import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_PROFILE, clientEnvironment, codexProfileText, installCodexProfile, codexProfilePath } from "../src/integrations.js";

test("managed Codex profile uses command auth and local Responses provider", () => {
  const text = codexProfileText({ nodePath: "C:\\runtime\\node.exe", projectRoot: "C:\\webgpt-api" });
  assert.match(text, /model_provider = "webgpt_local"/);
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:17841\/v1"/);
  assert.match(text, /\[model_providers\.webgpt_local\.auth\]/);
  assert.match(text, /command = "C:\\\\runtime\\\\node\.exe"/);
  assert.match(text, /args = \["C:\\\\webgpt-api\\\\src\\\\cli\.js", "key"\]/);
  assert.doesNotMatch(text, /env_key|requires_openai_auth/);
});

test("Codex profile installation is idempotent and respects CODEX_HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "webgpt-codex-home-"));
  try {
    const env = { CODEX_HOME: home };
    const first = installCodexProfile({ env, nodePath: "node.exe", projectRoot: "C:\\webgpt-api" });
    const second = installCodexProfile({ env, nodePath: "node.exe", projectRoot: "C:\\webgpt-api" });
    assert.equal(first.profile, CODEX_PROFILE);
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(readFileSync(codexProfilePath(env), "utf8"), codexProfileText({ nodePath: "node.exe", projectRoot: "C:\\webgpt-api" }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("client environment is scoped and includes common OpenAI variable names", () => {
  const env = clientEnvironment("local-test-key", { PATH: "test" });
  assert.equal(env.PATH, "test");
  assert.equal(env.OPENAI_BASE_URL, "http://127.0.0.1:17841/v1");
  assert.equal(env.OPENAI_API_KEY, "local-test-key");
  assert.equal(env.OPENAI_MODEL, "auto");
});
