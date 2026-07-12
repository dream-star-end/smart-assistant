/**
 * OAuth pending state PG store 单测(RFC-v5-dual-master-cohort §4 D7)。
 *
 * 用内存版 runner 忠实模拟 oauth_pending_states 的三条 SQL(INSERT / 原子
 * DELETE…RETURNING(带 expires_at>now() + provider)/ GC),覆盖安全语义:
 *   - 只存 hash,不存原始 state(库里 key 不等于 state)
 *   - 原子单次消费:consume 命中后行被删,重放返 null
 *   - 过期拒绝:expires_at 过期 → 消费 null
 *   - provider 隔离:github 的 state 不能当 linuxdo 消费
 *   - payload 加密:落库的是密文(≠ 明文 JSON),解密后拿回 payload
 *   - 密文被篡改 → 消费 null(fail-closed)
 *   - GC 清过期行
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import type { QueryRunner } from '../db/queries.js'
import {
  consumeOAuthPendingState,
  gcExpiredOAuthPendingStates,
  putOAuthPendingState,
} from '../auth/oauthPendingStore.js'

// pending payload 加密所需 KMS key
process.env.OPENCLAUDE_KMS_KEY = Buffer.alloc(32, 0x5a).toString('base64')

interface FakeRow {
  payload: string
  expires_at: Date
}

/** 内存版 oauth_pending_states(对齐 0135:单 payload TEXT 列),暴露内部 map 供断言/篡改。 */
function makeFakeStore(): { runner: QueryRunner; rows: Map<string, FakeRow> } {
  const rows = new Map<string, FakeRow>()
  const runner = {
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    async query(sql: string, params: readonly unknown[] = []): Promise<any> {
      if (sql.includes('INSERT INTO oauth_pending_states')) {
        const [stateHash, payload, expiresAt] = params as [string, string, Date]
        rows.set(stateHash, { payload, expires_at: expiresAt })
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('RETURNING payload')) {
        const [stateHash] = params as [string]
        const row = rows.get(stateHash)
        if (row && row.expires_at.getTime() > Date.now()) {
          rows.delete(stateHash)
          return { rows: [{ payload: row.payload }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('DELETE FROM oauth_pending_states WHERE expires_at')) {
        const [cutoff] = params as [Date]
        let n = 0
        for (const [k, v] of rows) {
          if (v.expires_at.getTime() <= cutoff.getTime()) {
            rows.delete(k)
            n += 1
          }
        }
        return { rows: [], rowCount: n }
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  } as unknown as QueryRunner
  return { runner, rows }
}

const hashState = (provider: string, state: string): string =>
  createHash('sha256').update(`${provider}:${state}`).digest('hex')

describe('oauthPendingStore', () => {
  test('put→consume:拿回 payload;库里 key=hash 且为密文(不含原始 state / 明文)', async () => {
    const { runner, rows } = makeFakeStore()
    await putOAuthPendingState({ provider: 'github', state: 'st-abc', payload: { userId: 42 }, runner })

    // 库里只有 hash,没有原始 state
    assert.equal(rows.size, 1)
    assert.ok(rows.has(hashState('github', 'st-abc')))
    assert.ok(!rows.has('st-abc'))
    // payload 是密文(base64 打包),不是明文 JSON
    const stored = rows.get(hashState('github', 'st-abc'))!
    assert.ok(!stored.payload.includes('userId'))

    const payload = await consumeOAuthPendingState({ provider: 'github', state: 'st-abc', runner })
    assert.deepEqual(payload, { userId: 42 })
    assert.equal(rows.size, 0, '消费即删除')
  })

  test('原子单次消费:重放第二次返 null', async () => {
    const { runner } = makeFakeStore()
    await putOAuthPendingState({ provider: 'linuxdo', state: 's1', payload: {}, runner })
    const first = await consumeOAuthPendingState({ provider: 'linuxdo', state: 's1', runner })
    assert.deepEqual(first, {})
    const second = await consumeOAuthPendingState({ provider: 'linuxdo', state: 's1', runner })
    assert.equal(second, null)
  })

  test('未知 state → null', async () => {
    const { runner } = makeFakeStore()
    const r = await consumeOAuthPendingState({ provider: 'github', state: 'never', runner })
    assert.equal(r, null)
  })

  test('过期拒绝:expires_at 已过 → 消费 null', async () => {
    const { runner, rows } = makeFakeStore()
    // ttl 为负 → expiresAt 落在过去
    await putOAuthPendingState({ provider: 'github', state: 'exp', payload: { userId: 1 }, ttlMs: -60_000, runner })
    const r = await consumeOAuthPendingState({ provider: 'github', state: 'exp', runner })
    assert.equal(r, null, '过期 state 不可消费')
    assert.equal(rows.size, 0, 'put 自带懒 GC 已清过期行')
  })

  test('provider 隔离:github 的 state 不能当 linuxdo 消费', async () => {
    const { runner } = makeFakeStore()
    await putOAuthPendingState({ provider: 'github', state: 'shared', payload: { userId: 7 }, runner })
    const asLinuxdo = await consumeOAuthPendingState({ provider: 'linuxdo', state: 'shared', runner })
    assert.equal(asLinuxdo, null)
    // 用对 provider 仍能消费
    const asGithub = await consumeOAuthPendingState({ provider: 'github', state: 'shared', runner })
    assert.deepEqual(asGithub, { userId: 7 })
  })

  test('密文被篡改 → 消费 null(fail-closed,行仍被删不留复用窗口)', async () => {
    const { runner, rows } = makeFakeStore()
    await putOAuthPendingState({ provider: 'github', state: 'tamper', payload: { userId: 9 }, runner })
    // 篡改密文最后一字节(破坏 GCM tag),再 base64 回写
    const row = rows.get(hashState('github', 'tamper'))!
    const raw = Buffer.from(row.payload, 'base64')
    raw[raw.length - 1] ^= 0xff
    row.payload = raw.toString('base64')
    const r = await consumeOAuthPendingState({ provider: 'github', state: 'tamper', runner })
    assert.equal(r, null)
    assert.equal(rows.size, 0, '篡改行也被 DELETE 消费掉,不留复用窗口')
  })

  test('gcExpiredOAuthPendingStates 清过期行、留未过期', async () => {
    const { runner, rows } = makeFakeStore()
    await putOAuthPendingState({ provider: 'github', state: 'fresh', payload: {}, ttlMs: 600_000, runner })
    // 手动塞一条过期行(绕过 put 的懒 GC)
    rows.set(hashState('linuxdo', 'stale'), {
      payload: Buffer.alloc(28).toString('base64'),
      expires_at: new Date(Date.now() - 1000),
    })
    const removed = await gcExpiredOAuthPendingStates(runner)
    assert.equal(removed, 1)
    assert.ok(rows.has(hashState('github', 'fresh')))
    assert.ok(!rows.has(hashState('linuxdo', 'stale')))
  })
})
