/**
 * Cursor external-engine 观测帧 → 平台 settle。
 *
 * Cursor adapter 仍是 billingMode='external'（订阅 CLI 上报 usage），
 * 但 selfhost 要从 0221 官方价走 settleUsageAndLedger 扣积分。
 * 不做 Codex 式 preCheck/journal；不足则 spendTwoBucket clamp。
 * 只对 engine status='success' 扣费；error/unavailable 落 audit 痕、0 扣。
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

export function planCursorExternalSettle(args: {
  engineStatus: CursorEngineStatus;
  usage: TokenUsage;
  pricing: ModelPricing;
  terminalCode?: string | null;
}): {
  settleStatus: "success" | "error";
  costCredits: bigint;
  snapshotJson: string;
} {
  const { cost_credits, snapshot } = computeCost(args.usage, args.pricing);
  const engineOk = args.engineStatus === "success";
  const waivedNoOutput =
    engineOk && BigInt(args.usage.output_tokens ?? 0) === 0n && cost_credits > 0n;
  const costCredits = engineOk && !waivedNoOutput ? cost_credits : 0n;
  const settleStatus: "success" | "error" = engineOk ? "success" : "error";
  const snapshotJson = JSON.stringify({
    ...snapshot,
    cursor_status: args.engineStatus,
    ...(args.terminalCode ? { cursor_terminal_code: args.terminalCode } : {}),
    ...(waivedNoOutput
      ? { waived: "no_output", wouldHaveCharged: cost_credits.toString() }
      : {}),
    ...(!engineOk && cost_credits > 0n
      ? { waived: "cursor_engine_not_success", wouldHaveCharged: cost_credits.toString() }
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
}): Promise<SettleResult | null> {
  const pricing = args.pricing.get(args.modelId);
  if (pricing === null) return null;
  const usage = mapCursorReportedUsage(args.usage);
  const plan = planCursorExternalSettle({
    engineStatus: args.engineStatus,
    usage,
    pricing,
    terminalCode: args.terminalCode ?? null,
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
