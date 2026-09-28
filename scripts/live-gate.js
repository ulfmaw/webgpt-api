// Sequential real-account acceptance gate. Child scripts emit only sanitized
// results; no request bodies, credentials, or raw logs are saved.
import { spawn } from "node:child_process";
import { join } from "node:path";

const checks = [
  "live-control-check.js",
  "media-live-check.js",
  "pdf-live-check.js",
  "sdk-live-check.js",
  "reliability-live-check.js",
  "abort-check.js",
];
if (process.argv.includes("--list")) { console.log(JSON.stringify({ checks })); process.exit(0); }
for (const script of checks) {
  console.log(JSON.stringify({ live_gate: "start", script }));
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, script)], { stdio: "inherit", windowsHide: true, env: process.env });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).catch(error => ({ code: null, signal: error.code ?? error.name }));
  if (status.code !== 0) {
    console.error(JSON.stringify({ live_gate: "failed", script, exit_code: status.code, signal: status.signal ?? null }));
    process.exit(1);
  }
  console.log(JSON.stringify({ live_gate: "passed", script }));
}
console.log(JSON.stringify({ live_gate: "passed", checks: checks.length }));
