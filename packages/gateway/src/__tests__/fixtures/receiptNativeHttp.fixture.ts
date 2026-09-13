/** Isolated Node gateway for real Bun/native integration, never a live service.
 * Actual HTTP/auth/parser/SQLite; session lookup and SDK process are synthetic. */
import { EventEmitter } from 'node:events'
import { randomBytes, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { Gateway } from '../../server.js'
import { CcbAdapter } from '../../engine/ccbAdapter.js'
import { DelegateDurableDb } from '../../delegateDurable.js'
import { DelegateJobStore } from '../../delegateJobs.js'
import { issueDelegateContextToken } from '../../delegateContext.js'

const [dir, nativeSession] = process.argv.slice(2)
if (!dir || !nativeSession) throw new Error('private dir and native session required')
const token = randomBytes(32).toString('hex')
const nonce = randomBytes(32).toString('hex')
const parentSession = 'agent:main:webchat:dm:native-http-fixture'
const turnKey = 'fixture-parent-turn'
class Sdk extends EventEmitter {
  sessionId = nativeSession
  isRunning = true
  receiptProcessIdentity = {}
  setConsultTurn() {}
  async submit(_a: unknown, _b: unknown, _c: unknown, _d: unknown, bind: (p: object) => void) { bind(this.receiptProcessIdentity) }
  interrupt() { return true }
  async shutdown() { this.isRunning = false }
}
const sdk = new Sdk()
const adapter = new CcbAdapter({ harness: 'ccb' } as never, sdk as never)
const turn = adapter.submitTurn({ input: 'paired test', turnKey, onEvent() {},
  sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() })
await turn.submitted
for (const id of ['creator', 'waiter']) sdk.emit('message', { type: 'assistant', message: {
  content: [{ type: 'tool_use', id, name: 'Bash', input: {} }],
} })
const owner = adapter.getReceiptToolOwner('creator')
if (!owner) throw new Error('actual adapter owner unavailable')
const dbPath = join(dir, 'delegate-jobs.db')
const db = new DelegateDurableDb(dbPath)
const jobs = new DelegateJobStore({ durable: db, sm: true, deliveryReceipts: true })
const made = jobs.create('worker', { callback: 'stdout-wait', callbackOriginUserId: 'default', parentSessionKey: parentSession,
  deliveryReceipt: { parentTurnKey: owner.turnKey, nativeToolUseId: owner.consumerToolUseId,
    receiptNonceHash: createHash('sha256').update(nonce).digest('hex') } })
if (!('jobId' in made)) throw new Error('job admission failed')
const snapshot = jobs.snapshotOf(made.jobId)!
if (!jobs.complete(made.jobId, { httpStatus: 200, body: { output: 'AUTHORITATIVE_NATIVE_RESULT', sessionKey: 'child-session' } },
  { claimToken: snapshot.claimToken!, fencingEpoch: snapshot.fencingEpoch })) throw new Error('job complete failed')
const gw = new Gateway({ config: { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: token },
  auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(dir, 'sessions.db') },
  defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } } } as never,
  agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }], routes: [], default: 'main' } })
const parent = { userId: 'default', sessionKey: parentSession, agentId: 'main', _currentTurnKey: turnKey, runner: adapter }
let visible = true
;(gw as any).sessions = { getByKey: (key: string) => visible && key === parentSession ? parent : undefined }
;(gw as any)._delegateJobs = jobs
const server = createServer((req, res) => { void (gw as any).handleHttp(req, res) })
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const contextFile = join(dir, 'context')
const tokenFile = join(dir, 'token')
writeFileSync(contextFile, issueDelegateContextToken({ agentId: 'main', sessionKey: parentSession, depth: 0 }), { mode: 0o600 })
writeFileSync(tokenFile, token, { mode: 0o600 })
process.stdout.write('PAIR_READY ' + JSON.stringify({ port, dbPath, contextFile, tokenFile, jobId: made.jobId, generation: 0,
  receiptNonce: nonce, epoch: owner.parentOwnerEpoch }) + '\n')
const reader = createInterface({ input: process.stdin })
reader.on('line', async line => {
  const command = JSON.parse(line)
  if (command.action === 'stop') adapter.interrupt()
  if (command.action === 'hide') visible = false
  if (command.action === 'change-turn') parent._currentTurnKey = 'other-turn'
  if (command.action === 'late-tool') setTimeout(() => sdk.emit('message', { type: 'assistant', message: {
    content: [{ type: 'tool_use', id: 'late-waiter', name: 'Bash', input: {} }],
  } }), 100)
  if (command.action === 'corrupt') (db as any).db.prepare("UPDATE delegate_jobs SET result_json=? WHERE job_id=?")
    .run('{"httpStatus":200,"body":{"output":"TAMPERED"}}', made.jobId)
  if (command.action === 'exit') {
    turn.end(); reader.close(); server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    jobs.close(); process.stdout.write('PAIR_ACK exit\n'); process.stdin.destroy(); return
  }
  process.stdout.write('PAIR_ACK ' + command.action + '\n')
})
