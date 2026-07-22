/**
 * V3 Phase 1 — billing 物理切出。
 *
 * 见 docs/V3_ANTHROPIC_PROXY_SPLIT_PLAN_2026-05-18.md Phase 1。
 *
 * 来源:`http/anthropicProxy.ts` L956-1471 逐字物理搬迁(行为零变更);
 * 关闭 anthropicProxy ↔ proxyBilling 双向 value import 依赖环靠把
 * `isObj` / `errSummary` / `errMessageShort` 三个通用 helper 下沉到
 * `http/util.ts`(两边都向 util 单向依赖)。`UsageObservation` 是
 * SSE-parse 侧的类型,proxyBilling 反向 type-only import,ESM 运行时
 * 已擦除,不形成 cycle。
 *
 * 本文件负责:
 *   - FinalizeContext / FinalizeOutcome / FinalizeDeps 接口
 *   - startInflightJournal / finalizeInflightJournal / abortInflightJournal
 *     三条 journal CAS 状态机入口
 *   - makeFinalizer single-shot 工厂(commit / fail / failClient 三态)
 *   - SettleResult / settleUsageAndLedger(usage_records + credit_ledger
 *     + users.credits 单事务,clamp + 23505 幂等)
 *   - isUniqueViolation / usageToLog 两个 billing-only 内部 helper
 *
 * 不变量(R3 + PR2 v1.0.66 + 2I-2 + Codex 审计结论):
 *   - single-shot finalize:once-flag + inflight promise 兜底,commit/fail/
 *     failClient 三入口加起来最多跑一次 release(scheduler + redis preCheck)
 *   - journal settle fence:仅 inflight→finalizing 可认领；随机 owner token
 *     同时约束 finalize/rollback，跨 bridge loser 不能扣费或 abort winner
 *   - DeepSeek 路径(`accountId === null`):跳过 scheduler.release,但 settle
 *     仍写 usage_records / credit_ledger(只是 account_id 写 NULL)
 *   - clamp 语义:余额 < cost,debit 夹到 balance、状态仍 success、ledger memo
 *     标 clamped、metrics 走 insufficient(不计 success)
 *   - 23505 幂等:同 (user_id, request_id) 二次进入 → SELECT 取已有行返回,
 *     debitedCredits/balanceAfter 退化为 null(无法重算)
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Logger } from "../logging/logger.js";
import { computeCost, type TokenUsage } from "./calculator.js";
import { spendTwoBucket } from "./spend.js";
import { lockTurnBillingKeys } from "./turnLock.js";
import { resolveOrgBillingContext } from "../org/orgBilling.js";
import type { ModelPricing } from "./pricing.js";
import {
  releasePreCheck,
  type PreCheckRedis,
  type ReservationHandle,
} from "./preCheck.js";
import type { AccountScheduler, ReleaseResult } from "../account-pool/scheduler.js";
import { incrBillingDebit } from "../admin/metrics.js";
import { errSummary, errMessageShort, isObj } from "../http/util.js";
import type { UsageObservation } from "../http/proxy/shared.js";
import {
  loadSettledUsageAttribution,
  stageUsageCostLocatorInBillingTransaction,
} from "../db/pgSessionsBackend.js";
import {
  verifySponsorshipForSettlement,
  type VerificationSponsorshipSnapshot,
} from "./verificationSponsorship.js";

export { loadUsageAttributionCredits } from "../db/pgSessionsBackend.js";

// ─── finalizer(single-shot + journal) ────────────────────────────────────

/**
 * 模型权威留证(0143 usage_records 四列;方案 §4 / R3-m11)。
 *
 * 语义:这一笔钱是**按哪个执行快照、哪个安全 epoch、凭哪类权威**扣的。
 *   - `bridge_signed`  = 浏览器 turn,凭 master Ed25519 签名的 authority/lease;
 *   - `local_catalog`  = 容器本地路径(cron/synthetic/delegate),凭容器 catalog token
 *                        (只做 epoch fence,授权仍走服务端权威)。
 * gate 未生效(legacy / 影子期)→ 整个对象为 null → 四列写 NULL(落库形状与旧版一致)。
 */
export interface BillingAuthorityStamp {
  executionRevision: string;
  /** bridge 路径无 per-uid 投影概念 → null。 */
  projectionRevision: string | null;
  securityEpoch: bigint;
  kind: "bridge_signed" | "local_catalog";
}

export interface FinalizeContext {
  requestId: string;
  userId: bigint;
  /**
   * agent_containers.id;**为 null 表示非容器 strategy**(如 API key 外接入口)。
   *
   * SQL 层 0015 `request_finalize_journal.container_id BIGINT REFERENCES ... NULL`
   * 早已允许 NULL,startInflightJournal 在 bind 时把 null 透传(见下方 SQL bind)。
   * settle 路径(usage_records / credit_ledger)本就不消费此字段,只按 user 维度。
   */
  containerId: bigint | null;
  /**
   * Claude 路径:scheduler.pick 选中的 claude_accounts.id,用于:
   *   - finalize 时 scheduler.release(account_id, result) 回流健康分
   *   - usage_records.account_id FK 关联(0044 已 nullable)
   *
   * **DeepSeek 路径(2026-05-02 接入):accountId=null**。理由:
   *   - DeepSeek 用 API key,不走 claude_accounts 池,无 account_id 概念
   *   - finalizer 在 accountId===null 时跳过 scheduler.release(没账号要回流)
   *   - usage_records.account_id 写 NULL(0044 SET NULL FK 支持)
   *   - 计费、journal、ledger 全部按 user 维度走,与 accountId 解耦
   */
  accountId: bigint | null;
  /**
   * B7 per-slot 租约 id。OAuth 路径 = pick.slotId(非 null);DeepSeek/MiniMax = null
   * (与 accountId 同生死)。finalize 权威 release 按此精确还槽。
   */
  slotId: string | null;
  model: string;
  pricing: ModelPricing;
  precheckCredits: bigint;
  preCheckReservation: ReservationHandle;
  log: Logger;
  /**
   * 调用方传来的 session_id(已 trim,空串→null)。
   * 仅用于写 usage_records.session_id,方便「使用消耗统计」按会话聚合。
   * 不参与调度 / 鉴权 / 限流;旧记录 session_id=NULL 属于 legacy 归属数据。
   */
  sessionId: string | null;
  /**
   * delegate 子会话计费归因(0104 migration)。三字段由 handler 从
   * extractUsageAttribution(body.metadata) 一次提取(权威源:gateway 对 delegate
   * 子会话 CCB 注入的 CLAUDE_CODE_EXTRA_METADATA env → metadata.user_id JSON)。
   *
   * 缺省语义(可选字段):mode 'chat' + null/null —— 未打标路径(codexFinalizer /
   * 旧容器镜像 / 普通 chat)与 0104 之前的落库行为完全一致。
   * 只做归因展示,不参与扣费判定 / 调度 / 限流。
   */
  mode?: "chat" | "delegate";
  parentSessionId?: string | null;
  delegateAgentId?: string | null;
  /** Stable lossless tape locators. When a real debit happens they are
   * persisted in the same PG transaction as the ledger entry, closing the
   * crash window before the egress cost outbox is fsynced. */
  turnKey?: string | null;
  parentTurnKey?: string | null;
  /**
   * 模型权威留证(0143 四列)。null / 缺省 = gate 未生效 → 四列写 NULL。
   * handler(http/proxy/index.ts)从每请求 gate 结果透传;codexFinalizer 等其它 settle
   * 调用方不传 → 行为与本批次之前一致。
   */
  authority?: BillingAuthorityStamp | null;
  /**
   * 0170 durable-turn dispatch 身份(RFC §2/§3)。handler 按每请求 dispatch 反查后透传;
   * 非 dispatch 路径(legacy / codexFinalizer)不传 → usage_records 两列写 NULL。
   */
  dispatchId?: string | null;
  attemptNo?: number | null;
  /** Release-bound test sponsorship admitted before provider work. */
  verificationSponsorship?: VerificationSponsorshipSnapshot | null;
}

export interface FinalizeOutcome {
  /** 写入 usage_records.cost_credits 的标称积分(基于 pricing 算出);abort/none → 0n */
  finalCredits: bigint;
  /**
   * 真正 debit 进 credit_ledger 的积分数(== ledger delta 绝对值)。
   *
   * 与 finalCredits 的区别:
   *   - clamp 场景:余额不足,debitedCredits = balance (< finalCredits)
   *   - billing_failed 场景(obs.kind='partial'):不走 ledger,debitedCredits=null
   *   - 23505 重入:DB 已提交,无法重读当次 debit → null
   *   - abort / cost=0 / 广播器想知道"有没有真的扣"→ null 表示不可用
   *
   * 广播/UI 应该用这个,不要用 finalCredits,否则 billing_failed/clamp 时会误报。
   */
  debitedCredits: bigint | null;
  /** Exact actual-debit amount persisted with the turn locator for GoalState
   * attribution. Unlike debitedCredits, zero is meaningful. Idempotent and
   * commit-proven recovery paths return the existing immutable locator amount
   * when available so callers can repair a missed fold/live refresh. */
  attributionCredits?: bigint | null;
  /** 'committed' | 'aborted' */
  state: "committed" | "aborted";
  /** journal 行的 PG 主键(== requestId) */
  requestId: string;
  /**
   * debit 完成后的 users.credits(== credit_ledger.balance_after)。
   *
   * 语义与 SettleResult.balanceAfter 一致:只要走了 ledger debit 事务就可读,
   * 即便 clamp 到 0n 也是合法值;非扣费路径 / 23505 重入 → null。
   * 调用方想展示"当前余额"且此处为 null 时,得另查 users 表。
   */
  balanceAfter: bigint | null;
}

export type JournalFailureCode =
  | "UNKNOWN"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_REJECTED"
  | "CLIENT_ABORT"
  | "STREAM_FAILED"
  | "BILLING_FAILED"
  | "INTERNAL_ERROR"
  | "USER_CANCELLED";

interface FinalizeDeps {
  pgPool: Pool;
  preCheckRedis: PreCheckRedis;
  scheduler: AccountScheduler;
}

/**
 * 在 stream 开始前原子申请一行 `inflight` journal。
 *
 * 返回 true 才代表本请求取得执行权；同 requestId 已存在时返回 false，调用方
 * 必须在上游 fetch 前停止。这里不能把冲突当“幂等 noop”继续执行：系统没有
 * 缓存可重放的模型响应，继续执行会产生第二份响应却没有第二条计费/审计记录。
 *
 * journal INSERT 必须先于上游 fetch,这样进程哪怕在 fetch 时 crash,journal 里
 * 也有这条 inflight 记录,reconciler 后续可以扫到并兜底退预扣(P1)。
 */
export async function startInflightJournal(
  pool: Pool,
  ctx: Pick<FinalizeContext, "requestId" | "userId" | "containerId" | "model" | "precheckCredits"> & {
    /** PR2 v1.0.66 — codex 路径透传 agent/account/source 到 ctx JSONB，reconciler
     *  重跑 / 排障可复原 turn 上下文。模型权威开启后还会持久化 server-owned 的精确
     *  billing pricing；跨 bridge settle 必须消费它，不能回读另一代异步缓存。普通同桥
     *  settle 仍以本地 inflight Map 中的 pricing 为准。anthropic 路径默认只含 model。 */
    ctxJson?: Record<string, unknown>;
    /** durable dispatch 身份(RFC §2.2)— 落**列**而非仅 ctx:reconciler 财务联查按
     *  dispatch_id 列直查,不落列 = 有账不认 → 误写"未计费"。legacy 路径不传 = NULL。 */
    dispatchId?: string | null;
    attemptNo?: number | null;
  },
): Promise<boolean> {
  const journalCtx = { model: ctx.model, ...(ctx.ctxJson ?? {}) };
  const inserted = await pool.query(
    `INSERT INTO request_finalize_journal
       (request_id, user_id, container_id, state, ctx, precheck_credits, dispatch_id, attempt_no)
     VALUES ($1, $2, $3, 'inflight', $4::jsonb, $5, $6, $7)
     ON CONFLICT (request_id) DO NOTHING`,
    [
      ctx.requestId,
      ctx.userId.toString(),
      // 2026-05-18 CC 外接 plan Phase 0:containerId 可为 null(API key strategy),
      // SQL 列允许 NULL(0015 SET NULL FK),pg bind null 即写 NULL。
      ctx.containerId === null ? null : ctx.containerId.toString(),
      JSON.stringify(journalCtx),
      ctx.precheckCredits.toString(),
      ctx.dispatchId ?? null,
      ctx.attemptNo ?? null,
    ],
  );
  return inserted.rowCount === 1;
}

/** 接管路径读 journal 现行(RFC §7.7):比对用**列**(权威),ctx 只补 model。 */
export async function readJournalForTakeover(
  pool: Pool,
  requestId: string,
): Promise<{
  state: string;
  userId: string;
  dispatchId: string | null;
  attemptNo: number | null;
  model: string | null;
} | null> {
  const row = (
    await pool.query<{
      state: string;
      user_id: string;
      dispatch_id: string | null;
      attempt_no: number | null;
      ctx: { model?: unknown } | null;
    }>(
      `SELECT state, user_id, dispatch_id, attempt_no, ctx
         FROM request_finalize_journal WHERE request_id = $1`,
      [requestId],
    )
  ).rows[0];
  if (!row) return null;
  return {
    state: row.state,
    userId: row.user_id,
    dispatchId: row.dispatch_id,
    attemptNo: row.attempt_no,
    model: typeof row.ctx?.model === "string" ? row.ctx.model : null,
  };
}

/**
 * Acquire the durable right to create financial settlement rows for a request.
 * A stale-stream reconciler may have already terminally aborted the journal;
 * in that case callers must not debit, even if a late upstream/Codex terminal
 * event contains valid usage.
 *
 * The UPDATE is also the concurrency fence:only `inflight` may become
 * `finalizing`, and the winner stores a random owner token in journal ctx.
 * PostgreSQL rechecks the WHERE after waiting on a concurrent row update, so
 * exactly one bridge can win. The token then fences both finalize and rollback;
 * a loser can neither debit nor abort the winner's settlement.
 */
export async function claimInflightJournalForSettlement(
  pool: Pool,
  requestId: string,
): Promise<string | null> {
  const settlementClaimId = randomUUID();
  const result = await pool.query(
    `UPDATE request_finalize_journal
        SET state='finalizing',
            ctx=jsonb_set(COALESCE(ctx, '{}'::jsonb), '{settlementClaimId}', to_jsonb($2::text), true),
            updated_at=NOW()
      WHERE request_id=$1 AND state='inflight'`,
    [requestId, settlementClaimId],
  );
  return result.rowCount === 1 ? settlementClaimId : null;
}

/**
 * journal owner CAS:finalizing → committed,落 final_credits + ledger/usage 关联。
 *
 * **PR2 v1.0.66 抽出**:从 makeFinalizer.runCommit 内联 SQL 抽出,
 * 只有持有 settlementClaimId 的 finalizer 能提交；0-row 必须抛错，已提交的
 * usage/ledger 留给 reconciler 按 request_id 补齐 journal，不得伪装成功。
 */
export async function finalizeInflightJournal(
  pool: Pool,
  ctx: {
    requestId: string;
    finalCredits: bigint;
    ledgerId: bigint | null;
    usageId: bigint;
    settlementClaimId: string;
  },
): Promise<void> {
  const finalized = await pool.query(
    `UPDATE request_finalize_journal
        SET state='committed',
            final_credits=$2,
            ledger_id=$3,
            usage_id=$4,
            failure_code=NULL,
            ctx=ctx - 'settlementClaimId',
            updated_at=NOW()
      WHERE request_id=$1
        AND state='finalizing'
        AND ctx->>'settlementClaimId'=$5`,
    [
      ctx.requestId,
      ctx.finalCredits.toString(),
      ctx.ledgerId === null ? null : ctx.ledgerId.toString(),
      ctx.usageId.toString(),
      ctx.settlementClaimId,
    ],
  );
  if (finalized.rowCount !== 1) {
    throw new Error(`request journal settlement fence lost for ${ctx.requestId}`);
  }
}

/**
 * journal CAS → aborted,落 error_msg + final_credits=0。
 *
 * **PR2 v1.0.66 抽出**:从 makeFinalizer.runAbort 内联 SQL 抽出。
 * 默认只允许未认领的 inflight abort；结算失败时必须同时提供 owner token，
 * 才能回滚自己持有的 finalizing。already committed 或别人的 claim 永不回退。
 */
export async function abortInflightJournal(
  pool: Pool,
  requestId: string,
  errorMsg: string,
  failureCode: JournalFailureCode = "UNKNOWN",
  settlementClaimId?: string,
): Promise<boolean> {
  const aborted = await pool.query(
    `UPDATE request_finalize_journal
        SET state='aborted',
            error_msg=$2,
            failure_code=$3,
            final_credits=0,
            ctx=ctx - 'settlementClaimId',
            updated_at=NOW()
      WHERE request_id=$1
        AND (${settlementClaimId === undefined
          ? "state='inflight'"
          : "state='finalizing' AND ctx->>'settlementClaimId'=$4"})`,
    settlementClaimId === undefined
      ? [requestId, errorMsg, failureCode]
      : [requestId, errorMsg, failureCode, settlementClaimId],
  );
  return aborted.rowCount === 1;
}

/**
 * Single-shot finalizer 工厂。
 *
 * 返回的 commit / fail 内部用 once-flag 包裹,保证两者总共只有一次实际效果。
 * 第二次/第三次调用立即返回上次的结果。
 *
 * 不变量:
 *   - release(scheduler) 与 releasePreCheck(redis) 都在这里发生,**不在外面**
 *   - DB 出错绝不阻塞响应已 flush 的字节流(异常被 catch + log + alert metric 留待运营)
 *   - usage_records 可能写不进去(如 status='error');不写 ledger 也不写 journal final
 *
 * 调用契约:外层 try 里 commit(observed),catch 里 fail(observed, err)。
 * finally 里**不要**再调任何 release —— finalize 内部已经搞定。
 */
/**
 * `makeFinalizer` 的返回类型。Phase 4(2026-05-18)切出 proxy/core.ts 时引入:
 * 让 `RoundTripCtx.finalize` 字段有命名类型,而不是裸 `ReturnType<typeof ...>`。
 */
export type FinalizerHandle = {
  commit: (obs: UsageObservation) => Promise<FinalizeOutcome>;
  fail: (obs: UsageObservation, err: unknown, failureCode?: JournalFailureCode) => Promise<FinalizeOutcome>;
  /**
   * 与 fail 同写库 + 写 abort journal,但 scheduler.release 走 client_error,
   * 不调 health.onFailure → 不扣账号健康分。用于上游 400 invalid_request_error
   * (用户参数损坏)与 ac.abort 客户端主动断流场景。
   */
  failClient: (obs: UsageObservation, err: unknown, failureCode?: JournalFailureCode) => Promise<FinalizeOutcome>;
};

export function makeFinalizer(deps: FinalizeDeps, ctx: FinalizeContext): FinalizerHandle {
  let done: FinalizeOutcome | null = null;
  let inflight: Promise<FinalizeOutcome> | null = null;

  async function runCommit(obs: UsageObservation): Promise<FinalizeOutcome> {
    if (obs.kind === "none") {
      // 看不到任何 usage 但 stream 正常结束 — 罕见(上游协议异常)。
      // 视为 abort,不扣费。
      return runAbort(obs, new Error("no usage observed in successful stream"), "BILLING_FAILED");
    }
    const usage = obs.usage;
    const { cost_credits, snapshot } = computeCost(usage, ctx.pricing);
    const status = obs.kind === "final" ? "success" : "billing_failed";
    // 免单规则(boss 2026-07-02):模型无响应/超时不向用户收费。代理层可判定的
    // 形态 = 流按"成功"收尾但 output_tokens 为 0 —— 正常回复(含 tool_use)至少
    // 产生 1 个 output token,零输出即"上游 hang/超时后吐了个空壳 usage"。此时
    // input/cache 成本平台自担:usage_records 照写(审计留痕,cost=0),ledger 不扣,
    // 前端不出 cost_charged。上游直接失败/中断的请求走 fail/abort 路径,本就不扣。
    const waivedNoOutput = status === "success" && BigInt(usage.output_tokens ?? 0) === 0n && cost_credits > 0n;
    const effectiveCredits = waivedNoOutput ? 0n : cost_credits;
    // 二阶段:journal→finalizing,再原子写 usage/ledger。只有结算事务尚未提交时
    // 才允许走 abort；结算一旦成功，journal 最终 CAS 失败必须留在 finalizing
    // 交给 reconciler，绝不能把已扣费请求回退成 aborted。
    let settled: SettleResult;
    let settlementClaimId: string | null = null;
    try {
      settlementClaimId = await claimInflightJournalForSettlement(
        deps.pgPool,
        ctx.requestId,
      );
      if (settlementClaimId === null) {
        // A stale-stream reconciler may already have terminally aborted this
        // journal. Settling after that CAS loss would debit the user while the
        // durable request truth remains "aborted" (and later GC loses the
        // association entirely). Never create usage/ledger rows without first
        // owning a settleable journal state.
        ctx.log.warn("proxy_finalize_claim_lost", {
          requestId: ctx.requestId,
        });
        // Another bridge/finalizer owns `finalizing`, or the journal is already
        // terminal. Never let the loser abort the winner's claim.
        return {
          finalCredits: 0n,
          debitedCredits: null,
          state: "aborted",
          requestId: ctx.requestId,
          balanceAfter: null,
        };
      }
      // 写 usage_records + credit_ledger + 更新 users.credits 一个事务里
      settled = await settleUsageAndLedger(deps.pgPool, {
        userId: ctx.userId,
        accountId: ctx.accountId,
        requestId: ctx.requestId,
        model: ctx.model,
        usage,
        snapshotJson: JSON.stringify({
          ...snapshot,
          ...(waivedNoOutput
            ? { waived: "no_output", wouldHaveCharged: cost_credits.toString() }
            : {}),
        }),
        costCredits: effectiveCredits,
        status,
        sessionId: ctx.sessionId ?? null,
        mode: ctx.mode,
        parentSessionId: ctx.parentSessionId,
        delegateAgentId: ctx.delegateAgentId,
        turnKey: ctx.turnKey,
        parentTurnKey: ctx.parentTurnKey,
        authority: ctx.authority ?? null,
        dispatchId: ctx.dispatchId ?? null,
        attemptNo: ctx.attemptNo ?? null,
        verificationSponsorship: ctx.verificationSponsorship ?? null,
      });
    } catch (err) {
      ctx.log.error("proxy_finalize_settle_db_failed", {
        err: errSummary(err),
        precheckCredits: ctx.precheckCredits.toString(),
      });
      // settle 写库失败 = billing_debit_failures_total{result="error"}
      incrBillingDebit("error");
      if (err instanceof SettlementCommitOutcomeUnknownError) {
        // Never turn an indeterminate COMMIT into an aborted waiver: a debit
        // may already exist and the reconciler will join durable usage truth.
        ctx.log.warn("proxy_finalize_commit_outcome_unknown", {
          requestId: ctx.requestId,
        });
        return {
          finalCredits: effectiveCredits,
          debitedCredits: null,
          attributionCredits: null,
          state: "committed",
          requestId: ctx.requestId,
          balanceAfter: null,
        };
      }
      return runAbort(obs, err, "BILLING_FAILED", settlementClaimId ?? undefined);
    }

    try {
      await finalizeInflightJournal(deps.pgPool, {
        requestId: ctx.requestId,
        finalCredits: effectiveCredits,
        ledgerId: settled.ledgerId,
        usageId: settled.usageId,
        settlementClaimId,
      });
    } catch (err) {
      ctx.log.warn("proxy_finalize_journal_pending", {
        errorClass: err instanceof Error ? "Error" : typeof err,
      });
      // Financial truth is already committed. The reconciler joins the durable
      // usage row by request_id and completes this journal CAS later.
    }
    ctx.log.info("proxy_finalize_committed", {
      finalCredits: effectiveCredits.toString(),
      kind: obs.kind,
      usage: usageToLog(usage),
      clamped: settled.clamped,
      ...(waivedNoOutput ? { waived: "no_output", wouldHaveCharged: cost_credits.toString() } : {}),
    });
    // 2I-2: billing_debit 三态语义重新对齐(Codex 审核结论):
    //   * success      = obs.kind='final' + cost>0 + 余额 >= cost (足额扣款)
    //   * insufficient = obs.kind='final' + cost>0 + 余额 < cost (debit 被夹到 0,欠费)
    //   * (不计数)    = obs.kind='partial' (status='billing_failed' 路径不走 ledger debit,settle 计 partial)
    //   * error        = settle 写库失败 (catch 块)
    if (status === "success" && effectiveCredits > 0n) {
      incrBillingDebit(settled.clamped ? "insufficient" : "success");
    }
    return {
      finalCredits: effectiveCredits,
      debitedCredits: settled.debitedCredits,
      attributionCredits: settled.attributionCredits,
      state: "committed",
      requestId: ctx.requestId,
      balanceAfter: settled.balanceAfter,
    };
  }

  async function runAbort(
    _obs: UsageObservation,
    err: unknown,
    failureCode: JournalFailureCode = "UNKNOWN",
    settlementClaimId?: string,
  ): Promise<FinalizeOutcome> {
    const msg = errMessageShort(err);
    try {
      await abortInflightJournal(
        deps.pgPool,
        ctx.requestId,
        msg,
        failureCode,
        settlementClaimId,
      );
    } catch (dbErr) {
      ctx.log.error("proxy_finalize_abort_db_failed", { err: errSummary(dbErr) });
    }
    ctx.log.warn("proxy_finalize_aborted", { reason: msg });
    return {
      finalCredits: 0n,
      debitedCredits: null,
      state: "aborted",
      requestId: ctx.requestId,
      balanceAfter: null,
    };
  }

  async function runFinalizeAndRelease(
    runner: () => Promise<FinalizeOutcome>,
    schedulerResult: "success" | "failure" | "client_error",
    schedulerErrMsg: string | null,
  ): Promise<FinalizeOutcome> {
    if (done) return done;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const out = await runner();
        // releasePreCheck:即使失败,Redis TTL 也会兜底(300s)
        try {
          await releasePreCheck(deps.preCheckRedis, ctx.preCheckReservation);
        } catch (e) {
          ctx.log.warn("proxy_release_precheck_failed", { err: errSummary(e) });
        }
        // DeepSeek/MiniMax 路径(accountId===null)无 claude_accounts pool slot 要回流;
        // 跳过 scheduler.release。accountId 与 slotId 同生死,配对判 null 同时让 TS 收窄
        // slotId 为非 null(避免裸 `!`,Codex 计划审 nice-to-have)。
        if (ctx.accountId !== null && ctx.slotId !== null) {
          try {
            const releaseResult: ReleaseResult =
              schedulerResult === "success"
                ? { kind: "success" }
                : schedulerResult === "client_error"
                  ? { kind: "client_error", error: schedulerErrMsg }
                  : { kind: "failure", error: schedulerErrMsg };
            await deps.scheduler.release({
              account_id: ctx.accountId,
              slotId: ctx.slotId,
              result: releaseResult,
            });
          } catch (e) {
            ctx.log.warn("proxy_release_scheduler_failed", { err: errSummary(e) });
          }
        }
        done = out;
        return out;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    commit: (obs) => runFinalizeAndRelease(() => runCommit(obs), "success", null),
    fail: (obs, err, failureCode) =>
      runFinalizeAndRelease(() => runAbort(obs, err, failureCode), "failure", errMessageShort(err)),
    failClient: (obs, err, failureCode) =>
      runFinalizeAndRelease(() => runAbort(obs, err, failureCode), "client_error", errMessageShort(err)),
  };
}

export interface SettleResult {
  usageId: bigint;
  ledgerId: bigint | null;
  /**
   * true 表示 debit 被夹到余额(`debit < costCredits`),用户余额已扣到 0 但还欠 cost - balance。
   * 此时 metrics 应记 `billing_debit_total{result="insufficient"}` 而非 "success"。
   * 仅在 `args.status === 'success'` 且 `costCredits > 0n` 路径才可能为 true。
   */
  clamped: boolean;
  /**
   * 真正 debit 进 ledger 的积分数(负号已去掉,就是绝对值)。
   *   - status='success' + cost>0:实际 debit (clamp 时 = balance,否则 = costCredits)
   *   - status='billing_failed' / cost=0:不走 ledger → null
   *   - 23505 重入:无法重算 → null
   *
   * 调用方用这个值决定是否向前端广播"已扣费"事件,以及广播多少。
   */
  debitedCredits: bigint | null;
  /** Actual debit persisted beside the lossless turn locator. Zero preserves
   * usage-only/error/waived attribution without inventing a charge. */
  attributionCredits: bigint | null;
  /**
   * debit 完成后的 users.credits(即 ledger balance_after)。
   *
   * 取值规则:
   *   - 走 ledger debit 的事务路径(status='success' + cost>0 + 非 23505 重入)
   *     → debit 后的 newBalance(clamp 场景下可能是 0n,也算合法值)
   *   - status='billing_failed' / cost=0 / abort / 23505 重入 → null
   *
   * caller 想展示"当前余额"且这里拿到 null 时,请另查 users 表。
   */
  balanceAfter: bigint | null;
}

/** COMMIT returned an error and independent reads could not yet prove whether
 * it committed. Callers must leave the journal recoverable; aborting could
 * contradict a debit that became visible after the connection was lost. */
export class SettlementCommitOutcomeUnknownError extends Error {
  constructor(readonly requestId: string, options?: { cause?: unknown }) {
    super(`settlement COMMIT outcome is unknown for ${requestId}`, options);
    this.name = "SettlementCommitOutcomeUnknownError";
  }
}

/**
 * 一个事务:INSERT usage_records,(若 status='success' 且 cost_credits>0)再走 debit。
 *
 * 幂等:`(user_id, request_id)` 唯一索引保证 usage_records 不会重插。
 * 重复进入 settle 时 INSERT 抛 23505 → 我们 catch 改成 SELECT 取已有行返回。
 */
/**
 * **PR2 v1.0.66 — export 供 codex 计费路径复用**(`packages/commercial/src/billing/codexFinalizer.ts`)。
 *
 * 单 PG 事务:INSERT usage_records → (status='success' && cost>0) FOR UPDATE users
 * → INSERT credit_ledger → 反写 usage_records.ledger_id。
 *
 * 调用方约束:
 *   - costCredits 必须 caller 自己用 computeCost(usage, derivedPricing) 算好
 *     (multiplier 已 apply 进 derivedPricing 了);**这里不重算**
 *   - status='success' + cost>0 才走 ledger debit;'billing_failed'/'error'/cost=0
 *     只落 usage_records 不扣费(audit 痕)
 *   - 重入(同 requestId 二次调用)由 (user_id, request_id) UNIQUE 守门,
 *     返回的 debitedCredits=null,balanceAfter=null,clamped=false
 */
export async function settleUsageAndLedger(
  pool: Pool,
  args: {
    userId: bigint;
    /**
     * Claude 路径 = claude_accounts.id;DeepSeek 路径 = null(无账号池概念,
     * usage_records.account_id 写 NULL,0044 SET NULL FK 支持)。
     */
    accountId: bigint | null;
    requestId: string;
    model: string;
    usage: TokenUsage;
    snapshotJson: string;
    costCredits: bigint;
    status: "success" | "billing_failed" | "error";
    sessionId: string | null;
    /**
     * delegate 计费归因(0104):缺省 'chat' + null/null = 0104 前落库行为。
     * mode CHECK 约束允许 ('chat','agent','delegate');'agent' 是 v3 legacy 值,
     * 本函数不产出。
     */
    mode?: "chat" | "delegate";
    parentSessionId?: string | null;
    delegateAgentId?: string | null;
    /** Stable logical tape locators. Optional only for rolling compatibility
     * with usage created before lossless turn tapes. */
    turnKey?: string | null;
    parentTurnKey?: string | null;
    /**
     * 模型权威留证(0143 四列;方案 §4)。缺省/null → 四列写 NULL —— codexFinalizer、
     * 旧测试、影子期的 CCB 路径都不传,落库形状与本批次之前完全一致。
     */
    authority?: BillingAuthorityStamp | null;
    /**
     * 0170 durable-turn dispatch 身份(RFC-v5-durable-turn-dispatch §2/§3)。缺省/null →
     * dispatch_id / attempt_no 两列写 NULL(legacy 路径 / 非 dispatch 请求,rollback-safe)。
     * 双引擎(CCB proxy + codex durable)在此单点收敛写入。
     */
    dispatchId?: string | null;
    attemptNo?: number | null;
    verificationSponsorship?: VerificationSponsorshipSnapshot | null;
  },
): Promise<SettleResult> {
  const client = await pool.connect();
  let commitAttempted = false;
  try {
    await client.query("BEGIN");
    // Exact turn-waiver fence. Delegate usage locks both child and parent/root
    // in canonical order; terminal finalization/refund uses the same key and
    // therefore cannot race between "checked marker" and debit COMMIT.
    const billingTurnKeys = await lockTurnBillingKeys(client, args.userId, [
      args.turnKey,
      args.parentTurnKey,
    ]);
    let turnWaived = false;
    if (billingTurnKeys.length > 0) {
      const waived = await client.query(
        `SELECT 1 FROM turn_waivers
          WHERE user_id=$1 AND turn_key = ANY($2::text[])
          LIMIT 1`,
        [args.userId.toString(), billingTurnKeys],
      );
      turnWaived = (waived.rowCount ?? 0) > 0;
    }
    const verificationSponsored = await verifySponsorshipForSettlement(
      client,
      args.verificationSponsorship,
    );
    const settledCostCredits = turnWaived || verificationSponsored ? 0n : args.costCredits;
    const settledSnapshotJson = turnWaived
      ? JSON.stringify({
          ...(JSON.parse(args.snapshotJson) as Record<string, unknown>),
          waived: "turn_auto_waive",
          wouldHaveCharged: args.costCredits.toString(),
        })
      : verificationSponsored
        ? JSON.stringify({
            ...(JSON.parse(args.snapshotJson) as Record<string, unknown>),
            waived: "verification_sponsorship",
            verificationRunId: args.verificationSponsorship!.runId,
            wouldHaveCharged: args.costCredits.toString(),
          })
        : args.snapshotJson;
    // org 归属解析(0112 企业版):tx 内、锁前一次索引点查。成员在某 active org 语境 →
    // 打戳 usage_records.org_id(**与扣费桶解耦**:只看成员是否在 org,无论钱从哪个桶扣);
    // billing_enabled=true 才让 org 钱包参与扣费(下面 spendTwoBucket 传 orgId)。
    const orgCtx = await resolveOrgBillingContext(client, args.userId);
    let usageId: bigint;
    let ledgerId: bigint | null = null;
    let clamped = false;
    let balanceAfter: bigint | null = null;
    let debitedCredits: bigint | null = null;
    try {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO usage_records
          (user_id, mode, account_id, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           price_snapshot, cost_credits, session_id, parent_session_id,
           delegate_agent_id, request_id, status, org_id,
           execution_revision, projection_revision, security_epoch, authority_kind,
           turn_key, parent_turn_key, dispatch_id, attempt_no,
           verification_run_id, would_have_cost_credits)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16,
                 $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
         RETURNING id::text AS id`,
        [
          args.userId.toString(),
          args.mode ?? "chat",
          // accountId === null → SQL NULL(deepseek 路径)
          args.accountId === null ? null : args.accountId.toString(),
          args.model,
          BigInt(args.usage.input_tokens).toString(),
          BigInt(args.usage.output_tokens).toString(),
          BigInt(args.usage.cache_read_tokens).toString(),
          BigInt(args.usage.cache_write_tokens).toString(),
          settledSnapshotJson,
          settledCostCredits.toString(),
          args.sessionId,
          args.parentSessionId ?? null,
          args.delegateAgentId ?? null,
          args.requestId,
          args.status,
          // org 语境即打戳(orgCtx 非空),不受 billing_enabled 影响。
          orgCtx?.orgId ?? null,
          // 0143 模型权威留证(不适用置 NULL)。BIGINT 列用十进制字符串绑,避免 JS number 丢精度。
          args.authority?.executionRevision ?? null,
          args.authority?.projectionRevision ?? null,
          args.authority ? args.authority.securityEpoch.toString() : null,
          args.authority?.kind ?? null,
          args.turnKey ?? null,
          args.parentTurnKey ?? null,
          // 0170 durable-turn dispatch 身份(双引擎收敛的唯一 usage_records 写入点)。
          args.dispatchId ?? null,
          args.attemptNo ?? null,
          verificationSponsored ? args.verificationSponsorship!.runId : null,
          verificationSponsored ? args.costCredits.toString() : null,
        ],
      );
      usageId = BigInt(ins.rows[0]!.id);
    } catch (err) {
      // 23505 = unique_violation;复用 (user_id, request_id) 上的 UNIQUE
      if (isUniqueViolation(err)) {
        // PG transaction 撞 23505 后整个 tx 进入 aborted state,
        // 后续语句直到 ROLLBACK/COMMIT 前全部报 25P02。
        // 幂等路径只需读出另一并发 tx 已提交的行,不再走本事务内 ledger 写入,
        // 因此先 ROLLBACK 结束 aborted tx,SELECT 走 autocommit 读已提交行即可。
        await client.query("ROLLBACK");
        const settled = await loadSettledUsageAttribution(client, args.userId, args.requestId);
        if (settled === null) throw err;
        // 重试时无法重新算 clamp(原始 balance 已变),保守标 false。
        // metric 只对首次 settle 路径完整反映 — 重复 settle 是边界场景,
        // 由 inflight 兜底,clamp 状态以原 ledger memo 为准(非 metric 来源)。
        return {
          usageId: settled.usageId,
          ledgerId: settled.ledgerId,
          clamped: false,
          // 重入路径 DB 已是提交态,原始 debit 金额无法安全重算,标 null
          // (caller 用 null 决定不对外广播 cost_charged,只靠 refreshBalance 更新气泡)。
          debitedCredits: null,
          // A crash may have happened after usage+ledger+pending committed but
          // before the post-commit fold/broadcast. Returning the existing exact
          // locator lets the retry drive that live refresh without re-debiting.
          attributionCredits: settled.attributionCredits,
          // 同上:余额可能被别的并发请求改过,无法还原当时的 balance_after。
          balanceAfter: null,
        };
      }
      throw err;
    }
    if (args.status === "success" && settledCostCredits > 0n) {
      // 双钱包扣费收口（0096）：先扣 period_credits 期内桶再扣 users.credits 持久钱包，
      // 各桶 FOR UPDATE 行锁串行化、按桶各写一条 credit_ledger（balance_after=该桶扣后值）。
      // 余额 < cost：不回滚 stream(已发字节回不来)，clamp 到总可用；status 仍 'success'，
      // billing_debit_total{result="insufficient"} +1 由 runCommit 据 settled.clamped 上报。
      const spend = await spendTwoBucket(client, {
        userId: args.userId,
        amount: settledCostCredits,
        reason: "chat",
        ref: { type: "usage_record", id: usageId.toString() },
        memo: `cost=${settledCostCredits}`,
        // billing_enabled=false 的成员:打戳但个人桶付(不传 orgId)。org 非 active 时
        // spendTwoBucket 内 FOR UPDATE 会再兜底 fail-open 降级个人桶。
        orgId: orgCtx && orgCtx.billingEnabled ? orgCtx.orgId : undefined,
        // 成员月度 org 预算(§17.4):随 orgId 一并传入,org 桶超限静默落个人桶。
        monthlyOrgBudget: orgCtx && orgCtx.billingEnabled ? orgCtx.monthlyOrgBudget : undefined,
      });
      clamped = spend.clamped;
      // balance_after 对外广播取"总可用"(期内桶+钱包)，对齐前端余额气泡语义。
      balanceAfter = spend.totalAfter;
      debitedCredits = spend.debited;
      ledgerId = spend.primaryLedgerId;
      if (ledgerId !== null) {
        await client.query("UPDATE usage_records SET ledger_id=$1 WHERE id=$2", [
          ledgerId.toString(),
          usageId.toString(),
        ]);
      }
    }
    const targetTurnKey = args.parentTurnKey ?? args.turnKey ?? null;
    const attributionCredits = targetTurnKey === null ? null : (debitedCredits ?? 0n);
    if (attributionCredits !== null) {
      await stageUsageCostLocatorInBillingTransaction(client, {
        requestId: args.requestId,
        userId: `c:${args.userId.toString()}`,
        sessionId: args.sessionId,
        parentSessionId: args.parentSessionId ?? null,
        delegateAgentId: args.delegateAgentId ?? null,
        turnKey: args.turnKey ?? null,
        parentTurnKey: args.parentTurnKey ?? null,
        // The locator is also the durable join from usage_records to this
        // tape. A zero actual debit must therefore still be staged; the goal
        // token aggregate reads the usage row while the credit aggregate adds
        // exactly zero. This commits atomically with usage/ledger truth.
        costCredits: attributionCredits,
      });
    }
    commitAttempted = true;
    await client.query("COMMIT");
    return { usageId, ledgerId, clamped, debitedCredits, attributionCredits, balanceAfter };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    if (commitAttempted) {
      // Use a new pool checkout: the transaction connection may be dead or in
      // an indeterminate protocol state. A committed usage row is permanent
      // financial truth and lets the journal finalize idempotently.
      for (const delayMs of [0, 50, 150]) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        try {
          const settled = await loadSettledUsageAttribution(pool, args.userId, args.requestId);
          if (settled) {
            return {
              usageId: settled.usageId,
              ledgerId: settled.ledgerId,
              clamped: false,
              debitedCredits: null,
              attributionCredits: settled.attributionCredits,
              balanceAfter: null,
            };
          }
        } catch {
          // A failed proof query is also indeterminate; retry, never abort.
        }
      }
      throw new SettlementCommitOutcomeUnknownError(args.requestId, { cause: err });
    }
    throw err;
  } finally {
    client.release();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return isObj(err) && (err as { code?: unknown }).code === "23505";
}

function usageToLog(u: TokenUsage): Record<string, string> {
  return {
    input_tokens: BigInt(u.input_tokens).toString(),
    output_tokens: BigInt(u.output_tokens).toString(),
    cache_read_tokens: BigInt(u.cache_read_tokens).toString(),
    cache_write_tokens: BigInt(u.cache_write_tokens).toString(),
  };
}
