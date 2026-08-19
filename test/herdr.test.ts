import assert from "node:assert/strict";
import test from "node:test";
import { buildPiArgs, HerdrClient, HERDR_OWNED_TOKEN, type CommandRunner } from "../src/herdr.js";

test("buildPiArgs disables discovery and replaces resource lists", () => {
  const args = buildPiArgs({
    settings: {
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "medium",
      tools: ["read", "bash"],
      extensions: ["/ext/a.ts"],
      skills: ["/skills/review"],
    },
    instructions: "Review carefully.",
    sessionFile: "/state/sessions/session-id.jsonl",
    sessionName: "review",
  });

  assert.deepEqual(args, [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--system-prompt",
    "",
    "--extension",
    "/ext/a.ts",
    "--skill",
    "/skills/review",
    "--tools",
    "read,bash",
    "--provider",
    "openai-codex",
    "--model",
    "gpt-5.6-sol",
    "--thinking",
    "medium",
    "--append-system-prompt",
    "Review carefully.",
    "--name",
    "review",
    "--session",
    "/state/sessions/session-id.jsonl",
  ]);
});

test("buildPiArgs omits an appended prompt file when none is supplied", () => {
  const args = buildPiArgs({
    settings: { tools: ["read"] },
    sessionFile: "/session.jsonl",
    sessionName: "fast",
  });

  assert.equal(args.includes("--append-system-prompt"), false);
});

test("buildPiArgs preserves an explicit provider when the model ID contains a slash", () => {
  const args = buildPiArgs({
    settings: { provider: "openrouter", model: "openai/o1", tools: [] },
    instructions: "/prompt.md",
    sessionFile: "/session.jsonl",
    sessionName: "review",
  });
  assert.deepEqual(args.slice(args.indexOf("--provider"), args.indexOf("--append-system-prompt")), [
    "--provider", "openrouter", "--model", "openai/o1",
  ]);
});

test("reports a display agent through distinct display-only metadata", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (_command, args) => {
    calls.push(args);
    return { code: 0, stderr: "", stdout: "" };
  };
  const client = new HerdrClient(run);

  await client.reportDisplayAgent("w1:p2", "review");

  assert.deepEqual(calls, [[
    "pane", "report-metadata", "w1:p2",
    "--source", "pi-herdr-agents",
    "--agent", "pi",
    "--applies-to-source", "herdr:pi",
    "--display-agent", "review",
    "--token", `${HERDR_OWNED_TOKEN}=1`,
  ]]);
});

test("waitForTurn observes a post-prompt state change before waiting for settlement", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (_command, args) => {
    calls.push(args);
    const status = args[1] === "get" ? "working" : "done";
    const sequence = args[1] === "get" ? 6 : 7;
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ result: { agent: {
        pane_id: "w1:p2",
        tab_id: "w1:t2",
        workspace_id: "w1",
        agent_status: status,
        state_change_seq: sequence,
      } } }),
    };
  };
  const client = new HerdrClient(run);
  const settled = await client.waitForTurn("w1:p2", 5);
  assert.equal(settled.agent_status, "done");
  assert.deepEqual(calls, [
    ["agent", "get", "w1:p2"],
    ["agent", "wait", "w1:p2"],
  ]);
});

test("startPi retries the determinate busy-pane response", async () => {
  let attempts = 0;
  const run: CommandRunner = async () => {
    attempts += 1;
    if (attempts === 1) {
      return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "agent_pane_busy", message: "not ready" } }) };
    }
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ result: { agent: {
        pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "idle",
      } } }),
    };
  };
  const client = new HerdrClient(run);
  const agent = await client.startPi("owned", "w1:p2", ["--no-tools"]);
  assert.equal(agent.pane_id, "w1:p2");
  assert.equal(attempts, 2);
});

test("HerdrClient uses explicit workspace and returned IDs", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (_command, args) => {
    calls.push(args);
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        result: {
          tab: { tab_id: "w1:t2" },
          root_pane: { pane_id: "w1:p2" },
        },
      }),
    };
  };
  const client = new HerdrClient(run);
  const tab = await client.createTab("w1", "/repo", "review");
  assert.deepEqual(tab, { tabId: "w1:t2", paneId: "w1:p2" });
  assert.deepEqual(calls[0], [
    "tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "review", "--no-focus",
  ]);
});
