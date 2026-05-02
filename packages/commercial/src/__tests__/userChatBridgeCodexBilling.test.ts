/**
 * PR2 v1.0.66 — userChatBridge codex 真扣费集成测试。
 *
 * 跑法: npx tsx --test src/__tests__/userChatBridgeCodexBilling.test.ts
 *
 * 与 userChatBridge.test.ts 互补:那个文件覆盖 byte-transparent 透传 + JWT + 容器
 * 拒绝等行为;本文件只覆盖 PR2 加进去的 codex 真扣费路径,包含:
 *   - happy path:inbound.message (codex) → 帧 rewrite + forwardRequestId 32-hex
 *     → 容器发 outbound.codex_billing → 用户收到 outbound.cost_charged
 *   - server-owned requestId 强制覆写 client 提供值(防伪造)
 *   - duplicate billing frame:同 requestId 收到第二次 → 只广播一次 cost_charged
 *   - safeNum sanitizer:容器侧发 NaN/string/Infinity → 不炸 onContainerMessage,
 *     按 0 token 走完 settle(cost=0 → 不广播 cost_charged)
 *   - drain 5s 窗口:user WS close 后容器仍可发 billing 帧 → settle 走完
 *   - drain timeout:窗口内未收到 billing → finalizer.fail() 触发 abortInflightJournal
 *   - legacy NULL 容器(acquired===null)依然每轮跑 billing(BLOCKER 修复回归)
 *
 * 测试夹具:与 userChatBridge.test.ts 同款 rig + fake pgPool / preCheckRedis /
 * PricingCache / codexBinding。不真起 PG / Redis。
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Pool, PoolClient } from "pg";
import { signAccess } from "../auth/jwt.js";
import {
  createUserChatBridge,
  BRIDGE_WS_PATH,
  type ResolveContainerEndpoint,
  type UserChatBridgeHandler,
  type CodexBindingHandle,
} from "../ws/userChatBridge.js";
import { PricingCache } from "../billing/pricing.js";
import type { ModelPricing } from "../billing/pricing.js";
import { InMemoryPreCheckRedis } from "../billing/preCheck.js";
import { _resetAgentMultiplierCacheForTests } from "../billing/agentMultiplier.js";
import { setPoolOverride, resetPool } from "../db/index.js";

const JWT_SECRET = "x".repeat(32);

const PRICING: ModelPricing = {
  model_id: "gpt-5.5",
  display_name: "GPT 5.5",
  input_per_mtok: 1000n,
  output_per_mtok: 5000n,
  cache_read_per_mtok: 100n,
  cache_write_per_mtok: 500n,
  multiplier: "1.000",
  enabled: true,
  sort_order: 0,
  visibility: "public",
  updated_at: new Date(0),
};

// ---------- Fake Pool(billing 路径只看 SQL 形状) -----------------------------

interface FakePoolControl {
  pool: Pool;
  /** 完整 SQL 调用记录 — 测试断言用。 */
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
}

function makeFakePool(opts: { userBalance?: bigint } = {}): FakePoolControl {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const balance = opts.userBalance ?? 1_000_000n;

  function record(sql: string, params: unknown[] | undefined): void {
    queries.push({ sql, params });
  }

  // pg query 重载太多,fake 实现用 any 绕开 typecheck。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeClient: any = {
    async query(sqlOrCfg: unknown, params?: unknown[]): Promise<unknown> {
      const sql =
        typeof sqlOrCfg === "string"
          ? sqlOrCfg
          : (sqlOrCfg as { text: string }).text;
      record(sql, params);
      const trimmed = sql.trim();
      if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (trimmed.startsWith("INSERT INTO usage_records")) {
        return { rows: [{ id: "100" }], rowCount: 1 };
      }
      if (trimmed.startsWith("SELECT credits")) {
        return { rows: [{ credits: balance.toString() }], rowCount: 1 };
      }
      if (trimmed.startsWith("UPDATE users SET credits")) {
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith("INSERT INTO credit_ledger")) {
        return { rows: [{ id: "200" }], rowCount: 1 };
      }
      if (trimmed.startsWith("UPDATE usage_records SET ledger_id")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fakeClient: unhandled SQL: ${trimmed.slice(0, 80)}`);
    },
    release(): void { /* */ },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakePool: any = {
    async connect(): Promise<PoolClient> { return fakeClient as PoolClient; },
    async query(sqlOrCfg: unknown, params?: unknown[]): Promise<unknown> {
      const sql =
        typeof sqlOrCfg === "string"
          ? sqlOrCfg
          : (sqlOrCfg as { text: string }).text;
      record(sql, params);
      const trimmed = sql.trim();
      // agent_cost_overrides:返空(默认 1.000)
      if (trimmed.startsWith("SELECT cost_multiplier FROM agent_cost_overrides")) {
        return { rows: [], rowCount: 0 };
      }
      // request_finalize_journal:INSERT inflight / UPDATE committed/aborted/finalizing
      if (trimmed.startsWith("INSERT INTO request_finalize_journal")) {
        return { rows: [], rowCount: 1 };
      }
      if (trimmed.startsWith("UPDATE request_finalize_journal")) {
        return { rows: [], rowCount: 1 };
      }
      // getBalance(userId)走 rootQuery 落 commercial/db getPool() —— 测试用
      // setPoolOverride 把 fakePool 装上,这里需要响应 SELECT credits FROM users
      if (trimmed.startsWith("SELECT credits::text AS credits FROM users")) {
        return { rows: [{ credits: balance.toString() }], rowCount: 1 };
      }
      throw new Error(`fakePool: unhandled SQL: ${trimmed.slice(0, 80)}`);
    },
    async end(): Promise<void> { /* noop for tests */ },
  };

  return { pool: fakePool as Pool, queries };
}

// ---------- Rig with billing deps ------------------------------------------

interface BillingRig {
  gateway: http.Server;
  bridge: UserChatBridgeHandler;
  gatewayPort: number;
  containerWss: WebSocketServer;
  containerPort: number;
  containerSockets: WebSocket[];
  poolCtrl: FakePoolControl;
  preCheckRedis: InMemoryPreCheckRedis;
  pricing: PricingCache;
  binding: { acquireCalls: number; releaseCalls: number };
}

async function startRig(opts: {
  userBalance?: bigint;
  acquireResult?: "account" | "legacy" | "throw";
  drainMs?: number;
} = {}): Promise<BillingRig> {
  // mock 容器 ws
  const containerSockets: WebSocket[] = [];
  const containerWss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => containerWss.once("listening", () => r()));
  const containerPort = (containerWss.address() as { port: number }).port;
  containerWss.on("connection", (ws) => { containerSockets.push(ws); });

  // billing deps
  const poolCtrl = makeFakePool({ userBalance: opts.userBalance });
  // getBalance() 走 commercial/db getPool() — 注入同一只 fakePool 让 SELECT credits 走通。
  setPoolOverride(poolCtrl.pool);
  const preCheckRedis = new InMemoryPreCheckRedis();
  const pricing = new PricingCache();
  pricing._setForTests([PRICING]);

  const bindingState = { acquireCalls: 0, releaseCalls: 0 };
  const acquireResult = opts.acquireResult ?? "account";
  const codexBinding: CodexBindingHandle = {
    async acquire(_containerId: number) {
      bindingState.acquireCalls += 1;
      if (acquireResult === "throw") throw new Error("simulated acquire failure");
      if (acquireResult === "legacy") return null;
      return { account_id: 7n };
    },
    release(_aid: bigint) { bindingState.releaseCalls += 1; },
  };

  // ResolveContainerEndpoint 必须返回 containerId 才能让 codex 路径走 IIFE
  const resolveContainerEndpoint: ResolveContainerEndpoint = async () => ({
    host: "127.0.0.1",
    port: containerPort,
    containerId: 999,
  });

  const bridge = createUserChatBridge({
    jwtSecret: JWT_SECRET,
    resolveContainerEndpoint,
    containerConnectTimeoutMs: 1500,
    heartbeatIntervalMs: 0, // 测试关心跳
    pgPool: poolCtrl.pool,
    preCheckRedis,
    pricing,
    codexBinding,
  });

  const gateway = http.createServer((_, res) => res.end());
  gateway.on("upgrade", (req, socket, head) => {
    if (!bridge.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  const gatewayPort = (gateway.address() as { port: number }).port;

  return {
    gateway, bridge, gatewayPort,
    containerWss, containerPort, containerSockets,
    poolCtrl, preCheckRedis, pricing,
    binding: bindingState,
  };
}

async function stopRig(rig: BillingRig): Promise<void> {
  await rig.bridge.shutdown();
  await new Promise<void>((r) => rig.containerWss.close(() => r()));
  await new Promise<void>((r) => rig.gateway.close(() => r()));
  await resetPool();
}

async function makeJwt(uid: string): Promise<string> {
  const r = await signAccess({ sub: uid, role: "user" }, JWT_SECRET);
  return r.token;
}

function openClient(port: number, token: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_WS_PATH}`, ["bearer", token]);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((r, rej) => {
    ws.once("open", () => r());
    ws.once("error", (e) => rej(e));
  });
}

function waitFrame(ws: WebSocket): Promise<{ data: string; isBinary: boolean }> {
  return new Promise((r) => {
    ws.once("message", (data, isBinary) => {
      const buf = typeof data === "string"
        ? data
        : Buffer.isBuffer(data) ? data
          : Buffer.concat(data as Buffer[]);
      r({ data: buf.toString("utf8"), isBinary });
    });
  });
}

function waitNextContainerSocket(rig: BillingRig, timeoutMs = 1000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no container connection")), timeoutMs);
    rig.containerWss.once("connection", (ws) => {
      clearTimeout(t);
      resolve(ws);
    });
  });
}

// 收下一条来自 ws 的 JSON 帧,匹配 type;不匹配的直接丢回去等下一条。
async function waitJsonFrameOfType(
  ws: WebSocket,
  type: string,
  timeoutMs = 1500,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData): void => {
      const buf = typeof data === "string" ? data
        : Buffer.isBuffer(data) ? data
          : Buffer.concat(data as Buffer[]);
      let parsed: unknown = null;
      try { parsed = JSON.parse(buf.toString("utf8")); } catch { /* */ }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        (parsed as { type?: unknown }).type === type
      ) {
        ws.removeListener("message", onMessage);
        clearTimeout(t);
        resolve(parsed as Record<string, unknown>);
      }
    };
    const t = setTimeout(() => {
      ws.removeListener("message", onMessage);
      reject(new Error(`timeout waiting for ${type} frame`));
    }, timeoutMs);
    ws.on("message", onMessage);
  });
}

async function waitContainerNextFrame(
  containerWs: WebSocket,
  timeoutMs = 1500,
): Promise<{ data: string; isBinary: boolean }> {
  return await new Promise((r, rej) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      const buf = typeof data === "string" ? data
        : Buffer.isBuffer(data) ? data
          : Buffer.concat(data as Buffer[]);
      containerWs.removeListener("message", onMessage);
      clearTimeout(t);
      r({ data: buf.toString("utf8"), isBinary });
    };
    const t = setTimeout(() => {
      containerWs.removeListener("message", onMessage);
      rej(new Error("timeout waiting for container frame"));
    }, timeoutMs);
    containerWs.on("message", onMessage);
  });
}

// 等容器 ws 关闭(drain timeout 场景);超时返 false。
function waitContainerClose(containerWs: WebSocket, timeoutMs: number): Promise<boolean> {
  return new Promise((r) => {
    if (containerWs.readyState === WebSocket.CLOSED) { r(true); return; }
    const t = setTimeout(() => r(false), timeoutMs);
    containerWs.once("close", () => { clearTimeout(t); r(true); });
  });
}

// ---------- tests -----------------------------------------------------------

describe("userChatBridge / codex billing — happy path", () => {
  let rig: BillingRig;
  before(async () => { rig = await startRig({ userBalance: 1_000_000n }); });
  after(async () => { await stopRig(rig); });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("inbound.message → frame rewrite with server requestId → cost_charged broadcast", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("11");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    const inbound = {
      type: "inbound.message",
      agentId: "codex",
      model: "gpt-5.5",
      requestId: "client-supplied-evil-id", // 应被覆写
      content: "hi",
    };
    ws.send(JSON.stringify(inbound));

    // 容器收到 forward 的帧
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    assert.equal(parsed.type, "inbound.message");
    assert.equal(parsed.model, "gpt-5.5");
    // server-owned 32-hex requestId 覆盖 client 值
    const serverReqId = parsed.requestId as string;
    assert.match(serverReqId, /^[0-9a-f]{32}$/);
    assert.notEqual(serverReqId, "client-supplied-evil-id");

    // 容器侧用同一 requestId 发 billing
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      status: "success",
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        reasoning_output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    }));

    // 用户应收到 cost_charged
    const cost = await waitJsonFrameOfType(ws, "outbound.cost_charged");
    assert.equal(cost.requestId, serverReqId);
    assert.equal(cost.model, "gpt-5.5");
    assert.equal(typeof cost.debitedCredits, "string");
    assert.ok(BigInt(cost.debitedCredits as string) > 0n);
    assert.equal(cost.clamped, false);

    // settle 真的发了 INSERT INTO usage_records
    const inserts = rig.poolCtrl.queries.filter((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.equal(inserts.length, 1);

    ws.close();
  });
});

describe("userChatBridge / codex billing — duplicate frame", () => {
  let rig: BillingRig;
  before(async () => { rig = await startRig({ userBalance: 1_000_000n }); });
  after(async () => { await stopRig(rig); });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("two outbound.codex_billing for same requestId → one cost_charged broadcast", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("12");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    const serverReqId = parsed.requestId as string;

    // 同一 requestId 发两次 billing
    const billing = {
      type: "outbound.codex_billing",
      requestId: serverReqId,
      status: "success",
      usage: {
        input_tokens: 100,
        output_tokens: 200,
      },
    };
    containerWs.send(JSON.stringify(billing));
    containerWs.send(JSON.stringify(billing));

    // 收到一次 cost_charged
    const first = await waitJsonFrameOfType(ws, "outbound.cost_charged");
    assert.equal(first.requestId, serverReqId);

    // 等 200ms 看有没有第二条 cost_charged 漏过来
    let second: Record<string, unknown> | null = null;
    try {
      second = await waitJsonFrameOfType(ws, "outbound.cost_charged", 200);
    } catch { /* timeout 即正确 */ }
    assert.equal(second, null, "duplicate billing must NOT broadcast twice");

    // settle 也只发一次
    const inserts = rig.poolCtrl.queries.filter((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.equal(inserts.length, 1);

    ws.close();
  });
});

describe("userChatBridge / codex billing — safeNum sanitizer", () => {
  let rig: BillingRig;
  before(async () => { rig = await startRig({ userBalance: 1_000_000n }); });
  after(async () => { await stopRig(rig); });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("NaN / string / Infinity in usage fields → no throw, treated as 0 (cost=0, no broadcast)", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("13");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    const serverReqId = parsed.requestId as string;

    // 发垃圾 usage:NaN(JSON 用 null 代替)、字符串、Infinity(JSON 用 null)、负数
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      status: "success",
      usage: {
        input_tokens: "not-a-number",
        output_tokens: -100,
        reasoning_output_tokens: null,
        cache_read_input_tokens: { obj: true },
      },
    }));

    // bridge 不应崩;200ms 内不应有 cost_charged(0 token cost=0 不广播)
    let cost: Record<string, unknown> | null = null;
    try { cost = await waitJsonFrameOfType(ws, "outbound.cost_charged", 200); }
    catch { /* */ }
    assert.equal(cost, null, "0 token usage must NOT broadcast cost_charged");

    // 但 settle 应该走完(audit row 仍要落)
    const inserts = rig.poolCtrl.queries.filter((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.equal(inserts.length, 1);
    // ledger 不应有 INSERT
    const ledgers = rig.poolCtrl.queries.filter((q) =>
      q.sql.trim().startsWith("INSERT INTO credit_ledger"),
    );
    assert.equal(ledgers.length, 0, "0 cost must not insert credit_ledger");

    ws.close();
  });
});

describe("userChatBridge / codex billing — drain on user close", () => {
  let rig: BillingRig;
  before(async () => {
    process.env.DRAIN_BILLING_MS = "5000"; // 默认 5s
    rig = await startRig({ userBalance: 1_000_000n });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("user close 后,容器仍可在 drain 窗口内发 billing 帧 → settle 正常落账", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("14");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    const serverReqId = parsed.requestId as string;

    // 用户主动 close —— bridge 应进 drain,不立即关 container WS
    ws.close();

    // 等一下 user-close cleanup 跑完 detachUserSide
    await new Promise<void>((r) => setTimeout(r, 50));

    // 容器侧仍在线(drain 期内),发 billing
    assert.notEqual(containerWs.readyState, WebSocket.CLOSED);
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    }));

    // settle 仍然走 — 等 INSERT INTO usage_records 出现
    let inserts: typeof rig.poolCtrl.queries = [];
    for (let i = 0; i < 50; i += 1) {
      inserts = rig.poolCtrl.queries.filter((q) =>
        q.sql.trim().startsWith("INSERT INTO usage_records"),
      );
      if (inserts.length > 0) break;
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    assert.equal(inserts.length, 1, "drain-window billing must settle");
  });
});

describe("userChatBridge / codex billing — drain timeout", () => {
  let rig: BillingRig;
  before(async () => {
    // 缩短 drain 窗口让测试快跑完
    process.env.DRAIN_BILLING_MS = "300";
    rig = await startRig({ userBalance: 1_000_000n });
  });
  after(async () => {
    delete process.env.DRAIN_BILLING_MS;
    await stopRig(rig);
  });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  // 注意:DRAIN_BILLING_MS 是模块顶层常量 import 时读,无法运行时改。
  // 但 v1.0.66 当前实现是常量 5_000(没读 env)。此 test 用默认 5s 也能验证
  // 行为:drain 超时 → finalCleanup → 容器 ws close + abortInflightJournal。
  // 通过观察 abortInflightJournal 出现来证明 fail 路径走完。
  test("user close 后,drain 窗口超时未收到 billing → finalCleanup 走 fail 路径", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("15");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    JSON.parse(frameToContainer.data); // 拿掉 parse 一次;requestId 留在 inflight Map

    ws.close();

    // 等 5s + 100ms 余量 — 默认 DRAIN_BILLING_MS = 5_000
    // 测试套整体 timeout 默认充足。
    const closed = await waitContainerClose(containerWs, 6_000);
    assert.equal(closed, true, "container ws must close after drain timeout");

    // abortInflightJournal 应被调
    const aborts = rig.poolCtrl.queries.filter((q) =>
      /UPDATE request_finalize_journal/.test(q.sql) &&
      /state='aborted'/.test(q.sql),
    );
    assert.equal(aborts.length, 1, "drain timeout must abort journal");
    // 确认没有 INSERT INTO usage_records(没 settle)
    const inserts = rig.poolCtrl.queries.filter((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.equal(inserts.length, 0);
  });
});

describe("userChatBridge / codex billing — legacy NULL container per-turn billing", () => {
  let rig: BillingRig;
  before(async () => { rig = await startRig({ userBalance: 1_000_000n, acquireResult: "legacy" }); });
  after(async () => { await stopRig(rig); });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("legacy(acquired===null)第 2 个 turn 仍跑 billing(BLOCKER 修复回归)", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("16");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    // turn 1
    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "1",
    }));
    const f1 = await waitContainerNextFrame(containerWs);
    const r1 = JSON.parse(f1.data).requestId as string;
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing", requestId: r1, status: "success",
      usage: { input_tokens: 50, output_tokens: 100 },
    }));
    await waitJsonFrameOfType(ws, "outbound.cost_charged");

    // turn 2 — 关键:BLOCKER 修复前会被 codexLegacyContainer=true sticky 短路跳过 IIFE
    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "2",
    }));
    const f2 = await waitContainerNextFrame(containerWs);
    const r2 = JSON.parse(f2.data).requestId as string;
    assert.notEqual(r2, r1, "turn 2 must get fresh server-owned requestId");
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing", requestId: r2, status: "success",
      usage: { input_tokens: 80, output_tokens: 150 },
    }));
    const cost2 = await waitJsonFrameOfType(ws, "outbound.cost_charged");
    assert.equal(cost2.requestId, r2, "turn 2 must broadcast cost_charged (legacy 仍计费)");

    // 两次 INSERT INTO usage_records;account_id 都是 0(legacy)
    const inserts = rig.poolCtrl.queries.filter((q) =>
      q.sql.trim().startsWith("INSERT INTO usage_records"),
    );
    assert.equal(inserts.length, 2);
    for (const ins of inserts) {
      assert.equal(ins.params?.[1], "0", "legacy turn must use account_id=0");
    }

    ws.close();
  });
});

describe("userChatBridge / codex billing — partial deps reject", () => {
  test("createUserChatBridge 三件套 partial 注入 → throw", async () => {
    const poolCtrl = makeFakePool();
    const containerWss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => containerWss.once("listening", () => r()));

    const resolveContainerEndpoint: ResolveContainerEndpoint = async () => ({
      host: "127.0.0.1",
      port: (containerWss.address() as { port: number }).port,
      containerId: 1,
    });

    assert.throws(
      () => createUserChatBridge({
        jwtSecret: JWT_SECRET,
        resolveContainerEndpoint,
        pgPool: poolCtrl.pool,
        // missing preCheckRedis + pricing
      }),
      /pgPool\/preCheckRedis\/pricing must be all set or all unset/,
    );

    await new Promise<void>((r) => containerWss.close(() => r()));
  });
});
