// Real account calls using synthetic inputs only. No model-generated code executes.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import OpenAI from "openai";
import { initialize, dataDirectory } from "../src/settings.js";
const client = new OpenAI({ baseURL: "http://127.0.0.1:17841/v1", apiKey: initialize(dataDirectory()).key, maxRetries: 0, timeout: 120_000 });
const stored = [];
try {
  const marker = randomBytes(12).toString("hex");
  const filler = Array.from({ length: 200 }, (_, i) => `Synthetic row ${i}: ${randomBytes(12).toString("hex")}`).join("\n");
  const first = await client.responses.create({ model: "auto", input: `Remember secret_test_marker=${marker}. These are unrelated synthetic rows:\n${filler}\nReply only READY.`, store: true });
  stored.push(first.id); assert.equal(first.output_text.trim(), "READY");
  const second = await client.responses.create({ model: "auto", previous_response_id: first.id, input: "Return only the exact secret_test_marker from the previous user message.", store: true });
  stored.push(second.id); assert.equal(second.output_text.trim(), marker);
  console.log(JSON.stringify({ test: "live_context_200_rows", passed: true, model: second.model }));

  const answers = await Promise.all(["QUEUE-ONE", "QUEUE-TWO"].map(async expected => {
    const response = await client.responses.create({ model: "auto", input: `Reply only ${expected}`, store: false });
    assert.equal(response.output_text.trim(), expected); return response.id;
  }));
  assert.notEqual(answers[0], answers[1]);
  console.log(JSON.stringify({ test: "live_two_concurrent_clients", passed: true, isolated_responses: true }));

  const stream = await client.responses.create({ model: "auto", input: "Write the integers 1 through 1000, one per line. Do not abbreviate or explain.", stream: true, store: false });
  let received = false;
  for await (const event of stream) {
    if (event.type === "response.output_text.delta" && event.delta) { received = true; stream.controller.abort(); break; }
  }
  assert.equal(received, true);
  const recovered = await client.responses.create({ model: "auto", input: "Reply only STREAM-RECOVERED", store: false });
  assert.equal(recovered.output_text.trim(), "STREAM-RECOVERED");
  console.log(JSON.stringify({ test: "live_cancel_after_first_text_then_recover", passed: true, model: recovered.model }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, code: error.code ?? error.name, status: error.status ?? null })); process.exitCode = 1;
} finally {
  for (const id of stored.reverse()) await client.responses.delete(id).catch(() => {});
}
