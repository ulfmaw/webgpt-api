#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initialize, dataDirectory, importSession, readSession } from "./settings.js";
import { Fault, publicError } from "./errors.js";

const help = `webgpt-api 0.1.0 — ulfmaw

  node src/cli.js init                 Create private local settings
  node src/cli.js launch               Open the local one-click control panel
  node src/cli.js setup                First-run login and connection check
  node src/cli.js login                Refresh login in a separate browser window
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

async function main(args) {
  const command = args.shift() ?? "help";
  if (["help", "--help", "-h"].includes(command)) { console.log(help); return; }
  if (["--version", "-v"].includes(command)) { console.log("0.1.0"); return; }
  const directory = dataDirectory();
  if (["launch", "serve", "doctor", "setup", "login"].includes(command)) {
    const { configureNetwork } = await import("./network.js"); configureNetwork();
  }
  if (command === "launch" && !args.length) {
    const { key } = initialize(directory);
    const { launch } = await import("./launcher.js");
    await launch(directory, key);
    return;
  }
  if (["setup", "login"].includes(command) && !args.length) {
    initialize(directory);
    const { interactiveLogin } = await import("./login.js");
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once("SIGINT", cancel);
    try { await interactiveLogin(directory, { signal: abort.signal }); }
    finally { process.removeListener("SIGINT", cancel); }
    const [{ Credentials }, { ChatGptTransport }] = await Promise.all([import("./credentials.js"), import("./transports/chatgpt.js")]);
    const credentials = new Credentials(directory);
    const models = await new ChatGptTransport(() => credentials.get()).models();
    console.log(`直連模型清單驗證通過（${models.length} 個）。生成仍須另行測試。執行 npm start 啟動本機 API。`);
    return;
  }
  if (command === "session" && args[0] === "import-ssh" && args.length === 3) {
    const [, host, path] = args;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(host) || !/^\/[A-Za-z0-9_./-]+$/.test(path)) {
      throw new Fault(400, "invalid_ssh_path", "Use an existing SSH host alias and an absolute remote path without shell characters.");
    }
    const { execFileSync } = await import("node:child_process");
    let value;
    try {
      const data = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", host, `cat -- ${path}`], {
        encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      value = JSON.parse(data);
    } catch { throw new Fault(503, "ssh_import_failed", "Could not read session over trusted SSH. Remote output is not logged."); }
    importSession(value, directory);
    console.log("Session imported privately over SSH. Remote file was not modified.");
    return;
  }
  if (command === "session" && args[0] === "import" && args.length === 2) {
    let value;
    try { value = JSON.parse(readFileSync(args[1], "utf8")); }
    catch { throw new Fault(400, "invalid_session_file", "Could not read session JSON. No file content was logged."); }
    importSession(value, directory);
    console.log("Session imported locally. Run doctor --live to verify access.");
    return;
  }
  if (command === "session" && args.join(" ") === "status") {
    const session = readSession(directory);
    const { sessionStatus } = await import("./session-status.js");
    console.log(JSON.stringify(sessionStatus(session), null, 2));
    return;
  }
  if (command === "init" && !args.length) {
    const { keyPath } = initialize(directory);
    console.log(`Local settings ready. API key file: ${keyPath}`);
    return;
  }
  if (command === "key" && !args.length) { console.log(initialize(directory).key); return; }
  if (command === "doctor" && (!args.length || args.join(" ") === "--live")) {
    const session = readSession(directory);
    const result = { node: process.versions.node, session_present: true, declared_expiry: session.deadline, models_verified: false, generation_verified: false };
    if (args.length) {
      const { ChatGptTransport } = await import("./transports/chatgpt.js");
      const { Credentials } = await import("./credentials.js");
      const credentials = new Credentials(directory);
      const models = await new ChatGptTransport(() => credentials.get()).models();
      result.models_verified = true;
      result.model_count = models.length;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "serve") {
    let port = 17841;
    if (args.length) {
      if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1])) throw new Fault(400, "invalid_arguments", "Use serve [--port N].");
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
    return;
  }
  throw new Fault(400, "invalid_arguments", "Unknown command or extra arguments. Run --help.");
}

main(process.argv.slice(2)).catch(error => {
  const safe = publicError(error);
  console.error(`webgpt-api: ${safe.code}: ${safe.message}`);
  process.exitCode = 1;
});
