#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initialize, dataDirectory, importSession, readSession } from "./settings.js";
import { Fault, publicError } from "./errors.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const help = `webgpt-api ${VERSION} — ulfmaw

  node src/cli.js init                 Create private local settings
  node src/cli.js launch               Open the local one-click control panel
  node src/cli.js setup                First-run login and connection check
  node src/cli.js login                Refresh login in a separate browser window
  node src/cli.js connect codex        Install a managed Codex profile
  node src/cli.js shell                Open a terminal with API settings ready
  node src/cli.js run -- TOOL [ARGS]   Run any OpenAI-compatible CLI automatically
  node src/cli.js serve [--port N]     Start loopback API (default 17841)
  node src/cli.js key                  Show the LOCAL API key
  node src/cli.js session import FILE  Import session JSON from a local file
  node src/cli.js session import-ssh HOST PATH  Import privately over existing SSH
  node src/cli.js session status       Show declared expiry, never the credential
  node src/cli.js doctor [--live]      Check local setup / probe account models
  node src/cli.js --version

WEBGPT_HOME overrides the private data directory.
No tunnel, public listener, bundled browser, or paid-API fallback is installed.
Model discovery uses HTTP; generation starts the installed browser in background.
The dedicated browser exits after two idle seconds. First login is interactive.
`;

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdInit(directory) {
  const { keyPath } = initialize(directory);
  console.log(`Local settings ready. API key file: ${keyPath}`);
}

async function cmdLaunch(directory) {
  const { key } = initialize(directory);
  const { launch } = await import("./launcher.js");
  await launch(directory, key);
}

async function cmdLogin(directory) {
  initialize(directory);
  const { interactiveLogin } = await import("./login.js");
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once("SIGINT", cancel);
  try { await interactiveLogin(directory, { signal: abort.signal }); }
  finally { process.removeListener("SIGINT", cancel); }

  const [{ Credentials }, { ChatGptTransport }] = await Promise.all([
    import("./credentials.js"),
    import("./transports/chatgpt.js"),
  ]);
  const credentials = new Credentials(directory);
  const models = await new ChatGptTransport(() => credentials.get()).models();
  console.log(`直連模型清單驗證通過（${models.length} 個）。生成仍須另行測試。執行 npm start 啟動本機 API。`);
}

async function cmdSessionImportSsh(directory, args) {
  const [, host, path] = args;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(host) || !/^\/[A-Za-z0-9_./-]+$/.test(path)) {
    throw new Fault(400, "invalid_ssh_path", "Use an existing SSH host alias and an absolute remote path without shell characters.");
  }
  const { execFileSync } = await import("node:child_process");
  let value;
  try {
    const data = execFileSync("ssh", [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
      "-o", "StrictHostKeyChecking=yes", host, `cat -- ${path}`,
    ], {
      encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    value = JSON.parse(data);
  } catch {
    throw new Fault(503, "ssh_import_failed", "Could not read session over trusted SSH. Remote output is not logged.");
  }
  importSession(value, directory);
  console.log("Session imported privately over SSH. Remote file was not modified.");
}

async function cmdSessionImport(directory, args) {
  let value;
  try { value = JSON.parse(readFileSync(args[1], "utf8")); }
  catch { throw new Fault(400, "invalid_session_file", "Could not read session JSON. No file content was logged."); }
  importSession(value, directory);
  console.log("Session imported locally. Run doctor --live to verify access.");
}

async function cmdSessionStatus(directory) {
  const session = readSession(directory);
  const { sessionStatus } = await import("./session-status.js");
  console.log(JSON.stringify(sessionStatus(session), null, 2));
}

async function cmdConnectCodex() {
  const { installCodexProfile, CODEX_PROFILE } = await import("./integrations.js");
  const result = installCodexProfile({ nodePath: process.execPath });
  console.log(`${result.changed ? "Codex profile installed" : "Codex profile already ready"}: ${CODEX_PROFILE}`);
}

async function cmdShell() {
  const { openClientShell } = await import("./integrations.js");
  process.exitCode = await openClientShell();
}

async function cmdRun(args) {
  const clientArgs = args[0] === "--" ? args.slice(1) : args;
  const { runClient } = await import("./integrations.js");
  process.exitCode = await runClient(clientArgs);
}

async function cmdKey(directory) {
  console.log(initialize(directory).key);
}

async function cmdDoctor(directory, args) {
  const session = readSession(directory);
  const result = {
    node: process.versions.node,
    session_present: true,
    declared_expiry: session.deadline,
    models_verified: false,
    generation_verified: false,
  };
  if (args.length) {
    const { ChatGptTransport } = await import("./transports/chatgpt.js");
    const { Credentials } = await import("./credentials.js");
    const credentials = new Credentials(directory);
    const models = await new ChatGptTransport(() => credentials.get()).models();
    result.models_verified = true;
    result.model_count = models.length;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function cmdServe(directory, args) {
  let port = 17841;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1])) {
      throw new Fault(400, "invalid_arguments", "Use serve [--port N].");
    }
    port = Number(args[1]);
    if (port < 1 || port > 65535) throw new Fault(400, "invalid_port", "Port must be 1–65535.");
  }
  const { key } = initialize(directory);
  const { createRuntime } = await import("./runtime.js");
  const runtime = createRuntime(directory, key);
  try {
    const address = await runtime.app.listen(port);
    console.log(`webgpt-api by ulfmaw — ${address}/v1`);
    console.log("Local API ready. Background website worker starts on demand and closes after idle.");
  } catch (error) { await runtime.close(); throw error; }

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/** Commands that need network configuration before running. */
const NETWORK_COMMANDS = new Set(["launch", "serve", "doctor", "setup", "login"]);

async function main(args) {
  const command = args.shift() ?? "help";

  // --- No-data commands ---
  if (["help", "--help", "-h"].includes(command)) { console.log(help); return; }
  if (["--version", "-v"].includes(command)) { console.log(VERSION); return; }

  const directory = dataDirectory();

  // --- Network setup for commands that need it ---
  if (NETWORK_COMMANDS.has(command)) {
    const { configureNetwork } = await import("./network.js");
    configureNetwork();
  }

  // --- Command dispatch ---
  if (command === "launch" && !args.length) return cmdLaunch(directory);
  if (["setup", "login"].includes(command) && !args.length) return cmdLogin(directory);
  if (command === "init" && !args.length) return cmdInit(directory);
  if (command === "key" && !args.length) return cmdKey(directory);
  if (command === "shell" && !args.length) return cmdShell();
  if (command === "run") return cmdRun(args);
  if (command === "connect" && args.length === 1 && args[0] === "codex") return cmdConnectCodex();
  if (command === "serve") return cmdServe(directory, args);
  if (command === "doctor" && (!args.length || args.join(" ") === "--live")) return cmdDoctor(directory, args);

  // --- Session subcommands ---
  if (command === "session") {
    if (args[0] === "import-ssh" && args.length === 3) return cmdSessionImportSsh(directory, args);
    if (args[0] === "import" && args.length === 2) return cmdSessionImport(directory, args);
    if (args.join(" ") === "status") return cmdSessionStatus(directory);
  }

  throw new Fault(400, "invalid_arguments", "Unknown command or extra arguments. Run --help.");
}

main(process.argv.slice(2)).catch(error => {
  if (error instanceof Fault) {
    const safe = publicError(error);
    console.error(`webgpt-api: ${safe.code}: ${safe.message}`);
  } else {
    console.error("webgpt-api fatal error:", error);
  }
  process.exitCode = 1;
});
