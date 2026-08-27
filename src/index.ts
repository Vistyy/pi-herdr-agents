import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfigDirectory, loadConfig } from "./config.js";
import { OwnedAgentViewController } from "./agent-view.js";
import { HerdrClient } from "./herdr.js";
import { AgentManager } from "./manager.js";
import { sendBatchCompletion } from "./notifications.js";
import { discoverInheritedResources, resolveRuntimeSettings } from "./resources.js";
import {
  OWNED_AGENT_ENTRY,
  type ExtensionConfig,
  type OwnedAgentCollection,
  type OwnedAgentRecord,
  type OwnedAgentSnapshot,
} from "./types.js";

export default async function piHerdrAgents(pi: ExtensionAPI): Promise<void> {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify("pi-herdr-agents is inactive because Pi is not running inside Herdr.", "warning");
    });
    return;
  }

  const configDir = getConfigDirectory();
  let config: ExtensionConfig;
  try {
    config = await loadConfig(configDir);
  } catch (error) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify((error as Error).message, "error");
    });
    return;
  }

  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const agentDir = dirname(configDir);

  let manager: AgentManager | undefined;
  let acceptsCompletions = false;
  pi.on("session_start", async (_event, ctx) => {
    for (const warning of config.warnings) ctx.ui.notify(warning, "warning");
    const view = OwnedAgentViewController.fromEnvironment();
    try {
      await view.install();
    } catch (error) {
      ctx.ui.notify(`Could not install the pi-herdr-agents sidebar filter: ${(error as Error).message}`, "warning");
    }
    if (config.identities.length === 0) return;

    const parentSessionId = ctx.sessionManager.getSessionId();
    const parentToken = createHash("sha256").update(parentSessionId).digest("hex").slice(0, 8);
    const herdr = new HerdrClient((command, args, options) => pi.exec(command, args, options));
    const inheritedResources = new Map<string, ReturnType<typeof discoverInheritedResources>>();
    acceptsCompletions = true;
    manager = new AgentManager(
      herdr,
      config,
      process.env.HERDR_WORKSPACE_ID!,
      join(configDir, "sessions", parentSessionId),
      parentToken,
      {
        provider: ctx.model?.provider,
        model: ctx.model?.id ?? "",
        thinking: ctx.thinkingLevel ?? "off",
      },
      {
        persist(records, collections) {
          const snapshot: OwnedAgentSnapshot = { version: 2, parentSessionId, records, collections };
          pi.appendEntry(OWNED_AGENT_ENTRY, snapshot);
          updateAgentWidget(ctx, records);
        },
        notifyCollection(collection) {
          if (acceptsCompletions) sendBatchCompletion(pi, collection);
        },
        reloadConfig: () => loadConfig(configDir),
        warn(message) {
          ctx.ui.notify(message, "warning");
        },
        async resolveRuntime(identity, cwd, defaults) {
          let inherited = inheritedResources.get(cwd);
          if (!inherited) {
            inherited = discoverInheritedResources({
              cwd,
              agentDir,
              projectTrusted: ctx.isProjectTrusted(),
              packageRoot,
            });
            inheritedResources.set(cwd, inherited);
          }
          return resolveRuntimeSettings({
            identity,
            defaults,
            parent: {
              provider: ctx.model?.provider,
              model: ctx.model?.id ?? "",
              thinking: ctx.thinkingLevel ?? "off",
            },
            inherited: await inherited,
            activeTools: pi.getActiveTools(),
          });
        },
      },
    );
    const snapshot = readSnapshot(ctx, parentSessionId);
    await manager.restore(snapshot.records, snapshot.collections);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    acceptsCompletions = false;
    if (manager) {
      if (event.reason === "reload") manager.suspend();
      else await manager.shutdown();
      manager = undefined;
    }
    if (ctx.mode === "tui") ctx.ui.setWidget("pi-herdr-agents", undefined);
  });

  if (config.identities.length === 0) return;
  registerTools(pi, config, () => {
    if (!manager) throw new Error("Owned agents are unavailable before the parent session starts.");
    return manager;
  });
}

export function registerTools(pi: ExtensionAPI, config: ExtensionConfig, getManager: () => AgentManager): void {
  const identityNames = config.identities.map((identity) => identity.name);
  const identityCatalog = config.identities.map((identity) => `${identity.name}: ${identity.description}`).join("\n");

  pi.registerTool({
    name: "start_agents",
    label: "Start Agents",
    description: `Start a fixed batch of one or more owned Pi agents in new tabs in the current Herdr workspace. Returns after each agent either accepts its assignment or fails to start. One grouped completion report is steered into the parent after the whole batch settles. Available identities:\n${identityCatalog}`,
    promptSnippet: "Start owned Pi agents in Herdr tabs",
    parameters: Type.Object({
      agents: Type.Array(Type.Object({
        name: Type.String({ description: "Unique agent name matching [a-z][a-z0-9_-]{0,28}" }),
        identity: Type.String({ description: `Configured agent identity. Available when this session started: ${identityNames.join(", ")}` }),
        task: Type.String({ description: "Assignment sent to the agent as a user message" }),
        keep_open: Type.Optional(Type.Boolean({ description: "Keep the agent tab open after completion. Default: false." })),
      }), { minItems: 1, description: "Fixed batch of agent assignments." }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      assertUniqueNames(params.agents.map((agent) => agent.name));
      const manager = getManager();
      const outcomes = await Promise.allSettled(params.agents.map((agent) => manager.start({
        name: agent.name,
        identityName: agent.identity,
        task: agent.task,
        keepOpen: agent.keep_open ?? false,
        cwd: ctx.cwd,
      }, signal)));
      const records = outcomes.map((outcome, index) => outcome.status === "fulfilled"
        ? outcome.value
        : failedDispatchRecord(params.agents[index].name, params.agents[index].identity, params.agents[index].task, params.agents[index].keep_open ?? false, ctx.cwd, outcome.reason));
      const batch = manager.batch(records);
      const names = batch.members.map((member) => member.name).join(", ");
      return batchToolResult(`Started ${batch.id}: ${names}. One grouped completion report will arrive after the batch settles.`, records, batch);
    },
  });

  pi.registerTool({
    name: "send_agents",
    label: "Send Agents",
    description: "Send messages to owned agents. Messages guide active assignments or start new assignments for settled agents. Do not mix active guidance and new assignments in one call.",
    promptSnippet: "Send messages to owned agents",
    parameters: Type.Object({
      agents: Type.Array(Type.Object({
        name: Type.String({ description: "Owned agent name" }),
        message: Type.String({ description: "Message sent to the agent" }),
      }), { minItems: 1, description: "Fixed batch of messages." }),
    }),
    async execute(_id, params, signal) {
      assertUniqueNames(params.agents.map((agent) => agent.name));
      const manager = getManager();
      const before = new Map(manager.getRecords().map((record) => [record.name, record]));
      const missing = params.agents.find((agent) => !before.has(agent.name));
      if (missing) throw new Error(`Unknown owned agent: ${missing.name}`);
      const active = params.agents.map((agent) => before.get(agent.name)!.status === "working");
      if (active.some(Boolean) && active.some((value) => !value)) {
        throw new Error("Do not mix guidance for active assignments with new assignments for settled agents in one send_agents call.");
      }

      const outcomes = await Promise.allSettled(params.agents.map((agent) => manager.send(agent.name, agent.message, signal)));
      const returned = outcomes.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
      const newAssignments: OwnedAgentRecord[] = [];
      for (let index = 0; index < outcomes.length; index += 1) {
        const outcome = outcomes[index];
        const agent = params.agents[index];
        const previous = before.get(agent.name)!;
        const current = manager.getRecords().find((record) => record.name === agent.name);
        if (outcome.status === "fulfilled") {
          if (outcome.value.assignment > previous.assignment) newAssignments.push(outcome.value);
        } else if (current && current.assignment > previous.assignment) {
          newAssignments.push(current);
        } else if (!active[index]) {
          newAssignments.push(failedDispatchRecord(agent.name, previous.identity, agent.message, previous.keepOpen, previous.cwd, outcome.reason));
        }
      }

      if (newAssignments.length === 0) {
        const failures = outcomes.flatMap((outcome, index) => outcome.status === "rejected" ? [`${params.agents[index].name}: ${errorMessage(outcome.reason)}`] : []);
        const text = failures.length > 0
          ? `Guidance completed with errors.\n${failures.join("\n")}`
          : `Guided active assignments: ${returned.map((record) => record.name).join(", ")}.`;
        return toolResult(text, returned);
      }

      const batch = manager.batch(newAssignments);
      const names = batch.members.map((member) => member.name).join(", ");
      return batchToolResult(`Started ${batch.id}: ${names}. One grouped completion report will arrive after the batch settles.`, newAssignments, batch);
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List the assignment and tab lifecycle state of agents owned by the current parent Pi session, including settled agents whose tabs closed and sessions remain resumable.",
    promptSnippet: "List agents owned by this parent session",
    parameters: Type.Object({}),
    async execute() {
      const records = getManager().getRecords();
      return toolResult(formatList(records), records);
    },
  });

  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt Agent",
    description: "Send Pi's Escape interrupt key to one live owned agent without closing its tab or deleting its Pi session.",
    promptSnippet: "Interrupt one live owned agent",
    parameters: Type.Object({ name: Type.String({ description: "Owned agent task name" }) }),
    async execute(_id, params, signal) {
      const record = await getManager().interrupt(params.name, signal);
      return toolResult(`Interrupted ${record.name}.`, [record]);
    },
  });

  pi.registerTool({
    name: "close_agent",
    label: "Close Agent",
    description: "Close one owned agent's Herdr tab while preserving its Pi session for later resumption.",
    promptSnippet: "Close an owned agent tab and preserve its session",
    parameters: Type.Object({ name: Type.String({ description: "Owned agent task name" }) }),
    async execute(_id, params) {
      const record = await getManager().close(params.name);
      return toolResult(`Closed ${record.name}. Its Pi session remains resumable.`, [record]);
    },
  });
}

function readSnapshot(ctx: ExtensionContext, parentSessionId: string): { records: OwnedAgentRecord[]; collections: OwnedAgentCollection[] } {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== OWNED_AGENT_ENTRY) continue;
    const data = entry.data as Partial<OwnedAgentSnapshot> | undefined;
    if (data?.parentSessionId !== parentSessionId || !Array.isArray(data.records)) continue;
    if (data.version === 2 && Array.isArray(data.collections)) {
      return { records: data.records, collections: data.collections };
    }
    if (data.version === 1) return { records: data.records, collections: [] };
  }
  return { records: [], collections: [] };
}

function toolResult(text: string, records: OwnedAgentRecord[]) {
  const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  const content = truncated.truncated
    ? `${truncated.content}\n\n[Output truncated. Full individual results remain in the child Pi session files.]`
    : truncated.content;
  return { content: [{ type: "text" as const, text: content }], details: { records } };
}

function batchToolResult(text: string, records: OwnedAgentRecord[], batch: OwnedAgentCollection) {
  return { content: [{ type: "text" as const, text }], details: { records, batch } };
}

function assertUniqueNames(names: string[]): void {
  if (new Set(names).size !== names.length) throw new Error("Agent names must be unique within a batch.");
}

function failedDispatchRecord(
  name: string,
  identity: string,
  task: string,
  keepOpen: boolean,
  cwd: string,
  error: unknown,
): OwnedAgentRecord {
  const message = errorMessage(error);
  return {
    name,
    identity,
    keepOpen,
    status: "failed",
    cwd,
    assignment: 0,
    completedAssignment: 0,
    lastTask: task,
    lastResult: `Dispatch failed: ${message}`,
    lastError: message,
    updatedAt: Date.now(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatList(records: OwnedAgentRecord[]): string {
  if (records.length === 0) return "No agents are owned by this parent session.";
  return records.map((record) => {
    const settled = record.completedAssignment === record.assignment && (record.status === "idle" || record.status === "closed");
    const state = settled
      ? `settled, tab ${record.status === "closed" ? "closed" : "open"}, report retained`
      : record.status;
    const resumable = record.sessionFile ? ", session resumable" : "";
    return `${record.name}: ${state}, identity ${record.identity}, assignment ${record.assignment}${resumable}`;
  }).join("\n");
}

function updateAgentWidget(ctx: ExtensionContext, records: OwnedAgentRecord[]): void {
  if (ctx.mode !== "tui") return;
  const visible = records.filter((record) =>
    record.status === "starting" || record.status === "working" || record.status === "blocked",
  );
  if (visible.length === 0) {
    ctx.ui.setWidget("pi-herdr-agents", undefined);
    return;
  }
  const items = visible.map((record) => {
    const label = `${record.name}[${record.identity}]`;
    return record.status === "working" ? label : `${label} (${record.status})`;
  });
  ctx.ui.setWidget("pi-herdr-agents", () => ({
    render(width) {
      return wrapInline("Agents: ", items, width);
    },
    invalidate() {},
  }));
}

function wrapInline(prefix: string, items: string[], width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  let line = prefix;
  for (const item of items) {
    const separator = line === prefix ? "" : ", ";
    if (line.length > prefix.length && line.length + separator.length + item.length > width) {
      lines.push(line.slice(0, width));
      line = `${" ".repeat(prefix.length)}${item}`;
    } else {
      line += `${separator}${item}`;
    }
  }
  lines.push(line.slice(0, width));
  return lines;
}
