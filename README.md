# pi-herdr-agents

`@vistyy/pi-herdr-agents` gives a Pi session owned, resumable agents in separate tabs of its current Herdr workspace.

An **agent identity** is global configuration that describes when an agent is useful and can customize its runtime settings, inherited resources, and role instructions.

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
pi install git:github.com/Vistyy/pi-herdr-agents@v0.2.0
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

- `start_agents`
- `send_agents`
- `list_agents`
- `interrupt_agent`
- `close_agent`

Filters cannot force-include these resources.
This keeps parent-only delegation policy and controls out of child prompts.

## Agent behavior

The extension registers the five delegation tools above when at least one valid identity exists.

Each owned agent opens in a new tab in the parent session's current Herdr workspace and uses the parent's working directory.
The extension does not create Git worktrees or enforce read-only access.
Its tool guidance delegates bounded read-only work only when doing so provides a material benefit.
The parent retains implementation, mutation, outcome framing, cross-cutting decisions, synthesis, evidence checks, and user communication.
A delegated investigation has one owner, and concurrent scopes do not overlap unless independent corroboration is intentional.
Each assignment states one requested result, relevant starting anchors, known constraints, a stopping condition, and the evidence the parent needs.

Each `start_agents` call dispatches one fixed batch of assignments.
A batch contains one or more assignments and produces one grouped completion notification after every assignment settles.
Put assignments that require one synthesis in the same call.
Continue useful independent work after dispatch.
If no independent work remains, finish the parent turn so the batch completion notification can resume it.
A normal task agent closes after it reports its result.
Every child receives a mandatory read-only boundary after any profile-specific instructions.
It must stop and report when continuing requires a guess, hidden uncertainty, broader scope, mutation, or a parent decision.
This includes asking which source controls when conflicting evidence has no established authority.
A complete result, partial evidence with a limitation, and a clear stopped report are all valid outcomes.
The assignment user message contains the task-specific scope, acceptance criteria, stopping condition, and output requirements.
Set `keep_open: true` when starting an agent to keep it as a persistent collaborator.

`send_agents` steers active assignments without creating a new batch.
If the previous assignments have settled, the messages start the next assignments as one new fixed batch.
Do not mix active guidance and new assignments in one call.
A one-agent call is valid.
`interrupt_agent` sends Pi's Escape interrupt key, then waits for settlement with a bounded timeout.
If Herdr still reports the child as working or unknown, the extension preserves the tab and session, retains the assignment lock, and continues reconciliation in the background.
Sending a message to a closed agent resumes its Pi session in a new tab.
The extension reloads `config.json` and the selected identity file before it starts or resumes a child, so edits apply without reloading the parent Pi session.

Batch completion sends one hidden follow-up message to the parent and triggers a parent turn.
The grouped message contains the latest assistant text from every assignment in that batch, subject to Pi's output limits.
If text is truncated, the full child conversation remains in the recorded child session file but is not automatically loaded into the parent model context.
If the parent is active when the batch settles, the extension defers the follow-up until that parent turn settles.
Successful, failed, blocked, and interrupted results all settle their batch member.
Pending batches survive a Pi extension reload.

In TUI mode, a widget above the editor shows each live owned agent's status and marks assignments whose completion belongs to a pending batch.

Only the same parent Pi session can list or resume its owned agents.
Forked and unrelated Pi sessions do not adopt them.

## Child Pi environment

The extension resolves inherited resources before launch and passes explicit tool, extension, and skill lists to the child.
The child disables automatic extension, skill, and prompt-template discovery so its launch cannot add resources outside those resolved lists.
It still loads applicable repository `AGENTS.md` and `CLAUDE.md` context files.
It uses Pi's default coding prompt, followed by the common task instructions, any profile-specific identity body, and the mandatory read-only boundary.
Frontmatter-only identities omit only the profile-specific section.
The assignment is sent separately as a user message.

This controls Pi resources and provides prompt guidance, not operating-system access or filesystem enforcement.
A child with shell access can still start processes permitted by the operating system, so the read-only boundary is not a security sandbox.

## Lifecycle

`/reload` keeps live owned-agent tabs open and reconnects tracking from parent-session entries.

Normal parent exit, `/new`, `/resume`, `/fork`, and `/clone` close live owned-agent tabs.
Child Pi session files remain available for same-parent resumption under `~/.pi/agent/pi-herdr-agents/sessions/`.
An active assignment is interrupted when its parent exits or changes sessions.

Hard crashes, `SIGKILL`, Herdr failure, and power loss cannot run graceful cleanup.
Crash recovery and orphan-tab cleanup are outside the initial version.
