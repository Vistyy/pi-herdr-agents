# pi-herdr-agents

`@vistyy/pi-herdr-agents` gives a Pi session owned, resumable agents in separate tabs of its current Herdr workspace.

An **agent identity** is global configuration that defines when an agent is useful, its runtime settings, its allowed resources, and its role instructions.

An **owned agent** is a resumable Pi session created from an agent identity and owned by one parent Pi session.

## Requirements

- Pi 0.84.1 or newer.
- A current Herdr session with `HERDR_ENV=1`.
- The `herdr` executable in `PATH`.

The extension is inactive outside Herdr.
It does not fall back to unmanaged child processes.

## Install

Install a published version:

```sh
pi install npm:@vistyy/pi-herdr-agents
```

Install a local checkout:

```sh
pi install /absolute/path/to/pi-herdr-agents
```

Run `/reload` after changing configuration.

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
    "tools": ["read", "bash", "web_search", "web_fetch"],
    "extensions": ["~/.pi/agent/extensions/web-search"],
    "skills": ["~/.pi/agent/skills/verification"]
  }
}
```

`maxAgents` defaults to `10`.
An invalid global configuration disables the extension and reports an error.

List settings use replacement semantics.
An identity list replaces the corresponding global list.
An empty list permits none.
If both the identity and global default omit a list, the child receives none of that resource type.

Scalar settings use identity, then global default, then parent-session values.
The scalar settings are `provider`, `model`, and `thinking`.

Relative extension and skill paths in `config.json` resolve from the configuration directory.
Relative paths in an identity resolve from that identity file's directory.
A leading `~/` resolves from the home directory.

### Agent identity

```md
---
name: reviewer
description: Reviews a bounded concern when independent analysis can reduce the parent session's context load.
provider: openai-codex
model: gpt-5.6-sol
thinking: medium
tools:
  - read
  - bash
skills:
  - ~/.pi/agent/skills/verification
extensions: []
---

Review the assigned concern within its stated scope.
Return actionable findings and state material uncertainty.
```

The `name` must match `[a-z][a-z0-9_-]{0,63}`.
The `description` tells the parent when and why to invoke the identity.
The Markdown body is appended to Pi's default coding prompt.

An invalid identity is disabled without disabling other valid identities.
The extension reports each invalid identity during session startup.

## Agent behavior

The extension registers these tools when at least one valid identity exists:

- `start_agent`
- `send_agent`
- `wait_agents`
- `list_agents`
- `interrupt_agent`
- `close_agent`

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

## Resource isolation

Child Pi sessions disable automatic extension, skill, and prompt-template discovery.
They load only the extensions and skills selected by their identity or global defaults.
They still load applicable repository `AGENTS.md` and `CLAUDE.md` files.
The child explicitly selects Pi's default coding prompt, so discovered `SYSTEM.md` files cannot replace it.

The child cannot load this delegation extension or the global Herdr skill through identity configuration.
A global default that names either resource disables the extension.
An identity that names either resource is disabled.

This is resource isolation, not an operating-system sandbox.
A child with shell access can still start processes permitted by the operating system.

## Lifecycle

`/reload` keeps live owned-agent tabs open and reconnects tracking from parent-session entries.

Normal parent exit, `/new`, `/resume`, `/fork`, and `/clone` close live owned-agent tabs.
Child Pi session files remain available for same-parent resumption.
An active assignment is interrupted when its parent exits or changes sessions.

Hard crashes, `SIGKILL`, Herdr failure, and power loss cannot run graceful cleanup.
Crash recovery and orphan-tab cleanup are outside the initial version.
