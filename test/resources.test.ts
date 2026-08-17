import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverInheritedResources, resolveRuntimeSettings } from "../src/resources.js";
import type { AgentIdentity } from "../src/types.js";

function identity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    name: "reviewer",
    description: "Reviews a bounded concern.",
    sourcePath: "/config/agents/reviewer.md",
    ...overrides,
  };
}

const inherited = {
  extensions: [
    { value: "/extensions/alpha/index.ts", aliases: ["alpha", "/extensions/alpha/index.ts"] },
    { value: "/extensions/beta.ts", aliases: ["beta.ts", "/extensions/beta.ts"] },
  ],
  skills: [
    { value: "/skills/review/SKILL.md", aliases: ["review", "/skills/review/SKILL.md"] },
    { value: "/skills/herdr/SKILL.md", aliases: ["herdr", "/skills/herdr/SKILL.md"] },
    { value: "/skills/session-routing/SKILL.md", aliases: ["session-routing", "/skills/session-routing/SKILL.md"] },
  ],
};

test("resource selectors apply defaults before identity filters", () => {
  const resolved = resolveRuntimeSettings({
    identity: identity({
      tools: ["read", "+edit"],
      extensions: ["alpha"],
      skills: ["+session-routing"],
    }),
    defaults: {
      tools: ["!edit"],
      extensions: ["!beta*"],
      skills: ["!session-*"],
    },
    parent: { provider: "parent-provider", model: "parent-model", thinking: "high" },
    inherited,
    activeTools: ["read", "edit", "start_agent"],
  });

  assert.equal(resolved.provider, "parent-provider");
  assert.equal(resolved.model, "parent-model");
  assert.equal(resolved.thinking, "high");
  assert.deepEqual(resolved.tools, ["read", "edit"]);
  assert.deepEqual(resolved.extensions, ["/extensions/alpha/index.ts"]);
  assert.deepEqual(resolved.skills, ["/skills/review/SKILL.md"]);
});

test("an empty resource list selects no inherited resources", () => {
  const resolved = resolveRuntimeSettings({
    identity: identity({ tools: [], extensions: [], skills: [] }),
    defaults: {},
    parent: {},
    inherited,
    activeTools: ["read", "bash"],
  });

  assert.deepEqual(resolved.tools, []);
  assert.deepEqual(resolved.extensions, []);
  assert.deepEqual(resolved.skills, []);
});

test("delegation tools and skills are unavailable even when force-included", () => {
  const resolved = resolveRuntimeSettings({
    identity: identity({
      tools: ["+start_agent", "+collect_agents", "+read"],
      skills: ["+herdr", "+session-routing", "+review"],
    }),
    defaults: { tools: [], skills: [] },
    parent: {},
    inherited,
    activeTools: ["read", "start_agent", "send_agent", "collect_agents", "close_agent"],
  });

  assert.deepEqual(resolved.tools, ["read"]);
  assert.deepEqual(resolved.skills, ["/skills/review/SKILL.md"]);
});

test("Pi discovery supplies inherited resources and removes the delegation extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-resources-"));
  const agentDir = join(root, "agent");
  const extensionRoot = join(agentDir, "extensions");
  const packageRoot = join(extensionRoot, "pi-herdr-agents");
  const keepSkillRoot = join(agentDir, "skills", "keep");
  const herdrSkillRoot = join(agentDir, "skills", "herdr");
  const projectExtensionRoot = join(root, ".pi", "extensions");
  const projectSkillRoot = join(root, ".pi", "skills", "project");
  await Promise.all([
    mkdir(packageRoot, { recursive: true }),
    mkdir(keepSkillRoot, { recursive: true }),
    mkdir(herdrSkillRoot, { recursive: true }),
    mkdir(projectExtensionRoot, { recursive: true }),
    mkdir(projectSkillRoot, { recursive: true }),
  ]);
  await writeFile(join(extensionRoot, "keep.ts"), "export default function () {}\n");
  await writeFile(join(packageRoot, "index.ts"), "export default function () {}\n");
  await writeFile(join(keepSkillRoot, "SKILL.md"), "---\nname: keep\ndescription: Keeps useful context.\n---\n\nUse this skill.\n");
  await writeFile(join(herdrSkillRoot, "SKILL.md"), "---\nname: herdr\ndescription: Controls Herdr.\n---\n\nUse Herdr.\n");
  await writeFile(join(projectExtensionRoot, "project.ts"), "export default function () {}\n");
  await writeFile(join(projectSkillRoot, "SKILL.md"), "---\nname: project\ndescription: Uses project guidance.\n---\n\nUse project guidance.\n");

  const discovered = await discoverInheritedResources({
    cwd: root,
    agentDir,
    projectTrusted: false,
    packageRoot,
  });

  assert.equal(discovered.extensions.some((resource) => resource.value === join(extensionRoot, "keep.ts")), true);
  assert.equal(discovered.extensions.some((resource) => resource.value.startsWith(packageRoot)), false);
  assert.equal(discovered.skills.some((resource) => resource.aliases.includes("keep")), true);
  assert.equal(discovered.skills.some((resource) => resource.aliases.includes("herdr")), true);
  assert.equal(discovered.extensions.some((resource) => resource.value === join(projectExtensionRoot, "project.ts")), false);
  assert.equal(discovered.skills.some((resource) => resource.aliases.includes("project")), false);

  const trusted = await discoverInheritedResources({
    cwd: root,
    agentDir,
    projectTrusted: true,
    packageRoot,
  });
  assert.equal(trusted.extensions.some((resource) => resource.value === join(projectExtensionRoot, "project.ts")), true);
  assert.equal(trusted.skills.some((resource) => resource.aliases.includes("project")), true);
});
