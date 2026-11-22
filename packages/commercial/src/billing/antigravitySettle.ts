import { ANTIGRAVITY_AUX_UPSTREAM_MODELS } from '@openclaude/protocol'
import { antigravityOwnerProtectedSql } from './antigravityRouteAuthority.js'
/**
 * Antigravity turn settlement (OCV5-415 P2).
 *
 * Usage is server-observed: the relay writes one antigravity_relay_usage row
 * per forwarded generate call (title generation, web_search, agent_monitoring
 * included) from the upstream usageMetadata. The container's own report is
 * never billed: the CLI omits auxiliary calls and its usage is cumulative
 * across a resumed conversation.
 *
 * Per-bucket attribution (strictly keyed on server-routed upstream_model,
 * never on untrusted client-declared request_type):
 *   - Primary calls (route model, plus legacy rows missing upstream_model):
 *     billed at the turn's catalog model pricing.
 *   - Auxiliary calls (ANTIGRAVITY_AUX_UPSTREAM_MODELS such as
 *     gemini-3.5-flash-lite, regardless of request_type): billed at the aux
 *     light-model rate (catalog row if present, else commercial-aligned
 *     flash-lite fallback, capped at primary pricing), combined with primary
 *     under a single ceiling. Client request_type='agent_monitoring' is
 *     recorded only as an observational count (`monitoring_calls`) in
 *     price_snapshot.antigravity_aux and never waives charges or budget.
 */
import type { Pool } from 'pg'
import { COST_SCALE, type TokenUsage, computeCost, multiplierToScaled } from './calculator.js'
import type { ModelPricing, PricingCache } from './pricing.js'
import { type SettleResult, settleUsageAndLedger } from './proxyBilling.js'
import { releaseInflight } from '../account-pool/policy/affinity.js'

export type AntigravityEngineStatus = 'success' | 'error' | 'unavailable'

/**
 * CLI-internal safety monitor requestType observed on aux flash-lite calls.
 * Used strictly for observational counters (`monitoring_calls`), never for
 * billing waivers or budget exemptions (client-supplied header/body metadata
 * is untrusted).
 */
export const ANTIGRAVITY_MONITORING_REQUEST_TYPE = 'agent_monitoring' as const

/**
 * Fallback commercial-aligned light-model rates for Antigravity auxiliary models
 * (gemini-3.5-flash-lite: ~$0.10/MTok input, ~$0.40/MTok output, ~$0.01/MTok cache read →
 * 20 / 80 / 1 / 0 fen/MTok at commercial 200 fen/USD input/output and 100 fen/USD cache read).
 * Used when model_pricing has no explicit row for the aux model. Each dimension is capped
 * at the route's primary pricing so an aux call can never exceed the primary model's rate.
 */
export const ANTIGRAVITY_AUX_FALLBACK_RATES = Object.freeze({
  model_id: 'antigravity-aux-flash-lite',
  display_name: 'Gemini Flash Lite (Antigravity Aux)',
  input_per_mtok: 20n,
  output_per_mtok: 80n,
  cache_read_per_mtok: 1n,
  cache_write_per_mtok: 0n,
})

const ANTIGRAVITY_AUX_PRICING_KEYS = [
  'antigravity-gemini-3.5-flash-lite',
  'gemini-3.5-flash-lite',
] as const

export interface AntigravityAuxPricing {
  model_id: string
  display_name: string
  input_per_mtok: bigint
  output_per_mtok: bigint
  cache_read_per_mtok: bigint
  cache_write_per_mtok: bigint
  multiplier: string
  source: 'catalog' | 'fallback'
}

export interface AntigravityUsageBucket {
  promptTokens: bigint
  candidatesTokens: bigint
  thoughtsTokens: bigint
  cachedTokens: bigint
  calls: number
  /** Observational subset of aux calls labeled request_type='agent_monitoring' (no billing effect). */
  monitoringCalls?: number
}

export interface AntigravityUsageTotals {
  /** Primary (route model) tokens — and legacy rows lacking upstream_model. */
  promptTokens: bigint
  candidatesTokens: bigint
  thoughtsTokens: bigint
  cachedTokens: bigint
  /** Total relay calls across all buckets (primary + aux). */
  calls: number
  /** Server-observed HTTP 200 retirement banner, persisted as relay status 410. */
  retired?: boolean
  /** Auxiliary-model calls (ANTIGRAVITY_AUX_UPSTREAM_MODELS, billed at light-model rate). */
  aux?: AntigravityUsageBucket
}

export const EMPTY_ANTIGRAVITY_USAGE: AntigravityUsageTotals = Object.freeze({
  promptTokens: 0n,
  candidatesTokens: 0n,
  thoughtsTokens: 0n,
  cachedTokens: 0n,
  calls: 0,
})

/** True when upstreamModel is one of the CLI's auxiliary light models (e.g. gemini-3.5-flash-lite). */
export function isAntigravityAuxUpstreamModel(upstreamModel: string | null | undefined): boolean {
  return (
    typeof upstreamModel === 'string' &&
    upstreamModel.length > 0 &&
    (ANTIGRAVITY_AUX_UPSTREAM_MODELS as readonly string[]).includes(upstreamModel)
  )
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

export function resolveAntigravityAuxPricing(
  primaryPricing: ModelPricing,
  pricingLookup?: Pick<PricingCache, 'get'> | null,
): AntigravityAuxPricing {
  let catalogMatch: ModelPricing | null = null
  if (pricingLookup) {
    for (const key of ANTIGRAVITY_AUX_PRICING_KEYS) {
      const found = pricingLookup.get(key)
      // Require exact model_id match so wildcard stubs or alias fallbacks
      // never misidentify the primary model's row as aux pricing.
      if (found !== null && found.model_id === key) {
        catalogMatch = found
        break
      }
    }
  }
  const base = catalogMatch ?? ANTIGRAVITY_AUX_FALLBACK_RATES
  return {
    model_id: base.model_id,
    display_name: base.display_name,
    input_per_mtok: minBigInt(base.input_per_mtok, primaryPricing.input_per_mtok),
    output_per_mtok: minBigInt(base.output_per_mtok, primaryPricing.output_per_mtok),
    cache_read_per_mtok: minBigInt(base.cache_read_per_mtok, primaryPricing.cache_read_per_mtok),
    cache_write_per_mtok: minBigInt(base.cache_write_per_mtok, primaryPricing.cache_write_per_mtok),
    multiplier: primaryPricing.multiplier,
    source: catalogMatch ? 'catalog' : 'fallback',
  }
}

/**
 * Gemini usageMetadata → platform tokens. promptTokenCount includes the
 * cached part; thoughts are billed as output (as the upstream does).
 */
export function mapAntigravityUsage(
  totals: Pick<
    AntigravityUsageBucket,
    'promptTokens' | 'candidatesTokens' | 'thoughtsTokens' | 'cachedTokens'
  >,
): TokenUsage {
  const cached =
    totals.cachedTokens < totals.promptTokens ? totals.cachedTokens : totals.promptTokens
  return {
    input_tokens: totals.promptTokens - cached,
    output_tokens: totals.candidatesTokens + totals.thoughtsTokens,
    cache_read_tokens: cached,
    cache_write_tokens: 0n,
  }
}

export async function sumAntigravityRelayUsage(
  pool: Pick<Pool, 'query'>,
  requestId: string,
  userId: bigint,
): Promise<AntigravityUsageTotals> {
  const res = await pool.query<{
    bucket?: string | null
    prompt: string | null
    candidates: string | null
    thoughts: string | null
    cached: string | null
    calls: string
    monitoring_calls?: string | null
    retired: boolean | null
  }>(
    `SELECT CASE
              WHEN COALESCE(upstream_model, '') = ANY($3::text[]) THEN 'aux'
              ELSE 'primary'
            END AS bucket,
            SUM(prompt_tokens)::text AS prompt, SUM(candidates_tokens)::text AS candidates,
            SUM(thoughts_tokens)::text AS thoughts, SUM(cached_tokens)::text AS cached,
            COUNT(*)::text AS calls,
            COUNT(*) FILTER (WHERE COALESCE(request_type, '') = $4)::text AS monitoring_calls,
            BOOL_OR(status_code = 410) AS retired
       FROM antigravity_relay_usage WHERE request_id = $1 AND user_id = $2
      GROUP BY 1`,
    [
      requestId,
      userId.toString(),
      [...ANTIGRAVITY_AUX_UPSTREAM_MODELS],
      ANTIGRAVITY_MONITORING_REQUEST_TYPE,
    ],
  )
  if (res.rows.length === 0) return { ...EMPTY_ANTIGRAVITY_USAGE }
  const totals: AntigravityUsageTotals = {
    promptTokens: 0n,
    candidatesTokens: 0n,
    thoughtsTokens: 0n,
    cachedTokens: 0n,
    calls: 0,
    retired: false,
  }
  for (const row of res.rows) {
    const bucket = row.bucket ?? 'primary'
    const prompt = BigInt(row.prompt ?? '0')
    const candidates = BigInt(row.candidates ?? '0')
    const thoughts = BigInt(row.thoughts ?? '0')
    const cached = BigInt(row.cached ?? '0')
    const calls = Number(row.calls ?? '0')
    const monitoringCalls = Number(row.monitoring_calls ?? '0')
    totals.calls += calls
    if (row.retired === true) totals.retired = true
    if (bucket === 'aux') {
      const prev = totals.aux
      const nextMonitoringCalls = (prev?.monitoringCalls ?? 0) + monitoringCalls
      totals.aux = {
        promptTokens: (prev?.promptTokens ?? 0n) + prompt,
        candidatesTokens: (prev?.candidatesTokens ?? 0n) + candidates,
        thoughtsTokens: (prev?.thoughtsTokens ?? 0n) + thoughts,
        cachedTokens: (prev?.cachedTokens ?? 0n) + cached,
        calls: (prev?.calls ?? 0) + calls,
        ...(nextMonitoringCalls > 0 ? { monitoringCalls: nextMonitoringCalls } : {}),
      }
    } else {
      totals.promptTokens += prompt
      totals.candidatesTokens += candidates
      totals.thoughtsTokens += thoughts
      totals.cachedTokens += cached
    }
  }
  return totals
}

function scaledTokenCost(
  usage: TokenUsage,
  pricing: Pick<
    ModelPricing,
    'input_per_mtok' | 'output_per_mtok' | 'cache_read_per_mtok' | 'cache_write_per_mtok' | 'multiplier'
  >,
): bigint {
  const mul = multiplierToScaled(pricing.multiplier)
  return (
    BigInt(usage.input_tokens) * pricing.input_per_mtok * mul +
    BigInt(usage.output_tokens) * pricing.output_per_mtok * mul +
    BigInt(usage.cache_read_tokens) * pricing.cache_read_per_mtok * mul +
    BigInt(usage.cache_write_tokens) * pricing.cache_write_per_mtok * mul
  )
}

function ceilScaledCredits(scaled: bigint): bigint {
  return scaled === 0n ? 0n : (scaled + COST_SCALE - 1n) / COST_SCALE
}

function computeAntigravityBreakdown(
  totals: AntigravityUsageTotals,
  pricing: ModelPricing,
  pricingLookup?: Pick<PricingCache, 'get'> | null,
) {
  const primaryUsage = mapAntigravityUsage(totals)
  const auxUsage = totals.aux && totals.aux.calls > 0 ? mapAntigravityUsage(totals.aux) : null
  const auxPricing = auxUsage ? resolveAntigravityAuxPricing(pricing, pricingLookup) : null
  const primaryScaled = scaledTokenCost(primaryUsage, pricing)
  const auxScaled = auxUsage && auxPricing ? scaledTokenCost(auxUsage, auxPricing) : 0n
  const totalScaled = primaryScaled + auxScaled
  const costCredits = ceilScaledCredits(totalScaled)
  const billableUsage: TokenUsage = auxUsage
    ? {
        input_tokens: BigInt(primaryUsage.input_tokens) + BigInt(auxUsage.input_tokens),
        output_tokens: BigInt(primaryUsage.output_tokens) + BigInt(auxUsage.output_tokens),
        cache_read_tokens:
          BigInt(primaryUsage.cache_read_tokens) + BigInt(auxUsage.cache_read_tokens),
        cache_write_tokens: 0n,
      }
    : primaryUsage
  return {
    primaryUsage,
    auxUsage,
    auxPricing,
    primaryCostCredits: ceilScaledCredits(primaryScaled),
    auxCostCredits: ceilScaledCredits(auxScaled),
    costCredits,
    billableUsage,
  }
}

export function antigravityUsageCost(
  totals: AntigravityUsageTotals,
  pricing: ModelPricing,
  pricingLookup?: Pick<PricingCache, 'get'> | null,
): bigint {
  return computeAntigravityBreakdown(totals, pricing, pricingLookup).costCredits
}

export function planAntigravitySettle(args: {
  engineStatus: AntigravityEngineStatus
  totals: AntigravityUsageTotals
  pricing: ModelPricing
  pricingLookup?: Pick<PricingCache, 'get'> | null
  terminalCode?: string | null
}): {
  settleStatus: 'success' | 'error'
  costCredits: bigint
  snapshotJson: string
  usage: TokenUsage
} {
  const breakdown = computeAntigravityBreakdown(args.totals, args.pricing, args.pricingLookup)
  const { snapshot } = computeCost(breakdown.primaryUsage, args.pricing)
  const cost_credits = breakdown.costCredits
  const usage = breakdown.billableUsage
  const effectiveStatus = args.totals.retired ? 'error' : args.engineStatus
  const engineOk = effectiveStatus === 'success'
  const primaryCalls = Math.max(0, args.totals.calls - (args.totals.aux?.calls ?? 0))
  const hasOutput =
    primaryCalls > 0
      ? BigInt(breakdown.primaryUsage.output_tokens) > 0n
      : BigInt(usage.output_tokens) > 0n
  const waivedNoOutput = engineOk && !hasOutput && cost_credits > 0n
  const costCredits = engineOk && !waivedNoOutput ? cost_credits : 0n
  const hasBreakdown = Boolean(breakdown.auxUsage)
  const monitoringCalls = args.totals.aux?.monitoringCalls ?? 0
  const snapshotJson = JSON.stringify({
    ...snapshot,
    antigravity_status: effectiveStatus,
    ...(args.totals.retired ? { antigravity_terminal_code: 'ANTIGRAVITY_MODEL_RETIRED' } : {}),
    antigravity_calls: args.totals.calls,
    ...(hasBreakdown
      ? {
          antigravity_primary: {
            calls: primaryCalls,
            input_tokens: BigInt(breakdown.primaryUsage.input_tokens).toString(),
            output_tokens: BigInt(breakdown.primaryUsage.output_tokens).toString(),
            cache_read_tokens: BigInt(breakdown.primaryUsage.cache_read_tokens).toString(),
            cost_credits: breakdown.primaryCostCredits.toString(),
          },
        }
      : {}),
    ...(breakdown.auxUsage && breakdown.auxPricing && args.totals.aux
      ? {
          antigravity_aux: {
            calls: args.totals.aux.calls,
            ...(monitoringCalls > 0 ? { monitoring_calls: monitoringCalls } : {}),
            input_tokens: BigInt(breakdown.auxUsage.input_tokens).toString(),
            output_tokens: BigInt(breakdown.auxUsage.output_tokens).toString(),
            cache_read_tokens: BigInt(breakdown.auxUsage.cache_read_tokens).toString(),
            cost_credits: breakdown.auxCostCredits.toString(),
            pricing: {
              model_id: breakdown.auxPricing.model_id,
              input_per_mtok: breakdown.auxPricing.input_per_mtok.toString(),
              output_per_mtok: breakdown.auxPricing.output_per_mtok.toString(),
              cache_read_per_mtok: breakdown.auxPricing.cache_read_per_mtok.toString(),
              cache_write_per_mtok: breakdown.auxPricing.cache_write_per_mtok.toString(),
              multiplier: breakdown.auxPricing.multiplier,
              source: breakdown.auxPricing.source,
            },
          },
        }
      : {}),
    ...(!args.totals.retired && args.terminalCode
      ? { antigravity_terminal_code: args.terminalCode }
      : {}),
    ...(waivedNoOutput ? { waived: 'no_output', wouldHaveCharged: cost_credits.toString() } : {}),
    ...(!engineOk && cost_credits > 0n
      ? { waived: 'antigravity_engine_not_success', wouldHaveCharged: cost_credits.toString() }
      : {}),
  })
  return { settleStatus: engineOk ? 'success' : 'error', costCredits, snapshotJson, usage }
}

export interface AntigravitySettleAttribution {
  delegateAgentId?: string
  parentSessionId?: string
  parentTurnKey?: string
}

export async function settleAntigravityTurn(args: {
  pool: Pool
  // OCV5-738 blocker 2: the delegate settle path must pass the journal's
  // frozen price snapshot, not the live cache, so `Pick<..,'get'>` is all
  // that is actually required (and all `refreshWaivedAntigravityUsage`
  // below already assumes).
  pricing: Pick<PricingCache, 'get'>
  userId: bigint
  requestId: string
  modelId: string
  sessionId: string | null
  engineStatus: AntigravityEngineStatus
  terminalCode?: string | null
  /**
   * Delegate turn attribution (OCV5-738). Chat turns omit it and keep the
   * historical mode='chat' shape; a delegate turn must land mode='delegate'
   * like every other engine so spend reports are not silently mixed.
   */
  attribution?: AntigravitySettleAttribution | null
}): Promise<SettleResult | null> {
  const pricing = args.pricing.get(args.modelId)
  if (pricing === null) return null
  const totals = await sumAntigravityRelayUsage(args.pool, args.requestId, args.userId)
  const plan = planAntigravitySettle({
    engineStatus: args.engineStatus,
    totals,
    pricing,
    pricingLookup: args.pricing,
    terminalCode: args.terminalCode ?? null,
  })
  const settled = await settleUsageAndLedger(args.pool, {
    userId: args.userId,
    accountId: null,
    requestId: args.requestId,
    model: args.modelId,
    usage: plan.usage,
    snapshotJson: plan.snapshotJson,
    costCredits: plan.costCredits,
    status: plan.settleStatus,
    sessionId: args.sessionId,
    ...(args.attribution
      ? {
          mode: 'delegate' as const,
          parentSessionId: args.attribution.parentSessionId ?? null,
          delegateAgentId: args.attribution.delegateAgentId ?? null,
          parentTurnKey: args.attribution.parentTurnKey ?? null,
        }
      : {}),
  })
  // A call that recorded its row between the sum above and this write would
  // otherwise be missed: its relay refresh found no usage row to update yet.
  if (args.engineStatus !== 'success' || totals.retired) {
    await refreshWaivedAntigravityUsage({
      pool: args.pool,
      pricing: args.pricing,
      requestId: args.requestId,
      userId: args.userId,
    }).catch(() => {})
  }
  return settled
}

/**
 * A Stop ends the turn while a call is still streaming: the CLI drops the
 * relay socket, the relay keeps reading Google to the end and records the
 * call's row after the turn already settled (OCV5-451). Such a turn is waived,
 * so nothing is charged, but its usage row and `wouldHaveCharged` must still
 * cover every call. Recomputes the waived row from the full relay sum under a
 * row lock; idempotent, and a no-op for charged or still-running turns.
 * Returns true when the row changed.
 */
export async function refreshWaivedAntigravityUsage(args: {
  pool: Pool
  pricing: Pick<PricingCache, 'get'>
  requestId: string
  userId: bigint
}): Promise<boolean> {
  const client = await args.pool.connect()
  try {
    await client.query('BEGIN')
    const cur = await client.query<{
      id: string
      model: string
      snapshot: Record<string, unknown>
    }>(
      `SELECT id::text AS id, model, price_snapshot AS snapshot FROM usage_records
        WHERE user_id = $1 AND request_id = $2 AND cost_credits = 0 AND ledger_id IS NULL
          AND status = 'error' AND price_snapshot ? 'antigravity_status'
          AND price_snapshot->>'antigravity_status' <> 'success'
        FOR UPDATE`,
      [args.userId.toString(), args.requestId],
    )
    const row = cur.rows[0]
    const pricing = row ? args.pricing.get(row.model) : null
    if (!row || pricing === null) {
      await client.query('ROLLBACK')
      return false
    }
    const totals = await sumAntigravityRelayUsage(client, args.requestId, args.userId)
    if (totals.calls === Number(row.snapshot.antigravity_calls)) {
      await client.query('ROLLBACK')
      return false
    }
    const terminalCode = row.snapshot.antigravity_terminal_code
    const plan = planAntigravitySettle({
      engineStatus: row.snapshot.antigravity_status as AntigravityEngineStatus,
      totals,
      pricing,
      pricingLookup: args.pricing,
      terminalCode: typeof terminalCode === 'string' ? terminalCode : null,
    })
    await client.query(
      `UPDATE usage_records SET input_tokens = $2, output_tokens = $3, cache_read_tokens = $4,
              cache_write_tokens = $5, price_snapshot = $6::jsonb
        WHERE id = $1 AND cost_credits = 0`,
      [
        row.id,
        plan.usage.input_tokens.toString(),
        plan.usage.output_tokens.toString(),
        plan.usage.cache_read_tokens.toString(),
        plan.usage.cache_write_tokens.toString(),
        plan.snapshotJson,
      ],
    )
    await client.query('COMMIT')
    return true
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

// ─── Durable turn record (Codex r1 P1) ──────────────────────────────────────
// Settlement must not depend on the admitting bridge's memory: after a
// reconnect the terminal frame reaches a different bridge. Every admitted
// turn gets an antigravity_turns row; whichever bridge sees the terminal
// frame claims it by (request_id, user_id). Turns nobody reported are settled
// from relay usage on the user's next admission (no timer).

/** Minimum orphan age; live execution owners are excluded separately. */
export const ANTIGRAVITY_STALE_TURN_MS = 2 * 60 * 60 * 1000

export interface AntigravityTurnRecord {
  requestId: string
  userId: bigint
  modelId: string
  sessionId: string | null
  traceId: string | null
}

export async function recordAntigravityTurn(
  pool: Pick<Pool, 'query'>,
  turn: AntigravityTurnRecord,
): Promise<void> {
  await pool.query(
    `INSERT INTO antigravity_turns (request_id, user_id, model_id, session_id, trace_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (request_id) DO NOTHING`,
    [turn.requestId, turn.userId.toString(), turn.modelId, turn.sessionId, turn.traceId],
  )
}

/** Admission failed after the row was written: nothing ran on the route. */
export async function abandonAntigravityTurn(
  pool: Pick<Pool, 'query'>,
  requestId: string,
  userId: bigint,
): Promise<void> {
  await pool.query(
    `UPDATE antigravity_turns SET status = 'abandoned', updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2 AND status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM antigravity_relay_usage u WHERE u.request_id = $1 AND u.user_id = $2)`,
    [requestId, userId.toString()],
  )
}

type SettledTurn = { settled: SettleResult; turn: AntigravityTurnRecord }

/**
 * Claim (pending → settling) and settle one turn. Returns null when another
 * bridge already claimed it, the row is unknown, or pricing is missing (the
 * row goes back to pending so a later pass retries).
 */
export async function settleAntigravityTurnRecord(args: {
  pool: Pool
  pricing: Pick<PricingCache, 'get'>
  requestId: string
  userId: bigint
  engineStatus: AntigravityEngineStatus | 'unknown'
  terminalCode?: string | null
  /** Delegate attribution; omitted for chat turns (OCV5-738). */
  attribution?: AntigravitySettleAttribution | null
  /** Reconcile pass: also take over a 'settling' row abandoned by a crash. */
  staleBefore?: Date
}): Promise<SettledTurn | null> {
  // The turn is over: free its in-flight slot on the account (OCV5-424 per-account cap).
  if (!args.staleBefore) releaseInflight(args.requestId)
  // A reconcile pass ('unknown') never overwrites a terminal status a bridge
  // already persisted: an error turn whose first settle attempt failed must
  // stay free (Codex r2 P1).
  const claim = await args.pool.query<{
    model_id: string
    session_id: string | null
    trace_id: string | null
    engine_status: string
  }>(
    `UPDATE antigravity_turns SET status = 'settling',
            engine_status = CASE WHEN $3 = 'unknown' THEN COALESCE(engine_status, 'unknown') ELSE $3 END,
            updated_at = NOW()
      WHERE request_id = $1 AND user_id = $2
        AND (status = 'pending' OR ($4::timestamptz IS NOT NULL AND status = 'settling' AND updated_at < $4))
        AND ($4::timestamptz IS NULL OR (updated_at < $4
          AND NOT ${antigravityOwnerProtectedSql('antigravity_turns')}))
      RETURNING model_id, session_id, trace_id, engine_status`,
    [args.requestId, args.userId.toString(), args.engineStatus, args.staleBefore ?? null],
  )
  const row = claim.rows[0]
  if (!row) return null
  if (args.staleBefore) releaseInflight(args.requestId)
  const engineStatus = row.engine_status as AntigravityEngineStatus | 'unknown'
  const reconciled = args.engineStatus === 'unknown'
  const turn: AntigravityTurnRecord = {
    requestId: args.requestId,
    userId: args.userId,
    modelId: row.model_id,
    sessionId: row.session_id,
    traceId: row.trace_id,
  }
  let settled: SettleResult | null = null
  try {
    settled = await settleAntigravityTurn({
      pool: args.pool,
      pricing: args.pricing,
      userId: args.userId,
      requestId: args.requestId,
      modelId: row.model_id,
      sessionId: row.session_id,
      // Unreported turns consumed real upstream tokens; bill them (clamped to balance).
      engineStatus: engineStatus === 'unknown' ? 'success' : engineStatus,
      terminalCode:
        engineStatus === 'unknown' ? 'RECONCILED' : reconciled ? null : (args.terminalCode ?? null),
      attribution: args.attribution ?? null,
    })
  } finally {
    await args.pool
      .query(
        'UPDATE antigravity_turns SET status = $3, updated_at = NOW() WHERE request_id = $1 AND user_id = $2',
        [args.requestId, args.userId.toString(), settled === null ? 'pending' : 'settled'],
      )
      .catch(() => {})
  }
  return settled === null ? null : { settled, turn }
}

/** Settle this user's turns that never got a terminal frame. Best-effort, bounded. */
export async function reconcileStaleAntigravityTurns(args: {
  pool: Pool
  pricing: PricingCache
  userId: bigint
  now?: number
  limit?: number
}): Promise<SettledTurn[]> {
  const staleBefore = new Date((args.now ?? Date.now()) - ANTIGRAVITY_STALE_TURN_MS)
  const due = await args.pool.query<{ request_id: string }>(
    `SELECT request_id FROM antigravity_turns
      WHERE user_id = $1 AND status IN ('pending','settling') AND updated_at < $2
        AND NOT ${antigravityOwnerProtectedSql('antigravity_turns')}
      ORDER BY created_at LIMIT $3`,
    [args.userId.toString(), staleBefore, args.limit ?? 5],
  )
  const out: SettledTurn[] = []
  for (const { request_id } of due.rows) {
    const done = await settleAntigravityTurnRecord({
      pool: args.pool,
      pricing: args.pricing,
      requestId: request_id,
      userId: args.userId,
      engineStatus: 'unknown',
      staleBefore,
    })
    if (done) out.push(done)
  }
  return out
}
