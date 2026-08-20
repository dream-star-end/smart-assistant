/**
 * ZCode canonical (glm-5.3-zai) usage → catalog-price settle.
 * Does not reuse Cursor membership/pool. Canary zcode-experimental stays audit-only.
 */
import type { Pool } from "pg";
import { computeCost, type TokenUsage } from "./calculator.js";
import type { ModelPricing, PricingCache } from "./pricing.js";
import { settleUsageAndLedger, type SettleResult } from "./proxyBilling.js";

export type ZcodeEngineStatus = "success" | "error" | "unavailable";

export interface ZcodeCostChargedEvent {
  type: "outbound.cost_charged";
  requestId: string;
  model: string;
  sessionId: string | null;
  costCredits: string;
  balanceAfter?: string;
  traceId?: string;
}

function asTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function mapZcodeReportedUsage(usage: unknown): TokenUsage {
  const rec = usage !== null && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
  return {
    input_tokens: asTokens(rec.input_tokens ?? rec.inputTokens),
    output_tokens: asTokens(rec.output_tokens ?? rec.outputTokens),
    cache_read_tokens: asTokens(
      rec.cache_read_input_tokens ?? rec.cache_read_tokens ?? rec.cacheReadTokens,
    ),
    cache_write_tokens: asTokens(
      rec.cache_creation_input_tokens ?? rec.cache_write_tokens ?? rec.cacheWriteTokens,
    ),
  };
}

export function planZcodeCatalogSettle(args: {
  engineStatus: ZcodeEngineStatus;
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
    zcode_status: args.engineStatus,
    ...(args.terminalCode ? { zcode_terminal_code: args.terminalCode } : {}),
    ...(waivedNoOutput
      ? { waived: "no_output", wouldHaveCharged: cost_credits.toString() }
      : {}),
    ...(!engineOk && cost_credits > 0n
      ? { waived: "zcode_engine_not_success", wouldHaveCharged: cost_credits.toString() }
      : {}),
  });
  return { settleStatus, costCredits, snapshotJson };
}

export async function publishZcodeCatalogSettle(args: {
  settled: SettleResult;
  requestId: string;
  userId: string;
  modelId: string;
  sessionId: string | null;
  traceId: string | null;
  persist?: (
    requestId: string,
    userId: string,
    costCredits: string,
    sessionId?: string | null,
  ) => Promise<unknown>;
  publish: (event: ZcodeCostChargedEvent) => void;
  onPersistError?: (error: unknown) => void;
}): Promise<void> {
  const persistCredits = args.settled.attributionCredits !== null
    ? args.settled.attributionCredits
    : args.settled.debitedCredits !== null && args.settled.debitedCredits > 0n
      ? args.settled.debitedCredits
      : null;
  if (persistCredits !== null && args.persist) {
    try {
      await args.persist(
        args.requestId,
        args.userId,
        persistCredits.toString(),
        args.sessionId,
      );
    } catch (error) {
      args.onPersistError?.(error);
    }
  }
  if (args.settled.debitedCredits === null || args.settled.debitedCredits <= 0n) return;
  args.publish({
    type: "outbound.cost_charged",
    requestId: args.requestId,
    model: args.modelId,
    sessionId: args.sessionId,
    costCredits: args.settled.debitedCredits.toString(),
    ...(args.settled.balanceAfter !== null
      ? { balanceAfter: args.settled.balanceAfter.toString() }
      : {}),
    ...(args.traceId ? { traceId: args.traceId } : {}),
  });
}

export async function settleZcodeCatalogUsage(args: {
  pool: Pool;
  pricing: PricingCache;
  userId: bigint;
  requestId: string;
  modelId: string;
  sessionId: string | null;
  engineStatus: ZcodeEngineStatus;
  terminalCode?: string | null;
  usage: unknown;
}): Promise<SettleResult | null> {
  if (args.modelId !== "glm-5.3-zai") return null;
  const pricing = args.pricing.get(args.modelId);
  if (pricing === null) return null;
  const usage = mapZcodeReportedUsage(args.usage);
  const plan = planZcodeCatalogSettle({
    engineStatus: args.engineStatus,
    usage,
    pricing,
    terminalCode: args.terminalCode ?? null,
  });
  return settleUsageAndLedger(args.pool, {
    userId: args.userId,
    accountId: null,
    requestId: args.requestId,
    model: args.modelId,
    usage,
    snapshotJson: plan.snapshotJson,
    costCredits: plan.costCredits,
    status: plan.settleStatus,
    sessionId: args.sessionId,
  });
}
