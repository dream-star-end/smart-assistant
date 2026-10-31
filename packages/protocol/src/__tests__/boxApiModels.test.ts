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
  boxApiRunnerFor,
  boxApiUpstreamModelFor,
  isBoxApiModel,
  isBoxApiModelPair,
  isBoxApiUpstreamModel,
} from '../boxApiModels.js'
import { BOX_NATIVE_CONTEXT_MODEL } from '../modelAuthority.js'

describe('boxApiModels', () => {
  it('keeps the builtin Agent API session matcher exact for every official Box route', () => {
    const source=readFileSync(new URL('../../../../claude-code-best/src/utils/boxAgentScope.ts',import.meta.url),'utf8')
    const array=source.match(/export const BOX_AGENT_API_MODELS: readonly string\[\] = \[([\s\S]*?)\n\]/)?.[1]
    assert.ok(array,'actual CCB Agent model matcher mirror must exist')
    assert.deepEqual([...array.matchAll(/'([^']+)'/g)].map(match=>match[1]),BOX_API_MODEL_IDS)
  })
  it('lists opus, sonnet and both haikus with the id the Box CLI reports', () => {
    assert.deepEqual(BOX_API_MODELS.map((m) => [m.id, m.upstreamModel, m.maxOutputTokens, m.supportsEffort, m.runner]), [
      ['box-api-claude-opus-5-5', 'claude-opus-5-5', 128_000, true, 'print'],
      ['box-api-claude-sonnet-5-5', 'claude-sonnet-5-5', 128_000, true, 'print'],
      ['box-api-claude-haiku-4-5', 'claude-haiku-4-5-20251001', 64_000, false, 'print'],
      ['box-api-claude-haiku-5-5', 'claude-haiku-5-5', 128_000, true, 'print'],
      ['box-claude-opus-5-5', 'claude-opus-5-5', 128_000, true, 'interactive'],
      ['box-claude-sonnet-5', 'claude-sonnet-5', 128_000, true, 'interactive'],
      ['box-claude-haiku-5-5', 'claude-haiku-5-5', 128_000, true, 'interactive'],
    ])
    assert.equal(new Set(BOX_API_MODEL_IDS).size, BOX_API_MODELS.length)
    assert.deepEqual(BOX_API_UPSTREAM_MODEL_IDS, ['claude-opus-5-5', 'claude-sonnet-5-5',
      'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-sonnet-5'])
    assert.equal(BOX_NATIVE_CONTEXT_MODEL, 'box-api-claude-opus-5-5')
  })

  it('runs box-api-* on claude -p and box-claude-* interactively; rows sharing an upstream id agree', () => {
    for (const m of BOX_API_MODELS) {
      assert.equal(boxApiRunnerFor(m.id), m.id.startsWith('box-api-') ? 'print' : 'interactive')
      for (const n of BOX_API_MODELS.filter((x) => x.upstreamModel === m.upstreamModel)) {
        assert.equal(n.maxOutputTokens, m.maxOutputTokens)
        assert.equal(n.supportsEffort, m.supportsEffort)
      }
    }
    for (const other of ['claude-haiku-5-5', 'box-claude-haiku-4-5', 'cursor-auto', '', undefined]) {
      assert.equal(boxApiRunnerFor(other), undefined, String(other))
    }
  })

  it('matches exact ids only', () => {
    for (const m of BOX_API_MODELS) {
      assert.equal(isBoxApiModel(m.id), true)
      assert.equal(isBoxApiUpstreamModel(m.upstreamModel), true)
      assert.equal(isBoxApiModel(m.upstreamModel), false)
      assert.equal(isBoxApiUpstreamModel(m.id), false)
      assert.equal(boxApiModelById(m.id), m)
      assert.equal(boxApiModelByEitherId(m.id), m)
      // An upstream id names the first row that runs it; shared rows agree (see above).
      assert.equal(boxApiModelByEitherId(m.upstreamModel)?.upstreamModel, m.upstreamModel)
      assert.equal(boxApiUpstreamModelFor(m.id), m.upstreamModel)
    }
    for (const other of ['box-api-claude-opus-5-5 ', 'BOX-API-CLAUDE-OPUS-5-5', 'box-api-claude-opus-5',
      'box-api-claude-sonnet-5', 'box-claude-opus-5', 'claude-haiku-4-5', 'box-api-claude-haiku-5',
      'box-claude-haiku-4-5', 'claude-haiku-5-5-20261007', 'box-api-', 'box-claude-', '', null, undefined, 7]) {
      assert.equal(isBoxApiModel(other), false, String(other))
      assert.equal(isBoxApiUpstreamModel(other), false, String(other))
      assert.equal(boxApiModelByEitherId(other), undefined, String(other))
      assert.equal(boxApiUpstreamModelFor(other), undefined, String(other))
    }
  })

  it('pairs a model only with its own upstream id', () => {
    for (const m of BOX_API_MODELS) {
      for (const n of BOX_API_MODELS) {
        assert.equal(isBoxApiModelPair(m.id, n.upstreamModel), m.upstreamModel === n.upstreamModel,
          `${m.id} / ${n.upstreamModel}`)
      }
      assert.equal(isBoxApiModelPair(m.id, undefined), false)
      assert.equal(isBoxApiModelPair(m.upstreamModel, m.upstreamModel), false)
    }
    assert.equal(isBoxApiModelPair('box-api-claude-haiku-4-5', 'claude-haiku-4-5'), false)
    assert.equal(isBoxApiModelPair('box-api-claude-haiku-5-5', 'claude-haiku-4-5-20251001'), false)
    assert.equal(isBoxApiModelPair('box-claude-haiku-5-5', 'claude-haiku-5-5'), true)
    assert.equal(isBoxApiModelPair('box-claude-sonnet-5', 'claude-sonnet-5-5'), false)
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
  it('the CCB output-cap mirror lists every model with its maxOutputTokens', () => {
    const mirror = readFileSync(fileURLToPath(new URL(
      '../../../../claude-code-best/src/utils/model/boxNativeRemoteContext.ts', import.meta.url)), 'utf8')
    const block = /export const BOX_API_OUTPUT_TOKENS: Readonly<Record<string, number>> = \{([^}]*)\}/.exec(mirror)
    assert.ok(block, 'output cap mirror not found')
    const entries = [...block[1]!.matchAll(/['"]([^'"]+)['"]:\s*([0-9_]+)/g)]
      .map((hit) => [hit[1], Number(hit[2]!.replaceAll('_', ''))] as const)
    assert.deepEqual(entries.map(([id]) => id), BOX_API_MODELS.map((m) => m.id))
    for (const [id, cap] of entries) assert.equal(cap, boxApiModelById(id)?.maxOutputTokens, id)
  })
})
