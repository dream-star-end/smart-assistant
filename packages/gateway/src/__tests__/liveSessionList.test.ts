/**
 * 巡检会话不得污染 live 会话列表,也不得当成长聊会话长留内存。
 *
 * 锁住 CORRECTIONS §1.3 / §1.4:
 *   - live 列表按 `isPatrolSessionKey` 排除 `agent:<id>:taskboard:...`
 *   - 普通 webchat 会话仍出现
 *   - `isTempSessionKey` 对 taskboard 为 true、对 webchat 为 false
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/liveSessionList.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { filterUserVisibleLiveSessions } from '../server.js'
import { isTempSessionKey } from '../sessionManager.js'
import { buildPatrolSessionKey, isPatrolSessionKey } from '../taskboard/domain.js'

const here = dirname(fileURLToPath(import.meta.url))
const PATROL_KEY = buildPatrolSessionKey('main', 'ticket-1', 'stage::design', 'run-9')
const WEBCHAT_KEY = 'agent:main:webchat:dm:web-peer-1'
const DELEGATE_KEY = 'agent:reviewer:delegate:main:1783900000000'
const CRON_KEY = 'agent:main:cron:dm:job-1'
const TASK_KEY = 'agent:main:task:task-1:1783900000000'

function live(sessionKey: string) {
  return {
    sessionKey,
    agentId: 'main',
    lastUsedAt: 1,
    ccbSessionId: null,
    turns: 0,
    totalCostUSD: 0,
  }
}

describe('filterUserVisibleLiveSessions', () => {
  test('taskboard 巡检会话不出现在 live 列表,即便 default 用户会把 stageId 误当成 peerId', () => {
    assert.equal(isPatrolSessionKey(PATROL_KEY), true)
    const owned = new Set(['stage::design', 'web-peer-1'])
    const result = filterUserVisibleLiveSessions(
      [live(PATROL_KEY), live(WEBCHAT_KEY)],
      owned,
      'default',
    )
    assert.deepEqual(
      result.map((s) => s.sessionKey),
      [WEBCHAT_KEY],
    )
  })

  test('普通 webchat 会话仍然出现', () => {
    const owned = new Set(['web-peer-1'])
    const result = filterUserVisibleLiveSessions([live(WEBCHAT_KEY)], owned, 'c:1')
    assert.equal(result.length, 1)
    assert.equal(result[0]?.sessionKey, WEBCHAT_KEY)
  })

  test('内部 delegate 会话仍被排除', () => {
    const result = filterUserVisibleLiveSessions(
      [live(DELEGATE_KEY), live(WEBCHAT_KEY)],
      new Set(['web-peer-1']),
      'default',
    )
    assert.deepEqual(
      result.map((s) => s.sessionKey),
      [WEBCHAT_KEY],
    )
  })

  test('kind 段碰巧含 taskboard 字样的 webchat peer 不被误杀', () => {
    const key = 'agent:main:webchat:dm:taskboard-fan'
    const result = filterUserVisibleLiveSessions([live(key)], new Set(['taskboard-fan']), 'c:1')
    assert.equal(result.length, 1)
    assert.equal(isPatrolSessionKey(key), false)
  })
})

describe('isTempSessionKey', () => {
  test('taskboard 巡检 key 视为临时会话', () => {
    assert.equal(isTempSessionKey(PATROL_KEY), true)
  })

  test('webchat key 不是临时会话', () => {
    assert.equal(isTempSessionKey(WEBCHAT_KEY), false)
  })

  test('cron / 旧 task 仍视为临时会话,delegate 仍不是', () => {
    assert.equal(isTempSessionKey(CRON_KEY), true)
    assert.equal(isTempSessionKey(TASK_KEY), true)
    assert.equal(isTempSessionKey(DELEGATE_KEY), false)
  })
})

describe('接线未漂移', () => {
  test('/api/sessions 走 filterUserVisibleLiveSessions,且调用 isPatrolSessionKey', () => {
    const source = readFileSync(join(here, '..', 'server.ts'), 'utf8')
    const start = source.indexOf("if (url.pathname === '/api/sessions') {")
    const end = source.indexOf("if (url.pathname === '/api/sessions/list'", start)
    assert.ok(start >= 0, 'GET /api/sessions handler missing')
    assert.ok(end > start, 'GET /api/sessions/list marker missing')
    const block = source.slice(start, end)
    assert.match(block, /filterUserVisibleLiveSessions\(/)
    assert.match(source, /import \{ isPatrolSessionKey \} from '\.\/taskboard\/domain\.js'/)
    assert.match(source, /if \(isPatrolSessionKey\(s\.sessionKey\)\) return false/)
  })

  test('LRU 驱逐使用 isTempSessionKey', () => {
    const source = readFileSync(join(here, '..', 'sessionManager.ts'), 'utf8')
    assert.match(source, /const isTempSession = isTempSessionKey\(key\)/)
    assert.match(source, /isPatrolSessionKey\(sessionKey\)/)
  })
})
