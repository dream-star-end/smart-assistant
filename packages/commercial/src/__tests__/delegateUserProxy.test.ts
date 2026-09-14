/** D14 protocol tests: original router/JWT/account query/proxy and real Gateway/SQLite.
 * Pool rows and Docker inspect are private seams, NOT live PG/account integration.
 * Remote uses original tunnel HTTP framing over a loopback socket, NOT mTLS/node-agent proof.
 * Run: scripts/test-mutex.sh commercial 'env TSX_TSCONFIG_PATH=packages/commercial/src/__tests__/delegateUserProxy.tsconfig.json node --import tsx --test --test-force-exit packages/commercial/src/__tests__/delegateUserProxy.test.ts'
 * Use an isolated environment. No production endpoints or credentials.
 */
import assert from 'node:assert/strict'
import http, { type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { mock, test } from 'node:test'
import type { Pool } from 'pg'
import type { TLSSocket } from 'node:tls'

const home = mkdtempSync(join(tmpdir(), 'delegate-user-proxy-'))
process.env.OPENCLAUDE_HOME = home
// A router dependency installs a keep-alive exception handler. Import failure must
// still fail this test process, never report a zero-execution green file.
function required<T>(promise: Promise<T>): Promise<T> {
  return promise.catch(error => { console.error(error); process.exit(1) })
}
const { Gateway } = await required(import('../../../gateway/src/server.js'))
const { DelegateDurableDb } = await required(import('../../../gateway/src/delegateDurable.js'))
const { DelegateJobStore } = await required(import('../../../gateway/src/delegateJobs.js'))
const { createCommercialHandler } = await required(import('../http/router.js'))
const { containerApiProxy } = await required(import('../http/containerApiProxy.js'))
const { signAccess } = await required(import('../auth/jwt.js'))
const { setPoolOverride, resetPool } = await required(import('../db/index.js'))
const { _clearMaintenanceCache } = await required(import('../middleware/maintenanceMode.js'))
const { containerSubnetPrefixForChannel } = await required(import('../containerNet.js'))
const { V3_CONTAINER_PORT } = await required(import('../agent-sandbox/v3supervisor.js'))
const SECRET = 'private-delegate-router-jwt-'.repeat(3)
const BRIDGE = 'private-delegate-router-bridge'
const originalRequest = http.request
const boundIp = containerSubnetPrefixForChannel() + '.0.77'
const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet } }
function gate() {
  let open!: () => void
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
async function expired(exp: number) {
  await new Promise(resolve => setTimeout(resolve, Math.max(1, exp * 1000 + 40 - Date.now())))
}

async function fixture() {
  const root = mkdtempSync(join(home, 'case-'))
  const db = new DelegateDurableDb(join(root, 'delegates.db'))
  const jobs = new DelegateJobStore({ durable: db, sm: true, failureInbox: true })
  const gw = new Gateway({ config: { version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: 'private-container-token' },
    auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(root, 'sessions.db') },
    defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } } } as never,
    agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }], routes: [], default: 'main' } })
  ;(gw as unknown as { _delegateJobs: typeof jobs })._delegateJobs = jobs
  const env = { OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1', OC_CONTAINER_ID: '77',
    OC_BRIDGE_NONCE: createHmac('sha256', BRIDGE).update('77').digest('hex') }
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  let gatewayRequests = 0, routedRequests = 0, accountReads = 0, statusReads = 0
  let active = true, accountFault = false
  let onAccount: ((n: number) => Promise<void>) | undefined
  let onStatus: (() => Promise<void>) | undefined
  let onReady: (() => Promise<void>) | undefined
  const gateway = http.createServer((req, res) => {
    gatewayRequests++
    ;(gw as unknown as { handleHttp(req: IncomingMessage, res: ServerResponse): void }).handleHttp(req, res)
  })
  const gatewayUrl = await listen(gateway)
  // Redirect only the private selected container address. Original router and proxy still execute.
  const requestMock = mock.method(http, 'request', ((options: http.RequestOptions, ...args: unknown[]) => {
    assert.equal(options.host, boundIp, 'only private container transport can be redirected')
    assert.equal(options.port, V3_CONTAINER_PORT)
    routedRequests++
    return Reflect.apply(originalRequest, http, [{ ...options, host: '127.0.0.1', port: new URL(gatewayUrl).port }, ...args])
  }) as typeof http.request)
  syncBuiltinESMExports()
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('FROM users') && sql.includes('role = ANY')) {
        accountReads++
        assert.ok(params[0] === '7' || params[0] === '8')
        assert.deepEqual(params[1], ['user', 'admin'])
        await onAccount?.(accountReads)
        if (accountFault) throw Error('PRIVATE_ACCOUNT_FAILURE')
        return { rowCount: active ? 1 : 0, rows: active ? [{ id: params[0], role: 'user' }] : [] }
      }
      if (sql.includes('FROM users') && sql.includes('SELECT role, status')) return { rowCount: 1, rows: [{ role: 'admin', status: 'active' }] }
      if (sql.includes('FROM agent_containers')) {
        statusReads++
        await onStatus?.()
        return { rowCount: 1, rows: [{ id: '77', user_id: String(params[0]), bound_ip: boundIp,
          port: V3_CONTAINER_PORT, container_internal_id: 'private-docker-id', host_uuid: 'self',
          created_at: new Date(), last_ws_activity: null }] }
      }
      if (sql.includes('INSERT INTO security_events') || sql.includes('FROM system_settings')) return { rowCount: 0, rows: [] }
      throw Error('unapproved private SQL: ' + sql)
    }, async end() {}, on() { return this },
  } as unknown as Pool
  setPoolOverride(pool)
  _clearMaintenanceCache()
  const deps = { jwtSecret: SECRET, mailer: { async send() {} }, redis: { async incr() { return 1 }, async expire() { return 1 } },
    bridgeSecret: BRIDGE, refreshCookieSecure: false,
    v3Supervisor: { pool, selfHostId: 'self', docker: { getContainer() { return { async inspect() { return { State: { Running: true } } } } } } } as never,
    ensureContainerReady: async () => { await onReady?.() },
  }
  let handler = createCommercialHandler(deps, { logger: quiet as never })
  let hostFallbacks = 0, handlerErrors = 0
  const master = http.createServer((req, res) => {
    void handler(req, res).then(handled => {
      if (!handled) { hostFallbacks++; res.writeHead(401); res.end('{"error":"host fallback"}') }
    }).catch(() => { handlerErrors++; res.writeHead(500); res.end('{"error":"handler exception"}') })
  })
  const masterUrl = await listen(master)
  function fail(userId: string) {
    const made = jobs.create('worker', { callbackOriginUserId: userId,
      parentSessionKey: 'agent:main:webchat:dm:private-' + userId, callback: 'none' })
    assert.ok('jobId' in made)
    const snap = jobs.snapshotOf(made.jobId)!
    assert.equal(jobs.fail(made.jobId, { failureClass: 'child_error', detail: 'PRIVATE_RESULT', httpStatus: 500,
      claimToken: snap.claimToken, fencingEpoch: snap.fencingEpoch }), true)
    return made.jobId
  }
  const good = fail('c:7'); fail('c:8'); fail('c:8')
  return { good, gatewayUrl, masterUrl, jobs,
    get counts() { return { gatewayRequests, routedRequests, accountReads, statusReads, hostFallbacks, handlerErrors } },
    set onAccount(fn: typeof onAccount) { onAccount = fn }, set onStatus(fn: typeof onStatus) { onStatus = fn },
    set onReady(fn: typeof onReady) { onReady = fn }, set active(value: boolean) { active = value },
    set accountFault(value: boolean) { accountFault = value },
    disableProxy() { handler = createCommercialHandler({ ...deps, v3Supervisor: undefined }, { logger: quiet as never }) },
    async call(path = 'inbox', token?: string, method = 'GET', body?: string, extra: Record<string, string> = {}) {
      token ??= (await signAccess({ sub: '7', role: 'user' }, SECRET)).token
      const res = await fetch(masterUrl + '/api/delegates/' + path, { method,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...extra }, ...(body ? { body } : {}) })
      return { status: res.status, body: await res.json() as { count?: number; error?: unknown }, cache: res.headers.get('cache-control') }
    },
    async close() {
      await close(master); await close(gateway)
      requestMock.mock.restore(); syncBuiltinESMExports()
      for (const key of Object.keys(env)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
      _clearMaintenanceCache(); await resetPool(); jobs.close(); db.close()
    },
  }
}

test('D14 original router JWT/account gate reaches private Gateway with no forged user or bridge headers', { timeout: 15000 }, async () => {
  const f = await fixture()
  try {
    const a = await f.call('inbox', undefined, 'GET', undefined, { 'x-openclaude-delegate-user': 'c:8',
      'x-openclaude-delegate-user-expires': String(Date.now() + 999999), 'x-openclaude-bridge-nonce': 'forged', 'x-openclaude-container-id': '8' })
    assert.equal(a.status, 200); assert.equal(a.body.count, 1); assert.equal(a.cache, 'no-store')
    const token = (await signAccess({ sub: '8', role: 'admin' }, SECRET)).token
    const b = await f.call('inbox', token, 'GET', undefined, { 'x-oc-host-scope': '1' })
    assert.equal(b.status, 200); assert.equal(b.body.count, 2)
    assert.deepEqual(f.counts, { accountReads: 4, statusReads: 2, routedRequests: 2, gatewayRequests: 2, hostFallbacks: 0, handlerErrors: 0 })
    const rejected = await f.call('inbox', (await signAccess({ sub: '7', role: 'user' }, 'x'.repeat(64))).token)
    assert.equal(rejected.status, 401); assert.equal(f.counts.routedRequests, 2)
    f.active = false
    assert.equal((await f.call()).status, 403); assert.equal(f.counts.routedRequests, 2)
  } finally { await f.close() }
})

test('D14 original router rechecks JWT after the second account query await', { timeout: 15000 }, async () => {
  const f = await fixture(), entered = gate(), release = gate()
  try {
    const signed = await signAccess({ sub: '7', role: 'user' }, SECRET, { ttlSeconds: 2 })
    f.onAccount = async n => { if (n === 2) { entered.open(); await release.promise } }
    const pending = f.call('inbox/' + f.good + '/ack', signed.token, 'POST', '{"generation":0}')
    await entered.promise; await expired(signed.exp); release.open()
    assert.equal((await pending).status, 401)
    assert.equal(f.counts.routedRequests, 0); assert.equal(f.jobs.userFailureInbox('c:7').count, 1)
  } finally { release.open(); await f.close() }
})

test('D14 original router partial body and container-await revocation never ACK', { timeout: 15000 }, async () => {
  const f = await fixture()
  try {
    const entered = gate()
    f.onReady = async () => { entered.open() }
    const signed = await signAccess({ sub: '7', role: 'user' }, SECRET, { ttlSeconds: 2 })
    const body = '{"generation":0}'
    const pending = new Promise<number>((resolve, reject) => {
      const req = originalRequest(f.masterUrl + '/api/delegates/inbox/' + f.good + '/ack', { method: 'POST',
        headers: { authorization: 'Bearer ' + signed.token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!))
      })
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(Error('body watchdog'))); req.write(body.slice(0, 1))
      void entered.promise.then(async () => { await expired(signed.exp); req.end(body.slice(1)) }).catch(reject)
    })
    assert.equal(await pending, 401); assert.equal(f.counts.routedRequests, 0)
    f.onStatus = async () => { f.active = false }
    assert.equal((await f.call()).status, 401)
    assert.equal(f.counts.routedRequests, 0); assert.equal(f.jobs.userFailureInbox('c:7').count, 1)
  } finally { await f.close() }
})

test('D14 account authority errors are explicit503 with no proxy or false ACK', { timeout: 15000 }, async () => {
  const f = await fixture()
  try {
    f.accountFault = true
    const response = await f.call('inbox/' + f.good + '/ack', undefined, 'POST', '{"generation":0}')
    assert.equal(response.status, 503); assert.equal(JSON.stringify(response).includes('PRIVATE_ACCOUNT_FAILURE'), false)
    assert.equal(f.counts.routedRequests, 0); assert.equal(f.counts.handlerErrors, 0)
    assert.equal(f.jobs.userFailureInbox('c:7').count, 1)
    f.accountFault = false
    f.onAccount = async n => { if (n === 3) throw Error('PRIVATE_ACCOUNT_FAILURE') }
    const later = await f.call('inbox/' + f.good + '/ack', undefined, 'POST', '{"generation":0}')
    assert.equal(later.status, 503); assert.equal(JSON.stringify(later).includes('PRIVATE_ACCOUNT_FAILURE'), false)
    assert.equal(f.counts.routedRequests, 0); assert.equal(f.counts.handlerErrors, 0)
    assert.equal(f.jobs.userFailureInbox('c:7').count, 1)
  } finally { await f.close() }
})

test('D14 unsupported paths/methods and unavailable proxy cannot use admin host fallback', { timeout: 15000 }, async () => {
  const f = await fixture()
  try {
    for (const role of ['user', 'admin'] as const) {
      const token = (await signAccess({ sub: '7', role }, SECRET)).token
      for (const [path, method] of [['summary', 'POST'], ['inbox/x/retry', 'GET'], ['inbox/x/ack/extra', 'GET']]) {
        assert.equal((await f.call(path, token, method, undefined, { 'x-oc-host-scope': '1' })).status, 403)
      }
    }
    f.disableProxy()
    const token = (await signAccess({ sub: '7', role: 'admin' }, SECRET)).token
    assert.equal((await f.call('inbox', token, 'GET', undefined, { 'x-oc-host-scope': '1' })).status, 403)
    assert.equal(f.counts.hostFallbacks, 0); assert.equal(f.counts.routedRequests, 0)
  } finally { await f.close() }
})

test('D14 exact retry POST reaches bound container; never falls back to host or accepts free input', async () => {
  const f = await fixture()
  try {
    const path = 'inbox/' + f.good + '/retry'
    const valid = JSON.stringify({ generation: 0, actionId: 'private-master-retry-0001' })
    const unavailable = await f.call(path, undefined, 'POST', valid)
    // Fixture has no ready source/native executor: the real container must
    // reject, not the master allowlist. End-to-end execution has its own fixture.
    assert.equal(unavailable.status, 503)
    assert.equal(unavailable.body.error, 'retry_not_ready')
    assert.equal(f.counts.routedRequests, 1); assert.equal(f.counts.gatewayRequests, 1)
    const forged = await f.call(path, undefined, 'POST', JSON.stringify({ generation: 0,
      actionId: 'private-master-retry-0002', userId: 'c:8', goal: 'forged' }))
    assert.equal(forged.status, 400); assert.equal(f.counts.routedRequests, 2)
    assert.equal(f.counts.hostFallbacks, 0)
  } finally { await f.close() }
})

test('D14 remote tunnel framing preserves user/nonce, rejects wrong identity and host-await expiry', { timeout: 15000 }, async () => {
  const f = await fixture()
  let identity = 'c:7', stale = false, dials = 0, expiresAt = Date.now() + 20000
  const key = Buffer.from('private-test-key')
  const status = { userId: 7, containerId: 77, state: 'running', boundIp, port: V3_CONTAINER_PORT,
    hostId: 'remote', dockerContainerId: 'private-docker-id', lastWsActivity: null } as const
  const remote = http.createServer((req, res) => {
    void containerApiProxy(req, res, { requestId: 'private-tunnel', log: quiet } as never, {
      v3: {} as never, bridgeSecret: BRIDGE, selfHostId: 'self', getStatus: async () => status,
      getHostById: async () => { if (stale) await expired(expiresAt / 1000); return { status: 'active' } as never },
      rowToTarget: () => ({ hostId: 'remote', host: 'unused.invalid', agentPort: 9444, psk: key,
        expectedFingerprint: 'f'.repeat(64) }),
      authorizeDelegateUser: async () => ({ userId: identity, expiresAt }),
      tunnelDial: async input => {
        dials++
        assert.equal(input.containerInternalId, 'private-docker-id'); assert.equal(input.headers?.authorization, undefined)
        const url = new URL(input.pathAndQuery!, 'http://private')
        assert.equal(url.searchParams.get('port'), String(V3_CONTAINER_PORT)); url.searchParams.delete('port')
        const socket = connect(Number(new URL(f.gatewayUrl).port), '127.0.0.1')
        await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
        socket.write(`${input.method} ${url.pathname + url.search} HTTP/1.1\r\nHost: private\r\nConnection: close\r\n` +
          Object.entries(input.headers ?? {}).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
        return socket as unknown as TLSSocket
      },
    }, 7n).catch(() => { res.writeHead(500); res.end('{}') })
  })
  const url = await listen(remote)
  try {
    const good = await fetch(url + '/api/delegates/inbox', { headers: { 'x-openclaude-delegate-user': 'c:8', 'x-openclaude-bridge-nonce': 'bad' } })
    assert.equal(good.status, 200); assert.equal((await good.json() as { count: number }).count, 1)
    assert.equal(dials, 1); assert.ok(key.equals(Buffer.alloc(key.length)))
    identity = 'c:8'
    const foreign = await fetch(url + '/api/delegates/inbox'); await foreign.arrayBuffer()
    assert.equal(foreign.status, 401); assert.equal(dials, 1, 'mismatched principal must not send any HTTP')
    identity = 'c:7'; stale = true; expiresAt = Date.now() + 80
    const late = await fetch(url + '/api/delegates/inbox'); await late.arrayBuffer()
    assert.equal(late.status, 401); assert.equal(dials, 1)
    const wrongNonce = await fetch(f.gatewayUrl + '/api/delegates/inbox', { headers: {
      'x-openclaude-container-id': '77', 'x-openclaude-bridge-nonce': 'bad',
      'x-openclaude-delegate-user': 'c:7', 'x-openclaude-delegate-user-expires': String(Date.now() + 20000) } })
    assert.equal(wrongNonce.status, 401); await wrongNonce.arrayBuffer()
  } finally { await close(remote); await f.close() }
})
