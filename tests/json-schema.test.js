import test from "node:test";
import assert from "node:assert/strict";
import { checkSchema, matchesSchema } from "../src/json-schema.js";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

test("Ajv validates formats and patterns without mutating arguments", () => {
  const schema = { type: "object", properties: { email: { type: "string", format: "email" }, code: { type: "string", pattern: "^[A-Z]{3}$" }, n: { type: "integer", default: 3 } }, required: ["email", "code"], additionalProperties: false };
  const value = { email: "test@example.com", code: "ABC" };
  checkSchema(schema); assert.equal(matchesSchema(value, schema), true);
  assert.deepEqual(value, { email: "test@example.com", code: "ABC" });
  for (const bad of [{ ...value, email: "invalid" }, { ...value, code: "abc" }, { ...value, n: "3" }, { ...value, extra: 1 }]) assert.equal(matchesSchema(bad, schema), false);
});
test("Ajv supports conditionals, contains and dependentRequired", () => {
  const schema = { type: "object", properties: { kind: { type: "string" }, values: { type: "array", contains: { const: 7 }, minContains: 1 } }, dependentRequired: { kind: ["values"] }, if: { required: ["kind"], properties: { kind: { const: "special" } } }, then: { properties: { values: { maxItems: 1 } } } };
  checkSchema(schema);
  assert.equal(matchesSchema({ kind: "special", values: [7] }, schema), true);
  for (const bad of [{ kind: "normal" }, { values: [1, 2] }, { kind: "special", values: [7, 2] }]) assert.equal(matchesSchema(bad, schema), false);
});
test("draft-07 tuple schemas and default 2020 prefixItems remain distinct", () => {
  const older = { $schema: "http://json-schema.org/draft-07/schema#", type: "array", items: [{ type: "string" }], additionalItems: false };
  const newer = { type: "array", prefixItems: [{ type: "string" }], items: false };
  for (const s of [older, newer]) { checkSchema(s); assert.equal(matchesSchema(["x"], s), true); assert.equal(matchesSchema(["x", 2], s), false); }
});
test("recursive local schema references work and unresolved refs fail early", () => {
  const schema = { type: "object", properties: { child: { $ref: "#" } }, additionalProperties: false };
  checkSchema(schema); assert.equal(matchesSchema({ child: {} }, schema), true);
  assert.equal(matchesSchema({ child: { extra: 1 } }, schema), false);
  assert.throws(() => checkSchema({ $ref: "#/$defs/missing" }), { code: "invalid_tool_schema" });
});
test("untrusted schemas cannot fetch external refs or run asynchronous validation", () => {
  for (const s of [{ $ref: "https://example.test/x" }, { properties: { x: { $ref: "file:///private" } } }]) assert.throws(() => checkSchema(s), { code: "unsupported_schema_ref" });
  for (const s of [{ $async: true }, { format: "made-up-format" }, { pattern: "[" }, { $schema: "https://example.test/schema" }]) assert.throws(() => checkSchema(s), { code: "invalid_tool_schema" });
});
test("schema-like property names and literal data are not interpreted as schemas", () => {
  const schema = { type: "object", properties: { $ref: { type: "string" }, $async: { type: "boolean" } }, const: { $ref: "https://example.test", $async: true } };
  checkSchema(schema); assert.equal(matchesSchema({ $ref: "https://example.test", $async: true }, schema), true);
});
test("schema IDs cannot leak definitions between requests", () => {
  const first = { $id: "urn:webgpt:test", const: 1 }, second = { $id: "urn:webgpt:test", const: 2 };
  checkSchema(first); checkSchema(second);
  assert.equal(matchesSchema(1, first), true); assert.equal(matchesSchema(2, second), true);
  assert.equal(matchesSchema(1, second), false);
});
test("bundled validator works from an isolated folder without npm packages", () => {
  const root = resolve(import.meta.dirname, ".."); const temp = mkdtempSync(join(tmpdir(), "webgpt-bundle-test-"));
  try {
    mkdirSync(join(temp, "src")); mkdirSync(join(temp, "vendor"));
    for (const p of ["package.json", "src/json-schema.js", "src/errors.js", "vendor/schema-validator.js"]) copyFileSync(join(root, p), join(temp, p));
    const url = pathToFileURL(join(temp, "src", "json-schema.js")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { matchesSchema } from ${JSON.stringify(url)}; if (!matchesSchema("a@b.com", {type:"string",format:"email"})) process.exit(1);`], { cwd: temp, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
