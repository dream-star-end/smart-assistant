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
import {
  DELEGATE_CONTEXT_HEADER,
  issueDelegateContextToken,
  resetDelegateContextKeyForTests,
} from '../delegateContext.js'
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
    getOrCreate: async (opts: any) => {
      gw._created = [...(gw._created ?? []), opts]
      return {
        agentId: opts?.agent?.id ?? 'coding-assistant',
        currentTurnStatus: null,
        runner: { interrupt: () => {}, sendPermissionResponse: () => {}, on: () => {}, off: () => {} },
      }
    },
    retireKeepResume: async (key: string) => {
      gw._retiredKeys = [...(gw._retiredKeys ?? []), key]
    },
    forgetResume: () => {},
    submit: async (
      _session: unknown,
      _payload: string,
      onEvent: (e: any) => void,
      effort?: string,
      model?: string,
    ) => {
      gw._submitted = [...(gw._submitted ?? []), { effort, model }]
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
  headers: Record<string, string> = {},
  opts: { autoContext?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const reqHeaders = { ...headers }
  if (
    method === 'handleDelegateTask' &&
    body.async === true &&
    opts.autoContext !== false &&
    !reqHeaders[DELEGATE_CONTEXT_HEADER]
  ) {
    reqHeaders[DELEGATE_CONTEXT_HEADER] = issueDelegateContextToken({
      agentId: 'main',
      sessionKey: PARENT_KEY,
      depth: 0,
    })
  }
  const req: any = { method: 'POST', headers: reqHeaders }
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

  it('TTL starts after completion: running survives, retained result later expires', async () => {
    const gw = makeGateway(false)
    let now = 1_000
    gw._delegateJobs = new DelegateJobStore({ ttlMs: 50, now: () => now })
    const created = gw._delegateJobs.create('coding-assistant')
    now = 1_100
    const running = await call(gw, 'handleDelegateWait', { jobId: created.jobId, waitMs: 30 })
    assert.equal(running.status, 200)
    assert.equal(running.body.status, 'running')
    gw._delegateJobs.complete(created.jobId, {
      httpStatus: 200,
      body: { ok: true, output: 'done' },
    })
    now = 1_151
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

  it('async start and wait-running share the minted sessionKey', async () => {
    const gw = makeGateway(true)
    const r = await call(gw, 'handleDelegateTask', {
      goal: '慢任务',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      async: true,
    })
    assert.equal(r.status, 200)
    assert.equal(typeof r.body.sessionKey, 'string')
    assert.match(String(r.body.sessionKey), /^agent:coding-assistant:delegate:main:\d+:[0-9a-f]+$/)
    const still = await call(gw, 'handleDelegateWait', { jobId: r.body.jobId, waitMs: 30 })
    assert.equal(still.body.sessionKey, r.body.sessionKey)
    const second = await call(gw, 'handleDelegateTask', {
      goal: '并发续跑应 409',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      resumeSessionKey: r.body.sessionKey,
      async: true,
    })
    assert.equal(second.status, 409)
    gw._releaseHold()
  })

  it('wrong parent cannot resume; after complete, matching parent can', async () => {
    const gw = makeGateway(false)
    const first = await call(gw, 'handleDelegateTask', {
      goal: '快任务',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
    })
    assert.equal(first.status, 200)
    assert.equal(typeof first.body.sessionKey, 'string')
    assert.ok(Array.isArray(gw._retiredKeys) && gw._retiredKeys.includes(first.body.sessionKey))
    const stolen = await call(gw, 'handleDelegateTask', {
      goal: '偷钥匙',
      sourceAgent: 'main',
      parentSessionKey: 'agent:main:webchat:dm:other',
      resumeSessionKey: first.body.sessionKey,
    })
    assert.equal(stolen.status, 400)
    const patrol = await call(gw, 'handleDelegateTask', {
      goal: 'taskboard key',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      resumeSessionKey: 'agent:coding-assistant:taskboard:t:s:r',
    })
    assert.equal(patrol.status, 400)
    const again = await call(gw, 'handleDelegateTask', {
      goal: '复审',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      resumeSessionKey: first.body.sessionKey,
    })
    assert.equal(again.status, 200)
    assert.equal(again.body.sessionKey, first.body.sessionKey)
  })

  it('retireKeepResume throw keeps occupancy while hasLiveSession is still true', async () => {
    const gw = makeGateway(false)
    gw.sessions.hasLiveSession = (key: string) => key === gw._heldKey
    gw.sessions.retireKeepResume = async (key: string) => {
      gw._heldKey = key
      throw new Error('shutdown failed')
    }
    const first = await call(gw, 'handleDelegateTask', {
      goal: '快任务',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
    })
    assert.equal(first.status, 200)
    const again = await call(gw, 'handleDelegateTask', {
      goal: '复审',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      resumeSessionKey: first.body.sessionKey,
    })
    assert.equal(again.status, 409)
  })

  it('retireKeepResume throw still releases after the live session is gone', async () => {
    const gw = makeGateway(false)
    gw.sessions.retireKeepResume = async () => {
      throw new Error('shutdown failed')
    }
    const first = await call(gw, 'handleDelegateTask', {
      goal: '快任务',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
    })
    assert.equal(first.status, 200)
    const again = await call(gw, 'handleDelegateTask', {
      goal: '复审',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      resumeSessionKey: first.body.sessionKey,
    })
    assert.equal(again.status, 200)
    assert.equal(again.body.sessionKey, first.body.sessionKey)
  })
})

describe('handleDelegateTask model override', () => {
  it('dotted agentId 返回 JSON 400,指向 model 参数', async () => {
    const gw = makeGateway(false)
    const r = await call(
      gw,
      'handleDelegateTask',
      { goal: '测', sourceAgent: 'main', parentSessionKey: PARENT_KEY },
      'cursor-grok-4.6-high-fast',
    )
    assert.equal(r.status, 400)
    assert.match(String(r.body.error ?? r.body), /model/)
  })

  it('非法 model 返回 400', async () => {
    const gw = makeGateway(false)
    const r = await call(gw, 'handleDelegateTask', {
      goal: '测',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      model: 'not a model',
    })
    assert.equal(r.status, 400)
    assert.match(String(r.body.error ?? r.body), /model 无效/)
  })

  it('合法 model 传到 getOrCreate 与 submit', async () => {
    const gw = makeGateway(false)
    const r = await call(gw, 'handleDelegateTask', {
      goal: '测 grok',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
      model: 'cursor-grok-4.6-high-fast',
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(gw._created[0].model, 'cursor-grok-4.6-high-fast')
    assert.equal(gw._created[0].agent.model, 'cursor-grok-4.6-high-fast')
    assert.equal(gw._submitted[0].model, 'cursor-grok-4.6-high-fast')
  })

  it('不传 model 时不覆盖成员默认', async () => {
    const gw = makeGateway(false)
    const r = await call(gw, 'handleDelegateTask', {
      goal: '普通',
      sourceAgent: 'main',
      parentSessionKey: PARENT_KEY,
    })
    assert.equal(r.status, 200)
    assert.equal(gw._submitted[0].model, undefined)
  })

  it('signed context overrides forged sourceAgent/depth/parentSessionKey', async () => {
    resetDelegateContextKeyForTests()
    const gw = makeGateway(true)
    const token = issueDelegateContextToken({
      agentId: 'main',
      sessionKey: PARENT_KEY,
      depth: 2,
    })
    const seen: any[] = []
    const orig = gw._runDelegateTask?.bind(gw)
    gw._runDelegateTask = async (input: any) => {
      seen.push(input)
      return { kind: 'ok', output: 'x', sessionKey: input.sessionKey }
    }
    const r = await call(
      gw,
      'handleDelegateTask',
      {
        goal: 'forged',
        sourceAgent: 'coding-assistant',
        parentSessionKey: 'forged-parent',
        async: true,
      },
      'coding-assistant',
      { [DELEGATE_CONTEXT_HEADER]: token, 'x-delegation-depth': '0' },
    )
    assert.equal(r.status, 200)
    assert.equal(typeof r.body.jobId, 'string')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].sourceAgent, 'main')
    assert.equal(seen[0].depth, 2)
    assert.equal(seen[0].parentSessionKey, PARENT_KEY)
    void orig
  })

  it('async without context is 401 even if the caller could present a bearer', async () => {
    const gw = makeGateway(true)
    let ran = 0
    gw._runDelegateTask = async () => {
      ran += 1
      return { kind: 'ok', output: 'x' }
    }
    const r = await call(
      gw,
      'handleDelegateTask',
      { goal: 'x', sourceAgent: 'main', parentSessionKey: PARENT_KEY, async: true },
      'coding-assistant',
      {},
      { autoContext: false },
    )
    assert.equal(r.status, 401)
    assert.match(String(r.body.error || r.body), /delegate context/)
    assert.equal(ran, 0)
  })

  it('invalid signed context is 401 and does not start a job', async () => {
    const gw = makeGateway(true)
    let ran = 0
    gw._runDelegateTask = async () => {
      ran += 1
      return { kind: 'ok', output: 'x' }
    }
    const r = await call(
      gw,
      'handleDelegateTask',
      { goal: 'x', sourceAgent: 'main', parentSessionKey: PARENT_KEY, async: true },
      'coding-assistant',
      { [DELEGATE_CONTEXT_HEADER]: 'not-a-token' },
    )
    assert.equal(r.status, 401)
    assert.equal(ran, 0)
  })
})
