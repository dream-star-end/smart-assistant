/** Real Gateway HTTP + CcbAdapter/parser, synthetic SDK process (no model/CLI).
 * Proves native identity and lifecycle, NOT receipt ingestion/notification ACK. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withReceiptWriteBarrier } from '@openclaude/storage/receiptWriteBarrier'
import type { SubprocessRunner } from '../subprocessRunner.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import type { TurnParams } from '../engine/engineAdapter.js'

const home = mkdtempSync(join(tmpdir(), 'receipt-owner-http-'))
process.env.OPENCLAUDE_HOME = home
const { Gateway } = await import('../server.js')
const { CcbAdapter } = await import('../engine/ccbAdapter.js')
const { SubprocessRunner: NativeRunner } = await import('../subprocessRunner.js')
const { issueDelegateContextToken, DELEGATE_CONTEXT_HEADER } = await import('../delegateContext.js')
const { signJwt } = await import('../auth.js')
const { ReceiptOwnerCapabilities } = await import('../receiptOwnerCapability.js')

const TOKEN = 'receipt-http-test-only-token'
const SESSION = 'agent:main:webchat:dm:receipt-http'
const TURN = 'server-owned-turn-1'
class SdkProcess extends EventEmitter {
  sessionId = 'native-ccb-session'
  isRunning = true
  receiptProcessIdentity: object = {}
  beforeInput?: () => void
  afterInput?: () => void
  submitGate: Promise<void> = Promise.resolve()
  shutdownGate: Promise<void> = Promise.resolve()
  setConsultTurn(): void {}
  async submit(_input?: unknown, _requestId?: string, _authority?: unknown, _turn?: string,
    onInput?: (identity: object) => void): Promise<void> {
    await this.submitGate
    this.beforeInput?.()
    onInput?.(this.receiptProcessIdentity)
    this.afterInput?.()
  }
  interrupt(): boolean { return true }
  async shutdown(): Promise<void> { await this.shutdownGate; this.isRunning = false }
  tool(id: string, name = 'Bash', parent?: string, input: Record<string, unknown> = {}): void {
    this.emit('message', { type: 'assistant', parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', id, name, input }] } })
  }
}
function makeAdapter(harness: 'ccb' | 'official-cc' = 'ccb') {
  const process = new SdkProcess()
  const adapter = new CcbAdapter({ harness } as EngineCreateOpts, process as unknown as SubprocessRunner)
  return { process, adapter }
}
function start(adapter: InstanceType<typeof CcbAdapter>, turnKey: string | undefined = TURN) {
  return adapter.submitTurn({ input: 'synthetic SDK test', turnKey, onEvent: () => {},
    sessionTotals: { totalCostUSD: 0, turns: 0, _lastCcbCumulativeCost: 0 },
    toolUseIdToName: new Map(),
  } as TurnParams)
}
async function fixture(userId = 'default') {
  const { process, adapter } = makeAdapter()
  const turn = start(adapter)
  await turn.submitted
  const parent = { agentId: 'main', sessionKey: SESSION, userId, _currentTurnKey: TURN, runner: adapter }
  let visibleParent: typeof parent | undefined = parent
  const gw = new Gateway({
    config: { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: TOKEN },
      auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(home, 'sessions.db') },
      defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } },
    } as never,
    agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }], routes: [], default: 'main' },
  })
  // Only session lookup is a fixture. Request dispatch, auth, adapter and parser are real.
  ;(gw as any).sessions = { getByKey: (key: string) => key === SESSION ? visibleParent : undefined }
  const server = createServer((req, res) => (gw as any).handleHttp(req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const context = issueDelegateContextToken({ agentId: 'main', sessionKey: SESSION, depth: 0 })
  async function post(action: string, body: unknown, overrides: Record<string, string> = {}, method = 'POST') {
    const response = await fetch(`http://127.0.0.1:${port}/api/delegate/receipt-owner/${action}`, {
      method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json',
        [DELEGATE_CONTEXT_HEADER]: context, ...overrides },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, data: await response.json() as any, cache: response.headers.get('cache-control') }
  }
  async function partialPost(action: string, body: unknown, authorization: string, completeAt: number, signedContext = context) {
    const bytes = JSON.stringify(body)
    let atDispatch = 0
    let atCompletion = 0
    const result = await new Promise<{ status: number; data: any }>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const req = request(`http://127.0.0.1:${port}/api/delegate/receipt-owner/${action}`, {
        method: 'POST', headers: { authorization, 'content-type': 'application/json',
          'content-length': Buffer.byteLength(bytes), [DELEGATE_CONTEXT_HEADER]: signedContext },
      }, res => {
        let text = ''
        res.setEncoding('utf8'); res.on('data', chunk => { text += chunk })
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode!, data: JSON.parse(text) }) })
      })
      req.on('error', reject)
      req.setTimeout(6000, () => req.destroy(new Error('partial-body test watchdog')))
      // This listener runs after the actual Gateway.handleHttp listener has
      // entered authentication/readBody; no auth or clock is mocked.
      server.once('request', () => {
        atDispatch = Date.now()
        timer = setTimeout(() => { atCompletion = Date.now(); req.end(bytes.slice(1)) }, Math.max(1, completeAt - Date.now()))
      })
      req.write(bytes.slice(0, 1))
    })
    return { ...result, atDispatch, atCompletion }
  }
  async function issue(id = 'creator') {
    const result = await post('issue', { toolUseId: id })
    assert.equal(result.status, 200, JSON.stringify(result.data))
    assert.equal(typeof result.data.capability, 'string')
    assert.equal(result.cache, 'no-store')
    return result.data.capability as string
  }
  return { url: `http://127.0.0.1:${port}`, gw, process, adapter, turn, parent, post, partialPost, issue, context,
    caps: (gw as unknown as { _receiptOwnerCapabilities: InstanceType<typeof ReceiptOwnerCapabilities> })._receiptOwnerCapabilities,
    hideParent: () => { visibleParent = undefined },
    close: async () => { turn.end(); clearTimeout((gw as any)._receiptCandidateTimer); await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}
const jwt = (userId: string) => `Bearer ${signJwt({ userId, exp: Math.floor(Date.now() / 1000) + 3600 }, TOKEN)}`

const storage = await import('../../../storage/src/sessionsDb.js')
async function seed(id: string, userId: string) {
  await storage.upsertClientSession({ id, userId, agentId: 'main', title: 'private F2 test', pinned: false,
    createdAt: 1000, lastAt: 1000, updatedAt: 1000, messages: [] })
}
async function requestSession(f: Awaited<ReturnType<typeof fixture>>, path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(f.url + path, { method, headers: { authorization: jwt('c:3'), 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() as any }
}

for (const route of ['single', 'batch', 'compensate'] as const) test(`real ${route} transaction deletion fences only owned candidates and revokes the old receipt owner`, async () => {
  const f = await fixture('c:3')
  const owned = route === 'compensate' ? 'wsess-0123456789abcdef' : `f2-${route}-owned`, foreign = `f2-${route}-foreign`, stale = `f2-${route}-stale`
  const env = { bridge: process.env.OPENCLAUDE_TRUST_BRIDGE_IP, container: process.env.OC_CONTAINER_ID, nonce: process.env.OPENCLAUDE_INBOUND_NONCE }
  try {
    await seed(owned, 'c:3'); await seed(foreign, 'c:4'); await seed(stale, 'c:3')
    Object.assign(f.parent, { channel: 'webchat', peerId: owned })
    f.process.tool('creator'); const cap = await f.issue()
    const claim = f.caps.verify(cap)!
    const dir = join(home, 'receipt-candidates-v1', 'data', claim.locatorPartition)
    const before = await requestSession(f, '/api/sessions/' + foreign, 'DELETE')
    assert.equal(before.status, 200); assert.equal(before.body.receiptCandidateCleanup.state, 'not_applicable')
    const rejected = await requestSession(f, '/api/sessions/batch', 'POST', { ids: [stale], action: 'delete',
      expectedSessions: [{ id: stale, updatedAt: 1, projectId: null }], operationId: 'f2-stale' })
    assert.equal(rejected.status, 409); assert.ok(existsSync(dir))
    let deleted: { status: number; body: any }
    if (route === 'single') deleted = await requestSession(f, '/api/sessions/' + owned, 'DELETE')
    else if (route === 'batch') deleted = await requestSession(f, '/api/sessions/batch', 'POST', { ids: [owned, foreign], action: 'delete' })
    else {
      process.env.OPENCLAUDE_TRUST_BRIDGE_IP = '127.0.0.1'; process.env.OC_CONTAINER_ID = '3'; process.env.OPENCLAUDE_INBOUND_NONCE = 'a'.repeat(43)
      deleted = await requestSession(f, '/internal/v3/wechat-inbound-compensate', 'POST', { sessionId: owned, bindingUserId: '3', reason: 'step2a_failed' },
        { 'x-openclaude-container-id': '3', 'x-openclaude-inbound-nonce': 'a'.repeat(43) })
    }
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
    assert.equal(deleted.body.receiptCandidateCleanup.state, 'complete')
    assert.equal(existsSync(dir), false)
    const states = await storage.classifyClientSessions([{ sessionId: owned, userId: 'c:3' }, { sessionId: foreign, userId: 'c:4' }, { sessionId: stale, userId: 'c:3' }])
    assert.deepEqual(states.map(s => s.state), ['deleted', 'active', 'active'])
    assert.equal((await f.post('check', { capability: cap })).data.ownerState, 'inactive')
    assert.equal((await f.post('refresh', { capability: cap })).status, 409)
    assert.equal((await f.post('issue', { toolUseId: 'creator' })).status, 409)
    assert.equal(f.adapter.getReceiptToolOwner('creator'), null)
    const repeated = await requestSession(f, '/api/sessions/' + owned, 'DELETE')
    assert.equal(repeated.body.receiptCandidateCleanup.state, 'complete')
    assert.equal(existsSync(dir), false)
  } finally {
    for (const [key, val] of [['OPENCLAUDE_TRUST_BRIDGE_IP', env.bridge], ['OC_CONTAINER_ID', env.container], ['OPENCLAUDE_INBOUND_NONCE', env.nonce]] as const) {
      if (val === undefined) delete process.env[key]; else process.env[key] = val
    }
    await f.close()
  }
})

test('mapped missing client row refuses new receipt authority without inferring deletion', async () => {
  const f = await fixture('c:3')
  try {
    Object.assign(f.parent, { channel: 'webchat', peerId: 'f2-truly-missing' })
    f.process.tool('creator')
    assert.equal((await f.post('issue', { toolUseId: 'creator' })).status, 503)
    assert.equal((await storage.classifyClientSessions([{ sessionId: 'f2-truly-missing', userId: 'c:3' }]))[0]?.state, 'missing')
    const files = existsSync(join(home, 'receipt-candidates-v1', 'deleted')) ? readdirSync(join(home, 'receipt-candidates-v1', 'deleted')) : []
    const { receiptCandidateDeletionKey } = await import('@openclaude/storage/receiptCandidateLifecycle')
    assert.equal(files.includes(receiptCandidateDeletionKey({ userId: 'c:3', clientSessionId: 'f2-truly-missing' }) + '.json'), false)
  } finally { await f.close() }
})


test('accepted SQL deletion behind a real writer lock reports pending then original timer cleans without late registration', { timeout: 45000 }, async () => {
  const f = await fixture('c:3'), id = 'f2-locked-delete'
  let release!: () => void, entered!: () => void
  let holder: Promise<unknown> | undefined
  let watcher: import('node:fs').FSWatcher | undefined, deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await seed(id, 'c:3'); Object.assign(f.parent, { channel: 'webchat', peerId: id })
    f.process.tool('creator'); const cap = await f.issue(), claims = f.caps.verify(cap)!
    const root = join(home, 'receipt-candidates-v1'), data = join(root, 'data', claims.locatorPartition)
    let timerSweeps = 0
    const actualSweep = (f.gw as any)._sweepReceiptCandidates.bind(f.gw)
    ;(f.gw as any)._sweepReceiptCandidates = () => { timerSweeps++; return actualSweep() }
    const ready = new Promise<void>(r => { entered = r }), gate = new Promise<void>(r => { release = r })
    holder = withReceiptWriteBarrier(join(root, 'barrier.lock'), async () => { entered(); await gate })
    await ready
    const deleted = await requestSession(f, '/api/sessions/' + id, 'DELETE')
    assert.equal(deleted.status, 200); assert.equal(deleted.body.receiptCandidateCleanup.state, 'pending')
    assert.equal((await storage.classifyClientSessions([{ sessionId: id, userId: 'c:3' }]))[0]?.state, 'deleted')
    assert.ok(existsSync(data))
    const { watch } = await import('node:fs')
    const removed = new Promise<void>((resolve, reject) => {
      watcher = watch(join(root, 'data'), () => { if (!existsSync(data)) resolve() })
      deadline = setTimeout(() => reject(new Error('actual 30s candidate retry missed deletion')), 35000)
    })
    release(); await holder; await removed
    assert.ok(timerSweeps >= 1, 'must observe the actual scheduled sweep, not a second HTTP cleanup')
    assert.equal(existsSync(data), false)
  } finally { release?.(); await holder; watcher?.close(); clearTimeout(deadline); await f.close() }
})

test('fresh gateway sweep resumes SQL-only deletion even with live old process and no parent lookup', async () => {
  const f = await fixture('c:3'), id = 'f2-sql-before-fs'
  const fresh = new Gateway((f.gw as any).deps) as any
  try {
    await seed(id, 'c:3'); Object.assign(f.parent, { channel: 'webchat', peerId: id })
    f.process.tool('creator'); const cap = await f.issue(), claims = f.caps.verify(cap)!
    const data = join(home, 'receipt-candidates-v1', 'data', claims.locatorPartition)
    assert.equal(await storage.deleteClientSession(id, 'c:3'), true)
    assert.ok(existsSync(data)); assert.equal(f.process.isRunning, true)
    fresh.sessions = { getByKey: () => undefined }
    await fresh._sweepReceiptCandidates()
    assert.equal(existsSync(data), false)
    const m = JSON.parse(readFileSync(join(home, 'receipt-candidates-v1', 'namespaces', claims.locatorPartition + '.json'), 'utf8'))
    assert.deepEqual(m.deletionRef, { userId: 'c:3', clientSessionId: id })
  } finally { clearTimeout(fresh._receiptCandidateTimer); await f.close() }
})

test('actual SQLite lookup failure retains candidate data and returns unknown without deletion fence', async () => {
  const f = await fixture('c:3'), id = 'f2-query-failure'
  const Database = (await import('better-sqlite3')).default
  let db: InstanceType<typeof Database> | undefined, renamed = false
  try {
    await seed(id, 'c:3'); Object.assign(f.parent, { channel: 'webchat', peerId: id })
    f.process.tool('creator'); const cap = await f.issue(), claims = f.caps.verify(cap)!
    const data = join(home, 'receipt-candidates-v1', 'data', claims.locatorPartition)
    db = new Database(join(home, 'sessions.db'), { fileMustExist: true })
    db.exec('ALTER TABLE client_sessions RENAME TO f2_private_unavailable'); renamed = true
    assert.equal((await f.post('check', { capability: cap })).data.ownerState, 'unknown')
    await (f.gw as any)._sweepReceiptCandidates()
    assert.ok(existsSync(data))
    const { receiptCandidateDeletionKey } = await import('@openclaude/storage/receiptCandidateLifecycle')
    assert.equal(existsSync(join(home, 'receipt-candidates-v1', 'deleted', receiptCandidateDeletionKey({ userId: 'c:3', clientSessionId: id }) + '.json')), false)
  } finally {
    if (renamed) db!.exec('ALTER TABLE f2_private_unavailable RENAME TO client_sessions')
    db?.close(); await f.close()
  }
})
