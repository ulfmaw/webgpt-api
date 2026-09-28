import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachFiles } from "../src/transports/attachments.js";
const file = { filename: "attachment-1-test.txt", base64: Buffer.from("test fixture").toString("base64") };
test("attachment upload retains private files until generation releases them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webgpt-upload-test-")); let selected = 0;
  try {
    const connection = { async call(method, params) {
      if (method === "Runtime.evaluate") return { result: { value: true } };
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.setFileInputFiles") { selected++; assert.equal(params.files.length, 1); assert.equal(readFileSync(params.files[0], "utf8"), "test fixture"); return {}; }
      throw Error("Unexpected call");
    } };
    const release = await attachFiles(connection, [file], dir, new AbortController().signal);
    assert.equal(selected, 1); assert.equal(readdirSync(dir).length, 1);
    release(); release(); assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("cancelled and failed uploads never leave temporary file content behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webgpt-upload-test-"));
  try {
    await assert.rejects(attachFiles({ call: async () => { throw Error("not reached"); } }, [file], dir, AbortSignal.abort()));
    assert.deepEqual(readdirSync(dir), []);
    await assert.rejects(attachFiles({ call: async () => { throw Error("synthetic failure"); } }, [file], dir, new AbortController().signal));
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
