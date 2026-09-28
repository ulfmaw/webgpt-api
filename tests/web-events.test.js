import test from "node:test";
import assert from "node:assert/strict";
import { WebEventDecoder } from "../src/transports/web-events.js";
const message = (content, channel = "final", status = "in_progress") => ({ message: { id: "test-message", author: { role: "assistant" }, channel, status, content: { content_type: "text", parts: [content] }, metadata: { model_slug: "test-model" } } });
test("decodes full snapshots, append and nested patch events without reasoning leakage", () => {
  const d = new WebEventDecoder();
  assert.equal(d.push(JSON.stringify("v1")), null);
  assert.equal(d.push(JSON.stringify({ p: "", o: "add", v: message("not public", "analysis") })), null);
  d.push(JSON.stringify({ v: message("") }));
  assert.deepEqual(d.push(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "你" })), { text: "你", model: "test-model" });
  assert.equal(d.push(JSON.stringify({ v: "好" })).text, "好");
  d.push(JSON.stringify({ o: "patch", v: [{ p: "/message/status", o: "replace", v: "finished_successfully" }, { p: "/message/metadata", o: "append", v: { done: true } }] }));
  d.push("[DONE]"); d.verify();
  assert.equal(d.text, "你好");
});
test("rejects truncation, revisions, protocol errors and prototype mutations", () => {
  const d = new WebEventDecoder();
  d.push(JSON.stringify({ p: "", o: "add", v: message("hello") }));
  assert.throws(() => d.verify(), { code: "incomplete_generation" });
  assert.throws(() => d.push(JSON.stringify({ p: "/message/content/parts/0", o: "replace", v: "different" })), { code: "non_append_stream" });
  assert.throws(() => d.push(JSON.stringify({ p: "/__proto__/bad", o: "add", v: true })), { code: "web_protocol_changed" });
  assert.throws(() => new WebEventDecoder().push(JSON.stringify({ error: "failed" })), { code: "generation_failed" });
  assert.equal({}.bad, undefined);
});

test("website acknowledgement and reported model remain distinct, including metadata-only updates", () => {
  const d=new WebEventDecoder();
  const frame=message("OK","final","finished_successfully");
  frame.message.metadata={model_slug:"reported-model",requested_model_slug:"selected-model"};
  assert.deepEqual(d.push(JSON.stringify(frame)),{text:"OK",model:"reported-model",requested_model:"selected-model"});
  const update=d.push(JSON.stringify({p:"/message/metadata/requested_model_slug",o:"replace",v:"different-selection"}));
  assert.deepEqual(update,{text:"",model:"reported-model",requested_model:"different-selection"});
  d.push("[DONE]");d.verify();
});

test("uniform model denial is reported as a code and its description is not copied", () => {
  const d = new WebEventDecoder();
  const frame = message("OK", "final", "finished_successfully");
  frame.message.metadata = { model_slug: "gpt-5-mini", requested_model_slug: "gpt-6-pro", model_switcher_deny: [
    { slug: "gpt-6-pro", context: "conversation", reason: "unsupported_account_sharing", is_available: false, description: "do not copy" },
  ] };
  assert.deepEqual(d.push(JSON.stringify(frame)), { text: "OK", model: "gpt-5-mini", requested_model: "gpt-6-pro", model_denial: "unsupported_account_sharing" });
  assert.equal(JSON.stringify(d.push(JSON.stringify(frame)) ?? "").includes("do not copy"), false);
});
