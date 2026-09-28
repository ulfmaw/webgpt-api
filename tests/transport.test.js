import test from "node:test";
import assert from "node:assert/strict";
import { ChatGptTransport } from "../src/transports/chatgpt.js";
import { readSse } from "../src/sse.js";
import { Engine, validateRequest } from "../src/engine.js";
import { ConversationStore } from "../src/state.js";

const collect = async iterable => { const values = []; for await (const value of iterable) values.push(value); return values; };
const session = () => ({ token: "test-only-credential" });
const stream = frames => new Response(frames.map(f => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const answer = (text, channel = "final") => ({ message: { author: { role: "assistant" }, channel, content: { content_type: "text", parts: [text] }, metadata: { model_slug: "actual-model" } } });

test("website transport stays on the website origin and sends no local API key", async () => {
  const calls = [];
  const transport = new ChatGptTransport(session, { fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/models")) return Response.json({ default_model_slug: "new-model", versions: [{ id:"version",enabled:true,intelligence_presets:[{id:0,model_slug:"new-model",preset_type:"available"}] }], models: [{ slug: "new-model", is_work_mode_model: false }, { slug: "work-model", is_work_mode_model: true }] });
    return stream([answer("secret reasoning", "analysis"), answer("你"), answer("你好"), "[DONE]"]);
  } });
  assert.deepEqual(await transport.models(), [{ id: "new-model", default: true }]);
  const result = await collect(transport.generate({ model: "new-model", messages: [{ role: "user", content: "hello" }] }));
  assert.equal(result.map(x => x.text).join(""), "你好");
  assert.equal(result[0].model, "actual-model");
  assert.equal(calls[1].url, "https://chatgpt.com/backend-api/conversation");
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(calls[1].options.headers.authorization, "Bearer test-only-credential");
});

test("HTML verification and rejected sessions fail clearly without raw body leakage", async () => {
  for (const status of [401, 403, 429, 500]) {
    const transport = new ChatGptTransport(session, { fetcher: async () => new Response("secret=should-not-leak", { status }) });
    await assert.rejects(transport.models(), error => !error.message.includes("should-not-leak") && !error.modelUnavailable);
  }
});

test("unverified error names, HTTP status and Retry-After never authorize model fallback", async () => {
  for (const code of ["model_not_found", "model_not_available", "model_cap_exceeded", "unknown_code"]) {
    for (const status of [400, 403, 429, 500]) {
      for (const envelope of ["error", "detail"]) {
        const transport = new ChatGptTransport(session, { fetcher: async () => Response.json({ [envelope]: { code, message: "private-upstream-text" } }, { status, headers: { "retry-after": "604800" } }) });
        await assert.rejects(transport.models(), error => error.modelUnavailable === false && error.retryAfter === undefined && !error.message.includes("private-upstream-text"));
      }
    }
  }
});

test("unknown dialect, missing terminal event, and revised text cannot masquerade as success", async () => {
  for (const frames of [[{ v: { patches: [] } }, "[DONE]"], [answer("unfinished")], [answer("abc"), answer("xyz"), "[DONE]"]]) {
    const transport = new ChatGptTransport(session, { fetcher: async () => stream(frames) });
    await assert.rejects(collect(transport.generate({ model: "model", messages: [{ role: "user", content: "hi" }] })));
  }
});

test("auto engine does not replay or persist a response on unverified website quota errors", async () => {
  const store = new ConversationStore(":memory:");
  let generations = 0;
  const transport = new ChatGptTransport(session, { fetcher: async url => {
    if (url.endsWith("/models")) return Response.json({ default_model_slug: "top", versions:[{id:"version",enabled:true,intelligence_presets:[{id:0,model_slug:"top",preset_type:"available"},{id:1,model_slug:"lower",preset_type:"available"}]}], models: [{ slug: "top", is_work_mode_model: false }, { slug: "lower", is_work_mode_model: false }] });
    generations++;
    return Response.json({ error: { code: "model_cap_exceeded" } }, { status: 429, headers: { "retry-after": "604800" } });
  } });
  try {
    await assert.rejects(collect(new Engine(transport, store).run(validateRequest({ model: "auto", input: "synthetic" }))), error => error.modelUnavailable === false);
    assert.equal(generations, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM turns").get().n, 0);
  } finally { store.close(); }
});

test("SSE parser handles split UTF-8, CRLF, comments, and multiline data", async () => {
  const bytes = Buffer.from(": heartbeat\r\n\r\ndata: 中文\r\ndata: line2\r\n\r\n");
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.deepEqual(await collect(readSse(body)), ["中文\nline2"]);
  await assert.rejects(collect(readSse(new Response("data: incomplete").body)), { code: "stream_truncated" });
  await assert.rejects(collect(readSse(new Response("data: too big\n\n").body, 4)), { code: "stream_frame_too_large" });
});
