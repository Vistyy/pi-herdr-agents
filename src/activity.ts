import { createHash } from "node:crypto";
import type { OwnedAgentRecord } from "./types.js";

export const HERDR_ACTIVITY_SOURCE = "pi-herdr-agents";
export const HERDR_ACTIVITY_EVENT = "herdr:activity";
export const HERDR_ACTIVITY_SNAPSHOT_REQUEST_EVENT = "herdr:activity_snapshot_request";
export const HERDR_ACTIVITY_SNAPSHOT_EVENT = "herdr:activity_snapshot";

const MAX_ACTIVITY_TEXT = 80;
const MAX_WORK_KEY = 80;
const sequenceState = globalThis as typeof globalThis & {
  __piHerdrAgentsActivitySequence?: number;
};

export interface HerdrActivityEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface HerdrActivityUpdate {
  source: typeof HERDR_ACTIVITY_SOURCE;
  workKey: string;
  active: boolean;
  message?: string;
  seq: number;
}

export interface HerdrActivitySnapshot {
  source: typeof HERDR_ACTIVITY_SOURCE;
  activities: Array<{
    workKey: string;
    message?: string;
  }>;
  seq: number;
}

interface ActivityEntry {
  workKey: string;
  assignment: number;
  name: string;
  message?: string;
}

/**
 * Publishes owned assignments through Pi's generic Herdr activity event bus.
 *
 * The producer owns one parent session epoch. Assignment identity is encoded
 * in each work key, so an old completion cannot clear a later assignment.
 */
export class OwnedAssignmentActivityProducer {
  private readonly active = new Map<string, ActivityEntry>();
  private readonly unsubscribeSnapshotRequest: () => void;
  private disposed = false;

  constructor(
    private readonly sessionEpoch: string,
    private readonly events: HerdrActivityEventBus,
  ) {
    this.unsubscribeSnapshotRequest = events.on(
      HERDR_ACTIVITY_SNAPSHOT_REQUEST_EVENT,
      () => this.emitSnapshot(),
    );
  }

  publish(record: OwnedAgentRecord): void {
    if (this.disposed) return;
    const entry = this.entryFor(record);
    const current = this.currentEntry(record.name);
    if (record.status === "starting" || record.status === "working") {
      if (current && current.assignment > record.assignment) return;
      if (current && current.workKey !== entry.workKey) {
        this.active.delete(current.workKey);
        this.emitUpdate(current.workKey, false);
      }
      this.active.set(entry.workKey, entry);
      this.emitUpdate(entry.workKey, true, entry.message);
      return;
    }
    this.clear(record.name, record.assignment, this.sessionEpoch);
  }

  /** Republish the authoritative active set after parent restore or reload. */
  republish(records: readonly OwnedAgentRecord[]): void {
    if (this.disposed) return;
    const desired = new Map<string, ActivityEntry>();
    for (const record of records) {
      if (record.status !== "starting" && record.status !== "working") continue;
      const entry = this.entryFor(record);
      const current = desired.get(entry.workKey);
      if (!current || current.assignment < entry.assignment) desired.set(entry.workKey, entry);
    }

    for (const entry of this.active.values()) {
      if (!desired.has(entry.workKey)) this.emitUpdate(entry.workKey, false);
    }
    this.active.clear();
    for (const entry of [...desired.values()].sort((left, right) => left.workKey.localeCompare(right.workKey))) {
      this.active.set(entry.workKey, entry);
      this.emitUpdate(entry.workKey, true, entry.message);
    }
  }

  /**
   * Clear one assignment only when both its epoch and assignment still match.
   * A stale completion is a no-op and emits no clearing event.
   */
  clear(name: string, assignment: number, sessionEpoch: string): boolean {
    if (this.disposed || sessionEpoch !== this.sessionEpoch) return false;
    const workKey = makeWorkKey(sessionEpoch, name, assignment);
    const current = this.active.get(workKey);
    if (!current) return false;
    this.active.delete(workKey);
    this.emitUpdate(workKey, false);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    for (const entry of this.active.values()) this.emitUpdate(entry.workKey, false);
    this.active.clear();
    this.disposed = true;
    this.unsubscribeSnapshotRequest();
  }

  private currentEntry(name: string): ActivityEntry | undefined {
    return [...this.active.values()]
      .filter((entry) => entry.name === name)
      .sort((left, right) => right.assignment - left.assignment)[0];
  }

  private entryFor(record: OwnedAgentRecord): ActivityEntry {
    return {
      workKey: makeWorkKey(this.sessionEpoch, record.name, record.assignment),
      assignment: record.assignment,
      name: record.name,
      message: boundText(record.lastTask),
    };
  }

  private emitUpdate(workKey: string, active: boolean, message?: string): void {
    const update: HerdrActivityUpdate = {
      source: HERDR_ACTIVITY_SOURCE,
      workKey,
      active,
      seq: nextActivitySequence(),
    };
    if (active && message) update.message = message;
    this.events.emit(HERDR_ACTIVITY_EVENT, update);
  }

  private emitSnapshot(): void {
    const snapshot: HerdrActivitySnapshot = {
      source: HERDR_ACTIVITY_SOURCE,
      activities: [...this.active.values()]
        .sort((left, right) => left.workKey.localeCompare(right.workKey))
        .map(({ workKey, message }) => message ? { workKey, message } : { workKey }),
      seq: nextActivitySequence(),
    };
    this.events.emit(HERDR_ACTIVITY_SNAPSHOT_EVENT, snapshot);
  }
}

export function makeWorkKey(sessionEpoch: string, name: string, assignment: number): string {
  const epochToken = createHash("sha256").update(sessionEpoch).digest("hex").slice(0, 16);
  const workKey = `${epochToken}:${name}:${assignment}`;
  if (workKey.length > MAX_WORK_KEY) throw new Error("Owned assignment work key exceeds 80 characters.");
  return workKey;
}

function boundText(value: string): string | undefined {
  const trimmed = value.trim();
  let end = Math.min(trimmed.length, MAX_ACTIVITY_TEXT);
  const last = end > 0 ? trimmed.charCodeAt(end - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  const text = trimmed.slice(0, end);
  return text || undefined;
}

function nextActivitySequence(): number {
  const current = sequenceState.__piHerdrAgentsActivitySequence ?? 0;
  if (current === Number.MAX_SAFE_INTEGER) throw new Error("Herdr activity sequence exhausted.");
  const next = current + 1;
  sequenceState.__piHerdrAgentsActivitySequence = next;
  return next;
}
