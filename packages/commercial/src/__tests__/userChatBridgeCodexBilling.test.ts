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
 *     gateway 唯一 helper 产物);缺失/形状非法 →
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
  PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE,
  PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
  PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
  PROMPT_QUEUE_DISPATCH_RESULT_TYPE,
  codexAbandonFailureCode,
  type ResolveContainerEndpoint,
  type UserChatBridgeHandler,
  type UserChatBridgeDeps,
  type CodexBindingHandle,
} from "../ws/userChatBridge.js";
import { PricingCache } from "../billing/pricing.js";
import type { ModelPricing } from "../billing/pricing.js";
import { InMemoryPreCheckRedis } from "../billing/preCheck.js";
import { _resetAgentMultiplierCacheForTests } from "../billing/agentMultiplier.js";
import {
  deriveEngineSessionId,
  permanentCodexWaiverReason,
} from "../billing/codexFinalizer.js";
import { setPoolOverride, resetPool } from "../db/index.js";
import { AuthoritySigner } from "../ws/authoritySigner.js";
import { AuthorityKeyCensus } from "../ws/authorityKeyCensus.js";
import { ModelAuthorityConsumer, buildContainerAttestFrame } from "@openclaude/gateway";
import { MODEL_AUTHORITY_FIELD } from "@openclaude/protocol";
import {
  ModelCatalogSnapshot,
  type ModelCatalogCache,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from "../billing/modelCatalog.js";

const JWT_SECRET = "x".repeat(32);

test("Codex abandon reasons map to stable failure-code families", () => {
  assert.equal(codexAbandonFailureCode("bridge_disconnect_before_finalize"), "CLIENT_ABORT");
  assert.equal(codexAbandonFailureCode("rewritten_frame_too_big"), "INVALID_REQUEST");
  assert.equal(codexAbandonFailureCode("codex_billing_engine_session_id_invalid"), "INVALID_REQUEST");
  assert.equal(codexAbandonFailureCode("container_forward_rejected"), "UPSTREAM_UNAVAILABLE");
  assert.equal(codexAbandonFailureCode("sign_boundary_missing"), "INTERNAL_ERROR");
});

// M2 — billing 帧上的 engineSessionId(gateway engineSessionId(sessionKey) 的
// 等价物;这里用 commercial 侧同算法 helper 派生,形状恒 oceng-<48hex>)。
const ENGINE_SID = deriveEngineSessionId("agent:codex:webchat:dm:test-peer");

const PRICING: ModelPricing = {
  model_id: "gpt-5.6-sol",
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
  default_effort: null,
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

/** P0 跨桥修复 — fake journal 行(request_finalize_journal 的最小状态机)。 */
interface FakeJournalRow {
  state: "inflight" | "finalizing" | "committed" | "aborted";
  user_id: string;
  ctx: Record<string, unknown>;
  precheck_credits: string;
  error_msg: string | null;
}

interface FakePoolControl {
  pool: Pool;
  /** 完整 SQL 调用记录 — 测试断言用。 */
  queries: Array<{ sql: string; params: unknown[] | undefined }>;
  /** P0 跨桥修复 — 有状态 journal 表(INSERT/UPDATE CAS/SELECT 都作用于此),
   *  测试可直接读断言终态,或预置 synthetic 行(aborted 撞帧 / 串桥用例)。 */
  journalRows: Map<string, FakeJournalRow>;
  /** Existing pending/component attribution visible after a committed settle. */
  attributionCredits: Map<string, string>;
}

function makeFakePool(opts: { userBalance?: bigint; periodCredits?: bigint | null } = {}): FakePoolControl {
  const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const balance = opts.userBalance ?? 1_000_000n;
  const periodCredits = opts.periodCredits ?? null; // null = 无 active 订阅(默认)
  const journalRows = new Map<string, FakeJournalRow>();
  const attributionCredits = new Map<string, string>();

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
      if (trimmed.startsWith("SELECT pg_advisory_xact_lock")) {
        return { rows: [{}], rowCount: 1 };
      }
      if (trimmed.startsWith("SELECT 1 FROM turn_waivers")) {
        return { rows: [], rowCount: 0 };
      }
      // 0112 企业版:settle 收口 tx 内的 org 归属解析(resolveOrgBillingContext)。
      // 本套件不测 org 计费 → 无成员归属,返回空 → orgCtx=null(纯个人扣费,行为不变)。
      if (trimmed.startsWith("SELECT m.org_id")) {
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
      // 0147: the exact turn locator is inserted in the same transaction as
      // the debit. Session-store reconciliation itself is covered by the PG
      // backend integration suite; this bridge fake only needs to acknowledge
      // the atomic insert.
      if (trimmed.startsWith("INSERT INTO pending_usage_patches")) {
        const values = params as unknown[];
        attributionCredits.set(String(values[0]), String(values[7]));
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
      // request_finalize_journal — P0 跨桥修复后 fake 变有状态:
      // INSERT inflight / UPDATE CAS(finalizing|committed|aborted)/ SELECT 回查
      // 都作用于 journalRows,测试能断言权威终态(而不只是 SQL 形状)。
      if (trimmed.startsWith("INSERT INTO request_finalize_journal")) {
        const [reqId, userId, , ctxJson, precheck] = params as [string, string, unknown, string, string];
        const inserted = !journalRows.has(reqId);
        if (inserted) { // ON CONFLICT DO NOTHING
          journalRows.set(reqId, {
            state: "inflight",
            user_id: userId,
            ctx: JSON.parse(ctxJson) as Record<string, unknown>,
            precheck_credits: precheck,
            error_msg: null,
          });
        }
        return { rows: [], rowCount: inserted ? 1 : 0 };
      }
      if (trimmed.startsWith("UPDATE request_finalize_journal")) {
        const values = params as unknown[];
        const reqId = values[0] as string;
        const row = journalRows.get(reqId);
        const setState = trimmed.match(/SET\s+state='(inflight|finalizing|committed|aborted)'/)?.[1];
        let casOk = false;

        if (row !== undefined && setState === "finalizing") {
          casOk = row.state === "inflight";
          if (casOk) {
            row.state = "finalizing";
            row.ctx = { ...row.ctx, settlementClaimId: String(values[1]) };
          }
        } else if (row !== undefined && setState === "committed") {
          casOk = row.state === "finalizing" &&
            row.ctx.settlementClaimId === values[4];
          if (casOk) {
            row.state = "committed";
            delete row.ctx.settlementClaimId;
          }
        } else if (row !== undefined && setState === "aborted") {
          const ownerClaim = values.length === 4 ? values[3] : undefined;
          casOk = ownerClaim === undefined
            ? row.state === "inflight"
            : row.state === "finalizing" && row.ctx.settlementClaimId === ownerClaim;
          if (casOk) {
            row.state = "aborted";
            row.error_msg = String(values[1] ?? "");
            delete row.ctx.settlementClaimId;
          }
        } else if (row !== undefined && setState === "inflight") {
          const expectedState = /state='finalizing'/.test(trimmed) ? "finalizing" : "aborted";
          const expectedUser = /user_id=\$2/.test(trimmed) ? String(values[1]) : row.user_id;
          casOk = row.state === expectedState && row.user_id === expectedUser;
          if (casOk) {
            row.state = "inflight";
            row.error_msg = null;
            delete row.ctx.settlementClaimId;
          }
        } else if (setState === undefined) {
          throw new Error(`fakePool: unrecognized journal UPDATE: ${trimmed.slice(0, 120)}`);
        }
        return { rows: [], rowCount: casOk ? 1 : 0 };
      }
      // P0 跨桥修复 — unknown-turn 分支的 journal 回查
      if (trimmed.startsWith("SELECT state, user_id::text AS user_id, ctx")) {
        const reqId = (params as unknown[])[0] as string;
        const row = journalRows.get(reqId);
        return row === undefined
          ? { rows: [], rowCount: 0 }
          : {
              rows: [{
                state: row.state,
                user_id: row.user_id,
                ctx: row.ctx,
                error_msg: row.error_msg,
              }],
              rowCount: 1,
            };
      }
      if (trimmed.startsWith("SELECT EXISTS(") && trimmed.includes("FROM usage_records")) {
        return { rows: [{ present: false }], rowCount: 1 };
      }
      if (
        trimmed.startsWith("SELECT usage_records.id::text AS id") &&
        trimmed.includes("AS attribution_credits")
      ) {
        const requestId = String((params as unknown[])[1]);
        return {
          rows: [{
            id: "100",
            ledger_id: "200",
            attribution_credits: attributionCredits.get(requestId) ?? null,
          }],
          rowCount: 1,
        };
      }
      // preCheck 的 getSpendableBalance(0096 双钱包总可用)走 rootQuery 落
      // commercial/db getPool() —— 测试用 setPoolOverride 把 fakePool 装上。
      if (trimmed.startsWith("SELECT u.credits::text AS wallet")) {
        return {
          rows: [{ wallet: balance.toString(), period: (periodCredits ?? 0n).toString() }],
          rowCount: 1,
        };
      }
      // 企业版预检:getOrgSpendableForUser(org 钱包+期内池)。本套件不测 org 计费
      // → 无成员归属,返回空 → org 可用额 0n(纯个人预检,行为不变)。
      if (trimmed.startsWith("SELECT (o.credits")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`fakePool: unhandled SQL: ${trimmed.slice(0, 80)}`);
    },
    async end(): Promise<void> { /* noop for tests */ },
  };

  return { pool: fakePool as Pool, queries, journalRows, attributionCredits };
}

// ---------- 模型执行权威夹具(签发边界 epoch 重读 / journal 补偿用) ----------

/** 快照 epoch;签发边界重读到别的值 = turn 途中发生了安全写 → 必须整单放弃。 */
const AUTH_EPOCH = 42n;

/** 只含本套件用的 codex 模型(gpt-5.6-sol),engine=codex → 走 codex 计费编排。 */
function fakeAuthorityCatalog(): ModelCatalogCache {
  const entries: ModelCatalogEntry[] = [
    {
      entryId: 1,
      modelId: "gpt-5.6-sol",
      engine: "codex",
      providerId: "codex",
      upstreamModelId: null,
      contextWindow: 400_000,
      capabilityProfile: {
        supportsVision: true,
        reasoning: { supported: ["medium", "xhigh"], codexModelDefault: "xhigh" },
        ccb: { capabilityZero: false, supportsThinking: false },
      },
      capabilitySchemaVersion: 1,
      state: "active",
      lockVersion: 1,
    } as ModelCatalogEntry,
  ];
  const pricing = new Map<string, ModelCatalogPricing>([
    [
      "gpt-5.6-sol",
      {
        modelId: "gpt-5.6-sol",
        displayName: "GPT 5.6",
        inputPerMtok: 1000n,
        outputPerMtok: 5000n,
        cacheReadPerMtok: 100n,
        cacheWritePerMtok: 500n,
        multiplier: "1.000",
        visibility: "public",
        sortOrder: 0,
        defaultEffort: null,
      },
    ],
  ]);
  const snapshot = new ModelCatalogSnapshot({
    entries,
    aliases: new Map(),
    pricing,
    securityEpoch: AUTH_EPOCH,
  });
  return {
    peek: () => snapshot,
    current: () => snapshot,
    assertFresh: async () => snapshot,
  } as unknown as ModelCatalogCache;
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
  /** 模型执行权威(仅 modelAuthority:true 的 rig 有);epochAtSign 可中途改 = 模拟 admin 安全写。 */
  authority?: { signer: AuthoritySigner; epochAtSign: { value: bigint } };
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
  appendCostCredits?: UserChatBridgeDeps["appendCostCredits"];
  createCodexRoute?: UserChatBridgeDeps["createCodexRoute"];
  expireCodexRoute?: UserChatBridgeDeps["expireCodexRoute"];
  loadAllowedModelChecker?: UserChatBridgeDeps["loadAllowedModelChecker"];
  // P0 计费旁路封堵 — bridge 可信模型推导(fake master agent 权威)。
  loadAgentModelResolver?: UserChatBridgeDeps["loadAgentModelResolver"];
  // P0 跨桥修复 — displacement 用例把 per-user 连接上限压到 1,新连接必踢旧桥。
  maxPerUser?: number;
  /**
   * 模型执行权威(flag 开)。开了之后:容器必须 attest(rig 用**真 gateway 代码**发帧),
   * 每条 inbound 注入签名 envelope,且**签发边界重读 epoch**(MAJOR-2)。
   */
  modelAuthority?: boolean;
  promptQueueEnabled?: boolean;
} = {}): Promise<BillingRig> {
  // 模型执行权威装配(flag 关 → 全部 undefined,rig 行为与本批次之前完全一致)
  const authoritySigner = opts.modelAuthority === true ? AuthoritySigner.createEphemeral() : null;
  const epochAtSign = { value: AUTH_EPOCH };

  // mock 容器 ws
  const containerSockets: WebSocket[] = [];
  const containerWss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => containerWss.once("listening", () => r()));
  const containerPort = (containerWss.address() as { port: number }).port;
  containerWss.on("connection", (ws) => {
    containerSockets.push(ws);
    if (authoritySigner !== null) {
      // 真容器行为:连上就 attest(keyring = master 注入的公钥 ring)。
      const consumer = new ModelAuthorityConsumer({
        keyring: authoritySigner.publicKeyring(),
        containerId: 999,
        uid: 11,
        required: true,
      });
      ws.send(
        JSON.stringify(buildContainerAttestFrame(consumer, consumer.newConnection(), 999)),
      );
    }
  });

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
    loadAllowedModelChecker: opts.loadAllowedModelChecker,
    loadAgentModelResolver: opts.loadAgentModelResolver,
    logger: opts.logger,
    appendCostCredits: opts.appendCostCredits,
    maxPerUser: opts.maxPerUser,
    promptQueueEnabled: opts.promptQueueEnabled,
    ...(authoritySigner !== null
      ? {
          modelAuthority: {
            signer: authoritySigner,
            catalog: fakeAuthorityCatalog(),
            census: new AuthorityKeyCensus(),
            // **签发边界**的 epoch 直读(MAJOR-2)。默认 = 快照 epoch(无安全写);
            // 用例把它改掉 = turn 途中 admin 禁用/撤销/改价 → 签发前必须拒 + 补偿。
            readSecurityEpoch: async () => epochAtSign.value,
          },
        }
      : {}),
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
    ...(authoritySigner !== null ? { authority: { signer: authoritySigner, epochAtSign } } : {}),
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

describe("userChatBridge / annotated Image 2 — forward only", () => {
  let rig: BillingRig;
  before(async () => { rig = await startRig({ userBalance: 50n }); });
  after(async () => { await stopRig(rig); });

  test("valid imageEdit gets canonical ids without Codex slot/precheck/journal", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, await makeJwt("11"));
    await waitOpen(ws);
    const containerWs = await containerOpenP;
    ws.send(JSON.stringify({
      type: "inbound.message",
      idempotencyKey: "image-edit-test",
      channel: "webchat",
      peer: { id: "image-peer", kind: "dm" },
      agentId: "codex",
      model: "gpt-5.6-sol",
      content: {
        text: "把圈选区域改成晚霞",
        media: [0, 1, 2].map((n) => ({
          kind: "image", url: `/api/media/image-${n}.png`, mimeType: "image/png", hidden: n > 0,
        })),
        imageEdit: {
          clientJobId: "1234567890abcdef1234567890abcdef",
          sourceIndex: 0,
          maskIndex: 1,
          guideIndex: 2,
          width: 1024,
          height: 768,
        },
      },
      ts: Date.now(),
    }));

    const forwarded = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
    assert.match(String(forwarded.requestId), /^[0-9a-f]{32}$/);
    assert.match(String(forwarded.traceId), /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(rig.binding.acquireCalls, 0, "Image 2 must not consume a Codex chat slot");
    assert.equal(
      rig.poolCtrl.queries.some((q) => /request_finalize_journal/.test(q.sql)),
      false,
      "Image 2 must not open a Codex inflight journal",
    );
    assert.equal(
      rig.poolCtrl.queries.some((q) => /SELECT\s+u\.credits/i.test(q.sql)),
      false,
      "Image 2 must not run ordinary chat preCheck",
    );
    ws.close();
  });

  test("outpaint imageEdit (mode:'outpaint', no mask) also bypasses Codex slot/precheck/journal", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, await makeJwt("11"));
    await waitOpen(ws);
    const containerWs = await containerOpenP;
    ws.send(JSON.stringify({
      type: "inbound.message",
      idempotencyKey: "image-outpaint-test",
      channel: "webchat",
      peer: { id: "outpaint-peer", kind: "dm" },
      agentId: "codex",
      model: "gpt-5.6-sol",
      content: {
        text: "把这张图调整为 16:9 宽屏构图",
        // outpaint 无用户 mask:media 只有 source + guide 两张图。
        media: [0, 1].map((n) => ({
          kind: "image", url: `/api/media/outpaint-${n}.png`, mimeType: "image/png", hidden: n === 0,
        })),
        imageEdit: {
          clientJobId: "abcdef0123456789abcdef0123456789",
          mode: "outpaint",
          sourceIndex: 0,
          guideIndex: 1,
          targetAspect: "16:9",
          width: 1024,
          height: 768,
        },
      },
      ts: Date.now(),
    }));

    const forwarded = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
    assert.match(String(forwarded.requestId), /^[0-9a-f]{32}$/);
    assert.match(String(forwarded.traceId), /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal(rig.binding.acquireCalls, 0, "outpaint must not consume a Codex chat slot");
    assert.equal(
      rig.poolCtrl.queries.some((q) => /request_finalize_journal/.test(q.sql)),
      false,
      "outpaint must not open a Codex inflight journal",
    );
    assert.equal(
      rig.poolCtrl.queries.some((q) => /SELECT\s+u\.credits/i.test(q.sql)),
      false,
      "outpaint must not run ordinary chat preCheck",
    );
    ws.close();
  });
});

describe("userChatBridge / prompt queue accepted-grant cancellation", () => {
  let rig: BillingRig;
  before(async () => {
    rig = await startRig({ userBalance: 1_000_000n, promptQueueEnabled: true });
  });
  after(async () => { await stopRig(rig); });

  test("lease loss before provider submit releases slot, precheck and inflight journal", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, await makeJwt("11"));
    await waitOpen(ws);
    const containerWs = await containerOpenP;
    const request = {
      type: PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
      grantId: "123e4567-e89b-12d3-a456-426614174001",
      owner: {
        sessionKey: "agent:codex:webchat:dm:queue-billing-peer",
        clientSessionId: "queue-billing-peer",
        agentId: "codex",
        peer: { id: "queue-billing-peer", kind: "dm" },
      },
      claim: { epoch: "17", claimToken: "ab".repeat(32) },
      item: {
        itemId: "queue-billing-item",
        clientMessageId: "queue-billing-message",
        contentHash: "cd".repeat(32),
        content: { text: "queued paid turn" },
        requestedExecution: { agentId: "codex", model: "gpt-5.6-sol" },
      },
    } as const;

    containerWs.send(JSON.stringify(request));
    const forwarded = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
    assert.equal(forwarded.type, "inbound.message");
    assert.match(String(forwarded.requestId), /^[0-9a-f]{32}$/);
    assert.equal(rig.binding.acquireCalls, 1);
    assert.ok(rig.preCheckRedis.totalLocked(11n) > 0n);
    assert.equal(journalAborts(rig).length, 0);

    containerWs.send(JSON.stringify({
      type: PROMPT_QUEUE_DISPATCH_CANCEL_TYPE,
      grantId: request.grantId,
      owner: request.owner,
      itemId: request.item.itemId,
      contentHash: request.item.contentHash,
      epoch: request.claim.epoch,
      claimToken: request.claim.claimToken,
      reasonCode: "LEASE_LOST",
    }));

    await waitUntil(() =>
      rig.binding.releaseCalls === 1 &&
      rig.preCheckRedis.totalLocked(11n) === 0n &&
      journalAborts(rig).length === 1,
    );
    assert.equal(usageInserts(rig).length, 0);
    assert.equal(ledgerInserts(rig).length, 0);
    ws.close();
  });

  test("container restart before activation exactly compensates slot, precheck and journal", async () => {
      const acquireBefore = rig.binding.acquireCalls;
      const releaseBefore = rig.binding.releaseCalls;
      const abortBefore = journalAborts(rig).length;
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("11"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;
      const request = {
        type: PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
        grantId: "123e4567-e89b-12d3-a456-426614174011",
        owner: {
          sessionKey: "agent:codex:webchat:dm:queue-restart-peer",
          clientSessionId: "queue-restart-peer",
          agentId: "codex",
          peer: { id: "queue-restart-peer", kind: "dm" },
        },
        claim: { epoch: "18", claimToken: "bc".repeat(32) },
        item: {
          itemId: "queue-restart-item",
          clientMessageId: "queue-restart-message",
          contentHash: "de".repeat(32),
          content: { text: "queued restart turn" },
          requestedExecution: { agentId: "codex", model: "gpt-5.6-sol" },
        },
      } as const;
      containerWs.send(JSON.stringify(request));
      const forwarded = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
      assert.equal(forwarded.type, "inbound.message");
      assert.equal(rig.binding.acquireCalls, acquireBefore + 1);
      assert.ok(rig.preCheckRedis.totalLocked(11n) > 0n);

      containerWs.terminate();
      await waitUntil(() =>
        rig.binding.releaseCalls === releaseBefore + 1 &&
        rig.preCheckRedis.totalLocked(11n) === 0n &&
        journalAborts(rig).length === abortBefore + 1,
      );
      assert.equal(usageInserts(rig).length, 0);
      assert.equal(ledgerInserts(rig).length, 0);
      ws.close();
  });

  test("queue grant never releases a live legacy Codex owner", async () => {
      const acquireBefore = rig.binding.acquireCalls;
      const releaseBefore = rig.binding.releaseCalls;
      const abortBefore = journalAborts(rig).length;
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("11"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "mixed-owner-peer", kind: "dm" },
        clientMessageId: "legacy-live-message",
        agentId: "codex",
        model: "gpt-5.6-sol",
        content: { text: "legacy turn stays live" },
      }));
      const legacy = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
      const lockedBefore = rig.preCheckRedis.totalLocked(11n);
      assert.equal(rig.binding.acquireCalls, acquireBefore + 1);
      assert.ok(lockedBefore > 0n);

      const queueRequest = {
        type: PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
        grantId: "123e4567-e89b-12d3-a456-426614174013",
        owner: {
          sessionKey: "agent:codex:webchat:dm:mixed-owner-peer",
          clientSessionId: "mixed-owner-peer",
          agentId: "codex",
          peer: { id: "mixed-owner-peer", kind: "dm" },
        },
        claim: { epoch: "20", claimToken: "be".repeat(32) },
        item: {
          itemId: "mixed-owner-item",
          clientMessageId: "mixed-owner-message",
          contentHash: "e1".repeat(32),
          content: { text: "must wait durably" },
          requestedExecution: { agentId: "codex", model: "gpt-5.6-sol" },
        },
      } as const;
      containerWs.send(JSON.stringify(queueRequest));
      const rejected = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
      assert.equal(rejected.type, PROMPT_QUEUE_DISPATCH_RESULT_TYPE);
      assert.equal(rejected.reasonCode, "EXECUTION_OWNER_BUSY");
      assert.equal(rejected.disposition, "retryable");
      assert.equal(rig.binding.acquireCalls, acquireBefore + 1);
      assert.equal(rig.binding.releaseCalls, releaseBefore);
      assert.equal(rig.preCheckRedis.totalLocked(11n), lockedBefore);
      assert.equal(journalAborts(rig).length, abortBefore);

      containerWs.send(JSON.stringify({
        type: "outbound.codex_billing",
        requestId: legacy.requestId,
        engineSessionId: ENGINE_SID,
        status: "success",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
      await waitUntil(() => rig.binding.releaseCalls === releaseBefore + 1);
      ws.close();
  });

  test("activation acknowledgement removes only pre-activation compensation", async () => {
      const releaseBefore = rig.binding.releaseCalls;
      const abortBefore = journalAborts(rig).length;
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("11"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;
      const request = {
        type: PROMPT_QUEUE_DISPATCH_REQUEST_TYPE,
        grantId: "123e4567-e89b-12d3-a456-426614174012",
        owner: {
          sessionKey: "agent:codex:webchat:dm:queue-active-peer",
          clientSessionId: "queue-active-peer",
          agentId: "codex",
          peer: { id: "queue-active-peer", kind: "dm" },
        },
        claim: { epoch: "19", claimToken: "bd".repeat(32) },
        item: {
          itemId: "queue-active-item",
          clientMessageId: "queue-active-message",
          contentHash: "df".repeat(32),
          content: { text: "queued active turn" },
          requestedExecution: { agentId: "codex", model: "gpt-5.6-sol" },
        },
      } as const;
      containerWs.send(JSON.stringify(request));
      await waitContainerNextFrame(containerWs);
      containerWs.send(JSON.stringify({
        type: PROMPT_QUEUE_DISPATCH_ACTIVATED_TYPE,
        grantId: request.grantId,
        owner: request.owner,
        itemId: request.item.itemId,
        contentHash: request.item.contentHash,
        epoch: request.claim.epoch,
        claimToken: request.claim.claimToken,
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      containerWs.terminate();
      await waitUntil(() => rig.binding.releaseCalls === releaseBefore + 1);
      assert.ok(rig.preCheckRedis.totalLocked(11n) > 0n);
      assert.equal(journalAborts(rig).length, abortBefore);
      ws.close();
  });
});

describe("userChatBridge / codex billing — happy path(双钱包 settle)", () => {
  let rig: BillingRig;
  const persisted: unknown[][] = [];
  before(async () => {
    rig = await startRig({
      userBalance: 1_000_000n,
      appendCostCredits: async (...args) => {
        persisted.push(args);
      },
    });
  });
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
      model: "gpt-5.6-sol",
      requestId: "client-supplied-evil-id", // 应被覆写
      content: "hi",
    };
    ws.send(JSON.stringify(inbound));

    // 容器收到 forward 的帧
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    assert.equal(parsed.type, "inbound.message");
    assert.equal(parsed.model, "gpt-5.6-sol");
    // server-owned 32-hex requestId 覆盖 client 值
    const serverReqId = parsed.requestId as string;
    const turnKey = "ab".repeat(32);
    assert.match(serverReqId, /^[0-9a-f]{32}$/);
    assert.notEqual(serverReqId, "client-supplied-evil-id");

    // 容器侧用同一 requestId 发 billing(M2:帧携 engineSessionId 记账键)
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      turnKey,
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
    assert.equal(cost.model, "gpt-5.6-sol");
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
    // 红线 3:account_id 恒 SQL NULL(params[2],0104 后 mode 占 $2;不再是 v3 的 '0' 假账号)
    assert.equal(inserts[0]!.params?.[2], null, "usage_records.account_id must be NULL");
    // 红线 2:session_id(params[10],0104 参数位)= billing 帧携带的 engineSessionId ——
    // 与 gateway engineSessionId(sessionKey) 同一 helper，保证会话维度稳定。
    // 免单归因已独立转为 turnKey / parentTurnKey，不依赖此字段。
    assert.equal(inserts[0]!.params?.[10], ENGINE_SID, "usage_records.session_id must equal wire engineSessionId");
    assert.equal(inserts[0]!.params?.[13], serverReqId);
    assert.deepEqual(
      persisted[0],
      [serverReqId, "11", cost.debitedCredits, ENGINE_SID, null, null, turnKey, null],
      "Codex cost persistence must join the same lossless turn key",
    );

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
      model: "gpt-5.6-sol",
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
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
    // cost_credits(params[9],0104 参数位)= '0'(免单后 effectiveCredits)
    assert.equal(ins.params?.[9], "0", "免单 turn 的 usage_records.cost_credits 必须为 0");
    // snapshot(params[8],0104 参数位)留免单痕:waived=no_output + wouldHaveCharged
    const snapshot = String(ins.params?.[8] ?? "");
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
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

// P0 修复(2026-07-03):桥关 ≠ turn 终止。drain 超时不再 fail-abort —— journal
// 保持 inflight,裁决权交给"billing 帧到达任意桥 → settle"或 reconciler 终态化。
// (旧行为 = abort journal + release reservation,是跨桥重连整 turn 免费的根因。)
describe("userChatBridge / codex billing — drain timeout 不再 abort 存活 turn(P0 修复)", () => {
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

  test("user close 后 drain 超时未收到 billing → finalCleanup 关桥但 journal 保持 inflight(不 abort)", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("15");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const serverReqId = (JSON.parse(frameToContainer.data) as { requestId: string }).requestId;

    ws.close();

    // 300ms drain + 余量:桥的资源(container ws)照常收尾
    const closed = await waitContainerClose(containerWs, 2_000);
    assert.equal(closed, true, "container ws must close after drain timeout");

    // 关键断言(P0):**不** abort journal —— 容器侧 turn 可能仍在跑,权威裁决
    // 交给后续 billing 帧(跨桥 settle)或 reconciler(stuck 阈值后终态化)。
    await new Promise<void>((r) => setTimeout(r, 100));
    assert.equal(journalAborts(rig).length, 0, "bridge teardown must NOT abort inflight journal");
    assert.equal(rig.poolCtrl.journalRows.get(serverReqId)?.state, "inflight");
    // 也没有 settle(billing 帧从未到)
    assert.equal(usageInserts(rig).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P0 收入漏洞回归(2026-07-03)— codex turn 中途 WS 重连 → billing 帧到新桥。
// 复现链:turn 开启(journal inflight)→ 用户断 WS(旧桥 drain)→ 重连(新桥)
// → 旧桥 finalCleanup → 容器跑完 turn,billing 帧到达新桥 → 旧实现 unknown-turn
// 只打日志 = 0 usage_records、0 debit。修复后:journal 权威回查 + 跨桥 settle。
// ─────────────────────────────────────────────────────────────────────────────
describe("userChatBridge / codex billing — P0 跨桥重连 settle(billing 帧后于重连到达)", () => {
  let rig: BillingRig;
  before(async () => {
    process.env.DRAIN_BILLING_MS = "200";
    rig = await startRig({ userBalance: 1_000_000n, modelAuthority: true });
  });
  after(async () => {
    delete process.env.DRAIN_BILLING_MS;
    await stopRig(rig);
  });
  beforeEach(() => {
    _resetAgentMultiplierCacheForTests();
    rig.pricing._setForTests([PRICING]);
  });

  test("旧桥 drain 超时关闭 → 新桥收 billing 帧 → journal 回查 settle + cost_charged 广播(duplicate 帧防重)", async () => {
    // ── turn 在桥 1 开启 ──
    const container1P = waitNextContainerSocket(rig);
    const token = await makeJwt("11");
    const ws1 = openClient(rig.gatewayPort, token);
    await waitOpen(ws1);
    const container1 = await container1P;
    ws1.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
    }));
    const f1 = JSON.parse((await waitContainerNextFrame(container1)).data) as Record<string, unknown>;
    const serverReqId = f1.requestId as string;
    const turnTraceId = f1.traceId as string;
    assert.match(serverReqId, /^[0-9a-f]{32}$/);
    // journal ctx 必须已带 traceId(跨桥 settle 的 trace 贯穿依赖)
    assert.equal(rig.poolCtrl.journalRows.get(serverReqId)?.ctx.traceId, turnTraceId);
    assert.deepEqual(rig.poolCtrl.journalRows.get(serverReqId)?.ctx.billingPricing, {
      v: 1,
      modelId: "gpt-5.6-sol",
      displayName: "GPT 5.6",
      inputPerMtok: "1000",
      outputPerMtok: "5000",
      cacheReadPerMtok: "100",
      cacheWritePerMtok: "500",
      multiplier: "1.000",
    });

    // ── 用户断线,旧桥 drain 超时收尾(billing 帧尚未产生)──
    ws1.close();
    assert.equal(await waitContainerClose(container1, 2_000), true);
    assert.equal(journalAborts(rig).length, 0, "old bridge must not abort surviving turn");
    assert.equal(rig.poolCtrl.journalRows.get(serverReqId)?.state, "inflight");

    // ── 用户重连(新桥、新容器 socket)──
    const container2P = waitNextContainerSocket(rig);
    const ws2 = openClient(rig.gatewayPort, token);
    await waitOpen(ws2);
    const container2 = await container2P;

    // 模拟 journal 开笔后异步 PricingCache 已切到另一代价格。跨桥 settle 必须仍用
    // journal 中与 authority snapshot 同代的 5000/1.000，而不是这份 1/0.001。
    rig.pricing._setForTests([{
      ...PRICING,
      output_per_mtok: 1n,
      multiplier: "0.001",
    }]);

    // ── 容器跑完 turn,billing 帧到达**新桥**(发两次:duplicate 防重一并验证)──
    const billing = JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    container2.send(billing);
    container2.send(billing);

    // 新桥的 userWs 收到 cost_charged,trace 贯穿自 journal ctx
    const cost = await waitJsonFrameOfType(ws2, "outbound.cost_charged");
    assert.equal(cost.requestId, serverReqId);
    assert.equal(cost.traceId, turnTraceId, "cost_charged.traceId must come from journal ctx");
    assert.equal(cost.model, "gpt-5.6-sol");
    assert.ok(BigInt(cost.debitedCredits as string) > 0n);

    // duplicate 帧不得二次广播 / 二次 settle
    let second: Record<string, unknown> | null = null;
    try { second = await waitJsonFrameOfType(ws2, "outbound.cost_charged", 200); } catch { /* */ }
    assert.equal(second, null, "duplicate cross-bridge billing must NOT broadcast twice");
    assert.equal(usageInserts(rig).length, 1, "exactly one settle");
    assert.equal(ledgerInserts(rig).length, 1);
    // settle 口径与主路径一致:session_id = 帧 engineSessionId,account_id NULL
    assert.equal(usageInserts(rig)[0]!.params?.[2], null);
    assert.equal(usageInserts(rig)[0]!.params?.[10], ENGINE_SID);
    const settledPrice = JSON.parse(String(usageInserts(rig)[0]!.params?.[8])) as Record<string, unknown>;
    assert.equal(settledPrice.output_per_mtok, "5000");
    assert.equal(settledPrice.multiplier, "1.000");
    assert.equal(usageInserts(rig)[0]!.params?.[9], "2", "must settle with persisted authority price");
    // journal 权威终态 committed
    assert.equal(rig.poolCtrl.journalRows.get(serverReqId)?.state, "committed");

    ws2.close();
  });

  test("authority journal 的精确定价缺失/畸形 → 跨桥恢复免单，不回退 PricingCache", async () => {
    const usageBefore = usageInserts(rig).length;
    const container1P = waitNextContainerSocket(rig);
    const token = await makeJwt("11");
    const ws1 = openClient(rig.gatewayPort, token);
    await waitOpen(ws1);
    const container1 = await container1P;
    ws1.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
    }));
    const forwarded = JSON.parse(
      (await waitContainerNextFrame(container1)).data,
    ) as Record<string, unknown>;
    const requestId = forwarded.requestId as string;
    const journal = rig.poolCtrl.journalRows.get(requestId)!;
    journal.ctx.billingPricing = {
      ...(journal.ctx.billingPricing as Record<string, unknown>),
      outputPerMtok: "-1",
    };

    ws1.close();
    assert.equal(await waitContainerClose(container1, 2_000), true);

    const container2P = waitNextContainerSocket(rig);
    const ws2 = openClient(rig.gatewayPort, token);
    await waitOpen(ws2);
    const container2 = await container2P;
    container2.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    }));

    await waitUntil(() => rig.poolCtrl.journalRows.get(requestId)?.state === "aborted");
    assert.equal(
      rig.poolCtrl.journalRows.get(requestId)?.error_msg,
      permanentCodexWaiverReason("cross_bridge_authority_billing_pricing_invalid"),
    );
    assert.equal(usageInserts(rig).length, usageBefore, "invalid persisted authority price must not settle");
    await assert.rejects(
      () => waitJsonFrameOfType(ws2, "outbound.cost_charged", 200),
      /timeout/i,
    );
    ws2.close();
  });

  test("flag 开启后仍按持久分类恢复上线前 legacy journal，并仅对完全缺失价格字段回退 cache", async () => {
    const usageBefore = usageInserts(rig).length;
    const container1P = waitNextContainerSocket(rig);
    const token = await makeJwt("11");
    const ws1 = openClient(rig.gatewayPort, token);
    await waitOpen(ws1);
    const container1 = await container1P;
    ws1.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
    }));
    const forwarded = JSON.parse(
      (await waitContainerNextFrame(container1)).data,
    ) as Record<string, unknown>;
    const requestId = forwarded.requestId as string;
    const journal = rig.poolCtrl.journalRows.get(requestId)!;
    // 模拟本版本部署前写下的 legacy inflight 行：没有 authority 分类/绑定，也没有
    // 新增的 server-owned billingPricing。接收帧的新 bridge 此时 authority flag 已开。
    for (const key of [
      "authorityKind",
      "authorityTurnId",
      "billingRequestId",
      "executionRevision",
      "billingRevision",
      "securityEpoch",
      "billingPricing",
    ]) {
      delete journal.ctx[key];
    }

    ws1.close();
    assert.equal(await waitContainerClose(container1, 2_000), true);

    const container2P = waitNextContainerSocket(rig);
    const ws2 = openClient(rig.gatewayPort, token);
    await waitOpen(ws2);
    const container2 = await container2P;
    container2.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    }));

    const cost = await waitJsonFrameOfType(ws2, "outbound.cost_charged");
    assert.equal(cost.requestId, requestId);
    assert.equal(rig.poolCtrl.journalRows.get(requestId)?.state, "committed");
    assert.equal(usageInserts(rig).length, usageBefore + 1);
    ws2.close();
  });
});

describe("userChatBridge / codex billing — P0 authority journal 跨 flag 关闭恢复", () => {
  let rig: BillingRig;
  before(async () => {
    process.env.DRAIN_BILLING_MS = "200";
    rig = await startRig({ userBalance: 1_000_000n });
  });
  after(async () => {
    delete process.env.DRAIN_BILLING_MS;
    await stopRig(rig);
  });
  beforeEach(() => {
    _resetAgentMultiplierCacheForTests();
    rig.pricing._setForTests([PRICING]);
  });

  test("flag 关闭后仍按持久分类校验 authority journal，坏快照免单且不回退 cache", async () => {
    const usageBefore = usageInserts(rig).length;
    const container1P = waitNextContainerSocket(rig);
    const token = await makeJwt("12");
    const ws1 = openClient(rig.gatewayPort, token);
    await waitOpen(ws1);
    const container1 = await container1P;
    ws1.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
    }));
    const forwarded = JSON.parse(
      (await waitContainerNextFrame(container1)).data,
    ) as Record<string, unknown>;
    const requestId = forwarded.requestId as string;
    const journal = rig.poolCtrl.journalRows.get(requestId)!;
    // 模拟 flag 打开时已写入、随后跨重启由 flag-off bridge 接收 billing 的 authority 行。
    journal.ctx.authorityKind = "bridge_signed";
    journal.ctx.authorityTurnId = "1".repeat(32);
    journal.ctx.billingRequestId = requestId;
    journal.ctx.executionRevision = "a".repeat(64);
    journal.ctx.billingRevision = "b".repeat(64);
    journal.ctx.securityEpoch = "42";
    journal.ctx.billingPricing = {
      ...(journal.ctx.billingPricing as Record<string, unknown>),
      outputPerMtok: "-1",
    };

    ws1.close();
    assert.equal(await waitContainerClose(container1, 2_000), true);

    const container2P = waitNextContainerSocket(rig);
    const ws2 = openClient(rig.gatewayPort, token);
    await waitOpen(ws2);
    const container2 = await container2P;
    container2.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    }));

    await waitUntil(() => rig.poolCtrl.journalRows.get(requestId)?.state === "aborted");
    assert.equal(
      rig.poolCtrl.journalRows.get(requestId)?.error_msg,
      permanentCodexWaiverReason("cross_bridge_authority_billing_pricing_invalid"),
    );
    assert.equal(usageInserts(rig).length, usageBefore);
    await assert.rejects(
      () => waitJsonFrameOfType(ws2, "outbound.cost_charged", 200),
      /timeout/i,
    );
    ws2.close();
  });
});

describe("userChatBridge / codex billing — P0 displacement(新连接顶掉旧桥)不 abort", () => {
  let rig: BillingRig;
  before(async () => {
    process.env.DRAIN_BILLING_MS = "200";
    rig = await startRig({ userBalance: 1_000_000n, maxPerUser: 1 });
  });
  after(async () => {
    delete process.env.DRAIN_BILLING_MS;
    await stopRig(rig);
  });
  beforeEach(() => { _resetAgentMultiplierCacheForTests(); });

  test("同 user 新连接踢旧桥 → 旧桥不 abort inflight turn;billing 帧经新桥 settle", async () => {
    const container1P = waitNextContainerSocket(rig);
    const token = await makeJwt("42");
    const ws1 = openClient(rig.gatewayPort, token);
    await waitOpen(ws1);
    const container1 = await container1P;
    ws1.send(JSON.stringify({
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
    }));
    const serverReqId = (JSON.parse((await waitContainerNextFrame(container1)).data) as {
      requestId: string;
    }).requestId;

    // maxPerUser=1:第二条连接注册即踢旧桥(TOO_MANY_CONNECTIONS)
    const container2P = waitNextContainerSocket(rig);
    const ws2 = openClient(rig.gatewayPort, token);
    await waitOpen(ws2);
    const container2 = await container2P;

    // 旧桥被踢 → cleanup → drain 超时收尾;等它的容器 socket 关闭
    assert.equal(await waitContainerClose(container1, 2_000), true);
    assert.equal(journalAborts(rig).length, 0, "displacement must NOT abort surviving turn");
    assert.equal(rig.poolCtrl.journalRows.get(serverReqId)?.state, "inflight");

    // billing 帧到新桥 → 跨桥 settle
    container2.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: serverReqId,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 60, output_tokens: 120 },
    }));
    const cost = await waitJsonFrameOfType(ws2, "outbound.cost_charged");
    assert.equal(cost.requestId, serverReqId);
    assert.equal(usageInserts(rig).length, 1);
    assert.equal(rig.poolCtrl.journalRows.get(serverReqId)?.state, "committed");

    ws2.close();
  });
});

describe("userChatBridge / codex billing — P0 journal 回查裁决(aborted 撞帧 / 幂等 / 串桥)", () => {
  let rig: BillingRig;
  let logs: CapturedLog[];
  const recoveredAppends: unknown[][] = [];
  before(async () => {
    const cap = makeCaptureLogger();
    logs = cap.logs;
    rig = await startRig({
      userBalance: 1_000_000n,
      logger: cap.log,
      appendCostCredits: async (...args) => { recoveredAppends.push(args); },
    });
  });
  after(async () => { await stopRig(rig); });
  beforeEach(() => {
    _resetAgentMultiplierCacheForTests();
    logs.length = 0;
    rig.poolCtrl.queries.length = 0;
    recoveredAppends.length = 0;
  });

  async function openPair(uidStr: string): Promise<{ ws: WebSocket; containerWs: WebSocket }> {
    const containerP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, await makeJwt(uidStr));
    await waitOpen(ws);
    return { ws, containerWs: await containerP };
  }

  function sendBilling(containerWs: WebSocket, reqId: string): void {
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: reqId,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    }));
  }

  test("billing 帧撞显式永久免单 journal → 幂等忽略且不补收", async () => {
    const { ws, containerWs } = await openPair("43");
    const reqId = "a".repeat(32);
    rig.poolCtrl.journalRows.set(reqId, {
      state: "aborted",
      user_id: "43",
      ctx: { model: "gpt-5.6-sol", agentId: "codex", source: "codex_bridge" },
      precheck_credits: "100",
      error_msg: permanentCodexWaiverReason("bridge_disconnect"),
    });
    sendBilling(containerWs, reqId);

    await waitUntil(() =>
      logs.some((l) => l.level === "info" && l.msg.includes("proven permanent waiver")), 1500);
    assert.equal(usageInserts(rig).length, 0);
    assert.equal(ledgerInserts(rig).length, 0);
    let cost: Record<string, unknown> | null = null;
    try { cost = await waitJsonFrameOfType(ws, "outbound.cost_charged", 200); } catch { /* */ }
    assert.equal(cost, null, "proven permanent waiver must not charge");
    assert.equal(rig.poolCtrl.journalRows.get(reqId)?.state, "aborted");
    ws.close();
  });

  test("billing 帧撞无永久标记的 legacy aborted journal → 重开并按精确帧结算", async () => {
    const { ws, containerWs } = await openPair("431");
    const reqId = "d".repeat(32);
    rig.poolCtrl.journalRows.set(reqId, {
      state: "aborted",
      user_id: "431",
      ctx: {
        model: "gpt-5.6-sol",
        agentId: "codex",
        source: "codex_bridge",
      },
      precheck_credits: "100",
      error_msg: "codex_commit_failed:transient",
    });
    sendBilling(containerWs, reqId);

    const cost = await waitJsonFrameOfType(ws, "outbound.cost_charged");
    assert.equal(cost.requestId, reqId);
    assert.equal(usageInserts(rig).length, 1);
    assert.equal(ledgerInserts(rig).length, 1);
    assert.equal(rig.poolCtrl.journalRows.get(reqId)?.state, "committed");
    assert.equal(
      logs.some((l) => l.level === "warn" && l.msg.includes("reopened unproven aborted")),
      true,
    );
    ws.close();
  });

  test("billing 帧撞 committed journal → 不二次 settle/扣费，但修复 crash-window goal attribution", async () => {
    const { ws, containerWs } = await openPair("44");
    const reqId = "b".repeat(32);
    rig.poolCtrl.journalRows.set(reqId, {
      state: "committed",
      user_id: "44",
      ctx: { model: "gpt-5.6-sol", agentId: "codex", source: "codex_bridge" },
      precheck_credits: "100",
      error_msg: null,
    });
    const turnKey = "f".repeat(64);
    rig.poolCtrl.attributionCredits.set(reqId, "17");
    containerWs.send(JSON.stringify({
      type: "outbound.codex_billing",
      requestId: reqId,
      turnKey,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    }));

    await waitUntil(() =>
      logs.some((l) => l.msg.includes("already-settled journal")), 1500);
    assert.equal(usageInserts(rig).length, 0);
    assert.equal(recoveredAppends.length, 1);
    assert.equal(recoveredAppends[0]![0], reqId);
    assert.equal(recoveredAppends[0]![2], "17");
    assert.equal(recoveredAppends[0]![6], turnKey);
    let cost: Record<string, unknown> | null = null;
    try { cost = await waitJsonFrameOfType(ws, "outbound.cost_charged", 200); } catch { /* */ }
    assert.equal(cost, null);
    ws.close();
  });

  test("billing 帧先撞 finalizing 未提交窗口 → 不永久去重，提交证据可见后同帧完成修复", async () => {
    const { ws, containerWs } = await openPair("441");
    const reqId = "f".repeat(32);
    const turnKey = "e".repeat(64);
    rig.poolCtrl.journalRows.set(reqId, {
      state: "finalizing",
      user_id: "441",
      ctx: {
        model: "gpt-5.6-sol",
        agentId: "codex",
        source: "codex_bridge",
        settlementClaimId: "claim-in-progress",
      },
      precheck_credits: "100",
      error_msg: null,
    });

    const frame = {
      type: "outbound.codex_billing",
      requestId: reqId,
      turnKey,
      engineSessionId: ENGINE_SID,
      status: "success",
      usage: { input_tokens: 100, output_tokens: 200 },
    };
    containerWs.send(JSON.stringify(frame));
    await waitUntil(() =>
      logs.some((l) => l.msg.includes("attribution not yet visible")), 1500);
    assert.equal(recoveredAppends.length, 0);

    rig.poolCtrl.journalRows.get(reqId)!.state = "committed";
    rig.poolCtrl.attributionCredits.set(reqId, "19");
    containerWs.send(JSON.stringify(frame));
    await waitUntil(() => recoveredAppends.length === 1, 1500);
    assert.equal(recoveredAppends[0]![0], reqId);
    assert.equal(recoveredAppends[0]![2], "19");
    assert.equal(recoveredAppends[0]![6], turnKey);
    assert.equal(usageInserts(rig).length, 0);
    assert.equal(ledgerInserts(rig).length, 0);
    ws.close();
  });

  test("journal 行归属他人(串桥/伪造 requestId)→ 拒绝 settle + error 告警,不动 journal", async () => {
    const { ws, containerWs } = await openPair("45");
    const reqId = "c".repeat(32);
    rig.poolCtrl.journalRows.set(reqId, {
      state: "inflight",
      user_id: "99999", // 非本桥 uid
      ctx: { model: "gpt-5.6-sol", agentId: "codex", source: "codex_bridge" },
      precheck_credits: "100",
      error_msg: null,
    });
    sendBilling(containerWs, reqId);

    await waitUntil(() =>
      logs.some((l) => l.level === "error" && l.msg.includes("user mismatch")), 1500);
    assert.equal(usageInserts(rig).length, 0);
    // 他人的 journal 行不 abort 也不 commit(留给其归属桥/reconciler)
    assert.equal(rig.poolCtrl.journalRows.get(reqId)?.state, "inflight");
    ws.close();
  });

  test("无 journal 行(容器伪造 requestId)→ warn 丢弃,不 settle", async () => {
    const { ws, containerWs } = await openPair("46");
    sendBilling(containerWs, "e".repeat(32));
    await waitUntil(() =>
      logs.some((l) => l.level === "warn" && l.msg.includes("no journal row")), 1500);
    assert.equal(usageInserts(rig).length, 0);
    ws.close();
  });
});

describe("userChatBridge / Codex admission is session-scoped", () => {
  test("different peers run concurrently while the same peer stays single-flight", async () => {
    const rig = await startRig({ userBalance: 1_000_000n });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("160"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;

      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "peer-a", kind: "dm" },
        clientMessageId: "m-peer-a-1",
        agentId: "codex",
        model: "gpt-5.6-sol",
        content: { text: "long task A" },
      }));
      const first = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;

      // peer-a is still active. peer-b must not be blocked by bridge-global state.
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "peer-b", kind: "dm" },
        clientMessageId: "m-peer-b-1",
        agentId: "codex",
        model: "gpt-5.6-sol",
        content: { text: "independent task B" },
      }));
      const second = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
      assert.equal((first.peer as { id: string }).id, "peer-a");
      assert.equal((second.peer as { id: string }).id, "peer-b");
      assert.equal(rig.binding.acquireCalls, 2);

      // A second logical turn in peer-a is rejected without touching peer-b,
      // and the error identifies only the rejected client row.
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "peer-a", kind: "dm" },
        clientMessageId: "m-peer-a-busy",
        agentId: "codex",
        model: "gpt-5.6-sol",
        content: { text: "must queue" },
      }));
      const busy = await waitJsonFrameOfType(ws, "error", 3000);
      assert.equal(busy.code, "CODEX_TURN_BUSY");
      assert.deepEqual(busy.peer, { id: "peer-a", kind: "dm" });
      assert.equal(busy.clientMessageId, "m-peer-a-busy");
      assert.equal(rig.binding.acquireCalls, 2);

      containerWs.send(JSON.stringify({
        type: "outbound.message",
        channel: "webchat",
        peer: { id: "peer-a", kind: "dm" },
        clientMessageId: "m-peer-a-1",
        blocks: [{ kind: "text", text: "A complete" }],
        isFinal: true,
      }));
      await waitJsonFrameOfType(ws, "outbound.message", 3000);
      await waitUntil(() => rig.binding.releaseCalls >= 1, 1500);

      // Exact terminal release makes the same peer immediately reusable while
      // peer-b remains active.
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "peer-a", kind: "dm" },
        clientMessageId: "m-peer-a-2",
        agentId: "codex",
        model: "gpt-5.6-sol",
        content: { text: "follow-up A" },
      }));
      const third = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
      assert.equal((third.peer as { id: string }).id, "peer-a");
      assert.equal(rig.binding.acquireCalls, 3);

      for (const frame of [first, second, third]) {
        containerWs.send(JSON.stringify({
          type: "outbound.codex_billing",
          requestId: frame.requestId,
          engineSessionId: ENGINE_SID,
          status: "success",
          usage: { input_tokens: 1, output_tokens: 1 },
        }));
      }
      await waitUntil(() => rig.binding.releaseCalls >= 3, 1500);

      // Billing is an exact requestId-scoped terminal and can release before a
      // user-facing final arrives. A late id-less final from the old turn must
      // not ABA-release the newer modern turn on the same peer.
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "peer-b", kind: "dm" },
        clientMessageId: "m-peer-b-2",
        agentId: "codex",
        model: "gpt-5.6-sol",
        content: { text: "new B after billing" },
      }));
      const fourth = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
      assert.equal(rig.binding.acquireCalls, 4);
      containerWs.send(JSON.stringify({
        type: "outbound.message",
        channel: "webchat",
        peer: { id: "peer-b", kind: "dm" },
        blocks: [{ kind: "text", text: "late legacy final for old B" }],
        isFinal: true,
      }));
      await waitJsonFrameOfType(ws, "outbound.message", 3000);
      ws.send(JSON.stringify({
        type: "inbound.message",
        channel: "webchat",
        peer: { id: "peer-b", kind: "dm" },
        clientMessageId: "m-peer-b-still-busy",
        agentId: "codex",
        model: "gpt-5.6-sol",
        content: { text: "must still be rejected" },
      }));
      const stillBusy = await waitJsonFrameOfType(ws, "error", 3000);
      assert.equal(stillBusy.code, "CODEX_TURN_BUSY");
      assert.equal(stillBusy.clientMessageId, "m-peer-b-still-busy");
      assert.equal(rig.binding.acquireCalls, 4);
      containerWs.send(JSON.stringify({
        type: "outbound.codex_billing",
        requestId: fourth.requestId,
        engineSessionId: ENGINE_SID,
        status: "success",
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
      await waitUntil(() => rig.binding.releaseCalls >= 4, 1500);
      ws.close();
    } finally {
      await stopRig(rig);
    }
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "1",
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "2",
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
      assert.equal(ins.params?.[2], null, "M2: usage_records.account_id must be NULL (legacy 亦然)");
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
        assert.equal(args.modelId, "gpt-5.6-sol");
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
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
  const survivingRouteToken = "d".repeat(64);
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
        assert.equal(args.modelId, "gpt-5.6-sol");
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
        const selectedToken = args.userId === 22n ? survivingRouteToken : routeToken;
        return {
          token: selectedToken,
          baseUrl: `http://127.0.0.1:18789/internal/v3/codex-relay/route/${selectedToken}`,
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
      model: "gpt-5.6-sol",
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

  test("forwarded route token survives bridge drain timeout for the continuing turn", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const token = await makeJwt("22");
    const ws = openClient(rig.gatewayPort, token);
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    ws.send(JSON.stringify({
      type: "inbound.message",
      agentId: "codex",
      model: "gpt-5.6-sol",
      content: "x",
    }));
    const frameToContainer = await waitContainerNextFrame(containerWs);
    const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
    const route = parsed.__oc_codex_route as { baseUrl?: string } | undefined;
    assert.equal(route?.baseUrl?.includes(survivingRouteToken), true);

    ws.close();
    const containerClosed = await waitContainerClose(containerWs, 2_000);
    assert.equal(containerClosed, true, "container bridge must close after drain timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(
      expiredTokens.includes(survivingRouteToken),
      false,
      "bridge teardown must not expire a route owned by the surviving turn",
    );
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
      const containerWs = await containerOpenP;

      ws.send(JSON.stringify({
        type: "inbound.message",
        agentId: "codex",
        model: "gpt-5.6-sol",
        content: "x",
      }));
      await routeStartedP;
      const closedP = new Promise<void>((resolve) => ws.once("close", () => resolve()));
      ws.close();
      await closedP;
      const containerClosed = await waitContainerClose(containerWs, 2_000);
      assert.equal(containerClosed, true, "bridge must finish cleanup before route creation resumes");
      resolveRoute();
      // finalCleanup 已先完成,这个 route 从未转发给容器；late creation 必须
      // 由 identity fence 立即 expire,不能借“跨桥存活”语义泄漏到 TTL。
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
      type: "inbound.message", agentId: "codex", model: "gpt-5.6-sol", content: "x",
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
      model: "gpt-5.6-sol",
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
      model: "gpt-5.6-sol",
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

// ---------- P0 计费旁路封堵 — bridge 可信模型推导(agent 权威) ----------------
//
// 威胁:M1a 后任意 agent 的 agent.model='gpt-5.6-sol' 都落 codex 底座;帧不带 model
// 时容器 gateway 回落 agent.model,而旧 bridge 只认 frame.model / agentId='codex'
// / lastSeen → 该类 turn 不 preCheck、不注 server requestId → 免费 codex。
// 修复:bridge 从 master agent 权威(fake resolver 注入)推导有效模型参与分类;
// 推导不出且帧无 model → fail-closed 拒帧。

describe("userChatBridge / codex billing — agent 权威模型推导(P0 封堵)", () => {
  test("agent 默认 gpt-5.6-sol + 帧无 model → 经权威分类为 codex:preCheck + 注 server requestId", async () => {
    const resolverLoads: bigint[] = [];
    const rig = await startRig({
      userBalance: 1_000_000n,
      loadAgentModelResolver: async (uid) => {
        resolverLoads.push(uid);
        return (agentId: string) =>
          agentId === "gpt-helper" ? "gpt-5.6-sol" : agentId === "main" ? "glm-5.2" : null;
      },
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("21"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;
      assert.equal(resolverLoads.length >= 1, true, "连接建立时应加载一次 agent 权威快照");

      // 关键:帧不带 model,agentId 也不是 'codex' —— 旧实现会当非 codex 透传
      ws.send(JSON.stringify({ type: "inbound.message", agentId: "gpt-helper", content: "hi" }));

      const frameToContainer = await waitContainerNextFrame(containerWs);
      const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
      assert.equal(parsed.type, "inbound.message");
      // codex 分类命中 ⇒ server-owned requestId 已注入(32 hex)
      assert.match(parsed.requestId as string, /^[0-9a-f]{32}$/);
      // preCheck / inflight journal 已建立(不再是免费透传)
      assert.equal(
        rig.poolCtrl.queries.some((q) =>
          q.sql.trim().startsWith("INSERT INTO request_finalize_journal"),
        ),
        true,
        "codex turn 必须开 inflight journal",
      );
      // per-account 槽也走了 acquire(与显式 model 的 codex 帧同路径)
      assert.equal(rig.binding.acquireCalls, 1);
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("权威模型非 codex(main→glm)+ 帧无 model → 非 codex 透传,不注 requestId 不占槽", async () => {
    const rig = await startRig({
      userBalance: 1_000_000n,
      loadAgentModelResolver: async () => (agentId: string) =>
        agentId === "main" ? "glm-5.2" : null,
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("22"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;

      ws.send(JSON.stringify({ type: "inbound.message", agentId: "main", content: "hi" }));

      const frameToContainer = await waitContainerNextFrame(containerWs);
      const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
      assert.equal(parsed.type, "inbound.message");
      assert.equal(parsed.requestId, undefined, "非 codex 帧不注 server requestId");
      assert.equal(rig.binding.acquireCalls, 0, "非 codex 帧不进 codex acquire 路径");
      assert.equal(
        rig.poolCtrl.queries.some((q) =>
          q.sql.trim().startsWith("INSERT INTO request_finalize_journal"),
        ),
        false,
        "非 codex 帧不开 journal",
      );
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("teamMode main 强制 GPT 队长:即使客户端传 glm 也按 gpt 计费并转发 gpt model", async () => {
    const rig = await startRig({
      userBalance: 1_000_000n,
      loadAllowedModelChecker: async () => (modelId: string) => modelId === "gpt-5.6-sol",
      loadAgentModelResolver: async () => (agentId: string) =>
        agentId === "main" ? "glm-5.2" : null,
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("25"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;

      ws.send(JSON.stringify({
        type: "inbound.message",
        agentId: "main",
        model: "glm-5.2",
        teamMode: true,
        content: "hi",
      }));

      const frameToContainer = await waitContainerNextFrame(containerWs);
      const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
      assert.equal(parsed.type, "inbound.message");
      assert.equal(parsed.agentId, "main");
      assert.equal(parsed.teamMode, true);
      assert.equal(parsed.model, "gpt-5.6-sol", "teamMode main must be forwarded as GPT");
      assert.match(parsed.requestId as string, /^[0-9a-f]{32}$/);
      assert.equal(rig.binding.acquireCalls, 1, "forced GPT must acquire codex slot");
      const journal = rig.poolCtrl.journalRows.get(parsed.requestId as string);
      assert.ok(journal, "forced GPT must open inflight journal");
      assert.equal(journal.ctx.model, "gpt-5.6-sol", "journal model must match forced GPT");
      assert.equal(journal.ctx.agentId, "main", "team-mode GPT leader should charge main agent multiplier");
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("teamMode 省略 agentId 也按 main GPT 队长处理,避免 master/container 谓词漂移", async () => {
    const variants: Array<{ name: string; extra: Record<string, unknown> }> = [
      { name: "no model", extra: {} },
      { name: "client glm model", extra: { model: "glm-5.2" } },
    ];
    for (const [idx, variant] of variants.entries()) {
      const rig = await startRig({
        userBalance: 1_000_000n,
        loadAllowedModelChecker: async () => (modelId: string) => modelId === "gpt-5.6-sol",
        loadAgentModelResolver: async () => (agentId: string) =>
          agentId === "main" ? "glm-5.2" : null,
      });
      try {
        const containerOpenP = waitNextContainerSocket(rig);
        const ws = openClient(rig.gatewayPort, await makeJwt(`27${idx}`));
        await waitOpen(ws);
        const containerWs = await containerOpenP;

        ws.send(JSON.stringify({
          type: "inbound.message",
          teamMode: true,
          content: `hi ${variant.name}`,
          ...variant.extra,
        }));

        const frameToContainer = await waitContainerNextFrame(containerWs);
        const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
        assert.equal(parsed.type, "inbound.message");
        assert.equal(parsed.agentId, "main", "missing agentId must be normalized to main");
        assert.equal(parsed.teamMode, true);
        assert.equal(parsed.model, "gpt-5.6-sol", "teamMode main must be forwarded as GPT");
        assert.match(parsed.requestId as string, /^[0-9a-f]{32}$/);
        assert.equal(rig.binding.acquireCalls, 1, "forced GPT must acquire codex slot");
        const journal = rig.poolCtrl.journalRows.get(parsed.requestId as string);
        assert.ok(journal, "forced GPT must open inflight journal");
        assert.equal(journal.ctx.model, "gpt-5.6-sol", "journal model must match forced GPT");
        assert.equal(journal.ctx.agentId, "main", "missing agentId team-mode turn should charge main");
        ws.close();
      } finally {
        await stopRig(rig);
      }
    }
  });

  test("teamMode 显式未知 agentId 也按 main GPT 队长处理,避免 gateway 降级漂移", async () => {
    const rig = await startRig({
      userBalance: 1_000_000n,
      loadAllowedModelChecker: async () => (modelId: string) =>
        modelId === "gpt-5.6-sol" || modelId === "glm-5.2",
      loadAgentModelResolver: async () => (agentId: string) =>
        agentId === "main" ? "glm-5.2" : null,
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("28"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;

      ws.send(JSON.stringify({
        type: "inbound.message",
        agentId: "not-installed-agent",
        model: "glm-5.2",
        teamMode: true,
        content: "hi",
      }));

      const frameToContainer = await waitContainerNextFrame(containerWs);
      const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
      assert.equal(parsed.type, "inbound.message");
      assert.equal(parsed.agentId, "main", "unknown teamMode agentId must be normalized to main");
      assert.equal(parsed.teamMode, true);
      assert.equal(parsed.model, "gpt-5.6-sol", "unknown teamMode agentId must still force GPT leader");
      assert.match(parsed.requestId as string, /^[0-9a-f]{32}$/);
      assert.equal(rig.binding.acquireCalls, 1, "forced GPT must acquire codex slot");
      const journal = rig.poolCtrl.journalRows.get(parsed.requestId as string);
      assert.ok(journal, "forced GPT must open inflight journal");
      assert.equal(journal.ctx.model, "gpt-5.6-sol", "journal model must match forced GPT");
      assert.equal(journal.ctx.agentId, "main", "unknown teamMode agent should charge main");
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("teamMode 无 agent 权威快照时,显式 non-main agentId 也 fail-safe 按 main GPT 队长处理", async () => {
    const rig = await startRig({
      userBalance: 1_000_000n,
      loadAllowedModelChecker: async () => (modelId: string) => modelId === "gpt-5.6-sol",
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("29"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;

      ws.send(JSON.stringify({
        type: "inbound.message",
        agentId: "possibly-real-agent",
        model: "glm-5.2",
        teamMode: true,
        content: "hi",
      }));

      const frameToContainer = await waitContainerNextFrame(containerWs);
      const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
      assert.equal(parsed.type, "inbound.message");
      assert.equal(parsed.agentId, "main", "teamMode without authority must normalize to main");
      assert.equal(parsed.model, "gpt-5.6-sol", "teamMode without authority must force GPT leader");
      assert.match(parsed.requestId as string, /^[0-9a-f]{32}$/);
      assert.equal(rig.binding.acquireCalls, 1, "forced GPT must acquire codex slot");
      const journal = rig.poolCtrl.journalRows.get(parsed.requestId as string);
      assert.ok(journal, "forced GPT must open inflight journal");
      assert.equal(journal.ctx.model, "gpt-5.6-sol", "journal model must match forced GPT");
      assert.equal(journal.ctx.agentId, "main", "authority-less teamMode turn should charge main");
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("teamMode main 未授权 gpt-5.6-sol → 拒帧且不转发容器", async () => {
    const rig = await startRig({
      userBalance: 1_000_000n,
      loadAllowedModelChecker: async () => (modelId: string) => modelId !== "gpt-5.6-sol",
      loadAgentModelResolver: async () => (agentId: string) =>
        agentId === "main" ? "glm-5.2" : null,
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("26"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;
      let containerGotFrame = false;
      containerWs.on("message", () => { containerGotFrame = true; });

      const errP = waitJsonFrameOfType(ws, "error");
      ws.send(JSON.stringify({
        type: "inbound.message",
        peer: { id: "team-policy-peer", kind: "dm" },
        clientMessageId: "team-policy-message",
        agentId: "main",
        teamMode: true,
        content: "hi",
      }));

      const err = await errP;
      assert.equal(err.code, "UNAUTHORIZED_MODEL");
      assert.deepEqual(err.peer, { id: "team-policy-peer", kind: "dm" });
      assert.equal(err.clientMessageId, "team-policy-message");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(ws.readyState, WebSocket.OPEN, "turn policy rejection must not reconnect the whole bridge");
      assert.equal(containerGotFrame, false, "unauthorized forced GPT must not reach container");
      assert.equal(rig.binding.acquireCalls, 0);
      assert.equal(rig.poolCtrl.journalRows.size, 0);
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("显式直连 hidden-reviewer 被 bridge 拒绝且不转发容器", async () => {
    const rig = await startRig({
      userBalance: 1_000_000n,
      loadAllowedModelChecker: async () => (modelId: string) =>
        modelId === "gpt-5.6-sol" || modelId === "glm-5.2",
      loadAgentModelResolver: async () => (agentId: string) =>
        agentId === "main" ? "glm-5.2"
          : agentId === "hidden-reviewer" ? "glm-5.2"
            : null,
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("30"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;
      let containerGotFrame = false;
      containerWs.on("message", () => { containerGotFrame = true; });

      const errP = waitJsonFrameOfType(ws, "error");
      const closedP = new Promise<number>((r) => ws.once("close", (code) => r(code)));
      ws.send(JSON.stringify({
        type: "inbound.message",
        agentId: "hidden-reviewer",
        content: "hi",
      }));

      const err = await errP;
      assert.equal(err.code, "AGENT_NOT_FOUND");
      const closeCode = await closedP;
      assert.equal(closeCode, 4507, "direct hidden reviewer chat must use product-policy close");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(containerGotFrame, false, "direct hidden reviewer chat must not reach container");
      assert.equal(rig.binding.acquireCalls, 0);
      assert.equal(rig.poolCtrl.journalRows.size, 0);
    } finally {
      await stopRig(rig);
    }
  });

  test("inbound.hello 会过滤 hidden-reviewer peer 后再转发容器", async () => {
    const rig = await startRig({ userBalance: 1_000_000n });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("31"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;

      ws.send(JSON.stringify({
        type: "inbound.hello",
        peers: [
          { peerId: "p1", agentId: "hidden-reviewer", lastFrameSeq: 10 },
          { peerId: "p1", agentId: "main", lastFrameSeq: 10 },
        ],
      }));

      const frameToContainer = await waitContainerNextFrame(containerWs);
      const parsed = JSON.parse(frameToContainer.data) as { peers?: Array<{ agentId?: string }> };
      assert.deepEqual(
        (parsed.peers ?? []).map((p) => p.agentId ?? "main"),
        ["main"],
        "hidden reviewer must not be registered/resumed through user hello",
      );
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });

  test("权威推导不出 + 帧无 model → fail-closed 拒帧(UNRESOLVED_AGENT_MODEL)并补触发 refresh", async () => {
    let loaderCalls = 0;
    const rig = await startRig({
      userBalance: 1_000_000n,
      loadAgentModelResolver: async () => {
        loaderCalls += 1;
        return (agentId: string) => (agentId === "main" ? "glm-5.2" : null);
      },
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("23"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;
      const loadsBeforeFrame = loaderCalls;

      const errP = waitJsonFrameOfType(ws, "error");
      const closedP = new Promise<number>((r) => ws.once("close", (code) => r(code)));
      // 容器不应收到任何帧(fail-closed 不放行)
      let containerGotFrame = false;
      containerWs.on("message", () => { containerGotFrame = true; });

      ws.send(JSON.stringify({ type: "inbound.message", agentId: "user-custom-agent", content: "hi" }));

      const err = await errP;
      assert.equal(err.code, "UNRESOLVED_AGENT_MODEL");
      const closeCode = await closedP;
      assert.equal(closeCode, 4507, "走 PRODUCT_POLICY 拒帧路径(与 UNAUTHORIZED_MODEL 同款)");
      await waitUntil(() => loaderCalls > loadsBeforeFrame, 1000);
      assert.equal(containerGotFrame, false, "被拒帧不得转发给容器");
      assert.equal(rig.binding.acquireCalls, 0);
    } finally {
      await stopRig(rig);
    }
  });

  test("Agent 能力未就绪 + 帧显式带 model → 仍 fail-closed,不得执行容器陈旧投影", async () => {
    let loaderCalls = 0;
    const rig = await startRig({
      userBalance: 1_000_000n,
      loadAgentModelResolver: async () => {
        loaderCalls += 1;
        const resolver = (agentId: string) =>
          agentId === "main" ? "glm-5.2" : null;
        resolver.isRuntimeDenied = (agentId: string) => agentId === "blocked-agent";
        return resolver;
      },
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("230"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;
      const loadsBeforeFrame = loaderCalls;
      let containerGotFrame = false;
      containerWs.on("message", () => { containerGotFrame = true; });

      const errP = waitJsonFrameOfType(ws, "error");
      const closedP = new Promise<number>((r) => ws.once("close", (code) => r(code)));
      ws.send(JSON.stringify({
        type: "inbound.message",
        agentId: "blocked-agent",
        model: "glm-5.2",
        content: "hi",
      }));

      const err = await errP;
      assert.equal(err.code, "UNRESOLVED_AGENT_MODEL");
      assert.match(String(err.message), /not ready/);
      assert.equal(await closedP, 4507);
      await waitUntil(() => loaderCalls > loadsBeforeFrame, 1000);
      assert.equal(containerGotFrame, false, "explicit model must not bypass runtime readiness");
      assert.equal(rig.binding.acquireCalls, 0);
      assert.equal(rig.poolCtrl.journalRows.size, 0);
    } finally {
      await stopRig(rig);
    }
  });

  test("帧显式带 model 时 frame.model 优先于权威(gpt-5.6-sol 帧在非 gpt agent 上仍走 codex 计费)", async () => {
    const rig = await startRig({
      userBalance: 1_000_000n,
      loadAgentModelResolver: async () => (agentId: string) =>
        agentId === "main" ? "glm-5.2" : null,
    });
    try {
      const containerOpenP = waitNextContainerSocket(rig);
      const ws = openClient(rig.gatewayPort, await makeJwt("24"));
      await waitOpen(ws);
      const containerWs = await containerOpenP;

      ws.send(JSON.stringify({ type: "inbound.message", agentId: "main", model: "gpt-5.6-sol", content: "hi" }));

      const frameToContainer = await waitContainerNextFrame(containerWs);
      const parsed = JSON.parse(frameToContainer.data) as Record<string, unknown>;
      assert.match(parsed.requestId as string, /^[0-9a-f]{32}$/, "frame.model=gpt-5.6-sol → codex 计费路径");
      assert.equal(rig.binding.acquireCalls, 1);
      ws.close();
    } finally {
      await stopRig(rig);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 代码审 R1 MAJOR-2 —— 签发边界 epoch 重读 + journal 补偿
//
// 起手 fence(resolveTurnExecution)之后,codex turn 还要走 route → acquire →
// getAgentCostMultiplier → preCheck → startInflightJournal → 历史装配 一连串 await。
// 安全写(admin 禁用模型 / 撤销授权 / 改价 → bump epoch)完全可能落在这中间。
// 只 fence 一次的实现会:**照样开 journal、照样按旧价签出 lease 50min 的票**。
//
// 本组测试锁死的不变量:签之前重读 epoch,不一致就整单放弃 —— 且**不留悬空 journal**
// (悬空 = 要等 reconciler 30min 才终态化,期间对账口径是错的)。
// ─────────────────────────────────────────────────────────────────────────────

describe("userChatBridge / 模型执行权威 — 签发边界 epoch 重读(MAJOR-2)", () => {
  let rig: BillingRig;
  before(async () => { rig = await startRig({ modelAuthority: true }); });
  after(async () => { await stopRig(rig); });
  beforeEach(() => {
    rig.poolCtrl.queries.length = 0;
    rig.poolCtrl.journalRows.clear();
    rig.binding.acquireCalls = 0;
    rig.binding.releaseCalls = 0;
    rig.authority!.epochAtSign.value = AUTH_EPOCH;
    rig.pricing._setForTests([PRICING]);
  });

  test("epoch 未变 → 正常签发:envelope 注入 + journal 保持 inflight", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, await makeJwt("11"));
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    // 异步 legacy cache 故意放一份完全不同的价格；authority turn 必须无视它。
    rig.pricing._setForTests([{
      ...PRICING,
      input_per_mtok: 1n,
      output_per_mtok: 2n,
      multiplier: "0.001",
    }]);
    ws.send(JSON.stringify({
      type: "inbound.message", channel: "webchat", peer: { id: "p-ok", kind: "dm" },
      agentId: "codex", model: "gpt-5.6-sol", content: { text: "hi" }, ts: Date.now(),
    }));

    const forwarded = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
    assert.equal(forwarded.type, "inbound.message");
    assert.ok(forwarded[MODEL_AUTHORITY_FIELD], "epoch 没变就该签票");
    const rows = [...rig.poolCtrl.journalRows.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "inflight", "正常 turn 的 journal 留 inflight 等 settle");
    assert.deepEqual(rows[0].ctx.billingPricing, {
      v: 1,
      modelId: "gpt-5.6-sol",
      displayName: "GPT 5.6",
      inputPerMtok: "1000",
      outputPerMtok: "5000",
      cacheReadPerMtok: "100",
      cacheWritePerMtok: "500",
      multiplier: "1.000",
    });
    assert.match(String(rows[0].ctx.billingRevision), /^[0-9a-f]{64}$/);
    ws.close();
  });

  test("journal 开了之后 epoch 变了 → 拒帧 + **journal 关闭(aborted)** + 还槽 + 不转发", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, await makeJwt("11"));
    await waitOpen(ws);
    const containerWs = await containerOpenP;
    const containerFrames: string[] = [];
    containerWs.on("message", (d) => containerFrames.push(String(d)));

    // admin 在 turn 途中禁用了这个模型 / 撤销了授权 / 改了价 → DB epoch 前进。
    rig.authority!.epochAtSign.value = AUTH_EPOCH + 1n;

    ws.send(JSON.stringify({
      type: "inbound.message", channel: "webchat", peer: { id: "p-epoch", kind: "dm" },
      agentId: "codex", model: "gpt-5.6-sol", content: { text: "hi" }, ts: Date.now(),
    }));

    const err = await waitJsonFrameOfType(ws, "error", 3000);
    assert.equal(err.code, "MODEL_CONFIG_CHANGED_RETRY_TURN");

    // ① journal 必须被**补偿关闭** —— 悬空 inflight = 漏账/错账(reconciler 30min 才兜底)
    const rows = [...rig.poolCtrl.journalRows.values()];
    assert.equal(rows.length, 1, "journal 已经开过(证明拒帧发生在 journal 之后)");
    assert.equal(rows[0].state, "aborted", "epoch 变了必须 abort journal,绝不留悬空 inflight");
    assert.match(String(rows[0].error_msg), /sign_boundary_epoch_changed/);

    // ② 不扣费:没有任何 usage_records 落笔
    assert.equal(
      rig.poolCtrl.queries.some((q) => /INSERT INTO usage_records/i.test(q.sql)),
      false,
      "拒帧的 turn 不许产生扣费记录",
    );

    // ③ codex 槽还回去(否则该用户后续 codex turn 全被单飞门挡住)
    assert.equal(rig.binding.acquireCalls, 1);
    assert.equal(rig.binding.releaseCalls, 1, "拒帧必须还槽");

    // ④ 帧绝不进容器(既不带 envelope 转发,也不降级为无 envelope 转发)
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(
      containerFrames.some((s) => s.includes("inbound.message")),
      false,
      "epoch 变了就不许把这条 turn 送进容器",
    );
    ws.close();
  });

  test("补偿后用户可重开 turn:下一条(epoch 已稳定)照常计费转发", async () => {
    const containerOpenP = waitNextContainerSocket(rig);
    const ws = openClient(rig.gatewayPort, await makeJwt("11"));
    await waitOpen(ws);
    const containerWs = await containerOpenP;

    rig.authority!.epochAtSign.value = AUTH_EPOCH + 1n;
    ws.send(JSON.stringify({
      type: "inbound.message", channel: "webchat", peer: { id: "p-retry", kind: "dm" },
      agentId: "codex", model: "gpt-5.6-sol", content: { text: "one" }, ts: Date.now(),
    }));
    const err = await waitJsonFrameOfType(ws, "error", 3000);
    assert.equal(err.code, "MODEL_CONFIG_CHANGED_RETRY_TURN");

    // 管理员的变更已被快照吸收(生产里 = NOTIFY 重建;这里直接把两边对齐)
    rig.authority!.epochAtSign.value = AUTH_EPOCH;
    ws.send(JSON.stringify({
      type: "inbound.message", channel: "webchat", peer: { id: "p-retry", kind: "dm" },
      agentId: "codex", model: "gpt-5.6-sol", content: { text: "two" }, ts: Date.now(),
    }));
    const forwarded = JSON.parse((await waitContainerNextFrame(containerWs)).data) as Record<string, unknown>;
    assert.ok(forwarded[MODEL_AUTHORITY_FIELD], "重开的 turn 必须能正常签发(单飞槽已释放)");
    // 前一轮 aborted + 本轮 inflight,两行互不干扰
    const states = [...rig.poolCtrl.journalRows.values()].map((r) => r.state).sort();
    assert.deepEqual(states, ["aborted", "inflight"]);
    ws.close();
  });
});
