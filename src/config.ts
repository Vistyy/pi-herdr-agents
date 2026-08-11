import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import {
  DEFAULT_MAX_AGENTS,
  type AgentIdentity,
  type ExtensionConfig,
  type RuntimeSettings,
  type ThinkingLevel,
} from "./types.js";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RUNTIME_KEYS = new Set(["provider", "model", "thinking", "tools", "extensions", "skills"]);
const IDENTITY_KEYS = new Set(["name", "description", ...RUNTIME_KEYS]);

export function getConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR
    ? expandHome(env.PI_CODING_AGENT_DIR)
    : join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-herdr-agents");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function resolveResource(value: string, baseDir: string): string {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function readString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function readList(value: unknown, field: string, baseDir?: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  const entries = value.map((item) => item.trim());
  if (entries.includes("all")) throw new Error(`${field} must use explicit entries; "all" is not supported`);
  if (new Set(entries).size !== entries.length) throw new Error(`${field} must not contain duplicates`);
  return baseDir ? entries.map((item) => resolveResource(item, baseDir)) : entries;
}

function readRuntimeSettings(value: unknown, location: string, baseDir: string): RuntimeSettings {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${location} must be an object`);
  const data = value as Record<string, unknown>;
  const unknown = Object.keys(data).filter((key) => !RUNTIME_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`${location} contains unknown fields: ${unknown.join(", ")}`);

  const thinking = readString(data.thinking, `${location}.thinking`);
  if (thinking !== undefined && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
    throw new Error(`${location}.thinking is invalid`);
  }

  return {
    provider: readString(data.provider, `${location}.provider`),
    model: readString(data.model, `${location}.model`),
    thinking: thinking as ThinkingLevel | undefined,
    tools: readList(data.tools, `${location}.tools`),
    extensions: readList(data.extensions, `${location}.extensions`, baseDir),
    skills: readList(data.skills, `${location}.skills`, baseDir),
  };
}

function splitFrontmatter(contents: string): { metadata: unknown; body: string } {
  if (!contents.startsWith("---\n")) throw new Error("missing YAML frontmatter");
  const end = contents.indexOf("\n---", 4);
  if (end < 0) throw new Error("unterminated YAML frontmatter");
  const after = end + 4;
  const metadata = parse(contents.slice(4, end));
  const body = contents.slice(contents[after] === "\n" ? after + 1 : after).trim();
  return { metadata, body };
}

async function loadIdentity(path: string): Promise<AgentIdentity> {
  const { metadata, body } = splitFrontmatter(await readFile(path, "utf8"));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("frontmatter must be an object");
  const data = metadata as Record<string, unknown>;
  const unknown = Object.keys(data).filter((key) => !IDENTITY_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`unknown fields: ${unknown.join(", ")}`);

  const name = readString(data.name, "name");
  const description = readString(data.description, "description");
  if (!name || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error("name must match [a-z][a-z0-9_-]{0,63}");
  }
  if (!description) throw new Error("description is required");
  if (!body) throw new Error("instruction body is required");

  const runtimeData = Object.fromEntries(Object.entries(data).filter(([key]) => RUNTIME_KEYS.has(key)));
  return {
    name,
    description,
    instructions: body,
    sourcePath: path,
    ...readRuntimeSettings(runtimeData, "frontmatter", dirname(path)),
  };
}

export async function loadConfig(configDir = getConfigDirectory()): Promise<ExtensionConfig> {
  const configPath = join(configDir, "config.json");
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config root must be an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Invalid ${configPath}: ${(error as Error).message}`);
    }
  }

  const unknown = Object.keys(raw).filter((key) => key !== "maxAgents" && key !== "defaults");
  if (unknown.length > 0) throw new Error(`Invalid ${configPath}: unknown fields: ${unknown.join(", ")}`);

  const maxAgents = raw.maxAgents ?? DEFAULT_MAX_AGENTS;
  if (!Number.isInteger(maxAgents) || (maxAgents as number) < 1) {
    throw new Error(`Invalid ${configPath}: maxAgents must be a positive integer`);
  }

  const warnings: string[] = [];
  const identities: AgentIdentity[] = [];
  const agentsDir = join(configDir, "agents");
  let files: string[] = [];
  try {
    files = (await readdir(agentsDir)).filter((name) => name.endsWith(".md")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  for (const file of files) {
    const path = join(agentsDir, file);
    try {
      const identity = await loadIdentity(path);
      if (identities.some((candidate) => candidate.name === identity.name)) {
        throw new Error(`duplicate identity name: ${identity.name}`);
      }
      identities.push(identity);
    } catch (error) {
      warnings.push(`Disabled identity ${file}: ${(error as Error).message}`);
    }
  }

  return {
    maxAgents: maxAgents as number,
    defaults: readRuntimeSettings(raw.defaults, "defaults", configDir),
    identities,
    warnings,
  };
}

export function resolveSettings(
  identity: AgentIdentity,
  defaults: RuntimeSettings,
  parent: Required<Pick<RuntimeSettings, "model" | "thinking">> & Pick<RuntimeSettings, "provider">,
): RuntimeSettings {
  return {
    provider: identity.provider ?? defaults.provider ?? parent.provider,
    model: identity.model ?? defaults.model ?? parent.model,
    thinking: identity.thinking ?? defaults.thinking ?? parent.thinking,
    tools: identity.tools ?? defaults.tools ?? [],
    extensions: identity.extensions ?? defaults.extensions ?? [],
    skills: identity.skills ?? defaults.skills ?? [],
  };
}
