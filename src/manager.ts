import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type { AgentIdentity, ExtensionConfig, OwnedAgentCollection, OwnedAgentRecord, RuntimeSettings } from "./types.js";
import { composeChildSystemPrompt } from "./child-prompt.js";
import { buildPiArgs, HerdrClient } from "./herdr.js";
import { readLatestAssistantResult } from "./session-result.js";

const INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;

interface TurnState {
  assignment: number;
  claims: Set<string>;
  generation: number;
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
  persist(records: OwnedAgentRecord[], collections: OwnedAgentCollection[]): void;
  notify(record: OwnedAgentRecord): void;
  notifyCollection?(collection: OwnedAgentCollection): void;
  claimNotification?(record: OwnedAgentRecord): void;
  releaseNotification?(record: OwnedAgentRecord): void;
  changed?(): void;
  reloadConfig?(): Promise<ExtensionConfig>;
  resolveRuntime?(identity: AgentIdentity, cwd: string, defaults: RuntimeSettings): Promise<RuntimeSettings>;
  warn?(message: string): void;
}

export class AgentManager {
  private readonly records = new Map<string, OwnedAgentRecord>();
  private readonly turns = new Map<string, TurnState>();
  private readonly collections = new Map<string, OwnedAgentCollection>();
  private readonly interruptions = new Set<string>();
  private readonly sends = new Set<string>();
  private readonly closures = new Set<string>();
  private stopped = false;

  constructor(
    private readonly herdr: HerdrClient,
    private config: ExtensionConfig,
    private readonly workspaceId: string,
    private readonly sessionDir: string,
    private readonly parentToken: string,
    private readonly parentSettings: RuntimeSettings & { model: string; thinking: NonNullable<RuntimeSettings["thinking"]> },
    private readonly callbacks: ManagerCallbacks,
  ) {}

  getRecords(): OwnedAgentRecord[] {
    return [...this.records.values()].sort((left, right) => left.updatedAt - right.updatedAt).map(cloneRecord);
  }

  getCollections(): OwnedAgentCollection[] {
    return [...this.collections.values()].map(cloneCollection);
  }

  getClaimedNames(): string[] {
    return [...this.turns.entries()]
      .filter(([, turn]) => turn.claims.size > 0)
      .map(([name]) => name)
      .sort();
  }

  async restore(records: OwnedAgentRecord[], collections: OwnedAgentCollection[] = []): Promise<void> {
    for (const collection of collections) this.collections.set(collection.id, cloneCollection(collection));
    for (const record of records) this.records.set(record.name, cloneRecord(record));
    for (const record of this.records.values()) {
      if (!record.paneId || record.status === "closed") continue;
      try {
        const agent = await this.herdr.getAgent(record.paneId);
        if (record.sessionFile && agent.agent_session?.value && agent.agent_session.value !== record.sessionFile) {
          record.status = "failed";
          record.lastError = "The recorded pane now hosts a different Pi session.";
          record.lastResult = record.lastError;
          record.completedAssignment = record.assignment;
          record.paneId = undefined;
          record.tabId = undefined;
          record.updatedAt = Date.now();
          this.finishSettledRecord(record);
          continue;
        }
        record.tabId = agent.tab_id;
        try {
          await this.herdr.reportDisplayAgent(agent.pane_id, record.name);
        } catch (error) {
          record.lastError = `Could not refresh owned agent metadata during restore: ${(error as Error).message}`;
          record.updatedAt = Date.now();
          this.callbacks.warn?.(`Owned agent ${record.name} remains live, but its Herdr metadata could not be refreshed: ${(error as Error).message}`);
        }
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
      } catch (error) {
        if (this.isPendingCollection(record.name, record.assignment)) {
          record.status = "working";
          record.lastError = `Could not inspect the collected assignment during restore: ${(error as Error).message}`;
          record.updatedAt = Date.now();
          this.watch(record);
        } else {
          record.status = "closed";
          record.paneId = undefined;
          record.tabId = undefined;
          record.updatedAt = Date.now();
        }
      }
    }
    this.completeCollections();
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
    await this.reloadConfig();
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
      await this.herdr.reportDisplayAgent(agent.pane_id, options.name, signal);

      const prompted = await this.herdr.prompt(record.paneId, options.task.trim(), signal);
      record.status = "working";
      record.updatedAt = Date.now();
      this.persist();
      this.watchAfterPrompt(record, prompted);
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
    const text = message.trim();
    if (!text) throw new Error("Message must not be empty.");
    if (this.sends.has(name)) throw new Error(`Agent ${name} is already receiving a message.`);
    if (this.closures.has(name)) throw new Error(`Agent ${name} is closing.`);
    this.sends.add(name);
    const activeTurn = this.turns.get(name);
    let restoreActiveWatch = Boolean(activeTurn);
    let activeBaselineSequence: number | undefined;
    if (activeTurn) this.pauseTurn(activeTurn);

    try {
      let metadataReported = false;
      if (record.status === "failed" && record.paneId) {
        await this.reconcileFailedRecord(record, signal);
        metadataReported = true;
      }
      if (!metadataReported && record.paneId && record.status !== "closed" && record.status !== "starting") {
        await this.herdr.reportDisplayAgent(record.paneId, record.name, signal);
      }
      this.assertRunning();
      if (this.closures.has(name)) throw new Error(`Agent ${name} is closing.`);
      if (record.status === "closed" || !record.paneId) {
        await this.reloadConfig();
        await this.reopen(record, signal);
      }
      this.assertRunning();
      if (this.interruptions.has(name)) {
        throw new Error(`Agent ${name} is being interrupted. Wait for the interrupt operation to finish.`);
      }

      if (activeTurn) {
        if (this.turns.get(name) !== activeTurn || activeTurn.assignment !== record.assignment) {
          throw new Error(`Agent ${name} has inconsistent active assignment tracking.`);
        }
        const baseline = await this.herdr.getAgent(record.paneId!, signal);
        activeBaselineSequence = baseline.state_change_seq;
        this.assertRunning();
        const prompted = await this.herdr.prompt(record.paneId!, text, signal);
        this.assertRunning();
        record.status = "working";
        record.updatedAt = Date.now();
        this.persist();
        this.watchAfterPrompt(record, prompted, activeTurn);
        restoreActiveWatch = false;
        return cloneRecord(record);
      }
      if (record.status === "working") {
        throw new Error(`Agent ${name} is working without a tracked assignment.`);
      }

      const baseline = await this.herdr.getAgent(record.paneId!, signal);
      this.assertRunning();
      record.assignment += 1;
      record.lastTask = text;
      record.lastResult = undefined;
      record.lastError = undefined;
      record.status = "working";
      record.updatedAt = Date.now();
      this.persist();
      try {
        const prompted = await this.herdr.prompt(record.paneId!, text, signal);
        this.assertRunning();
        this.watchAfterPrompt(record, prompted);
      } catch (error) {
        this.reconcileNewAssignmentPromptFailure(record, baseline.state_change_seq, error);
        throw error;
      }
      return cloneRecord(record);
    } catch (error) {
      if (activeTurn && restoreActiveWatch && !this.stopped && this.turns.get(name) === activeTurn) {
        this.watch(record, activeBaselineSequence, activeTurn);
      }
      throw error;
    } finally {
      this.sends.delete(name);
    }
  }

  collect(names: string[]): OwnedAgentCollection {
    this.assertRunning();
    if (names.length === 0) throw new Error("At least one agent name is required.");
    if (new Set(names).size !== names.length) throw new Error("Agent names must be unique.");

    const records = names.map((name) => this.requireRecord(name));
    for (const record of records) {
      const isSettled = record.completedAssignment === record.assignment;
      const turn = this.turns.get(record.name);
      if (this.sends.has(record.name) && !turn) {
        throw new Error(`Owned agent ${record.name} is receiving a new assignment.`);
      }
      if (!isSettled && (!turn || turn.assignment !== record.assignment)) {
        throw new Error(`Owned agent ${record.name} has no active or completed current assignment to collect.`);
      }
      if (this.isPendingCollection(record.name, record.assignment)) {
        throw new Error(`Assignment ${record.assignment} for owned agent ${record.name} is already in a pending collection.`);
      }
    }

    const collection: OwnedAgentCollection = {
      id: `c-${randomUUID().slice(0, 8)}`,
      members: records.map((record) => ({
        name: record.name,
        assignment: record.assignment,
        result: record.completedAssignment === record.assignment ? cloneRecord(record) : undefined,
      })),
      createdAt: Date.now(),
      notified: false,
    };
    this.collections.set(collection.id, collection);
    for (const record of records) {
      this.callbacks.claimNotification?.(cloneRecord(record));
      this.turns.get(record.name)?.claims.add(collectionClaim(collection.id));
    }
    this.persist();
    this.completeCollections();
    this.callbacks.changed?.();
    return cloneCollection(collection);
  }

  async wait(
    names?: string[],
    signal?: AbortSignal,
    onProgress?: (progress: WaitProgress) => void,
  ): Promise<OwnedAgentRecord[]> {
    const selected = names?.length ? names.map((name) => this.requireRecord(name)) : [...this.records.values()].filter((record) => record.status === "working");
    const selections = selected.map((record) => ({ record, turn: this.turns.get(record.name) }));
    for (const { record, turn } of selections) {
      if (this.sends.has(record.name) && !turn) {
        throw new Error(`Owned agent ${record.name} is receiving a new assignment.`);
      }
    }
    const completed = new Set(selections.filter(({ turn }) => !turn).map(({ record }) => record.name));
    const reportProgress = () => onProgress?.({
      selected: selections.map(({ record }) => record.name),
      completed: selections.map(({ record }) => record.name).filter((name) => completed.has(name)),
      waiting: selections.map(({ record }) => record.name).filter((name) => !completed.has(name)),
    });
    const claim = `wait:${randomUUID()}`;
    for (const selection of selections) {
      this.callbacks.claimNotification?.(cloneRecord(selection.record));
      if (selection.turn) selection.turn.claims.add(claim);
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
        if (!turn) {
          if (!this.isCollected(record.name, record.assignment)) this.callbacks.releaseNotification?.(cloneRecord(record));
        } else if (this.turns.get(record.name) === turn) {
          turn.claims.delete(claim);
        } else if (record.completedAssignment === turn.assignment && record.notifiedAssignment !== turn.assignment && !this.isCollected(record.name, turn.assignment)) {
          this.persistAndNotify(record, false);
        }
      }
      this.callbacks.changed?.();
      throw error;
    }
  }

  async interrupt(name: string, signal?: AbortSignal): Promise<OwnedAgentRecord> {
    this.assertRunning();
    const record = this.requireLiveRecord(name);
    if (this.sends.has(name)) throw new Error(`Owned agent ${name} is receiving a message.`);
    if (this.closures.has(name)) throw new Error(`Owned agent ${name} is closing.`);
    if (this.interruptions.has(name)) throw new Error(`Owned agent ${name} is already being interrupted.`);
    const assignment = record.assignment;
    const paneId = record.paneId!;
    const turn = this.turns.get(name);
    let restoreTurn = Boolean(turn);
    this.interruptions.add(name);
    if (turn) this.pauseTurn(turn);

    try {
      const baseline = await this.herdr.getAgent(paneId, signal);
      if (baseline.agent_status !== "working" && baseline.agent_status !== "blocked" && baseline.agent_status !== "unknown") {
        throw new Error(`Owned agent ${name} is not currently working or blocked.`);
      }
      try {
        await this.herdr.interrupt(paneId, signal);
        await this.herdr.waitForTurn(paneId, baseline.state_change_seq ?? 0, signal, {
          settleTimeoutMs: INTERRUPT_SETTLE_TIMEOUT_MS,
          acceptSettledStatusWithoutSequence: true,
        });
        if (record.assignment !== assignment || record.paneId !== paneId) {
          throw new Error(`Owned agent ${name} changed assignments while the interrupt was settling.`);
        }
        this.turns.delete(name);
        restoreTurn = false;
        record.status = "interrupted";
        record.lastResult = `Assignment ${assignment} was interrupted.`;
        record.lastError = undefined;
        record.completedAssignment = assignment;
        record.notifiedAssignment = assignment;
        record.updatedAt = Date.now();
        this.captureCollectionResults(record);
        this.persist();
        this.completeCollections();
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
          if (!this.stopped) {
            this.watch(record, undefined, turn);
            restoreTurn = false;
          }
        }
        throw error;
      }
    } finally {
      if (turn && restoreTurn && !this.stopped && this.turns.get(name) === turn) {
        this.watch(record, undefined, turn);
      }
      this.interruptions.delete(name);
    }
  }

  async close(name: string): Promise<OwnedAgentRecord> {
    const record = this.requireRecord(name);
    if (this.sends.has(name)) throw new Error(`Owned agent ${name} is receiving a message.`);
    if (this.interruptions.has(name)) throw new Error(`Owned agent ${name} is being interrupted.`);
    if (this.closures.has(name)) throw new Error(`Owned agent ${name} is already closing.`);
    if (record.status === "starting") throw new Error(`Owned agent ${name} is still starting or reopening.`);
    this.closures.add(name);
    try {
      await this.closeRecord(record, record.status === "working" ? "interrupted" : "closed");
      return cloneRecord(record);
    } finally {
      this.closures.delete(name);
    }
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

  private reconcileNewAssignmentPromptFailure(
    record: OwnedAgentRecord,
    baselineSequence: number | undefined,
    promptError: unknown,
  ): void {
    if (this.stopped) return;
    record.status = "working";
    record.lastError = `Message submission failed after the child may have accepted it: ${(promptError as Error).message}`;
    record.updatedAt = Date.now();
    this.persist();
    this.watch(record, baselineSequence);
  }

  private async reconcileFailedRecord(record: OwnedAgentRecord, signal?: AbortSignal): Promise<void> {
    let agent;
    try {
      agent = await this.herdr.getAgent(record.paneId!, signal);
    } catch (error) {
      throw new Error(`Could not verify failed owned agent ${record.name}; retry later: ${(error as Error).message}`);
    }
    if (record.sessionFile && agent.agent_session?.value && agent.agent_session.value !== record.sessionFile) {
      throw new Error(`Refused to reuse pane ${record.paneId} because it hosts a different Pi session.`);
    }
    record.tabId = agent.tab_id;
    await this.herdr.reportDisplayAgent(agent.pane_id, record.name, signal);
    if (agent.agent_status === "working" || agent.agent_status === "unknown") {
      record.status = "working";
      record.completedAssignment = undefined;
      record.lastResult = undefined;
      record.updatedAt = Date.now();
      this.persist();
      this.watch(record);
      throw new Error(`Owned agent ${record.name} is still working on assignment ${record.assignment}.`);
    }
    if (agent.agent_status === "blocked") {
      await this.settleBlocked(record);
      throw new Error(`Owned agent ${record.name} is blocked and needs input.`);
    }
    record.status = "idle";
    record.updatedAt = Date.now();
    this.persist();
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
      await this.herdr.reportDisplayAgent(agent.pane_id, record.name, signal);
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

  private async writeInstructions(identity: AgentIdentity): Promise<string> {
    const promptDir = join(this.sessionDir, "prompts");
    await mkdir(promptDir, { recursive: true });
    const path = join(promptDir, `${identity.name}.md`);
    await writeFile(path, composeChildSystemPrompt(identity.instructions), { encoding: "utf8", mode: 0o600 });
    return path;
  }

  private runtimeSettings(identity: AgentIdentity, cwd: string): Promise<RuntimeSettings> {
    if (this.callbacks.resolveRuntime) return this.callbacks.resolveRuntime(identity, cwd, this.config.defaults);
    return Promise.resolve(resolveRuntime(identity, this.config.defaults, this.parentSettings));
  }

  private async reloadConfig(): Promise<void> {
    if (this.callbacks.reloadConfig) this.config = await this.callbacks.reloadConfig();
  }

  private watchAfterPrompt(record: OwnedAgentRecord, prompted: { agent_status?: string; state_change_seq?: number }, turn?: TurnState): void {
    const stillWorking = prompted.agent_status === "working" || prompted.agent_status === "unknown";
    this.watch(record, stillWorking ? undefined : prompted.state_change_seq, turn);
  }

  private pauseTurn(turn: TurnState): void {
    turn.generation += 1;
    turn.controller.abort();
  }

  private watch(record: OwnedAgentRecord, baselineSequence?: number, existingTurn?: TurnState): void {
    const oldTurn = this.turns.get(record.name);
    if (oldTurn && oldTurn !== existingTurn) this.pauseTurn(oldTurn);
    const controller = new AbortController();
    let turn = existingTurn;
    if (turn) {
      turn.controller.abort();
      turn.controller = controller;
    } else {
      let resolve!: (record: OwnedAgentRecord) => void;
      const promise = new Promise<OwnedAgentRecord>((done) => { resolve = done; });
      turn = {
        assignment: record.assignment,
        claims: new Set(this.collectionClaims(record.name, record.assignment)),
        generation: 0,
        controller,
        promise,
        resolve,
      };
    }
    const generation = ++turn.generation;
    this.turns.set(record.name, turn);

    const settled = baselineSequence === undefined
      ? this.herdr.wait(record.paneId!, controller.signal)
      : this.herdr.waitForTurn(record.paneId!, baselineSequence, controller.signal);
    void settled.then(async (agent) => {
      if (this.stopped || this.turns.get(record.name) !== turn || turn.generation !== generation) return;
      if (agent.agent_status === "blocked") await this.settleBlocked(record, turn);
      else await this.settleCompleted(record, turn);
    }).catch((error) => {
      if (controller.signal.aborted || this.stopped || turn.generation !== generation) return;
      record.status = "failed";
      record.lastError = (error as Error).message;
      record.lastResult = `Agent ${record.name} failed: ${record.lastError}`;
      record.completedAssignment = record.assignment;
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
    else this.finishSettledRecord(record);
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
    const shouldClose = !record.keepOpen;
    if (shouldClose) this.closures.add(record.name);
    if (turn) this.finishTurn(record, turn);
    else this.finishSettledRecord(record);

    if (shouldClose) {
      try {
        await this.closeRecord(record, record.status === "failed" ? "failed" : "closed");
      } finally {
        this.closures.delete(record.name);
      }
    }
  }

  private finishTurn(record: OwnedAgentRecord, turn: TurnState): void {
    if (this.turns.get(record.name) !== turn) return;
    this.turns.delete(record.name);
    this.captureCollectionResults(record);
    this.persistAndNotify(record, turn.claims.size > 0);
    this.completeCollections();
    turn.resolve(cloneRecord(record));
  }

  private finishSettledRecord(record: OwnedAgentRecord): void {
    this.captureCollectionResults(record);
    this.persistAndNotify(record, this.isCollected(record.name, record.assignment));
    this.completeCollections();
  }

  private captureCollectionResults(record: OwnedAgentRecord): void {
    if (record.completedAssignment !== record.assignment) return;
    for (const collection of this.collections.values()) {
      if (collection.notified) continue;
      const member = collection.members.find((candidate) => candidate.name === record.name && candidate.assignment === record.assignment);
      if (member && !member.result) member.result = cloneRecord(record);
    }
  }

  private completeCollections(): void {
    for (const collection of this.collections.values()) {
      if (collection.notified || collection.members.some((member) => !member.result)) continue;
      collection.notified = true;
      const notification = cloneCollection(collection);
      for (const member of collection.members) member.result = undefined;
      this.persist();
      this.callbacks.notifyCollection?.(notification);
    }
  }

  private isCollected(name: string, assignment: number): boolean {
    return [...this.collections.values()].some((collection) =>
      collection.members.some((member) => member.name === name && member.assignment === assignment));
  }

  private isPendingCollection(name: string, assignment: number): boolean {
    return [...this.collections.values()].some((collection) => !collection.notified
      && collection.members.some((member) => member.name === name && member.assignment === assignment));
  }

  private collectionClaims(name: string, assignment: number): string[] {
    return [...this.collections.values()]
      .filter((collection) => !collection.notified
        && collection.members.some((member) => member.name === name && member.assignment === assignment))
      .map((collection) => collectionClaim(collection.id));
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
    const turn = this.turns.get(record.name);
    if (turn) this.pauseTurn(turn);
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
        if (turn && !this.stopped && this.turns.get(record.name) === turn) this.watch(record, undefined, turn);
        throw error;
      }
    }
    this.turns.delete(record.name);
    if (record.tabId) {
      try {
        await this.herdr.closeTab(record.tabId);
      } catch (error) {
        record.status = "working";
        record.lastError = `Could not close owned tab ${record.tabId}: ${(error as Error).message}`;
        record.updatedAt = Date.now();
        this.persist();
        if (turn && !this.stopped) this.watch(record, undefined, turn);
        throw error;
      }
    }
    record.status = status;
    record.paneId = undefined;
    record.tabId = undefined;
    record.updatedAt = Date.now();
    this.settleClosedTurn(record, turn);
  }

  private settleClosedTurn(record: OwnedAgentRecord, turn: TurnState | undefined): void {
    if (turn) {
      record.completedAssignment = turn.assignment;
      record.notifiedAssignment = turn.assignment;
      record.lastResult ??= `Assignment ${turn.assignment} was ${record.status}.`;
      this.captureCollectionResults(record);
    }
    this.persist();
    this.completeCollections();
    turn?.resolve(cloneRecord(record));
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
    this.callbacks.persist(this.getRecords(), this.getCollections());
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

function cloneCollection(collection: OwnedAgentCollection): OwnedAgentCollection {
  return {
    ...collection,
    members: collection.members.map((member) => ({
      ...member,
      result: member.result ? cloneRecord(member.result) : undefined,
    })),
  };
}

function collectionClaim(id: string): string {
  return `collection:${id}`;
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
