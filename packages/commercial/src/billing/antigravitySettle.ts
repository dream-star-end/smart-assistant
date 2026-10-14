/**
 * Antigravity turn settlement (OCV5-415 P2).
 *
 * Usage is server-observed: the relay writes one antigravity_relay_usage row
 * per forwarded generate call (title generation included) from the upstream
 * usageMetadata. The container's own report is never billed: the CLI omits
 * the title call and its usage is cumulative across a resumed conversation.
 * Every call is priced at the turn's catalog model.
 */
import type { Pool } from 'pg'
import { type TokenUsage, computeCost } from './calculator.js'
import type { ModelPricing, PricingCache } from './pricing.js'
import { type SettleResult, settleUsageAndLedger } from './proxyBilling.js'

export type AntigravityEngineStatus = 'success' | 'error' | 'unavailable'

export interface AntigravityUsageTotals {
  promptTokens: bigint
  candidatesTokens: bigint
  thoughtsTokens: bigint
  cachedTokens: bigint
  calls: number
}

export const EMPTY_ANTIGRAVITY_USAGE: AntigravityUsageTotals = Object.freeze({
  promptTokens: 0n,
  candidatesTokens: 0n,
  thoughtsTokens: 0n,
  cachedTokens: 0n,
  calls: 0,
})

/**
 * Gemini usageMetadata → platform tokens. promptTokenCount includes the
 * cached part; thoughts are billed as output (as the upstream does).
 */
export function mapAntigravityUsage(totals: AntigravityUsageTotals): TokenUsage {
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
    prompt: string | null
    candidates: string | null
    thoughts: string | null
    cached: string | null
    calls: string
  }>(
    `SELECT SUM(prompt_tokens)::text AS prompt, SUM(candidates_tokens)::text AS candidates,
            SUM(thoughts_tokens)::text AS thoughts, SUM(cached_tokens)::text AS cached,
            COUNT(*)::text AS calls
       FROM antigravity_relay_usage WHERE request_id = $1 AND user_id = $2`,
    [requestId, userId.toString()],
  )
  const row = res.rows[0]
  if (!row) return { ...EMPTY_ANTIGRAVITY_USAGE }
  return {
    promptTokens: BigInt(row.prompt ?? '0'),
    candidatesTokens: BigInt(row.candidates ?? '0'),
    thoughtsTokens: BigInt(row.thoughts ?? '0'),
    cachedTokens: BigInt(row.cached ?? '0'),
    calls: Number(row.calls),
  }
}

export function antigravityUsageCost(
  totals: AntigravityUsageTotals,
  pricing: ModelPricing,
): bigint {
  return computeCost(mapAntigravityUsage(totals), pricing).cost_credits
}

export function planAntigravitySettle(args: {
  engineStatus: AntigravityEngineStatus
  totals: AntigravityUsageTotals
  pricing: ModelPricing
  terminalCode?: string | null
}): {
  settleStatus: 'success' | 'error'
  costCredits: bigint
  snapshotJson: string
  usage: TokenUsage
} {
  const usage = mapAntigravityUsage(args.totals)
  const { cost_credits, snapshot } = computeCost(usage, args.pricing)
  const engineOk = args.engineStatus === 'success'
  const waivedNoOutput = engineOk && BigInt(usage.output_tokens) === 0n && cost_credits > 0n
  const costCredits = engineOk && !waivedNoOutput ? cost_credits : 0n
  const snapshotJson = JSON.stringify({
    ...snapshot,
    antigravity_status: args.engineStatus,
    antigravity_calls: args.totals.calls,
    ...(args.terminalCode ? { antigravity_terminal_code: args.terminalCode } : {}),
    ...(waivedNoOutput ? { waived: 'no_output', wouldHaveCharged: cost_credits.toString() } : {}),
    ...(!engineOk && cost_credits > 0n
      ? { waived: 'antigravity_engine_not_success', wouldHaveCharged: cost_credits.toString() }
      : {}),
  })
  return { settleStatus: engineOk ? 'success' : 'error', costCredits, snapshotJson, usage }
}

export async function settleAntigravityTurn(args: {
  pool: Pool
  pricing: PricingCache
  userId: bigint
  requestId: string
  modelId: string
  sessionId: string | null
  engineStatus: AntigravityEngineStatus
  terminalCode?: string | null
}): Promise<SettleResult | null> {
  const pricing = args.pricing.get(args.modelId)
  if (pricing === null) return null
  const totals = await sumAntigravityRelayUsage(args.pool, args.requestId, args.userId)
  const plan = planAntigravitySettle({
    engineStatus: args.engineStatus,
    totals,
    pricing,
    terminalCode: args.terminalCode ?? null,
  })
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
  })
}

// ─── Durable turn record (Codex r1 P1) ──────────────────────────────────────
// Settlement must not depend on the admitting bridge's memory: after a
// reconnect the terminal frame reaches a different bridge. Every admitted
// turn gets an antigravity_turns row; whichever bridge sees the terminal
// frame claims it by (request_id, user_id). Turns nobody reported are settled
// from relay usage on the user's next admission (no timer).

/** Route TTL (1h) plus margin: a pending turn older than this cannot still be running. */
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
  pricing: PricingCache
  requestId: string
  userId: bigint
  engineStatus: AntigravityEngineStatus | 'unknown'
  terminalCode?: string | null
  /** Reconcile pass: also take over a 'settling' row abandoned by a crash. */
  staleBefore?: Date
}): Promise<SettledTurn | null> {
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
      RETURNING model_id, session_id, trace_id, engine_status`,
    [args.requestId, args.userId.toString(), args.engineStatus, args.staleBefore ?? null],
  )
  const row = claim.rows[0]
  if (!row) return null
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
