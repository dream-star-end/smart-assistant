/**
 * Unit tests for `projectRecentSessions()` — admin 详情 modal 里
 * "最近会话 · 90 天" 列表的投影逻辑。
 *
 * 背景:历史 bug 修复 (2026-05) —— 此前 `recent_sessions` 来自 PG
 * `usage_records.session_id` (CCB metadata UUID),与详情接口查询的
 * SQLite `client_sessions.id` (web-* / wsess-*) 不在同一命名空间,
 * 导致 admin "点开看会话" 100% 命中 404。现切换到 SQLite client_sessions
 * 为唯一数据源,本函数负责 90 天过滤 + slice(10) + ISO 字段投影。
 *
 * 这里只测**纯函数行为**(无 SQLite/PG 依赖):
 *   1. 90 天 cutoff 按 `lastAt`(不是 `updatedAt`)
 *   2. 排序信赖上游 (last_at DESC),本函数不重排
 *   3. 最多 10 条
 *   4. 时间字段输出 ISO string
 *
 * 集成层契约 (storage `listClientSessions` 返回顺序 / namespace `c:${id}`
 * 拼接 / handleAdminGetSession scope cross-check) 不在本文件覆盖范围,
 * 由 code review 把关 —— 该路径只有一行 namespace 拼接逻辑,且依赖
 * 完整 master DB 链路,抽 helper 单测代价大于收益(参考仓内 mediaSign
 * 的"抽纯函数测"约定:HTTP handler 本身不走 unit)。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { projectRecentSessions } from '../users.js'

/** 构造一条 ClientSessionMeta-shape 的 fixture。lastAt 不传则等同 createdAt。 */
function mkSession(over: {
  id: string
  createdAt: number
  lastAt?: number
  updatedAt?: number
  title?: string
  agentId?: string
  messageCount?: number
}) {
  const lastAt = over.lastAt ?? over.createdAt
  return {
    id: over.id,
    agentId: over.agentId ?? 'main',
    title: over.title ?? `s-${over.id}`,
    createdAt: over.createdAt,
    lastAt,
    updatedAt: over.updatedAt ?? lastAt,
    messageCount: over.messageCount ?? 0,
  }
}

const NOW = Date.UTC(2026, 4, 15, 14, 0, 0) // 2026-05-15T14:00:00.000Z
const DAY = 24 * 60 * 60 * 1000

describe('projectRecentSessions — 90 天过滤', () => {
  test('lastAt 在 90 天内的保留,超出的丢弃', () => {
    const input = [
      mkSession({ id: 'in-1', createdAt: NOW - 89 * DAY }),
      mkSession({ id: 'in-2', createdAt: NOW - 30 * DAY }),
      mkSession({ id: 'out-1', createdAt: NOW - 91 * DAY }),
      mkSession({ id: 'out-2', createdAt: NOW - 180 * DAY }),
    ]
    const out = projectRecentSessions(input, NOW)
    assert.deepEqual(
      out.map((r) => r.session_id),
      ['in-1', 'in-2'],
    )
  })

  test('过滤口径是 lastAt,不是 updatedAt(updatedAt 在窗口内但 lastAt 不在 → 丢弃)', () => {
    // 场景:用户 100 天前的老 session,90 天内只是 admin 改了 title (updatedAt 刷新,
    // lastAt 不变)。"最近会话"应排除这种纯 metadata 写入。
    const input = [
      mkSession({
        id: 'stale',
        createdAt: NOW - 120 * DAY,
        lastAt: NOW - 100 * DAY,
        updatedAt: NOW - 5 * DAY, // 看着新,但 lastAt 才是对话维度
      }),
    ]
    const out = projectRecentSessions(input, NOW)
    assert.deepEqual(out, [])
  })

  test('lastAt 恰好等于 cutoff(now - 90d)的边界包含', () => {
    const exactly90d = NOW - 90 * DAY
    const input = [mkSession({ id: 'edge', createdAt: exactly90d })]
    const out = projectRecentSessions(input, NOW)
    assert.equal(out.length, 1)
    assert.equal(out[0].session_id, 'edge')
  })
})

describe('projectRecentSessions — 排序保留 + slice(10)', () => {
  test('不重排,严格保留输入顺序 (上游 listClientSessions 已 ORDER BY last_at DESC)', () => {
    // 故意构造"非 DESC"输入,确认本函数不会替上游兜底排序 ——
    // 如果上游契约被破坏,我们希望测试反映出来,而不是被本函数掩盖。
    const input = [
      mkSession({ id: 'a', createdAt: NOW - 10 * DAY }),
      mkSession({ id: 'b', createdAt: NOW - 1 * DAY }), // 更新但排第二
      mkSession({ id: 'c', createdAt: NOW - 5 * DAY }),
    ]
    const out = projectRecentSessions(input, NOW)
    assert.deepEqual(
      out.map((r) => r.session_id),
      ['a', 'b', 'c'],
    )
  })

  test('超过 10 条时截到前 10 条', () => {
    const input = Array.from({ length: 15 }, (_, i) =>
      mkSession({ id: `s${i}`, createdAt: NOW - i * DAY }),
    )
    const out = projectRecentSessions(input, NOW)
    assert.equal(out.length, 10)
    assert.deepEqual(
      out.map((r) => r.session_id),
      ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'],
    )
  })

  test('90 天过滤先于 slice (确保被过滤掉的不会占用 10 个名额)', () => {
    const input = [
      // 前 3 条都超 90 天 → 应整体丢弃
      mkSession({ id: 'old-1', createdAt: NOW - 100 * DAY }),
      mkSession({ id: 'old-2', createdAt: NOW - 95 * DAY }),
      mkSession({ id: 'old-3', createdAt: NOW - 91 * DAY }),
      // 再 12 条 90 天内 → 应留 10 条
      ...Array.from({ length: 12 }, (_, i) =>
        mkSession({ id: `new-${i}`, createdAt: NOW - i * DAY }),
      ),
    ]
    const out = projectRecentSessions(input, NOW)
    assert.equal(out.length, 10)
    assert.ok(out.every((r) => r.session_id.startsWith('new-')))
  })
})

describe('projectRecentSessions — 字段投影', () => {
  test('时间字段转 ISO string (与 topups / recent_requests 同 schema)', () => {
    const input = [
      mkSession({
        id: 'abc',
        title: 'Hello',
        agentId: 'codex',
        createdAt: Date.UTC(2026, 4, 1, 10, 30, 0),
        lastAt: Date.UTC(2026, 4, 10, 12, 0, 0),
        updatedAt: Date.UTC(2026, 4, 14, 8, 15, 0),
        messageCount: 42,
      }),
    ]
    const out = projectRecentSessions(input, NOW)
    assert.equal(out.length, 1)
    assert.deepEqual(out[0], {
      session_id: 'abc',
      title: 'Hello',
      agent_id: 'codex',
      message_count: 42,
      created_at: '2026-05-01T10:30:00.000Z',
      last_at: '2026-05-10T12:00:00.000Z',
      updated_at: '2026-05-14T08:15:00.000Z',
    })
  })

  test('不再含 request_count / total_cost_credits / first_at (旧 schema 字段已删)', () => {
    const out = projectRecentSessions([mkSession({ id: 'x', createdAt: NOW - 1 * DAY })], NOW)
    assert.equal(out.length, 1)
    const row = out[0] as unknown as Record<string, unknown>
    assert.ok(!('request_count' in row), 'request_count 应已移除')
    assert.ok(!('total_cost_credits' in row), 'total_cost_credits 应已移除')
    assert.ok(!('first_at' in row), 'first_at 应已移除')
  })

  test('空输入 → 空输出', () => {
    assert.deepEqual(projectRecentSessions([], NOW), [])
  })
})
