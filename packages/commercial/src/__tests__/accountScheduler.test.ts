/**
 * T-32 单元测试:scheduler 纯函数 — defaultHash / parseMaxConcurrentEnv /
 * computeAccountWeight / pickWRH。不触 DB。
 *
 * v3 0064(2026-05-13)起 pickSticky/pickWeighted 已合并为单一 pickWRH 算法,
 * 见 scheduler.ts 文件头注释。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  AccountPoolBusyError,
  AccountPoolUnavailableError,
  DEFAULT_MAX_CONCURRENT_PER_ACCOUNT,
  ERR_ACCOUNT_POOL_BUSY,
  ERR_ACCOUNT_POOL_UNAVAILABLE,
  computeAccountWeight,
  defaultHash,
  parseMaxConcurrentEnv,
  pickWRH,
} from '../account-pool/scheduler.js'
import type { CandidateRow } from '../account-pool/scheduler.js'

const NOW = new Date('2026-05-13T00:00:00Z')

function mkRow(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    id: overrides.id ?? '1',
    plan: overrides.plan ?? 'pro',
    health_score: overrides.health_score ?? 100,
    quota_5h_pct: overrides.quota_5h_pct ?? null,
    quota_7d_pct: overrides.quota_7d_pct ?? null,
    subscription_end_at: overrides.subscription_end_at ?? null,
  }
}

function mkCandidates(n: number, health = 100): CandidateRow[] {
  const rows: CandidateRow[] = []
  for (let i = 1; i <= n; i += 1) {
    rows.push(mkRow({ id: String(i), health_score: health }))
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

describe('computeAccountWeight', () => {
  test('全 NULL 字段 → health × 1 × 1 × 1', () => {
    const r = mkRow({ health_score: 100 })
    assert.equal(computeAccountWeight(r, NOW), 100)
  })

  test('health=0 时仍 floor 至 1(× 中性因子)', () => {
    const r = mkRow({ health_score: 0 })
    assert.equal(computeAccountWeight(r, NOW), 1)
  })

  test('quota 50% 临界 → 中性 1.0', () => {
    const r = mkRow({ health_score: 100, quota_5h_pct: 50 })
    assert.equal(computeAccountWeight(r, NOW), 100)
  })

  test('quota 95% 钳到 0.05 → 100 × 0.05 = 5', () => {
    const r = mkRow({ health_score: 100, quota_5h_pct: 95 })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 5) < 1e-9)
  })

  test('quota 100% 也是 0.05(钳位)', () => {
    const r = mkRow({ health_score: 100, quota_5h_pct: 100 })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 5) < 1e-9)
  })

  test('quota 72.5%(50→95 中点)→ 因子 ≈ 0.525', () => {
    const r = mkRow({ health_score: 100, quota_5h_pct: 72.5 })
    // (72.5 - 50) / 45 = 0.5,1.0 - 0.5*0.95 = 0.525
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 52.5) < 1e-6)
  })

  test('5h + 7d 配额因子相乘', () => {
    const r = mkRow({ health_score: 100, quota_5h_pct: 95, quota_7d_pct: 95 })
    // 100 × 0.05 × 0.05 = 0.25,但 floor 0.05
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 0.25) < 1e-9)
  })

  test('NaN / 负数 quota → 中性 1.0', () => {
    const r1 = mkRow({ health_score: 100, quota_5h_pct: Number.NaN })
    const r2 = mkRow({ health_score: 100, quota_5h_pct: -5 })
    assert.equal(computeAccountWeight(r1, NOW), 100)
    assert.equal(computeAccountWeight(r2, NOW), 100)
  })

  test('subscription 30 天后 → 中性 1.0', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 30 * 86_400_000),
    })
    assert.equal(computeAccountWeight(r, NOW), 100)
  })

  test('subscription <7 天 → 因子 0.7', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 5 * 86_400_000),
    })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 70) < 1e-9)
  })

  test('subscription <2 天 → 因子 0.3', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 1.5 * 86_400_000),
    })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 30) < 1e-9)
  })

  test('subscription 已过期 → 因子 0.1', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() - 86_400_000),
    })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 10) < 1e-9)
  })

  test('subscription 边界刚好 7 天 → 因子 1.0(下闭上开:days < 7 → 0.7,days ≥ 7 → 1.0)', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 7 * 86_400_000),
    })
    assert.equal(computeAccountWeight(r, NOW), 100)
  })

  test('subscription 边界刚好 2 天 → 因子 0.7(下闭上开:days < 2 → 0.3,days ≥ 2 → 0.7)', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 2 * 86_400_000),
    })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 70) < 1e-9)
  })

  test('多因子组合:health=80 + quota_5h=70 + sub<7d → 80 × ~0.578 × 0.7', () => {
    const r = mkRow({
      health_score: 80,
      quota_5h_pct: 70,
      subscription_end_at: new Date(NOW.getTime() + 5 * 86_400_000),
    })
    // quota: (70-50)/45 = 0.444..,1 - 0.444*0.95 = 0.5778
    // 80 * 0.5778 * 0.7 ≈ 32.356
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 32.356) < 0.1)
  })

  test('极端劣:health=0 + quota=100 + sub 过期 → floor 0.05', () => {
    const r = mkRow({
      health_score: 0,
      quota_5h_pct: 100,
      quota_7d_pct: 100,
      subscription_end_at: new Date(NOW.getTime() - 86_400_000),
    })
    // 1 × 0.05 × 0.05 × 0.1 = 0.00025 → floor 0.05
    assert.equal(computeAccountWeight(r, NOW), 0.05)
  })
})

describe('pickWRH', () => {
  test('空候选 → AccountPoolUnavailableError', () => {
    assert.throws(
      () => pickWRH([], 'sess', NOW),
      (err: unknown) =>
        err instanceof AccountPoolUnavailableError &&
        (err as AccountPoolUnavailableError).code === ERR_ACCOUNT_POOL_UNAVAILABLE,
    )
  })

  test('同 key + 同候选 → 同账号(WRH 确定性)', () => {
    const cands = mkCandidates(5)
    const first = pickWRH(cands, 'sess-1', NOW)
    for (let i = 0; i < 50; i += 1) {
      assert.equal(pickWRH(cands, 'sess-1', NOW).id, first.id)
    }
  })

  test('不同 key 倾向不同账号(分布:5 个等权,~20%)', () => {
    const cands = mkCandidates(5)
    const hits = new Map<string, number>()
    for (let i = 0; i < 2000; i += 1) {
      const c = pickWRH(cands, `sess-${i}`, NOW)
      hits.set(c.id, (hits.get(c.id) ?? 0) + 1)
    }
    assert.equal(hits.size, 5, 'all 5 ids should be hit')
    for (const [id, count] of hits.entries()) {
      const pct = count / 2000
      assert.ok(pct > 0.13 && pct < 0.28, `id=${id} hit rate ${pct} out of bounds`)
    }
  })

  test('候选下线 → 大部分 key 仍 stick 到原账号(rendezvous 稳定性)', () => {
    const full = mkCandidates(5)
    const reduced = full.filter((c) => c.id !== '3')
    let migrated = 0
    const SAMPLES = 1000
    for (let i = 0; i < SAMPLES; i += 1) {
      const before = pickWRH(full, `k-${i}`, NOW)
      const after = pickWRH(reduced, `k-${i}`, NOW)
      if (before.id !== after.id) migrated += 1
    }
    // 理论 ≈ 1/5 = 20%,容忍 12%~30%
    const pct = migrated / SAMPLES
    assert.ok(pct > 0.12 && pct < 0.3, `migration rate ${pct} out of bounds`)
  })

  test('权重悬殊:weight 100 vs weight 10 → 大致 10:1 概率', () => {
    const cands: CandidateRow[] = [
      mkRow({ id: 'hi', health_score: 100 }),
      mkRow({ id: 'lo', health_score: 10 }),
    ]
    const counts = { hi: 0, lo: 0 }
    const N = 20_000
    for (let i = 0; i < N; i += 1) {
      counts[pickWRH(cands, `seed-${i}`, NOW).id as 'hi' | 'lo'] += 1
    }
    const ratio = counts.hi / counts.lo
    // 理论 10;容忍 7~14
    assert.ok(ratio > 7 && ratio < 14, `ratio ${ratio} out of bounds`)
  })

  test('全 health=0 退化为 floor=1 → 均匀分布', () => {
    const cands: CandidateRow[] = [
      mkRow({ id: 'a', health_score: 0 }),
      mkRow({ id: 'b', health_score: 0 }),
      mkRow({ id: 'c', health_score: 0 }),
    ]
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 }
    const N = 9000
    for (let i = 0; i < N; i += 1) {
      counts[pickWRH(cands, `seed-${i}`, NOW).id] += 1
    }
    for (const id of ['a', 'b', 'c']) {
      const pct = counts[id] / N
      assert.ok(pct > 0.28 && pct < 0.38, `id=${id} pct=${pct}`)
    }
  })

  test('注入 hash 可重现选择(让 id=2 获得"最幸运" u → score 最小)', () => {
    const cands = mkCandidates(3)
    // hash(`anything:2`) → 1n(很小)→ u 接近 0 → -ln(u) 很大;但其他更大
    // 改成:让 id=2 的 hash 极小(u 接近 0,-ln(u) 大)反而 score 大不被选。
    // 让 id=2 的 hash 极大(u 接近 1,-ln(u) 接近 0)→ score 最小 → 被选。
    const fake = (s: string): bigint => (s.endsWith(':2') ? (1n << 64n) - 1n : 1n)
    assert.equal(pickWRH(cands, 'anything', NOW, fake).id, '2')
  })

  test('注入低 weight 影响分布:weight 高的胜出概率高', () => {
    // 用 subscription 因子拉低 id=2 的 weight(过期),id=1 中性 1.0
    const cands: CandidateRow[] = [
      mkRow({ id: '1', health_score: 100 }),
      mkRow({
        id: '2',
        health_score: 100,
        subscription_end_at: new Date(NOW.getTime() - 86_400_000), // 过期 → 0.1
      }),
    ]
    let count1 = 0
    let count2 = 0
    const N = 10_000
    for (let i = 0; i < N; i += 1) {
      const p = pickWRH(cands, `seed-${i}`, NOW)
      if (p.id === '1') count1 += 1
      else count2 += 1
    }
    // weight 比 100:10 → 10:1
    const ratio = count1 / count2
    assert.ok(ratio > 7 && ratio < 14, `ratio ${ratio} out of bounds`)
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

/**
 * WRH 漂移性质 —— 防回归到普通 hash / 阶跃因子 / 错算分。
 *
 * 这组测试**专门**验证 "异常情况下 session 不该漂移" 的 WRH 核心承诺,
 * 与上面的"单次选号正确性"互补。Codex round-3 plan reviewed PASS。
 */
describe('WRH drift properties', () => {
  function pickOver(
    candidates: ReadonlyArray<CandidateRow>,
    sessionIds: ReadonlyArray<string>,
  ): string[] {
    return sessionIds.map((sid) => pickWRH(candidates, sid, NOW).id)
  }

  // 1000 个 deterministic sessionId,用 defaultHash 在不同 Node 版本上稳定
  const SESSIONS = Array.from({ length: 1000 }, (_, i) => `sess-${i.toString().padStart(4, '0')}`)

  test('T1: 删一个候选 → 只 ~1/N session 迁移,其余 winner 100% 不变', () => {
    const pool5 = mkCandidates(5) // id=1..5, 全等权
    const winners5 = pickOver(pool5, SESSIONS)
    const pool4 = pool5.filter((c) => c.id !== '1') // 删 id=1
    const winners4 = pickOver(pool4, SESSIONS)

    // 不在被删账号上的 session — winner 必须 100% 不变(WRH 最小迁移定理)
    let unchanged = 0
    let migrated = 0
    const migrationTargets = new Map<string, number>()
    for (let i = 0; i < SESSIONS.length; i += 1) {
      if (winners5[i] === '1') {
        migrated += 1
        migrationTargets.set(winners4[i], (migrationTargets.get(winners4[i]) ?? 0) + 1)
        assert.notEqual(winners4[i], '1', '被删账号不能再出现在新结果里')
      } else {
        unchanged += 1
        assert.equal(
          winners4[i],
          winners5[i],
          `session ${SESSIONS[i]} winner 不应漂移:before=${winners5[i]} after=${winners4[i]}`,
        )
      }
    }
    // 等权下,1/5 的 session 命中被删账号 → 期望 200,±60 容忍 hash 偏度
    assert.ok(migrated >= 140 && migrated <= 260, `migrated=${migrated} should be ~200`)
    assert.equal(unchanged + migrated, SESSIONS.length)

    // 被删 session 应均匀迁移到剩余 4 个,每个期望 50,允许 ±30
    for (const id of ['2', '3', '4', '5']) {
      const cnt = migrationTargets.get(id) ?? 0
      assert.ok(cnt >= 20 && cnt <= 80, `id=${id} got ${cnt} migrations, expected ~50±30`)
    }
  })

  test('T2: quota 49→51(平滑段起点)→ 非目标账号 session winner 100% 不变,目标账号小幅减少', () => {
    // 5 候选,id=1 是"目标账号"
    const base = mkCandidates(5)
    const before = base.map((c) => (c.id === '1' ? { ...c, quota_5h_pct: 49 } : c))
    const after = base.map((c) => (c.id === '1' ? { ...c, quota_5h_pct: 51 } : c))

    // 边界验证:49 时 weight=100 (≤50 → factor=1.0), 51 时 weight≈97.89
    assert.equal(computeAccountWeight(before[0], NOW), 100)
    const wAfter = computeAccountWeight(after[0], NOW)
    assert.ok(Math.abs(wAfter - 97.889) < 0.05, `expected weight ~97.89, got ${wAfter}`)

    const w1 = pickOver(before, SESSIONS)
    const w2 = pickOver(after, SESSIONS)

    // 单调性核心断言:非目标账号原 winner 一定不变 — 目标 weight 下降只能让目标失客户,
    // 不可能让原本不在目标上的 session 改投目标(score 单调变差)
    let n1 = 0
    let n2 = 0
    for (let i = 0; i < SESSIONS.length; i += 1) {
      if (w1[i] === '1') n1 += 1
      if (w2[i] === '1') n2 += 1
      if (w1[i] !== '1') {
        assert.equal(
          w2[i],
          w1[i],
          `非目标 session ${SESSIONS[i]} 不应迁移:before=${w1[i]} after=${w2[i]}`,
        )
      }
    }
    assert.ok(n2 <= n1, `n2=${n2} must be ≤ n1=${n1} (目标 weight 下降只能减少命中)`)
    // 理论: n1≈200, n2≈197 (weight 100 vs 97.89, denominator 500 vs 497.89)
    assert.ok(n1 - n2 < 30, `drift n1-n2=${n1 - n2} too large; expected <30 for 49→51 smooth segment`)
  })

  test('T3: 全候选 weight floor=0.05 → 仍 deterministic,winner 分布近等权', () => {
    // 5 候选全极差:health=0 + quota=100 + sub 过期
    const expired = new Date(NOW.getTime() - 86_400_000)
    const pool = Array.from({ length: 5 }, (_, i) =>
      mkRow({
        id: String(i + 1),
        health_score: 0,
        quota_5h_pct: 100,
        quota_7d_pct: 100,
        subscription_end_at: expired,
      }),
    )
    for (const c of pool) {
      const w = computeAccountWeight(c, NOW)
      assert.ok(Math.abs(w - 0.05) < 1e-9, `floor 不生效: id=${c.id} weight=${w}`)
    }

    // 同 key 两次必须返同账号(deterministic)
    assert.equal(pickWRH(pool, 'sess-x', NOW).id, pickWRH(pool, 'sess-x', NOW).id)

    // 1000 sessions 分布近等权(每个 ~200,±50 容忍)
    const winners = pickOver(pool, SESSIONS)
    const counts = new Map<string, number>()
    for (const id of winners) counts.set(id, (counts.get(id) ?? 0) + 1)
    for (const c of pool) {
      const n = counts.get(c.id) ?? 0
      assert.ok(n >= 150 && n <= 250, `id=${c.id} count=${n} (expected ~200±50 equal-weight)`)
    }
  })

  // T4 不是 WRH 漂移定理测试,而是 scheduler.pick 的 inflight cap 集成行为。
  // 集成测试在 accountScheduler.integ.test.ts 已覆盖(需 PG fixture),此处不重复。

  test('T5: subscription 7d → 7d-1s 跨阶跃边界 → 比例符合 weight 比,非目标 session 不漂移', () => {
    // 5 候选,id=1 是目标,其余 4 个 sub=NOW+7d 锁在 factor=1.0
    const sub7d = new Date(NOW.getTime() + 7 * 86_400_000)
    const sub7dMinus1s = new Date(NOW.getTime() + 7 * 86_400_000 - 1000)

    const before = Array.from({ length: 5 }, (_, i) =>
      mkRow({ id: String(i + 1), health_score: 100, subscription_end_at: sub7d }),
    )
    const after = before.map((c) =>
      c.id === '1' ? { ...c, subscription_end_at: sub7dMinus1s } : c,
    )

    // 边界 weight 验证: 7d → factor=1.0, 7d-1s → factor=0.7
    assert.equal(computeAccountWeight(before[0], NOW), 100)
    assert.ok(Math.abs(computeAccountWeight(after[0], NOW) - 70) < 1e-9)

    const w1 = pickOver(before, SESSIONS)
    const w2 = pickOver(after, SESSIONS)

    let n1 = 0
    let n2 = 0
    for (let i = 0; i < SESSIONS.length; i += 1) {
      if (w1[i] === '1') n1 += 1
      if (w2[i] === '1') n2 += 1
      // 单调性:目标 weight 下降,原本不在目标的 session 不可能改投目标
      if (w1[i] !== '1') {
        assert.equal(w2[i], w1[i], `非目标 session winner 异常漂移`)
      }
    }
    // 理论: n1 = 1000 * 100/500 = 200, n2 = 1000 * 70/470 ≈ 149,比例 ≈ 0.745
    const ratio = n2 / n1
    assert.ok(
      ratio >= 0.65 && ratio <= 0.85,
      `subscription 7d→7d-1s drift ratio=${ratio.toFixed(3)}, expected ~0.745 ±0.08`,
    )
  })
})
