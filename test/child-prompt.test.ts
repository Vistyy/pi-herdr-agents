import assert from "node:assert/strict";
import test from "node:test";
import { composeChildSystemPrompt } from "../src/child-prompt.js";

test("omits an appended prompt when no instructions are configured", () => {
  assert.equal(composeChildSystemPrompt(), undefined);
});

test("appends shared instructions before identity instructions", () => {
  const prompt = composeChildSystemPrompt({
    globalInstructions: "Follow the shared operating rules.",
    identityInstructions: "Run bounded experiments.",
  });

  assert.equal(prompt, "Follow the shared operating rules.\n\nRun bounded experiments.\n");
});

test("supports shared or identity instructions independently", () => {
  assert.equal(
    composeChildSystemPrompt({ globalInstructions: "Shared only." }),
    "Shared only.\n",
  );
  assert.equal(
    composeChildSystemPrompt({ identityInstructions: "Identity only." }),
    "Identity only.\n",
  );
});
