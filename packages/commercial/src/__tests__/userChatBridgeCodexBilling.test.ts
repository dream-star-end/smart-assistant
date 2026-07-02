/**
 * PR2 v1.0.66 → M2 — userChatBridge codex 真扣费集成测试(v5 双钱包形态复活)。
 *
 * 跑法: npx tsx --test src/__tests__/userChatBridgeCodexBilling.test.ts
 *
 * 与 userChatBridge.test.ts 互补:那个文件覆盖 byte-transparent 透传 + JWT + 容器
 * 拒绝等行为;本文件只覆盖 codex 真扣费路径。
 *
 * M2 语义适配(相对 P1f 删除前的 v3 版):
 *   - settle 收口 = codexFinalizer → settleUsageAndLedger → spendTwoBucket(0096
 *     双钱包):fake pool 需响应 users FOR UPDATE / user_subscriptions FOR UPDATE /
 *     UPDATE user_subscriptions SET period_credits / 每桶一条 credit_ledger;
 *   - usage_records.account_id 恒 NULL(v3 legacy 0n 假账号已废弃);
 *   - usage_records.session_id = billing 帧的 engineSessionId(oceng-<48hex>,
 *     gateway 唯一 helper 产物;settle=waive 同值红线);缺失/形状非法 →
 *     fail-closed 免单(abort journal,不扣费);
 *   - 零输出免单:success + output=0 + 本有成本 → cost=0 落 audit,不 debit 不广播;
 *   - cost_charged.balanceAfter = 双钱包总可用(period + wallet)。
 *
 * 覆盖(任务书 M2 验收清单):
 *   - happy path:帧 rewrite server requestId → billing settle → cost_charged
 *     (含 account_id NULL / session_id=engineSessionId / balanceAfter 断言)
 *   - duplicate billing frame 防重(一次广播一次 settle)
 *   - safeNum sanitizer(坏 usage 不崩,0 token 落 audit 不扣费)
 *   - readyState 前拦截:user close 后 drain 窗口内 billing 帧仍落账(断连不漏扣)
 *   - drain timeout → finalCleanup fail-abort(abort journal,无 settle)
 *   - engineSessionId 缺失 / 形状非法 → fail-closed 免单
 *   - 零输出免单端到端
 *   - balanceAfter 双桶(期内桶+钱包跨桶扣,两条 ledger)
 *   - legacy NULL 容器逐轮计费(account_id NULL)
 *   - relay route(fallback / official_oauth / unavailable / expiry)
 *   - ContainerStaleBindingError recycle
 *   - CG2c trace 贯穿(inbound → cost_charged;容器伪造 traceId 不采纳)
 *   - partial deps / codexBinding-无三件套 boot fail-closed
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
import { deriveEngineSessionId } from "../billing/codexFinalizer.js";
import { setPoolOverride, resetPool } from "../db/index.js";

const JWT_SECRET = "x".repeat(32);

// M2 — billing 帧上的 engineSessionId(gateway engineSessionId(sessionKey) 的
// 等价物;这里用 commercial 侧同算法 helper 派生,形状恒 oceng-<48hex>)。
const ENGINE_SID = deriveEngineSessionId("agent:codex:webchat:dm:test-peer");

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
//
// M2:settle 走 settleUsageAndLedger → spendTwoBucket,SQL 序列(单 tx):
//   BEGIN → INSERT usage_records → [cost>0] SELECT credits FROM users FOR UPDATE
//   → SELECT id, period_credits FROM user_subscriptions FOR UPDATE
//   → [期内桶] UPDATE user_subscriptions SET period_credits + INSERT credit_ledger
//   → [钱包] UPDATE users SET credits + INSERT credit_ledger
//   → UPDATE usage_records SET ledger_id → COMMIT
// preCheck 的 getSpendableBalance 走 pool.query(SELECT u.credits ... LEFT JOIN
// user_subscriptions),返回 wallet+period 总可用。

interface FakePoolControl {
  pool: Pool;
  /** 完整 SQL 调用记录 — 测试断言用。 */
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
}

function makeFakePool(opts: { userBalance?: bigint; periodCredits?: bigint | null } = {}): FakePoolControl {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const balance = opts.userBalance ?? 1_000_000n;
  const periodCredits = opts.periodCredits ?? null; // null = 无 active 订阅(默认)

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
      // spendTwoBucket step1:锁钱包
      if (trimmed.startsWith("SELECT credits")) {
        return { rows: [{ credits: balance.toString() }], rowCount: 1 };
      }
      // spendTwoBucket step2:锁期内桶(0096)。periodCredits=null → 无 active 订阅
      if (trimmed.startsWith("SELECT id::text AS id, period_credits::text")) {
        return periodCredits === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: "501", period_credits: periodCredits.toString() }], rowCount: 1 };
      }
      if (trimmed.startsWith("UPDATE user_subscriptions SET period_credits")) {
        return { rows: [], rowCount: 1 };
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
      // settle 23505 重入读(不该在本套件触发,兜住防 unhandled)
      if (trimmed.startsWith("SELECT id::text AS id, ledger_id")) {
        return { rows: [], rowCount: 0 };
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
      // preCheck 的 getSpendableBalance(0096 双钱包总可用)走 rootQuery 落
      // commercial/db getPool() —— 测试用 setPoolOverride 把 fakePool 装上。
      if (trimmed.startsWith("SELECT u.credits::text AS wallet")) {
        return {
          rows: [{ wallet: balance.toString(), period: (periodCredits ?? 0n).toString() }],
          rowCount: 1,
        };
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
  periodCredits?: bigint | null;
  acquireResult?: "account" | "legacy" | "throw" | "stale";
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
  const poolCtrl = makeFakePool({ userBalance: opts.userBalance, periodCredits: opts.periodCredits });
  // getSpendableBalance() 走 commercial/db getPool() — 注入同一只 fakePool。
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
      return { account_id: 7n, slotId: "slot-codex-test" };
    },
    release(_aid: bigint, _slotId: string) { bindingState.releaseCalls += 1; },
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

function usageInserts(rig: BillingRig) {
  return rig.poolCtrl.queries.filter((q) =>
    q.sql.trim().startsWith("INSERT INTO usage_records"),
  );
}
function ledgerInserts(rig: BillingRig) {
  return rig.poolCtrl.queries.filter((q) =>
    q.sql.trim().startsWith("INSERT INTO credit_ledger"),
  );
}
function journalAborts(rig: BillingRig) {
  return rig.poolCtrl.queries.filter((q) =>
    /UPDATE request_finalize_journal/.test(q.sql) &&
    /state='aborted'/.test(q.sql),
  );
}

// ---------- tests -----------------------------------------------------------

describe("userChatBridge / codex billing — happy path(双钱包 settle)", () => {
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

    // 容器侧用同一 requestId 发 billing(M2:帧携 engineSessionId 记账键)
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      engineSessionId: ENGINE_SID,
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
    // M2 红线 4:balanceAfter = 双钱包总可用(无订阅 → period=0,即 wallet-debit)
    assert.equal(
      cost.balanceAfter,
      (1_000_000n - BigInt(cost.debitedCredits as string)).toString(),
      "balanceAfter 必须是双钱包总可用口径",
    );

    // settle 真的发了 INSERT INTO usage_records,且落账口径符合 M2 红线:
    const inserts = usageInserts(rig);
    assert.equal(inserts.length, 1);
    // 红线 3:account_id 恒 SQL NULL(params[1];不再是 v3 的 '0' 假账号)
    assert.equal(inserts[0]!.params?.[1], null, "usage_records.account_id must be NULL");
    // 红线 2:session_id(params[9])= billing 帧携带的 engineSessionId ——
    // 与 gateway idle-timeout waive 上报(engineSessionId(sessionKey))同一 helper
    // 同一入参 ⇒ settle=waive 同值,refund.refundSessionWindow 才能圈到本记录。
    assert.equal(inserts[0]!.params?.[9], ENGINE_SID, "usage_records.session_id must equal wire engineSessionId");
    assert.equal(inserts[0]!.params?.[10], serverReqId);

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
    // client 提供的 __oc_codex_route 必须被剥离(master-owned 私有字段)
    assert.equal(parsed.__oc_codex_route, undefined, "client __oc_codex_route must be stripped");

    // 同一 requestId 发两次 billing
    const billing = {
      type: "outbound.codex_billing",
      requestId: serverReqId,
      engineSessionId: ENGINE_SID,
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
    assert.equal(usageInserts(rig).length, 1);

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
      engineSessionId: ENGINE_SID,
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
    assert.equal(usageInserts(rig).length, 1);
    // ledger 不应有 INSERT
    assert.equal(ledgerInserts(rig).length, 0, "0 cost must not insert credit_ledger");

    ws.close();
  });
});

// M2 红线 1 — 零输出免单端到端:success + output=0 但本有成本(纯 input/cache)
// → finalizer 免单:usage_records 落 audit(cost_credits=0 + snapshot 记 waived),
// 不 debit、不广播。对齐 proxyBilling waivedNoOutput / f3818040 语义。
describe("userChatBridge / codex billing — 零输出免单(M2 红线)", () => {
  let rig: BillingRig;
  before(async () => { rig = await startRig({ userBalance: 1_000_000n }); });
  after(async () => { await stopRig(rig); });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("success + output=0 + input 成本>0 → cost=0 落 audit,不扣费不广播", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("31");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const serverReqId = (JSON.parse(frameToContainer.data) as { requestId: string }).requestId;

    // 1M input tokens @1000/MTok = 1000 credits 本应扣;output=0 → 免单
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    }));

    let cost: Record<string, unknown> | null = null;
    try { cost = await waitJsonFrameOfType(ws, "outbound.cost_charged", 300); }
    catch { /* timeout 即正确 */ }
    assert.equal(cost, null, "零输出免单不得广播 cost_charged");

    await waitUntil(() => usageInserts(rig).length === 1);
    const ins = usageInserts(rig)[0]!;
    // cost_credits(params[8])= '0'(免单后 effectiveCredits)
    assert.equal(ins.params?.[8], "0", "免单 turn 的 usage_records.cost_credits 必须为 0");
    // snapshot(params[7])留免单痕:waived=no_output + wouldHaveCharged
    const snapshot = String(ins.params?.[7] ?? "");
    assert.match(snapshot, /"waived":"no_output"/);
    assert.match(snapshot, /"wouldHaveCharged":"1000"/);
    // 不 debit
    assert.equal(ledgerInserts(rig).length, 0);

    ws.close();
  });
});

// M2 红线 4 — balanceAfter 双桶:期内桶(period_credits)+ 钱包跨桶扣,
// 两条 credit_ledger(period + wallet),balanceAfter = 扣后总可用。
describe("userChatBridge / codex billing — balanceAfter 双桶(M2 红线)", () => {
  let rig: BillingRig;
  before(async () => {
    // wallet=1_000_000,period=1000;usage 1M in + 1M out → cost 6000 跨桶
    rig = await startRig({ userBalance: 1_000_000n, periodCredits: 1000n });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("扣费跨期内桶+钱包 → 两条 ledger,balanceAfter=period+wallet-debit", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("32");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const serverReqId = (JSON.parse(frameToContainer.data) as { requestId: string }).requestId;

    // cost = 1M*1000/MTok + 1M*5000/MTok = 6000 credits
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    }));

    const cost = await waitJsonFrameOfType(ws, "outbound.cost_charged");
    assert.equal(cost.debitedCredits, "6000");
    // balanceAfter = (1000 + 1_000_000) - 6000 = 995_000(总可用,非单桶)
    assert.equal(cost.balanceAfter, "995000", "balanceAfter 必须是期内桶+钱包扣后总可用");
    assert.equal(cost.clamped, false);

    // 两桶各一条 ledger:period(-1000)+ wallet(-5000)
    const ledgers = ledgerInserts(rig);
    assert.equal(ledgers.length, 2, "跨桶扣费必须每桶一条 credit_ledger");
    const buckets = ledgers.map((l) => l.params?.[4]);
    assert.deepEqual(buckets.sort(), ["period", "wallet"]);
    // 期内桶 UPDATE 也要发生
    const periodUpdates = rig.poolCtrl.queries.filter((q) =>
      q.sql.trim().startsWith("UPDATE user_subscriptions SET period_credits"),
    );
    assert.equal(periodUpdates.length, 1);

    ws.close();
  });
});

// M2 红线 2 — engineSessionId fail-closed:缺失 / 形状非法 → 不 settle 不扣费,
// abort journal(免单+告警,宁可少收不可乱扣)。
describe("userChatBridge / codex billing — engineSessionId fail-closed", () => {
  let rig: BillingRig;
  let logs: CapturedLog[];
  before(async () => {
    const capture = makeCaptureLogger();
    logs = capture.logs;
    rig = await startRig({ userBalance: 1_000_000n, logger: capture.log });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => {
    _resetAgentMultiplierCacheForTests();
    logs.length = 0;
    rig.poolCtrl.queries.length = 0;
  });

  async function runTurnWithBilling(uid: string, billingExtra: Record<string, unknown>): Promise<void> {
    const containerOpenP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, await makeJwt(uid));
    await waitOpen(ws);
    const containerWs = await containerOpenP;
    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const serverReqId = (JSON.parse(frameToContainer.data) as { requestId: string }).requestId;
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
      ...billingExtra,
    }));
    // fail-closed 路径:abort journal 必须出现
    await waitUntil(() => journalAborts(rig).length === 1, 1500);
    // 不 settle、不扣费、不广播
    assert.equal(usageInserts(rig).length, 0, "fail-closed 不得 INSERT usage_records");
    assert.equal(ledgerInserts(rig).length, 0);
    let cost: Record<string, unknown> | null = null;
    try { cost = await waitJsonFrameOfType(ws, "outbound.cost_charged", 200); }
    catch { /* timeout 即正确 */ }
    assert.equal(cost, null);
    // 告警日志(error 级)
    const err = logs.find((l) =>
      l.msg === "user-chat-bridge: codex_billing engineSessionId missing/invalid — waiving turn (fail-closed)",
    );
    assert.ok(err, "fail-closed 必须落 error 告警");
    ws.close();
  }

  test("billing 帧缺 engineSessionId(旧容器镜像)→ 免单 abort,不漏扣也不乱扣", async () => {
    await runTurnWithBilling("41", {});
  });

  test("engineSessionId 形状非法(旧 containerId 口径 / 伪造)→ 免单 abort", async () => {
    await runTurnWithBilling("42", { engineSessionId: "container-999" });
  });
});

describe("userChatBridge / codex billing — drain on user close(readyState 前拦截)", () => {
  let rig: BillingRig;
  before(async () => {
    rig = await startRig({ userBalance: 1_000_000n });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("user close 后,容器仍可在 drain 窗口内发 billing 帧 → settle 正常落账(断连不漏扣)", async () => {
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

    // 容器侧仍在线(drain 期内),发 billing。billing 拦截在 userWs.readyState
    // 检查**之前**,user 已断也必须落账 —— 否则用户跑路免费送 token。
    assert.notEqual(containerWs.readyState, WebSocket.CLOSED);
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    }));

    // settle 仍然走 — 等 INSERT INTO usage_records 出现
    await waitUntil(() => usageInserts(rig).length === 1, 2500);
    // 且 ledger debit 也落了(cost>0)
    await waitUntil(() => ledgerInserts(rig).length === 1, 1500);
  });
});

describe("userChatBridge / codex billing — drain timeout → fail-abort", () => {
  let rig: BillingRig;
  before(async () => {
    // M2:DRAIN_BILLING_MS 改为 env 可覆盖(读时求值)—— 用 300ms 快速验证
    // timeout 路径,不再像旧版那样真等 5s。
    process.env.DRAIN_BILLING_MS = "300";
    rig = await startRig({ userBalance: 1_000_000n });
  });
  after(async () => {
    delete process.env.DRAIN_BILLING_MS;
    await stopRig(rig);
  });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("user close 后,drain 窗口超时未收到 billing → finalCleanup fail-abort(abort journal,无 settle)", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("15");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.5", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    JSON.parse(frameToContainer.data); // requestId 留在 inflight Map,billing 永不发

    ws.close();

    // 300ms drain + 余量
    const closed = await waitContainerClose(containerWs, 2_000);
    assert.equal(closed, true, "container ws must close after drain timeout");

    // abortInflightJournal 应被调(acquire 未 settle 的 inflight 一致性)
    await waitUntil(() => journalAborts(rig).length === 1, 1500);
    // 确认没有 INSERT INTO usage_records(没 settle)
    assert.equal(usageInserts(rig).length, 0);
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
      type: "outbound.codex_billing", requestId: r1, engineSessionId: ENGINE_SID,
      status: "success",
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
      type: "outbound.codex_billing", requestId: r2, engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 80, output_tokens: 150 },
    }));
    const cost2 = await waitJsonFrameOfType(ws, "outbound.cost_charged");
    assert.equal(cost2.requestId, r2, "turn 2 must broadcast cost_charged (legacy 仍计费)");

    // 两次 INSERT INTO usage_records;M2:account_id 恒 NULL(v3 旧口径是 '0')
    const inserts = usageInserts(rig);
    assert.equal(inserts.length, 2);
    for (const ins of inserts) {
      assert.equal(ins.params?.[1], null, "M2: usage_records.account_id must be NULL (legacy 亦然)");
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
      engineSessionId: ENGINE_SID,
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
    assert.deepEqual(
      parsed.__oc_codex_route,
      { kind: "official_oauth" },
      "official OAuth path must inject the env-relay suppression marker",
    );

    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      engineSessionId: ENGINE_SID,
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
    // delayed-route case:close 与 route 创建完成的先后是真实竞态(见 test 内注释),
    // 竞态输给 close 的分支要等 drain 窗口收尾才 expire —— 缩短窗口让测试快而稳。
    process.env.DRAIN_BILLING_MS = "300";
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
  after(async () => {
    delete process.env.DRAIN_BILLING_MS;
    await stopRig(rig);
  });
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
      engineSessionId: ENGINE_SID,
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
      // 两种合法时序都必须以 expire 收尾(资源安全不变量):
      //   a) server 侧 close 先于 route 创建完成 → cleaned=true → IIFE 走
      //      cleanup_during_route_creation 立即 expire;
      //   b) route 创建先完成(client 'close' 事件可先于 server close 处理,竞态真实
      //      存在)→ turn 注册 inflight → close 进 drain → 窗口(300ms)超时
      //      finalCleanup → abandon + bridge_cleanup expire。
      await waitUntil(() => expiredTokens.includes(delayedToken), 3_000);
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
    assert.equal(closeCode, 4508, "ENV_RECYCLED close code");
    assert.equal(closeReason, "codex_container_recycled");
    // 没占 per-account slot,所以 release 也不该被调
    assert.equal(rig.binding.releaseCalls, 0);
    // billing 路径根本没进 — 没 INSERT INTO usage_records / journal
    const billingInserts = rig.poolCtrl.queries.filter((q) =>
      /INSERT INTO (request_finalize_journal|usage_records)/.test(q.sql),
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
      engineSessionId: ENGINE_SID,
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
      engineSessionId: ENGINE_SID,
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

  test("codexBinding 注入但三件套缺省 → throw(防 acquire 不 settle 的静默免费)", async () => {
    const resolveContainerEndpoint: ResolveContainerEndpoint = async () => ({
      host: "127.0.0.1",
      port: 1,
      containerId: 1,
    });
    const codexBinding: CodexBindingHandle = {
      async acquire() { return null; },
      release() { /* */ },
    };
    assert.throws(
      () => createUserChatBridge({
        jwtSecret: JWT_SECRET,
        resolveContainerEndpoint,
        codexBinding,
      }),
      /codexBinding requires pgPool\+preCheckRedis\+pricing/,
    );
  });
});
