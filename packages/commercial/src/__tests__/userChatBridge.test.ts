/**
 * V3 Phase 2 Task 2E — userChatBridge 单元测试。
 *
 * 跑法: npx tsx --test src/__tests__/userChatBridge.test.ts
 *
 * 集成场景(真起 ws server + 客户端 + mock 容器 ws server):
 *   - JWT 失败 → close(1008)
 *   - ensureRunning throw ContainerUnreadyError → close(4503) + reason JSON
 *   - 正常路径:用户帧 → 容器,容器帧 → 用户(双向 byte-exact)
 *   - 容器 send back 与早到帧的顺序保证
 *   - binary 帧支持
 *   - 任一侧 close → 另一侧也 close
 *   - 单帧超大 → close(1009)
 *   - ConnectionRegistry 超额踢老
 *   - shutdown
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { signAccess } from "../auth/jwt.js";
import {
  createUserChatBridge,
  ContainerUnreadyError,
  CLOSE_BRIDGE,
  BRIDGE_WS_PATH,
  _encode4503Reason,
  _rawDataLen,
  type ResolveContainerEndpoint,
  type UserChatBridgeHandler,
} from "../ws/userChatBridge.js";

// ------- 测试夹具:bridge gateway + mock 容器 ws server ------------------

const JWT_SECRET = "x".repeat(32);

interface TestRig {
  gateway: http.Server;
  bridge: UserChatBridgeHandler;
  gatewayPort: number;
  containerWss: WebSocketServer;
  containerPort: number;
  containerSeen: Array<{ data: string | Buffer; isBinary: boolean }>;
  containerSockets: WebSocket[];
  /** 由测试覆盖:resolve 行为(默认指向 mock 容器);可改成 throw。 */
  resolveImpl: ResolveContainerEndpoint;
}

async function startRig(opts: {
  resolve?: ResolveContainerEndpoint;
  maxPerUser?: number;
  maxFrameBytes?: number;
  markContainerActivity?: (containerId: number) => void;
  loadAllowedModelChecker?: (
    uid: bigint,
    role: "user" | "admin",
  ) => Promise<(modelId: string) => boolean>;
} = {}): Promise<TestRig> {
  // 1) mock 容器 ws server
  const containerSeen: Array<{ data: string | Buffer; isBinary: boolean }> = [];
  const containerSockets: WebSocket[] = [];
  const containerWss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => containerWss.once("listening", () => r()));
  const containerPort = (containerWss.address() as { port: number }).port;
  containerWss.on("connection", (ws) => {
    containerSockets.push(ws);
    ws.on("message", (data, isBinary) => {
      const buf = typeof data === "string"
        ? data
        : Buffer.isBuffer(data) ? data
          : Buffer.concat(data as Buffer[]);
      containerSeen.push({ data: buf, isBinary });
    });
  });

  // 2) bridge handler
  const defaultResolve: ResolveContainerEndpoint = async () => ({
    host: "127.0.0.1", port: containerPort,
  });
  const rig: Partial<TestRig> = {};
  rig.resolveImpl = opts.resolve ?? defaultResolve;
  const bridge = createUserChatBridge({
    jwtSecret: JWT_SECRET,
    resolveContainerEndpoint: (uid) => rig.resolveImpl!(uid),
    maxPerUser: opts.maxPerUser,
    maxFrameBytes: opts.maxFrameBytes,
    containerConnectTimeoutMs: 1500,
    markContainerActivity: opts.markContainerActivity,
    loadAllowedModelChecker: opts.loadAllowedModelChecker,
  });

  // 3) gateway HTTP server,只挂 bridge upgrade
  const gateway = http.createServer((_, res) => res.end());
  gateway.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  const gatewayPort = (gateway.address() as { port: number }).port;

  return {
    gateway, bridge, gatewayPort,
    containerWss, containerPort, containerSeen, containerSockets,
    resolveImpl: rig.resolveImpl!,
  };
}

async function stopRig(rig: TestRig): Promise<void> {
  await rig.bridge.shutdown();
  await new Promise<void>((r) => rig.containerWss.close(() => r()));
  await new Promise<void>((r) => rig.gateway.close(() => r()));
}

async function makeJwt(uid: string): Promise<string> {
  const r = await signAccess({ sub: uid, role: "user" }, JWT_SECRET);
  return r.token;
}

function openClient(port: number, token: string): WebSocket {
  // 2026-04-21 安全审计 HIGH#2:server 已不再接受 ?token= URL query fallback。
  // 测试与生产前端一致走 Sec-WebSocket-Protocol "bearer, <token>" 子协议。
  return new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_WS_PATH}`, ["bearer", token]);
}

function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  if (ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve({ code: 1006, reason: "" });
  }
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function waitMessage(ws: WebSocket): Promise<{ data: string | Buffer; isBinary: boolean }> {
  return new Promise((resolve) => {
    ws.once("message", (data, isBinary) => {
      const out = typeof data === "string"
        ? data
        : Buffer.isBuffer(data) ? data
          : Buffer.concat(data as Buffer[]);
      resolve({ data: out, isBinary });
    });
  });
}

/** 等下一条容器侧 ws 连接(按时间顺序;不复用已有的)。 */
function waitNextContainerSocket(rig: TestRig, timeoutMs = 1000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no container connection")), timeoutMs);
    rig.containerWss.once("connection", (ws) => {
      clearTimeout(t);
      resolve(ws);
    });
  });
}

// ------- pure helpers -----------------------------------------------------

describe("encode4503Reason", () => {
  test("returns valid JSON with retryAfterSec + reason", () => {
    const s = _encode4503Reason(5, "provisioning");
    const o = JSON.parse(s) as { retryAfterSec: number; reason: string };
    assert.equal(o.retryAfterSec, 5);
    assert.equal(o.reason, "provisioning");
  });
  test("truncates very long reason to 64 chars", () => {
    const s = _encode4503Reason(2, "x".repeat(200));
    const o = JSON.parse(s) as { reason: string };
    assert.equal(o.reason.length, 64);
  });
});

describe("rawDataLen", () => {
  test("Buffer", () => { assert.equal(_rawDataLen(Buffer.from([1, 2, 3])), 3); });
  test("ArrayBuffer", () => {
    const ab = new ArrayBuffer(10);
    assert.equal(_rawDataLen(ab), 10);
  });
  test("array of buffers", () => {
    assert.equal(_rawDataLen([Buffer.alloc(3), Buffer.alloc(7)]), 10);
  });
});

describe("ContainerUnreadyError", () => {
  test("captures retryAfterSec + reason", () => {
    const e = new ContainerUnreadyError(5, "starting");
    assert.equal(e.retryAfterSec, 5);
    assert.equal(e.reason, "starting");
    assert.equal(e.name, "ContainerUnreadyError");
  });
});

// ------- end-to-end:JWT 失败 ---------------------------------------------

describe("userChatBridge — JWT failure", () => {
  let rig: TestRig;
  before(async () => { rig = await startRig(); });
  after(async () => { await stopRig(rig); });

  test("missing token → close(1008) UNAUTHORIZED", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${rig.gatewayPort}${BRIDGE_WS_PATH}`);
    const errFrame = waitMessage(ws);
    const closeP = waitClose(ws);
    const frame = await errFrame;
    assert.match(frame.data.toString(), /UNAUTHORIZED/);
    const close = await closeP;
    assert.equal(close.code, CLOSE_BRIDGE.POLICY);
  });

  test("invalid token → close(1008)", async () => {
    const ws = openClient(rig.gatewayPort, "bad-token");
    const closeP = waitClose(ws);
    void waitMessage(ws).catch(() => {});
    const close = await closeP;
    assert.equal(close.code, CLOSE_BRIDGE.POLICY);
  });
});

// ------- end-to-end:容器未就绪 -------------------------------------------

describe("userChatBridge — container not ready", () => {
  let rig: TestRig;
  before(async () => {
    rig = await startRig({
      resolve: async () => { throw new ContainerUnreadyError(2, "provisioning"); },
    });
  });
  after(async () => { await stopRig(rig); });

  test("ContainerUnreadyError → close(4503) + reason JSON", async () => {
    const token = await makeJwt("42");
    const ws = openClient(rig.gatewayPort, token);
    const close = await waitClose(ws);
    assert.equal(close.code, CLOSE_BRIDGE.CONTAINER_UNREADY);
    const reason = JSON.parse(close.reason) as { retryAfterSec: number; reason: string };
    assert.equal(reason.retryAfterSec, 2);
    assert.equal(reason.reason, "provisioning");
  });
});

// ------- end-to-end:resolve throw 普通 error -----------------------------

describe("userChatBridge — resolve throws generic error", () => {
  let rig: TestRig;
  before(async () => {
    rig = await startRig({
      resolve: async () => { throw new Error("internal db error"); },
    });
  });
  after(async () => { await stopRig(rig); });

  test("→ close(1011) without leaking error message", async () => {
    const token = await makeJwt("42");
    const ws = openClient(rig.gatewayPort, token);
    void waitMessage(ws).catch(() => {});
    const close = await waitClose(ws);
    assert.equal(close.code, CLOSE_BRIDGE.INTERNAL);
    // 不应该把 "internal db error" 这种东西吐给客户端 close.reason
    assert.equal(/db error/.test(close.reason), false);
  });
});

// ------- end-to-end:正常双向桥接 -----------------------------------------

describe("userChatBridge — happy path", () => {
  let rig: TestRig;
  before(async () => { rig = await startRig(); });
  after(async () => { await stopRig(rig); });

  test("user → container 文本帧透传", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("100");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    const seenP = new Promise<{ data: Buffer | string; isBinary: boolean }>((r) => {
      containerWs.once("message", (data, isBinary) => {
        const buf = typeof data === "string" ? data
          : Buffer.isBuffer(data) ? data
            : Buffer.concat(data as Buffer[]);
        r({ data: buf, isBinary });
      });
    });

    ws.send(JSON.stringify({ type: "hi", n: 1 }));
    const got = await seenP;
    const text = typeof got.data === "string" ? got.data : got.data.toString("utf8");
    assert.deepEqual(JSON.parse(text), { type: "hi", n: 1 });

    ws.close();
    await waitClose(ws);
  });

  test("container → user 文本帧透传", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("101");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    const recv = waitMessage(ws);
    containerWs.send(JSON.stringify({ type: "delta", text: "hello" }));
    const got = await recv;
    const txt = typeof got.data === "string" ? got.data : got.data.toString("utf8");
    assert.deepEqual(JSON.parse(txt), { type: "delta", text: "hello" });

    ws.close();
    await waitClose(ws);
  });

  test("binary frame 双向透传", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("102");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    // user → container binary
    const blob = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    const seenP = new Promise<{ data: Buffer; isBinary: boolean }>((r) => {
      containerWs.once("message", (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data
          : data instanceof ArrayBuffer ? Buffer.from(data)
            : Buffer.concat(data as Buffer[]);
        r({ data: buf, isBinary });
      });
    });
    ws.send(blob, { binary: true });
    const seen = await seenP;
    assert.equal(seen.isBinary, true);
    assert.deepEqual(seen.data, blob);

    // container → user binary
    const recv = waitMessage(ws);
    const blob2 = Buffer.from([0x01, 0x02, 0x03]);
    containerWs.send(blob2, { binary: true });
    const got = await recv;
    assert.equal(got.isBinary, true);
    assert.deepEqual(got.data, blob2);

    ws.close();
    await waitClose(ws);
  });

  test("client close → container 也 close", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("103");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    const closedP = new Promise<void>((r) => containerWs.once("close", () => r()));
    ws.close(1000, "bye");
    await closedP;
    await waitClose(ws);
  });

  test("container close → client 也 close", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("104");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    const closeP = waitClose(ws);
    containerWs.close(1000, "agent done");
    const close = await closeP;
    assert.equal(close.code, 1000);
  });
});

// ------- end-to-end:超大帧 -----------------------------------------------

describe("userChatBridge — container frame too big", () => {
  let rig: TestRig;
  before(async () => { rig = await startRig({ maxFrameBytes: 1024 }); });
  after(async () => { await stopRig(rig); });

  test("容器返一个 > maxFrameBytes 的帧 → bridge close(1009)", async () => {
    const token = await makeJwt("210");
    const cP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await cP;

    const closeP = waitClose(ws);
    // 让 container 主动发一个超大帧 → bridge 的 onContainerMessage 检查命中 1009
    containerWs.send(Buffer.alloc(2048, 0x42), { binary: true });
    const close = await closeP;
    assert.equal(close.code, CLOSE_BRIDGE.TOO_BIG);
  });
});

// ------- end-to-end:每用户并发上限 ---------------------------------------

describe("userChatBridge — per-user concurrency", () => {
  let rig: TestRig;
  before(async () => { rig = await startRig({ maxPerUser: 2 }); });
  after(async () => { await stopRig(rig); });

  test("同 uid 第 3 个连接 → 第 1 个被踢", async () => {
    const token = await makeJwt("300");

    const c1 = waitNextContainerSocket(rig);
    const ws1 = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws1.once("open", () => r()));
    await c1;

    const c2 = waitNextContainerSocket(rig);
    const ws2 = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws2.once("open", () => r()));
    await c2;

    const ws1Closed = waitClose(ws1);

    const c3 = waitNextContainerSocket(rig);
    const ws3 = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws3.once("open", () => r()));
    await c3;

    const close1 = await ws1Closed;
    assert.equal(close1.code, CLOSE_BRIDGE.POLICY,
      "ws1 应该被 kick(收 1008)");
    assert.notEqual(ws2.readyState, WebSocket.CLOSED);
    assert.notEqual(ws3.readyState, WebSocket.CLOSED);

    ws2.close();
    ws3.close();
    await waitClose(ws2);
    await waitClose(ws3);
  });
});

// ------- shutdown ---------------------------------------------------------

describe("userChatBridge — shutdown", () => {
  test("shutdown 关掉所有活跃连接", async () => {
    const rig = await startRig();
    const token = await makeJwt("400");
    const cP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    await cP;

    const closeP = waitClose(ws);
    await rig.bridge.shutdown();
    const close = await closeP;
    assert.equal(close.code, CLOSE_BRIDGE.POLICY);

    await new Promise<void>((r) => rig.containerWss.close(() => r()));
    await new Promise<void>((r) => rig.gateway.close(() => r()));
  });
});

// ------- handleUpgrade 路径不匹配 ----------------------------------------

describe("userChatBridge — upgrade path mismatch", () => {
  test("非 /ws/user-chat-bridge 路径返 false(交回 gateway)", async () => {
    const rig = await startRig();
    // 直接构造 fake req,验证 handleUpgrade 返回值
    const req = { url: "/ws/agent" } as unknown as http.IncomingMessage;
    const sock = { destroyed: false, end: () => {}, destroy: () => {} } as unknown as
      Parameters<typeof rig.bridge.handleUpgrade>[1];
    const head = Buffer.alloc(0);
    const handled = rig.bridge.handleUpgrade(req, sock, head);
    assert.equal(handled, false);
    await stopRig(rig);
  });
});

// ------- PR1:client→container 帧 debounced markContainerActivity -----------
//
// 防 idle sweep 误杀长 WS:bridge 在每帧 client→container 时刷 last_ws_activity,
// 但 60s 内只刷一次。container→user 帧不算(防容器 chatty 输出把 idle 假装活跃)。
// resolve 返 containerId === undefined → 整层逻辑跳过(测试/单测 mock 路径)。

describe("userChatBridge — markContainerActivity (PR1 idle hibernate 前置)", () => {
  test("30 条 client→container 帧 60s 内最多调 1 次 markActivity", async () => {
    const seen: number[] = [];
    // 注:startRig 内部用 `rig.resolveImpl` 闭包,但返回值是新对象——
    // 在 startRig 之后修改返回值的 resolveImpl 不会改 bridge 里的 closure。
    // 用 ref 对象延迟读 containerPort,并通过 opts.resolve 一次性传进去。
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 42,
      }),
      markContainerActivity: (cid) => { seen.push(cid); },
    });
    portRef.p = rig.containerPort;

    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("500");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    await containerOpenP;

    // 30 条文本帧 — 同步 send(测试单进程,Date.now() 不会跨过 60s)
    for (let i = 0; i < 30; i++) {
      ws.send(JSON.stringify({ type: "frame", n: i }));
    }
    // 让 bridge 处理完
    await new Promise<void>((r) => setTimeout(r, 50));

    assert.equal(seen.length, 1, `期待 debounce 后 == 1 次,实际 ${seen.length}`);
    assert.equal(seen[0], 42, "containerId 应被透传给 markActivity");

    ws.close();
    await waitClose(ws);
    await stopRig(rig);
  });

  test("container→user 帧不刷活动", async () => {
    const seen: number[] = [];
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 99,
      }),
      markContainerActivity: (cid) => { seen.push(cid); },
    });
    portRef.p = rig.containerPort;

    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("501");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    // 容器主动 send 10 条 → user
    const recvCount = new Promise<void>((resolve) => {
      let n = 0;
      ws.on("message", () => {
        n += 1;
        if (n >= 10) resolve();
      });
    });
    for (let i = 0; i < 10; i++) {
      containerWs.send(JSON.stringify({ type: "delta", i }));
    }
    await recvCount;

    assert.equal(seen.length, 0,
      "container→user 流量不应触发 markActivity(否则 chatty 容器假装 idle 用户活跃)");

    ws.close();
    await waitClose(ws);
    await stopRig(rig);
  });

  test("resolve 返 containerId === undefined → 不调 markActivity", async () => {
    const seen: number[] = [];
    const rig = await startRig({
      markContainerActivity: (cid) => { seen.push(cid); },
    });
    // 默认 resolve 不带 containerId — 验证降级路径

    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("502");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    await containerOpenP;

    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ ping: i }));
    }
    await new Promise<void>((r) => setTimeout(r, 50));

    assert.equal(seen.length, 0,
      "containerId undefined 时整层逻辑应跳过(向后兼容旧 resolve)");

    ws.close();
    await waitClose(ws);
    await stopRig(rig);
  });

  test("markActivity throw → bridge 不挂(异常 swallow)", async () => {
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 7,
      }),
      markContainerActivity: () => { throw new Error("simulated db down"); },
    });
    portRef.p = rig.containerPort;

    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("503");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    // send 一帧触发 markActivity throw — bridge 应继续工作
    const seenP = new Promise<{ data: Buffer | string; isBinary: boolean }>((r) => {
      containerWs.once("message", (data, isBinary) => {
        const buf = typeof data === "string" ? data
          : Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        r({ data: buf, isBinary });
      });
    });
    ws.send(JSON.stringify({ type: "hi" }));
    const got = await seenP;
    const txt = typeof got.data === "string" ? got.data : got.data.toString("utf8");
    assert.deepEqual(JSON.parse(txt), { type: "hi" },
      "markActivity throw 后 bridge 应仍能透传帧");

    ws.close();
    await waitClose(ws);
    await stopRig(rig);
  });
});

// ------- regression:跨 host tunnel 路由 ----------------------------------
// 历史 bug(2026-04-26):endpoint 返回 tunnel 字段时,bridge 仍用默认
// `new WebSocket(\`ws://${host}:${port}/ws\`)` 直接拨远端 docker bridge IP
// → EHOSTUNREACH → 用户 ws 4503 重连风暴。修复后 bridge 必须走 tunnelFactory,
// 绝不 dial endpoint.host。

describe("userChatBridge — tunnel routing (regression)", () => {
  test("endpoint.tunnel set → 调 tunnelFactory,不 dial endpoint.host", async () => {
    // mock 容器 ws server(只为给 tunnelFactory 返回一个真 ws)
    const containerWss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => containerWss.once("listening", () => r()));
    const containerPort = (containerWss.address() as { port: number }).port;
    const containerSeen: Array<{ data: string | Buffer; isBinary: boolean }> = [];
    containerWss.on("connection", (ws) => {
      ws.on("message", (data, isBinary) => {
        const buf = typeof data === "string" ? data
          : Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
        containerSeen.push({ data: buf, isBinary });
      });
    });

    let directDialed = false;
    const tunnelCalls: Array<{
      hostId: string; containerInternalId: string; port: number;
    }> = [];

    const fakeNodeAgent = {
      hostId: "host-remote",
      host: "10.0.0.42",      // 远端,实际不会被 dial(tunnelFactory 内部 mock)
      agentPort: 9443,
      expectedFingerprint: null,
      psk: null,
    };

    const bridge = createUserChatBridge({
      jwtSecret: JWT_SECRET,
      resolveContainerEndpoint: async () => ({
        // host/port 是远端 docker bridge — 若 bridge 错误地直连这里就 EHOSTUNREACH;
        // tunnelFactory 路径下应该被忽略
        host: "172.30.99.99",
        port: 18789,
        containerId: 1,
        tunnel: {
          hostId: "host-remote",
          containerInternalId: "deadbeef" + "0".repeat(56),
          nodeAgent: fakeNodeAgent,
        },
      }),
      // direct 工厂:若被调到就标记 + dial 一个不存在的端口 → 测试断言 directDialed === false
      createContainerSocket: (host, port, _signal) => {
        directDialed = true;
        // 返回一个不会 connect 的 ws,避免污染 mock 容器
        return new WebSocket(`ws://127.0.0.1:1/__should-not-be-called__`);
      },
      // tunnel 工厂:实际就连本地 mock 容器 ws,把 hostId/cid/port 记下来给断言
      createTunnelContainerSocket: async (tunnel, port, _signal) => {
        tunnelCalls.push({
          hostId: tunnel.hostId,
          containerInternalId: tunnel.containerInternalId,
          port,
        });
        return new WebSocket(`ws://127.0.0.1:${containerPort}/ws`);
      },
      containerConnectTimeoutMs: 1500,
    });

    const gateway = http.createServer((_, res) => res.end());
    gateway.on("upgrade", (req, socket, head) => {
      if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
    const gatewayPort = (gateway.address() as { port: number }).port;

    try {
      const token = await makeJwt("777");
      const ws = openClient(gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));

      // 等容器 ws 真连上(说明 tunnel 工厂返回的 ws 确实在跑)
      await new Promise<void>((r, j) => {
        const t = setTimeout(() => j(new Error("container never connected")), 1500);
        containerWss.once("connection", () => { clearTimeout(t); r(); });
      });
      // 发一帧验证整条链通
      ws.send(JSON.stringify({ type: "ping" }));
      // 等 mock 容器收到
      const start = Date.now();
      while (containerSeen.length === 0 && Date.now() - start < 1500) {
        await new Promise((r) => setTimeout(r, 20));
      }

      assert.equal(directDialed, false,
        "tunnel endpoint 时绝不能调 createContainerSocket(直连远端 docker bridge IP 必 EHOSTUNREACH)");
      assert.equal(tunnelCalls.length, 1, "tunnel 工厂应被调一次");
      assert.equal(tunnelCalls[0]!.hostId, "host-remote");
      assert.equal(tunnelCalls[0]!.port, 18789);
      assert.ok(tunnelCalls[0]!.containerInternalId.startsWith("deadbeef"));
      assert.equal(containerSeen.length, 1, "用户帧应通过 tunnel 工厂的 ws 传到容器");

      ws.close();
      await waitClose(ws);
    } finally {
      await bridge.shutdown();
      await new Promise<void>((r) => containerWss.close(() => r()));
      await new Promise<void>((r) => gateway.close(() => r()));
    }
  });

  test("endpoint.tunnel set 但 createTunnelContainerSocket 未注入 → close(1011)", async () => {
    const fakeNodeAgent = {
      hostId: "host-remote",
      host: "10.0.0.42",
      agentPort: 9443,
      expectedFingerprint: null,
      psk: null,
    };

    const bridge = createUserChatBridge({
      jwtSecret: JWT_SECRET,
      resolveContainerEndpoint: async () => ({
        host: "172.30.99.99",
        port: 18789,
        tunnel: {
          hostId: "host-remote",
          containerInternalId: "abc123",
          nodeAgent: fakeNodeAgent,
        },
      }),
      // 故意不注入 createTunnelContainerSocket
      containerConnectTimeoutMs: 1500,
    });

    const gateway = http.createServer((_, res) => res.end());
    gateway.on("upgrade", (req, socket, head) => {
      if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
    const gatewayPort = (gateway.address() as { port: number }).port;

    try {
      const token = await makeJwt("888");
      const ws = openClient(gatewayPort, token);
      const closed = await waitClose(ws);
      assert.equal(closed.code, CLOSE_BRIDGE.INTERNAL,
        "tunnel endpoint 但工厂未注入 → close(1011) — 不能默默 fall back 到直连");
    } finally {
      await bridge.shutdown();
      await new Promise<void>((r) => gateway.close(() => r()));
    }
  });
});

// ------- 0049 模型授权(plan v3 review v1/v2 follow-up)----------------------

describe("userChatBridge — model authorization", () => {
  test("inbound.message 带 model 且未授权 → close(POLICY)", async () => {
    const allowed = new Set<string>(["claude-opus-4-7"]); // gpt-5.5 不在
    const rig = await startRig({
      loadAllowedModelChecker: async () => (id: string) => allowed.has(id),
    });
    try {
      const token = await makeJwt("200");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));

      const errFrameP = waitMessage(ws);
      const closeP = waitClose(ws);
      ws.send(JSON.stringify({ type: "inbound.message", model: "gpt-5.5" }));
      const err = await errFrameP;
      assert.match(err.data.toString(), /UNAUTHORIZED_MODEL/);
      const closed = await closeP;
      assert.equal(closed.code, CLOSE_BRIDGE.POLICY);
    } finally {
      await stopRig(rig);
    }
  });

  test("inbound.message 仅带 agentId='codex' 不带 model 且未授权 → 仍被拦(round-2 finding 1)", async () => {
    // 这是 Codex review v2 finding 1 修复的核心:agentId='codex' 隐含 gpt-5.5,
    // 即便不带 model 也必须按 gpt-5.5 校验,否则未授权用户可以用纯 agentId 帧绕过 authz。
    const allowed = new Set<string>(["claude-opus-4-7"]);
    const rig = await startRig({
      loadAllowedModelChecker: async () => (id: string) => allowed.has(id),
    });
    try {
      const token = await makeJwt("201");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));

      const errFrameP = waitMessage(ws);
      const closeP = waitClose(ws);
      ws.send(JSON.stringify({ type: "inbound.message", agentId: "codex" }));
      const err = await errFrameP;
      assert.match(err.data.toString(), /UNAUTHORIZED_MODEL/);
      const closed = await closeP;
      assert.equal(closed.code, CLOSE_BRIDGE.POLICY);
    } finally {
      await stopRig(rig);
    }
  });

  test("inbound.message 带 claude-* model 且授权 → 透传到容器", async () => {
    // 普通 claude 帧路径不应受 round-2 修改影响。
    const allowed = new Set<string>(["claude-opus-4-7"]);
    const rig = await startRig({
      loadAllowedModelChecker: async () => (id: string) => allowed.has(id),
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const token = await makeJwt("202");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));
      const containerWs = await containerOpenP;

      const seenP = new Promise<{ data: Buffer | string; isBinary: boolean }>((r) => {
        containerWs.once("message", (data, isBinary) => {
          const buf = typeof data === "string" ? data
            : Buffer.isBuffer(data) ? data
              : Buffer.concat(data as Buffer[]);
          r({ data: buf, isBinary });
        });
      });

      ws.send(JSON.stringify({ type: "inbound.message", model: "claude-opus-4-7" }));
      const got = await seenP;
      const text = typeof got.data === "string" ? got.data : got.data.toString("utf8");
      assert.deepEqual(JSON.parse(text), { type: "inbound.message", model: "claude-opus-4-7" });

      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("第一帧带 gpt-5.5(授权)→ 第二帧不带 model 仍按 lastSeenModelId 校验(review v1 follow-up)", async () => {
    // 场景:bridge lifetime 内 user 第一帧合法用了 gpt-5.5;之后流式增量帧仅带
    // delta/text 不带 model。如果中间 admin 撤销了 grant,后续的 delta 帧也必须
    // 被拦(lastSeenModelId 兜底)。这里通过 mock checker 在 mid-session 切语义
    // 来模拟"撤销"。
    const state = { allowGpt: true };
    const rig = await startRig({
      loadAllowedModelChecker: async () => (id: string) => {
        if (id === "claude-opus-4-7") return true;
        if (id === "gpt-5.5") return state.allowGpt;
        return false;
      },
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const token = await makeJwt("203");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));
      const containerWs = await containerOpenP;

      // 1) 首帧带 gpt-5.5,被授权 → 透传
      const firstP = new Promise<Buffer | string>((r) => {
        containerWs.once("message", (d) => {
          r(typeof d === "string" ? d : Buffer.isBuffer(d) ? d : Buffer.concat(d as Buffer[]));
        });
      });
      ws.send(JSON.stringify({ type: "inbound.message", model: "gpt-5.5", n: 1 }));
      const first = await firstP;
      const firstText = typeof first === "string" ? first : first.toString("utf8");
      assert.match(firstText, /"gpt-5\.5"/);

      // 2) admin 撤销
      state.allowGpt = false;

      // 3) 第二帧不带 model,但 lastSeenModelId='gpt-5.5' → 应该被拦
      const errFrameP = waitMessage(ws);
      const closeP = waitClose(ws);
      ws.send(JSON.stringify({ type: "inbound.message", n: 2 }));
      const err = await errFrameP;
      assert.match(err.data.toString(), /UNAUTHORIZED_MODEL/);
      const closed = await closeP;
      assert.equal(closed.code, CLOSE_BRIDGE.POLICY);
    } finally {
      await stopRig(rig);
    }
  });
});

// ------- regression: containerWs CONNECTING + earlyClose 不冒 fatal --------
//
// 历史:client 在 ensureRunning / resolve 慢 async 期间关闭后,bridge 走到
// handleUpgrade 的 earlyClose !== null 分支调 `containerWs.terminate()`。如果
// 此时 containerWs 还在 CONNECTING(socket 已连 TCP 但 ws handshake 没完成),
// ws lib 会在异步回调里 throw "WebSocket was closed before the connection was
// established" — 而 startBridge 里的正式 'error' handler 此时还没挂上,error
// 升级成 process uncaughtException,把 v3 master gateway 整个搞崩。
// 生产线上 /var/log/openclaude.log 自 2026-04-26 起累计 10 次同类崩溃。
// 修复:在 createContainerSocket 之后立刻挂 named early 'error' handler。

// ──────────── Phase 0.4 — bridge ring replay (inbound.hello → outbound replay) ────────────
//
// 桥接层 outbound ring buffer:容器侧的 personal-master gateway 给每个 outbound
// 帧打 sessionKey + frameSeq,bridge 抓住转发的同时丢一份进 ring;客户端重连
// 发 inbound.hello.lastFrameSeq 时 bridge 直接回放 ring 内的尾部帧,miss 则发
// outbound.resume_failed 让客户端 REST force-sync。
//
// 测试焦点:
//   1. 命中:bridge 在 hello 后立即推 ring 里 seq>cursor 的帧
//   2. miss:cursor>0 + ring 空 → resume_failed reason="no_buffer"
//   3. 容器重启(cid 变更)→ 新 namespace,旧 cid 的帧不漏给新 cid
//   4. binary 帧不进 ring(只解析 JSON 文本帧)
//   5. 没 sessionKey / frameSeq 的 outbound 帧不进 ring(向后兼容旧帧)
//   6. hello 转发到容器(byte-transparent),不被吞
describe("userChatBridge — Phase 0.4 ring replay", () => {
  test("replays missed stamped frames on hello reconnect", async () => {
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 42,
      }),
    });
    portRef.p = rig.containerPort;

    try {
      // Tab1: 容器 emit 一个 stamped frame seq=5,tab1 收到后关
      const containerOpen1 = waitNextContainerSocket(rig);
      const token = await makeJwt("700");
      const ws1 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws1.once("open", () => r()));
      const containerWs1 = await containerOpen1;
      const recvP1 = waitMessage(ws1);
      const stamped = JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:peerX",
        frameSeq: 5,
        blocks: [],
      });
      containerWs1.send(stamped);
      const recv1 = await recvP1;
      assert.equal(JSON.parse(recv1.data.toString()).frameSeq, 5);
      ws1.close();
      await waitClose(ws1);

      // Tab2: reconnect,hello.lastFrameSeq=4 (一帧没看见)
      const containerOpen2 = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws2.once("open", () => r()));
      await containerOpen2;
      const recvP2 = waitMessage(ws2);
      ws2.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerX", agentId: "main", lastFrameSeq: 4 }],
      }));
      const recv2 = await recvP2;
      const replayed = JSON.parse(recv2.data.toString());
      assert.equal(replayed.frameSeq, 5, "ring replay 必须把 seq=5 推下来");
      assert.equal(replayed.sessionKey, "agent:main:webchat:dm:peerX");

      ws2.close();
      await waitClose(ws2);
    } finally {
      await stopRig(rig);
    }
  });

  test("hello with cursor>0 + empty ring → resume_failed reason=no_buffer", async () => {
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 50,
      }),
    });
    portRef.p = rig.containerPort;

    try {
      const containerOpen = waitNextContainerSocket(rig);
      const token = await makeJwt("701");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));
      await containerOpen;
      const recvP = waitMessage(ws);
      ws.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerY", agentId: "main", lastFrameSeq: 100 }],
      }));
      const recv = await recvP;
      const frame = JSON.parse(recv.data.toString());
      assert.equal(frame.type, "outbound.resume_failed");
      assert.equal(frame.reason, "no_buffer");
      assert.equal(frame.peer.id, "peerY");
      assert.equal(frame.peer.kind, "dm");
      assert.equal(frame.channel, "webchat");
      assert.equal(frame.from, 100, "from 必须是 client 报的 cursor");
      assert.equal(frame.to, 0, "to 必须是 ring currentLast (=0 因 ring 空)");

      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("container restart (different containerId) → fresh namespace, no cross-pollination", async () => {
    const portRef = { p: 0 };
    let cid = 100;
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: cid,
      }),
    });
    portRef.p = rig.containerPort;

    try {
      // cid=100: 存 seq=3
      const containerOpen1 = waitNextContainerSocket(rig);
      const token = await makeJwt("702");
      const ws1 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws1.once("open", () => r()));
      const containerWs1 = await containerOpen1;
      const recvP1 = waitMessage(ws1);
      containerWs1.send(JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:peerZ",
        frameSeq: 3,
      }));
      await recvP1;
      ws1.close();
      await waitClose(ws1);

      // 容器重启 → cid=200,新 storeKey namespace 空
      cid = 200;
      const containerOpen2 = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws2.once("open", () => r()));
      await containerOpen2;
      const recvP2 = waitMessage(ws2);
      ws2.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerZ", agentId: "main", lastFrameSeq: 2 }],
      }));
      const recv = await recvP2;
      const frame = JSON.parse(recv.data.toString());
      assert.equal(frame.type, "outbound.resume_failed",
        "新 cid namespace 空 + cursor>0 → resume_failed,绝不能漏 seq=3 给新生命周期");
      assert.equal(frame.reason, "no_buffer");

      ws2.close();
      await waitClose(ws2);
    } finally {
      await stopRig(rig);
    }
  });

  test("non-stamped outbound frames (无 sessionKey/frameSeq) 不进 ring", async () => {
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 60,
      }),
    });
    portRef.p = rig.containerPort;

    try {
      // Tab1: 容器 emit 一个无 frameSeq 的帧(legacy outbound,旧版 master 没打戳)
      const containerOpen1 = waitNextContainerSocket(rig);
      const token = await makeJwt("703");
      const ws1 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws1.once("open", () => r()));
      const containerWs1 = await containerOpen1;
      const recvP1 = waitMessage(ws1);
      containerWs1.send(JSON.stringify({
        type: "outbound.message",
        // 故意不带 sessionKey/frameSeq
        blocks: [],
      }));
      await recvP1;
      ws1.close();
      await waitClose(ws1);

      // Tab2: hello with cursor=0 — 不该 replay 任何东西(ring 应该是空的)
      // 但 cursor=0 + currentLast=0 → ok+[](正常 fresh session)
      const containerOpen2 = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws2.once("open", () => r()));
      await containerOpen2;
      let firstMsg: string | null = null;
      const t = setTimeout(() => { /* timeout — 期望无消息 */ }, 200);
      ws2.once("message", (data) => { firstMsg = data.toString(); });
      ws2.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerW", agentId: "main", lastFrameSeq: 0 }],
      }));
      await new Promise<void>((r) => setTimeout(r, 250));
      clearTimeout(t);
      assert.equal(firstMsg, null,
        "无 stamped 的 outbound 不进 ring + cursor=0 + currentLast=0 → 不发 replay 也不发 resume_failed");

      ws2.close();
      await waitClose(ws2);
    } finally {
      await stopRig(rig);
    }
  });

  test("hello 仍透传到容器(byte-transparent — container 也要 register WS)", async () => {
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 70,
      }),
    });
    portRef.p = rig.containerPort;

    try {
      const containerOpen = waitNextContainerSocket(rig);
      const token = await makeJwt("704");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));
      await containerOpen;

      const helloFrame = JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerH", agentId: "main", lastFrameSeq: 0 }],
      });
      ws.send(helloFrame);
      // 等容器侧记到这条帧
      await new Promise<void>((r) => setTimeout(r, 100));
      const containerSawHello = rig.containerSeen.find((m) => {
        const s = typeof m.data === "string" ? m.data : m.data.toString("utf8");
        return s === helloFrame;
      });
      assert.ok(containerSawHello,
        "hello 必须 byte-exact 透传到容器(container's autoResumeFromHello 要 set.add(ws) 给后续 deliver 用)");

      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("binary container 帧不解析 JSON / 不进 ring(对 binary 透明)", async () => {
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 80,
      }),
    });
    portRef.p = rig.containerPort;

    try {
      const containerOpen1 = waitNextContainerSocket(rig);
      const token = await makeJwt("705");
      const ws1 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws1.once("open", () => r()));
      const containerWs1 = await containerOpen1;
      const recvP1 = waitMessage(ws1);
      // binary 帧 — 即便里面 ASCII 看起来像 JSON 也不该被当 JSON 解析
      const bin = Buffer.from('{"sessionKey":"x","frameSeq":99}');
      containerWs1.send(bin, { binary: true });
      const recv1 = await recvP1;
      assert.equal(recv1.isBinary, true, "binary 帧透传保 isBinary 标志");
      ws1.close();
      await waitClose(ws1);

      // Tab2: cursor=98 — 期望 no_buffer(binary 不进 ring)
      const containerOpen2 = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws2.once("open", () => r()));
      await containerOpen2;
      const recvP2 = waitMessage(ws2);
      ws2.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "x", agentId: "main", lastFrameSeq: 98 }],
      }));
      const recv2 = await recvP2;
      const f = JSON.parse(recv2.data.toString());
      assert.equal(f.type, "outbound.resume_failed",
        "binary 帧不能进 ring,所以 cursor>0 时必须 miss");

      ws2.close();
      await waitClose(ws2);
    } finally {
      await stopRig(rig);
    }
  });
});

describe("userChatBridge — earlyClose during CONNECTING containerWs (regression)", () => {
  test("client closes during slow resolve → containerWs.terminate() 不冒 uncaughtException", async () => {
    // blackhole TCP server:接受 TCP 但永远不发 HTTP/ws upgrade 响应,让 ws
    // 客户端无限期卡在 CONNECTING 状态(精确复现"CONNECTING 阶段 .terminate")。
    const blackhole = await new Promise<net.Server>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const blackholePort = (blackhole.address() as net.AddressInfo).port;

    // resolve 慢 200ms,留出窗口让 client 在 await 期间 close
    const rig = await startRig({
      resolve: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { host: "127.0.0.1", port: blackholePort };
      },
    });

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => { uncaught.push(err); };
    process.prependListener("uncaughtException", onUncaught);

    try {
      const token = await makeJwt("9999");
      const ws = openClient(rig.gatewayPort, token);
      // client open 后立刻 close,触发 onEarlyClose 写 earlyClose
      await new Promise<void>((r) => ws.once("open", () => r()));
      ws.close();

      // 等 resolve 完成(200ms) + createContainerSocket 创建 ws + earlyClose
      // 路径调 .terminate() + ws 异步抛 "closed before connection established"
      // + 错误事件派发 + 修复后的 named handler 接住。给足 600ms。
      await new Promise((r) => setTimeout(r, 600));

      assert.equal(
        uncaught.length, 0,
        `expected no uncaughtException, got: ${uncaught
          .map((e) => (e as { message?: string })?.message ?? String(e))
          .join(", ")}`,
      );
    } finally {
      process.removeListener("uncaughtException", onUncaught);
      await stopRig(rig);
      await new Promise<void>((r) => blackhole.close(() => r()));
    }
  });
});
