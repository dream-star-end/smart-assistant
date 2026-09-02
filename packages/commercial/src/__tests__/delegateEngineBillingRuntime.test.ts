import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  createDelegateEngineBillingRuntime,
  resolveDelegateBillingAttribution,
} from '../billing/delegateEngineBillingRuntime.js'
import {
  DELEGATE_ENGINE_BILLING_ABANDON_PATH,
  DELEGATE_ENGINE_BILLING_ADMIT_PATH,
  DELEGATE_ENGINE_BILLING_SETTLE_PATH,
} from '../http/internalDelegateEngineBilling.js'
import { InsufficientCreditsError } from '../billing/preCheck.js'
import type { ModelPricing } from '../billing/pricing.js'

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

const GROK_PRICING: ModelPricing = { ...PRICING, model_id: 'grok-build', display_name: 'Grok Build' }

const IDENTITY = { userId: 42, containerId: 7 }
const REQUEST_ID = 'ab'.repeat(16)

function makeRuntime(opts?: {
  journals?: Map<string, { user_id: string; container_id: string; ctx: Record<string, unknown> }>
  insufficient?: boolean
}) {
  const journals =
    opts?.journals ??
    new Map<string, { user_id: string; container_id: string; ctx: Record<string, unknown> }>()
  const journalCalls: unknown[] = []
  const settleCalls: unknown[] = []
  const abortCalls: unknown[] = []
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
        if (model === 'gpt-5.6-sol') return PRICING
        if (model === 'grok-build') return GROK_PRICING
        return undefined
      },
    } as any,
    newRequestId: () => REQUEST_ID,
    getAgentCostMultiplierFn: async () => '1.000',
    preCheckWithCostFn: async () => {
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
    releasePreCheckFn: async () => true,
  })
  return { runtime, journalCalls, settleCalls, abortCalls, journals }
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
    const { runtime } = makeRuntime()
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
      /PRICING_UNAVAILABLE/,
    )
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
})
