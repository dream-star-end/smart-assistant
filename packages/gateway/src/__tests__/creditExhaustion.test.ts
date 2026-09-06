import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  CreditBudgetGuard,
  parseCreditBudgetFen,
  runningCostFenForUsage,
  shouldAbortForCreditBudget,
} from '../creditExhaustion.js'
import { _setModelCatalogClientForTests } from '../modelCatalogClient.js'
import { _setPlatformPricingLookupForTests, type PlatformPricing } from '../usageCost.js'

// 100 fen per 1M input tokens, 1000 fen per 1M output tokens.
const PRICING: PlatformPricing = {
  inputPerMtok: '100',
  outputPerMtok: '1000',
  cacheReadPerMtok: '10',
  cacheWritePerMtok: '0',
  multiplier: '1.000',
}

function fakeCatalog(agentMultiplier: string | null): void {
  _setModelCatalogClientForTests({
    get configured() { return true },
    async lookupAgentCostMultiplier() { return agentMultiplier },
  } as never)
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

afterEach(() => {
  _setPlatformPricingLookupForTests(null)
  _setModelCatalogClientForTests(null)
})

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

describe('runningCostFenForUsage', () => {
  it('prices cumulative usage with the catalog row and composes the agent multiplier on request', async () => {
    _setPlatformPricingLookupForTests(async () => PRICING)
    fakeCatalog('2.000')
    const base = await runningCostFenForUsage({
      modelId: 'gpt-6-astra',
      usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
      composeAgentMultiplier: false,
    })
    assert.equal(base, 200n)
    const composed = await runningCostFenForUsage({
      modelId: 'gpt-6-astra',
      usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
      agentId: 'main',
      composeAgentMultiplier: true,
    })
    assert.equal(composed, 400n)
  })

  it('fails open (null) on missing model, missing pricing, or missing agent multiplier', async () => {
    _setPlatformPricingLookupForTests(async (model) => (model === 'known' ? PRICING : null))
    fakeCatalog(null)
    assert.equal(await runningCostFenForUsage({ modelId: undefined, usage: { inputTokens: 1, outputTokens: 1 } }), null)
    assert.equal(await runningCostFenForUsage({ modelId: 'unknown', usage: { inputTokens: 1, outputTokens: 1 } }), null)
    assert.equal(
      await runningCostFenForUsage({
        modelId: 'known',
        usage: { inputTokens: 1, outputTokens: 1 },
        agentId: 'main',
        composeAgentMultiplier: true,
      }),
      null,
    )
  })
})

describe('CreditBudgetGuard', () => {
  it('is inert without an admitted budget', async () => {
    _setPlatformPricingLookupForTests(async () => PRICING)
    let fired = 0
    const guard = new CreditBudgetGuard({
      budgetFen: undefined,
      modelId: () => 'm',
      composeAgentMultiplier: false,
      isLive: () => true,
      onExhausted: () => { fired++ },
    })
    assert.equal(guard.active, false)
    guard.observe({ inputTokens: 10_000_000, outputTokens: 10_000_000 })
    await settle()
    assert.equal(fired, 0)
    assert.equal(guard.isExhausted, false)
  })

  it('fires exactly once when cumulative cost reaches the budget and ignores later snapshots', async () => {
    _setPlatformPricingLookupForTests(async () => PRICING)
    let fired = 0
    const guard = new CreditBudgetGuard({
      budgetFen: 150n,
      modelId: () => 'm',
      composeAgentMultiplier: false,
      isLive: () => true,
      onExhausted: () => { fired++ },
    })
    guard.observe({ inputTokens: 1_000_000, outputTokens: 0 }) // 100 fen
    await settle()
    assert.equal(fired, 0)
    assert.equal(guard.isExhausted, false)
    guard.observe({ inputTokens: 1_000_000, outputTokens: 50_000 }) // 150 fen
    await settle()
    assert.equal(fired, 1)
    assert.equal(guard.isExhausted, true)
    guard.observe({ inputTokens: 5_000_000, outputTokens: 0 })
    await settle()
    assert.equal(fired, 1)
  })

  it('coalesces bursts while a lookup is in flight and still evaluates the latest snapshot', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let lookups = 0
    _setPlatformPricingLookupForTests(async () => {
      lookups++
      if (lookups === 1) await gate
      return PRICING
    })
    let fired = 0
    const guard = new CreditBudgetGuard({
      budgetFen: 100n,
      modelId: () => 'm',
      composeAgentMultiplier: false,
      isLive: () => true,
      onExhausted: () => { fired++ },
    })
    guard.observe({ inputTokens: 10, outputTokens: 0 })
    guard.observe({ inputTokens: 100, outputTokens: 0 })
    guard.observe({ inputTokens: 1_000_000, outputTokens: 0 }) // latest wins → 100 fen
    await settle()
    assert.equal(fired, 0)
    release()
    await settle()
    assert.equal(lookups, 2, 'one in-flight + one for the coalesced latest snapshot')
    assert.equal(fired, 1)
  })

  it('never fires for a turn that is no longer live', async () => {
    _setPlatformPricingLookupForTests(async () => PRICING)
    let live = true
    let fired = 0
    const guard = new CreditBudgetGuard({
      budgetFen: 1n,
      modelId: () => 'm',
      composeAgentMultiplier: false,
      isLive: () => live,
      onExhausted: () => { fired++ },
    })
    guard.observe({ inputTokens: 1_000_000, outputTokens: 0 })
    live = false
    await settle()
    assert.equal(fired, 0)
    assert.equal(guard.isExhausted, false)
  })

  it('fails open when pricing is missing', async () => {
    _setPlatformPricingLookupForTests(async () => null)
    let fired = 0
    const guard = new CreditBudgetGuard({
      budgetFen: 0n,
      modelId: () => 'm',
      composeAgentMultiplier: false,
      isLive: () => true,
      onExhausted: () => { fired++ },
    })
    guard.observe({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
    await settle()
    assert.equal(fired, 0)
  })

  it('applies the agent multiplier when asked (Codex/Grok settlement parity)', async () => {
    _setPlatformPricingLookupForTests(async () => PRICING)
    fakeCatalog('2.000')
    let fired = 0
    const guard = new CreditBudgetGuard({
      budgetFen: 200n,
      modelId: () => 'm',
      agentId: 'main',
      composeAgentMultiplier: true,
      isLive: () => true,
      onExhausted: () => { fired++ },
    })
    guard.observe({ inputTokens: 1_000_000, outputTokens: 0 }) // 100 × 2 = 200 fen
    await settle()
    assert.equal(fired, 1)
  })
})
