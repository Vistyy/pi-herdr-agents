export const OWNED_AGENT_ENTRY = "pi-herdr-owned-agents";
export const DEFAULT_MAX_AGENTS = 10;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type OwnedAgentStatus = "starting" | "working" | "blocked" | "idle" | "closed" | "interrupted" | "failed";

export interface RuntimeSettings {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  extensions?: string[];
  skills?: string[];
}

export interface AgentIdentity extends RuntimeSettings {
  name: string;
  description: string;
  instructions?: string;
  sourcePath: string;
}

export interface ExtensionConfig {
  maxAgents: number;
  defaults: RuntimeSettings;
  identities: AgentIdentity[];
  warnings: string[];
}

export interface OwnedAgentRecord {
  name: string;
  identity: string;
  keepOpen: boolean;
  status: OwnedAgentStatus;
  paneId?: string;
  tabId?: string;
  sessionFile?: string;
  cwd: string;
  assignment: number;
  completedAssignment?: number;
  notifiedAssignment?: number;
  lastTask: string;
  lastResult?: string;
  lastError?: string;
  updatedAt: number;
}

export interface OwnedAgentCollectionMember {
  name: string;
  assignment: number;
  result?: OwnedAgentRecord;
}

export interface OwnedAgentCollection {
  id: string;
  members: OwnedAgentCollectionMember[];
  createdAt: number;
  notified: boolean;
}

export type OwnedAgentSnapshot = {
  version: 1;
  parentSessionId: string;
  records: OwnedAgentRecord[];
} | {
  version: 2;
  parentSessionId: string;
  records: OwnedAgentRecord[];
  collections: OwnedAgentCollection[];
};

export interface HerdrAgent {
  name?: string;
  agent_status?: "idle" | "working" | "blocked" | "done" | "unknown";
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  state_change_seq?: number;
  agent_session?: {
    value?: string;
  };
}
