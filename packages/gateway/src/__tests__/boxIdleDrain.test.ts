/**
 * OCV5-297 background idle drain: internal-turn accounting over the whole
 * drain window, lock ordering with a submit that joined the chain first, and
 * rereading durable state instead of a captured source. paths.home is pinned
 * to a temp dir before any gateway module loads.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const home = mkdtempSync(join(tmpdir(), 'idle-drain-home-'))
process.env.OPENCLAUDE_HOME = home
after(() => rmSync(home, { recursive: true, force: true }))

const { SessionManager } = await import('../sessionManager.js')
const { clearIdleCandidate, readIdleCandidate, writeIdleCandidate } = await import('../boxIdleCompact.js')
const { paths } = await import('@openclaude/storage')

type Session = { sessionKey: string; lock: Promise<void>; _idleInternalTurns?: number }
const schedule = (SessionManager.prototype as unknown as {
  scheduleIdleDrain: (this: object, session: Session) => void
}).scheduleIdleDrain

function harness(session: Session) {
  const seen: Array<{ sessionId: string; turnKey: string }> = []
  const self = {
    sessions: new Map([[session.sessionKey, session]]),
    async finishIdleUnderLock(s: Session, source: { sessionId: string; turnKey: string }) {
      seen.push(source)
      clearIdleCandidate(paths.home, s.sessionKey)
    },
    scheduleIdleDrain: schedule,
  }
  return { self, seen }
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

test('paths.home is the isolated temp dir, never the production home', () => {
  assert.equal(paths.home, home)
})

test('the drain counts as an internal turn from scheduling until it releases the lock', async () => {
  const user = gate()
  const session: Session = { sessionKey: 'drain-count', lock: user.promise }
  writeIdleCandidate(paths.home, { v: 1, sessionKey: session.sessionKey, sessionId: 'n1', turnKey: 'a'.repeat(64) })
  const { self, seen } = harness(session)
  schedule.call(self, session)
  assert.equal(session._idleInternalTurns, 1, 'busy while still waiting for the lock')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.length, 0, 'does not run before the holder releases')
  user.open()
  await session.lock
  assert.equal(session._idleInternalTurns, 0)
  assert.deepEqual(seen, [{ sessionId: 'n1', turnKey: 'a'.repeat(64) }])
})

test('a submit already queued on the lock runs first; the drain then reads its fresh state', async () => {
  const user = gate()
  const session: Session = { sessionKey: 'drain-order', lock: user.promise }
  writeIdleCandidate(paths.home, { v: 1, sessionKey: session.sessionKey, sessionId: 'n1', turnKey: 'a'.repeat(64) })
  // Submit B joined the chain during the user turn.
  const order: string[] = []
  const prevB = session.lock
  let releaseB!: () => void
  session.lock = new Promise<void>((resolve) => { releaseB = resolve })
  void (async () => {
    await prevB
    order.push('B')
    // B's own submit-start gate handled the old candidate; its turn wrote a new one.
    writeIdleCandidate(paths.home, { v: 1, sessionKey: session.sessionKey, sessionId: 'n1', turnKey: 'b'.repeat(64) })
    releaseB()
  })()
  const { self, seen } = harness(session)
  user.open()
  schedule.call(self, session)
  await session.lock
  order.push('drain-done')
  assert.deepEqual(order, ['B', 'drain-done'])
  assert.deepEqual(seen, [{ sessionId: 'n1', turnKey: 'b'.repeat(64) }], 'no stale captured source')
  assert.equal(readIdleCandidate(paths.home, session.sessionKey), undefined)
  assert.equal(session._idleInternalTurns, 0)
})

test('a drain for a session that was closed meanwhile does nothing and still releases', async () => {
  const session: Session = { sessionKey: 'drain-closed', lock: Promise.resolve() }
  writeIdleCandidate(paths.home, { v: 1, sessionKey: session.sessionKey, sessionId: 'n1', turnKey: 'c'.repeat(64) })
  const { self, seen } = harness(session)
  self.sessions.delete(session.sessionKey)
  schedule.call(self, session)
  await session.lock
  assert.deepEqual(seen, [])
  assert.equal(session._idleInternalTurns, 0)
  assert.ok(readIdleCandidate(paths.home, session.sessionKey), 'durable state kept for the next submit')
})
