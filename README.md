# pi-herdr-agents

`@vistyy/pi-herdr-agents` provides a Pi session with owned, resumable read-only helpers in separate tabs of its current Herdr workspace.

A temporary helper performs one small, explicitly bounded supporting task and returns evidence for its parent to evaluate.
The parent retains the overall investigation, consequential judgment, synthesis, and user communication.

An **agent identity** is global configuration that describes a helper's narrow role and can customize its runtime settings, inherited resources, and role instructions.

An **owned agent** is a resumable helper Pi session created from an agent identity and owned by one parent Pi session.

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
pi install git:github.com/Vistyy/pi-herdr-agents@v0.2.4
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
    └── helper.md
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
name: helper
description: Checks one small, explicitly bounded question and returns evidence for parent evaluation.
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

Each owned helper opens in a new tab in the parent session's current Herdr workspace and uses the parent's working directory.
The extension does not create Git worktrees or enforce read-only access.
When an investigation, explanation, feasibility judgment, or plan needs source-local evidence, the parent identifies its unknowns without reading the sources that answer them.
It gives each helper exactly one factual question about how a specific component, operation, invariant, or source relationship behaves.
It partitions a batch by behavior or claim, not into implementation, test, and documentation branches.
A helper does not receive bundled concerns or assess, review, find material gaps, plan, or recommend.
The parent retains the overall investigation, plan, design choice, final recommendation, implementation, final verification, consequential decisions, synthesis, and user communication.
Concurrent helper scopes do not overlap unless independent corroboration is intentional.
Each assignment contains the requested result, relevant starting anchors and constraints, and a stopping condition when one is useful.

Each `start_agents` call dispatches one fixed batch of assignments.
A batch contains one or more supporting assignments and produces one grouped completion notification after every assignment settles.
A batch groups helpers started together and does not transfer synthesis to them.
Use multiple helpers only for non-overlapping local questions or intentional independent corroboration.
After dispatch returns, the parent does not call another tool or inspect any source.
It finishes the turn immediately so the batch completion notification can resume it.
A normal helper closes after it reports its evidence.
Every child receives a mandatory read-only boundary after any profile-specific instructions.
If its task requires a state change, it reports that limitation and stops.
The assignment user message defines the task-specific behavior and output.
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
The message tells the parent to evaluate and connect the evidence itself instead of merely repeating the reports.
The grouped message contains the latest assistant text from every assignment in that batch, subject to Pi's output limits.
If text is truncated, the full child conversation remains in the recorded child session file but is not automatically loaded into the parent model context.
If the parent is active when the batch settles, the extension defers the follow-up until that parent turn settles.
Successful, failed, blocked, and interrupted results all settle their batch member.
Pending batches survive a Pi extension reload.

In TUI mode, a concise widget above the editor shows agents with active or blocked work.
Use `list_agents` when you need identity, assignment, status, or resumability details.

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
