import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { RuntimeSettings, HerdrAgent } from "./types.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<CommandResult>;

interface HerdrEnvelope<T> {
  result?: T;
  error?: { code?: string; message?: string };
}

export interface CreatedTab {
  tabId: string;
  paneId: string;
}

export interface WaitForTurnOptions {
  /** Bound settlement polling after an interrupt state transition is observed. */
  settleTimeoutMs?: number;
  /** Interrupts can settle without Herdr advancing the state sequence. */
  acceptSettledStatusWithoutSequence?: boolean;
}

export const HERDR_METADATA_SOURCE = "pi-herdr-agents";
export const HERDR_OWNED_TOKEN = "pi_herdr_owned";
const PI_INTERRUPT_KEY = "escape";
// Herdr control responses are small; these bounds allow diagnostics while
// preventing an incomplete newline-delimited response from waiting 10 seconds.
const MAX_SOCKET_FRAME_BYTES = 64 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 128 * 1024;

export interface AgentViewState {
  active: boolean;
  source?: string;
  label?: string;
}

export class HerdrSocketClient {
  constructor(
    private readonly socketPath = process.env.HERDR_SOCKET_PATH,
    private readonly connect: (path: string) => Socket = (path) => createConnection(path),
  ) {}

  async setOwnedAgentView(): Promise<AgentViewState> {
    return this.request<AgentViewState>("agent.view.set", {
      source: HERDR_METADATA_SOURCE,
      filter: {
        op: "not",
        filter: { op: "exists", field: { token: HERDR_OWNED_TOKEN } },
      },
    });
  }

  async clearAgentView(source: string): Promise<AgentViewState> {
    return this.request<AgentViewState>("agent.view.clear", { source });
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.socketPath) throw new Error("HERDR_SOCKET_PATH is unavailable; cannot use the Herdr socket API.");
    const id = `pi-herdr-agents-${randomUUID()}`;
    const socket = this.connect(this.socketPath);
    return new Promise<T>((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      socket.setEncoding("utf8");
      socket.setTimeout(10_000, () => finish(new Error(`Herdr socket request ${method} timed out.`)));
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      socket.on("data", (chunk: string | Buffer) => {
        buffer += chunk.toString();
        if (Buffer.byteLength(buffer, "utf8") > MAX_SOCKET_BUFFER_BYTES) {
          finish(new Error(`Herdr socket pending buffer exceeded ${MAX_SOCKET_BUFFER_BYTES} bytes for ${method}.`));
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line, "utf8") > MAX_SOCKET_FRAME_BYTES) {
            finish(new Error(`Herdr socket frame exceeded ${MAX_SOCKET_FRAME_BYTES} bytes for ${method}.`));
            return;
          }
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            finish(new Error(`Herdr socket returned invalid JSON for ${method}.`));
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            finish(new Error(`Herdr socket returned a non-object frame for ${method}.`));
            return;
          }
          const response = parsed as { id?: string; result?: T; error?: { code?: string; message?: string } };
          if (response.error) {
            finish(new Error(`Herdr ${method} failed${response.error.code ? ` (${response.error.code})` : ""}: ${response.error.message ?? "unknown error"}`));
            return;
          }
          if (response.id !== id) continue;
          if (response.result === undefined) {
            finish(new Error(`Herdr ${method} returned no result.`));
            return;
          }
          finish(undefined, response.result);
          return;
        }
      });
      socket.on("error", (error) => finish(new Error(`Herdr socket ${method} failed: ${error.message}`)));
      socket.on("close", () => finish(new Error(`Herdr socket closed before ${method} completed.`)));
    });
  }
}

class HerdrCommandError extends Error {
  constructor(readonly code: string | undefined, message: string) {
    super(message);
  }
}

function parseEnvelope<T>(result: CommandResult, operation: string): T {
  let envelope: HerdrEnvelope<T>;
  try {
    envelope = JSON.parse(result.stdout || result.stderr) as HerdrEnvelope<T>;
  } catch {
    throw new Error(`${operation} returned invalid JSON${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  if (result.code !== 0 || envelope.error) {
    throw new HerdrCommandError(
      envelope.error?.code,
      envelope.error?.message ?? `${operation} failed with exit code ${result.code}`,
    );
  }
  if (!envelope.result) throw new Error(`${operation} returned no result`);
  return envelope.result;
}

export class HerdrClient {
  constructor(private readonly run: CommandRunner) {}

  async createTab(workspaceId: string, cwd: string, label: string, signal?: AbortSignal): Promise<CreatedTab> {
    const result = parseEnvelope<Record<string, any>>(
      await this.run("herdr", [
        "tab",
        "create",
        "--workspace",
        workspaceId,
        "--cwd",
        cwd,
        "--label",
        label,
        "--no-focus",
      ], { signal, timeout: 10_000 }),
      "herdr tab create",
    );
    const tabId = result.tab?.tab_id ?? result.tab_id;
    const paneId = result.root_pane?.pane_id ?? result.pane?.pane_id ?? result.pane_id;
    if (typeof tabId !== "string" || typeof paneId !== "string") {
      throw new Error("herdr tab create omitted the tab or pane ID");
    }
    return { tabId, paneId };
  }

  async startPi(
    agentName: string,
    paneId: string,
    piArgs: string[],
    signal?: AbortSignal,
  ): Promise<HerdrAgent> {
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        const result = parseEnvelope<Record<string, any>>(
          await this.run("herdr", [
            "agent",
            "start",
            agentName,
            "--kind",
            "pi",
            "--pane",
            paneId,
            "--timeout",
            "120000",
            "--",
            ...piArgs,
          ], { signal, timeout: 130_000 }),
          "herdr agent start",
        );
        return normalizeAgent(result.agent ?? result);
      } catch (error) {
        if (!(error instanceof HerdrCommandError) || error.code !== "agent_pane_busy" || Date.now() >= deadline) {
          throw error;
        }
        await delay(100, signal);
      }
    }
  }

  async prompt(target: string, message: string, signal?: AbortSignal): Promise<HerdrAgent> {
    const result = parseEnvelope<Record<string, any>>(
      await this.run("herdr", ["agent", "prompt", target, message], { signal, timeout: 10_000 }),
      "herdr agent prompt",
    );
    return normalizeAgent(result.agent ?? result);
  }

  async reportDisplayAgent(paneId: string, displayAgent: string, signal?: AbortSignal): Promise<void> {
    const result = await this.run("herdr", [
      "pane",
      "report-metadata",
      paneId,
      "--source",
      HERDR_METADATA_SOURCE,
      "--agent",
      "pi",
      "--applies-to-source",
      "herdr:pi",
      "--display-agent",
      displayAgent,
      "--token",
      `${HERDR_OWNED_TOKEN}=1`,
    ], { signal, timeout: 10_000 });
    if (result.code === 0 && !result.stdout.trim() && !result.stderr.trim()) return;
    parseEnvelope(result, "herdr pane report-metadata");
  }

  async waitForTurn(
    target: string,
    baselineSequence: number,
    signal?: AbortSignal,
    options: WaitForTurnOptions = {},
  ): Promise<HerdrAgent> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const agent = await this.getAgent(target, signal);
      const stateChanged = (agent.state_change_seq ?? baselineSequence) > baselineSequence;
      const settled = agent.agent_status === "idle" || agent.agent_status === "done" || agent.agent_status === "blocked";
      if (options.acceptSettledStatusWithoutSequence && settled) return agent;
      if (stateChanged) {
        if (agent.agent_status === "working" || agent.agent_status === "unknown") {
          if (options.settleTimeoutMs !== undefined) {
            const remaining = Math.max(1, deadline - Date.now());
            return this.waitForSettlement(target, Math.min(options.settleTimeoutMs, remaining), signal);
          }
          return this.wait(target, signal);
        }
        return agent;
      }
      await delay(50, signal);
    }
    if (options.settleTimeoutMs !== undefined) {
      throw new Error("The child agent did not settle after interrupt within 5 seconds.");
    }
    throw new Error("The child agent did not begin processing the submitted assignment within 5 seconds.");
  }

  private async waitForSettlement(target: string, timeoutMs: number, signal?: AbortSignal): Promise<HerdrAgent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const agent = await this.getAgent(target, signal);
      if (agent.agent_status !== "working" && agent.agent_status !== "unknown") return agent;
      await delay(Math.min(50, Math.max(1, deadline - Date.now())), signal);
    }
    throw new Error(`The child agent did not settle within ${timeoutMs}ms after interrupt.`);
  }

  async wait(target: string, signal?: AbortSignal): Promise<HerdrAgent> {
    const result = parseEnvelope<Record<string, any>>(
      await this.run("herdr", ["agent", "wait", target], { signal }),
      "herdr agent wait",
    );
    return normalizeAgent(result.agent ?? result);
  }

  async getAgent(target: string, signal?: AbortSignal): Promise<HerdrAgent> {
    const result = parseEnvelope<Record<string, any>>(
      await this.run("herdr", ["agent", "get", target], { signal, timeout: 10_000 }),
      "herdr agent get",
    );
    return normalizeAgent(result.agent ?? result);
  }

  async interrupt(target: string, signal?: AbortSignal): Promise<void> {
    parseEnvelope(
      await this.run("herdr", ["agent", "send-keys", target, PI_INTERRUPT_KEY], { signal, timeout: 10_000 }),
      "herdr agent send-keys",
    );
  }

  async closeTab(tabId: string): Promise<void> {
    parseEnvelope(await this.run("herdr", ["tab", "close", tabId], { timeout: 10_000 }), "herdr tab close");
  }
}

function normalizeAgent(value: Record<string, any>): HerdrAgent {
  const paneId = value.pane_id;
  const tabId = value.tab_id;
  const workspaceId = value.workspace_id;
  if (typeof paneId !== "string" || typeof tabId !== "string" || typeof workspaceId !== "string") {
    throw new Error("Herdr agent response omitted topology IDs");
  }
  return {
    name: typeof value.name === "string" ? value.name : undefined,
    agent_status: value.agent_status,
    pane_id: paneId,
    tab_id: tabId,
    workspace_id: workspaceId,
    state_change_seq: typeof value.state_change_seq === "number" ? value.state_change_seq : undefined,
    agent_session: value.agent_session,
  };
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Operation cancelled."));
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Operation cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function buildPiArgs(options: {
  settings: RuntimeSettings;
  instructions?: string;
  sessionFile: string;
  sessionName: string;
}): string[] {
  const { settings } = options;
  const args = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--system-prompt", ""];

  for (const extension of settings.extensions ?? []) args.push("--extension", extension);
  for (const skill of settings.skills ?? []) args.push("--skill", skill);

  if ((settings.tools ?? []).length === 0) args.push("--no-tools");
  else args.push("--tools", settings.tools!.join(","));

  if (settings.provider) args.push("--provider", settings.provider);
  if (settings.model) args.push("--model", settings.model);
  if (settings.thinking) args.push("--thinking", settings.thinking);
  if (options.instructions) args.push("--append-system-prompt", options.instructions);
  args.push("--name", options.sessionName);

  args.push("--session", options.sessionFile);
  return args;
}
