import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { Engine } from "../src/engine.js";
import { ConversationStore } from "../src/state.js";
import { createLocalServer } from "../src/http.js";

async function fixture(t, generate = async function* () { yield { text: "你", model: "sdk-test" }; yield { text: "好", model: "sdk-test" }; }) {
  const store = new ConversationStore(":memory:");
  const engine = new Engine({ models: async () => [{ id: "sdk-test", default: true }], generate }, store);
  const key = "sdk-test-only-key-000000000000000000000";
  const app = createLocalServer({ engine, key }); const baseURL = await app.listen(0);
  const client = new OpenAI({ baseURL: baseURL + "/v1", apiKey: key, maxRetries: 0 });
  t.after(async () => { await app.close(); store.close(); });
  return { client, store, engine };
}

test("official SDK consumes models, Responses JSON and stream helper", async t => {
  const { client } = await fixture(t);
  assert.equal((await client.models.list()).data[0].id, "sdk-test");
  const first = await client.responses.create({ model: "auto", input: "hello" });
  assert.equal(first.output_text, "你好");
  const retrieved = await client.responses.retrieve(first.id);
  assert.deepEqual(retrieved.output, first.output); assert.equal(retrieved.created_at, first.created_at);
  const stream = client.responses.stream({ model: "auto", input: "continue", previous_response_id: first.id });
  let text = ""; stream.on("response.output_text.delta", e => { text += e.delta; });
  const result = await stream.finalResponse();
  assert.equal(text, "你好"); assert.equal(result.output_text, "你好");
  assert.deepEqual(await client.responses.delete(first.id), { id: first.id, object: "response.deleted", deleted: true });
  await assert.rejects(client.responses.retrieve(first.id), error => error.status === 404);
});

test("official SDK consumes Chat JSON and stream accumulator", async t => {
  const { client } = await fixture(t);
  const body = { model: "auto", messages: [{ role: "user", content: "hello" }] };
  assert.equal((await client.chat.completions.create(body)).choices[0].message.content, "你好");
  const result = await client.chat.completions.stream(body).finalChatCompletion();
  assert.equal(result.choices[0].message.content, "你好");
});

async function* functionTransport(request) {
  const task = JSON.parse(request.messages[0].content);
  const last = task.conversation.at(-1);
  const value = last.type === "function_call_output" ? { reply: last.output, actions: [] } : { reply: null, actions: [{ name: "read_value", args: { key: "test" } }] };
  yield { text: JSON.stringify(value), model: "sdk-test" };
}
const definition = { name: "read_value", parameters: { type: "object", properties: { key: { type: "string", enum: ["test"] } }, required: ["key"], additionalProperties: false }, strict: true };

test("official SDK Responses stream accumulates real function call items and continuation", async t => {
  const { client } = await fixture(t, functionTransport);
  const tools = [{ type: "function", ...definition }];
  const first = await client.responses.stream({ model: "auto", input: "read", tools }).finalResponse();
  const call = first.output[0]; assert.equal(call.type, "function_call");
  const retrievedCall = (await client.responses.retrieve(first.id)).output[0];
  assert.equal(retrievedCall.call_id, call.call_id); assert.equal(retrievedCall.arguments, call.arguments); assert.equal(retrievedCall.id, call.id);
  assert.equal(call.name, "read_value"); assert.deepEqual(JSON.parse(call.arguments), { key: "test" });
  const result = await client.responses.create({ model: "auto", previous_response_id: first.id, input: [{ type: "function_call_output", call_id: call.call_id, output: "SDK-VALUE" }], tools });
  assert.equal(result.output_text, "SDK-VALUE");
});

for (const stream of [false, true]) test(`official SDK runTools executes once and resumes (stream=${stream})`, async t => {
  const { client } = await fixture(t, functionTransport); let executed = 0;
  const runner = client.chat.completions.runTools({ model: "auto", stream, messages: [{ role: "user", content: "read" }], tools: [{ type: "function", function: { ...definition, parse: JSON.parse, function: args => { assert.deepEqual(args, { key: "test" }); executed++; return "SDK-EXECUTED"; } } }] });
  assert.equal(await runner.finalContent(), "SDK-EXECUTED"); assert.equal(executed, 1);
});

test("official SDK parses schema-validated JSON and surfaces unsupported options", async t => {
  const { client } = await fixture(t, async function* () { yield { text: JSON.stringify({ reply: '{"total":7}', actions: [] }), model: "sdk-test" }; });
  const result = await client.responses.parse({ model: "auto", input: "test", text: { format: { type: "json_schema", name: "result", schema: { type: "object", properties: { total: { type: "integer" } }, required: ["total"], additionalProperties: false }, strict: true } } });
  assert.deepEqual(result.output_parsed, { total: 7 });
  const tolerant = await client.responses.create({ model: "auto", input: "test", temperature: 0, reasoning: { effort: "high" } });
  assert.equal(typeof tolerant.output_text, "string");
});
