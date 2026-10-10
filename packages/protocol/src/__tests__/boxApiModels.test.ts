/**
 * Box model route table.
 * 跑法: npx tsx --test packages/protocol/src/__tests__/boxApiModels.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  BOX_API_MODELS,
  BOX_API_MODEL_IDS,
  BOX_API_UPSTREAM_MODEL_IDS,
  boxApiModelByEitherId,
  boxApiModelById,
  boxApiUpstreamModelFor,
  isBoxApiModel,
  isBoxApiModelPair,
  isBoxApiUpstreamModel,
} from '../boxApiModels.js'
import { BOX_NATIVE_CONTEXT_MODEL } from '../modelAuthority.js'

describe('boxApiModels', () => {
  it('lists opus, sonnet and both haikus with the id the Box CLI reports', () => {
    assert.deepEqual(BOX_API_MODELS.map((m) => [m.id, m.upstreamModel, m.maxOutputTokens, m.supportsEffort]), [
      ['box-api-claude-opus-5-5', 'claude-opus-5-5', 128_000, true],
      ['box-api-claude-sonnet-5-5', 'claude-sonnet-5-5', 128_000, true],
      ['box-api-claude-haiku-4-5', 'claude-haiku-4-5-20251001', 64_000, false],
      ['box-api-claude-haiku-5-5', 'claude-haiku-5-5', 128_000, true],
    ])
    assert.equal(new Set(BOX_API_MODEL_IDS).size, BOX_API_MODELS.length)
    assert.equal(new Set(BOX_API_UPSTREAM_MODEL_IDS).size, BOX_API_MODELS.length)
    assert.equal(BOX_NATIVE_CONTEXT_MODEL, 'box-api-claude-opus-5-5')
  })

  it('matches exact ids only', () => {
    for (const m of BOX_API_MODELS) {
      assert.equal(isBoxApiModel(m.id), true)
      assert.equal(isBoxApiUpstreamModel(m.upstreamModel), true)
      assert.equal(isBoxApiModel(m.upstreamModel), false)
      assert.equal(isBoxApiUpstreamModel(m.id), false)
      assert.equal(boxApiModelById(m.id), m)
      assert.equal(boxApiModelByEitherId(m.id), m)
      assert.equal(boxApiModelByEitherId(m.upstreamModel), m)
      assert.equal(boxApiUpstreamModelFor(m.id), m.upstreamModel)
    }
    for (const other of ['box-api-claude-opus-5-5 ', 'BOX-API-CLAUDE-OPUS-5-5', 'box-api-claude-opus-5',
      'box-api-claude-sonnet-5', 'box-claude-opus-5-5', 'claude-haiku-4-5', 'box-api-claude-haiku-5',
      'box-claude-haiku-5-5', 'claude-haiku-5-5-20261007', 'box-api-', '', null, undefined, 7]) {
      assert.equal(isBoxApiModel(other), false, String(other))
      assert.equal(isBoxApiUpstreamModel(other), false, String(other))
      assert.equal(boxApiModelByEitherId(other), undefined, String(other))
      assert.equal(boxApiUpstreamModelFor(other), undefined, String(other))
    }
  })

  it('pairs a model only with its own upstream id', () => {
    for (const m of BOX_API_MODELS) {
      for (const n of BOX_API_MODELS) {
        assert.equal(isBoxApiModelPair(m.id, n.upstreamModel), m === n, `${m.id} / ${n.upstreamModel}`)
      }
      assert.equal(isBoxApiModelPair(m.id, undefined), false)
      assert.equal(isBoxApiModelPair(m.upstreamModel, m.upstreamModel), false)
    }
    assert.equal(isBoxApiModelPair('box-api-claude-haiku-4-5', 'claude-haiku-4-5'), false)
    assert.equal(isBoxApiModelPair('box-api-claude-haiku-5-5', 'claude-haiku-4-5-20251001'), false)
  })

  for (const mirrorPath of [
    '../../../../claude-code-best/src/utils/model/boxNativeRemoteContext.ts',
    '../../../commercial/src/http/proxy/boxNativeContextOwner.ts',
  ]) {
    it(`${mirrorPath.split('/').slice(-1)[0]} mirrors the same ids in the same order`, () => {
      const mirror = readFileSync(fileURLToPath(new URL(mirrorPath, import.meta.url)), 'utf8')
      const block = /export const BOX_NATIVE_CONTEXT_MODELS: readonly string\[\] = \[([^\]]*)\]/.exec(mirror)
      assert.ok(block, 'mirror list not found')
      const ids = [...block[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((hit) => hit[1])
      assert.deepEqual(ids, [...BOX_API_MODEL_IDS])
      // the mirror file must stay loadable without the workspace
      if (mirrorPath.includes('commercial')) assert.doesNotMatch(mirror, /^import /m)
    })
  }

  // OCV5-368: CCB sends max_tokens = the model's official cap for these models.
  it('the CCB output-cap mirror equals maxOutputTokens for every model it lists', () => {
    const mirror = readFileSync(fileURLToPath(new URL(
      '../../../../claude-code-best/src/utils/model/boxNativeRemoteContext.ts', import.meta.url)), 'utf8')
    const block = /export const BOX_API_OUTPUT_TOKENS: Readonly<Record<string, number>> = \{([^}]*)\}/.exec(mirror)
    assert.ok(block, 'output cap mirror not found')
    const entries = [...block[1]!.matchAll(/['"]([^'"]+)['"]:\s*([0-9_]+)/g)]
      .map((hit) => [hit[1], Number(hit[2]!.replaceAll('_', ''))] as const)
    assert.deepEqual(entries.map(([id]) => id), ['box-api-claude-opus-5-5', 'box-api-claude-sonnet-5-5'])
    for (const [id, cap] of entries) assert.equal(cap, boxApiModelById(id)?.maxOutputTokens, id)
  })
})
