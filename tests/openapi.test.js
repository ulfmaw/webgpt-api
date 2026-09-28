import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "../vendor/schema-validator.js";
const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));

test("published attachment contract accepts supported forms and rejects incompatible inputs", () => {
  const validate = new Ajv2020({ strict: false }).compile({ components: spec.components, $ref: "#/components/schemas/ResponseRequest" });
  const file = { filename: "test.txt", file_data: "data:text/plain;base64,dGVzdA==" };
  const image = "data:image/png;base64,dGVzdA=="; // Schema checks encoding shape, not image decoding.
  for (const part of [{ type: "input_file", ...file }, { type: "file", file }, { type: "input_image", image_url: image }, { type: "image_url", image_url: { url: image, detail: "auto" } }]) {
    assert.equal(validate({ input: [{ role: "user", content: [part] }] }), true, JSON.stringify(validate.errors));
    assert.equal(validate({ input: [{ role: "assistant", content: [part] }] }), false);
  }
  for (const part of [{ type: "input_image", image_url: file.file_data }, { type: "input_image", image_url: image, detail: "high" }, { type: "input_file", filename: "x.txt", file_data: "https://example.test/x" }]) {
    assert.equal(validate({ input: [{ role: "user", content: [part] }] }), false);
  }
  assert.ok(spec.paths["/v1/responses/{id}"].get);
  assert.ok(spec.paths["/v1/responses/{id}"].delete);
});
