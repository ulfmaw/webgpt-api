// Live Windows diagnostic: cancels only its own request and observes our profile.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { initialize, dataDirectory } from "../src/settings.js";

const directory = dataDirectory();
const { key } = initialize(directory);
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
function workers() {
  return Number(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:WEBGPT_TEST_PROFILE) }).Count"],
  { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024,
    env: { ...process.env, WEBGPT_TEST_PROFILE: join(directory, "browser-profile") } }));
}
async function idle() {
  for (let attempt = 0; attempt < 15; attempt++) {
    if (!workers() && !existsSync(join(directory, "login.lock"))) return;
    await delay(1000);
  }
  throw Error("Dedicated worker or profile lock remained after idle deadline");
}
try {
  assert.equal(process.platform, "win32");
  await idle();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1000);
  try {
    await assert.rejects(fetch("http://127.0.0.1:17841/v1/responses", {
      method: "POST", headers, signal: abort.signal,
      body: JSON.stringify({ model: "auto", input: "Reply only: CANCEL-TEST", store: false }),
    }), { name: "AbortError" });
  } finally { clearTimeout(timer); }
  await idle();
  console.log(JSON.stringify({ test: "cancel_cleanup", browser_processes: 0, profile_lock: false }));
  const response = await fetch("http://127.0.0.1:17841/v1/responses", {
    method: "POST", headers, signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({ model: "auto", input: "Reply only: RECOVERED", store: false }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, body.error?.code);
  assert.equal(body.status, "completed");
  assert.ok(body.output.some(item => item.content?.some(part => part.text?.includes("RECOVERED"))));
  await idle();
  console.log(JSON.stringify({ test: "recovery", model: body.model, browser_processes: 0 }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
