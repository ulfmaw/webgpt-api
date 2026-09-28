import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserTransport, generationStream } from "../src/transports/browser.js";
import { matchesModelSelection, modelDenialReason } from "../src/model-identity.js";

test("native request acknowledgement never conceals an unacknowledged model substitution", () => {
  assert.equal(matchesModelSelection("chosen","reported","chosen"),false);
  assert.equal(matchesModelSelection("chosen","chosen",undefined),true);
  assert.equal(matchesModelSelection("chosen","reported",undefined),false);
  assert.equal(matchesModelSelection("chosen","chosen","other"),false);
  assert.equal(matchesModelSelection("chosen","reported","other"),false);
  assert.equal(matchesModelSelection("chosen",null,"chosen"),false);
});

test("a uniform model-switcher denial reason is kept and mixed entries are dropped", () => {
  const denied = slug => ({ slug, context: "conversation", reason: "unsupported_account_sharing", is_available: false, description: "private wording" });
  assert.equal(modelDenialReason({ model_switcher_deny: [denied("gpt-6-pro"), denied("gpt-5-6-thinking")] }), "unsupported_account_sharing");
  assert.equal(modelDenialReason({ model_switcher_deny: [denied("gpt-6-pro"), { ...denied("gpt-5-6"), reason: "other_limit" }] }), null);
  assert.equal(modelDenialReason({ model_switcher_deny: [{ reason: "free text", is_available: false }] }), null);
  assert.equal(modelDenialReason({}), null);
});

test("model interception is active before navigation starts native preparation", async () => {
  const calls=[];
  const connection={on:()=>()=>{},call:async method=>{
    calls.push(method);
    if(method==="Page.navigate")throw Error("synthetic_navigation_stop");
    return {};
  }};
  await assert.rejects(generationStream(connection,{model:"candidate",messages:[{role:"user",content:"test"}]},new AbortController().signal),/synthetic_navigation_stop/);
  assert.ok(calls.indexOf("Fetch.enable")>=0);
  assert.ok(calls.indexOf("Fetch.enable")<calls.indexOf("Page.navigate"));
});
test("generation without a login fails before opening any browser", async () => {
  const temp = mkdtempSync(join(tmpdir(), "webgpt-no-session-")); let opened = 0;
  try {
    const transport = new BrowserTransport(temp, { pool: { run: () => { opened++; throw Error("Must not open"); } } });
    await assert.rejects(async () => { for await (const part of transport.generate({ model: "auto", automatic: true, messages: [{ role: "user", content: "hello" }] })) void part; }, { code: "session_required", status: 503 });
    assert.equal(opened, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
