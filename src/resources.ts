import { basename, dirname, relative, sep } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import type { AgentIdentity, RuntimeSettings } from "./types.js";

const DELEGATION_TOOLS = new Set([
  "start_agent",
  "send_agent",
  "wait_agents",
  "collect_agents",
  "list_agents",
  "interrupt_agent",
  "close_agent",
]);
const DELEGATION_SKILLS = new Set(["herdr", "session-routing"]);

interface SelectableResource {
  value: string;
  aliases: string[];
}

export interface InheritedResources {
  extensions: SelectableResource[];
  skills: SelectableResource[];
}

export async function discoverInheritedResources(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  packageRoot: string;
}): Promise<InheritedResources> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  settingsManager.setProjectTrusted(options.projectTrusted);
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "",
  });
  await loader.reload();

  const extensions = loader.getExtensions().extensions
    .filter((extension) => !isWithin(extension.resolvedPath, options.packageRoot))
    .map((extension) => ({
      value: extension.resolvedPath,
      aliases: unique([
        extension.resolvedPath,
        relative(options.agentDir, extension.resolvedPath),
        extension.path,
        extension.sourceInfo.source,
        basename(extension.resolvedPath),
        basename(dirname(extension.resolvedPath)),
      ]),
    }));
  const skills = loader.getSkills().skills
    .map((skill) => ({
      value: skill.filePath,
      aliases: unique([
        skill.name,
        skill.filePath,
        relative(options.agentDir, skill.filePath),
      ]),
    }));

  return { extensions, skills };
}

export function resolveRuntimeSettings(options: {
  identity: AgentIdentity;
  defaults: RuntimeSettings;
  parent: RuntimeSettings;
  inherited: InheritedResources;
  activeTools: string[];
}): RuntimeSettings {
  const toolUniverse = options.activeTools
    .filter((name) => !DELEGATION_TOOLS.has(name))
    .map((name) => ({ value: name, aliases: [name] }));

  return {
    provider: options.identity.provider ?? options.defaults.provider ?? options.parent.provider,
    model: options.identity.model ?? options.defaults.model ?? options.parent.model,
    thinking: options.identity.thinking ?? options.defaults.thinking ?? options.parent.thinking,
    tools: selectLayered(toolUniverse, options.defaults.tools, options.identity.tools),
    extensions: selectLayered(options.inherited.extensions, options.defaults.extensions, options.identity.extensions),
    skills: selectLayered(
      options.inherited.skills.filter((skill) => !skill.aliases.some((alias) => DELEGATION_SKILLS.has(alias))),
      options.defaults.skills,
      options.identity.skills,
    ),
  };
}

function selectLayered(
  universe: SelectableResource[],
  defaults: string[] | undefined,
  identity: string[] | undefined,
): string[] {
  const afterDefaults = applySelectors(universe, universe, defaults);
  return applySelectors(afterDefaults, universe, identity).map((resource) => resource.value);
}

function applySelectors(
  current: SelectableResource[],
  universe: SelectableResource[],
  selectors: string[] | undefined,
): SelectableResource[] {
  if (selectors === undefined) return current;
  if (selectors.length === 0) return [];

  const includes = selectors.filter((selector) => !selector.startsWith("!") && !selector.startsWith("+") && !selector.startsWith("-"));
  const globExcludes = selectors.filter((selector) => selector.startsWith("!")).map((selector) => selector.slice(1));
  const exactExcludes = selectors.filter((selector) => selector.startsWith("-")).map((selector) => selector.slice(1));
  const forceIncludes = selectors.filter((selector) => selector.startsWith("+")).map((selector) => selector.slice(1));

  let selected = includes.length === 0
    ? [...current]
    : current.filter((resource) => includes.some((pattern) => matchesPattern(resource, pattern)));
  selected = selected.filter((resource) => !globExcludes.some((pattern) => matchesPattern(resource, pattern)));
  selected = selected.filter((resource) => !exactExcludes.some((value) => matchesExact(resource, value)));

  for (const value of forceIncludes) {
    const resource = universe.find((candidate) => matchesExact(candidate, value));
    if (resource && !selected.some((candidate) => candidate.value === resource.value)) selected.push(resource);
  }
  return selected;
}

function matchesPattern(resource: SelectableResource, pattern: string): boolean {
  return resource.aliases.some((alias) => minimatch(alias, pattern, { dot: true }));
}

function matchesExact(resource: SelectableResource, value: string): boolean {
  return resource.aliases.includes(value);
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

