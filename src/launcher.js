import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { Fault, publicError } from "./errors.js";

export function controlToken(key) {
  return createHmac("sha256", key).update("webgpt-api/local-launcher/v1").digest("base64url");
}

export class LaunchController {
  state = { phase: "starting", generation_verified: false, error: null };
  task = null;
  abort = new AbortController();
  constructor({ probe, login, canStart = () => true, onStart = () => {} }) {
    this.probe = probe; this.login = login; this.canStart = canStart; this.onStart = onStart;
  }
  start(action = "check") {
    if (this.task || this.abort.signal.aborted || !this.canStart()) return false;
    this.onStart(action);
    this.state = { phase: action === "login" ? "login" : "checking", generation_verified: false, error: null };
    this.task = Promise.resolve().then(async () => {
      const authenticate = async () => {
        this.state = { phase: "login", generation_verified: false, error: null };
        await this.login({ signal: this.abort.signal, onStatus: message => { this.state.message = message; } });
        this.state = { phase: "checking", generation_verified: false, error: null };
      };
      if (action === "login") await authenticate();
      this.state = { phase: "checking", generation_verified: false, error: null };
      let result;
      try { result = await this.probe(this.abort.signal); }
      catch (error) {
        // First use opens login automatically exactly once. A verification failure
        // on an existing session must never become a repeated login loop.
        if (action !== "startup" || error?.code !== "session_required") throw error;
        await authenticate();
        result = await this.probe(this.abort.signal);
      }
      this.state = { phase: "ready", generation_verified: true, error: null,
        ...(typeof result?.model === "string" ? { actual_model: result.model } : {}) };
    }).catch(error => {
      this.state = { phase: "blocked", generation_verified: false, error: publicError(error) };
    }).finally(() => { this.task = null; });
    return true;
  }
  async close() { this.abort.abort(); await this.task; }
}

// Separate management listener: API CORS policy stays closed to browser callers.
export function createLauncher({ key, controller, apiUrl, onStop = () => {} }) {
  const token = controlToken(key);
  const html = readFileSync(new URL("./launcher.html", import.meta.url));
  const script = readFileSync(new URL("./launcher-ui.js", import.meta.url));
  let origin;
  const server = createServer((req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers["sec-fetch-site"] === "cross-site") {
      send(403, { error: "local_only" }); return;
    }
    if (req.method === "GET" && ["/", "/launcher-ui.js"].includes(req.url)) {
      res.writeHead(200, { "content-type": req.url === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8" });
      res.end(req.url === "/" ? html : script); return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(401, { error: "unauthorized" }); return; }
    if (req.method === "GET" && req.url === "/status") {
      send(200, { service: "webgpt-api-launcher", ...controller.state, api_url: apiUrl }); return;
    }
    if (req.method === "POST" && req.url === "/key") { send(200, { key }); return; }
    if (req.method === "POST" && ["/check", "/login"].includes(req.url)) {
      const accepted = controller.start(req.url.slice(1));
      send(accepted ? 202 : 409, { accepted }); return;
    }
    if (req.method === "POST" && req.url === "/stop") { send(202, { stopping: true }); setImmediate(onStop); return; }
    send(404, { error: "not_found" });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return {
    server,
    async listen(port = 17840) {
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      origin = `http://127.0.0.1:${server.address().port}`;
      return `${origin}/#${token}`;
    },
    async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); },
  };
}

function openPage(url) {
  // URL is constructed internally; no shell expansion or secret output.
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
  child.on("error", () => console.error("Could not open the local launcher window."));
  child.unref();
}

export async function launch(directory, key, { open = openPage } = {}) {
  const token = controlToken(key);
  const existing = await fetch("http://127.0.0.1:17840/status", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) })
    .then(async response => response.ok && (await response.json()).service === "webgpt-api-launcher").catch(() => false);
  if (existing) { open("http://127.0.0.1:17841/v1"); return; }
  let runtime;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await controller.close();
    if (runtime) await runtime.close();
    await manager.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  };
  const controller = new LaunchController({
    canStart: () => !runtime?.selection.busy,
    onStart: action => runtime?.selection.invalidate(action === "login" ? undefined : runtime.selection.current.key),
    login: async options => { runtime?.selection.invalidate(); await runtime?.transport.close(); const { interactiveLogin } = await import("./login.js"); await interactiveLogin(directory, options); },
    probe: async signal => {
      try {
        await runtime.selection.refresh();
        const combined = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
        const response = await fetch("http://127.0.0.1:17841/v1/responses", {
          method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", input: "Reply only: OK", store: false }), signal: combined,
        });
        const body = await response.json();
        if (!response.ok) throw new Fault(response.status, body.error?.code ?? "probe_failed", body.error?.message ?? "Generation check failed.", body.error);
        if (body.status !== "completed" || !body.output?.some(item => item.content?.some(part => typeof part.text === "string" && part.text.trim()))) {
          throw new Fault(502, "empty_probe", "Generation did not produce a completed text response.");
        }
        // Record the exact startup/check result used by normal API traffic.
        if (!runtime.selection.markVerified(body.model, runtime.selection.current.key, body.requested_model)) throw new Fault(409, "model_substituted", "The website did not acknowledge the selected model.");
        return { model: body.model };
      } catch (error) { runtime.selection.markFailed(error); throw error; }
    },
  });
  const manager = createLauncher({ key, controller, apiUrl: "http://127.0.0.1:17841/v1", onStop: () => { void stop(); } });
  let url;
  try { url = await manager.listen(); }
  catch { throw new Fault(503, "launcher_port_busy", "Port 17840 is occupied. No existing process was stopped."); }
  try {
    const { createRuntime } = await import("./runtime.js");
    runtime = createRuntime(directory, key);
    Object.assign(runtime.control, {
      state: () => controller.state, busy: () => Boolean(controller.task),
      start: action => controller.start(action),
      selected: result => { controller.state = { phase: "ready", error: null, generation_verified: true, actual_model: result.actual_model }; },
      stop: () => { void stop(); },
    });
    await runtime.app.listen(17841);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    open("http://127.0.0.1:17841/v1");
    controller.start("startup");
    console.log("webgpt-api launcher opened. Keep this process running; use Stop in the launcher to exit.");
  } catch (error) { await stop(); throw error; }
}
