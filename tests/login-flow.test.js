import test from "node:test";
import assert from "node:assert/strict";
import { waitForAuthenticatedSession } from "../src/login-flow.js";
import { LaunchController } from "../src/launcher.js";
import { Fault } from "../src/errors.js";

function clock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; } };
}

test("login completes automatically while its window remains open", async () => {
  let attempts = 0;
  const session = { accessToken: "test-only-auth-token-not-real" };
  const result = await waitForAuthenticatedSession({ ...clock(), isClosed: () => false,
    probe: async () => ++attempts < 3 ? null : session });
  assert.equal(result, session);
  assert.equal(attempts, 3);
});

test("missing or malformed credentials are not a successful login", async () => {
  const values = [{}, { accessToken: "short" }, { accessToken: "whitespace is not a token" }, null];
  await assert.rejects(waitForAuthenticatedSession({ ...clock(), timeout: 5000, probe: async () => values.shift() }), { code: "login_timeout" });
});

test("closing or cancelling login cannot masquerade as completion", async () => {
  let probes = 0;
  await assert.rejects(waitForAuthenticatedSession({ isClosed: () => true, probe: async () => { probes++; } }), { code: "login_window_closed" });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(waitForAuthenticatedSession({ signal: abort.signal, probe: async () => { probes++; } }), { name: "AbortError" });
  assert.equal(probes, 0);
});

test("first run opens login without a button, then automatically verifies generation", async () => {
  const steps = [];
  let authenticated = false;
  const controller = new LaunchController({
    login: async () => { steps.push("login"); authenticated = true; },
    probe: async () => { steps.push("probe"); if (!authenticated) throw new Fault(503, "session_required", "No session"); },
  });
  controller.start("startup"); await controller.task;
  assert.deepEqual(steps, ["probe", "login", "probe"]);
  assert.equal(controller.state.generation_verified, true);
  await controller.close();
});

test("first-run failure never reopens login or marks the API usable", async () => {
  let logins = 0;
  const controller = new LaunchController({ login: async () => { logins++; }, probe: async () => { throw new Fault(503, "session_required", "No session"); } });
  controller.start("startup"); await controller.task;
  assert.equal(logins, 1);
  assert.equal(controller.state.phase, "blocked");
  assert.equal(controller.state.generation_verified, false);
  await controller.close();
});

test("an existing session's verification failure does not trigger automatic login", async () => {
  let logins = 0;
  const controller = new LaunchController({ login: async () => { logins++; }, probe: async () => { throw new Fault(503, "web_verification_required", "Verify"); } });
  controller.start("startup"); await controller.task;
  assert.equal(logins, 0);
  assert.equal(controller.state.phase, "blocked");
  await controller.close();
});
