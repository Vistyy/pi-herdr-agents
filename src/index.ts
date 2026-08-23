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
    description: `Start a fixed batch of one or more temporary read-only Pi helpers in new tabs in the current Herdr workspace. Each task asks one bounded factual evidence question about a specific component, operation, invariant, or source relationship. Partition a batch by behavior or claim, never by repository area such as implementation, tests, or documentation. A helper does not assess a whole branch, suite, documentation set, investigation, plan, or recommendation. Returns after each helper either accepts its assignment or fails to start. The parent receives one completion notification after the whole batch settles. Available identities:\n${identityCatalog}`,
    promptSnippet: "Delegate source-local questions to temporary Pi helpers",
    promptGuidelines: [
      "Use start_agents for a factual evidence question whose retrieval is independently answerable and source-heavy, specialized, parallelizable, or likely to crowd the parent context. Inspect small local evidence directly.",
      "A valid task asks one bounded question about how a specific component, operation, invariant, or source relationship behaves. Do not bundle unrelated concerns or ask a helper to assess, review, plan, recommend, or identify material gaps for the overall outcome.",
      "Partition a batch by behavior or claim, never into implementation, test, and documentation branches. A local question may inspect connected sources when they all answer that question.",
      "Use one batch for the non-overlapping local questions needed by the same reasoning step. Use duplicate scopes only for intentional corroboration.",
      "The parent owns implementation, final verification, consequential decisions, synthesis, recommendations, and the final response.",
      "Do not duplicate delegated work, inspect another evidence branch for the same outcome, or poll helper status. If the reports contribute to the current answer, plan, decision, or implementation, end the turn after dispatch. Continue only a separate user-requested outcome that cannot affect or be affected by the reports.",
      "After reports arrive, do not re-read delegated sources unless an exact conflict or synthesis question requires it.",
    ],
    parameters: Type.Object({
      agents: Type.Array(Type.Object({
        name: Type.String({ description: "Unique task name matching [a-z][a-z0-9_-]{0,28}" }),
        identity: Type.String({ description: `Configured agent identity. Available when this session started: ${identityNames.join(", ")}` }),
        task: Type.String({ description: "One bounded factual read-only evidence question about a named component, operation, invariant, or source relationship. Partition by behavior or claim, not by implementation, tests, or documentation. Request evidence, not assessment, planning, or recommendation for the overall outcome." }),
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
      return batchToolResult(`Started ${batch.id}: ${names}. If these reports contribute to the current outcome, end this turn now. Do not inspect another evidence branch for that outcome or poll status. Continue only a separate user-requested outcome that cannot affect or be affected by the reports.`, records, batch);
    },
  });

  pi.registerTool({
    name: "send_agents",
    label: "Send Agents",
    description: "Send messages to owned helpers. Guide an active helper within its current factual local question, or give a settled helper one new bounded factual local question. Partition work by behavior or claim, not by implementation, tests, or documentation. A message must not broaden into an assessment, review, gap analysis, plan, or recommendation. Do not mix active guidance and new assignments in one call.",
    promptSnippet: "Guide a local question or dispatch its next assignment",
    promptGuidelines: [
      "Reuse a helper when its existing source context materially helps answer the current factual local question or one new factual local question.",
      "Do not broaden a helper, bundle unrelated concerns, or request an assessment, plan, or recommendation for the overall outcome.",
      "Partition work by behavior or claim, never into implementation, test, and documentation branches. Use one batch for non-overlapping local questions needed by the same reasoning step.",
      "Do not duplicate delegated work, inspect another evidence branch for the same outcome, or poll helper status. If a new report contributes to the current answer, plan, decision, or implementation, end the turn after dispatch. Continue only a separate user-requested outcome that cannot affect or be affected by the report.",
      "The parent evaluates and connects reports, owns all consequential judgments, and does not re-read delegated sources without an exact conflict or synthesis need.",
    ],
    parameters: Type.Object({
      agents: Type.Array(Type.Object({
        name: Type.String({ description: "Owned agent task name" }),
        message: Type.String({ description: "Guidance within the active factual local question, or one new bounded factual local question for a settled helper. Partition by behavior or claim. Do not request assessment, planning, or recommendation for the overall outcome." }),
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
      return batchToolResult(`Started ${batch.id}: ${names}. If these reports contribute to the current outcome, end this turn now. Do not inspect another evidence branch for that outcome or poll status. Continue only a separate user-requested outcome that cannot affect or be affected by the reports.`, newAssignments, batch);
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Agents",
    description: "List agents owned by the current parent Pi session, including closed resumable agents.",
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

function formatList(records: OwnedAgentRecord[]): string {
  if (records.length === 0) return "No agents are owned by this parent session.";
  return records.map((record) => {
    const resumable = record.sessionFile ? ", resumable" : "";
    return `${record.name}: ${record.status}, identity ${record.identity}, assignment ${record.assignment}${resumable}`;
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
  const items = visible.map((record) =>
    record.status === "working" ? record.name : `${record.name} (${record.status})`,
  );
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
  return `Owned helper ${record.name} settled${status}. Evaluate and connect this evidence yourself; do not merely repeat the report.\n\n${record.lastResult ?? record.lastError ?? "(no result)"}`;
}

function formatCollectionNotification(collection: OwnedAgentCollection): string {
  const records = collection.members.flatMap((member) => member.result ? [member.result] : []);
  const text = `Owned helper batch ${collection.id} settled. Evaluate and connect this evidence yourself; do not merely repeat the reports.\n\n${formatResults(records)}`;
  const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return truncated.truncated
    ? `${truncated.content}\n\n[Batch output truncated. Full individual results remain in the child Pi session files.]`
    : truncated.content;
}
