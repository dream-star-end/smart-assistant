/** Real HTTP create, original resume/capacity path and private SQLite transactions.
 * Session lookup and child executor are fixtures; no native retry or deletion-route claim.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import Database from 'better-sqlite3'

const home = mkdtempSync(join(tmpdir(), 'delegate-retry-source-'))
process.env.OPENCLAUDE_HOME = home
process.env.OC_DELEGATE_SM = '1'
process.env.OC_DELEGATE_DURABLE = '1'
const { Gateway } = await import('../server.js')
const { DelegateDurableDb } = await import('../delegateDurable.js')
const { DelegateJobStore } = await import('../delegateJobs.js')
const { issueDelegateContextToken, DELEGATE_CONTEXT_HEADER } = await import('../delegateContext.js')
const { signJwt } = await import('../auth.js')
const storage = await import('../../../storage/src/sessionsDb.js')
const TOKEN = 'private-source-test-token'
const jwt = (userId = 'c:7', exp = Math.floor(Date.now() / 1000) + 60) => 'Bearer ' + signJwt({ userId, exp }, TOKEN)
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function fixture() {
  const dir = mkdtempSync(join(home, 'case-')), peerId = dir.split('/').pop()!
  await storage.upsertClientSession({ id: peerId, userId: 'c:7', agentId: 'main', title: 'private source',
    pinned: false, createdAt: 1000, lastAt: 1000, updatedAt: 1000, messages: [] })
  const parent: any = { agentId: 'main', userId: 'c:7', sessionKey: 'agent:main:webchat:dm:' + peerId,
    _currentTurnKey: 'private-source-turn', channel: 'webchat', peerId, runner: {} }
  let visible = parent, now = Date.now(), executions = 0
  const path = join(dir, 'delegate.db'), db = new DelegateDurableDb(path)
  // No blanket failureInbox opt-in: only proven source creation may enable it.
  const jobs = new DelegateJobStore({ durable: db, sm: true, ttlMs: 100, now: () => now })
  const gw: any = new Gateway({ config: { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: TOKEN },
    auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(dir, 'sessions.db') },
    defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } } } as never,
    agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }, { id: 'coding-assistant', model: 'glm-5.2' }], routes: [], default: 'main' } })
  gw.sessions = { getByKey: (key: string) => key === parent.sessionKey ? visible : undefined }
  gw._delegateJobs = jobs; gw._delegateReconcileReady = true; gw._readDelegateMemoryPressure = () => null
  gw._runDelegateTask = async (input: any) => {
    executions++
    // Actual core is outside this fixture. It normally owns/releases these reservations.
    gw._releasePreadmittedDelegateCapacity(input)
    return { kind: 'rejected', status: 503, failureClass: 'internal', message: 'PRIVATE_RESULT_SECRET' }
  }
  const server = createServer((req, res) => gw.handleHttp(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const context = issueDelegateContextToken({ agentId: 'main', sessionKey: parent.sessionKey, depth: 0 })
  async function post(extra: Record<string, unknown> = {}, authorization = jwt(), signedContext = context) {
    const res = await fetch(base + '/api/agents/coding-assistant/delegate', { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', [DELEGATE_CONTEXT_HEADER]: signedContext },
      body: JSON.stringify({ async: true, goal: 'PRIVATE_GOAL_SECRET', context: 'PRIVATE_CONTEXT_SECRET', model: 'glm-5.2', ...extra }) })
    const data = await res.json() as any
    await tick()
    return { status: res.status, data }
  }
  const sql = new Database(path)
  const counts = () => ({ jobs: (sql.prepare('SELECT count(*) n FROM delegate_jobs').get() as { n: number }).n,
    sources: (sql.prepare('SELECT count(*) n FROM delegate_retry_source').get() as { n: number }).n,
    executions, active: gw._activeDelegations, resume: gw._delegateResume?.reservedSize() ?? 0,
    queued: gw._delegateQueueWaiters?.size ?? 0 })
  return { gw, parent, peerId, path, db, jobs, sql, post, context, counts,
    hide() { visible = undefined }, expire() { now += 1000; return jobs.sweep() },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      clearTimeout(gw._notifyRetryTimer); clearTimeout(gw._receiptCandidateTimer); jobs.close(); db.close(); sql.close() },
  }
}

test('HTTP authenticated create captures exact source, enables only its inbox, survives runtime TTL/reopen', async () => {
  const f = await fixture()
  try {
    const response = await f.post({ userId: 'c:8', sourceAgent: 'auditor', parentSessionKey: 'forged',
      retrySource: { userId: 'c:8', childSessionKey: 'forged', goal: 'DO_NOT_STORE' } })
    assert.equal(response.status, 200, JSON.stringify(response))
    const source = f.db.getRetrySource('c:7', response.data.jobId, 0)
    assert.deepEqual(source, { version: 1, userId: 'c:7', parentSessionKey: f.parent.sessionKey,
      parentClientSessionId: f.peerId, originSessionKey: f.parent.sessionKey,
      childSessionKey: response.data.sessionKey, targetAgentId: 'coding-assistant', sourceAgentId: 'main', depth: 0, model: 'glm-5.2' })
    assert.equal(f.db.getRetrySource('c:8', response.data.jobId, 0), undefined)
    assert.equal(f.jobs.userFailureInbox('c:7').count, 1)
    const metadata = String((f.sql.prepare('SELECT metadata_json FROM delegate_retry_source').get() as { metadata_json: string }).metadata_json)
    assert.doesNotMatch(metadata, /SECRET|DO_NOT_STORE|forged|capability|receiptNonce/)
    assert.equal(f.counts().executions, 1); assert.equal(f.expire(), 1)
    assert.equal(f.jobs.snapshotOf(response.data.jobId), undefined)
    const reopened = new DelegateDurableDb(f.path)
    try { assert.deepEqual(reopened.getRetrySource('c:7', response.data.jobId, 0), source) } finally { reopened.close() }
  } finally { await f.close() }
})

test('service credential never supplies owner; missing live provenance has no source or invented failure inbox', async () => {
  const f = await fixture()
  try {
    const known = await f.post({}, 'Bearer ' + TOKEN)
    assert.equal(known.status, 200); assert.equal(f.db.getRetrySource('c:7', known.data.jobId, 0)?.userId, 'c:7')
    f.hide()
    const legacy = await f.post({}, 'Bearer ' + TOKEN)
    assert.equal(legacy.status, 200, JSON.stringify(legacy))
    assert.equal(f.db.getRetrySource('c:7', legacy.data.jobId, 0), undefined)
    assert.equal(f.jobs.userFailureInbox('c:7').count, 1); assert.equal(f.counts().sources, 1)
  } finally { await f.close() }
})

test('foreign user and real foreign SQL client row create no job/source/reservation', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.post({}, jwt('c:8'))).status, 403)
    await storage.upsertClientSession({ id: f.peerId + '-foreign', userId: 'c:8', agentId: 'main', title: 'private foreign',
      pinned: false, createdAt: 1000, lastAt: 1000, updatedAt: 1000, messages: [] })
    f.parent.peerId += '-foreign'
    assert.equal((await f.post()).status, 503)
    const c = f.counts(); assert.equal(c.jobs, 0); assert.equal(c.sources, 0); assert.equal(c.executions, 0)
    assert.equal(c.active, 0); assert.equal(c.resume, 0); assert.equal(c.queued, 0)
  } finally { await f.close() }
})

test('actual SQL await then JWT expiry or native parent turn change cannot capture stale provenance', { timeout: 10000 }, async () => {
  for (const mode of ['jwt', 'turn'] as const) {
    const f = await fixture(), entered = gate(), release = gate()
    try {
      const original = f.gw._receiptClientState.bind(f.gw)
      f.gw._receiptClientState = async (parent: unknown) => { const state = await original(parent); entered.release(); await release.promise; return state }
      const exp = Math.floor(Date.now() / 1000) + 2
      const pending = f.post({}, jwt('c:7', mode === 'jwt' ? exp : exp + 30))
      await entered.promise
      if (mode === 'jwt') await new Promise(resolve => setTimeout(resolve, exp * 1000 + 30 - Date.now()))
      else f.parent._currentTurnKey = 'different-turn'
      release.release()
      assert.equal((await pending).status, mode === 'jwt' ? 401 : 409)
      const c = f.counts(); assert.equal(c.jobs, 0); assert.equal(c.sources, 0); assert.equal(c.executions, 0); assert.equal(c.resume, 0)
    } finally { release.release(); await f.close() }
  }
})

test('source insert SQL failure rolls back the real job and original preadmitted capacity', async () => {
  const f = await fixture()
  try {
    f.sql.exec(`CREATE TRIGGER private_source_fault BEFORE INSERT ON delegate_retry_source BEGIN SELECT RAISE(ABORT,'private source fault'); END`)
    const rejected = await f.post()
    assert.equal(rejected.status, 500)
    const c = f.counts(); assert.equal(c.jobs, 0); assert.equal(c.sources, 0); assert.equal(c.executions, 0)
    assert.equal(c.active, 0); assert.equal(c.resume, 0); assert.equal(c.queued, 0)
    f.sql.exec('DROP TRIGGER private_source_fault')
    assert.equal((await f.post()).status, 200); assert.equal(f.counts().executions, 1)
  } finally { await f.close() }
})

test('durable reuse never overwrites provenance; a persisted parent fence rejects the INSERT', async () => {
  const f = await fixture()
  try {
    const first = await f.post()
    assert.equal(first.status, 200)
    const source = f.db.getRetrySource('c:7', first.data.jobId, 0)!
    const meta = { sessionKey: 'private-child', parentSessionKey: source.parentSessionKey, callbackOriginUserId: source.userId,
      idempotencyKey: 'private-source-reuse', retrySource: { ...source, childSessionKey: 'private-child' } }
    const created = f.jobs.create('coding-assistant', meta); assert.ok('jobId' in created)
    const same = f.jobs.create('coding-assistant', meta); assert.ok('jobId' in same); assert.equal(same.jobId, created.jobId)
    assert.throws(() => f.jobs.create('coding-assistant', { ...meta, retrySource: { ...meta.retrySource, depth: 1 } }), /binding mismatch/)
    assert.deepEqual(f.db.getRetrySource('c:7', created.jobId, 0), meta.retrySource)
    // Storage-level fence only; this does not claim the user deletion hook is wired.
    f.sql.prepare('INSERT INTO delegate_retry_parent_fence VALUES(?,?,?)').run(source.userId, source.parentClientSessionId, Date.now())
    assert.equal(f.db.getRetrySource('c:7', first.data.jobId, 0), undefined)
    const before = f.counts()
    assert.throws(() => f.jobs.create('coding-assistant', { ...meta, idempotencyKey: 'new-after-fence' }), /parent deleted/)
    assert.deepEqual(f.counts(), before)
  } finally { await f.close() }
})
