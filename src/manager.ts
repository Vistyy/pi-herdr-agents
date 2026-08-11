import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { AgentIdentity, ExtensionConfig, OwnedAgentRecord, RuntimeSettings } from "./types.js";
import { buildPiArgs, HerdrClient } from "./herdr.js";
import { readLatestAssistantResult } from "./session-result.js";

interface TurnState {
  assignment: number;
  claimed: boolean;
  controller: AbortController;
  promise: Promise<OwnedAgentRecord>;
  resolve: (record: OwnedAgentRecord) => void;
}

export interface WaitProgress {
  selected: string[];
  completed: string[];
  waiting: string[];
}

export interface ManagerCallbacks {
  persist(records: OwnedAgentRecord[]): void;
  notify(record: OwnedAgentRecord): void;
  changed?(): void;
  resolveRuntime?(identity: AgentIdentity, cwd: string): Promise<RuntimeSettings>;
}

export class AgentManager {
  private readonly records = new Map<string, OwnedAgentRecord>();
  private readonly turns = new Map<string, TurnState>();
  private readonly interruptions = new Set<string>();
  private stopped = false;

  constructor(
    private readonly herdr: HerdrClient,
    private readonly config: ExtensionConfig,
    private readonly workspaceId: string,
    private readonly sessionDir: string,
    private readonly parentToken: string,
    private readonly parentSettings: RuntimeSettings & { model: string; thinking: NonNullable<RuntimeSettings["thinking"]> },
    private readonly callbacks: ManagerCallbacks,
  ) {}

  getRecords(): OwnedAgentRecord[] {
    return [...this.records.values()].sort((left, right) => left.updatedAt - right.updatedAt).map(cloneRecord);
  }

  getClaimedNames(): string[] {
    return [...this.turns.entries()]
      .filter(([, turn]) => turn.claimed)
      .map(([name]) => name)
      .sort();
  }

  async restore(records: OwnedAgentRecord[]): Promise<void> {
    for (const record of records) this.records.set(record.name, cloneRecord(record));
    for (const record of this.records.values()) {
      if (!record.paneId || record.status === "closed") continue;
      try {
        const agent = await this.herdr.getAgent(record.paneId);
        if (record.sessionFile && agent.agent_session?.value && agent.agent_session.value !== record.sessionFile) {
          record.status = "failed";
          record.lastError = "The recorded pane now hosts a different Pi session.";
          record.updatedAt = Date.now();
          continue;
        }
        record.tabId = agent.tab_id;
        if (agent.agent_status === "working" || agent.agent_status === "unknown") {
          record.status = "working";
          this.watch(record);
        } else if (agent.agent_status === "blocked") {
          await this.settleBlocked(record);
        } else if (record.completedAssignment !== record.assignment) {
          await this.settleCompleted(record);
        } else {
          record.status = "idle";
        }
      } catch {
        record.status = "closed";
        record.paneId = undefined;
        record.tabId = undefined;
        record.updatedAt = Date.now();
      }
    }
    this.persist();
  }

  async start(options: {
    name: string;
    identityName: string;
    task: string;
    keepOpen: boolean;
    cwd: string;
  }, signal?: AbortSignal): Promise<OwnedAgentRecord> {
    this.assertRunning();
    validateAgentName(options.name);
    if (this.records.has(options.name)) throw new Error(`Agent name already belongs to this parent session: ${options.name}`);
    if (this.liveCount() >= this.config.maxAgents) {
      throw new Error(`Live agent limit reached (${this.config.maxAgents}). Close an agent before starting another.`);
    }
    const identity = this.getIdentity(options.identityName);
    const record: OwnedAgentRecord = {
      name: options.name,
      identity: identity.name,
      keepOpen: options.keepOpen,
      status: "starting",
      cwd: options.cwd,
      assignment: 1,
      lastTask: options.task,
      updatedAt: Date.now(),
    };
    this.records.set(record.name, record);
    this.persist();

    let tabId: string | undefined;
    try {
      await mkdir(this.sessionDir, { recursive: true });
      const tab = await this.herdr.createTab(this.workspaceId, options.cwd, options.name, signal);
      tabId = tab.tabId;
      record.tabId = tab.tabId;
      record.paneId = tab.paneId;
      this.persist();

      const settings = await this.runtimeSettings(identity, options.cwd);
      const instructionsFile = await this.writeInstructions(identity);
      record.sessionFile = join(this.sessionDir, `${randomUUID()}.jsonl`);
      const agent = await this.herdr.startPi(
        makeHerdrAgentName(this.parentToken, options.name),
        tab.paneId,
        buildPiArgs({
          settings,
          instructions: instructionsFile,
          sessionFile: record.sessionFile,
          sessionName: options.name,
        }),
        signal,
      );
      record.paneId = agent.pane_id;
      record.tabId = agent.tab_id;
      const reportedSessionFile = agent.agent_session?.value;
      if (reportedSessionFile && reportedSessionFile !== record.sessionFile) {
        throw new Error("Herdr reported a different child Pi session file.");
      }

      const prompted = await this.herdr.prompt(record.paneId, handoff(options.task), signal);
      record.status = "working";
      record.updatedAt = Date.now();
      this.persist();
      this.watch(record, prompted.state_change_seq);
      return cloneRecord(record);
    } catch (error) {
      if (tabId) {
        try {
          await this.herdr.closeTab(tabId);
        } catch (closeError) {
          record.status = "failed";
          record.lastError = `Startup failed and owned tab ${tabId} could not close: ${(closeError as Error).message}`;
          record.updatedAt = Date.now();
          this.persist();
          throw new Error(`${(error as Error).message}; ${record.lastError}`);
        }
      }
      if (this.records.get(record.name) === record) this.records.delete(record.name);
      this.persist();
      throw error;
    }
  }

  async send(name: string, message: string, signal?: AbortSignal): Promise<OwnedAgentRecord> {
    this.assertRunning();
    const record = this.requireRecord(name);
    if (!message.trim()) throw new Error("Message must not be empty.");
    if (record.status === "closed" || !record.paneId) await this.reopen(record, signal);
    if (this.interruptions.has(name)) {
      throw new Error(`Agent ${name} is being interrupted. Wait for the interrupt operation to finish.`);
    }
    if (this.turns.has(name) || record.status === "working") {
      throw new Error(`Agent ${name} is already working. Wait for or interrupt its current assignment first.`);
    }

    const previous = cloneRecord(record);
    record.assignment += 1;
    record.lastTask = message;
    record.lastResult = undefined;
    record.lastError = undefined;
    record.status = "working";
    record.updatedAt = Date.now();
    this.persist();
    try {
      const prompted = await this.herdr.prompt(record.paneId!, handoff(message), signal);
      this.watch(record, prompted.state_change_seq);
    } catch (error) {
      Object.assign(record, previous, { updatedAt: Date.now() });
      this.persist();
      throw error;
    }
    return cloneRecord(record);
  }

  async wait(
    names?: string[],
    signal?: AbortSignal,
    onProgress?: (progress: WaitProgress) => void,
  ): Promise<OwnedAgentRecord[]> {
    const selected = names?.length ? names.map((name) => this.requireRecord(name)) : [...this.records.values()].filter((record) => record.status === "working");
    const selections = selected.map((record) => ({ record, turn: this.turns.get(record.name) }));
    const completed = new Set(selections.filter(({ turn }) => !turn).map(({ record }) => record.name));
    const reportProgress = () => onProgress?.({
      selected: selections.map(({ record }) => record.name),
      completed: selections.map(({ record }) => record.name).filter((name) => completed.has(name)),
      waiting: selections.map(({ record }) => record.name).filter((name) => !completed.has(name)),
    });
    for (const selection of selections) {
      if (selection.turn) selection.turn.claimed = true;
    }
    this.callbacks.changed?.();
    reportProgress();

    try {
      return await Promise.all(selections.map(async ({ record, turn }) => {
        const result = cloneRecord(turn ? await waitWithSignal(turn.promise, signal) : record);
        completed.add(record.name);
        reportProgress();
        return result;
      }));
    } catch (error) {
      for (const { record, turn } of selections) {
        if (turn && this.turns.get(record.name) === turn) turn.claimed = false;
      }
      this.callbacks.changed?.();
      throw error;
    }
  }

  async interrupt(name: string, signal?: AbortSignal): Promise<OwnedAgentRecord> {
    this.assertRunning();
    const record = this.requireLiveRecord(name);
    if (this.interruptions.has(name)) throw new Error(`Owned agent ${name} is already being interrupted.`);
    const assignment = record.assignment;
    const paneId = record.paneId!;
    this.interruptions.add(name);

    try {
      const baseline = await this.herdr.getAgent(paneId, signal);
      if (baseline.agent_status !== "working" && baseline.agent_status !== "blocked" && baseline.agent_status !== "unknown") {
        throw new Error(`Owned agent ${name} is not currently working or blocked.`);
      }
      const turn = this.turns.get(name);
      turn?.controller.abort();

      try {
        await this.herdr.interrupt(paneId, signal);
        await this.herdr.waitForTurn(paneId, baseline.state_change_seq ?? 0, signal);
        if (record.assignment !== assignment || record.paneId !== paneId) {
          throw new Error(`Owned agent ${name} changed assignments while the interrupt was settling.`);
        }
        this.turns.delete(name);
        record.status = "interrupted";
        record.lastResult = `Assignment ${assignment} was interrupted.`;
        record.lastError = undefined;
        record.completedAssignment = assignment;
        record.notifiedAssignment = assignment;
        record.updatedAt = Date.now();
        this.persist();
        turn?.resolve(cloneRecord(record));
        return cloneRecord(record);
      } catch (error) {
        const currentStatus = await this.herdr.getAgent(paneId).then(
          (agent) => agent.agent_status,
          () => "unknown" as const,
        );
        if (record.assignment !== assignment || record.paneId !== paneId) throw error;
        record.lastError = `Interrupt did not settle the assignment: ${(error as Error).message}`;
        record.updatedAt = Date.now();
        if (currentStatus === "blocked") {
          await this.settleBlocked(record, turn);
        } else if (currentStatus === "idle" || currentStatus === "done") {
          await this.settleCompleted(record, turn);
        } else {
          record.status = "working";
          this.persist();
          if (!this.stopped) this.watch(record, undefined, turn);
        }
        throw error;
      }
    } finally {
      this.interruptions.delete(name);
    }
  }

  async close(name: string): Promise<OwnedAgentRecord> {
    const record = this.requireRecord(name);
    if (this.interruptions.has(name)) throw new Error(`Owned agent ${name} is being interrupted.`);
    if (record.status === "starting") throw new Error(`Owned agent ${name} is still starting or reopening.`);
    await this.closeRecord(record, record.status === "working" ? "interrupted" : "closed");
    return cloneRecord(record);
  }

  suspend(): void {
    this.stopped = true;
    for (const turn of this.turns.values()) turn.controller.abort();
    this.turns.clear();
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.records.values()].map(async (record) => {
      if (!record.paneId || record.status === "closed") return;
      await this.closeRecord(record, record.status === "working" ? "interrupted" : "closed").catch(() => undefined);
    }));
  }

  private async reopen(record: OwnedAgentRecord, signal?: AbortSignal): Promise<void> {
    if (record.status === "starting") throw new Error(`Owned agent ${record.name} is already reopening.`);
    if (!record.sessionFile) throw new Error(`Agent ${record.name} has no resumable Pi session.`);
    if (this.liveCount() >= this.config.maxAgents) {
      throw new Error(`Live agent limit reached (${this.config.maxAgents}). Close an agent before reopening another.`);
    }
    const identity = this.getIdentity(record.identity);
    const previous = cloneRecord(record);
    record.status = "starting";
    record.updatedAt = Date.now();
    this.persist();

    let tab: { tabId: string; paneId: string } | undefined;
    try {
      tab = await this.herdr.createTab(this.workspaceId, record.cwd, record.name, signal);
      record.tabId = tab.tabId;
      record.paneId = tab.paneId;
      this.persist();
      const instructionsFile = await this.writeInstructions(identity);
      const agent = await this.herdr.startPi(
        makeHerdrAgentName(this.parentToken, record.name),
        tab.paneId,
        buildPiArgs({
          settings: await this.runtimeSettings(identity, record.cwd),
          instructions: instructionsFile,
          sessionFile: record.sessionFile,
          sessionName: record.name,
        }),
        signal,
      );
      record.paneId = agent.pane_id;
      record.tabId = agent.tab_id;
      record.status = "idle";
      record.updatedAt = Date.now();
      this.persist();
    } catch (error) {
      if (tab) {
        try {
          await this.herdr.closeTab(tab.tabId);
        } catch (closeError) {
          record.status = "failed";
          record.lastError = `Reopen failed and owned tab ${tab.tabId} could not close: ${(closeError as Error).message}`;
          record.updatedAt = Date.now();
          this.persist();
          throw new Error(`${(error as Error).message}; ${record.lastError}`);
        }
      }
      Object.assign(record, previous, { updatedAt: Date.now() });
      this.persist();
      throw error;
    }
  }

  private async writeInstructions(identity: AgentIdentity): Promise<string | undefined> {
    if (!identity.instructions) return undefined;
    const promptDir = join(this.sessionDir, "prompts");
    await mkdir(promptDir, { recursive: true });
    const path = join(promptDir, `${identity.name}.md`);
    await writeFile(path, `${identity.instructions.trim()}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
  }

  private runtimeSettings(identity: AgentIdentity, cwd: string): Promise<RuntimeSettings> {
    if (this.callbacks.resolveRuntime) return this.callbacks.resolveRuntime(identity, cwd);
    return Promise.resolve(resolveRuntime(identity, this.config.defaults, this.parentSettings));
  }

  private watch(record: OwnedAgentRecord, baselineSequence?: number, existingTurn?: TurnState): void {
    const oldTurn = this.turns.get(record.name);
    if (oldTurn && oldTurn !== existingTurn) oldTurn.controller.abort();
    const controller = new AbortController();
    let turn = existingTurn;
    if (turn) {
      turn.controller = controller;
    } else {
      let resolve!: (record: OwnedAgentRecord) => void;
      const promise = new Promise<OwnedAgentRecord>((done) => { resolve = done; });
      turn = { assignment: record.assignment, claimed: false, controller, promise, resolve };
    }
    this.turns.set(record.name, turn);

    const settled = baselineSequence === undefined
      ? this.herdr.wait(record.paneId!, controller.signal)
      : this.herdr.waitForTurn(record.paneId!, baselineSequence, controller.signal);
    void settled.then(async (agent) => {
      if (this.turns.get(record.name) !== turn) return;
      if (agent.agent_status === "blocked") await this.settleBlocked(record, turn);
      else await this.settleCompleted(record, turn);
    }).catch((error) => {
      if (controller.signal.aborted || this.stopped) return;
      record.status = "failed";
      record.lastError = (error as Error).message;
      record.updatedAt = Date.now();
      this.finishTurn(record, turn);
    });
  }

  private async settleBlocked(record: OwnedAgentRecord, turn = this.turns.get(record.name)): Promise<void> {
    record.status = "blocked";
    record.completedAssignment = record.assignment;
    record.lastResult = `Agent ${record.name} is blocked and needs input.`;
    record.updatedAt = Date.now();
    if (turn) this.finishTurn(record, turn);
    else this.persistAndNotify(record, false);
  }

  private async settleCompleted(record: OwnedAgentRecord, turn = this.turns.get(record.name)): Promise<void> {
    try {
      if (!record.sessionFile) throw new Error("The child Pi session file is unavailable.");
      const result = readLatestAssistantResult(record.sessionFile);
      record.lastResult = truncateResult(result.text, record.sessionFile);
      record.lastError = result.error;
      record.status = result.failed ? "failed" : "idle";
    } catch (error) {
      record.status = "failed";
      record.lastError = (error as Error).message;
      record.lastResult = `Could not read agent result: ${record.lastError}`;
    }
    record.completedAssignment = record.assignment;
    record.updatedAt = Date.now();
    if (turn) this.finishTurn(record, turn);
    else this.persistAndNotify(record, false);

    if (!record.keepOpen) {
      await this.closeRecord(record, record.status === "failed" ? "failed" : "closed");
    }
  }

  private finishTurn(record: OwnedAgentRecord, turn: TurnState): void {
    if (this.turns.get(record.name) !== turn) return;
    this.turns.delete(record.name);
    this.persistAndNotify(record, turn.claimed);
    turn.resolve(cloneRecord(record));
  }

  private persistAndNotify(record: OwnedAgentRecord, claimed: boolean): void {
    if (!claimed && record.notifiedAssignment !== record.assignment) {
      record.notifiedAssignment = record.assignment;
      this.persist();
      this.callbacks.notify(cloneRecord(record));
      return;
    }
    this.persist();
  }

  private async closeRecord(record: OwnedAgentRecord, status: "closed" | "interrupted" | "failed"): Promise<void> {
    if (record.paneId) {
      try {
        const agent = await this.herdr.getAgent(record.paneId);
        const expectedName = makeHerdrAgentName(this.parentToken, record.name);
        if (agent.name !== expectedName) {
          throw new Error(`pane ${record.paneId} does not host owned agent ${expectedName}`);
        }
        if (record.sessionFile && agent.agent_session?.value && agent.agent_session.value !== record.sessionFile) {
          throw new Error(`pane ${record.paneId} hosts a different Pi session`);
        }
      } catch (error) {
        record.status = "failed";
        record.lastError = `Refused to close unverified owned tab ${record.tabId ?? "(unknown)"}: ${(error as Error).message}`;
        record.updatedAt = Date.now();
        this.persist();
        throw error;
      }
    }
    this.turns.get(record.name)?.controller.abort();
    this.turns.delete(record.name);
    if (record.tabId) {
      try {
        await this.herdr.closeTab(record.tabId);
      } catch (error) {
        record.status = "failed";
        record.lastError = `Could not close owned tab ${record.tabId}: ${(error as Error).message}`;
        record.updatedAt = Date.now();
        this.persist();
        throw error;
      }
    }
    record.status = status;
    record.paneId = undefined;
    record.tabId = undefined;
    record.updatedAt = Date.now();
    this.persist();
  }

  private liveCount(): number {
    return [...this.records.values()].filter((record) => record.status === "starting" || Boolean(record.paneId)).length;
  }

  private getIdentity(name: string): AgentIdentity {
    const identity = this.config.identities.find((candidate) => candidate.name === name);
    if (!identity) throw new Error(`Unknown or disabled identity: ${name}`);
    return identity;
  }

  private requireRecord(name: string): OwnedAgentRecord {
    const record = this.records.get(name);
    if (!record) throw new Error(`Unknown owned agent: ${name}`);
    return record;
  }

  private requireLiveRecord(name: string): OwnedAgentRecord {
    const record = this.requireRecord(name);
    if (!record.paneId || record.status === "closed") throw new Error(`Owned agent ${name} is closed.`);
    return record;
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error("The parent session is shutting down.");
  }

  private persist(): void {
    this.callbacks.persist(this.getRecords());
  }
}

function resolveRuntime(identity: AgentIdentity, defaults: RuntimeSettings, parent: RuntimeSettings): RuntimeSettings {
  return {
    provider: identity.provider ?? defaults.provider ?? parent.provider,
    model: identity.model ?? defaults.model ?? parent.model,
    thinking: identity.thinking ?? defaults.thinking ?? parent.thinking,
    tools: identity.tools ?? defaults.tools ?? [],
    extensions: identity.extensions ?? defaults.extensions ?? [],
    skills: identity.skills ?? defaults.skills ?? [],
  };
}

function handoff(task: string): string {
  return `Complete this assignment for the parent session. Return a concise result when done.\n\n${task.trim()}`;
}

function makeHerdrAgentName(parentToken: string, name: string): string {
  const nameHash = createHash("sha256").update(name).digest("hex").slice(0, 4);
  return `oa-${parentToken}-${name.slice(0, 14)}-${nameHash}`;
}

function validateAgentName(name: string): void {
  if (!/^[a-z][a-z0-9_-]{0,28}$/.test(name)) {
    throw new Error("Agent name must match [a-z][a-z0-9_-]{0,28}.");
  }
}

function truncateResult(text: string, sessionFile: string): string {
  const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!truncated.truncated) return truncated.content;
  return `${truncated.content}\n\n[Result truncated. Full response remains in child session: ${sessionFile}]`;
}

function cloneRecord(record: OwnedAgentRecord): OwnedAgentRecord {
  return { ...record };
}

async function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error("Wait cancelled.");
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Wait cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
