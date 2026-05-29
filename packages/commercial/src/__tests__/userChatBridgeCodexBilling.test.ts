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
  type UserChatBridgeDeps,
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
  extra_system_prompt: null,
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
  binding: { acquireCalls: number; releaseCalls: number; acquireGroupIds: Array<string | null | undefined> };
}

// CG2c — 测试用最小 logger,记 fields(含 child 累计 bindings)。
interface CapturedLog {
  level: "info" | "warn" | "error" | "debug" | "trace";
  msg: string;
  fields?: Record<string, unknown>;
}
import type { Logger } from "../logging/logger.js";

function makeCaptureLogger(): { log: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
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

async function startRig(opts: {
  userBalance?: bigint;
  acquireResult?: "account" | "legacy" | "throw" | "stale";
  drainMs?: number;
  logger?: Logger;
  // CG2c — 注入 deps.appendCostCredits,可用于触发 billingLog.warn 路径(persist 抛错)。
  appendCostCredits?: (
    requestId: string, userId: string, debited: string,
  ) => Promise<void>;
  createCodexRoute?: UserChatBridgeDeps["createCodexRoute"];
  expireCodexRoute?: UserChatBridgeDeps["expireCodexRoute"];
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

  const bindingState = { acquireCalls: 0, releaseCalls: 0, acquireGroupIds: [] as Array<string | null | undefined> };
  const acquireResult = opts.acquireResult ?? "account";
  const codexBinding: CodexBindingHandle = {
    async acquire(_containerId: number, groupId?: string | null) {
      bindingState.acquireCalls += 1;
      bindingState.acquireGroupIds.push(groupId);
      if (acquireResult === "throw") throw new Error("simulated acquire failure");
      if (acquireResult === "stale") {
        const { ContainerStaleBindingError } = await import("../account-pool/scheduler.js");
        throw new ContainerStaleBindingError(_containerId);
      }
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
    createCodexRoute: opts.createCodexRoute,
    expireCodexRoute: opts.expireCodexRoute,
    logger: opts.logger,
    appendCostCredits: opts.appendCostCredits,
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

async function waitUntil(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(fn(), true);
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
      type: "inbound.message",
      agentId: "codex",
      model: "gpt-5.5",
      content: "x",
      __oc_codex_route: {
        baseUrl: `http://127.0.0.1:18789/internal/v3/codex-relay/route/${"a".repeat(64)}`,
        modelProvider: "api111",
      },
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

describe("userChatBridge / codex relay — fallback to legacy binding", () => {
  let rig: BillingRig;
  let routeCalls = 0;
  before(async () => {
    rig = await startRig({
      userBalance: 1_000_000n,
      createCodexRoute: async (args) => {
        routeCalls += 1;
        assert.equal(args.modelId, "gpt-5.5");
        return null;
      },
    });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => {
    _resetAgentMultiplierCacheForTests();
    routeCalls = 0;
  });

  test("no enabled relay group falls back to legacy codexBinding instead of failing the turn", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("18");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    const serverReqId = parsed.requestId as string;

    assert.equal(routeCalls, 1, "relay resolver should be attempted first");
    assert.equal(rig.binding.acquireCalls, 1, "legacy binding must be used after relay miss");
    assert.equal(parsed.__oc_codex_route, undefined, "client-supplied route config must be stripped on fallback");

    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      status: "success",
      usage: { input_tokens: 50, output_tokens: 100 },
    }));
    await waitJsonFrameOfType(ws, "outbound.cost_charged");

    ws.close();
  });
});

describe("userChatBridge / codex relay — official OAuth group marker", () => {
  let rig: BillingRig;
  before(async () => {
    rig = await startRig({
      userBalance: 1_000_000n,
      createCodexRoute: async () => ({ kind: "official_oauth", groupId: "42" }),
    });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => {
    _resetAgentMultiplierCacheForTests();
    rig.binding.acquireCalls = 0;
    rig.binding.releaseCalls = 0;
    rig.binding.acquireGroupIds.length = 0;
  });

  test("official_oauth route marker acquires legacy codex binding within selected group", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("19");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    const serverReqId = parsed.requestId as string;

    assert.equal(rig.binding.acquireCalls, 1);
    assert.deepEqual(rig.binding.acquireGroupIds, ["42"]);
    assert.equal(parsed.__oc_codex_route, undefined, "official OAuth path must not inject API relay route");

    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      status: "success",
      usage: { input_tokens: 50, output_tokens: 100 },
    }));
    await waitJsonFrameOfType(ws, "outbound.cost_charged");

    ws.close();
  });
});

describe("userChatBridge / codex relay — enabled groups fail closed", () => {
  let rig: BillingRig;
  before(async () => {
    rig = await startRig({
      userBalance: 1_000_000n,
      createCodexRoute: async () => ({ kind: "unavailable", reason: "no usable enabled Codex group" }),
    });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => {
    _resetAgentMultiplierCacheForTests();
    rig.binding.acquireCalls = 0;
    rig.binding.releaseCalls = 0;
    rig.binding.acquireGroupIds.length = 0;
  });

  test("enabled but unusable Codex groups do not bypass to legacy whole-pool binding", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("20");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const errFrame = await waitJsonFrameOfType(ws, "error");
    assert.equal(errFrame.code, "CODEX_ROUTE_UNAVAILABLE");
    assert.equal(rig.binding.acquireCalls, 0, "must not fall back to legacy pool after enabled groups were selected");

    const forwarded = await Promise.race([
      waitContainerNextFrame(containerWs, 150).then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    assert.equal(forwarded, false, "unavailable route must not forward the turn to the container");

    ws.close();
  });
});

describe("userChatBridge / codex relay — route expiry", () => {
  let rig: BillingRig;
  const routeToken = "b".repeat(64);
  const expiredTokens: string[] = [];
  let delayedRoute:
    | { token: string; gate: Promise<void>; started: () => void }
    | null = null;
  before(async () => {
    rig = await startRig({
      userBalance: 1_000_000n,
      createCodexRoute: async (args) => {
        assert.equal(args.modelId, "gpt-5.5");
        if (args.userId === 21n && delayedRoute !== null) {
          delayedRoute.started();
          await delayedRoute.gate;
          return {
            token: delayedRoute.token,
            baseUrl: `http://127.0.0.1:18789/internal/v3/codex-relay/route/${delayedRoute.token}`,
            modelProvider: "api111",
            providerName: "Yunwu",
            wireApi: "responses",
            preferredAuthMethod: "apikey",
            disableResponseStorage: true,
            groupId: "9",
            credentialId: "8",
          };
        }
        return {
          token: routeToken,
          baseUrl: `http://127.0.0.1:18789/internal/v3/codex-relay/route/${routeToken}`,
          modelProvider: "api111",
          providerName: "Yunwu",
          wireApi: "responses",
          preferredAuthMethod: "apikey",
          disableResponseStorage: true,
          groupId: "9",
          credentialId: "8",
        };
      },
      expireCodexRoute: async (token) => { expiredTokens.push(token); },
    });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => {
    _resetAgentMultiplierCacheForTests();
    expiredTokens.length = 0;
  });

  test("route token is expired after the billed turn settles", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("20");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message",
      agentId: "codex",
      model: "gpt-5.5",
      content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    const serverReqId = parsed.requestId as string;
    const route = parsed.__oc_codex_route as { baseUrl?: string } | undefined;
    assert.equal(route?.baseUrl?.includes(routeToken), true);
    assert.equal(rig.binding.acquireCalls, 0, "API relay route should not acquire legacy codex account");

    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      status: "success",
      usage: { input_tokens: 50, output_tokens: 100 },
    }));
    await waitJsonFrameOfType(ws, "outbound.cost_charged");
    await waitUntil(() => expiredTokens.includes(routeToken));

    ws.close();
  });

  test("route token is expired if the bridge closes while route creation is in flight", async () => {
    const delayedToken = "c".repeat(64);
    let resolveRoute!: () => void;
    const routeGate = new Promise<void>((resolve) => { resolveRoute = resolve; });
    let routeStarted!: () => void;
    const routeStartedP = new Promise<void>((resolve) => { routeStarted = resolve; });
    delayedRoute = { token: delayedToken, gate: routeGate, started: routeStarted };
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const token = await makeJwt("21");
      const ws = openClient(rig.gatewayPort, token);
      await waitOpen(ws);
      await containerOpenP;

      ws.send(JSON.stringify({
        type: "inbound.message",
        agentId: "codex",
        model: "gpt-5.5",
        content: "x",
      }));
      await routeStartedP;
      const closedP = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.close();
      await closedP;
      resolveRoute();
      await waitUntil(() => expiredTokens.includes(delayedToken));
    } finally {
      delayedRoute = null;
    }
  });
});

describe("userChatBridge / codex acquire — ContainerStaleBindingError recycle path", () => {
  let rig: BillingRig;
  before(async () => {
    rig = await startRig({ userBalance: 1_000_000n, acquireResult: "stale" });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("acquire throws ContainerStaleBindingError → bridge sends CODEX_CONTAINER_RECYCLED + closes ws", async () => {
    const token = await makeJwt("19");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    // 不预拨 container ws — recycle 路径 acquire 抛错前不会到 forward,
    // resolveContainerEndpoint 仍会被调一次拿 containerId,但容器 socket 早绑了
    // listener 通过 wss handler。本 test 关心的是用户侧帧 + close。
    let closeCode = 0;
    let closeReason = "";
    ws.on("close", (code, reason) => {
      closeCode = code;
      closeReason = reason.toString("utf8");
    });
    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const errFrame = await waitJsonFrameOfType(ws, "error");
    assert.equal(errFrame.code, "CODEX_CONTAINER_RECYCLED");
    assert.match(String(errFrame.message ?? ""), /容器已自动重建/);
    // 等 ws 真正 close
    await new Promise<void>((r) => {
      if (ws.readyState === WebSocket.CLOSED) r();
      else ws.once("close", () => r());
    });
    assert.equal(closeCode, 1008, "policy close code");
    assert.equal(closeReason, "codex_container_recycled");
    // 没占 per-account slot,所以 release 也不该被调
    assert.equal(rig.binding.releaseCalls, 0);
    // billing 路径根本没进 — 没 INSERT INTO inflight_charges / usage_records
    const billingInserts = rig.poolCtrl.queries.filter((q) =>
      /INSERT INTO (inflight_charges|usage_records)/.test(q.sql),
    );
    assert.equal(billingInserts.length, 0, "no billing rows on stale recycle");
  });
});

// ------- CG2c: outbound trace 贯穿 codex billing 链 -------------------------
//
// 验证三件事:
//   1. inbound.message → 容器收到的 frame.traceId(master canonical 32-hex)
//      与 outbound.cost_charged 广播帧的 traceId 相同 — server-owned trace 贯穿
//   2. 容器伪造 frame.traceId(发 "0".repeat(32))→ 广播仍用 snapshot 的 traceId
//      — 证明 snap.traceId 是计费观测的唯一可信源,不解析帧字段
//   3. billingLog binding(traceId + requestId)落到 persist-throw 路径 —
//      appendCostCredits 故意 throw 触发 billingLog.warn,断言日志带 turn trace

describe("userChatBridge / codex billing — CG2c outbound trace 贯穿", () => {
  let rig: BillingRig;
  let logs: CapturedLog[];

  before(async () => {
    const capture = makeCaptureLogger();
    logs = capture.logs;
    rig = await startRig({
      userBalance: 1_000_000n,
      logger: capture.log,
      // 强制 appendCostCredits 抛错 → 触发 billingLog.warn 路径,断言 traceId binding
      appendCostCredits: async () => {
        throw new Error("simulated persist failure");
      },
    });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => {
    _resetAgentMultiplierCacheForTests();
    logs.length = 0;
  });

  test("inbound.traceId 经 snap.traceId 贯穿到 outbound.cost_charged", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("21");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message",
      agentId: "codex",
      model: "gpt-5.5",
      content: "trace me",
    }));

    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    const serverReqId = parsed.requestId as string;
    const inboundTraceId = parsed.traceId as string;
    assert.match(inboundTraceId, /^[0-9a-f]{32}$/, "inbound 必须含 32-hex canonical traceId");

    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    }));

    const cost = await waitJsonFrameOfType(ws, "outbound.cost_charged");
    assert.equal(cost.requestId, serverReqId);
    assert.equal(
      cost.traceId,
      inboundTraceId,
      "broadcast.traceId 必须等于 inbound canonical(snap.traceId 贯穿)",
    );

    // appendCostCredits 抛错 → billingLog.warn("codex persist costCredits threw")
    // 必须有 traceId binding(snap.traceId)+ requestId(serverReqId)
    const warn = logs.find(
      (l) => l.msg === "user-chat-bridge: codex persist costCredits threw",
    );
    assert.ok(warn, "appendCostCredits 抛错应触发 billingLog.warn");
    assert.equal(
      warn!.fields?.traceId,
      inboundTraceId,
      "billingLog.warn 必须带 turn 的 canonical traceId(child binding)",
    );
    assert.equal(
      warn!.fields?.requestId,
      serverReqId,
      "billingLog.warn 必须带 requestId(child binding)",
    );

    ws.close();
  });

  test("容器伪造 frame.traceId → broadcast 仍用 snap.traceId(trust source)", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("22");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message",
      agentId: "codex",
      model: "gpt-5.5",
      content: "trust source",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    const serverReqId = parsed.requestId as string;
    const inboundTraceId = parsed.traceId as string;

    // 容器伪造一个完全不同的 traceId 塞到 billing 帧顶层 — bridge 必须忽略
    const forgedTraceId = "0".repeat(32);
    assert.notEqual(forgedTraceId, inboundTraceId, "前置:伪造值必须 ≠ 真值,否则测试无效");
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      traceId: forgedTraceId,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    }));

    const cost = await waitJsonFrameOfType(ws, "outbound.cost_charged");
    assert.equal(
      cost.traceId,
      inboundTraceId,
      "broadcast.traceId 必须用 snap.traceId,**不**采纳容器侧伪造帧字段",
    );
    assert.notEqual(
      cost.traceId,
      forgedTraceId,
      "伪造的 frame.traceId 绝不应进 broadcast(防容器侧污染计费观测)",
    );

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
