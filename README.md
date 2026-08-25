# pi-herdr-agents

`@vistyy/pi-herdr-agents` provides a Pi session with owned, resumable read-only agents in separate tabs of its current Herdr workspace.

The extension owns agent launch, messaging, lifecycle, resource selection, and completion delivery.
External instructions own delegation and orchestration policy.

An **agent identity** is global configuration that selects runtime settings, inherited resources, and optional stable instructions.

An **owned agent** is a resumable Pi session created from an agent identity and owned by one parent Pi session.

Each managed child keeps its canonical Herdr ownership name (`oa-*`).
Each caller-provided `start_agents.agents[].name` is published separately as Herdr's display-only agent metadata through the `pi-herdr-agents` metadata source.
The metadata is guarded to apply to Herdr's authoritative `herdr:pi` lifecycle reporter and does not change Pi state reporting, ownership checks, waits, or rollups.

The extension adds the `pi_herdr_owned=1` pane token to every owned child and installs a Herdr-session Agents view that excludes that token.
This changes only the sidebar projection.
Owned children remain recognized Herdr agents, and `agent.list`, `agent.get`, `agent.read`, `agent.prompt`, notifications, and tabs are unchanged.
The projection remains until another source replaces or clears it, or the Herdr server exits.
Individual Pi session shutdown does not clear the shared projection.
Installation is source-guarded.
If another source already owns the Agents projection, the extension reports a warning and leaves that projection unchanged.
Herdr 0.8 has no atomic check-and-set view operation, so a narrow race remains between the source-guarded preflight and set request.

## Requirements

- Pi 0.84.1 or newer.
- A current Herdr session with `HERDR_ENV=1`.
- The `herdr` executable in `PATH`.

The extension is inactive outside Herdr.
It does not fall back to unmanaged child processes.

## Install

Install a released version from GitHub:

```sh
pi install git:github.com/Vistyy/pi-herdr-agents@v0.3.1
```

Install a local checkout:

```sh
pi install /absolute/path/to/pi-herdr-agents
```

Run `/reload` after installation or configuration changes.

## Configure

Configuration is global under:

```text
~/.pi/agent/pi-herdr-agents/
├── config.json
└── agents/
    └── analysis.md
```

Set `PI_CODING_AGENT_DIR` to move the Pi agent directory.

The package ships no agent identities.
When no valid identities exist, it registers no LLM tools.

### Global defaults

```json
{
  "maxAgents": 10,
  "defaults": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "thinking": "medium"
  }
}
```

`maxAgents` defaults to `10`.
An invalid global configuration disables the extension and reports an error.

Scalar settings use identity, then global default, then parent-session values.
The scalar settings are `provider`, `model`, and `thinking`.

### Agent identity

Each identity is one Markdown file with YAML frontmatter.
The `name` and `description` fields are required.
All runtime fields and the Markdown body are optional.

```md
---
name: analysis
description: Use for read-only analysis with additional reasoning effort.
thinking: high
tools:
  - "!edit"
  - "!write"
---
```

The `name` must match `[a-z][a-z0-9_-]{0,63}`.
Every assignment selects an identity explicitly.
The `description` tells the parent what stable runtime capability or specialist method the identity provides.

A Markdown body supplies identity-specific instructions:

```md
---
name: library-evidence
description: Checks one precise question about an installed or selected library and returns version-matched evidence.
model: gpt-5.6-luna
thinking: high
tools:
  - read
  - bash
  - web_search
  - web_fetch
---

Establish the installed library version before making compatibility claims.
Use installed source, types, current repository usage, and matching official documentation.
Treat missing evidence as unknown.
```

The body is appended to Pi's default coding prompt.
A frontmatter-only identity adds no identity prompt.

An invalid identity is disabled without disabling other valid identities.
The extension reports each invalid identity during session startup.

### Resource inheritance and filters

A child starts from the parent's resources.
Tools come from the parent's active tool set when the child starts.
Extensions and skills are resolved through Pi's resource loader with the parent's global configuration, project configuration, working directory, and project trust decision.

Global default filters apply first.
Identity filters apply to that result second.

Each `tools`, `extensions`, or `skills` field has these semantics:

- An omitted field preserves the inherited set from the previous layer.
- An empty list selects no resources of that type.
- Plain glob patterns form an allowlist.
- `!pattern` excludes all glob matches.
- `-value` excludes one exact match.
- `+value` force-includes one exact match from the inherited parent universe, including a resource removed by a global default filter.

Patterns use minimatch glob syntax.
Tool and skill names can be used directly.
Extension selectors can match resolved paths, configured source names, file names, or containing directory names.

This identity keeps inherited tools, removes write tools, and selects two inherited skills:

```yaml
tools:
  - "!edit"
  - "!write"
skills:
  - verification
  - codebase-design
```

This identity removes all inherited skills:

```yaml
skills: []
```

Relative extension and skill paths in `config.json` resolve from the configuration directory.
Relative paths in an identity resolve from that identity file's directory.
A leading `~/` resolves from the home directory.

This extension, the global `herdr` and `session-transfer` skills, and these agent-management tools are always excluded from children:

- `start_agents`
- `send_agents`
- `list_agents`
- `interrupt_agent`
- `close_agent`

Filters cannot force-include these resources.
This prevents children from recursively launching owned agents or transferring sessions.

## Agent behavior

The extension registers the five agent tools above when at least one valid identity exists.

Each owned agent opens in a new tab in the parent session's current Herdr workspace and uses the parent's working directory.
The assignment user message defines the agent's task-specific behavior and output.
Every child receives a mandatory read-only boundary after any identity-specific instructions.
If an assignment requires a state change, the child reports that limitation and stops.
The extension does not create Git worktrees or provide operating-system isolation.

Each `start_agents` call dispatches one fixed batch containing one or more assignments.
The call returns after every agent either accepts its assignment or fails to start.
It does not terminate the parent turn.
Set `keep_open: true` when an agent should remain available after completion.
A normal temporary agent closes its tab after preserving its report and resumable session.

`send_agents` guides active assignments without creating a new batch.
Messages to settled agents start their next assignments as one new fixed batch.
Do not mix active guidance and new assignments in one call.
Sending a message to a closed agent resumes its Pi session in a new tab.
The extension reloads `config.json` and the selected identity file before it starts or resumes a child, so edits apply without reloading the parent Pi session.

`interrupt_agent` sends Pi's Escape key, then waits for settlement with a bounded timeout.
If Herdr still reports the child as working or unknown, the extension preserves the tab and session, retains the assignment lock, and continues reconciliation in the background.

Batch completion sends one hidden follow-up message to the parent and triggers a parent turn.
The grouped message contains the latest assistant text from every assignment in that batch, subject to Pi's output limits.
If text is truncated, the full child conversation remains in the recorded child session file but is not automatically loaded into the parent model context.
If the parent is active when the batch settles, the extension defers the follow-up until that parent turn settles.
Successful, failed, blocked, and interrupted results all settle their batch member.
Pending batches survive a Pi extension reload.

In TUI mode, a concise widget above the editor shows active or blocked assignment names and selected identities.
Use `list_agents` to inspect identity, assignment, tab lifecycle, and resumability details.

Only the same parent Pi session can list or resume its owned agents.
Forked and unrelated Pi sessions do not adopt them.

## Child Pi environment

The extension resolves inherited resources before launch and passes explicit tool, extension, and skill lists to the child.
The child disables automatic extension, skill, and prompt-template discovery so its launch cannot add resources outside those resolved lists.
It still loads applicable repository `AGENTS.md` and `CLAUDE.md` context files.
It uses Pi's default coding prompt, followed by any profile-specific identity body and the mandatory read-only boundary.
Frontmatter-only identities add no profile-specific instructions.
The assignment is sent separately as a user message and defines what the child must do.

This controls Pi resources and provides prompt guidance, not operating-system access or filesystem enforcement.
A child with shell access can still start processes permitted by the operating system, so the read-only boundary is not a security sandbox.

## Lifecycle

`/reload` keeps live owned-agent tabs open and reconnects tracking from parent-session entries.

Normal parent exit, `/new`, `/resume`, `/fork`, and `/clone` close live owned-agent tabs.
Child Pi session files remain available for same-parent resumption under `~/.pi/agent/pi-herdr-agents/sessions/`.
An active assignment is interrupted when its parent exits or changes sessions.

Hard crashes, `SIGKILL`, Herdr failure, and power loss cannot run graceful cleanup.
Crash recovery and orphan-tab cleanup are outside the initial version.
