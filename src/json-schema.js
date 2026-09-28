import { Ajv, Ajv2020, addFormats } from "../vendor/schema-validator.js";
import { Fault } from "./errors.js";

// The library owns schema semantics. This wrapper only enforces gateway limits.
const validators = new WeakMap();
const options = { strictSchema: true, strictTypes: false, strictTuples: false,
  strictRequired: false, allowUnionTypes: true, allErrors: false, ownProperties: true,
  addUsedSchema: true, validateFormats: true, logger: false };
const draft7 = addFormats(new Ajv(options));
const draft2020 = addFormats(new Ajv2020(options));
const invalid = () => new Fault(400, "invalid_tool_schema", "Invalid or unsupported JSON Schema. Use draft-07 or draft-2020-12 with local references and supported formats.");

function inspect(schema, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 10000 || depth > 32) throw invalid();
  if (!schema || typeof schema !== "object") return;
  for (const [key, value] of Object.entries(schema)) {
    if (["$ref", "$dynamicRef", "$recursiveRef"].includes(key) &&
        (typeof value !== "string" || !value.startsWith("#"))) {
      throw new Fault(400, "unsupported_schema_ref", "Only local schema references are supported.");
    }
    if (key === "$async") throw invalid();
    if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) && value && typeof value === "object") {
      for (const child of Object.values(value)) inspect(child, depth + 1, budget);
    } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(value)) {
      for (const child of value) inspect(child, depth + 1, budget);
    } else if (["items", "additionalItems", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "contains", "not", "if", "then", "else", "propertyNames"].includes(key)) {
      if (Array.isArray(value)) { for (const child of value) inspect(child, depth + 1, budget); }
      else inspect(value, depth + 1, budget);
    } else if (key === "dependencies" && value && typeof value === "object") {
      for (const child of Object.values(value)) if (!Array.isArray(child)) inspect(child, depth + 1, budget);
    }
  }
}

function compile(schema) {
  if (typeof schema === "boolean") return () => schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw invalid();
  if (validators.has(schema)) return validators.get(schema);
  if (Buffer.byteLength(JSON.stringify(schema)) > 65536) throw invalid();
  inspect(schema);
  let ajv = draft2020;
  if (schema.$schema) {
    if (/^https?:\/\/json-schema.org\/draft-07\/schema#?$/.test(schema.$schema)) ajv = draft7;
    else if (!/^https?:\/\/json-schema.org\/draft\/2020-12\/schema#?$/.test(schema.$schema)) throw invalid();
  }
  let validate;
  try { validate = ajv.compile(schema); }
  catch { throw invalid(); }
  finally { ajv.removeSchema(schema); }
  validators.set(schema, validate);
  return validate;
}

export function checkSchema(schema) { compile(schema); }
export function matchesSchema(value, schema) {
  try { return compile(schema)(value) === true; }
  catch (error) { if (error instanceof Fault) throw error; return false; }
}
