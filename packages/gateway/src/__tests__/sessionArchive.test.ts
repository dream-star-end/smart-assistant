/**
 * 长会话热尾巴 + 归档(Agent B §2)— gateway pure helper + 帧 schema 测试。
 *
 * 覆盖:
 *   - _parseArchiveQuery:归档端点 before/limit 解析与边界收敛(参数校验 §2.5)。
 *   - _buildContextRebuiltFrame:sys.context_rebuilt 帧构造 + 路由继承(§2.3)。
 *   - SysContextRebuilt schema:Value.Check 接受合法帧 / 拒非法(frames.ts 类型补全)。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionArchive.test.ts
 * 与其它 gateway 测试一样由 root package.json `test:gateway` glob 命中。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Value } from '@sinclair/typebox/value'

import { _parseArchiveQuery, _buildContextRebuiltFrame } from '../server.js'
import { SysContextRebuilt } from '@openclaude/protocol'
import type { OutboundMessage } from '@openclaude/protocol'

// ── _parseArchiveQuery ──

test('archiveQuery: 缺省 → before=0 limit=100', () => {
  assert.deepEqual(_parseArchiveQuery(null, null), { beforeSeq: 0, limit: 100 })
})

test('archiveQuery: 合法值直通 + before 取整', () => {
  assert.deepEqual(_parseArchiveQuery('500', '50'), { beforeSeq: 500, limit: 50 })
  assert.deepEqual(_parseArchiveQuery('12.9', '30'), { beforeSeq: 12, limit: 30 })
})

test('archiveQuery: limit 上限 clamp 到 200', () => {
  assert.deepEqual(_parseArchiveQuery('0', '999'), { beforeSeq: 0, limit: 200 })
  assert.deepEqual(_parseArchiveQuery('0', '200'), { beforeSeq: 0, limit: 200 })
})

test('archiveQuery: 非法 limit(≤0 / NaN / 负)→ 默认 100', () => {
  assert.equal(_parseArchiveQuery('0', '0').limit, 100)
  assert.equal(_parseArchiveQuery('0', '-5').limit, 100)
  assert.equal(_parseArchiveQuery('0', 'abc').limit, 100)
})

test('archiveQuery: 非法 before(负 / NaN)→ 收敛到 0', () => {
  assert.equal(_parseArchiveQuery('-3', '10').beforeSeq, 0)
  assert.equal(_parseArchiveQuery('abc', '10').beforeSeq, 0)
})

// ── _buildContextRebuiltFrame ──

function baseOut(): OutboundMessage & { _userId?: string } {
  return {
    type: 'outbound.message',
    sessionKey: 'agent:main:dm:web:u1',
    channel: 'webchat',
    peer: { id: 'peer-1', kind: 'dm' },
    blocks: [],
    isFinal: false,
    _userId: 'c:42',
  }
}

test('contextRebuilt: 继承主 out 路由三件套 + _userId,补 agentId/messageCount', () => {
  const frame = _buildContextRebuiltFrame(baseOut(), 'coding-assistant', 40)
  assert.equal(frame.type, 'sys.context_rebuilt')
  assert.equal(frame.sessionKey, 'agent:main:dm:web:u1')
  assert.equal(frame.channel, 'webchat')
  assert.deepEqual(frame.peer, { id: 'peer-1', kind: 'dm' })
  assert.equal(frame.agentId, 'coding-assistant')
  assert.equal(frame.messageCount, 40)
  // _userId 私有路由字段被继承(deliver() 后续 strip);ts 不预填(deliver stamp)。
  assert.equal(frame._userId, 'c:42')
  assert.equal((frame as { ts?: number }).ts, undefined)
})

test('contextRebuilt: 主 out 无 _userId 时不带该字段(deliver 回退 default)', () => {
  const out = baseOut()
  delete out._userId
  const frame = _buildContextRebuiltFrame(out, 'main', 12)
  assert.equal('_userId' in frame, false)
})

test('contextRebuilt: 继承主 out 的 traceId(存在时)', () => {
  const out = { ...baseOut(), traceId: '01234567890abcdef01234567890abcd' }
  const frame = _buildContextRebuiltFrame(out, 'main', 5)
  assert.equal(frame.traceId, '01234567890abcdef01234567890abcd')
})

// ── SysContextRebuilt schema(frames.ts 类型补全,前科:漏 sys.frontend_build)──

test('schema: 合法 sys.context_rebuilt 帧 Value.Check 通过(带/不带 ts)', () => {
  const wireNoTs = {
    type: 'sys.context_rebuilt',
    sessionKey: 'sk',
    channel: 'webchat',
    peer: { id: 'p', kind: 'dm' },
    agentId: 'main',
    messageCount: 40,
  }
  assert.equal(Value.Check(SysContextRebuilt, wireNoTs), true)
  // deliver() stamp ts 之后的 wire 形状也要通过。
  assert.equal(Value.Check(SysContextRebuilt, { ...wireNoTs, ts: Date.now() }), true)
})

test('schema: 缺 messageCount / agentId → Value.Check 拒', () => {
  const base = {
    type: 'sys.context_rebuilt',
    sessionKey: 'sk',
    channel: 'webchat',
    peer: { id: 'p', kind: 'dm' },
    agentId: 'main',
    messageCount: 40,
  }
  const { messageCount, ...noCount } = base
  const { agentId, ...noAgent } = base
  assert.equal(Value.Check(SysContextRebuilt, noCount), false)
  assert.equal(Value.Check(SysContextRebuilt, noAgent), false)
})

test('schema: 错误 type 字面量 → Value.Check 拒', () => {
  assert.equal(
    Value.Check(SysContextRebuilt, {
      type: 'sys.frontend_build',
      sessionKey: 'sk',
      channel: 'webchat',
      peer: { id: 'p', kind: 'dm' },
      agentId: 'main',
      messageCount: 1,
    }),
    false,
  )
})
