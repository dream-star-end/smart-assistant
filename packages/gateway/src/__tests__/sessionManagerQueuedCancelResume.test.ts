// OCV5-121/138: queued cancellation must precede durable-resume side effects.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'

// No paths-aware runtime import may run before this isolated HOME exists.
const home = await mkdtemp(join(tmpdir(), 'oc-queued-resume-'))
process.env.OPENCLAUDE_HOME = home
delete process.env.OC_RUNTIME_CHANNEL
delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
const {
  insertQueuedTurnDispatch, cancelQueuedTurnDispatchExact, getTurnDispatchByDispatchId,
  getSessionsDb, closeSessionsDb,
} = await import('@openclaude/storage')
const { SessionManager } = await import('../sessionManager.js')
const { eventBus } = await import('../eventBus.js')

after(async () => {
  await closeSessionsDb()
  await rm(home, { recursive: true, force: true })
})

const DEAD = '11111111-1111-4111-8111-111111111111'
const PRIOR = '22222222-2222-4222-8222-222222222222'
let serial = 0

async function fixture(t: TestContext) {
  const id = ++serial
  const dir = join(home, 'fixture-' + id)
  const artifact = join(home, 'grok-build', 'sessions', '%2Fws', PRIOR)
  await mkdir(artifact, { recursive: true })
  await mkdir(dir, { recursive: true })
  await writeFile(join(artifact, 'messages.jsonl'), '{}\n')
  const config = {
    version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: '' },
    defaults: { model: 'glm-5.3-zai' },
  } as unknown as OpenClaudeConfig
  const sm = new SessionManager(config)
  // Private observations only; submit(), both inbox fences and resume probing remain real.
  const m = sm as any
  m.resumeMapPath = join(dir, 'resume-map.json')
  m._resumeMap.clear()
  m._resumeMapProvider.clear()
  m._resumeMapTimestamps.clear()
  m._resumeMapHistory.clear()
  const session = await sm.getOrCreate({
    sessionKey: 'queued-resume-' + id,
    agent: { id: 'main', model: 'grok-build', cwd: dir },
    model: 'grok-build',
    executionAuthority: { engine: 'grok', canonicalModel: 'grok-build', source: 'local_catalog' },
    workspaceCwd: dir,
  })
  session.runner.setResumeSessionId?.(DEAD)
  session.runner.emit('session_id', DEAD)
  // The prompt-queue coordinator registers exactly one logical client turn
  // before calling submit with queueLifecycle; preserve that real admission precondition.
  session._activeClientTurnCount = 1
  m._resumeMapHistory.set(session.sessionKey, [PRIOR])
  m._saveResumeMap()
  await m.awaitResumeMapFlush()
  const beforeMap = await readFile(m.resumeMapPath, 'utf8')
  const ctx = {
    userId: '42', sessionId: 'queued-resume-' + id, clientMessageId: 'cm-' + id,
    dispatchId: 'dispatch-' + id, attemptNo: 1,
  }
  assert.equal((await insertQueuedTurnDispatch({ ...ctx, payloadHash: 'hash' })).inserted, true)
  const calls: string[] = []
  for (const method of ['setResumeSessionId', 'clearSessionId', 'setModel', 'setEffortLevel',
    'setTraceId', 'setGrokRoute', 'setGoalState'] as const) {
    const runner = session.runner as any
    if (typeof runner[method] === 'function') {
      const original = runner[method].bind(runner)
      t.mock.method(runner, method, (...args: unknown[]) => {
        calls.push(method)
        return original(...args)
      })
    }
  }
  t.mock.method(session.runner, 'shutdown', async () => { calls.push('shutdown') })
  t.mock.method(session.runner, 'submitTurn', () => {
    calls.push('submitTurn')
    throw new Error('unexpected model submission')
  })
  const originalSave = m._saveResumeMap.bind(m)
  t.mock.method(m, '_saveResumeMap', () => { calls.push('saveResumeMap'); return originalSave() })
  const tools: unknown[] = []
  const onTool = (event: unknown) => { tools.push(event) }
  eventBus.on('tool.called', onTool)
  t.after(async () => {
    eventBus.off('tool.called', onTool)
    await m.awaitResumeMapFlush()
  })
  const replay = {
    clientMessageId: ctx.clientMessageId,
    onStart: () => { calls.push('replayStart') },
    onBeforeRelease: () => { calls.push('replayBeforeRelease') },
    onEnd: () => { calls.push('replayEnd') },
  }
  const queue = { queueTurn: true as const, onTurnReserved: async () => { calls.push('turnReserved') } }
  const events: unknown[] = []
  const submit = (dispatchContext = ctx, extra: Record<string, unknown> = {}) =>
    sm.submit(session, 'cancelled task must not resume', event => events.push(event),
      undefined, undefined, undefined, 'a'.repeat(32), undefined, {
        dispatchContext, replayLifecycle: replay, queueLifecycle: queue, ...extra,
      })
  const assertReleased = async () => {
    await session.lock
    assert.equal(session._activeTurnCount, 0)
    assert.equal(session._currentDispatch, undefined)
    assert.equal(m._promptQueueExecutions.has(session), false)
    assert.equal(m._promptQueueExecutionKeys.has(session.sessionKey), false)
  }
  const assertNoEffects = async () => {
    await m.awaitResumeMapFlush()
    assert.deepEqual(calls, [])
    assert.deepEqual(events, [])
    assert.deepEqual(tools, [])
    assert.equal(session.runner.nativeSessionId, DEAD)
    assert.equal(session.ccbSessionId, DEAD)
    assert.equal(m._resumeMap.get(session.sessionKey), DEAD)
    assert.deepEqual(m._resumeMapHistory.get(session.sessionKey), [PRIOR])
    assert.equal(await readFile(m.resumeMapPath, 'utf8'), beforeMap)
    const db = await getSessionsDb()
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions_fts WHERE session_id = ?')
      .get(session.sessionKey) as { n: number }).n, 0)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_turn_counters WHERE session_id = ?')
      .get(session.sessionKey) as { n: number }).n, 0)
    await assertReleased()
  }
  return { sm, m, session, ctx, calls, events, tools, submit, assertReleased, assertNoEffects }
}

for (const resetNativeSession of [false, true]) {
  test('cancel while predecessor holds lock: no resume/promotion/reset side effects; reset=' + resetNativeSession,
    { timeout: 10000 }, async t => {
      const f = await fixture(t)
      let release!: () => void
      f.session.lock = new Promise<void>(resolve => { release = resolve })
      let failure: unknown
      const observed = f.submit(f.ctx, { resetNativeSession }).catch(error => { failure = error })
      try {
        assert.equal(f.session._activeTurnCount, 1)
        assert.deepEqual(f.calls, [])
        assert.equal((await cancelQueuedTurnDispatchExact(f.ctx)).applied, true)
      } finally {
        release()
        await observed
        if (failure !== undefined) throw failure
      }
      await f.assertNoEffects()
      const row = await getTurnDispatchByDispatchId(f.ctx.dispatchId, 1)
      assert.equal(row?.state, 'rejected')
      assert.equal(row?.outcome, 'not_accepted')
    })
}

test('exact early guard does not silently consume a different identity or attempt',
  { timeout: 10000 }, async t => {
    const variants = [
      { userId: '43' }, { sessionId: 'other' }, { clientMessageId: 'other' },
      { dispatchId: 'other' }, { attemptNo: 2 },
    ]
    for (const variant of variants) {
      const f = await fixture(t)
      await cancelQueuedTurnDispatchExact(f.ctx)
      const sentinel = new Error('reached preflight after nonmatching fence')
      let preflight = 0
      t.mock.method(f.session.runner, 'setTraceId', () => { preflight++; throw sentinel })
      await assert.rejects(f.submit({ ...f.ctx, ...variant }), error => error === sentinel)
      assert.equal(preflight, 1)
      await f.assertReleased()
      assert.equal((await getTurnDispatchByDispatchId(f.ctx.dispatchId, 1))?.state, 'rejected')
    }
  })

test('queued at early read, cancelled before real final CAS: no model/tape/error',
  { timeout: 10000 }, async t => {
    const f = await fixture(t)
    const original = f.m.runOneTurnWithRetry.bind(f.m)
    let finalCasPath = 0
    t.mock.method(f.m, 'runOneTurnWithRetry', async (...args: unknown[]) => {
      finalCasPath++
      assert.equal((await cancelQueuedTurnDispatchExact(f.ctx)).applied, true)
      return original(...args)
    })
    await f.submit()
    assert.equal(finalCasPath, 1, 'must really traverse preflight and the final CAS')
    assert.equal(f.calls.includes('submitTurn'), false)
    assert.equal(f.calls.includes('turnReserved'), false)
    assert.deepEqual(f.events, [])
    assert.deepEqual(f.tools, [])
    assert.equal((await getTurnDispatchByDispatchId(f.ctx.dispatchId, 1))?.state, 'rejected')
    const db = await getSessionsDb()
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sessions_fts WHERE session_id = ?')
      .get(f.session.sessionKey) as { n: number }).n, 0)
    await f.assertReleased()
  })

test('inbox lookup error fails closed before replay and resume effects',
  { timeout: 10000 }, async t => {
    const f = await fixture(t)
    const db = await getSessionsDb()
    const original = db.prepare.bind(db)
    const sentinel = new Error('injected exact inbox read failure')
    const mock = t.mock.method(db, 'prepare', ((sql: string) => {
      if (sql === 'SELECT * FROM turn_dispatch_inbox WHERE dispatch_id = ? AND attempt_no = ?') {
        throw sentinel
      }
      return original(sql)
    }) as typeof db.prepare)
    try {
      await assert.rejects(f.submit(), error => error === sentinel)
    } finally {
      mock.mock.restore()
    }
    await f.assertNoEffects()
    assert.equal((await getTurnDispatchByDispatchId(f.ctx.dispatchId, 1))?.state, 'queued')
  })

test('positive control: uncancelled queued turn really promotes the durable prior resume id',
  { timeout: 10000 }, async t => {
    const f = await fixture(t)
    let executionSeam = 0
    t.mock.method(f.m, 'runOneTurnWithRetry', async () => { executionSeam++ })
    await f.submit()
    assert.equal(executionSeam, 1)
    assert.equal(f.session.runner.nativeSessionId, PRIOR)
    assert.equal(f.m._resumeMap.get(f.session.sessionKey), PRIOR)
    assert.equal(f.calls.includes('setResumeSessionId'), true)
    assert.equal(f.calls.includes('saveResumeMap'), true)
    assert.equal(f.calls.includes('submitTurn'), false)
    await f.assertReleased()
  })
