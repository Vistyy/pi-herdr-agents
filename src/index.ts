import { createHash } from "node:crypto";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getConfigDirectory, loadConfig } from "./config.js";
import { HerdrClient } from "./herdr.js";
import { AgentManager } from "./manager.js";
import { OWNED_AGENT_ENTRY, type ExtensionConfig, type OwnedAgentRecord, type OwnedAgentSnapshot } from "./types.js";

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
  const herdrSkillRoot = join(dirname(configDir), "skills", "herdr");
  const forbiddenDefault = findForbiddenResource(config.defaults.extensions, packageRoot, "delegation extension")
    ?? findForbiddenResource(config.defaults.skills, herdrSkillRoot, "Herdr skill");
  if (forbiddenDefault) {
    pi.on("session_start", (_event, ctx) => ctx.ui.notify(`Invalid pi-herdr-agents defaults: ${forbiddenDefault}`, "error"));
    return;
  }
  config.identities = config.identities.filter((identity) => {
    const forbidden = findForbiddenResource(identity.extensions, packageRoot, "delegation extension")
      ?? findForbiddenResource(identity.skills, herdrSkillRoot, "Herdr skill");
    if (!forbidden) return true;
    config.warnings.push(`Disabled identity ${identity.name}: ${forbidden}`);
    return false;
  });

  let manager: AgentManager | undefined;
  pi.on("session_start", async (_event, ctx) => {
    for (const warning of config.warnings) ctx.ui.notify(warning, "warning");
    if (config.identities.length === 0) return;

    const parentSessionId = ctx.sessionManager.getSessionId();
    const parentToken = createHash("sha256").update(parentSessionId).digest("hex").slice(0, 8);
    const herdr = new HerdrClient((command, args, options) => pi.exec(command, args, options));
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
        persist(records) {
          const snapshot: OwnedAgentSnapshot = { version: 1, parentSessionId, records };
          pi.appendEntry(OWNED_AGENT_ENTRY, snapshot);
        },
        notify(record) {
          pi.sendMessage(
            {
              customType: OWNED_AGENT_ENTRY,
              content: formatNotification(record),
              display: true,
              details: record,
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        },
      },
    );
    await manager.restore(readSnapshot(ctx, parentSessionId));
  });

  pi.on("session_shutdown", async (event) => {
    if (!manager) return;
    if (event.reason === "reload") manager.suspend();
    else await manager.shutdown();
    manager = undefined;
  });

  if (config.identities.length === 0) return;
  registerTools(pi, config, () => {
    if (!manager) throw new Error("Owned agents are unavailable before the parent session starts.");
    return manager;
  });
}

function findForbiddenResource(resources: string[] | undefined, root: string, label: string): string | undefined {
  const match = resources?.find((resource) => resource === root || resource.startsWith(`${root}${sep}`));
  return match ? `${label} must not be loaded into child agents (${match})` : undefined;
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
      "Use start_agent for bounded delegated research, review, or other mostly non-mutating work.",
      "Do not assign overlapping repository write tasks to owned agents; prefer the parent session's But Why workflow for repository implementation when available.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Unique task name matching [a-z][a-z0-9_-]{0,28}" }),
      identity: StringEnum(identityNames as [string, ...string[]], { description: "Configured agent identity" }),
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
      return toolResult(`Started ${record.name} with identity ${record.identity}.`, [record]);
    },
  });

  pi.registerTool({
    name: "send_agent",
    label: "Send Agent",
    description: "Send a new assignment or follow-up to an owned agent. A closed agent is resumed in a new Herdr tab.",
    promptSnippet: "Send a follow-up to an owned agent, reopening it when needed",
    promptGuidelines: ["Use send_agent for follow-up work that needs an owned agent's existing session context."],
    parameters: Type.Object({
      name: Type.String({ description: "Owned agent task name" }),
      message: Type.String({ description: "New assignment or follow-up" }),
    }),
    async execute(_id, params, signal) {
      const record = await getManager().send(params.name, params.message, signal);
      return toolResult(`Sent assignment ${record.assignment} to ${record.name}.`, [record]);
    },
  });

  pi.registerTool({
    name: "wait_agents",
    label: "Wait for Agents",
    description: "Wait for selected owned agents to settle and return their latest results. Waiting claims those results and suppresses their automatic parent notification.",
    promptSnippet: "Wait for owned agents and claim their results",
    promptGuidelines: ["Use wait_agents only when the next action depends on the selected agents; otherwise continue useful work."],
    parameters: Type.Object({
      names: Type.Optional(Type.Array(Type.String(), { uniqueItems: true, description: "Agent names. Omit to wait for all working owned agents." })),
    }),
    async execute(_id, params, signal) {
      const records = await getManager().wait(params.names, signal);
      return toolResult(formatResults(records), records);
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

function readSnapshot(ctx: ExtensionContext, parentSessionId: string): OwnedAgentRecord[] {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "custom" || entry.customType !== OWNED_AGENT_ENTRY) continue;
    const data = entry.data as Partial<OwnedAgentSnapshot> | undefined;
    if (data?.version === 1 && data.parentSessionId === parentSessionId && Array.isArray(data.records)) {
      return data.records;
    }
  }
  return [];
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

function formatNotification(record: OwnedAgentRecord): string {
  return `Owned agent ${record.name} settled with status ${record.status}.\n\n${record.lastResult ?? record.lastError ?? "(no result)"}`;
}
