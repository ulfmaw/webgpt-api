import test from "node:test";
import assert from "node:assert/strict";
import { readSse } from "../src/sse.js";
const collect = async input => { const values = []; for await (const value of input) values.push(value); return values; };
for (const separator of ["\r", "\n", "\r\n"]) test(`SSE library handles ${JSON.stringify(separator)} split at each byte`, async () => {
  const text = '\ufeff:comment' + separator + separator + ['id: 12', 'event: message', 'data: 中文: value', 'data: second', '', ''].join(separator);
  const bytes = Buffer.from(text); const stream = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  assert.deepEqual(await collect(readSse(stream)), ["中文: value\nsecond"]);
});
test("SSE library accepts mixed terminators and ignores unknown extension fields", async () => {
  assert.deepEqual(await collect(readSse(new Response("unknown: ignored\rdata: one\n\rdata: two\r\n\n").body)), ["one", "two"]);
});
test("SSE byte limit and incomplete events still fail explicitly", async () => {
  await assert.rejects(collect(readSse(new Response("data: 中文中文\n\n").body, 14)), { code: "stream_frame_too_large" });
  await assert.rejects(collect(readSse(new Response("data: incomplete\r").body)), { code: "stream_truncated" });
  await assert.rejects(collect(readSse(new Response(": " + "x".repeat(100)).body, 20)), { code: "stream_frame_too_large" });
  assert.deepEqual(await collect(readSse(new Response("data: one\n\ndata: two\n\n").body, 16)), ["one", "two"]);
});
