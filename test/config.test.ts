import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

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
  assert.equal(config.identities[0].instructions, "Review the assigned concern and report findings.");
  assert.deepEqual(config.identities[0].tools, []);
  assert.match(config.warnings[0], /Disabled identity broken\.md/);
});

test("accepts a frontmatter-only identity with required descriptive metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-config-"));
  await mkdir(join(root, "agents"));
  await writeFile(join(root, "agents", "fast.md"), `---
name: fast
description: Handles small tasks with limited reasoning.
thinking: low
skills:
  - "!session-routing"
  - "-./skills/local"
---
`);

  const config = await loadConfig(root);
  assert.deepEqual(config.warnings, []);
  assert.equal(config.identities[0].instructions, undefined);
  assert.deepEqual(config.identities[0].skills, ["!session-routing", `-${join(root, "agents", "skills", "local")}`]);
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
