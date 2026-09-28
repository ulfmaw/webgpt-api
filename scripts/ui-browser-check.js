// Browser integration test against synthetic state. No real account or clipboard.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findBrowser } from "../src/login.js";
import { ModelSelection, modelOptions } from "../src/model-selection.js";
import { Engine } from "../src/engine.js";
import { ConversationStore } from "../src/state.js";
import { createLocalServer } from "../src/http.js";
import { Fault } from "../src/errors.js";

const temp = mkdtempSync(join(tmpdir(), "webgpt-ui-test-"));
const store = new ConversationStore(":memory:"); let browser, app;
const key = "synthetic-ui-test-key-00000000000000000";
const actions = []; let stopped = false, phase = "ready";
try {
  const engine = new Engine({ models: async () => [{ id: "candidate" }], async *generate(request) {
    if (request.model === "unavailable") throw new Fault(409, "model_substituted", "The website returned a different model.", { requested_model: request.model, actual_model: "gpt-5-mini", reason: "unsupported_account_sharing" });
    yield { text: "OK", model: request.model === "routed" ? "different-model" : request.model === "auto" ? "website-selected" : request.model,
      ...(request.model === "routed" ? { requested_model: "routed" } : {}) };
  } }, store);
  const selection = new ModelSelection(temp, engine, async () => modelOptions({ models: [{ slug: "candidate", title: "Test Candidate", group: "Chat version", preset: "High", thinking_effort: "extended" }, { slug: "unavailable", title: "Unavailable Test" }, { slug: "routed", title: "Native Routed Test" }] }));
  engine.selection = selection; await selection.refresh();
  app = createLocalServer({ engine, selection, key, control: { state: () => ({ phase }), start: action => {
    actions.push(action); phase = action === "login" ? "login" : "checking";
    selection.invalidate();
    setTimeout(() => { selection.markVerified(selection.current.id); phase = "ready"; }, 300);
    return true;
  }, stop: () => { stopped = true; } } });
  const url = await app.listen(0);
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1100 } });
  const page = await context.newPage(); const errors = [];
  page.on("pageerror", () => errors.push("pageerror"));
  await page.addInitScript(() => { window.copied = []; Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => window.copied.push(text) } }); });
  await page.goto(url + "/v1");
  await page.waitForFunction(() => document.getElementById("models").options.length === 4);
  assert.equal(await page.locator("#models").inputValue(), "auto");
  assert.match(await page.locator("#selected").textContent(), /Auto/);
  assert.equal(await page.locator('#models optgroup').getAttribute('label'),'Chat version');
  assert.match(await page.locator('#models optgroup option').textContent(),/High/);
  await page.locator("#models").selectOption("routed"); await page.locator("#select").click();
  await page.waitForFunction(() => document.getElementById("notice").textContent.includes("model_substituted"));
  assert.equal(selection.snapshot().id,"auto");
  assert.match(await page.locator('option[value="routed"]').textContent(), /最近測試失敗/);
  await page.locator("#models").selectOption("candidate"); await page.locator("#select").click();
  await page.waitForFunction(() => document.getElementById("notice").textContent.includes("已保存"));
  assert.equal(selection.snapshot().id, "candidate");
  await page.locator("#models").selectOption("unavailable"); await page.locator("#select").click();
  await page.waitForFunction(() => document.getElementById("notice").textContent.includes("model_substituted") && document.getElementById("notice").textContent.includes("帳號共用"));
  assert.equal(selection.snapshot().id, "candidate");
  await page.locator("#refresh").click(); await page.waitForFunction(() => document.getElementById("notice").textContent.includes("清單已刷新"));
  assert.match(await page.locator("#detail").textContent(), /最近一次成功測試回報模型：candidate/);
  assert.match(await page.locator('option[value="unavailable"]').textContent(), /最近測試失敗/);
  await page.locator("#copy-url").click(); await page.waitForFunction(() => window.copied.length === 1);
  await page.locator("#copy-key").click(); await page.waitForFunction(() => window.copied.length === 2);
  assert.deepEqual(await page.evaluate(() => window.copied), [url + "/v1", key]);
  assert.equal((await page.locator("body").innerText()).includes(key), false);
  await page.locator("#check").click(); await page.waitForFunction(() => document.getElementById("notice").textContent.includes("目前模型測試完成"));
  await page.locator("#login").click(); await page.waitForFunction(() => document.getElementById("notice").textContent.includes("登入更新完成"));
  assert.deepEqual(actions, ["check", "login"]);
  const output = resolve(import.meta.dirname, "../.tmp/ui-check"); mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  await page.locator("#stop").click(); await page.waitForFunction(() => [...document.querySelectorAll("button")].every(b => b.disabled));
  assert.equal(stopped, true); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ test: "isolated_browser_control_panel", passed: true, checks: ["load", "selection_success", "selection_failure_preserves_previous", "refresh", "copy_handlers", "login_check_handlers", "responsive_layout", "stop", "no_js_errors"] }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await browser?.close(); await app?.close(); store.close(); rmSync(temp, { recursive: true, force: true }); }
