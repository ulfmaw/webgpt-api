import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { unzipSync } from "fflate";
const root = resolve(import.meta.dirname, ".."); const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const temp = mkdtempSync(join(tmpdir(), "webgpt-release-check-")); let child;
try {
  const files = unzipSync(readFileSync(join(root, "dist", `webgpt-api-${version}.zip`)));
  for (const [name, bytes] of Object.entries(files)) {
    const target = resolve(temp, name);
    if (!target.startsWith(temp + sep)) throw Error("Unsafe archive path");
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  }
  const folder = join(temp, "webgpt-api"), privateDirectory = join(temp, "private");
  const env = { ...process.env, WEBGPT_HOME: privateDirectory, WEBGPT_ACCESS_TOKEN: "" };
  assert.equal(existsSync(join(folder, "node_modules")), false);
  assert.equal(existsSync(join(folder, "session.json")), false);
  for (const command of ["--help", "--version", "init"]) {
    const result = spawnSync(process.execPath, ["src/cli.js", command], { cwd: folder, env, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, `Release command failed: ${command}`);
  }
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  child = spawn(process.execPath, ["src/cli.js", "serve", "--port", String(port)], { cwd: folder, env, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  let health;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { health = await (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).json(); break; } catch { await delay(100); }
  }
  assert.equal(health?.service, "webgpt-api");
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 401);
  const key = readFileSync(join(privateDirectory, "api.key"), "utf8").trim();
  const reply = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ input: "test", store: false }) });
  assert.equal(reply.status, 503); assert.equal((await reply.json()).error.code, "session_required");
  console.log(JSON.stringify({ test: "clean_release_without_npm_or_credentials", passed: true, files: Object.keys(files).length }));
} finally {
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
  // Only the unique extraction directory created above is removed.
  rmSync(temp, { recursive: true, force: true });
}
