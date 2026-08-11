# pi-herdr-agents

`@vistyy/pi-herdr-agents` gives a Pi session owned, resumable agents in separate tabs of its current Herdr workspace.

An **agent identity** is global configuration that describes when an agent is useful and can customize its runtime settings, inherited resources, and role instructions.

An **owned agent** is a resumable Pi session created from an agent identity and owned by one parent Pi session.

## Requirements

- Pi 0.84.1 or newer.
- A current Herdr session with `HERDR_ENV=1`.
- The `herdr` executable in `PATH`.

The extension is inactive outside Herdr.
It does not fall back to unmanaged child processes.

## Install

Install a released version from GitHub:

```sh
pi install git:github.com/Vistyy/pi-herdr-agents@v0.1.1
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
    "thinking": "medium",
    "skills": ["!session-routing"]
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

The delegation extension, the global `herdr` skill, and these delegation tools are always excluded from children:

- `start_agent`
- `send_agent`
- `wait_agents`
- `list_agents`
- `interrupt_agent`
- `close_agent`

Filters cannot force-include these resources.

## Agent behavior

The extension registers the six delegation tools above when at least one valid identity exists.

Each owned agent opens in a new tab in the parent session's current Herdr workspace and uses the parent's working directory.
The extension does not create Git worktrees or prevent writes.
Its tool guidance recommends owned agents for research, review, and other mostly non-mutating work.
It prefers the parent session's But Why workflow for repository implementation when But Why is available.

A normal task agent closes after it reports its result.
Set `keep_open: true` when starting an agent to keep it as a persistent collaborator.
Sending a message to a closed agent resumes its Pi session in a new tab.

Completion sends a follow-up message to the parent and triggers a parent turn.
Calling `wait_agents` before completion claims the selected results and suppresses that automatic notification.

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
