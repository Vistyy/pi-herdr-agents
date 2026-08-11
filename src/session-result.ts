import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface AgentResult {
  text: string;
  failed: boolean;
  error?: string;
}

export function readLatestAssistantResult(sessionFile: string): AgentResult {
  const messages = SessionManager.open(sessionFile).buildSessionContext().messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    return {
      text: text || (failed ? message.errorMessage ?? "Agent failed without output." : "(no output)"),
      failed,
      error: message.errorMessage,
    };
  }
  return { text: "(no assistant response)", failed: true, error: "The child session has no assistant response." };
}
