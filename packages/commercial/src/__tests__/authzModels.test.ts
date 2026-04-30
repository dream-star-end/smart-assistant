/**
 * authzModels — canUseModel 单测(不碰 DB)。
 *
 * 覆盖矩阵(plan v3 §B3):
 *   - visibility public → 所有 role + 任意 grants 都允许
 *   - visibility admin → role=admin 允许 / role=user 仅 grant 允许
 *   - visibility hidden → 仅 grant 允许(连 admin 都不自动放行,与 listForUser 同源)
 *   - enabled=false → 一律拒绝(即使 visibility=public)
 *   - 未知 modelId → 拒绝(不假设兜底允许)
 *   - canonicalize 入参(带日期 alias)→ 命中 canonical 行
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { canUseModel } from '../billing/authzModels.js'
import { type ModelPricing, PricingCache } from '../billing/pricing.js'

function makeCache(rows: ModelPricing[]): PricingCache {
  const c = new PricingCache()
  c._setForTests(rows)
  return c
}

const opusPublic: ModelPricing = {
  model_id: 'claude-opus-4-7',
  display_name: 'Opus',
  input_per_mtok: 500n,
  output_per_mtok: 2500n,
  cache_read_per_mtok: 50n,
  cache_write_per_mtok: 625n,
  multiplier: '2.000',
  enabled: true,
  sort_order: 90,
  visibility: 'public',
  updated_at: new Date('2026-04-01T00:00:00Z'),
}

const gpt55Admin: ModelPricing = {
  model_id: 'gpt-5.5',
  display_name: 'GPT 5.5',
  input_per_mtok: 500n,
  output_per_mtok: 2500n,
  cache_read_per_mtok: 50n,
  cache_write_per_mtok: 625n,
  multiplier: '2.000',
  enabled: true,
  sort_order: 110,
  visibility: 'admin',
  updated_at: new Date('2026-04-29T00:00:00Z'),
}

const internalHidden: ModelPricing = {
  model_id: 'internal-tool',
  display_name: 'Internal',
  input_per_mtok: 100n,
  output_per_mtok: 500n,
  cache_read_per_mtok: 10n,
  cache_write_per_mtok: 125n,
  multiplier: '1.000',
  enabled: true,
  sort_order: 999,
  visibility: 'hidden',
  updated_at: new Date('2026-04-01T00:00:00Z'),
}

const disabledPublic: ModelPricing = {
  model_id: 'claude-legacy',
  display_name: 'Legacy',
  input_per_mtok: 100n,
  output_per_mtok: 500n,
  cache_read_per_mtok: 10n,
  cache_write_per_mtok: 125n,
  multiplier: '1.000',
  enabled: false,
  sort_order: 200,
  visibility: 'public',
  updated_at: new Date('2026-04-01T00:00:00Z'),
}

const empty: ReadonlySet<string> = new Set()

describe('canUseModel — visibility=public', () => {
  const pricing = makeCache([opusPublic])

  test('user 无 grant 允许', () => {
    assert.equal(
      canUseModel(
        { pricing },
        { role: 'user', grantedModelIds: empty, modelId: 'claude-opus-4-7' },
      ),
      true,
    )
  })

  test('admin 无 grant 允许', () => {
    assert.equal(
      canUseModel(
        { pricing },
        { role: 'admin', grantedModelIds: empty, modelId: 'claude-opus-4-7' },
      ),
      true,
    )
  })

  test('canonicalize 入参(带日期 alias)命中', () => {
    assert.equal(
      canUseModel(
        { pricing },
        { role: 'user', grantedModelIds: empty, modelId: 'claude-opus-4-7-20260101' },
      ),
      true,
    )
  })
})

describe('canUseModel — visibility=admin', () => {
  const pricing = makeCache([gpt55Admin])
  const grants = new Set(['gpt-5.5'])

  test('admin 无 grant 允许(role 自动放行)', () => {
    assert.equal(
      canUseModel({ pricing }, { role: 'admin', grantedModelIds: empty, modelId: 'gpt-5.5' }),
      true,
    )
  })

  test('user 无 grant 拒绝', () => {
    assert.equal(
      canUseModel({ pricing }, { role: 'user', grantedModelIds: empty, modelId: 'gpt-5.5' }),
      false,
    )
  })

  test('user 有 grant 允许', () => {
    assert.equal(
      canUseModel({ pricing }, { role: 'user', grantedModelIds: grants, modelId: 'gpt-5.5' }),
      true,
    )
  })

  test('user 有别的模型 grant 但本模型无 grant 拒绝', () => {
    assert.equal(
      canUseModel(
        { pricing },
        { role: 'user', grantedModelIds: new Set(['other-model']), modelId: 'gpt-5.5' },
      ),
      false,
    )
  })
})

describe('canUseModel — visibility=hidden', () => {
  const pricing = makeCache([internalHidden])
  const grants = new Set(['internal-tool'])

  test('admin 无 grant 拒绝(hidden 严格)', () => {
    assert.equal(
      canUseModel({ pricing }, { role: 'admin', grantedModelIds: empty, modelId: 'internal-tool' }),
      false,
    )
  })

  test('admin 有 grant 允许', () => {
    assert.equal(
      canUseModel(
        { pricing },
        { role: 'admin', grantedModelIds: grants, modelId: 'internal-tool' },
      ),
      true,
    )
  })

  test('user 无 grant 拒绝', () => {
    assert.equal(
      canUseModel({ pricing }, { role: 'user', grantedModelIds: empty, modelId: 'internal-tool' }),
      false,
    )
  })

  test('user 有 grant 允许', () => {
    assert.equal(
      canUseModel({ pricing }, { role: 'user', grantedModelIds: grants, modelId: 'internal-tool' }),
      true,
    )
  })
})

describe('canUseModel — enabled=false / 未知模型', () => {
  test('enabled=false 即使 visibility=public 也拒', () => {
    const pricing = makeCache([disabledPublic])
    assert.equal(
      canUseModel({ pricing }, { role: 'admin', grantedModelIds: empty, modelId: 'claude-legacy' }),
      false,
    )
  })

  test('未知 modelId 拒(不假设兜底允许)', () => {
    const pricing = makeCache([opusPublic])
    assert.equal(
      canUseModel({ pricing }, { role: 'admin', grantedModelIds: empty, modelId: 'made-up-model' }),
      false,
    )
  })

  test('未知 + grant 集合里有同名 model 但 cache 里没 → 仍拒(grant 不能虚授不存在的模型)', () => {
    const pricing = makeCache([opusPublic])
    assert.equal(
      canUseModel(
        { pricing },
        {
          role: 'user',
          grantedModelIds: new Set(['phantom-model']),
          modelId: 'phantom-model',
        },
      ),
      false,
    )
  })
})
