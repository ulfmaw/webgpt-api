import test from "node:test";
import assert from "node:assert/strict";
import { contentParts, prepareMedia } from "../src/media.js";
import { Engine, validateRequest } from "../src/engine.js";
import { ConversationStore } from "../src/state.js";
import { prepareWebsiteBody } from "../src/transports/browser.js";
const data = "data:text/plain;base64," + Buffer.from("synthetic-file-content").toString("base64");
const part = { type: "input_file", filename: "test.txt", file_data: data };
test("inline media validates filename, base64, detail and type without fetching URLs", () => {
  const input = contentParts([{ type: "input_text", text: "read" }, part], "user");
  assert.equal(input.content, "read"); assert.equal(input.attachments[0].filename, "test.txt");
  for (const p of [{ ...part, filename: "../test.txt" }, { ...part, file_data: "https://example.test/private" }, { ...part, file_data: "data:text/plain;base64,Y===" }, { type: "input_image", image_url: data }, { type: "input_audio" }]) assert.throws(() => contentParts([p], "user"), { code: "unsupported_media" });
  assert.throws(() => contentParts([part], "assistant"), { code: "unsupported_media" });
});
test("media prompt contains filenames, not base64, and deduplicates full history", () => {
  const record = { role: "user", ...contentParts([part], "user") };
  const media = prepareMedia([record, { role: "assistant", content: "read" }, record]);
  assert.equal(media.attachments.length, 1); assert.equal(JSON.stringify(media.input).includes(record.attachments[0].base64), false);
  assert.equal(media.input[0].attachments[0].filename, media.input[2].attachments[0].filename);
  assert.equal(record.attachments[0].filename, "test.txt");
});
test("too many attachments fail before generating instead of omitting files", () => {
  const records = Array.from({ length: 11 }, (_, i) => ({ role: "user", ...contentParts([{ ...part, filename: `${i}.txt` }], "user") }));
  assert.throws(() => prepareMedia(records), { code: "attachments_too_large" });
});
test("website request retains native uploaded file metadata and non-text image parts", () => {
  const native = { id: "test-native", content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "test-image" }, "draft"] }, metadata: { attachments: [{ id: "test-file", name: "attachment-1-test.txt" }] } };
  const result = prepareWebsiteBody({ messages: [native] }, "/backend-api/f/conversation", { model: "auto", messages: [{ role: "user", content: "full context" }], attachments: [{}] });
  assert.deepEqual(result.messages[0].metadata, native.metadata);
  assert.deepEqual(result.messages[0].content.parts, [native.content.parts[0], "full context"]);
  assert.throws(() => prepareWebsiteBody({ messages: [{ id: "empty" }] }, "/backend-api/f/conversation", { model: "auto", messages: [{ role: "user", content: "test" }], attachments: [{}] }), { code: "attachment_metadata_missing" });
});
test("attachment context persists across Responses continuation and supports tool prompts", async () => {
  const store = new ConversationStore(":memory:"), requests = [];
  const engine = new Engine({ models: async () => [{ id: "test" }], async *generate(r) { requests.push(r); yield { text: "read", model: "test" }; } }, store);
  try {
    let id;
    for await (const event of engine.run(validateRequest({ input: [{ role: "user", content: [part] }] }))) if (event.kind === "done") id = event.id;
    for await (const event of engine.run(validateRequest({ input: "read again", previous_response_id: id }))) void event;
    assert.equal(requests[1].attachments[0].base64, Buffer.from("synthetic-file-content").toString("base64"));
    assert.equal(requests[1].messages[0].content.includes("read again"), true);
    assert.equal(requests[1].messages[0].content.includes(requests[1].attachments[0].base64), false);
  } finally { store.close(); }
});
