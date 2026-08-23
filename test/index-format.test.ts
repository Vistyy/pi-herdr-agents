import assert from "node:assert/strict";
import test from "node:test";
import { formatList } from "../src/index.js";
import type { OwnedAgentRecord } from "../src/types.js";

function record(overrides: Partial<OwnedAgentRecord> = {}): OwnedAgentRecord {
  return {
    name: "review",
    identity: "default",
    keepOpen: false,
    status: "working",
    cwd: "/repo",
    assignment: 1,
    lastTask: "Inspect the relevant source.",
    updatedAt: 1,
    ...overrides,
  };
}

test("formatList distinguishes a settled assignment from its closed tab", () => {
  const output = formatList([record({
    status: "closed",
    completedAssignment: 1,
    lastResult: "Inspection complete.",
    sessionFile: "/sessions/review.jsonl",
  })]);

  assert.equal(
    output,
    "review: settled, tab closed, report retained, identity default, assignment 1, session resumable",
  );
});

test("formatList preserves an active assignment status", () => {
  assert.equal(formatList([record()]), "review: working, identity default, assignment 1");
});
