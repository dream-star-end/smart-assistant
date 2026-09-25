import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { IdentityError } from "../../auth/proxyIdentity.js";
import { BoxDurableJournalError } from "./boxDurableJournal.js";
import { makeBoxUserStopHandler } from "./boxUserStopHandler.js";

const turn = { session_id: "web-stop-session", oc_turn_key: "a".repeat(64) };
const run = { requestId: "box-leaf", uid: 3n, accountId: 20n,
  runNonce: "b".repeat(24), leaseEpoch: "c".repeat(32) };

async function invoke(deps: Parameters<typeof makeBoxUserStopHandler>[0],
  body: unknown = turn): Promise<{ status: number; result: Record<string, unknown> }> {
  const handler = makeBoxUserStopHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res, { hostUuid: "selfhost-test", boundIp: "127.0.0.1" })
      .catch(() => { res.statusCode = 500; res.end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/internal/box/stop`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status,
      result: await response.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("authenticated container turn resolves server-owned run before stop", async () => {
  const calls: string[] = [];
  const result = await invoke({
    identity: { resolve: async () => { calls.push("auth");
      return { uid: 3n, containerId: 7n }; } } as never,
    journal: { findCancelableRun: async (input: { uid: bigint;
      containerId: bigint; sessionId: string; turnKey: string }) => {
      calls.push("lookup"); assert.equal(input.uid, 3n);
      assert.equal(input.containerId, 7n);
      assert.equal(input.sessionId, turn.session_id);
      assert.equal(input.turnKey, turn.oc_turn_key); return run;
    } } as never,
    coordinator: { requestStop: async (input: unknown) => {
      calls.push("stop"); assert.deepEqual(input, run); return "stopped_proven";
    } } as never,
  });
  assert.deepEqual(result, { status: 200, result: { status: "stopped" } });
  assert.deepEqual(calls, ["auth", "lookup", "stop"]);
});

test("bad auth, API key, malformed turn and wrong container fail before remote stop", async () => {
  let remote = 0;
  const coordinator = { requestStop: async () => { remote++; return "stopped_proven"; } } as never;
  const journal = { findCancelableRun: async () => run } as never;
  assert.equal((await invoke({ identity: { resolve: async () => {
    throw new IdentityError("BAD_SECRET", "private detail");
  } } as never, journal, coordinator })).status, 401);
  assert.equal((await invoke({ identity: { resolve: async () => ({ uid: 3n,
    containerId: null, apiKey: { id: 1n } }) } as never,
    journal, coordinator })).status, 403);
  assert.equal((await invoke({ identity: { resolve: async () => ({ uid: 3n,
    containerId: 7n }) } as never, journal, coordinator },
    { ...turn, extra: true })).status, 400);
  assert.equal((await invoke({ identity: { resolve: async () => ({ uid: 3n,
    containerId: 7n }) } as never,
    journal: { findCancelableRun: async () => {
      throw new BoxDurableJournalError("BOX_CANCEL_RUN_UNKNOWN");
    } } as never, coordinator })).status, 404);
  assert.equal(remote, 0);
});
