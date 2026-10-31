import { installDelegateSandbox } from './helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { backgroundDelegates, BackgroundDelegateScope, isDelegateBackgroundEffective, type BackgroundDelegateOwner } from '../delegateBackground.js'
import { issueDelegateContextToken, DELEGATE_CONTEXT_HEADER } from '../delegateContext.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { handleDelegateTask, _runDelegateTask } from '../delegateRuntime.js'
import { handleStop } from '../wsConnection.js'
import { setV3MasterSinkSingleton } from '../v3MasterSink.js'
import { submit } from '../sessionSubmit.js'
import { acquireDelegateGrokRoute } from '../delegateGrokRoute.js'

const owner: BackgroundDelegateOwner = {
  sessionKey: 'agent:main:webchat:dm:background-session', clientMessageId: 'cmid-background-owner',
  userId: 'background-user', traceId: 'a'.repeat(32),
  locator: { parentSessionId: 'background-session', parentTurnKey: 'b'.repeat(64), turnIndex: 1 },
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function enable() {
  Object.assign(process.env, {
    OC_DELEGATE_BACKGROUND: '1', OC_SELFHOST_ENGINE_LOCAL_TURNS: '1', OC_RUNTIME_CHANNEL: 'v5',
    OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.invalid', OPENCLAUDE_V3_CONTAINER_TOKEN: 'test-bearer',
  })
  setV3MasterSinkSingleton({ persistOrQueue: async () => ({ ok: true }), attemptOnce: async () => {} } as never)
}
afterEach(() => setV3MasterSinkSingleton(null))

describe('background delegate exact lifetime', { concurrency: 1 }, () => {
  it('defaults off and cannot activate in a commercial or standalone runtime', () => {
    const env = { OC_SELFHOST_ENGINE_LOCAL_TURNS: '1', OC_RUNTIME_CHANNEL: 'v5',
      OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.invalid', OPENCLAUDE_V3_CONTAINER_TOKEN: 'x' }
    assert.equal(isDelegateBackgroundEffective(env), false)
    assert.equal(isDelegateBackgroundEffective({ ...env, OC_DELEGATE_BACKGROUND: '1' }), true)
    assert.equal(isDelegateBackgroundEffective({ ...env, OC_DELEGATE_BACKGROUND: '1', OC_SELFHOST_ENGINE_LOCAL_TURNS: '0' }), false)
    assert.equal(isDelegateBackgroundEffective({ ...env, OC_DELEGATE_BACKGROUND: '1', OPENCLAUDE_V3_CONTAINER_TOKEN: '' }), false)
  })

  it('stops never-resolving read preparation without waiting for its barrier', async () => {
    const scope = new BackgroundDelegateScope(owner)
    const pending = scope.wait(new Promise<void>(() => {}))
    scope.stop()
    await assert.rejects(pending, /USER_CANCELLED/)
    await scope.waitForCleanup()
  })

  it('keeps an uncertain resource receipt pending until late release finishes', async () => {
    const scope = new BackgroundDelegateScope(owner)
    const acquired = deferred<{ lease: string }>()
    const release = deferred<void>()
    let releaseCalls = 0
    const waiting = scope.wait(acquired.promise, async value => {
      assert.equal(value.lease, 'exact-lease')
      releaseCalls++
      await release.promise
    })
    scope.stop()
    await assert.rejects(waiting, /USER_CANCELLED/)
    let clean = false
    const cleaning = scope.waitForCleanup().then(() => { clean = true })
    await Promise.resolve()
    assert.equal(clean, false)
    acquired.resolve({ lease: 'exact-lease' })
    await Promise.resolve()
    assert.equal(releaseCalls, 1)
    assert.equal(clean, false)
    release.resolve()
    await cleaning
    assert.equal(clean, true)
  })

  it('tracks nested HTTP preparation through descendant cleanup', async () => {
    const scope = new BackgroundDelegateScope(owner)
    const leaveRoot = scope.enter('root')
    const leavePending = scope.enterPending('root')
    let finished = false
    const waiting = scope.waitForDescendants('root').then(() => { finished = true })
    await Promise.resolve()
    assert.equal(finished, false)
    assert.throws(() => scope.enter('late', 'root'), /USER_CANCELLED/)
    leavePending()
    await waiting
    leaveRoot()
    assert.equal(finished, true)
  })

  it('seals an empty owner before its delayed signed delegate HTTP can arrive', () => {
    const registry = backgroundDelegates({})
    registry.sealOwner(owner.sessionKey, owner.locator.parentTurnKey)
    assert.throws(() => registry.begin(owner), /USER_CANCELLED/)
  })

  it('exact IDs reject foreign ownership and a repeated main Stop cannot capture newer jobs', () => {
    const registry = backgroundDelegates({})
    const first = registry.begin(owner)
    first.jobId = 'dlgjob-first'
    const second = registry.begin({ ...owner, clientMessageId: 'cmid-second',
      locator: { ...owner.locator, parentTurnKey: 'c'.repeat(64) } })
    second.jobId = 'dlgjob-second'
    assert.equal(registry.stop({ peerId: owner.locator.parentSessionId, userId: 'foreign', jobIds: [first.jobId] }), false)
    registry.stop({ peerId: owner.locator.parentSessionId, userId: owner.userId,
      clientMessageId: owner.clientMessageId, captureCurrentTurn: true })
    assert.equal(first.signal.aborted, true)
    assert.equal(second.signal.aborted, true, 'current main Stop captures older live work')
    const later = registry.begin({ ...owner, clientMessageId: 'cmid-third',
      locator: { ...owner.locator, parentTurnKey: 'd'.repeat(64) } })
    registry.stop({ peerId: owner.locator.parentSessionId, userId: owner.userId,
      clientMessageId: owner.clientMessageId, captureCurrentTurn: true })
    assert.equal(later.signal.aborted, false)
  })

  it('a background-only control never reaches legacy session-wide interrupt, including with the flag off', async () => {
    const host: any = { sessions: { interrupt: () => { throw new Error('must not kill a new turn') } } }
    const applied = await handleStop.call(host, {
      type: 'inbound.control.stop', channel: 'webchat', peer: { id: 'background-session', kind: 'dm' },
      backgroundJobIds: ['dlgjob-unknown'], _userId: owner.userId,
    })
    assert.equal(applied, false)
  })
})

function fixture() {
  enable()
  const parent: any = { sessionKey: owner.sessionKey, channel: 'webchat', agentId: 'main', userId: owner.userId,
    peerId: owner.locator.parentSessionId, _currentTurnKey: owner.locator.parentTurnKey,
    _currentTurnTraceId: owner.traceId, _currentTurnIndex: 1, _runningClientMessageId: owner.clientMessageId,
    turns: 0, workspaceMode: 'legacy' }
  const cleanup = deferred<void>()
  const terminal = deferred<void>()
  const store = new DelegateJobStore({ sm: false, onTerminal: () => terminal.resolve() })
  const host: any = sandbox.trackGateway({
    _delegateJobs: store,
    sessions: { getByKey: (key: string) => key === parent.sessionKey ? parent : undefined },
    log: { warn() {}, info() {}, error() {} },
    getUserId: () => owner.userId,
    _forgetEvictedDelegateResumes() {},
    _resolveDelegateProgressTarget: () => ({ target: { sessionKey: parent.sessionKey, channel: 'webchat',
      peerId: parent.peerId, userId: parent.userId }, nested: false }),
    _resolveDelegateParent: () => ({ sessionKey: parent.sessionKey, repoSessionId: parent.peerId,
      workspaceMode: 'legacy', billingParentTurnKey: parent._currentTurnKey }),
    _ensureDelegateJobStore: () => store,
    _touchDelegateInflightSurface() {},
    _releasePreadmittedDelegateCapacity() {},
    _completeDelegateResumeClaim: async () => { await cleanup.promise },
    _queueSendToAgentCallback(input: any) { assert.equal(input.callbackOnComplete, undefined) },
    _settlePendingPermissionsForStop() {}, _interruptDelegationsForParent() {},
    _delegateResultToHttp: (result: any) => ({ httpStatus: result.httpStatus ?? 200,
      body: { output: result.output, error: result.message ?? result.error } }),
    sendJson: (res: any, status: number, body: unknown) => { res.status = status; res.body = body },
    sendError: (res: any, status: number, error: string) => { res.status = status; res.body = { error } },
  } as any)
  host._runDelegateTask = (input: any) => _runDelegateTask.call(host, input)
  host._runDelegateTaskCore = async (input: any) => {
    host.input = input
    await input.backgroundControl.wait(new Promise<void>(() => {}))
  }
  const token = issueDelegateContextToken({ agentId: 'main', sessionKey: owner.sessionKey, depth: 0, traceId: owner.traceId })
  const body = { async: true, resultDelivery: 'background', goal: 'independent delayed work', model: 'glm-5.2' }
  const req: any = Object.assign(new EventEmitter(), { method: 'POST', headers: { [DELEGATE_CONTEXT_HEADER]: token }, complete: true })
  host.readBody = async () => JSON.stringify(body)
  return { host, store, parent, cleanup, terminal, req, body }
}

describe('background HTTP admission and cleanup', { concurrency: 1 }, () => {
  it('returns immediately with callback none and only marks cancelled after cleanup', async () => {
    const f = fixture()
    const res: any = {}
    await handleDelegateTask.call(f.host, f.req, res, 'coding-assistant')
    assert.equal(res.body.resultDelivery, 'background')
    const jobId = res.body.jobId
    assert.equal(f.store.snapshotOf(jobId)?.callback, 'none')
    assert.deepEqual(f.store.adoptOrphanedStdoutWait(owner.sessionKey), [], 'fan-out completion cannot create a billed origin-inject turn')
    assert.equal(f.host.input.backgroundOwner.locator.parentTurnKey, owner.locator.parentTurnKey)
    f.parent._runningClientMessageId = 'cmid-new-conversation'
    f.parent._currentTurnKey = 'e'.repeat(64)
    backgroundDelegates(f.host).stop({ peerId: f.parent.peerId, userId: owner.userId, jobIds: [jobId] })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(f.store.snapshotOf(jobId)?.state, 'running', 'unknown cleanup must not claim terminal')
    f.cleanup.resolve()
    await f.terminal.promise
    assert.equal(f.store.snapshotOf(jobId)?.state, 'cancelled')
    assert.equal(f.store.snapshotOf(jobId)?.ownerLeaseUntil, undefined)
    assert.equal(f.parent._runningClientMessageId, 'cmid-new-conversation')
  })

  it('a stopped stale signed root caller cannot fall back to foreground model execution', async () => {
    const f = fixture()
    f.parent._runningClientMessageId = undefined
    const res: any = {}
    await handleDelegateTask.call(f.host, f.req, res, 'coding-assistant')
    assert.equal(res.status, 409)
    assert.equal(res.body.failure_class, 'cancelled')
    assert.equal(f.host.input, undefined)
    assert.equal(f.store.size(), 0)
    f.cleanup.resolve()
  })

  it('keeps a stopped background job running until the real master Grok lease release ACK', async () => {
    const f = fixture()
    const releaseAck = deferred<void>()
    const releaseReached = deferred<void>()
    const server = createServer((req, res) => {
      req.resume()
      res.setHeader('content-type', 'application/json')
      if (req.url?.endsWith('/mint')) {
        res.end(JSON.stringify({ baseUrl: 'http://relay.invalid/v1', routeToken: 'd'.repeat(64) }))
      } else if (req.url?.endsWith('/release')) {
        releaseReached.resolve()
        void releaseAck.promise.then(() => res.end(JSON.stringify({ ok: true })))
      } else res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    try {
      const acquired = await acquireDelegateGrokRoute({ modelId: 'grok-build',
        log: { warn() {} }, env: { OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${address.port}`,
          OPENCLAUDE_V3_CONTAINER_TOKEN: 'test-bearer' } })
      assert.ok(acquired.ok)
      f.cleanup.resolve()
      f.host._runDelegateTaskCore = async (input: any) => {
        try { await input.backgroundControl.wait(new Promise<void>(() => {})) }
        finally { await acquired.lease.release({ waitForAck: true }) }
      }
      const res: any = {}
      await handleDelegateTask.call(f.host, f.req, res, 'coding-assistant')
      const jobId = res.body.jobId
      assert.equal(res.body.resultDelivery, 'background')
      backgroundDelegates(f.host).stop({ peerId: f.parent.peerId, userId: owner.userId, jobIds: [jobId] })
      await releaseReached.promise
      assert.equal(f.store.snapshotOf(jobId)?.state, 'running', 'job terminal must wait for release ACK')
      releaseAck.resolve()
      await f.terminal.promise
      assert.equal(f.store.snapshotOf(jobId)?.state, 'cancelled')
      assert.equal(f.store.snapshotOf(jobId)?.ownerLeaseUntil, undefined)
    } finally {
      releaseAck.resolve()
      f.cleanup.resolve()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('Stop while submit is preparing a cold engine never submits after the late preparation receipt', async () => {
    const scope = new BackgroundDelegateScope(owner)
    const preparing = deferred<any>()
    const session: any = { sessionKey: 'agent:child:delegate:main:cold',
      _identityCreationOpts: { agent: { id: 'coding-assistant' } } }
    const host: any = { getOrCreate: () => preparing.promise,
      isRuntimeRecycleDraining: () => { throw new Error('cancelled preparation reached execution') } }
    const running = submit.call(host, session, 'work', () => {}, undefined, undefined,
      undefined, undefined, undefined, { cancellationSignal: scope.signal })
    scope.stop()
    preparing.resolve(session)
    await assert.rejects(running, /USER_CANCELLED/)
  })
})
