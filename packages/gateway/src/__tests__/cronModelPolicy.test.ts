import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCronEffortField,
  normalizeCronModelField,
  resolveCronJobExecution,
} from '../cronModelPolicy.js'
import {
  _setModelCatalogClientForTests,
  type LocalCatalogView,
} from '../modelCatalogClient.js'

function mockCatalogView(): LocalCatalogView {
  const rows = new Map([
    ['gpt-5.6-sol', { modelId: 'gpt-5.6-sol', engine: 'codex' as const, supportsVision: true, available: true }],
    ['deepseek-v4-flash', { modelId: 'deepseek-v4-flash', engine: 'ccb' as const, supportsVision: false, available: true }],
    ['glm-5.3', { modelId: 'glm-5.3', engine: 'ccb' as const, supportsVision: true, available: true }],
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

describe('cronModelPolicy field normalization', () => {
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
})

describe('resolveCronJobExecution — zero silent downgrade', () => {
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
