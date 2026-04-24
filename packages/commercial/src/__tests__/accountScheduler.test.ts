/**
 * T-32 — scheduler 单元:pickSticky / pickWeighted / defaultHash 纯函数,不触 DB。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  AccountPoolBusyError,
  AccountPoolUnavailableError,
  DEFAULT_MAX_CONCURRENT_PER_ACCOUNT,
  ERR_ACCOUNT_POOL_BUSY,
  ERR_ACCOUNT_POOL_UNAVAILABLE,
  defaultHash,
  parseMaxConcurrentEnv,
  pickSticky,
  pickWeighted,
} from '../account-pool/scheduler.js'

type Row = { id: string; plan: 'pro' | 'max' | 'team'; health_score: number }

function mkCandidates(n: number, health = 100): Row[] {
  const rows: Row[] = []
  for (let i = 1; i <= n; i += 1) {
    rows.push({ id: String(i), plan: 'pro', health_score: health })
  }
  return rows
}

describe('defaultHash', () => {
  test('确定性:同输入同输出', () => {
    assert.equal(defaultHash('x'), defaultHash('x'))
  })
  test('不同输入高概率不同', () => {
    assert.notEqual(defaultHash('a'), defaultHash('b'))
  })
  test('返 64-bit BigInt(0 ≤ x < 2^64)', () => {
    const h = defaultHash('hello')
    assert.equal(typeof h, 'bigint')
    assert.ok(h >= 0n)
    assert.ok(h < 1n << 64n)
  })
})

describe('pickSticky', () => {
  test('同 sessionId 多次调用 → 同一账号', () => {
    const cands = mkCandidates(5)
    const first = pickSticky(cands, 'sess-1')
    for (let i = 0; i < 50; i += 1) {
      assert.equal(pickSticky(cands, 'sess-1').id, first.id)
    }
  })

  test('不同 sessionId 倾向不同账号(统计分布)', () => {
    const cands = mkCandidates(4)
    const hits = new Map<string, number>()
    for (let i = 0; i < 1000; i += 1) {
      const c = pickSticky(cands, `sess-${i}`)
      hits.set(c.id, (hits.get(c.id) ?? 0) + 1)
    }
    // 期望 4 个账号都至少被命中一次;每个账号占比大致 25%,容忍 ±15%
    assert.equal(hits.size, 4, 'all 4 ids should be hit')
    for (const [id, count] of hits.entries()) {
      const pct = count / 1000
      assert.ok(pct > 0.15 && pct < 0.4, `id=${id} hit rate ${pct} out of bounds`)
    }
  })

  test('账号下线(从候选集移除)→ 大部分 session 仍 stick 到原账号(rendezvous 稳定性)', () => {
    // 构造:5 个账号
    const full = mkCandidates(5)
    // 去掉 id=3
    const reduced = full.filter((c) => c.id !== '3')
    let migrated = 0
    const SAMPLES = 500
    for (let i = 0; i < SAMPLES; i += 1) {
      const before = pickSticky(full, `s-${i}`)
      const after = pickSticky(reduced, `s-${i}`)
      if (before.id !== after.id) migrated += 1
    }
    // 理论迁移 ≈ 1/N(这里 N=5)= 20%;容忍 10%~35%
    const pct = migrated / SAMPLES
    assert.ok(pct > 0.1 && pct < 0.35, `migration rate ${pct} out of bounds`)
  })

  test('注入 hash 可重现选择', () => {
    const cands = mkCandidates(3)
    const fake = (s: string): bigint => (s.endsWith('3') ? 99n : 0n)
    // id=3 的 hash 最大 → 选它
    assert.equal(pickSticky(cands, 'anything', fake).id, '3')
  })

  test('空候选 → AccountPoolUnavailableError', () => {
    assert.throws(
      () => pickSticky([], 'sess'),
      (err: unknown) =>
        err instanceof AccountPoolUnavailableError &&
        (err as AccountPoolUnavailableError).code === ERR_ACCOUNT_POOL_UNAVAILABLE,
    )
  })
})

describe('pickWeighted', () => {
  test('单账号 → 必选唯一', () => {
    const cands: Row[] = [{ id: '7', plan: 'pro', health_score: 50 }]
    assert.equal(pickWeighted(cands, () => 0.5).id, '7')
  })

  test('注入 random=0 → 选第一个;random=0.999 → 选最后', () => {
    const cands = mkCandidates(3, 100)
    assert.equal(pickWeighted(cands, () => 0).id, '1')
    assert.equal(pickWeighted(cands, () => 0.999999).id, '3')
  })

  test('权重悬殊:health=100 vs health=10,高 health 大致 ~10×概率', () => {
    const cands: Row[] = [
      { id: 'hi', plan: 'pro', health_score: 100 },
      { id: 'lo', plan: 'pro', health_score: 10 },
    ]
    const counts = { hi: 0, lo: 0 }
    // 用 LCG 作可重复 PRNG,避免偶发失败
    let state = 12345
    const prng = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state / 0x80000000
    }
    const N = 10_000
    for (let i = 0; i < N; i += 1) {
      counts[pickWeighted(cands, prng).id as 'hi' | 'lo'] += 1
    }
    const ratio = counts.hi / counts.lo
    // 理论 100 / 10 = 10;容忍 7~14
    assert.ok(ratio > 7 && ratio < 14, `ratio ${ratio} out of bounds`)
  })

  test('所有 health=0 退化为均匀(min weight=1)', () => {
    const cands: Row[] = [
      { id: 'a', plan: 'pro', health_score: 0 },
      { id: 'b', plan: 'pro', health_score: 0 },
      { id: 'c', plan: 'pro', health_score: 0 },
    ]
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 }
    let state = 987654
    const prng = (): number => {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      return state / 0x80000000
    }
    const N = 9000
    for (let i = 0; i < N; i += 1) {
      counts[pickWeighted(cands, prng).id] += 1
    }
    // 各 1/3 = 33%,容忍 ±5%
    for (const id of ['a', 'b', 'c']) {
      const pct = counts[id] / N
      assert.ok(pct > 0.28 && pct < 0.38, `id=${id} pct=${pct}`)
    }
  })

  test('空候选 → AccountPoolUnavailableError', () => {
    assert.throws(() => pickWeighted([]), AccountPoolUnavailableError)
  })
})

describe('parseMaxConcurrentEnv', () => {
  test('undefined/空 → 默认 10', () => {
    assert.equal(parseMaxConcurrentEnv(undefined), DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
    assert.equal(parseMaxConcurrentEnv(''), DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
  })
  test('纯正整数字符串 → 透传', () => {
    assert.equal(parseMaxConcurrentEnv('1'), 1)
    assert.equal(parseMaxConcurrentEnv('25'), 25)
    assert.equal(parseMaxConcurrentEnv('1000'), 1000)
  })
  test('0/负数/小数/trailing-garbage/非数字 → 默认 10', () => {
    assert.equal(parseMaxConcurrentEnv('0'), DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
    assert.equal(parseMaxConcurrentEnv('-3'), DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
    assert.equal(parseMaxConcurrentEnv('abc'), DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
    assert.equal(parseMaxConcurrentEnv('NaN'), DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
    assert.equal(parseMaxConcurrentEnv('10xyz'), DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
    assert.equal(parseMaxConcurrentEnv('1.5'), DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
    assert.equal(parseMaxConcurrentEnv(' 10'), DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
    assert.equal(parseMaxConcurrentEnv('01'), DEFAULT_MAX_CONCURRENT_PER_ACCOUNT)
  })
})

describe('AccountPoolBusyError', () => {
  test('code=ERR_ACCOUNT_POOL_BUSY,name 正确', () => {
    const e = new AccountPoolBusyError('test')
    assert.equal(e.code, ERR_ACCOUNT_POOL_BUSY)
    assert.equal(e.name, 'AccountPoolBusyError')
    assert.ok(e instanceof Error)
    assert.match(e.message, /account pool busy: test/)
  })
})
