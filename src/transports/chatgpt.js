import { randomUUID } from "node:crypto";
import { Fault } from "../errors.js";
import { readSse } from "../sse.js";
import { chatPickerCatalog } from "./chat-catalog.js";

// Experimental website transport, isolated from the local API contract.
// This is NOT the paid API or the Codex backend. Website protocol/auth may change;
// challenges and unknown stream dialects stop explicitly instead of switching services.
export class ChatGptTransport {
  constructor(session, { fetcher = fetch } = {}) {
    this.session = session;
    this.fetcher = fetcher;
  }
  async request(path, options = {}) {
    const { token, cookies = [], userAgent } = await this.session();
    const cookie = cookies.filter(c => (!c.expires || c.expires <= 0 || c.expires * 1000 > Date.now())
      && (c.path === "/" || `/backend-api/${path}`.startsWith(c.path))).map(c => `${c.name}=${c.value}`).join("; ");
    let response;
    try {
      response = await this.fetcher(`https://chatgpt.com/backend-api/${path}`, {
        ...options, redirect: "error",
        signal: AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(options.method === "POST" ? 600_000 : 20_000)]),
        headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}), ...(userAgent ? { "user-agent": userAgent } : {}),
          referer: "https://chatgpt.com/", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin",
          "content-type": "application/json", accept: options.method === "POST" ? "text/event-stream" : "application/json" },
      });
    } catch {
      options.signal?.throwIfAborted();
      throw new Fault(502, "web_connection_failed", "ChatGPT connection failed; no request was automatically replayed.");
    }
    if (!response.ok) {
      // No website error signature has passed live downgrade verification yet.
      // Status, a plausible error name, or Retry-After alone must not authorize
      // replay on another model. Synthetic fixtures only prove local behavior.
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) throw new Fault(401, "session_rejected", "ChatGPT rejected the session; renew it.");
      if (response.status === 403) throw new Fault(503, "web_verification_required", "ChatGPT requires browser verification or denied access. Pure HTTP access is not available for this session.");
      if (response.status === 429) throw new Fault(429, "upstream_rate_limited", "ChatGPT rate-limited this request. The request was not replayed.");
      throw new Fault(502, "web_request_rejected", `ChatGPT rejected the request (HTTP ${response.status}); website protocol may have changed.`);
    }
    return response;
  }
  async models() {
    const response = await this.request("models");
    let body;
    try { body = await response.json(); }
    catch { throw new Fault(502, "web_protocol_changed", "Model discovery did not return JSON."); }
    return chatPickerCatalog(body).models
      .map(m => ({ id: m.slug, default: m.slug === body.default_model_slug }));
  }
  async *generate({ model, messages, instructions, signal }) {
    const conversation = instructions ? [{ role: "system", content: instructions }, ...messages] : messages;
    const response = await this.request("conversation", {
      method: "POST", signal,
      body: JSON.stringify({
        action: "next", model, parent_message_id: randomUUID(),
        history_and_training_disabled: true,
        messages: conversation.map(message => ({
          id: randomUUID(), author: { role: message.role },
          content: { content_type: "text", parts: [message.content] },
        })),
      }),
    });
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      await response.body?.cancel();
      throw new Fault(502, "web_protocol_changed", "Expected a text event stream from ChatGPT.");
    }
    let text = "";
    let completed = false;
    let sawAssistant = false;
    for await (const data of readSse(response.body)) {
      signal?.throwIfAborted();
      if (data === "[DONE]") { completed = true; break; }
      let event;
      try { event = JSON.parse(data); }
      catch { throw new Fault(502, "web_protocol_changed", "ChatGPT emitted an invalid event."); }
      if (event.error) throw new Fault(502, "generation_failed", "ChatGPT rejected generation after opening the stream; no fallback was attempted.");
      const message = event.message;
      // Tool/reasoning channels are not user-visible final answers.
      if (!message || message.author?.role !== "assistant" || (message.channel && message.channel !== "final")) continue;
      if (message.content?.content_type !== "text" || !Array.isArray(message.content.parts) || message.content.parts.some(p => typeof p !== "string")) {
        throw new Fault(502, "unsupported_output", "This transport currently supports text answers only.");
      }
      sawAssistant = true;
      const next = message.content.parts.join("");
      if (!next.startsWith(text)) throw new Fault(502, "non_append_stream", "The remote answer revised emitted text; refusing a corrupted stream.");
      if (next.length > text.length) yield { text: next.slice(text.length), model: message.metadata?.model_slug || model };
      text = next;
    }
    if (!completed || !sawAssistant) throw new Fault(502, "incomplete_generation", "ChatGPT did not return a supported, completed answer.");
  }
}
