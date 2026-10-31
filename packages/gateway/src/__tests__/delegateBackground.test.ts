import { installDelegateSandbox } from './helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { backgroundDelegates, BackgroundDelegateScope, isDelegateBackgroundEffective, type BackgroundDelegateOwner } from '../delegateBackground.js'
import { issueDelegateContextToken, DELEGATE_CONTEXT_HEADER } from '../delegateContext.js'
import { DelegateJobStore, DELEGATE_LEASE_HEARTBEAT_MS, DELEGATE_LEASE_HEARTBEAT_MAX_BEATS, type DelegateJobStoreOptions } from '../delegateJobs.js'
import { openDelegateDurableDb } from '../delegateDurable.js'
import { handleDelegateTask, _runDelegateTask, _runDelegateTaskCore } from '../delegateRuntime.js'
import { deliver, handleStop } from '../wsConnection.js'
import { setV3MasterSinkSingleton } from '../v3MasterSink.js'
import { submit } from '../sessionSubmit.js'
import { acquireDelegateGrokRoute } from '../delegateGrokRoute.js'
import { OutboundRingBuffer } from '../outboundRing.js'
import { DelegateInflightSurfaceStore, handleInflightDelegatesRequest } from '../delegateInflightSurface.js'
import { _completeDelegateResumeClaim } from '../delegateSupervision.js'
import { retireKeepResume, startEvictionLoop } from '../sessionLifecycle.js'
import { SessionManager } from '../sessionManager.js'

const owner: BackgroundDelegateOwner = {
  sessionKey: 'agent:main:webchat:dm:background-session', clientMessageId: 'cmid-background-owner',
  userId: '765', traceId: 'a'.repeat(32),
  locator: { parentSessionId: 'background-session', parentTurnKey: 'b'.repeat(64), turnIndex: 1 },
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function enable(masterBaseUrl = 'http://master.invalid') {
  Object.assign(process.env, {
    OC_DELEGATE_BACKGROUND: '1', OC_SELFHOST_ENGINE_LOCAL_TURNS: '1', OC_RUNTIME_CHANNEL: 'v5',
    OPENCLAUDE_V3_MASTER_BASE_URL: masterBaseUrl, OPENCLAUDE_V3_CONTAINER_TOKEN: 'test-bearer',
    OC_USER_ID: owner.userId,
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

  it('real deliver wire and replay keep an exact background owner after T1 final and T2 admission', () => {
    enable()
    const ring = new OutboundRingBuffer()
    const wire: any[] = []
    const host: any = { _outboundRing: ring, _recordRingEvictions() {},
      clientsByPeer: new Map([[`${owner.userId}:webchat:${owner.locator.parentSessionId}`,
        new Set([{ send: (data: string) => wire.push(JSON.parse(data)) }])]]) }
    const registry = backgroundDelegates(host)
    const scope = registry.begin(owner)
    scope.jobId = 'dlgjob-owner'
    const leave = scope.enter('child')
    ring.beginActiveTurn(owner.sessionKey, owner.clientMessageId)
    const seed = ring.nextSeq(owner.sessionKey)
    ring.store(owner.sessionKey, seed, Date.now(), '{}')
    ring.endActiveTurn(owner.sessionKey, owner.clientMessageId)
    ring.beginActiveTurn(owner.sessionKey, 'cmid-T2')
    const progress = { kind: 'delegate_progress', phase: 'text', runId: 'run-owner',
      agentId: 'coding-assistant', jobId: scope.jobId, background: true, text: 'T1 progress' }
    const send = (blocks: any[], extra: object = {}) => deliver.call(host, {
      type: 'outbound.message', sessionKey: owner.sessionKey, channel: 'webchat',
      peer: { id: owner.locator.parentSessionId, kind: 'dm' }, clientMessageId: owner.clientMessageId,
      blocks, isFinal: false, _userId: owner.userId, ...extra,
    } as never)
    send([progress])
    assert.equal(wire.at(-1).clientMessageId, owner.clientMessageId)
    const replay = ring.peekReplay(owner.sessionKey, seed)
    assert.ok(replay.ok)
    assert.equal(JSON.parse(replay.sent.at(-1)!.data).clientMessageId, owner.clientMessageId)
    send([progress, { kind: 'text', text: 'mixed frame' }])
    assert.equal(wire.at(-1).clientMessageId, 'cmid-T2', 'mixed content retains the terminal fence')
    send([{ ...progress, background: undefined }])
    assert.equal(wire.at(-1).clientMessageId, 'cmid-T2', 'legacy progress retains the terminal fence')
    send([{ ...progress, jobId: 'dlgjob-foreign' }])
    assert.equal(wire.at(-1).clientMessageId, 'cmid-T2', 'unowned lookalikes cannot bypass the fence')
    send([progress], { isFinal: true })
    assert.equal(wire.at(-1).clientMessageId, 'cmid-T2', 'a final frame is not a background sideband')
    leave()
    registry.finish(scope)
    send([{ ...progress, phase: 'done' }])
    assert.equal(wire.at(-1).clientMessageId, owner.clientMessageId, 'post-cleanup publication retains its retired owner')
    assert.equal(scope.signal.aborted, false, 'normal retirement must not masquerade as user cancellation')
  })
})

function fixture(masterBaseUrl: string, storeOptions: DelegateJobStoreOptions = {}) {
  enable(masterBaseUrl)
  if (storeOptions.sm) process.env.OC_DELEGATE_SM = '1'
  if (storeOptions.durable) process.env.OC_DELEGATE_DURABLE = '1'
  const parent: any = { sessionKey: owner.sessionKey, channel: 'webchat', agentId: 'main', userId: owner.userId,
    peerId: owner.locator.parentSessionId, _currentTurnKey: owner.locator.parentTurnKey,
    _currentTurnTraceId: owner.traceId, _currentTurnIndex: 1, _runningClientMessageId: owner.clientMessageId,
    turns: 0, workspaceMode: 'legacy' }
  const cleanup = deferred<void>()
  const terminal = deferred<void>()
  let projectTerminal: ((job: any) => void) | undefined
  let host: any
  const store = new DelegateJobStore({ sm: false, ...storeOptions,
    canCommitTerminal: job => !backgroundDelegates(host).ownsActiveJob(job.id),
    onTerminal: job => { projectTerminal?.(job); terminal.resolve() } })
  host = sandbox.trackGateway({
    _delegateJobs: store,
    _delegateReconcileReady: true,
    _admitDelegateCreate: () => 'slot',
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
  return { host, store, parent, cleanup, terminal, req, body,
    setTerminalProjection: (project: (job: any) => void) => { projectTerminal = project } }
}

function lifecycleFixture(session: any) {
  let destroyed = 0
  return { sessions: new Map([[session.sessionKey, session]]),
    _sessionIdToKey: new Map([[session.peerId, session.sessionKey]]),
    _resumeMap: new Map([[session.sessionKey, 'native-resume']]),
    _resumeMapTimestamps: new Map(), _resumeMapLastCost: new Map(),
    _resumeMapCostImprecise: new Map(), _resumeMapProvider: new Map(), _resumeMapHistory: new Map(),
    _saveResumeMap() {}, _pruneResumeMap() {}, markPlannedServiceRestart(s: any) { s._plannedTeardown = 'service_restart' },
    _flushTailFolding: async () => {}, onSessionDestroyed() { destroyed++ },
    maxIdleMsCron: 1, maxIdleMsChat: 1,
    destroyed: () => destroyed,
  }
}

describe('strict background session cleanup', { concurrency: 1 }, () => {
  it('the terminal fence covers preparing roots and releases a cleaned nested job independently of its live siblings', () => {
    const host = {}
    const registry = backgroundDelegates(host)
    const store = new DelegateJobStore({ sm: true,
      canCommitTerminal: job => !registry.ownsActiveJob(job.id) })
    try {
      const root = store.create('coding-assistant', { sessionKey: 'root-job' })
      const child = store.create('coding-assistant', { sessionKey: 'nested-job' })
      assert.ok('jobId' in root && 'jobId' in child)
      const scope = registry.begin(owner)
      scope.jobId = root.jobId
      registry.beginJob(scope, root.jobId)
      registry.beginJob(scope, child.jobId)
      const finish = (jobId: string) => {
        const snap = store.snapshotOf(jobId)!
        return store.complete(jobId, { httpStatus: 200, body: { output: 'paid' } },
          { claimToken: snap.claimToken!, fencingEpoch: snap.fencingEpoch })
      }
      assert.equal(finish(root.jobId), false, 'a preparing root has no member yet and still owns its barrier')
      assert.equal(store.snapshotOf(root.jobId)?.result, null)
      const leaveRoot = scope.enter('root-job')
      assert.equal(finish(child.jobId), false, 'a nested preparing job has its own barrier before any member exists')
      const leaveChild = scope.enter('nested-job', 'root-job')
      const leaveSibling = scope.enter('sibling-job', 'root-job')
      assert.equal(finish(child.jobId), false)
      leaveChild()
      registry.endJob(scope, child.jobId)
      assert.equal(finish(child.jobId), true, 'the nested job may finish after its own cleanup while root/sibling remain live')
      assert.equal(finish(root.jobId), false)
      leaveSibling()
      leaveRoot()
      assert.equal(finish(root.jobId), false, 'the root scope itself still owns final cleanup')
      registry.endJob(scope, root.jobId)
      assert.equal(finish(root.jobId), true)
      registry.finish(scope)
    } finally { store.close() }
  })

  it('preserves legacy retirement failure semantics without strict cleanup', async () => {
    const session = { sessionKey: 'legacy-retire', peerId: 'legacy-peer', userId: owner.userId,
      executionTarget: { kind: 'remote', hostId: 'fake-host' },
      runner: { shutdown: async () => { throw new Error('legacy shutdown failure') } } }
    const host: any = lifecycleFixture(session)
    host._remoteTargetController = { releaseMux: async () => { throw new Error('legacy release failure') } }
    await retireKeepResume.call(host, session.sessionKey)
    assert.equal(host.sessions.has(session.sessionKey), false)
    assert.equal(host._resumeMap.has(session.sessionKey), true)
    assert.equal(host.destroyed(), 1)
  })

  it('never substitutes a best-effort remote release for a strict ACK', async () => {
    for (const missing of ['controller', 'confirmed', 'user']) {
      const session = { sessionKey: `strict-missing-${missing}`, peerId: `peer-${missing}`,
        userId: missing === 'user' ? undefined : owner.userId,
        executionTarget: { kind: 'remote', hostId: 'fake-host' },
        runner: { shutdown: async () => {}, waitForOutputDrain: async () => {} } }
      const host: any = lifecycleFixture(session)
      if (missing !== 'controller') host._remoteTargetController = {
        releaseMux: async () => assert.fail('strict cleanup cannot use legacy releaseMux'),
        ...(missing === 'user' ? { releaseMuxConfirmed: async () => assert.fail('missing owner cannot release a mux') } : {}),
      }
      await assert.rejects(retireKeepResume.call(host, session.sessionKey, { strictCleanup: true }), /release ACK controller/)
      assert.equal(host.sessions.get(session.sessionKey), session)
      assert.equal(host._sessionIdToKey.get(session.peerId), session.sessionKey)
      assert.equal(host.destroyed(), 0)
    }
  })

  it('an eviction already awaiting shutdown cannot discard a later strict retirement', { timeout: 5_000 }, async t => {
    const evictionEntered = deferred<void>()
    const evictionAck = deferred<void>()
    const strictEntered = deferred<void>()
    const strictAck = deferred<void>()
    let shutdowns = 0
    const session = { sessionKey: 'agent:child:delegate:main:strict-lru', peerId: 'strict-lru-peer',
      lastUsedAt: 0, executionTarget: { kind: 'local' },
      runner: { lastActivityAt: 0, waitForOutputDrain: async () => {}, shutdown: async () => {
        if (++shutdowns === 1) { evictionEntered.resolve(); await evictionAck.promise }
        else { strictEntered.resolve(); await strictAck.promise }
      } } }
    const host: any = lifecycleFixture(session)
    const stopEviction = startEvictionLoop.call(host, 1)
    t.after(() => { stopEviction(); evictionAck.resolve(); strictAck.resolve() })
    await evictionEntered.promise
    const retiring = retireKeepResume.call(host, session.sessionKey, { strictCleanup: true })
    await strictEntered.promise
    evictionAck.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(host.sessions.get(session.sessionKey), session)
    assert.equal(host.destroyed(), 0)
    strictAck.resolve()
    await retiring
    assert.equal(host.sessions.has(session.sessionKey), false)
    assert.equal(host.destroyed(), 1)
  })
})

describe('background HTTP admission and cleanup', { concurrency: 1 }, () => {
  let authority: ReturnType<typeof createServer>
  let authorityBaseUrl: string
  beforeEach(async () => {
    authority = createServer((req, res) => {
      req.resume()
      res.setHeader('content-type', 'application/json')
      if (req.url !== '/internal/v3/marketplace/sync') {
        res.writeHead(404).end('{}')
      } else if (req.headers.authorization !== 'Bearer test-bearer') {
        res.writeHead(401).end('{}')
      } else {
        // Exercise the real authenticated authority fetch and parser, including
        // the numeric container owner required by identityCompat validation.
        res.end(JSON.stringify({ identityCompat: { schema: 1, userId: owner.userId, profiles: [] } }))
      }
    })
    await new Promise<void>(resolve => authority.listen(0, '127.0.0.1', resolve))
    const address = authority.address()
    assert.ok(address && typeof address !== 'string')
    authorityBaseUrl = `http://127.0.0.1:${address.port}`
  })
  afterEach(async () => {
    authority.closeAllConnections()
    await new Promise<void>((resolve, reject) => authority.close(error => error ? reject(error) : resolve()))
  })
  for (const cleanupMode of ['completed', 'cancelled', 'shutdown-retry', 'remote-release-retry', 'drain-ack', 'durable-heartbeat', 'durable-model-cap']) {
    const stopDuringRetire = cleanupMode !== 'completed'
    it(`real core keeps GET inflight and Stop live through blocked retire (${cleanupMode})`, { timeout: 15_000 }, async t => {
      let jobNow = Date.now()
      const durableModelCap = cleanupMode === 'durable-model-cap'
      const durableHeartbeat = cleanupMode === 'durable-heartbeat' || durableModelCap
      const f = fixture(authorityBaseUrl, durableHeartbeat
        ? { sm: true, durable: openDelegateDurableDb(), now: () => jobNow } : {})
      let heartbeat: (() => void) | undefined
      let heartbeatCleared = false
      if (durableHeartbeat) {
        const setIntervalOriginal = globalThis.setInterval
        const clearIntervalOriginal = globalThis.clearInterval
        const heartbeatTimer = { unref() {} }
        t.mock.method(globalThis, 'setInterval', ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
          if (ms === DELEGATE_LEASE_HEARTBEAT_MS) { heartbeat = () => callback(...args); return heartbeatTimer }
          return setIntervalOriginal(callback, ms, ...args)
        }) as typeof globalThis.setInterval)
        t.mock.method(globalThis, 'clearInterval', ((timer: any) => {
          if (timer === heartbeatTimer) heartbeatCleared = true
          else clearIntervalOriginal(timer)
        }) as typeof globalThis.clearInterval)
      }
      const surface = new DelegateInflightSurfaceStore({ dbPath: null })
      const retiring = deferred<void>()
      const releaseRetire = deferred<void>()
      const children = new Map<string, any>()
      const groups: any[] = []
      const progress: any[] = []
      const submitted = deferred<void>()
      const finishSubmit = deferred<void>()
      let interrupts = 0
      let shutdownCalls = 0
      let releaseCalls = 0
      let destroyed = 0
      const waitForAck = async () => { retiring.resolve(); await releaseRetire.promise }
      const lifecycleHost: any = { sessions: children, _sessionIdToKey: new Map(),
        markPlannedServiceRestart(session: any) { session._plannedTeardown = 'service_restart' },
        _flushTailFolding: async () => {}, onSessionDestroyed() { destroyed++ },
        _remoteTargetController: {
          releaseMux: async () => { throw new Error('strict cleanup used legacy best-effort release') },
          releaseMuxConfirmed: async () => {
            if (++releaseCalls === 1) throw new Error('remote release ACK unavailable')
            await waitForAck()
          },
        } }
      f.host.deps = { config: { version: 1, defaults: { model: 'glm-5.2' },
        gateway: { bind: '127.0.0.1', port: 0 }, auth: { mode: 'subscription' } } }
      f.host._mapLocalExecutionError = () => undefined
      f.host._getAgentsConfig = async () => ({ agents: [{ id: 'coding-assistant', model: 'glm-5.2', provider: 'anthropic' }] })
      f.host._memberDelegateGuard = { tryAcquire: () => true, resetForParent() {} }
      f.host._hiddenDelegateGuard = { resetForParent() {} }
      f.host._activeDelegationsByParent = new Map()
      f.host._registerActiveDelegation = () => () => {}
      f.host._waitForDelegateCapacity = async () => ({ status: 'ok' })
      f.host._releaseDelegateSlot = () => {}
      f.host._runLog = { start: () => ({}), complete() {} }
      f.host._ensureDelegateInflightSurface = () => surface
      f.host._touchDelegateInflightSurface = (input: any) => surface.upsertEnqueue({ ...input,
        fencingEpoch: f.store.snapshotOf(input.jobId)?.fencingEpoch ?? 0,
        generation: f.store.snapshotOf(input.jobId)?.generation ?? 0 })
      f.host.deliver = (out: any) => progress.push(out)
      f.host.sessions.getByKey = (key: string) => key === f.parent.sessionKey ? f.parent : children.get(key)
      f.host.sessions.getOrCreate = async (opts: any) => {
        const child = { ...opts, agentId: opts.agent.id, model: 'glm-5.2', providerTag: 'ccb', turns: 1,
          userId: owner.userId, executionTarget: cleanupMode === 'remote-release-retry'
            ? { kind: 'remote', hostId: 'fake-host' } : { kind: 'local' },
          totalCostUSD: 0.1, totalInputTokens: 1, totalOutputTokens: 2,
          runner: { model: 'glm-5.2', engineId: 'ccb', on() {}, off() {},
            shutdown: async () => {
              shutdownCalls++
              if (cleanupMode === 'shutdown-retry' && shutdownCalls === 1) throw new Error('shutdown ACK unavailable')
              if (cleanupMode !== 'remote-release-retry' && cleanupMode !== 'drain-ack') await waitForAck()
            },
            waitForOutputDrain: async () => { if (cleanupMode === 'drain-ack') await waitForAck() },
          } }
        children.set(opts.sessionKey, child)
        lifecycleHost._sessionIdToKey.set(child.peerId, opts.sessionKey)
        return child
      }
      f.host.sessions.submit = async (_session: any, _prompt: string, onEvent: (event: any) => void) => {
        onEvent({ kind: 'block', block: { kind: 'text', text: 'paid result' } })
        if (durableModelCap) { submitted.resolve(); await finishSubmit.promise }
        onEvent({ kind: 'final', meta: { inputTokens: 1, outputTokens: 2 } })
      }
      f.host.sessions.flushSessionTailFolding = async () => {}
      f.host.sessions.bufferPendingAgentGroup = (_key: string, group: any) => { groups.push(group); return true }
      f.host.sessions.retireKeepResume = (key: string, options: any) => {
        assert.equal(options?.strictCleanup, true)
        return retireKeepResume.call(lifecycleHost, key, options)
      }
      f.host.sessions.hasLiveSession = (key: string) => children.has(key)
      f.host.sessions.interrupt = () => { interrupts++; if (durableModelCap) finishSubmit.resolve(); return true }
      f.host._completeDelegateResumeClaim = (input: any, spawned: boolean) => _completeDelegateResumeClaim.call(f.host, input, spawned)
      f.host._runDelegateTaskCore = (input: any, hooks: any) => {
        f.host.input = input
        input.traceId = 'f'.repeat(32)
        return _runDelegateTaskCore.call(f.host, input, hooks)
      }
      f.setTerminalProjection(job => surface.projectJob(job))
      Object.assign(f.body, { streamProgress: true })
      const read = () => handleInflightDelegatesRequest({ method: 'GET',
        sessionId: owner.locator.parentSessionId, userId: owner.userId, enabled: true,
        loadSession: async () => ({}), store: surface, overlayJobs: () => f.store.listNonTerminal(),
        resolveJob: jobId => f.store.snapshotOf(jobId) })
      let abortWait!: () => void
      const aborted = new Promise<never>((_, reject) => {
        abortWait = () => reject(new Error('real core fixture timed out while waiting for admission or cleanup'))
        t.signal.addEventListener('abort', abortWait, { once: true })
      })
      try {
        const res: any = {}
        await Promise.race([handleDelegateTask.call(f.host, f.req, res, 'coding-assistant'), aborted])
        assert.equal(res.body.resultDelivery, 'background')
        const jobId = res.body.jobId
        if (durableModelCap) {
          await Promise.race([submitted.promise, aborted])
          assert.equal(f.host.input._backgroundCleanupPending, undefined)
          assert.ok(heartbeat)
          for (let beat = 0; beat <= DELEGATE_LEASE_HEARTBEAT_MAX_BEATS; beat++) {
            jobNow += DELEGATE_LEASE_HEARTBEAT_MS
            heartbeat()
          }
          assert.equal(interrupts, 1, 'the model runtime cap still interrupts at the 481st beat')
          assert.equal(heartbeatCleared, false, 'a runtime cap cannot destroy the subsequent cleanup lease')
        }
        await Promise.race([retiring.promise, aborted, f.terminal.promise.then(() => {
          assert.fail(`delegate reached terminal before retire: ${JSON.stringify(f.store.snapshotOf(jobId))}`)
        })])
        const childKey = res.body.sessionKey
        assert.equal(children.has(childKey), true, 'a pending cleanup ACK retains the live session')
        assert.equal(f.host._delegateResume.isReserved(childKey), true, 'cleanup retains exact resume occupancy')
        assert.equal(backgroundDelegates(f.host).scopes.has(f.host.input.backgroundControl), true)
        assert.equal(destroyed, 0, 'unknown cleanup must not notify session destruction')
        if (cleanupMode === 'shutdown-retry') assert.equal(shutdownCalls, 2)
        if (cleanupMode === 'remote-release-retry') assert.equal(releaseCalls, 2)
        if (durableHeartbeat) {
          assert.equal(f.host.input._backgroundCleanupPending, true)
          assert.equal(heartbeatCleared, false, 'retirement must retain the owner heartbeat')
          assert.ok(heartbeat)
          for (let beat = 0; beat <= DELEGATE_LEASE_HEARTBEAT_MAX_BEATS; beat++) {
            jobNow += DELEGATE_LEASE_HEARTBEAT_MS
            heartbeat()
          }
          assert.equal(heartbeatCleared, false, 'the model execution cap cannot cut off unknown cleanup')
          assert.ok(f.store.snapshotOf(jobId)!.ownerLeaseUntil! > jobNow)
          jobNow += 31 * 60_000
          assert.deepEqual(f.store.reapStaleRunning({ timeoutMs: 30 * 60_000, now: jobNow }), [])
          assert.equal(f.store.adoptOrKill(jobId, f.store.snapshotOf(jobId)!.fencingEpoch, 'killed_by_cutover'), undefined)
          const fence = f.store.snapshotOf(jobId)!
          assert.equal(f.store.pauseForCutover(jobId, { claimToken: fence.claimToken!, fencingEpoch: fence.fencingEpoch,
            generation: 1, checkpointKind: 'none' }), undefined, 'cutover cannot rotate away a cleanup owner fence')
          assert.equal(f.store.snapshotOf(jobId)?.state, 'running', 'reaper/reconciler cannot write terminal before cleanup ACK')
          assert.equal(f.store.snapshotOf(jobId)?.result, null)
          heartbeat()
        }
        const before = await read()
        assert.equal((before.body.items as any[]).find(item => item.jobId === jobId)?.state, 'running')
        assert.equal(groups.length, 0, 'a model result card cannot seal the running cleanup job')
        assert.equal(progress.some(out => out.blocks?.some((block: any) => ['done', 'error'].includes(block.phase))), false)
        if (stopDuringRetire) {
          assert.equal(await handleStop.call(f.host, { type: 'inbound.control.stop', channel: 'webchat',
            peer: { id: f.parent.peerId, kind: 'dm' }, backgroundJobIds: [jobId], _userId: owner.userId }), true)
          assert.equal(((await read()).body.items as any[]).find(item => item.jobId === jobId)?.state, 'running')
        }
        releaseRetire.resolve()
        await Promise.race([f.terminal.promise, aborted])
        const after = await read()
        const completed = (after.body.items as any[]).find(item => item.jobId === jobId)
        assert.equal(children.has(childKey), false)
        assert.equal(f.host._delegateResume.isReserved(childKey), false)
        assert.equal(backgroundDelegates(f.host).scopes.has(f.host.input.backgroundControl), false)
        assert.equal(destroyed, 1)
        if (durableHeartbeat) assert.equal(heartbeatCleared, true, 'terminal CAS retires the heartbeat')
        assert.equal(completed?.state, stopDuringRetire ? 'cancelled' : 'completed')
        assert.equal(completed?.foldedGroup?.transcript?.some((block: any) => block.text === 'paid result'), true)
        assert.equal(groups[0]?.jobId, jobId)
        assert.equal(progress.some(out => out.blocks?.some((block: any) => ['done', 'error'].includes(block.phase))), true)
      } finally {
        t.signal.removeEventListener('abort', abortWait)
        releaseRetire.resolve()
        finishSubmit.resolve()
        f.cleanup.resolve()
        surface.close()
      }
    })
  }

  it('a stopped late session receipt retains its job and scope until strict destroy receives a remote ACK', { timeout: 10_000 }, async t => {
    const f = fixture(authorityBaseUrl)
    const receipt = deferred<any>()
    const preparing = deferred<void>()
    const releaseEntered = deferred<void>()
    const releaseAck = deferred<void>()
    const child = { sessionKey: 'agent:child:delegate:main:late-cleanup', peerId: 'late-cleanup-peer',
      userId: owner.userId, executionTarget: { kind: 'remote', hostId: 'fake-host' },
      runner: { shutdown: async () => {}, waitForOutputDrain: async () => {} } }
    const lifecycleHost: any = lifecycleFixture(child)
    lifecycleHost.sessions.clear()
    let releaseCalls = 0
    let receiptDelivered = false
    lifecycleHost._remoteTargetController = {
      releaseMux: async () => assert.fail('background destroy used legacy release'),
      releaseMuxConfirmed: async () => {
        if (++releaseCalls === 1) throw new Error('late mux release unavailable')
        releaseEntered.resolve()
        await releaseAck.promise
      },
    }
    f.cleanup.resolve()
    f.host._completeDelegateResumeClaim = (input: any, spawned: boolean) => _completeDelegateResumeClaim.call(f.host, input, spawned)
    f.host._runDelegateTaskCore = async (input: any) => {
      f.host.input = input
      child.sessionKey = input.sessionKey
      lifecycleHost._resumeMap.clear()
      lifecycleHost._resumeMap.set(child.sessionKey, 'native-resume')
      lifecycleHost._sessionIdToKey.set(child.peerId, child.sessionKey)
      preparing.resolve()
      await input.backgroundControl.wait(receipt.promise, () =>
        SessionManager.prototype.destroySession.call(lifecycleHost, child.sessionKey, { strictCleanup: true }))
    }
    t.after(() => {
      releaseAck.resolve()
      if (!receiptDelivered) { lifecycleHost.sessions.set(child.sessionKey, child); receipt.resolve(child) }
    })
    const res: any = {}
    await handleDelegateTask.call(f.host, f.req, res, 'coding-assistant')
    await preparing.promise
    const jobId = res.body.jobId
    assert.equal(await handleStop.call(f.host, { type: 'inbound.control.stop', channel: 'webchat',
      peer: { id: f.parent.peerId, kind: 'dm' }, backgroundJobIds: [jobId], _userId: owner.userId }), true)
    lifecycleHost.sessions.set(child.sessionKey, child)
    receiptDelivered = true
    receipt.resolve(child)
    await Promise.race([releaseEntered.promise, f.terminal.promise.then(() => {
      assert.fail(`late cleanup terminated before release ACK: ${JSON.stringify(f.store.snapshotOf(jobId))}`)
    })])
    assert.equal(releaseCalls, 2)
    assert.equal(lifecycleHost.sessions.get(child.sessionKey), child)
    assert.equal(lifecycleHost.destroyed(), 0)
    assert.equal(f.store.snapshotOf(jobId)?.state, 'running')
    assert.equal(f.host._delegateResume.isReserved(res.body.sessionKey), true)
    assert.equal(backgroundDelegates(f.host).scopes.has(f.host.input.backgroundControl), true)
    releaseAck.resolve()
    await f.terminal.promise
    assert.equal(f.store.snapshotOf(jobId)?.state, 'cancelled')
    assert.equal(f.host._delegateResume.isReserved(res.body.sessionKey), false)
    assert.equal(lifecycleHost.sessions.has(child.sessionKey), false)
    assert.equal(lifecycleHost._resumeMap.has(child.sessionKey), false)
    assert.equal(lifecycleHost.destroyed(), 1)
    assert.equal(backgroundDelegates(f.host).scopes.has(f.host.input.backgroundControl), false)
  })

  it('a valid remote parent retains the legacy wait contract instead of negotiating an unsupported background ACK', async () => {
    const f = fixture(authorityBaseUrl)
    f.parent.executionTarget = { kind: 'remote', hostId: 'configured-old-controller' }
    f.cleanup.resolve()
    f.host._runDelegateTaskCore = async (input: any) => {
      f.host.input = input
      return { kind: 'completed', ok: true, output: 'legacy remote result' }
    }
    const run = f.host._runDelegateTask
    let running: Promise<unknown> | undefined
    f.host._runDelegateTask = (input: any) => { running = run(input); return running }
    const res: any = {}
    await handleDelegateTask.call(f.host, f.req, res, 'coding-assistant')
    assert.equal(res.status, 200)
    assert.equal(res.body.resultDelivery, undefined)
    assert.equal(f.store.snapshotOf(res.body.jobId)?.callback, 'stdout-wait')
    assert.equal(f.host.input.backgroundControl, undefined)
    assert.equal(backgroundDelegates(f.host).scopes.size, 0)
    await running
  })

  it('a stopped nested async caller releases its preparing permit when enter rejects after late callback-intent ACK', { timeout: 10_000 }, async t => {
    const f = fixture(authorityBaseUrl)
    const registry = backgroundDelegates(f.host)
    const scope = registry.begin(owner)
    scope.jobId = 'dlgjob-held-root'
    const rootKey = 'agent:coding-assistant:delegate:main:held-root'
    const traceId = 'f'.repeat(32)
    const leaveRoot = scope.enter(rootKey)
    scope.bindTrace(rootKey, traceId)
    const intentReached = deferred<void>()
    const intentAck = deferred<void>()
    f.cleanup.resolve()
    f.host.sessions.getByKey = (key: string) => key === rootKey
      ? { sessionKey: rootKey, agentId: 'coding-assistant', channel: 'delegate' }
      : key === owner.sessionKey ? f.parent : undefined
    f.host._completeDelegateResumeClaim = (input: any, spawned: boolean) => _completeDelegateResumeClaim.call(f.host, input, spawned)
    f.host._runDelegateTaskCore = async () => assert.fail('a stopped preparing caller must fail before entering core')
    f.host._persistSendToAgentIntent = async () => { intentReached.resolve(); await intentAck.promise }
    f.host._activeSendToAgentCallbacks = new Map()
    f.host._queueSendToAgentCallback = () => {}
    f.req.headers[DELEGATE_CONTEXT_HEADER] = issueDelegateContextToken({
      agentId: 'coding-assistant', sessionKey: rootKey, depth: 1, traceId,
    })
    Object.assign(f.body, { callbackOnComplete: 'origin-inject' })
    const res: any = {}
    const handling = handleDelegateTask.call(f.host, f.req, res, 'data-analyst')
    t.after(async () => { intentAck.resolve(); scope.stop(); await handling; leaveRoot(); registry.finish(scope) })
    await intentReached.promise
    const pending = f.store.listNonTerminal()[0]!
    assert.equal(scope.members.has(pending.sessionKey!), false, 'the callback-intent await precedes control.enter')
    assert.equal(registry.ownsActiveJob(pending.id), true)
    scope.stop()
    intentAck.resolve()
    await handling
    await f.terminal.promise
    assert.equal(f.store.snapshotOf(pending.id)?.state, 'cancelled')
    assert.equal(f.host._delegateResume.isReserved(pending.sessionKey), false)
    assert.equal(registry.ownsActiveJob(pending.id), false)
    assert.equal(registry.scopes.has(scope), true, 'a child permit must not retire its still-owned root scope')
    assert.equal(scope.members.get(rootKey)?.active, true)
  })

  it('returns immediately with callback none and only marks cancelled after cleanup', async () => {
    const f = fixture(authorityBaseUrl)
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
    const f = fixture(authorityBaseUrl)
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
    const f = fixture(authorityBaseUrl)
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
