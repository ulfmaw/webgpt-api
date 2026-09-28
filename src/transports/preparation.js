import { setTimeout as delay } from "node:timers/promises";
import { Fault } from "../errors.js";

// Website prepare can update its selected model during initial hydration.
// Files uploaded before that transition are rejected by the native composer.
export function observePreparation(connection, { now = Date.now } = {}) {
  const pending = new Set();
  let lastActivity = now(), completed = false, rejected = false;
  let model, modelVersion = 0;
  const cleanups = [
    connection.on("Network.requestWillBeSent", event => {
      let url; try { url = new URL(event.request.url); } catch { return; }
      if (url.origin !== "https://chatgpt.com" || url.pathname !== "/backend-api/f/conversation/prepare") return;
      try {
        const next = JSON.parse(event.request.postData).model;
        if (typeof next === "string" && next !== model) { model = next; modelVersion++; }
      } catch { /* Never store request bodies; missing optional model cannot establish a change. */ }
      pending.add(event.requestId); lastActivity = now();
    }),
    connection.on("Network.responseReceived", event => {
      if (!pending.has(event.requestId)) return;
      pending.delete(event.requestId); lastActivity = now();
      completed = event.response.status === 200;
      rejected = !completed;
    }),
    connection.on("Network.loadingFailed", event => {
      if (!pending.delete(event.requestId)) return;
      lastActivity = now(); rejected = true;
    }),
  ];
  return {
    modelVersion: () => modelVersion,
    ready: () => completed && !rejected && !pending.size && now() - lastActivity >= 1000,
    async wait(signal, { attachments = true } = {}) {
      const deadline = now() + 20_000;
      while (now() < deadline) {
        signal.throwIfAborted();
        if (this.ready()) return;
        await delay(100, undefined, { signal });
      }
      throw new Fault(503, attachments ? "attachment_model_not_ready" : "model_not_ready", "The website has not finished preparing its model. No message was sent.");
    },
    dispose: () => { for (const cleanup of cleanups) cleanup(); },
  };
}
