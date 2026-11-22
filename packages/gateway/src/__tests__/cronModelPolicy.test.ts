import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_MODEL_AUTO } from '@openclaude/protocol'
import {
  checkCronOriginModelConflict,
  normalizeCronEffortField,
  normalizeCronModelField,
  resolveCronJobExecution,
} from '../cronModelPolicy.js'
import {
  _setModelCatalogClientForTests,
  type LocalCatalogView,
} from '../modelCatalogClient.js'
import { AntigravityAdapter } from '../engine/antigravityAdapter.js'
import { GrokAdapter } from '../engine/grokAdapter.js'
import { handleCronApi, handleCronItem, type CronTaskWebhookHost } from '../cronTaskWebhook.js'

function mockCatalogView(): LocalCatalogView {
  const rows = new Map([
    ['gpt-5.6-sol', { modelId: 'gpt-5.6-sol', engine: 'codex' as const, supportsVision: true, available: true }],
    ['deepseek-v4-flash', { modelId: 'deepseek-v4-flash', engine: 'ccb' as const, supportsVision: false, available: true }],
    ['glm-5.3', { modelId: 'glm-5.3', engine: 'ccb' as const, supportsVision: true, available: true }],
    ['grok-build', { modelId: 'grok-build', engine: 'grok' as const, supportsVision: true, available: true }],
    ['antigravity-gemini-4-carbon', { modelId: 'antigravity-gemini-4-carbon', engine: 'antigravity' as const, supportsVision: true, available: true }],
  ])
  return {
    models: [...rows.values()],
    canonicalize: (m: string) => m,
    isRoutable: (m: string) => rows.has(m),
    resolve: (m: string) => rows.get(m),
  } as unknown as LocalCatalogView
}

afterEach(() => {
  _setModelCatalogClientForTests(null)
})

describe('cronModelPolicy field normalization & origin-session conflict (B4)', () => {
  it('accepts omitted/empty model and effort for legacy job compatibility', () => {
    assert.deepEqual(normalizeCronModelField(undefined), { ok: true, value: undefined })
    assert.deepEqual(normalizeCronModelField(''), { ok: true, value: undefined })
    assert.deepEqual(normalizeCronModelField('  glm-5.3  '), { ok: true, value: 'glm-5.3' })
    assert.deepEqual(normalizeCronEffortField(undefined), { ok: true, value: undefined })
    assert.deepEqual(normalizeCronEffortField('  HIGH '), { ok: true, value: 'high' })
  })

  it('rejects malformed model or unsupported effort values', () => {
    assert.equal(normalizeCronModelField(123).ok, false)
    assert.equal(normalizeCronModelField('bad model with spaces').ok, false)
    assert.equal(normalizeCronEffortField('ultra-turbo').ok, false)
    assert.equal(normalizeCronEffortField(42).ok, false)
  })

  it('B4: rejects origin-session combined with model or effort, allows isolated or origin without overrides', () => {
    assert.ok(checkCronOriginModelConflict({ resume: 'origin-session', model: 'glm-5.3' }))
    assert.ok(checkCronOriginModelConflict({ resume: 'origin-session', effort: 'high' }))
    assert.equal(checkCronOriginModelConflict({ resume: 'origin-session' }), null)
    assert.equal(checkCronOriginModelConflict({ resume: 'origin-session', model: '', effort: '' }), null)
    assert.equal(checkCronOriginModelConflict({ resume: 'isolated', model: 'glm-5.3', effort: 'high' }), null)
  })

  it('B4 HTTP: POST /api/cron and PUT /api/cron/:id reject origin-session + model/effort with HTTP 400', async () => {
    const errors: Array<{ status: number; message: string }> = []
    let addCalls = 0
    let updateCalls = 0
    const makeHost = (bodyObj: Record<string, unknown>): CronTaskWebhookHost =>
      ({
        cron: {
          addJob: async () => { addCalls++ },
          updateJob: async () => { updateCalls++; return true },
          listJobsWithMeta: async () => [
            {
              id: 'remind-origin-1',
              schedule: '0 9 * * *',
              agent: 'main',
              prompt: 'check',
              resume: 'origin-session',
              sourceSessionKey: 'agent:main:webchat:dm:s1',
            },
          ],
        },
        sessions: { getByKey: () => ({ userId: 'u1' }) },
        readBody: async () => JSON.stringify(bodyObj),
        sendError: (_res: unknown, status: number, message: string) => {
          errors.push({ status, message })
        },
        sendJson: () => {},
      }) as unknown as CronTaskWebhookHost

    const postHost = makeHost({
      schedule: '0 9 * * *',
      prompt: 'hi',
      resume: 'origin-session',
      originSessionKey: 'agent:main:webchat:dm:s1',
      model: 'glm-5.3',
    })
    await handleCronApi.call(
      postHost,
      { method: 'POST', url: '/api/cron' } as any,
      {} as any,
    )
    assert.equal(addCalls, 0)
    assert.equal(errors[0]?.status, 400)
    assert.match(errors[0]?.message ?? '', /origin-session/)

    const putHost = makeHost({ effort: 'high' })
    await handleCronItem.call(
      putHost,
      { method: 'PUT', url: '/api/cron/remind-origin-1' } as any,
      {} as any,
      'remind-origin-1',
    )
    assert.equal(updateCalls, 0)
    assert.equal(errors[1]?.status, 400)
    assert.match(errors[1]?.message ?? '', /origin-session/)
  })
})

describe('resolveCronJobExecution — B2 zero inherited fallback & B3 master-route engine guard', () => {
  it('authority=1 + non-exempt + codex model → explicit DELEGATE_CODEX_UNSUPPORTED (no silent fallback)', async () => {
    _setModelCatalogClientForTests({ getRoutingView: async () => mockCatalogView() } as any)
    const res = await resolveCronJobExecution({
      jobId: 'daily-brief',
      agent: { id: 'main', model: 'gpt-5.6-sol' },
      defaultModel: 'deepseek-v4-flash',
      env: { OC_MODEL_AUTHORITY: '1' },
    })
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, 'DELEGATE_CODEX_UNSUPPORTED')
      assert.equal(res.retryable, false)
      assert.match(res.message, /gpt-5\.6-sol/)
    }
  })

  it('B2 (authority=1): retired/unroutable inherited agent.model rejects visibly instead of silently falling back to deepseek-v4-flash', async () => {
    _setModelCatalogClientForTests({ getRoutingView: async () => mockCatalogView() } as any)
    const res = await resolveCronJobExecution({
      jobId: 'legacy-agent-job',
      agent: { id: 'researcher', model: 'claude-3-7-sonnet-retired' },
      defaultModel: 'deepseek-v4-flash',
      env: { OC_MODEL_AUTHORITY: '1' },
    })
    assert.equal(res.ok, false, 'retired agent model must NOT silently fall back to deepseek-v4-flash')
    if (!res.ok) {
      assert.equal(res.code, 'DELEGATE_MODEL_UNKNOWN')
      assert.match(res.message, /claude-3-7-sonnet-retired/)
    }
  })

  it('B2 (authority=0): retired/unroutable inherited agent.model rejects visibly instead of falling through static ladder', async () => {
    const res = await resolveCronJobExecution({
      jobId: 'legacy-flagoff-job',
      agent: { id: 'researcher', model: 'claude-3-7-sonnet-retired' },
      defaultModel: 'deepseek-v4-flash',
      env: {},
    })
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, 'CRON_MODEL_UNAVAILABLE')
      assert.match(res.message, /claude-3-7-sonnet-retired/)
    }
  })

  it('B2: only when job, agent, and config all omit model (or use auto) does platform default apply', async () => {
    _setModelCatalogClientForTests({ getRoutingView: async () => mockCatalogView() } as any)
    const res = await resolveCronJobExecution({
      jobId: 'auto-job',
      agent: { id: 'main', model: AGENT_MODEL_AUTO },
      defaultModel: undefined,
      env: { OC_MODEL_AUTHORITY: '1' },
    })
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.model, 'deepseek-v4-flash')
    }
  })

  it('B2 (R2): job.model="auto" skips auto and inherits valid bound agent.model cleanly', async () => {
    _setModelCatalogClientForTests({ getRoutingView: async () => mockCatalogView() } as any)
    const resAuth = await resolveCronJobExecution({
      jobId: 'auto-job-auth',
      explicitModel: AGENT_MODEL_AUTO,
      agent: { id: 'main', model: 'glm-5.3' },
      defaultModel: 'deepseek-v4-flash',
      env: { OC_MODEL_AUTHORITY: '1' },
    })
    assert.equal(resAuth.ok, true)
    if (resAuth.ok) {
      assert.equal(resAuth.model, 'glm-5.3')
    }

    const resFlagOff = await resolveCronJobExecution({
      jobId: 'auto-job-flagoff',
      explicitModel: AGENT_MODEL_AUTO,
      agent: { id: 'main', model: 'glm-5.3' },
      defaultModel: 'deepseek-v4-flash',
      env: {},
    })
    assert.equal(resFlagOff.ok, true)
    if (resFlagOff.ok) {
      assert.equal(resFlagOff.model, undefined, 'auto job inherits agent model without injecting literal "auto"')
    }
  })

  it('authority=1 + selfhost exempt + explicit codex model & effort → runs exact model with zero downgrade', async () => {
    _setModelCatalogClientForTests({ getRoutingView: async () => mockCatalogView() } as any)
    const res = await resolveCronJobExecution({
      jobId: 'research-patrol',
      explicitModel: 'gpt-5.6-sol',
      explicitEffort: 'high',
      agent: { id: 'main', model: 'deepseek-v4-flash' },
      defaultModel: 'deepseek-v4-flash',
      env: { OC_MODEL_AUTHORITY: '1', OC_SELFHOST_ENGINE_LOCAL_TURNS: '1' },
    })
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.model, 'gpt-5.6-sol')
      assert.equal(res.effort, 'high')
      assert.equal(res.execution?.engine, 'codex')
      assert.equal(res.execution?.downgradedFrom, undefined)
    }
  })

  it('B3: selfhost exempt still rejects Antigravity and Grok pre-execution because cron has no master relay route', async () => {
    _setModelCatalogClientForTests({ getRoutingView: async () => mockCatalogView() } as any)
    for (const model of ['antigravity-gemini-4-carbon', 'grok-build']) {
      for (const env of [
        { OC_MODEL_AUTHORITY: '1', OC_SELFHOST_ENGINE_LOCAL_TURNS: '1' },
        { OC_SELFHOST_ENGINE_LOCAL_TURNS: '1' },
      ]) {
        const res = await resolveCronJobExecution({
          jobId: `cron-${model}`,
          explicitModel: model,
          agent: { id: 'main' },
          defaultModel: 'deepseek-v4-flash',
          env,
        })
        assert.equal(res.ok, false, `${model} must be rejected before execution`)
        if (!res.ok) {
          assert.equal(res.code, 'CRON_ENGINE_ROUTE_REQUIRED')
          assert.equal(res.retryable, false)
        }
      }
    }
  })

  it('B3 adapter parity: real AntigravityAdapter and GrokAdapter reject turns when no master route is set', async () => {
    const makeTurnParams = () => ({
      input: 'ping',
      onEvent: () => {},
      sessionTotals: { turns: 0, costUSD: 0, inputTokens: 0, outputTokens: 0 },
    })

    const agy = new AntigravityAdapter({
      sessionKey: 'agent:main:cron:dm:agy-test',
      agentId: 'main',
      agentBaseDir: '/tmp',
      config: { defaults: {} } as any,
      model: 'antigravity-gemini-4-carbon',
    })
    agy.on('error', () => {})
    agy.setAntigravityRoute(null)
    const agyRun = agy.submitTurn(makeTurnParams() as any)
    await assert.rejects(agyRun.submitted, /ANTIGRAVITY_ROUTE_REQUIRED/)
    await agyRun.summary

    const grok = new GrokAdapter({
      sessionKey: 'agent:main:cron:dm:grok-test',
      agentId: 'main',
      agentBaseDir: '/tmp',
      config: { defaults: {} } as any,
      model: 'grok-build',
    })
    grok.on('error', () => {})
    grok.setGrokRoute(null)
    const grokRun = grok.submitTurn(makeTurnParams() as any)
    await assert.rejects(grokRun.submitted, /GROK_ROUTE_REQUIRED/)
    await grokRun.summary
  })

  it('authority=0 + unknown explicit model → explicit DELEGATE_MODEL_UNKNOWN error', async () => {
    const res = await resolveCronJobExecution({
      jobId: 'bad-model',
      explicitModel: 'nonexistent-model-xyz',
      agent: { id: 'main', model: 'deepseek-v4-flash' },
      defaultModel: 'deepseek-v4-flash',
      env: {},
    })
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.equal(res.code, 'DELEGATE_MODEL_UNKNOWN')
      assert.equal(res.retryable, false)
    }
  })
})
