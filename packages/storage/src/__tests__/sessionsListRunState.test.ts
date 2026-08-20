/**
 * GET /api/sessions/list 的 runState / lastOutcome 派生:
 * 一条 LEFT JOIN SQL 从 turn_dispatch_inbox 取值,不 N+1。
 * inbox.user_id 是裸 uid,client_sessions.user_id 是 `c:<uid>` —— JOIN 只按 session_id。
 *
 * Run: npx tsx --test packages/storage/src/__tests__/sessionsListRunState.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-sess-runstate-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  casTurnDispatchState,
  getSessionsDb,
  insertQueuedTurnDispatch,
  listClientSessions,
  markAllClientSessionsRead,
  markClientSessionRead,
  migrateClientSessionsUnread,
  recordTurnDispatchRunning,
  searchClientSessions,
  upsertClientSession,
} = await import('../sessionsDb.js')

const USER = 'c:42'
const INBOX_UID = '42'

async function clearTables(): Promise<void> {
  const db = await getSessionsDb()
  db.exec('DELETE FROM turn_dispatch_inbox')
  db.exec('DELETE FROM client_sessions')
}

function session(id: string) {
  const now = Date.now()
  return {
    id,
    userId: USER,
    agentId: 'main',
    title: id,
    pinned: false,
    createdAt: now,
    lastAt: now,
    messages: [] as unknown[],
    updatedAt: now,
  }
}

async function admit(sessionId: string, cm: string, dispatchId: string) {
  const r = await insertQueuedTurnDispatch({
    userId: INBOX_UID,
    sessionId,
    clientMessageId: cm,
    dispatchId,
    attemptNo: 1,
    payloadHash: `h-${cm}`,
  })
  assert.equal(r.inserted, true)
}

describe('listClientSessions runState/lastOutcome', () => {
  beforeEach(clearTables)

  it('从未跑过 turn → idle + lastOutcome null', async () => {
    await upsertClientSession(session('web-idle'))
    const meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'web-idle')
    assert.ok(meta)
    assert.equal(meta.runState, 'idle')
    assert.equal(meta.lastOutcome, null)
    assert.equal(meta.lastErrorCode, null)
    assert.equal(meta.projectId, null)
  })

  it('queued/running 非终态 → running;终态 completed → idle + lastOutcome', async () => {
    await upsertClientSession(session('web-run'))
    await admit('web-run', 'cm-1', 'd-1')
    let meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'web-run')
    assert.equal(meta?.runState, 'running')
    assert.equal(meta?.lastOutcome, null)

    await recordTurnDispatchRunning({
      userId: INBOX_UID,
      sessionId: 'web-run',
      clientMessageId: 'cm-1',
      agentId: 'main',
      turnIndex: 1,
      turnKey: 'tk-1',
      requestId: 'req-1',
      createdAt: 1,
    })
    meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'web-run')
    assert.equal(meta?.runState, 'running')

    const terminal = await casTurnDispatchState({
      userId: INBOX_UID,
      sessionId: 'web-run',
      clientMessageId: 'cm-1',
      fromStates: ['running'],
      toState: 'terminal',
      outcome: 'completed',
    })
    assert.equal(terminal?.outcome, 'completed')
    meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'web-run')
    assert.equal(meta?.runState, 'idle')
    assert.equal(meta?.lastOutcome, 'completed')
  })

  it('最近一条终态优先;仍有开放 dispatch 则 running', async () => {
    await upsertClientSession(session('web-mix'))
    await admit('web-mix', 'cm-old', 'd-old')
    await casTurnDispatchState({
      userId: INBOX_UID,
      sessionId: 'web-mix',
      clientMessageId: 'cm-old',
      fromStates: ['queued'],
      toState: 'terminal',
      outcome: 'interrupted',
      now: 1000,
    })
    await admit('web-mix', 'cm-new', 'd-new')
    await casTurnDispatchState({
      userId: INBOX_UID,
      sessionId: 'web-mix',
      clientMessageId: 'cm-new',
      fromStates: ['queued'],
      toState: 'terminal',
      outcome: 'crashed',
      now: 2000,
    })
    let meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'web-mix')
    assert.equal(meta?.runState, 'idle')
    assert.equal(meta?.lastOutcome, 'crashed')

    await admit('web-mix', 'cm-open', 'd-open')
    meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'web-mix')
    assert.equal(meta?.runState, 'running')
    assert.equal(meta?.lastOutcome, 'crashed')
  })

  it('rejected 计为终态 lastOutcome=not_accepted,且不算 running', async () => {
    await upsertClientSession(session('web-rej'))
    await admit('web-rej', 'cm-r', 'd-r')
    await casTurnDispatchState({
      userId: INBOX_UID,
      sessionId: 'web-rej',
      clientMessageId: 'cm-r',
      fromStates: ['queued'],
      toState: 'rejected',
      outcome: 'not_accepted',
    })
    const meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'web-rej')
    assert.equal(meta?.runState, 'idle')
    assert.equal(meta?.lastOutcome, 'not_accepted')
  })

  it('last_read_at 列存在;终态后 unread=true;markRead 后 false', async () => {
    const db = await getSessionsDb()
    const cols = db.pragma('table_info(client_sessions)') as Array<{ name: string }>
    assert.ok(cols.some((c) => c.name === 'last_read_at'))

    await upsertClientSession(session('web-unread'))
    let meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'web-unread')
    assert.equal(meta?.unread, false)

    await admit('web-unread', 'cm-u', 'd-u')
    await casTurnDispatchState({
      userId: INBOX_UID,
      sessionId: 'web-unread',
      clientMessageId: 'cm-u',
      fromStates: ['queued'],
      toState: 'terminal',
      outcome: 'completed',
    })
    meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'web-unread')
    assert.equal(meta?.unread, true)

    const marked = await markClientSessionRead(USER, 'web-unread')
    assert.equal(marked.ok, true)
    meta = (await listClientSessions(USER)).sessions.find((s) => s.id === 'web-unread')
    assert.equal(meta?.unread, false)
  })

  it('search 命中带 unread;migrate 把指定 id 变回未读;read-all 全清', async () => {
    await upsertClientSession({ ...session('web-hit'), title: 'alpha unread', lastAt: Date.now() })
    await admit('web-hit', 'cm-h', 'd-h')
    await casTurnDispatchState({
      userId: INBOX_UID,
      sessionId: 'web-hit',
      clientMessageId: 'cm-h',
      fromStates: ['queued'],
      toState: 'terminal',
      outcome: 'interrupted',
    })
    const marked = await markClientSessionRead(USER, 'web-hit')
    assert.equal(marked.ok, true)
    assert.equal((await listClientSessions(USER)).sessions.find((s) => s.id === 'web-hit')?.unread, false)

    const migrated = await migrateClientSessionsUnread(USER, ['web-hit'])
    assert.equal(migrated.ok, true)
    assert.equal((await listClientSessions(USER)).sessions.find((s) => s.id === 'web-hit')?.unread, true)

    const hits = await searchClientSessions(USER, { q: 'alpha' })
    const hit = hits.results.find((h) => h.sessionId === 'web-hit')
    assert.ok(hit)
    assert.equal(hit.unread, true)

    const all = await markAllClientSessionsRead(USER)
    assert.ok(all.updated >= 1)
    assert.equal((await listClientSessions(USER)).sessions.find((s) => s.id === 'web-hit')?.unread, false)
  })
})
