import test from "node:test";
import assert from "node:assert/strict";
import { sessionStatus } from "../src/session-status.js";

const cookie = (name, expires) => ({ name, expires, value: "test-value-must-not-appear" });

test("login expiry and security cookie expiry remain separate", () => {
  const result = sessionStatus({ cookies: [
    cookie("__Secure-next-auth.session-token", 1000),
    cookie("cf_clearance", 2000),
    cookie("__cf_bm", 1),
  ] }, 100_000);
  assert.equal(result.session_cookie.expiry_state, "not_expired");
  assert.equal(result.bot_management_cookie.expiry_state, "expired");
  assert.equal(result.server_validity, "not_verified");
  assert.ok(!JSON.stringify(result).includes("test-value-must-not-appear"));
});

test("chunked auth cookies use the earliest declared expiry; no invented fixed lifetime", () => {
  const result = sessionStatus({ cookies: [
    cookie("__Secure-next-auth.session-token.0", 2000),
    cookie("__Secure-next-auth.session-token.1", 1000),
  ] }, 0);
  assert.equal(result.session_cookie.declared_expiry, new Date(1000_000).toISOString());
  assert.equal(sessionStatus({ cookies: [cookie("__Secure-next-auth.session-token", -1)] }).session_cookie.expiry_state, "unknown");
});

test("missing and malformed expirations cannot crash diagnostics or imply validity", () => {
  assert.equal(sessionStatus({ cookies: [] }).session_cookie.expiry_state, "missing");
  assert.equal(sessionStatus({ cookies: [cookie("__Secure-next-auth.session-token", 1e100)] }).session_cookie.expiry_state, "unknown");
  assert.equal(sessionStatus({ token: "hidden-test-token", deadline: "2099-01-01T00:00:00Z" }).server_validity, "not_verified");
});
