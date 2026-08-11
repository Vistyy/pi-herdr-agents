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

  async waitForTurn(target: string, baselineSequence: number, signal?: AbortSignal): Promise<HerdrAgent> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const agent = await this.getAgent(target, signal);
      if ((agent.state_change_seq ?? baselineSequence) > baselineSequence) {
        if (agent.agent_status === "working" || agent.agent_status === "unknown") return this.wait(target, signal);
        return agent;
      }
      await delay(50, signal);
    }
    throw new Error("The child agent did not begin processing the submitted assignment within 5 seconds.");
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
      await this.run("herdr", ["agent", "send-keys", target, "ctrl+c"], { signal, timeout: 10_000 }),
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
  instructions: string;
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
  args.push("--append-system-prompt", options.instructions);
  args.push("--name", options.sessionName);

  args.push("--session", options.sessionFile);
  return args;
}
