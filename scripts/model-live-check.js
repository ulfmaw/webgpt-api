// Explicit, sequential real-account audit. Each catalog entry gets one short
// generation; it never changes the saved selection or stores conversation text.
import assert from "node:assert/strict";
import { initialize } from "../src/settings.js";
import { controlToken } from "../src/launcher.js";
const headers = { authorization: `Bearer ${controlToken(initialize().key)}`, "content-type": "application/json" };
const base = "http://127.0.0.1:17841/v1/control/";
const call = async (action, body) => {
  const response = await fetch(base + action, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(100_000) });
  return { ok: response.ok, value: await response.json() };
};
try {
  const initial = await call("status"); assert.ok(initial.ok);
  assert.equal(initial.value.busy, false);
  const refreshed = await call("refresh", {}); assert.ok(refreshed.ok);
  const results = [];
  for (const option of refreshed.value.options) {
    const { ok, value } = await call("probe", { key: option.key });
    const result = { key: option.key, model: option.id, passed: ok, ...(ok ? { actual_model: value.actual_model, requested_model: value.requested_model, status: value.options.find(o => o.key === option.key)?.status } : { code: value.error?.code ?? "unknown_error", ...(value.error?.actual_model ? { actual_model: value.error.actual_model } : {}) }) };
    if (ok && !option.nativeAuto) {
      if (value.requested_model !== undefined) assert.equal(value.requested_model, option.id);
      assert.equal(value.actual_model, option.id);
    }
    results.push(result); console.log(JSON.stringify({ test: "live_catalog_model", ...result }));
  }
  const final = await call("status"); assert.ok(final.ok);
  assert.equal(final.value.selected.id, initial.value.selected.id);
  for (const result of results) assert.equal(final.value.options.find(o => o.key === result.key)?.status, result.passed ? result.status : "failed");
  const selectedPassed = results.find(r => r.key === initial.value.selected.key)?.passed === true;
  console.log(JSON.stringify({ test: "live_model_audit", completed: true, selected_passed: selectedPassed, tested: results.length, passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, selection_unchanged: true }));
  if (!selectedPassed || results.some(r => !r.passed)) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ test: "live_model_audit", completed: false, code: error.code ?? error.name }));
  process.exitCode = 1;
}
