import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../src/state.js";
test("stored response identity and metadata survive restart; deletion is explicit", () => {
  const dir = mkdtempSync(join(tmpdir(), "webgpt-response-test-")); const path = join(dir, "store.sqlite"); let store;
  try {
    store = new ConversationStore(path); store.save({ id: "a", input: [], output: [{ role: "assistant", content: "one" }], model: "test", details: { created: 1234, itemId: "msg_test" } });
    store.save({ id: "b", parent: "a", input: [{ role: "user", content: "next" }], output: [{ role: "assistant", content: "two" }], model: "test" });
    store.close(); store = new ConversationStore(path);
    assert.equal(store.retrieve("a").itemId, "msg_test"); assert.equal(store.retrieve("a").created, 1234);
    assert.equal(store.delete("a").deleted, true);
    assert.throws(() => store.retrieve("a"), { code: "response_not_found", status: 404 });
    assert.throws(() => store.history("b"), { code: "history_missing" });
    assert.equal(store.retrieve("b").output[0].content, "two");
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("legacy database migrates without deleting existing history or inventing response metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "webgpt-response-test-")); const path = join(dir, "store.sqlite"); let store;
  try {
    const db = new DatabaseSync(path); db.exec("CREATE TABLE turns (id TEXT PRIMARY KEY,parent TEXT,input TEXT NOT NULL,output TEXT NOT NULL,model TEXT NOT NULL,expires INTEGER NOT NULL,bytes INTEGER NOT NULL)");
    db.prepare("INSERT INTO turns VALUES (?,?,?,?,?,?,?)").run("old", null, '[{"role":"user","content":"old-input"}]', '[{"role":"assistant","content":"old-output"}]', "test", Date.now() + 100000, 100); db.close();
    store = new ConversationStore(path);
    assert.equal(store.history("old")[0].content, "old-input");
    assert.throws(() => store.retrieve("old"), { code: "legacy_response_metadata_missing" });
    store.save({ id: "new", parent: "old", input: [], output: [{ role: "assistant", content: "new" }], model: "test" });
    assert.equal(store.history("new").length, 3);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
