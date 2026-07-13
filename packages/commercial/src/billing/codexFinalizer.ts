/**
 * PR2 v1.0.66 — codex turn 真扣费 finalizer。
 *
 * ── v5 形态(M1b codex 复活,2026-07-02)──────────────────────────────────
 *   与 v3 版的四个口径差(均为钱安全项,不得回退):
 *   1. 扣费收口 = settleUsageAndLedger → spendTwoBucket(0096 双钱包:期内桶优先、
 *      持久钱包兜底),balanceAfter = 双钱包总可用;
 *   2. 零输出免单:success 且 output_tokens=0 但本有成本 → 免单(f3818040 红线,
 *      anthropic 路径的同规则在 proxyBilling 层,codex 直连 settle 必须本层显式补);
 *   3. usage_records.account_id 恒写 NULL(不再用 v3 的 accountId=0n 假账号);
 *   4. usage_records.session_id = engineSessionId(`oceng-<48hex>`,
 *      deriveEngineSessionId 单一权威),turn-waive 退款窗口才能命中 codex 记录。
 *   bridge 接线与 inflight/drain 状态机属 M2,本文件不含 bridge 依赖。
 *
 * 职责:接 outbound.codex_billing 帧的 token usage,按 derivedPricing(已 apply
 * agent_cost_overrides multiplier)算出 costCredits →
 *   1. settleUsageAndLedger:单 PG 事务 BEGIN/COMMIT 写 usage_records + credit_ledger
 *      debit(沿用 anthropic 既有 helper,(user_id, request_id) UNIQUE 防重复)
 *   2. finalizeInflightJournal:**独立** UPDATE 把 journal 由 inflight → committed
 *      (与 settle 不在同一 tx — 沿用 anthropic 既有架构;若 settle 已 COMMIT 而
 *      finalize 失败,会进 catch 走 abortInflightJournal,留下"用户已扣费 + journal=
 *      aborted"的窄窗口,reconciler 不会回滚已 COMMIT 的 ledger,日志可发现。统一
 *      模式与 anthropicProxy.makeFinalizer 一致,不在 PR2 范围内重构)
 *   3. release preCheck reservation
 *
 * 与 anthropic 路径的 makeFinalizer 区别:
 *   - codex 没有 multi-account scheduler(用 codexBinding.acquire/release 已在
 *     userChatBridge.ts 早释放路径里搞定),不调 scheduler.release
 *   - codex 是 single-shot:gateway 在 turn 终态发一次 outbound.codex_billing,
 *     不存在 anthropic 那种 stream 中途观察 partial 的两阶段(没有 'finalizing' 中间态)
 *   - cost 由 caller 给的 derivedPricing(multiplier 已 apply)算 — settle 前就要
 *     拿到 multiplier,因为 preCheck 也用同一份 derivedPricing 估 maxCost
 *
 * 不变量(commit / fail 只能合计执行一次的实际效果):
 *   - 第二次调用按"首次 kind"分支:
 *       - commit-after-commit:返**首次 commit 的同一 promise**(duplicate 帧也
 *         不重复 debit,广播由 caller 的 Map.delete 单次门控)
 *       - fail-after-fail:同上,共享 fail promise
 *       - commit-after-fail:await fail 完成后返合成 SKIPPED_RESULT(debitedCredits
 *         =null caller 不广播);**不**把 Promise<void> cast 成 Promise<Result>
 *       - fail-after-commit:await commit 完成 + swallow,no-op 不再 abort journal
 *   - commit 内部 settle 失败 → 自动 abortInflightJournal,然后 throw 给 caller log
 *   - 无论 commit 成功 / 失败 / fail → 在 finally 里 releasePreCheck(否则
 *     Redis 锁卡 300s,影响下一 turn)
 *   - codex slot 已由 G6 early-release 路径(userChatBridge 看 outbound.message
 *     isFinal / outbound.error)释放,这里不再 codexBinding.release
 *
 * **职责切割(Plan v3 与 Codex 审计确认)**:
 *   - finalizer.commit / fail = ledger debit + journal CAS + preCheck 释放
 *   - codex per-account slot 释放 ≠ finalizer 职责;由 bridge 三条独立路径负责:
 *       (1) outbound.message isFinal / outbound.error 的 G6 早释段
 *       (2) CODEX_SESSION_MAX_MS=600s 兜底 timer
 *       (3) bridge finalCleanup() 显式 codexBinding.release
 *     finalizer 不持 codexBinding 引用,二次重构也不应跨此界线。
 *
 * **同步幂等不变量(commit/fail 二次调用必须命中首次 promise)**:
 *   `if (_done !== null) return _done; const inflight = (async()=>{...})(); _done = inflight`
 *   三步全在单同步块内(无 await 在 _done 赋值之前),JS 单线程保证检查→创建→
 *   赋值原子。任何并发 commit×2 / commit+fail 都共享首次 promise,见单测。
 */

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { TokenUsage } from "./calculator.js";
import { computeCost } from "./calculator.js";
import type { ModelPricing } from "./pricing.js";
import type { BillingAuthorityStamp } from "./proxyBilling.js";
import {
  type PreCheckRedis,
  type ReservationHandle,
  releasePreCheck,
} from "./preCheck.js";
import {
  abortInflightJournal,
  finalizeInflightJournal,
  settleUsageAndLedger,
  type SettleResult,
} from "./proxyBilling.js";

/**
 * v5 计费口径(M1b):codex turn 的 usage_records.session_id 单一口径 ——
 * `'oceng-' + sha256(sessionKey).hex.slice(0,48)`(共 54 字符),满足
 * internalTurnWaive 的 SESSION_ID_RE(不放宽端点校验),settle 落库与 turn-waive
 * 上报必须用同一值,idle-timeout 退款窗口(refund.refundSessionWindow 按
 * usage_records.session_id 圈定)才能命中。**禁止各模块自行 hash** —— 本 helper
 * 是唯一权威;gateway M1a 经 billing 事件传来的 engineSessionId 也是本算法产物。
 */
export const ENGINE_SESSION_ID_RE = /^oceng-[0-9a-f]{48}$/;

export function deriveEngineSessionId(sessionKey: string): string {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    throw new TypeError("deriveEngineSessionId: sessionKey required");
  }
  return `oceng-${createHash("sha256").update(sessionKey, "utf8").digest("hex").slice(0, 48)}`;
}

export interface CodexFinalizeContext {
  pgPool: Pool;
  preCheckRedis: PreCheckRedis;
  /** 落账主体 — 与 anthropic 路径同一张 users 表。 */
  userId: bigint;
  /** server-owned per-turn id — settle 用 (user_id, request_id) UNIQUE 防重复。 */
  requestId: string;
  /**
   * v5(M1b):usage_records.session_id 落库值 — 必须是 `deriveEngineSessionId`
   * 产出的 `oceng-<48hex>` 形状(makeCodexFinalizer 构造期 fail-closed 校验)。
   * 旧 v3 形态用 containerId 字符串占位导致 turn-waive/退款窗口永远对不上,已废弃。
   */
  engineSessionId: string;
  /** effective model — 从 effectiveModelForFrame 取,可能是 gpt-5.5 / gpt-5.5-codex 等。 */
  model: string;
  /** 已 apply agent_cost_overrides multiplier 的 pricing 快照 — 与 preCheck 估
   *  maxCost 时用的同一份(P3-3 derivedPricing 一处定终)。 */
  derivedPricing: ModelPricing;
  /** preCheck 返回的 reservation handle — commit/fail 完都要 release。 */
  reservation: ReservationHandle;
  /** 模型权威开启时必传；写入 usage_records 四个留证列。 */
  authority?: BillingAuthorityStamp | null;
  // v5(M1b):不再携带 accountId —— codex 记账 usage_records.account_id 恒写
  // SQL NULL(0044 SET NULL FK 语义,与 deepseek/minimax 静态 provider 同型),
  // 不再用 v3 的 `accountId=0n` 假账号占位。
}

export interface CodexFinalizeResult {
  /** 真正 debit 进 ledger 的积分(分);0 / null 不广播 outbound.cost_charged。
   *  - status='success' + cost>0:debit 实际值(clamp 时 = balance < cost)
   *  - status='error' / cost=0 / 零输出免单 / 23505 重入:null */
  debitedCredits: bigint | null;
  /** debit 后**双钱包总可用**(period_credits 期内桶 + users.credits 持久钱包,
   *  0096 spendTwoBucket.totalAfter 口径,对齐前端余额气泡);cost=0 / 重入路径为 null。 */
  balanceAfter: bigint | null;
  /** 记 metric / log 用。 */
  costCredits: bigint;
  /** clamp 标记 — 余额 < cost 时 debit 被夹到 0。 */
  clamped: boolean;
}

export interface CodexFinalizeHandle {
  /**
   * 用 outbound.codex_billing 帧的 usage 落账。
   *
   * @param usage    snake_case TokenUsage(reasoning_output_tokens 已由 caller fold 进 output_tokens)
   * @param codexStatus  billing 帧报告的状态 — 仅落 snapshotJson 排障用,**不影响是否扣费**
   *                     (有正 token 就 charge — 与代理商成本模型对齐)
   * @param errorReason  仅 codexStatus='error' 时有意义,落 snapshotJson + journal 用
   */
  commit(
    usage: TokenUsage,
    codexStatus: "success" | "error",
    errorReason?: string,
  ): Promise<CodexFinalizeResult>;
  /**
   * 无 usage 的失败收尾(用户 ws 断开 / 容器 crash / runner spawn 失败等)。
   * journal inflight → aborted + releasePreCheck,**不**走 ledger debit。
   */
  fail(reason: string): Promise<void>;
}

export function makeCodexFinalizer(ctx: CodexFinalizeContext): CodexFinalizeHandle {
  // v5(M1b)fail-closed:session_id 口径错(旧 containerId 占位 / 各模块自行 hash)
  // 会让 turn-waive 退款窗口永远圈不到 codex 记录 —— 构造期直接拒,不让脏口径入库。
  if (!ENGINE_SESSION_ID_RE.test(ctx.engineSessionId)) {
    throw new TypeError(
      `makeCodexFinalizer: engineSessionId must match ${String(ENGINE_SESSION_ID_RE)} (use deriveEngineSessionId), got ${JSON.stringify(ctx.engineSessionId)}`,
    );
  }
  // _done 是 tagged union:首次调用是 commit 还是 fail 决定 kind,二次调用按 kind
  // 分支返回 — commit-after-commit 共享 promise(idempotent);fail-after-fail 同理;
  // commit-after-fail 返合成 skipped result(避免错误地 cast Promise<void> 成
  // Promise<CodexFinalizeResult> 后访问 .debitedCredits 拿 undefined 触 TypeError);
  // fail-after-commit 把 commit 的 promise await 完直接 swallow(commit 已扣过钱,
  // fail 不该再 abort journal — _done 命中即跳过)。
  type DoneState =
    | { kind: "commit"; promise: Promise<CodexFinalizeResult> }
    | { kind: "fail"; promise: Promise<void> };
  let _done: DoneState | null = null;
  // commit-after-fail 的合成"skipped" result:caller 看 debitedCredits===null 不广播。
  const SKIPPED_RESULT: CodexFinalizeResult = {
    debitedCredits: null,
    balanceAfter: null,
    costCredits: 0n,
    clamped: false,
  };

  function commitOnce(
    usage: TokenUsage,
    codexStatus: "success" | "error",
    errorReason?: string,
  ): Promise<CodexFinalizeResult> {
    return (async (): Promise<CodexFinalizeResult> => {
      const { cost_credits, snapshot } = computeCost(usage, ctx.derivedPricing);
      // settle 的 status 选择:
      //   - 有正 token (cost>0) → 'success' 走 ledger debit
      //   - 0-token success → 仍 'success'(usage_records 落 audit,但 cost=0 不 debit)
      //   - 0-token error → 'error'(usage_records.status='error',audit 痕)
      // 这样 codex 的 'success' 永远不被错标 'error','error' 也永远不被错扣钱。
      const settleStatus: "success" | "error" =
        cost_credits > 0n
          ? "success"
          : codexStatus === "success"
            ? "success"
            : "error";
      // v5 零输出免单(M1b,对齐 proxyBilling.makeFinalizer 的 waivedNoOutput 语义,
      // f3818040 boss 红线"零输出不得扣费"):success 且 output_tokens=0 但本有成本
      // (纯 input/cache 成本)→ 免单。usage_records 仍落 audit 痕(cost_credits=0 +
      // snapshot 记 waived/wouldHaveCharged),不 debit。anthropic 代理路径的同规则
      // 在 proxyBilling 层,codex 直连 settle 拿不到 → 必须在本层显式补,不得照搬 v3。
      const waivedNoOutput =
        settleStatus === "success" &&
        BigInt(usage.output_tokens ?? 0) === 0n &&
        cost_credits > 0n;
      const effectiveCredits = waivedNoOutput ? 0n : cost_credits;
      // snapshotJson 含完整 pricing snapshot + codex 状态(reconciler / admin 排障)。
      // **不**影响落账金额 — 那个是 effectiveCredits 决定。
      const snapshotJson = JSON.stringify({
        ...snapshot,
        codex_status: codexStatus,
        ...(errorReason !== undefined ? { codex_error_reason: errorReason } : {}),
        ...(waivedNoOutput
          ? { waived: "no_output", wouldHaveCharged: cost_credits.toString() }
          : {}),
      });
      let settled: SettleResult;
      try {
        settled = await settleUsageAndLedger(ctx.pgPool, {
          userId: ctx.userId,
          // v5:codex 记账不占用账号池 FK —— usage_records.account_id 恒 NULL
          // (0044 SET NULL 语义,同 deepseek 静态 provider 路径),不用假账号 0n。
          accountId: null,
          requestId: ctx.requestId,
          model: ctx.model,
          usage,
          snapshotJson,
          costCredits: effectiveCredits,
          status: settleStatus,
          sessionId: ctx.engineSessionId,
          authority: ctx.authority ?? null,
        });
        await finalizeInflightJournal(ctx.pgPool, {
          requestId: ctx.requestId,
          finalCredits: effectiveCredits,
          ledgerId: settled.ledgerId,
          usageId: settled.usageId,
        });
      } catch (err) {
        // settle 或 journal CAS 失败 → 自动 abort journal 兜底,reservation 在外层
        // finally 仍会 release。throw 给 caller 让它 log(billing 拦截块只 log 不
        // 双重 release)。
        await abortInflightJournal(
          ctx.pgPool,
          ctx.requestId,
          `codex_commit_failed: ${(err as Error).message}`.slice(0, 500),
        ).catch(() => {});
        throw err;
      }
      return {
        debitedCredits: settled.debitedCredits,
        // 双钱包总可用(settleUsageAndLedger → spendTwoBucket.totalAfter),非单桶。
        balanceAfter: settled.balanceAfter,
        costCredits: effectiveCredits,
        clamped: settled.clamped,
      };
    })();
  }

  async function failOnce(reason: string): Promise<void> {
    try {
      await abortInflightJournal(ctx.pgPool, ctx.requestId, reason.slice(0, 500));
    } catch {
      // journal abort 失败 — 数据库瞬断,reconciler 会扫到 stuck inflight 兜底。
      // 这里不 rethrow,让 cleanup 路径继续走完(Map 必须清空)。
    }
  }

  return {
    async commit(usage, codexStatus, errorReason) {
      if (_done !== null) {
        if (_done.kind === "commit") {
          // commit-after-commit:duplicate billing 帧场景 — 共享首次 promise,
          // ledger debit 不重复,广播逻辑由 caller 的 Map.delete 单次保证。
          return _done.promise;
        }
        // commit-after-fail:fail 已 abort journal + release reservation,本次
        // commit 不能再 settle(reservation 已没;继续会 throw)。await fail 完成
        // 后返合成 skipped 让 caller 走 "debitedCredits===null 不广播" 分支。
        await _done.promise.catch(() => {});
        return SKIPPED_RESULT;
      }
      const promise = (async (): Promise<CodexFinalizeResult> => {
        try {
          return await commitOnce(usage, codexStatus, errorReason);
        } finally {
          // 无论 commit 成 / 失败,都 release preCheck(否则 Redis 锁卡 300s)。
          await releasePreCheck(ctx.preCheckRedis, ctx.reservation).catch(
            () => {},
          );
        }
      })();
      _done = { kind: "commit", promise };
      return promise;
    },
    async fail(reason) {
      if (_done !== null) {
        // fail-after-anything:首次 promise 已起,await 让 caller 等到 settle/abort
        // 实际收尾再返(方便 cleanup 顺序确定)。错误吞掉(commit 失败的 throw 不
        // 是 fail 调用方该看到的)。
        await _done.promise.catch(() => {});
        return;
      }
      const promise = (async (): Promise<void> => {
        try {
          await failOnce(reason);
        } finally {
          await releasePreCheck(ctx.preCheckRedis, ctx.reservation).catch(
            () => {},
          );
        }
      })();
      _done = { kind: "fail", promise };
      return promise;
    },
  };
}
