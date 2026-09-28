import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) throw Error("Invalid release version");
// Explicit whitelist: never package a user's runtime, tests, caches or credentials.
const paths = ["README.md", "LICENSE", "openapi.json", "package.json", "start.cmd", "webgpt.cmd", "scripts/start.ps1", "scripts/run-client.ps1", "docs/architecture.md", "docs/client-compatibility.md", "docs/model-verification.md", "docs/release-readiness.md"];
function include(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const name = directory + "/" + entry.name;
    if (entry.isSymbolicLink()) throw Error(`Symlink not permitted in release: ${name}`);
    if (entry.isDirectory()) include(name); else paths.push(name);
  }
}
include("src"); include("vendor");
const entries = {}, manifest = [];
for (const name of paths.sort()) {
  if (!lstatSync(join(root, name)).isFile() || /(?:^|\/)(?:\.env|session\.json|api\.key|model-selection\.json)|\.(?:sqlite|db|log)(?:$|[-.])/i.test(name)) throw Error(`Private or unexpected release file: ${name}`);
  const bytes = readFileSync(join(root, name));
  if (/(?:sk-[a-zA-Z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(bytes.toString("utf8"))) throw Error(`Potential credential in ${name}`);
  entries[`webgpt-api/${name}`] = [bytes, { mtime: new Date("2020-01-01T00:00:00Z") }];
  manifest.push({ path: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
const output = join(root, "dist"); mkdirSync(output, { recursive: true });
const archive = zipSync(entries, { level: 9 }); const filename = `webgpt-api-${version}.zip`;
writeFileSync(join(output, filename), archive);
writeFileSync(join(output, filename + ".sha256"), `${createHash("sha256").update(archive).digest("hex")}  ${filename}\n`);
writeFileSync(join(output, "manifest.json"), JSON.stringify({ version, files: manifest }, null, 2) + "\n");
console.log(JSON.stringify({ artifact: filename, files: manifest.length, bytes: archive.length, includes_private_data: false }));
