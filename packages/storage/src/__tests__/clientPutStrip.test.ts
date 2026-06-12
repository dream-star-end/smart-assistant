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
        modelOverride: 'gpt-5.5',
      },
    })
    assert.deepEqual(cleaned?._media, [{ kind: 'image', url: 'blob:foo' }])
    assert.equal(cleaned?._modelText, 'photo! [image]')
    assert.deepEqual(cleaned?._teamRun, {
      id: 'programming_team',
      name: '编程协作团队',
      leaderAgentId: 'codex',
      modelOverride: 'gpt-5.5',
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

  it('preserves status sending/queued/sent/read but drops "replied"', () => {
    for (const ok of ['sending', 'queued', 'sent', 'read']) {
      const c = _stripClientPutMessage({ id: 'x', role: 'user', text: '', ts: 1, status: ok })
      assert.equal(c?.status, ok)
    }
    const c = _stripClientPutMessage({ id: 'x', role: 'user', text: '', ts: 1, status: 'replied' })
    assert.equal(c?.status, undefined, 'replied dropped (derived now)')
  })

  it('drops + counts server-authoritative fields (_source/_seq/usage/_truncated/_errorCode/_errorDetail)', () => {
    const cleaned = _stripClientPutMessage({
      id: 'm-evil',
      role: 'assistant',
      text: 'fake server msg',
      ts: 1,
      _source: 'server',
      _seq: 9999,
      usage: { costCredits: '1000', inputTokens: 0 },
      _truncated: true,
      _errorCode: 'oops',
      _errorDetail: 'forged',
    })
    assert.equal(cleaned?._source, undefined)
    assert.equal(cleaned?._seq, undefined)
    assert.equal(cleaned?.usage, undefined)
    assert.equal(cleaned?._truncated, undefined)
    assert.equal(cleaned?._errorCode, undefined)
    assert.equal(cleaned?._errorDetail, undefined)

    const counts = getClientPutBlockedFieldCounts()
    assert.equal(counts._source, 1)
    assert.equal(counts._seq, 1)
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

    // Metric counters bumped for the deny-listed fields.
    const counts = getClientPutBlockedFieldCounts()
    assert.equal(counts._source, 1)
    assert.equal(counts._seq, 1)
    assert.equal(counts.usage, 1)
    assert.equal(counts._truncated, 1)
    assert.equal(counts._errorCode, 1)
    assert.equal(counts._errorDetail, 1)
  })
})
