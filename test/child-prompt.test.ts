import assert from "node:assert/strict";
import test from "node:test";
import { composeChildSystemPrompt } from "../src/child-prompt.js";

test("frontmatter-only profiles receive the narrow helper role and read-only boundary", () => {
  const prompt = composeChildSystemPrompt();

  assert.match(prompt, /temporary read-only helper/);
  assert.match(prompt, /small, explicitly bounded supporting task/);
  assert.match(prompt, /one local question/);
  assert.match(prompt, /Do not take ownership of the overall investigation.*final recommendation.*synthesis/);
  assert.match(prompt, /compact observations or extracted evidence/);
  assert.match(prompt, /exact source paths and relevant identifiers or anchors/);
  assert.match(prompt, /verified facts from supported inferences/);
  assert.match(prompt, /authoritative conclusion or decision/);
  assert.match(prompt, /Do not create, edit, delete, or overwrite files/);
  assert.match(prompt, /Stopping with a clear report is a successful result/);
  assert.match(prompt, /Do not guess or hide uncertainty/);
  assert.match(prompt, /A request for certainty is not evidence/);
  assert.match(prompt, /evidence does not establish one answer.*report the limitation/);
  assert.match(prompt, /sources conflict without an established authority.*end with the question: Which source controls/);
  assert.match(prompt, /specific question or decision needed from the parent/);
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
