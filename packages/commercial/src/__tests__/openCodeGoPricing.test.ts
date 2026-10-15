/**
 * OCV5-425 OpenCode Go prices: https://opencode.ai/docs/go/ USD/1M → selfhost fen
 * floor(usd*100/2), non-zero minimum 1. Expected values are worked out by hand from the docs
 * table so a change to either the table or the conversion shows up here.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/openCodeGoPricing.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { OPENCODE_GO_EXTRA_MODELS } from '@openclaude/protocol'

import { GO_CATALOG_MODELS, goPricingFen, usdToFen } from '../admin/openCodeGoCatalog.js'

describe('OpenCode Go pricing', () => {
  test('conversion: floor(usd*50) in integer arithmetic, non-zero minimum 1', () => {
    assert.equal(usdToFen('4.00'), 200) // Gemini 4 input (OCV5-423 row)
    assert.equal(usdToFen('20.00'), 1000)
    assert.equal(usdToFen('0.20'), 10)
    assert.equal(usdToFen('0.15'), 7) // 7.5 floors
    assert.equal(usdToFen('0.016'), 1) // 0.8 → 0 → stored as 1
    assert.equal(usdToFen('1.32'), 66) // no float drift
    assert.equal(usdToFen(null), 0)
    assert.throws(() => usdToFen('1.2.3'))
  })

  test('every model matches the hand-checked docs price', () => {
    const expected: Record<string, [number, number, number, number]> = {
      'deepseek-v4-pro-go': [66, 198, 2, 0], // Peak $1.32 / $3.96 / $0.044
      'claude-haiku-5-5-go': [5, 25, 1, 6], // ≤100K $0.10 / $0.50 / $0.01 / $0.125
      'kimi-k3-go': [150, 750, 15, 0], // $3 / $15 / $0.30
      'minimax-m2.7-go': [15, 60, 3, 18], // $0.30 / $1.20 / $0.06 / $0.375
      'minimax-m3-go': [15, 60, 3, 0], // $0.30 / $1.20 / $0.06
      'space-bunny-go': [7, 30, 1, 0], // $0.15 / $0.60 / $0.03
      'qwen3.8-max-go': [100, 300, 12, 125], // $2 / $6 / $0.25 / $2.50
      'qwen3.8-flash-go': [7, 23, 1, 10], // $0.15 / $0.47 / $0.016 / $0.20
      'qwen3.7-plus-go': [20, 80, 2, 25], // ≤256K $0.40 / $1.60 / $0.04 / $0.50
      'glm-5.3-go': [70, 220, 13, 0], // $1.40 / $4.40 / $0.26
      'glm-5.2-go': [70, 220, 13, 0],
      'glm-5.3-flash-go': [7, 25, 1, 0], // $0.15 / $0.50 / $0.03
      'kimi-k2.7-code-go': [47, 200, 9, 0], // $0.95 / $4.00 / $0.19
      'kimi-k2.6-go': [47, 200, 8, 0], // $0.95 / $4.00 / $0.16
      'mimo-v2.6-pro-go': [21, 43, 1, 0], // $0.435 / $0.87 / $0.003625
      'mimo-v2.5-pro-go': [21, 43, 1, 0],
      'mimo-v2.6-flash-go': [7, 14, 1, 0], // $0.14 / $0.28 / $0.0028
      'mimo-v2.5-go': [7, 14, 1, 0],
      'hy4-preview-go': [41, 125, 2, 0], // $0.834 / $2.501 / $0.042
      'hy3-go': [7, 29, 1, 0], // $0.14 / $0.58 / $0.035
      'longcat-2.0-go': [15, 60, 1, 0], // $0.30 / $1.20 / $0.006
      'longcat-2.5-preview-free-go': [0, 0, 0, 0], // Free (limited time)
      'step-5-preview-free-go': [0, 0, 0, 0], // Free (limited time)
    }
    assert.deepEqual(GO_CATALOG_MODELS.map((m) => m.modelId).sort(), Object.keys(expected).sort())
    assert.deepEqual(Object.keys(OPENCODE_GO_EXTRA_MODELS).sort(), Object.keys(expected).sort())
    for (const m of GO_CATALOG_MODELS) {
      const fen = goPricingFen(m)
      assert.deepEqual(
        [fen.input, fen.output, fen.cacheRead, fen.cacheWrite],
        expected[m.modelId],
        m.modelId,
      )
    }
  })

  test('tiered models are capped below the next price tier', () => {
    const window = Object.fromEntries(GO_CATALOG_MODELS.map((m) => [m.modelId, m.contextWindow]))
    assert.ok(window['claude-haiku-5-5-go']! <= 100_000)
    assert.ok(window['qwen3.7-plus-go']! <= 200_000)
    assert.ok(window['minimax-m3-go']! <= 200_000)
  })
})
