import test from "node:test";
import assert from "node:assert/strict";
import { proxyEnvironment } from "../src/network.js";

test("proxy setup preserves explicit proxies and bypasses loopback in both casings", () => {
  const original = { https_proxy: "http://explicit.test:8080", no_proxy: "internal.test", NO_PROXY: "other.test" };
  const result = proxyEnvironment(original, "system.test:8081");
  assert.equal(result.https_proxy, original.https_proxy);
  assert.equal(result.HTTPS_PROXY, undefined);
  assert.equal(result.no_proxy, result.NO_PROXY);
  for (const host of ["internal.test", "other.test", "127.0.0.1", "localhost", "::1"]) assert.ok(result.NO_PROXY.split(",").includes(host));
  assert.equal(original.no_proxy, "internal.test");
});

test("system proxy accepts valid ports and rejects invalid addresses or PAC", () => {
  assert.equal(proxyEnvironment({}, "proxy.test:80").HTTPS_PROXY, "http://proxy.test/");
  assert.equal(proxyEnvironment({}, "http=one.test:8080;https=two.test:8081").HTTPS_PROXY, "http://two.test:8081/");
  assert.equal(proxyEnvironment({}, "[::1]:8080").HTTPS_PROXY, "http://[::1]:8080/");
  for (const setting of ["proxy.test:0", "proxy.test:99999", "https://example.test/proxy.pac", "", "bad address:80"]) assert.equal(proxyEnvironment({}, setting).HTTPS_PROXY, undefined);
});
