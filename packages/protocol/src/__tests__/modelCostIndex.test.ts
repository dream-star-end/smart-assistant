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
})
