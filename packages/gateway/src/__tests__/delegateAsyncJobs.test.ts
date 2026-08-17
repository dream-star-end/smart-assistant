/**
 * Gateway HTTP: `/delegate` async job + `/delegate/wait` long-poll.
 * Drives real handleDelegateTask / handleDelegateWait on an Object.create
 * Gateway.prototype stub (same scaffold as memberDelegateLimit.test.ts).
 *
 * Covers: 45s-window complete via wait, timeout returns jobId, wait later
 * yields the final result, TTL expiry. Short constants; submit is a barrier.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateAsyncJobs.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DelegateJobStore } from '../delegateJobs.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-async-delegate'

function makeGateway(holdSubmit = false): any {
  const agent = { id: 'main', provider: 'anthropic', model: 'glm-5.2' }
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw._activeDelegations = 0
  gw._activeDelegationsByParent = new Map()
  gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.deps = {
    config: {
      version: 1,
      provider: 'anthropic',
      gateway: { bind: '127.0.0.1', port: 18789, accessToken: 'test' },
      auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
      defaults: { model: 'glm-5.2', permissionMode: 'default' },
      channels: { webchat: { enabled: true } },
    },
  }
  gw._getAgentsConfig = async () => ({
    default: 'main',
    agents: [agent, { id: 'hidden-reviewer' }, { id: 'coding-assistant' }],
  })
  gw._runLog = { start: () => ({}), complete: () => {} }
  let releaseHold!: () => void
  gw._holdGate = holdSubmit
    ? new Promise<void>((res) => {
        releaseHold = res
      })
    : Promise.resolve()
  gw._releaseHold = () => releaseHold?.()
  gw.sessions = {
    destroySession: async () => {},
    getByKey: () => ({ _teamModeTurn: true, _currentTurnUserText: '测试任务' }),
    getOrCreate: async () => ({
      agentId: 'coding-assistant',
      currentTurnStatus: null,
      runner: { interrupt: () => {}, sendPermissionResponse: () => {}, on: () => {}, off: () => {} },
    }),
    submit: async (_session: unknown, _payload: string, onEvent: (e: any) => void) => {
      onEvent({ kind: 'block', block: { kind: 'text', text: '子任务完成' } })
      await gw._holdGate
      onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
    },
    bufferPendingAgentGroup: () => true,
  }
  gw.deliver = () => {}
  return gw
}

async function call(
  gw: any,
  method: 'handleDelegateTask' | 'handleDelegateWait',
  body: Record<string, unknown>,
  targetAgentId = 'coding-assistant',
): Promise<{ status: number; body: any }> {
  const req: any = { method: 'POST', headers: {} }
  gw.readBody = async () => JSON.stringify(body)
  let status = 0
  let raw = ''
  const res: any = {
    writeHead: (code: number) => {
      status = code
    },
    end: (chunk?: unknown) => {
      raw = String(chunk ?? '')
    },
  }
  if (method === 'handleDelegateTask') await gw.handleDelegateTask(req, res, targetAgentId)
  else await gw.handleDelegateWait(req, res)
  return { status, body: raw ? JSON.parse(raw) : {} }
}

describe('handleDelegateTask async + handleDelegateWait', () => {
  it('default sync path is unchanged: no jobId, 200 + ok/output', async () => {
    const gw = makeGateway(false)
    const r = await call(gw, 'handleDelegateTask', {
      goal: '快任务',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.output, '子任务完成')
    assert.equal(r.body.jobId, undefined)
    assert.equal(r.body.status, undefined)
  })

  it('async:true returns jobId immediately while the child is still running', async () => {
    const gw = makeGateway(true)
    const started = Date.now()
    const r = await call(gw, 'handleDelegateTask', {
      goal: '慢任务',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      async: true,
    })
    const elapsed = Date.now() - started
    assert.ok(elapsed < 500, `async start should not block on the child; elapsed=${elapsed}`)
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'running')
    assert.equal(typeof r.body.jobId, 'string')
    assert.match(r.body.jobId, /^dlgjob-/)
    const still = await call(gw, 'handleDelegateWait', { jobId: r.body.jobId, waitMs: 30 })
    assert.equal(still.status, 200)
    assert.equal(still.body.status, 'running')
    assert.equal(still.body.jobId, r.body.jobId)
    gw._releaseHold()
  })

  it('wait later returns the full sync-shaped result', async () => {
    const gw = makeGateway(true)
    const start = await call(gw, 'handleDelegateTask', {
      goal: '慢任务',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      async: true,
    })
    const jobId = start.body.jobId as string
    const pending = call(gw, 'handleDelegateWait', { jobId, waitMs: 2_000 })
    setTimeout(() => gw._releaseHold(), 20)
    const waited = await pending
    assert.equal(waited.status, 200)
    assert.equal(waited.body.status, 'done')
    assert.equal(waited.body.ok, true)
    assert.equal(waited.body.output, '子任务完成')
    assert.equal(waited.body.jobId, jobId)
    assert.equal(waited.body.httpStatus, 200)
  })

  it('TTL expiry: wait on an expired job returns 404 expired', async () => {
    const gw = makeGateway(false)
    let now = 1_000
    gw._delegateJobs = new DelegateJobStore({ ttlMs: 50, now: () => now })
    const created = gw._delegateJobs.create('coding-assistant')
    now = 1_100
    const r = await call(gw, 'handleDelegateWait', { jobId: created.jobId, waitMs: 30 })
    assert.equal(r.status, 404)
    assert.equal(r.body.status, 'expired')
    assert.match(String(r.body.error), /expired/)
  })

  it('wait on an unknown jobId is expired, not a hang', async () => {
    const gw = makeGateway(false)
    const r = await call(gw, 'handleDelegateWait', { jobId: 'dlgjob-nope', waitMs: 30 })
    assert.equal(r.status, 404)
    assert.equal(r.body.status, 'expired')
  })
})
