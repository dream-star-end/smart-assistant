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
import { composeMultiplier } from "@openclaude/protocol";
import { computeCost, type TokenUsage } from "./calculator.js";
import type { ModelPricing, PricingCache } from "./pricing.js";
import { settleUsageAndLedger, type SettleResult } from "./proxyBilling.js";

export type CursorEngineStatus = "success" | "error" | "unavailable";

/**
 * Settle-time surcharge for Cursor Sand Opus/Fable families (operator decision
 * 2026-09-03; commercial reverted 1.5→2.0 on 2026-09-05): the credits actually
 * debited are 2x the catalog price, but the
 * public catalog (`model_pricing.multiplier`, cost_x badge, per_ktok_credits)
 * is left untouched so nothing user-facing advertises the markup. Composed on
 * top of the row multiplier (so `-fast` siblings keep their own 2x) and
 * recorded in price_snapshot as `cursor_settle_multiplier` for reconciliation.
 *
 * `COMMERCIAL_CURSOR_SETTLE_SURCHARGE_MULTIPLIER` overrides the default per
 * deployment. selfhost sets `1.000` (0269: catalog fen are fitted to Cursor's
 * real USD spend at 150 credits/USD, so the catalog price *is* the debited
 * price and the snapshot carries no `cursor_settle_multiplier`). Anything
 * that is not a finite positive NUMERIC(6,3) falls back to the default.
 */
export const CURSOR_SETTLE_SURCHARGE_FAMILIES: ReadonlyArray<string> = ["cursor-opus-", "cursor-fable-"];
export const CURSOR_SETTLE_SURCHARGE_MULTIPLIER = "2.000";
export const CURSOR_SETTLE_SURCHARGE_ENV = "COMMERCIAL_CURSOR_SETTLE_SURCHARGE_MULTIPLIER";

/** Parse the env override into a canonical "d.ddd" string; null = use default. */
export function parseCursorSettleSurcharge(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n.toFixed(3);
}

export function cursorSettleMultiplier(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!CURSOR_SETTLE_SURCHARGE_FAMILIES.some((prefix) => modelId.startsWith(prefix))) return null;
  const surcharge = parseCursorSettleSurcharge(env[CURSOR_SETTLE_SURCHARGE_ENV]) ?? CURSOR_SETTLE_SURCHARGE_MULTIPLIER;
  // 1.000 = no surcharge: behave exactly like a non-surcharged family so the
  // snapshot does not advertise a phantom `cursor_settle_multiplier`.
  return surcharge === "1.000" ? null : surcharge;
}

/** Frozen pricing fields captured before the model call. Rates are decimal
 * strings so the intent file never contains bigint. `settleSurcharge` is the
 * effective surcharge at capture (`null` = none), not a second catalog multiply. */
export interface CursorPricingBasis {
  modelId: string;
  displayName: string;
  inputPerMtok: string;
  outputPerMtok: string;
  cacheReadPerMtok: string;
  cacheWritePerMtok: string;
  catalogMultiplier: string;
  settleSurcharge: string | null;
  capturedAt: string;
}

/** Once-generated plan stored on the ready record. Recovery must not re-read
 * catalog/env; `costCredits` is a decimal string (JSON cannot hold bigint). */
export interface PreparedCursorSettlePlan {
  settleStatus: "success" | "error";
  costCredits: string;
  snapshotJson: string;
}

export function captureCursorPricingBasis(
  pricing: ModelPricing,
  env: NodeJS.ProcessEnv = process.env,
  capturedAt: Date = new Date(),
): CursorPricingBasis {
  return {
    modelId: pricing.model_id,
    displayName: pricing.display_name,
    inputPerMtok: pricing.input_per_mtok.toString(),
    outputPerMtok: pricing.output_per_mtok.toString(),
    cacheReadPerMtok: pricing.cache_read_per_mtok.toString(),
    cacheWritePerMtok: pricing.cache_write_per_mtok.toString(),
    catalogMultiplier: pricing.multiplier,
    settleSurcharge: cursorSettleMultiplier(pricing.model_id, env),
    capturedAt: capturedAt.toISOString(),
  };
}

export function modelPricingFromBasis(basis: CursorPricingBasis): ModelPricing {
  return {
    model_id: basis.modelId,
    display_name: basis.displayName,
    input_per_mtok: BigInt(basis.inputPerMtok),
    output_per_mtok: BigInt(basis.outputPerMtok),
    cache_read_per_mtok: BigInt(basis.cacheReadPerMtok),
    cache_write_per_mtok: BigInt(basis.cacheWritePerMtok),
    multiplier: basis.catalogMultiplier,
    enabled: true,
    sort_order: 0,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(basis.capturedAt),
  };
}

function applyCursorSettleMultiplier(
  pricing: ModelPricing,
  capturedSurcharge?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { pricing: ModelPricing; surcharge: string | null } {
  const surcharge =
    capturedSurcharge !== undefined ? capturedSurcharge : cursorSettleMultiplier(pricing.model_id, env);
  if (surcharge === null) return { pricing, surcharge: null };
  return {
    pricing: { ...pricing, multiplier: composeMultiplier(pricing.multiplier, surcharge) },
    surcharge,
  };
}

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

export function freezePreparedCursorSettlePlan(plan: {
  settleStatus: "success" | "error";
  costCredits: bigint;
  snapshotJson: string;
}): PreparedCursorSettlePlan {
  return {
    settleStatus: plan.settleStatus,
    costCredits: plan.costCredits.toString(),
    snapshotJson: plan.snapshotJson,
  };
}

export function planCursorExternalSettle(args: {
  engineStatus: CursorEngineStatus;
  usage: TokenUsage;
  /** Live catalog row. Ignored when `pricingBasis` is provided. */
  pricing?: ModelPricing;
  /** Execution-time rates/surcharge; recovery must pass this instead of re-reading catalog/env. */
  pricingBasis?: CursorPricingBasis | null;
  terminalCode?: string | null;
  /** Record the would-have-charged amount but settle at 0 credits. */
  zeroCharge?: boolean;
}): {
  settleStatus: "success" | "error";
  costCredits: bigint;
  snapshotJson: string;
} {
  const catalogPricing = args.pricingBasis
    ? modelPricingFromBasis(args.pricingBasis)
    : args.pricing;
  if (!catalogPricing) {
    throw new TypeError("planCursorExternalSettle requires pricing or pricingBasis");
  }
  const { pricing: effectivePricing, surcharge } = applyCursorSettleMultiplier(
    catalogPricing,
    args.pricingBasis ? args.pricingBasis.settleSurcharge : undefined,
  );
  const { cost_credits, snapshot } = computeCost(args.usage, effectivePricing);
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
    ...(surcharge !== null
      ? { cursor_settle_multiplier: surcharge, catalog_multiplier: catalogPricing.multiplier }
      : {}),
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

/**
 * What a settled Cursor turn writes back onto its account row.
 *
 * Stats + visibility only. Deliberately NOT routed through
 * AccountHealthTracker: health_score / status / cooldown_until feed the
 * cursorMaterializer whitelist (`eligibleCursorRows`), and a burst of Sand
 * 504s or a service_restart SIGKILL must not un-materialize a key for every
 * user (the 2026-09-04 "sessions scattered across accounts" incident was
 * exactly a false slot-fail cascade). The container-side wrapper keeps its
 * own 600s rotation cooldown for that.
 *
 * What *was* missing is any admin-visible trace: a Cursor account could fail
 * 200 turns in a row and the accounts table showed nothing but a counter.
 * `last_error` now carries the last terminal code (`cursor_<code>`) so the
 * "最近出错" chip lights up like it does for CCB/Grok rows, and a success
 * clears it — same contract as `health.onSuccess`, minus the health mutation.
 */
export function planCursorAccountUsageBump(args: {
  success: boolean;
  terminalCode?: string | null;
}): { sql: string; lastError: string | null } {
  if (args.success) {
    return {
      sql: `UPDATE claude_accounts
               SET success_count = success_count + 1,
                   last_used_at = NOW(),
                   last_error = NULL,
                   updated_at = NOW()
             WHERE id = $1 AND provider = 'cursor'`,
      lastError: null,
    };
  }
  const code = (args.terminalCode ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return {
    sql: `UPDATE claude_accounts
             SET fail_count = fail_count + 1,
                 last_used_at = NOW(),
                 last_error = $2,
                 updated_at = NOW()
           WHERE id = $1 AND provider = 'cursor'`,
    lastError: `cursor_${code || "engine_error"}`,
  };
}

async function bumpCursorAccountUsageCounts(
  pool: Pool,
  accountId: bigint,
  success: boolean,
  terminalCode: string | null,
): Promise<void> {
  const plan = planCursorAccountUsageBump({ success, terminalCode });
  await pool.query(
    plan.sql,
    plan.lastError === null ? [accountId.toString()] : [accountId.toString(), plan.lastError],
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
  /** 0277: external API key attribution (usage_records.api_key_id + spent_credits). */
  apiKeyId?: bigint | null;
  /** Execution-time pricing snapshot. When set, catalog/env are not re-read. */
  pricingBasis?: CursorPricingBasis | null;
  /** Sealed plan from the ready record. Skips planner/catalog/env entirely. */
  preparedPlan?: PreparedCursorSettlePlan | null;
}): Promise<SettleResult | null> {
  const usage = mapCursorReportedUsage(args.usage);
  let plan: { settleStatus: "success" | "error"; costCredits: bigint; snapshotJson: string };
  if (args.preparedPlan) {
    plan = {
      settleStatus: args.preparedPlan.settleStatus,
      costCredits: BigInt(args.preparedPlan.costCredits),
      snapshotJson: args.preparedPlan.snapshotJson,
    };
  } else {
    const pricing = args.pricingBasis
      ? modelPricingFromBasis(args.pricingBasis)
      : args.pricing.get(args.modelId);
    if (pricing === null) return null;
    plan = planCursorExternalSettle({
      engineStatus: args.engineStatus,
      usage,
      pricing,
      pricingBasis: args.pricingBasis ?? null,
      terminalCode: args.terminalCode ?? null,
      zeroCharge: args.zeroCharge === true,
    });
  }
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
    apiKeyId: args.apiKeyId ?? null,
  });
  const shouldBump =
    accountId !== null
    && (args.preparedPlan ? settled.commitDisposition === "new_commit" : true);
  if (shouldBump) {
    try {
      await bumpCursorAccountUsageCounts(
        args.pool,
        accountId,
        plan.settleStatus === "success",
        args.terminalCode ?? null,
      );
    } catch {
      // usage_records.account_id already committed; counts are best-effort.
    }
  }
  return settled;
}
