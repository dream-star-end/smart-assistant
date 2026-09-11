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
  UnknownCapabilitySchemaError,
  type ModelCatalogSnapshot,
} from './modelCatalog.js'
import { serializeBillingPricing } from './persistedBillingPricing.js'
import type { PricingCache } from './pricing.js'
import {
  InsufficientCreditsError,
  estimateMaxCost,
  preCheckWithCost,
  releasePreCheck,
  type PreCheckRedis,
} from './preCheck.js'
import { abortInflightJournal, startInflightJournal } from './proxyBilling.js'
import type { AdvisorCodexAdmitRoute } from './advisorCodexAdmitRoute.js'

const CODEX_PRECHECK_TOKEN_ESTIMATE = 64_000
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SESSION_ID_RE = DELEGATE_ENGINE_BILLING_SESSION_KEY_RE
const PARENT_TURN_KEY_RE = /^[0-9a-f]{64}$/
const MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/
const ROUTE_TOKEN_RE = /^[0-9a-f]{64}$/
const ADVISOR_AGENT_ID = 'advisor'

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
   * Advisor-consult only. Regular delegate admits must not call this.
   * Selection is metadata + short-lived api_relay context; 179 catalog/authz/
   * price/precheck/journal stay unchanged.
   */
  createAdvisorCodexRoute?: (args: {
    containerId: number
    userId: bigint
    modelId: string
    requestId: string
  }) => Promise<AdvisorCodexAdmitRoute>
  expireAdvisorCodexRoute?: (token: string) => Promise<void> | void
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

function sourceForEngine(engine: 'codex' | 'grok'): 'delegate_codex' | 'delegate_grok' {
  return engine === 'grok' ? 'delegate_grok' : 'delegate_codex'
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
  const parentSessionId = pick('parentSessionId', /^.{1,128}$/)
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

  return {
    async handle({ path, identity, body }) {
      const userId = BigInt(identity.userId)
      if (path === DELEGATE_ENGINE_BILLING_ADMIT_PATH) {
        const model = requireString(body, 'model', MODEL_ID_RE)
        const engineRaw = requireString(body, 'engine', /^(codex|grok)$/)
        const engine = engineRaw as 'codex' | 'grok'
        const agentId = requireString(body, 'agentId', AGENT_ID_RE)
        const delegateAgentId = requireString(body, 'delegateAgentId', AGENT_ID_RE)
        const sessionKey = requireString(body, 'sessionKey', SESSION_ID_RE)
        const parentSessionId = optionalString(body, 'parentSessionId', /^.{1,128}$/)
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
        const advisorConsult = delegateAgentId === ADVISOR_AGENT_ID && engine === 'codex'
        let advisorRoute: AdvisorCodexAdmitRoute | undefined
        if (advisorConsult) {
          try {
            advisorRoute = deps.createAdvisorCodexRoute
              ? await deps.createAdvisorCodexRoute({
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
        const advisorRouteToken =
          advisorRoute?.kind === 'api_relay' ? advisorRoute.token : undefined
        try {
          const admitted = await runStartJournal(deps.getPool(), {
            requestId,
            userId,
            containerId: BigInt(identity.containerId),
            model: canonical,
            precheckCredits: precheck.maxCost,
            ctxJson: {
              agentId,
              delegateAgentId,
              ...(parentSessionId ? { parentSessionId } : {}),
              ...(parentTurnKey ? { parentTurnKey } : {}),
              source: sourceForEngine(engine),
              durableBillingRecovery: DURABLE_CODEX_RECOVERY_VERSION,
              billingPricing: serializeBillingPricing(derivedPricing),
              // Nested so settle does not treat these as a bridge_signed stamp.
              catalogGeneration: {
                billingRevision: snapshot.billingRevision,
                executionRevision: snapshot.executionRevision,
                securityEpoch: snapshot.securityEpoch.toString(),
              },
              engineSessionId,
              ...(advisorRouteToken ? { advisorRouteToken } : {}),
              ...(advisorRoute ? { advisorRouteKind: advisorRoute.kind } : {}),
            },
          })
          if (!admitted) throw new Error('DELEGATE_ENGINE_BILLING_JOURNAL_CONFLICT')
        } catch (err) {
          await runReleasePreCheck(deps.preCheckRedis, precheck.reservation).catch(() => {})
          if (advisorRouteToken) {
            await Promise.resolve(deps.expireAdvisorCodexRoute?.(advisorRouteToken)).catch(() => {})
          }
          throw err
        }
        if (advisorConsult) {
          return { requestId, engineSessionId, route: advisorRoute }
        }
        return { requestId, engineSessionId }
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
        (source !== 'delegate_codex' && source !== 'delegate_grok')
      ) {
        throw new Error('DELEGATE_ENGINE_BILLING_INVALID_JOURNAL_IDENTITY')
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
          await Promise.resolve(deps.expireAdvisorCodexRoute?.(settledRouteToken)).catch(() => {})
        }
        return { settled: true }
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
          await Promise.resolve(deps.expireAdvisorCodexRoute?.(abandonedRouteToken)).catch(() => {})
        }
        return { abandoned: true }
      }

      throw new Error('DELEGATE_ENGINE_BILLING_INVALID_PATH')
    },
  }
}
