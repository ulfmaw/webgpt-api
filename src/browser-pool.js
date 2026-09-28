import { Gate } from "./gate.js";
import { Fault } from "./errors.js";
import { interactiveLogin } from "./login.js";

export class BrowserPool {
  gate = new Gate(1);
  connection = null;
  opening = null;
  running = null;
  closing = null;
  idle = null;
  constructor(directory, { idleMs = 2000, login = interactiveLogin } = {}) {
    this.directory = directory; this.idleMs = idleMs; this.login = login;
  }
  async open() {
    if (this.closing) await this.closing;
    if (this.connection && !this.connection.closed) return this.connection;
    if (this.opening) return this.opening;
    this.abort = new AbortController();
    const ready = Promise.withResolvers();
    const release = Promise.withResolvers();
    this.release = release.resolve;
    this.opening = ready.promise;
    this.running = this.login(this.directory, {
      background: true, timeout: 20_000, signal: this.abort.signal, onStatus: () => {},
      onAuthenticated: async connection => {
        this.connection = connection;
        ready.resolve(connection);
        await release.promise;
      },
    }).catch(error => {
      ready.reject(error?.code === "login_timeout" ? new Fault(503, "background_session_unverified", "The background page did not confirm its session in time. This can be a connection, website verification, or login problem; an expired login has not been established.") : error);
    }).finally(() => { this.connection = null; this.opening = null; });
    return ready.promise;
  }
  async run(job, signal) {
    const release = await this.gate.enter(signal);
    clearTimeout(this.idle);
    const cancel = () => { void this.close(); };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const connection = await this.open();
      signal?.throwIfAborted();
      return await job(connection);
    } catch (error) { await this.close(); throw error; }
    finally {
      signal?.removeEventListener("abort", cancel);
      release();
      if (!this.gate.active) {
        this.idle = setTimeout(() => { void this.close(); }, this.idleMs);
        this.idle.unref();
      }
    }
  }
  close() {
    if (this.closing) return this.closing;
    clearTimeout(this.idle);
    this.abort?.abort(); this.release?.();
    this.closing = Promise.resolve(this.running).finally(() => { this.closing = null; });
    return this.closing;
  }
}
