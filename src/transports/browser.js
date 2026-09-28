import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserPool } from "../browser-pool.js";
import { Fault } from "../errors.js";
import { readSse } from "../sse.js";
import { WebEventDecoder } from "./web-events.js";
import { discoverChatCatalog } from "./chat-catalog.js";
import { modelOptions } from "../model-selection.js";
import { attachFiles } from "./attachments.js";
import { observePreparation } from "./preparation.js";
import { matchesModelSelection } from "../model-identity.js";

export function prepareWebsiteBody(body, path, { model, thinking_effort, messages, instructions, attachments }) {
  const next = structuredClone(body);
  if (path === "/backend-api/conversation/init") {
    next.requested_default_model = model === "auto" ? null : model;
    return next;
  }
  next.model = model;
  // A saved browser draft's reasoning setting must not override native Auto.
  if (thinking_effort !== undefined && model !== "auto") next.thinking_effort = thinking_effort;
  else delete next.thinking_effort;
  next.is_do_not_remember = true;
  delete next.conversation_id;
  if (path === "/backend-api/f/conversation") {
    const input = instructions ? [{ role: "system", content: instructions }, ...messages] : messages;
    const native = next.messages?.at(-1);
    if (attachments?.length && (native?.metadata?.attachments?.length ?? 0) < attachments.length) throw new Fault(502, "attachment_metadata_missing", "Website request did not contain every uploaded attachment.");
    next.messages = input.map((message, i) => {
      if (attachments?.length && i === input.length - 1) return { ...native, author: { role: message.role }, content: { ...native.content, parts: [...(native.content?.parts ?? []).filter(p => typeof p !== "string"), message.content] } };
      return { id: i === input.length - 1 && native?.id ? native.id : randomUUID(), author: { role: message.role }, content: { content_type: "text", parts: [message.content] } };
    });
  }
  return next;
}

export async function generationStream(connection, request, signal) {
  let streamController;
  let ended = false;
  let sourceId;
  let initialReady = false;
  let loadingComplete = false;
  let pending = [];
  let received = 0;
  let submitted = false;
  const disposers = [];
  // The composer can render before its model preparation finishes, including
  // text-only turns. A clickable button alone does not establish readiness.
  const preparation = observePreparation(connection);
  disposers.push(preparation.dispose);
  const cleanup = () => { for (const dispose of disposers) dispose(); signal.removeEventListener("abort", abort); };
  const fail = error => { if (!ended) { ended = true; streamController.error(error); cleanup(); } };
  const abort = () => fail(signal.reason ?? new Error("Cancelled"));
  const enqueue = chunk => {
    if (ended) return;
    received += chunk.length;
    if (received > 8 * 1024 * 1024) { fail(new Fault(502, "stream_too_large", "Website stream exceeded 8 MiB.")); return; }
    streamController.enqueue(chunk);
  };
  const stream = new ReadableStream({ start(controller) { streamController = controller; }, cancel() { ended = true; cleanup(); } });
  signal.addEventListener("abort", abort, { once: true });
  disposers.push(connection.on("Network.dataReceived", event => {
    if (event.requestId !== sourceId || !event.data) return;
    const chunk = Buffer.from(event.data, "base64");
    if (!initialReady) pending.push(chunk); else enqueue(chunk);
  }));
  disposers.push(connection.on("Network.loadingFailed", event => {
    if (event.requestId === sourceId) fail(new Fault(502, "web_connection_failed", "Website generation connection failed. No replay was attempted."));
  }));
  disposers.push(connection.on("Network.loadingFinished", event => {
    if (event.requestId !== sourceId) return;
    loadingComplete = true;
    if (initialReady && !ended) { ended = true; streamController.close(); cleanup(); }
  }));
  disposers.push(connection.on("Network.responseReceived", event => {
    let url; try { url = new URL(event.response.url); } catch { return; }
    if (url.origin !== "https://chatgpt.com" || url.pathname !== "/backend-api/f/conversation") return;
    if (sourceId) { fail(new Fault(502, "duplicate_generation", "Unexpected second generation request.")); return; }
    sourceId = event.requestId;
    if (event.response.status !== 200) {
      fail(new Fault(event.response.status === 429 ? 429 : 502, "web_generation_rejected", `Website generation was rejected (HTTP ${event.response.status}). No login loop or replay was attempted.`)); return;
    }
    if (event.response.mimeType !== "text/event-stream") { fail(new Fault(502, "web_protocol_changed", "Website did not return a text event stream.")); return; }
    connection.call("Network.streamResourceContent", { requestId: sourceId }).then(result => {
      enqueue(Buffer.from(result.bufferedData, "base64"));
      initialReady = true;
      for (const chunk of pending) enqueue(chunk);
      pending = [];
      if (loadingComplete && !ended) { ended = true; streamController.close(); cleanup(); }
    }).catch(() => fail(new Fault(502, "browser_stream_unavailable", "Browser streaming interface was unavailable.")));
  }));
  disposers.push(connection.on("Fetch.requestPaused", event => {
    void (async () => {
      try {
        const url = new URL(event.request.url);
        if (url.origin !== "https://chatgpt.com" || !["/backend-api/conversation/init", "/backend-api/f/conversation", "/backend-api/f/conversation/prepare"].includes(url.pathname)) {
          await connection.call("Fetch.continueRequest", { requestId: event.requestId }); return;
        }
        if (signal.aborted || ended) { await connection.call("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" }); return; }
        const body = prepareWebsiteBody(JSON.parse(event.request.postData), url.pathname, request);
        await connection.call("Fetch.continueRequest", { requestId: event.requestId, postData: Buffer.from(JSON.stringify(body)).toString("base64") });
        if (url.pathname === "/backend-api/f/conversation") submitted = true;
      } catch {
        await connection.call("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" }).catch(() => {});
        fail(new Fault(502, "web_request_shape_changed", "Website request shape changed. The unmodified request was not sent."));
      }
    })();
  }));
  try {
    await connection.call("Network.enable", { maxTotalBufferSize: 8 * 1024 * 1024, maxResourceBufferSize: 2 * 1024 * 1024 });
    const imageRequest = request.attachments?.some(file => file.mime.startsWith("image/"));
    await connection.call("Network.setBlockedURLs", { urls: ["*.woff", "*.woff2", "*.ttf", ...(!imageRequest ? ["*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif"] : []), "*.mp4", "*.webm"] });
    const pageUrl = new URL("https://chatgpt.com/");
    pageUrl.searchParams.set("temporary-chat", "true");
    pageUrl.searchParams.set("model", request.model);
    const navigationMarker = randomUUID();
    await connection.call("Runtime.evaluate", { expression: `window.__webgptNavigationMarker=${JSON.stringify(navigationMarker)}` });
    // Preparation can start during navigation, before the composer is ready.
    // Intercept it before loading the page so its model matches the final send.
    await connection.call("Fetch.enable", { patterns: [{ urlPattern: "https://chatgpt.com/backend-api/f/conversation*", requestStage: "Request" }, { urlPattern: "https://chatgpt.com/backend-api/conversation/init", requestStage: "Request" }] });
    await connection.call("Page.navigate", { url: pageUrl.href });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      signal.throwIfAborted();
      const result = await connection.call("Runtime.evaluate", { expression: `(()=>{if(window.__webgptNavigationMarker===${JSON.stringify(navigationMarker)}||document.readyState==='loading')return false;const e=document.querySelector('[contenteditable="true"][role="textbox"]');if(!e)return false;e.focus();window.getSelection().selectAllChildren(e);return document.activeElement===e;})()`, returnByValue: true });
      if (result.result?.value === true) { ready = true; break; }
      await delay(500, undefined, { signal });
    }
    if (!ready) throw new Fault(503, "composer_unavailable", "The website composer was not ready in the background.");
    const latest = request.messages.at(-1);
    if (latest?.role !== "user") throw new Fault(400, "user_turn_required", "The last message must be a user turn.");
    await connection.call("Input.insertText", { text: latest.content });
    await preparation.wait(signal, { attachments: Boolean(request.attachments?.length) });
    const attachmentModelVersion = preparation?.modelVersion();
    // File-input selections can be read lazily at Send time. Retain the private
    // files until generation completes or is cancelled, not just until a tile appears.
    disposers.push(await attachFiles(connection, request.attachments, request.directory, signal));
    if (preparation && preparation.modelVersion() !== attachmentModelVersion) throw new Fault(503, "attachment_model_changed", "The website changed its model while files were uploading. No message was sent; retry after the website finishes initializing.");
    let clicked = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      signal.throwIfAborted();
      const result = await connection.call("Runtime.evaluate", { expression: `(()=>{const c=document.querySelector('[contenteditable="true"][role="textbox"]');const f=c?.closest('form');const b=f?.querySelector('[data-testid="send-button"],button[type="submit"]');const props=e=>e?.[Object.keys(e).find(k=>k.startsWith('__reactProps$'))];if(!b||b.disabled||!c.textContent.trim()||(typeof props(b)?.onClick!=='function'&&typeof props(f)?.onSubmit!=='function'))return false;b.click();return true;})()`, returnByValue: true });
      if (result.result?.value === true) { clicked = true; break; }
      await delay(250, undefined, { signal });
    }
    if (!clicked) throw new Fault(503, "composer_unavailable", "Website submit control is not ready. No message was sent.");
    for (let attempt = 0; attempt < 120 && !submitted && !ended; attempt++) await delay(250, undefined, { signal });
    if (!submitted && !ended) throw new Fault(503, "web_send_not_started", "The website did not start a generation request. No automatic resend was attempted.");
    return stream;
  } catch (error) { cleanup(); await stream.cancel().catch(() => {}); throw error; }
}

export class BrowserTransport {
  verified = false;
  constructor(directory, { pool = new BrowserPool(directory) } = {}) {
    this.directory = directory; this.pool = pool;
  }
  async models() {
    if (!existsSync(join(this.directory, "session.json"))) throw new Fault(503, "session_required", "First use requires account login.");
    const body = await this.pool.run(connection => discoverChatCatalog(connection));
    return body.models.map(model => ({ id: model.slug, default: model.slug === body.default_model_slug }));
  }
  async options() {
    if (!existsSync(join(this.directory, "session.json"))) throw new Fault(503, "session_required", "First use requires account login.");
    return modelOptions(await this.pool.run(connection => discoverChatCatalog(connection)));
  }
  async *generate(request) {
    if (!existsSync(join(this.directory, "session.json"))) throw new Fault(503, "session_required", "First use requires account login.");
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, request.signal ?? new AbortController().signal, AbortSignal.timeout(600_000)]);
    const channel = new TransformStream();
    const writer = channel.writable.getWriter();
    const reader = channel.readable.getReader();
    let completed = false;
    const task = this.pool.run(async connection => {
      const raw = await generationStream(connection, { ...request, directory: this.directory }, signal);
      const decoder = new WebEventDecoder();
      try {
        for await (const data of readSse(raw)) {
          signal.throwIfAborted();
          const delta = decoder.push(data);
          if (delta && request.automatic !== true && !delta.model) throw new Fault(502, "model_identity_missing", "The website did not identify the selected model. Selection cannot be verified.");
          if (delta?.model && request.automatic !== true && !matchesModelSelection(request.model, delta.model, delta.requested_model)) {
            throw new Fault(409, "model_substituted", "The website returned a different model. Use auto to allow website model routing.", { requested_model: request.model, actual_model: delta.model, ...(delta.model_denial ? { reason: delta.model_denial } : {}) });
          }
          if (delta) await writer.write(delta);
          if (decoder.done) break;
        }
        decoder.verify(); this.verified = true;
        await writer.close();
      } finally { await connection.call("Fetch.disable").catch(() => {}); }
    }, signal).catch(error => writer.abort(error).catch(() => {}));
    try { while (true) { const part = await reader.read(); if (part.done) { completed = true; break; } yield part.value; } }
    finally { if (!completed) abort.abort(); await reader.cancel().catch(() => {}); reader.releaseLock(); await task; }
  }
  close() { return this.pool.close(); }
}
