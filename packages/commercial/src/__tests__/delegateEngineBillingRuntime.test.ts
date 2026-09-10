import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DELEGATE_ENGINE_BILLING_SESSION_KEY_MAX_CHARS } from '@openclaude/protocol'

import {
  UserModelAuthzEpochMismatchError,
  type UserModelAuthz,
} from '../auth/userModelAuthz.js'
import { deriveEngineSessionId } from '../billing/codexFinalizer.js'
import {
  createDelegateEngineBillingRuntime,
  resolveDelegateBillingAttribution,
} from '../billing/delegateEngineBillingRuntime.js'
import {
  CAPABILITY_SCHEMA_VERSION,
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from '../billing/modelCatalog.js'
import { parseBillingPricing } from '../billing/persistedBillingPricing.js'
import {
  DELEGATE_ENGINE_BILLING_ABANDON_PATH,
  DELEGATE_ENGINE_BILLING_ADMIT_PATH,
  DELEGATE_ENGINE_BILLING_SETTLE_PATH,
} from '../http/internalDelegateEngineBilling.js'
import { InsufficientCreditsError } from '../billing/preCheck.js'
import type { ModelPricing } from '../billing/pricing.js'

/** Live taskboard patrol key (uid3 2026-09, 155 chars). */
const TASKBOARD_SESSION_KEY_155 =
  'agent:stage-triage:taskboard:5bfa0bd1-72de-47a4-b75b-a5a4d75e2eee:852859fa-cf1d-481c-96fd-23f2966b8b5f.stage.feature.0:3057ab8d-4308-46b6-b5f8-09f118294897'

const PRICING: ModelPricing = {
  model_id: 'gpt-5.6-sol',
  display_name: 'GPT 5.6 Sol',
  input_per_mtok: 1000n,
  output_per_mtok: 5000n,
  cache_read_per_mtok: 100n,
  cache_write_per_mtok: 500n,
  multiplier: '1.000',
  enabled: true,
  sort_order: 0,
  visibility: 'public',
  extra_system_prompt: null,
  default_effort: null,
  updated_at: new Date(0),
}

const CACHE_DECOY: ModelPricing = {
  ...PRICING,
  model_id: 'decoy',
  input_per_mtok: 999_999n,
  output_per_mtok: 999_999n,
  multiplier: '9.000',
}

const IDENTITY = { userId: 42, containerId: 7 }
const REQUEST_ID = 'ab'.repeat(16)
const SECURITY_EPOCH = 7n

const CAPABILITY = {
  supportsVision: false,
  reasoning: { supported: ['medium'] as const, codexModelDefault: null },
  ccb: { capabilityZero: false, supportsThinking: false },
}

function catalogEntry(
  over: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, 'entryId' | 'modelId' | 'engine'>,
): ModelCatalogEntry {
  return {
    providerId: over.engine,
    upstreamModelId: null,
    contextWindow: 128_000,
    capabilityProfile: CAPABILITY,
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    state: 'active',
    lockVersion: 1,
    ...over,
  }
}

function catalogPrice(modelId: string, over: Partial<ModelCatalogPricing> = {}): ModelCatalogPricing {
  return {
    modelId,
    displayName: modelId,
    inputPerMtok: 1000n,
    outputPerMtok: 5000n,
    cacheReadPerMtok: 100n,
    cacheWritePerMtok: 500n,
    multiplier: '1.000',
    visibility: 'public',
    sortOrder: 0,
    defaultEffort: null,
    ...over,
  }
}

function defaultSnapshot(over?: {
  prices?: Partial<Record<string, Partial<ModelCatalogPricing>>>
  epoch?: bigint
}): ModelCatalogSnapshot {
  const price = (modelId: string, extra: Partial<ModelCatalogPricing> = {}) =>
    catalogPrice(modelId, { ...(over?.prices?.[modelId] ?? {}), ...extra })
  return new ModelCatalogSnapshot({
    entries: [
      catalogEntry({ entryId: 1, modelId: 'gpt-5.6-sol', engine: 'codex' }),
      catalogEntry({ entryId: 2, modelId: 'grok-build', engine: 'grok' }),
      catalogEntry({ entryId: 3, modelId: 'glm-5.3-zai', engine: 'ccb', providerId: 'ark' }),
      catalogEntry({ entryId: 4, modelId: 'admin-codex', engine: 'codex' }),
      catalogEntry({ entryId: 5, modelId: 'hidden-codex', engine: 'codex' }),
      catalogEntry({ entryId: 6, modelId: 'max-codex', engine: 'codex' }),
      catalogEntry({
        entryId: 7,
        modelId: 'future-codex',
        engine: 'codex',
        capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION + 1,
      }),
      catalogEntry({ entryId: 8, modelId: 'retired-codex', engine: 'codex', state: 'disabled' }),
    ],
    aliases: new Map([
      ['sol-alias', 1],
      ['cross-engine-alias', 2],
    ]),
    pricing: new Map([
      ['gpt-5.6-sol', price('gpt-5.6-sol', { displayName: 'GPT 5.6 Sol' })],
      ['grok-build', price('grok-build', { displayName: 'Grok Build' })],
      ['glm-5.3-zai', price('glm-5.3-zai', { displayName: 'GLM' })],
      ['admin-codex', price('admin-codex', { visibility: 'admin', displayName: 'Admin Codex' })],
      ['hidden-codex', price('hidden-codex', { visibility: 'hidden', displayName: 'Hidden Codex' })],
      ['max-codex', price('max-codex', { minPlanCode: 'max', minPlanTier: 3, displayName: 'Max Codex' })],
      ['future-codex', price('future-codex', { displayName: 'Future Codex' })],
      ['retired-codex', price('retired-codex', { displayName: 'Retired Codex' })],
    ]),
    securityEpoch: over?.epoch ?? SECURITY_EPOCH,
  })
}

const PUBLIC_AUTHZ: UserModelAuthz = {
  role: 'user',
  grantedModelIds: new Set(),
  deniedModelIds: new Set(),
  userPlanTier: null,
  orgPlanCode: null,
}

function admitBody(over: Record<string, unknown> = {}) {
  return {
    model: 'gpt-5.6-sol',
    engine: 'codex',
    agentId: 'auditor',
    delegateAgentId: 'auditor',
    sessionKey: 'agent:auditor:delegate:main:1',
    ...over,
  }
}

function makeRuntime(opts?: {
  journals?: Map<string, { user_id: string; container_id: string; ctx: Record<string, unknown> }>
  insufficient?: boolean
  snapshot?: ModelCatalogSnapshot
  authz?: UserModelAuthz | ((uid: bigint, requiredEpoch?: bigint) => Promise<UserModelAuthz>)
  catalogError?: Error
  journalAdmitted?: boolean
  agentMul?: string
  pricingGet?: (model: string) => ModelPricing | undefined
  advisorRoute?: import('../billing/advisorCodexAdmitRoute.js').AdvisorCodexAdmitRoute | (() => Promise<import('../billing/advisorCodexAdmitRoute.js').AdvisorCodexAdmitRoute>)
  advisorRouteThrow?: Error
}) {
  const journals =
    opts?.journals ??
    new Map<string, { user_id: string; container_id: string; ctx: Record<string, unknown> }>()
  const journalCalls: unknown[] = []
  const settleCalls: unknown[] = []
  const abortCalls: unknown[] = []
  const releaseCalls: unknown[] = []
  const precheckCalls: unknown[] = []
  const pricingGets: string[] = []
  const authzCalls: Array<{ uid: bigint; requiredEpoch?: bigint }> = []
  const advisorRouteCalls: unknown[] = []
  const expireCalls: string[] = []
  let assertFreshCalls = 0
  let snapshot = opts?.snapshot ?? defaultSnapshot()
  const runtime = createDelegateEngineBillingRuntime({
    getPool: () =>
      ({
        async query(sql: string, params?: unknown[]) {
          if (String(sql).includes('FROM request_finalize_journal')) {
            const row = journals.get(String(params?.[0]))
            return {
              rows: row
                ? [{ user_id: row.user_id, container_id: row.container_id, ctx: row.ctx }]
                : [],
            }
          }
          return { rows: [], rowCount: 0 }
        },
      }) as any,
    preCheckRedis: {} as any,
    pricing: {
      get(model: string) {
        pricingGets.push(model)
        if (opts?.pricingGet) return opts.pricingGet(model)
        return CACHE_DECOY
      },
    } as any,
    catalog: {
      async assertFresh() {
        assertFreshCalls += 1
        if (opts?.catalogError) throw opts.catalogError
        return snapshot
      },
    },
    loadUserModelAuthz: async (uid, requiredEpoch) => {
      authzCalls.push({ uid, requiredEpoch })
      if (typeof opts?.authz === 'function') return opts.authz(uid, requiredEpoch)
      return opts?.authz ?? PUBLIC_AUTHZ
    },
    newRequestId: () => REQUEST_ID,
    getAgentCostMultiplierFn: async () => opts?.agentMul ?? '1.000',
    preCheckWithCostFn: async (...args) => {
      precheckCalls.push(args)
      if (opts?.insufficient) {
        throw new InsufficientCreditsError(0n, 1n)
      }
      return {
        maxCost: 10n,
        balance: 100n,
        capped: false,
        originalMaxCost: 10n,
        reservation: { userId: '42', requestId: REQUEST_ID },
      }
    },
    startInflightJournalFn: async (_pool, ctx) => {
      journalCalls.push(ctx)
      if (opts?.journalAdmitted === false) return false
      journals.set(ctx.requestId, {
        user_id: String(ctx.userId),
        container_id: String(ctx.containerId),
        ctx: { model: ctx.model, ...(ctx.ctxJson ?? {}) },
      })
      return true
    },
    settleDurableCodexBillingFn: async (_deps, _userId, frame) => {
      settleCalls.push(frame)
      return 'committed'
    },
    abortInflightJournalFn: async (_pool, requestId) => {
      abortCalls.push(requestId)
      return true
    },
    createAdvisorCodexRoute: opts?.advisorRouteThrow
      ? async (args) => {
          advisorRouteCalls.push(args)
          throw opts.advisorRouteThrow
        }
      : opts?.advisorRoute
        ? async (args) => {
            advisorRouteCalls.push(args)
            return typeof opts.advisorRoute === 'function' ? opts.advisorRoute() : opts.advisorRoute!
          }
        : undefined,
    expireAdvisorCodexRoute: async (token) => {
      expireCalls.push(token)
    },
    releasePreCheckFn: async (redis, reservation) => {
      releaseCalls.push({ redis, reservation })
      return true
    },
  })
  return {
    runtime,
    journalCalls,
    settleCalls,
    abortCalls,
    journals,
    releaseCalls,
    precheckCalls,
    pricingGets,
    authzCalls,
    advisorRouteCalls,
    expireCalls,
    get assertFreshCalls() {
      return assertFreshCalls
    },
    replaceSnapshot(next: ModelCatalogSnapshot) {
      snapshot = next
    },
  }
}

describe('delegate engine-billing runtime', () => {
  it('admits a codex delegate with source + attribution in journal ctx', async () => {
    const { runtime, journalCalls } = makeRuntime()
    const result = await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: {
        model: 'gpt-5.6-sol',
        engine: 'codex',
        agentId: 'auditor',
        delegateAgentId: 'auditor',
        sessionKey: 'agent:auditor:delegate:main:1',
        parentSessionId: 'web-parent',
        parentTurnKey: 'c'.repeat(64),
      },
    })
    assert.equal(result.requestId, REQUEST_ID)
    assert.match(String(result.engineSessionId), /^oceng-[0-9a-f]{48}$/)
    assert.equal('route' in result, false)
    const ctx = journalCalls[0] as {
      model: string
      ctxJson: Record<string, unknown>
    }
    assert.equal(ctx.model, 'gpt-5.6-sol')
    assert.equal(ctx.ctxJson.source, 'delegate_codex')
    assert.equal(ctx.ctxJson.delegateAgentId, 'auditor')
    assert.equal(ctx.ctxJson.parentSessionId, 'web-parent')
    assert.equal(ctx.ctxJson.parentTurnKey, 'c'.repeat(64))
    assert.equal(ctx.ctxJson.durableBillingRecovery, 'lossless_turn_tape_v2')
    assert.ok(ctx.ctxJson.billingPricing)
  })

  it('admits grok without treating it as a Codex route mint', async () => {
    const { runtime, journalCalls } = makeRuntime()
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: {
        model: 'grok-build',
        engine: 'grok',
        agentId: 'coding-assistant',
        delegateAgentId: 'coding-assistant',
        sessionKey: 'agent:coding-assistant:delegate:main:1',
      },
    })
    assert.equal((journalCalls[0] as { ctxJson: { source: string } }).ctxJson.source, 'delegate_grok')
  })

  it('rejects glm/ccb-shaped models at admit', async () => {
    const { runtime, precheckCalls } = makeRuntime()
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: {
            model: 'glm-5.3-zai',
            engine: 'codex',
            agentId: 'auditor',
            delegateAgentId: 'auditor',
            sessionKey: 'agent:auditor:delegate:main:1',
          },
        }),
      /INVALID_ENGINE/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('fail-closes on insufficient credits', async () => {
    const { runtime, journalCalls } = makeRuntime({ insufficient: true })
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: {
            model: 'gpt-5.6-sol',
            engine: 'codex',
            agentId: 'auditor',
            delegateAgentId: 'auditor',
            sessionKey: 'agent:auditor:delegate:main:1',
          },
        }),
      /INSUFFICIENT_CREDITS/,
    )
    assert.equal(journalCalls.length, 0)
  })

  it('settles with journal-owned attribution that finalizer uses for mode=delegate', async () => {
    const { runtime, settleCalls, journals } = makeRuntime()
    journals.set(REQUEST_ID, {
      user_id: '42',
      container_id: '7',
      ctx: {
        source: 'delegate_codex',
        engineSessionId: `oceng-${'b'.repeat(48)}`,
        delegateAgentId: 'auditor',
        parentSessionId: 'web-parent',
        parentTurnKey: 'c'.repeat(64),
      },
    })
    const result = await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_SETTLE_PATH,
      identity: IDENTITY,
      body: {
        requestId: REQUEST_ID,
        engineSessionId: `oceng-${'b'.repeat(48)}`,
        status: 'success',
        durationMs: 12,
        usage: { input_tokens: 8, output_tokens: 3 },
      },
    })
    assert.deepEqual(result, { settled: true })
    const frame = settleCalls[0] as {
      delegateAgentId?: string
      parentSessionId?: string
      parentTurnKey?: string
      requestId: string
    }
    assert.equal(frame.requestId, REQUEST_ID)
    assert.equal(frame.delegateAgentId, 'auditor')
    assert.equal(frame.parentSessionId, 'web-parent')
    assert.equal(frame.parentTurnKey, 'c'.repeat(64))
    const finalizerAttribution = {
      parentTurnKey: frame.parentTurnKey ?? null,
      parentSessionId: frame.parentSessionId ?? null,
      delegateAgentId: frame.delegateAgentId ?? null,
    }
    const mode =
      finalizerAttribution.parentTurnKey ||
      finalizerAttribution.parentSessionId ||
      finalizerAttribution.delegateAgentId
        ? 'delegate'
        : 'chat'
    assert.equal(mode, 'delegate')
    assert.equal(finalizerAttribution.delegateAgentId, 'auditor')
  })

  it('prefers journal attribution when the billing frame disagrees', async () => {
    const { runtime, settleCalls, journals } = makeRuntime()
    journals.set(REQUEST_ID, {
      user_id: '42',
      container_id: '7',
      ctx: {
        source: 'delegate_codex',
        delegateAgentId: 'auditor',
        parentSessionId: 'web-journal',
        parentTurnKey: 'c'.repeat(64),
      },
    })
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_SETTLE_PATH,
      identity: IDENTITY,
      body: {
        requestId: REQUEST_ID,
        engineSessionId: `oceng-${'b'.repeat(48)}`,
        status: 'success',
        durationMs: 3,
        delegateAgentId: 'coding-assistant',
        parentSessionId: 'web-frame',
        parentTurnKey: 'd'.repeat(64),
      },
    })
    const frame = settleCalls[0] as {
      delegateAgentId?: string
      parentSessionId?: string
      parentTurnKey?: string
    }
    assert.equal(frame.delegateAgentId, 'auditor')
    assert.equal(frame.parentSessionId, 'web-journal')
    assert.equal(frame.parentTurnKey, 'c'.repeat(64))
    assert.deepEqual(
      resolveDelegateBillingAttribution(
        {
          delegateAgentId: 'auditor',
          parentSessionId: 'web-journal',
          parentTurnKey: 'c'.repeat(64),
        },
        {
          delegateAgentId: 'coding-assistant',
          parentSessionId: 'web-frame',
          parentTurnKey: 'd'.repeat(64),
        },
      ),
      {
        delegateAgentId: 'auditor',
        parentSessionId: 'web-journal',
        parentTurnKey: 'c'.repeat(64),
      },
    )
  })

  it('abandons the inflight journal', async () => {
    const { runtime, abortCalls, journals } = makeRuntime()
    journals.set(REQUEST_ID, {
      user_id: '42',
      container_id: '7',
      ctx: { source: 'delegate_grok' },
    })
    const result = await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ABANDON_PATH,
      identity: IDENTITY,
      body: { requestId: REQUEST_ID },
    })
    assert.deepEqual(result, { abandoned: true })
    assert.deepEqual(abortCalls, [REQUEST_ID])
  })

  it('admits a real 155-char taskboard patrol sessionKey without truncating it', async () => {
    assert.equal(TASKBOARD_SESSION_KEY_155.length, 155)
    const { runtime, journalCalls } = makeRuntime()
    const result = await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: {
        model: 'grok-build',
        engine: 'grok',
        agentId: 'stage-triage',
        delegateAgentId: 'stage-triage',
        sessionKey: TASKBOARD_SESSION_KEY_155,
      },
    })
    assert.equal(result.requestId, REQUEST_ID)
    assert.equal(result.engineSessionId, deriveEngineSessionId(TASKBOARD_SESSION_KEY_155))
    assert.equal(journalCalls.length, 1)
  })

  it('rejects illegal sessionKey characters and empty string', async () => {
    const { runtime, journalCalls } = makeRuntime()
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: {
            model: 'grok-build',
            engine: 'grok',
            agentId: 'stage-triage',
            delegateAgentId: 'stage-triage',
            sessionKey: `${TASKBOARD_SESSION_KEY_155.slice(0, 154)}/`,
          },
        }),
      /INVALID_SESSIONKEY/,
    )
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: {
            model: 'grok-build',
            engine: 'grok',
            agentId: 'stage-triage',
            delegateAgentId: 'stage-triage',
            sessionKey: `${TASKBOARD_SESSION_KEY_155.slice(0, 154)} `,
          },
        }),
      /INVALID_SESSIONKEY/,
    )
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: {
            model: 'grok-build',
            engine: 'grok',
            agentId: 'stage-triage',
            delegateAgentId: 'stage-triage',
            sessionKey: '',
          },
        }),
      /INVALID_SESSIONKEY/,
    )
    assert.equal(journalCalls.length, 0)
  })

  it('accepts 240-char sessionKey and rejects 241', async () => {
    const { runtime, journalCalls } = makeRuntime()
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: {
            model: 'grok-build',
            engine: 'grok',
            agentId: 'stage-triage',
            delegateAgentId: 'stage-triage',
            sessionKey: 'a'.repeat(DELEGATE_ENGINE_BILLING_SESSION_KEY_MAX_CHARS + 1),
          },
        }),
      /INVALID_SESSIONKEY/,
    )
    const boundary = 'a'.repeat(DELEGATE_ENGINE_BILLING_SESSION_KEY_MAX_CHARS)
    const result = await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: {
        model: 'grok-build',
        engine: 'grok',
        agentId: 'stage-triage',
        delegateAgentId: 'stage-triage',
        sessionKey: boundary,
      },
    })
    assert.equal(result.requestId, REQUEST_ID)
    assert.equal(result.engineSessionId, deriveEngineSessionId(boundary))
    assert.equal(journalCalls.length, 1)
  })
})

describe('delegate engine-billing admit uses one fenced snapshot', () => {
  it('loads fenced authz with snapshot.securityEpoch and does not read PricingCache', async () => {
    const rig = makeRuntime()
    const { runtime, authzCalls, pricingGets, journalCalls } = rig
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: admitBody(),
    })
    assert.equal(rig.assertFreshCalls, 1)
    assert.equal(authzCalls.length, 1)
    assert.equal(authzCalls[0]?.uid, 42n)
    assert.equal(authzCalls[0]?.requiredEpoch, SECURITY_EPOCH)
    assert.deepEqual(pricingGets, [])
    const ctx = journalCalls[0] as { model: string; ctxJson: Record<string, unknown> }
    const frozen = parseBillingPricing(ctx.ctxJson.billingPricing, 'gpt-5.6-sol')
    assert.ok(frozen)
    assert.equal(frozen.input_per_mtok, 1000n)
    assert.equal(frozen.multiplier, '1.000')
    const generation = ctx.ctxJson.catalogGeneration as { billingRevision: string; securityEpoch: string }
    assert.equal(generation.securityEpoch, String(SECURITY_EPOCH))
    assert.match(generation.billingRevision, /^[0-9a-f]{64}$/)
    assert.equal(generation.billingRevision, defaultSnapshot().billingRevision)
  })

  it('canonicalizes alias into journal.model and freezes snapshot price plus agent multiplier', async () => {
    const snap = defaultSnapshot({ prices: { 'gpt-5.6-sol': { multiplier: '2.000', inputPerMtok: 111n } } })
    const { runtime, journalCalls } = makeRuntime({ snapshot: snap, agentMul: '1.500' })
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: admitBody({ model: 'sol-alias' }),
    })
    const ctx = journalCalls[0] as { model: string; ctxJson: Record<string, unknown> }
    assert.equal(ctx.model, 'gpt-5.6-sol')
    const frozen = parseBillingPricing(ctx.ctxJson.billingPricing, 'gpt-5.6-sol')
    assert.ok(frozen)
    assert.equal(frozen.model_id, 'gpt-5.6-sol')
    assert.equal(frozen.input_per_mtok, 111n)
    assert.equal(frozen.multiplier, '3.000')
    const generation = ctx.ctxJson.catalogGeneration as { billingRevision: string }
    assert.equal(generation.billingRevision, snap.billingRevision)
  })

  it('rejects unknown model before reserve even if PricingCache has a row', async () => {
    const { runtime, precheckCalls, journalCalls } = makeRuntime({
      pricingGet: () => CACHE_DECOY,
    })
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody({ model: 'not-a-model' }),
        }),
      /MODEL_UNAVAILABLE/,
    )
    assert.equal(precheckCalls.length, 0)
    assert.equal(journalCalls.length, 0)
  })

  it('rejects disabled catalog rows before reserve', async () => {
    const { runtime, precheckCalls } = makeRuntime()
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody({ model: 'retired-codex' }),
        }),
      /MODEL_UNAVAILABLE/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('rejects future capability schema before reserve', async () => {
    const { runtime, precheckCalls } = makeRuntime()
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody({ model: 'future-codex' }),
        }),
      /CAPABILITY_UNSUPPORTED/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('rejects alias that canonicalizes onto another engine', async () => {
    const { runtime, precheckCalls } = makeRuntime()
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody({ model: 'cross-engine-alias', engine: 'codex' }),
        }),
      /INVALID_ENGINE/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('rejects grok engine requested for a codex canonical model', async () => {
    const { runtime, precheckCalls } = makeRuntime()
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody({ engine: 'grok' }),
        }),
      /INVALID_ENGINE/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('rejects hidden model without grant', async () => {
    const { runtime, precheckCalls } = makeRuntime()
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody({ model: 'hidden-codex' }),
        }),
      /NOT_AUTHORIZED/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('admits hidden model when grant is present', async () => {
    const { runtime, journalCalls } = makeRuntime({
      authz: { ...PUBLIC_AUTHZ, grantedModelIds: new Set(['hidden-codex']) },
    })
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: admitBody({ model: 'hidden-codex' }),
    })
    assert.equal((journalCalls[0] as { model: string }).model, 'hidden-codex')
  })

  it('rejects admin-only model for a user without grant', async () => {
    const { runtime, precheckCalls } = makeRuntime()
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody({ model: 'admin-codex' }),
        }),
      /NOT_AUTHORIZED/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('admits admin-only model for admin role', async () => {
    const { runtime, journalCalls } = makeRuntime({
      authz: { ...PUBLIC_AUTHZ, role: 'admin' },
    })
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: admitBody({ model: 'admin-codex' }),
    })
    assert.equal((journalCalls[0] as { model: string }).model, 'admin-codex')
  })

  it('rejects denied models even when they are public', async () => {
    const { runtime, precheckCalls } = makeRuntime({
      authz: { ...PUBLIC_AUTHZ, deniedModelIds: new Set(['gpt-5.6-sol']) },
    })
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody(),
        }),
      /NOT_AUTHORIZED/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('rejects max-plan models without personal or org entitlement', async () => {
    const { runtime, precheckCalls } = makeRuntime()
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody({ model: 'max-codex' }),
        }),
      /NOT_AUTHORIZED/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('admits max-plan models with org Max entitlement', async () => {
    const { runtime, journalCalls } = makeRuntime({
      authz: { ...PUBLIC_AUTHZ, orgPlanCode: 'org-max' },
    })
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: admitBody({ model: 'max-codex' }),
    })
    assert.equal((journalCalls[0] as { model: string }).model, 'max-codex')
  })

  it('admits max-plan models with personal tier at the floor', async () => {
    const { runtime, journalCalls } = makeRuntime({
      authz: { ...PUBLIC_AUTHZ, userPlanTier: 3 },
    })
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: admitBody({ model: 'max-codex' }),
    })
    assert.equal((journalCalls[0] as { model: string }).model, 'max-codex')
  })

  it('fail-closes catalog assertFresh errors before reserve', async () => {
    const { runtime, precheckCalls, journalCalls } = makeRuntime({
      catalogError: new Error('db down'),
    })
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody(),
        }),
      /CATALOG_UNAVAILABLE/,
    )
    assert.equal(precheckCalls.length, 0)
    assert.equal(journalCalls.length, 0)
  })

  it('fail-closes epoch mismatch before reserve', async () => {
    const { runtime, precheckCalls } = makeRuntime({
      authz: async (_uid, requiredEpoch) => {
        throw new UserModelAuthzEpochMismatchError(requiredEpoch ?? 0n, 99n)
      },
    })
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody(),
        }),
      /EPOCH_MISMATCH/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('fail-closes authz DB failures before reserve', async () => {
    const { runtime, precheckCalls } = makeRuntime({
      authz: async () => {
        throw new Error('users table missing')
      },
    })
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody(),
        }),
      /AUTHZ_UNAVAILABLE/,
    )
    assert.equal(precheckCalls.length, 0)
  })

  it('releases the reservation when journal insert fails after admit checks', async () => {
    const { runtime, releaseCalls, precheckCalls } = makeRuntime({ journalAdmitted: false })
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody(),
        }),
      /JOURNAL_CONFLICT/,
    )
    assert.equal(precheckCalls.length, 1)
    assert.equal(releaseCalls.length, 1)
    assert.deepEqual((releaseCalls[0] as { reservation: { requestId: string } }).reservation, {
      userId: '42',
      requestId: REQUEST_ID,
    })
  })

  it('keeps frozen snapshot price after catalog and cache prices change', async () => {
    const admitted = defaultSnapshot({ prices: { 'gpt-5.6-sol': { inputPerMtok: 111n, multiplier: '2.000' } } })
    const later = defaultSnapshot({ prices: { 'gpt-5.6-sol': { inputPerMtok: 777n, multiplier: '9.000' } } })
    const { runtime, journals, journalCalls, replaceSnapshot } = makeRuntime({
      snapshot: admitted,
      agentMul: '1.500',
    })
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: admitBody(),
    })
    const frozenAtAdmit = parseBillingPricing(
      (journalCalls[0] as { ctxJson: { billingPricing: unknown } }).ctxJson.billingPricing,
      'gpt-5.6-sol',
    )
    assert.ok(frozenAtAdmit)
    assert.equal(frozenAtAdmit.input_per_mtok, 111n)
    assert.equal(frozenAtAdmit.multiplier, '3.000')
    replaceSnapshot(later)
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_SETTLE_PATH,
      identity: IDENTITY,
      body: {
        requestId: REQUEST_ID,
        status: 'success',
        durationMs: 4,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const stillFrozen = parseBillingPricing(journals.get(REQUEST_ID)?.ctx.billingPricing, 'gpt-5.6-sol')
    assert.ok(stillFrozen)
    assert.equal(stillFrozen.input_per_mtok, 111n)
    assert.equal(stillFrozen.multiplier, '3.000')
    assert.notEqual(stillFrozen.input_per_mtok, later.billingPricingFor('gpt-5.6-sol')?.input_per_mtok)
  })

  it('advisor official_oauth returns kind metadata without a hardcoded loopback URL', async () => {
    const { runtime, advisorRouteCalls, journalCalls } = makeRuntime({
      advisorRoute: { kind: 'official_oauth', groupId: '9' },
    })
    const result = await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: admitBody({ agentId: 'advisor', delegateAgentId: 'advisor', model: 'gpt-5.6-sol' }),
    })
    assert.deepEqual(result.route, { kind: 'official_oauth', groupId: '9' })
    assert.equal(JSON.stringify(result).includes('18789'), false)
    assert.equal((advisorRouteCalls[0] as { modelId: string; containerId: number }).modelId, 'gpt-5.6-sol')
    assert.equal((advisorRouteCalls[0] as { containerId: number }).containerId, 7)
    assert.equal((journalCalls[0] as { ctxJson: { advisorRouteKind: string } }).ctxJson.advisorRouteKind, 'official_oauth')
  })

  it('advisor api_relay stores the opaque token and expires it on abandon', async () => {
    const token = 'cd'.repeat(32)
    const { runtime, journals, expireCalls } = makeRuntime({
      advisorRoute: {
        kind: 'api_relay',
        token,
        modelProvider: 'api111',
        providerName: 'Yunwu',
        wireApi: 'responses',
        preferredAuthMethod: 'apikey',
        disableResponseStorage: true,
      },
    })
    const result = await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: admitBody({ agentId: 'advisor', delegateAgentId: 'advisor' }),
    })
    assert.equal((result.route as { kind: string }).kind, 'api_relay')
    assert.equal((result.route as { token: string }).token, token)
    assert.equal('baseUrl' in (result.route as object), false)
    assert.equal(journals.get(REQUEST_ID)?.ctx.advisorRouteToken, token)
    await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ABANDON_PATH,
      identity: IDENTITY,
      body: { requestId: REQUEST_ID },
    })
    assert.deepEqual(expireCalls, [token])
  })

  it('advisor unavailable still returns the original requestId', async () => {
    const { runtime, abortCalls, journalCalls } = makeRuntime({
      advisorRoute: { kind: 'unavailable', reason: 'no_bound_codex_account' },
    })
    const result = await runtime.handle({
      path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
      identity: IDENTITY,
      body: admitBody({ agentId: 'advisor', delegateAgentId: 'advisor' }),
    })
    assert.equal(result.requestId, REQUEST_ID)
    assert.deepEqual(result.route, { kind: 'unavailable', reason: 'no_bound_codex_account' })
    assert.equal(journalCalls.length, 1)
    assert.equal(abortCalls.length, 0)
  })

  it('advisor selector throw after precheck releases reservation and does not journal', async () => {
    const { runtime, journalCalls, releaseCalls, abortCalls } = makeRuntime({
      advisorRouteThrow: new Error('db down'),
    })
    await assert.rejects(
      () =>
        runtime.handle({
          path: DELEGATE_ENGINE_BILLING_ADMIT_PATH,
          identity: IDENTITY,
          body: admitBody({ agentId: 'advisor', delegateAgentId: 'advisor' }),
        }),
      /ROUTE_UNAVAILABLE/,
    )
    assert.equal(journalCalls.length, 0)
    assert.equal(releaseCalls.length, 1)
    assert.equal(abortCalls.length, 0)
  })
})
