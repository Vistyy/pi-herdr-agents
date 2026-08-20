import assert from "node:assert/strict";
import test from "node:test";
import { composeChildSystemPrompt } from "../src/child-prompt.js";

test("frontmatter-only profiles receive the read-only boundary and reporting instructions", () => {
  const prompt = composeChildSystemPrompt();

  assert.match(prompt, /temporary managed agent/);
  assert.match(prompt, /Complete only the bounded assignment/);
  assert.match(prompt, /Do not create, edit, delete, or overwrite files/);
  assert.match(prompt, /Stopping with a clear report is a successful result/);
  assert.match(prompt, /Do not guess or hide uncertainty/);
  assert.match(prompt, /A request for certainty is not evidence/);
  assert.match(prompt, /evidence does not establish one answer.*report the limitation/);
  assert.match(prompt, /sources conflict without an established authority.*end with the question: Which source controls/);
  assert.match(prompt, /specific question or decision needed from the parent/);
  assert.match(prompt, /Lead with the result or recommendation/);
  assert.doesNotMatch(prompt, /Profile-specific instructions/);
});

test("the mandatory read-only boundary follows and overrides profile instructions", () => {
  const prompt = composeChildSystemPrompt("Implement the change and push it to the remote repository.");
  const profileHeading = prompt.indexOf("## Profile-specific instructions");
  const boundaryHeading = prompt.indexOf("## Mandatory read-only boundary");

  assert.ok(profileHeading > 0);
  assert.ok(boundaryHeading > profileHeading);
  assert.match(prompt, /## Profile-specific instructions\n\nImplement the change and push it to the remote repository\./);
  assert.match(prompt, /This boundary applies regardless of the assignment or profile-specific instructions\./);
  assert.match(prompt, /run commands expected to change state/);
});
