import assert from "node:assert/strict";
import test from "node:test";
import { composeChildSystemPrompt } from "../src/child-prompt.js";

test("frontmatter-only profiles receive only the read-only boundary", () => {
  const prompt = composeChildSystemPrompt();

  assert.match(prompt, /Inspect existing information without changing local or external state/);
  assert.match(prompt, /Do not create, edit, delete, or overwrite files/);
  assert.match(prompt, /If the task requires a state change, report that limitation and stop/);
  assert.doesNotMatch(prompt, /temporary|helper|parent|bounded|recommendation|synthesis|Profile-specific instructions/i);
});

test("the mandatory read-only boundary follows and overrides profile instructions", () => {
  const prompt = composeChildSystemPrompt("Implement the change and push it to the remote repository.");
  const profileHeading = prompt.indexOf("## Profile-specific instructions");
  const boundaryHeading = prompt.indexOf("## Mandatory read-only boundary");

  assert.equal(profileHeading, 0);
  assert.ok(boundaryHeading > profileHeading);
  assert.match(prompt, /## Profile-specific instructions\n\nImplement the change and push it to the remote repository\./);
  assert.match(prompt, /This boundary overrides conflicting instructions\./);
  assert.match(prompt, /run commands expected to change state/);
});
