import { Fault } from "../errors.js";
import { modelDenialReason } from "../model-identity.js";

const fail = () => { throw new Fault(502, "web_protocol_changed", "Unsupported website stream update; no partial answer is stored."); };
function patch(root, path, operation, value) {
  if (operation === "patch") {
    if (!Array.isArray(value) || path !== "") fail();
    for (const item of value) root = patch(root, item.p ?? "", item.o, item.v);
    return root;
  }
  if (path === "") { if (!["add", "replace"].includes(operation)) fail(); return structuredClone(value); }
  if (typeof path !== "string" || !path.startsWith("/") || !root || typeof root !== "object") fail();
  const parts = path.slice(1).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.some(p => ["__proto__", "constructor", "prototype"].includes(p))) fail();
  let target = root;
  for (const key of parts.slice(0, -1)) {
    if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== "object") fail();
    target = target[key];
  }
  const key = parts.at(-1);
  if (operation === "append") {
    if (typeof target[key] === "string" && typeof value === "string") target[key] += value;
    else if (Array.isArray(target[key]) && Array.isArray(value)) target[key].push(...structuredClone(value));
    else if (target[key] && value && typeof target[key] === "object" && typeof value === "object" && !Array.isArray(target[key]) && !Array.isArray(value)) {
      if (Object.keys(value).some(k => ["__proto__", "constructor", "prototype"].includes(k))) fail();
      Object.assign(target[key], structuredClone(value));
    }
    else fail();
  } else if (["add", "replace"].includes(operation)) {
    if (Array.isArray(target)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) > target.length) fail();
    }
    target[key] = structuredClone(value);
  } else if (operation === "remove") {
    if (Array.isArray(target)) { if (!/^\d+$/.test(key)) fail(); target.splice(Number(key), 1); }
    else delete target[key];
  } else fail();
  return root;
}

export class WebEventDecoder {
  state = null;
  path = "";
  operation = "add";
  text = "";
  messageId = null;
  model = null;
  requestedModel = null;
  denial = null;
  finished = false;
  done = false;
  modern = false;
  push(data) {
    if (data === "[DONE]") { this.done = true; return null; }
    let event; try { event = JSON.parse(data); } catch { fail(); }
    if (typeof event === "string") { if (event !== "v1") fail(); this.modern = true; return null; }
    if (!event || typeof event !== "object") fail();
    if (event.error || event.error_code) throw new Fault(502, "generation_failed", "Website generation failed. No request was replayed.");
    if (event.message) this.state = event;
    else if (Object.hasOwn(event, "v")) {
      this.path = event.p ?? (event.o === "patch" ? "" : this.path);
      this.operation = event.o ?? this.operation;
      this.state = patch(this.state, this.path, this.operation, event.v);
    } else return null; // non-message markers / metadata never become answer text
    if (this.state?.error || this.state?.error_code) throw new Fault(502, "generation_failed", "Website generation failed. No request was replayed.");
    const message = this.state?.message;
    if (this.modern && message?.channel !== "final") return null;
    if (message?.author?.role !== "assistant" || (message.channel && message.channel !== "final")) return null;
    if (message.content?.content_type !== "text" || !Array.isArray(message.content.parts) || message.content.parts.some(p => typeof p !== "string")) return null;
    const next = message.content.parts.join("");
    if (!next && !this.text) return null;
    if (this.messageId && message.id && message.id !== this.messageId) fail();
    this.messageId = message.id ?? this.messageId;
    if (!next.startsWith(this.text)) throw new Fault(502, "non_append_stream", "The website revised emitted text; refusing a corrupted answer.");
    const previousModel = this.model, previousRequested = this.requestedModel, previousDenial = this.denial;
    this.model = message.metadata?.model_slug ?? this.model;
    this.requestedModel = message.metadata?.requested_model_slug ?? this.requestedModel;
    this.denial = modelDenialReason(message.metadata) ?? this.denial;
    for (const identity of [this.model, this.requestedModel]) if (identity != null && (typeof identity !== "string" || !identity || identity.length > 160)) fail();
    this.finished = message.status === "finished_successfully";
    const delta = next.slice(this.text.length);
    this.text = next;
    return delta || previousModel !== this.model || previousRequested !== this.requestedModel || previousDenial !== this.denial
      ? { text: delta, ...(this.model ? { model: this.model } : {}), ...(this.requestedModel ? { requested_model: this.requestedModel } : {}), ...(this.denial ? { model_denial: this.denial } : {}) } : null;
  }
  verify() {
    if (!this.done || !this.finished || !this.text) throw new Fault(502, "incomplete_generation", "The website did not complete a non-empty answer.");
  }
}
