/**
 * T-52 — `/ws/agent` 单元测试。
 *
 * 覆盖:
 *   - auth failure → error frame + close 1008
 *   - hello roundtrip → frame 携带 hello_ack
 *   - tool roundtrip → frame + auditCalls 写一条
 *   - resolveSocketPath ENOENT → ERR_AGENT_UNAVAILABLE + close
 *   - maxPerUser=1 → 第二条连接踢掉第一条
 *
 * 用 fake unix socket server(`net.createServer`)模拟容器内 RPC server,不起真容器,
 * 不开真 pg。通过 `deps.writeAudit` 拦截 audit 写入。
 *
 * TODO(T-53): wsAgent.integ.test.ts once lifecycle provisioning lands —— 到时候
 * 接 real docker 容器 + real pg,跑 echo hello / bash echo hi 的端到端验收。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import * as net from "node:net";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { signAccess } from "../auth/jwt.js";
import { createAgentWsHandler, type AgentAuditRow } from "../ws/agent.js";

const JWT_SECRET = "z".repeat(64);

// -----------------------------
// Fake container RPC server
// -----------------------------
// 每个 test 按需起一个 net.createServer 绑到 tmp socket。收到的 JSON line 用注册的
// handler 决定如何回。没有 handler 就 echo 原样(加 \n)。
interface FakeServer {
  socketPath: string;
  close: () => Promise<void>;
  setHandler: (h: (line: string, sock: net.Socket) => void) => void;
}

function startFakeAgent(rootDir: string, suffix = ""): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const socketPath = join(rootDir, `agent${suffix}.sock`);
    let handler: (line: string, sock: net.Socket) => void = (line, sock) => {
      // default: echo
      sock.write(line + "\n");
    };
    const srv = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        let idx: number;
        while ((idx = buf.indexOf(0x0a)) >= 0) {
          const line = buf.subarray(0, idx).toString("utf8");
          buf = buf.subarray(idx + 1);
          if (line.length === 0) continue;
          try { handler(line, sock); } catch (err) { sock.destroy(err as Error); }
        }
      });
      sock.on("error", () => { /* drop */ });
    });
    srv.listen(socketPath, () => {
      resolve({
        socketPath,
        setHandler: (h) => { handler = h; },
        close: () =>
          new Promise<void>((r) => { try { srv.close(() => r()); } catch { r(); } }),
      });
    });
    srv.on("error", reject);
  });
}

// -----------------------------
// WS gateway fixture
// -----------------------------
interface Fixture {
  baseUrl: string;
  server: Server;
  shutdown: () => Promise<void>;
  auditCalls: AgentAuditRow[];
  setSocketPath: (uid: bigint | number, path: string) => void;
  resetSocketMap: () => void;
}

async function startGateway(opts: { maxPerUser?: number } = {}): Promise<Fixture> {
  const auditCalls: AgentAuditRow[] = [];
  const sockMap = new Map<string, string>();
  const setSocketPath = (uid: bigint | number, p: string) => sockMap.set(String(uid), p);
  const resetSocketMap = () => sockMap.clear();

  const handler = createAgentWsHandler({
    jwtSecret: JWT_SECRET,
    resolveSocketPath: (uid) => {
      const p = sockMap.get(String(uid));
      if (!p) return join(tmpdir(), "nonexistent-socket-for-user-" + uid); // ENOENT path
      return p;
    },
    writeAudit: async (row) => { auditCalls.push(row); },
    maxPerUser: opts.maxPerUser ?? 1,
  });

  const server = createServer((req, res) => { res.statusCode = 404; res.end("nope"); });
  server.on("upgrade", (req, socket, head) => {
    if (!handler.handleUpgrade(req, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `ws://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    server,
    auditCalls,
    setSocketPath,
    resetSocketMap,
    shutdown: async () => {
      await handler.shutdown();
      try { server.closeAllConnections(); } catch { /* */ }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * 打开 ws,并把所有 message 缓存进内存队列 —— 避免 open → attach listener 之间丢帧。
 * 返回 { ws, recvJson }。recvJson 会先从缓存里取,空的时候挂 waiter。
 */
type RecvFn = (timeoutMs?: number) => Promise<Record<string, unknown>>;
/** 扩展的 ws 句柄,缓存 close info,避免测试里 waitClose 抢在 close 事件之后挂 listener 拿到 code=0。 */
type WsHandle = { ws: WebSocket; recvJson: RecvFn; waitClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }> };

/** WeakMap: ws instance → cached close info (+ pending waiters)。供 standalone waitClose(ws) 复用。 */
const wsCloseCache: WeakMap<WebSocket, {
  closed: { code: number; reason: string } | null;
  waiters: Array<(v: { code: number; reason: string }) => void>;
}> = new WeakMap();

async function wsOpen(url: string): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: Record<string, unknown>[] = [];
    const waiters: Array<(v: Record<string, unknown>) => void> = [];
    const cache: { closed: { code: number; reason: string } | null; waiters: Array<(v: { code: number; reason: string }) => void> } = { closed: null, waiters: [] };
    wsCloseCache.set(ws, cache);
    ws.on("message", (data) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(data.toString()); }
      catch { return; }
      const w = waiters.shift();
      if (w) w(parsed);
      else queue.push(parsed);
    });
    // 预注册 close listener,避免 auth 失败路径上 server 直接 close 后测试
    // 挂 listener 慢一步拿不到 code(ws lib 不会 buffer 历史事件)。
    ws.on("close", (code, reason) => {
      const info = { code, reason: reason.toString() };
      cache.closed = info;
      for (const w of cache.waiters.splice(0)) w(info);
    });
    const recvJson: RecvFn = (timeoutMs = 2000) =>
      new Promise<Record<string, unknown>>((res, rej) => {
        const q = queue.shift();
        if (q) { res(q); return; }
        const onTimeout = () => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          rej(new Error("recv timeout"));
        };
        const to = setTimeout(onTimeout, timeoutMs);
        const waiter = (v: Record<string, unknown>) => { clearTimeout(to); res(v); };
        waiters.push(waiter);
      });
    const waitClose = (timeoutMs = 1500): Promise<{ code: number; reason: string }> =>
      new Promise((res, rej) => {
        if (cache.closed) { res(cache.closed); return; }
        const to = setTimeout(() => {
          const i = cache.waiters.indexOf(w);
          if (i >= 0) cache.waiters.splice(i, 1);
          rej(new Error("close timeout"));
        }, timeoutMs);
        const w = (info: { code: number; reason: string }) => { clearTimeout(to); res(info); };
        cache.waiters.push(w);
      });
    ws.once("open", () => resolve({ ws, recvJson, waitClose }));
    ws.once("error", (err) => {
      // open 之前出错
      if (cache.closed) return; // 已经由 close handler 解析
      reject(err);
    });
  });
}

/** 兼容旧调用位点:等 close,返回 { code, reason }。优先从 wsOpen 预注册的缓存读。 */
function waitClose(ws: WebSocket, timeoutMs = 1500): Promise<{ code: number; reason: string }> {
  const cache = wsCloseCache.get(ws);
  if (cache) {
    return new Promise((res, rej) => {
      if (cache.closed) { res(cache.closed); return; }
      const to = setTimeout(() => {
        const i = cache.waiters.indexOf(w);
        if (i >= 0) cache.waiters.splice(i, 1);
        rej(new Error("close timeout"));
      }, timeoutMs);
      const w = (info: { code: number; reason: string }) => { clearTimeout(to); res(info); };
      cache.waiters.push(w);
    });
  }
  // ws 未经 wsOpen 包装 —— fallback 到原来的路径
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.CLOSED) {
      resolve({ code: 0, reason: "already closed" });
      return;
    }
    const to = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.once("close", (code, reason) => {
      clearTimeout(to);
      resolve({ code, reason: reason.toString() });
    });
  });
}

// -----------------------------
// lifecycle
// -----------------------------
let rootDir: string;
let fakeServers: FakeServer[] = [];
let fixture: Fixture | null = null;

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), "ws-agent-ut-"));
});

after(async () => {
  for (const f of fakeServers) {
    try { await f.close(); } catch { /* */ }
  }
  if (fixture) { try { await fixture.shutdown(); } catch { /* */ } }
  if (rootDir && existsSync(rootDir)) {
    try { rmSync(rootDir, { recursive: true, force: true }); } catch { /* */ }
  }
});

beforeEach(async () => {
  // 每个 test 自己起干净 fixture + fakeServers
  for (const f of fakeServers) { try { await f.close(); } catch { /* */ } }
  fakeServers = [];
  if (fixture) { try { await fixture.shutdown(); } catch { /* */ } fixture = null; }
});

async function issueToken(sub: string): Promise<string> {
  const r = await signAccess({ sub, role: "user" }, JWT_SECRET);
  return r.token;
}

// -----------------------------
// tests
// -----------------------------
describe("ws agent handler", () => {
  test("auth failure: missing token → error frame + close 1008", async () => {
    fixture = await startGateway();
    const { ws, recvJson } = await wsOpen(`${fixture.baseUrl}/ws/agent`);
    const frame = await recvJson();
    assert.equal(frame.type, "error");
    assert.equal(frame.code, "UNAUTHORIZED");
    const { code } = await waitClose(ws);
    assert.equal(code, 1008);
  });

  test("auth failure: bad token → error frame + close 1008", async () => {
    fixture = await startGateway();
    const { ws, recvJson } = await wsOpen(`${fixture.baseUrl}/ws/agent?token=garbage.jwt.here`);
    const frame = await recvJson();
    assert.equal(frame.type, "error");
    assert.equal(frame.code, "UNAUTHORIZED");
    const { code } = await waitClose(ws);
    assert.equal(code, 1008);
  });

  test("hello roundtrip: client → container echoes back as frame", async () => {
    fixture = await startGateway();
    const fake = await startFakeAgent(rootDir, "-hello");
    fakeServers.push(fake);
    fake.setHandler((line, sock) => {
      const req = JSON.parse(line);
      if (req.type === "hello") {
        sock.write(JSON.stringify({
          type: "hello_ack", pid: 123, uid: "42", node_version: "v22.0.0", bun_version: "1.1.34",
        }) + "\n");
      }
    });
    fixture.setSocketPath(42, fake.socketPath);

    const token = await issueToken("42");
    const { ws, recvJson } = await wsOpen(`${fixture.baseUrl}/ws/agent?token=${encodeURIComponent(token)}`);

    const openFrame = await recvJson();
    assert.equal(openFrame.type, "open");
    assert.ok(typeof openFrame.session_id === "string" && (openFrame.session_id as string).length > 0);

    ws.send(JSON.stringify({ type: "hello" }));
    const resp = await recvJson();
    assert.equal(resp.type, "frame");
    const data = resp.data as Record<string, unknown>;
    assert.equal(data.type, "hello_ack");
    assert.equal(data.pid, 123);

    ws.close();
    await waitClose(ws).catch(() => { /* */ });
  });

  test("tool roundtrip: tool_result frame triggers auditCalls entry", async () => {
    fixture = await startGateway();
    const fake = await startFakeAgent(rootDir, "-tool");
    fakeServers.push(fake);
    fake.setHandler((line, sock) => {
      const req = JSON.parse(line);
      if (req.type === "tool") {
        sock.write(JSON.stringify({
          type: "tool_result",
          id: req.id,
          success: true,
          stdout: "hi\n",
          stderr: "",
          exit_code: 0,
          duration_ms: 7,
        }) + "\n");
      }
    });
    fixture.setSocketPath(42, fake.socketPath);

    const token = await issueToken("42");
    const { ws, recvJson } = await wsOpen(`${fixture.baseUrl}/ws/agent?token=${encodeURIComponent(token)}`);
    await recvJson(); // open frame

    ws.send(JSON.stringify({
      type: "tool",
      id: "t1",
      tool: "bash",
      args: { cmd: "echo hi" },
    }));

    const resp = await recvJson();
    assert.equal(resp.type, "frame");
    const data = resp.data as Record<string, unknown>;
    assert.equal(data.type, "tool_result");
    assert.equal(data.id, "t1");
    assert.equal(data.success, true);
    assert.equal(data.stdout, "hi\n");

    // 等 audit 异步落 —— auditWriter 是 Promise.resolve(),两次 microtask 即可 settle
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fixture.auditCalls.length, 1,
      "expected exactly one audit row for the successful tool call");
    const row = fixture.auditCalls[0];
    assert.equal(row.tool, "bash");
    assert.equal(row.success, true);
    assert.equal(row.user_id, "42");
    assert.ok(typeof row.session_id === "string" && row.session_id.length > 0);
    assert.ok(typeof row.input_hash === "string" && (row.input_hash as string).length === 64);
    assert.ok(typeof row.output_hash === "string" && (row.output_hash as string).length === 64);
    // duration_ms 优先拿容器返回的 7
    assert.equal(row.duration_ms, 7);
    assert.equal(row.error_msg, null);
    // input_meta 未超 4KB → 原样保留 args
    assert.deepEqual(row.input_meta, { cmd: "echo hi" });

    ws.close();
    await waitClose(ws).catch(() => { /* */ });
  });

  test("failed tool → audit row has success=false + error_msg", async () => {
    fixture = await startGateway();
    const fake = await startFakeAgent(rootDir, "-tool-fail");
    fakeServers.push(fake);
    fake.setHandler((line, sock) => {
      const req = JSON.parse(line);
      if (req.type === "tool") {
        sock.write(JSON.stringify({
          type: "tool_result",
          id: req.id,
          success: false,
          stdout: "",
          stderr: "boom\n",
          exit_code: 1,
          duration_ms: 2,
        }) + "\n");
      }
    });
    fixture.setSocketPath(9, fake.socketPath);

    const token = await issueToken("9");
    const { ws, recvJson } = await wsOpen(`${fixture.baseUrl}/ws/agent?token=${encodeURIComponent(token)}`);
    await recvJson(); // open

    ws.send(JSON.stringify({ type: "tool", id: "x", tool: "bash", args: { cmd: "false" } }));
    await recvJson(); // frame

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fixture.auditCalls.length, 1);
    const row = fixture.auditCalls[0];
    assert.equal(row.success, false);
    assert.ok(typeof row.error_msg === "string" && (row.error_msg as string).includes("boom"));

    ws.close();
    await waitClose(ws).catch(() => { /* */ });
  });

  test("socket path missing → ERR_AGENT_UNAVAILABLE + close", async () => {
    fixture = await startGateway();
    // 不调 setSocketPath → resolveSocketPath 返回一个不存在的路径

    const token = await issueToken("999");
    const { ws, recvJson } = await wsOpen(`${fixture.baseUrl}/ws/agent?token=${encodeURIComponent(token)}`);
    // 第一帧应是 error,不是 open
    const frame = await recvJson();
    assert.equal(frame.type, "error");
    assert.equal(frame.code, "ERR_AGENT_UNAVAILABLE");
    const { code } = await waitClose(ws);
    assert.equal(code, 1011);
  });

  test("maxPerUser=1: second connection kicks the first", async () => {
    fixture = await startGateway({ maxPerUser: 1 });
    const fake = await startFakeAgent(rootDir, "-kick");
    fakeServers.push(fake);
    fixture.setSocketPath(5, fake.socketPath);

    const token = await issueToken("5");
    const c1 = await wsOpen(`${fixture.baseUrl}/ws/agent?token=${encodeURIComponent(token)}`);
    const open1 = await c1.recvJson();
    assert.equal(open1.type, "open");

    const c2 = await wsOpen(`${fixture.baseUrl}/ws/agent?token=${encodeURIComponent(token)}`);
    // c1.ws 应收到 error + close(1008)
    const kicked = await c1.recvJson();
    assert.equal(kicked.type, "error");
    assert.equal(kicked.code, "ERR_CONN_KICKED");
    const closed = await waitClose(c1.ws);
    assert.equal(closed.code, 1008);

    // c2 正常
    const open2 = await c2.recvJson();
    assert.equal(open2.type, "open");

    c2.ws.close();
    await waitClose(c2.ws).catch(() => { /* */ });
  });
});
