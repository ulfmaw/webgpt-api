import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importSession } from "../src/settings.js";
import { restoreBrowserSession } from "../src/browser-session.js";
const cookie = { name: "__Secure-next-auth.session-token.0", value: "synthetic-only", domain: ".chatgpt.com", path: "/", expires: 2000 };
test("browser recovery verifies existing login cookies, excludes clearance and preserves expiry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webgpt-session-restore-")); const calls = []; let verified = false;
  try {
    importSession({ cookies: [cookie, { ...cookie, name: "cf_clearance", value: "never-restored" }, { ...cookie, name: "__cf_bm", value: "never-restored" }] }, dir);
    await restoreBrowserSession({ call: async (method, params) => { assert.equal(verified, true); calls.push({ method, params }); return method === "Network.getAllCookies" ? { cookies: [{ ...cookie, name: "__Secure-next-auth.session-token.2" }, { ...cookie, name: "cf_clearance" }, { ...cookie, domain: "other.invalid" }] } : {}; } }, dir, {
      now: 1000000, verify: async header => { assert.equal(header, cookie.name + "=" + cookie.value); verified = true; },
    });
    assert.deepEqual(calls.map(c => c.method), ["Network.getAllCookies", "Network.deleteCookies", "Network.setCookies"]);
    const sent = calls.at(-1).params.cookies; assert.equal(sent.length, 1); assert.equal(sent[0].expires, cookie.expires); assert.equal(sent[0].secure, true); assert.equal(sent[0].httpOnly, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("failed verification or expired cookies never mutate the browser", async () => {
  const dir = mkdtempSync(join(tmpdir(), "webgpt-session-restore-")); let calls = 0;
  const connection = { call: async () => { calls++; } };
  try {
    importSession({ cookies: [cookie] }, dir);
    await assert.rejects(restoreBrowserSession(connection, dir, { now: 1000000, verify: async () => { throw Error("synthetic rejected session"); } }));
    await assert.rejects(restoreBrowserSession(connection, dir, { now: 3000000, verify: async () => { throw Error("must not verify expired cookies"); } }), { code: "session_required" });
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
