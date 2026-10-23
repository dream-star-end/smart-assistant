import assert from 'node:assert/strict'
import { test } from 'node:test'
import { KIMI31_VERSION, KIMI31_PRICE, exactKimi31Catalog, exactKimi31Price }
  from '../admin/kimi31Catalog.js'
import { normalizeVersionInput, validateVersionSemantics } from '../admin/modelCatalogOps.js'

test('Kimi 3.1 Pro operator descriptor is valid for the exact Moonshot route', () => {
  assert.deepEqual(validateVersionSemantics(normalizeVersionInput(KIMI31_VERSION)), [])
  assert.deepEqual(KIMI31_VERSION.capability_profile.reasoning.supported, ['low', 'high', 'max'])
  assert.deepEqual([KIMI31_PRICE.input_per_mtok, KIMI31_PRICE.output_per_mtok,
    KIMI31_PRICE.cache_read_per_mtok, KIMI31_PRICE.cache_write_per_mtok], ['609', '3046', '61', '0'])
  assert.equal(KIMI31_PRICE.default_effort, 'max')
  assert.equal(KIMI31_PRICE.enabled, false)
})

test('Kimi 3.1 preparation rejects mismatched upstream, capabilities and prices', () => {
  const row = { ...KIMI31_VERSION, entry_id: '611', state: 'staged' }
  assert.equal(exactKimi31Catalog(row), true)
  for (const change of [{ upstream_model_id: 'kimi-k3' }, { provider_id: 'opencodego' },
    { context_window: 262144 }, { capability_schema_version: 2 },
    { capability_profile: { ...KIMI31_VERSION.capability_profile, supports_vision: false } }]) {
    assert.equal(exactKimi31Catalog({ ...row, ...change }), false)
  }
  assert.equal(exactKimi31Price(KIMI31_PRICE), true)
  for (const change of [{ input_per_mtok: '610' }, { output_per_mtok: '3047' },
    { input_per_mtok: '914', output_per_mtok: '4569', cache_read_per_mtok: '92' },
    { enabled: true }, { default_effort: 'high' }, { visibility: 'admin' },
    { multiplier: '2.000' }, { min_plan_code: 'pro' }]) {
    assert.equal(exactKimi31Price({ ...KIMI31_PRICE, ...change }), false)
  }
})
