import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { CNY_PER_USD, composeMultiplier, computeCostFen, fenToUsd } from '../computeCost.js'

const terra = {
  input_per_mtok: 150n,
  output_per_mtok: 899n,
  cache_read_per_mtok: 15n,
  cache_write_per_mtok: 0n,
  multiplier: '1.000',
}

describe('computeCostFen', () => {
  test('zero usage → 0', () => {
    assert.equal(
      computeCostFen(
        { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
        terra,
      ),
      0n,
    )
  })

  test('terra 1M input only = 150 分; Fast×2 doubles', () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    }
    assert.equal(computeCostFen(usage, terra), 150n)
    assert.equal(computeCostFen(usage, { ...terra, multiplier: '2.000' }), 300n)
  })

  test('any positive token ceilings to at least 1 分', () => {
    assert.equal(
      computeCostFen(
        { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
        terra,
      ),
      1n,
    )
  })
})

describe('composeMultiplier', () => {
  test('与 commercial agentMultiplier 截断/clamp 同口径', () => {
    assert.equal(composeMultiplier('2.000', '1.500'), '3.000')
    assert.equal(composeMultiplier('1.234', '1.234'), '1.522')
    assert.equal(composeMultiplier('0.001', '0.001'), '0.001')
    assert.equal(composeMultiplier('0.000', '1.500'), '0.000')
    assert.equal(composeMultiplier('1.000', '1.500'), '1.500')
  })
})

describe('fenToUsd', () => {
  test('uses the 0223 official mid-rate', () => {
    assert.equal(CNY_PER_USD, 6.7905)
    assert.equal(fenToUsd(0n), 0)
    assert.ok(Math.abs(fenToUsd(67905n) - 100) < 1e-9)
  })
})
