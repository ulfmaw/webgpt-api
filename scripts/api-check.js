import assert from "node:assert/strict";
import { initialize, dataDirectory } from "../src/settings.js";
import { readSse } from "../src/sse.js";
import { controlToken } from "../src/launcher.js";
const { key } = initialize(dataDirectory());
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const ids = [];
try {
  const state = await (await fetch("http://127.0.0.1:17840/status", { headers: { authorization: `Bearer ${controlToken(key)}` } })).json();
  console.log(JSON.stringify({ launcher: state.phase, generation_verified: state.generation_verified }));
  const post = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:17841/v1/${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    if (!r.ok) { const b=await r.json(); throw Error(`HTTP ${r.status}: ${b.error?.code}`); }
    return r;
  };
  const first = await (await post("responses", { model: "auto", input: "Remember this exact marker for our next turn: SUNFLOWER-4827. Reply only: remembered." })).json();
  ids.push(first.id);
  assert.equal(first.status, "completed");
  console.log(JSON.stringify({ test: "responses_json", status: first.status, model: first.model }));
  const second = await (await post("responses", { model: "auto", input: "What exact marker did I ask you to remember? Reply with the marker only.", previous_response_id: first.id, store: false })).json();
  const answer = second.output.flatMap(item => item.content).map(part => part.text ?? "").join("");
  assert.ok(answer.includes("SUNFLOWER-4827"), "Conversation history was not preserved");
  console.log(JSON.stringify({ test: "multi_turn", answer, model: second.model }));
  const stream = await post("chat/completions", { model: "auto", messages: [{ role: "user", content: "Reply only: STREAM-OK" }], stream: true });
  let output = "", done = false;
  for await (const data of readSse(stream.body)) {
    if (data === "[DONE]") { done = true; break; }
    const chunk = JSON.parse(data);
    assert.ok(!chunk.error, chunk.error?.code);
    output += chunk.choices?.[0]?.delta?.content ?? "";
  }
  assert.equal(done, true);
  assert.ok(output.includes("STREAM-OK"));
  console.log(JSON.stringify({ test: "chat_sse", answer: output, done }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  // Remove only the synthetic test's own local rows; no user conversations are touched.
  if (ids.length) {
    const { DatabaseSync } = await import("node:sqlite"); const { join } = await import("node:path");
    const db = new DatabaseSync(join(dataDirectory(), "conversations.sqlite"));
    try { const remove = db.prepare("DELETE FROM turns WHERE id = ?"); for (const id of ids) remove.run(id); }
    finally { db.close(); }
  }
}
