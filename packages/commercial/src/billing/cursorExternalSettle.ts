/**
 * Cursor external-engine 观测帧 → 平台 settle。
 *
 * Cursor adapter 仍是 billingMode='external'（订阅 CLI 上报 usage），
 * 但 selfhost 要从 0221 官方价走 settleUsageAndLedger 扣积分。
 * 不做 Codex 式 preCheck/journal；不足则 spendTwoBucket clamp。
 * engine status='success' 按实扣费；用户主动 Stop（status='error' +
 * terminalCode=USER_CANCELLED）同样按引擎上报的真实 token 扣费（2026-09-03 起）；
 * 其余 error/unavailable 落 audit 痕、0 扣。
 * 零输出免单对齐 f3818040 / codexFinalizer。
 */
import type { Pool } from "pg";
import { computeCost, type TokenUsage } from "./calculator.js";
import type { ModelPricing, PricingCache } from "./pricing.js";
import { settleUsageAndLedger, type SettleResult } from "./proxyBilling.js";

export type CursorEngineStatus = "success" | "error" | "unavailable";

function asTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function mapCursorReportedUsage(usage: unknown): TokenUsage {
  const rec = usage !== null && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  return {
    input_tokens: asTokens(rec.input_tokens),
    output_tokens: asTokens(rec.output_tokens),
    cache_read_tokens: asTokens(rec.cache_read_input_tokens ?? rec.cache_read_tokens),
    cache_write_tokens: asTokens(rec.cache_creation_input_tokens ?? rec.cache_write_tokens),
  };
}

/** Stable snapshot marker for historical pending audits settled by the
 * durable reconciler after the fact: record usage/credits for the ledger and
 * UI but never debit (operator decision 2026-09-02). */
export const CURSOR_HISTORICAL_BACKFILL_WAIVER = "historical_backfill_no_charge" as const;

export function planCursorExternalSettle(args: {
  engineStatus: CursorEngineStatus;
  usage: TokenUsage;
  pricing: ModelPricing;
  terminalCode?: string | null;
  /** Record the would-have-charged amount but settle at 0 credits. */
  zeroCharge?: boolean;
}): {
  settleStatus: "success" | "error";
  costCredits: bigint;
  snapshotJson: string;
} {
  const { cost_credits, snapshot } = computeCost(args.usage, args.pricing);
  const engineOk = args.engineStatus === "success";
  // A user-initiated Stop is not an engine failure: the tokens the engine
  // reported were really consumed upstream before the abort landed, so the
  // turn settles at its actual cost (operator decision 2026-09-03). Only the
  // adapter's `error` status qualifies; `unavailable` (auth/quota) still
  // means the upstream call never went through.
  const userCancelled =
    args.engineStatus === "error" && args.terminalCode === "USER_CANCELLED";
  const chargeable = engineOk || userCancelled;
  const waivedNoOutput =
    chargeable && BigInt(args.usage.output_tokens ?? 0) === 0n && cost_credits > 0n;
  const wouldCharge = chargeable && !waivedNoOutput ? cost_credits : 0n;
  const zeroCharged = args.zeroCharge === true && wouldCharge > 0n;
  const costCredits = zeroCharged ? 0n : wouldCharge;
  const settleStatus: "success" | "error" = chargeable ? "success" : "error";
  const snapshotJson = JSON.stringify({
    ...snapshot,
    cursor_status: args.engineStatus,
    ...(args.terminalCode ? { cursor_terminal_code: args.terminalCode } : {}),
    ...(userCancelled ? { charged_on_user_cancel: true } : {}),
    ...(waivedNoOutput
      ? { waived: "no_output", wouldHaveCharged: cost_credits.toString() }
      : {}),
    ...(!chargeable && cost_credits > 0n
      ? { waived: "cursor_engine_not_success", wouldHaveCharged: cost_credits.toString() }
      : {}),
    ...(zeroCharged
      ? { waived: CURSOR_HISTORICAL_BACKFILL_WAIVER, wouldHaveCharged: wouldCharge.toString() }
      : {}),
  });
  return { settleStatus, costCredits, snapshotJson };
}

async function bumpCursorAccountUsageCounts(
  pool: Pool,
  accountId: bigint,
  success: boolean,
): Promise<void> {
  // Stats-only. Do NOT call health.onSuccess/onFailure: those mutate
  // health_score / last_error / status / cooldown and can drop a key from
  // the cursor materializer whitelist.
  await pool.query(
    success
      ? `UPDATE claude_accounts
            SET success_count = success_count + 1,
                last_used_at = NOW(),
                updated_at = NOW()
          WHERE id = $1 AND provider = 'cursor'`
      : `UPDATE claude_accounts
            SET fail_count = fail_count + 1,
                last_used_at = NOW(),
                updated_at = NOW()
          WHERE id = $1 AND provider = 'cursor'`,
    [accountId.toString()],
  );
}

export async function settleCursorExternalUsage(args: {
  pool: Pool;
  pricing: PricingCache;
  userId: bigint;
  requestId: string;
  modelId: string;
  sessionId: string | null;
  engineStatus: CursorEngineStatus;
  terminalCode?: string | null;
  usage: unknown;
  /** Eligible cursor pool row actually used this turn; null if unknown. */
  accountId?: bigint | null;
  /** Exact logical-turn locators (durable tape path). When present the cost
   * is staged into the pending usage patch table inside the same transaction so the
   * tape finalize / appendCostCredits fold it into turn_tape_cost_components. */
  turnKey?: string | null;
  parentTurnKey?: string | null;
  parentSessionId?: string | null;
  delegateAgentId?: string | null;
  dispatchId?: string | null;
  attemptNo?: number | null;
  /** Historical backfill: usage row + 0-credit ledger truth, no debit. */
  zeroCharge?: boolean;
}): Promise<SettleResult | null> {
  const pricing = args.pricing.get(args.modelId);
  if (pricing === null) return null;
  const usage = mapCursorReportedUsage(args.usage);
  const plan = planCursorExternalSettle({
    engineStatus: args.engineStatus,
    usage,
    pricing,
    terminalCode: args.terminalCode ?? null,
    zeroCharge: args.zeroCharge === true,
  });
  const accountId = args.accountId ?? null;
  const settled = await settleUsageAndLedger(args.pool, {
    userId: args.userId,
    accountId,
    requestId: args.requestId,
    model: args.modelId,
    usage,
    snapshotJson: plan.snapshotJson,
    costCredits: plan.costCredits,
    status: plan.settleStatus,
    sessionId: args.sessionId,
    mode: args.parentTurnKey || args.parentSessionId || args.delegateAgentId ? "delegate" : "chat",
    parentSessionId: args.parentSessionId ?? null,
    delegateAgentId: args.delegateAgentId ?? null,
    turnKey: args.turnKey ?? null,
    parentTurnKey: args.parentTurnKey ?? null,
    dispatchId: args.dispatchId ?? null,
    attemptNo: args.attemptNo ?? null,
  });
  if (accountId !== null) {
    try {
      await bumpCursorAccountUsageCounts(args.pool, accountId, plan.settleStatus === "success");
    } catch {
      // usage_records.account_id already committed; counts are best-effort.
    }
  }
  return settled;
}
