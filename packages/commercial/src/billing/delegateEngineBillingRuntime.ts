import { grokExecutionUpstream, type GrokExecutionDescriptor } from '@openclaude/protocol'
import { hashRouteToken } from '../account-pool/groups.js'
import { randomBytes } from 'node:crypto'

import {
  DELEGATE_ENGINE_BILLING_SESSION_KEY_RE,
  type DurableCodexBilling,
} from '@openclaude/protocol'
import type { Pool } from 'pg'

import {
  DELEGATE_ENGINE_BILLING_ABANDON_PATH,
  DELEGATE_ENGINE_BILLING_ADMIT_PATH,
  DELEGATE_ENGINE_BILLING_SETTLE_PATH,
  type DelegateEngineBillingRuntime,
} from '../http/internalDelegateEngineBilling.js'
import {
  UserModelAuthzEpochMismatchError,
  scopeFromAuthz,
  type UserModelAuthzLoader,
} from '../auth/userModelAuthz.js'
import { composeMultiplier, getAgentCostMultiplier } from './agentMultiplier.js'
import {
  DURABLE_CODEX_RECOVERY_VERSION,
  deriveEngineSessionId,
} from './codexFinalizer.js'
import { settleDurableCodexBilling } from './durableCodexBilling.js'
import {
  attributeOpenTurn,
  delegateOpenTurnCtx,
  openTurnDispatchColumns,
} from './openTurnAttribution.js'
import {
  UnknownCapabilitySchemaError,
  type ModelCatalogSnapshot,
} from './modelCatalog.js'
import { parseBillingPricing, serializeBillingPricing } from './persistedBillingPricing.js'
import type { PricingCache } from './pricing.js'
import {
  InsufficientCreditsError,
  estimateMaxCost,
  preCheckWithCost,
  releasePreCheck,
  type PreCheckRedis,
} from './preCheck.js'
import {
  abortInflightJournal,
  claimInflightJournalForSettlement,
  finalizeInflightJournal,
  startInflightJournal,
} from './proxyBilling.js'
import {
  abandonAntigravityTurn,
  settleAntigravityTurnRecord,
} from './antigravitySettle.js'
import {
  expireAntigravityRelayRoute,
  expireAntigravityRelayRouteForRequest,
} from './antigravityRouteContext.js'
import { releaseInflight } from '../account-pool/policy/affinity.js'
import type { AdvisorCodexAdmitRoute } from './advisorCodexAdmitRoute.js'
import { isPlatformPresetPaused } from '../marketplace/seedPlatformAgents.js'

const CODEX_PRECHECK_TOKEN_ESTIMATE = 64_000
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SESSION_ID_RE = DELEGATE_ENGINE_BILLING_SESSION_KEY_RE
const PARENT_TURN_KEY_RE = /^[0-9a-f]{64}$/
const MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/
const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/

export interface DelegateEngineCatalog {
  assertFresh(): Promise<ModelCatalogSnapshot>
}

export interface DelegateEngineBillingRuntimeDeps {
  getPool: () => Pool
  preCheckRedis: PreCheckRedis
  /**
   * Settle/recovery compatibility only. New admit must not use this cache
   * to decide authorization, engine match, or frozen price.
   */
  pricing: PricingCache
  catalog: DelegateEngineCatalog
  loadUserModelAuthz: UserModelAuthzLoader
  newRequestId?: () => string
  preCheckWithCostFn?: typeof preCheckWithCost
  startInflightJournalFn?: typeof startInflightJournal
  settleDurableCodexBillingFn?: typeof settleDurableCodexBilling
  abortInflightJournalFn?: typeof abortInflightJournal
  releasePreCheckFn?: typeof releasePreCheck
  getAgentCostMultiplierFn?: typeof getAgentCostMultiplier
  /**
   * Master-issued Codex route for every codex delegate (OCV5-729) and for
   * advisor consults. Selection is metadata + short-lived api_relay context;
   * catalog/authz/price/precheck/journal stay unchanged.
   */
  createCodexDelegateRoute?: (args: {
    containerId: number
    userId: bigint
    modelId: string
    requestId: string
  }) => Promise<AdvisorCodexAdmitRoute>
  expireCodexDelegateRoute?: (token: string) => Promise<void> | void
  claimInflightJournalForSettlementFn?: typeof claimInflightJournalForSettlement
  finalizeInflightJournalFn?: typeof finalizeInflightJournal
  settleAntigravityTurnFn?: typeof settleAntigravityTurnRecord
  abandonAntigravityTurnFn?: typeof abandonAntigravityTurn
  expireAntigravityRoute?: (token: string) => Promise<void> | void
  expireAntigravityRouteForRequest?: (requestId: string) => Promise<void> | void
  releaseAntigravityInflightFn?: typeof releaseInflight
  attributeOpenTurnFn?: typeof attributeOpenTurn
  broadcastToUser?: (userId: bigint, payload: Record<string, unknown>) => void
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void }
}

function requireString(
  body: Record<string, unknown>,
  key: string,
  re: RegExp,
): string {
  const value = body[key]
  if (typeof value !== 'string' || !re.test(value)) {
    throw new Error(`DELEGATE_ENGINE_BILLING_INVALID_${key.toUpperCase()}`)
  }
  return value
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
  re: RegExp,
): string | undefined {
  const value = body[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !re.test(value)) {
    throw new Error(`DELEGATE_ENGINE_BILLING_INVALID_${key.toUpperCase()}`)
  }
  return value
}

type DelegateBillingSource = 'delegate_codex' | 'delegate_grok' | 'delegate_antigravity'

function sourceForEngine(engine: 'codex' | 'grok' | 'antigravity'): DelegateBillingSource {
  if (engine === 'grok') return 'delegate_grok'
  if (engine === 'antigravity') return 'delegate_antigravity'
  return 'delegate_codex'
}

/** Bounded terminal classification from the container frame (same contract as codex). */
function normalizeTerminalCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z0-9_]{1,40}$/.test(value) ? value : undefined
}

function journalString(
  ctx: Record<string, unknown> | null | undefined,
  key: string,
  re: RegExp,
): string | undefined {
  const value = ctx?.[key]
  if (typeof value === 'string' && re.test(value)) return value
  return undefined
}

/**
 * Journal ctx is the master-owned attribution authority for delegate
 * engine-reported settles. Frame fields fill only gaps; a mismatch keeps
 * the journal value so codexFinalizer writes mode=delegate.
 */
export function resolveDelegateBillingAttribution(
  journalCtx: Record<string, unknown> | null | undefined,
  frame: {
    delegateAgentId?: unknown
    parentSessionId?: unknown
    parentTurnKey?: unknown
  },
): {
  delegateAgentId?: string
  parentSessionId?: string
  parentTurnKey?: string
} {
  const fromFrame = (value: unknown, re: RegExp): string | undefined =>
    typeof value === 'string' && re.test(value) ? value : undefined
  const pick = (
    key: 'delegateAgentId' | 'parentSessionId' | 'parentTurnKey',
    re: RegExp,
  ): string | undefined => journalString(journalCtx, key, re) ?? fromFrame(frame[key], re)
  const delegateAgentId = pick('delegateAgentId', AGENT_ID_RE)
  // A taskboard parent has no web client id, so this value is the raw
  // session key (~155, worst ~207). Same 240-char contract as sessionKey.
  const parentSessionId = pick('parentSessionId', SESSION_ID_RE)
  const parentTurnKey = pick('parentTurnKey', PARENT_TURN_KEY_RE)
  return {
    ...(delegateAgentId ? { delegateAgentId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(parentTurnKey ? { parentTurnKey } : {}),
  }
}

async function loadFreshCatalogSnapshot(
  catalog: DelegateEngineCatalog,
): Promise<ModelCatalogSnapshot> {
  try {
    return await catalog.assertFresh()
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('DELEGATE_ENGINE_BILLING_')) {
      throw err
    }
    throw new Error('DELEGATE_ENGINE_BILLING_CATALOG_UNAVAILABLE')
  }
}

function usageFromBody(body: Record<string, unknown>): DurableCodexBilling['usage'] {
  const usage =
    body.usage && typeof body.usage === 'object' && !Array.isArray(body.usage)
      ? (body.usage as Record<string, unknown>)
      : {}
  const safe = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
  return {
    input_tokens: safe(usage.input_tokens),
    output_tokens: safe(usage.output_tokens),
    reasoning_output_tokens: safe(usage.reasoning_output_tokens),
    cache_read_input_tokens: safe(usage.cache_read_input_tokens),
    cache_creation_input_tokens: safe(usage.cache_creation_input_tokens),
  }
}

export function createDelegateEngineBillingRuntime(
  deps: DelegateEngineBillingRuntimeDeps,
): DelegateEngineBillingRuntime {
  const newRequestId = deps.newRequestId ?? (() => randomBytes(16).toString('hex'))
  const runPreCheck = deps.preCheckWithCostFn ?? preCheckWithCost
  const runStartJournal = deps.startInflightJournalFn ?? startInflightJournal
  const runSettle = deps.settleDurableCodexBillingFn ?? settleDurableCodexBilling
  const runAbort = deps.abortInflightJournalFn ?? abortInflightJournal
  const runReleasePreCheck = deps.releasePreCheckFn ?? releasePreCheck
  const runAgentMul = deps.getAgentCostMultiplierFn ?? getAgentCostMultiplier
  const runClaimJournal =
    deps.claimInflightJournalForSettlementFn ?? claimInflightJournalForSettlement
  const runFinalizeJournal = deps.finalizeInflightJournalFn ?? finalizeInflightJournal
  const runSettleAntigravity = deps.settleAntigravityTurnFn ?? settleAntigravityTurnRecord
  const runAbandonAntigravity = deps.abandonAntigravityTurnFn ?? abandonAntigravityTurn
  const runExpireAntigravityRoute = deps.expireAntigravityRoute ?? expireAntigravityRelayRoute
  const runExpireAntigravityRouteForRequest =
    deps.expireAntigravityRouteForRequest ?? expireAntigravityRelayRouteForRequest
  const runReleaseAntigravityInflight = deps.releaseAntigravityInflightFn ?? releaseInflight

  return {
    async handle({ path, identity, body }) {
      const userId = BigInt(identity.userId)
      if (path === DELEGATE_ENGINE_BILLING_ADMIT_PATH) {
        const model = requireString(body, 'model', MODEL_ID_RE)
        const engineRaw = requireString(body, 'engine', /^(codex|grok|antigravity)$/)
        const engine = engineRaw as 'codex' | 'grok' | 'antigravity'
        const agentId = requireString(body, 'agentId', AGENT_ID_RE)
        const delegateAgentId = requireString(body, 'delegateAgentId', AGENT_ID_RE)
        if (isPlatformPresetPaused(agentId) || isPlatformPresetPaused(delegateAgentId)) {
          throw new Error('DELEGATE_ENGINE_BILLING_AGENT_UNAVAILABLE')
        }
        const sessionKey = requireString(body, 'sessionKey', SESSION_ID_RE)
        const parentSessionId = optionalString(body, 'parentSessionId', SESSION_ID_RE)
        const parentTurnKey = optionalString(body, 'parentTurnKey', PARENT_TURN_KEY_RE)
        const snapshot = await loadFreshCatalogSnapshot(deps.catalog)
        let authz
        try {
          authz = await deps.loadUserModelAuthz(userId, snapshot.securityEpoch)
        } catch (err) {
          if (err instanceof UserModelAuthzEpochMismatchError) {
            throw new Error('DELEGATE_ENGINE_BILLING_EPOCH_MISMATCH')
          }
          throw new Error('DELEGATE_ENGINE_BILLING_AUTHZ_UNAVAILABLE')
        }
        const scope = scopeFromAuthz(userId, authz)
        const canonical = snapshot.aliasToCanonical(model)
        let descriptor
        try {
          descriptor = snapshot.resolve(canonical)
        } catch (err) {
          if (err instanceof UnknownCapabilitySchemaError) {
            throw new Error('DELEGATE_ENGINE_BILLING_CAPABILITY_UNSUPPORTED')
          }
          throw err
        }
        if (!descriptor) throw new Error('DELEGATE_ENGINE_BILLING_MODEL_UNAVAILABLE')
        if (descriptor.engine !== engine) {
          throw new Error('DELEGATE_ENGINE_BILLING_INVALID_ENGINE')
        }
        if (!snapshot.canUseModel(scope, canonical)) {
          throw new Error('DELEGATE_ENGINE_BILLING_NOT_AUTHORIZED')
        }
        const basePricing = snapshot.billingPricingFor(canonical)
        if (!basePricing) throw new Error('DELEGATE_ENGINE_BILLING_PRICING_UNAVAILABLE')
        let grokRouteTokenHash: string | undefined
        if (engine === 'grok') {
          grokRouteTokenHash = hashRouteToken(requireString(body, 'grokRouteToken', ROUTE_TOKEN_RE))
          const boundRoute = await deps.getPool().query(
            "SELECT model_id FROM grok_route_contexts WHERE token_hash=$1 AND container_id=$2 AND user_id=$3 AND model_id=$4 AND status='active' AND expires_at>NOW()",
            [grokRouteTokenHash, String(identity.containerId), String(userId), canonical],
          )
          if (boundRoute.rows.length !== 1) throw new Error('DELEGATE_ENGINE_BILLING_GROK_ROUTE_MISMATCH')
          grokExecutionUpstream(canonical, descriptor.upstreamModelId)
        }
        const agentMul = await runAgentMul(deps.getPool(), agentId)
        const derivedPricing = {
          ...basePricing,
          multiplier: composeMultiplier(basePricing.multiplier, agentMul),
        }
        const requestId = newRequestId()
        const maxCost = estimateMaxCost(CODEX_PRECHECK_TOKEN_ESTIMATE, derivedPricing)
        let precheck: Awaited<ReturnType<typeof preCheckWithCost>>
        try {
          precheck = await runPreCheck(deps.preCheckRedis, { userId, requestId, maxCost })
        } catch (err) {
          if (err instanceof InsufficientCreditsError) {
            throw new Error('DELEGATE_ENGINE_BILLING_INSUFFICIENT_CREDITS')
          }
          throw err
        }
        const engineSessionId = deriveEngineSessionId(sessionKey)
        const grokExecutionDescriptor: GrokExecutionDescriptor | undefined = engine === 'grok'
          ? Object.freeze({
              canonicalModel: canonical,
              upstreamModelId: grokExecutionUpstream(canonical, descriptor.upstreamModelId),
              billingRequestId: requestId, executionRevision: snapshot.executionRevision,
              engineSessionId, routeTokenHash: grokRouteTokenHash,
            })
          : undefined
        const openTurn = parentTurnKey
          ? null
          : await (deps.attributeOpenTurnFn ?? attributeOpenTurn)(
              deps.getPool(),
              { userId, containerId: BigInt(identity.containerId) },
              deps.logger,
            )
        const openTurnColumns = parentTurnKey ? undefined : openTurnDispatchColumns(openTurn)
        // Every codex delegate needs a master-issued route (OCV5-729): the
        // container's codex CLI is spawned with no provider override and would
        // otherwise fall back to the built-in `openai` provider plus workspace
        // routing discovery, which the relay allowlist rejects. Advisor
        // consults use the same authority; the route stays master-signed and
        // bound to this container/user/model.
        const codexRouteRequired = engine === 'codex'
        let codexRoute: AdvisorCodexAdmitRoute | undefined
        if (codexRouteRequired) {
          try {
            codexRoute = deps.createCodexDelegateRoute
              ? await deps.createCodexDelegateRoute({
                  containerId: identity.containerId,
                  userId,
                  modelId: canonical,
                  requestId,
                })
              : { kind: 'unavailable', reason: 'selector_unwired' }
          } catch {
            await runReleasePreCheck(deps.preCheckRedis, precheck.reservation).catch(() => {})
            throw new Error('DELEGATE_ENGINE_BILLING_ROUTE_UNAVAILABLE')
          }
        }
        const codexRouteToken =
          codexRoute?.kind === 'api_relay' ? codexRoute.token : undefined
        try {
          const admitted = await runStartJournal(deps.getPool(), {
            requestId,
            userId,
            containerId: BigInt(identity.containerId),
            model: canonical,
            precheckCredits: precheck.maxCost,
            ...(openTurnColumns ?? {}),
            ctxJson: {
              agentId,
              delegateAgentId,
              ...delegateOpenTurnCtx({ parentSessionId, parentTurnKey, stamp: openTurn }),
              source: sourceForEngine(engine),
              ...(engine === 'antigravity'
                ? {
                    antigravityBudgetCredits: (
                      typeof precheck.balance === 'bigint' && precheck.balance > precheck.maxCost
                        ? precheck.balance
                        : precheck.maxCost
                    ).toString(),
                  }
                : {}),
              durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
              billingPricing: serializeBillingPricing(derivedPricing),
              ...(grokExecutionDescriptor ? { grokExecutionDescriptor } : {}),
              // Nested so settle does not treat these as a bridge_signed stamp.
              catalogGeneration: {
                billingRevision: snapshot.billingRevision,
                executionRevision: snapshot.executionRevision,
                securityEpoch: snapshot.securityEpoch.toString(),
              },
              engineSessionId,
              // Historical key names, shared with advisor consults: settle and
              // abandon recovery read them to expire api_relay routes.
              ...(codexRouteToken ? { advisorRouteToken: codexRouteToken } : {}),
              ...(codexRoute ? { advisorRouteKind: codexRoute.kind } : {}),
            },
          })
          if (!admitted) throw new Error('DELEGATE_ENGINE_BILLING_JOURNAL_CONFLICT')
        } catch (err) {
          await runReleasePreCheck(deps.preCheckRedis, precheck.reservation).catch(() => {})
          if (codexRouteToken) {
            await Promise.resolve(deps.expireCodexDelegateRoute?.(codexRouteToken)).catch(() => {})
          }
          throw err
        }
        if (codexRouteRequired) {
          return { requestId, engineSessionId, route: codexRoute }
        }
        return { requestId, engineSessionId, ...(grokExecutionDescriptor ? { grokExecutionDescriptor } : {}) }
      }

      const requestId = requireString(body, 'requestId', REQUEST_ID_RE)
      const journal = await deps.getPool().query<{
        user_id: string
        container_id: string | null
        ctx: Record<string, unknown> | null
      }>(
        `SELECT user_id::text,container_id::text,ctx
           FROM request_finalize_journal WHERE request_id=$1`,
        [requestId],
      )
      const journalRow = journal.rows[0]
      const source = journalRow?.ctx?.source
      if (
        !journalRow ||
        journalRow.user_id !== String(identity.userId) ||
        journalRow.container_id !== String(identity.containerId) ||
        source !== 'delegate_codex' &&
        source !== 'delegate_grok' &&
        source !== 'delegate_antigravity'
      ) {
        throw new Error('DELEGATE_ENGINE_BILLING_INVALID_JOURNAL_IDENTITY')
      }

      if (path === DELEGATE_ENGINE_BILLING_SETTLE_PATH && source === 'delegate_antigravity') {
        const engineStatus = body.status === 'success' ? 'success' : 'error'
        // The route is done the moment the turn is: stop relay traffic before
        // the (idempotent) usage settle so no late call can add unattributed
        // spend to this turn.
        const routeToken = journalString(journalRow.ctx, 'antigravityRouteToken', ROUTE_TOKEN_RE)
        if (routeToken) {
          await Promise.resolve(runExpireAntigravityRoute(routeToken)).catch(() => {})
        }
        await Promise.resolve(runExpireAntigravityRouteForRequest(requestId)).catch(() => {})
        const pool = deps.getPool()
        const reservation = { userId: String(identity.userId), requestId }
        const claimId = await runClaimJournal(pool, requestId)
        if (claimId === null) {
          // Another owner already finalized/claimed this admission. Never
          // double-debit; the retry converges once that owner reports state.
          const state = await pool.query<{ state: string }>(
            'SELECT state FROM request_finalize_journal WHERE request_id=$1',
            [requestId],
          )
          if (state.rows[0]?.state === 'committed') return { settled: true }
          throw new Error('DELEGATE_ENGINE_BILLING_JOURNAL_CONFLICT')
        }
        try {
          // OCV5-738 blocker 2: settle with the immutable price snapshot frozen
          // at admission (includes composed agent multiplier). Fall back to
          // live pricing cache only for legacy journals without billingPricing.
          const frozenModel = typeof journalRow.ctx?.model === 'string' ? journalRow.ctx.model : undefined
          const hasFrozenPricing = journalRow.ctx?.billingPricing !== undefined
          const frozenPricing =
            frozenModel && hasFrozenPricing
              ? parseBillingPricing(journalRow.ctx?.billingPricing, frozenModel)
              : null
          if (hasFrozenPricing && frozenPricing === null) {
            await runAbort(
              pool,
              requestId,
              'durable_billing_pricing_invalid',
              'INTERNAL_ERROR',
              claimId,
            )
            runReleaseAntigravityInflight(requestId)
            await runReleasePreCheck(deps.preCheckRedis, reservation).catch(() => {})
            return { settled: false }
          }
          const settlePricing: Pick<PricingCache, 'get'> = frozenPricing
            ? {
                get: (modelId: string) =>
                  modelId === frozenPricing.model_id ? frozenPricing : deps.pricing.get(modelId),
              }
            : deps.pricing
          const done = await runSettleAntigravity({
            pool,
            pricing: settlePricing,
            requestId,
            userId,
            engineStatus,
            terminalCode: normalizeTerminalCode(body.terminalCode),
            attribution: resolveDelegateBillingAttribution(journalRow.ctx, body),
          })
          if (done === null) {
            // No turn row (route never minted → nothing ran), pricing missing,
            // or another settle already owns it. Prefer durable usage truth when present.
            const usage = await pool.query<{
              id: string
              ledger_id: string | null
              cost_credits: string
            }>(
              `SELECT id::text AS id, ledger_id::text AS ledger_id, cost_credits::text AS cost_credits
                 FROM usage_records WHERE user_id=$1 AND request_id=$2`,
              [String(identity.userId), requestId],
            )
            const row = usage.rows[0]
            if (!row) {
              // OCV5-738 blocker 3: distinguish "route never minted / abandoned
              // with zero relay usage" from "turn exists (pending due to missing
              // price, or settling by another worker) / relay usage recorded".
              const turnState = await pool.query<{
                status: string
                has_usage: boolean
              }>(
                `SELECT t.status,
                        EXISTS (
                          SELECT 1 FROM antigravity_relay_usage u
                           WHERE u.request_id = t.request_id AND u.user_id = t.user_id
                        ) AS has_usage
                   FROM antigravity_turns t
                  WHERE t.request_id = $1 AND t.user_id = $2`,
                [requestId, String(identity.userId)],
              )
              const turnRow = turnState.rows[0]
              if (turnRow && (turnRow.status !== 'abandoned' || turnRow.has_usage)) {
                throw new Error('DELEGATE_ANTIGRAVITY_SETTLE_RETRYABLE')
              }
              await runAbort(
                pool,
                requestId,
                'delegate_antigravity_never_started',
                'INTERNAL_ERROR',
                claimId,
              )
              // No turn row means the account in-flight unit admitted at mint
              // was never released by settleAntigravityTurn: give it back here
              // or ANTIGRAVITY_MAX_INFLIGHT_PER_ROUTE fills with ghosts.
              runReleaseAntigravityInflight(requestId)
              await runReleasePreCheck(deps.preCheckRedis, reservation).catch(() => {})
              return { settled: false }
            }
            await runFinalizeJournal(pool, {
              requestId,
              finalCredits: BigInt(row.cost_credits),
              ledgerId: row.ledger_id === null ? null : BigInt(row.ledger_id),
              usageId: BigInt(row.id),
              settlementClaimId: claimId,
            })
            await runReleasePreCheck(deps.preCheckRedis, reservation).catch(() => {})
            return { settled: true }
          }
          await runFinalizeJournal(pool, {
            requestId,
            finalCredits: done.settled.settledCostCredits ?? 0n,
            ledgerId: done.settled.ledgerId,
            usageId: done.settled.usageId,
            settlementClaimId: claimId,
          })
        } catch (err) {
          // A DB/settle failure is not a waiver: hand finalizing back to
          // inflight so the container's durable settle retry can finish. The
          // precheck reservation must survive for that retry.
          await pool
            .query(
              `UPDATE request_finalize_journal
                  SET state='inflight', ctx=ctx - 'settlementClaimId', updated_at=NOW()
                WHERE request_id=$1 AND state='finalizing' AND ctx->>'settlementClaimId'=$2`,
              [requestId, claimId],
            )
            .catch(() => {})
          throw err
        }
        await runReleasePreCheck(deps.preCheckRedis, reservation).catch(() => {})
        return { settled: true }
      }

      if (path === DELEGATE_ENGINE_BILLING_SETTLE_PATH) {
        const status = body.status === 'success' ? 'success' : 'error'
        const durationMs =
          typeof body.durationMs === 'number' && Number.isFinite(body.durationMs) && body.durationMs > 0
            ? Math.trunc(body.durationMs)
            : 0
        const engineSessionId =
          typeof body.engineSessionId === 'string' && body.engineSessionId
            ? body.engineSessionId
            : typeof journalRow.ctx?.engineSessionId === 'string'
              ? journalRow.ctx.engineSessionId
              : deriveEngineSessionId(`delegate:${identity.userId}:${identity.containerId}`)
        await runSettle(
          {
            pgPool: deps.getPool(),
            preCheckRedis: deps.preCheckRedis,
            pricing: deps.pricing,
            broadcastToUser: deps.broadcastToUser,
          },
          userId,
          {
            requestId,
            engineSessionId,
            status,
            durationMs,
            usage: usageFromBody(body),
            ...(body.terminalCode === 'USER_CANCELLED' || body.terminalCode === 'CODEX_ERROR'
              ? { terminalCode: body.terminalCode }
              : {}),
            ...(typeof body.turnKey === 'string' ? { turnKey: body.turnKey } : {}),
            ...resolveDelegateBillingAttribution(journalRow.ctx, body),
            ...(body.rateLimits !== undefined ? { rateLimits: body.rateLimits as DurableCodexBilling['rateLimits'] } : {}),
          },
        )
        const settledRouteToken = journalString(journalRow.ctx, 'advisorRouteToken', ROUTE_TOKEN_RE)
        if (settledRouteToken) {
          await Promise.resolve(deps.expireCodexDelegateRoute?.(settledRouteToken)).catch(() => {})
        }
        return { settled: true }
      }

      if (path === DELEGATE_ENGINE_BILLING_ABANDON_PATH && source === 'delegate_antigravity') {
        // Exactly-once terminal cleanup for an admission whose turn never
        // started: drop the route, mark the durable turn abandoned (refuses
        // when relay usage proves a turn ran), give back the account in-flight
        // slot and the precheck reservation, then abort the journal.
        const routeToken = journalString(journalRow.ctx, 'antigravityRouteToken', ROUTE_TOKEN_RE)
        if (routeToken) {
          await Promise.resolve(runExpireAntigravityRoute(routeToken)).catch(() => {})
        }
        await Promise.resolve(runExpireAntigravityRouteForRequest(requestId)).catch(() => {})
        await runAbandonAntigravity(deps.getPool(), requestId, userId).catch(() => {})
        runReleaseAntigravityInflight(requestId)
        await runAbort(
          deps.getPool(),
          requestId,
          'delegate_engine_billing_abandoned',
          'INTERNAL_ERROR',
        )
        await runReleasePreCheck(deps.preCheckRedis, {
          userId: String(identity.userId),
          requestId,
        }).catch(() => {})
        return { abandoned: true }
      }

      if (path === DELEGATE_ENGINE_BILLING_ABANDON_PATH) {
        await runAbort(
          deps.getPool(),
          requestId,
          'delegate_engine_billing_abandoned',
          'INTERNAL_ERROR',
        )
        await runReleasePreCheck(deps.preCheckRedis, {
          userId: String(identity.userId),
          requestId,
        }).catch(() => {})
        const abandonedRouteToken = journalString(journalRow.ctx, 'advisorRouteToken', ROUTE_TOKEN_RE)
        if (abandonedRouteToken) {
          await Promise.resolve(deps.expireCodexDelegateRoute?.(abandonedRouteToken)).catch(() => {})
        }
        return { abandoned: true }
      }

      throw new Error('DELEGATE_ENGINE_BILLING_INVALID_PATH')
    },
  }
}
