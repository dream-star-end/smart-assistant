/**
 * P3 cohort lane 评估单测(RFC-v5-dual-master-cohort §4 D1)。
 *   1. laneHash:钉死实现的穷举稳定性(golden 值 + 幂等 + 范围 [0,99])。
 *   2. evaluateLane:全分支(stable 恒 active=零行为变化基石 / aborting / allowlist /
 *      percent 覆盖与否 / candidate_slot 缺失 / row null)。
 *   3. 指标:lane_evaluations 计数 + lane_users (generation,uid) 去重 + generation 滚动。
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import {
  type DeployStateLaneRow,
  evaluateLane,
  evaluateLaneForUser,
  getLaneMetricsSnapshot,
  laneHash,
  _resetLaneMetricsForTesting,
  _resetLaneStateCacheForTesting,
} from '../deploy/laneEvaluate.js'

const SALT = 'rollout-salt-1'

function row(over: Partial<DeployStateLaneRow> = {}): DeployStateLaneRow {
  return {
    generation: '5',
    phase: 'canary',
    active_slot: 'A',
    candidate_slot: 'B',
    cohort_percent: 0,
    cohort_salt: SALT,
    cohort_allowlist: [],
    ...over,
  }
}

// ─── laneHash ────────────────────────────────────────────────────────

describe('laneHash', () => {
  test('golden 值(sha256(salt:uid) 前 8 hex → uint32 mod 100)', () => {
    // 与 SQL / 脚本三侧共用同一钉死定义;这些值即三处必须一致的锚点。
    assert.equal(laneHash('1', SALT), 7)
    assert.equal(laneHash('2', SALT), 73)
    assert.equal(laneHash('1000000', SALT), 0)
  })

  test('幂等:同 (uid,salt) 多次调用恒等', () => {
    for (const uid of ['1', '2', '1000000', '42', '7', '999999999999']) {
      assert.equal(laneHash(uid, SALT), laneHash(uid, SALT))
    }
  })

  test('穷举 0..999 uid:恒落 [0,99]', () => {
    for (let i = 0; i < 1000; i++) {
      const h = laneHash(String(i), SALT)
      assert.ok(Number.isInteger(h) && h >= 0 && h < 100, `uid=${i} → ${h} 越界`)
    }
  })

  test('换 salt 结果改变(同 rollout 固定 salt,新 rollout 才换)', () => {
    // 极小概率相等,取多个 uid 只要有一个不同即证明 salt 参与哈希。
    const diff = ['1', '2', '3', '4', '5'].some((u) => laneHash(u, SALT) !== laneHash(u, 'other-salt'))
    assert.ok(diff)
  })
})

// ─── evaluateLane 全分支 ─────────────────────────────────────────────

describe('evaluateLane', () => {
  test('row=null → active,清 cookie', () => {
    assert.deepEqual(evaluateLane('1', null), { lane: 'active', cookieValue: null })
  })

  test('phase=stable(基建版 seed)→ 恒 active(零行为变化基石)', () => {
    assert.deepEqual(
      evaluateLane('1', row({ phase: 'stable', cohort_percent: 100, candidate_slot: 'B' })),
      { lane: 'active', cookieValue: null },
    )
  })

  test('phase=aborting → active(无灰度目标)', () => {
    assert.deepEqual(
      evaluateLane('1', row({ phase: 'aborting', cohort_percent: 100 })),
      { lane: 'active', cookieValue: null },
    )
  })

  test('candidate_slot 为空 → active', () => {
    assert.deepEqual(
      evaluateLane('1', row({ candidate_slot: null, cohort_percent: 100 })),
      { lane: 'active', cookieValue: null },
    )
  })

  test('percent=0 且不在 allowlist → active', () => {
    assert.deepEqual(evaluateLane('1', row({ cohort_percent: 0 })), {
      lane: 'active',
      cookieValue: null,
    })
  })

  test('allowlist 命中(即使 percent=0)→ candidate', () => {
    assert.deepEqual(
      evaluateLane('1', row({ cohort_percent: 0, cohort_allowlist: ['1', '2'], generation: '9' })),
      { lane: 'candidate', cookieValue: 'g9.B' },
    )
  })

  test('percent 覆盖(laneHash<percent)→ candidate;不覆盖 → active', () => {
    // uid '1' → laneHash=7
    assert.deepEqual(evaluateLane('1', row({ cohort_percent: 8 })), {
      lane: 'candidate',
      cookieValue: 'g5.B',
    })
    // 边界:percent=7 → 7<7 false → active
    assert.deepEqual(evaluateLane('1', row({ cohort_percent: 7 })), {
      lane: 'active',
      cookieValue: null,
    })
  })

  test('finalizing 阶段同样按 cohort 路由', () => {
    assert.deepEqual(
      evaluateLane('1', row({ phase: 'finalizing', cohort_percent: 100, candidate_slot: 'A', active_slot: 'B', generation: '12' })),
      { lane: 'candidate', cookieValue: 'g12.A' },
    )
  })

  test('cookie 值编码当前 generation + candidate slot', () => {
    const d = evaluateLane('1', row({ cohort_percent: 100, generation: '42', candidate_slot: 'B' }))
    assert.equal(d.cookieValue, 'g42.B')
  })
})

// ─── 指标 ────────────────────────────────────────────────────────────

describe('lane metrics', () => {
  beforeEach(() => {
    _resetLaneMetricsForTesting()
    _resetLaneStateCacheForTesting()
  })

  test('evaluateLaneForUser 记 evaluations + (generation,uid) 去重', async () => {
    const r = row({ generation: '5', cohort_percent: 100, candidate_slot: 'B', active_slot: 'A' })
    await evaluateLaneForUser('1', { row: r })
    await evaluateLaneForUser('1', { row: r }) // 同 uid 重复 → evaluations+1,users 不变
    await evaluateLaneForUser('2', { row: r })
    const snap = getLaneMetricsSnapshot()
    assert.equal(snap.generation, '5')
    const b = snap.buckets.find((x) => x.lane === 'candidate' && x.slot === 'B')!
    assert.equal(b.evaluations, 3)
    assert.equal(b.uniqueUsers, 2)
    assert.equal(b.usersCapped, false)
  })

  test('active 决策记到 active_slot 桶', async () => {
    const r = row({ generation: '5', cohort_percent: 0, active_slot: 'A' })
    await evaluateLaneForUser('1', { row: r })
    const snap = getLaneMetricsSnapshot()
    const b = snap.buckets.find((x) => x.lane === 'active' && x.slot === 'A')!
    assert.equal(b.evaluations, 1)
    assert.equal(b.uniqueUsers, 1)
  })

  test('generation 变化 → 指标滚动清空', async () => {
    await evaluateLaneForUser('1', { row: row({ generation: '5', cohort_percent: 100 }) })
    assert.equal(getLaneMetricsSnapshot().generation, '5')
    await evaluateLaneForUser('1', { row: row({ generation: '6', cohort_percent: 100 }) })
    const snap = getLaneMetricsSnapshot()
    assert.equal(snap.generation, '6')
    // 只保留当前代:总 evaluations = 本代 1 次
    const total = snap.buckets.reduce((s, x) => s + x.evaluations, 0)
    assert.equal(total, 1)
  })

  test('row=null(deploy_state 缺失)→ active 且不记指标', async () => {
    const d = await evaluateLaneForUser('1', { row: null })
    assert.deepEqual(d, { lane: 'active', cookieValue: null })
    assert.equal(getLaneMetricsSnapshot().generation, null)
  })
})
