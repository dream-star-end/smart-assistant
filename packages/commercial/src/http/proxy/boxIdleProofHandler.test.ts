import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { IdentityError } from "../../auth/proxyIdentity.js";
import { makeBoxIdleProofHandler } from "./boxIdleProofHandler.js";

const turn = { session_id: "ccb-session", oc_turn_key: "a".repeat(64) };

async function invoke(deps: Parameters<typeof makeBoxIdleProofHandler>[0],
  body: unknown = turn, path = "/internal/box/idle-proof"):
  Promise<{ status: number; result: Record<string, unknown> }> {
  const handler = makeBoxIdleProofHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res, { hostUuid: "selfhost-test", boundIp: "127.0.0.1" })
      .catch(() => { res.statusCode = 500; res.end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, result: await response.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("idle proof uses container identity and rejects client rows", async () => {
  let seen: unknown;
  const ok = await invoke({
    identity: { resolve: async () => ({ uid: 3n, containerId: 7n }) } as never,
    journal: { readIdleProof: async (input: unknown) => {
      seen = input;
      return { status: "pending", reason: "unsettled" };
    } } as never,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.result, { status: "pending", reason: "unsettled" });
  assert.deepEqual(seen, { uid: 3n, containerId: 7n, sessionId: turn.session_id, turnKey: turn.oc_turn_key });
  const extra = await invoke({
    identity: { resolve: async () => ({ uid: 3n, containerId: 7n }) } as never,
    journal: { readIdleProof: async () => { throw new Error("should not query"); } } as never,
  }, { ...turn, rows: [], terminal: true });
  assert.equal(extra.status, 400);
  assert.equal((await invoke({
    identity: { resolve: async () => { throw new IdentityError("BAD", "hidden"); } } as never,
    journal: { readIdleProof: async () => ({ status: "not_found" }) } as never,
  })).status, 401);
  assert.equal((await invoke({
    identity: { resolve: async () => ({ uid: 3n, containerId: null, apiKey: { id: 1n } }) } as never,
    journal: { readIdleProof: async () => ({ status: "not_found" }) } as never,
  })).status, 403);
});
