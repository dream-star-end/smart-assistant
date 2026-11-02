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


const grokPublic: ModelPricing = {
  model_id: 'grok-build',
  display_name: 'Grok Build',
  input_per_mtok: 100n,
  output_per_mtok: 500n,
  cache_read_per_mtok: 10n,
  cache_write_per_mtok: 125n,
  multiplier: '1.000',
  enabled: true,
  sort_order: 80,
  visibility: 'public',
  extra_system_prompt: null,
  default_effort: 'high',
  updated_at: new Date('2026-08-25T00:00:00Z'),
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
  extra_system_prompt: null,
  default_effort: null,
  updated_at: new Date('2026-04-01T00:00:00Z'),
}

const gpt56Admin: ModelPricing = {
  model_id: 'gpt-5.6-sol',
  display_name: 'GPT-5.6-Sol',
  input_per_mtok: 500n,
  output_per_mtok: 2500n,
  cache_read_per_mtok: 50n,
  cache_write_per_mtok: 625n,
  multiplier: '2.000',
  enabled: true,
  sort_order: 110,
  visibility: 'admin',
  extra_system_prompt: null,
  default_effort: null,
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
  extra_system_prompt: null,
  default_effort: null,
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
  extra_system_prompt: null,
  default_effort: null,
  updated_at: new Date('2026-04-01T00:00:00Z'),
}

const empty: ReadonlySet<string> = new Set()


describe('canUseModel — grok-build follows visibility', () => {
  test('public grok-build is usable by ordinary users', () => {
    const pricing = makeCache([grokPublic])
    assert.equal(
      canUseModel({ pricing }, { role: 'user', grantedModelIds: new Set(), modelId: 'grok-build' }),
      true,
    )
    assert.equal(
      canUseModel({ pricing }, { role: 'admin', grantedModelIds: new Set(), modelId: 'grok-build' }),
      true,
    )
  })
})

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

  test('account hard denial overrides public visibility and an explicit grant', () => {
    assert.equal(
      canUseModel(
        { pricing },
        {
          role: 'admin',
          grantedModelIds: new Set(['claude-opus-4-7']),
          deniedModelIds: new Set(['claude-opus-4-7']),
          modelId: 'claude-opus-4-7',
        },
      ),
      false,
    )
  })
})

describe('canUseModel — visibility=admin', () => {
  const pricing = makeCache([gpt56Admin])
  const grants = new Set(['gpt-5.6-sol'])

  test('admin 无 grant 允许(role 自动放行)', () => {
    assert.equal(
      canUseModel({ pricing }, { role: 'admin', grantedModelIds: empty, modelId: 'gpt-5.6-sol' }),
      true,
    )
  })

  test('user 无 grant 拒绝', () => {
    assert.equal(
      canUseModel({ pricing }, { role: 'user', grantedModelIds: empty, modelId: 'gpt-5.6-sol' }),
      false,
    )
  })

  test('user 有 grant 允许', () => {
    assert.equal(
      canUseModel({ pricing }, { role: 'user', grantedModelIds: grants, modelId: 'gpt-5.6-sol' }),
      true,
    )
  })

  test('user 有别的模型 grant 但本模型无 grant 拒绝', () => {
    assert.equal(
      canUseModel(
        { pricing },
        { role: 'user', grantedModelIds: new Set(['other-model']), modelId: 'gpt-5.6-sol' },
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

describe('canUseModel — min_plan_code Max floor', () => {
  const opusMax: ModelPricing = {
    ...opusPublic,
    model_id: 'cursor-opus-5-high',
    min_plan_code: 'max',
    min_plan_tier: 3,
  }
  const pricing = makeCache([opusMax])

  test('public visibility still requires Max', () => {
    assert.equal(
      canUseModel(
        { pricing },
        { role: 'user', grantedModelIds: empty, modelId: 'cursor-opus-5-high' },
      ),
      false,
    )
    assert.equal(
      canUseModel(
        { pricing },
        { role: 'admin', grantedModelIds: empty, modelId: 'cursor-opus-5-high', userPlanTier: 2 },
      ),
      false,
    )
    assert.equal(
      canUseModel(
        { pricing },
        { role: 'user', grantedModelIds: empty, modelId: 'cursor-opus-5-high', userPlanTier: 3 },
      ),
      true,
    )
    assert.equal(
      canUseModel(
        { pricing },
        { role: 'user', grantedModelIds: empty, modelId: 'cursor-opus-5-high', orgPlanCode: 'org-ultra' },
      ),
      true,
    )
  })
})

describe('retired cc5 task model visibility and execution backstop', () => {
  test('never leaks publicly and never authorizes ordinary/admin identities by grant or public visibility', () => {
    const keys = ['OC_SELFHOST_CC5_T1555U_ENABLED', 'OC_SELFHOST_CC5_T1555U_TEST_UID'] as const
    const saved = keys.map(key => process.env[key])
    try {
      process.env.OC_SELFHOST_CC5_T1555U_TEST_UID = '314159'
      for (const visibility of ['public', 'admin', 'hidden'] as const) {
        const row = { ...grokPublic, model_id: 'cc5-remote-t1555u', visibility }
        const pricing = makeCache([row])
        assert.deepEqual(pricing.listPublic(), [])
        for (const flag of ['0', '1']) {
          process.env.OC_SELFHOST_CC5_T1555U_ENABLED = flag
          for (const uid of [0, 3, 314158, 314159]) {
            for (const role of ['user', 'admin'] as const) {
              const scope = { uid, role, grantedModelIds: new Set([row.model_id]) }
              const expected = false
              assert.equal(canUseModel({ pricing }, { ...scope, modelId: row.model_id }), expected)
              assert.deepEqual(pricing.listForUser(scope).map(p => p.id), expected ? [row.model_id] : [])
            }
          }
        }
      }
    } finally {
      keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
    }
  })

  test('existing Sonnet uses ordinary visibility and grants for the existing UID, independent of legacy flags', () => {
    const keys = ['OC_SELFHOST_CC5_T1555U_ENABLED', 'OC_SELFHOST_CC5_T1555U_TEST_UID'] as const
    const saved = keys.map(key => process.env[key])
    try {
      process.env.OC_SELFHOST_CC5_T1555U_TEST_UID = '314159'
      for (const flag of ['0', '1']) {
        process.env.OC_SELFHOST_CC5_T1555U_ENABLED = flag
        for (const visibility of ['public', 'admin', 'hidden'] as const) {
          const row = { ...grokPublic, model_id: 'box-claude-sonnet-5', visibility }
          const pricing = makeCache([row])
          for (const granted of [false, true]) {
            for (const role of ['user', 'admin'] as const) {
              const grantedModelIds = new Set(granted ? [row.model_id] : [])
              const scope = { uid: 3, role, grantedModelIds }
              const expected = visibility === 'public' || granted || (visibility === 'admin' && role === 'admin')
              assert.equal(canUseModel({ pricing }, { ...scope, modelId: row.model_id }), expected)
              assert.deepEqual(pricing.listForUser(scope).map(p => p.id), expected ? [row.model_id] : [])
            }
          }
        }
      }
    } finally {
      keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
    }
  })
})
