import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
}
for (const path of [...files(join(root, "src")), ...files(join(root, "tests")), ...files(join(root, "scripts"))].filter(p => p.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (result.status !== 0) { console.error(result.stderr); process.exit(1); }
}
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.author !== "ulfmaw") throw new Error("Unexpected product author.");
for (const name of Object.keys(manifest.dependencies ?? {})) {
  if (!["ajv", "ajv-formats", "eventsource-parser"].includes(name)) throw new Error(`Unreviewed dependency: ${name}`);
}
if (!readFileSync(join(root, "vendor", "THIRD_PARTY_NOTICES.txt"), "utf8").includes("ajv@")) throw new Error("Missing bundled dependency licenses.");
console.log("Syntax and dependency checks passed.");
