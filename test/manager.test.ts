import assert from "node:assert/strict";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { HerdrClient } from "../src/herdr.js";
import { AgentManager, type WaitProgress } from "../src/manager.js";
import type { ExtensionConfig, HerdrAgent, OwnedAgentRecord } from "../src/types.js";

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

  async createTab() {
    this.createCalls += 1;
    return { tabId: "w1:t2", paneId: "w1:p2" };
  }
  async waitForShell() {}
  async startPi(name?: string, _pane?: string, args?: string[]) {
    if (name) this.agentName = name;
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
  async prompt() {
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
  async closeTab(tabId: string) { this.closed.push(tabId); }
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
