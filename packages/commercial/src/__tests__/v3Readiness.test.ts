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
} from "../agent-sandbox/v3readiness.js";

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
    const ok = await waitContainerReady("h", 1, {
      probeHttp: async () => { httpCalls++; return true; },
      probeWs: async () => { wsCalls++; return true; },
      sleep: async () => { /* */ },
      now: () => 0,
      timeoutMs: 1000,
      intervalMs: 100,
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(httpCalls, 1);
    assert.strictEqual(wsCalls, 1);
  });

  test("HTTP fail → 跳过 WS probe(省 socket)", async () => {
    let httpCalls = 0;
    let wsCalls = 0;
    let nowVal = 0;
    const ok = await waitContainerReady("h", 1, {
      probeHttp: async () => { httpCalls++; return false; },
      probeWs: async () => { wsCalls++; return true; },  // 不应该被调到
      sleep: async (ms) => { nowVal += ms; },
      now: () => nowVal,
      timeoutMs: 500,
      intervalMs: 100,
    });
    assert.strictEqual(ok, false);
    assert.ok(httpCalls >= 2, `httpCalls should be >= 2, got ${httpCalls}`);
    assert.strictEqual(wsCalls, 0);
  });

  test("HTTP ok + WS fail → 不 ready,继续轮询直到 timeout", async () => {
    let httpCalls = 0;
    let wsCalls = 0;
    let nowVal = 0;
    const ok = await waitContainerReady("h", 1, {
      probeHttp: async () => { httpCalls++; return true; },
      probeWs: async () => { wsCalls++; return false; },
      sleep: async (ms) => { nowVal += ms; },
      now: () => nowVal,
      timeoutMs: 500,
      intervalMs: 100,
    });
    assert.strictEqual(ok, false);
    assert.ok(httpCalls >= 2);
    assert.ok(wsCalls >= 2);
  });

  test("第三轮才 ready → true", async () => {
    let attempts = 0;
    let nowVal = 0;
    const ok = await waitContainerReady("h", 1, {
      probeHttp: async () => { attempts++; return attempts >= 3; },
      probeWs: async () => true,
      sleep: async (ms) => { nowVal += ms; },
      now: () => nowVal,
      timeoutMs: 5000,
      intervalMs: 100,
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(attempts, 3);
  });

  test("end-to-end 走真 server (HTTP+WS 都起)→ true", async () => {
    const s = await startHttpAndOptionalWs({ attachWs: true });
    try {
      const ok = await waitContainerReady("127.0.0.1", s.port, {
        timeoutMs: 3000,
        intervalMs: 100,
        httpProbeMs: 1000,
        wsProbeMs: 1000,
      });
      assert.strictEqual(ok, true);
    } finally { await s.close(); }
  });

  test("end-to-end 走真 server (只有 HTTP, 无 WS)→ false (3E 要双过)", async () => {
    const s = await startHttpAndOptionalWs({ attachWs: false });
    try {
      const ok = await waitContainerReady("127.0.0.1", s.port, {
        timeoutMs: 500,
        intervalMs: 100,
        httpProbeMs: 200,
        wsProbeMs: 200,
      });
      assert.strictEqual(ok, false);
    } finally { await s.close(); }
  });
});
