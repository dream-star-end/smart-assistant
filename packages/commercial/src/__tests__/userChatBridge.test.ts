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
