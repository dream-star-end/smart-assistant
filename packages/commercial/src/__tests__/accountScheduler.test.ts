/**
 * T-32 单元测试:scheduler 纯函数 — defaultHash / parseMaxConcurrentEnv /
 * computeAccountWeight / pickWRH。不触 DB。
 *
 * v3 0064(2026-05-13)起 pickSticky/pickWeighted 已合并为单一 pickWRH 算法,
 * 见 scheduler.ts 文件头注释。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AccountHealthTracker } from '../account-pool/health.js'
import {
  AccountPoolBusyError,
  AccountPoolUnavailableError,
  AccountScheduler,
  DEFAULT_MAX_CONCURRENT_PER_ACCOUNT,
  DEFAULT_QUOTA_BACKOFF_PCT,
  DEFAULT_SLOT_LEASE_TTL_MS,
  ERR_ACCOUNT_POOL_BUSY,
  ERR_ACCOUNT_POOL_UNAVAILABLE,
  SLOT_LEASE_TTL_CEIL_MS,
  computeAccountWeight,
  defaultHash,
  parseMaxConcurrentEnv,
  parseQuotaBackoffPctEnv,
  parseSlotLeaseTtlEnv,
  pickWRH,
  sanitizeSlotLeaseTtl,
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
    pinned_user_id:
      overrides.pinned_user_id ??
      '0'.repeat(63) + ((Number(overrides.id ?? '1') % 16).toString(16)),
    account_uuid: overrides.account_uuid ?? null,
    persona: overrides.persona ?? null,
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

  // subscription 因子 — 收益最大化方向:**快到期加权,远期让路**
  test('subscription 远期 60 天 → 因子 0.8(让路给快到期的)', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 60 * 86_400_000),
    })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 80) < 1e-9)
  })

  test('subscription 月内 15 天 → 因子 1.0(中性)', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 15 * 86_400_000),
    })
    assert.equal(computeAccountWeight(r, NOW), 100)
  })

  test('subscription <7 天 (5d) → 因子 1.5(优先吃)', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 5 * 86_400_000),
    })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 150) < 1e-9)
  })

  test('subscription <2 天 (1.5d) → 因子 2.0(紧急榨)', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 1.5 * 86_400_000),
    })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 200) < 1e-9)
  })

  test('subscription 已过期 → 因子 0.1(belt+suspenders;health 系统应 disable)', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() - 86_400_000),
    })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 10) < 1e-9)
  })

  test('subscription 边界刚好 30 天 → 因子 0.8(下闭上开:days < 30 → 1.0,days ≥ 30 → 0.8)', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 30 * 86_400_000),
    })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 80) < 1e-9)
  })

  test('subscription 边界刚好 7 天 → 因子 1.0(下闭上开:days < 7 → 1.5,days ≥ 7 → 1.0)', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 7 * 86_400_000),
    })
    assert.equal(computeAccountWeight(r, NOW), 100)
  })

  test('subscription 边界刚好 2 天 → 因子 1.5(下闭上开:days < 2 → 2.0,days ≥ 2 → 1.5)', () => {
    const r = mkRow({
      health_score: 100,
      subscription_end_at: new Date(NOW.getTime() + 2 * 86_400_000),
    })
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 150) < 1e-9)
  })

  test('多因子组合:health=80 + quota_5h=70 (≈0.578) + sub<7d (1.5) → ≈69.34', () => {
    const r = mkRow({
      health_score: 80,
      quota_5h_pct: 70,
      subscription_end_at: new Date(NOW.getTime() + 5 * 86_400_000),
    })
    // quota: (70-50)/45 = 0.444..,1 - 0.444*0.95 = 0.5778
    // 80 * 0.5778 * 1.5 ≈ 69.336
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 69.336) < 0.1)
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

  test('快到期+触顶矛盾:sub<2d (2.0) × quota_7d=90% (≈0.156) → 31.11 (合理折中,不 override quota)', () => {
    const r = mkRow({
      health_score: 100,
      quota_7d_pct: 90,
      subscription_end_at: new Date(NOW.getTime() + 1 * 86_400_000),
    })
    // q7d: (90-50)/45 = 0.8889, 1 - 0.8889*0.95 = 0.1556
    // 100 * 0.1556 * 2.0 ≈ 31.11 — 想榨干但不能为榨干撞 rate limit
    assert.ok(Math.abs(computeAccountWeight(r, NOW) - 31.11) < 0.5)
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

  test('注入低 weight 影响分布:weight 高的胜出概率高(sub 过期 0.1 vs 中性 1.0)', () => {
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

  test('收益最大化方向:sub<2d (factor 2.0) 比中性 (factor 1.0) 优先 ~2:1', () => {
    // 业务语义验证 — 订阅快到期的账号应该优先吃流量榨干额度
    const cands: CandidateRow[] = [
      mkRow({ id: 'urgent', health_score: 100, subscription_end_at: new Date(NOW.getTime() + 86_400_000) }), // 1d → 2.0
      mkRow({ id: 'normal', health_score: 100, subscription_end_at: new Date(NOW.getTime() + 15 * 86_400_000) }), // 15d → 1.0
    ]
    let urgent = 0
    let normal = 0
    const N = 10_000
    for (let i = 0; i < N; i += 1) {
      const p = pickWRH(cands, `seed-${i}`, NOW)
      if (p.id === 'urgent') urgent += 1
      else normal += 1
    }
    // weight 比 200:100 → 2:1
    const ratio = urgent / normal
    assert.ok(ratio > 1.7 && ratio < 2.4, `urgent/normal ratio=${ratio} expected ~2.0`)
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

describe('parseQuotaBackoffPctEnv(反封复盘 2026-08)', () => {
  test('undefined/空 → 默认 95', () => {
    assert.equal(parseQuotaBackoffPctEnv(undefined), DEFAULT_QUOTA_BACKOFF_PCT)
    assert.equal(parseQuotaBackoffPctEnv(''), DEFAULT_QUOTA_BACKOFF_PCT)
  })
  test('1..100 整数 → 透传', () => {
    assert.equal(parseQuotaBackoffPctEnv('1'), 1)
    assert.equal(parseQuotaBackoffPctEnv('90'), 90)
    assert.equal(parseQuotaBackoffPctEnv('100'), 100)
  })
  test('0/>100/负数/小数/非数字 → 默认 95', () => {
    assert.equal(parseQuotaBackoffPctEnv('0'), DEFAULT_QUOTA_BACKOFF_PCT)
    assert.equal(parseQuotaBackoffPctEnv('101'), DEFAULT_QUOTA_BACKOFF_PCT)
    assert.equal(parseQuotaBackoffPctEnv('-5'), DEFAULT_QUOTA_BACKOFF_PCT)
    assert.equal(parseQuotaBackoffPctEnv('95.5'), DEFAULT_QUOTA_BACKOFF_PCT)
    assert.equal(parseQuotaBackoffPctEnv('abc'), DEFAULT_QUOTA_BACKOFF_PCT)
    assert.equal(parseQuotaBackoffPctEnv('95xyz'), DEFAULT_QUOTA_BACKOFF_PCT)
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

  test('T5: subscription 7d → 7d-1s 跨阶跃边界(1.0→1.5 上升)→ 目标命中 superset 单调性', () => {
    // 收益最大化方向反转后,跨过 7d 边界进入"<7d 优先"档,目标 weight 由 1.0 升到 1.5。
    // WRH 性质:weight 上升 → 目标 winner 集合是原集合的 superset。
    //   - 原本在目标的 session:100% 仍在
    //   - 原本不在目标的 session:只能保持原 winner 或迁移到目标(不能从 B 漂到 C)
    //   - n2 >= n1
    const sub7d = new Date(NOW.getTime() + 7 * 86_400_000)
    const sub7dMinus1s = new Date(NOW.getTime() + 7 * 86_400_000 - 1000)

    const before = Array.from({ length: 5 }, (_, i) =>
      mkRow({ id: String(i + 1), health_score: 100, subscription_end_at: sub7d }),
    )
    const after = before.map((c) =>
      c.id === '1' ? { ...c, subscription_end_at: sub7dMinus1s } : c,
    )

    // 边界 weight 验证: 7d → factor=1.0 → weight=100;7d-1s → factor=1.5 → weight=150
    assert.equal(computeAccountWeight(before[0], NOW), 100)
    assert.ok(Math.abs(computeAccountWeight(after[0], NOW) - 150) < 1e-9)

    const w1 = pickOver(before, SESSIONS)
    const w2 = pickOver(after, SESSIONS)

    let n1 = 0
    let n2 = 0
    for (let i = 0; i < SESSIONS.length; i += 1) {
      if (w1[i] === '1') n1 += 1
      if (w2[i] === '1') n2 += 1
      // 单调性 superset:原在目标必须仍在目标;原不在目标只能保持原 winner 或漂到目标。
      // 不允许 B → C 这种非目标之间的漂移(因为只有目标 score 变好,其他相对关系不变)
      if (w1[i] === '1') {
        assert.equal(w2[i], '1', `原在目标的 session ${SESSIONS[i]} 不应离开目标`)
      } else {
        const allowed = w2[i] === w1[i] || w2[i] === '1'
        assert.ok(
          allowed,
          `原非目标 session ${SESSIONS[i]} 异常漂移:before=${w1[i]} after=${w2[i]} (只允许保持或迁移到目标)`,
        )
      }
    }
    assert.ok(n2 >= n1, `n2=${n2} must be ≥ n1=${n1} (目标 weight 上升只能增加命中)`)
    // 理论: n1 = 1000 * 100/500 = 200, n2 = 1000 * 150/550 ≈ 273,ratio ≈ 1.364
    const ratio = n2 / n1
    assert.ok(
      ratio >= 1.2 && ratio <= 1.55,
      `subscription 7d→7d-1s drift ratio=${ratio.toFixed(3)}, expected ~1.36 [1.2,1.55]`,
    )
  })

  test('T6: subscription 2d → 2d-1s 跨阶跃边界(1.5→2.0 二次上升)→ superset 单调性仍成立', () => {
    // 再跨一档:从"<7d 优先(1.5)"进入"<2d 紧急(2.0)",weight 100*1.5=150 升到 100*2.0=200
    const sub2d = new Date(NOW.getTime() + 2 * 86_400_000)
    const sub2dMinus1s = new Date(NOW.getTime() + 2 * 86_400_000 - 1000)

    const before = Array.from({ length: 5 }, (_, i) =>
      mkRow({ id: String(i + 1), health_score: 100, subscription_end_at: sub2d }),
    )
    const after = before.map((c) =>
      c.id === '1' ? { ...c, subscription_end_at: sub2dMinus1s } : c,
    )

    assert.ok(Math.abs(computeAccountWeight(before[0], NOW) - 150) < 1e-9)
    assert.ok(Math.abs(computeAccountWeight(after[0], NOW) - 200) < 1e-9)

    const w1 = pickOver(before, SESSIONS)
    const w2 = pickOver(after, SESSIONS)

    let n1 = 0
    let n2 = 0
    for (let i = 0; i < SESSIONS.length; i += 1) {
      if (w1[i] === '1') n1 += 1
      if (w2[i] === '1') n2 += 1
      if (w1[i] === '1') {
        assert.equal(w2[i], '1', `原在目标的 session 不应离开目标`)
      } else {
        const allowed = w2[i] === w1[i] || w2[i] === '1'
        assert.ok(allowed, `非目标 session 异常漂移(超出 superset 边界)`)
      }
    }
    assert.ok(n2 >= n1, `n2=${n2} must be ≥ n1=${n1}`)
    // 理论: before 全 sub2d → 5 个候选 weight 都是 150,总 750,target 期望 1000*150/750=200
    //       after  其他 4 个仍 150,target 升到 200,总 800,target 期望 1000*200/800=250
    //       ratio = 250/200 = 1.25
    const ratio = n2 / n1
    assert.ok(
      ratio >= 1.1 && ratio <= 1.4,
      `subscription 2d→2d-1s drift ratio=${ratio.toFixed(3)}, expected ~1.25 [1.1,1.4]`,
    )
  })
})

// ─── B6/B7 per-slot 租约(slot 内存方法不触 DB/health,可纯单元测) ──────────

const stubHealth = {
  onSuccess: async () => null,
  onFailure: async () => null,
} as unknown as AccountHealthTracker

/** 构造仅用于 slot 内存方法测试的 scheduler。 */
function mkSlotScheduler(
  opts: {
    slotIds?: string[]
    nowRef?: { ms: number }
    maxConcurrent?: number
    slotLeaseTtlMs?: number
    ephemeralKey?: () => string
  } = {},
): AccountScheduler {
  let i = 0
  const slotIdFn = opts.slotIds ? () => opts.slotIds?.[i++] ?? `auto-${i}` : undefined
  const now = opts.nowRef ? () => new Date(opts.nowRef?.ms ?? 0) : undefined
  return new AccountScheduler({
    health: stubHealth,
    slotIdFn,
    now,
    ephemeralKey: opts.ephemeralKey,
    maxConcurrent: opts.maxConcurrent,
    slotLeaseTtlMs: opts.slotLeaseTtlMs,
  })
}

describe('per-slot 租约:精确 acquire/release', () => {
  test('同账号两槽互不干扰:release 其一,另一仍在', () => {
    const s = mkSlotScheduler({ slotIds: ['s1', 's2'] })
    const a = s.acquireCodexSlot('100')
    const b = s.acquireCodexSlot('100')
    assert.equal(a, 's1')
    assert.equal(b, 's2')
    assert.equal(s.getInflight('100'), 2)
    s.releaseCodexSlot('100', a)
    assert.equal(s.getInflight('100'), 1) // s2 仍在
    s.releaseCodexSlot('100', b)
    assert.equal(s.getInflight('100'), 0) // 归 0,account entry 删除
  })

  test('双重 release / 未知 slotId / 未知 account 幂等:不变负', () => {
    const s = mkSlotScheduler({ slotIds: ['s1'] })
    const a = s.acquireCodexSlot('100')
    s.releaseCodexSlot('100', a)
    s.releaseCodexSlot('100', a) // 二次还同 slot
    s.releaseCodexSlot('100', 'never') // 未知 slot
    s.releaseCodexSlot('999', 'never') // 未知 account
    assert.equal(s.getInflight('100'), 0)
  })

  test('错配 release 不误伤同账号其它活跃槽(精度根因)', () => {
    const s = mkSlotScheduler({ slotIds: ['s1', 's2'] })
    s.acquireCodexSlot('100') // s1
    const b = s.acquireCodexSlot('100') // s2
    s.releaseCodexSlot('100', 'bogus') // 不属于该账号的 slotId → 不扣任何槽
    assert.equal(s.getInflight('100'), 2)
    s.releaseCodexSlot('100', b)
    assert.equal(s.getInflight('100'), 1)
  })
})

describe('per-slot 租约:cap 与 slotId 唯一性', () => {
  test('cap 到达 acquireCodexSlot 抛 AccountPoolBusyError', () => {
    const s = mkSlotScheduler({ maxConcurrent: 2 })
    s.acquireCodexSlot('100')
    s.acquireCodexSlot('100')
    assert.throws(() => s.acquireCodexSlot('100'), AccountPoolBusyError)
    assert.equal(s.getInflight('100'), 2)
  })

  test('slotId 唯一性独立于 ephemeralKey:ephemeralKey 固定也不互相覆盖', () => {
    const s = mkSlotScheduler({ ephemeralKey: () => 'FIXED' }) // slotIdFn 默认 randomUUID
    s.acquireCodexSlot('100')
    s.acquireCodexSlot('100')
    assert.equal(s.getInflight('100'), 2)
  })

  test('slotIdFn 退化为非唯一时 acquireSlot 防御性抛错(不 under-count)', () => {
    const s = new AccountScheduler({ health: stubHealth, slotIdFn: () => 'DUP' })
    s.acquireCodexSlot('100') // 第一个 'DUP' ok
    assert.throws(() => s.acquireCodexSlot('100'), /colliding ids/)
  })
})

describe('reapExpiredSlots(B7)', () => {
  test('renew keeps a live long-running slot ahead of the orphan reaper', () => {
    const nowRef = { ms: 0 }
    const s = mkSlotScheduler({ slotIds: ['long-turn'], nowRef })
    const slotId = s.acquireCodexSlot('100')
    nowRef.ms = s.slotLeaseTtlMs - 1
    assert.equal(s.renewCodexSlot('100', slotId), true)
    assert.equal(s.renewCodexSlot('100', 'unknown'), false)
    assert.equal(s.reapExpiredSlots(s.slotLeaseTtlMs + 1), 0)
    assert.equal(s.getInflight('100'), 1)
  })

  test('回收超 TTL 的槽,保留新槽', () => {
    const nowRef = { ms: 0 }
    const s = mkSlotScheduler({ slotIds: ['old', 'fresh'], nowRef })
    const ttl = s.slotLeaseTtlMs
    s.acquireCodexSlot('100') // acquiredAt=0
    nowRef.ms = ttl - 100
    s.acquireCodexSlot('100') // fresh, acquiredAt=ttl-100
    assert.equal(s.getInflight('100'), 2)
    // 在 ttl+1 时刻 reap:old 龄=ttl+1>ttl 回收;fresh 龄=101<ttl 保留
    const reaped = s.reapExpiredSlots(ttl + 1)
    assert.equal(reaped, 1)
    assert.equal(s.getInflight('100'), 1)
  })

  test('durable Grok lease rehydrates after 30m+ reaper and blocks reallocation until terminal release', () => {
    const nowRef = { ms: 0 }
    const s = mkSlotScheduler({ slotIds: ['original', 'next'], nowRef, maxConcurrent: 1 })
    const slotId = s.acquireCodexSlot('100')
    nowRef.ms = s.slotLeaseTtlMs + 1
    assert.equal(s.reapExpiredSlots(), 1)
    assert.equal(s.getInflight('100'), 0)

    // An active grok_route_context is reloaded before the next allocation.
    s.restoreCodexSlot('100', slotId)
    assert.equal(s.getInflight('100'), 1)
    assert.throws(() => s.acquireCodexSlot('100'), AccountPoolBusyError)

    // Terminal billing expires the durable row and releases this exact mirror.
    s.releaseCodexSlot('100', slotId)
    assert.equal(s.acquireCodexSlot('100'), 'next')
  })

  test('全部未过期:reap 不回收,返回 0', () => {
    const nowRef = { ms: 1000 }
    const s = mkSlotScheduler({ nowRef })
    s.acquireCodexSlot('100')
    assert.equal(s.reapExpiredSlots(1000 + 5), 0)
    assert.equal(s.getInflight('100'), 1)
  })

  test('nowMs 默认用注入 now()', () => {
    const nowRef = { ms: 0 }
    const s = mkSlotScheduler({ nowRef })
    s.acquireCodexSlot('100') // acquiredAt=0
    nowRef.ms = s.slotLeaseTtlMs + 10 // now() 推进过 TTL
    assert.equal(s.reapExpiredSlots(), 1) // 默认 nowMs=now()
    assert.equal(s.getInflight('100'), 0)
  })
})

describe('sanitizeSlotLeaseTtl / parseSlotLeaseTtlEnv', () => {
  const codex600 = 600_000
  test('默认 30min(codex floor 600s < 30min)', () => {
    assert.equal(sanitizeSlotLeaseTtl(undefined, codex600), DEFAULT_SLOT_LEASE_TTL_MS)
  })
  test('低于 floor → 抬到 floor(30min)', () => {
    assert.equal(sanitizeSlotLeaseTtl(1000, codex600), DEFAULT_SLOT_LEASE_TTL_MS)
  })
  test('floor=max(codex,30min):codex>30min 时下界=codex', () => {
    const codex40 = 40 * 60_000
    assert.equal(sanitizeSlotLeaseTtl(1000, codex40), codex40)
  })
  test('高于 ceil(24h)→ 夹到 ceil', () => {
    assert.equal(
      sanitizeSlotLeaseTtl(SLOT_LEASE_TTL_CEIL_MS + 1_000_000, codex600),
      SLOT_LEASE_TTL_CEIL_MS,
    )
  })
  test('codex floor>24h → ceil 抬到 floor,ttl≥floor≥codex 恒成立(Blocking 4)', () => {
    const codex25h = 25 * 60 * 60_000
    assert.equal(sanitizeSlotLeaseTtl(1000, codex25h), codex25h) // 抬到 floor=25h
    assert.equal(sanitizeSlotLeaseTtl(SLOT_LEASE_TTL_CEIL_MS, codex25h), codex25h) // 24h<floor → 25h
  })
  test('非法/非 SafeInteger → 默认 30min', () => {
    assert.equal(sanitizeSlotLeaseTtl(-5, codex600), DEFAULT_SLOT_LEASE_TTL_MS)
    assert.equal(
      sanitizeSlotLeaseTtl(Number.MAX_SAFE_INTEGER + 10, codex600),
      DEFAULT_SLOT_LEASE_TTL_MS,
    )
  })
  test('parseSlotLeaseTtlEnv:正整数采用,非法 undefined', () => {
    assert.equal(parseSlotLeaseTtlEnv('1800000'), 1_800_000)
    assert.equal(parseSlotLeaseTtlEnv('0'), undefined)
    assert.equal(parseSlotLeaseTtlEnv('-1'), undefined)
    assert.equal(parseSlotLeaseTtlEnv('1.5'), undefined)
    assert.equal(parseSlotLeaseTtlEnv('abc'), undefined)
    assert.equal(parseSlotLeaseTtlEnv(undefined), undefined)
    assert.equal(parseSlotLeaseTtlEnv(''), undefined)
  })
})
