/** D5-B1: real HTTP admission + SQLite rejection must not strand capacity. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Gateway } from '../server.js'
import { CcbAdapter } from '../engine/ccbAdapter.js'
import { DelegateDurableDb } from '../delegateDurable.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { issueDelegateContextToken } from '../delegateContext.js'

const SESSION = 'agent:main:webchat:dm:receipt-create-cleanup'
const TURN = 'receipt-create-cleanup-turn'

for (const mode of ['slot', 'waiter', 'sqlite-abort'] as const) {
  test(`receipt create rejection releases its ${mode} reservations and fresh request succeeds`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-create-cleanup-'))
    const keys = ['OPENCLAUDE_HOME', 'OC_DELEGATE_SM', 'OC_DELEGATE_DURABLE'] as const
    const old = keys.map(key => process.env[key])
    process.env.OPENCLAUDE_HOME = dir
    process.env.OC_DELEGATE_SM = '1'
    process.env.OC_DELEGATE_DURABLE = '1'
    const token = randomBytes(32).toString('hex')
    const nonce = randomBytes(32).toString('hex')
    const nonceHash = createHash('sha256').update(nonce).digest('hex')
    const sdk = new class extends EventEmitter {
      sessionId = 'native-cleanup-session'
      isRunning = true
      receiptProcessIdentity = {}
      setConsultTurn() {}
      async submit(_a: unknown, _b: unknown, _c: unknown, _d: unknown, bind: (p: object) => void) { bind(this.receiptProcessIdentity) }
      interrupt() { return true }
      async shutdown() { this.isRunning = false }
    }()
    const adapter = new CcbAdapter({ harness: 'ccb' } as never, sdk as never)
    const turn = adapter.submitTurn({ input: 'cleanup test', turnKey: TURN, onEvent() {},
      sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map() })
    await turn.submitted
    sdk.emit('message', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'creator', name: 'Bash', input: {} }] } })
    const db = new DelegateDurableDb(join(dir, 'delegate-jobs.db'))
    const jobs = new DelegateJobStore({ durable: db, sm: true, deliveryReceipts: true })
    const seeded = jobs.create('coding-assistant', { idempotencyKey: 'existing-idempotency', callback: 'stdout-wait',
      callbackOriginUserId: 'default', parentSessionKey: SESSION,
      deliveryReceipt: { parentTurnKey: TURN, nativeToolUseId: 'creator', receiptNonceHash: nonceHash } })
    assert.ok('jobId' in seeded)
    const initial = jobs.snapshotOf(seeded.jobId)!
    assert.ok(jobs.complete(seeded.jobId, { httpStatus: 200, body: { output: 'original' } },
      { claimToken: initial.claimToken!, fencingEpoch: initial.fencingEpoch }))
    const gw = new Gateway({ config: { version: 1, gateway: { bind: '127.0.0.1', port: 0, accessToken: token },
      auth: { mode: 'subscription', claudeCodePath: '' }, sessions: { dbPath: join(dir, 'sessions.db') },
      defaults: { model: 'glm-5.2', permissionMode: 'default' }, channels: { webchat: { enabled: true } } } as never,
      agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }], routes: [], default: 'main' } })
    const parent = { userId: 'default', sessionKey: SESSION, agentId: 'main', _currentTurnKey: TURN, runner: adapter }
    ;(gw as any).sessions = { getByKey: (key: string) => key === SESSION ? parent : undefined }
    ;(gw as any)._delegateJobs = jobs
    ;(gw as any)._delegateReconcileReady = true
    ;(gw as any)._readDelegateMemoryPressure = () => null
    let executions = 0
    ;(gw as any)._runDelegateTask = async (input: any) => {
      executions++
      const claim = jobs.claimQueued(input.backgroundJobId)
      assert.ok(claim.ok)
      input.claimToken = claim.claimToken; input.fencingEpoch = claim.fencingEpoch
      ;(gw as any)._releasePreadmittedDelegateCapacity(input)
      return { kind: 'completed', ok: true, output: 'fresh request executed', sessionKey: input.sessionKey }
    }
    const server = createServer((req, res) => { void (gw as any).handleHttp(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      'x-openclaude-delegate-context': issueDelegateContextToken({ agentId: 'main', sessionKey: SESSION, depth: 0 }) }
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers,
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      return { status: response.status, body: await response.json() as any }
    }
    const rawDb = (db as any).db
    const observe = () => ({ active: (gw as any)._activeDelegations,
      parent: (gw as any)._runningDelegationsByParent?.get(SESSION) ?? 0,
      waiters: (gw as any)._delegateQueueWaiters?.size ?? 0,
      reserved: (gw as any)._delegateResume?.reservedSize() ?? 0,
      jobs: rawDb.prepare('SELECT COUNT(*) n FROM delegate_jobs').get().n, executions })
    const slotOptions = { parentBucketKey: SESSION, isReview: false }
    let protectedSlots = 0
    try {
      if (mode === 'waiter') {
        while (!(gw as any)._tryReserveDelegateSlot(slotOptions)) protectedSlots++
        ;(gw as any)._delegateQueueWaiters = new Map([['unrelated-waiter', () => {}]])
        assert.ok(protectedSlots > 0)
      }
      if (mode === 'sqlite-abort') rawDb.exec("CREATE TRIGGER reject_receipt_insert BEFORE INSERT ON delegate_jobs BEGIN SELECT RAISE(ABORT,'test create write failure'); END")
      const issued = await post('/api/delegate/receipt-owner/issue', { toolUseId: 'creator' })
      assert.equal(issued.status, 200)
      const capability = issued.body.capability
      const before = observe()
      const requests = mode === 'sqlite-abort' ? 1 : 14
      for (let index = 0; index < requests; index++) {
        const rejected = await post('/api/agents/coding-assistant/delegate', { goal: 'must reject without dispatch', async: true,
          ...(mode !== 'sqlite-abort' ? { idempotencyKey: 'existing-idempotency' } : {}),
          receipt: { capability, receiptNonce: '1'.repeat(64) } })
        assert.equal(rejected.status, 500, JSON.stringify(rejected.body))
        assert.deepEqual(observe(), before, `rejection ${index} leaked resources`)
      }
      const binding = JSON.parse(rawDb.prepare('SELECT delivery_receipt_context FROM delegate_jobs WHERE job_id=?').get(seeded.jobId).delivery_receipt_context)
      assert.equal(binding.receiptNonceHash, nonceHash)
      assert.equal(binding.nativeToolUseId, 'creator')
      assert.equal(executions, 0)
      if (mode === 'sqlite-abort') rawDb.exec('DROP TRIGGER reject_receipt_insert')
      if (mode === 'waiter') {
        assert.ok((gw as any)._delegateQueueWaiters.has('unrelated-waiter'))
        for (let i = 0; i < protectedSlots; i++) (gw as any)._releaseDelegateSlot(slotOptions)
        protectedSlots = 0
        ;(gw as any)._delegateQueueWaiters.delete('unrelated-waiter')
      }
      const fresh = await post('/api/agents/coding-assistant/delegate', { goal: 'valid after rejected creates', async: true,
        receipt: { capability, receiptNonce: '2'.repeat(64) } })
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body))
      const freshJob = jobs.snapshotOf(fresh.body.jobId)
      assert.equal(freshJob?.state, 'completed')
      assert.equal(freshJob.result?.body.output, 'fresh request executed')
      assert.equal(executions, 1)
      assert.equal(observe().jobs, before.jobs + 1)
      assert.equal(observe().active, 0)
      assert.equal(observe().waiters, 0)
    } finally {
      turn.end(); server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      jobs.close()
      keys.forEach((key, i) => { if (old[i] === undefined) delete process.env[key]; else process.env[key] = old[i] })
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
