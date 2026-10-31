import { installDelegateSandbox } from './helpers/delegateSandbox.js'
const sandbox = installDelegateSandbox()
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { backgroundDelegates, BackgroundDelegateScope, isDelegateBackgroundEffective, type BackgroundDelegateOwner } from '../delegateBackground.js'
import { issueDelegateContextToken, DELEGATE_CONTEXT_HEADER } from '../delegateContext.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { handleDelegateTask, _runDelegateTask, _runDelegateTaskCore } from '../delegateRuntime.js'
import { deliver, handleStop } from '../wsConnection.js'
import { setV3MasterSinkSingleton } from '../v3MasterSink.js'
import { submit } from '../sessionSubmit.js'
import { acquireDelegateGrokRoute } from '../delegateGrokRoute.js'
import { OutboundRingBuffer } from '../outboundRing.js'
import { DelegateInflightSurfaceStore, handleInflightDelegatesRequest } from '../delegateInflightSurface.js'
import { _completeDelegateResumeClaim } from '../delegateSupervision.js'

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

function fixture(masterBaseUrl: string) {
  enable(masterBaseUrl)
  const parent: any = { sessionKey: owner.sessionKey, channel: 'webchat', agentId: 'main', userId: owner.userId,
    peerId: owner.locator.parentSessionId, _currentTurnKey: owner.locator.parentTurnKey,
    _currentTurnTraceId: owner.traceId, _currentTurnIndex: 1, _runningClientMessageId: owner.clientMessageId,
    turns: 0, workspaceMode: 'legacy' }
  const cleanup = deferred<void>()
  const terminal = deferred<void>()
  let projectTerminal: ((job: any) => void) | undefined
  const store = new DelegateJobStore({ sm: false, onTerminal: job => { projectTerminal?.(job); terminal.resolve() } })
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
  return { host, store, parent, cleanup, terminal, req, body,
    setTerminalProjection: (project: (job: any) => void) => { projectTerminal = project } }
}

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
  for (const stopDuringRetire of [false, true]) {
    it(`real core keeps GET inflight and Stop live through blocked retire (${stopDuringRetire ? 'cancelled' : 'completed'})`, { timeout: 15_000 }, async t => {
      const f = fixture(authorityBaseUrl)
      const surface = new DelegateInflightSurfaceStore({ dbPath: null })
      const retiring = deferred<void>()
      const releaseRetire = deferred<void>()
      const children = new Map<string, any>()
      const groups: any[] = []
      const progress: any[] = []
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
          totalCostUSD: 0.1, totalInputTokens: 1, totalOutputTokens: 2,
          runner: { model: 'glm-5.2', engineId: 'ccb', on() {}, off() {} } }
        children.set(opts.sessionKey, child)
        return child
      }
      f.host.sessions.submit = async (_session: any, _prompt: string, onEvent: (event: any) => void) => {
        onEvent({ kind: 'block', block: { kind: 'text', text: 'paid result' } })
        onEvent({ kind: 'final', meta: { inputTokens: 1, outputTokens: 2 } })
      }
      f.host.sessions.flushSessionTailFolding = async () => {}
      f.host.sessions.bufferPendingAgentGroup = (_key: string, group: any) => { groups.push(group); return true }
      f.host.sessions.retireKeepResume = async (key: string) => {
        retiring.resolve()
        await releaseRetire.promise
        children.delete(key)
      }
      f.host.sessions.hasLiveSession = (key: string) => children.has(key)
      f.host.sessions.interrupt = () => true
      f.host._completeDelegateResumeClaim = (input: any, spawned: boolean) => _completeDelegateResumeClaim.call(f.host, input, spawned)
      f.host._runDelegateTaskCore = (input: any, hooks: any) => {
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
        await Promise.race([retiring.promise, aborted, f.terminal.promise.then(() => {
          assert.fail(`delegate reached terminal before retire: ${JSON.stringify(f.store.snapshotOf(jobId))}`)
        })])
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
        assert.equal(completed?.state, stopDuringRetire ? 'cancelled' : 'completed')
        assert.equal(completed?.foldedGroup?.transcript?.some((block: any) => block.text === 'paid result'), true)
        assert.equal(groups[0]?.jobId, jobId)
        assert.equal(progress.some(out => out.blocks?.some((block: any) => ['done', 'error'].includes(block.phase))), true)
      } finally {
        t.signal.removeEventListener('abort', abortWait)
        releaseRetire.resolve()
        f.cleanup.resolve()
        surface.close()
      }
    })
  }

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
