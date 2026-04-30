/**
 * V3 Phase 3E — agent-sandbox/v3readiness.ts 单测。
 *
 * 覆盖:
 *   - probeHealthzHttp:200/4xx/5xx/ECONNREFUSED/超时
 *   - probeWsUpgrade:成功 upgrade / server 没起 / server 起来但拒绝 upgrade
 *   - waitContainerReady:HTTP+WS 双过 / HTTP fail / WS fail / 超时
 *   - 探活顺序:HTTP 没过 → 跳过 WS 不浪费 socket
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

import {
  waitContainerReady,
  probeHealthzHttp,
  probeWsUpgrade,
  probeHealthzViaTunnel,
  probeWsUpgradeViaTunnel,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_READINESS_TIMEOUT_REMOTE_MS,
} from "../agent-sandbox/v3readiness.js";
import type {
  NodeAgentTarget,
  TunnelDialOptions,
} from "../compute-pool/nodeAgentClient.js";
import type { TLSSocket } from "node:tls";
import { V3_CONTAINER_PORT } from "../agent-sandbox/v3supervisor.js";
import { mock } from "node:test";

// ───────────────────────────────────────────────────────────────────────
//  Fixture helpers
// ───────────────────────────────────────────────────────────────────────

interface RunningServer {
  server: Server;
  wss?: WebSocketServer;
  port: number;
  close: () => Promise<void>;
}

async function startHttpAndOptionalWs(opts: {
  healthzStatus?: number;
  attachWs?: boolean;
  wsPath?: string;
}): Promise<RunningServer> {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.statusCode = opts.healthzStatus ?? 200;
      res.end("ok");
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  let wss: WebSocketServer | undefined;
  if (opts.attachWs) {
    wss = new WebSocketServer({ server, path: opts.wsPath ?? "/ws" });
    wss.on("connection", (ws) => {
      // 不发数据;让 client 自己 close。我们只验证 upgrade 握手成功。
      ws.on("error", () => { /* */ });
    });
  }
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    wss,
    port,
    close: async () => {
      if (wss) await new Promise<void>((r) => wss!.close(() => r()));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
//  probeHealthzHttp
// ───────────────────────────────────────────────────────────────────────

describe("probeHealthzHttp", () => {
  test("200 → true", async () => {
    const s = await startHttpAndOptionalWs({ healthzStatus: 200 });
    try {
      assert.strictEqual(await probeHealthzHttp("127.0.0.1", s.port, 1000), true);
    } finally { await s.close(); }
  });

  test("204 (2xx) → true", async () => {
    const s = await startHttpAndOptionalWs({ healthzStatus: 204 });
    try {
      assert.strictEqual(await probeHealthzHttp("127.0.0.1", s.port, 1000), true);
    } finally { await s.close(); }
  });

  test("404 → false", async () => {
    const s = await startHttpAndOptionalWs({ healthzStatus: 404 });
    try {
      assert.strictEqual(await probeHealthzHttp("127.0.0.1", s.port, 1000), false);
    } finally { await s.close(); }
  });

  test("500 → false", async () => {
    const s = await startHttpAndOptionalWs({ healthzStatus: 500 });
    try {
      assert.strictEqual(await probeHealthzHttp("127.0.0.1", s.port, 1000), false);
    } finally { await s.close(); }
  });

  test("ECONNREFUSED (无人监听)→ false", async () => {
    // 0 端口 listen 拿到的是动态 port,但我们用 1 是几乎肯定没人监听
    // 用 random high port 也行;这里取 1(reserved)在 unprivileged 下 connect 必拒
    assert.strictEqual(await probeHealthzHttp("127.0.0.1", 1, 500), false);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  probeWsUpgrade
// ───────────────────────────────────────────────────────────────────────

describe("probeWsUpgrade", () => {
  test("server 起来 + ws 已 attach → true", async () => {
    const s = await startHttpAndOptionalWs({ attachWs: true });
    try {
      assert.strictEqual(await probeWsUpgrade("127.0.0.1", s.port, 2000), true);
    } finally { await s.close(); }
  });

  test("server 起来但 ws 没 attach → false (HTTP 426/200 都不会 upgrade)", async () => {
    const s = await startHttpAndOptionalWs({ attachWs: false });
    try {
      assert.strictEqual(await probeWsUpgrade("127.0.0.1", s.port, 1000), false);
    } finally { await s.close(); }
  });

  test("ws path 不匹配 → false", async () => {
    // server 有 ws,但 attach 在 /custompath;client probe 默认走 /ws
    const s = await startHttpAndOptionalWs({ attachWs: true, wsPath: "/custompath" });
    try {
      assert.strictEqual(await probeWsUpgrade("127.0.0.1", s.port, 1000), false);
    } finally { await s.close(); }
  });

  test("ECONNREFUSED → false", async () => {
    assert.strictEqual(await probeWsUpgrade("127.0.0.1", 1, 500), false);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  waitContainerReady (双过 + 顺序 + 超时)
// ───────────────────────────────────────────────────────────────────────

describe("waitContainerReady", () => {
  test("HTTP+WS 立即 ok → 一次轮询返 true", async () => {
    let httpCalls = 0;
    let wsCalls = 0;
    const ok = await waitContainerReady(
      { kind: "direct", host: "h", port: 1 },
      {
        probeHttp: async () => { httpCalls++; return true; },
        probeWs: async () => { wsCalls++; return true; },
        sleep: async () => { /* */ },
        now: () => 0,
        timeoutMs: 1000,
        intervalMs: 100,
      },
    );
    assert.strictEqual(ok, true);
    assert.strictEqual(httpCalls, 1);
    assert.strictEqual(wsCalls, 1);
  });

  test("HTTP fail → 跳过 WS probe(省 socket)", async () => {
    let httpCalls = 0;
    let wsCalls = 0;
    let nowVal = 0;
    const ok = await waitContainerReady(
      { kind: "direct", host: "h", port: 1 },
      {
        probeHttp: async () => { httpCalls++; return false; },
        probeWs: async () => { wsCalls++; return true; },  // 不应该被调到
        sleep: async (ms: number) => { nowVal += ms; },
        now: () => nowVal,
        timeoutMs: 500,
        intervalMs: 100,
      },
    );
    assert.strictEqual(ok, false);
    assert.ok(httpCalls >= 2, `httpCalls should be >= 2, got ${httpCalls}`);
    assert.strictEqual(wsCalls, 0);
  });

  test("HTTP ok + WS fail → 不 ready,继续轮询直到 timeout", async () => {
    let httpCalls = 0;
    let wsCalls = 0;
    let nowVal = 0;
    const ok = await waitContainerReady(
      { kind: "direct", host: "h", port: 1 },
      {
        probeHttp: async () => { httpCalls++; return true; },
        probeWs: async () => { wsCalls++; return false; },
        sleep: async (ms: number) => { nowVal += ms; },
        now: () => nowVal,
        timeoutMs: 500,
        intervalMs: 100,
      },
    );
    assert.strictEqual(ok, false);
    assert.ok(httpCalls >= 2);
    assert.ok(wsCalls >= 2);
  });

  test("第三轮才 ready → true", async () => {
    let attempts = 0;
    let nowVal = 0;
    const ok = await waitContainerReady(
      { kind: "direct", host: "h", port: 1 },
      {
        probeHttp: async () => { attempts++; return attempts >= 3; },
        probeWs: async () => true,
        sleep: async (ms: number) => { nowVal += ms; },
        now: () => nowVal,
        timeoutMs: 5000,
        intervalMs: 100,
      },
    );
    assert.strictEqual(ok, true);
    assert.strictEqual(attempts, 3);
  });

  test("end-to-end 走真 server (HTTP+WS 都起)→ true", async () => {
    const s = await startHttpAndOptionalWs({ attachWs: true });
    try {
      const ok = await waitContainerReady(
        { kind: "direct", host: "127.0.0.1", port: s.port },
        {
          timeoutMs: 3000,
          intervalMs: 100,
          httpProbeMs: 1000,
          wsProbeMs: 1000,
        },
      );
      assert.strictEqual(ok, true);
    } finally { await s.close(); }
  });

  test("end-to-end 走真 server (只有 HTTP, 无 WS)→ false (3E 要双过)", async () => {
    const s = await startHttpAndOptionalWs({ attachWs: false });
    try {
      const ok = await waitContainerReady(
        { kind: "direct", host: "127.0.0.1", port: s.port },
        {
          timeoutMs: 500,
          intervalMs: 100,
          httpProbeMs: 200,
          wsProbeMs: 200,
        },
      );
      assert.strictEqual(ok, false);
    } finally { await s.close(); }
  });

  // V1.0.53 — 跨 host 默认 timeout 25s,self 默认 10s,caller 不传 timeoutMs
  // 时由 endpoint kind 决策(逻辑放在 waitContainerReady 内)。
  //
  // loop 语义(读测试的人务必看):waitContainerReady 第一轮 probe 在 t=0 立即跑(不等 interval),
  // 之后每轮 sleep(intervalMs) 推进 mock now;`now() >= deadline` 时直接 return false **不再 probe**。
  // intervalMs=5000 + direct deadline=10000 → probe 在 t=0,5000 各 1 次,t=10000 触达退出 → 共 2 次。
  // intervalMs=5000 + remote deadline=25000 → probe 在 t=0,5000,10000,15000,20000 各 1 次,t=25000 退出 → 共 5 次。
  // 改 loop 边界(例如改成 deadline 时再 probe 一次)需要同步本测试断言。
  test("direct endpoint + 不传 timeoutMs → 默认 deadline = 10s", async () => {
    let httpCalls = 0;
    let nowVal = 0;
    const ok = await waitContainerReady(
      { kind: "direct", host: "h", port: 1 },
      {
        // 故意不传 timeoutMs;intervalMs=5000 让 loop 5 步内退出便于断言
        intervalMs: 5_000,
        probeHttp: async () => { httpCalls++; return false; },
        probeWs: async () => true,  // 不应被调到(httpFalse 跳过 ws)
        sleep: async (ms: number) => { nowVal += ms; },
        now: () => nowVal,
      },
    );
    assert.strictEqual(ok, false);
    // direct 默认 10s:probe 调 2 次(t=0, t=5000),t=10000 时 deadline 触达退出。
    // 等价于"deadline ≤ DEFAULT_READINESS_TIMEOUT_MS",不会进第 3 轮。
    assert.strictEqual(DEFAULT_READINESS_TIMEOUT_MS, 10_000, "default self timeout 改了请同步本测试");
    assert.strictEqual(httpCalls, 2, `direct 默认 10s 应调 probeHttp 2 次,实际 ${httpCalls}`);
  });

  test("node-tunnel endpoint + 不传 timeoutMs → 默认 deadline = 25s(remote 长 timeout)", async () => {
    let httpCalls = 0;
    let nowVal = 0;
    const ok = await waitContainerReady(
      // 注意:同时传 probeHttp+probeWs 时 needTarget=false,不触发 resolveTarget
      { kind: "node-tunnel", hostId: "fake-host", containerInternalId: "fake-cid" },
      {
        intervalMs: 5_000,
        probeHttp: async () => { httpCalls++; return false; },
        probeWs: async () => true,
        sleep: async (ms: number) => { nowVal += ms; },
        now: () => nowVal,
      },
    );
    assert.strictEqual(ok, false);
    // node-tunnel 默认 25s:probe 调 5 次(t=0, 5000, 10000, 15000, 20000),
    // t=25000 时 deadline 触达退出。区分自 direct 的关键断言。
    assert.strictEqual(DEFAULT_READINESS_TIMEOUT_REMOTE_MS, 25_000, "default remote timeout 改了请同步本测试");
    assert.strictEqual(httpCalls, 5, `node-tunnel 默认 25s 应调 probeHttp 5 次,实际 ${httpCalls}`);
  });

  test("caller 显式传 timeoutMs 时 endpoint kind 不影响超时", async () => {
    // node-tunnel 但 caller 把 timeout 缩到 10s — caller 优先级最高
    let httpCalls = 0;
    let nowVal = 0;
    const ok = await waitContainerReady(
      { kind: "node-tunnel", hostId: "h", containerInternalId: "c" },
      {
        timeoutMs: 10_000,  // 覆盖默认的 25s
        intervalMs: 5_000,
        probeHttp: async () => { httpCalls++; return false; },
        probeWs: async () => true,
        sleep: async (ms: number) => { nowVal += ms; },
        now: () => nowVal,
      },
    );
    assert.strictEqual(ok, false);
    assert.strictEqual(httpCalls, 2, `caller 传 timeoutMs=10000 应覆盖 remote 默认值,实际 ${httpCalls} 次`);
  });
});

// ───────────────────────────────────────────────────────────────────────
//  tunnel readiness probes — 必须带 `?port=<V3_CONTAINER_PORT>`
//
//  regression guard:node-agent 的 /tunnel/containers/{cid}/{sub} handler
//  强制要求 ?port=N(缺则 400 "missing port query param");历史 bug 这两条
//  探针漏传 port,导致远端 host 容器永远 readiness=false → ensureRunning
//  抛 "starting" → bridge 4503 风暴(2026-04-26 修复)。
// ───────────────────────────────────────────────────────────────────────

describe("tunnel readiness probes — port query contract", () => {
  const target: NodeAgentTarget = {
    hostId: "fake-host",
    host: "127.0.0.1",
    agentPort: 9443,
    expectedFingerprint: null,
    psk: null,
  };
  const cid = "abc123def456";

  test("probeHealthzViaTunnel 经 dial 传 /healthz?port=<V3_CONTAINER_PORT>", async () => {
    const calls: TunnelDialOptions[] = [];
    const fakeDial = mock.fn(async (opts: TunnelDialOptions): Promise<TLSSocket> => {
      calls.push(opts);
      // 让 readStatusLine 立刻 close 拿到空,probe 会返 false;但我们只关心 path 契约
      throw new Error("fake-dial-stop");
    });
    const ok = await probeHealthzViaTunnel(target, cid, 100, fakeDial as unknown as typeof import("../compute-pool/nodeAgentClient.js").dialTunnelSocket);
    assert.strictEqual(ok, false, "throw 路径必须返 false");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.pathAndQuery, `/healthz?port=${V3_CONTAINER_PORT}`);
    assert.strictEqual(calls[0]!.containerInternalId, cid);
    assert.strictEqual(calls[0]!.method, "GET");
  });

  test("probeWsUpgradeViaTunnel 经 dial 传 /ws?port=<V3_CONTAINER_PORT>", async () => {
    const calls: TunnelDialOptions[] = [];
    const fakeDial = mock.fn(async (opts: TunnelDialOptions): Promise<TLSSocket> => {
      calls.push(opts);
      throw new Error("fake-dial-stop");
    });
    const ok = await probeWsUpgradeViaTunnel(target, cid, 100, fakeDial as unknown as typeof import("../compute-pool/nodeAgentClient.js").dialTunnelSocket);
    assert.strictEqual(ok, false);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.pathAndQuery, `/ws?port=${V3_CONTAINER_PORT}`);
    assert.strictEqual(calls[0]!.upgradeWebSocket, true);
    // WS 协议要求的两个头不能丢
    assert.ok(calls[0]!.headers?.["Sec-WebSocket-Key"]);
    assert.strictEqual(calls[0]!.headers?.["Sec-WebSocket-Version"], "13");
  });
});
