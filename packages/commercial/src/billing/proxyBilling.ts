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
 *   - journal CAS:WHERE state IN ('inflight','finalizing') 防 reconciler 已
 *     abort 的行被覆盖回 committed,反向同理
 *   - DeepSeek 路径(`accountId === null`):跳过 scheduler.release,但 settle
 *     仍写 usage_records / credit_ledger(只是 account_id 写 NULL)
 *   - clamp 语义:余额 < cost,debit 夹到 balance、状态仍 success、ledger memo
 *     标 clamped、metrics 走 insufficient(不计 success)
 *   - 23505 幂等:同 (user_id, request_id) 二次进入 → SELECT 取已有行返回,
 *     debitedCredits/balanceAfter 退化为 null(无法重算)
 */

import type { Pool } from "pg";
import type { Logger } from "../logging/logger.js";
import { computeCost, type TokenUsage } from "./calculator.js";
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

// ─── finalizer(single-shot + journal) ────────────────────────────────────

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

interface FinalizeDeps {
  pgPool: Pool;
  preCheckRedis: PreCheckRedis;
  scheduler: AccountScheduler;
}

/**
 * 在 stream 开始前写一行 `inflight` journal。**幂等**:同 requestId 二次调用 noop。
 *
 * 设计理由:journal INSERT 必须先于上游 fetch,这样进程哪怕在 fetch 时 crash,
 * journal 里就有这条 inflight 记录,reconciler 后续可以扫到并兜底退预扣(P1)。
 */
export async function startInflightJournal(
  pool: Pool,
  ctx: Pick<FinalizeContext, "requestId" | "userId" | "containerId" | "model" | "precheckCredits"> & {
    /** PR2 v1.0.66 — codex 路径透传 {agentId, codexAccountId, source} 到 ctx JSONB,
     *  reconciler 重跑 / 排障可从 journal 复原 codex turn 上下文。anthropic 路径不传,
     *  保持现状(默认 ctx 只含 model)。**注意**:settle 时不信 ctxJson(以本地 Map
     *  snapshot 为准),ctxJson 只服务 reconciler / audit。 */
    ctxJson?: Record<string, unknown>;
  },
): Promise<void> {
  const journalCtx = { model: ctx.model, ...(ctx.ctxJson ?? {}) };
  await pool.query(
    `INSERT INTO request_finalize_journal
       (request_id, user_id, container_id, state, ctx, precheck_credits)
     VALUES ($1, $2, $3, 'inflight', $4::jsonb, $5)
     ON CONFLICT (request_id) DO NOTHING`,
    [
      ctx.requestId,
      ctx.userId.toString(),
      // 2026-05-18 CC 外接 plan Phase 0:containerId 可为 null(API key strategy),
      // SQL 列允许 NULL(0015 SET NULL FK),pg bind null 即写 NULL。
      ctx.containerId === null ? null : ctx.containerId.toString(),
      JSON.stringify(journalCtx),
      ctx.precheckCredits.toString(),
    ],
  );
}

/**
 * journal CAS:inflight/finalizing → committed,落 final_credits + ledger/usage 关联。
 *
 * **PR2 v1.0.66 抽出**:从 makeFinalizer.runCommit 内联 SQL 抽出,
 * codex finalizer 单 phase(无 finalizing 中间态)直接调用此 helper。
 *
 * CAS WHERE state IN (...) 防止 reconciler 已 abort 的行被覆盖回 committed
 * (虽然 once-flag + reconciler 间隔保证一般不会发生,helper 自防御稳)。
 */
export async function finalizeInflightJournal(
  pool: Pool,
  ctx: {
    requestId: string;
    finalCredits: bigint;
    ledgerId: bigint | null;
    usageId: bigint;
  },
): Promise<void> {
  await pool.query(
    `UPDATE request_finalize_journal
        SET state='committed',
            final_credits=$2,
            ledger_id=$3,
            usage_id=$4,
            updated_at=NOW()
      WHERE request_id=$1
        AND state IN ('inflight','finalizing')`,
    [
      ctx.requestId,
      ctx.finalCredits.toString(),
      ctx.ledgerId === null ? null : ctx.ledgerId.toString(),
      ctx.usageId.toString(),
    ],
  );
}

/**
 * journal CAS:inflight/finalizing → aborted,落 error_msg + final_credits=0。
 *
 * **PR2 v1.0.66 抽出**:从 makeFinalizer.runAbort 内联 SQL 抽出。
 * 加 CAS state IN (...) guard:already committed 行不被回退到 aborted。
 */
export async function abortInflightJournal(
  pool: Pool,
  requestId: string,
  errorMsg: string,
): Promise<void> {
  await pool.query(
    `UPDATE request_finalize_journal
        SET state='aborted',
            error_msg=$2,
            final_credits=0,
            updated_at=NOW()
      WHERE request_id=$1
        AND state IN ('inflight','finalizing')`,
    [requestId, errorMsg],
  );
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
  fail: (obs: UsageObservation, err: unknown) => Promise<FinalizeOutcome>;
  /**
   * 与 fail 同写库 + 写 abort journal,但 scheduler.release 走 client_error,
   * 不调 health.onFailure → 不扣账号健康分。用于上游 400 invalid_request_error
   * (用户参数损坏)与 ac.abort 客户端主动断流场景。
   */
  failClient: (obs: UsageObservation, err: unknown) => Promise<FinalizeOutcome>;
};

export function makeFinalizer(deps: FinalizeDeps, ctx: FinalizeContext): FinalizerHandle {
  let done: FinalizeOutcome | null = null;
  let inflight: Promise<FinalizeOutcome> | null = null;

  async function runCommit(obs: UsageObservation): Promise<FinalizeOutcome> {
    if (obs.kind === "none") {
      // 看不到任何 usage 但 stream 正常结束 — 罕见(上游协议异常)。
      // 视为 abort,不扣费。
      return runAbort(obs, new Error("no usage observed in successful stream"));
    }
    const usage = obs.usage;
    const { cost_credits, snapshot } = computeCost(usage, ctx.pricing);
    const status = obs.kind === "final" ? "success" : "billing_failed";
    // 二阶段:UPDATE → INSERT × 2 + UPDATE。失败任何一步都 catch 掉走 abort 路径。
    try {
      await deps.pgPool.query(
        `UPDATE request_finalize_journal
            SET state='finalizing', updated_at=NOW()
          WHERE request_id=$1 AND state IN ('inflight','finalizing')`,
        [ctx.requestId],
      );
      // 写 usage_records + credit_ledger + 更新 users.credits 一个事务里
      const settled = await settleUsageAndLedger(deps.pgPool, {
        userId: ctx.userId,
        accountId: ctx.accountId,
        requestId: ctx.requestId,
        model: ctx.model,
        usage,
        snapshotJson: JSON.stringify(snapshot),
        costCredits: cost_credits,
        status,
        sessionId: ctx.sessionId ?? null,
      });
      await finalizeInflightJournal(deps.pgPool, {
        requestId: ctx.requestId,
        finalCredits: cost_credits,
        ledgerId: settled.ledgerId,
        usageId: settled.usageId,
      });
      ctx.log.info("proxy_finalize_committed", {
        finalCredits: cost_credits.toString(),
        kind: obs.kind,
        usage: usageToLog(usage),
        clamped: settled.clamped,
      });
      // 2I-2: billing_debit 三态语义重新对齐(Codex 审核结论):
      //   * success      = obs.kind='final' + cost>0 + 余额 >= cost (足额扣款)
      //   * insufficient = obs.kind='final' + cost>0 + 余额 < cost (debit 被夹到 0,欠费)
      //   * (不计数)    = obs.kind='partial' (status='billing_failed' 路径不走 ledger debit,settle 计 partial)
      //   * error        = settle 写库失败 (catch 块)
      if (status === "success" && cost_credits > 0n) {
        incrBillingDebit(settled.clamped ? "insufficient" : "success");
      }
      return {
        finalCredits: cost_credits,
        debitedCredits: settled.debitedCredits,
        state: "committed",
        requestId: ctx.requestId,
        balanceAfter: settled.balanceAfter,
      };
    } catch (err) {
      ctx.log.error("proxy_finalize_commit_db_failed", {
        err: errSummary(err),
        precheckCredits: ctx.precheckCredits.toString(),
      });
      // settle 写库失败 = billing_debit_failures_total{result="error"}
      incrBillingDebit("error");
      // 走 abort 路径,确保 journal/redis/scheduler 状态一致
      return runAbort(obs, err);
    }
  }

  async function runAbort(_obs: UsageObservation, err: unknown): Promise<FinalizeOutcome> {
    const msg = errMessageShort(err);
    try {
      await abortInflightJournal(deps.pgPool, ctx.requestId, msg);
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
        // DeepSeek 路径(accountId===null)无 claude_accounts pool slot 要回流;
        // 跳过 scheduler.release 以免传 null account_id 进 scheduler 内部。
        if (ctx.accountId !== null) {
          try {
            const releaseResult: ReleaseResult =
              schedulerResult === "success"
                ? { kind: "success" }
                : schedulerResult === "client_error"
                  ? { kind: "client_error", error: schedulerErrMsg }
                  : { kind: "failure", error: schedulerErrMsg };
            await deps.scheduler.release({
              account_id: ctx.accountId,
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
    fail: (obs, err) =>
      runFinalizeAndRelease(() => runAbort(obs, err), "failure", errMessageShort(err)),
    failClient: (obs, err) =>
      runFinalizeAndRelease(() => runAbort(obs, err), "client_error", errMessageShort(err)),
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
  },
): Promise<SettleResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
           price_snapshot, cost_credits, session_id, request_id, status)
         VALUES ($1, 'chat', $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)
         RETURNING id::text AS id`,
        [
          args.userId.toString(),
          // accountId === null → SQL NULL(deepseek 路径)
          args.accountId === null ? null : args.accountId.toString(),
          args.model,
          BigInt(args.usage.input_tokens).toString(),
          BigInt(args.usage.output_tokens).toString(),
          BigInt(args.usage.cache_read_tokens).toString(),
          BigInt(args.usage.cache_write_tokens).toString(),
          args.snapshotJson,
          args.costCredits.toString(),
          args.sessionId,
          args.requestId,
          args.status,
        ],
      );
      usageId = BigInt(ins.rows[0]!.id);
    } catch (err) {
      // 23505 = unique_violation;复用 (user_id, request_id) 上的 UNIQUE
      if (isUniqueViolation(err)) {
        const sel = await client.query<{ id: string; ledger_id: string | null }>(
          `SELECT id::text AS id, ledger_id::text AS ledger_id
             FROM usage_records WHERE user_id=$1 AND request_id=$2`,
          [args.userId.toString(), args.requestId],
        );
        if (sel.rowCount === 0) throw err;
        const r = sel.rows[0]!;
        await client.query("COMMIT");
        // 重试时无法重新算 clamp(原始 balance 已变),保守标 false。
        // metric 只对首次 settle 路径完整反映 — 重复 settle 是边界场景,
        // 由 inflight 兜底,clamp 状态以原 ledger memo 为准(非 metric 来源)。
        return {
          usageId: BigInt(r.id),
          ledgerId: r.ledger_id === null ? null : BigInt(r.ledger_id),
          clamped: false,
          // 重入路径 DB 已是提交态,原始 debit 金额无法安全重算,标 null
          // (caller 用 null 决定不对外广播 cost_charged,只靠 refreshBalance 更新气泡)。
          debitedCredits: null,
          // 同上:余额可能被别的并发请求改过,无法还原当时的 balance_after。
          balanceAfter: null,
        };
      }
      throw err;
    }
    if (args.status === "success" && args.costCredits > 0n) {
      // FOR UPDATE 行锁:同一 user 并发 finalize 串行,balance_after 单调
      const before = await client.query<{ credits: string }>(
        "SELECT credits::text AS credits FROM users WHERE id=$1 FOR UPDATE",
        [args.userId.toString()],
      );
      if (before.rowCount === 0) throw new Error(`user ${args.userId} not found`);
      const balance = BigInt(before.rows[0]!.credits);
      // 余额 < cost:不再回滚 stream(已发字节回不来),把扣费金额 clamp 到余额。
      // status 仍是 'success' (业务上已交付完整流), ledger memo 标 'clamped' 并把
      // billing_debit_total{result="insufficient"} +1 (由 runCommit 根据 settled.clamped 上报)。
      // balance_after = 0,用户回到 0 再充值。
      const debit = balance < args.costCredits ? balance : args.costCredits;
      clamped = debit < args.costCredits;
      const newBalance = balance - debit;
      balanceAfter = newBalance;
      debitedCredits = debit;
      await client.query(
        "UPDATE users SET credits=$1 WHERE id=$2",
        [newBalance.toString(), args.userId.toString()],
      );
      const led = await client.query<{ id: string }>(
        `INSERT INTO credit_ledger
           (user_id, delta, balance_after, reason, ref_type, ref_id, memo)
         VALUES ($1, $2, $3, 'chat', 'usage_record', $4, $5)
         RETURNING id::text AS id`,
        [
          args.userId.toString(),
          (-debit).toString(),
          newBalance.toString(),
          usageId.toString(),
          debit < args.costCredits
            ? `cost=${args.costCredits} balance=${balance} clamped`
            : null,
        ],
      );
      ledgerId = BigInt(led.rows[0]!.id);
      await client.query(
        "UPDATE usage_records SET ledger_id=$1 WHERE id=$2",
        [ledgerId.toString(), usageId.toString()],
      );
    }
    await client.query("COMMIT");
    return { usageId, ledgerId, clamped, debitedCredits, balanceAfter };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
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
