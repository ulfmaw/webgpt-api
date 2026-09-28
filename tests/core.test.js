import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../src/state.js";
import { Engine, validateRequest } from "../src/engine.js";
import { Gate } from "../src/gate.js";
import { Catalog } from "../src/catalog.js";
import { Fault, publicError } from "../src/errors.js";
import { initialize, importSession, readSession } from "../src/settings.js";

const collect = async iterable => { const values = []; for await (const value of iterable) values.push(value); return values; };
const fake = () => ({ models: async () => [{ id: "account-default", default: true }, { id: "other" }],
  async *generate() { yield { text: "你好" }; yield { text: "，世界" }; } });

test("independent local settings never persist arbitrary account/profile fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "webgpt-settings-"));
  try {
    const first = initialize(directory);
    assert.equal(first.key, initialize(directory).key);
    importSession({ accessToken: "test-only-not-a-real-session", email: "ignored", cookie: "ignored" }, directory);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "session.json"))), { accessToken: "test-only-not-a-real-session", expires: null });
    assert.equal(readSession(directory, {}).deadline, null);
    importSession({ accessToken: "test-only-not-a-real-session", expires: "2000-01-01T00:00:00Z" }, directory);
    assert.throws(() => readSession(directory, {}), { code: "session_expired" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("SQLite delta history survives restart and branches without copying previous turns", () => {
  const directory = mkdtempSync(join(tmpdir(), "webgpt-store-"));
  const path = join(directory, "state.sqlite");
  let store;
  try {
    store = new ConversationStore(path);
    store.save({ id: "a", input: [{ role: "user", content: "first" }], output: [{ role: "assistant", content: "one" }], model: "m1" });
    store.save({ id: "b", parent: "a", input: [{ role: "user", content: "next" }], output: [{ role: "assistant", content: "two" }], model: "m2" });
    const row = store.db.prepare("SELECT input FROM turns WHERE id = 'b'").get();
    assert.equal(JSON.parse(row.input).length, 1);
    store.close();
    store = new ConversationStore(path);
    assert.deepEqual(store.history("b").map(x => x.content), ["first", "one", "next", "two"]);
    assert.equal(store.history("a").length, 2);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("missing, expired, or oversized context never becomes silent partial history", () => {
  let now = 0;
  const store = new ConversationStore(":memory:", { clock: () => now, ttl: 10 });
  try {
    assert.throws(() => store.history("missing"), { code: "history_missing" });
    store.save({ id: "a", input: ["中"], output: ["文"], model: "m" });
    assert.throws(() => store.history("a", 1), { code: "history_too_large" });
    now = 11;
    assert.throws(() => store.history("a"), { code: "history_missing" });
  } finally { store.close(); }
});

test("storage counts UTF-8 bytes and rolls back failed writes", () => {
  const store = new ConversationStore(":memory:", { maxBytes: 20 });
  try {
    store.save({ id: "a", input: ["中"], output: [], model: "m" });
    assert.throws(() => store.save({ id: "b", input: ["中文中文中文"], output: [], model: "m" }), { code: "storage_full" });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM turns").get().n, 1);
  } finally { store.close(); }
});

test("completed responses resume across model changes without retaining old instructions", async () => {
  const store = new ConversationStore(":memory:");
  const transport = fake();
  const calls = [];
  transport.generate = async function* (request) { calls.push(request); yield { text: "answer" }; };
  const engine = new Engine(transport, store);
  try {
    const first = (await collect(engine.run(validateRequest({ input: "one", instructions: "first instruction" })))).at(-1);
    const second = await collect(engine.run(validateRequest({ input: "two", model: "other", previous_response_id: first.id })));
    assert.equal(second.at(-1).model, "other");
    assert.deepEqual(calls[1].messages.map(m => m.content), ["one", "answer", "two"]);
    assert.equal(calls[1].instructions, undefined);
  } finally { store.close(); }
});

test("store:false leaves no recoverable row", async () => {
  const store = new ConversationStore(":memory:");
  try {
    const last = (await collect(new Engine(fake(), store).run(validateRequest({ input: "private", store: false })))).at(-1);
    assert.equal(last.stored, false);
    assert.throws(() => store.history(last.id), { code: "history_missing" });
  } finally { store.close(); }
});

test("only auto falls back after an explicit pre-generation model rejection", async () => {
  const store = new ConversationStore(":memory:");
  const transport = fake();
  const calls = [];
  transport.generate = async function* ({ model }) {
    calls.push(model);
    if (model === "account-default") throw new Fault(429, "model_unavailable", "unavailable", { modelUnavailable: true });
    yield { text: "fallback" };
  };
  try {
    const engine = new Engine(transport, store);
    const last = (await collect(engine.run(validateRequest({ input: "hello" })))).at(-1);
    assert.equal(last.model, "other");
    assert.deepEqual(calls, ["account-default", "other"]);
    await assert.rejects(collect(engine.run(validateRequest({ input: "hello", model: "account-default" }))), { code: "model_unavailable" });
  } finally { store.close(); }
});

test("never replay after a delta, generic rate limit, or network failure", async () => {
  for (const mode of ["delta", "rate", "network"]) {
    const store = new ConversationStore(":memory:");
    let calls = 0;
    const transport = fake();
    transport.generate = async function* () {
      calls++;
      if (mode === "delta") yield { text: "partial" };
      throw new Fault(mode === "rate" ? 429 : 502, "failure", "failed", { modelUnavailable: mode === "delta" });
    };
    const engine = new Engine(transport, store);
    try {
      await assert.rejects(collect(engine.run(validateRequest({ input: "hello" }))));
      assert.equal(calls, 1);
      assert.equal(engine.gate.active, 0);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM turns").get().n, 0);
    } finally { store.close(); }
  }
});

test("context preflight happens before any generation call", async () => {
  const store = new ConversationStore(":memory:");
  let called = false;
  const transport = fake();
  transport.generate = async function* () { called = true; };
  try {
    await assert.rejects(collect(new Engine(transport, store, { maxContextBytes: 10 }).run(validateRequest({ input: "中文中文中文" }))), { code: "context_too_large" });
    assert.equal(called, false);
  } finally { store.close(); }
});

test("bounded queue releases cancelled waiters without consuming concurrency", async () => {
  const gate = new Gate(1, 1);
  const release = await gate.enter();
  const abort = new AbortController();
  const waiting = gate.enter(abort.signal);
  await assert.rejects(gate.enter(), { code: "queue_full" });
  abort.abort();
  await assert.rejects(waiting);
  release(); release();
  assert.equal(gate.active, 0);
  assert.equal(gate.waiting.length, 0);
});

test("model refresh cannot be overwritten by an older in-flight account catalog", async () => {
  const old = Promise.withResolvers();let calls=0;
  const catalog=new Catalog({models:()=>++calls===1?old.promise:Promise.resolve([null,{id:"current"},{id:"work",work_mode:true}])});
  const pending=catalog.list();catalog.refresh();
  assert.deepEqual(await catalog.list(),[{id:"current"}]);
  old.resolve([{id:"old-account"}]);await pending;
  assert.deepEqual(await catalog.list(),[{id:"current"}]);
});

test("model discovery coalesces requests, refreshes new models, and does not invent cooldowns", async () => {
  let calls = 0;
  const catalog = new Catalog({ models: async () => { calls++; return [{ id: `version-${calls}`, default: true }]; } });
  await Promise.all([catalog.list(), catalog.list(), catalog.list()]);
  assert.equal(calls, 1);
  catalog.unavailable("version-1");
  assert.deepEqual(await catalog.candidates("auto"), []);
  catalog.refresh();
  assert.equal((await catalog.candidates("latest"))[0].id, "version-2");
});

test("unsupported tools and media are rejected; common client sampling fields are ignored", () => {
  for (const body of [{ input: "a", tools: [{type:"unsupported"}] }, { input: [{ role: "user", content: [{ type: "input_image", image_url: "ignored" }] }] }]) {
    assert.throws(() => validateRequest(body), Fault);
  }
  const tolerant = validateRequest({ input: "a", temperature: 0, top_p: 1, max_tokens: 16, reasoning_effort: "high", stream_options: { include_usage: true }, n: 1 });
  assert.equal(tolerant.model, "auto");
  assert.equal(tolerant.includeUsage, true);
  assert.throws(() => validateRequest({ input: "a", n: 2 }), { code: "unsupported_option" });
  assert.deepEqual(publicError(new Error("secret=value")), { code: "internal_error", message: "Request failed; no credentials or upstream body are logged.", type: "webgpt_error" });
  assert.deepEqual(publicError(new Fault(409, "model_substituted", "substituted", { requested_model: "gpt-6-pro", actual_model: "gpt-5-mini", reason: "unsupported_account_sharing" })).reason, "unsupported_account_sharing");
  assert.equal(publicError(new Fault(409, "model_substituted", "substituted", { reason: "not a code" })).reason, undefined);
});
