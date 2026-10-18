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
import { releaseInflight } from '../account-pool/policy/affinity.js'

export type AntigravityEngineStatus = 'success' | 'error' | 'unavailable'

export interface AntigravityUsageTotals {
  promptTokens: bigint
  candidatesTokens: bigint
  thoughtsTokens: bigint
  cachedTokens: bigint
  calls: number
  /** Server-observed HTTP 200 retirement banner, persisted as relay status 410. */
  retired?: boolean
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
    retired: boolean | null
  }>(
    `SELECT SUM(prompt_tokens)::text AS prompt, SUM(candidates_tokens)::text AS candidates,
            SUM(thoughts_tokens)::text AS thoughts, SUM(cached_tokens)::text AS cached,
            COUNT(*)::text AS calls, BOOL_OR(status_code = 410) AS retired
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
    retired: row.retired === true,
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
  const effectiveStatus = args.totals.retired ? 'error' : args.engineStatus
  const engineOk = effectiveStatus === 'success'
  const waivedNoOutput = engineOk && BigInt(usage.output_tokens) === 0n && cost_credits > 0n
  const costCredits = engineOk && !waivedNoOutput ? cost_credits : 0n
  const snapshotJson = JSON.stringify({
    ...snapshot,
    antigravity_status: effectiveStatus,
    ...(args.totals.retired ? { antigravity_terminal_code: 'ANTIGRAVITY_MODEL_RETIRED' } : {}),
    antigravity_calls: args.totals.calls,
    ...(!args.totals.retired && args.terminalCode ? { antigravity_terminal_code: args.terminalCode } : {}),
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
  // The turn is over: free its in-flight slot on the account (OCV5-424 per-account cap).
  releaseInflight(args.requestId)
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
