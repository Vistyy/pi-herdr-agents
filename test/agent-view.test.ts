import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OwnedAgentViewController } from "../src/agent-view.js";
import {
  HERDR_METADATA_SOURCE,
  HerdrSocketClient,
  HERDR_OWNED_TOKEN,
  type AgentViewState,
} from "../src/herdr.js";

async function withSocketPayload(payload: string, run: (client: HerdrSocketClient) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-view-frame-"));
  const socketPath = join(root, "herdr.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", () => socket.end(payload));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await run(new HerdrSocketClient(socketPath));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

class FakeViewApi {
  readonly calls: Array<{ method: string; source?: string }> = [];
  clearResult: AgentViewState = { active: false };
  setResult: AgentViewState = { active: true, source: HERDR_METADATA_SOURCE };

  async clearAgentView(source: string): Promise<AgentViewState> {
    this.calls.push({ method: "clear", source });
    return this.clearResult;
  }

  async setOwnedAgentView(): Promise<AgentViewState> {
    this.calls.push({ method: "set" });
    return this.setResult;
  }
}

test("does not replace another source's active sidebar projection", async () => {
  const api = new FakeViewApi();
  api.clearResult = { active: true, source: "other.extension" };
  const controller = new OwnedAgentViewController(api);

  await assert.rejects(controller.install(), /owned by another source/);
  assert.deepEqual(api.calls, [{ method: "clear", source: HERDR_METADATA_SOURCE }]);
});

test("clears after a set request fails without a response", async () => {
  const api = new FakeViewApi();
  api.setOwnedAgentView = async function(this: FakeViewApi) {
    this.calls.push({ method: "set" });
    throw new Error("socket lost");
  };
  const controller = new OwnedAgentViewController(api);

  await assert.rejects(controller.install(), /may have succeeded without a response/);
  await controller.clearOwned();
  assert.deepEqual(api.calls, [
    { method: "clear", source: HERDR_METADATA_SOURCE },
    { method: "set" },
    { method: "clear", source: HERDR_METADATA_SOURCE },
  ]);
});

test("clears after a malformed successful set response", async () => {
  const api = new FakeViewApi();
  api.setResult = { active: true };
  const controller = new OwnedAgentViewController(api);

  await assert.rejects(controller.install(), /ownership may still have succeeded/);
  await controller.clearOwned();
  assert.deepEqual(api.calls, [
    { method: "clear", source: HERDR_METADATA_SOURCE },
    { method: "set" },
    { method: "clear", source: HERDR_METADATA_SOURCE },
  ]);
});

test("replaces its own projection and clears only its source", async () => {
  const api = new FakeViewApi();
  api.clearResult = { active: true, source: HERDR_METADATA_SOURCE };
  const controller = new OwnedAgentViewController(api);

  await controller.install();
  await controller.clearOwned();
  assert.deepEqual(api.calls, [
    { method: "clear", source: HERDR_METADATA_SOURCE },
    { method: "set" },
    { method: "clear", source: HERDR_METADATA_SOURCE },
  ]);
});

test("processes Herdr error frames before request-ID filtering", async () => {
  const payload = JSON.stringify({ id: "", error: { code: "other_source", message: "view conflict" } }) + "\n";
  await withSocketPayload(payload, async (client) => {
    await assert.rejects(client.setOwnedAgentView(), /other_source.*view conflict/);
  });
});

test("rejects non-object JSON frames", async () => {
  await withSocketPayload("[]\n", async (client) => {
    await assert.rejects(client.setOwnedAgentView(), /non-object frame/);
  });
});

test("rejects an oversized individual frame before the timeout", async () => {
  await withSocketPayload(`${"x".repeat(64 * 1024 + 1)}\n`, async (client) => {
    await assert.rejects(client.setOwnedAgentView(), /frame exceeded 65536 bytes/);
  });
});

test("rejects an oversized pending buffer before the timeout", async () => {
  await withSocketPayload("x".repeat(128 * 1024 + 1), async (client) => {
    await assert.rejects(client.setOwnedAgentView(), /pending buffer exceeded 131072 bytes/);
  });
});

test("uses the documented newline-delimited raw socket API", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-view-"));
  const socketPath = join(root, "herdr.sock");
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      for (const line of chunk.trim().split("\n")) {
        const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
        requests.push(request);
        socket.write(JSON.stringify({
          id: request.id,
          result: { type: "agent_view", active: true, source: HERDR_METADATA_SOURCE },
        }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    const client = new HerdrSocketClient(socketPath);
    await client.setOwnedAgentView();
    assert.deepEqual(requests[0]?.method, "agent.view.set");
    assert.deepEqual(requests[0]?.params, {
      source: HERDR_METADATA_SOURCE,
      filter: {
        op: "not",
        filter: { op: "exists", field: { token: HERDR_OWNED_TOKEN } },
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
