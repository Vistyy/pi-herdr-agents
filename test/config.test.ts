import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, resolveSettings } from "../src/config.js";

test("loads defaults and valid identities while disabling only invalid identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-config-"));
  await mkdir(join(root, "agents"));
  await writeFile(join(root, "config.json"), JSON.stringify({
    maxAgents: 10,
    defaults: { tools: ["read"], skills: ["./skills/review"] },
  }));
  await writeFile(join(root, "agents", "reviewer.md"), `---
name: reviewer
description: Reviews a bounded concern.
model: gpt-5.6-sol
tools: []
---
Review the assigned concern and report findings.
`);
  await writeFile(join(root, "agents", "broken.md"), "no frontmatter");

  const config = await loadConfig(root);
  assert.equal(config.maxAgents, 10);
  assert.deepEqual(config.defaults.tools, ["read"]);
  assert.deepEqual(config.defaults.skills, [join(root, "skills", "review")]);
  assert.deepEqual(config.identities.map((identity) => identity.name), ["reviewer"]);
  assert.match(config.warnings[0], /Disabled identity broken\.md/);

  const resolved = resolveSettings(config.identities[0], config.defaults, {
    provider: "openai-codex",
    model: "openai-codex/parent",
    thinking: "high",
  });
  assert.equal(resolved.model, "gpt-5.6-sol");
  assert.equal(resolved.thinking, "high");
  assert.deepEqual(resolved.tools, []);
  assert.deepEqual(resolved.skills, [join(root, "skills", "review")]);
});

test("invalid global defaults disable the complete configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-config-"));
  await writeFile(join(root, "config.json"), JSON.stringify({ defaults: { tools: "read" } }));
  await assert.rejects(loadConfig(root), /defaults\.tools must be an array/);
});

test('resource lists reject "all"', async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-config-"));
  await writeFile(join(root, "config.json"), JSON.stringify({ defaults: { tools: ["all"] } }));
  await assert.rejects(loadConfig(root), /must use explicit entries/);
});
