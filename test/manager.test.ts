import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { composeChildSystemPrompt } from "../src/child-prompt.js";
import type { HerdrClient } from "../src/herdr.js";
import { AgentManager } from "../src/manager.js";
import type { ExtensionConfig, HerdrAgent, OwnedAgentCollection, OwnedAgentRecord } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
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

async function childSessionFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-owned-session-"));
  const path = join(root, "child.jsonl");
  await writeFile(path, [
    JSON.stringify({ type: "session", version: 3, id: "child-session", timestamp: new Date().toISOString(), cwd: "/repo" }),
    JSON.stringify({ type: "message", id: "00000001", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "task", timestamp: Date.now() } }),
    JSON.stringify({ type: "message", id: "00000002", parentId: "00000001", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Finished review." }], provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } }),
  ].join("\n") + "\n");
  return path;
}

function testConfig(): ExtensionConfig {
  return {
    maxAgents: 10,
    defaults: {},
    warnings: [],
    identities: [{
      name: "reviewer",
      description: "Reviews code.",
      instructions: "Review the assignment.",
      sourcePath: "/config/agents/reviewer.md",
      tools: ["read"],
    }],
  };
}

class FakeHerdr {
  settled = deferred<HerdrAgent>();
  readonly closed: string[] = [];
  createCalls = 0;
  sessionFile = "";
  activeSessionFile = "";
  currentStatus: "idle" | "working" | "blocked" = "idle";
  interruptWaitError: Error | undefined;
  interruptFailureStatus: "idle" | "working" | "blocked" | undefined;
  waitForTurnOptions: unknown;
  reconciliationGate: Promise<void> | undefined;
  gateReconciliation = false;
  agentName = "";
  startArgs: string[] = [];
  prompts: string[] = [];
  displayAgents: Array<{ paneId: string; name: string }> = [];
  reportFailure: Error | undefined;
  closeFailure: Error | undefined;
  promptGate: Promise<void> | undefined;
  promptStateSequence: number | undefined;
  promptReportedStatus: "idle" | "working" | "blocked" = "idle";
  promptError: Error | undefined;
  promptAcceptedOnError = true;
  ignoreWaitAbort = false;
  waitForTurnGate: Promise<void> | undefined;
  createGate: Promise<void> | undefined;
  getAgentGate: Promise<void> | undefined;
  waitCalls = 0;
  waitForTurnCalls = 0;

  async createTab() {
    this.createCalls += 1;
    if (this.createGate) await this.createGate;
    return { tabId: "w1:t2", paneId: "w1:p2" };
  }
  async waitForShell() {}
  async startPi(name?: string, _pane?: string, args?: string[]) {
    if (name) this.agentName = name;
    this.startArgs = args ?? [];
    const sessionIndex = args?.indexOf("--session") ?? -1;
    if (sessionIndex >= 0) {
      this.activeSessionFile = args![sessionIndex + 1];
      if (this.sessionFile !== this.activeSessionFile) await copyFile(this.sessionFile, this.activeSessionFile);
    }
    return {
      pane_id: "w1:p2",
      tab_id: "w1:t2",
      workspace_id: "w1",
      agent_status: "idle" as const,
      name: this.agentName,
    };
  }
  async reportDisplayAgent(paneId: string, name: string) {
    this.displayAgents.push({ paneId, name });
    if (this.reportFailure) throw this.reportFailure;
  }
  async prompt(_paneId?: string, message?: string) {
    if (message) this.prompts.push(message);
    if (this.promptError && !this.promptAcceptedOnError) throw this.promptError;
    this.currentStatus = "working";
    if (this.promptError) throw this.promptError;
    const gate = this.promptGate;
    this.promptGate = undefined;
    if (gate) await gate;
    return {
      pane_id: "w1:p2",
      tab_id: "w1:t2",
      workspace_id: "w1",
      agent_status: this.promptReportedStatus,
      state_change_seq: this.promptStateSequence,
    };
  }
  async wait(_paneId?: string, signal?: AbortSignal) {
    this.waitCalls += 1;
    return this.ignoreWaitAbort ? this.settled.promise : abortable(this.settled.promise, signal);
  }
  async waitForTurn(_paneId?: string, _baselineSequence?: number, signal?: AbortSignal, options?: unknown) {
    this.waitForTurnCalls += 1;
    this.waitForTurnOptions = options;
    if (this.interruptWaitError) {
      if (this.interruptFailureStatus) this.currentStatus = this.interruptFailureStatus;
      this.gateReconciliation = true;
      throw this.interruptWaitError;
    }
    const gate = this.waitForTurnGate;
    this.waitForTurnGate = undefined;
    if (gate) await abortable(gate, signal);
    this.currentStatus = "idle";
    return { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "idle" as const, state_change_seq: 2 };
  }
  async getAgent() {
    if (this.getAgentGate) await this.getAgentGate;
    if (this.gateReconciliation && this.reconciliationGate) await this.reconciliationGate;
    return { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: this.currentStatus, state_change_seq: 1, name: this.agentName };
  }
  async interrupt() {}
  async closeTab(tabId: string) {
    this.closed.push(tabId);
    if (this.closeFailure) throw this.closeFailure;
  }
}

test("a settled temporary assignment retains its result and closes its tab", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const snapshots: OwnedAgentRecord[][] = [];
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist: (records) => snapshots.push(records) },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review it.", keepOpen: false, cwd: "/repo" });
  assert.equal(fake.prompts[0], "Review it.");
  fake.settled.resolve({
    pane_id: "w1:p2",
    tab_id: "w1:t2",
    workspace_id: "w1",
    agent_status: "done",
    agent_session: { value: fake.activeSessionFile },
  });

  await new Promise((resolve) => setImmediate(resolve));
  const result = manager.getRecords()[0];
  assert.equal(result.lastResult, "Finished review.");
  assert.deepEqual(fake.closed, ["w1:t2"]);
  assert.equal(result.status, "closed");
  assert.ok(snapshots.length > 0);
});
test("a start uses the explicitly selected identity", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const config = testConfig();
  config.identities[0] = {
    ...config.identities[0],
    model: "selected-model",
  };
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    config,
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "parent-model", thinking: "medium" },
    { persist() {} },
  );

  const record = await manager.start({ name: "check", identityName: "reviewer", task: "Check it.", keepOpen: true, cwd: "/repo" });

  assert.equal(record.identity, "reviewer");
  const modelIndex = fake.startArgs.indexOf("--model");
  assert.equal(fake.startArgs[modelIndex + 1], "selected-model");
});

test("a start rejects an unknown selected identity", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "parent-model", thinking: "medium" },
    { persist() {} },
  );

  await assert.rejects(
    manager.start({ name: "check", identityName: "missing", task: "Check it.", keepOpen: true, cwd: "/repo" }),
    /Unknown or disabled identity: missing/,
  );
});

test("a start reloads the identity before spawning the child", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const refreshed = testConfig();
  refreshed.identities[0] = {
    ...refreshed.identities[0],
    instructions: "Use the updated profile.",
    model: "updated-model",
  };
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "parent-model", thinking: "medium" },
    {
      persist() {},
      async reloadConfig() { return refreshed; },
    },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review it.", keepOpen: true, cwd: "/repo" });

  const modelIndex = fake.startArgs.indexOf("--model");
  assert.equal(fake.startArgs[modelIndex + 1], "updated-model");
  const instructionsIndex = fake.startArgs.indexOf("--append-system-prompt");
  assert.equal(await readFile(fake.startArgs[instructionsIndex + 1], "utf8"), composeChildSystemPrompt({ identityInstructions: "Use the updated profile." }));
});

test("a frontmatter-only identity receives no appended child prompt", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const config = testConfig();
  config.identities[0] = { ...config.identities[0], instructions: undefined };
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    config,
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "fast", identityName: "reviewer", task: "Check it.", keepOpen: true, cwd: "/repo" });

  assert.equal(fake.startArgs.includes("--append-system-prompt"), false);
  assert.equal(fake.prompts[0], "Check it.");
});

test("shared instructions precede identity instructions in the child prompt", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const config = testConfig();
  config.instructions = "Follow shared instructions.";
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    config,
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "trial", identityName: "reviewer", task: "Run it.", keepOpen: true, cwd: "/repo" });

  const instructionsIndex = fake.startArgs.indexOf("--append-system-prompt");
  assert.equal(
    await readFile(fake.startArgs[instructionsIndex + 1], "utf8"),
    "Follow shared instructions.\n\nReview the assignment.\n",
  );
});

test("re-reports display metadata when restoring a live child", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  fake.currentStatus = "working";
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.restore([{
    name: "review",
    identity: "reviewer",
    keepOpen: true,
    status: "working",
    paneId: "w1:p2",
    tabId: "w1:t2",
    sessionFile: fake.sessionFile,
    cwd: "/repo",
    assignment: 1,
    lastTask: "Review.",
    updatedAt: Date.now(),
  }]);

  assert.deepEqual(fake.displayAgents, [{ paneId: "w1:p2", name: "review" }]);
  manager.suspend();
});

test("keeps a live child when restore metadata refresh fails and retries without spawning", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  fake.reportFailure = new Error("metadata transport failure");
  const warnings: string[] = [];
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {}, warn: (message) => warnings.push(message) },
  );

  await manager.restore([{
    name: "review",
    identity: "reviewer",
    keepOpen: true,
    status: "idle",
    paneId: "w1:p2",
    tabId: "w1:t2",
    sessionFile: fake.sessionFile,
    cwd: "/repo",
    assignment: 1,
    completedAssignment: 1,
    lastTask: "Review.",
    updatedAt: Date.now(),
  }]);

  assert.equal(manager.getRecords()[0].status, "idle");
  assert.equal(manager.getRecords()[0].paneId, "w1:p2");
  assert.equal(manager.getRecords()[0].tabId, "w1:t2");
  assert.match(warnings[0], /remains live/);

  fake.reportFailure = undefined;
  await manager.send("review", "Continue the review.");
  assert.equal(fake.createCalls, 0);
  assert.deepEqual(fake.displayAgents, [
    { paneId: "w1:p2", name: "review" },
    { paneId: "w1:p2", name: "review" },
  ]);
  manager.suspend();
});

test("re-reports display metadata before reusing a failed child", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  fake.reportFailure = new Error("metadata transport failure");
  fake.closeFailure = new Error("tab close failure");
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await assert.rejects(
    manager.start({ name: "review", identityName: "reviewer", task: "Review it.", keepOpen: true, cwd: "/repo" }),
    /metadata transport failure/,
  );
  fake.reportFailure = undefined;
  fake.closeFailure = undefined;
  await manager.send("review", "Continue the review.");

  assert.deepEqual(fake.displayAgents, [
    { paneId: "w1:p2", name: "review" },
    { paneId: "w1:p2", name: "review" },
  ]);
  manager.suspend();
});

test("publishes the caller name as display metadata on start and reopen", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review it.", keepOpen: true, cwd: "/repo" });
  await manager.close("review");
  await manager.send("review", "Resume the review.");

  assert.deepEqual(fake.displayAgents, [
    { paneId: "w1:p2", name: "review" },
    { paneId: "w1:p2", name: "review" },
  ]);
  assert.equal(fake.agentName, "oa-parent-review-c97a");
});

test("send steers active work without replacing its assignment or close behavior", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: false, cwd: "/repo" });
  fake.promptReportedStatus = "working";
  const steered = await manager.send("review", "Focus on lifecycle races.");

  assert.equal(steered.assignment, 1);
  assert.equal(steered.status, "working");
  assert.deepEqual(fake.prompts, ["Review.", "Focus on lifecycle races."]);
  assert.equal(fake.waitCalls, 2);
  assert.equal(fake.waitForTurnCalls, 0);
  assert.deepEqual(fake.closed, []);

  fake.settled.resolve({
    pane_id: "w1:p2",
    tab_id: "w1:t2",
    workspace_id: "w1",
    agent_status: "done",
    agent_session: { value: fake.activeSessionFile },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const result = manager.getRecords()[0];
  assert.equal(result.assignment, 1);
  assert.equal(result.lastResult, "Finished review.");
  assert.deepEqual(fake.closed, ["w1:t2"]);
});

test("send keeps settlement paused until racing guidance has a completion watcher", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: true, cwd: "/repo" });
  const promptGate = deferred<void>();
  const continuation = deferred<void>();
  fake.promptGate = promptGate.promise;
  fake.promptStateSequence = 1;
  fake.waitForTurnGate = continuation.promise;

  const sending = manager.send("review", "Include the late guidance.");
  await new Promise((resolve) => setImmediate(resolve));
  fake.settled.resolve({
    pane_id: "w1:p2",
    tab_id: "w1:t2",
    workspace_id: "w1",
    agent_status: "done",
    agent_session: { value: fake.activeSessionFile },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getRecords()[0].status, "working");

  promptGate.resolve();
  const sent = await sending;
  assert.equal(sent.assignment, 1);
  assert.equal(manager.getRecords()[0].status, "working");

  continuation.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getRecords()[0].completedAssignment, 1);
});

test("send fences a watcher whose Herdr wait resolved just before steering", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  fake.ignoreWaitAbort = true;
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: false, cwd: "/repo" });
  const continuation = deferred<void>();
  fake.promptStateSequence = 1;
  fake.waitForTurnGate = continuation.promise;
  fake.settled.resolve({ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "done" });

  const sent = await manager.send("review", "Late guidance.");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.assignment, 1);
  assert.equal(manager.getRecords()[0].status, "working");
  assert.deepEqual(fake.closed, []);

  continuation.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.closed, ["w1:t2"]);
});

test("send serializes messages and excludes interrupt and close while submitting", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: true, cwd: "/repo" });
  const gate = deferred<void>();
  fake.promptGate = gate.promise;
  const first = manager.send("review", "First guidance.");
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(manager.send("review", "Second guidance."), /already receiving a message/);
  await assert.rejects(manager.interrupt("review"), /receiving a message/);
  await assert.rejects(manager.close("review"), /receiving a message/);

  gate.resolve();
  const sent = await first;
  assert.equal(sent.assignment, 1);
});

test("shutdown prevents an in-flight send from installing a new watcher", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: true, cwd: "/repo" });
  const gate = deferred<void>();
  fake.promptGate = gate.promise;
  const sending = manager.send("review", "Guidance during shutdown.");
  await new Promise((resolve) => setImmediate(resolve));
  const shuttingDown = manager.shutdown();
  await new Promise((resolve) => setImmediate(resolve));

  gate.resolve();
  await assert.rejects(sending, /parent session is shutting down/);
  await shuttingDown;
  assert.equal(manager.getRecords()[0].status, "interrupted");
});

test("shutdown prevents new-assignment failure recovery from installing a watcher", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: true, cwd: "/repo" });
  fake.settled.resolve({ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "done" });
  await new Promise((resolve) => setImmediate(resolve));
  fake.currentStatus = "idle";
  fake.settled = deferred<HerdrAgent>();

  const gate = deferred<void>();
  fake.promptGate = gate.promise;
  const sending = manager.send("review", "New work during shutdown.");
  await new Promise((resolve) => setImmediate(resolve));
  const shuttingDown = manager.shutdown();
  await new Promise((resolve) => setImmediate(resolve));

  gate.resolve();
  await assert.rejects(sending, /parent session is shutting down/);
  await shuttingDown;
  assert.equal(manager.getRecords()[0].status, "interrupted");
  assert.equal(manager.getRecords()[0].paneId, undefined);
});

test("batch registration rejects the gap while a new assignment is being submitted", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: true, cwd: "/repo" });
  fake.settled.resolve({ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "done" });
  await new Promise((resolve) => setImmediate(resolve));
  fake.currentStatus = "idle";
  fake.settled = deferred<HerdrAgent>();

  const gate = deferred<void>();
  fake.promptGate = gate.promise;
  const sending = manager.send("review", "Next assignment.");
  await new Promise((resolve) => setImmediate(resolve));

  assert.throws(() => manager.batch(manager.getRecords()), /receiving a new assignment/);

  gate.resolve();
  const sent = await sending;
  assert.equal(sent.assignment, 2);
  fake.settled.resolve({ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "done" });
});

test("batch registration rejects an old assignment while a closed agent is reopening", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );
  await manager.restore([{
    name: "review",
    identity: "reviewer",
    keepOpen: true,
    status: "closed",
    sessionFile: fake.sessionFile,
    cwd: "/repo",
    assignment: 1,
    completedAssignment: 1,
    lastTask: "Previous.",
    updatedAt: Date.now(),
  }]);
  const gate = deferred<void>();
  fake.createGate = gate.promise;

  const sending = manager.send("review", "Resume with new work.");
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => manager.batch(manager.getRecords()), /receiving a new assignment/);

  gate.resolve();
  const sent = await sending;
  assert.equal(sent.assignment, 2);
});

test("automatic close reserves the agent against a racing send", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: false, cwd: "/repo" });
  const closeGate = deferred<void>();
  fake.getAgentGate = closeGate.promise;
  fake.settled.resolve({ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "done" });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(manager.send("review", "Too late."), /is closing/);
  closeGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getRecords()[0].status, "closed");
});

test("explicit close reserves the agent against a racing send", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: true, cwd: "/repo" });
  const closeGate = deferred<void>();
  fake.getAgentGate = closeGate.promise;
  const closing = manager.close("review");
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(manager.send("review", "Do not race close."), /is closing/);
  closeGate.resolve();
  await closing;
});

test("new assignment prompt failures remain tracked until their acceptance is reconciled", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: true, cwd: "/repo" });
  fake.settled.resolve({ pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "done" });
  await new Promise((resolve) => setImmediate(resolve));
  fake.currentStatus = "idle";
  fake.settled = deferred<HerdrAgent>();

  const firstReconciliation = deferred<void>();
  fake.waitForTurnGate = firstReconciliation.promise;
  fake.promptError = new Error("pre-dispatch failure");
  fake.promptAcceptedOnError = false;
  await assert.rejects(manager.send("review", "Not confirmed."), /pre-dispatch failure/);
  assert.equal(manager.getRecords()[0].assignment, 2);
  assert.equal(manager.getRecords()[0].status, "working");

  fake.promptError = undefined;
  firstReconciliation.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getRecords()[0].completedAssignment, 2);

  fake.currentStatus = "idle";
  const secondReconciliation = deferred<void>();
  fake.waitForTurnGate = secondReconciliation.promise;
  fake.promptError = new Error("response lost after acceptance");
  fake.promptAcceptedOnError = true;
  await assert.rejects(manager.send("review", "Possibly accepted."), /response lost after acceptance/);
  assert.equal(manager.getRecords()[0].assignment, 3);
  assert.equal(manager.getRecords()[0].status, "working");

  fake.promptError = undefined;
  secondReconciliation.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getRecords()[0].completedAssignment, 3);
});

test("interrupt settles the assignment without closing and permits a follow-up", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: false, cwd: "/repo" });
  const interrupted = await manager.interrupt("review");
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.paneId, "w1:p2");
  assert.equal(interrupted.tabId, "w1:t2");
  assert.equal(interrupted.sessionFile, fake.activeSessionFile);
  assert.deepEqual(fake.waitForTurnOptions, {
    settleTimeoutMs: 5_000,
    acceptSettledStatusWithoutSequence: true,
  });
  assert.deepEqual(fake.closed, []);

  const followUp = await manager.send("review", "Continue differently.");
  assert.equal(followUp.assignment, 2);
  assert.equal(followUp.status, "working");
  assert.deepEqual(fake.closed, []);
});

test("a failed interrupt retains the active assignment for steering", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: true, cwd: "/repo" });
  fake.interruptWaitError = new Error("interrupt timeout");
  await assert.rejects(manager.interrupt("review"), /interrupt timeout/);
  const steered = await manager.send("review", "Continue without interrupting.");
  assert.equal(steered.assignment, 1);
  assert.equal(steered.status, "working");
});

test("a failed interrupt preserves a blocked agent's usable state", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  fake.currentStatus = "blocked";
  fake.interruptWaitError = new Error("interrupt timeout");
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );
  await manager.restore([{
    name: "review",
    identity: "reviewer",
    keepOpen: true,
    status: "blocked",
    paneId: "w1:p2",
    tabId: "w1:t2",
    sessionFile: fake.sessionFile,
    cwd: "/repo",
    assignment: 1,
    completedAssignment: 1,
    lastTask: "Previous.",
    lastResult: "Agent review is blocked and needs input.",
    updatedAt: Date.now(),
  }]);

  await assert.rejects(manager.interrupt("review"), /interrupt timeout/);
  assert.equal(manager.getRecords()[0].status, "blocked");
  const followUp = await manager.send("review", "Answer the blocker.");
  assert.equal(followUp.status, "working");
});

test("interrupt reconciliation reserves a blocked agent until it finishes", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  fake.currentStatus = "blocked";
  fake.interruptWaitError = new Error("interrupt timeout");
  const gate = deferred<void>();
  fake.reconciliationGate = gate.promise;
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );
  await manager.restore([{
    name: "review",
    identity: "reviewer",
    keepOpen: true,
    status: "blocked",
    paneId: "w1:p2",
    tabId: "w1:t2",
    sessionFile: fake.sessionFile,
    cwd: "/repo",
    assignment: 1,
    completedAssignment: 1,
    lastTask: "Previous.",
    updatedAt: Date.now(),
  }]);

  const interrupting = manager.interrupt("review");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(manager.send("review", "Do not race reconciliation."), /being interrupted/);
  gate.resolve();
  await assert.rejects(interrupting, /interrupt timeout/);
  const followUp = await manager.send("review", "Continue after reconciliation.");
  assert.equal(followUp.assignment, 2);
  assert.equal(followUp.status, "working");
});

test("failed interrupt reconciliation follows the current child state", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  fake.currentStatus = "blocked";
  fake.interruptWaitError = new Error("interrupt transport failure");
  fake.interruptFailureStatus = "working";
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );
  await manager.restore([{
    name: "review",
    identity: "reviewer",
    keepOpen: true,
    status: "blocked",
    paneId: "w1:p2",
    tabId: "w1:t2",
    sessionFile: fake.sessionFile,
    cwd: "/repo",
    assignment: 1,
    completedAssignment: 1,
    lastTask: "Previous.",
    updatedAt: Date.now(),
  }]);

  await assert.rejects(manager.interrupt("review"), /transport failure/);
  assert.equal(manager.getRecords()[0].status, "working");
  const steered = await manager.send("review", "Continue after reconciliation.");
  assert.equal(steered.assignment, 1);
});

test("parallel reopens reserve names and capacity before tab creation", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const config = testConfig();
  config.maxAgents = 1;
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    config,
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );
  const base = {
    identity: "reviewer",
    keepOpen: true,
    status: "closed" as const,
    sessionFile: fake.sessionFile,
    cwd: "/repo",
    assignment: 1,
    lastTask: "Previous.",
    updatedAt: Date.now(),
  };
  await manager.restore([
    { ...base, name: "first" },
    { ...base, name: "second" },
  ]);

  const first = manager.send("first", "Resume first.");
  const second = manager.send("second", "Resume second.");
  await assert.rejects(second, /Live agent limit reached/);
  await first;
  assert.equal(fake.createCalls, 1);

  await manager.close("first");
  const sameFirst = manager.send("first", "Resume once.");
  const sameSecond = manager.send("first", "Resume twice.");
  await assert.rejects(sameSecond, /already receiving a message/);
  await sameFirst;
  assert.equal(fake.createCalls, 2);
});

test("close refuses a pane that no longer hosts the recorded owned agent", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );
  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: true, cwd: "/repo" });
  fake.agentName = "unrelated-agent";
  await assert.rejects(manager.close("review"), /does not host owned agent/);
  assert.deepEqual(fake.closed, []);
  assert.equal(manager.getRecords()[0].status, "failed");
});

test("parallel starts reserve names and capacity before asynchronous tab creation", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const config = testConfig();
  config.maxAgents = 1;
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    config,
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {} },
  );

  const first = manager.start({ name: "first", identityName: "reviewer", task: "First.", keepOpen: true, cwd: "/repo" });
  const second = manager.start({ name: "second", identityName: "reviewer", task: "Second.", keepOpen: true, cwd: "/repo" });
  await assert.rejects(second, /Live agent limit reached/);
  await first;
  assert.equal(fake.createCalls, 1);

  const duplicate = manager.start({ name: "first", identityName: "reviewer", task: "Duplicate.", keepOpen: true, cwd: "/repo" });
  await assert.rejects(duplicate, /already belongs/);
  assert.equal(fake.createCalls, 1);
});

class MultiAgentHerdr {
  readonly turns = new Map<string, ReturnType<typeof deferred<HerdrAgent>>>();
  readonly failGetOnce = new Set<string>();

  add(paneId: string): void {
    this.turns.set(paneId, deferred<HerdrAgent>());
  }

  async getAgent(paneId: string) {
    if (this.failGetOnce.delete(paneId)) throw new Error("temporary transport failure");
    return { pane_id: paneId, tab_id: `tab-${paneId}`, workspace_id: "w1", agent_status: "working" as const };
  }

  async reportDisplayAgent() {}

  async wait(paneId: string) {
    return this.turns.get(paneId)!.promise;
  }

  settle(paneId: string, status: "done" | "blocked" = "done"): void {
    this.turns.get(paneId)!.resolve({
      pane_id: paneId,
      tab_id: `tab-${paneId}`,
      workspace_id: "w1",
      agent_status: status,
    });
  }
}

function ownedRecord(options: {
  name: string;
  status: OwnedAgentRecord["status"];
  sessionFile?: string;
  paneId?: string;
  result?: string;
}): OwnedAgentRecord {
  return {
    name: options.name,
    identity: "reviewer",
    keepOpen: true,
    status: options.status,
    paneId: options.paneId,
    tabId: options.paneId ? `tab-${options.paneId}` : undefined,
    sessionFile: options.sessionFile,
    cwd: "/repo",
    assignment: 1,
    completedAssignment: options.status === "working" ? undefined : 1,
    lastTask: "Review.",
    lastResult: options.result,
    updatedAt: Date.now(),
  };
}

function collectionManager(
  fake: MultiAgentHerdr,
  callbacks: {
    persist?(records: OwnedAgentRecord[], collections: OwnedAgentCollection[]): void;
    notifyCollection?(collection: OwnedAgentCollection): void;
  } = {},
): AgentManager {
  return new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    "/tmp",
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    {
      persist: callbacks.persist ?? (() => undefined),
      notifyCollection: callbacks.notifyCollection,
    },
  );
}

test("a batch includes already-settled mixed outcomes in one notification", async () => {
  const fake = new MultiAgentHerdr();
  const completed: OwnedAgentCollection[] = [];
  const manager = collectionManager(fake, {
    notifyCollection: (collection) => completed.push(collection),
  });
  const records = [
    ownedRecord({ name: "ok", status: "idle", result: "Done." }),
    ownedRecord({ name: "blocked", status: "blocked", result: "Needs input." }),
    ownedRecord({ name: "failed", status: "failed", result: "Failed." }),
    ownedRecord({ name: "stopped", status: "interrupted", result: "Interrupted." }),
  ];
  await manager.restore(records);

  const collection = manager.batch(records);

  assert.equal(collection.notified, true);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].members.map((member) => member.result?.status), ["idle", "blocked", "failed", "interrupted"]);
});

test("a batch emits one notification after every member completes", async () => {
  const fake = new MultiAgentHerdr();
  const firstFile = await childSessionFile();
  const secondFile = await childSessionFile();
  fake.add("p1");
  fake.add("p2");
  const completed: OwnedAgentCollection[] = [];
  const manager = collectionManager(fake, {
    notifyCollection: (collection) => completed.push(collection),
  });
  await manager.restore([
    ownedRecord({ name: "first", status: "working", paneId: "p1", sessionFile: firstFile }),
    ownedRecord({ name: "second", status: "working", paneId: "p2", sessionFile: secondFile }),
  ]);
  manager.batch(manager.getRecords());

  fake.settle("p1");
  fake.settle("p2");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].members.map((member) => member.result?.lastResult), ["Finished review.", "Finished review."]);
});

test("a transient restore inspection failure does not complete a pending collection", async () => {
  const fake = new MultiAgentHerdr();
  const sessionFile = await childSessionFile();
  fake.add("p1");
  fake.failGetOnce.add("p1");
  const completed: OwnedAgentCollection[] = [];
  const manager = collectionManager(fake, {
    notifyCollection: (collection) => completed.push(collection),
  });
  const collection: OwnedAgentCollection = {
    id: "c-reload",
    members: [{ name: "review", assignment: 1 }],
    createdAt: Date.now(),
    notified: false,
  };

  await manager.restore(
    [ownedRecord({ name: "review", status: "working", paneId: "p1", sessionFile })],
    [collection],
  );
  assert.equal(completed.length, 0);
  assert.equal(manager.getRecords()[0].status, "working");

  fake.settle("p1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].members[0].result?.lastResult, "Finished review.");
});

test("a pending collection survives manager reload and notifies after settlement", async () => {
  const firstFake = new MultiAgentHerdr();
  const sessionFile = await childSessionFile();
  firstFake.add("p1");
  let recordsSnapshot: OwnedAgentRecord[] = [];
  let collectionsSnapshot: OwnedAgentCollection[] = [];
  const firstManager = collectionManager(firstFake, {
    persist: (records, collections) => {
      recordsSnapshot = records;
      collectionsSnapshot = collections;
    },
  });
  await firstManager.restore([ownedRecord({ name: "review", status: "working", paneId: "p1", sessionFile })]);
  firstManager.batch(firstManager.getRecords());
  firstManager.suspend();

  const secondFake = new MultiAgentHerdr();
  secondFake.add("p1");
  const completed: OwnedAgentCollection[] = [];
  const secondManager = collectionManager(secondFake, {
    notifyCollection: (collection) => completed.push(collection),
  });
  await secondManager.restore(recordsSnapshot, collectionsSnapshot);
  secondFake.settle("p1");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(completed.length, 1);
  assert.equal(completed[0].members[0].result?.lastResult, "Finished review.");
});
