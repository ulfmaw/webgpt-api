import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Credentials } from "../src/credentials.js";
import { importSession } from "../src/settings.js";

function fixture(t, expires = -1) {
  const directory = mkdtempSync(join(tmpdir(), "webgpt-cookie-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  importSession({ cookies: [
    { name: "session-test", value: "not-real", domain: ".chatgpt.com", path: "/", expires },
    { name: "unrelated", value: "excluded", domain: ".example.com", path: "/" },
  ] }, directory);
  return directory;
}

test("cookie exchange stays on ChatGPT, coalesces requests, and does not persist the bearer", async t => {
  const directory = fixture(t);
  let calls = 0;
  const credentials = new Credentials(directory, { env: {}, fetcher: async (url, options) => {
    calls++;
    assert.equal(url, "https://chatgpt.com/api/auth/session");
    assert.equal(options.headers.cookie, "session-test=not-real");
    assert.equal(options.redirect, "error");
    return Response.json({ accessToken: "test-exchanged-bearer-not-real", expires: "2099-01-01T00:00:00Z" });
  } });
  const [a, b] = await Promise.all([credentials.get(), credentials.get()]);
  assert.equal(a.token, b.token);
  assert.equal((await credentials.get()).cookies.length, 1);
  assert.equal(calls, 1);
  assert.ok(!readFileSync(join(directory, "session.json"), "utf8").includes("exchanged"));
});

test("expired cookies stop without a network call", async t => {
  const credentials = new Credentials(fixture(t, 1), { env: {}, fetcher: async () => assert.fail("no network") });
  await assert.rejects(credentials.get(), { code: "session_expired" });
});

test("403 distinguishes browser verification from proven cookie expiry", async t => {
  const credentials = new Credentials(fixture(t), { env: {}, fetcher: async () => new Response("untrusted content", { status: 403 }) });
  await assert.rejects(credentials.get(), error => error.code === "web_verification_required" && !error.message.includes("untrusted content"));
});
