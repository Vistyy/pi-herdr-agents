import assert from "node:assert/strict";
import test from "node:test";
import { DeferredNotifications } from "../src/notifications.js";

test("a completion during an active parent turn can be claimed before delivery", () => {
  const delivered: string[] = [];
  const notifications = new DeferredNotifications<string>(() => false, (value) => delivered.push(value));

  notifications.complete("review:1", "result");
  notifications.claim("review:1");
  notifications.flush();

  assert.deepEqual(delivered, []);
});

test("an unclaimed deferred completion is delivered when the parent settles", () => {
  const delivered: string[] = [];
  const notifications = new DeferredNotifications<string>(() => false, (value) => delivered.push(value));

  notifications.complete("review:1", "result");
  notifications.flush();
  notifications.flush();

  assert.deepEqual(delivered, ["result"]);
});

test("an idle-parent completion is delivered immediately", () => {
  const delivered: string[] = [];
  const notifications = new DeferredNotifications<string>(() => true, (value) => delivered.push(value));

  notifications.complete("review:1", "result");

  assert.deepEqual(delivered, ["result"]);
});
