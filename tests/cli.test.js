import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "src", "cli.js");

test("help/version do not initialize private data; invalid arguments fail", () => {
  const temp = mkdtempSync(join(tmpdir(), "webgpt-cli-test-"));
  const home = join(temp, "private");
  const env = { ...process.env, WEBGPT_HOME: home, WEBGPT_ACCESS_TOKEN: "" };
  try {
    for (const argument of ["--help", "--version"]) {
      const result = spawnSync(process.execPath, [cli, argument], { env, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0);
      assert.ok(result.stdout.length > 0);
      assert.equal(existsSync(home), false);
    }
    assert.equal(spawnSync(process.execPath, [cli, "serve", "--host", "0.0.0.0"], { env }).status, 1);
    assert.equal(existsSync(home), false);
    assert.equal(spawnSync(process.execPath, [cli, "init"], { env }).status, 0);
    assert.equal(existsSync(join(home, "api.key")), true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("published API document parses and specifies only loopback", () => {
  const document = JSON.parse(readFileSync(join(root, "openapi.json"), "utf8"));
  assert.equal(document.info.contact.name, "ulfmaw");
  assert.equal(document.servers[0].url, "http://127.0.0.1:17841");
  assert.ok(document.paths["/v1/responses"]);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.author, "ulfmaw");
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["ajv", "ajv-formats", "eventsource-parser"]);
  assert.ok(existsSync(join(root, "vendor", "schema-validator.js")));
  assert.ok(readFileSync(join(root, "vendor", "THIRD_PARTY_NOTICES.txt"), "utf8").includes("ajv@"));
});

test("double-click entry starts management UI and verifies portable runtime integrity", () => {
  const script = readFileSync(join(root, "scripts", "start.ps1"), "utf8");
  assert.ok(script.includes("src/cli.js launch"));
  assert.ok(!/src\/cli\.js\s+(setup|login)\b/.test(script));
  assert.ok(script.includes("Get-FileHash"));
  assert.ok(script.includes("https://nodejs.org/dist/v24.14.0/"));
  assert.ok(script.indexOf("Runtime download checksum mismatch") < script.indexOf("Move-Item"));
  const wrapper = readFileSync(join(root, "webgpt.cmd"), "utf8");
  assert.match(wrapper, /scripts\\run-client\.ps1/);
  assert.ok(readFileSync(join(root, "scripts", "run-client.ps1"), "utf8").includes("@args"));
});

test("portable bootstrap refuses an altered cached executable without replacing it", { skip: process.platform !== "win32" }, () => {
  const temp = mkdtempSync(join(tmpdir(), "webgpt-runtime-test-"));
  const arch = process.env.PROCESSOR_ARCHITECTURE === "ARM64" || process.env.PROCESSOR_ARCHITEW6432 === "ARM64" ? "arm64" : "x64";
  const runtime = join(temp, "webgpt-api", "runtime", `node-v24.14.0-${arch}`);
  mkdirSync(runtime, { recursive: true });
  const executable = join(runtime, "node.exe");
  writeFileSync(executable, "not-an-executable");
  try {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts", "start.ps1"), "-PortableRuntime", "-CheckRuntime"], {
      env: { ...process.env, LOCALAPPDATA: temp }, encoding: "utf8", windowsHide: true, timeout: 15_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch/);
    assert.equal(readFileSync(executable, "utf8"), "not-an-executable");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
