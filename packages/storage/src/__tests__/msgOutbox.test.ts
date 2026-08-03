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
import { before, describe, it } from 'node:test'

// Point OPENCLAUDE_HOME at a throwaway dir BEFORE importing the modules that
// capture `paths` at module-load time.
const testHome = await mkdtemp(join(tmpdir(), 'oc-msgoutbox-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  appendClientSessionTapeFrame,
  appendServerAuthoredMessage,
  appendServerAuthoredMessageDurable,
  claimSession,
  deleteClientSession,
  getClientSession,
  getClientSessionTapeMeta,
  getUsageSummary,
  insertUsageLog,
  listClientSessionTapePage,
  listClientSessions,
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
    const t2 = (sess!.messages as Array<{ id: string; text: string }>).find(
      (m) => m.id === 'srv-sess-A-t2',
    )
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
      createdAt: 0,
      lastAt: 0,
      updatedAt: 0,
      messages: [] as unknown[],
    } as any)
    const r1 = await appendServerAuthoredMessageDurable('sess-B', 'user-A', {
      id: 'srv-sess-B-t1',
      role: 'assistant',
      text: 'one',
      ts: 100,
    })
    assert.equal(r1.applied, true)

    const r2 = await appendServerAuthoredMessageDurable('sess-B', 'user-A', {
      id: 'srv-sess-B-t1',
      role: 'assistant',
      text: 'two',
      ts: 100,
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
    assert.ok(
      raw.includes('srv-sess-does-not-exist-t1'),
      'queued line must reference the message id',
    )

    // Simulate the client's PUT landing later, then replay — entry should apply.
    await upsertClientSession({
      id: 'sess-does-not-exist',
      userId: 'user-A',
      agentId: 'default',
      title: '',
      pinned: false,
      createdAt: 0,
      lastAt: 0,
      updatedAt: 0,
      messages: [] as unknown[],
    } as any)
    const summary = await replayMsgOutbox()
    assert.equal(summary.applied, 1, 'replay persists the queued first-turn reply')
    const sess = await getClientSession('sess-does-not-exist')
    assert.ok(sess)
    const msgs = sess!.messages as Array<{ id?: string }>
    assert.ok(
      msgs.some((m) => m.id === 'srv-sess-does-not-exist-t1'),
      'replayed message now in session',
    )
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
      createdAt: 100,
      lastAt: 100,
      updatedAt: 100,
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
      createdAt: 100,
      lastAt: 100,
      updatedAt: 100,
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
    await upsertClientSession(
      {
        ...before!,
        updatedAt: 300,
        messages: before!.messages,
      } as any,
      200 /* baseSyncedAt */,
    )
    const after = await getClientSession('sess-rt')
    const real = (after!.messages as Array<{ id?: string; _source?: unknown }>).find(
      (m) => m.id === 'srv-sess-rt-t1',
    )
    assert.ok(real, 'server row still present after round-trip')
    assert.equal(real!._source, 'server', '_source preserved for authoritative id')
  })
})

describe('server-authoritative client session tape', () => {
  it('allocates ordered rows, pages complete turns, and rejects another owner', async () => {
    await upsertClientSession({
      id: 'sess-tape-order',
      userId: 'tape-owner',
      agentId: 'main',
      title: 'Tape',
      pinned: false,
      createdAt: 1,
      lastAt: 1,
      updatedAt: 1,
      messages: [],
    })
    const first = await appendClientSessionTapeFrame({
      sessionId: 'sess-tape-order',
      userId: 'tape-owner',
      turnKey: 'turn-1',
      direction: 'inbound',
      ts: 100,
      frame: { type: 'inbound.message', clientMessage: { id: 'u1' } },
    })
    const second = await appendClientSessionTapeFrame({
      sessionId: 'sess-tape-order',
      userId: 'tape-owner',
      turnKey: 'turn-1',
      direction: 'outbound',
      ts: 110,
      frame: { type: 'outbound.message', blocks: [{ kind: 'text', text: 'one' }] },
    })
    await appendClientSessionTapeFrame({
      sessionId: 'sess-tape-order',
      userId: 'tape-owner',
      turnKey: 'turn-2',
      direction: 'inbound',
      ts: 200,
      frame: { type: 'inbound.message', clientMessage: { id: 'u2' } },
    })
    await appendClientSessionTapeFrame({
      sessionId: 'sess-tape-order',
      userId: 'tape-owner',
      turnKey: 'turn-2',
      direction: 'outbound',
      ts: 210,
      frame: { type: 'outbound.message', blocks: [{ kind: 'text', text: 'two' }] },
    })
    await appendClientSessionTapeFrame({
      sessionId: 'sess-tape-order',
      userId: 'tape-owner',
      turnKey: 'turn-1',
      direction: 'outbound',
      ts: 220,
      frame: { type: 'outbound.message', blocks: [{ kind: 'tool_output_tail', tail: 'late' }] },
    })
    assert.equal(first.tapeSeq, 1)
    assert.equal(first.inserted, true)
    assert.equal(second.tapeSeq, 2)

    const latest = await listClientSessionTapePage('sess-tape-order', 'tape-owner', { turns: 1 })
    assert.deepEqual(
      latest?.frames.map((row) => row.turnKey),
      ['turn-2', 'turn-2'],
    )
    assert.equal(latest?.hasMore, true)
    const older = await listClientSessionTapePage('sess-tape-order', 'tape-owner', {
      before: latest?.nextBefore ?? undefined,
      turns: 1,
    })
    assert.deepEqual(
      older?.frames.map((row) => row.turnKey),
      ['turn-1', 'turn-1', 'turn-1'],
    )
    assert.equal(older?.hasMore, false)
    assert.equal(await listClientSessionTapePage('sess-tape-order', 'other-user'), null)
    const meta = (await listClientSessions('tape-owner')).find(
      (session) => session.id === 'sess-tape-order',
    )
    assert.equal(meta?.messageCount, 4, 'list metadata signals two taped turns for lazy hydration')
    assert.equal(meta?.tapeTurnCount, 2, 'list metadata explicitly forces cursor rehydration')

    const duplicateInbound = await appendClientSessionTapeFrame({
      sessionId: 'sess-tape-order',
      userId: 'tape-owner',
      turnKey: 'turn-2',
      direction: 'inbound',
      ts: 999,
      frame: { type: 'inbound.message', clientMessage: { id: 'duplicate' } },
    })
    assert.equal(duplicateInbound.tapeSeq, 3, 'inbound retry reuses the committed tape row')
    assert.equal(duplicateInbound.inserted, false)
    const unchanged = await listClientSessionTapePage('sess-tape-order', 'tape-owner', { turns: 2 })
    assert.equal(unchanged?.frames.length, 5)
  })

  it('makes the tape range authoritative over later browser PUTs and legacy append', async () => {
    await upsertClientSession({
      id: 'sess-tape-boundary',
      userId: 'boundary-owner',
      agentId: 'main',
      title: 'Boundary',
      pinned: false,
      createdAt: 1,
      lastAt: 1,
      updatedAt: 100,
      messages: [
        { id: 'legacy', role: 'user', text: 'before', ts: 5000 },
        { id: 'current', role: 'user', text: 'current', ts: 10 },
      ],
    })
    await appendClientSessionTapeFrame({
      sessionId: 'sess-tape-boundary',
      userId: 'boundary-owner',
      turnKey: 'turn-1',
      direction: 'inbound',
      ts: 100,
      frame: { type: 'inbound.message', clientMessage: { id: 'current' } },
    })
    const applied = await upsertClientSession(
      {
        id: 'sess-tape-boundary',
        userId: 'boundary-owner',
        agentId: 'main',
        title: 'Boundary',
        pinned: false,
        createdAt: 1,
        lastAt: 300,
        updatedAt: 300,
        messages: [
          { id: 'legacy', role: 'user', text: 'before', ts: 5000 },
          { id: 'current', role: 'user', text: 'current', ts: 10 },
          { id: 'stale-client', role: 'assistant', text: 'partial', ts: 150 },
        ],
      },
      100,
    )
    assert.equal(applied, true)
    const stored = await getClientSession('sess-tape-boundary', 'boundary-owner')
    assert.deepEqual(
      (stored?.messages as Array<{ id: string }>).map((message) => message.id),
      ['legacy'],
    )
    const legacyAppend = await appendServerAuthoredMessage('sess-tape-boundary', 'boundary-owner', {
      id: 'srv-old-path',
      role: 'assistant',
      text: 'must not duplicate tape',
      ts: 200,
    })
    assert.deepEqual(legacyAppend, { applied: false, reason: 'tape_authoritative' })
  })

  it('freezes a legacy prefix when the first browser PUT lands after the tape', async () => {
    await appendClientSessionTapeFrame({
      sessionId: 'sess-tape-first-put',
      userId: 'first-put-owner',
      turnKey: 'turn-new',
      direction: 'inbound',
      ts: 100,
      frame: { type: 'inbound.message', clientMessage: { id: 'current-new' } },
    })
    await upsertClientSession({
      id: 'sess-tape-first-put',
      userId: 'first-put-owner',
      agentId: 'main',
      title: 'First PUT',
      pinned: false,
      createdAt: 1,
      lastAt: 200,
      updatedAt: 200,
      messages: [
        { id: 'legacy-new', role: 'assistant', text: 'old', ts: 5000 },
        { id: 'current-new', role: 'user', text: 'current', ts: 10 },
        { id: 'partial-new', role: 'assistant', text: 'partial', ts: 20 },
      ],
    })
    const stored = await getClientSession('sess-tape-first-put', 'first-put-owner')
    assert.deepEqual(
      (stored?.messages as Array<{ id: string }>).map((message) => message.id),
      ['legacy-new'],
    )
  })

  it('moves tape ownership on claim and deletes rows with the session', async () => {
    await upsertClientSession({
      id: 'sess-tape-claim',
      userId: 'default',
      agentId: 'main',
      title: 'Claim',
      pinned: false,
      createdAt: 1,
      lastAt: 1,
      updatedAt: 1,
      messages: [],
    })
    await appendClientSessionTapeFrame({
      sessionId: 'sess-tape-claim',
      userId: 'default',
      turnKey: 'turn-1',
      direction: 'inbound',
      ts: 10,
      frame: { type: 'inbound.message' },
    })
    assert.equal(await claimSession('sess-tape-claim', 'claimed-owner'), true)
    assert.equal(
      (await getClientSessionTapeMeta('sess-tape-claim', 'claimed-owner')).lastTapeSeq,
      1,
    )
    assert.equal((await getClientSessionTapeMeta('sess-tape-claim', 'default')).lastTapeSeq, null)
    assert.equal(await deleteClientSession('sess-tape-claim', 'claimed-owner'), true)
    assert.equal(
      (await getClientSessionTapeMeta('sess-tape-claim', 'claimed-owner')).lastTapeSeq,
      null,
    )
  })
})

describe('usage availability labels', () => {
  it('distinguishes observed tokens from unavailable subscription cost', async () => {
    await insertUsageLog({
      id: 'usage-availability-1',
      sessionId: 'usage-session',
      agentId: 'codex',
      turnIndex: 1,
      model: 'gpt-test',
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      costUsd: 0,
      usageStatus: 'observed',
      costStatus: 'unavailable',
      durationMs: 10,
      toolCalls: 0,
      timestamp: 1,
    })
    const summary = await getUsageSummary({ sessionId: 'usage-session' })
    assert.equal(summary.totalInputTokens, 123)
    assert.equal(summary.usageObservedTurns, 1)
    assert.equal(summary.usageUnavailableTurns, 0)
    assert.equal(summary.costObservedTurns, 0)
    assert.equal(summary.costUnavailableTurns, 1)
  })
})
