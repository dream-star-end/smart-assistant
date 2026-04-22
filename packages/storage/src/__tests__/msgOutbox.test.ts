import * as assert from 'node:assert/strict'
/**
 * Tests for the durable msg-outbox (Phase 0.2).
 *
 * The outbox protects server-authored assistant messages when the primary
 * SQLite write fails (disk full, BUSY, crash mid-transaction). Writes are
 * appended as JSON lines and replayed on gateway startup.
 *
 * Pure serialization/parsing is tested in isolation. The full
 * queue → replay → DB path is exercised end-to-end against a fresh SQLite
 * database created under a temp OPENCLAUDE_HOME.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/msgOutbox.test.ts
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, before } from 'node:test'

// Point OPENCLAUDE_HOME at a throwaway dir BEFORE importing the modules that
// capture `paths` at module-load time.
const testHome = await mkdtemp(join(tmpdir(), 'oc-msgoutbox-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  appendServerAuthoredMessageDurable,
  getClientSession,
  parseQueuedMessageLine,
  queueMessageToOutbox,
  queuedMessageToLine,
  replayMsgOutbox,
  upsertClientSession,
} = await import('../sessionsDb.js')
const { paths } = await import('../paths.js')

describe('queuedMessageToLine / parseQueuedMessageLine (pure)', () => {
  it('roundtrips a well-formed entry', () => {
    const entry = {
      sessId: 's1',
      userId: 'u1',
      message: { id: 'srv-s1-t1', role: 'assistant' as const, text: 'hello', ts: 1234 },
      queuedAt: 5000,
    }
    const line = queuedMessageToLine(entry)
    assert.ok(line.endsWith('\n'), 'line must be newline-terminated')
    const back = parseQueuedMessageLine(line)
    assert.deepEqual(back, entry)
  })

  it('returns null on malformed JSON', () => {
    assert.equal(parseQueuedMessageLine('{not json'), null)
  })

  it('returns null on missing required fields', () => {
    assert.equal(parseQueuedMessageLine(JSON.stringify({ sessId: 's1' })), null)
    assert.equal(parseQueuedMessageLine(JSON.stringify({ sessId: 's1', userId: 'u1' })), null)
    assert.equal(
      parseQueuedMessageLine(JSON.stringify({ sessId: 's1', userId: 'u1', message: {} })),
      null,
      'message.id required',
    )
  })

  it('returns null on blank line', () => {
    assert.equal(parseQueuedMessageLine(''), null)
    assert.equal(parseQueuedMessageLine('   \n'), null)
  })

  it('preserves extra fields on the message (passthrough)', () => {
    const entry = {
      sessId: 's1',
      userId: 'u1',
      message: { id: 'x', role: 'assistant' as const, text: 't', status: 'interrupted' as const },
      queuedAt: 1,
    }
    const back = parseQueuedMessageLine(queuedMessageToLine(entry))!
    assert.equal(back.message.status, 'interrupted')
  })
})

describe('queueMessageToOutbox + replayMsgOutbox (integration)', () => {
  before(async () => {
    // Seed one client session we can replay a write into.
    await upsertClientSession({
      id: 'sess-A',
      userId: 'user-A',
      agentId: 'default',
      title: 'Test',
      pinned: false,
      createdAt: 1000,
      lastAt: 1000,
      updatedAt: 1000,
      messages: [{ id: 'u1', role: 'user', text: 'hi', ts: 1000 }] as unknown[],
    } as any)
  })

  it('queued message is replayed into the DB on next replayMsgOutbox() call', async () => {
    await queueMessageToOutbox({
      sessId: 'sess-A',
      userId: 'user-A',
      message: { id: 'srv-sess-A-t1', role: 'assistant', text: 'server text', ts: 2000 },
      queuedAt: 2000,
    })

    const summary = await replayMsgOutbox()
    assert.equal(summary.applied, 1, 'exactly one message applied')
    assert.equal(summary.requeued, 0)
    assert.equal(summary.malformed, 0)

    const sess = await getClientSession('sess-A', 'user-A')
    assert.ok(sess, 'session exists')
    const ids = (sess!.messages as Array<{ id: string }>).map((m) => m.id)
    assert.ok(ids.includes('srv-sess-A-t1'), 'assistant message landed in session')

    // Outbox file should be empty after successful replay.
    const leftover = await readFile(paths.msgOutbox, 'utf8').catch(() => '')
    assert.equal(leftover, '', 'outbox file drained')
  })

  it('idempotent replay: if the same message is queued twice, both resolve (already_exists drops)', async () => {
    await queueMessageToOutbox({
      sessId: 'sess-A',
      userId: 'user-A',
      message: { id: 'srv-sess-A-t2', role: 'assistant', text: 'v1', ts: 3000 },
      queuedAt: 3000,
    })
    await queueMessageToOutbox({
      sessId: 'sess-A',
      userId: 'user-A',
      // Same id → second one is already_exists after first lands.
      message: { id: 'srv-sess-A-t2', role: 'assistant', text: 'v2', ts: 3000 },
      queuedAt: 3001,
    })

    const summary = await replayMsgOutbox()
    assert.equal(summary.applied, 1)
    assert.equal(summary.dropped, 1, 'duplicate dropped as already_exists')
    assert.equal(summary.requeued, 0)

    const sess = await getClientSession('sess-A', 'user-A')
    const t2 = (sess!.messages as Array<{ id: string; text: string }>).find((m) => m.id === 'srv-sess-A-t2')
    assert.equal(t2?.text, 'v1', 'first-write-wins semantics preserved')
  })

  it('malformed lines are counted and dropped, valid lines still replay', async () => {
    // Write directly: two junk lines + one valid entry.
    const valid = queuedMessageToLine({
      sessId: 'sess-A',
      userId: 'user-A',
      message: { id: 'srv-sess-A-t3', role: 'assistant', text: 'ok', ts: 4000 },
      queuedAt: 4000,
    })
    await writeFile(paths.msgOutbox, `not json\n{"incomplete":true}\n${valid}`, 'utf8')

    const summary = await replayMsgOutbox()
    assert.equal(summary.applied, 1)
    assert.equal(summary.malformed, 2)
    assert.equal(summary.requeued, 0)

    const sess = await getClientSession('sess-A', 'user-A')
    const ids = (sess!.messages as Array<{ id: string }>).map((m) => m.id)
    assert.ok(ids.includes('srv-sess-A-t3'))
  })

  it('missing outbox file is a no-op', async () => {
    // Ensure replay doesn't crash when nothing has been queued yet.
    await writeFile(paths.msgOutbox, '', 'utf8')
    const summary = await replayMsgOutbox()
    assert.deepEqual(summary, { processed: 0, applied: 0, dropped: 0, requeued: 0, malformed: 0 })
  })

  it('queued write for a missing session is dropped (not requeued forever)', async () => {
    await queueMessageToOutbox({
      sessId: 'sess-DOES-NOT-EXIST',
      userId: 'user-A',
      message: { id: 'srv-ghost-t1', role: 'assistant', text: 'x', ts: 5000 },
      queuedAt: 5000,
    })
    const summary = await replayMsgOutbox()
    assert.equal(summary.applied, 0)
    assert.equal(summary.dropped, 1, 'session_not_found counts as terminal drop')
    assert.equal(summary.requeued, 0, 'do not infinite-requeue vanished sessions')
  })
})

describe('appendServerAuthoredMessageDurable', () => {
  it('returns already_exists when the same id is written twice (no outbox spam)', async () => {
    // Seed + first write.
    await upsertClientSession({
      id: 'sess-B',
      userId: 'user-A',
      agentId: 'default',
      title: '',
      pinned: false,
      createdAt: 0, lastAt: 0, updatedAt: 0,
      messages: [] as unknown[],
    } as any)
    const r1 = await appendServerAuthoredMessageDurable('sess-B', 'user-A', {
      id: 'srv-sess-B-t1', role: 'assistant', text: 'one', ts: 100,
    })
    assert.equal(r1.applied, true)

    const r2 = await appendServerAuthoredMessageDurable('sess-B', 'user-A', {
      id: 'srv-sess-B-t1', role: 'assistant', text: 'two', ts: 100,
    })
    assert.equal(r2.applied, false)
    if (!r2.applied) assert.equal(r2.reason, 'already_exists')

    // Outbox must not have grown from this redundant call.
    const raw = await readFile(paths.msgOutbox, 'utf8').catch(() => '')
    assert.equal(raw, '', 'already_exists must not enqueue to outbox')
  })

  it('P1-3: session_not_found is queued to outbox, not silently dropped', async () => {
    // Reset outbox — earlier tests in this suite may have left entries.
    await writeFile(paths.msgOutbox, '', 'utf8')

    // First-turn race: CCB emits assistant text before the client has PUT
    // the session row. The durable wrapper must queue (not drop) so a later
    // replayMsgOutbox() can persist once the PUT has landed.
    const r = await appendServerAuthoredMessageDurable('sess-does-not-exist', 'user-A', {
      id: 'srv-sess-does-not-exist-t1',
      role: 'assistant',
      text: 'first-turn reply',
      ts: 500,
    })
    assert.equal(r.applied, false)
    if (r.applied) return
    assert.equal(r.reason, 'queued_to_outbox', 'must route through outbox, not silently drop')
    assert.equal(r.error, 'session_not_found')

    // Outbox now carries the entry.
    const raw = await readFile(paths.msgOutbox, 'utf8')
    assert.ok(raw.includes('srv-sess-does-not-exist-t1'), 'queued line must reference the message id')

    // Simulate the client's PUT landing later, then replay — entry should apply.
    await upsertClientSession({
      id: 'sess-does-not-exist',
      userId: 'user-A',
      agentId: 'default',
      title: '',
      pinned: false,
      createdAt: 0, lastAt: 0, updatedAt: 0,
      messages: [] as unknown[],
    } as any)
    const summary = await replayMsgOutbox()
    assert.equal(summary.applied, 1, 'replay persists the queued first-turn reply')
    const sess = await getClientSession('sess-does-not-exist')
    assert.ok(sess)
    const msgs = sess!.messages as Array<{ id?: string }>
    assert.ok(msgs.some((m) => m.id === 'srv-sess-does-not-exist-t1'), 'replayed message now in session')
  })
})

describe('upsertClientSession: initial-insert _source scrub (Codex R4 defense)', () => {
  it('strips client-forged _source=server on first-ever insert', async () => {
    // Fresh session (no existing DB row) with a client-authored message
    // carrying spoofed `_source: 'server'`. Previously this path bypassed
    // merge entirely and the forged flag persisted verbatim, letting a later
    // appendServerAuthoredMessage's phantom dedupe trust the client row as
    // authoritative and drop the real server turn.
    await upsertClientSession({
      id: 'sess-forge',
      userId: 'user-forge',
      agentId: 'default',
      title: 'Forge attempt',
      pinned: false,
      createdAt: 100, lastAt: 100, updatedAt: 100,
      messages: [
        { id: 'u1', role: 'user', text: 'hi', ts: 100 },
        { id: 'm-evil', role: 'assistant', text: 'fake authoritative', ts: 200, _source: 'server' },
      ] as unknown[],
    } as any)

    const sess = await getClientSession('sess-forge')
    assert.ok(sess, 'session persisted')
    const msgs = sess!.messages as Array<{ id?: string; _source?: unknown }>
    const evil = msgs.find((m) => m.id === 'm-evil')
    assert.ok(evil, 'm-evil message itself is kept (scrub only strips the flag, not the row)')
    assert.equal(evil!._source, undefined, 'spoofed _source scrubbed before persistence')
  })

  it('keeps legitimate _source=server written by appendServerAuthoredMessage intact after later upsert', async () => {
    // Round-trip regression: server writes authoritative row, client later
    // does a full PUT echoing the session back. The server row must keep
    // its `_source` through the merge.
    await upsertClientSession({
      id: 'sess-rt',
      userId: 'user-rt',
      agentId: 'default',
      title: 'Round trip',
      pinned: false,
      createdAt: 100, lastAt: 100, updatedAt: 100,
      messages: [{ id: 'u1', role: 'user', text: 'hi', ts: 100 }] as unknown[],
    } as any)
    // Gateway path: writes the server-authored row.
    await appendServerAuthoredMessageDurable('sess-rt', 'user-rt', {
      id: 'srv-sess-rt-t1',
      role: 'assistant',
      text: 'real answer',
      ts: 200,
    })
    // Client path: reads back, does a full PUT echoing the server row.
    const before = await getClientSession('sess-rt')
    assert.ok(before)
    await upsertClientSession({
      ...before!,
      updatedAt: 300,
      messages: before!.messages,
    } as any, 200 /* baseSyncedAt */)
    const after = await getClientSession('sess-rt')
    const real = (after!.messages as Array<{ id?: string; _source?: unknown }>)
      .find((m) => m.id === 'srv-sess-rt-t1')
    assert.ok(real, 'server row still present after round-trip')
    assert.equal(real!._source, 'server', '_source preserved for authoritative id')
  })
})
