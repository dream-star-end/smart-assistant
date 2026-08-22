/**
 * V3 Phase 2 Task 2E — userChatBridge 单元测试。
 *
 * 跑法: npx tsx --test src/__tests__/userChatBridge.test.ts
 *
 * 集成场景(真起 ws server + 客户端 + mock 容器 ws server):
 *   - JWT 失败 → close(1008)
 *   - ensureRunning throw ContainerUnreadyError → close(4503) + reason JSON
 *   - 正常路径:非 inbound.message 用户帧 → 容器,容器帧 → 用户(双向 byte-exact);
 *     inbound.message 会被 master 注入 trace/history/platform hints 后转发
 *   - 容器 send back 与早到帧的顺序保证
 *   - binary 帧支持
 *   - 任一侧 close → 另一侧也 close
 *   - 单帧超大 → close(1009)
 *   - ConnectionRegistry 超额踢老
 *   - shutdown
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { Pool } from "pg";
import { signAccess } from "../auth/jwt.js";
import type { Logger } from "../logging/logger.js";
import {
  createUserChatBridge,
  ContainerUnreadyError,
  CLOSE_BRIDGE,
  BRIDGE_WS_PATH,
  _encode4503Reason,
  _OutboundPersistQueueCoordinator,
  _rawDataLen,
  _sanitizeMasterHistoricalMessagesForFrame,
  isCursorContainerOnSelfHost,
  type ResolveContainerEndpoint,
  type UserChatBridgeDeps,
  type UserChatBridgeHandler,
} from "../ws/userChatBridge.js";
import {
  detectScanSciPaperIntent,
  SCANSCI_PAPER_HINT_MARKER,
} from "../ws/paperIntentHint.js";
import { GoalStateError } from "../goal/goalStateService.js";
import { formatMessageReplyPrompt } from "@openclaude/protocol";

// ------- 测试夹具:bridge gateway + mock 容器 ws server ------------------

const JWT_SECRET = "x".repeat(32);

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}

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
  maxBufferedBytes?: number;
  markContainerActivity?: (containerId: number) => void;
  loadAllowedModelChecker?: UserChatBridgeDeps["loadAllowedModelChecker"];
  loadMasterSessionMessages?: UserChatBridgeDeps["loadMasterSessionMessages"];
  loadGoalState?: UserChatBridgeDeps["loadGoalState"];
  persistMasterUserMessage?: UserChatBridgeDeps["persistMasterUserMessage"];
  persistOutboundFrame?: UserChatBridgeDeps["persistOutboundFrame"];
  loadSessionWorkspaceMode?: UserChatBridgeDeps["loadSessionWorkspaceMode"];
  logger?: Logger;
  getFrontendBuildId?: () => string | null;
  pgPool?: UserChatBridgeDeps["pgPool"];
  preCheckRedis?: UserChatBridgeDeps["preCheckRedis"];
  pricing?: UserChatBridgeDeps["pricing"];
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
    maxBufferedBytes: opts.maxBufferedBytes,
    containerConnectTimeoutMs: 1500,
    markContainerActivity: opts.markContainerActivity,
    loadAllowedModelChecker: opts.loadAllowedModelChecker,
    loadMasterSessionMessages: opts.loadMasterSessionMessages,
    loadGoalState: opts.loadGoalState,
    persistMasterUserMessage: opts.persistMasterUserMessage,
    persistOutboundFrame: opts.persistOutboundFrame,
    loadSessionWorkspaceMode: opts.loadSessionWorkspaceMode,
    logger: opts.logger,
    getFrontendBuildId: opts.getFrontendBuildId,
    pgPool: opts.pgPool,
    preCheckRedis: opts.preCheckRedis,
    pricing: opts.pricing,
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

/**
 * 持久收帧器 —— 解决 waitMessage 的丢帧竞态:服务端背靠背连发两帧(如 pre-auth 的
 * sys.frontend_build + UNAUTHORIZED)时,两帧在同一同步 emit 循环内到达;once 模式下
 * 第一帧 resolve 后、下一个 waitMessage 挂上 listener 前,第二帧已 emit 完毕被丢弃,
 * await 永久挂死(07-07 起 CI commercial-unit 30min 超时的根因)。
 * 构造时立即挂常驻 listener 入队,next() 从队列取或等待,不存在无 listener 窗口。
 */
function frameCollector(ws: WebSocket): { next: () => Promise<string> } {
  const queue: string[] = [];
  const waiters: Array<(s: string) => void> = [];
  ws.on("message", (data) => {
    const out = typeof data === "string"
      ? data
      : Buffer.isBuffer(data) ? data.toString("utf8")
        : Buffer.concat(data as Buffer[]).toString("utf8");
    const w = waiters.shift();
    if (w) w(out);
    else queue.push(out);
  });
  return {
    next(): Promise<string> {
      const q = queue.shift();
      if (q !== undefined) return Promise.resolve(q);
      return new Promise((r) => waiters.push(r));
    },
  };
}

/**
 * frameCollector 之上再过滤:跳过 sys.*(relay_ready / frontend_build 等**连接性帧**)与
 * 非 JSON 帧,返回下一条业务帧的解析对象。业务断言一律经它取帧——bridge 在容器 relay
 * 建立时会主动推 sys.relay_ready,once 式 waitMessage 抢到的第一帧可能是它而不是业务帧
 * (本文件 4 个套件曾因此长期躺在基线失败债里)。
 */
async function nextBusinessFrame(fc: { next: () => Promise<string> }): Promise<Record<string, unknown>> {
  for (;;) {
    const s = await fc.next();
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      if (typeof parsed?.type === "string" && (parsed.type as string).startsWith("sys.")) continue;
      return parsed;
    } catch {
      /* 非 JSON(binary 透传等)不属于业务 JSON 断言目标,跳过 */
    }
  }
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

describe("detectScanSciPaperIntent", () => {
  test("detects DOI/arXiv and terse Chinese paper topics", () => {
    assert.equal(detectScanSciPaperIntent("10.1038/nature12373")?.kind, "download");
    assert.equal(detectScanSciPaperIntent("arXiv:2301.00001")?.kind, "download");
    assert.equal(detectScanSciPaperIntent("CRISPR prime editing 论文")?.kind, "search");
    assert.equal(detectScanSciPaperIntent("请给这篇论文生成 BibTeX: 10.1038/nature12373")?.kind, "citation");
  });

  test("does not trigger generic non-paper PDF/chat text", () => {
    assert.equal(detectScanSciPaperIntent("晚上吃什么？"), null);
    assert.equal(detectScanSciPaperIntent("帮我把这个 PDF 转成 Word"), null);
  });
});

describe("sanitizeMasterHistoricalMessagesForFrame", () => {
  test("keeps every selected semantic history row without a second arbitrary cap", () => {
    const rows = _sanitizeMasterHistoricalMessagesForFrame([
      { id: "u1", role: "user", text: "hello", status: "sent", ts: 1 },
      { id: "th1", role: "thinking", text: "hidden" },
      { id: "sys", role: "assistant", text: "system", system: true },
      { id: "a1", role: "assistant", content: [{ text: "answer" }], extra: "drop" },
      { id: "t1", role: "tool", toolName: "Bash", inputJson: { command: "pwd" }, output: "/srv" },
    ]);
    assert.deepEqual(rows, [
      { id: "u1", role: "user", text: "hello", status: "sent", ts: 1 },
      { id: "a1", role: "assistant", text: "answer" },
      { id: "t1", role: "tool", text: "Tool: Bash\nInput: {\"command\":\"pwd\"}\nOutput: /srv" },
    ]);
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

    // relay 建立时 bridge 会先推 sys.relay_ready,业务断言经 nextBusinessFrame 取帧。
    const fc = frameCollector(ws);
    containerWs.send(JSON.stringify({ type: "delta", text: "hello" }));
    assert.deepEqual(await nextBusinessFrame(fc), { type: "delta", text: "hello" });

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

describe("userChatBridge — durable outbound frame ordering", () => {
  test("durability poison survives one detach but retires after the final consumer", async () => {
    const queues = new _OutboundPersistQueueCoordinator();
    const key = "703:79:agent:main:webchat:dm:sess-consumer-retire";
    const attempted: number[] = [];
    const failures: string[] = [];
    queues.retain(key);
    queues.retain(key);

    queues.enqueue(
      key,
      9,
      async () => {
        attempted.push(9);
        throw new Error("db unavailable");
      },
      (error) => failures.push((error as Error).message),
    );
    await queues.drain();
    assert.deepEqual(queues.snapshotForTest(), { queues: 1, consumerKeys: 1, consumers: 2 });

    queues.release(key);
    queues.enqueue(
      key,
      10,
      async () => { attempted.push(10); },
      (error) => failures.push((error as Error).message),
    );
    await queues.drain();
    assert.deepEqual(attempted, [9]);
    assert.match(failures.at(-1) ?? "", /blocked at frame 9/);
    assert.deepEqual(queues.snapshotForTest(), { queues: 1, consumerKeys: 1, consumers: 1 });

    queues.release(key);
    await queues.drain();
    await Promise.resolve();
    assert.deepEqual(queues.snapshotForTest(), { queues: 0, consumerKeys: 0, consumers: 0 });

    queues.retain(key);
    queues.enqueue(
      key,
      10,
      async () => { attempted.push(10); },
      (error) => failures.push((error as Error).message),
    );
    await queues.drain();
    assert.deepEqual(attempted, [9, 10]);
    queues.release(key);
    assert.deepEqual(queues.snapshotForTest(), { queues: 0, consumerKeys: 0, consumers: 0 });
  });

  test("exact failed sequence retry heals while another consumer remains attached", async () => {
    const queues = new _OutboundPersistQueueCoordinator();
    const key = "704:80:agent:main:webchat:dm:sess-exact-heal";
    let attempts = 0;
    const failures: string[] = [];
    queues.retain(key);
    queues.retain(key);

    const persist = async (): Promise<void> => {
      attempts++;
      if (attempts === 1) throw new Error("transient write failure");
    };
    queues.enqueue(key, 5, persist, (error) => failures.push((error as Error).message));
    await queues.drain();
    queues.enqueue(key, 5, persist, (error) => failures.push((error as Error).message));
    await queues.drain();

    assert.equal(attempts, 2);
    assert.deepEqual(failures, ["transient write failure"]);
    assert.deepEqual(queues.snapshotForTest(), { queues: 0, consumerKeys: 1, consumers: 2 });
    queues.release(key);
    queues.release(key);
    assert.deepEqual(queues.snapshotForTest(), { queues: 0, consumerKeys: 0, consumers: 0 });
  });

  test("a permanent exact retry retires only the same-sequence transient poison", async () => {
    const queues = new _OutboundPersistQueueCoordinator();
    const key = "706:82:agent:main:webchat:dm:sess-permanent-exact-retry";
    const attempted: number[] = [];
    const failures: string[] = [];
    const permanentConflicts: string[] = [];
    queues.retain(key);

    queues.enqueue(
      key,
      5,
      async () => {
        attempted.push(5);
        throw new Error("transient write failure");
      },
      (error) => failures.push((error as Error).message),
    );
    await queues.drain();

    queues.enqueue(
      key,
      5,
      async () => {
        attempted.push(5);
        const error = new Error("live frame immutable payload conflict") as Error & {
          liveFramePermanentConflict: boolean;
        };
        error.liveFramePermanentConflict = true;
        throw error;
      },
      (error) => failures.push((error as Error).message),
      (error) => permanentConflicts.push((error as Error).message),
    );
    await queues.drain();

    queues.enqueue(
      key,
      6,
      async () => { attempted.push(6); },
      (error) => failures.push((error as Error).message),
    );
    await queues.drain();

    assert.deepEqual(attempted, [5, 5, 6]);
    assert.deepEqual(failures, ["transient write failure"]);
    assert.deepEqual(permanentConflicts, ["live frame immutable payload conflict"]);
    assert.deepEqual(queues.snapshotForTest(), { queues: 0, consumerKeys: 1, consumers: 1 });
    queues.release(key);
    assert.deepEqual(queues.snapshotForTest(), { queues: 0, consumerKeys: 0, consumers: 0 });
  });

  test("a detached late-frame failure cannot poison a later sequence", async () => {
    const queues = new _OutboundPersistQueueCoordinator();
    const key = "705:81:agent:main:webchat:dm:sess-detached-late";
    const attempted: number[] = [];

    queues.enqueue(
      key,
      4,
      async () => {
        attempted.push(4);
        throw new Error("detached write failed");
      },
      () => {},
    );
    await queues.drain();
    assert.deepEqual(queues.snapshotForTest(), { queues: 0, consumerKeys: 0, consumers: 0 });

    queues.enqueue(key, 5, async () => { attempted.push(5); }, () => {});
    await queues.drain();
    assert.deepEqual(attempted, [4, 5]);
    assert.deepEqual(queues.snapshotForTest(), { queues: 0, consumerKeys: 0, consumers: 0 });
  });

  test("a permanent live-frame conflict skips one frame without closing or poisoning later seqs", async () => {
    const persisted: number[] = [];
    const portRef = { value: 0 };
    const rig = await startRig({
      resolve: async () => ({ host: "127.0.0.1", port: portRef.value, containerId: 83 }),
      persistOutboundFrame: async (input) => {
        if (input.frameSeq === 1) {
          const error = new Error("live frame immutable payload conflict") as Error & {
            liveFramePermanentConflict: boolean;
          };
          error.liveFramePermanentConflict = true;
          throw error;
        }
        persisted.push(input.frameSeq);
      },
    });
    portRef.value = rig.containerPort;
    try {
      const containerOpen = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("707"));
      await new Promise<void>((resolve) => ws.once("open", resolve));
      const containerWs = await containerOpen;
      const business: Record<string, unknown>[] = [];
      let closed: { code: number; reason: string } | null = null;
      ws.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (typeof frame.type === "string" && !frame.type.startsWith("sys.")) business.push(frame);
        } catch { /* irrelevant */ }
      });
      ws.once("close", (code, reason) => {
        closed = { code, reason: reason.toString("utf8") };
      });
      const frame = (frameSeq: number, text: string): string => JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:sess-permanent-skip",
        frameSeq,
        peer: { id: "sess-permanent-skip", kind: "dm" },
        clientMessageId: "cm-permanent-skip",
        blocks: [{ kind: "text", text }],
      });
      containerWs.send(frame(1, "one"));
      containerWs.send(frame(2, "two"));

      await waitFor(() => persisted.includes(2) && business.some((entry) => entry.frameSeq === 2));
      assert.equal(closed, null);
      assert.equal(ws.readyState, WebSocket.OPEN);
      assert.deepEqual(persisted, [2]);
      assert.deepEqual(business.map((entry) => entry.frameSeq), [2]);
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("commits exact stamped frames serially before either becomes browser-visible", async () => {
    const persisted: Array<Parameters<NonNullable<UserChatBridgeDeps["persistOutboundFrame"]>>[0]> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const portRef = { value: 0 };
    const rig = await startRig({
      resolve: async () => ({ host: "127.0.0.1", port: portRef.value, containerId: 77 }),
      persistOutboundFrame: async (input) => {
        persisted.push(input);
        if (input.frameSeq === 1) await firstGate;
      },
    });
    portRef.value = rig.containerPort;
    try {
      const containerOpen = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("701"));
      await new Promise<void>((resolve) => ws.once("open", resolve));
      const containerWs = await containerOpen;
      const business: Record<string, unknown>[] = [];
      ws.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (typeof frame.type === "string" && !frame.type.startsWith("sys.")) business.push(frame);
        } catch { /* irrelevant */ }
      });
      const first = JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:sess-durable",
        frameSeq: 1,
        peer: { id: "sess-durable", kind: "dm" },
        clientMessageId: "cm-durable",
        blocks: [{ kind: "text", text: "one" }],
      });
      const second = JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:sess-durable",
        frameSeq: 2,
        peer: { id: "sess-durable", kind: "dm" },
        clientMessageId: "cm-durable",
        blocks: [{ kind: "text", text: "two" }],
      });
      containerWs.send(first);
      containerWs.send(second);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(persisted.map((input) => input.frameSeq), [1]);
      assert.equal(business.length, 0);

      releaseFirst();
      await waitFor(() => business.length === 2);
      assert.deepEqual(persisted.map((input) => input.frameSeq), [1, 2]);
      assert.equal(persisted[0]!.payload, first);
      assert.equal(persisted[1]!.payload, second);
      assert.deepEqual(business.map((frame) => frame.frameSeq), [1, 2]);
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("a failed commit is never shown and the exact container replay can heal it", async () => {
    let attempts = 0;
    const portRef = { value: 0 };
    const rig = await startRig({
      resolve: async () => ({ host: "127.0.0.1", port: portRef.value, containerId: 78 }),
      persistOutboundFrame: async () => {
        attempts++;
        if (attempts === 1) throw new Error("db unavailable");
      },
    });
    portRef.value = rig.containerPort;
    const frame = JSON.stringify({
      type: "outbound.message",
      sessionKey: "agent:main:webchat:dm:sess-replay-heal",
      frameSeq: 9,
      peer: { id: "sess-replay-heal", kind: "dm" },
      clientMessageId: "cm-replay-heal",
      blocks: [{ kind: "text", text: "kept" }],
    });
    try {
      const firstContainerOpen = waitNextContainerSocket(rig);
      const ws1 = openClient(rig.gatewayPort, await makeJwt("702"));
      await new Promise<void>((resolve) => ws1.once("open", resolve));
      const firstContainer = await firstContainerOpen;
      const firstBusiness: Record<string, unknown>[] = [];
      ws1.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
          if (typeof parsed.type === "string" && !parsed.type.startsWith("sys.")) firstBusiness.push(parsed);
        } catch { /* irrelevant */ }
      });
      const firstClose = waitClose(ws1);
      firstContainer.send(frame);
      assert.equal((await firstClose).code, CLOSE_BRIDGE.INTERNAL);
      assert.deepEqual(firstBusiness, []);

      const secondContainerOpen = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, await makeJwt("702"));
      await new Promise<void>((resolve) => ws2.once("open", resolve));
      const secondContainer = await secondContainerOpen;
      const frames = frameCollector(ws2);
      secondContainer.send(frame);
      const visible = await nextBusinessFrame(frames);
      assert.equal(visible.frameSeq, 9);
      assert.equal(attempts, 2);
      ws2.close();
      await waitClose(ws2);
    } finally {
      await stopRig(rig);
    }
  });

  test("a reconnect can advance past a failed sequence after the old bridge detaches", async () => {
    let attempts = 0;
    const portRef = { value: 0 };
    const rig = await startRig({
      resolve: async () => ({ host: "127.0.0.1", port: portRef.value, containerId: 82 }),
      persistOutboundFrame: async () => {
        attempts++;
        if (attempts === 1) throw new Error("db unavailable");
      },
    });
    portRef.value = rig.containerPort;
    const frame = (frameSeq: number): string => JSON.stringify({
      type: "outbound.message",
      sessionKey: "agent:main:webchat:dm:sess-reconnect-advance",
      frameSeq,
      peer: { id: "sess-reconnect-advance", kind: "dm" },
      clientMessageId: "cm-reconnect-advance",
      blocks: [{ kind: "text", text: `frame ${frameSeq}` }],
    });
    try {
      const firstContainerOpen = waitNextContainerSocket(rig);
      const ws1 = openClient(rig.gatewayPort, await makeJwt("706"));
      await new Promise<void>((resolve) => ws1.once("open", resolve));
      const firstContainer = await firstContainerOpen;
      const firstClose = waitClose(ws1);
      firstContainer.send(frame(9));
      assert.equal((await firstClose).code, CLOSE_BRIDGE.INTERNAL);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));

      const secondContainerOpen = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, await makeJwt("706"));
      await new Promise<void>((resolve) => ws2.once("open", resolve));
      const secondContainer = await secondContainerOpen;
      const frames = frameCollector(ws2);
      secondContainer.send(frame(10));
      const visible = await nextBusinessFrame(frames);
      assert.equal(visible.frameSeq, 10);
      assert.equal(attempts, 2);
      ws2.close();
      await waitClose(ws2);
    } finally {
      await stopRig(rig);
    }
  });

  test("hello counts an attached tab before its first outbound frame", async () => {
    let attempts = 0;
    const sessionId = "sess-hello-consumer";
    const sessionKey = `agent:main:webchat:dm:${sessionId}`;
    const portRef = { value: 0 };
    const rig = await startRig({
      resolve: async () => ({ host: "127.0.0.1", port: portRef.value, containerId: 83 }),
      persistOutboundFrame: async (input) => {
        attempts++;
        if (input.frameSeq === 9) throw new Error("db unavailable");
      },
    });
    portRef.value = rig.containerPort;
    const hello = JSON.stringify({
      type: "inbound.hello",
      peers: [{ peerId: sessionId, agentId: "main", lastFrameSeq: 0 }],
    });
    const frame = (frameSeq: number): string => JSON.stringify({
      type: "outbound.message",
      sessionKey,
      frameSeq,
      peer: { id: sessionId, kind: "dm" },
      clientMessageId: "cm-hello-consumer",
      blocks: [{ kind: "text", text: `frame ${frameSeq}` }],
    });
    try {
      const firstContainerOpen = waitNextContainerSocket(rig);
      const ws1 = openClient(rig.gatewayPort, await makeJwt("707"));
      await new Promise<void>((resolve) => ws1.once("open", resolve));
      const firstContainer = await firstContainerOpen;

      const secondContainerOpen = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, await makeJwt("707"));
      await new Promise<void>((resolve) => ws2.once("open", resolve));
      const secondContainer = await secondContainerOpen;

      ws1.send(hello);
      ws2.send(hello);
      await waitFor(() => rig.containerSeen.filter(({ data }) => data.toString() === hello).length === 2);

      const firstClose = waitClose(ws1);
      firstContainer.send(frame(9));
      assert.equal((await firstClose).code, CLOSE_BRIDGE.INTERNAL);
      assert.equal(attempts, 1);

      const secondClose = waitClose(ws2);
      secondContainer.send(frame(10));
      assert.equal((await secondClose).code, CLOSE_BRIDGE.INTERNAL);
      assert.equal(attempts, 1, "the later frame must stay blocked while tab two remains attached");
      await new Promise<void>((resolve) => setTimeout(resolve, 25));

      const thirdContainerOpen = waitNextContainerSocket(rig);
      const ws3 = openClient(rig.gatewayPort, await makeJwt("707"));
      await new Promise<void>((resolve) => ws3.once("open", resolve));
      const thirdContainer = await thirdContainerOpen;
      const frames = frameCollector(ws3);
      ws3.send(hello);
      thirdContainer.send(frame(10));
      const visible = await nextBusinessFrame(frames);
      assert.equal(visible.frameSeq, 10);
      assert.equal(attempts, 2);
      ws3.close();
      await waitClose(ws3);
    } finally {
      await stopRig(rig);
    }
  });
});

// ------- end-to-end:超大帧 -----------------------------------------------

describe("userChatBridge — container frame too big", () => {
  let rig: TestRig;
  before(async () => { rig = await startRig({ maxFrameBytes: 1024 }); });
  after(async () => { await stopRig(rig); });

  test("容器返一个 > maxFrameBytes 的帧 → 容器侧 maxPayload 护栏 → close(1011)", async () => {
    const token = await makeJwt("210");
    const cP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await cP;

    const closeP = waitClose(ws);
    // 现行语义:容器→bridge 的超大帧由 ws lib maxPayload(createContainerSocket 传入
    // maxFrameBytes)在协议层拦截 → containerWs 'error' → 容器侧异常路径,user 收
    // ERR_CONTAINER + close(INTERNAL 1011)。旧的 onContainerMessage 显式 1009 预检
    // 已被 maxPayload 护栏取代(1009 仅保留在 user→container 入站帧检查)。
    containerWs.send(Buffer.alloc(2048, 0x42), { binary: true });
    const close = await closeP;
    assert.equal(close.code, CLOSE_BRIDGE.INTERNAL);
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
    // 契约:kick 只走 close code(4505),不发 turn 级 error 帧(不进会话正文)。
    const ws1ErrorFrames: string[] = [];
    ws1.on("message", (data) => {
      const s = typeof data === "string" ? data : data.toString();
      try {
        if (JSON.parse(s)?.type === "error") ws1ErrorFrames.push(s);
      } catch { /* 非 JSON 帧忽略 */ }
    });

    const c3 = waitNextContainerSocket(rig);
    const ws3 = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws3.once("open", () => r()));
    await c3;

    const close1 = await ws1Closed;
    assert.equal(close1.code, CLOSE_BRIDGE.TOO_MANY_CONNECTIONS,
      "ws1 应该被 kick(收 4505,连接数超限语义)");
    assert.equal(close1.reason, "too_many_connections");
    assert.deepEqual(ws1ErrorFrames, [], "kick 不应发 turn 级 error 帧");
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
  test("shutdown 关掉所有活跃连接:4509 瞬态语义,无 error 帧(部署不打扰用户)", async () => {
    const rig = await startRig();
    const token = await makeJwt("400");
    const cP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    await cP;

    // 契约:发版/重启只走 close code(4509 SERVER_RESTART),不发 turn 级 error 帧——
    // 前端据此静默自动重连+resume 续传,会话正文零痕迹(历史上曾误用 error 帧+4505,
    // 每次部署=全线会话钉"连接已断开"红卡+误报连接数超限)。
    const errorFrames: string[] = [];
    ws.on("message", (data) => {
      const s = typeof data === "string" ? data : data.toString();
      try {
        if (JSON.parse(s)?.type === "error") errorFrames.push(s);
      } catch { /* 非 JSON 帧忽略 */ }
    });

    const closeP = waitClose(ws);
    await rig.bridge.shutdown();
    const close = await closeP;
    assert.equal(close.code, CLOSE_BRIDGE.SERVER_RESTART);
    assert.equal(close.reason, "server_restart");
    assert.deepEqual(errorFrames, [], "shutdown 不应发 turn 级 error 帧");

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
      // S12e CG4:bridge 应把 connId(server-side randomUUID)透传到 tunnel 工厂的
      // 第 4 形参,用于 outgoing WS upgrade 的 X-Connection-Trace-Id 头。
      connectionTraceId: string;
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
      // tunnel 工厂:实际就连本地 mock 容器 ws,把 hostId/cid/port/connectionTraceId 记下来给断言
      createTunnelContainerSocket: async (tunnel, port, _signal, connectionTraceId) => {
        tunnelCalls.push({
          hostId: tunnel.hostId,
          containerInternalId: tunnel.containerInternalId,
          port,
          connectionTraceId,
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
      // S12e CG4:bridge 必须把 connId(randomUUID)透传到 tunnel 工厂第 4 形参,
      // 用于 outgoing tunnel WS upgrade 的 X-Connection-Trace-Id 头。本断言只校验
      // 格式(36-char UUID),具体值由 bridge 内部生成,不需要测试可预测。
      assert.match(
        tunnelCalls[0]!.connectionTraceId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "connectionTraceId 应是 36-char UUID(randomUUID),用作 connection-level trace",
      );
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
  test("inbound.message 带 model 且未授权 → 精确拒帧且保持连接,避免重连重放", async () => {
    const allowed = new Set<string>(["claude-opus-4-7"]); // gpt-5.6-sol 不在
    const rig = await startRig({
      loadAllowedModelChecker: async () => (id: string) => allowed.has(id),
    });
    try {
      const token = await makeJwt("200");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));

      const fc = frameCollector(ws);
      ws.send(JSON.stringify({
        type: "inbound.message",
        peer: { id: "model-policy-peer", kind: "dm" },
        clientMessageId: "model-policy-message",
        model: "gpt-5.6-sol",
      }));
      const err = await nextBusinessFrame(fc);
      assert.equal(err.code, "UNAUTHORIZED_MODEL");
      assert.deepEqual(err.peer, { id: "model-policy-peer", kind: "dm" });
      assert.equal(err.clientMessageId, "model-policy-message");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(ws.readyState, WebSocket.OPEN, "turn 级策略拒绝不能关闭用户整条 WS");
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  // (v5 ccb-only:agentId='codex' 隐含 gpt-5.6-sol 的 authz 用例已随 codex agent +
  //  AGENT_AUTHZ_IMPLIED_MODEL codex 条目一并移除。)

  test("inbound.message 带公开 model 且授权 → 透传到容器", async () => {
    // 普通已授权模型帧路径应原样透传(Claude 官方模型已下线,这里用公开的 glm-5.2 验证)。
    const allowed = new Set<string>(["glm-5.2"]);
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

      ws.send(JSON.stringify({
        type: "inbound.message",
        model: "glm-5.2",
        clientMessageId: "m-user-exact",
      }));
      const got = await seenP;
      const text = typeof got.data === "string" ? got.data : got.data.toString("utf8");
      // CG2a:inbound.message 现在会被 master 注入 traceId(32-hex)— 验类型 + model 透传 +
      // traceId 存在,但不绑定具体值(每 turn 随机)。
      const forwarded = JSON.parse(text) as Record<string, unknown>;
      assert.equal(forwarded.type, "inbound.message");
      assert.equal(forwarded.model, "glm-5.2");
      assert.equal(forwarded.clientMessageId, "m-user-exact");
      assert.match(forwarded.traceId as string, /^[a-f0-9]{32}$/);

      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("inbound.message 会附带 master 权威历史给容器用于跨 provider 上下文", async () => {
    const allowed = new Set<string>(["gpt-5.6-sol"]);
    const rig = await startRig({
      loadAllowedModelChecker: async () => (id: string) => allowed.has(id),
      loadMasterSessionMessages: async (uid, sessionId, context) => {
        assert.equal(uid, 204n);
        assert.equal(sessionId, "sess-history");
        assert.deepEqual(context, {
          contextWindow: null,
          engine: "codex",
          currentUserText: "我刚才问了什么？",
        });
        return [
          { id: "u-old", role: "user", text: "之前问了什么项目", ts: 1 },
          { id: "srv-sess-history-main-t1", role: "assistant", text: "DeepSeek 的回答", ts: 2 },
          { id: "think", role: "thinking", text: "不要透传" },
        ];
      },
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const token = await makeJwt("204");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));
      const containerWs = await containerOpenP;

      const seenP = new Promise<Buffer | string>((r) => {
        containerWs.once("message", (d) => {
          r(typeof d === "string" ? d : Buffer.isBuffer(d) ? d : Buffer.concat(d as Buffer[]));
        });
      });
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "sess-history", kind: "dm" },
        content: { text: "我刚才问了什么？" },
        model: "gpt-5.6-sol",
      }));
      const got = await seenP;
      const forwarded = JSON.parse(
        typeof got === "string" ? got : got.toString("utf8"),
      ) as Record<string, unknown>;
      assert.match(forwarded.traceId as string, /^[a-f0-9]{32}$/);
      assert.deepEqual(forwarded._masterHistoricalMessages, [
        { id: "u-old", role: "user", text: "之前问了什么项目", ts: 1 },
        { id: "srv-sess-history-main-t1", role: "assistant", text: "DeepSeek 的回答", ts: 2 },
      ]);

      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("GoalState PG read failure rejects the turn before container execution", async () => {
    const rig = await startRig({
      loadGoalState: async () => {
        throw new Error("goal pg unavailable");
      },
    });
    try {
      const token = await makeJwt("208");
      const ws = openClient(rig.gatewayPort, token);
      const frames = frameCollector(ws);
      await new Promise<void>((r) => ws.once("open", () => r()));
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "sess-goal-read-failure", kind: "dm" },
        content: { text: "must not execute without goal authority" },
      }));

      const error = await nextBusinessFrame(frames);
      assert.equal(error.code, "GOAL_STATE_UNAVAILABLE");
      assert.deepEqual(error.peer, { id: "sess-goal-read-failure", kind: "dm" });
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.equal(
        rig.containerSeen.some(({ data }) => {
          const text = typeof data === "string" ? data : data.toString("utf8");
          return text.includes("must not execute without goal authority");
        }),
        false,
      );
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("GoalState NOT_FOUND (fresh session without row) proceeds with null goal instead of rejecting", async () => {
    // 2026-07-17 生产实证:纯 WS 新会话(无 client_sessions 行)被 goal 加载的
    // NOT_FOUND 当作瞬态失败整轮拒掉。NOT_FOUND 是确定性答案(行不存在 →
    // 必然无 goal),必须放行并以 _goalState=null 进容器。
    const rig = await startRig({
      loadGoalState: async () => {
        throw new GoalStateError("NOT_FOUND", "session not found");
      },
    });
    try {
      const token = await makeJwt("209");
      const ws = openClient(rig.gatewayPort, token);
      const frames = frameCollector(ws);
      await new Promise<void>((r) => ws.once("open", () => r()));
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "sess-goal-not-found", kind: "dm" },
        content: { text: "fresh session must reach container" },
      }));

      await waitFor(() =>
        rig.containerSeen.some(({ data }) => {
          const text = typeof data === "string" ? data : data.toString("utf8");
          return text.includes("fresh session must reach container");
        }),
      );
      const forwardedRaw = rig.containerSeen
        .map(({ data }) => (typeof data === "string" ? data : data.toString("utf8")))
        .find((text) => text.includes("fresh session must reach container"));
      assert.ok(forwardedRaw, "inbound must be forwarded to container");
      const forwarded = JSON.parse(forwardedRaw);
      assert.equal(forwarded._goalState, null);
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("authoritative user row is persisted before history load and current logical turn is excluded", async () => {
    const order: string[] = [];
    const replyTo = {
      messageId: "a-old",
      role: "assistant" as const,
      text: "older answer",
    };
    const rig = await startRig({
      persistMasterUserMessage: async (uid, sessionId, message) => {
        assert.equal(uid, 205n);
        assert.equal(sessionId, "sess-persist-order");
        assert.equal(message.id, "m-current-turn");
        assert.equal(message.text, "continue safely");
        assert.equal(message._modelText, "continue safely\n[attachment text]");
        assert.deepEqual(message._replyTo, replyTo);
        assert.deepEqual(message._media, [
          { kind: "file", url: "/api/media/visible.txt" },
        ]);
        assert.deepEqual(message._routing, {
          model: "gpt-5.6-sol",
          teamMode: true,
          effortLevel: "high",
        });
        order.push("persist");
        return { applied: true };
      },
      loadMasterSessionMessages: async (_uid, _sessionId, options) => {
        assert.deepEqual(order, ["persist"]);
        assert.equal(
          options.currentUserText,
          formatMessageReplyPrompt("continue safely\n[attachment text]", replyTo),
        );
        order.push("history");
        return [
          { id: "u-old", role: "user", text: "older question", ts: 1 },
          { id: "a-old", role: "assistant", text: "older answer", status: "completed", ts: 2 },
          { id: "m-current-turn", role: "user", text: "continue safely", ts: 3 },
          { id: "a-failed", role: "assistant", text: "old failed projection", _clientMessageId: "m-current-turn", status: "crashed", ts: 4 },
        ];
      },
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("205"));
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      const containerWs = await containerOpenP;
      const forwardedP = new Promise<Record<string, unknown>>((resolve) => {
        containerWs.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "sess-persist-order", kind: "dm" },
        clientMessageId: "m-current-turn",
        model: "gpt-5.6-sol",
        effortLevel: "high",
        teamMode: true,
        content: {
          text: "continue safely\n[attachment text]",
          displayText: "continue safely",
          media: [
            { kind: "file", url: "/api/media/visible.txt" },
            { kind: "file", url: "/api/media/hidden.txt", hidden: true },
          ],
          replyTo,
        },
      }));
      const forwarded = await forwardedP;
      assert.deepEqual(order, ["persist", "history"]);
      assert.deepEqual(forwarded._masterHistoricalMessages, [
        { id: "u-old", role: "user", text: "older question", ts: 1 },
        { id: "a-old", role: "assistant", text: "older answer", status: "completed", ts: 2 },
      ]);
      assert.deepEqual((forwarded.content as { replyTo?: unknown }).replyTo, replyTo);
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("browser workspace mode is stripped and replaced with the database authority", async () => {
    const rig = await startRig({
      persistMasterUserMessage: async () => ({ applied: true }),
      loadSessionWorkspaceMode: async (uid, sessionId) => {
        assert.equal(uid, 211n);
        assert.equal(sessionId, "sess-workspace-authority");
        return "isolated_v1";
      },
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("211"));
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      const containerWs = await containerOpenP;
      const forwardedP = new Promise<Record<string, unknown>>((resolve) => {
        containerWs.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "sess-workspace-authority", kind: "dm" },
        clientMessageId: "m-workspace-authority",
        idempotencyKey: "web:m-workspace-authority:0",
        content: { text: "isolate me" },
        _workspaceMode: "legacy",
      }));
      const forwarded = await forwardedP;
      assert.equal(forwarded._workspaceMode, "isolated_v1");
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("an unavailable authoritative workspace mode rejects before container execution", async () => {
    const rig = await startRig({
      persistMasterUserMessage: async () => ({ applied: true }),
      loadSessionWorkspaceMode: async () => null,
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("212"));
      const frames = frameCollector(ws);
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      await containerOpenP;
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "sess-workspace-missing", kind: "dm" },
        clientMessageId: "m-workspace-missing",
        idempotencyKey: "web:m-workspace-missing:0",
        content: { text: "must not execute" },
      }));
      let errorFrame: { type?: string; code?: string } = {};
      for (let i = 0; i < 3 && errorFrame.type !== "error"; i++) {
        errorFrame = JSON.parse(await frames.next()) as { type?: string; code?: string };
      }
      assert.equal(errorFrame.type, "error");
      assert.equal(errorFrame.code, "SESSION_WORKSPACE_UNAVAILABLE");
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.equal(
        rig.containerSeen.some(({ data }) => data.toString().includes("must not execute")),
        false,
      );
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("completed clientMessageId deduplicates with exact ACK and no container execution", async () => {
    const rig = await startRig({
      persistMasterUserMessage: async () => ({ applied: false, reason: "already_exists" }),
      loadMasterSessionMessages: async () => [
        { id: "m-done", role: "user", text: "do once", ts: 1 },
        { id: "srv-done", role: "assistant", text: "already complete", status: "completed", _clientMessageId: "m-done", ts: 2 },
      ],
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("206"));
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      await containerOpenP;
      const fc = frameCollector(ws);
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "sess-done", kind: "dm" },
        clientMessageId: "m-done",
        idempotencyKey: "web:m-done:0",
        model: "gpt-5.6-sol",
        content: { text: "do once" },
      }));
      const ack = await nextBusinessFrame(fc);
      assert.deepEqual(ack, {
        type: "outbound.ack",
        deduplicated: true,
        idempotencyKey: "web:m-done:0",
        peer: { id: "sess-done", kind: "dm" },
        clientMessageId: "m-done",
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.equal(rig.containerSeen.some((entry) => {
        try { return JSON.parse(entry.data.toString()).type === "inbound.message"; }
        catch { return false; }
      }), false);
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("persistence admission failure is scoped and never starts container work", async () => {
    let attempts = 0;
    const rig = await startRig({
      persistMasterUserMessage: async () => {
        attempts += 1;
        return { applied: false, reason: "session_not_found" };
      },
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("207"));
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      await containerOpenP;
      const fc = frameCollector(ws);
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "sess-missing", kind: "dm" },
        clientMessageId: "m-not-admitted",
        model: "gpt-5.6-sol",
        content: { text: "must not execute" },
      }));
      const error = await nextBusinessFrame(fc);
      assert.equal(error.code, "SESSION_PERSIST_UNAVAILABLE");
      assert.deepEqual(error.peer, { id: "sess-missing", kind: "dm" });
      assert.equal(error.clientMessageId, "m-not-admitted");
      assert.equal(attempts, 3);
      assert.equal(rig.containerSeen.some((entry) => {
        try { return JSON.parse(entry.data.toString()).type === "inbound.message"; }
        catch { return false; }
      }), false);
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("paper DOI inbound.message gets hidden ScanSci hint only in forwarded frame", async () => {
    const rig = await startRig();
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const token = await makeJwt("205");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));
      const containerWs = await containerOpenP;

      const seenP = new Promise<Buffer | string>((r) => {
        containerWs.once("message", (d) => {
          r(typeof d === "string" ? d : Buffer.isBuffer(d) ? d : Buffer.concat(d as Buffer[]));
        });
      });
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "sess-paper", kind: "dm" },
        content: { text: "10.1038/nature12373" },
      }));
      const got = await seenP;
      const forwarded = JSON.parse(
        typeof got === "string" ? got : got.toString("utf8"),
      ) as { content?: { text?: string }; traceId?: string };
      assert.match(forwarded.traceId ?? "", /^[a-f0-9]{32}$/);
      assert.ok(forwarded.content?.text?.startsWith("10.1038/nature12373"));
      assert.ok((forwarded.content?.text ?? "").includes(SCANSCI_PAPER_HINT_MARKER));
      // 文献检索/引用权威已迁到 oc-* 研究 CLI:hint 必须指向 oc-lit/oc-cite,而非
      // 已退役的 scansci-pdf CLI(当前镜像 server-only,无 search/download 子命令——
      // 旧 hint 引导 `scansci-pdf search` 会让 agent 每次先必失败再回落)。
      assert.match(forwarded.content?.text ?? "", /oc-lit search/);
      assert.match(forwarded.content?.text ?? "", /oc-cite verify/);
      assert.doesNotMatch(forwarded.content?.text ?? "", /scansci_pdf_\*/);
      // 不得再把检索引导到 scansci-pdf(只能出现"不要用 scansci-pdf 做检索"这类禁用语)。
      assert.doesNotMatch(forwarded.content?.text ?? "", /先 `scansci-pdf` search/);
      assert.match(forwarded.content?.text ?? "", /WebSearch\/WebFetch/);

      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("ordinary inbound.message content.text is not paper-hinted", async () => {
    const rig = await startRig();
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const token = await makeJwt("206");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));
      const containerWs = await containerOpenP;

      const seenP = new Promise<Buffer | string>((r) => {
        containerWs.once("message", (d) => {
          r(typeof d === "string" ? d : Buffer.isBuffer(d) ? d : Buffer.concat(d as Buffer[]));
        });
      });
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "sess-normal", kind: "dm" },
        content: { text: "晚上吃什么？" },
      }));
      const got = await seenP;
      const forwarded = JSON.parse(
        typeof got === "string" ? got : got.toString("utf8"),
      ) as { content?: { text?: string } };
      assert.equal(forwarded.content?.text, "晚上吃什么？");

      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("第一帧带 gpt-5.6-sol(授权)→ 第二帧不带 model 仍按 lastSeenModelId 校验(review v1 follow-up)", async () => {
    // 场景:bridge lifetime 内 user 第一帧合法用了 gpt-5.6-sol;之后流式增量帧仅带
    // delta/text 不带 model。如果中间 admin 撤销了 grant,后续的 delta 帧也必须
    // 被拦(lastSeenModelId 兜底)。这里通过 mock checker 在 mid-session 切语义
    // 来模拟"撤销"。
    const state = { allowGpt: true };
    const rig = await startRig({
      loadAllowedModelChecker: async () => (id: string) => {
        if (id === "claude-opus-4-7") return true;
        if (id === "gpt-5.6-sol") return state.allowGpt;
        return false;
      },
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const token = await makeJwt("203");
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));
      const containerWs = await containerOpenP;

      // 1) 首帧带 gpt-5.6-sol,被授权 → 透传
      const firstP = new Promise<Buffer | string>((r) => {
        containerWs.once("message", (d) => {
          r(typeof d === "string" ? d : Buffer.isBuffer(d) ? d : Buffer.concat(d as Buffer[]));
        });
      });
      ws.send(JSON.stringify({ type: "inbound.message", model: "gpt-5.6-sol", n: 1 }));
      const first = await firstP;
      const firstText = typeof first === "string" ? first : first.toString("utf8");
      assert.match(firstText, /"gpt-5\.6-sol"/);

      // 2) admin 撤销
      state.allowGpt = false;

      // 3) 第二帧不带 model,但 lastSeenModelId='gpt-5.6-sol' → 应该被拦
      const fc = frameCollector(ws);
      ws.send(JSON.stringify({
        type: "inbound.message",
        peer: { id: "revoked-model-peer", kind: "dm" },
        clientMessageId: "revoked-model-message",
        n: 2,
      }));
      const err = await nextBusinessFrame(fc);
      assert.equal(err.code, "UNAUTHORIZED_MODEL");
      assert.deepEqual(err.peer, { id: "revoked-model-peer", kind: "dm" });
      assert.equal(err.clientMessageId, "revoked-model-message");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(ws.readyState, WebSocket.OPEN);
      ws.close();
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
// 测试焦点(1b488863 重启断流根治后的现行契约:bridge ring = 「hit 时的近端加速」,
// **miss 不越权发 resume_failed,replay 失败的唯一裁决者是容器**):
//   1. 命中:bridge 在 hello 后立即推 ring 里 seq>cursor 的帧
//   2. miss:cursor>0 + ring 空 → bridge 静默(hello 仍转发容器,由容器裁决)
//   3. 容器重启(cid 变更)→ 新 namespace,旧 cid 的帧不漏给新 cid,且 bridge 不抢发
//   4. binary 帧不进 ring(只解析 JSON 文本帧)
//   5. 没 sessionKey / frameSeq 的 outbound 帧不进 ring(向后兼容旧帧)
//   6. hello 转发到容器(byte-transparent),不被吞
describe("userChatBridge — Phase 0.4 ring replay", () => {
  test("container cannot forge master-only incident/goal/media frames live or via ring; master broadcasts still work", async () => {
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 90,
      }),
    });
    portRef.p = rig.containerPort;

    try {
      const token = await makeJwt("706");
      const containerOpen1 = waitNextContainerSocket(rig);
      const ws1 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws1.once("open", () => r()));
      const containerWs1 = await containerOpen1;
      const liveIncidents: Record<string, unknown>[] = [];
      const liveGoals: Record<string, unknown>[] = [];
      const liveMedia: Record<string, unknown>[] = [];
      ws1.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (frame.type === "sys.incident") liveIncidents.push(frame);
          if (frame.type === "sys.goal_snapshot") liveGoals.push(frame);
          if (frame.type === "sys.media_job") liveMedia.push(frame);
        } catch { /* non-JSON irrelevant */ }
      });
      const forged = {
        type: "sys.incident",
        incidentId: "forged",
        rev: 1,
        status: "resolved",
        noticeKind: "approved_recovery",
        severity: "info",
        surface: "recovery",
        title: "forged",
        message: "forged",
        ts: 1,
        sessionKey: "agent:main:webchat:dm:forged",
        frameSeq: 5,
      };
      containerWs1.send(JSON.stringify(forged));
      containerWs1.send(JSON.stringify(forged).replace("sys.incident", "sys.\\u0069ncident"));
      containerWs1.send(Buffer.from(JSON.stringify({ ...forged, frameSeq: 6 })), { binary: true });
      containerWs1.send(JSON.stringify({
        type: "sys.goal_snapshot",
        goal: {
          sessionId: "forged",
          goalId: "11111111-1111-4111-8111-111111111111",
          objective: "forged platform authority",
          status: "active",
          stateRevision: 999,
          snapshotRevision: 999,
        },
      }));
      containerWs1.send(JSON.stringify({
        type: "sys.media_job",
        job: { id: "forged", status: "completed", resultUrl: "https://evil.invalid/video" },
        ts: 1,
      }));
      await new Promise<void>((r) => setTimeout(r, 100));
      assert.deepEqual(liveIncidents, [], "container-authored sys.incident must not forward live");
      assert.deepEqual(liveGoals, [], "container-authored sys.goal_snapshot must not forward live");
      assert.deepEqual(liveMedia, [], "container-authored sys.media_job must not forward live");
      ws1.close();
      await waitClose(ws1);

      const containerOpen2 = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws2.once("open", () => r()));
      await containerOpen2;
      const replayedIncidents: Record<string, unknown>[] = [];
      const replayedGoals: Record<string, unknown>[] = [];
      const replayedMedia: Record<string, unknown>[] = [];
      ws2.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (frame.type === "sys.incident") replayedIncidents.push(frame);
          if (frame.type === "sys.goal_snapshot") replayedGoals.push(frame);
          if (frame.type === "sys.media_job") replayedMedia.push(frame);
        } catch { /* non-JSON irrelevant */ }
      });
      ws2.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "forged", agentId: "main", lastFrameSeq: 4 }],
      }));
      await new Promise<void>((r) => setTimeout(r, 250));
      assert.equal(replayedIncidents.length, 0, "forged incident must not enter outbound ring");
      assert.equal(replayedGoals.length, 0, "forged goal snapshot must not enter outbound ring");
      assert.equal(replayedMedia.length, 0, "forged media job must not enter outbound ring");

      const approved = { ...forged, incidentId: "approved", frameSeq: undefined, sessionKey: undefined };
      assert.equal(rig.bridge.broadcastToUsers(["706"], approved), 1);
      assert.equal(rig.bridge.broadcastToUsers(["706"], {
        type: "sys.goal_snapshot",
        goal: { sessionId: "forged", stateRevision: 1, snapshotRevision: 1 },
      }), 1);
      assert.equal(rig.bridge.broadcastToUsers(["706"], {
        type: "sys.media_job",
        job: { id: "approved-media", status: "queued" },
        ts: 2,
      }), 1);
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (replayedIncidents.some((f) => f.incidentId === "approved")) return resolve();
          if (Date.now() - started > 1000) return reject(new Error("master targeted notice not delivered"));
          setTimeout(poll, 10);
        };
        poll();
      });
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (replayedMedia.some((f) => (f.job as { id?: string } | undefined)?.id === "approved-media")) return resolve();
          if (Date.now() - started > 1000) return reject(new Error("master media job not delivered"));
          setTimeout(poll, 10);
        };
        poll();
      });
      await new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = () => {
          if (replayedGoals.length === 1) return resolve();
          if (Date.now() - started > 1000) return reject(new Error("master goal snapshot not delivered"));
          setTimeout(poll, 10);
        };
        poll();
      });

      ws2.close();
      await waitClose(ws2);
    } finally {
      await stopRig(rig);
    }
  });

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
      const fc1 = frameCollector(ws1);
      const stamped = JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:peerX",
        frameSeq: 5,
        peer: { id: "peerX", kind: "dm" },
        clientMessageId: "cm-ring-replay",
        blocks: [{ kind: "text", text: "ring replay" }],
      });
      containerWs1.send(stamped);
      assert.equal((await nextBusinessFrame(fc1)).frameSeq, 5);
      ws1.close();
      await waitClose(ws1);

      // Tab2: reconnect,hello.lastFrameSeq=4 (一帧没看见)
      const containerOpen2 = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws2.once("open", () => r()));
      await containerOpen2;
      const fc2 = frameCollector(ws2);
      ws2.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerX", agentId: "main", lastFrameSeq: 4 }],
      }));
      const replayed = await nextBusinessFrame(fc2);
      assert.equal(replayed.frameSeq, 5, "ring replay 必须把 seq=5 推下来");
      assert.equal(replayed.sessionKey, "agent:main:webchat:dm:peerX");

      ws2.close();
      await waitClose(ws2);
    } finally {
      await stopRig(rig);
    }
  });

  test("hello with cursor>0 + empty ring → bridge 静默不越权(hello 仍转发容器裁决)", async () => {
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
      const fc = frameCollector(ws);
      ws.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerY", agentId: "main", lastFrameSeq: 100 }],
      }));

      // 现行契约(1b488863):miss 时 bridge 刻意不发 resume_failed——master 重启后
      // bridge ring 恒空,抢发会用 REST 快照覆盖容器随后完好的重放(boss 实测丢内容)。
      // ① hello 必须原样到达容器(裁决权移交);② 客户端在窗口内收不到任何业务帧。
      await new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const poll = () => {
          const seen = rig.containerSeen.some((m) => {
            try { return JSON.parse(m.data.toString()).type === "inbound.hello"; }
            catch { return false; }
          });
          if (seen) return resolve();
          if (Date.now() - t0 > 1000) return reject(new Error("hello 未转发到容器"));
          setTimeout(poll, 20);
        };
        poll();
      });
      const got = await Promise.race([
        nextBusinessFrame(fc),
        new Promise<null>((r) => setTimeout(() => r(null), 250)),
      ]);
      assert.equal(got, null,
        `miss 时 bridge 不得越权发任何业务帧(收到 ${JSON.stringify(got)}),裁决权在容器`);

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
      const fc1 = frameCollector(ws1);
      containerWs1.send(JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:peerZ",
        frameSeq: 3,
        peer: { id: "peerZ", kind: "dm" },
        clientMessageId: "cm-ring-old-container",
        blocks: [{ kind: "text", text: "old container" }],
      }));
      await nextBusinessFrame(fc1);
      ws1.close();
      await waitClose(ws1);

      // 容器重启 → cid=200,新 storeKey namespace 空
      cid = 200;
      const containerOpen2 = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws2.once("open", () => r()));
      await containerOpen2;
      const fc2 = frameCollector(ws2);
      ws2.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerZ", agentId: "main", lastFrameSeq: 2 }],
      }));
      // 核心不变量:旧 cid 的 seq=3 绝不能漏给新生命周期;且现行契约下 bridge 对
      // miss 保持静默(不越权 resume_failed,裁决在容器)→ 窗口内应零业务帧。
      const got = await Promise.race([
        nextBusinessFrame(fc2),
        new Promise<null>((r) => setTimeout(() => r(null), 250)),
      ]);
      assert.equal(got, null,
        `新 cid namespace 必须为空且 bridge 不抢发(收到 ${JSON.stringify(got)})`);

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
      // 负断言只看业务帧:sys.*(relay_ready 等连接性帧)何时到达取决于 relay 建立时序,
      // 不属于本断言语义(曾用 once 抓首帧,撞上 relay_ready 即假失败)。
      const businessMsgs: string[] = [];
      ws2.on("message", (data) => {
        const s = data.toString();
        try {
          if (!String(JSON.parse(s)?.type ?? "").startsWith("sys.")) businessMsgs.push(s);
        } catch { businessMsgs.push(s); }
      });
      ws2.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerW", agentId: "main", lastFrameSeq: 0 }],
      }));
      await new Promise<void>((r) => setTimeout(r, 250));
      assert.deepEqual(businessMsgs, [],
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
        peers: [{
          peerId: "peerH",
          agentId: "main",
          lastFrameSeq: 0,
          resumeActiveTurnCandidateMessageIds: ["m-queued", "m-running"],
        }],
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
      // 等第一条 **binary** 帧(text 侧可能先来 sys.relay_ready,once 抓任意首帧会误配)
      const recvBinaryP = new Promise<{ isBinary: boolean }>((resolve) => {
        const onMsg = (_d: unknown, isBinary: boolean) => {
          if (!isBinary) return;
          ws1.off("message", onMsg);
          resolve({ isBinary });
        };
        ws1.on("message", onMsg);
      });
      // binary 帧 — 即便里面 ASCII 看起来像 JSON 也不该被当 JSON 解析
      const bin = Buffer.from('{"sessionKey":"x","frameSeq":99}');
      containerWs1.send(bin, { binary: true });
      const recv1 = await recvBinaryP;
      assert.equal(recv1.isBinary, true, "binary 帧透传保 isBinary 标志");
      ws1.close();
      await waitClose(ws1);

      // Tab2: cursor=98 — binary 不进 ring → miss;现行契约下 bridge 对 miss 静默
      // (不越权 resume_failed,裁决在容器),窗口内应零业务帧。
      const containerOpen2 = waitNextContainerSocket(rig);
      const ws2 = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws2.once("open", () => r()));
      await containerOpen2;
      const fc2 = frameCollector(ws2);
      ws2.send(JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "x", agentId: "main", lastFrameSeq: 98 }],
      }));
      const got2 = await Promise.race([
        nextBusinessFrame(fc2),
        new Promise<null>((r) => setTimeout(() => r(null), 250)),
      ]);
      assert.equal(got2, null,
        `binary 帧不能进 ring(cursor>0 必 miss),且 miss 时 bridge 静默(收到 ${JSON.stringify(got2)})`);

      ws2.close();
      await waitClose(ws2);
    } finally {
      await stopRig(rig);
    }
  });
});

// ──────────── hello 终态回落(容器重建后 PG 补 isFinal) ────────────
//
// 容器侧 autoResumeFromHello 只查进程内存环,重建后为空,只能发
// turn_state_unknown(isFinal:false),前端不清发送态。宿主桥有 PG,
// 在 hello 转发之后按 inFlightClientMessageId 查 turn_dispatches,
// 终态时给本条 userWs 补一帧。

function rawDispatchRow(input: {
  userId: string;
  sessionId: string;
  clientMessageId: string;
  status: string;
  outcome: string | null;
}): Record<string, unknown> {
  return {
    dispatch_id: "d-hello-terminal",
    user_id: input.userId,
    session_id: input.sessionId,
    client_message_id: input.clientMessageId,
    agent_id: "main",
    model: null,
    request_hash: "hash",
    billing_request_id: "bill",
    attempt_no: 1,
    status: input.status,
    outcome: input.outcome,
    failure_code: null,
    conflict_reason: null,
    resolution: null,
    resolved_at: null,
    client_notified: false,
    owner_id: null,
    lease_epoch: "1",
    lease_until: null,
    anchor_seq: null,
    admitted_at: new Date(),
    accepted_at: null,
    terminal_at: input.status === "terminal" ? new Date() : null,
    last_attempt_at: null,
  };
}

function helloTerminalBillingTrio(opts: {
  row?: Record<string, unknown> | null;
  lookups?: unknown[][];
  beforeTurnDispatchLookup?: () => Promise<void>;
}): Pick<UserChatBridgeDeps, "pgPool" | "preCheckRedis" | "pricing"> {
  const lookups = opts.lookups ?? [];
  return {
    pgPool: {
      query: async (sql: unknown, params?: unknown[]) => {
        const text = typeof sql === "string"
          ? sql
          : String((sql as { text?: unknown })?.text ?? "");
        if (/SELECT status FROM users WHERE id/.test(text)) {
          return { rows: [{ status: "active" }], rowCount: 1 };
        }
        if (/FROM turn_dispatches/.test(text) && /client_message_id/.test(text)) {
          if (opts.beforeTurnDispatchLookup) await opts.beforeTurnDispatchLookup();
          lookups.push(params ?? []);
          return opts.row
            ? { rows: [opts.row], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as UserChatBridgeDeps["pgPool"],
    preCheckRedis: {
      async atomicReserve() {
        return { ok: true as const, locked: 0n, needed: 0n };
      },
      async releaseReservation() {
        return true;
      },
    } as UserChatBridgeDeps["preCheckRedis"],
    pricing: {
      get() { return null; },
    } as unknown as UserChatBridgeDeps["pricing"],
  };
}

async function waitHelloForwarded(
  rig: TestRig,
  helloFrame: string,
  timeoutMs = 1000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      const seen = rig.containerSeen.some((m) => {
        const s = typeof m.data === "string" ? m.data : m.data.toString("utf8");
        return s === helloFrame;
      });
      if (seen) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error("hello 未转发到容器"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

describe("userChatBridge — hello terminal dispatch fallback", () => {
  async function openHelloRig(opts: {
    uid: string;
    containerId: number;
    row?: Record<string, unknown> | null;
    lookups?: unknown[][];
    beforeTurnDispatchLookup?: () => Promise<void>;
  }): Promise<{
    rig: TestRig;
    ws: WebSocket;
    lookups: unknown[][];
  }> {
    const lookups = opts.lookups ?? [];
    const trio = helloTerminalBillingTrio({
      row: opts.row,
      lookups,
      beforeTurnDispatchLookup: opts.beforeTurnDispatchLookup,
    });
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: opts.containerId,
      }),
      ...trio,
    });
    portRef.p = rig.containerPort;
    const containerOpen = waitNextContainerSocket(rig);
    const token = await makeJwt(opts.uid);
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    await containerOpen;
    return { rig, ws, lookups };
  }

  test("hello + inFlight + terminal/completed → 本条 userWs 收到 turn_completed", async () => {
    const uid = "801";
    const peerId = "peerCompleted";
    const clientMessageId = "cm-completed";
    const { rig, ws } = await openHelloRig({
      uid,
      containerId: 801,
      row: rawDispatchRow({
        userId: uid,
        sessionId: peerId,
        clientMessageId,
        status: "terminal",
        outcome: "completed",
      }),
    });
    try {
      const fc = frameCollector(ws);
      const helloFrame = JSON.stringify({
        type: "inbound.hello",
        peers: [{
          peerId,
          agentId: "main",
          lastFrameSeq: 0,
          inFlight: true,
          inFlightClientMessageId: clientMessageId,
        }],
      });
      ws.send(helloFrame);
      await waitHelloForwarded(rig, helloFrame);
      const frame = await nextBusinessFrame(fc);
      assert.equal(frame.type, "outbound.message");
      assert.equal(frame.isFinal, true);
      assert.equal((frame.meta as { reconcile?: unknown })?.reconcile, "turn_completed");
      assert.equal(frame.clientMessageId, clientMessageId);
      assert.equal((frame.meta as { clientMessageId?: unknown })?.clientMessageId, clientMessageId);
      assert.deepEqual(frame.peer, { id: peerId, kind: "dm" });
      assert.deepEqual(frame.blocks, []);
      assert.equal(frame.channel, "webchat");
    } finally {
      ws.close();
      await waitClose(ws);
      await stopRig(rig);
    }
  });

  test("hello + inFlight + terminal/interrupted → meta.reconcile==='interrupted'", async () => {
    const uid = "802";
    const peerId = "peerInterrupted";
    const clientMessageId = "cm-interrupted";
    const { rig, ws } = await openHelloRig({
      uid,
      containerId: 802,
      row: rawDispatchRow({
        userId: uid,
        sessionId: peerId,
        clientMessageId,
        status: "terminal",
        outcome: "interrupted",
      }),
    });
    try {
      const fc = frameCollector(ws);
      const helloFrame = JSON.stringify({
        type: "inbound.hello",
        peers: [{
          peerId,
          agentId: "main",
          lastFrameSeq: 0,
          inFlight: true,
          inFlightClientMessageId: clientMessageId,
        }],
      });
      ws.send(helloFrame);
      await waitHelloForwarded(rig, helloFrame);
      const frame = await nextBusinessFrame(fc);
      assert.equal(frame.isFinal, true);
      assert.equal((frame.meta as { reconcile?: unknown })?.reconcile, "interrupted");
      assert.equal(frame.clientMessageId, clientMessageId);
    } finally {
      ws.close();
      await waitClose(ws);
      await stopRig(rig);
    }
  });

  test("hello + inFlight + terminal/executed_error → 不发补帧", async () => {
    const uid = "803";
    const peerId = "peerExecErr";
    const clientMessageId = "cm-exec-error";
    const { rig, ws } = await openHelloRig({
      uid,
      containerId: 803,
      row: rawDispatchRow({
        userId: uid,
        sessionId: peerId,
        clientMessageId,
        status: "terminal",
        outcome: "executed_error",
      }),
    });
    try {
      const fc = frameCollector(ws);
      const helloFrame = JSON.stringify({
        type: "inbound.hello",
        peers: [{
          peerId,
          agentId: "main",
          lastFrameSeq: 0,
          inFlight: true,
          inFlightClientMessageId: clientMessageId,
        }],
      });
      ws.send(helloFrame);
      await waitHelloForwarded(rig, helloFrame);
      const got = await Promise.race([
        nextBusinessFrame(fc),
        new Promise<null>((r) => setTimeout(() => r(null), 250)),
      ]);
      assert.equal(got, null, `executed_error 不得发补帧(收到 ${JSON.stringify(got)})`);
    } finally {
      ws.close();
      await waitClose(ws);
      await stopRig(rig);
    }
  });

  test("hello + inFlight + 非 terminal(accepted) → 不发补帧", async () => {
    const uid = "804";
    const peerId = "peerAccepted";
    const clientMessageId = "cm-accepted";
    const { rig, ws } = await openHelloRig({
      uid,
      containerId: 804,
      row: rawDispatchRow({
        userId: uid,
        sessionId: peerId,
        clientMessageId,
        status: "accepted",
        outcome: null,
      }),
    });
    try {
      const fc = frameCollector(ws);
      const helloFrame = JSON.stringify({
        type: "inbound.hello",
        peers: [{
          peerId,
          agentId: "main",
          lastFrameSeq: 0,
          inFlight: true,
          inFlightClientMessageId: clientMessageId,
        }],
      });
      ws.send(helloFrame);
      await waitHelloForwarded(rig, helloFrame);
      const got = await Promise.race([
        nextBusinessFrame(fc),
        new Promise<null>((r) => setTimeout(() => r(null), 250)),
      ]);
      assert.equal(got, null, `非 terminal 不得发补帧(收到 ${JSON.stringify(got)})`);
    } finally {
      ws.close();
      await waitClose(ws);
      await stopRig(rig);
    }
  });

  test("hello 没有 inFlightClientMessageId → 不查 PG、不发帧", async () => {
    const lookups: unknown[][] = [];
    const uid = "805";
    const { rig, ws } = await openHelloRig({
      uid,
      containerId: 805,
      row: rawDispatchRow({
        userId: uid,
        sessionId: "peerNoInflight",
        clientMessageId: "cm-should-not-lookup",
        status: "terminal",
        outcome: "completed",
      }),
      lookups,
    });
    try {
      const fc = frameCollector(ws);
      const helloFrame = JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerNoInflight", agentId: "main", lastFrameSeq: 0, inFlight: true }],
      });
      const lookupsBefore = lookups.length;
      ws.send(helloFrame);
      await waitHelloForwarded(rig, helloFrame);
      const got = await Promise.race([
        nextBusinessFrame(fc),
        new Promise<null>((r) => setTimeout(() => r(null), 250)),
      ]);
      assert.equal(got, null, `无 inFlight 不得发补帧(收到 ${JSON.stringify(got)})`);
      assert.equal(lookups.length, lookupsBefore, "无 inFlightClientMessageId 不得查 turn_dispatches");
    } finally {
      ws.close();
      await waitClose(ws);
      await stopRig(rig);
    }
  });

  test("hello 仍照常转发给容器(补帧不得改变转发时机与内容)", async () => {
    const uid = "806";
    const peerId = "peerForward";
    const clientMessageId = "cm-forward";
    const { rig, ws } = await openHelloRig({
      uid,
      containerId: 806,
      row: rawDispatchRow({
        userId: uid,
        sessionId: peerId,
        clientMessageId,
        status: "terminal",
        outcome: "completed",
      }),
    });
    try {
      const helloFrame = JSON.stringify({
        type: "inbound.hello",
        peers: [{
          peerId,
          agentId: "main",
          lastFrameSeq: 0,
          inFlight: true,
          inFlightClientMessageId: clientMessageId,
          resumeActiveTurnCandidateMessageIds: ["m-queued", "m-running"],
        }],
      });
      ws.send(helloFrame);
      await waitHelloForwarded(rig, helloFrame);
      const containerSawHello = rig.containerSeen.find((m) => {
        const s = typeof m.data === "string" ? m.data : m.data.toString("utf8");
        return s === helloFrame;
      });
      assert.ok(containerSawHello,
        "hello 必须 byte-exact 透传到容器(container's autoResumeFromHello 要登记 containerWs)");
    } finally {
      ws.close();
      await waitClose(ws);
      await stopRig(rig);
    }
  });

  test("hello 带 12 个互异候选 → PG 查询次数不超过 8", async () => {
    const lookups: unknown[][] = [];
    const uid = "807";
    const { rig, ws } = await openHelloRig({
      uid,
      containerId: 807,
      row: rawDispatchRow({
        userId: uid,
        sessionId: "peerCap0",
        clientMessageId: "cm-cap-0",
        status: "terminal",
        outcome: "completed",
      }),
      lookups,
    });
    try {
      const peers = Array.from({ length: 12 }, (_, i) => ({
        peerId: `peerCap${i}`,
        agentId: "main",
        lastFrameSeq: 0,
        inFlight: true,
        inFlightClientMessageId: `cm-cap-${i}`,
      }));
      const helloFrame = JSON.stringify({ type: "inbound.hello", peers });
      const lookupsBefore = lookups.length;
      ws.send(helloFrame);
      await waitHelloForwarded(rig, helloFrame);
      const deadline = Date.now() + 1000;
      while (lookups.length - lookupsBefore < 8 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 80));
      const queried = lookups.length - lookupsBefore;
      assert.ok(queried <= 8, `超限候选不得再查 PG(实际 ${queried})`);
      assert.equal(queried, 8, "12 个合法互异候选应查满上限 8");
    } finally {
      ws.close();
      await waitClose(ws);
      await stopRig(rig);
    }
  });

  test("hello 带 5 个完全相同的 (peerId, clientMessageId) → 只查 1 次", async () => {
    const lookups: unknown[][] = [];
    const uid = "808";
    const peerId = "peerDup";
    const clientMessageId = "cm-dup";
    const { rig, ws } = await openHelloRig({
      uid,
      containerId: 808,
      row: rawDispatchRow({
        userId: uid,
        sessionId: peerId,
        clientMessageId,
        status: "terminal",
        outcome: "completed",
      }),
      lookups,
    });
    try {
      const peer = {
        peerId,
        agentId: "main",
        lastFrameSeq: 0,
        inFlight: true,
        inFlightClientMessageId: clientMessageId,
      };
      const helloFrame = JSON.stringify({
        type: "inbound.hello",
        peers: [peer, peer, peer, peer, peer],
      });
      const lookupsBefore = lookups.length;
      ws.send(helloFrame);
      await waitHelloForwarded(rig, helloFrame);
      const deadline = Date.now() + 1000;
      while (lookups.length - lookupsBefore < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(lookups.length - lookupsBefore, 1, "同一 (peer, id) 只应查一次");
    } finally {
      ws.close();
      await waitClose(ws);
      await stopRig(rig);
    }
  });

  test("hello + 超长 clientMessageId(>200) → 不查 PG、不发帧", async () => {
    const lookups: unknown[][] = [];
    const uid = "809";
    const peerId = "peerLongId";
    const clientMessageId = "a".repeat(201);
    const { rig, ws } = await openHelloRig({
      uid,
      containerId: 809,
      row: rawDispatchRow({
        userId: uid,
        sessionId: peerId,
        clientMessageId,
        status: "terminal",
        outcome: "completed",
      }),
      lookups,
    });
    try {
      const fc = frameCollector(ws);
      const helloFrame = JSON.stringify({
        type: "inbound.hello",
        peers: [{
          peerId,
          agentId: "main",
          lastFrameSeq: 0,
          inFlight: true,
          inFlightClientMessageId: clientMessageId,
        }],
      });
      const lookupsBefore = lookups.length;
      ws.send(helloFrame);
      await waitHelloForwarded(rig, helloFrame);
      const got = await Promise.race([
        nextBusinessFrame(fc),
        new Promise<null>((r) => setTimeout(() => r(null), 250)),
      ]);
      assert.equal(got, null, `超长 id 不得发补帧(收到 ${JSON.stringify(got)})`);
      assert.equal(lookups.length, lookupsBefore, "超长 clientMessageId 不得查 turn_dispatches");
    } finally {
      ws.close();
      await waitClose(ws);
      await stopRig(rig);
    }
  });

  test("hello 发出后立刻 close → 断开后不再继续查询", async () => {
    const lookups: unknown[][] = [];
    const uid = "810";
    let releaseLookup: () => void = () => {};
    const lookupGate = new Promise<void>((r) => { releaseLookup = r; });
    let firstEntered!: () => void;
    const firstLookupEntered = new Promise<void>((r) => { firstEntered = r; });
    const { rig, ws } = await openHelloRig({
      uid,
      containerId: 810,
      row: rawDispatchRow({
        userId: uid,
        sessionId: "peerClose0",
        clientMessageId: "cm-close-0",
        status: "terminal",
        outcome: "completed",
      }),
      lookups,
      beforeTurnDispatchLookup: async () => {
        firstEntered();
        await lookupGate;
      },
    });
    try {
      const fc = frameCollector(ws);
      const peers = [0, 1, 2].map((i) => ({
        peerId: `peerClose${i}`,
        agentId: "main",
        lastFrameSeq: 0,
        inFlight: true,
        inFlightClientMessageId: `cm-close-${i}`,
      }));
      const helloFrame = JSON.stringify({ type: "inbound.hello", peers });
      ws.send(helloFrame);
      await waitHelloForwarded(rig, helloFrame);
      await Promise.race([
        firstLookupEntered,
        new Promise((_, reject) => setTimeout(() => reject(new Error("未进入 PG 查询门闩")), 1000)),
      ]);
      ws.close();
      await waitClose(ws);
      releaseLookup();
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(lookups.length, 1, "断开后不得继续查后续候选");
      const got = await Promise.race([
        nextBusinessFrame(fc),
        new Promise<null>((r) => setTimeout(() => r(null), 150)),
      ]);
      assert.equal(got, null, `断开后不得发补帧(收到 ${JSON.stringify(got)})`);
    } finally {
      releaseLookup();
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

// ─── tryAutoRebindFlush — wedge regression tripwire (v1.0.119) ────────────
//
// 真根因 (2026-05-09 prod wedge):tryAutoRebindFlush finally 块仅判
// pendingRebindMap.size > 0 就同步递归调自己。当 hello peers 与
// pendingRebindMap.sessionIds 不交集时,buildAutoRebindFrames 返回
// matchedSessionIds=[],没消化任何 row,size 不变,finally 立即再次自调,
// V8 microtask 永远 spin → healthz timeout → systemd watchdog SIGKILL → wedge。
//
// 修复:加 `progressMade` 门控,只在本轮真消化了 row 时才再触发。
//
// 该函数是 upgrade handler 闭包内的局部函数,无法直接单测。这里用静态属性
// tripwire — 扫 userChatBridge.ts 源码确保 progressMade 门控存在,防止有人
// 未来把 bug 改回去。配套 docs/v3/code-review-checklist.md §1。
describe("tryAutoRebindFlush regression tripwire", () => {
  test("source contains progressMade gate in finally block", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(
      path.resolve(here, "..", "ws", "userChatBridge.ts"),
      "utf8",
    );
    // 剥块注释 + 行注释,防 comment-only false positive
    // (注释里带 "progressMade" 文案不能蒙混过关)
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    // 1) 闭包里有 progressMade 标志
    assert.match(
      src,
      /let\s+progressMade\s*=\s*false/,
      "tryAutoRebindFlush 必须声明 progressMade=false (wedge 修复 v1.0.119)",
    );
    // 2) try 块里 matchedSessionIds.length > 0 时置位
    assert.match(
      src,
      /matchedSessionIds\.length\s*>\s*0\s*\)\s*progressMade\s*=\s*true/,
      "progressMade 必须在 matchedSessionIds.length > 0 时置 true",
    );
    // 3) finally 块里再触发 tryAutoRebindFlush 的 if 条件中必须包含 progressMade。
    //    bug 还原:`if (pendingRebindMap.size > 0) tryAutoRebindFlush();` 同步递归 →
    //    V8 microtask 死循环。修复:`if (progressMade && ...) tryAutoRebindFlush()`。
    //    匹配 finally{...} 块里的 `if ( ... progressMade ... ) ... tryAutoRebindFlush(`,
    //    确保是真实代码条件而非注释。
    const finallyBlock = src.match(
      /finally\s*\{[\s\S]*?autoRebindFlushInFlight\s*=\s*false[\s\S]*?\}/,
    );
    assert.ok(finallyBlock, "找不到 tryAutoRebindFlush 的 finally 块");
    assert.match(
      finallyBlock![0],
      /if\s*\([^)]*progressMade[\s\S]*?tryAutoRebindFlush\s*\(/,
      "finally 块里再触发 tryAutoRebindFlush 的 if 条件必须包含 progressMade," +
        "不能只看 size > 0 (会触发 V8 microtask 死循环 — 见 v1.0.119 复盘)",
    );
  });
});

describe("Cursor external authority regression tripwire", () => {
  test("Cursor uses the existing non-CCB authority classification and credential/audit gates", async () => {
    const source = await readFile(new URL("../ws/userChatBridge.ts", import.meta.url), "utf8");
    const cursorBranch = source.slice(
      source.indexOf("if (isCursorInboundFrame && containerId !== undefined)"),
      source.indexOf("if (\n        isCodexInboundFrame &&", source.indexOf("if (isCursorInboundFrame && containerId !== undefined)")),
    );
    assert.match(cursorBranch, /classifiedCodex: true/);
    assert.match(cursorBranch, /isCursorCredentialMember\(uid\)/);
    assert.match(cursorBranch, /isCursorEngineModel\(modelCapture\)/);
    assert.match(cursorBranch, /authorityExec\.canonicalModel !== modelCapture/);
    assert.match(cursorBranch, /isCursorContainerOnSelfHost/);
    assert.match(cursorBranch, /INSERT INTO cursor_external_usage_audit/);
    assert.match(cursorBranch, /peerCapture, modelCapture/);
    assert.match(cursorBranch, /cursorTurnIdentity/);
    assert.match(
      cursorBranch,
      /sendErrorFrame\(userWs, 'CURSOR_UNAVAILABLE', 'Cursor requires the account-owned local runtime', cursorTurnIdentity\)/,
    );
    assert.match(
      cursorBranch,
      /sendErrorFrame\(userWs, 'UNAUTHORIZED_MODEL', 'Cursor is not enabled for this account', cursorTurnIdentity\)/,
    );
    assert.match(source, /settleCursorExternalUsage/);
  });

  test("ZCode uses an independent admission/audit branch and does not reuse Cursor gates", async () => {
    const source = await readFile(new URL("../ws/userChatBridge.ts", import.meta.url), "utf8");
    const start = source.indexOf("if (isZcodeInboundFrame && containerId !== undefined)");
    const end = source.indexOf("if (\n        isCodexInboundFrame &&", start);
    assert.notEqual(start, -1);
    const zcodeBranch = source.slice(start, end);
    assert.match(zcodeBranch, /insertPendingZcodeAudit/);
    assert.match(zcodeBranch, /authorityExec\.engine !== 'zcode'/);
    assert.match(zcodeBranch, /isZcodeEngineModel\(modelCapture\)/);
    assert.doesNotMatch(zcodeBranch, /isCursorCredentialMember/);
    assert.doesNotMatch(zcodeBranch, /isCursorContainerOnSelfHost/);
    assert.doesNotMatch(zcodeBranch, /settleCursorExternalUsage/);
    assert.match(source, /closeZcodeAudit/);
    assert.match(source, /closePendingZcodeAudits/);
    assert.match(source, /isCursorModel\(authorityModelForFrame\)/);
    assert.match(source, /isZcodeModel\(authorityModelForFrame\)/);
  });

  test("Cursor accepts only an active row on the trusted self host", async () => {
    const selfHostId = "bc99292f-7337-4552-aa8b-756f68f3b449";
    let storedHostId = selfHostId;
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pgPool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return {
          rowCount: storedHostId === params[2] ? 1 : 0,
          rows: storedHostId === params[2] ? [{ ok: 1 }] : [],
        };
      },
    } as unknown as Pool;

    assert.equal(await isCursorContainerOnSelfHost(pgPool, 6495, 4n, selfHostId), true);
    assert.deepEqual(calls[0]!.params, [6495, 4n, selfHostId]);
    assert.match(calls[0]!.sql, /state='active' AND host_uuid=\$3::uuid/);

    storedHostId = "b230af20-1cd9-4bd5-bc92-5e7f67065bea";
    assert.equal(await isCursorContainerOnSelfHost(pgPool, 6495, 4n, selfHostId), false);
  });

  test("Cursor fails closed without a trusted self host and does not query", async () => {
    let queryCount = 0;
    const pgPool = {
      query: async () => {
        queryCount += 1;
        return { rowCount: 1, rows: [{ ok: 1 }] };
      },
    } as unknown as Pool;

    assert.equal(await isCursorContainerOnSelfHost(pgPool, 6495, 4n, null), false);
    assert.equal(await isCursorContainerOnSelfHost(pgPool, 6495, 4n, undefined), false);
    assert.equal(await isCursorContainerOnSelfHost(pgPool, 6495, 4n, "  "), false);
    assert.equal(queryCount, 0);
  });
});

// ------- CG2a: master canonical traceId 注入 + clientTraceId observation ---
//
// plan §3.6 测试 3 用例:
//   (a) 无 clientTraceId → frame.traceId 是 32-hex 新生成,不等于 connId;
//                          logger 含 traceId 字段,不含 clientTraceId/Issue
//   (b) 合法 clientTraceId → frame.traceId 是新 canonical(不复用 clientTraceId);
//                            logger 含 clientTraceId 原值,不含 clientTraceIdIssue
//   (c) 非法 charset → canonical 仍生成;logger 只有 clientTraceIdIssue:'bad-charset';
//                      **mock 容器收到的 frame 不含 clientTraceId 字段**(MAJOR 1 sanitize)
//   (d) 超长 → logger clientTraceIdIssue:'too-long';frame strip clientTraceId
//   (e) 同 connection 多 turn → 两次 frame.traceId 不同,均 32-hex,均不复用 clientTraceId

interface CapturedLog {
  level: "info" | "warn" | "error" | "debug" | "trace";
  msg: string;
  fields?: Record<string, unknown>;
}

function makeCaptureLogger(): { log: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  // CG2b — child 返回累计 bindings 的子 logger;emit 时 spread base+fields 到 logs。
  // 这样 turnLog/connLog 的 child bindings(uid/connId/traceId)能进 fields,便于断言。
  function makeLogger(base: Record<string, unknown>): Logger {
    const mk = (level: CapturedLog["level"]) =>
      (msg: string, fields?: Record<string, unknown>) => {
        logs.push({ level, msg, fields: { ...base, ...fields } });
      };
    const self: Logger = {
      trace: mk("trace"),
      debug: mk("debug"),
      info: mk("info"),
      warn: mk("warn"),
      error: mk("error"),
      child: (bindings) => makeLogger({ ...base, ...bindings }),
    };
    return self;
  }
  return { log: makeLogger({}), logs };
}

/** 等容器侧收到 1 条 message frame 的工具。 */
async function waitContainerMessage(
  rig: TestRig,
  containerWs: WebSocket,
  timeoutMs = 1500,
): Promise<Record<string, unknown>> {
  void rig;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("container did not receive frame in time")), timeoutMs);
    containerWs.once("message", (data) => {
      clearTimeout(t);
      const text = typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.concat(data as Buffer[]).toString("utf8");
      try { resolve(JSON.parse(text) as Record<string, unknown>); }
      catch (e) { reject(e as Error); }
    });
  });
}

const TRACE_ID_REGEX = /^[A-Za-z0-9_-]{16,64}$/;
const TURN_START_MSG = "user-chat-bridge: inbound turn start";

describe("userChatBridge — CG2a canonical traceId injection", () => {
  let rig: TestRig;
  let logs: CapturedLog[];

  before(async () => {
    const capture = makeCaptureLogger();
    logs = capture.logs;
    rig = await startRig({ logger: capture.log });
  });
  after(async () => { await stopRig(rig); });

  test("(a) inbound.message 无 clientTraceId → frame.traceId 是新 32-hex,logger 无 client 字段", async () => {
    logs.length = 0;
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("9001");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    const recvP = waitContainerMessage(rig, containerWs);
    ws.send(JSON.stringify({
      type: "inbound.message",
      peer: { id: "peer-a", kind: "dm" },
      channel: "webchat",
      content: { text: "hi" },
    }));
    const frame = await recvP;

    assert.equal(typeof frame.traceId, "string", "frame 必须含 traceId");
    assert.match(frame.traceId as string, /^[a-f0-9]{32}$/, "32-hex from randomBytes");
    assert.ok(!("clientTraceId" in frame), "无 clientTraceId 字段(未传)");
    // V3 S12e CG10 — Contract 5a 私字段-absence 回归保护:bridge inbound
    // forward 路径除显式协议化的 master-owned workspace authority 外,不能把
    // `_userId` / `_traceId` / `_connectionTraceId` 等 gateway stash 泄到 wire。
    const privateKeys = Object.keys(frame).filter((k) => k.startsWith("_"));
    assert.deepEqual(
      privateKeys, ["_workspaceMode"],
      `wire frame must not carry _-prefixed private fields; got: ${privateKeys.join(",")}`,
    );
    assert.equal(frame._workspaceMode, "legacy");

    const turnLog = logs.find((l) => l.msg === TURN_START_MSG);
    assert.ok(turnLog, "找不到 turn start log");
    // CG2b — uid/connId/traceId 三件套均从 connLog→turnLog child bindings 注入。
    assert.equal(turnLog!.fields?.uid, "9001", "uid 经 connLog binding 注入");
    assert.equal(typeof turnLog!.fields?.connId, "string", "connId 经 connLog binding 注入");
    assert.equal(turnLog!.fields?.traceId, frame.traceId);
    assert.ok(!("clientTraceId" in (turnLog!.fields ?? {})), "无 clientTraceId");
    assert.ok(!("clientTraceIdIssue" in (turnLog!.fields ?? {})), "无 clientTraceIdIssue");

    ws.close();
    await waitClose(ws);
  });

  test("(b) 合法 clientTraceId → frame.traceId 独立 canonical,logger 含 clientTraceId 原值", async () => {
    logs.length = 0;
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("9002");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    const legalClientTrace = "client-1234567890abcdef";
    const recvP = waitContainerMessage(rig, containerWs);
    ws.send(JSON.stringify({
      type: "inbound.message",
      peer: { id: "peer-b", kind: "dm" },
      channel: "webchat",
      content: { text: "hi" },
      clientTraceId: legalClientTrace,
    }));
    const frame = await recvP;

    assert.equal(typeof frame.traceId, "string");
    assert.notEqual(frame.traceId, legalClientTrace, "canonical 必须独立生成,不复用 client 值");
    assert.match(frame.traceId as string, /^[a-f0-9]{32}$/);
    // 合法 clientTraceId 应保留透传(plan §3.5)
    assert.equal(frame.clientTraceId, legalClientTrace, "合法 clientTraceId 透传");

    const turnLog = logs.find((l) => l.msg === TURN_START_MSG);
    assert.ok(turnLog);
    assert.equal(turnLog!.fields?.clientTraceId, legalClientTrace);
    assert.ok(!("clientTraceIdIssue" in (turnLog!.fields ?? {})));

    ws.close();
    await waitClose(ws);
  });

  test("(c) 非法 charset clientTraceId → logger 只记 issue,frame strip clientTraceId", async () => {
    logs.length = 0;
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("9003");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    const recvP = waitContainerMessage(rig, containerWs);
    ws.send(JSON.stringify({
      type: "inbound.message",
      peer: { id: "peer-c", kind: "dm" },
      channel: "webchat",
      content: { text: "hi" },
      clientTraceId: "../etc/passwd_abc",
    }));
    const frame = await recvP;

    assert.match(frame.traceId as string, TRACE_ID_REGEX, "canonical 仍生成");
    assert.ok(!("clientTraceId" in frame), "非法 clientTraceId 必须从 forward frame strip");

    const turnLog = logs.find((l) => l.msg === TURN_START_MSG);
    assert.ok(turnLog);
    assert.equal(turnLog!.fields?.clientTraceIdIssue, "bad-charset");
    assert.ok(!("clientTraceId" in (turnLog!.fields ?? {})),
      "MAJOR 2:非法 raw 值禁止进入 logger");

    ws.close();
    await waitClose(ws);
  });

  test("(d) 超长 clientTraceId → logger 只记 too-long,frame strip", async () => {
    logs.length = 0;
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("9004");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    const recvP = waitContainerMessage(rig, containerWs);
    ws.send(JSON.stringify({
      type: "inbound.message",
      peer: { id: "peer-d", kind: "dm" },
      channel: "webchat",
      content: { text: "hi" },
      clientTraceId: "a".repeat(65),
    }));
    const frame = await recvP;

    assert.match(frame.traceId as string, TRACE_ID_REGEX);
    assert.ok(!("clientTraceId" in frame), "超长值必须 strip(防超长字符串撑大下游 log)");

    const turnLog = logs.find((l) => l.msg === TURN_START_MSG);
    assert.ok(turnLog);
    assert.equal(turnLog!.fields?.clientTraceIdIssue, "too-long");
    assert.ok(!("clientTraceId" in (turnLog!.fields ?? {})));

    ws.close();
    await waitClose(ws);
  });

  test("(e) 同 connection 多 turn → 两次 traceId 不同,均 canonical", async () => {
    logs.length = 0;
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("9005");
    const ws = openClient(rig.gatewayPort, token);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const containerWs = await containerOpenP;

    const recvP1 = waitContainerMessage(rig, containerWs);
    ws.send(JSON.stringify({
      type: "inbound.message",
      peer: { id: "peer-e", kind: "dm" },
      channel: "webchat",
      content: { text: "turn 1" },
    }));
    const frame1 = await recvP1;

    const recvP2 = waitContainerMessage(rig, containerWs);
    ws.send(JSON.stringify({
      type: "inbound.message",
      peer: { id: "peer-e", kind: "dm" },
      channel: "webchat",
      content: { text: "turn 2" },
    }));
    const frame2 = await recvP2;

    assert.match(frame1.traceId as string, /^[a-f0-9]{32}$/);
    assert.match(frame2.traceId as string, /^[a-f0-9]{32}$/);
    assert.notEqual(frame1.traceId, frame2.traceId,
      "每个 turn canonical 必须独立生成,不可复用上一 turn");

    const turnStartLogs = logs.filter((l) => l.msg === TURN_START_MSG);
    assert.equal(turnStartLogs.length, 2);
    assert.notEqual(turnStartLogs[0]!.fields?.traceId, turnStartLogs[1]!.fields?.traceId);
    // CG2b — 两个 turn 共享同一 connId(从 connLog 派生),uid 也都为 "9005"
    assert.equal(turnStartLogs[0]!.fields?.uid, "9005");
    assert.equal(turnStartLogs[1]!.fields?.uid, "9005");
    assert.equal(
      turnStartLogs[0]!.fields?.connId,
      turnStartLogs[1]!.fields?.connId,
      "同 connection 两 turn 必共享 connId binding",
    );

    ws.close();
    await waitClose(ws);
  });
});

// ------- 版本握手:sys.frontend_build ------------------------------------

describe("frontend build handshake", () => {
  test("注入 getFrontendBuildId → accept 即发 sys.frontend_build(auth 之前)", async () => {
    const rig = await startRig({ getFrontendBuildId: () => "a1b2c3d4e5f60718" });
    try {
      // 用非法 token 连:首帧仍必须是 sys.frontend_build(pre-auth 发送的语义锚点
      // ——过期 token 的旧前端也要能收到并自救),之后才是 UNAUTHORIZED 错误帧。
      const ws = new WebSocket(
        `ws://127.0.0.1:${rig.gatewayPort}${BRIDGE_WS_PATH}`,
        ["bearer", "not-a-jwt"],
      );
      // 两帧背靠背同步到达,必须用持久收帧器;逐次 waitMessage 会丢第二帧挂死(见 frameCollector)。
      const frames = frameCollector(ws);
      const first = JSON.parse(await frames.next()) as { type: string; build?: string };
      assert.equal(first.type, "sys.frontend_build");
      assert.equal(first.build, "a1b2c3d4e5f60718");
      const second = JSON.parse(await frames.next()) as { type: string };
      assert.notEqual(second.type, "sys.frontend_build");
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("probe 返回 null / 未注入 → 不发帧(v3 与既有行为零变化)", async () => {
    for (const probe of [undefined, () => null] as const) {
      const rig = await startRig(probe ? { getFrontendBuildId: probe } : {});
      try {
        const ws = new WebSocket(
          `ws://127.0.0.1:${rig.gatewayPort}${BRIDGE_WS_PATH}`,
          ["bearer", "not-a-jwt"],
        );
        const first = JSON.parse(String((await waitMessage(ws)).data)) as { type: string };
        assert.notEqual(first.type, "sys.frontend_build");
        await waitClose(ws);
      } finally {
        await stopRig(rig);
      }
    }
  });
});

describe("userChatBridge — session-scoped live frame fan-out", () => {
  test("stamped frames reach every hello subscriber of uid+session, not other sessions or uids", async () => {
    const portRef = { p: 0 };
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 91,
      }),
      maxPerUser: 4,
    });
    portRef.p = rig.containerPort;
    try {
      const tokenA = await makeJwt("910");
      const tokenB = await makeJwt("911");
      const openAndHello = async (token: string, sessionId: string) => {
        const nextContainer = waitNextContainerSocket(rig);
        const ws = openClient(rig.gatewayPort, token);
        await new Promise<void>((r) => ws.once("open", () => r()));
        await nextContainer;
        const hello = JSON.stringify({
          type: "inbound.hello",
          peers: [{ peerId: sessionId, agentId: "main", lastFrameSeq: 0 }],
        });
        const seenBefore = rig.containerSeen.length;
        ws.send(hello);
        await waitFor(() => rig.containerSeen.length > seenBefore);
        return { ws, fc: frameCollector(ws) };
      };
      const tab1 = await openAndHello(tokenA, "sessA");
      const tab2 = await openAndHello(tokenA, "sessA");
      const otherSess = await openAndHello(tokenA, "sessB");
      const otherUid = await openAndHello(tokenB, "sessA");

      const stamped = JSON.stringify({
        type: "outbound.message",
        sessionKey: "agent:main:webchat:dm:sessA",
        frameSeq: 7,
        peer: { id: "sessA", kind: "dm" },
        clientMessageId: "m-fanout",
        blocks: [],
      });
      rig.containerSockets[0]!.send(stamped);

      const got1 = await nextBusinessFrame(tab1.fc);
      const got2 = await nextBusinessFrame(tab2.fc);
      assert.equal(got1.frameSeq, 7);
      assert.equal(got2.frameSeq, 7);

      const leaked = await Promise.race([
        nextBusinessFrame(otherSess.fc).then((frame) => ({ who: "sessB", frame })),
        nextBusinessFrame(otherUid.fc).then((frame) => ({ who: "uidB", frame })),
        new Promise<null>((r) => setTimeout(() => r(null), 250)),
      ]);
      assert.equal(leaked, null, `fan-out leaked to ${JSON.stringify(leaked)}`);

      tab1.ws.close();
      tab2.ws.close();
      otherSess.ws.close();
      otherUid.ws.close();
      await Promise.all([
        waitClose(tab1.ws), waitClose(tab2.ws), waitClose(otherSess.ws), waitClose(otherUid.ws),
      ]);
    } finally {
      await stopRig(rig);
    }
  });
});

describe("userChatBridge — hello live-frame catch-up", () => {
  test("catch-up send path reuses bufferedAmount backpressure and does not cleanup the bridge", async () => {
    const source = await readFile(new URL("../ws/userChatBridge.ts", import.meta.url), "utf8");
    const start = source.indexOf("if (liveCatchupSessions.length > 0 && deps.pgPool)");
    const end = source.indexOf("Fall through to forwardInboundFrame below", start);
    assert.notEqual(start, -1);
    const block = source.slice(start, end);
    assert.match(block, /liveCatchupSendDecision/);
    assert.match(block, /CLOSE_BRIDGE\.TOO_BIG/);
    assert.match(block, /maxBytes:/);
    assert.match(block, /item\.kind === "oversize"/);
    assert.doesNotMatch(block, /cleanup\("/);
  });

  test("hello catches up open-dispatch live frames from PG when ring is empty", async () => {
    const portRef = { p: 0 };
    const catchupFrame = {
      type: "outbound.message",
      sessionKey: "agent:main:webchat:dm:peerCatch",
      frameSeq: 3,
      peer: { id: "peerCatch", kind: "dm" },
      clientMessageId: "cm-catch",
      blocks: [{ type: "text", text: "caught up" }],
    };
    const lookups: unknown[][] = [];
    const trio = helloTerminalBillingTrio({ row: null, lookups: [] });
    const innerQuery = trio.pgPool!.query.bind(trio.pgPool);
    trio.pgPool = {
      query: async (sql: unknown, params?: unknown[]) => {
        const text = typeof sql === "string"
          ? sql
          : String((sql as { text?: unknown })?.text ?? "");
        if (/client_session_live_frames/.test(text)) {
          lookups.push(params ?? []);
          return {
            rows: [{ payload: Buffer.from(JSON.stringify(catchupFrame), "utf8") }],
            rowCount: 1,
          };
        }
        return innerQuery(text, params);
      },
    } as UserChatBridgeDeps["pgPool"];
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 93,
      }),
      ...trio,
    });
    portRef.p = rig.containerPort;
    try {
      const token = await makeJwt("930");
      const nextContainer = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));
      await nextContainer;
      const fc = frameCollector(ws);
      const hello = JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "peerCatch", agentId: "main", lastFrameSeq: 0 }],
      });
      ws.send(hello);
      await waitHelloForwarded(rig, hello);
      const got = await nextBusinessFrame(fc);
      assert.equal(got.frameSeq, 3);
      assert.equal((got.blocks as Array<{ text?: string }>)[0]?.text, "caught up");
      assert.equal(lookups.length, 1);
      assert.equal(lookups[0]![1], "peerCatch");
      assert.equal(lookups[0]![0], "930");
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });

  test("hello catch-up queries the hello session, not another session id", async () => {
    const portRef = { p: 0 };
    const sessions: string[] = [];
    const trio = helloTerminalBillingTrio({ row: null, lookups: [] });
    const innerQuery = trio.pgPool!.query.bind(trio.pgPool);
    trio.pgPool = {
      query: async (sql: unknown, params?: unknown[]) => {
        const text = typeof sql === "string"
          ? sql
          : String((sql as { text?: unknown })?.text ?? "");
        if (/client_session_live_frames/.test(text)) {
          sessions.push(String(params?.[1] ?? ""));
          return { rows: [], rowCount: 0 };
        }
        return innerQuery(text, params);
      },
    } as UserChatBridgeDeps["pgPool"];
    const rig = await startRig({
      resolve: async () => ({
        host: "127.0.0.1", port: portRef.p, containerId: 94,
      }),
      ...trio,
    });
    portRef.p = rig.containerPort;
    try {
      const token = await makeJwt("940");
      const nextContainer = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, token);
      await new Promise<void>((r) => ws.once("open", () => r()));
      await nextContainer;
      const hello = JSON.stringify({
        type: "inbound.hello",
        peers: [{ peerId: "only-this-session", agentId: "main", lastFrameSeq: 2 }],
      });
      ws.send(hello);
      await waitHelloForwarded(rig, hello);
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(sessions, ["only-this-session"]);
      ws.close();
      await waitClose(ws);
    } finally {
      await stopRig(rig);
    }
  });
});

describe("inbound turn identity is frozen onto every parsed-turn error exit", () => {
  test("authority helpers and remaining parsed-turn errors carry frozen peer identity", async () => {
    const source = await readFile(new URL("../ws/userChatBridge.ts", import.meta.url), "utf8");
    assert.match(source, /inboundTurnIdentityForFrame = inboundTurnIdentityFromParsed\(parsed\)/);
    assert.match(source, /sendErrorFrame\(userWs, code, message, args\.turn\)/);
    assert.equal(
      source.split("sendErrorFrame(userWs, code, message, args.turn)").length - 1,
      2,
      "seal + resolve reject paths must both pass args.turn",
    );
    assert.match(
      source,
      /GOAL_STATE_UNAVAILABLE[\s\S]{0,180}\{ peerId, clientMessageId \}/,
    );
    for (const needle of [
      'sendErrorFrame(\n                userWs,\n                "AGENT_NOT_FOUND"',
      "inboundTurnIdentityForFrame",
    ]) {
      assert.ok(source.includes('inboundTurnIdentityForFrame'), needle);
    }
    assert.match(source, /"agent not found",[\s\S]{0,40}inboundTurnIdentityForFrame/);
    assert.match(source, /repair its required capabilities and retry`,[\s\S]{0,40}inboundTurnIdentityForFrame/);
    assert.match(source, /specify a model`,[\s\S]{0,40}inboundTurnIdentityForFrame/);
    assert.match(source, /trace invariant violated", annotatedTurnIdentity/);
    assert.match(source, /maxFrameBytes}`, annotatedTurnIdentity/);
    assert.match(source, /"internal error", annotatedTurnIdentity/);
    assert.match(source, /retry this turn shortly",[\s\S]{0,40}ccbTurnIdentity/);
    assert.match(source, /maxFrameBytes}`,[\s\S]{0,20}ccbTurnIdentity/);
    assert.match(source, /"internal error", ccbTurnIdentity/);
    assert.doesNotMatch(source, /firstSession\(\)/);
  });
});
