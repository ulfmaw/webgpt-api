import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LaunchController, createLauncher, controlToken } from "../src/launcher.js";
import { loginArguments, acquireLoginLock } from "../src/login.js";
import { Fault } from "../src/errors.js";
import { request as httpRequest } from "node:http";

test("launcher guards both legacy and control-page entry points before clearing evidence", async () => {
  let busy=true,invalidated=0;
  const controller=new LaunchController({canStart:()=>!busy,onStart:()=>invalidated++,probe:async()=>({model:"auto"}),login:async()=>{}});
  assert.equal(controller.start("login"),false);assert.equal(invalidated,0);
  busy=false;assert.equal(controller.start("check"),true);assert.equal(invalidated,1);
  await controller.task;await controller.close();
});

test("generation failure stays blocked; never triggers automatic login", async () => {
  let logins = 0;
  const controller = new LaunchController({ probe: async () => { throw new Fault(503, "web_verification_required", "Verify login"); }, login: async () => { logins++; } });
  assert.equal(controller.start(), true);
  assert.equal(controller.start("login"), false);
  await controller.task;
  assert.equal(logins, 0);
  assert.equal(controller.state.phase, "blocked");
  assert.equal(controller.state.generation_verified, false);
  controller.start("login");
  await controller.task;
  assert.equal(logins, 1);
  assert.equal(controller.state.phase, "blocked");
  await controller.close();
});

test("only a completed probe transitions to ready; closing cancels active work", async () => {
  const controller = new LaunchController({ probe: async () => {}, login: async () => {} });
  controller.start(); await controller.task;
  assert.equal(controller.state.generation_verified, true);
  assert.equal(controller.state.phase, "ready");
  controller.probe = signal => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("private upstream error")), { once: true }));
  controller.start(); await Promise.resolve();
  await controller.close();
  assert.equal(controller.state.generation_verified, false);
  assert.ok(!JSON.stringify(controller.state).includes("private upstream"));
  assert.equal(controller.start(), false);
});

test("launcher protects credentials and mutations against unauthenticated and cross-origin requests", async () => {
  const key = "test-local-key-".repeat(4);
  const controller = new LaunchController({ probe: async () => {}, login: async () => {} });
  let stopped = false;
  const manager = createLauncher({ key, controller, apiUrl: "http://127.0.0.1:17841/v1", onStop: () => { stopped = true; } });
  const url = new URL(await manager.listen(0));
  const origin = url.origin;
  const headers = { authorization: `Bearer ${controlToken(key)}` };
  try {
    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes(key));
    assert.ok(page.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
    assert.equal((await fetch(`${origin}/key`, { method: "POST" })).status, 401);
    const rebinding = await new Promise((resolve, reject) => {
      const req = httpRequest(`${origin}/status`, { headers: { ...headers, host: "evil.invalid" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(rebinding, 403);
    assert.equal((await fetch(`${origin}/key`, { method: "POST", headers: { ...headers, origin: "https://evil.invalid" } })).status, 403);
    const status = await (await fetch(`${origin}/status`, { headers })).json();
    assert.equal(status.service, "webgpt-api-launcher");
    assert.ok(!JSON.stringify(status).includes(key));
    assert.deepEqual(await (await fetch(`${origin}/key`, { method: "POST", headers: { ...headers, origin } })).json(), { key });
    assert.equal((await fetch(`${origin}/check`, { method: "POST", headers })).status, 202);
    await controller.task;
    assert.equal(controller.state.phase, "ready");
    await fetch(`${origin}/stop`, { method: "POST", headers });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, true);
  } finally { await controller.close(); await manager.close(); }
});

test("managed login binds a nonzero debug port only on loopback and uses its own profile", () => {
  const normal = loginArguments("C:\\private\\app-profile");
  const capture = loginArguments("C:\\private\\app-profile", { debugPort: 49231 });
  assert.ok(normal.every(arg => !arg.includes("remote-debugging")));
  assert.equal(normal[0], capture[0]);
  assert.ok(normal.includes("--window-position=100,80"));
  assert.ok(normal.includes("--start-maximized"));
  assert.ok(!normal.includes("--start-minimized"));
  assert.ok(capture.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(capture.includes("--remote-debugging-port=49231"));
  assert.throws(() => loginArguments("profile", { debugPort: 0 }));
  const background = loginArguments("profile", { debugPort: 49231, background: true });
  assert.ok(background.includes("--start-minimized"));
  assert.equal(background.at(-1), "https://chatgpt.com/?temporary-chat=true");
});

test("login lock prevents concurrent profile use and can be released", () => {
  const temp = mkdtempSync(join(tmpdir(), "webgpt-login-test-"));
  try {
    const release = acquireLoginLock(temp);
    assert.throws(() => acquireLoginLock(temp), { code: "login_busy" });
    release();
    acquireLoginLock(temp)();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
