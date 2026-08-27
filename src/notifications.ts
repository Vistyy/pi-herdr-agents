import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { OWNED_AGENT_ENTRY, type OwnedAgentCollection, type OwnedAgentRecord } from "./types.js";

export function sendBatchCompletion(pi: Pick<ExtensionAPI, "sendMessage">, collection: OwnedAgentCollection): void {
  pi.sendMessage(
    {
      customType: OWNED_AGENT_ENTRY,
      content: formatBatchCompletion(collection),
      display: false,
      details: { kind: "collection", collection },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

export function formatBatchCompletion(collection: OwnedAgentCollection): string {
  const records = collection.members.flatMap((member) => member.result ? [member.result] : []);
  const text = `Owned agent batch ${collection.id} settled.\n\n${formatResults(records)}`;
  const truncated = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  return truncated.truncated
    ? `${truncated.content}\n\n[Batch output truncated. Full individual results remain in the child Pi session files.]`
    : truncated.content;
}

function formatResults(records: OwnedAgentRecord[]): string {
  if (records.length === 0) return "No agent results.";
  return records.map((record) => {
    const status = record.status === "idle" || record.status === "closed" ? "" : ` (${record.status})`;
    return `## ${record.name}${status}\n\n${record.lastResult ?? record.lastError ?? "(no result)"}`;
  }).join("\n\n");
}
