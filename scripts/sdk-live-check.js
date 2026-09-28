// Uses the official SDK against localhost and the real signed-in website account.
// Executes only a fixed synthetic function; never runs model-supplied commands.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import OpenAI from "openai";
import { initialize, dataDirectory } from "../src/settings.js";
const client = new OpenAI({ baseURL: "http://127.0.0.1:17841/v1", apiKey: initialize(dataDirectory()).key, maxRetries: 0, timeout: 90_000 });
let storedId;
const fixtureDirectory = mkdtempSync(join(tmpdir(), "webgpt-sdk-live-"));
const fixturePath = join(fixtureDirectory, "verification.txt");
try {
  const text = await client.responses.stream({ model: "auto", input: "Reply only SDK-READY", store: true }).finalResponse();
  storedId = text.id;
  assert.equal(text.output_text.trim(), "SDK-READY");
  console.log(JSON.stringify({ test: "sdk_live_responses_stream", passed: true, model: text.model }));
  const stored = await client.responses.retrieve(storedId);
  assert.equal(stored.output_text, text.output_text); assert.equal(stored.output[0].id, text.output[0].id);
  assert.equal((await client.responses.delete(storedId)).deleted, true); storedId = undefined;
  console.log(JSON.stringify({ test: "sdk_live_retrieve_delete", passed: true }));
  let executed = 0;
  const observed = randomBytes(16).toString("hex"); writeFileSync(fixturePath, observed, { mode: 0o600 });
  const runner = client.chat.completions.runTools({ model: "auto", stream: true,
    messages: [{ role: "user", content: "Call read_test_value with key verification, then return only its exact value without additional text. You cannot know the value before the caller executes the function." }],
    tools: [{ type: "function", function: { name: "read_test_value", description: "Read a synthetic verification file that exists only on the caller's local machine.", strict: true,
      parameters: { type: "object", properties: { key: { type: "string", const: "verification" } }, required: ["key"], additionalProperties: false },
      parse: JSON.parse, function: args => { assert.deepEqual(args, { key: "verification" }); assert.equal(executed++, 0); return readFileSync(fixturePath, "utf8"); } } }],
  }, { maxChatCompletions: 3 });
  const answer = await runner.finalContent(); assert.equal(executed, 1); assert.equal(answer?.trim(), observed);
  console.log(JSON.stringify({ test: "sdk_live_streaming_run_tools", passed: true, executions: executed, local_file_read: true }));
  const parsed = await client.responses.parse({ model: "auto", input: "Return an object with email test@example.com and code SDK-OK.", store: false,
    text: { format: { type: "json_schema", name: "check", strict: true, schema: { type: "object", properties: { email: { type: "string", format: "email" }, code: { type: "string", pattern: "^SDK-OK$" } }, required: ["email", "code"], additionalProperties: false } } } });
  assert.deepEqual(parsed.output_parsed, { email: "test@example.com", code: "SDK-OK" });
  console.log(JSON.stringify({ test: "sdk_live_structured_parse", passed: true, model: parsed.model }));
} catch (error) {
  // Do not dump SDK request objects, headers, or response content.
  console.error(JSON.stringify({ passed: false, status: error.status ?? null, code: error.code ?? error.name }));
  process.exitCode = 1;
} finally {
  if (storedId) await client.responses.delete(storedId).catch(() => {});
  try { unlinkSync(fixturePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  rmdirSync(fixtureDirectory);
}
