/**
 * Antigravity turn settlement (OCV5-415 P2).
 *
 * Usage is server-observed: the relay writes one antigravity_relay_usage row
 * per forwarded generate call (title generation included) from the upstream
 * usageMetadata. The container's own report is never billed: the CLI omits
 * the title call and its usage is cumulative across a resumed conversation.
 * Every call is priced at the turn's catalog model.
 */
import type { Pool } from "pg";
import { computeCost, type TokenUsage } from "./calculator.js";
import type { ModelPricing, PricingCache } from "./pricing.js";
import { settleUsageAndLedger, type SettleResult } from "./proxyBilling.js";

export type AntigravityEngineStatus = "success" | "error" | "unavailable";

export interface AntigravityUsageTotals {
  promptTokens: bigint;
  candidatesTokens: bigint;
  thoughtsTokens: bigint;
  cachedTokens: bigint;
  calls: number;
}

export const EMPTY_ANTIGRAVITY_USAGE: AntigravityUsageTotals = Object.freeze({
  promptTokens: 0n,
  candidatesTokens: 0n,
  thoughtsTokens: 0n,
  cachedTokens: 0n,
  calls: 0,
});

/**
 * Gemini usageMetadata → platform tokens. promptTokenCount includes the
 * cached part; thoughts are billed as output (as the upstream does).
 */
export function mapAntigravityUsage(totals: AntigravityUsageTotals): TokenUsage {
  const cached = totals.cachedTokens < totals.promptTokens ? totals.cachedTokens : totals.promptTokens;
  return {
    input_tokens: totals.promptTokens - cached,
    output_tokens: totals.candidatesTokens + totals.thoughtsTokens,
    cache_read_tokens: cached,
    cache_write_tokens: 0n,
  };
}

export async function sumAntigravityRelayUsage(
  pool: Pick<Pool, "query">,
  requestId: string,
  userId: bigint,
): Promise<AntigravityUsageTotals> {
  const res = await pool.query<{
    prompt: string | null; candidates: string | null; thoughts: string | null; cached: string | null; calls: string;
  }>(
    `SELECT SUM(prompt_tokens)::text AS prompt, SUM(candidates_tokens)::text AS candidates,
            SUM(thoughts_tokens)::text AS thoughts, SUM(cached_tokens)::text AS cached,
            COUNT(*)::text AS calls
       FROM antigravity_relay_usage WHERE request_id = $1 AND user_id = $2`,
    [requestId, userId.toString()],
  );
  const row = res.rows[0];
  if (!row) return { ...EMPTY_ANTIGRAVITY_USAGE };
  return {
    promptTokens: BigInt(row.prompt ?? "0"),
    candidatesTokens: BigInt(row.candidates ?? "0"),
    thoughtsTokens: BigInt(row.thoughts ?? "0"),
    cachedTokens: BigInt(row.cached ?? "0"),
    calls: Number(row.calls),
  };
}

export function antigravityUsageCost(totals: AntigravityUsageTotals, pricing: ModelPricing): bigint {
  return computeCost(mapAntigravityUsage(totals), pricing).cost_credits;
}

export function planAntigravitySettle(args: {
  engineStatus: AntigravityEngineStatus;
  totals: AntigravityUsageTotals;
  pricing: ModelPricing;
  terminalCode?: string | null;
}): { settleStatus: "success" | "error"; costCredits: bigint; snapshotJson: string; usage: TokenUsage } {
  const usage = mapAntigravityUsage(args.totals);
  const { cost_credits, snapshot } = computeCost(usage, args.pricing);
  const engineOk = args.engineStatus === "success";
  const waivedNoOutput = engineOk && BigInt(usage.output_tokens) === 0n && cost_credits > 0n;
  const costCredits = engineOk && !waivedNoOutput ? cost_credits : 0n;
  const snapshotJson = JSON.stringify({
    ...snapshot,
    antigravity_status: args.engineStatus,
    antigravity_calls: args.totals.calls,
    ...(args.terminalCode ? { antigravity_terminal_code: args.terminalCode } : {}),
    ...(waivedNoOutput ? { waived: "no_output", wouldHaveCharged: cost_credits.toString() } : {}),
    ...(!engineOk && cost_credits > 0n
      ? { waived: "antigravity_engine_not_success", wouldHaveCharged: cost_credits.toString() }
      : {}),
  });
  return { settleStatus: engineOk ? "success" : "error", costCredits, snapshotJson, usage };
}

export async function settleAntigravityTurn(args: {
  pool: Pool;
  pricing: PricingCache;
  userId: bigint;
  requestId: string;
  modelId: string;
  sessionId: string | null;
  engineStatus: AntigravityEngineStatus;
  terminalCode?: string | null;
}): Promise<SettleResult | null> {
  const pricing = args.pricing.get(args.modelId);
  if (pricing === null) return null;
  const totals = await sumAntigravityRelayUsage(args.pool, args.requestId, args.userId);
  const plan = planAntigravitySettle({
    engineStatus: args.engineStatus,
    totals,
    pricing,
    terminalCode: args.terminalCode ?? null,
  });
  return settleUsageAndLedger(args.pool, {
    userId: args.userId,
    accountId: null,
    requestId: args.requestId,
    model: args.modelId,
    usage: plan.usage,
    snapshotJson: plan.snapshotJson,
    costCredits: plan.costCredits,
    status: plan.settleStatus,
    sessionId: args.sessionId,
  });
}
