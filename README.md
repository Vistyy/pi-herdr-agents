# pi-herdr-agents

`@vistyy/pi-herdr-agents` gives a Pi session owned, resumable agents in separate tabs of its current Herdr workspace.

An **agent identity** is global configuration that describes when an agent is useful and can customize its runtime settings, inherited resources, and role instructions.

An **owned agent** is a resumable Pi session created from an agent identity and owned by one parent Pi session.

Each managed child keeps its canonical Herdr ownership name (`oa-*`).
The caller-provided `start_agent.name` is published separately as Herdr's display-only agent metadata through the `pi-herdr-agents` metadata source.
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
pi install git:github.com/Vistyy/pi-herdr-agents@v0.1.12
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
    └── reviewer.md
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
name: reviewer
description: Reviews a bounded concern when independent analysis can reduce the parent session's context load.
thinking: high
skills:
  - verification
  - "!session-routing"
---
```

The `name` must match `[a-z][a-z0-9_-]{0,63}`.
The `description` tells the parent when and why to invoke the identity.
Write a specific description because the parent uses it to select an identity.

A Markdown body supplies identity-specific instructions:

```md
---
name: library-researcher
description: Researches a bounded decision about an installed library using version-specific evidence and official guidance.
model: gpt-5.6-luna
thinking: high
tools:
  - read
  - bash
  - web_search
  - web_fetch
---

Establish the installed library version before making compatibility claims.
Prefer official documentation and repository evidence.
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

The delegation extension, the global `herdr` and `session-routing` skills, and these delegation tools are always excluded from children:

- `start_agent`
- `send_agent`
- `wait_agents`
- `collect_agents`
- `list_agents`
- `interrupt_agent`
- `close_agent`

Filters cannot force-include these resources.
This keeps parent-only delegation policy and controls out of child prompts.

## Agent behavior

The extension registers the seven delegation tools above when at least one valid identity exists.

Each owned agent opens in a new tab in the parent session's current Herdr workspace and uses the parent's working directory.
The extension does not create Git worktrees or prevent writes.
Its tool guidance makes delegation the default for separable bounded work that requires tool use, including small tasks and implementation.
The parent retains outcome framing, authoritative project context, cross-cutting decisions, synthesis, evidence checks, and user communication.
A delegated scope has one owner, and concurrent agents must not receive overlapping repository write scopes.

Default completion protocol: after `start_agent` or `send_agent` returns, do not call `wait_agents`.
Continue useful independent work.
If no independent work remains, finish the parent turn so the completion notification can resume it.
A normal task agent closes after it reports its result.
The assignment prompt asks the agent to lead with its result or recommendation and include applicable evidence, changed files, verification, uncertainty, and required action without forcing a fixed template.
Set `keep_open: true` when starting an agent to keep it as a persistent collaborator.
Sending a message to a closed agent resumes its Pi session in a new tab.
The extension reloads `config.json` and the selected identity file before it starts or resumes a child, so edits apply without reloading the parent Pi session.

Completion sends a hidden follow-up message to the parent and triggers a parent turn.
The parent receives the latest assistant text, subject to Pi's output limits.
If that text is truncated, the full child conversation remains in the recorded child session file but is not automatically loaded into the parent model context.
If the parent is active when an agent completes, the extension defers the follow-up until that parent turn settles.
`wait_agents` is an exceptional tool.
Use it only when one specific agent result is a prerequisite for an immediate next tool call in the current parent turn and neither yielding nor `collect_agents` can satisfy that dependency.
A task that needs a later final synthesis is not by itself a reason to preserve the current turn.
Do not use `wait_agents` to monitor progress, obtain a final response, or wait for later synthesis.
Calling `wait_agents` claims selected results, including deferred completions from the current parent turn, and suppresses their automatic notifications.
After `collect_agents` returns, do not call `wait_agents` for any assignment in that collection.
The collection notification supplies the grouped results.
If no immediate blocking tool call remains, finish the parent turn so the notification can resume it.
Canceling `wait_agents` does not stop its agents or lose their later completion notifications.
While `wait_agents` runs, its tool row reports the selected agents, completed agents, and agents that are still pending.

Calling `collect_agents` registers a nonblocking barrier for an exact fixed group of current assignments whose results require one synthesis, whether or not useful independent work remains.
It returns immediately, includes assignments that have already settled, suppresses pending individual notifications, and sends one hidden parent follow-up with the grouped results after all named assignments settle.
After registering a collection, continue useful work or finish the parent turn.
Do not call `wait_agents` for any assignment in the collection.
Successful, failed, blocked, and interrupted results all satisfy the barrier.
Pending collections survive a Pi extension reload.
An individual notification that was already delivered before collection registration cannot be retracted.

In TUI mode, a widget above the editor shows each live owned agent's status and marks agents whose results are claimed by a wait or collection.

Only the same parent Pi session can list or resume its owned agents.
Forked and unrelated Pi sessions do not adopt them.

## Child Pi environment

The extension resolves inherited resources before launch and passes explicit tool, extension, and skill lists to the child.
The child disables automatic extension, skill, and prompt-template discovery so its launch cannot add resources outside those resolved lists.
It still loads applicable repository `AGENTS.md` and `CLAUDE.md` context files.
It uses Pi's default coding prompt, with an optional identity body appended to it.

This controls Pi resources, not operating-system access.
A child with shell access can still start processes permitted by the operating system.

## Lifecycle

`/reload` keeps live owned-agent tabs open and reconnects tracking from parent-session entries.

Normal parent exit, `/new`, `/resume`, `/fork`, and `/clone` close live owned-agent tabs.
Child Pi session files remain available for same-parent resumption under `~/.pi/agent/pi-herdr-agents/sessions/`.
An active assignment is interrupted when its parent exits or changes sessions.

Hard crashes, `SIGKILL`, Herdr failure, and power loss cannot run graceful cleanup.
Crash recovery and orphan-tab cleanup are outside the initial version.
