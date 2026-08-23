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
import { DeferredNotifications } from "./notifications.js";
import { discoverInheritedResources, resolveRuntimeSettings } from "./resources.js";
import {
  OWNED_AGENT_ENTRY,
  type ExtensionConfig,
  type OwnedAgentCollection,
  type OwnedAgentRecord,
  type OwnedAgentSnapshot,
} from "./types.js";

type ParentNotification =
  | { kind: "agent"; record: OwnedAgentRecord }
  | { kind: "collection"; collection: OwnedAgentCollection };

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
  let notifications: DeferredNotifications<ParentNotification> | undefined;
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
    notifications = new DeferredNotifications<ParentNotification>(
      () => ctx.isIdle(),
      (notification) => {
        pi.sendMessage(
          {
            customType: OWNED_AGENT_ENTRY,
            content: notification.kind === "agent"
              ? formatNotification(notification.record)
              : formatCollectionNotification(notification.collection),
            display: false,
            details: notification,
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
    );
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
        notify(record) {
          notifications?.complete(notificationKey(record), { kind: "agent", record });
        },
        notifyCollection(collection) {
          notifications?.complete(`collection:${collection.id}`, { kind: "collection", collection });
        },
        claimNotification(record) {
          notifications?.claim(notificationKey(record));
        },
        releaseNotification(record) {
          notifications?.complete(notificationKey(record), { kind: "agent", record });
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

  pi.on("agent_settled", () => notifications?.flush());

  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") notifications?.flush();
    notifications?.clear();
    notifications = undefined;
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

function registerTools(pi: ExtensionAPI, config: ExtensionConfig, getManager: () => AgentManager): void {
  const identityNames = config.identities.map((identity) => identity.name);
  const identityCatalog = config.identities.map((identity) => `${identity.name}: ${identity.description}`).join("\n");

  pi.registerTool({
    name: "start_agents",
    label: "Start Agents",
    description: `Start a fixed batch of one or more temporary read-only Pi helpers in new tabs in the current Herdr workspace. Each helper performs one bounded evidence operation for the parent. The parent, not the helpers, owns and performs the user's work. Returns after each helper either accepts its assignment or fails to start. The parent receives one completion notification after the whole batch settles. Available identities:\n${identityCatalog}`,
    promptSnippet: "Offload bounded context-heavy evidence operations to temporary Pi helpers",
    promptGuidelines: [
      "Before calling start_agents, frame the user's outcome and identify one separable evidence operation whose file reading, searching, or raw output would otherwise consume substantial parent context. Do not delegate when a handful of short files or one targeted command can provide compact evidence, or when the parent needs the raw evidence to reason correctly.",
      "Treat start_agents like calling a helper method, not transferring work. Ask for a local evidence result. Never ask a helper to produce the user's plan, design, implementation, recommendation, review verdict, final verification, or answer, and never partition the whole user task among helpers.",
      "Select the least intensive configured identity whose catalog description matches the evidence operation. Identity complexity changes evidence-processing effort, not ownership or allowable scope.",
      "Give each helper one requested evidence result with relevant anchors, constraints, and a stopping condition when useful. Ask it to identify inspected sources, direct observations, supported inferences, and material unknowns.",
      "Keep outcome framing, work decomposition, consequential interpretation, cross-cutting decisions, plan and design, synthesis, implementation, final verification, and user communication in the parent session. The parent must do this work rather than merely route, summarize, or approve helper output.",
      "Call start_agents as the only tool call in its assistant turn. Do not combine dispatch with read, bash, web, or other evidence-gathering calls. After dispatch, stop the parent run and wait for the completion follow-up.",
      "Do not inspect or duplicate a dispatched evidence operation while it is active or after its report arrives. Treat the report's cited observations as the evidence returned by the helper call. If required evidence is missing or unclear, send one context-local follow-up to that helper instead of reconstructing its search in the parent.",
      "Do not poll or resend because a normal temporary helper tab closed.",
    ],
    parameters: Type.Object({
      agents: Type.Array(Type.Object({
        name: Type.String({ description: "Unique evidence-operation name matching [a-z][a-z0-9_-]{0,28}" }),
        identity: Type.String({ description: `Required helper identity selected by evidence-operation complexity. Available when this session started: ${identityNames.join(", ")}` }),
        task: Type.String({ description: "One bounded read-only evidence operation and its requested local result. It may inspect connected sources and reason locally, but it must not produce the parent plan, design, implementation, recommendation, verdict, final verification, or answer." }),
        keep_open: Type.Optional(Type.Boolean({ description: "Keep the agent tab open after completion. Default: false." })),
      }), { minItems: 1, description: "Fixed batch of independent evidence operations, not a partition of the user's task." }),
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
      return batchToolResult(`Started ${batch.id}: ${names}. End this parent run now. Do not inspect or duplicate the dispatched evidence operations. One completion follow-up will resume the parent after the whole batch settles.`, records, batch);
    },
  });

  pi.registerTool({
    name: "send_agents",
    label: "Send Agents",
    description: "Send messages to owned helpers. Guide an active evidence operation, or give a settled helper one new bounded read-only evidence operation that benefits from its existing source context. Do not mix active guidance and new assignments in one call.",
    promptSnippet: "Guide an active evidence operation or reuse its source-local context",
    promptGuidelines: [
      "Use send_agents only when an owned helper's existing source context materially benefits guidance within its active evidence operation or one new source-local evidence operation.",
      "Do not use send_agents to expand a helper into the user's task or ask for a plan, design, implementation, recommendation, verdict, final verification, or answer.",
      "Call send_agents as the only tool call in its assistant turn. After sending guidance or a new evidence operation, stop the parent run and wait for settlement.",
      "Do not inspect or duplicate the helper's evidence operation during or after the assignment. Evaluate the report, and use a context-local follow-up when required evidence is missing or unclear.",
    ],
    parameters: Type.Object({
      agents: Type.Array(Type.Object({
        name: Type.String({ description: "Owned agent task name" }),
        message: Type.String({ description: "Guidance within the active evidence operation, or one new bounded source-local evidence operation for a settled helper. It must not transfer parent-owned work." }),
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
        return terminatingToolResult(text, returned);
      }

      const batch = manager.batch(newAssignments);
      const names = batch.members.map((member) => member.name).join(", ");
      return batchToolResult(`Started ${batch.id}: ${names}. End this parent run now. Do not inspect or duplicate the dispatched evidence operations. One completion follow-up will resume the parent after the whole batch settles.`, newAssignments, batch);
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List the assignment and tab lifecycle state of agents owned by the current parent Pi session, including settled agents whose tabs closed and sessions remain resumable. Completion reports arrive through batch notifications.",
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

function terminatingToolResult(text: string, records: OwnedAgentRecord[]) {
  return { ...toolResult(text, records), terminate: true };
}

function batchToolResult(text: string, records: OwnedAgentRecord[], batch: OwnedAgentCollection) {
  return { content: [{ type: "text" as const, text }], details: { records, batch }, terminate: true };
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

function formatResults(records: OwnedAgentRecord[]): string {
  if (records.length === 0) return "No agent results.";
  return records.map((record) => {
    const status = record.status === "idle" || record.status === "closed" ? "" : ` (${record.status})`;
    return `## ${record.name}${status}\n\n${record.lastResult ?? record.lastError ?? "(no result)"}`;
  }).join("\n\n");
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

function notificationKey(record: OwnedAgentRecord): string {
  return `${record.name}:${record.assignment}`;
}

function formatNotification(record: OwnedAgentRecord): string {
  const status = record.status === "idle" || record.status === "closed" ? "" : ` (${record.status})`;
  return `Owned helper ${record.name} settled${status}. Use this report as evidence while doing the parent-owned work. Do not reconstruct the helper's source inspection in the parent; send a context-local follow-up if required evidence is missing or unclear.\n\n${record.lastResult ?? record.lastError ?? "(no result)"}`;
}

function formatCollectionNotification(collection: OwnedAgentCollection): string {
  const records = collection.members.flatMap((member) => member.result ? [member.result] : []);
  const text = `Owned helper batch ${collection.id} settled. Use these reports as evidence while doing the parent-owned work. Do not reconstruct their source inspection in the parent; send a context-local follow-up if required evidence is missing or unclear.\n\n${formatResults(records)}`;
  const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return truncated.truncated
    ? `${truncated.content}\n\n[Batch output truncated. Full individual results remain in the child Pi session files.]`
    : truncated.content;
}
