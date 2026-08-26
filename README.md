# pi-herdr-agents

`@vistyy/pi-herdr-agents` runs owned Pi agents in separate tabs of the current Herdr workspace.
Each agent has a configurable model, resource set, and instruction profile.
The parent Pi session starts assignments, receives their reports, and retains ownership of their resumable sessions.

The extension provides agent execution and lifecycle primitives.
It does not decide when work should be delegated or impose a read-only policy.

## Requirements

- Pi 0.84.1 or newer.
- An active Herdr session with `HERDR_ENV=1`.
- The `herdr` executable in `PATH`.

The extension is inactive outside Herdr.

## Install

Install from GitHub:

```sh
pi install git:github.com/Vistyy/pi-herdr-agents
```

Install a local checkout during development:

```sh
pi install /absolute/path/to/pi-herdr-agents
```

Run `/reload` after installation or configuration changes.

## Configure identities

Configuration is stored under `$PI_CODING_AGENT_DIR/pi-herdr-agents/`.
When `PI_CODING_AGENT_DIR` is unset, the default location is `~/.pi/agent/pi-herdr-agents/`.

```text
pi-herdr-agents/
├── config.json
├── instructions.md
└── agents/
    ├── general.md
    └── experimenter.md
```

The package does not ship agent identities.
The extension registers no agent tools until at least one valid identity exists.

### Global configuration

`config.json` defines the live-agent limit, optional shared instructions, and runtime defaults:

```json
{
  "maxAgents": 10,
  "instructionsFile": "./instructions.md",
  "defaults": {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "thinking": "high",
    "extensions": ["!expensive-extension"],
    "skills": ["!specialized-skill"]
  }
}
```

`maxAgents` must be a positive integer and defaults to `10`.
`instructionsFile` is optional and resolves relative to `config.json`.
The referenced text is appended to Pi's system prompt for every child.

The `defaults` object accepts `provider`, `model`, `thinking`, `tools`, `extensions`, and `skills`.
Runtime scalar values resolve in this order: identity, global default, parent session.
An invalid global configuration disables the extension and reports the error.

### Identity files

Each Markdown file under `agents/` defines one identity.
The YAML frontmatter requires `name` and `description` and accepts the same runtime fields as `defaults`.
The Markdown body contains stable instructions for that identity.

```md
---
name: general
description: Collects and compresses read-only evidence for the parent.
model: gpt-5.6-luna
thinking: high
tools:
  - "!edit"
  - "!write"
---

Inspect existing information without changing local or external state.
Return a compact report with concrete evidence and material unknowns.
```

Identity names must match `[a-z][a-z0-9_-]{0,63}`.
Descriptions appear in the `start_agents` tool so the parent can select an appropriate identity.
The shared instructions are appended before the identity body.
When neither source has content, the extension appends no additional system instructions.

An invalid identity is disabled without disabling other valid identities.
The extension reports disabled identities when the parent session starts.

### Select resources

Children inherit the parent's active tools and the extensions and skills available in the parent's project context.
Global selectors apply first, and identity selectors apply to that result.

The `tools`, `extensions`, and `skills` fields use the following selector rules:

- Omitting a field preserves the resources from the previous layer.
- An empty list selects no resources of that type.
- A plain glob forms an allowlist from the current resources.
- `!pattern` excludes every glob match.
- `-value` excludes one exact match.
- `+value` restores one exact resource from the inherited parent set, including a resource excluded by global defaults.

Patterns use minimatch syntax.
Tool and skill selectors can use their names.
Extension selectors can match resolved paths, configured source names, file names, or containing directory names.
Relative extension and skill paths in `config.json` resolve from the configuration directory.
Relative paths in an identity resolve from that identity file's directory.
Paths beginning with `~/` resolve from the home directory.

Children can never receive this extension, the `herdr` or `session-transfer` skills, or the following management tools:

- `start_agents`
- `send_agents`
- `list_agents`
- `interrupt_agent`
- `close_agent`

These exclusions prevent recursive owned-agent trees and parent-session transfer.

## Operation

The extension exposes five tools to the parent model:

- `start_agents` starts one fixed batch of assignments.
- `send_agents` guides active assignments or gives settled agents a new assignment.
- `list_agents` reports owned-agent and tab state.
- `interrupt_agent` sends Pi's Escape interrupt without deleting the child session.
- `close_agent` closes a child tab while preserving its resumable session.

Each child runs in the parent's working directory and current Herdr workspace.
The assignment is sent as a user message after Pi's default system prompt, shared instructions, and identity instructions.
Assignments in one `start_agents` batch run concurrently.
The parent receives one completion follow-up after every member of the batch settles.

Temporary agents close their tabs after reporting unless `keep_open` is true.
A later message to a closed agent resumes its preserved Pi session in a new tab.
Only the parent Pi session that created an agent can list or resume it.

Owned children are excluded from the Herdr Agents sidebar to avoid duplicate parent-visible entries.
Their tabs and normal Herdr agent operations remain available.

## Boundaries and recovery

Resource selectors and prompt instructions are not a security boundary.
A child with shell access has the operating-system permissions of the Pi process.
The extension does not create Git worktrees or isolate concurrent filesystem changes.

`/reload` reconnects to live children owned by the current parent session.
Starting a new parent session or normally exiting Pi closes its live child tabs while preserving child session files.
Hard crashes, `SIGKILL`, Herdr failure, and power loss can leave orphaned tabs because graceful cleanup cannot run.
