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
import { AgentManager, type WaitProgress } from "./manager.js";
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
          updateAgentWidget(ctx, records, manager?.getClaimedNames() ?? []);
        },
        changed() {
          updateAgentWidget(ctx, manager?.getRecords() ?? [], manager?.getClaimedNames() ?? []);
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
        activityBus: pi.events,
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
      parentSessionId,
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
    name: "start_agent",
    label: "Start Agent",
    description: `Start an owned Pi agent in a new tab in the current Herdr workspace. Returns after the agent accepts its assignment. Available identities:\n${identityCatalog}`,
    promptSnippet: "Start an owned Pi agent in a new Herdr tab",
    promptGuidelines: [
      "Default to start_agent for each separable bounded deliverable before gathering its detailed working context.",
      "If completing a separable deliverable requires file reads, searches, commands, investigation, implementation, review, or verification, use start_agent even when the work is small or tightly coupled to the parent decision.",
      "Use parent-session tools for outcome framing, authoritative project context, cross-cutting synthesis, conflict resolution, and checking material result evidence. Delegate the bounded execution and detailed working context.",
      "Keep outcome framing, cross-cutting decisions, synthesis, and user communication in the parent session.",
      "After start_agent or send_agent returns, continue useful independent work or finish the parent turn by default. Do not call wait_agents only to monitor completion.",
      "While a delegated scope is active, do not gather the same evidence or perform the same work in the parent session. After completion, check only the material evidence needed to integrate the result.",
      "Do not assign overlapping repository write scopes to concurrent agents.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Unique task name matching [a-z][a-z0-9_-]{0,28}" }),
      identity: Type.String({ description: `Configured agent identity. Available when this session started: ${identityNames.join(", ")}` }),
      task: Type.String({ description: "Concrete assignment and expected result" }),
      keep_open: Type.Optional(Type.Boolean({ description: "Keep the agent tab open after completion. Default: false." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const record = await getManager().start({
        name: params.name,
        identityName: params.identity,
        task: params.task,
        keepOpen: params.keep_open ?? false,
        cwd: ctx.cwd,
      }, signal);
      return toolResult(`Started ${record.name} with identity ${record.identity}. Continue independent work or finish the parent turn; do not call wait_agents just to monitor completion.`, [record]);
    },
  });

  pi.registerTool({
    name: "send_agent",
    label: "Send Agent",
    description: "Send a new assignment or follow-up to an owned agent. A closed agent is resumed in a new Herdr tab.",
    promptSnippet: "Send a follow-up to an owned agent, reopening it when needed",
    promptGuidelines: [
      "Use send_agent for follow-up work that needs an owned agent's existing session context.",
      "After start_agent or send_agent returns, continue useful independent work or finish the parent turn by default. Do not call wait_agents only to monitor completion.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Owned agent task name" }),
      message: Type.String({ description: "New assignment or follow-up" }),
    }),
    async execute(_id, params, signal) {
      const record = await getManager().send(params.name, params.message, signal);
      return toolResult(`Sent assignment ${record.assignment} to ${record.name}. Continue independent work or finish the parent turn; do not call wait_agents just to monitor completion.`, [record]);
    },
  });

  pi.registerTool({
    name: "wait_agents",
    label: "Wait for Agents",
    description: "Exceptional tool only. Use wait_agents when one specific agent result is a prerequisite for an immediate next tool call in this parent turn and neither continuing nor collect_agents can satisfy that dependency. Do not use it to monitor progress, obtain a final response, or wait for later synthesis. Waiting claims those results and suppresses their automatic parent notification.",
    promptSnippet: "Wait only for an immediate blocking dependency",
    promptGuidelines: [
      "Default completion protocol: do not call wait_agents after start_agent or send_agent. Continue useful independent work or finish the parent turn so completion notifications can resume it.",
      "A final parent response or later synthesis is not an immediate next tool call and is not a reason to wait.",
      "Use wait_agents only when one specific result is required for an immediate next tool call in this turn and neither yielding nor collect_agents can satisfy that dependency.",
      "Pass explicit names for that one dependency. Do not omit names to wait for all working agents.",
      "After collect_agents returns, never call wait_agents for any assignment in that collection. The collection notification supplies the grouped results.",
    ],
    parameters: Type.Object({
      names: Type.Optional(Type.Array(Type.String(), { uniqueItems: true, description: "Agent names. Omit to wait for all working owned agents." })),
    }),
    async execute(_id, params, signal, onUpdate) {
      const records = await getManager().wait(params.names, signal, (progress) => {
        onUpdate?.({
          content: [{ type: "text", text: formatWaitProgress(progress) }],
          details: { progress },
        });
      });
      return toolResult(formatResults(records), records);
    },
    renderResult(result, { isPartial }, _theme, context) {
      if (context.isError) return singleLineComponent("Wait failed");
      const details = result.details as { progress?: WaitProgress } | undefined;
      if (isPartial && details?.progress) {
        return inlineListComponent("", formatWaitItems(details.progress));
      }
      return singleLineComponent("Done");
    },
  });

  pi.registerTool({
    name: "collect_agents",
    label: "Collect Agents",
    description: "Register a nonblocking barrier for an exact fixed group of current assignments whose results require one synthesis, whether or not useful independent work remains. Returns immediately, suppresses individual notifications, and sends one parent follow-up with the grouped results after every named assignment settles.",
    promptSnippet: "Collect an exact group, then yield for one synthesis wake",
    promptGuidelines: [
      "Use collect_agents for an exact fixed group whose results require one synthesis, whether or not useful independent work remains.",
      "After collect_agents returns, do not call wait_agents for any collected assignment. Continue useful work or finish the parent turn so the collection notification can resume it with the grouped results.",
    ],
    parameters: Type.Object({
      names: Type.Array(Type.String(), {
        minItems: 1,
        uniqueItems: true,
        description: "Fixed agent names whose current assignments form the collection.",
      }),
    }),
    async execute(_id, params) {
      const collection = getManager().collect(params.names);
      const assignments = collection.members.map((member) => `${member.name}#${member.assignment}`).join(", ");
      return {
        content: [{ type: "text" as const, text: `Registered ${collection.id} for ${assignments}. The parent will be notified with the grouped results after all assignments settle. Do not call wait_agents for these assignments; continue useful work or finish the parent turn.` }],
        details: { collection },
      };
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
    description: "Send Ctrl+C to one live owned agent without closing its tab or deleting its Pi session.",
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

function formatList(records: OwnedAgentRecord[]): string {
  if (records.length === 0) return "No agents are owned by this parent session.";
  return records.map((record) => {
    const resumable = record.sessionFile ? ", resumable" : "";
    return `${record.name}: ${record.status}, identity ${record.identity}, assignment ${record.assignment}${resumable}`;
  }).join("\n");
}

function formatResults(records: OwnedAgentRecord[]): string {
  if (records.length === 0) return "No working owned agents to wait for.";
  return records.map((record) => `## ${record.name} (${record.status})\n\n${record.lastResult ?? record.lastError ?? "(no result)"}`).join("\n\n");
}

function formatWaitProgress(progress: WaitProgress): string {
  const items = formatWaitItems(progress);
  return items.length > 0 ? items.join(" | ") : "No agents";
}

function formatWaitItems(progress: WaitProgress): string[] {
  const completed = new Set(progress.completed);
  return progress.selected.map((name) => `${name} ${completed.has(name) ? "✓" : "…"}`);
}

function updateAgentWidget(ctx: ExtensionContext, records: OwnedAgentRecord[], claimedNames: string[]): void {
  if (ctx.mode !== "tui") return;
  const claimed = new Set(claimedNames);
  const visible = records.filter((record) =>
    record.status === "starting" || Boolean(record.paneId) || claimed.has(record.name),
  );
  if (visible.length === 0) {
    ctx.ui.setWidget("pi-herdr-agents", undefined);
    return;
  }
  const items = visible.map((record) =>
    `${record.name} [${record.status}${claimed.has(record.name) ? "/claimed" : ""}]`,
  );
  ctx.ui.setWidget("pi-herdr-agents", () => ({
    render(width) {
      return wrapInline("Agents: ", items, width);
    },
    invalidate() {},
  }));
}

function singleLineComponent(text: string) {
  return inlineListComponent("", [text]);
}

function inlineListComponent(prefix: string, items: string[]) {
  return {
    render(width: number) {
      return wrapInline(prefix, items, width);
    },
    invalidate() {},
  };
}

function wrapInline(prefix: string, items: string[], width: number): string[] {
  if (width <= 0) return [""];
  const lines: string[] = [];
  let line = prefix;
  for (const item of items) {
    const separator = line === prefix ? "" : " | ";
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
  return `Owned agent ${record.name} settled with status ${record.status}.\n\n${record.lastResult ?? record.lastError ?? "(no result)"}`;
}

function formatCollectionNotification(collection: OwnedAgentCollection): string {
  const records = collection.members.flatMap((member) => member.result ? [member.result] : []);
  const text = `Owned agent collection ${collection.id} settled.\n\n${formatResults(records)}`;
  const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return truncated.truncated
    ? `${truncated.content}\n\n[Collection output truncated. Full individual results remain in the child Pi session files.]`
    : truncated.content;
}
