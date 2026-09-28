import { Fault } from "./errors.js";

export class Catalog {
  cached = null;
  pending = null;
  revision = 0;
  blocked = new Map();
  constructor(transport, { clock = Date.now, ttl = 60_000 } = {}) {
    this.transport = transport;
    this.clock = clock;
    this.ttl = ttl;
  }
  async list() {
    if (this.cached && this.cached.until > this.clock()) return this.cached.models;
    if (!this.pending) {
      const revision = this.revision;
      const pending = this.transport.models().then(models => {
        const seen = new Set();
        if (!Array.isArray(models)) throw new Fault(502, "model_discovery_failed", "Unrecognized model catalog.");
        const safe = models.filter(m => m && m.work_mode !== true && m.is_work_mode_model !== true && typeof m.id === "string" && m.id.length > 0 && m.id.length < 160 && !seen.has(m.id) && seen.add(m.id));
        if (revision === this.revision) this.cached = { models: safe, until: this.clock() + this.ttl };
        return safe;
      }).finally(() => { if (this.pending === pending) this.pending = null; });
      this.pending = pending;
    }
    return this.pending;
  }
  async candidates(requested) {
    const models = await this.list();
    if (requested && !["auto", "latest"].includes(requested)) {
      const match = models.find(m => m.id === requested);
      if (!match) throw new Fault(404, "model_not_available", "Requested model is not advertised by this account.");
      return [match];
    }
    const available = models.filter(m => !this.blocked.has(m.id) || this.blocked.get(m.id) <= this.clock());
    // Provider-advertised default first. No guess that a name means newest, unlimited, or best.
    return available.sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)));
  }
  unavailable(id, retryAfter) {
    // Missing reset time is recorded as unknown until an explicit refresh, never "one week".
    this.blocked.set(id, Number.isFinite(retryAfter) ? this.clock() + retryAfter * 1000 : Infinity);
  }
  refresh() { this.revision++; this.cached = null; this.pending = null; this.blocked.clear(); }
}
