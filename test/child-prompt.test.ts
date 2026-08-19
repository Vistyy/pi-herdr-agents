import assert from "node:assert/strict";
import test from "node:test";
import { composeChildSystemPrompt } from "../src/child-prompt.js";

test("frontmatter-only profiles receive shared safety and reporting instructions", () => {
  const prompt = composeChildSystemPrompt();

  assert.match(prompt, /working directory shared with the parent and sibling agents/);
  assert.match(prompt, /derive and verify the exact target and its ownership/);
  assert.match(prompt, /Lead with the result or recommendation/);
  assert.match(prompt, /Include evidence, changed files, verification, uncertainty, or required action/);
  assert.doesNotMatch(prompt, /Profile-specific instructions/);
});

test("profile instructions follow the common child prompt", () => {
  const prompt = composeChildSystemPrompt("Review the assigned concern.");
  const profileHeading = prompt.indexOf("## Profile-specific instructions");

  assert.ok(profileHeading > 0);
  assert.ok(prompt.indexOf("Lead with the result or recommendation") < profileHeading);
  assert.match(prompt, /## Profile-specific instructions\n\nReview the assigned concern\./);
});
