import { Fault } from "./errors.js";
import { createSseParser } from "../vendor/schema-validator.js";

export async function* readSse(stream, maxFrameBytes = 2 * 1024 * 1024) {
  if (!stream) throw new Fault(502, "empty_stream", "Remote server returned no stream.");
  const decoder = new TextDecoder();
  const pending = [];
  const tooLarge = () => new Fault(502, "stream_frame_too_large", "Remote stream frame exceeds the safety limit.");
  const parser = createSseParser({ maxBufferSize: maxFrameBytes, onEvent: event => { if (event.data) pending.push(event.data); },
    onError: error => { if (error.type === "max-buffer-size-exceeded") throw tooLarge(); } });
  // Only size/completion bookkeeping is local; the library parses SSE semantics.
  // Track bytes, not just JS characters, and recognize CR, LF and split CRLF.
  let frameBytes = 0, lineLength = 0, hasContent = false, previousCR = false;
  const account = text => {
    for (const char of text) {
      if (previousCR && char === "\n") { previousCR = false; continue; }
      previousCR = char === "\r";
      if (char === "\n" || char === "\r") {
        if (!lineLength) { frameBytes = 0; hasContent = false; }
        else { frameBytes++; lineLength = 0; }
      } else { frameBytes += Buffer.byteLength(char); lineLength++; if (char.trim()) hasContent = true; }
      if (frameBytes > maxFrameBytes) throw tooLarge();
    }
  };
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      const text = decoder.decode(value, { stream: !done });
      account(text); parser.feed(text);
      while (pending.length) yield pending.shift();
      if (done) {
        if (hasContent) throw new Fault(502, "stream_truncated", "Remote stream ended inside an event.");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
