/**
 * Durable Antigravity turn-tape settlement & periodic background reconciler (OCV5-887).
 *
 * Mirrors `durableCursorBilling.ts` + `cursorAuditReconciler.ts` + `delegateEngineBillingRuntime.ts`:
 *   1. Tenant ownership fence BEFORE route expiry (B11): never expires a route until `(requestId, userId)`
 *      ownership is verified in `request_finalize_journal` or `antigravity_turns`.
 *   2. Delegate frozen pricing authority (B4): delegate Antigravity frames in parent `engine_billings[]`
 *      claim `request_finalize_journal`, apply the frozen `billingPricing` (with composed agent multiplier),
 *      finalize the journal, and release `preCheckRedis`.
 *   3. Raced live WS repair (B5): computes exact actual debited credits from `credit_ledger` (never nominal
 *      `costCredits` when clamped to 0), upgrades keyless `pending_usage_patches` one-way, and propagates
 *      transient DB/remap errors so durable tape finalize retries cleanly without double-charging.
 *   4. Late stream closure (B3): sweeps post-SUM/pre-COMMIT late relay rows immediately after parent commit
 *      and periodically in `startAntigravityTurnReconciler`.
 */
import type { Pool } from 'pg'
import { isAntigravityDurableBillingFrame, type DurableCodexBilling } from '@openclaude/protocol'
import type { Logger } from '../logging/logger.js'
import type { PricingCache } from './pricing.js'
import { parseBillingPricing } from './persistedBillingPricing.js'
import { releasePreCheck, type PreCheckRedis } from './preCheck.js'
import {
  abortInflightJournal,
  claimInflightJournalForSettlement,
  finalizeInflightJournal,
} from './proxyBilling.js'
import {
  expireAntigravityRelayRoute,
  expireAntigravityRelayRouteForRequest,
} from './antigravityRouteContext.js'
import { antigravityOwnerProtectedSql } from './antigravityRouteAuthority.js'
import {
  settleAntigravityTurnRecord,
  settleLateAntigravityRelayUsage,
} from './antigravitySettle.js'
import { publishZcodeCatalogSettle } from './zcodeCatalogSettle.js'
import { loadSettledUsageAttribution } from '../db/pgSessionsBackend.js'
import type { AppendCostCreditsForUser } from './durableCursorBilling.js'
import { releaseInflight } from '../account-pool/policy/affinity.js'

const CANONICAL_TURN_KEY_RE = /^[0-9a-f]{64}$/
const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/

function canonicalTurnKey(raw: unknown): string | null {
  return typeof raw === 'string' && CANONICAL_TURN_KEY_RE.test(raw) ? raw : null
}

export interface DurableAntigravityBillingDeps {
  pgPool: Pool
  preCheckRedis?: PreCheckRedis
  pricing: PricingCache
  logger?: Logger
  appendCostCredits?: AppendCostCreditsForUser
  broadcastToUser?: (userId: bigint, payload: Record<string, unknown>) => void
  expireRoute?: (token: string) => Promise<unknown>
  expireRouteForRequest?: (requestId: string, expectedUserId?: bigint) => Promise<unknown>
}

export function isAntigravityDurableBilling(frame: DurableCodexBilling): boolean {
  return isAntigravityDurableBillingFrame(frame)
}

async function resolveActualDebitedCredits(
  pool: Pool,
  userId: bigint,
  existing: NonNullable<Awaited<ReturnType<typeof loadSettledUsageAttribution>>>,
): Promise<bigint> {
  if (existing.attributionCredits !== null) return existing.attributionCredits
  // B5: If no ledger entry was written (waived or wallet clamped to 0), actual debit is 0n!
  if (existing.ledgerId === null) return 0n
  const res = await pool.query<{ debited: string }>(
    `SELECT COALESCE(SUM(-delta), 0)::text AS debited
       FROM credit_ledger
      WHERE user_id = $1
        AND ref_type = 'usage_record'
        AND ref_id = $2
        AND delta < 0`,
    [userId.toString(), existing.usageId.toString()],
  )
  return BigInt(res.rows[0]?.debited ?? '0')
}

async function repairAlreadySettledAttribution(args: {
  deps: DurableAntigravityBillingDeps
  userId: bigint
  requestId: string
  frameSessionId: string | null
  turnSessionId: string | null
  turnKey: string | null
  parentTurnKey: string | null
  parentSessionId: string | null
  delegateAgentId: string | null
  existing: NonNullable<Awaited<ReturnType<typeof loadSettledUsageAttribution>>>
}): Promise<void> {
  const uidStr = args.userId.toString()
  // B5: Never swallow DB or remap errors during repair so the durable tape queue retries cleanly.
  if (args.turnKey || args.parentTurnKey) {
    await args.deps.pgPool.query(
      `UPDATE usage_records
          SET turn_key = COALESCE(turn_key, $3),
              parent_turn_key = COALESCE(parent_turn_key, $4)
        WHERE user_id = $1 AND request_id = $2`,
      [uidStr, args.requestId, args.turnKey, args.parentTurnKey],
    )
  }
  if (args.deps.appendCostCredits && (args.turnKey || args.parentTurnKey)) {
    const actualCredits = await resolveActualDebitedCredits(
      args.deps.pgPool,
      args.userId,
      args.existing,
    )
    await args.deps.appendCostCredits(
      args.requestId,
      uidStr,
      actualCredits.toString(),
      args.turnSessionId ?? args.frameSessionId,
      args.parentSessionId,
      args.delegateAgentId,
      args.turnKey,
      args.parentTurnKey,
    )
  }
}

export async function settleDurableAntigravityBilling(
  deps: DurableAntigravityBillingDeps,
  userId: bigint,
  frame: DurableCodexBilling,
): Promise<'committed' | 'already_committed' | 'waived'> {
  const requestId = frame.requestId
  const uidStr = userId.toString()
  const log = deps.logger?.child({ requestId, userId: uidStr })

  // B11: Verify tenant ownership BEFORE expiring any relay route!
  const [journalRes, turnCheckRes] = await Promise.all([
    deps.pgPool.query<{
      user_id: string
      state: string
      ctx: Record<string, unknown> | null
    }>(
      'SELECT user_id::text, state, ctx FROM request_finalize_journal WHERE request_id = $1',
      [requestId],
    ),
    deps.pgPool.query<{
      user_id: string
      status: string
      session_id: string | null
    }>(
      'SELECT user_id::text, status, session_id FROM antigravity_turns WHERE request_id = $1',
      [requestId],
    ),
  ])

  const journalRow = journalRes.rows[0]
  const turnRow = turnCheckRes.rows[0]
  if (
    (journalRow && journalRow.user_id !== uidStr) ||
    (turnRow && turnRow.user_id !== uidStr)
  ) {
    log?.warn('durable antigravity billing: foreign requestId rejected without side effects')
    return 'already_committed'
  }
  if (!journalRow && !turnRow) {
    log?.warn('durable antigravity billing: unknown requestId skipped without side effects')
    return 'already_committed'
  }

  const expireByReq = deps.expireRouteForRequest ?? expireAntigravityRelayRouteForRequest
  const expireByTok = deps.expireRoute ?? expireAntigravityRelayRoute
  const journalRouteTok =
    typeof journalRow?.ctx?.antigravityRouteToken === 'string' &&
    ROUTE_TOKEN_RE.test(journalRow.ctx.antigravityRouteToken)
      ? journalRow.ctx.antigravityRouteToken
      : null
  if (journalRouteTok) {
    await Promise.resolve(expireByTok(journalRouteTok)).catch(() => {})
  }
  await Promise.resolve(expireByReq(requestId, userId)).catch(() => {})

  const engineStatus = frame.status === 'success' ? 'success' : 'error'
  const terminalCode =
    frame.status === 'success'
      ? null
      : frame.terminalCode === 'USER_CANCELLED'
        ? 'USER_CANCELLED'
        : 'ENGINE_ERROR'

  const ctxParentSessionId =
    typeof journalRow?.ctx?.parentSessionId === 'string' ? journalRow.ctx.parentSessionId : null
  const ctxDelegateAgentId =
    typeof journalRow?.ctx?.delegateAgentId === 'string' ? journalRow.ctx.delegateAgentId : null
  const ctxParentTurnKey = canonicalTurnKey(journalRow?.ctx?.parentTurnKey)

  const turnKey = canonicalTurnKey(frame.turnKey)
  const parentTurnKey = canonicalTurnKey(frame.parentTurnKey) ?? ctxParentTurnKey
  const parentSessionId = frame.parentSessionId ?? ctxParentSessionId
  const delegateAgentId = frame.delegateAgentId ?? ctxDelegateAgentId
  const hasDelegateAttribution = Boolean(delegateAgentId || parentSessionId || parentTurnKey)

  // B4: Delegate Antigravity turns freeze pricing (with composed agent multiplier) in request_finalize_journal.
  let settlePricing: Pick<PricingCache, 'get'> = deps.pricing
  const isDelegateJournal = journalRow?.ctx?.source === 'delegate_antigravity'
  let journalClaimId: string | null = null

  if (isDelegateJournal && journalRow) {
    const frozenModel =
      typeof journalRow.ctx?.model === 'string' ? journalRow.ctx.model : undefined
    const hasFrozenPricing = journalRow.ctx?.billingPricing !== undefined
    const frozenPricing =
      frozenModel && hasFrozenPricing
        ? parseBillingPricing(journalRow.ctx?.billingPricing, frozenModel)
        : null
    if (hasFrozenPricing && frozenPricing === null) {
      log?.warn('durable antigravity billing: invalid frozen delegate pricing, waiving journal')
      await abortInflightJournal(deps.pgPool, requestId, 'durable_billing_pricing_invalid', 'INTERNAL_ERROR')
      releaseInflight(requestId)
      if (deps.preCheckRedis) {
        await releasePreCheck(deps.preCheckRedis, { userId: uidStr, requestId }).catch(() => {})
      }
      return 'waived'
    }
    if (frozenPricing) {
      settlePricing = {
        get: (modelId: string) =>
          modelId === frozenPricing.model_id ? frozenPricing : deps.pricing.get(modelId),
      }
    }
    if (journalRow.state === 'aborted') {
      releaseInflight(requestId)
      if (deps.preCheckRedis) {
        await releasePreCheck(deps.preCheckRedis, { userId: uidStr, requestId }).catch(() => {})
      }
      return 'waived'
    }
    let journalAlreadyCommitted = journalRow.state === 'committed'
    if (!journalAlreadyCommitted) {
      journalClaimId = await claimInflightJournalForSettlement(deps.pgPool, requestId)
      if (journalClaimId === null) {
        const refreshed = await deps.pgPool.query<{ state: string }>(
          'SELECT state FROM request_finalize_journal WHERE request_id = $1',
          [requestId],
        )
        const curState = refreshed.rows[0]?.state
        if (curState === 'aborted') {
          releaseInflight(requestId)
          if (deps.preCheckRedis) {
            await releasePreCheck(deps.preCheckRedis, { userId: uidStr, requestId }).catch(() => {})
          }
          return 'waived'
        }
        if (curState === 'committed') {
          journalAlreadyCommitted = true
        } else {
          throw new Error(`durable antigravity billing: delegate journal ${requestId} busy (${String(curState)})`)
        }
      }
    }
    if (journalAlreadyCommitted) {
      const existing = await loadSettledUsageAttribution(deps.pgPool, userId, requestId)
      if (existing !== null) {
        await repairAlreadySettledAttribution({
          deps,
          userId,
          requestId,
          frameSessionId: frame.engineSessionId || null,
          turnSessionId: turnRow?.session_id ?? null,
          turnKey,
          parentTurnKey,
          parentSessionId,
          delegateAgentId,
          existing,
        })
        if (engineStatus === 'success') {
          await settleLateAntigravityRelayUsage({
            pool: deps.pgPool,
            pricing: settlePricing,
            requestId,
            userId,
            appendCostCredits: deps.appendCostCredits,
          })
        }
      }
      return 'already_committed'
    }
  }

  let done: Awaited<ReturnType<typeof settleAntigravityTurnRecord>> = null
  try {
    done = await settleAntigravityTurnRecord({
      pool: deps.pgPool,
      pricing: settlePricing,
      requestId,
      userId,
      engineStatus,
      terminalCode,
      turnKey,
      parentTurnKey,
      ...(hasDelegateAttribution
        ? {
            attribution: {
              ...(delegateAgentId ? { delegateAgentId } : {}),
              ...(parentSessionId ? { parentSessionId } : {}),
              ...(parentTurnKey ? { parentTurnKey } : {}),
            },
          }
        : {}),
    })

    if (done === null) {
      const existing = await loadSettledUsageAttribution(deps.pgPool, userId, requestId)
      if (existing === null) {
        const latestTurn = await deps.pgPool.query<{ status: string; has_usage: boolean }>(
          `SELECT t.status,
                  EXISTS (
                    SELECT 1 FROM antigravity_relay_usage u
                     WHERE u.request_id = t.request_id AND u.user_id = t.user_id
                  ) AS has_usage
             FROM antigravity_turns t
            WHERE t.request_id = $1 AND t.user_id = $2`,
          [requestId, uidStr],
        )
        const tr = latestTurn.rows[0]
        if (tr && (tr.status === 'pending' || tr.status === 'settling' || (tr.status !== 'abandoned' && tr.has_usage))) {
          throw new Error(`durable antigravity billing: turn ${requestId} still unsettled (pricing miss or busy)`)
        }
        if (journalClaimId) {
          await abortInflightJournal(
            deps.pgPool,
            requestId,
            'delegate_antigravity_never_started',
            'INTERNAL_ERROR',
            journalClaimId,
          )
          journalClaimId = null
          releaseInflight(requestId)
          if (deps.preCheckRedis) {
            await releasePreCheck(deps.preCheckRedis, { userId: uidStr, requestId }).catch(() => {})
          }
          return 'waived'
        }
        return 'already_committed'
      }

      if (journalClaimId) {
        await finalizeInflightJournal(deps.pgPool, {
          requestId,
          finalCredits: existing.costCredits,
          ledgerId: existing.ledgerId,
          usageId: existing.usageId,
          settlementClaimId: journalClaimId,
        })
        journalClaimId = null
        if (deps.preCheckRedis) {
          await releasePreCheck(deps.preCheckRedis, { userId: uidStr, requestId }).catch(() => {})
        }
      }

      await repairAlreadySettledAttribution({
        deps,
        userId,
        requestId,
        frameSessionId: frame.engineSessionId || null,
        turnSessionId: turnRow?.session_id ?? null,
        turnKey,
        parentTurnKey,
        parentSessionId,
        delegateAgentId,
        existing,
      })
      if (engineStatus === 'success') {
        await settleLateAntigravityRelayUsage({
          pool: deps.pgPool,
          pricing: settlePricing,
          requestId,
          userId,
          appendCostCredits: deps.appendCostCredits,
        })
      }
      return 'already_committed'
    }

    if (journalClaimId) {
      await finalizeInflightJournal(deps.pgPool, {
        requestId,
        finalCredits: done.settled.settledCostCredits ?? 0n,
        ledgerId: done.settled.ledgerId,
        usageId: done.settled.usageId,
        settlementClaimId: journalClaimId,
      })
      journalClaimId = null
      if (deps.preCheckRedis) {
        await releasePreCheck(deps.preCheckRedis, { userId: uidStr, requestId }).catch(() => {})
      }
    }
  } catch (err) {
    if (journalClaimId) {
      await deps.pgPool
        .query(
          `UPDATE request_finalize_journal
              SET state = 'inflight', ctx = ctx - 'settlementClaimId', updated_at = NOW()
            WHERE request_id = $1 AND state = 'finalizing' AND ctx->>'settlementClaimId' = $2`,
          [requestId, journalClaimId],
        )
        .catch(() => {})
    }
    throw err
  }

  let persistError: unknown = null
  await publishZcodeCatalogSettle({
    settled: done.settled,
    requestId,
    userId: uidStr,
    modelId: done.turn.modelId,
    sessionId: done.turn.sessionId ?? (frame.engineSessionId || null),
    traceId: done.turn.traceId,
    turnKey: done.turn.turnKey ?? turnKey,
    parentTurnKey: done.turn.parentTurnKey ?? parentTurnKey,
    parentSessionId,
    delegateAgentId,
    persist: deps.appendCostCredits,
    publish: (event) => {
      deps.broadcastToUser?.(userId, event as unknown as Record<string, unknown>)
    },
    onPersistError: (err) => {
      persistError = err
    },
  })
  if (persistError !== null) throw persistError

  // B3: Immediate post-commit sweep for any late relay call committed between parent SUM and parent COMMIT.
  if (engineStatus === 'success') {
    await settleLateAntigravityRelayUsage({
      pool: deps.pgPool,
      pricing: settlePricing,
      requestId,
      userId,
      appendCostCredits: deps.appendCostCredits,
    })
  }

  if (done.settled.debitedCredits !== null && done.settled.debitedCredits > 0n) {
    return 'committed'
  }
  if (done.settled.debitedCredits === null) {
    return 'already_committed'
  }
  return 'waived'
}

export interface AntigravityTurnReconcilerOptions extends DurableAntigravityBillingDeps {
  minAgeMs?: number
  batchSize?: number
  intervalMs?: number
  runOnStart?: boolean
}

export async function runAntigravityTurnReconcileTick(
  opts: AntigravityTurnReconcilerOptions,
): Promise<{ scanned: number; settled: number; lateSettled: number; errors: number }> {
  const minAgeMs = Math.max(5_000, opts.minAgeMs ?? 15 * 60_000)
  const batchSize = Math.max(1, Math.min(100, opts.batchSize ?? 25))
  const staleBefore = new Date(Date.now() - minAgeMs)
  const due = await opts.pgPool.query<{ request_id: string; user_id: string }>(
    `SELECT request_id, user_id::text AS user_id
       FROM antigravity_turns
      WHERE status IN ('pending', 'settling')
        AND updated_at < $1
        AND NOT ${antigravityOwnerProtectedSql('antigravity_turns')}
      ORDER BY created_at ASC
      LIMIT $2`,
    [staleBefore, batchSize],
  )
  let settledCount = 0
  let lateSettled = 0
  let errors = 0
  const expireByReq = opts.expireRouteForRequest ?? expireAntigravityRelayRouteForRequest
  for (const row of due.rows) {
    const uid = BigInt(row.user_id)
    try {
      await Promise.resolve(expireByReq(row.request_id, uid)).catch(() => {})
      const done = await settleAntigravityTurnRecord({
        pool: opts.pgPool,
        pricing: opts.pricing,
        requestId: row.request_id,
        userId: uid,
        engineStatus: 'unknown',
        staleBefore,
      })
      if (!done) continue
      await publishZcodeCatalogSettle({
        settled: done.settled,
        requestId: row.request_id,
        userId: row.user_id,
        modelId: done.turn.modelId,
        sessionId: done.turn.sessionId,
        traceId: done.turn.traceId,
        turnKey: done.turn.turnKey ?? null,
        parentTurnKey: done.turn.parentTurnKey ?? null,
        persist: opts.appendCostCredits,
        publish: (event) => {
          opts.broadcastToUser?.(uid, event as unknown as Record<string, unknown>)
        },
      })
      settledCount += 1
    } catch (err) {
      errors += 1
      opts.logger?.warn('antigravity turn reconciler row failed', {
        requestId: row.request_id,
        userId: row.user_id,
        err: (err as Error)?.message,
      })
    }
  }

  // B3: Durable retry sweep for settled success turns with orphaned late relay calls
  // whose fire-and-forget callback raced before parent COMMIT or failed transiently.
  try {
    const lateCandidates = await opts.pgPool.query<{ request_id: string; user_id: string }>(
      `SELECT t.request_id, t.user_id::text AS user_id
         FROM antigravity_turns t
         JOIN usage_records ur
           ON ur.user_id = t.user_id AND ur.request_id = t.request_id
        WHERE t.status = 'settled'
          AND t.engine_status IN ('success', 'unknown')
          AND t.updated_at >= NOW() - INTERVAL '12 hours'
          AND ur.status = 'success'
          AND NOT EXISTS (
            SELECT 1 FROM antigravity_relay_usage r410
             WHERE r410.request_id = t.request_id AND r410.user_id = t.user_id AND r410.status_code = 410
          )
          AND (
            SELECT COUNT(*)::int FROM antigravity_relay_usage r
             WHERE r.request_id = t.request_id AND r.user_id = t.user_id
          ) > (
            COALESCE((ur.price_snapshot->>'antigravity_calls')::int, 0) +
            COALESCE((
              SELECT SUM(COALESCE((lc.price_snapshot->>'antigravity_late_calls')::int, 0))::int
                FROM usage_records lc
               WHERE lc.user_id = t.user_id
                 AND lc.created_at >= ur.created_at
                 AND lc.price_snapshot->>'antigravity_late_of' = t.request_id
            ), 0)
          )
        ORDER BY t.updated_at DESC
        LIMIT $1`,
      [batchSize],
    )
    for (const cand of lateCandidates.rows) {
      try {
        const applied = await settleLateAntigravityRelayUsage({
          pool: opts.pgPool,
          pricing: opts.pricing,
          requestId: cand.request_id,
          userId: BigInt(cand.user_id),
          appendCostCredits: opts.appendCostCredits,
        })
        if (applied) lateSettled += 1
      } catch (err) {
        errors += 1
        opts.logger?.warn('antigravity late-stream reconciler row failed', {
          requestId: cand.request_id,
          userId: cand.user_id,
          err: (err as Error)?.message,
        })
      }
    }
  } catch (err) {
    opts.logger?.warn('antigravity late-stream reconciler scan failed', {
      err: (err as Error)?.message,
    })
  }

  return { scanned: due.rows.length, settled: settledCount, lateSettled, errors }
}

export function startAntigravityTurnReconciler(opts: AntigravityTurnReconcilerOptions): {
  stop: () => void
} {
  const intervalMs = Math.max(5_000, opts.intervalMs ?? 60_000)
  let stopped = false
  let running = false
  const tick = () => {
    if (stopped || running) return
    running = true
    void runAntigravityTurnReconcileTick(opts)
      .catch((err) => {
        opts.logger?.warn('antigravity turn reconciler tick failed', {
          err: (err as Error)?.message,
        })
      })
      .finally(() => {
        running = false
      })
  }
  if (opts.runOnStart) tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
