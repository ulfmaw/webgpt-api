import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { ConversationStore } from "../src/state.js";
import { Engine } from "../src/engine.js";
import { createLocalServer } from "../src/http.js";
import { Fault } from "../src/errors.js";

const key = "local-testing-key-00000000000000000000";
async function fixture(t, generate = async function* () { yield { text: "你" }; yield { text: "好" }; }) {
  const store = new ConversationStore(":memory:");
  const engine = new Engine({ models: async () => [{ id: "test-model", default: true }], generate }, store);
  const app = createLocalServer({ key, engine });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); store.close(); });
  const request = (path, body, extra = {}) => fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { app, engine, store, url, request };
}

test("only loopback is bound; all model routes require key and reject browser-origin requests", async t => {
  const { app, url, request } = await fixture(t);
  assert.equal(app.server.address().address, "127.0.0.1");
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  assert.equal((await fetch(`${url}/v1/models`)).status, 401);
  assert.equal((await request("/v1/models", undefined, { origin: "https://untrusted.invalid" })).status, 403);
  // Fetch normalizes Host; use an actual wire-level Host override for the rebinding test.
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(`${url}/v1/models`, { headers: { host: "untrusted.invalid", authorization: `Bearer ${key}` } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on("error", reject); req.end();
  });
  assert.equal(status, 403);
  const modelList = await (await request("/v1/models")).json();
  assert.equal(modelList.data[0].id, "test-model");
  assert.equal(modelList.models[0].id, "test-model");
  assert.equal((await (await request("/v1/models/test-model")).json()).id, "test-model");
  assert.equal((await request("/v1/models/missing")).status, 404);
});

test("Responses JSON and streamed lifecycle contain the actual model and complete text", async t => {
  const { request } = await fixture(t);
  const first = await (await request("/v1/responses", { input: "hi" })).json();
  assert.equal(first.model, "test-model");
  assert.equal(first.output[0].content[0].text, "你好");
  const stream = await request("/v1/responses", { input: "next", previous_response_id: first.id, stream: true });
  assert.equal(stream.status, 200);
  const text = await stream.text();
  const events = text.split("\n").filter(s => s.startsWith("data: ")).map(s => JSON.parse(s.slice(6)));
  assert.equal(events[0].type, "response.created");
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output[0].content[0].text, "你好");
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
});

test("Chat Completions supports text JSON and SSE with DONE", async t => {
  const { request } = await fixture(t);
  const body = { messages: [{ role: "user", content: "hello" }] };
  const response = await (await request("/v1/chat/completions", body)).json();
  assert.equal(response.choices[0].message.content, "你好");
  const stream = await (await request("/v1/chat/completions", { ...body, stream: true })).text();
  assert.ok(stream.endsWith("data: [DONE]\n\n"));
  assert.ok(stream.includes('"content":"你"'));
});

test("stream failure emits failed, never completed, and never saves partial history", async t => {
  const { request, store } = await fixture(t, async function* () { yield { text: "partial" }; throw new Fault(502, "interrupted", "Connection ended."); });
  const body = await (await request("/v1/responses", { input: "hi", stream: true })).text();
  assert.ok(body.includes("event: response.failed"));
  assert.ok(!body.includes("event: response.completed"));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM turns").get().n, 0);
});

test("disconnect aborts the transport and releases the concurrency permit", async t => {
  let aborted = false;
  const { url, engine } = await fixture(t, async function* ({ signal }) {
    try { yield { text: "start" }; await once(signal, "abort"); signal.throwIfAborted(); }
    finally { aborted = true; }
  });
  const abort = new AbortController();
  const response = await fetch(`${url}/v1/responses`, {
    method: "POST", signal: abort.signal,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ input: "hello", stream: true }),
  });
  const reader = response.body.getReader();
  await reader.read();
  abort.abort();
  await reader.cancel().catch(() => {});
  for (let i = 0; i < 100 && !aborted; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(aborted, true);
  assert.equal(engine.gate.active, 0);
});

test("invalid input and unknown options fail before generation", async t => {
  const { request } = await fixture(t, async function* () { assert.fail("should never generate"); });
  assert.equal((await request("/v1/responses", { input: "hello", tools: [{type:"unknown"}] })).status, 400);
  assert.equal((await request("/v1/responses", { input: "hello", model: "not-advertised" })).status, 404);
});
