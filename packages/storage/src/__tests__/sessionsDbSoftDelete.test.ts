/**
 * Tests for the `session_deleted` reason split (2026-05-07).
 *
 * The pre-existing storage core conflated two distinct terminal states into
 * a single `session_not_found` reason:
 *   1. row never existed (frontend's debounced PUT in flight — RECOVERABLE)
 *   2. row existed but was soft-deleted (terminal, retry never resolves)
 *
 * The split surfaces (2) as the new `session_deleted` reason so the
 * commercial handler can map it to HTTP 410 Gone and the v3 sink can
 * fatal-drop it (instead of letting durable retry storms run for 24h).
 *
 * These tests pin the new contract at the storage layer; handler/sink layer
 * have their own dedicated tests.
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionsDbSoftDelete.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, beforeEach, describe, it } from 'node:test'

// Capture paths at module-load time — must set OPENCLAUDE_HOME first.
const testHome = await mkdtemp(join(tmpdir(), 'oc-softdelete-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  appendServerAuthoredMessage,
  appendServerAuthoredMessageDurable,
  appendServerAuthoredMessageForRequest,
  classifyClientSessions,
  deleteClientSession,
  getSessionsDb,
  queueMessageToOutbox,
  replayMsgOutbox,
  upsertClientSession,
} = await import('../sessionsDb.js')
const { paths } = await import('../paths.js')

interface MapRow {
  request_id: string
  user_id: string
  session_id: string
  msg_id: string
}

async function getMapRow(requestId: string, userId: string): Promise<MapRow | undefined> {
  const db = await getSessionsDb()
  return db
    .prepare(
      'SELECT request_id, user_id, session_id, msg_id FROM server_authored_request_map WHERE request_id = ? AND user_id = ?',
    )
    .get(requestId, userId) as MapRow | undefined
}

async function clearTables(): Promise<void> {
  const db = await getSessionsDb()
  db.exec('DELETE FROM client_sessions')
  db.exec('DELETE FROM server_authored_request_map')
  db.exec('DELETE FROM pending_usage_patches')
  await writeFile(paths.msgOutbox, '', 'utf8').catch(() => undefined)
}

async function seedSession(id: string, userId: string): Promise<void> {
  await upsertClientSession({
    id,
    userId,
    agentId: 'default',
    title: 'soft-delete test',
    pinned: false,
    createdAt: 1000,
    lastAt: 1000,
    updatedAt: 1000,
    messages: [{ id: 'u1', role: 'user', text: 'hi', ts: 1000 }] as unknown[],
  } as any)
}

describe('appendServerAuthoredMessage — session_deleted vs session_not_found split', () => {
  before(clearTables)
  beforeEach(clearTables)

  it('returns session_deleted when the row exists but is soft-deleted', async () => {
    await seedSession('sess-soft', 'user-X')
    const ok = await deleteClientSession('sess-soft', 'user-X')
    assert.equal(ok, true, 'soft-delete must succeed')

    const r = await appendServerAuthoredMessage('sess-soft', 'user-X', {
      id: 'srv-sess-soft-t1',
      role: 'assistant',
      text: 'late assistant write',
      ts: 2000,
    })
    assert.equal(r.applied, false)
    assert.equal(r.reason, 'session_deleted')
  })

  it('classifies active, deleted and missing refs without conflating tenant mismatch', async () => {
    await seedSession('sess-live', 'user-X')
    await seedSession('sess-deleted', 'user-X')
    await deleteClientSession('sess-deleted', 'user-X')

    assert.deepEqual(await classifyClientSessions([
      { sessionId: 'sess-live', userId: 'user-X' },
      { sessionId: 'sess-deleted', userId: 'user-X' },
      { sessionId: 'sess-missing', userId: 'user-X' },
      { sessionId: 'sess-live', userId: 'other-user' },
    ]), [
      { sessionId: 'sess-live', userId: 'user-X', state: 'active' },
      { sessionId: 'sess-deleted', userId: 'user-X', state: 'deleted' },
      { sessionId: 'sess-missing', userId: 'user-X', state: 'missing' },
      { sessionId: 'sess-live', userId: 'other-user', state: 'missing' },
    ])
  })

  it('still returns session_not_found when the row never existed', async () => {
    const r = await appendServerAuthoredMessage('sess-ghost', 'user-X', {
      id: 'srv-sess-ghost-t1',
      role: 'assistant',
      text: 'first turn before PUT',
      ts: 2000,
    })
    assert.equal(r.applied, false)
    assert.equal(r.reason, 'session_not_found')
  })

  it('writes succeed normally on a live (non-deleted) row', async () => {
    await seedSession('sess-live', 'user-X')
    const r = await appendServerAuthoredMessage('sess-live', 'user-X', {
      id: 'srv-sess-live-t1',
      role: 'assistant',
      text: 'hello',
      ts: 2000,
    })
    assert.equal(r.applied, true)
  })

  it('mismatched userId on a live session still surfaces session_not_found (defense-in-depth)', async () => {
    // Session is owned by user-A. A request from user-B must NOT see the
    // row at all — the WHERE id=? AND user_id=? filter scopes by tenancy.
    // This is a tenant-isolation invariant, orthogonal to the soft-delete
    // split, but worth pinning here so the new probe doesn't accidentally
    // leak (e.g. if someone later removes the user_id predicate from the
    // probe).
    await seedSession('sess-tenant', 'user-A')

    const r = await appendServerAuthoredMessage('sess-tenant', 'user-B', {
      id: 'srv-sess-tenant-t1',
      role: 'assistant',
      text: 'cross-tenant write should be rejected',
      ts: 2000,
    })
    assert.equal(r.applied, false)
    assert.equal(
      r.reason,
      'session_not_found',
      'tenant isolation must surface as session_not_found, never session_deleted',
    )
  })
})

describe('appendServerAuthoredMessageDurable — soft-delete is terminal, never queued', () => {
  before(clearTables)
  beforeEach(clearTables)

  it('returns session_deleted without enqueueing to the outbox', async () => {
    await seedSession('sess-soft-durable', 'user-Y')
    await deleteClientSession('sess-soft-durable', 'user-Y')

    const r = await appendServerAuthoredMessageDurable('sess-soft-durable', 'user-Y', {
      id: 'srv-sess-soft-durable-t1',
      role: 'assistant',
      text: 'never to be persisted',
      ts: 3000,
    })
    assert.equal(r.applied, false)
    if (r.applied) return
    assert.equal(r.reason, 'session_deleted', 'terminal — must NOT route through outbox')

    // Outbox file size must remain zero (or absent).
    const size = await stat(paths.msgOutbox).then((s) => s.size).catch(() => 0)
    assert.equal(size, 0, 'session_deleted must not enqueue — replay would just re-hit the same terminal state')
  })

  it('still queues session_not_found (first-turn race) — the outbox path is unchanged', async () => {
    const r = await appendServerAuthoredMessageDurable('sess-never-puts', 'user-Y', {
      id: 'srv-sess-never-puts-t1',
      role: 'assistant',
      text: 'first turn pre-PUT',
      ts: 3000,
    })
    assert.equal(r.applied, false)
    if (r.applied) return
    assert.equal(r.reason, 'queued_to_outbox')
    assert.equal(r.error, 'session_not_found')

    const raw = await readFile(paths.msgOutbox, 'utf8')
    assert.ok(
      raw.includes('srv-sess-never-puts-t1'),
      'session_not_found path still queues so a later PUT + replay can land it',
    )
  })
})

describe('replayMsgOutbox — drops session_deleted same as session_not_found', () => {
  before(clearTables)
  beforeEach(clearTables)

  it('a queued entry whose session was soft-deleted afterwards is dropped, not requeued', async () => {
    // Seed + queue an entry while the session is live.
    await seedSession('sess-soft-replay', 'user-Z')
    await queueMessageToOutbox({
      sessId: 'sess-soft-replay',
      userId: 'user-Z',
      message: { id: 'srv-sess-soft-replay-t1', role: 'assistant', text: 'ok', ts: 4000 },
      queuedAt: 4000,
    })

    // Soft-delete the session BEFORE replay — simulates a user clearing the
    // chat between the entry being queued and the next replay sweep.
    await deleteClientSession('sess-soft-replay', 'user-Z')

    const summary = await replayMsgOutbox()
    assert.equal(summary.applied, 0)
    assert.equal(summary.dropped, 1, 'session_deleted is terminal — drop, do not requeue')
    assert.equal(summary.requeued, 0, 'must not infinite-requeue a tombstone session')

    // Outbox file is drained (atomic rewrite).
    const leftover = await readFile(paths.msgOutbox, 'utf8').catch(() => '')
    assert.equal(leftover, '')
  })
})

describe('appendServerAuthoredMessageForRequest — soft-delete is terminal, no map insert', () => {
  before(clearTables)
  beforeEach(clearTables)

  it('returns session_deleted without inserting server_authored_request_map row', async () => {
    await seedSession('sess-soft-req', 'user-W')
    await deleteClientSession('sess-soft-req', 'user-W')

    const r = await appendServerAuthoredMessageForRequest(
      'req-soft-1',
      'sess-soft-req',
      'user-W',
      {
        id: 'srv-sess-soft-req-t1',
        role: 'assistant',
        text: 'never written',
        ts: 5000,
      },
    )
    assert.equal(r.applied, false)
    if (r.applied) return
    assert.equal(r.reason, 'session_deleted')

    // No request_map row should be written for a message that never landed —
    // otherwise a later appendCostCredits would patch a phantom row.
    const map = await getMapRow('req-soft-1', 'user-W')
    assert.equal(map, undefined, 'no request_map insert for non-applied write')
  })

  it('drains pending_usage_patches on session_deleted (terminal — would otherwise sit until 24h aging)', async () => {
    // Race ordering: cost-credit arrived before the assistant message commit
    // (so a pending_usage_patches row exists), then the user soft-deleted the
    // session before the sink retry landed. Without the cleanup the pending
    // row sits until the 24h aging sweep — adding noise to pending-age
    // dashboards. With cleanup it goes away on the same txn that surfaces
    // session_deleted to the caller.
    await seedSession('sess-pending-soft', 'user-V')

    const db = await getSessionsDb()
    db.prepare(
      `INSERT INTO pending_usage_patches (request_id, user_id, cost_credits, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('req-pending-soft', 'user-V', '12345', Date.now())

    await deleteClientSession('sess-pending-soft', 'user-V')

    const r = await appendServerAuthoredMessageForRequest(
      'req-pending-soft',
      'sess-pending-soft',
      'user-V',
      { id: 'srv-sess-pending-soft-t1', role: 'assistant', text: 'never written', ts: 6000 },
    )
    assert.equal(r.applied, false)
    if (r.applied) return
    assert.equal(r.reason, 'session_deleted')

    const pending = db
      .prepare('SELECT request_id FROM pending_usage_patches WHERE request_id = ? AND user_id = ?')
      .get('req-pending-soft', 'user-V') as { request_id: string } | undefined
    assert.equal(
      pending,
      undefined,
      'session_deleted is terminal — pending_usage_patches must be drained, not left to age',
    )
  })

  it('LEAVES pending_usage_patches on session_not_found (race may still resolve)', async () => {
    // Counterpart to the above: row genuinely doesn't exist yet (frontend's
    // PUT pending). The sink will retry; when the PUT lands, the pending row
    // must still be there so the retry-drain logic can apply costCredits.
    const db = await getSessionsDb()
    db.prepare(
      `INSERT INTO pending_usage_patches (request_id, user_id, cost_credits, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('req-pending-ghost', 'user-V', '67890', Date.now())

    const r = await appendServerAuthoredMessageForRequest(
      'req-pending-ghost',
      'sess-never-puts',
      'user-V',
      { id: 'srv-sess-never-puts-t1', role: 'assistant', text: 'first turn', ts: 6000 },
    )
    assert.equal(r.applied, false)
    if (r.applied) return
    assert.equal(r.reason, 'session_not_found')

    const pending = db
      .prepare('SELECT cost_credits FROM pending_usage_patches WHERE request_id = ? AND user_id = ?')
      .get('req-pending-ghost', 'user-V') as { cost_credits: string } | undefined
    assert.equal(pending?.cost_credits, '67890', 'session_not_found path must preserve pending row')
  })
})
