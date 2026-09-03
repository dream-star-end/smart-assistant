import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseCreditBudgetFen,
  shouldAbortForCreditBudget,
} from '../creditExhaustion.js'

describe('parseCreditBudgetFen', () => {
  it('accepts non-negative bigint / safe int / decimal string', () => {
    assert.equal(parseCreditBudgetFen(0n), 0n)
    assert.equal(parseCreditBudgetFen(12n), 12n)
    assert.equal(parseCreditBudgetFen(0), 0n)
    assert.equal(parseCreditBudgetFen(9035), 9035n)
    assert.equal(parseCreditBudgetFen('0'), 0n)
    assert.equal(parseCreditBudgetFen('100'), 100n)
  })

  it('rejects negatives, floats, empty, oversized, and junk', () => {
    assert.equal(parseCreditBudgetFen(-1n), undefined)
    assert.equal(parseCreditBudgetFen(-1), undefined)
    assert.equal(parseCreditBudgetFen(1.5), undefined)
    assert.equal(parseCreditBudgetFen(''), undefined)
    assert.equal(parseCreditBudgetFen('01a'), undefined)
    assert.equal(parseCreditBudgetFen('1'.repeat(33)), undefined)
    assert.equal(parseCreditBudgetFen(null), undefined)
    assert.equal(parseCreditBudgetFen(undefined), undefined)
    assert.equal(parseCreditBudgetFen({}), undefined)
  })
})

describe('shouldAbortForCreditBudget', () => {
  it('stops at or past remaining budget, including a zero wallet', () => {
    assert.equal(shouldAbortForCreditBudget(0n, 0n), true)
    assert.equal(shouldAbortForCreditBudget(1n, 0n), true)
    assert.equal(shouldAbortForCreditBudget(100n, 100n), true)
    assert.equal(shouldAbortForCreditBudget(101n, 100n), true)
  })

  it('continues while running cost is still below remaining budget', () => {
    assert.equal(shouldAbortForCreditBudget(0n, 1n), false)
    assert.equal(shouldAbortForCreditBudget(99n, 100n), false)
  })
})
