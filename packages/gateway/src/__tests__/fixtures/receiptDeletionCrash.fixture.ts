/** Private process fixture: actual HTTP SQL commit, abrupt death, actual start() receipt-sweep prefix. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Gateway } from '../../server.js'
import { CcbAdapter } from '../../engine/ccbAdapter.js'
import { issueDelegateContextToken } from '../../delegateContext.js'
import { upsertClientSession, classifyClientSessions } from '../../../../storage/src/sessionsDb.js'

const home = process.env.OPENCLAUDE_HOME!
assert.ok(home && home.includes('f2-crash-private-'))
const sessionKey = 'agent:main:webchat:dm:f2-crash', token = 'private-crash-http-token'
const gw = new Gateway({ config: { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: token },
  auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(home, 'sessions.db') },
  defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } } } as never,
  agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }], routes: [], default: 'main' } }) as any
const emit = (record: object) => process.stdout.write(JSON.stringify(record) + '\n')

async function run() {
  if (process.argv[2] === 'boot') {
    const stop = new Error('PRIVATE_AFTER_RECEIPT_BOOT_PREFIX')
    const actual = gw._sweepReceiptCandidates.bind(gw)
    let calls = 0
    gw._sweepReceiptCandidates = async () => {
      await actual(); calls++
      emit({ phase: 'boot-swept', calls, exists: existsSync(process.argv[3]!) })
      throw stop // stop before unrelated listeners/services, not a full master boot test
    }
    try { await gw.start(); throw new Error('start omitted receipt sweep') }
    catch (error) { if (error !== stop) throw error }
    clearTimeout(gw._receiptCandidateTimer)
    process.exit(0)
  }
  await upsertClientSession({ id: 'f2-crash', userId: 'default', agentId: 'main', title: 'private crash test', pinned: false,
    createdAt: 1000, lastAt: 1000, updatedAt: 1000, messages: [] })
  const sdk = new class extends EventEmitter {
    sessionId = 'f2-crash-native'; isRunning = true; receiptProcessIdentity = { pid: process.pid }
    setConsultTurn() {}
    async submit(_a: unknown, _b: unknown, _c: unknown, _d: unknown, bind: (p: object) => void) { bind(this.receiptProcessIdentity) }
    interrupt() { return true }
  }()
  const adapter = new CcbAdapter({ harness: 'ccb' } as never, sdk as never)
  const turn = adapter.submitTurn({ input: 'private synthetic SDK', turnKey: 'f2-crash-turn', onEvent() {},
    sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() })
  await turn.submitted
  sdk.emit('message', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'creator', name: 'Bash', input: {} }] } })
  const parent = { userId: 'default', channel: 'webchat', peerId: 'f2-crash', agentId: 'main', sessionKey,
    _currentTurnKey: 'f2-crash-turn', runner: adapter }
  gw.sessions = { getByKey: (key: string) => key === sessionKey ? parent : undefined }
  const server = createServer((req, res) => { void gw.handleHttp(req, res) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json',
    'x-openclaude-delegate-context': issueDelegateContextToken({ agentId: 'main', sessionKey, depth: 0 }) }
  const issued = await fetch(url + '/api/delegate/receipt-owner/issue', { method: 'POST', headers, body: '{"toolUseId":"creator"}' })
  assert.equal(issued.status, 200)
  const body = await issued.json() as any, partition = gw._receiptOwnerCapabilities.verify(body.capability).locatorPartition
  const data = join(home, 'receipt-candidates-v1', 'data', partition)
  assert.ok(existsSync(data))
  gw._cleanupDeletedReceiptCandidates = async () => {
    const state = await classifyClientSessions([{ userId: 'default', sessionId: 'f2-crash' }])
    assert.equal(state[0]?.state, 'deleted'); assert.ok(existsSync(data))
    emit({ phase: 'sql-before-fs', data, partition, state: state[0]?.state })
    await new Promise(() => {}) // killed by parent; no cleanup/finally can run
  }
  await fetch(url + '/api/sessions/f2-crash', { method: 'DELETE', headers })
  throw new Error('delete gate unexpectedly returned')
}
run().catch(error => { console.error(error); process.exit(1) })
