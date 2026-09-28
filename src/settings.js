import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Fault } from "./errors.js";

export function dataDirectory(env = process.env) {
  return resolve(env.WEBGPT_HOME || join(env.LOCALAPPDATA || env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "webgpt-api"));
}

export function initialize(directory = dataDirectory()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, "api.key");
  try { writeFileSync(keyPath, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const key = readFileSync(keyPath, "utf8").trim();
  if (key.length < 32) throw new Fault(500, "invalid_local_key", "Local API key is invalid.");
  return { directory, key, keyPath };
}

export function importSession(value, directory = dataDirectory()) {
  const token = value?.accessToken;
  const cookies = usableCookies(value?.cookies);
  const validToken = typeof token === "string" && token.length >= 20 && !/\s/.test(token);
  if (!validToken && !cookies.length) throw new Fault(400, "invalid_session", "Session JSON must contain an accessToken or ChatGPT cookies.");
  initialize(directory);
  // Only the required fields are retained. Never copy arbitrary account/profile data.
  writeFileSync(join(directory, "session.json"), JSON.stringify({
    ...(validToken ? { accessToken: token } : {}),
    ...(cookies.length ? { cookies } : {}),
    expires: typeof value.expires === "string" ? value.expires : null,
    ...(typeof value.userAgent === "string" && value.userAgent.length < 512 && !/[\r\n]/.test(value.userAgent) ? { userAgent: value.userAgent } : {}),
  }), { mode: 0o600 });
}

function usableCookies(cookies) {
  if (!Array.isArray(cookies)) return [];
  return cookies.filter(c => c && ["chatgpt.com", ".chatgpt.com"].includes(c.domain)
    && typeof c.name === "string" && /^[A-Za-z0-9_.-]+$/.test(c.name)
    && typeof c.value === "string" && !/[;\r\n\x00-\x20\x7f]/.test(c.value)
    && (c.path === undefined || c.path === "/" || "/api/auth/session".startsWith(c.path)))
    .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/", expires: Number.isFinite(c.expires) ? c.expires : -1 }));
}

export function readSession(directory = dataDirectory(), env = process.env) {
  let session;
  if (env.WEBGPT_ACCESS_TOKEN) session = { accessToken: env.WEBGPT_ACCESS_TOKEN };
  else if (existsSync(join(directory, "session.json"))) {
    try { session = JSON.parse(readFileSync(join(directory, "session.json"), "utf8")); }
    catch { throw new Fault(503, "invalid_session", "Stored session is unreadable; import it again."); }
  }
  const cookies = usableCookies(session?.cookies);
  if ((!session?.accessToken || typeof session.accessToken !== "string" || /\s/.test(session.accessToken)) && !cookies.length) {
    throw new Fault(503, "session_required", "Import your ChatGPT session before using live models.");
  }
  let deadline = Date.parse(session.expires);
  // JWT exp is a declared upper bound, not a guarantee the server still accepts it.
  try {
    const claims = JSON.parse(Buffer.from(session.accessToken.split(".")[1], "base64url").toString("utf8"));
    if (Number.isFinite(claims.exp)) deadline = Math.min(Number.isFinite(deadline) ? deadline : Infinity, claims.exp * 1000);
  } catch { /* Opaque tokens have no locally readable expiration. */ }
  if (Number.isFinite(deadline) && deadline <= Date.now() && !cookies.length) {
    throw new Fault(401, "session_expired", "Session has expired; import a renewed session.");
  }
  return { token: session.accessToken, cookies, deadline: Number.isFinite(deadline) ? new Date(deadline).toISOString() : null,
    ...(typeof session.userAgent === "string" && session.userAgent.length < 512 && !/[\r\n]/.test(session.userAgent) ? { userAgent: session.userAgent } : {}) };
}
