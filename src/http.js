import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { Fault, publicError } from "./errors.js";
import { validateRequest } from "./engine.js";
import { readFileSync } from "node:fs";
import { controlToken } from "./launcher.js";

function authorized(header, key) {
  const expected = Buffer.from(`Bearer ${key}`);
  const supplied = Buffer.from(typeof header === "string" ? header : "");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function readJson(req) {
  const limit = 16 * 1024 * 1024;
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Fault(415, "json_required", "Content-Type must be application/json.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) {
      req.resume();
      throw new Fault(413, "body_too_large", "Request exceeds 16 MiB.");
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Fault(400, "invalid_json", "Request body must contain valid JSON."); }
}

function item(event, status = "completed") {
  return { id: event.itemId, type: "message", role: "assistant", status,
    content: event.text === undefined ? [] : [{ type: "output_text", text: event.text, annotations: [] }] };
}

function responseObject(event, status = "completed") {
  return { id: event.id, object: "response", created_at: event.created, status,
    model: event.model, ...(event.requested_model ? { requested_model: event.requested_model } : {}), output: status === "completed" ? event.items ?? [item(event)] : [],
    error: null, incomplete_details: null, usage: null, store: event.stored ?? false };
}

export function createLocalServer({ engine, key, selection, control = {} }) {
  if (typeof key !== "string" || key.length < 32) throw new Error("A local API key of at least 32 characters is required.");
  const active = new Set();
  const token = controlToken(key);
  const panel = selection ? readFileSync(new URL("./control.html", import.meta.url)) : null;
  const panelScript = selection ? readFileSync(new URL("./control-ui.js", import.meta.url)) : null;
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    active.add(abort);
    res.on("close", () => { if (!res.writableFinished) abort.abort(); });
    req.on("aborted", () => abort.abort());
    let started;
    let chat = false;
    let sequence = 0;
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    const json = (status, value) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(value));
    };
    const write = async value => {
      abort.signal.throwIfAborted();
      if (!res.write(value)) await once(res, "drain", { signal: abort.signal });
    };
    const event = async (type, data) => write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...(started?{response_id:started.id}:{}), ...data })}\n\n`);
    const chunk = async value => write(`data: ${JSON.stringify(value)}\n\n`);
    try {
      const panelUrl = new URL(req.url, "http://127.0.0.1");
      if (selection && (["/v1", "/v1/", "/v1/control-ui.js"].includes(panelUrl.pathname) || panelUrl.pathname.startsWith("/v1/control/"))) {
        const origin = `http://${req.headers.host}`;
        if (req.headers.host !== `127.0.0.1:${server.address().port}` || (req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site") throw new Fault(403, "local_client_required", "Open the control page directly on 127.0.0.1.");
        res.setHeader("referrer-policy", "no-referrer");
        res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
        if (req.method === "GET" && ["/v1", "/v1/", "/v1/control-ui.js"].includes(panelUrl.pathname)) {
          const script = panelUrl.pathname === "/v1/control-ui.js";
          if (!script) res.setHeader("set-cookie", `webgpt_control=${token}; HttpOnly; SameSite=Strict; Path=/v1/control; Max-Age=28800`);
          res.writeHead(200, { "content-type": script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
          res.end(script ? panelScript : panel); return;
        }
        const cookie = req.headers.cookie?.split(";").map(p=>p.trim()).find(p=>p.startsWith("webgpt_control="))?.slice(15);
        const browserAuthorized = req.headers["sec-fetch-site"] === "same-origin" && req.headers["x-webgpt-control"] === "1" && authorized(`Bearer ${cookie ?? ''}`, token);
        if (!browserAuthorized && !authorized(req.headers.authorization, token)) throw new Fault(401, "control_auth_required", "Reopen the local control page.");
        const action = panelUrl.pathname.slice("/v1/control/".length);
        if (req.method === "GET" && action === "status") {
          const lifecycle = control.state?.() ?? { phase: "ready" };
          const models = selection.state();
          json(200, { ...lifecycle, ...models, actual_model: models.selected_actual_model ?? null,
            generation_verified: models.generation_verified && !["starting", "login", "checking", "blocked"].includes(lifecycle.phase),
            api_url: `${origin}/v1` }); return;
        }
        if (req.method === "POST" && action === "key") { json(200, { key }); return; }
        if (req.method === "POST" && action === "stop" && control.stop) { json(202, { stopping: true }); setImmediate(control.stop); return; }
        if (req.method === "POST" && ["login", "check"].includes(action) && control.start) {
          if (selection.busy) throw new Fault(409, "selection_busy", "Wait for the model test to finish.");
          const accepted = control.start(action); json(accepted ? 202 : 409, { accepted }); return;
        }
        if (req.method === "POST" && ["refresh", "select", "probe"].includes(action)) {
          if (control.busy?.()) throw new Fault(409, "control_busy", "Wait for login or connection testing to finish.");
          if (selection.busy) throw new Fault(409, "selection_busy", "Wait for the model test to finish.");
          if (action === "refresh") { json(200, await selection.refresh()); return; }
          const body = await readJson(req);
          if (typeof body.key !== "string" || body.key.length > 160 || Object.keys(body).some(k=>k!=="key")) throw new Fault(400, "invalid_selection", "Select a model from the current list.");
          const result = await selection.apply(body.key, AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]), { save: action === "select" });
          if (action === "select" || body.key === selection.current.key) control.selected?.(result);
          json(200, result); return;
        }
        throw new Fault(404, "not_found", "Unknown control action. Use start.cmd to enable login controls.");
      }
      // Loopback binding alone does not stop malicious websites or DNS rebinding.
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "") || req.headers.origin) {
        throw new Fault(403, "local_client_required", "Only direct local clients without an Origin header are accepted.");
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/healthz" && req.method === "GET") {
        json(200, { status: "ok", service: "webgpt-api", version: "0.1.0", scope: "local", live_transport_verified: engine.transport?.verified === true });
        return;
      }
      if (!authorized(req.headers.authorization, key)) throw new Fault(401, "invalid_api_key", "A valid local API key is required.");
      if (url.pathname === "/v1/models" && req.method === "GET") {
        const models = await engine.catalog.list();
        const entries = models.map(m => ({ id: m.id, object: "model", created: 0, owned_by: "account" }));
        // Keep the standard OpenAI `data` field and add Codex CLI's expected alias.
        json(200, { object: "list", data: entries, models: entries });
        return;
      }
      const modelRoute = /^\/v1\/models\/([^/]+)$/.exec(url.pathname);
      if (modelRoute && req.method === "GET" && modelRoute[1] !== "refresh") {
        const id = decodeURIComponent(modelRoute[1]);
        const found = (await engine.catalog.list()).find(model => model.id === id);
        if (!found) throw new Fault(404, "model_not_found", "Model is not in the current account list.");
        json(200, { id: found.id, object: "model", created: 0, owned_by: "account" });
        return;
      }
      if (url.pathname === "/v1/models/refresh" && req.method === "POST") {
        engine.catalog.refresh();
        json(200, { refreshed: true });
        return;
      }
      const responseRoute = /^\/v1\/responses\/(resp_[a-f0-9-]{36})$/.exec(url.pathname);
      if (responseRoute && ["GET", "DELETE"].includes(req.method)) {
        if (url.search) throw new Fault(400, "unsupported_query", "Stored response retrieval does not support streaming replay or query options.");
        if (req.method === "DELETE") json(200, engine.store.delete(responseRoute[1]));
        else {
          const saved = engine.store.retrieve(responseRoute[1]);
          const tools = saved.output[0]?.type === "function_call";
          json(200, responseObject({ id: saved.id, itemId: saved.itemId, created: saved.created, model: saved.model, requested_model: saved.requested_model, stored: true,
            ...(tools ? { items: saved.output } : { text: saved.output.map(message => message.content).join("") }) }));
        }
        return;
      }
      chat = url.pathname === "/v1/chat/completions";
      if (req.method !== "POST" || (!chat && url.pathname !== "/v1/responses")) throw new Fault(404, "not_found", "Unknown endpoint.");
      const request = validateRequest(await readJson(req), chat);
      for await (const output of engine.run(request, abort.signal)) {
        if (output.kind === "start") {
          started = output;
          if (request.stream) {
            res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
            if (chat) await chunk({ id: output.id, object: "chat.completion.chunk", created: output.created, model: output.model, requested_model: output.requested_model,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
            else {
              await event("response.created", { response: responseObject({ ...output, stored: request.store }, "in_progress") });
              if(!output.toolCalls){
              await event("response.output_item.added", { output_index: 0, item: item(output, "in_progress") });
              await event("response.content_part.added", { item_id: output.itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
              }
            }
          }
        } else if (output.kind === "delta" && request.stream) {
          if (chat) await chunk({ id: started.id, object: "chat.completion.chunk", created: started.created, model: started.model, requested_model: started.requested_model,
            choices: [{ index: 0, delta: { content: output.text }, finish_reason: null }] });
          else await event("response.output_text.delta", { item_id: started.itemId, output_index: 0, content_index: 0, delta: output.text, logprobs: [] });
        } else if(output.kind==="tool"&&request.stream){
          const call=output.item;
          if(chat)await chunk({id:started.id,object:"chat.completion.chunk",created:started.created,model:started.model,requested_model:started.requested_model,choices:[{index:0,delta:{tool_calls:[{index:output.index,id:call.call_id,type:"function",function:{name:call.name,arguments:call.arguments}}]},finish_reason:null}]});
          else{
            await event("response.output_item.added",{output_index:output.index,item:{...call,status:"in_progress",arguments:""}});
            await event("response.function_call_arguments.delta",{item_id:call.id,output_index:output.index,delta:call.arguments});
            await event("response.function_call_arguments.done",{item_id:call.id,output_index:output.index,name:call.name,arguments:call.arguments});
            await event("response.output_item.done",{output_index:output.index,item:call});
          }
        } else if (output.kind === "done") {
          if (!request.stream) {
            json(200, chat ? { id: output.id, object: "chat.completion", created: output.created, model: output.model, requested_model: output.requested_model,
              choices: [{ index: 0, message: output.items?{role:"assistant",content:null,tool_calls:output.items.map(c=>({id:c.call_id,type:"function",function:{name:c.name,arguments:c.arguments}}))}:{ role: "assistant", content: output.text }, finish_reason: output.items?"tool_calls":"stop" }], usage: null } : responseObject(output));
          } else if (chat) {
            await chunk({ id: output.id, object: "chat.completion.chunk", created: output.created, model: output.model, requested_model: output.requested_model,
              choices: [{ index: 0, delta: {}, finish_reason: output.items?"tool_calls":"stop" }] });
            if (request.includeUsage) await chunk({ id: output.id, object: "chat.completion.chunk", created: output.created, model: output.model, choices: [], usage: null });
            await write("data: [DONE]\n\n");
            res.end();
          } else {
            if(!output.items){
            const part = { type: "output_text", text: output.text, annotations: [] };
            await event("response.output_text.done", { item_id: output.itemId, output_index: 0, content_index: 0, text: output.text, logprobs: [] });
            await event("response.content_part.done", { item_id: output.itemId, output_index: 0, content_index: 0, part });
            await event("response.output_item.done", { output_index: 0, item: item(output) });
            }
            await event("response.completed", { response: responseObject(output) });
            res.end();
          }
        }
      }
    } catch (error) {
      if (abort.signal.aborted || res.destroyed) return;
      const failure = publicError(error);
      if (!res.headersSent) json(error instanceof Fault ? error.status : 500, { error: failure });
      else {
        try {
          if (chat) await chunk({ error: failure });
          else await event("response.failed", { response: { ...responseObject(started, "failed"), error: failure } });
        } catch { /* Client disconnected while reporting the error. */ }
        res.end();
      }
    } finally { active.delete(abort); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return {
    server,
    async listen(port = 17841) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      for (const controller of active) controller.abort();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
