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
})
