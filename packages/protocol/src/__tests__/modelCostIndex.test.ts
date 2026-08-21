import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  COST_INDEX_BASELINE_MODEL_ID,
  blendedCostFen,
  costXVsBaseline,
  formatCostX,
} from '../modelCostIndex.js'

describe('modelCostIndex', () => {
  test('DeepSeek V4 Pro off-peak is the x1.0 baseline', () => {
    const pro = {
      inputPerMtok: 450,
      cacheReadPerMtok: 15,
      outputPerMtok: 1350,
      multiplier: 1,
    }
    assert.equal(COST_INDEX_BASELINE_MODEL_ID, 'deepseek-v4-pro')
    assert.equal(costXVsBaseline(pro, pro), 1.0)
    assert.equal(formatCostX(1), 'x1.0')
  })

  test('Flash off-peak is cheaper than Pro on the observed mix', () => {
    const pro = {
      inputPerMtok: 450,
      cacheReadPerMtok: 15,
      outputPerMtok: 1350,
      multiplier: 1,
    }
    const flash = {
      inputPerMtok: 150,
      cacheReadPerMtok: 5,
      outputPerMtok: 450,
      multiplier: 1,
    }
    assert.equal(costXVsBaseline(flash, pro), 0.3)
  })

  test('GPT Sol short-window CNY fen is ~x11.3 vs Pro', () => {
    const pro = {
      inputPerMtok: 450,
      cacheReadPerMtok: 15,
      outputPerMtok: 1350,
      multiplier: 1,
    }
    const sol = {
      inputPerMtok: 3395,
      cacheReadPerMtok: 340,
      outputPerMtok: 20372,
      multiplier: 1,
    }
    assert.equal(costXVsBaseline(sol, pro), 11.3)
    assert.ok(blendedCostFen(sol) > blendedCostFen(pro))
  })

  test('Fast multiplier doubles xN', () => {
    const pro = {
      inputPerMtok: 450,
      cacheReadPerMtok: 15,
      outputPerMtok: 1350,
      multiplier: 1,
    }
    const grok = {
      inputPerMtok: 1358,
      cacheReadPerMtok: 340,
      outputPerMtok: 4074,
      multiplier: 1,
    }
    const grokFast = { ...grok, multiplier: 2 }
    assert.equal(blendedCostFen(grokFast), blendedCostFen(grok) * 2)
    const standard = costXVsBaseline(grok, pro)
    const fast = costXVsBaseline(grokFast, pro)
    assert.equal(typeof standard, 'number')
    assert.ok(fast! > standard!)
  })

  test('0224 published fen hits product xN targets', () => {
    const pro = {
      inputPerMtok: 450,
      cacheReadPerMtok: 15,
      outputPerMtok: 1350,
      multiplier: 1,
    }
    const cases: Array<[string, number, number, number, number, number]> = [
      ['glm', 453, 84, 1424, 1, 2.0],
      ['k3-256k', 1219, 122, 6092, 1, 4.0],
      ['kimi-k3', 2438, 244, 12184, 1, 8.0],
      ['sol', 1199, 120, 7197, 1, 4.0],
      ['sol-1m', 2398, 240, 14394, 1, 8.0],
      ['terra', 600, 60, 3599, 1, 2.0],
      ['luna', 296, 31, 1776, 1, 1.0],
      ['flash', 225, 7, 675, 1, 0.5],
      ['grok', 376, 94, 1127, 1, 2.0],
      ['grok-fast', 376, 94, 1127, 2, 4.0],
      ['composer', 264, 106, 1320, 1, 2.0],
      ['opus', 3047, 305, 15234, 1, 10.0],
      ['opus-fast', 3047, 305, 15234, 2, 20.0],
      ['fable', 6098, 610, 30486, 1, 20.0],
    ]
    for (const [, input, cache, output, mul, want] of cases) {
      assert.equal(
        costXVsBaseline(
          { inputPerMtok: input, cacheReadPerMtok: cache, outputPerMtok: output, multiplier: mul },
          pro,
        ),
        want,
      )
    }
  })
})
