import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "../src/index.js";
import type { AgentManager } from "../src/manager.js";
import { formatBatchCompletion } from "../src/notifications.js";
import type { ExtensionConfig, OwnedAgentCollection, OwnedAgentRecord } from "../src/types.js";

type RegisteredTool = {
  name: string;
  description?: string;
  promptGuidelines?: unknown;
  execute: (...args: unknown[]) => Promise<Record<string, unknown>>;
};

function record(overrides: Partial<OwnedAgentRecord> = {}): OwnedAgentRecord {
  return {
    name: "analysis",
    identity: "analysis",
    keepOpen: false,
    status: "closed",
    cwd: "/repo",
    assignment: 1,
    completedAssignment: 1,
    lastTask: "Inspect the relevant source.",
    lastResult: "Inspection complete.",
    updatedAt: 1,
    ...overrides,
  };
}

function collection(result = record()): OwnedAgentCollection {
  return {
    id: "batch-1",
    members: [{ name: result.name, assignment: result.assignment, result }],
    createdAt: 1,
    notified: false,
  };
}

function registeredTools(manager: AgentManager): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool(tool: unknown) {
      tools.push(tool as RegisteredTool);
    },
  } as unknown as ExtensionAPI;
  const config: ExtensionConfig = {
    maxAgents: 1,
    defaults: {},
    identities: [{
      name: "analysis",
      description: "Use for read-only analysis with additional reasoning effort.",
      sourcePath: "/config/agents/analysis.md",
    }],
    warnings: [],
  };

  registerTools(pi, config, () => manager);
  return tools;
}

function tool(tools: RegisteredTool[], name: string): RegisteredTool {
  const found = tools.find((candidate) => candidate.name === name);
  assert.ok(found);
  return found;
}

test("agent tools expose mechanisms without embedding orchestration policy", () => {
  const tools = registeredTools({} as AgentManager);
  const start = tool(tools, "start_agents");
  const send = tool(tools, "send_agents");

  assert.equal("promptGuidelines" in start, false);
  assert.equal("promptGuidelines" in send, false);
  const descriptions = `${String(start.description)}\n${String(send.description)}`;
  assert.doesNotMatch(descriptions, /bounded evidence|parent retains|parent owns|recommendation|verdict|synthesis/i);
});

test("start and send results do not terminate the parent turn", async () => {
  let current = record({ status: "working", completedAssignment: 0 });
  const manager = {
    start: async () => current,
    send: async () => {
      if (current.status !== "working") {
        current = record({ assignment: current.assignment + 1, status: "working", completedAssignment: current.assignment });
      }
      return current;
    },
    getRecords: () => [current],
    batch: (records: OwnedAgentRecord[]) => collection(records[0]),
  } as unknown as AgentManager;
  const tools = registeredTools(manager);
  const signal = new AbortController().signal;

  const started = await tool(tools, "start_agents").execute(
    "start-call",
    { agents: [{ name: "analysis", identity: "analysis", task: "Inspect the relevant source." }] },
    signal,
    undefined,
    { cwd: "/repo" },
  );
  const guided = await tool(tools, "send_agents").execute(
    "send-call",
    { agents: [{ name: "analysis", message: "Check one more detail." }] },
    signal,
  );

  current = record();
  const reassigned = await tool(tools, "send_agents").execute(
    "reassign-call",
    { agents: [{ name: "analysis", message: "Inspect the follow-up." }] },
    signal,
  );

  assert.equal("terminate" in started, false);
  assert.equal("terminate" in guided, false);
  assert.equal("terminate" in reassigned, false);
});

test("a grouped completion report contains lifecycle state without workflow instructions", () => {
  const grouped = formatBatchCompletion(collection(record()));

  assert.equal(grouped, "Owned agent batch batch-1 settled.\n\n## analysis\n\nInspection complete.");
  assert.doesNotMatch(grouped, /integrate|synthesize|continue|delegate|parent/i);
});
