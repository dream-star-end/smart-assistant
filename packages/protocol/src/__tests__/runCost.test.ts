import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyRecordedRunCost, formatRecordedCostTotal } from '../runCost.js'

test('recorded flags classify consistently without inventing settlement provenance', () => {
  for (const flag of [true, 1]) assert.equal(classifyRecordedRunCost(10, 1, 2, flag), 'estimated')
  for (const flag of [false, 0]) assert.equal(classifyRecordedRunCost(10, 1, 2, flag), 'unflagged')
  for (const flag of [null, undefined, 2]) assert.equal(classifyRecordedRunCost(10, 1, 2, flag), 'unverified')
  assert.equal(classifyRecordedRunCost(10, 1, 0, true), 'unpriced')
  assert.equal(classifyRecordedRunCost(null, null, null), 'unknown')
  assert.equal(classifyRecordedRunCost(0, 0, 0), 'unverified')
  assert.equal(formatRecordedCostTotal(2), '参考费用 $2.0000（来源未证实）')
})
