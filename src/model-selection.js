import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Fault, publicError } from "./errors.js";
import { validateRequest } from "./engine.js";
import { matchesModelSelection } from "./model-identity.js";

const nativeAuto = () => ({ key: "auto", id: "auto", label: "ChatGPT 原生 Auto", nativeAuto: true });
export function modelOptions(body) {
  if (!Array.isArray(body?.models)) throw new Fault(502, "model_discovery_failed", "Website model catalog is unavailable.");
  const options = [nativeAuto()];
  const seen = new Set(["auto"]);
  for (const model of body.models) {
    if (!model || typeof model !== "object") continue;
    // The account catalog also advertises work-mode entries (usually `*-wm`).
    // They are a different ChatGPT route and must not be selectable by this
    // regular-chat transport. Trust the provider flag, not a slug heuristic.
    if (model?.is_work_mode_model === true || model?.work_mode === true) continue;
    const key = model.option_key ?? model.slug;
    if (typeof model.slug !== "string" || model.slug.length > 160 || !model.slug || typeof key !== "string" || !key || key.length > 160 || seen.has(key)) continue;
    seen.add(key);
    options.push({ key, id: model.slug, label: typeof model.title === "string" ? model.title.slice(0,160) : model.slug, nativeAuto: false,
      ...(model.group ? { group: model.group, preset: model.preset } : {}),
      ...(model.thinking_effort !== undefined ? { thinking_effort: model.thinking_effort } : {}) });
  }
  return options;
}

export class ModelSelection {
  current = nativeAuto();
  options = [];
  checkedAt = null;
  busy = false;
  verifications = new Map();
  constructor(directory, engine, discover) {
    this.path = join(directory, "model-selection.json"); this.engine = engine; this.discover = discover;
    if (existsSync(this.path)) {
      try {
        const saved = JSON.parse(readFileSync(this.path, "utf8"));
        if (typeof saved.id !== "string" || !saved.id || saved.id.length > 160 || typeof saved.label !== "string") throw Error();
        const key = saved.key ?? saved.id;
        if (typeof key !== "string" || !key || key.length > 160 || (saved.thinking_effort !== undefined && (typeof saved.thinking_effort !== "string" || !/^[a-z_]{1,40}$/.test(saved.thinking_effort)))) throw Error();
        this.current = { key, id: saved.id, label: saved.label.slice(0,160), nativeAuto: saved.id === "auto",
          ...(saved.thinking_effort !== undefined ? { thinking_effort: saved.thinking_effort } : {}),
          ...(typeof saved.group === "string" && typeof saved.preset === "string" ? { group: saved.group.slice(0,80), preset: saved.preset.slice(0,80) } : {}) };
      } catch { throw new Fault(500, "invalid_model_selection", "Saved model selection is invalid; it was not silently replaced."); }
    }
  }
  snapshot() { return { ...this.current }; }
  optionStatus(option) {
    return this.verifications.get(option.key)?.status ?? "account_reported";
  }
  state() {
    const selectedInCatalog = this.current.nativeAuto || this.options.some(item => item.key === this.current.key);
    const selectedStatus = !this.checkedAt ? "not_refreshed"
      : !selectedInCatalog ? "not_reported"
      : this.optionStatus(this.current);
    const evidence = this.verifications.get(this.current.key);
    const succeeded = selectedStatus === "verified";
    return {
      selected: this.snapshot(),
      options: this.options.map(option => ({ ...option, ...this.verifications.get(option.key), status: this.optionStatus(option) })),
      checked_at: this.checkedAt,
      busy: this.busy,
      selected_status: selectedStatus,
      generation_verified: succeeded,
      ...(succeeded ? {
        selected_actual_model: evidence.actual_model,
        actual_model: evidence.actual_model,
        verified_at: evidence.at,
        ...(evidence.requested_model ? { selected_requested_model: evidence.requested_model } : {}),
      } : {}),
      ...(evidence?.status === "failed" ? { selected_error: evidence.error } : {}),
    };
  }
  async refresh() {
    if (this.busy) throw new Fault(409, "selection_busy", "Wait for the current model operation to finish.");
    this.busy = true;
    try { await this.refreshCatalog(); } finally { this.busy = false; }
    return this.state();
  }
  async refreshCatalog() {
    const options = await this.discover();
    for (const previous of this.options) {
      const next = options.find(option=>option.key===previous.key);
      if (!next || next.id!==previous.id || next.thinking_effort!==previous.thinking_effort) this.verifications.delete(previous.key);
    }
    const current = options.find(option=>option.key===this.current.key);
    if (current) this.current = { ...current };
    this.options = options; this.checkedAt = new Date().toISOString();
    // A read-only refresh does not erase a completed generation. Re-login
    // invalidates all evidence separately, before a different account can load.
    for (const key of this.verifications.keys()) if (!options.some(o => o.key === key)) this.verifications.delete(key);
    this.engine.catalog.refresh();
    return this.state();
  }
  markVerified(actualModel, key = this.current.key, acknowledged) {
    const id = this.options.find(option=>option.key===key)?.id ?? (this.current.key===key ? this.current.id : key);
    if (typeof actualModel !== "string" || !actualModel || (key !== "auto" && !matchesModelSelection(id, actualModel, acknowledged))) return false;
    this.verifications.set(key, { status: "verified", actual_model: actualModel,
      ...(acknowledged ? { requested_model: acknowledged } : {}), at: new Date().toISOString() });
    return true;
  }
  invalidate(key) { if (key === undefined) this.verifications.clear(); else this.verifications.delete(key); }
  markFailed(error, key = this.current.key) {
    this.verifications.set(key, { status: "failed", at: new Date().toISOString(), error: publicError(error) });
  }
  async probe(option, signal) {
    let result;
    const request = { ...validateRequest({ input: "Reply only: OK", store: false }), selectionOverride: option };
    for await (const event of this.engine.run(request, signal)) if (event.kind === "done") result = event;
    if (!result?.text?.trim()) throw new Fault(502, "empty_probe", "No complete text response was received.");
    if (!option.nativeAuto && !matchesModelSelection(option.id, result.model, result.requested_model)) throw new Fault(409, "model_substituted", "The website did not acknowledge the selected model. Selection was not saved.", { requested_model: option.id, actual_model: result.model, ...(result.model_denial ? { reason: result.model_denial } : {}) });
    return { actual_model: result.model, ...(result.requested_model ? { requested_model: result.requested_model } : {}) };
  }
  async apply(key, signal, { save = true } = {}) {
    if (this.busy) throw new Fault(409, "selection_busy", "A model selection is already being tested.");
    this.busy = true;
    try {
      await this.refreshCatalog(); signal?.throwIfAborted();
      const option = this.options.find(item => item.key === key);
      if (!option) throw new Fault(409, "model_not_available", "This model is not in the refreshed account catalog. Refresh or update login if account access changed.");
      let result;
      try { result = await this.probe(option, signal); signal?.throwIfAborted(); }
      catch (error) {
        this.markFailed(error, key);
        throw error;
      }
      if (save) {
        const next = `${this.path}.tmp`;
        writeFileSync(next, JSON.stringify(option), { mode: 0o600 });
        renameSync(next, this.path);
        this.current = { ...option };
      }
      this.markVerified(result.actual_model, option.key, result.requested_model);
      return { ...this.state(), busy: false, ...result };
    } finally { this.busy = false; }
  }
}
