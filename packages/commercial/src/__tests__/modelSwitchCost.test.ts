import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'pg'
import { PricingCache, type ModelPricing } from '../billing/pricing.js'
import {
  readSwitchCostPolicy,
  expensiveSwitch,
  switchCostRange,
} from '../billing/modelSwitchCostPolicy.js'
import { ModelSwitchCostService, ModelSwitchCostError } from '../billing/modelSwitchCost.js'
import type { SwitchContext } from '../billing/modelSwitchCostContext.js'
const policy = readSwitchCostPolicy({})
const price = (
  id: string,
  input: number,
  output: number,
  read: number,
  write: number,
  multiplier = '1.000',
) =>
  ({
    model_id: id,
    display_name: id,
    input_per_mtok: BigInt(input),
    output_per_mtok: BigInt(output),
    cache_read_per_mtok: BigInt(read),
    cache_write_per_mtok: BigInt(write),
    multiplier,
  }) as ModelPricing

test('cost threshold filters cheap/small changes and covers large absolute changes', () => {
  assert.equal(expensiveSwitch(128n, 5n, policy), true)
  assert.equal(expensiveSwitch(10n, 5n, policy), false)
  assert.equal(expensiveSwitch(50n, 100n, policy), false)
  assert.equal(expensiveSwitch(510n, 400n, policy), true)
  assert.throws(() => readSwitchCostPolicy({ OC_MODEL_SWITCH_MIN_CREDITS: '-1' }))
  assert.throws(() => readSwitchCostPolicy({ OC_MODEL_SWITCH_RATIO_MILLI: '1000' }))
})
test('new input cannot inherit old cache hits', () => {
  const result = switchCostRange({
    contextTokens: 1000000,
    additionalTokens: 1000000,
    output: [0, 0],
    calls: 1,
    price: price('x', 100, 0, 1, 0),
    warmRatio: 1,
  })
  assert.equal(result.expectedCredits, '101')
})
test('cold context is input OR cache write, and predicted requests round separately', () => {
  assert.equal(
    switchCostRange({
      contextTokens: 1000000,
      additionalTokens: 0,
      output: [0, 0],
      calls: 1,
      price: price('x', 100, 0, 10, 125),
      warmRatio: 0,
    }).expectedCredits,
    '126',
  )
  assert.equal(
    switchCostRange({
      contextTokens: 1,
      additionalTokens: 0,
      output: [0, 0],
      calls: 3,
      price: price('x', 1, 0, 1, 0),
      warmRatio: 0,
    }).expectedCredits,
    '3',
  )
})
function fixture() {
  let now = 1000
  let balance = 10000n
  const source = price('gpt-6-luna', 53, 265, 11, 64, '0.400')
  let target = price('gpt-6-astra', 598, 3598, 60, 0)
  const pricing = new PricingCache()
  pricing._setForTests([source, target])
  const context: SwitchContext = {
    revision: 7,
    fingerprint: 'root-v7',
    sourceModel: source.model_id,
    sourceAgent: 'main',
    tokens: 200453,
    source: 'last-call',
    warmRatio: 0,
    outputs: [7],
    calls: 1,
    lastOutputTokens: 7,
  }
  const pool = { query: async () => ({ rows: [{ cost_multiplier: '1.000' }] }) } as unknown as Pool
  const service = new ModelSwitchCostService({
    pool,
    pricing,
    secret: 'unit-test-secret-no-credential',
    policy,
    now: () => now,
    balance: async () => balance,
    readContext: async () => ({ ...context }),
    sourceEngine: () => 'codex',
    resolveTarget: async () => ({ pricing: target, engine: 'codex', contextWindow: 258400 }),
  })
  const request = {
    sessionId: 'own-session',
    requestId: 'm-switch-1',
    targetModel: target.model_id,
    agentId: 'main',
  }
  return {
    service,
    request,
    context,
    expire: () => {
      now += 300001
    },
    setBalance: (n: bigint) => {
      balance = n
    },
    changePrice: () => {
      target = { ...target, input_per_mtok: 599n }
    },
  }
}
const confirmation = (e: unknown) =>
  e instanceof ModelSwitchCostError && e.code === 'MODEL_SWITCH_CONFIRMATION_REQUIRED'
test('real 200k pricing fixture produces raw credit quote and a scoped consent', async () => {
  const f = fixture()
  const q = await f.service.quote('765', f.request)
  assert.equal(q.requiresConfirmation, true)
  assert.equal(q.targetCost!.expectedCredits, '128')
  assert.equal(q.currentCost!.expectedCredits, '5')
  assert.equal(q.contextTokens, 200453)
  assert.ok(BigInt(q.targetCost!.lowCredits) <= 125n && BigInt(q.targetCost!.highCredits) >= 125n)
  await assert.rejects(f.service.assertAuthorized('765', f.request, q.quoteToken), confirmation)
  const c = await f.service.confirm('765', f.request, q.quoteToken!)
  assert.ok(c.consent)
  await f.service.assertAuthorized('765', f.request, c.consent)
  await assert.rejects(f.service.assertAuthorized('766', f.request, c.consent), confirmation)
  await assert.rejects(
    f.service.assertAuthorized('765', { ...f.request, requestId: 'm-other' }, c.consent),
    confirmation,
  )
  await assert.rejects(
    f.service.assertAuthorized(
      '765',
      { ...f.request, text: 'new material '.repeat(200000) },
      c.consent,
    ),
    confirmation,
  )
  await assert.rejects(
    f.service.assertAuthorized('765', f.request, `${c.consent!.slice(0, -2)}xx`),
    confirmation,
  )
})
test('changed context, price, expiry and balance require fresh user action', async () => {
  for (const change of ['context', 'price', 'expiry', 'balance'] as const) {
    const f = fixture()
    const q = await f.service.quote('765', f.request)
    const c = await f.service.confirm('765', f.request, q.quoteToken!)
    if (change === 'context') f.context.revision++
    if (change === 'price') f.changePrice()
    if (change === 'expiry') f.expire()
    if (change === 'balance') f.setBalance(1n)
    await assert.rejects(
      f.service.assertAuthorized('765', f.request, c.consent),
      (e) =>
        e instanceof ModelSwitchCostError &&
        (e.code === 'MODEL_SWITCH_CONFIRMATION_REQUIRED' ||
          e.code === 'MODEL_SWITCH_INSUFFICIENT_BALANCE'),
    )
  }
})
test('insufficient balance cannot obtain a consent', async () => {
  const f = fixture()
  f.setBalance(1n)
  const q = await f.service.quote('765', f.request)
  assert.equal(q.canConfirm, false)
  await assert.rejects(
    f.service.confirm('765', f.request, q.quoteToken!),
    (e) => e instanceof ModelSwitchCostError && e.code === 'MODEL_SWITCH_INSUFFICIENT_BALANCE',
  )
})

test('B uses null counts/costs, effective prices and explicit scoped risk consent', async () => {
  const f = fixture()
  f.context.tokens = null
  f.context.source = 'unknown'
  const q = await f.service.quote('765', f.request)
  assert.equal(q.mode, 'risk')
  assert.equal(q.contextTokens, null)
  assert.equal(q.targetCost, null)
  assert.equal(q.currentCost, null)
  assert.equal(q.targetUnitPrice?.input, '598')
  assert.equal(q.balanceCredits, '10000')
  await assert.rejects(f.service.assertAuthorized('765', f.request), confirmation)
  await assert.rejects(f.service.assertAuthorized('765', f.request, q.quoteToken), confirmation)
  const c = await f.service.confirm('765', f.request, q.quoteToken!)
  await f.service.assertAuthorized('765', f.request, c.consent)
  f.context.tokens = 200453
  f.context.source = 'last-call'
  await assert.rejects(f.service.assertAuthorized('765', f.request, c.consent), confirmation)
})
test('displayed balance is rechecked when confirming, fresh balance gates dispatch', async () => {
  const f = fixture()
  f.context.tokens = null
  f.context.source = 'unknown'
  const q = await f.service.quote('765', f.request)
  f.setBalance(9000n)
  await assert.rejects(
    f.service.confirm('765', f.request, q.quoteToken!),
    (e) => e instanceof ModelSwitchCostError && e.code === 'MODEL_SWITCH_QUOTE_CHANGED',
  )
  const fresh = await f.service.quote('765', f.request)
  const c = await f.service.confirm('765', f.request, fresh.quoteToken!)
  f.setBalance(0n)
  await assert.rejects(
    f.service.assertAuthorized('765', f.request, c.consent),
    (e) => e instanceof ModelSwitchCostError && e.code === 'MODEL_SWITCH_INSUFFICIENT_BALANCE',
  )
})
test('new/empty and actual same model do not ask, attachments require B', async () => {
  const f = fixture()
  f.context.source = 'empty'
  assert.equal((await f.service.quote('765', f.request)).requiresConfirmation, false)
  f.context.source = 'unchanged'
  assert.equal((await f.service.quote('765', f.request)).requiresConfirmation, false)
  f.context.source = 'last-call'
  const q = await f.service.quote('765', { ...f.request, mediaCount: 1 })
  assert.equal(q.mode, 'risk')
  assert.equal(q.targetCost, null)
})
test('database failure is not converted into an exempt quote', async () => {
  const f = fixture()
  Object.defineProperty(f.context, 'source', {
    get() {
      throw new Error('read failure')
    },
  })
  await assert.rejects(f.service.quote('765', f.request), /read failure/)
})
