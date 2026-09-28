import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, openSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Fault } from "./errors.js";
import { importSession } from "./settings.js";
import { randomUUID } from "node:crypto";
import { waitForAuthenticatedSession } from "./login-flow.js";
import { createServer } from "node:net";
import { once } from "node:events";
import { restoreBrowserSession } from "./browser-session.js";
import { setTimeout as delay } from "node:timers/promises";

export function findBrowser(env = process.env) {
  const candidates = [env.WEBGPT_BROWSER,
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    env.ProgramFiles && join(env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
  ];
  const path = candidates.find(candidate => candidate && existsSync(candidate));
  if (!path) throw new Fault(503, "browser_missing", "No supported system browser found. Set WEBGPT_BROWSER to its executable path.");
  return path;
}

// Small protocol client using the runtime's WebSocket; no automation framework.
class BrowserConnection {
  sequence = 0;
  waiting = new Map();
  closed = false;
  listeners = new Map();
  constructor(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1") throw new Fault(500, "invalid_debug_endpoint", "Login debugger must be on loopback.");
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Browser connection timed out")); this.socket.close(); }, 10_000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Browser connection failed")); }, { once: true });
      this.socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Browser closed")); }, { once: true });
    });
    this.socket.addEventListener("message", event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
        return;
      }
      const pending = this.waiting.get(message.id);
      if (!pending) return;
      this.waiting.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error("Browser command failed"));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error("Browser closed")); }
      this.waiting.clear();
    });
  }
  async call(method, params = {}, timeoutMs = 10_000) {
    await this.ready;
    if (this.closed) throw new Error("Browser closed");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error("Browser command timed out")); }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.waiting.delete(id); reject(error); }
    });
  }
  close() { this.socket.close(); }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }
}

export function loginArguments(profile, { debugPort, background = false } = {}) {
  if (debugPort !== undefined && (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535)) throw new Error("Invalid login debug port");
  return [`--user-data-dir=${profile}`, "--disable-background-mode", "--no-first-run", "--no-default-browser-check",
    ...(background === "headless" ? ["--headless=new"] : background ? ["--start-minimized", "--window-position=-32000,-32000", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] : ["--window-position=100,80", "--window-size=1100,800", "--start-maximized"]),
    ...(debugPort ? ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${debugPort}`] : []),
    "--new-window", background ? "https://chatgpt.com/?temporary-chat=true" : "https://chatgpt.com/"];
}

export function acquireLoginLock(directory) {
  const path = join(directory, "login.lock");
  const identity = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, identity); } finally { closeSync(fd); }
      return () => { if (existsSync(path) && readFileSync(path, "utf8") === identity) unlinkSync(path); };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(path, "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (error) { stale = error.code === "ESRCH"; }
        }
      } catch { /* An unrecognized lock is not ours to remove. */ }
      if (!stale) throw new Fault(409, "login_busy", "A login is already active. Close that login before trying again.");
      unlinkSync(path);
    }
  }
  throw new Fault(409, "login_busy", "Login profile is busy.");
}

export async function interactiveLogin(directory, { timeout = 600_000, signal, onStatus = console.log, onAuthenticated, background = false } = {}) {
  const executable = findBrowser();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const unlock = acquireLoginLock(directory);
  // This dedicated profile never attaches to the user's normal browser.
  const profile = join(directory, "browser-profile");
  let child;
  let launchFailed = false;
  let connection;
  let port;
  let attemptedRestore = false;
  try {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    signal?.throwIfAborted();
    child = spawn(executable, loginArguments(profile, { debugPort: port, background }), { stdio: "ignore", windowsHide: background !== false });
    child.on("error", () => { launchFailed = true; });
    onStatus(background ? "正在背景接手既有登入。" : "請在新視窗正常登入 ChatGPT。登入後程式會自動接手，你不需要關閉視窗、搬 Cookie 或按完成。");
    const value = await waitForAuthenticatedSession({
      signal, timeout,
      isClosed: () => child.exitCode !== null || child.signalCode !== null,
      probe: async () => {
      if (launchFailed) throw new Fault(503, "browser_launch_failed", "Could not start the system browser.");
      try {
        const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
        const tab = tabs.find(tab => tab.type === "page" && typeof tab.url === "string" && new URL(tab.url).origin === "https://chatgpt.com");
        if (!tab) return null;
        const endpoint = new URL(tab.webSocketDebuggerUrl);
        if (endpoint.hostname !== "127.0.0.1" || Number(endpoint.port) !== port) throw new Fault(503, "invalid_debug_endpoint", "Unexpected login browser endpoint.");
        connection?.close();
        connection = new BrowserConnection(tab.webSocketDebuggerUrl);
        const result = await connection.call("Runtime.evaluate", {
          expression: "fetch('/api/auth/session', {credentials:'include',cache:'no-store'}).then(async r=>({status:r.status,session:r.ok?await r.json():null})).then(({status,session:s})=>({status,session:s&&typeof s.accessToken==='string'?{accessToken:s.accessToken,expires:s.expires,userAgent:navigator.userAgent}:null}))",
          awaitPromise: true, returnByValue: true,
        });
        const observed = result.result?.value;
        const session = observed?.session;
        if (typeof session?.accessToken === "string") {
          const { cookies } = await connection.call("Network.getAllCookies");
          return { ...session, cookies };
        }
        if (background && observed?.status === 403) throw new Fault(503, "web_verification_required", "The website requires browser verification. Saved login cookies will not be injected into a verification challenge.");
        if (background && [200, 401].includes(observed?.status)) {
          if (attemptedRestore) throw new Fault(401, "session_rejected", "The website did not accept the restored login. Use interactive login; no repeated restore was attempted.");
          attemptedRestore = true;
          await restoreBrowserSession(connection, directory);
        }
      } catch (error) {
        if (error instanceof Fault) throw error;
        signal?.throwIfAborted();
        // Navigation during sign-in invalidates a page connection; wait for the next page.
      }
      return null;
      },
    });
    importSession(value, directory);
    if (onAuthenticated) await onAuthenticated(connection);
    onStatus("登入已自動接手，憑證已存入本機私人資料夾。正在關閉專用視窗並驗證實際生成。");
  } finally {
    if (connection) { await connection.call("Browser.close").catch(() => {}); connection.close(); }
    // A cancelled startup may not yet have a page connection. Still close only
    // the browser created here, using its own loopback endpoint before a PID fallback.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        const info = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })).json();
        const endpoint = new URL(info.webSocketDebuggerUrl);
        if (Number(endpoint.port) === port) {
          const control = new BrowserConnection(endpoint.href);
          try { await control.call("Browser.close", {}, 2000).catch(() => {}); } finally { control.close(); }
        }
      } catch { /* The owned browser may already have exited. */ }
      for (let i=0; i<10 && child.exitCode===null && child.signalCode===null; i++) await delay(100);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    unlock();
    // The dedicated profile is retained privately for recovery; never recursively delete user data.
  }
}
