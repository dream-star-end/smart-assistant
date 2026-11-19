import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { signAccess } from '../auth/jwt.js'
import { formatMessageReplyPrompt } from '@openclaude/protocol'
import { applyAdmittedServiceTierToFrame, composeCodexTurnPricing, resolveTakenOverCodexBilling } from '../billing/codexServiceTierPricing.js'
import { serializeBillingPricing } from '../billing/persistedBillingPricing.js'
import { settleDurableCodexBilling } from '../billing/durableCodexBilling.js'
import { ModelSwitchCostService, ModelSwitchCostError } from '../billing/modelSwitchCost.js'
import type { SwitchContext } from '../billing/modelSwitchCostContext.js'
import { InMemoryPreCheckRedis } from '../billing/preCheck.js'
import { PricingCache, type ModelPricing } from '../billing/pricing.js'
import type { CommercialHttpDeps } from '../http/handlers.js'
import { handleModelSwitchCost } from '../http/modelSwitchCost.js'
import { HttpError } from '../http/util.js'

function makePrice(id: string, input = 100, output = 400, multiplier = '1.000'): ModelPricing {
  return {
    model_id: id,
    display_name: id,
    input_per_mtok: BigInt(input),
    output_per_mtok: BigInt(output),
    cache_read_per_mtok: 10n,
    cache_write_per_mtok: 0n,
    multiplier,
    enabled: true,
    sort_order: 0,
    visibility: 'public',
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(0),
  }
}

describe('OCV5-798 composeCodexTurnPricing', () => {
  it('composes 2x Fast on active local Codex GPT-6 and 6x Ultrafast exclusively on 6.2-sol(-1m)', () => {
    const sol = makePrice('gpt-6.2-sol')
    assert.deepEqual(composeCodexTurnPricing(sol, '1.000', 'gpt-6.2-sol', null), {
      pricing: { ...sol, multiplier: '1.000' },
      serviceTier: null,
    })
    assert.deepEqual(composeCodexTurnPricing(sol, '0.500', 'gpt-6.2-sol', 'fast'), {
      pricing: { ...sol, multiplier: '1.000' },
      serviceTier: 'fast',
    })
    assert.deepEqual(composeCodexTurnPricing(sol, '0.500', 'gpt-6.2-sol', 'ultrafast'), {
      pricing: { ...sol, multiplier: '3.000' },
      serviceTier: 'ultrafast',
    })
    const sol1m = makePrice('gpt-6.2-sol-1m', 100, 400, '1.500')
    assert.deepEqual(composeCodexTurnPricing(sol1m, '1.000', 'gpt-6.2-sol-1m', 'ultrafast'), {
      pricing: { ...sol1m, multiplier: '9.000' },
      serviceTier: 'ultrafast',
    })

    const astra = makePrice('gpt-6.2-astra')
    assert.deepEqual(composeCodexTurnPricing(astra, '1.000', 'gpt-6.2-astra', 'fast'), {
      pricing: { ...astra, multiplier: '2.000' },
      serviceTier: 'fast',
    })
    assert.deepEqual(composeCodexTurnPricing(astra, '1.000', 'gpt-6.2-astra', 'ultrafast'), {
      pricing: { ...astra, multiplier: '1.000' },
      serviceTier: null,
    })

    const remote = makePrice('gpt-6-luna-remote', 53, 265, '0.400')
    assert.deepEqual(composeCodexTurnPricing(remote, '1.000', 'gpt-6-luna-remote', 'fast'), {
      pricing: { ...remote, multiplier: '0.400' },
      serviceTier: null,
    })
  })


  it('clamps advisor read-only main turn & legacy gateway without speed-tier capability to 1x', () => {
    const sol = makePrice('gpt-6.2-sol', 100, 400, '1.000')
    assert.deepEqual(
      composeCodexTurnPricing(sol, '1.000', 'gpt-6.2-sol', 'ultrafast', {
        agentId: 'main',
        collabMode: 'advisor',
        advisorModel: 'gpt-6.2-astra',
        text: '请只分析原因，不要修改任何文件',
        gatewaySupportsSpeedTiers: true,
      }),
      { pricing: { ...sol, multiplier: '1.000' }, serviceTier: null },
    )
    assert.deepEqual(
      composeCodexTurnPricing(sol, '1.000', 'gpt-6.2-sol', 'fast', {
        agentId: 'main',
        collabMode: 'solo',
        text: 'hello',
        gatewaySupportsSpeedTiers: false,
      }),
      { pricing: { ...sol, multiplier: '1.000' }, serviceTier: null },
    )
    assert.deepEqual(
      applyAdmittedServiceTierToFrame({ type: 'inbound.message', serviceTier: 'ultrafast' }, null),
      { type: 'inbound.message' },
    )
  })

  it('settleDurableCodexBilling legacy fallback composes ctx.serviceTier=ultrafast at 6x', async () => {
    const sol = makePrice('gpt-6.2-sol', 100, 500, '1.000')
    const pricing = new PricingCache()
    pricing._setForTests([sol])
    const requestId = '1'.repeat(32)
    const turnKey = '2'.repeat(64)
    const engineSessionId = `oceng-${'3'.repeat(48)}`
    const redis = new InMemoryPreCheckRedis()
    await redis.atomicReserve({
      userId: 42n,
      requestId,
      balance: 1_000_000n,
      maxCost: 10_000n,
      ttlSeconds: 60,
    })
    let walletAfter: string | null = null
    const client = {
      async query(sqlOrConfig: unknown, params?: unknown[]) {
        const sql = typeof sqlOrConfig === 'string'
          ? sqlOrConfig
          : (sqlOrConfig as { text: string }).text
        const trimmed = sql.trim()
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(trimmed)) {
          return { rows: [], rowCount: 0 }
        }
        if (trimmed.startsWith('SELECT pg_advisory_xact_lock')) {
          return { rows: [{}], rowCount: 1 }
        }
        if (trimmed.startsWith('SELECT 1 FROM turn_waivers')) {
          return { rows: [], rowCount: 0 }
        }
        if (trimmed.startsWith('SELECT m.org_id')) {
          return { rows: [], rowCount: 0 }
        }
        if (trimmed.startsWith('INSERT INTO usage_records')) {
          return { rows: [{ id: '100' }], rowCount: 1 }
        }
        if (trimmed.startsWith('SELECT credits::text AS credits FROM users')) {
          return { rows: [{ credits: '1000000' }], rowCount: 1 }
        }
        if (trimmed.startsWith('SELECT id::text AS id, period_credits::text')) {
          return { rows: [], rowCount: 0 }
        }
        if (trimmed.startsWith('UPDATE users SET credits')) {
          walletAfter = String(params?.[0] ?? '')
          return { rows: [], rowCount: 1 }
        }
        if (trimmed.startsWith('INSERT INTO credit_ledger')) {
          return { rows: [{ id: '200' }], rowCount: 1 }
        }
        if (trimmed.startsWith('UPDATE usage_records SET ledger_id')) {
          return { rows: [], rowCount: 1 }
        }
        if (trimmed.startsWith('INSERT INTO pending_usage_patches')) {
          return { rows: [], rowCount: 1 }
        }
        if (/FROM client_sessions cs/.test(trimmed) && /board_project_id/.test(trimmed)) {
          return { rows: [], rowCount: 0 }
        }
        throw new Error(`unhandled fake client SQL: ${trimmed.slice(0, 120)}`)
      },
      release() {},
    } as unknown as PoolClient
    const pool = {
      async connect() {
        return client
      },
      async query(sqlOrConfig: unknown) {
        const sql = typeof sqlOrConfig === 'string'
          ? sqlOrConfig
          : (sqlOrConfig as { text: string }).text
        const trimmed = sql.trim()
        if (trimmed.startsWith('SELECT state, user_id::text AS user_id, ctx')) {
          return {
            rows: [{
              state: 'inflight',
              user_id: '42',
              ctx: { model: 'gpt-6.2-sol', agentId: 'codex', serviceTier: 'ultrafast' },
              error_msg: null,
            }],
            rowCount: 1,
          }
        }
        if (trimmed.includes('FROM usage_records ur')) {
          return { rows: [], rowCount: 0 }
        }
        if (trimmed.includes('FROM agent_cost_overrides')) {
          return { rows: [], rowCount: 0 }
        }
        if (trimmed.startsWith('UPDATE request_finalize_journal')) {
          return { rows: [], rowCount: 1 }
        }
        if (trimmed.includes('UPDATE product_friction_events')) {
          return { rows: [], rowCount: 0 }
        }
        throw new Error(`unhandled fake pool SQL: ${trimmed.slice(0, 120)}`)
      },
    } as unknown as Pool
    const outcome = await settleDurableCodexBilling(
      { pgPool: pool, preCheckRedis: redis, pricing },
      42n,
      {
        requestId,
        turnKey,
        engineSessionId,
        status: 'success',
        durationMs: 500,
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      },
    )
    assert.equal(outcome, 'committed')
    assert.ok(walletAfter !== null)
    // (100 + 500) * 6.000 = 3600 credits debited
    assert.equal(1_000_000n - BigInt(walletAfter), 3600n)
  })
})

describe('OCV5-798 ModelSwitchCostService + HTTP validation for Codex speed tiers', () => {
  it('applies 2x Fast and 6x Ultrafast to Codex quotes and rejects stale quotes across tier changes', async () => {
    const deepseek = makePrice('deepseek-v4-flash', 20, 40, '1.000')
    const sol = makePrice('gpt-6.2-sol', 500, 2000, '1.000')
    const astra = makePrice('gpt-6.2-astra', 598, 3598, '1.000')
    const pricing = new PricingCache()
    pricing._setForTests([deepseek, sol, astra])
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool
    const context: SwitchContext = {
      revision: 1,
      fingerprint: 'ctx-1',
      sourceModel: deepseek.model_id,
      sourceAgent: 'main',
      tokens: 200_000,
      source: 'last-call',
      warmRatio: 0,
      outputs: [500],
      calls: 1,
      lastOutputTokens: 500,
    }
    const service = new ModelSwitchCostService({
      pool,
      pricing,
      secret: 'codex-tier-switch-cost-secret',
      balance: async () => 1_000_000n,
      sourceEngine: () => 'ccb',
      resolveTarget: async (_uid, id) => ({
        pricing: id === 'gpt-6.2-astra' ? astra : sol,
        engine: 'codex',
        contextWindow: 1_000_000,
      }),
      readContext: async () => ({ ...context }),
    })

    const stdQuote = await service.quote('765', {
      sessionId: 's1',
      requestId: 'r-std',
      targetModel: 'gpt-6.2-sol',
      agentId: 'main',
    })
    const fastQuote = await service.quote('765', {
      sessionId: 's1',
      requestId: 'r-fast',
      targetModel: 'gpt-6.2-sol',
      agentId: 'main',
      serviceTier: 'fast',
    })
    const ultraQuote = await service.quote('765', {
      sessionId: 's1',
      requestId: 'r-ultra',
      targetModel: 'gpt-6.2-sol',
      agentId: 'main',
      serviceTier: 'ultrafast',
    })
    assert.equal(fastQuote.targetUnitPrice?.input, String(Number(stdQuote.targetUnitPrice?.input) * 2))
    assert.equal(ultraQuote.targetUnitPrice?.input, String(Number(stdQuote.targetUnitPrice?.input) * 6))
    assert.equal(ultraQuote.requiresConfirmation, true)

    const astraUltraQuote = await service.quote('765', {
      sessionId: 's1',
      requestId: 'r-astra-u',
      targetModel: 'gpt-6.2-astra',
      agentId: 'main',
      serviceTier: 'ultrafast',
    })
    const astraStdQuote = await service.quote('765', {
      sessionId: 's1',
      requestId: 'r-astra-s',
      targetModel: 'gpt-6.2-astra',
      agentId: 'main',
    })
    assert.equal(astraUltraQuote.targetUnitPrice?.input, astraStdQuote.targetUnitPrice?.input)

    const confirmed = await service.confirm(
      '765',
      {
        sessionId: 's1',
        requestId: 'r-ultra',
        targetModel: 'gpt-6.2-sol',
        agentId: 'main',
        serviceTier: 'ultrafast',
      },
      ultraQuote.quoteToken!,
    )
    assert.equal(confirmed.requiresConfirmation, false)
    assert.ok(confirmed.consent)

    // Same tier + consent succeeds; changing tier to fast invalidates consent / quote.
    await service.assertAuthorized(
      '765',
      {
        sessionId: 's1',
        requestId: 'r-ultra',
        targetModel: 'gpt-6.2-sol',
        agentId: 'main',
        serviceTier: 'ultrafast',
      },
      confirmed.consent,
    )
    await assert.rejects(
      service.assertAuthorized(
        '765',
        {
          sessionId: 's1',
          requestId: 'r-ultra',
          targetModel: 'gpt-6.2-sol',
          agentId: 'main',
          serviceTier: 'fast',
        },
        confirmed.consent,
      ),
      (e) => e instanceof ModelSwitchCostError && e.code === 'MODEL_SWITCH_CONFIRMATION_REQUIRED',
    )
    await assert.rejects(
      service.confirm(
        '765',
        {
          sessionId: 's1',
          requestId: 'r-ultra',
          targetModel: 'gpt-6.2-sol',
          agentId: 'main',
          serviceTier: 'fast',
        },
        ultraQuote.quoteToken!,
      ),
      (e) => e instanceof ModelSwitchCostError && e.code === 'MODEL_SWITCH_QUOTE_CHANGED',
    )
  })

  it('HTTP handler accepts serviceTier=ultrafast and rejects unknown tier strings', async () => {
    const jwtSecret = 'model-switch-http-test-secret-only-32-bytes'
    const { token } = await signAccess({ sub: '765', role: 'user' }, jwtSecret)
    const mkReq = (body: Record<string, unknown>) => {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage
      req.headers = { authorization: `Bearer ${token}` }
      req.url = '/api/me/sessions/own/model-switch-estimate'
      return req
    }
    const seen: unknown[] = []
    const service = {
      validateTarget: async () => {},
      quote: async (_uid: string, input: unknown) => {
        seen.push(input)
        return { mode: 'exempt' }
      },
      confirm: async () => ({}),
    }
    const fakeRes = { setHeader: () => {}, end: () => {}, statusCode: 200 } as unknown as ServerResponse
    await handleModelSwitchCost(
      mkReq({
        requestId: 'm-http-ultra',
        targetModel: 'gpt-6.2-sol',
        agentId: 'main',
        serviceTier: 'ultrafast',
      }),
      fakeRes,
      { jwtSecret, modelSwitchCost: service } as unknown as CommercialHttpDeps,
    )
    assert.equal((seen[0] as { serviceTier?: string }).serviceTier, 'ultrafast')

    await assert.rejects(
      handleModelSwitchCost(
        mkReq({
          requestId: 'm-http-bad',
          targetModel: 'gpt-6.2-sol',
          agentId: 'main',
          serviceTier: 'priority',
        }),
        fakeRes,
        { jwtSecret, modelSwitchCost: service } as unknown as CommercialHttpDeps,
      ),
      (e) => e instanceof HttpError && e.status === 400,
    )
  })

  it('resolves catalog alias before normalizing Ultrafast 6x and clamps advisor no-write switch quotes to 1x', async () => {
    const deepseek = makePrice('deepseek-v4-flash', 20, 40, '1.000')
    const sol = makePrice('gpt-6.2-sol', 500, 2000, '1.000')
    const pricing = new PricingCache()
    pricing._setForTests([deepseek, sol])
    const pool = { query: async () => ({ rows: [] }) } as unknown as Pool
    const context: SwitchContext = {
      revision: 1,
      fingerprint: 'ctx-alias',
      sourceModel: deepseek.model_id,
      sourceAgent: 'main',
      tokens: 200_000,
      source: 'last-call',
      warmRatio: 0,
      outputs: [500],
      calls: 1,
      lastOutputTokens: 500,
    }
    const service = new ModelSwitchCostService({
      pool,
      pricing,
      secret: 'codex-tier-alias-secret',
      balance: async () => 10_000_000n,
      sourceEngine: () => 'ccb',
      resolveTarget: async (_uid, id) => ({
        pricing: id === 'sol-alias' || id === 'gpt-6.2-sol' ? sol : deepseek,
        engine: 'codex',
        contextWindow: 1_000_000,
        canonicalize: (m) => (m === 'sol-alias' ? 'gpt-6.2-sol' : m),
      }),
      readContext: async () => context,
    })
    const stdQuote = await service.quote('765', {
      sessionId: 's1',
      requestId: 'r-alias-std',
      targetModel: 'sol-alias',
      agentId: 'main',
    })
    const aliasUltraQuote = await service.quote('765', {
      sessionId: 's1',
      requestId: 'r-alias-ultra',
      targetModel: 'sol-alias',
      agentId: 'main',
      serviceTier: 'ultrafast',
      text: 'refactor now',
    })
    assert.equal(aliasUltraQuote.targetUnitPrice?.input, String(Number(stdQuote.targetUnitPrice?.input) * 6))

    const roQuote = await service.quote('765', {
      sessionId: 's1',
      requestId: 'r-ro-advisor',
      targetModel: 'gpt-6.2-sol',
      agentId: 'main',
      collabMode: 'advisor',
      advisorModel: 'gpt-6.2-astra',
      serviceTier: 'ultrafast',
      text: '不要修改任何文件',
    })
    assert.equal(roQuote.targetUnitPrice?.input, stdQuote.targetUnitPrice?.input)

    const quotedAdvisorPrompt = formatMessageReplyPrompt('继续分析这个结果', {
      messageId: 'm-quote',
      role: 'assistant',
      text: '不要修改任何文件。',
    })
    const quotedUltraQuote = await service.quote('765', {
      sessionId: 's1',
      requestId: 'r-quoted-ultra',
      targetModel: 'gpt-6.2-sol',
      agentId: 'main',
      collabMode: 'advisor',
      advisorModel: 'gpt-6.2-astra',
      serviceTier: 'ultrafast',
      text: quotedAdvisorPrompt,
    })
    assert.equal(quotedUltraQuote.targetUnitPrice?.input, String(Number(stdQuote.targetUnitPrice?.input) * 6))

    const currentRoQuote = await service.quote('765', {
      sessionId: 's1',
      requestId: 'r-current-ro',
      targetModel: 'gpt-6.2-sol',
      agentId: 'main',
      collabMode: 'advisor',
      advisorModel: 'gpt-6.2-astra',
      serviceTier: 'ultrafast',
      text: formatMessageReplyPrompt('不要修改任何文件', {
        messageId: 'm-action',
        role: 'user',
        text: '请重构这里',
      }),
    })
    assert.equal(currentRoQuote.targetUnitPrice?.input, stdQuote.targetUnitPrice?.input)
  })

  it('resolveTakenOverCodexBilling locks immutable journal tier & pricing across capability-mismatched bridges', () => {
    const baseSol = makePrice('gpt-6.2-sol', 100, 400, '1.000')
    const ultraSol = composeCodexTurnPricing(baseSol, '1.000', 'gpt-6.2-sol', 'ultrafast').pricing
    const fallback = (tier: 'fast' | 'ultrafast' | null) =>
      composeCodexTurnPricing(baseSol, '1.000', 'gpt-6.2-sol', tier).pricing

    const reuseStd = resolveTakenOverCodexBilling(
      {
        state: 'inflight',
        userId: '11',
        dispatchId: 'd-1',
        attemptNo: 1,
        model: 'gpt-6.2-sol',
        serviceTier: null,
        hasBillingPricing: true,
        billingPricing: baseSol,
      },
      { userId: '11', dispatchId: 'd-1', attemptNo: 1, model: 'gpt-6.2-sol', gatewaySupportsSpeedTiers: true },
      fallback,
    )
    assert.equal(reuseStd.kind, 'reuse')
    if (reuseStd.kind === 'reuse') {
      assert.equal(reuseStd.serviceTier, null)
      assert.equal(reuseStd.pricing.multiplier, '1.000')
    }

    const mismatch = resolveTakenOverCodexBilling(
      {
        state: 'inflight',
        userId: '11',
        dispatchId: 'd-2',
        attemptNo: 1,
        model: 'gpt-6.2-sol',
        serviceTier: 'ultrafast',
        hasBillingPricing: true,
        billingPricing: ultraSol,
      },
      { userId: '11', dispatchId: 'd-2', attemptNo: 1, model: 'gpt-6.2-sol', gatewaySupportsSpeedTiers: false },
      fallback,
    )
    assert.equal(mismatch.kind, 'capability_mismatch')

    const reuseUltra = resolveTakenOverCodexBilling(
      {
        state: 'inflight',
        userId: '11',
        dispatchId: 'd-2',
        attemptNo: 1,
        model: 'gpt-6.2-sol',
        serviceTier: 'ultrafast',
        hasBillingPricing: true,
        billingPricing: ultraSol,
      },
      { userId: '11', dispatchId: 'd-2', attemptNo: 1, model: 'gpt-6.2-sol', gatewaySupportsSpeedTiers: true },
      fallback,
    )
    assert.equal(reuseUltra.kind, 'reuse')
    if (reuseUltra.kind === 'reuse') {
      assert.equal(reuseUltra.serviceTier, 'ultrafast')
      assert.equal(reuseUltra.pricing.multiplier, '6.000')
    }

    const badTier = resolveTakenOverCodexBilling(
      {
        state: 'inflight',
        userId: '11',
        dispatchId: 'd-3',
        attemptNo: 1,
        model: 'gpt-6.2-sol',
        serviceTier: 'invalid',
        hasBillingPricing: true,
        billingPricing: baseSol,
      },
      { userId: '11', dispatchId: 'd-3', attemptNo: 1, model: 'gpt-6.2-sol', gatewaySupportsSpeedTiers: true },
      fallback,
    )
    assert.equal(badTier.kind, 'conflict')

    const badBp = resolveTakenOverCodexBilling(
      {
        state: 'inflight',
        userId: '11',
        dispatchId: 'd-4',
        attemptNo: 1,
        model: 'gpt-6.2-sol',
        serviceTier: null,
        hasBillingPricing: true,
        billingPricing: null,
      },
      { userId: '11', dispatchId: 'd-4', attemptNo: 1, model: 'gpt-6.2-sol', gatewaySupportsSpeedTiers: true },
      fallback,
    )
    assert.equal(badBp.kind, 'conflict')
    assert.equal(serializeBillingPricing(ultraSol).multiplier, '6.000')
  })
})
