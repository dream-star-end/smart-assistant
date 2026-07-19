/**
 * Tests for the CLIENT-PUT message strip (T1 / T2 / T24 in plan §五).
 *
 * `_stripClientPutMessage` is the single chokepoint that:
 *   1. Allow-lists client-authored fields (id/role/text/...).
 *   2. Restricts `status` to {sending, queued, sent, read} — `'replied'`
 *      is NEVER persisted (derived at render time).
 *   3. Drops + counts server-authoritative fields (_source, _seq, usage,
 *      _truncated, _errorCode, _errorDetail).
 *   4. Silently drops anything else (metaText, _rawMeta, _partial, …).
 *
 * Run: npx tsx --test packages/storage/src/__tests__/clientPutStrip.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-clientputstrip-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  _resetClientPutBlockedFieldCountsForTest,
  _stripClientPutMessage,
  _stripClientPutMessages,
  getClientPutBlockedFieldCounts,
  getSessionsDb,
  upsertClientSession,
} = await import('../sessionsDb.js')

describe('_stripClientPutMessage allow-list (T1, T2)', () => {
  beforeEach(() => {
    _resetClientPutBlockedFieldCountsForTest()
  })

  it('passes through a clean user message verbatim', () => {
    const cleaned = _stripClientPutMessage({
      id: 'm-1',
      role: 'user',
      text: 'hello',
      ts: 1000,
      createdAt: 1000,
      status: 'sending',
    })
    assert.deepEqual(cleaned, {
      id: 'm-1',
      role: 'user',
      text: 'hello',
      ts: 1000,
      createdAt: 1000,
      status: 'sending',
    })
  })

  it('preserves childBlocks / agentName / tool fields on assistant + tool messages', () => {
    const cleaned = _stripClientPutMessage({
      id: 'm-tool',
      role: 'tool',
      text: 'res',
      ts: 1,
      toolName: 'bash',
      toolIcon: 'terminal',
      toolInput: { command: 'ls' },
      toolUseId: 'tu-1',
      parentToolUseId: 'tu-0',
      childBlocks: [{ kind: 'text', text: 'inner' }],
      agentName: 'main',
      agentId: 'main',
    })
    assert.deepEqual(cleaned, {
      id: 'm-tool',
      role: 'tool',
      text: 'res',
      ts: 1,
      toolName: 'bash',
      toolIcon: 'terminal',
      toolInput: { command: 'ls' },
      toolUseId: 'tu-1',
      parentToolUseId: 'tu-0',
      childBlocks: [{ kind: 'text', text: 'inner' }],
      agentName: 'main',
      agentId: 'main',
    })
  })

  it('preserves _media / _modelText / _teamRun (client-persistent private fields)', () => {
    const cleaned = _stripClientPutMessage({
      id: 'm-1',
      role: 'user',
      text: 'photo!',
      ts: 1,
      _media: [{ kind: 'image', url: 'blob:foo' }],
      _modelText: 'photo! [image]',
      _teamRun: {
        id: 'programming_team',
        name: '编程协作团队',
        leaderAgentId: 'codex',
        modelOverride: 'gpt-5.6-sol',
      },
    })
    assert.deepEqual(cleaned?._media, [{ kind: 'image', url: 'blob:foo' }])
    assert.equal(cleaned?._modelText, 'photo! [image]')
    assert.deepEqual(cleaned?._teamRun, {
      id: 'programming_team',
      name: '编程协作团队',
      leaderAgentId: 'codex',
      modelOverride: 'gpt-5.6-sol',
    })
  })

  it('preserves codex plan fields for refresh-stable plan cards', () => {
    const cleaned = _stripClientPutMessage({
      id: 'plan-1',
      role: 'plan',
      text: '',
      explanation: '需要先确认计划',
      steps: [
        { step: '确认问题', status: 'completed' },
        { step: '修复 UI', status: 'inProgress' },
      ],
      blockId: 'codex-plan',
      ts: 123,
      completedAt: 456,
      _partial: false,
    })
    assert.deepEqual(cleaned, {
      id: 'plan-1',
      role: 'plan',
      text: '',
      explanation: '需要先确认计划',
      steps: [
        { step: '确认问题', status: 'completed' },
        { step: '修复 UI', status: 'inProgress' },
      ],
      blockId: 'codex-plan',
      ts: 123,
      completedAt: 456,
    })
  })

  it('preserves team/delegate card display fields only for team-owned roles', () => {
    const group = _stripClientPutMessage({
      id: 'g1',
      role: 'agent-group',
      text: '审查草稿',
      ts: 10,
      toolName: 'delegate_task',
      blockId: 'call-1',
      startTime: 9,
      _completed: true,
      _delegate: true,
      _delegateAgentId: 'hidden-reviewer',
      _delegateGoal: '审查草稿',
      _delegateRunId: 'run-1',
      // P2 债A 新增三态字段 —— 权威在 protocol TEAM_CARD_CLIENT_DISPLAY_FIELDS,
      // strip 白名单必须同步放行(否则 server-authored 团队行经全量 PUT 后
      // 丢掉 timeout/failed 语义)。
      _delegateStatus: 'timeout',
      _duration: 1234,
      _resultPreview: 'PASS',
      _isError: false,
      // f2272c08 前端新增的展示字段 —— 服务端白名单必须同步放行,否则全量
      // PUT 后"临时 Codex 子智能体"标注跨设备退化(清单权威在 protocol)。
      _agentGroupOrigin: 'codex-collab',
      _teamFallback: true,
      childBlocks: [{ kind: 'text', text: '审查结果正文' }],
    })
    assert.equal(group?._completed, true)
    assert.equal(group?._delegateAgentId, 'hidden-reviewer')
    assert.equal(group?._delegateGoal, '审查草稿')
    assert.equal(group?._delegateRunId, 'run-1')
    assert.equal(group?._delegateStatus, 'timeout')
    assert.equal(group?._resultPreview, 'PASS')
    assert.equal(group?._agentGroupOrigin, 'codex-collab')
    assert.equal(group?._teamFallback, true)
    assert.deepEqual(group?.childBlocks, [{ kind: 'text', text: '审查结果正文' }])

    const progress = _stripClientPutMessage({
      id: 'dp1',
      role: 'delegate-progress',
      text: '',
      ts: 20,
      runId: 'run-1',
      agentId: 'hidden-reviewer',
      goal: '审查草稿',
      entries: [{ phase: 'text', text: '正在审查', ts: 21 }],
      summary: 'PASS',
      _completed: true,
      _isError: false,
      error: false,
      _adoptedInto: 'g1',
    })
    assert.equal(progress?.runId, 'run-1')
    assert.equal(progress?.goal, '审查草稿')
    assert.deepEqual(progress?.entries, [{ phase: 'text', text: '正在审查', ts: 21 }])
    assert.equal(progress?.summary, 'PASS')
    assert.equal(progress?._completed, true)
    assert.equal(progress?._adoptedInto, 'g1')

    const ordinary = _stripClientPutMessage({
      id: 'a1',
      role: 'assistant',
      text: 'hi',
      ts: 30,
      _completed: true,
      summary: 'should drop',
      entries: [{ phase: 'text', text: 'should drop', ts: 31 }],
      _agentGroupOrigin: 'codex-collab',
      _teamFallback: true,
    })
    assert.equal(ordinary?._completed, undefined)
    assert.equal(ordinary?.summary, undefined)
    assert.equal(ordinary?.entries, undefined)
    assert.equal(ordinary?._agentGroupOrigin, undefined, 'team-only field stripped on assistant')
    assert.equal(ordinary?._teamFallback, undefined, 'team-only field stripped on assistant')
  })

  it('preserves _agentGroupOrigin / _teamFallback on delegate-progress rows too', () => {
    // 两个 team-owned role 都放行(清单权威 = protocol TEAM_CARD_CLIENT_DISPLAY_FIELDS)。
    const progress = _stripClientPutMessage({
      id: 'dp-origin',
      role: 'delegate-progress',
      text: '',
      ts: 40,
      runId: 'run-2',
      _agentGroupOrigin: 'codex-collab',
      _teamFallback: true,
    })
    assert.equal(progress?._agentGroupOrigin, 'codex-collab')
    assert.equal(progress?._teamFallback, true)
  })

  it('preserves status sending/queued/sent/read but drops "replied"', () => {
    for (const ok of ['sending', 'queued', 'sent', 'read']) {
      const c = _stripClientPutMessage({ id: 'x', role: 'user', text: '', ts: 1, status: ok })
      assert.equal(c?.status, ok)
    }
    const c = _stripClientPutMessage({ id: 'x', role: 'user', text: '', ts: 1, status: 'replied' })
    assert.equal(c?.status, undefined, 'replied dropped (derived now)')
  })

  it('drops + counts server-authoritative fields (_source/_seq/_orderSeq/_turnTapeOrdinal/usage/_truncated/_errorCode/_errorDetail)', () => {
    const cleaned = _stripClientPutMessage({
      id: 'm-evil',
      role: 'assistant',
      text: 'fake server msg',
      ts: 1,
      _source: 'server',
      _seq: 9999,
      _orderSeq: 7777,
      _turnTapeOrdinal: 42,
      usage: { costCredits: '1000', inputTokens: 0 },
      _truncated: true,
      _errorCode: 'oops',
      _errorDetail: 'forged',
    })
    assert.equal(cleaned?._source, undefined)
    assert.equal(cleaned?._seq, undefined)
    assert.equal(cleaned?._orderSeq, undefined)
    assert.equal(cleaned?._turnTapeOrdinal, undefined)
    assert.equal(cleaned?.usage, undefined)
    assert.equal(cleaned?._truncated, undefined)
    assert.equal(cleaned?._errorCode, undefined)
    assert.equal(cleaned?._errorDetail, undefined)

    const counts = getClientPutBlockedFieldCounts()
    assert.equal(counts._source, 1)
    assert.equal(counts._seq, 1)
    assert.equal(counts._orderSeq, 1)
    assert.equal(counts._turnTapeOrdinal, 1)
    assert.equal(counts.usage, 1)
    assert.equal(counts._truncated, 1)
    assert.equal(counts._errorCode, 1)
    assert.equal(counts._errorDetail, 1)
  })

  it('silently drops ephemeral / unknown fields (metaText, _rawMeta, _partial, output, ...)', () => {
    const cleaned = _stripClientPutMessage({
      id: 'm-1',
      role: 'assistant',
      text: 'hi',
      ts: 1,
      metaText: '8 积分',
      _rawMeta: { costCredits: 8 },
      _partial: 'unfinished',
      _completed: false,
      output: 'tool out',
      bashTail: '...',
      foo: 'bar',
    })
    // Allow-listed only — metaText et al. dropped; counter NOT bumped (those
    // aren't *server-authoritative*, just ephemeral).
    assert.deepEqual(Object.keys(cleaned ?? {}).sort(), ['id', 'role', 'text', 'ts'])
    const counts = getClientPutBlockedFieldCounts()
    assert.equal(counts.metaText, undefined, 'ephemeral fields not counted')
    assert.equal(counts._rawMeta, undefined)
  })

  it('returns null for malformed input (non-object)', () => {
    assert.equal(_stripClientPutMessage(null), null)
    assert.equal(_stripClientPutMessage(undefined), null)
    assert.equal(_stripClientPutMessage('string'), null)
    assert.equal(_stripClientPutMessage(42), null)
  })

  it('_stripClientPutMessages drops malformed entries', () => {
    const out = _stripClientPutMessages([
      { id: 'a', role: 'user', text: '', ts: 1 },
      null,
      { id: 'b', role: 'user', text: '', ts: 2 },
      'oops',
    ])
    assert.equal(out.length, 2)
    assert.equal(out[0].id, 'a')
    assert.equal(out[1].id, 'b')
  })
})

describe('upsertClientSession applies strip end-to-end (T24)', () => {
  before(async () => {
    const db = await getSessionsDb()
    db.exec('DELETE FROM client_sessions')
  })

  it('client PUT carrying _source/_seq/usage/status:replied/metaText is stripped on persist', async () => {
    _resetClientPutBlockedFieldCountsForTest()

    await upsertClientSession({
      id: 'sess-strip-1',
      userId: 'u-strip',
      agentId: 'main',
      title: 't',
      pinned: false,
      createdAt: 1,
      lastAt: 1,
      messages: [
        {
          id: 'm-evil',
          role: 'user',
          text: 'hi',
          ts: 1,
          status: 'replied', // forbidden — must be stripped
          _source: 'server',
          _seq: 9999,
          _orderSeq: 9999,
          usage: { costCredits: '1000' },
          _truncated: true,
          _errorCode: 'oops',
          _errorDetail: 'detail',
          metaText: '8 积分',
          _rawMeta: { costCredits: 8 },
          _partial: 'frag',
          output: 'tool out',
        },
      ],
      updatedAt: 1,
    })

    const db = await getSessionsDb()
    const row = db
      .prepare('SELECT messages FROM client_sessions WHERE id = ? AND user_id = ?')
      .get('sess-strip-1', 'u-strip') as { messages: string }
    const persisted = JSON.parse(row.messages) as Array<Record<string, unknown>>
    assert.equal(persisted.length, 1)

    const m = persisted[0]
    // Allow-listed fields preserved.
    assert.equal(m.id, 'm-evil')
    assert.equal(m.role, 'user')
    assert.equal(m.text, 'hi')
    assert.equal(m.ts, 1)

    // Server-authoritative fields stripped.
    assert.equal(m._source, undefined)
    assert.equal(m.usage, undefined)
    assert.equal(m._truncated, undefined)
    assert.equal(m._errorCode, undefined)
    assert.equal(m._errorDetail, undefined)

    // status='replied' stripped (derived now).
    assert.equal(m.status, undefined)

    // Ephemeral fields stripped.
    assert.equal(m.metaText, undefined)
    assert.equal(m._rawMeta, undefined)
    assert.equal(m._partial, undefined)
    assert.equal(m.output, undefined)

    // _seq is reassigned by normalizeAndAssignSeqs since this is a new
    // message — but the *forged* 9999 must NOT survive.
    assert.notEqual(m._seq, 9999)
    assert.notEqual(m._orderSeq, 9999)

    // Metric counters bumped for the deny-listed fields.
    const counts = getClientPutBlockedFieldCounts()
    assert.equal(counts._source, 1)
    assert.equal(counts._seq, 1)
    assert.equal(counts._orderSeq, 1)
    assert.equal(counts.usage, 1)
    assert.equal(counts._truncated, 1)
    assert.equal(counts._errorCode, 1)
    assert.equal(counts._errorDetail, 1)
  })
})
