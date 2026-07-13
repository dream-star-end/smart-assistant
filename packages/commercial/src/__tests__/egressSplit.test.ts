/**
 * Egress 进程解耦(2026-07-02)— 三个安全/正确性关键面:
 *   1. CostEventSink:FIFO 保序、失败重试不丢、TTL 过期丢弃。
 *   2. internalCostEvent handler:秘钥缺失 503 / 错误 401 / 正确才 apply。
 *   3. forwarder:/internal/v5/* 控制专用路径拒转(容器伪造控制调用的第一道闸)。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";

import { CostEventSink } from "../egress/costEventSink.js";
import { makeCostEventHandler, COST_EVENT_PATH, EGRESS_SECRET_HEADER } from "../http/internalCostEvent.js";
import { makeForwarder } from "../egress/forwarder.js";

// ─── CostEventSink ──────────────────────────────────────────────────────────

describe("CostEventSink — FIFO 保序 + 失败重试", () => {
  test("先 persist 后 broadcast,批内顺序与入队一致", async () => {
    const batches: unknown[][] = [];
    const fakeFetcher = (async (_url: string, opts: { body?: unknown }) => {
      batches.push(JSON.parse(String(opts.body)).events);
      return { statusCode: 200, body: { text: async () => "{}" } };
    }) as never;
    const sink = new CostEventSink({ controlBaseUrl: "http://x", secret: "s".repeat(16), fetcher: fakeFetcher });
    sink.enqueue({ kind: "persist", requestId: "r1", uid: "7", costCredits: "3", sessionId: null });
    sink.enqueue({ kind: "broadcast", uid: "7", payload: { type: "outbound.cost_charged" } });
    await sink.flush();
    assert.equal(sink.pending, 0);
    const flat = batches.flat() as Array<{ kind: string }>;
    assert.deepEqual(flat.map((e) => e.kind), ["persist", "broadcast"], "顺序必须 persist→broadcast");
  });

  test("master 不可达 → 留队列;恢复后重试成功", async () => {
    let fail = true;
    const sent: unknown[] = [];
    const fakeFetcher = (async (_url: string, opts: { body?: unknown }) => {
      if (fail) throw new Error("ECONNREFUSED");
      sent.push(...JSON.parse(String(opts.body)).events);
      return { statusCode: 200, body: { text: async () => "{}" } };
    }) as never;
    const sink = new CostEventSink({ controlBaseUrl: "http://x", secret: "s".repeat(16), fetcher: fakeFetcher });
    sink.enqueue({ kind: "persist", requestId: "r1", uid: "7", costCredits: "3", sessionId: null });
    await sink.flush();
    assert.equal(sink.pending, 1, "失败必须留队列");
    fail = false;
    await sink.flush();
    assert.equal(sink.pending, 0, "恢复后清空");
    assert.equal(sent.length, 1);
    sink.stop();
  });

  test("超过 TTL 的事件被丢弃(尽力而为语义)", async () => {
    let t = 1_000_000;
    const fakeFetcher = (async () => {
      throw new Error("down");
    }) as never;
    const sink = new CostEventSink({
      controlBaseUrl: "http://x",
      secret: "s".repeat(16),
      fetcher: fakeFetcher,
      now: () => t,
    });
    sink.enqueue({ kind: "persist", requestId: "r1", uid: "7", costCredits: "3", sessionId: null });
    await sink.flush();
    assert.equal(sink.pending, 1);
    t += 121_000; // 越过 120s TTL
    await sink.flush();
    assert.equal(sink.pending, 0, "过期事件必须被丢弃");
    sink.stop();
  });
});

// ─── CostEventSink health counters(D3④ finalize 门槛差分)─────────────────────

describe("CostEventSink — health 单调计数器", () => {
  test("初始全零;成功发送 → enqueued==sent,无 drop,oldestPendingAgeMs=0", async () => {
    const okFetcher = (async () => ({ statusCode: 200, body: { text: async () => "{}" } })) as never;
    const sink = new CostEventSink({ controlBaseUrl: "http://x", secret: "s".repeat(16), fetcher: okFetcher });
    let c = sink.healthCounters();
    assert.deepEqual(
      {
        pendingCostEvents: c.pendingCostEvents,
        enqueuedTotal: c.enqueuedTotal,
        sentTotal: c.sentTotal,
        expiredDropsTotal: c.expiredDropsTotal,
        overflowDropsTotal: c.overflowDropsTotal,
        oldestPendingAgeMs: c.oldestPendingAgeMs,
      },
      { pendingCostEvents: 0, enqueuedTotal: 0, sentTotal: 0, expiredDropsTotal: 0, overflowDropsTotal: 0, oldestPendingAgeMs: 0 },
    );
    sink.enqueue({ kind: "persist", requestId: "r1", uid: "7", costCredits: "3", sessionId: null });
    sink.enqueue({ kind: "broadcast", uid: "7", payload: { type: "outbound.cost_charged" } });
    await sink.flush();
    c = sink.healthCounters();
    assert.equal(c.enqueuedTotal, 2);
    assert.equal(c.sentTotal, 2);
    assert.equal(c.pendingCostEvents, 0);
    assert.equal(c.expiredDropsTotal, 0);
    assert.equal(c.overflowDropsTotal, 0);
    assert.equal(c.oldestPendingAgeMs, 0);
    sink.stop();
  });

  test("发送失败 → pending 保留,oldestPendingAgeMs 反映队首等待时长", async () => {
    let t = 1_000;
    const failFetcher = (async () => {
      throw new Error("down");
    }) as never;
    const sink = new CostEventSink({
      controlBaseUrl: "http://x",
      secret: "s".repeat(16),
      fetcher: failFetcher,
      now: () => t,
    });
    sink.enqueue({ kind: "persist", requestId: "r1", uid: "7", costCredits: "3", sessionId: null });
    await sink.flush();
    t = 1_500;
    const c = sink.healthCounters();
    assert.equal(c.enqueuedTotal, 1);
    assert.equal(c.sentTotal, 0);
    assert.equal(c.pendingCostEvents, 1);
    assert.equal(c.oldestPendingAgeMs, 500);
    sink.stop();
  });

  test("TTL 过期丢弃 → expiredDropsTotal 计数", async () => {
    let t = 1_000_000;
    const failFetcher = (async () => {
      throw new Error("down");
    }) as never;
    const sink = new CostEventSink({
      controlBaseUrl: "http://x",
      secret: "s".repeat(16),
      fetcher: failFetcher,
      now: () => t,
    });
    sink.enqueue({ kind: "persist", requestId: "r1", uid: "7", costCredits: "3", sessionId: null });
    await sink.flush();
    t += 121_000; // 越过 120s TTL
    await sink.flush();
    const c = sink.healthCounters();
    assert.equal(c.pendingCostEvents, 0);
    assert.equal(c.expiredDropsTotal, 1);
    assert.equal(c.sentTotal, 0);
    sink.stop();
  });

  test("队列上限溢出丢最老 → overflowDropsTotal 计数(enqueuedTotal 仍单调计全量)", () => {
    const failFetcher = (async () => {
      throw new Error("down");
    }) as never;
    const sink = new CostEventSink({ controlBaseUrl: "http://x", secret: "s".repeat(16), fetcher: failFetcher });
    // MAX_QUEUE=2000;入队 2001 触发一次溢出丢弃(同步发生在 enqueue)。
    for (let i = 0; i < 2001; i++) {
      sink.enqueue({ kind: "persist", requestId: `r${i}`, uid: "7", costCredits: "1", sessionId: null });
    }
    const c = sink.healthCounters();
    assert.equal(c.enqueuedTotal, 2001);
    assert.equal(c.overflowDropsTotal, 1);
    assert.equal(c.pendingCostEvents, 2000);
    sink.stop();
  });
});

// ─── internalCostEvent handler ──────────────────────────────────────────────

async function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  opts: { headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const server = createServer((req, res) => void handler(req, res));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address() as { port: number };
  try {
    const r = await fetch(`http://127.0.0.1:${addr.port}${COST_EVENT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      body: JSON.stringify(opts.body ?? {}),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  } finally {
    server.close();
  }
}

describe("internalCostEvent — 秘钥闸", () => {
  const applied: string[] = [];
  const deps = {
    secret: "super-secret-egress-key",
    appendCostCredits: async (requestId: string) => {
      applied.push(`persist:${requestId}`);
    },
    broadcastToUser: (_uid: bigint, _p: unknown) => {
      applied.push("broadcast");
    },
  };

  test("秘钥未配 → 503(split 漏配要 loud)", async () => {
    const h = makeCostEventHandler({ ...deps, secret: undefined });
    const r = await invokeHandler(h, { body: { events: [] } });
    assert.equal(r.status, 503);
  });

  test("秘钥错误 → 401,不 apply", async () => {
    applied.length = 0;
    const h = makeCostEventHandler(deps);
    const r = await invokeHandler(h, {
      headers: { [EGRESS_SECRET_HEADER]: "wrong" },
      body: { events: [{ kind: "persist", requestId: "r1", uid: "7", costCredits: "3" }] },
    });
    assert.equal(r.status, 401);
    assert.equal(applied.length, 0);
  });

  test("秘钥正确 → 按序 apply persist+broadcast", async () => {
    applied.length = 0;
    const h = makeCostEventHandler(deps);
    const r = await invokeHandler(h, {
      headers: { [EGRESS_SECRET_HEADER]: "super-secret-egress-key" },
      body: {
        events: [
          { kind: "persist", requestId: "r1", uid: "7", costCredits: "3" },
          { kind: "broadcast", uid: "7", payload: { type: "outbound.cost_charged" } },
        ],
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(applied, ["persist:r1", "broadcast"]);
  });

  test("persist 事件 parentSessionId 经 egress→master 透传给 appendCostCredits(Fix A durable hop)", async () => {
    const seen: Array<{ sessionId?: string | null; parentSessionId?: string | null }> = [];
    const h = makeCostEventHandler({
      secret: "super-secret-egress-key",
      appendCostCredits: async (
        _rid: string,
        _uid: string,
        _cents: string,
        sessionId?: string | null,
        parentSessionId?: string | null,
      ) => {
        seen.push({ sessionId, parentSessionId });
      },
      broadcastToUser: () => {},
    });
    const r = await invokeHandler(h, {
      headers: { [EGRESS_SECRET_HEADER]: "super-secret-egress-key" },
      body: {
        events: [
          // 委派 persist:带 parent_session_id;缺 parentSessionId 的老事件解析成 null。
          { kind: "persist", requestId: "rd", uid: "7", costCredits: "5", sessionId: "eng-d", parentSessionId: "web-parent-01" },
          { kind: "persist", requestId: "rc", uid: "7", costCredits: "9", sessionId: "eng-leader" },
        ],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], { sessionId: "eng-d", parentSessionId: "web-parent-01" }, "委派事件透传 parentSessionId");
    assert.deepEqual(seen[1], { sessionId: "eng-leader", parentSessionId: null }, "无 parentSessionId → null(不丢字段)");
  });
});

// ─── forwarder deny-list ────────────────────────────────────────────────────

describe("egress forwarder — 控制专用路径拒转", () => {
  test("/internal/v5/* → 403,不打到 master;其它路径正常转发且注入 peer-ip 头", async () => {
    const seen: Array<{ path: string; peerHdr: string | undefined; secretHdr: string | undefined }> = [];
    const master = createServer((req, res) => {
      seen.push({
        path: req.url ?? "",
        peerHdr: req.headers["x-v5-egress-peer-ip"] as string | undefined,
        secretHdr: req.headers[EGRESS_SECRET_HEADER] as string | undefined,
      });
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    master.listen(0, "127.0.0.1");
    await once(master, "listening");
    const mAddr = master.address() as { port: number };
    const forward = makeForwarder({ controlBaseUrl: `http://127.0.0.1:${mAddr.port}` });
    const front = createServer((req, res) => forward(req, res, "172.31.0.9"));
    front.listen(0, "127.0.0.1");
    await once(front, "listening");
    const fAddr = front.address() as { port: number };
    try {
      // 1) 控制专用路径拒转
      const r1 = await fetch(`http://127.0.0.1:${fAddr.port}/internal/v5/cost-event`, { method: "POST", body: "{}" });
      assert.equal(r1.status, 403);
      assert.equal(seen.length, 0, "绝不能到 master");
      // 2) 普通路径转发 + peer ip 注入 + 秘钥头剥除(即使容器伪造带上)
      const r2 = await fetch(`http://127.0.0.1:${fAddr.port}/internal/v3/turn-waive`, {
        method: "POST",
        headers: { [EGRESS_SECRET_HEADER]: "forged", "x-v5-egress-peer-ip": "1.2.3.4" },
        body: "{}",
      });
      assert.equal(r2.status, 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.path, "/internal/v3/turn-waive");
      assert.equal(seen[0]!.peerHdr, "172.31.0.9", "peer ip 必须来自 socket,不信入站头");
      assert.equal(seen[0]!.secretHdr, undefined, "伪造秘钥头必须被剥除");
    } finally {
      front.close();
      master.close();
    }
  });
});
