import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, test } from "node:test";
import {
  createSlotRelayClient,
  handleSlotRelayRequest,
  SLOT_BROADCAST_PATH,
  SLOT_ONLINE_PATH,
  SLOT_RELAY_MAX_UIDS,
} from "../deploy/slotRelay.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(handler: RequestListener): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function rawPost(port: number, path: string, secret: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(data.length),
        "x-oc-egress-secret": secret,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

function relayServer(secret: string, online: Set<string>, sent: Array<{ uids: string[]; payload: unknown }>) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (!handleSlotRelayRequest(req, res, {
      secret,
      local: {
        onlineUserSubset: (uids) => uids.filter((uid) => online.has(uid)),
        broadcastToUsers: (uids, payload) => {
          sent.push({ uids, payload });
          return uids.filter((uid) => online.has(uid)).length;
        },
      },
    })) {
      res.statusCode = 404;
      res.end();
    }
  };
}

describe("slot relay", () => {
  test("鉴权、uid 校验与本槽 deliveredUids", async () => {
    const sent: Array<{ uids: string[]; payload: unknown }> = [];
    const port = await listen(relayServer("secret", new Set(["1", "3"]), sent));
    assert.equal((await rawPost(port, SLOT_ONLINE_PATH, "bad", { uids: ["1"] })).status, 401);
    assert.equal((await rawPost(port, SLOT_ONLINE_PATH, "secret", { uids: ["x"] })).status, 400);
    const online = await rawPost(port, SLOT_ONLINE_PATH, "secret", { uids: ["1", "2", "3"] });
    assert.deepEqual(online, { status: 200, body: { ok: true, deliveredUids: ["1", "3"] } });
    const broadcast = await rawPost(port, SLOT_BROADCAST_PATH, "secret", {
      uids: ["1", "2", "3"], payload: { type: "sys.incident" },
    });
    assert.deepEqual(broadcast.body, { ok: true, deliveredUids: ["1", "3"] });
    assert.equal(sent.length, 3, "服务端逐 uid 确认至少一个 OPEN WS 后才回 delivered");
  });

  test("A/B 并行查询与投递返回 uid 并集，peer down 视为空", async () => {
    const sentA: Array<{ uids: string[]; payload: unknown }> = [];
    const sentB: Array<{ uids: string[]; payload: unknown }> = [];
    const portA = await listen(relayServer("secret", new Set(["1", "2"]), sentA));
    const portB = await listen(relayServer("secret", new Set(["2", "3"]), sentB));
    const client = createSlotRelayClient({ secret: "secret", ports: [portA, portB], requestTimeoutMs: 200, totalBudgetMs: 500 });
    assert.deepEqual((await client.onlineUserSubset(["1", "2", "3", "4"])).sort(), ["1", "2", "3"]);
    assert.deepEqual((await client.broadcastToUsers(["1", "2", "3", "4"], { ok: true })).sort(), ["1", "2", "3"]);
    assert.ok(sentA.length > 0 && sentB.length > 0);

    const peerDown = createSlotRelayClient({ secret: "secret", ports: [portA, 9], requestTimeoutMs: 50, totalBudgetMs: 150 });
    assert.deepEqual((await peerDown.onlineUserSubset(["1", "3"])).sort(), ["1"]);
  });

  test("cost broadcast 在仅候选槽持有 WS 时仍投递到候选槽", async () => {
    const sentA: Array<{ uids: string[]; payload: unknown }> = [];
    const sentB: Array<{ uids: string[]; payload: unknown }> = [];
    const portA = await listen(relayServer("secret", new Set(), sentA));
    const portB = await listen(relayServer("secret", new Set(["247"]), sentB));
    const client = createSlotRelayClient({
      secret: "secret",
      ports: [portA, portB],
      requestTimeoutMs: 200,
      totalBudgetMs: 500,
    });
    const payload = {
      type: "outbound.cost_charged",
      requestId: "candidate-deepseek",
      costCredits: "5",
    };

    assert.deepEqual(await client.broadcastToUsers(["247"], payload), ["247"]);
    assert.equal(sentA.length, 1);
    assert.equal(sentB.length, 1);
    assert.deepEqual(sentB[0], { uids: ["247"], payload });
  });

  test("half-open peer 在预算内主动终止；4096 audience 上限 fail-closed", async () => {
    const halfOpenPort = await listen((_req, _res) => { /* 故意不响应 */ });
    const client = createSlotRelayClient({ secret: "secret", ports: [halfOpenPort], requestTimeoutMs: 50, totalBudgetMs: 120 });
    const started = Date.now();
    assert.deepEqual(await client.onlineUserSubset(["1"]), []);
    assert.ok(Date.now() - started < 500, "half-open 不得拖住 approval/drain");
    await assert.rejects(
      () => client.onlineUserSubset(Array.from({ length: SLOT_RELAY_MAX_UIDS + 1 }, (_, i) => String(i + 1))),
      /out-of-range/,
    );
  });
});
