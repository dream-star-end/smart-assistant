/**
 * Gateway 全局并发槽 / review 保留槽 env 旋钮。
 *
 * MAX_CONCURRENT_DELEGATIONS 与 DELEGATE_REVIEW_RESERVED_SLOTS 改为调用期 getter:
 *   OPENCLAUDE_DELEGATE_MAX_CONCURRENT      有限整数 ≥1,非法/缺省 → 5
 *   OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS 整数 ≥0,非法/缺省 → 1,且 clamp 到 max−1
 * 保证普通委派永远至少 1 槽。测试改 process.env 必须 afterEach 还原。
 *
 * Object.create(Gateway.prototype) 不跑字段初始化;本文件读的是 class static getter,
 * 不依赖实例字段。闸行为经真实 _checkDelegateResourceGate 交叉验证。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateEnvKnobs.test.ts
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { Gateway } from '../server.js'

const ENV_KEYS = [
  'OPENCLAUDE_DELEGATE_MAX_CONCURRENT',
  'OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS',
  'OPENCLAUDE_DELEGATE_MAX_PER_PARENT',
] as const

const ORIG_ENV: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) ORIG_ENV[k] = process.env[k]
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIG_ENV[k]
  }
})

type Caps = {
  MAX_CONCURRENT_DELEGATIONS: number
  DELEGATE_REVIEW_RESERVED_SLOTS: number
}

function caps(): { max: number; reserved: number } {
  const C = Gateway as unknown as Caps
  return { max: C.MAX_CONCURRENT_DELEGATIONS, reserved: C.DELEGATE_REVIEW_RESERVED_SLOTS }
}

function makeGate(): any {
  const gw = Object.create(Gateway.prototype) as any
  gw._activeDelegations = 0
  gw._runningDelegationsByParent = new Map()
  gw._readDelegateMemoryPressure = () => null
  return gw
}

function clearKnobEnv(): void {
  delete process.env.OPENCLAUDE_DELEGATE_MAX_CONCURRENT
  delete process.env.OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS
}

describe('Gateway.MAX_CONCURRENT_DELEGATIONS env getter', () => {
  it('缺省回落 5', () => {
    clearKnobEnv()
    assert.equal(caps().max, 5)
  })

  it('合法值生效', () => {
    process.env.OPENCLAUDE_DELEGATE_MAX_CONCURRENT = '8'
    assert.equal(caps().max, 8)
  })

  it('非法值回默认 5', () => {
    for (const raw of ['', 'abc', '-1', '0', 'NaN', 'Infinity']) {
      process.env.OPENCLAUDE_DELEGATE_MAX_CONCURRENT = raw
      assert.equal(caps().max, 5, `raw=${JSON.stringify(raw)} 应回落 5`)
    }
  })
})

describe('Gateway.DELEGATE_REVIEW_RESERVED_SLOTS env getter', () => {
  it('缺省回落 1', () => {
    clearKnobEnv()
    assert.equal(caps().reserved, 1)
  })

  it('合法值生效(含 0)', () => {
    process.env.OPENCLAUDE_DELEGATE_MAX_CONCURRENT = '5'
    process.env.OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS = '2'
    assert.equal(caps().reserved, 2)
    process.env.OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS = '0'
    assert.equal(caps().reserved, 0)
  })

  it('非法值回默认 1', () => {
    process.env.OPENCLAUDE_DELEGATE_MAX_CONCURRENT = '5'
    for (const raw of ['', 'abc', '-1', 'NaN', 'Infinity']) {
      process.env.OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS = raw
      assert.equal(caps().reserved, 1, `raw=${JSON.stringify(raw)} 应回落 1`)
    }
  })

  it('reserved≥max 时 clamp 到 max−1,普通槽 ≥1', () => {
    process.env.OPENCLAUDE_DELEGATE_MAX_CONCURRENT = '5'
    process.env.OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS = '5'
    assert.equal(caps().reserved, 4)
    assert.equal(caps().max - caps().reserved, 1)

    process.env.OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS = '99'
    assert.equal(caps().reserved, 4)
    assert.equal(caps().max - caps().reserved, 1)
  })

  it('max=1 时 reserved clamp 到 0,普通槽仍为 1', () => {
    process.env.OPENCLAUDE_DELEGATE_MAX_CONCURRENT = '1'
    process.env.OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS = '1'
    assert.equal(caps().max, 1)
    assert.equal(caps().reserved, 0)
    assert.equal(caps().max - caps().reserved, 1)
  })
})

describe('env knobs 驱动资源闸(调用期读,非加载期缓存)', () => {
  it('max=3 / reserved=1 → 非 review 在 2 处被拦,review 可用满 3', () => {
    process.env.OPENCLAUDE_DELEGATE_MAX_CONCURRENT = '3'
    process.env.OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS = '1'
    const gw = makeGate()
    gw._activeDelegations = 2
    assert.deepEqual(gw._checkDelegateResourceGate({ isReview: false }), { kind: 'concurrency' })
    assert.equal(gw._checkDelegateResourceGate({ isReview: true }), null)
    gw._activeDelegations = 3
    assert.deepEqual(gw._checkDelegateResourceGate({ isReview: true }), { kind: 'concurrency' })
  })

  it('同一进程内改 env 立即生效(证明非模块加载期缓存)', () => {
    const gw = makeGate()
    process.env.OPENCLAUDE_DELEGATE_MAX_CONCURRENT = '2'
    process.env.OPENCLAUDE_DELEGATE_REVIEW_RESERVED_SLOTS = '0'
    gw._activeDelegations = 2
    assert.deepEqual(gw._checkDelegateResourceGate({ isReview: false }), { kind: 'concurrency' })
    process.env.OPENCLAUDE_DELEGATE_MAX_CONCURRENT = '6'
    assert.equal(gw._checkDelegateResourceGate({ isReview: false }), null, '改 max 后应立刻放行')
  })
})
