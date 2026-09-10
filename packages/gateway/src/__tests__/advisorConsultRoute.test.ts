/**
 * Advisor consult route: admit/spawn/deliver/settle counts, fail-closed catalog,
 * no silent model swap, job+slot always created, settle_pending is not settled.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/advisorConsultRoute.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'

import { CONSULT_INVOCATION_HEADER } from '@openclaude/protocol'

import { AdvisorConfigStore } from '../advisorConfigStore.js'
import { AdvisorConsultStore } from '../advisorConsultStore.js'
import {
  DELEGATE_CONTEXT_HEADER,
  issueConsultTurnToken,
  resetDelegateContextKeyForTests,
} from '../delegateContext.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-advisor-route'
const TURN_KEY = 'a'.repeat(64)
const REQUEST_ID = 'ab'.repeat(16)
const ENV_KEYS = [
  'OC_SELFHOST_ENGINE_LOCAL_TURNS',
  'OC_ADVISOR_OPEN_ENGINES',
  'OC_MODEL_AUTHORITY',
] as const
const ORIG_ENV: Record<string, string | undefined> = {}
for (const key of ENV_KEYS) ORIG_ENV[key] = process.env[key]

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (ORIG_ENV[key] === undefined) delete process.env[key]
    else process.env[key] = ORIG_ENV[key]
  }
}
afterEach(() => {
  process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
  process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
  process.env.OC_MODEL_AUTHORITY = '0'
})
after(() => {
  restoreEnv()
  resetDelegateContextKeyForTests()
})
process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
process.env.OC_MODEL_AUTHORITY = '0'

function makeBilling() {
  const admits: unknown[] = []
  const settles: unknown[] = []
  const abandons: string[] = []
  return {
    admits,
    settles,
    abandons,
    async admit(input: unknown) {
      admits.push(input)
      return { requestId: REQUEST_ID, engineSessionId: `oceng-${'b'.repeat(48)}` }
    },
    async settle(billing: unknown) {
      settles.push(billing)
    },
    async abandon(requestId: string) {
      abandons.push(requestId)
    },
  }
}

async function http(
  gw: any,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const url = new URL(path, 'http://127.0.0.1')
  const req: any = { method, headers }
  gw.readBody = async () => (body === undefined ? '' : JSON.stringify(body))
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
  if (path === '/api/agents/advisor/consult') {
    await gw.handleConsultAdvisor(req, res)
  } else if (path.startsWith('/api/collaboration-config')) {
    await gw.handleCollaborationConfig(req, res, url)
  } else if (path.startsWith('/api/agents/') && path.endsWith('/delegate')) {
    await gw.handleDelegateTask(req, res, 'advisor')
  } else {
    throw new Error(`unexpected path ${path}`)
  }
  return { status, body: raw ? JSON.parse(raw) : {} }
}

async function makeGateway(opts?: {
  emitBilling?: boolean
  settleError?: Error
  submitError?: Error
  hangSubmit?: boolean
  turnKey?: string
}): Promise<{ gw: any; billing: ReturnType<typeof makeBilling>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'oc-adv-route-'))
  const billing = makeBilling()
  if (opts?.settleError) {
    billing.settle = async (frame: unknown) => {
      billing.settles.push(frame)
      throw opts.settleError
    }
  }
  const parent = {
    agentId: 'main',
    _collabModeTurn: 'advisor',
    _advisorTurn: { advisorModel: 'gpt-6-astra', configVersion: 'v1:advisor:gpt-6-astra' },
    _currentTurnKey: opts?.turnKey ?? TURN_KEY,
    _currentTurnUserText: 'fix the red test',
    _injectedTurnConstraints: 'keep the public API',
    sessionKey: PARENT_KEY,
    channel: 'webchat',
    peerId: 'wsess-advisor-route',
    userId: '3',
    providerTag: 'ccb',
    runner: { getPartialSnapshot: () => ({ completedTools: [] }) },
  }
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw._activeDelegations = 0
  gw._activeDelegationsByParent = new Map()
  gw._runningDelegationsByParent = new Map()
  gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
  gw._readDelegateMemoryPressure = () => null
  gw._delegateEngineBilling = billing
  gw._advisorConsults = new AdvisorConsultStore(join(dir, 'advisor-consults.db'))
  gw._advisorConfig = new AdvisorConfigStore(join(dir, 'collaboration-config.json'))
  gw._delegateJobs = new DelegateJobStore({ ttlMs: 60_000 })
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.getUserId = () => '3'
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
    agents: [{ id: 'main', provider: 'anthropic', model: 'glm-5.2' }],
  })
  gw.sessions = {
    getByKey: (key: string) => {
      if (key === PARENT_KEY) return parent
      if (String(key).startsWith('advisor:')) return { sessionKey: key, runner: {} }
      return undefined
    },
    destroySession: async () => {},
    getOrCreate: async () => {
      gw._spawnCount = (gw._spawnCount ?? 0) + 1
      return {
        agentId: 'advisor',
        currentTurnStatus: null,
        runner: { interrupt: () => {}, shutdown: () => {}, off: () => {}, on: () => {} },
      }
    },
    submit: async (
      _session: unknown,
      _payload: string,
      onEvent: (e: any) => void,
      _effort?: string | null,
      _model?: string,
      requestId?: string,
    ) => {
      gw._lastSubmitRequestId = requestId
      gw._submitOnEvent = onEvent
      if (opts?.submitError) throw opts.submitError
      if (opts?.hangSubmit) {
        await new Promise(() => {})
        return
      }
      if (opts?.emitBilling !== false) {
        onEvent({
          kind: 'codex_billing',
          requestId,
          engineSessionId: `oceng-${'b'.repeat(48)}`,
          status: 'success',
          durationMs: 12,
          usage: { input_tokens: 8, output_tokens: 3 },
          delegateAgentId: 'advisor',
          parentSessionId: 'wsess-advisor-route',
        })
      }
      onEvent({ kind: 'block', block: { kind: 'text', text: 'check the assertion first' } })
    },
    interrupt: (key: string) => {
      gw._interrupted = key
      return true
    },
  }
  return { gw, billing, dir }
}

function consultHeaders(over: Record<string, string> = {}): Record<string, string> {
  const token = issueConsultTurnToken({
    agentId: 'main',
    sessionKey: PARENT_KEY,
    depth: 0,
    turnKey: TURN_KEY,
    turnIndex: 1,
    collabMode: 'advisor',
    configVersion: 'v1:advisor:gpt-6-astra',
  })
  return {
    [DELEGATE_CONTEXT_HEADER]: token,
    [CONSULT_INVOCATION_HEADER]: `cinv-test-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  }
}

describe('advisor consult route lifecycle', () => {
  it('admits, always creates a job+slot, spawns once, settles once', async () => {
    const { gw, billing } = await makeGateway()
    const headers = consultHeaders()
    const r = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'settled')
    assert.equal(r.body.advice, 'check the assertion first')
    assert.equal(billing.admits.length, 1)
    assert.equal(billing.settles.length, 1)
    assert.equal(billing.abandons.length, 0)
    assert.equal(gw._spawnCount, 1)
    assert.equal(gw._lastSubmitRequestId, REQUEST_ID)
    assert.ok(r.body.jobId)
    const job = gw._delegateJobs.snapshotOf(r.body.jobId)
    assert.equal(job?.kind, 'advisor')
    assert.equal(gw._activeDelegations, 0)
    const rec = gw._advisorConsults.findById(r.body.consultId)
    assert.equal(rec.state, 'settled')
    assert.equal(rec.billingRequestId, REQUEST_ID)
  })

  it('reuses the same invocation without a second admit', async () => {
    const { gw, billing } = await makeGateway()
    const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-reuse-1' })
    const first = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    const second = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(second.body.reused, true)
    assert.equal(second.body.consultId, first.body.consultId)
    assert.equal(billing.admits.length, 1)
    assert.equal(gw._spawnCount, 1)
  })

  it('settle failure stays settle_pending and does not abandon', async () => {
    const { gw, billing } = await makeGateway({ settleError: new Error('master 503') })
    const r = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders(),
    )
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'settle_pending')
    assert.equal(billing.settles.length, 1)
    assert.equal(billing.abandons.length, 0)
    const rec = gw._advisorConsults.findById(r.body.consultId)
    assert.equal(rec.state, 'settle_pending')
    assert.equal(rec.billingRequestId, REQUEST_ID)
    assert.equal(gw._advisorConsults.listByState('settled').length, 0)
    assert.equal(gw._activeDelegations, 0)
  })

  it('missing billing frame fails closed and abandons once', async () => {
    const { gw, billing } = await makeGateway({ emitBilling: false })
    const r = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders(),
    )
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'failed')
    assert.equal(billing.settles.length, 0)
    assert.deepEqual(billing.abandons, [REQUEST_ID])
    assert.equal(gw._advisorConsults.findById(r.body.consultId).state, 'failed')
  })

  it('parent Stop interrupts the in-flight advisor session', async () => {
    const { gw } = await makeGateway({ hangSubmit: true })
    let resume!: () => void
    gw.sessions.submit = async (
      _session: unknown,
      _payload: string,
      onEvent: (e: any) => void,
    ) => {
      gw._submitOnEvent = onEvent
      await new Promise<void>((resolve) => {
        resume = resolve
      })
      const err = Object.assign(new Error('stopped'), { errorCode: 'USER_CANCELLED' })
      onEvent({ kind: 'error', error: err.message, errorCode: 'USER_CANCELLED' })
      throw err
    }
    const pending = http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders(),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok((gw._activeDelegationsByParent.get(PARENT_KEY)?.size ?? 0) >= 1)
    const interrupted = gw._interruptDelegationsForParent(PARENT_KEY)
    assert.equal(interrupted, true)
    assert.equal(String(gw._interrupted).startsWith('advisor:'), true)
    resume()
    const r = await pending
    assert.equal(r.status, 200)
    assert.equal(r.body.status, 'cancelled')
    assert.equal(gw._activeDelegations, 0)
  })

  it('rejects consult after the origin turn has ended', async () => {
    const { gw } = await makeGateway({ turnKey: 'b'.repeat(64) })
    const r = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders(),
    )
    assert.equal(r.status, 409)
    assert.match(String(r.body.error), /原回合已结束/)
  })

  it('rejects /delegate to advisor', async () => {
    const { gw } = await makeGateway()
    const r = await http(gw, 'POST', '/api/agents/advisor/delegate', { goal: 'nope' })
    assert.equal(r.status, 403)
    assert.match(String(r.body.error), /consult_advisor/)
  })

  it('PUT advisor fails closed when catalog is unproven, without writing a model', async () => {
    process.env.OC_ADVISOR_OPEN_ENGINES = ''
    const { gw } = await makeGateway()
    const before = gw._advisorConfig.read()
    const r = await http(gw, 'PUT', '/api/collaboration-config', {
      mode: 'advisor',
      advisorModel: 'gpt-6-astra',
      expectedRev: 0,
      asDefault: true,
    })
    assert.ok(r.status === 400 || r.status === 503, JSON.stringify(r.body))
    assert.match(String(r.body.error), /尚未完成无工具证明|尚未证明|不可用|不在已证明/)
    assert.equal(gw._advisorConfig.read().rev, before.rev)
    assert.equal(gw._advisorConfig.read().defaultMode, 'solo')
  })

  it('PUT unknown advisor model does not silently swap to listed[0]', async () => {
    const { gw } = await makeGateway()
    await gw._advisorConfig.markEngineProven('codex')
    const r = await http(gw, 'PUT', '/api/collaboration-config', {
      mode: 'advisor',
      advisorModel: 'deepseek-v4-flash',
      expectedRev: 1,
      asDefault: true,
    })
    assert.ok(r.status === 400 || r.status === 503, JSON.stringify(r.body))
    assert.match(String(r.body.error), /不在已证明|不可用|尚未证明/)
    assert.equal(gw._advisorConfig.read().defaultAdvisorModel, null)
  })

  it('GET/PUT unknown sessionId is not treated as owned', async () => {
    const { gw } = await makeGateway()
    const get = await http(gw, 'GET', '/api/collaboration-config?sessionId=missing-session', undefined)
    assert.equal(get.status, 404)
    const put = await http(gw, 'PUT', '/api/collaboration-config', {
      sessionId: 'missing-session',
      mode: 'solo',
      expectedRev: 0,
    })
    assert.equal(put.status, 404)
  })

  it('unauthenticated consult is 401, not a no-tools pass', async () => {
    const { gw } = await makeGateway()
    const r = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, {
      [CONSULT_INVOCATION_HEADER]: 'cinv-no-token',
    })
    assert.equal(r.status, 401)
  })

  it('missing invocation header is 400 and does not admit', async () => {
    const { gw, billing } = await makeGateway()
    const token = issueConsultTurnToken({
      agentId: 'main',
      sessionKey: PARENT_KEY,
      depth: 0,
      turnKey: TURN_KEY,
      turnIndex: 1,
      collabMode: 'advisor',
      configVersion: 'v1:advisor:gpt-6-astra',
    })
    const r = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, {
      [DELEGATE_CONTEXT_HEADER]: token,
    })
    assert.equal(r.status, 400)
    assert.equal(billing.admits.length, 0)
  })

  it('same invocation with a different question conflicts and does not admit twice', async () => {
    const { gw, billing } = await makeGateway()
    const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-conflict-1' })
    const first = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    const second = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'a different question' },
      headers,
    )
    assert.equal(first.status, 200)
    assert.equal(second.status, 409)
    assert.equal(billing.admits.length, 1)
    assert.equal(gw._spawnCount, 1)
  })

  it('admission_unknown does not admit a second time', async () => {
    const { gw, billing } = await makeGateway()
    billing.admit = async (input: unknown) => {
      billing.admits.push(input)
      throw new Error('master down')
    }
    const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-unknown-1' })
    const first = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    const second = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    assert.equal(first.status, 503)
    assert.equal(first.body.state, 'admission_unknown')
    assert.equal(second.status, 503)
    assert.equal(second.body.reused, true)
    assert.equal(second.body.state, 'admission_unknown')
    assert.equal(billing.admits.length, 1)
    assert.equal(gw._spawnCount ?? 0, 0)
  })

  it('PUT advisor without a model does not fill gpt-6-astra', async () => {
    const { gw } = await makeGateway()
    const r = await http(gw, 'PUT', '/api/collaboration-config', {
      mode: 'advisor',
      expectedRev: 0,
      asDefault: true,
    })
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.match(String(r.body.error), /advisorModel required/)
    assert.equal(gw._advisorConfig.read().defaultAdvisorModel, null)
    assert.equal(gw._advisorConfig.read().rev, 0)
  })

  it('PUT without sessionId and without asDefault does not write the user default', async () => {
    const { gw } = await makeGateway()
    const r = await http(gw, 'PUT', '/api/collaboration-config', {
      mode: 'solo',
      expectedRev: 0,
    })
    assert.equal(r.status, 400, JSON.stringify(r.body))
    assert.match(String(r.body.error), /asDefault or sessionId/)
    assert.equal(gw._advisorConfig.read().defaultMode, 'solo')
    assert.equal(gw._advisorConfig.read().rev, 0)
  })

  it('settled replay returns the original advice without a second admit', async () => {
    const { gw, billing } = await makeGateway()
    const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-replay-1' })
    const first = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    const second = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    assert.equal(first.status, 200)
    assert.equal(first.body.advice, 'check the assertion first')
    assert.equal(second.status, 200)
    assert.equal(second.body.reused, true)
    assert.equal(second.body.advice, first.body.advice)
    assert.equal(billing.admits.length, 1)
    assert.equal(billing.settles.length, 1)
    assert.equal(gw._spawnCount, 1)
  })

  it('in-flight replay waits for the original advice', async () => {
    const { gw, billing } = await makeGateway({ hangSubmit: true })
    gw._advisorConsultWaitMs = 2_000
    let resume!: () => void
    gw.sessions.submit = async (
      _session: unknown,
      _payload: string,
      onEvent: (e: any) => void,
    ) => {
      gw._lastSubmitRequestId = REQUEST_ID
      await new Promise<void>((resolve) => {
        resume = resolve
      })
      onEvent({
        kind: 'codex_billing',
        requestId: REQUEST_ID,
        engineSessionId: `oceng-${'b'.repeat(48)}`,
        status: 'success',
        durationMs: 12,
        usage: { input_tokens: 8, output_tokens: 3 },
        delegateAgentId: 'advisor',
        parentSessionId: 'wsess-advisor-route',
      })
      onEvent({ kind: 'block', block: { kind: 'text', text: 'waited advice' } })
    }
    const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-wait-1' })
    const firstP = http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    await new Promise((resolve) => setTimeout(resolve, 40))
    const secondP = http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    await new Promise((resolve) => setTimeout(resolve, 40))
    resume()
    const [first, second] = await Promise.all([firstP, secondP])
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.reused, true)
    assert.equal(second.body.advice, 'waited advice')
    assert.equal(billing.admits.length, 1)
    assert.equal(gw._spawnCount, 1)
  })

  it('queued consult aborted by parent Stop does not spawn', async () => {
    const { gw, billing } = await makeGateway()
    gw._activeDelegations = 99
    gw._delegateQueuePollMs = 10
    const pending = http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-queue-stop' }),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(gw._spawnCount ?? 0, 0)
    const interrupted = gw._interruptDelegationsForParent(PARENT_KEY)
    assert.equal(interrupted, true)
    const r = await pending
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'cancelled')
    assert.equal(gw._spawnCount ?? 0, 0)
    assert.equal(billing.admits.length, 1)
    assert.equal(billing.abandons.length, 1)
    assert.equal(billing.settles.length, 0)
  })

  it('Stop after usage settles the original owner and does not abandon', async () => {
    const { gw, billing } = await makeGateway({ hangSubmit: true })
    let resume!: () => void
    gw.sessions.submit = async (
      _session: unknown,
      _payload: string,
      onEvent: (e: any) => void,
    ) => {
      onEvent({
        kind: 'codex_billing',
        requestId: REQUEST_ID,
        engineSessionId: `oceng-${'b'.repeat(48)}`,
        status: 'success',
        durationMs: 9,
        usage: { input_tokens: 4, output_tokens: 2 },
        delegateAgentId: 'advisor',
        parentSessionId: 'wsess-advisor-route',
      })
      await new Promise<void>((resolve) => {
        resume = resolve
      })
      const err = Object.assign(new Error('stopped'), { errorCode: 'USER_CANCELLED' })
      onEvent({ kind: 'error', error: err.message, errorCode: 'USER_CANCELLED' })
      throw err
    }
    const pending = http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders(),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    gw._interruptDelegationsForParent(PARENT_KEY)
    resume()
    const r = await pending
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'cancelled')
    assert.equal(billing.settles.length, 1)
    assert.equal(billing.abandons.length, 0)
  })

  it('source-agent miss after admit abandons and does not spawn', async () => {
    const { gw, billing } = await makeGateway()
    gw._getAgentsConfig = async () => ({ default: 'main', agents: [] })
    const r = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders(),
    )
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'failed')
    assert.equal(billing.admits.length, 1)
    assert.equal(billing.abandons.length, 1)
    assert.equal(gw._spawnCount ?? 0, 0)
  })

  it('codex parent consult is a visible capability limit, not a silent model swap', async () => {
    const { gw, billing } = await makeGateway()
    const parent = gw.sessions.getByKey(PARENT_KEY)
    parent.providerTag = 'codex'
    const r = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders(),
    )
    assert.equal(r.status, 409)
    assert.match(String(r.body.error), /CCB/)
    assert.equal(billing.admits.length, 0)
  })
})
