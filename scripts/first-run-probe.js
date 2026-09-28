// Probe used by the isolated first-run PowerShell wrapper. It reads only the
// local key through settings and prints a sanitized result, never the key or body.
import { initialize, dataDirectory } from "../src/settings.js";
const port = Number(process.argv[2] ?? "17842");
let stage = "request";
try {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error("invalid_probe_port");
  const directory = dataDirectory();
  const { key } = initialize(directory);
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", input: "Reply only CLEAN-FIRST-RUN-OK", store: false }),
    signal: AbortSignal.timeout(90_000),
  });
  stage = "parse";
  const body = await response.json();
  const text = (body.output ?? []).flatMap(item => item.content ?? []).filter(part => typeof part.text === "string").map(part => part.text).join("");
  if (response.status !== 200 || body.status !== "completed" || text.trim() !== "CLEAN-FIRST-RUN-OK") throw Error("first_run_generation_failed");
  console.log(JSON.stringify({ test: "isolated_first_run", passed: true, response_status: response.status, model: body.model }));
} catch (error) {
  console.error(JSON.stringify({ test: "isolated_first_run", passed: false, stage, code: error.code ?? error.name, status: error.status ?? null }));
  process.exitCode = 1;
}
