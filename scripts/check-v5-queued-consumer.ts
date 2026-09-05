#!/usr/bin/env tsx
/**
 * OCV5-121 hermetic deploy proof: queued waiting, exact cancellation, late-consumer silence.
 * Run from the pinned staging tree. No production DSN, model, service, or replay.
 * The supervisor owns cleanup even if the paths-aware worker times out/crashes.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolConfig } from 'pg'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_TEST_URL = 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const WORK_TIMEOUT_MS = 120_000
const CLEANUP_TIMEOUT_MS = 20_000
const TITLE = 'OCV5-121 hermetic deploy proof: queued waiting, exact cancellation, late-consumer silence'

function testDatabase(): { url: string; config: PoolConfig } {
  // Never consult DATABASE_URL, PGHOST, PGSERVICE, or URL query overrides.
  const raw = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL
  const u = new URL(raw)
  assert.ok(u.protocol === 'postgres:' || u.protocol === 'postgresql:', 'test PostgreSQL scheme required')
  assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname), 'loopback test PG only')
  assert.equal(u.search + u.hash, '', 'PG URL options/overrides forbidden')
  const database = decodeURIComponent(u.pathname.slice(1))
  assert.match(database, /^[a-zA-Z0-9_]+_test$/, 'database name must end in _test')
  const user = decodeURIComponent(u.username)
  assert.ok(user, 'explicit test PG user required')
  assert.ok(u.password, 'explicit test PG password required; no PGPASSWORD fallback')
  return { url: raw, config: {
    host: u.hostname === '[::1]' ? '::1' : '127.0.0.1',
    port: Number(u.port || 5432), database, user, password: decodeURIComponent(u.password),
    ssl: false, connectionTimeoutMillis: 3_000, query_timeout: 10_000,
    statement_timeout: 5_000, idle_in_transaction_session_timeout: 5_000,
  } }
}

async function sourceSha(): Promise<string> {
  let sha: string
  try {
    const manifest = JSON.parse(await readFile(join(root, 'flavor.manifest.json'), 'utf8'))
    sha = manifest.sourceCommit
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  }
  assert.match(sha, /^[0-9a-f]{40}$/, 'pinned source SHA required')
  return sha
}

async function boundedCleanup(work: () => Promise<void>): Promise<void> {
  // A cleanup timeout is a red gate, never an exit-0 shortcut.
  const timer = setTimeout(() => {
    console.error('queued-consumer proof: CLEANUP_TIMEOUT (FAIL)')
    process.exit(1)
  }, CLEANUP_TIMEOUT_MS)
  try { await work() } finally { clearTimeout(timer) }
}

async function supervise(): Promise<void> {
  const db = testDatabase()
  const sha = await sourceSha()
  for (const name of ['storage', 'protocol', 'gateway', 'commercial']) {
    assert.equal(await realpath(join(root, 'node_modules/@openclaude', name)),
      await realpath(join(root, 'packages', name)), 'workspace dependency escaped pinned tree: ' + name)
  }
  const schema = 'oc_qconsumer_' + randomUUID().replaceAll('-', '')
  const home = await mkdtemp(join(tmpdir(), 'oc-qconsumer-'))
  const admin = new Pool({ ...db.config, max: 1, options: '-c search_path=' + schema + ',public' })
  let created = false
  let worker: ReturnType<typeof spawn> | undefined
  let workerClosed: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const failures: unknown[] = []
  try {
    await admin.query('CREATE SCHEMA "' + schema + '"')
    created = true
    console.log(TITLE + ' source=' + sha + ' root=' + root + ' schema=' + schema)
    worker = spawn(process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url), '--worker', schema, home, sha], {
        cwd: root,
        // No inherited live runtime configuration, proxy, production DB, model keys or HOME.
        env: { PATH: process.env.PATH, HOME: home, OPENCLAUDE_HOME: home,
          TEST_DATABASE_URL: db.url, NODE_ENV: 'test' },
        stdio: 'inherit',
      })
    const child = worker
    workerClosed = new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        if (code === 0 && signal === null) resolve()
        else reject(new Error('proof worker failed: code=' + code + ' signal=' + signal))
      })
    })
    timer = setTimeout(() => {
      console.error('queued-consumer proof: WORK_TIMEOUT (FAIL)')
      child.kill('SIGKILL')
    }, WORK_TIMEOUT_MS)
    await workerClosed
  } catch (err) {
    failures.push(err)
  } finally {
    if (timer) clearTimeout(timer)
    await boundedCleanup(async () => {
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGKILL')
        await workerClosed?.catch(() => {})
      }
      if (created) {
        try {
          await admin.query('DROP SCHEMA "' + schema + '" CASCADE')
          const check = await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])
          assert.equal(check.rowCount, 0, 'own schema must be removed')
        } catch (err) { failures.push(err) }
      }
      try { await admin.end() } catch (err) { failures.push(err) }
      try { await rm(home, { recursive: true, force: false }) } catch (err) { failures.push(err) }
    })
  }
  if (failures.length) throw new AggregateError(failures, 'queued-consumer proof/cleanup failed')
  console.log(TITLE + ' PASS source=' + sha + ' journeys=3 cleanup=PASS')
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return address.port
}

async function runWorker(): Promise<void> {
  const [, , , schema, home, sha] = process.argv
  assert.match(schema!, /^oc_qconsumer_[0-9a-f]{32}$/)
  assert.equal(process.env.OPENCLAUDE_HOME, home)
  assert.match(sha!, /^[0-9a-f]{40}$/)
  // No storage or gateway runtime import is allowed above this setup.
  process.env.OPENCLAUDE_HOME = home
  const storage = await import('../packages/storage/src/index.js')
  const inbox = await import('../packages/gateway/src/turnDispatchInbox.js')
  const { Gateway } = await import('../packages/gateway/src/server.js')
  const { SessionManager } = await import('../packages/gateway/src/sessionManager.js')
  const { CcbAdapter } = await import('../packages/gateway/src/engine/ccbAdapter.js')
  const { setV3MasterSinkSingleton } = await import('../packages/gateway/src/v3MasterSink.js')
  const { eventBus } = await import('../packages/gateway/src/eventBus.js')
  const { makeContainerDispatchClient } = await import('../packages/commercial/src/dispatch/containerDispatchClient.js')
  const { computeInboundNonce } = await import('../packages/commercial/src/bridgeSecret.js')
  const { runReconcileTick } = await import('../packages/commercial/src/dispatch/turnDispatchReconciler.js')
  const { createPgSessionsBackend } = await import('../packages/commercial/src/db/pgSessionsBackend.js')
  const { makeTurnTapeStateHandler } = await import('../packages/commercial/src/http/internalServerAuthored.js')
  const db = testDatabase()
  const pool = new Pool({ ...db.config, max: 4, options: '-c search_path=' + schema + ',public' })
  const forbidden: string[] = []
  const fail = (kind: string): never => { forbidden.push(kind); throw new Error('forbidden proof side effect: ' + kind) }
  const servers: Server[] = []
  let release: (() => void) | undefined
  let original: Promise<unknown> | undefined
  const cleanupErrors: unknown[] = []
  let probeWrites = false
  // Observers retain violations outside PG transactions, even if production recovery catches/rolls back.
  pool.on('connect', client => {
    const query = client.query.bind(client)
    client.query = ((...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? ''
      if (probeWrites && (
        /producer_fenced_at\s*=|visible_head\s*=|visible_at\s*=/i.test(sql)
        || /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:client_sessions|client_session_turn_tapes|client_session_turn_tape_parts|usage_records|turn_dispatch_error_projections)\b/i.test(sql)
        || /UPDATE\s+request_finalize_journal[\s\S]*SET\s+(?!ctx\s*=)/i.test(sql)
      )) fail('PG fallback/fence/tape/financial write')
      const last = args.length - 1
      if (typeof args[last] === 'function') {
        const callback = args[last] as (...args: unknown[]) => void
        args[last] = (err: unknown, ...rest: unknown[]) => {
          if (err) forbidden.push('PG query error: ' + (err as Error).message)
          callback(err, ...rest)
        }
        return (query as (...args: unknown[]) => unknown)(...args)
      }
      return (query as (...args: unknown[]) => Promise<unknown>)(...args).catch(err => {
        forbidden.push('PG query error: ' + (err as Error).message)
        throw err
      })
    }) as typeof client.query
  })
  const onTool = () => fail('tool')
  eventBus.on('tool.called', onTool)
  setV3MasterSinkSingleton({ stageDurable: async () => fail('tape'), enqueue: () => fail('tape') } as never)
  try {
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema)
    // Minimal dedicated-schema fixture plus the production dispatch migration. No public writes/extensions.
    await pool.query(`
      CREATE TABLE client_sessions (id text, user_id text, deleted_at bigint, messages text DEFAULT '[]', PRIMARY KEY(id,user_id));
      CREATE TABLE agent_containers (id bigint PRIMARY KEY, user_id bigint, state text, runtime_kind text);
      CREATE TABLE request_finalize_journal (request_id text PRIMARY KEY, ctx jsonb DEFAULT '{}', state text);
      CREATE TABLE usage_records (id bigint PRIMARY KEY);
      CREATE TABLE client_session_turn_tapes (tape_id text, session_id text, user_id text,
        finalized_at bigint, visible_at bigint, status text, part_count integer);
      CREATE TABLE client_session_turn_tape_parts (tape_id text, session_id text, user_id text);
      CREATE TABLE client_session_live_streams (stream_key text, dispatch_id uuid);
      CREATE TABLE client_session_live_frames (stream_key text, created_at timestamptz);
      CREATE TABLE turn_traces (trace_id text, user_id bigint, session_key text, first_visible_at timestamptz);
    `)
    await pool.query(await readFile(join(root, 'packages/commercial/src/db/migrations/0170_durable_turn_dispatch.sql'), 'utf8'))
    await pool.query(await readFile(join(root, 'packages/commercial/src/db/migrations/0239_turn_dispatch_shutdown_ctx.sql'), 'utf8'))
    await pool.query(await readFile(join(root, 'packages/commercial/src/db/migrations/0267_turn_dispatches_agent_container.sql'), 'utf8'))
    await pool.query('ALTER TABLE turn_dispatches ADD COLUMN visible_head jsonb, ADD COLUMN visible_at bigint, ADD COLUMN producer_fenced_at timestamptz')
    await pool.query("INSERT INTO agent_containers VALUES (7,42,'active','docker')")
    const bridgeSecret = randomBytes(32).toString('hex')
    Object.assign(process.env, { OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1',
      OC_CONTAINER_ID: '7', OPENCLAUDE_INBOUND_NONCE: computeInboundNonce(bridgeSecret, 7) })
    const config = { version: 1, defaults: {}, gateway: { bind: '127.0.0.1', port: 0, accessToken: 'proof-only' },
      auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: '' } } as never
    const gateway = new Gateway({ config, agentsConfig: { agents: [{ id: 'main' }], routes: [], default: 'main' } as never })
    let gets = 0
    let cancels = 0
    const gatewayServer = createServer((req, res) => {
      const path = new URL(req.url!, 'http://local').pathname
      if (path === '/internal/v3/turn-dispatch-state') gets++
      else if (path === '/internal/v3/turn-cancel-if-queued') cancels++
      else { res.writeHead(404).end(); return }
      ;(gateway as unknown as { handleHttp: (r: unknown, s: unknown) => void }).handleHttp(req, res)
    })
    servers.push(gatewayServer)
    const port = await listen(gatewayServer)
    const request = async (method: string, endpoint: { host: string; port: number }, path: string,
      headers: Record<string, string>, body: string | null, timeoutMs: number) => {
      assert.equal(endpoint.host, '127.0.0.1')
      assert.equal(endpoint.port, port)
      const response = await fetch('http://127.0.0.1:' + port + path, {
        method, headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      })
      return { status: response.status, bodyText: await response.text() }
    }
    const container = makeContainerDispatchClient({ bridgeSecret,
      resolveRunningEndpoint: async () => ({ host: '127.0.0.1', port, containerId: 7 }),
      transport: { request, post: async (endpoint, path, headers, body, timeout) => request('POST', endpoint, path, headers, body, timeout) },
    })
    const now = Date.now()
    const identity = { uid: 42n, sessionId: 'proof-queued', clientMessageId: 'cm-queued',
      dispatchId: randomUUID(), attemptNo: 1 }
    const seed = async (id: typeof identity, status: 'accepted' | 'terminal', at: number) => {
      await pool.query('INSERT INTO client_sessions(id,user_id) VALUES($1,$2)', [id.sessionId, 'c:42'])
      await pool.query(`INSERT INTO turn_dispatches
        (dispatch_id,user_id,session_id,client_message_id,agent_id,request_hash,billing_request_id,
         status,outcome,client_notified,anchor_seq,admitted_at,accepted_at,terminal_at,agent_container_id,runtime_kind)
        VALUES($1,42,$2,$3,'main','hash',$4,$5,$6,true,1,$7,$7,$8,7,'docker')`,
        [id.dispatchId,id.sessionId,id.clientMessageId,randomBytes(16).toString('hex'),status,
          status === 'terminal' ? 'interrupted' : null,new Date(at),status === 'terminal' ? new Date(at) : null])
    }
    const state = async (id: typeof identity) => {
      const pg = (await pool.query('SELECT status,outcome,producer_fenced_at,visible_head,visible_at FROM turn_dispatches WHERE dispatch_id=$1', [id.dispatchId])).rows[0]
      const local = await storage.getTurnDispatchByDispatchId(id.dispatchId, id.attemptNo)
      assert.ok(pg && local, 'both durable authorities must exist')
      assert.equal(pg.producer_fenced_at, null)
      assert.equal(pg.visible_head, null)
      assert.equal(pg.visible_at, null)
      for (const table of ['client_session_turn_tapes', 'client_session_turn_tape_parts', 'usage_records',
        'request_finalize_journal', 'turn_dispatch_error_projections']) {
        assert.equal(Number((await pool.query('SELECT count(*) AS n FROM ' + table)).rows[0].n), 0, table)
      }
      assert.equal((await pool.query('SELECT messages FROM client_sessions WHERE id=$1', [id.sessionId])).rows[0].messages, '[]')
      assert.deepEqual(forbidden, [])
      return { pg, local }
    }
    await seed(identity, 'accepted', now - 16 * 60_000)
    await storage.insertQueuedTurnDispatch({ ...identity, userId: '42', payloadHash: 'hash' })
    probeWrites = true
    const tick = (at: number) => runReconcileTick({ pool, container, now: () => at,
      enqueueAlert: () => fail('alert'), nudgeClient: () => fail('fallback notification'),
      commitVisibleTape: async () => fail('visible tape'), releaseReservation: async () => fail('financial release') })

    const first = await tick(now)
    assert.equal(first.visibleOrphans, 0)
    assert.ok(gets > 0, 'production client must query actual gateway HTTP')
    assert.equal(cancels, 0)
    const waiting = await state(identity)
    assert.equal(waiting.pg.status, 'accepted')
    assert.equal(waiting.pg.outcome, null)
    assert.equal(waiting.local.state, 'queued')
    console.log('journey=normal-queued-over-15min PASS source=' + sha)

    const hardCap = now + 6 * 3_600_000
    const beforeGets = gets
    const capped = await tick(hardCap)
    assert.equal(capped.visibleOrphans, 0)
    assert.equal(cancels, 1)
    const cancelled = await state(identity)
    assert.equal(cancelled.pg.status, 'accepted')
    assert.equal(cancelled.pg.outcome, null)
    assert.equal(cancelled.local.state, 'rejected')
    assert.equal(cancelled.local.outcome, 'not_accepted')
    const next = await tick(hardCap)
    assert.ok(gets >= beforeGets + 2, 'next tick must perform another real GET')
    assert.equal(next.rejectedTerminal, 1)
    assert.equal(cancels, 1)
    const terminal = await state(identity)
    assert.equal(terminal.pg.status, 'terminal')
    assert.equal(terminal.pg.outcome, 'not_accepted')
    console.log('journey=hardcap-exact-cancel-next-tick PASS source=' + sha)

    probeWrites = false
    const historical = { ...identity, sessionId: 'proof-historical', clientMessageId: 'cm-historical', dispatchId: randomUUID() }
    await seed(historical, 'terminal', now)
    probeWrites = true
    const backend = createPgSessionsBackend(pool, { expectedGeneration: 'proof' })
    const secret = randomBytes(32).toString('hex')
    const hostUuid = 'hermetic-proof-host'
    let masterQueries = 0
    const handler = makeTurnTapeStateHandler({ storage: backend, identityRepo: {
      async findActiveByHostAndBoundIp(host, ip) {
        if (host !== hostUuid || ip !== '127.0.0.1') return null
        return { id: 7, user_id: 42, host_uuid: hostUuid, bound_ip: ip,
          secret_hash: createHash('sha256').update(Buffer.from(secret, 'hex')).digest() }
      },
    } })
    const masterServer = createServer((req, res) => {
      if (!req.url?.startsWith('/internal/v3/turn-tape-state?')) { res.writeHead(404).end(); return }
      masterQueries++
      void handler(req, res, { hostUuid, boundIp: '127.0.0.1' }).catch(err => {
        forbidden.push('master handler error: ' + String(err))
        res.writeHead(500).end()
      })
    })
    servers.push(masterServer)
    const masterPort = await listen(masterServer)
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = 'http://127.0.0.1:' + masterPort
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = 'oc-v3.7.' + secret
    const authority = await inbox.queryMasterTapeState(historical.dispatchId, 1)
    assert.equal(authority.state, 'none')
    assert.equal(authority.dispatchStatus, 'terminal')
    assert.equal(authority.dispatchOutcome, 'interrupted')
    assert.equal(authority.producerFenced, false)
    const predecessor = new Promise<void>(resolve => { release = resolve })
    const rawRunner = Object.assign(new EventEmitter(), {
      isRunning: true, lastActivityAt: Date.now(),
      submit: async () => fail('model'), start: async () => fail('model start'),
    })
    const adapter = new CcbAdapter({} as never, rawRunner as never)
    const session = { sessionKey: 'agent:main:webchat:dm:' + historical.sessionId, agentId: 'main',
      peerId: historical.sessionId, channel: 'unit', turns: 0, lock: predecessor, lastUsedAt: 0,
      totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0, toolUseIdToName: new Map(), providerTag: 'ccb',
      executionTarget: { kind: 'local' }, runner: adapter,
    } as unknown as import('../packages/gateway/src/sessionManager.js').AgentSession
    const sm = new SessionManager(config)
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const ctx = { ...historical, uid: '42', payloadHash: 'hash', billingRequestId: 'proof' }
    original = inbox.runDurableDispatchAdmission({ ctx,
      sendReceipt: row => { assert.equal(row?.state, 'queued') },
      dispatch: async () => {
        const pending = sm.submit(session, 'hermetic queued input', () => fail('event/error'),
          undefined, undefined, undefined, undefined, undefined, {
            dispatchContext: { ...historical, userId: '42' },
            replayLifecycle: { clientMessageId: historical.clientMessageId, onStart() {},
              onBeforeRelease(error) { if (error !== undefined) fail('replay error') }, onEnd() {} },
          })
        entered()
        await pending
      },
    })
    // Observe early failures while waiting, without suppressing the original rejection.
    await Promise.race([ready, original.then(() => { throw new Error('admission ended before queue barrier') })])
    assert.equal(inbox.isTurnDispatchLive(historical.dispatchId, 1), true)
    assert.equal(session._activeTurnCount, 1)
    assert.equal((await state(historical)).local.state, 'queued')
    const recovered = await inbox.recoverTurnDispatchInboxOnBoot({
      isDispatchLive: inbox.isTurnDispatchLive, queryMasterTapeState: inbox.queryMasterTapeState,
      retryQueueHasDispatch: async () => false, stageSyntheticCrashedTape: async () => fail('synthetic tape'),
      onManualReconcile: () => fail('manual recovery'),
    })
    assert.equal(recovered.rejected, 1)
    assert.ok(masterQueries >= 2, 'recovery must traverse actual master tape-state HTTP')
    assert.equal((await state(historical)).local.state, 'rejected')
    release!()
    await original
    await session.lock
    assert.equal(session._currentDispatch, undefined)
    assert.equal(session._activeTurnCount, 0)
    assert.equal(inbox.isTurnDispatchLive(historical.dispatchId, 1), false)
    const final = await state(historical)
    assert.equal(final.pg.status, 'terminal')
    assert.equal(final.pg.outcome, 'interrupted')
    assert.equal(final.local.state, 'rejected')
    assert.equal(final.local.outcome, 'not_accepted')
    assert.deepEqual(forbidden, [])
    console.log('journey=historical-split-deferred-consumer PASS source=' + sha + ' model/tool/tape/error=0')
  } finally {
    await boundedCleanup(async () => {
      release?.()
      if (original) {
        try { await original } catch (err) { cleanupErrors.push(err) }
      }
      eventBus.off('tool.called', onTool)
      setV3MasterSinkSingleton(null)
      for (const server of servers) {
        try {
          server.closeAllConnections()
          if (server.listening) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
        } catch (err) { cleanupErrors.push(err) }
      }
      try { await storage.closeSessionsDb() } catch (err) { cleanupErrors.push(err) }
      try { await pool.end() } catch (err) { cleanupErrors.push(err) }
    })
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'worker cleanup failed')
  }
}

try {
  if (process.argv[2] === '--worker') await runWorker()
  else {
    assert.equal(process.argv.length, 2, 'no proof bypass/options accepted')
    await supervise()
  }
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
