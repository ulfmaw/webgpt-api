import { createHash } from "node:crypto";
import { Fault } from "./errors.js";
import { readSession } from "./settings.js";

// Cookies remain in the private local credential file. Exchanged bearer tokens
// are cached only in memory and never returned through the local API.
export class Credentials {
  cached = null;
  pending = null;
  constructor(directory, { fetcher = fetch, env = process.env } = {}) {
    this.directory = directory;
    this.fetcher = fetcher;
    this.env = env;
  }
  async get() {
    const session = readSession(this.directory, this.env);
    if (session.token && (!session.deadline || Date.parse(session.deadline) > Date.now() + 30_000)) return session;
    const cookies = session.cookies.filter(c => c.expires <= 0 || c.expires * 1000 > Date.now());
    if (!cookies.length) throw new Fault(401, "session_expired", "No unexpired ChatGPT cookies remain; import a renewed session.");
    const cookie = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    const identity = createHash("sha256").update(cookie).digest("hex");
    if (this.cached?.identity === identity && this.cached.until > Date.now()) return this.cached.session;
    if (this.pending?.identity === identity) return this.pending.promise;
    const promise = this.exchange(cookie, session.userAgent).then(result => {
      const resolved = { ...result, cookies, ...(session.userAgent ? { userAgent: session.userAgent } : {}) };
      this.cached = { identity, session: resolved, until: Math.min(Date.now() + 5 * 60_000, result.deadline ? Date.parse(result.deadline) - 30_000 : Infinity) };
      return resolved;
    }).finally(() => { if (this.pending?.promise === promise) this.pending = null; });
    this.pending = { identity, promise };
    return promise;
  }
  async exchange(cookie, userAgent) {
    let response;
    try {
      response = await this.fetcher("https://chatgpt.com/api/auth/session", {
        headers: { cookie, accept: "application/json", ...(userAgent ? { "user-agent": userAgent } : {}) }, redirect: "error", signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new Fault(502, "session_exchange_failed", "Could not contact ChatGPT to exchange cookies. No credential details are logged."); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Fault(response.status === 403 ? 503 : 401, response.status === 403 ? "web_verification_required" : "session_rejected", "ChatGPT rejected the cookie session or requires browser verification.");
    }
    let value;
    try { value = await response.json(); }
    catch { throw new Fault(502, "session_exchange_failed", "Session exchange returned an unsupported response."); }
    if (typeof value.accessToken !== "string" || value.accessToken.length < 20 || /\s/.test(value.accessToken)) {
      throw new Fault(401, "session_rejected", "These cookies do not yield an authenticated ChatGPT session.");
    }
    return { token: value.accessToken, deadline: Number.isFinite(Date.parse(value.expires)) ? new Date(value.expires).toISOString() : null };
  }
}
