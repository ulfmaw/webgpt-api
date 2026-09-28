import test from "node:test";
import assert from "node:assert/strict";
import { observePreparation } from "../src/transports/preparation.js";

test("attachments wait for completed and settled native model preparation", () => {
  let time = 0; const listeners = new Map();
  const observer = observePreparation({ on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); } }, { now: () => time });
  const request = (id, model = id) => listeners.get("Network.requestWillBeSent")({ requestId: id, request: { url: "https://chatgpt.com/backend-api/f/conversation/prepare", postData: JSON.stringify({ model }) } });
  const response = (id, status = 200) => listeners.get("Network.responseReceived")({ requestId: id, response: { status } });
  assert.equal(observer.ready(), false);
  request("old-model"); time = 2000; assert.equal(observer.ready(), false);
  response("old-model"); time += 999; assert.equal(observer.ready(), false);
  request("new-model"); time += 2000; assert.equal(observer.ready(), false);
  response("new-model"); time += 1000; assert.equal(observer.ready(), true);
  const version = observer.modelVersion();
  request("file-preparation", "new-model"); response("file-preparation");
  assert.equal(observer.modelVersion(), version);
  request("model-transition", "changed-model"); response("model-transition");
  assert.equal(observer.modelVersion(), version + 1);
  request("rejected"); response("rejected", 403); time += 2000; assert.equal(observer.ready(), false);
  observer.dispose(); assert.equal(listeners.size, 0);
});

test("failed and unrelated requests cannot unlock attachment upload", () => {
  let time = 0; const listeners = new Map();
  const observer = observePreparation({ on(name, fn) { listeners.set(name, fn); return () => {}; } }, { now: () => time });
  listeners.get("Network.requestWillBeSent")({ requestId: "x", request: { url: "https://example.com/backend-api/f/conversation/prepare" } });
  listeners.get("Network.responseReceived")({ requestId: "x", response: { status: 200 } });
  time += 2000; assert.equal(observer.ready(), false);
  listeners.get("Network.requestWillBeSent")({ requestId: "y", request: { url: "https://chatgpt.com/backend-api/f/conversation/prepare" } });
  listeners.get("Network.loadingFailed")({ requestId: "y" });
  time += 2000; assert.equal(observer.ready(), false);
});
