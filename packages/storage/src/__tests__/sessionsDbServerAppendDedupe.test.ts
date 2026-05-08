/**
 * Tests for the phantom-dedupe applied inside `_appendServerAuthoredCore`
 * (2026-05-09 — v1.0.100 follow-up to Bug 2 round 1).
 *
 * Background: prior to v1.0.100, the server-authored append path
 * (`appendServerAuthoredMessage`) just appended new rows; phantom dedupe of
 * client-authored phantoms (assistant/thinking/tool by blockId) only ran on
 * the next client PUT (`upsertClientSession`). An F5 between turn-end and
 * the next PUT showed duplicate tool cards (one stripped legacy + one rich).
 *
 * v1.0.100 makes the two paths symmetric: server-append now runs the same
 * `mergePreservingServerAuthored` dedupe at write time, so the persisted
 * messages blob is always clean.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionsDbServerAppendDedupe.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-srvappend-dedupe-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  appendServerAuthoredMessage,
  getSessionsDb,
  upsertClientSession,
} = await import('../sessionsDb.js')

interface SessionRow {
  messages: string
}

async function getMessages(sessId: string, userId: string): Promise<unknown[]> {
  const db = await getSessionsDb()
  const row = db
    .prepare('SELECT messages FROM client_sessions WHERE id = ? AND user_id = ?')
    .get(sessId, userId) as SessionRow | undefined
  if (!row) return []
  return JSON.parse(row.messages) as unknown[]
}

async function clearTables(): Promise<void> {
  const db = await getSessionsDb()
  db.exec('DELETE FROM client_sessions')
}

/**
 * Seed a session whose messages array mirrors what the boss saw in
 * `web-moxe6g0k-2r6qy2x3` after a tool turn but before any post-turn
 * server-authored writes had landed: one user msg, then a stream of
 * client-authored tool rows with blockIds but no `_completed`.
 */
async function seedSessionWithClientToolPhantoms(
  sessId: string,
  userId: string,
  blockIds: string[],
): Promise<void> {
  const messages: unknown[] = [
    { id: 'u1', role: 'user', text: 'hi', ts: 1000 },
  ]
  for (let i = 0; i < blockIds.length; i++) {
    messages.push({
      id: `m-${1100 + i}`,
      role: 'tool',
      text: 'Bash',
      toolName: 'Bash',
      blockId: blockIds[i],
      ts: 1100 + i,
    })
  }
  await upsertClientSession({
    id: sessId,
    userId,
    agentId: 'default',
    title: 'srv-append dedupe test',
    pinned: false,
    createdAt: 1000,
    lastAt: 1100 + blockIds.length,
    updatedAt: 1100 + blockIds.length,
    messages,
  } as any)
}

describe('appendServerAuthoredMessage — phantom-dedupe at write time', () => {
  before(clearTables)
  beforeEach(clearTables)

  it('drops client-authored tool phantom with matching blockId in same turn group', async () => {
    await seedSessionWithClientToolPhantoms('s1', 'user-X', ['blk-A'])

    const r = await appendServerAuthoredMessage('s1', 'user-X', {
      id: 'srv-s1-t0-tool-blk-A',
      role: 'tool',
      text: 'output A',
      toolName: 'Bash',
      blockId: 'blk-A',
      inputJson: { command: 'echo A' },
      inputPreview: 'echo A',
      output: 'A',
      _completed: true,
      ts: 2000,
    })
    assert.equal(r.applied, true)

    const msgs = await getMessages('s1', 'user-X') as Array<Record<string, unknown>>
    const ids = msgs.map((m) => m.id)
    // Server-authored row preserved
    assert.ok(ids.includes('srv-s1-t0-tool-blk-A'), 'server-authored row should be present')
    // Client phantom dropped
    assert.ok(!ids.includes('m-1100'), 'client-authored tool phantom with matching blockId should be dropped')
    // User message preserved
    assert.ok(ids.includes('u1'), 'user message survives')
  })

  it('preserves client-authored tool row when blockId does NOT match', async () => {
    await seedSessionWithClientToolPhantoms('s2', 'user-X', ['blk-A'])

    const r = await appendServerAuthoredMessage('s2', 'user-X', {
      id: 'srv-s2-t0-tool-blk-Z',
      role: 'tool',
      text: 'output Z',
      toolName: 'Bash',
      blockId: 'blk-Z',
      _completed: true,
      ts: 2000,
    })
    assert.equal(r.applied, true)

    const msgs = await getMessages('s2', 'user-X') as Array<Record<string, unknown>>
    const ids = msgs.map((m) => m.id)
    assert.ok(ids.includes('srv-s2-t0-tool-blk-Z'), 'server-authored row present')
    assert.ok(ids.includes('m-1100'), 'client tool row with non-matching blockId must be preserved')
  })

  it('preserves client-authored tool row when blockId is missing (legacy data)', async () => {
    // Tools without blockId are legacy / pre-allow-list strip path. Per
    // mergePreservingServerAuthored comment lines 877-880, these are kept.
    const messages: unknown[] = [
      { id: 'u1', role: 'user', text: 'hi', ts: 1000 },
      { id: 'm-no-bid', role: 'tool', text: 'Legacy', toolName: 'Bash', ts: 1100 },
    ]
    await upsertClientSession({
      id: 's3',
      userId: 'user-X',
      agentId: 'default',
      title: 't',
      pinned: false,
      createdAt: 1000,
      lastAt: 1100,
      updatedAt: 1100,
      messages,
    } as any)

    await appendServerAuthoredMessage('s3', 'user-X', {
      id: 'srv-s3-t0-tool-blk-A',
      role: 'tool',
      text: 'A',
      toolName: 'Bash',
      blockId: 'blk-A',
      _completed: true,
      ts: 2000,
    })

    const msgs = await getMessages('s3', 'user-X') as Array<Record<string, unknown>>
    const ids = msgs.map((m) => m.id)
    assert.ok(ids.includes('srv-s3-t0-tool-blk-A'))
    assert.ok(ids.includes('m-no-bid'), 'legacy tool row without blockId must be preserved')
  })

  it('drops 13 client tool phantoms in single turn group when 13 server-authored rows append (boss session shape)', async () => {
    // Mirrors the failing real-world session web-moxe6g0k-2r6qy2x3:
    // 13 client tool phantoms, then a batch of 13 server-authored tool rows
    // arriving via internalServerAuthored.ts at turn-end. We append them
    // sequentially (the production order — see internalServerAuthored.ts
    // line 509 sequential loop) and assert each call drops its peer.
    const blockIds = Array.from({ length: 13 }, (_, i) => `call_${String(i).padStart(2, '0')}_TEST`)
    await seedSessionWithClientToolPhantoms('s4', 'user-X', blockIds)

    for (let i = 0; i < blockIds.length; i++) {
      const r = await appendServerAuthoredMessage('s4', 'user-X', {
        id: `srv-s4-t1-tool-${blockIds[i]}`,
        role: 'tool',
        text: `out ${i}`,
        toolName: 'Bash',
        blockId: blockIds[i],
        inputJson: { i },
        inputPreview: `cmd ${i}`,
        output: `out ${i}`,
        _completed: true,
        ts: 5000 + i,
      })
      assert.equal(r.applied, true, `append #${i} should succeed`)
    }

    const msgs = await getMessages('s4', 'user-X') as Array<Record<string, unknown>>
    const ids = msgs.map((m) => m.id)
    const clientPhantomIds = Array.from({ length: 13 }, (_, i) => `m-${1100 + i}`)
    const serverAuthoredIds = blockIds.map((b) => `srv-s4-t1-tool-${b}`)

    for (const cid of clientPhantomIds) {
      assert.ok(!ids.includes(cid), `client phantom ${cid} must be dropped`)
    }
    for (const sid of serverAuthoredIds) {
      assert.ok(ids.includes(sid), `server-authored ${sid} must be present`)
    }
    // Final shape: u1 + 13 server tools
    assert.equal(msgs.length, 14, `expected 14 messages (u1 + 13 server tools), got ${msgs.length}`)
  })

  it('drops client-authored assistant phantom when server assistant lands (existing PUT-path parity)', async () => {
    // Phantom-dedupe is not tool-specific: assistant phantoms must drop too.
    const messages: unknown[] = [
      { id: 'u1', role: 'user', text: 'hi', ts: 1000 },
      { id: 'm-asst-1', role: 'assistant', text: 'phantom client assistant', ts: 1100 },
    ]
    await upsertClientSession({
      id: 's5',
      userId: 'user-X',
      agentId: 'default',
      title: 't',
      pinned: false,
      createdAt: 1000,
      lastAt: 1100,
      updatedAt: 1100,
      messages,
    } as any)

    await appendServerAuthoredMessage('s5', 'user-X', {
      id: 'srv-s5-t0-asst',
      role: 'assistant',
      text: 'authoritative assistant',
      ts: 2000,
    })

    const msgs = await getMessages('s5', 'user-X') as Array<Record<string, unknown>>
    const ids = msgs.map((m) => m.id)
    assert.ok(ids.includes('srv-s5-t0-asst'), 'server assistant present')
    assert.ok(!ids.includes('m-asst-1'), 'client phantom assistant dropped')
  })

  it('_seq invariant holds when phantom-dedupe drops rows that had _seq assigned', async () => {
    // Regression guard: when the dedupe drops a previously-_seq'd row,
    // remaining rows must still satisfy uniqueness, and next_seq must
    // remain > max(_seq) of retained rows. Codex R2 reviewer flagged
    // this as the subtle invariant worth pinning explicitly.
    await seedSessionWithClientToolPhantoms('s7', 'user-X', ['blk-A', 'blk-B'])

    // First append assigns _seq to all rows via legacy backfill
    // (oldMsgs lack _seq → backfilled in current order).
    await appendServerAuthoredMessage('s7', 'user-X', {
      id: 'srv-s7-t0-tool-blk-A',
      role: 'tool',
      text: 'A',
      toolName: 'Bash',
      blockId: 'blk-A',
      _completed: true,
      ts: 5000,
    })
    // Second append: drops the remaining client phantom for blk-B and
    // adds the server-authored row for blk-B.
    await appendServerAuthoredMessage('s7', 'user-X', {
      id: 'srv-s7-t0-tool-blk-B',
      role: 'tool',
      text: 'B',
      toolName: 'Bash',
      blockId: 'blk-B',
      _completed: true,
      ts: 5001,
    })

    const db = await getSessionsDb()
    const row = db
      .prepare('SELECT messages, next_seq FROM client_sessions WHERE id = ? AND user_id = ?')
      .get('s7', 'user-X') as { messages: string; next_seq: number }
    const msgs = JSON.parse(row.messages) as Array<Record<string, unknown>>

    // Final shape: u1 + 2 server tools = 3 rows.
    assert.equal(msgs.length, 3, 'after dedupe, only u1 + 2 server tools survive')

    // Every retained row has a positive integer _seq.
    const seqs = msgs.map((m) => m._seq as number)
    for (const s of seqs) {
      assert.ok(typeof s === 'number' && Number.isFinite(s) && s > 0, `_seq must be positive integer, got ${s}`)
    }
    // _seq values are unique among retained rows.
    assert.equal(new Set(seqs).size, seqs.length, '_seq values must be unique')
    // next_seq strictly greater than max(_seq).
    assert.ok(row.next_seq > Math.max(...seqs), `next_seq (${row.next_seq}) must be > max(_seq) (${Math.max(...seqs)})`)
  })

  it('different turn groups are independent (server tool in turn 2 does not drop client tool in turn 1)', async () => {
    // Turn 1: user u1 + client tool with blockId blk-A.
    // Turn 2: user u2 + server-authored tool with blockId blk-A (re-used).
    // The phantom-dedupe must NOT drop the turn-1 client tool because
    // it sits in a different turn group (separated by u2).
    const messages: unknown[] = [
      { id: 'u1', role: 'user', text: 'turn 1', ts: 1000 },
      { id: 'm-t1-tool', role: 'tool', text: 'Bash', toolName: 'Bash', blockId: 'blk-A', ts: 1100 },
      { id: 'u2', role: 'user', text: 'turn 2', ts: 2000 },
    ]
    await upsertClientSession({
      id: 's6',
      userId: 'user-X',
      agentId: 'default',
      title: 't',
      pinned: false,
      createdAt: 1000,
      lastAt: 2000,
      updatedAt: 2000,
      messages,
    } as any)

    await appendServerAuthoredMessage('s6', 'user-X', {
      id: 'srv-s6-t2-tool-blk-A',
      role: 'tool',
      text: 'turn 2 tool result',
      toolName: 'Bash',
      blockId: 'blk-A',
      _completed: true,
      ts: 2100,
    })

    const msgs = await getMessages('s6', 'user-X') as Array<Record<string, unknown>>
    const ids = msgs.map((m) => m.id)
    assert.ok(ids.includes('m-t1-tool'), 'turn-1 client tool with same blockId must survive (different turn group)')
    assert.ok(ids.includes('srv-s6-t2-tool-blk-A'), 'turn-2 server tool present')
  })
})
