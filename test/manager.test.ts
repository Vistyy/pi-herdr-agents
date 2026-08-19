import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { composeChildSystemPrompt } from "../src/child-prompt.js";
import type { HerdrClient } from "../src/herdr.js";
import { AgentManager, type WaitProgress } from "../src/manager.js";
import type { ExtensionConfig, HerdrAgent, OwnedAgentCollection, OwnedAgentRecord } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
  readonly settled = deferred<HerdrAgent>();
  readonly closed: string[] = [];
  createCalls = 0;
  sessionFile = "";
  activeSessionFile = "";
  currentStatus: "idle" | "working" | "blocked" = "idle";
  interruptWaitError: Error | undefined;
  interruptFailureStatus: "idle" | "working" | "blocked" | undefined;
  reconciliationGate: Promise<void> | undefined;
  gateReconciliation = false;
  agentName = "";
  startArgs: string[] = [];
  prompts: string[] = [];
  displayAgents: Array<{ paneId: string; name: string }> = [];
  reportFailure: Error | undefined;
  closeFailure: Error | undefined;

  async createTab() {
    this.createCalls += 1;
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
    this.currentStatus = "working";
    return { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "idle" as const };
  }
  async wait() { return this.settled.promise; }
  async waitForTurn() {
    if (this.interruptWaitError) {
      if (this.interruptFailureStatus) this.currentStatus = this.interruptFailureStatus;
      this.gateReconciliation = true;
      throw this.interruptWaitError;
    }
    this.currentStatus = "idle";
    return { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "idle" as const, state_change_seq: 2 };
  }
  async getAgent() {
    if (this.gateReconciliation && this.reconciliationGate) await this.reconciliationGate;
    return { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: this.currentStatus, state_change_seq: 1, name: this.agentName };
  }
  async interrupt() {}
  async closeTab(tabId: string) {
    this.closed.push(tabId);
    if (this.closeFailure) throw this.closeFailure;
  }
}

test("a claimed task result is returned, not automatically announced, and its tab closes", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const notifications: OwnedAgentRecord[] = [];
  const snapshots: OwnedAgentRecord[][] = [];
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    {
      persist: (records) => snapshots.push(records),
      notify: (record) => notifications.push(record),
    },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review it.", keepOpen: false, cwd: "/repo" });
  assert.equal(fake.prompts[0], "Review it.");
  const progress: WaitProgress[] = [];
  const waiting = manager.wait(["review"], undefined, (update) => progress.push(update));
  assert.deepEqual(progress, [{ selected: ["review"], completed: [], waiting: ["review"] }]);
  fake.settled.resolve({
    pane_id: "w1:p2",
    tab_id: "w1:t2",
    workspace_id: "w1",
    agent_status: "done",
    agent_session: { value: fake.activeSessionFile },
  });

  const [result] = await waiting;
  assert.equal(result.lastResult, "Finished review.");
  assert.deepEqual(progress.at(-1), { selected: ["review"], completed: ["review"], waiting: [] });
  assert.equal(notifications.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.closed, ["w1:t2"]);
  assert.equal(manager.getRecords()[0].status, "closed");
  assert.ok(snapshots.length > 0);
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
      notify() {},
      async reloadConfig() { return refreshed; },
    },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review it.", keepOpen: true, cwd: "/repo" });

  const modelIndex = fake.startArgs.indexOf("--model");
  assert.equal(fake.startArgs[modelIndex + 1], "updated-model");
  const instructionsIndex = fake.startArgs.indexOf("--append-system-prompt");
  assert.equal(await readFile(fake.startArgs[instructionsIndex + 1], "utf8"), composeChildSystemPrompt("Use the updated profile."));
});

test("a frontmatter-only identity receives the common child prompt", async () => {
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
    { persist() {}, notify() {} },
  );

  await manager.start({ name: "fast", identityName: "reviewer", task: "Check it.", keepOpen: true, cwd: "/repo" });

  const instructionsIndex = fake.startArgs.indexOf("--append-system-prompt");
  assert.notEqual(instructionsIndex, -1);
  assert.equal(await readFile(fake.startArgs[instructionsIndex + 1], "utf8"), composeChildSystemPrompt());
  assert.equal(fake.prompts[0], "Check it.");
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
    { persist() {}, notify() {} },
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
    { persist() {}, notify() {}, warn: (message) => warnings.push(message) },
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
    { persist() {}, notify() {} },
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
    { persist() {}, notify() {} },
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

test("a wait claims a completion deferred during the current parent turn", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const pending = new Map<string, OwnedAgentRecord>();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    {
      persist() {},
      notify: (record) => pending.set(`${record.name}:${record.assignment}`, record),
      claimNotification: (record) => pending.delete(`${record.name}:${record.assignment}`),
    },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review it.", keepOpen: true, cwd: "/repo" });
  fake.settled.resolve({
    pane_id: "w1:p2",
    tab_id: "w1:t2",
    workspace_id: "w1",
    agent_status: "done",
    agent_session: { value: fake.activeSessionFile },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.size, 1);

  const [result] = await manager.wait(["review"]);

  assert.equal(result.lastResult, "Finished review.");
  assert.equal(pending.size, 0);
});

test("a cancelled wait restores automatic notification for later completion", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const notifications: OwnedAgentRecord[] = [];
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {}, notify: (record) => notifications.push(record) },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review it.", keepOpen: true, cwd: "/repo" });
  const controller = new AbortController();
  const waiting = manager.wait(["review"], controller.signal);
  controller.abort();
  await assert.rejects(waiting, /Wait cancelled/);

  fake.settled.resolve({
    pane_id: "w1:p2",
    tab_id: "w1:t2",
    workspace_id: "w1",
    agent_status: "done",
    agent_session: { value: fake.activeSessionFile },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].lastResult, "Finished review.");
});

test("an unclaimed persistent result notifies the parent and keeps its tab", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const notifications: OwnedAgentRecord[] = [];
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {}, notify: (record) => notifications.push(record) },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review it.", keepOpen: true, cwd: "/repo" });
  fake.settled.resolve({
    pane_id: "w1:p2",
    tab_id: "w1:t2",
    workspace_id: "w1",
    agent_status: "done",
    agent_session: { value: fake.activeSessionFile },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(notifications[0].lastResult, "Finished review.");
  assert.equal(manager.getRecords()[0].status, "idle");
  assert.deepEqual(fake.closed, []);
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
    { persist() {}, notify() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: false, cwd: "/repo" });
  const interrupted = await manager.interrupt("review");
  assert.equal(interrupted.status, "interrupted");
  assert.deepEqual(fake.closed, []);

  const followUp = await manager.send("review", "Continue differently.");
  assert.equal(followUp.assignment, 2);
  assert.equal(followUp.status, "working");
  assert.deepEqual(fake.closed, []);
});

test("a failed interrupt retains the active assignment lock", async () => {
  const fake = new FakeHerdr();
  fake.sessionFile = await childSessionFile();
  const manager = new AgentManager(
    fake as unknown as HerdrClient,
    testConfig(),
    "w1",
    dirname(fake.sessionFile),
    "parent",
    { provider: "test", model: "test/model", thinking: "medium" },
    { persist() {}, notify() {} },
  );

  await manager.start({ name: "review", identityName: "reviewer", task: "Review.", keepOpen: true, cwd: "/repo" });
  fake.interruptWaitError = new Error("interrupt timeout");
  await assert.rejects(manager.interrupt("review"), /interrupt timeout/);
  await assert.rejects(manager.send("review", "Do not overlap."), /already working/);
  assert.equal(manager.getRecords()[0].status, "working");
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
    { persist() {}, notify() {} },
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
    notifiedAssignment: 1,
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
    { persist() {}, notify() {} },
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
    notifiedAssignment: 1,
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
    { persist() {}, notify() {} },
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
    notifiedAssignment: 1,
    lastTask: "Previous.",
    updatedAt: Date.now(),
  }]);

  await assert.rejects(manager.interrupt("review"), /transport failure/);
  assert.equal(manager.getRecords()[0].status, "working");
  await assert.rejects(manager.send("review", "Do not overlap."), /already working/);
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
    { persist() {}, notify() {} },
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
  await assert.rejects(sameSecond, /already reopening/);
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
    { persist() {}, notify() {} },
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
    { persist() {}, notify() {} },
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
    notify?(record: OwnedAgentRecord): void;
    notifyCollection?(collection: OwnedAgentCollection): void;
    claimNotification?(record: OwnedAgentRecord): void;
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
      notify: callbacks.notify ?? (() => undefined),
      notifyCollection: callbacks.notifyCollection,
      claimNotification: callbacks.claimNotification,
    },
  );
}

test("collect_agents includes already-settled mixed outcomes and claims individual notifications", async () => {
  const fake = new MultiAgentHerdr();
  const claimed: string[] = [];
  const completed: OwnedAgentCollection[] = [];
  const manager = collectionManager(fake, {
    claimNotification: (record) => claimed.push(record.name),
    notifyCollection: (collection) => completed.push(collection),
  });
  const records = [
    ownedRecord({ name: "ok", status: "idle", result: "Done." }),
    ownedRecord({ name: "blocked", status: "blocked", result: "Needs input." }),
    ownedRecord({ name: "failed", status: "failed", result: "Failed." }),
    ownedRecord({ name: "stopped", status: "interrupted", result: "Interrupted." }),
  ];
  await manager.restore(records);

  const collection = manager.collect(records.map((record) => record.name));

  assert.equal(collection.notified, true);
  assert.deepEqual(claimed, ["ok", "blocked", "failed", "stopped"]);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].members.map((member) => member.result?.status), ["idle", "blocked", "failed", "interrupted"]);
});

test("collect_agents emits one notification for simultaneous completions and suppresses individuals", async () => {
  const fake = new MultiAgentHerdr();
  const firstFile = await childSessionFile();
  const secondFile = await childSessionFile();
  fake.add("p1");
  fake.add("p2");
  const individual: OwnedAgentRecord[] = [];
  const completed: OwnedAgentCollection[] = [];
  const manager = collectionManager(fake, {
    notify: (record) => individual.push(record),
    notifyCollection: (collection) => completed.push(collection),
  });
  await manager.restore([
    ownedRecord({ name: "first", status: "working", paneId: "p1", sessionFile: firstFile }),
    ownedRecord({ name: "second", status: "working", paneId: "p2", sessionFile: secondFile }),
  ]);
  manager.collect(["first", "second"]);

  fake.settle("p1");
  fake.settle("p2");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(individual.length, 0);
  assert.equal(completed.length, 1);
  assert.deepEqual(completed[0].members.map((member) => member.result?.lastResult), ["Finished review.", "Finished review."]);
});

test("a cancelled overlapping wait does not release an assignment from its collection", async () => {
  const fake = new MultiAgentHerdr();
  const sessionFile = await childSessionFile();
  fake.add("p1");
  const completed: OwnedAgentCollection[] = [];
  const individual: OwnedAgentRecord[] = [];
  const manager = collectionManager(fake, {
    notify: (record) => individual.push(record),
    notifyCollection: (collection) => completed.push(collection),
  });
  await manager.restore([ownedRecord({ name: "review", status: "working", paneId: "p1", sessionFile })]);
  manager.collect(["review"]);
  const controller = new AbortController();
  const waiting = manager.wait(["review"], controller.signal);

  fake.settle("p1");
  controller.abort();
  await assert.rejects(waiting, /Wait cancelled/);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(individual.length, 0);
  assert.equal(completed.length, 1);
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
  firstManager.collect(["review"]);
  firstManager.suspend();

  const secondFake = new MultiAgentHerdr();
  secondFake.add("p1");
  const completed: OwnedAgentCollection[] = [];
  const individual: OwnedAgentRecord[] = [];
  const secondManager = collectionManager(secondFake, {
    notify: (record) => individual.push(record),
    notifyCollection: (collection) => completed.push(collection),
  });
  await secondManager.restore(recordsSnapshot, collectionsSnapshot);
  secondFake.settle("p1");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(individual.length, 0);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].members[0].result?.lastResult, "Finished review.");
});
