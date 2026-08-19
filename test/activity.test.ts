import assert from "node:assert/strict";
import test from "node:test";
import {
  HERDR_ACTIVITY_EVENT,
  HERDR_ACTIVITY_SNAPSHOT_EVENT,
  HERDR_ACTIVITY_SNAPSHOT_REQUEST_EVENT,
  OwnedAssignmentActivityProducer,
  type HerdrActivityEventBus,
  type HerdrActivitySnapshot,
  type HerdrActivityUpdate,
} from "../src/activity.js";
import type { OwnedAgentRecord } from "../src/types.js";

class FakeEventBus implements HerdrActivityEventBus {
  readonly emitted: Array<{ channel: string; data: unknown }> = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
}

function record(overrides: Partial<OwnedAgentRecord> = {}): OwnedAgentRecord {
  return {
    name: "review",
    identity: "reviewer",
    keepOpen: true,
    status: "working",
    cwd: "/repo",
    assignment: 1,
    lastTask: "Review the change.",
    updatedAt: 1,
    ...overrides,
  };
}

function updates(bus: FakeEventBus): HerdrActivityUpdate[] {
  return bus.emitted
    .filter((event) => event.channel === HERDR_ACTIVITY_EVENT)
    .map((event) => event.data as HerdrActivityUpdate);
}

test("publishes bounded active updates and clears idle assignments", () => {
  const bus = new FakeEventBus();
  const producer = new OwnedAssignmentActivityProducer("parent-session", bus);
  const longTask = "x".repeat(100);

  producer.republish([
    record({ status: "starting", lastTask: longTask }),
    record({ name: "idle-agent", status: "idle", assignment: 3 }),
  ]);

  const update = updates(bus).at(-1)!;
  assert.equal(update.source, "pi-herdr-agents");
  assert.equal(update.active, true);
  assert.equal(update.message?.length, 80);
  assert.equal(update.workKey.length <= 80, true);
  assert.equal(update.workKey.endsWith(":review:1"), true);

  producer.republish([record({ status: "idle" })]);
  assert.deepEqual(updates(bus).at(-1), {
    source: "pi-herdr-agents",
    workKey: update.workKey,
    active: false,
    seq: update.seq + 1,
  });
});

test("bounds astral messages to 80 UTF-16 code units", () => {
  const bus = new FakeEventBus();
  const producer = new OwnedAssignmentActivityProducer("astral", bus);

  producer.publish(record({ lastTask: "😀".repeat(100) }));

  const message = updates(bus).at(-1)?.message;
  assert.equal(message, "😀".repeat(40));
  assert.equal(message?.length, 80);
  assert.notEqual(message?.charCodeAt(message.length - 1) >= 0xd800 && message?.charCodeAt(message.length - 1) <= 0xdbff, true);
});

test("uses source-wide increasing sequences and answers snapshot requests synchronously", () => {
  const bus = new FakeEventBus();
  const producer = new OwnedAssignmentActivityProducer("epoch-1", bus);
  producer.publish(record({ assignment: 1 }));

  let response: HerdrActivitySnapshot | undefined;
  bus.on(HERDR_ACTIVITY_SNAPSHOT_EVENT, (data) => { response = data as HerdrActivitySnapshot; });
  const before = bus.emitted.length;
  bus.emit(HERDR_ACTIVITY_SNAPSHOT_REQUEST_EVENT, {});

  assert.equal(bus.emitted.length, before + 2);
  assert.deepEqual(response, {
    source: "pi-herdr-agents",
    activities: [{ workKey: updates(bus)[0].workKey, message: "Review the change." }],
    seq: updates(bus)[0].seq + 1,
  });
  const sequences = bus.emitted
    .map((event) => (event.data as { seq?: number }).seq)
    .filter((seq): seq is number => seq !== undefined);
  assert.ok(sequences.every((seq, index) => index === 0 || seq > sequences[index - 1]));

  producer.dispose();
  assert.equal(updates(bus).at(-1)?.active, false);
  const afterDispose = bus.emitted.length;
  bus.emit(HERDR_ACTIVITY_SNAPSHOT_REQUEST_EVENT, {});
  assert.equal(bus.emitted.length, afterDispose + 1);
});

test("a stale completion cannot clear a later assignment or another epoch", () => {
  const bus = new FakeEventBus();
  const producer = new OwnedAssignmentActivityProducer("epoch-1", bus);
  producer.publish(record({ assignment: 1 }));
  producer.publish(record({ assignment: 2, lastTask: "Follow up." }));
  const beforeStaleClear = bus.emitted.length;

  assert.equal(producer.clear("review", 1, "epoch-1"), false);
  producer.publish(record({ status: "idle", assignment: 1 }));
  assert.equal(bus.emitted.length, beforeStaleClear);
  assert.equal(updates(bus).at(-1)?.workKey.endsWith(":review:2"), true);
  assert.equal(producer.clear("review", 2, "epoch-2"), false);
  assert.equal(updates(bus).at(-1)?.active, true);
});
