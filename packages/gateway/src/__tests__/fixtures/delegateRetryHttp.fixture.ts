/** Real HTTP -> SQL/source/action -> original executor -> actual manager/adapter
 * and stdio RPC. Source/native seed, app-server enrollment and billing are private
 * fixtures; no real user/paid model, master ACK or boot scheduling claim. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { createServer, request } from 'node:http'
import Database from 'better-sqlite3'
import { Gateway } from '../../server.js'
import { SessionManager } from '../../sessionManager.js'
import { DelegateDurableDb } from '../../delegateDurable.js'
import { DelegateJobStore } from '../../delegateJobs.js'
import { DelegateResumeRegistry } from '../../delegateResume.js'
import { signJwt } from '../../auth.js'
import { upsertClientSession, deleteClientSession } from '../../../../storage/src/sessionsDb.js'
import { paths, type OpenClaudeConfig, type AgentDef } from '@openclaude/storage'

async function main() {
  const mode = process.argv[2]!, home = process.env.OPENCLAUDE_HOME!, codexHome = process.env.CODEX_HOME!
  assert.ok(home.includes('retry-http-private-')); assert.equal(process.env.HOME, home)
  const token = 'private-retry-user-token', userId = 'c:7', peer = 'web-private-retry'
  const parentKey = 'agent:main:webchat:dm:' + peer, childKey = 'agent:worker:delegate:main:1:private-retry'
  const nativeId = '8aef3dc0-cd8b-4fe5-9743-af842e17b605'
  const config = { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: token },
    auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(home, 'sessions.db') },
    defaults: { model: 'gpt-6-astra', permissionMode: 'default' }, channels: { webchat: { enabled: true } } } as unknown as OpenClaudeConfig
  const agents = ['main', 'worker'].map(id => ({ id, model: 'gpt-6-astra', provider: 'codex-native', cwd: home } as AgentDef))
  writeFileSync(paths.agentsYaml, JSON.stringify({ agents, routes: [], default: 'main' }))
  const gw: any = new Gateway({ config, agentsConfig: { agents, routes: [], default: 'main' } })
  const sm = new SessionManager(config), ins: any = sm
  gw.sessions = sm
  gw._delegateReconcileReady = true; gw._readDelegateMemoryPressure = () => null
  await upsertClientSession({ id: peer, userId, agentId: 'main', modelId: 'gpt-6-astra', title: 'private retry', pinned: false,
    createdAt: 1000, lastAt: 1000, updatedAt: 1000, messages: [] })
  await sm.getOrCreate({ sessionKey: parentKey, agent: agents[0]!, model: 'gpt-6-astra',
    channel: 'webchat', peerId: peer, userId, hermeticNoTools: true })
  const artifactDir = join(codexHome, 'sessions', '2026', '01', '01'); mkdirSync(artifactDir, { recursive: true })
  const artifact = join(artifactDir, `rollout-private-${nativeId}.jsonl`), rpcLog = join(home, 'rpc.jsonl')
  writeFileSync(artifact, '{"private":true}\n')
  ins._resumeMap.set(childKey, nativeId); ins._resumeMapProvider.set(childKey, 'codex')
  const childSession = await sm.getOrCreate({ sessionKey: childKey, agent: agents[1]!, model: 'gpt-6-astra',
    channel: 'delegate', peerId: 'main', parentSessionKey: parentKey, userId, hermeticNoTools: true,
    requireNativeResume: { engine: 'codex', nativeSessionId: nativeId } })
  let db = new DelegateDurableDb(join(home, 'delegate.db')); const sql = new Database(join(home, 'delegate.db'))
  let jobs = new DelegateJobStore({ durable: db, sm: true })
  gw._delegateJobs = jobs
  const source = { version: 1 as const, userId, parentSessionKey: parentKey, originSessionKey: parentKey,
    parentClientSessionId: peer, childSessionKey: childKey, targetAgentId: 'worker', sourceAgentId: 'main', depth: 0, model: 'gpt-6-astra', ...(mode.startsWith('boot-') ? { parentWorkspaceMode: 'legacy' as const } : {}) }
  const made = jobs.create('worker', { retrySource: source, callbackOriginUserId: userId,
    callbackOriginSessionKey: parentKey, sessionKey: childKey, parentSessionKey: parentKey })
  assert.ok('jobId' in made)
  const original = jobs.snapshotOf(made.jobId)!
  assert.equal(jobs.fail(made.jobId, { failureClass: 'child_error', detail: 'private original failure', httpStatus: 500,
    claimToken: original.claimToken, fencingEpoch: original.fencingEpoch }), true)
  if (mode.startsWith('parent-')) {
    const parent = sm.getByKey(parentKey)!
    assert.equal(parent._currentTurnKey, undefined)
    // Remove only this real idle parent, leaving the actual child as its trusted
    // inherited workspace witness. No fabricated lookup or submitted parent turn.
    ins.sessions.delete(parentKey)
    if (mode === 'parent-metadata-missing') await deleteClientSession(peer, userId)
  }
  let billed = 0
  gw._delegateEngineBilling = { admit: async (input: any) => {
    billed++; assert.equal(input.parentSessionId, peer); assert.equal(input.sessionKey, childKey)
    return { requestId: 'a'.repeat(32), engineSessionId: childKey }
  }, settle: async () => {}, abandon: async () => {} }
  const kernel: any = (childSession.runner as any).kernel
  const rpc = spawn(process.execPath, [fileURLToPath(new URL('./codexStrictResumeRpc.fixture.mjs', import.meta.url)),
    artifact, rpcLog, 'success'], { env: { PATH: process.env.PATH, HOME: home, NODE_ENV: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(rpc, 'close')
  rpc.stderr.on('data', b => process.stderr.write(b))
  const lines = createInterface({ input: rpc.stdout }); lines.on('line', line => kernel.handleLine(line))
  kernel.proc = rpc; kernel.initialized = true
  kernel.ensureSpawned = async () => { if (mode === 'missing-late' && existsSync(artifact)) unlinkSync(artifact) }
  const server = createServer((req, res) => { gw.handleHttp(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const url = base + `/api/delegates/inbox/${made.jobId}/retry`
  const action = 'private-retry-action-0001', body = { generation: 0, actionId: action }
  const jwt = (uid = userId, exp = Math.floor(Date.now() / 1000) + 60) => 'Bearer ' + signJwt({ userId: uid, exp }, token)
  const post = async (value: unknown = body, authorization = jwt()) => {
    const response = await fetch(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(value) })
    return { status: response.status, body: await response.json() as any }
  }
  const counts = () => ({ jobs: (sql.prepare('SELECT count(*) n FROM delegate_jobs').get() as any).n,
    actions: (sql.prepare('SELECT count(*) n FROM delegate_retry_action').get() as any).n,
    slots: gw._activeDelegations, waiters: gw._delegateQueueWaiters?.size ?? 0, resume: gw._delegateResume?.reservedSize() ?? 0 })
  if (mode === 'deleted-after-accept') {
    const read = gw._getAgentsConfig.bind(gw); let reads = 0
    gw._getAgentsConfig = async () => {
      const config = await read()
      if (++reads === 2) {
        assert.equal(counts().actions, 1, 'deletion is after real acceptance, not precheck')
        await deleteClientSession(peer, userId)
      }
      return config
    }
  }
  let booted = false
  try {
    if (mode.startsWith('availability-')) {
      const get = async (path = '/inbox?limit=50', auth = jwt()) => {
        const response = await fetch(base + '/api/delegates' + path, { headers: { authorization: auth } })
        return { status: response.status, body: await response.json() as any }
      }
      const start = counts(), sessions = ins.sessions.size
      let probes = 0
      const probe = sm.strictNativeResumeAvailability.bind(sm)
      sm.strictNativeResumeAvailability = keys => { probes++; return probe(keys) }
      // Guard against accidentally falling back to a full scan for EACH row.
      sm.resolveStrictNativeResume = () => { throw new Error('UNBOUNDED_GET_NATIVE_PROBE') }
      const hint = (result: any) => result.body.items.find((r: any) => r.jobId === made.jobId)?.retry
      if (mode === 'availability-live') {
        for (let i = 0; i < 49; i++) {
          const sibling = jobs.create('worker', { retrySource: source, callbackOriginUserId: userId,
            callbackOriginSessionKey: parentKey, sessionKey: childKey, parentSessionKey: parentKey })
          assert.ok('jobId' in sibling)
          const snap = jobs.snapshotOf(sibling.jobId)!
          jobs.fail(sibling.jobId, { failureClass: 'child_error', detail: 'private', httpStatus: 500,
            claimToken: snap.claimToken, fencingEpoch: snap.fencingEpoch })
        }
        assert.equal((await get('/summary')).body.unacknowledgedFailures, 50); assert.equal(probes, 0)
        const page = await get(); assert.equal(page.status, 200); assert.equal(page.body.items.length, 50)
        assert.ok(page.body.items.every((r: any) => r.retry.available && r.retry.reason === null)); assert.equal(probes, 1)
        assert.equal((await get('/inbox', jwt('c:8'))).body.count, 0)
        assert.doesNotMatch(JSON.stringify(page.body), /nativeSessionId|rollout-private|private original failure/)
        // Missing file and wrong provider are not inferred as success, even if a
        // previous GET was positive. No cross-request native cache is authority.
        unlinkSync(artifact); assert.deepEqual(hint(await get()), { available: false, reason: 'retry_native_unavailable' })
        writeFileSync(artifact, '{"private":true}\n')
        const provider = childSession.providerTag; (childSession as any).providerTag = 'ccb'
        assert.equal(hint(await get()).available, false); (childSession as any).providerTag = provider
        assert.equal(hint(await get()).available, true)
        const active = jobs.create('worker', { sessionKey: childKey, parentSessionKey: parentKey })
        assert.ok('jobId' in active)
        assert.deepEqual(hint(await get()), { available: false, reason: 'retry_child_busy' })
        assert.equal(counts().jobs, 51)
      } else if (mode === 'availability-parent') {
        ins.sessions.delete(parentKey)
        assert.deepEqual(hint(await get()), { available: true, reason: null })
        assert.equal(sm.getByKey(parentKey), undefined, 'GET must not restore a parent')
        assert.equal(ins.sessions.size, sessions - 1)
      } else if (mode === 'availability-model') {
        // Seed a null-model source through the REAL create transaction. With no
        // live child witness this must not resolve the default model.
        const noModel = jobs.create('worker', { retrySource: { ...source, model: null, parentWorkspaceMode: 'legacy' },
          callbackOriginUserId: userId, callbackOriginSessionKey: parentKey, sessionKey: childKey, parentSessionKey: parentKey })
        assert.ok('jobId' in noModel); const snap = jobs.snapshotOf(noModel.jobId)!
        jobs.fail(noModel.jobId, { failureClass: 'child_error', detail: 'private', httpStatus: 500,
          claimToken: snap.claimToken, fencingEpoch: snap.fencingEpoch })
        ins.sessions.delete(childKey)
        const page = await get()
        assert.deepEqual(page.body.items.find((r: any) => r.jobId === noModel.jobId).retry,
          { available: false, reason: 'retry_model_unavailable' })
      } else if ((mode === 'availability-expired' || mode === 'availability-expired-final')) {
        const exp = Math.floor(Date.now() / 1000) + 2, read = gw._getAgentsConfig.bind(gw)
        const expire = () => new Promise(r => setTimeout(r, Math.max(1, exp * 1000 + 30 - Date.now())))
        if (mode === 'availability-expired-final') {
          const reconcile = gw._reconcileDelegateUserLifecycle.bind(gw); let calls = 0
          gw._reconcileDelegateUserLifecycle = async (...args: any[]) => {
            const result = await reconcile(...args)
            if (++calls === 2) await expire()
            return result
          }
        } else gw._getAgentsConfig = async () => { const config = await read(); await expire(); return config }
        assert.equal((await get('/inbox', jwt(userId, exp))).status, 401)
      } else if (mode === 'availability-delete') {
        const read = gw._getAgentsConfig.bind(gw)
        gw._getAgentsConfig = async () => { const cfg = await read(); await deleteClientSession(peer, userId); return cfg }
        const page = await get(); assert.equal(page.status, 200); assert.equal(page.body.count, 0)
        assert.equal(page.body.items.length, 0, 'deleted during availability must not remain in the final page')
      }
      assert.equal(counts().actions, start.actions); assert.equal(counts().slots, 0)
      assert.equal(counts().waiters, 0); assert.equal(counts().resume, 0); assert.equal(billed, 0)
      const requests = existsSync(rpcLog) ? readFileSync(rpcLog, 'utf8') : ''
      assert.equal(requests, '', 'GET cannot execute a native RPC')
      if (!['availability-parent', 'availability-model'].includes(mode)) assert.equal(ins.sessions.size, sessions)
    } else if (mode.startsWith('boot-')) {
      const key = { userId, sourceJobId: made.jobId, generation: 0, actionId: action }
      const accepted = jobs.acceptRetryAction(key, source, 'codex')
      assert.ok(!('error' in accepted)); const target = accepted.action.targetJobId
      assert.equal(jobs.snapshotOf(target)?.state, 'queued')
      if (mode === 'boot-dispatched') assert.equal(jobs.claimQueued(target).ok, true)
      if (mode === 'boot-deleted') await deleteClientSession(peer, userId)
      if (mode === 'boot-missing-native') { unlinkSync(artifact); ins.sessions.delete(childKey) }
      // Simulate the persisted acceptance boundary without executing. Reopen the
      // original durable store through actual Gateway.start; native/app-server
      // seed and billing remain private seams, not a real Codex CLI restart.
      jobs.close(); db.close(); gw._delegateJobs = undefined
      gw._delegateDurablePath = join(home, 'delegate.db')
      ins.sessions.delete(parentKey)
      // This case tests boot dispatch, not callback model admission. Retain
      // pending notification without fabricating durable ACK or contacting an
      // actual model; D13/retry-master callback acceptance remains separate.
      gw.injectSendToAgentCallback = async () => ({ kind: 'retryable_failure', code: 'NO_TRANSPORT' })
      let unregisteredSpawns = 0
      // Defense in the test, not production: the seeded child has its own real
      // synthetic-stdio ensureSpawned. No other kernel may launch a CLI/network.
      kernel.constructor.prototype.ensureSpawned = async () => {
        unregisteredSpawns++; throw new Error('PRIVATE_BOOT_UNREGISTERED_NATIVE_PROCESS')
      }
      let transientReads = 0
      if (mode === 'boot-busy') {
        gw._delegateResume = new DelegateResumeRegistry()
        assert.equal(gw._delegateResume.restoreTrustedIdle({ sessionKey: childKey, parentSessionKey: parentKey,
          targetAgentId: 'worker', sourceAgent: 'main' }), true)
        assert.equal(gw._delegateResume.preflight({ resumeSessionKey: childKey, parentSessionKey: parentKey,
          targetAgentId: 'worker', sourceAgent: 'main' }).dispatchGranted, true)
      }
      if (mode === 'boot-transient') {
        const read = gw._getAgentsConfig.bind(gw)
        gw._getAgentsConfig = async () => {
          const cfg = await read()
          if (gw._delegateRetryBootReady && transientReads++ === 0) throw new Error('PRIVATE_CONFIG_READ_UNKNOWN')
          return cfg
        }
      }
      await gw.start(); booted = true
      jobs = gw._delegateJobs
      db = new DelegateDurableDb(join(home, 'delegate.db'))
      if (mode === 'boot-busy' || mode === 'boot-transient') {
        for (let i = 0; i < 1000 && gw._delegateRetryRecovering; i++) await new Promise(r => setTimeout(r, 10))
        assert.equal(gw._delegateRetryRecovering, false)
        assert.equal(jobs.snapshotOf(target)?.state, 'queued', 'busy/unknown cannot settle or re-create accepted intent')
        assert.equal(db.getRetryAction(key)?.state, 'accepted')
        assert.equal(billed, 0); assert.equal(existsSync(rpcLog) ? readFileSync(rpcLog, 'utf8') : '', '')
        if (mode === 'boot-transient') assert.equal(transientReads, 1)
        else gw._delegateResume.release(childKey)
        // Do NOT manually call recovery or shorten its timer. The original 30s
        // reconcile must reclaim the exact persisted target once the obstacle clears.
        const start = Date.now()
        for (let i = 0; i < 4400 && !jobs.snapshotOf(target)?.result; i++) await new Promise(r => setTimeout(r, 10))
        assert.ok(Date.now() - start >= 20_000, 'observed original bounded timer, not direct redispatch')
        assert.match(JSON.stringify(jobs.snapshotOf(target)?.result), /PRIVATE_NATIVE_CONTINUATION_RESULT/)
      }
      const executed = ['boot-accepted', 'boot-busy', 'boot-transient'].includes(mode)
      if (mode === 'boot-accepted' || mode === 'boot-missing-native') {
        for (let i = 0; i < 1200 && !jobs.snapshotOf(target)?.result; i++) await new Promise(r => setTimeout(r, 10))
        const terminal = jobs.snapshotOf(target)!
        assert.ok(terminal.result, JSON.stringify(terminal))
        assert.match(JSON.stringify(terminal.result), mode === 'boot-accepted' ? /PRIVATE_NATIVE_CONTINUATION_RESULT/ : /retry_native_unavailable/)
      }
      const requests = existsSync(rpcLog) ? readFileSync(rpcLog, 'utf8').trim().split('\n').map(s => JSON.parse(s)) : []
      assert.equal(requests.filter(r => r.method === 'thread/start').length, 0)
      assert.equal(requests.filter(r => r.method === 'turn/start').length, executed ? 1 : 0)
      const replay = await post(); assert.equal(replay.status, 200); assert.equal(replay.body.jobId, target)
      assert.equal(billed, executed ? 1 : 0)
      assert.equal(unregisteredSpawns, 0)
      assert.equal(counts().jobs, 2); assert.equal(counts().actions, 1)
      if (mode !== 'boot-dispatched') assert.equal(counts().resume, 0)
      assert.equal(counts().slots, 0); assert.equal(counts().waiters, 0)
      if (mode === 'boot-deleted') assert.equal(db.getRetryAction(key)?.state, 'source_deleted')
      if (mode === 'boot-dispatched') assert.notEqual(db.getRetryAction(key)?.state, 'accepted')
      if (mode === 'boot-accepted' || mode === 'boot-missing-native') {
        const restored = sm.getByKey(parentKey)!
        assert.equal(restored.userId, userId); assert.equal(restored._currentTurnKey, undefined)
        assert.equal(restored.turns, 0)
      }
      process.stdout.write(JSON.stringify({ mode, target, methods: requests.map(r => r.method), counts: counts() }) + '\n')
    } else if (mode === 'parent-restore-expired') {
      const exp = Math.floor(Date.now() / 1000) + 2
      const originalRead = gw._getAgentsConfig.bind(gw)
      gw._getAgentsConfig = async () => {
        const cfg = await originalRead()
        await new Promise(r => setTimeout(r, Math.max(1, exp * 1000 + 30 - Date.now())))
        return cfg
      }
      assert.equal((await post(body, jwt(userId, exp))).status, 401)
      assert.equal(sm.getByKey(parentKey), undefined)
      assert.deepEqual(counts(), { jobs: 1, actions: 0, slots: 0, waiters: 0, resume: 0 })
    } else if (mode === 'parent-metadata-missing') {
      assert.equal((await post()).status, 409)
      assert.equal(sm.getByKey(parentKey), undefined)
      assert.deepEqual(counts(), { jobs: 1, actions: 0, slots: 0, waiters: 0, resume: 0 })
    } else if (mode === 'parent-restore-race') {
      const restore = sm.restoreIdleSession.bind(sm)
      let rival: any
      sm.restoreIdleSession = async (opts, validate) => {
        // Real manager creation wins before the recovery lock. Recovery must not
        // adopt its user, switch its model or mutate its workspace.
        rival = await sm.getOrCreate({ sessionKey: parentKey, agent: agents[0]!, model: 'gpt-6-astra',
          channel: 'webchat', peerId: peer, userId: 'c:8', hermeticNoTools: true })
        return restore(opts, validate)
      }
      assert.equal((await post()).status, 409)
      assert.equal(sm.getByKey(parentKey), rival); assert.equal(rival.userId, 'c:8')
      assert.equal(rival._currentTurnKey, undefined)
      assert.deepEqual(counts(), { jobs: 1, actions: 0, slots: 0, waiters: 0, resume: 0 })
    } else if (mode === 'denied') {
      assert.equal((await post(body, jwt('c:8'))).status, 409)
      assert.equal((await post({ ...body, userId })).status, 400)
      assert.equal((await post({ ...body, generation: 1 })).status, 409)
      assert.equal((await post({ ...body, actionId: 'short' })).status, 400)
      assert.equal((await post(body, 'Bearer ' + token)).status, 401)
      assert.deepEqual(counts(), { jobs: 1, actions: 0, slots: 0, waiters: 0, resume: 0 })
    } else if (mode === 'write-fault') {
      // Real original acceptance transaction fault AFTER reservation.
      sql.exec(`CREATE TRIGGER private_action_fault BEFORE INSERT ON delegate_retry_action BEGIN SELECT RAISE(ABORT,'private action fault'); END`)
      assert.equal((await post()).status, 503)
      assert.deepEqual(counts(), { jobs: 1, actions: 0, slots: 0, waiters: 0, resume: 0 })
    } else if (mode === 'expired-body') {
      const exp = Math.floor(Date.now() / 1000) + 2, text = JSON.stringify(body)
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(url, { method: 'POST', headers: { authorization: jwt(userId, exp),
          'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode!))
        })
        req.on('error', reject); req.setTimeout(6000, () => req.destroy(Error('private body timeout')))
        server.once('request', () => setTimeout(() => req.end(text.slice(1)), Math.max(1, exp * 1000 + 30 - Date.now())))
        req.write(text.slice(0, 1))
      })
      assert.equal(status, 401)
      assert.deepEqual(counts(), { jobs: 1, actions: 0, slots: 0, waiters: 0, resume: 0 })
    } else if (mode === 'expired-permission') {
      const exp = Math.floor(Date.now() / 1000) + 2
      const originalRead = gw._getAgentsConfig.bind(gw)
      gw._getAgentsConfig = async () => {
        const config = await originalRead() // real file permission config; source SQL already completed
        await new Promise(r => setTimeout(r, Math.max(1, exp * 1000 + 30 - Date.now())))
        return config // production coordinator must recheck the original user after this await
      }
      assert.equal((await post(body, jwt(userId, exp))).status, 401)
      assert.deepEqual(counts(), { jobs: 1, actions: 0, slots: 0, waiters: 0, resume: 0 })
    } else {
      const responses = await Promise.all([post(), post()])
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 202], JSON.stringify(responses))
      if (mode === 'parent-restore') {
        const parent = sm.getByKey(parentKey)!
        assert.equal(parent.userId, userId); assert.equal(parent.agentId, 'main')
        assert.equal(parent._currentTurnKey, undefined); assert.equal(parent._activeTurnCount ?? 0, 0)
        assert.equal(parent.turns, 0); assert.equal(parent.workspaceMode, childSession.workspaceMode)
      }
      const target = responses[0]!.body.jobId
      assert.equal(responses[1]!.body.jobId, target); assert.notEqual(target, made.jobId)
      for (let i = 0; i < 1000 && !jobs.snapshotOf(target)?.result; i++) await new Promise(r => setTimeout(r, 10))
      const terminal = jobs.snapshotOf(target)!
      assert.ok(terminal.result, JSON.stringify(terminal))
      const requests = existsSync(rpcLog) ? readFileSync(rpcLog, 'utf8').trim().split('\n').map(s => JSON.parse(s)) : []
      assert.equal(requests.filter(r => r.method === 'thread/start').length, 0)
      assert.equal(requests.filter(r => r.method === 'turn/start').length, mode === 'missing-late' || mode === 'deleted-after-accept' ? 0 : 1, JSON.stringify(terminal))
      if (mode === 'missing-late') assert.match(JSON.stringify(terminal.result), /STRICT_NATIVE_RESUME_UNAVAILABLE/)
      else if (mode === 'deleted-after-accept') assert.match(JSON.stringify(terminal.result), /retry_source_unavailable/)
      else assert.match(JSON.stringify(terminal.result), /PRIVATE_NATIVE_CONTINUATION_RESULT/)
      assert.equal(billed, mode === 'deleted-after-accept' ? 0 : 1)
      assert.deepEqual(counts(), { jobs: 2, actions: 1, slots: 0, waiters: 0, resume: 0 })
      assert.equal(db.getRetryAction({ userId, sourceJobId: made.jobId, generation: 0, actionId: action })?.state,
        mode === 'deleted-after-accept' ? 'source_deleted' : 'terminal')
      assert.equal((await post()).body.jobId, target)
      assert.equal(billed, mode === 'deleted-after-accept' ? 0 : 1)
      if (mode === 'deleted-after-accept') {
        assert.equal(jobs.userFailureInbox(userId).count, 0)
        assert.equal(db.getRetrySource(userId, made.jobId, 0), undefined)
      } else {
        assert.equal(jobs.userFailureInbox(userId).items.some(r => r.jobId === made.jobId), true, 'retry never ACKs original failure')
        assert.deepEqual(db.getRetrySource(userId, made.jobId, 0), source)
      }
      process.stdout.write(JSON.stringify({ mode, target, methods: requests.map(r => r.method), counts: counts() }) + '\n')
    }
    process.stdout.write(`RETRY_HTTP_PASS ${mode}\n`)
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    if (booted) await gw.shutdown(false)
    lines.close(); rpc.kill('SIGKILL'); await closed
    clearTimeout(gw._receiptCandidateTimer); clearTimeout(gw._notifyRetryTimer)
    jobs.close(); db.close(); sql.close(); await sm.awaitResumeMapFlush()
  }
}
main().catch(error => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exitCode = 1 })
