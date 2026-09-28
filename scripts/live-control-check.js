// Live control-page check against the current signed-in runtime. Prints only
// status, counts and model labels; no cookies, key, or page text is persisted.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { findBrowser } from "../src/login.js";
let browser;
try {
  browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on("pageerror", () => errors.push("pageerror"));
  await page.goto("http://127.0.0.1:17841/v1", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#models option").length >= 1, null, { timeout: 20_000 });
  const initial = await page.locator("#selected").textContent();
  assert.ok(initial?.trim());
  if (process.argv.includes("--login")) {
    await page.locator("#login").click();
    await page.waitForFunction(() => document.querySelector("#notice")?.textContent.includes("登入更新完成"), null, { timeout: 180_000 });
    assert.match(await page.locator("#detail").textContent(), /最近一次成功測試回報模型/);
  }
  await page.locator("#refresh").click();
  await page.waitForFunction(() => document.querySelector("#notice")?.textContent.includes("清單已刷新"), null, { timeout: 30_000 });
  const optionCount = await page.locator("#models option").count();
  assert.ok(optionCount >= 2);
  await page.locator("#check").click();
  await page.waitForFunction(() => document.querySelector("#notice")?.textContent.includes("目前模型測試完成"), null, { timeout: 120_000 });
  assert.match(await page.locator("#detail").textContent(), /最近一次成功測試回報模型/);
  await page.locator("#refresh").click();
  await page.waitForFunction(() => document.querySelector("#notice")?.textContent.includes("清單已刷新"));
  assert.match(await page.locator("#detail").textContent(), /最近一次成功測試回報模型/);
  assert.equal(await page.locator("#selected").textContent(), initial);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ test: "live_control_page_existing_account", passed: true, selected: initial, option_count: optionCount, generation_check: true, login_refresh: process.argv.includes("--login") }));
} catch (error) {
  console.error(JSON.stringify({ test: "live_control_page_existing_account", passed: false, code: error.code ?? error.name }));
  process.exitCode = 1;
} finally { await browser?.close(); }
