// Exercise current source on an ephemeral listener; never stop another server.
import { spawn } from "node:child_process";
import { createRuntime } from "../src/runtime.js";
import { initialize, dataDirectory } from "../src/settings.js";
const directory = dataDirectory();
const { key } = initialize(directory);
const runtime = createRuntime(directory, key);
try {
  const address = await runtime.app.listen(0);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await new Promise(resolve => {
      const child = spawn("codex", ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check",
        "--sandbox", "read-only", "--json", "-c", 'model="auto"', "-c", 'model_provider="local_smoke"',
        "-c", `model_providers.local_smoke={name="webgpt",base_url="${address}/v1",env_key="WEBGPT_SMOKE_KEY",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
        "-c", "features.apps=false", "-c", "features.remote_plugin=false", "-c", 'web_search="disabled"',
        "Reply only WEBGPT-SMOKE-OK. Do not use tools."], {
        windowsHide: true, env: { ...process.env, WEBGPT_SMOKE_KEY: key }, stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "", passed = false;
      const timer = setTimeout(() => child.kill(), 120000);
      let diagnostic = "";
      child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
      child.stdout.on("data", chunk => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/); buffer = lines.pop();
        for (const line of lines) {
          try { const e = JSON.parse(line); if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text.trim() === "WEBGPT-SMOKE-OK") passed = true;
            if (e.type === "turn.failed" || e.type === "error") console.log(JSON.stringify(e).replaceAll(key, "[redacted]").slice(0, 1500));
          } catch {}
        }
      });
      child.on("error", () => { clearTimeout(timer); resolve({ passed: false, started: false }); });
      child.on("close", code => { clearTimeout(timer); resolve({ passed: code === 0 && passed, exit_code: code, ...(code ? { diagnostic: diagnostic.replaceAll(key, "[redacted]").slice(-1500) } : {}) }); });
    });
    console.log(JSON.stringify({ attempt, ...result }));
    if (!result.passed) { process.exitCode = 1; break; }
    await runtime.transport.close();
  }
} finally { await runtime.close(); }
