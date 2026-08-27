import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendBatchCompletion } from "../src/notifications.js";
import type { OwnedAgentCollection } from "../src/types.js";

function completedBatch(): OwnedAgentCollection {
  return {
    id: "batch-1",
    createdAt: 1,
    notified: true,
    members: [{
      name: "review",
      assignment: 1,
      result: {
        name: "review",
        identity: "general",
        keepOpen: false,
        status: "closed",
        cwd: "/repo",
        assignment: 1,
        completedAssignment: 1,
        lastTask: "Review it.",
        lastResult: "Review complete.",
        updatedAt: 2,
      },
    }],
  };
}

test("a settled batch steers one grouped completion report into the parent", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
  } as unknown as Pick<ExtensionAPI, "sendMessage">;
  const batch = completedBatch();

  sendBatchCompletion(pi, batch);

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { deliverAs: "steer", triggerTurn: true });
  assert.deepEqual(sent[0].message, {
    customType: "pi-herdr-owned-agents",
    content: "Owned agent batch batch-1 settled.\n\n## review\n\nReview complete.",
    display: false,
    details: { kind: "collection", collection: batch },
  });
});
