/**
 * Advisor consult route: admit/spawn/deliver/settle counts, fail-closed catalog,
 * no silent model swap, job+slot always created, settle_pending is not settled.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/advisorConsultRoute.test.ts
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CONSULT_INVOCATION_HEADER } from '@openclaude/protocol'

import { AdvisorConfigStore } from '../advisorConfigStore.js'
import { AdvisorConsultStore } from '../advisorConsultStore.js'
import {
  DELEGATE_CONTEXT_HEADER,
  hashConsultTurnToken,
  inspectConsultTurnToken,
  issueConsultTurnToken,
  resetDelegateContextKeyForTests,
} from '../delegateContext.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'
import { SessionManager } from '../sessionManager.js'

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
      gw._submitCount = (gw._submitCount ?? 0) + 1
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

function consultHeaders(
  over: Record<string, string> = {},
  turnKey = TURN_KEY,
): Record<string, string> {
  const token = issueConsultTurnToken({
    agentId: 'main',
    sessionKey: PARENT_KEY,
    depth: 0,
    turnKey,
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

  it('real-route receipt recovers after HMAC rotation; invented signatures do not', async () => {
    const { gw, billing } = await makeGateway()
    const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-receipt-auth-1' })
    const first = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.advice, 'check the assertion first')
    const rec = gw._advisorConsults.findById(first.body.consultId)
    const originalToken = headers[DELEGATE_CONTEXT_HEADER]!
    assert.equal(rec.tokenReceipt, hashConsultTurnToken(originalToken))

    resetDelegateContextKeyForTests()
    gw.sessions.getByKey = () => undefined
    assert.equal(inspectConsultTurnToken(originalToken)?.hmacOk, false)

    const replayed = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      headers,
    )
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body))
    assert.equal(replayed.body.advice, 'check the assertion first')
    assert.equal(replayed.body.reused, true)
    assert.equal(billing.admits.length, 1)
    assert.equal(gw._spawnCount, 1)

    const payloadB64 = originalToken.slice(0, originalToken.lastIndexOf('.'))
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    const signatureOnly = `${payloadB64}.invented-signature`
    const sigGot = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      { ...headers, [DELEGATE_CONTEXT_HEADER]: signatureOnly },
    )
    assert.equal(sigGot.status, 401, JSON.stringify(sigGot.body))

    claims.exp = Date.now() + 3_600_000
    const expExtended = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.invented-signature`
    const expGot = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      { ...headers, [DELEGATE_CONTEXT_HEADER]: expExtended },
    )
    assert.equal(expGot.status, 401, JSON.stringify(expGot.body))

    const remint = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-receipt-auth-1' })
    assert.equal(inspectConsultTurnToken(remint[DELEGATE_CONTEXT_HEADER]!)?.hmacOk, true)
    const remintGot = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, remint)
    assert.equal(remintGot.status, 401, JSON.stringify(remintGot.body))

    gw.getUserId = () => '9'
    const otherUser = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      headers,
    )
    assert.equal(otherUser.status, 401, JSON.stringify(otherUser.body))
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

describe('M4c recovery contracts', () => {
  it('config load failure after admit releases billing ownership', async () => {
    const { gw, billing } = await makeGateway()
    gw._getAgentsConfig = async () => {
      throw new Error('injected config read failure')
    }
    let actual: unknown
    try {
      actual = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, consultHeaders())
    } catch (e) {
      actual = String(e)
    }
    try {
      assert.equal(billing.admits.length, 1)
      assert.equal(billing.abandons.length, 1, 'accepted request must be abandoned when no child spawned')
      assert.equal(gw._spawnCount ?? 0, 0)
      if (typeof actual === 'object' && actual && 'body' in actual) {
        assert.equal((actual as { body: { status?: string } }).body.status, 'failed')
      }
    } finally {
      gw._advisorConsults.close()
    }
  })

  it('persist failure after settled usage must never abandon that usage', async () => {
    const { gw, billing } = await makeGateway()
    const orig = gw._advisorConsults.update.bind(gw._advisorConsults)
    let injected = false
    gw._advisorConsults.update = (id: string, patch: { state?: string }) => {
      if (patch.state === 'settled' && !injected) {
        injected = true
        throw new Error('injected local write failure')
      }
      return orig(id, patch)
    }
    const actual = await http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders(),
    )
    try {
      assert.equal(billing.settles.length, 1)
      assert.equal(billing.abandons.length, 0, 'usage observed/settled must not go through abandon')
      assert.equal(actual.body.advice, 'check the assertion first')
      assert.notEqual(actual.body.status, 'failed')
    } finally {
      gw._advisorConsults.close()
    }
  })

  it('replay past one wait budget is pending not success running JSON, then same invocation recovers advice', async () => {
    const { gw, billing } = await makeGateway()
    gw._advisorConsultWaitMs = 60
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>((r) => {
      entered = r
    })
    const gate = new Promise<void>((r) => {
      release = r
    })
    const orig = gw.sessions.submit
    gw.sessions.submit = async (...args: unknown[]) => {
      entered()
      await gate
      return orig(...args)
    }
    const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-over-wait' })
    const first = http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    await started
    const pending = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    assert.equal(pending.status, 202, JSON.stringify(pending.body))
    assert.equal(pending.body.status, 'pending')
    assert.equal(pending.body.reused, true)
    assert.equal(pending.body.advice, undefined)
    assert.equal(pending.body.recoverable, true)
    release()
    const firstResult = await first
    const after = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    try {
      assert.equal(firstResult.body.advice, 'check the assertion first')
      assert.equal(after.body.advice, 'check the assertion first')
      assert.equal(after.body.reused, true)
      assert.equal(billing.admits.length, 1)
    } finally {
      gw._advisorConsults.close()
    }
  })

  it('GET/PUT consume parent engine capability: non-CCB session cannot select advisor', async () => {
    const { gw } = await makeGateway()
    const parent = gw.sessions.getByKey(PARENT_KEY)
    parent.providerTag = 'codex'
    const get = await http(gw, 'GET', '/api/collaboration-config?sessionId=wsess-advisor-route', undefined)
    assert.equal(get.status, 200, JSON.stringify(get.body))
    assert.equal(get.body.advisorConsultAllowed, false)
    assert.equal(get.body.parentEngine, 'codex')
    assert.deepEqual(get.body.advisorConsultParents, ['ccb'])
    const before = gw._advisorConfig.read()
    const put = await http(gw, 'PUT', '/api/collaboration-config', {
      sessionId: 'wsess-advisor-route',
      mode: 'advisor',
      advisorModel: 'gpt-6-astra',
      expectedRev: 0,
    })
    assert.equal(put.status, 409, JSON.stringify(put.body))
    assert.match(String(put.body.error), /CCB|未知/)
    assert.equal(gw._advisorConfig.read().rev, before.rev)
    parent.providerTag = 'ccb'
    const allowed = await http(gw, 'GET', '/api/collaboration-config?sessionId=wsess-advisor-route', undefined)
    assert.equal(allowed.body.advisorConsultAllowed, true)
  })

  it('unknown explicit session parent engine fail-closes advisor PUT', async () => {
    const { gw } = await makeGateway()
    const parent = gw.sessions.getByKey(PARENT_KEY)
    parent.providerTag = ''
    const put = await http(gw, 'PUT', '/api/collaboration-config', {
      sessionId: 'wsess-advisor-route',
      mode: 'advisor',
      advisorModel: 'gpt-6-astra',
      expectedRev: 0,
    })
    assert.equal(put.status, 409, JSON.stringify(put.body))
    assert.match(String(put.body.error), /未知|fail closed|CCB/)
  })

  it('SessionManager.interrupt drives consult cancelled without test-side resume', async () => {
    const { gw, billing } = await makeGateway()
    const sm = new SessionManager({
      version: 1,
      gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: '' },
      sessions: { dbPath: '' },
    } as never)
    const waiters: Array<(err: Error) => void> = []
    const runner = {
      interrupt(): boolean {
        const err = Object.assign(new Error('stopped'), { errorCode: 'USER_CANCELLED' })
        for (const wait of waiters.splice(0)) wait(err)
        return true
      },
      shutdown: async () => {},
      off: () => {},
      on: () => {},
    }
    const origGetOrCreate = gw.sessions.getOrCreate
    const origGetByKey = gw.sessions.getByKey
    gw.sessions.getByKey = (key: string) => origGetByKey(key) ?? sm.getByKey(key)
    gw.sessions.getOrCreate = async (opts: { sessionKey: string }) => {
      const session = await origGetOrCreate()
      session.sessionKey = opts.sessionKey
      session.runner = runner
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(opts.sessionKey, session)
      return session
    }
    gw.sessions.interrupt = (key: string) => sm.interrupt(key)
    gw.sessions.submit = async (_session: unknown, _payload: string, onEvent: (e: unknown) => void) => {
      gw._submitCount = (gw._submitCount ?? 0) + 1
      await new Promise<void>((_resolve, reject) => {
        waiters.push((err) => {
          onEvent({ kind: 'error', error: err.message, errorCode: (err as { errorCode?: string }).errorCode })
          reject(err)
        })
      })
    }
    const pending = http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, consultHeaders())
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(gw._interruptDelegationsForParent(PARENT_KEY), true)
    const r = await pending
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'cancelled')
    assert.equal(billing.abandons.length, 1)
    assert.equal(gw._submitCount, 1)
  })

  it('Stop during getOrCreate does not later submit', async () => {
    const { gw, billing } = await makeGateway()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((r) => {
      entered = r
    })
    gw.sessions.getOrCreate = async () => {
      entered()
      await new Promise<void>((r) => {
        release = r
      })
      gw._spawnCount = (gw._spawnCount ?? 0) + 1
      return {
        agentId: 'advisor',
        currentTurnStatus: null,
        runner: { interrupt: () => {}, shutdown: () => {}, off: () => {}, on: () => {} },
      }
    }
    const pending = http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-create-stop' }),
    )
    await started
    gw._interruptDelegationsForParent(PARENT_KEY)
    release()
    const r = await pending
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, 'cancelled')
    assert.equal(gw._submitCount ?? 0, 0)
    assert.equal(billing.settles.length, 0)
    assert.equal(billing.abandons.length, 1)
  })

  it('queued Stop still yields 0 spawn after capacity is released', async () => {
    const { gw, billing } = await makeGateway()
    gw._activeDelegations = 99
    gw._delegateQueuePollMs = 10
    const pending = http(
      gw,
      'POST',
      '/api/agents/advisor/consult',
      { question: 'why red?' },
      consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-queue-stop-2' }),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    gw._interruptDelegationsForParent(PARENT_KEY)
    gw._activeDelegations = 0
    const r = await pending
    assert.equal(r.body.status, 'cancelled')
    assert.equal(gw._spawnCount ?? 0, 0)
    assert.equal(gw._submitCount ?? 0, 0)
    assert.equal(billing.settles.length, 0)
  })

  it('new store on the same sqlite file rereads settled advice', async () => {
    const { gw, dir } = await makeGateway()
    const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-newproc' })
    const first = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    assert.equal(first.body.status, 'settled')
    const dbPath = join(dir, 'advisor-consults.db')
    gw._advisorConsults.close()
    const fresh = new (await import('../advisorConsultStore.js')).AdvisorConsultStore(dbPath)
    try {
      const rec = fresh.findById(first.body.consultId)
      assert.equal(rec?.state, 'settled')
      assert.equal(rec?.advice, 'check the assertion first')
    } finally {
      fresh.close()
    }
  })

  it('admitted orphan with missing job is failed, not running or fake settled', async () => {
    const { gw } = await makeGateway()
    gw._advisorConsultWaitMs = 40
    const inserted = gw._advisorConsults.insertNew({
      consultId: 'advc-orphan-1',
      invocationId: 'cinv-orphan-1',
      userId: '3',
      sessionKey: PARENT_KEY,
      clientSessionId: 'wsess-advisor-route',
      originTurnKey: TURN_KEY,
      originTurnIndex: 1,
      configVersion: 'v1:advisor:gpt-6-astra',
      evidenceVersion: 'e'.repeat(64),
      advisorModel: 'gpt-6-astra',
      question: 'why red?',
      concern: '',
      snapshotJson: '{}',
      jobId: 'dlgjob-missing',
      billingRequestId: REQUEST_ID,
      state: 'admitted',
    })
    assert.equal(inserted.reused, false)
    const presented = await gw._presentExistingConsult({
      record: inserted.record,
      question: 'why red?',
      concern: '',
    })
    assert.equal(presented.status, 200)
    assert.equal(presented.body.status, 'failed')
    assert.notEqual(presented.body.status, 'settled')
    assert.equal(gw._advisorConsults.findById('advc-orphan-1').state, 'failed')
  })

  it('job failed is not mapped to settled', async () => {
    const { gw } = await makeGateway()
    gw._advisorConsultWaitMs = 80
    const created = gw._delegateJobs.create('advisor', {
      sessionKey: 'advisor:x',
      parentSessionKey: PARENT_KEY,
      kind: 'advisor',
      callback: 'stdout-wait',
      idempotencyKey: 'advc-jobfail',
    })
    assert.equal('jobId' in created, true)
    const jobId = (created as { jobId: string }).jobId
    const snap = gw._delegateJobs.snapshotOf(jobId)
    const failed = gw._delegateJobs.fail(jobId, {
      failureClass: 'child_error',
      detail: 'child died',
      httpStatus: 500,
      body: { ok: false, error: 'child died' },
      claimToken: snap?.claimToken,
      fencingEpoch: snap?.fencingEpoch,
    })
    assert.equal(failed, true)
    const view = gw._delegateJobs.get(jobId)
    assert.ok(view.status === 'failed' || (view.status === 'done' && view.httpStatus >= 400))
    const inserted = gw._advisorConsults.insertNew({
      consultId: 'advc-jobfail',
      invocationId: 'cinv-jobfail',
      userId: '3',
      sessionKey: PARENT_KEY,
      clientSessionId: 'wsess-advisor-route',
      originTurnKey: TURN_KEY,
      originTurnIndex: 1,
      configVersion: 'v1:advisor:gpt-6-astra',
      evidenceVersion: 'f'.repeat(64),
      advisorModel: 'gpt-6-astra',
      question: 'why red?',
      concern: '',
      snapshotJson: '{}',
      jobId,
      billingRequestId: REQUEST_ID,
      state: 'spawned',
    })
    const presented = await gw._presentExistingConsult({
      record: inserted.record,
      question: 'why red?',
      concern: '',
    })
    assert.equal(presented.body.status, 'failed')
    assert.notEqual(presented.body.status, 'settled')
  })

  it('settle_pending replay returns original advice and does not admit again', async () => {
    const { gw, billing } = await makeGateway({ settleError: new Error('master 503') })
    const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-settle-pending-replay' })
    const first = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    assert.equal(first.body.status, 'settle_pending')
    const second = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
    assert.equal(second.body.reused, true)
    assert.equal(second.body.status, 'settle_pending')
    assert.equal(second.body.advice, 'check the assertion first')
    assert.equal(billing.admits.length, 1)
    assert.equal(billing.settles.length, 1)
    assert.equal(billing.abandons.length, 0)
  })

  it('GET allowed follows current model catalog, not a stale live providerTag', async () => {
    const { gw } = await makeGateway()
    const parent = gw.sessions.getByKey(PARENT_KEY)
    parent.providerTag = 'codex'
    parent.model = 'glm-5.2'
    gw._catalogEngineForModel = async (modelId: string) => (modelId === 'glm-5.2' ? 'ccb' : undefined)
    const get = await http(gw, 'GET', '/api/collaboration-config?sessionId=wsess-advisor-route', undefined)
    assert.equal(get.status, 200, JSON.stringify(get.body))
    assert.equal(get.body.parentEngine, 'ccb')
    assert.equal(get.body.advisorConsultAllowed, true)
  })

  it('Stop then new turn: late old advice is not delivered; usage stays on original requestId', async () => {
    const { gw, billing } = await makeGateway()
    const sm = new SessionManager({
      version: 1,
      gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: '' },
      sessions: { dbPath: '' },
    } as never)
    const waiters: Array<(err: Error) => void> = []
    let lateAdvice: ((text: string) => void) | undefined
    const runner = {
      interrupt(): boolean {
        const err = Object.assign(new Error('stopped'), { errorCode: 'USER_CANCELLED' })
        for (const wait of waiters.splice(0)) wait(err)
        return true
      },
      shutdown: async () => {},
      off: () => {},
      on: () => {},
    }
    const origGetOrCreate = gw.sessions.getOrCreate
    const origGetByKey = gw.sessions.getByKey
    gw.sessions.getByKey = (key: string) => origGetByKey(key) ?? sm.getByKey(key)
    gw.sessions.getOrCreate = async (opts: { sessionKey: string }) => {
      const session = await origGetOrCreate()
      session.sessionKey = opts.sessionKey
      session.runner = runner
      ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(opts.sessionKey, session)
      return session
    }
    gw.sessions.interrupt = (key: string) => sm.interrupt(key)
    let firstOnEvent: ((e: unknown) => void) | undefined
    gw.sessions.submit = async (
      _session: unknown,
      _payload: string,
      onEvent: (e: any) => void,
      _effort?: string | null,
      _model?: string,
      requestId?: string,
    ) => {
      gw._submitCount = (gw._submitCount ?? 0) + 1
      if (!firstOnEvent) {
        firstOnEvent = onEvent
        onEvent({
          kind: 'codex_billing',
          requestId,
          engineSessionId: `oceng-${'b'.repeat(48)}`,
          status: 'success',
          durationMs: 9,
          usage: { input_tokens: 4, output_tokens: 2 },
          delegateAgentId: 'advisor',
          parentSessionId: 'wsess-advisor-route',
        })
        await new Promise<void>((_resolve, reject) => {
          lateAdvice = (text: string) => onEvent({ kind: 'block', block: { kind: 'text', text } })
          waiters.push((err) => {
            onEvent({ kind: 'error', error: err.message, errorCode: (err as { errorCode?: string }).errorCode })
            reject(err)
          })
        })
        return
      }
      onEvent({
        kind: 'codex_billing',
        requestId,
        engineSessionId: `oceng-${'c'.repeat(48)}`,
        status: 'success',
        durationMs: 4,
        usage: { input_tokens: 1, output_tokens: 1 },
        delegateAgentId: 'advisor',
        parentSessionId: 'wsess-advisor-route',
      })
      onEvent({ kind: 'block', block: { kind: 'text', text: 'second turn advice' } })
    }
    const firstHeaders = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-old-turn' })
    const pending = http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, firstHeaders)
    await new Promise((resolve) => setTimeout(resolve, 30))
    gw._interruptDelegationsForParent(PARENT_KEY)
    const first = await pending
    assert.equal(first.body.status, 'cancelled')
    assert.equal(billing.settles.length, 1)
    assert.equal((billing.settles[0] as { requestId: string }).requestId, REQUEST_ID)
    const parent = gw.sessions.getByKey(PARENT_KEY)
    parent._currentTurnKey = 'c'.repeat(64)
    const secondHeaders = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-new-turn' }, 'c'.repeat(64))
    const secondP = http(gw, 'POST', '/api/agents/advisor/consult', { question: 'new turn?' }, secondHeaders)
    lateAdvice?.('old advice must not land')
    const second = await secondP
    assert.equal(second.body.advice, 'second turn advice')
    assert.notEqual(second.body.advice, 'old advice must not land')
    assert.equal(billing.settles.length, 2)
    assert.equal((billing.settles[0] as { requestId: string }).requestId, REQUEST_ID)
  })

  it('new process route replay returns settled advice without a second admit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-proc-'))
    const dbPath = join(dir, 'advisor-consults.db')
    const childPath = fileURLToPath(new URL('./advisorConsultRouteChild.ts', import.meta.url))
    const run = (mode: string, extra: Record<string, string> = {}) =>
      new Promise<any>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', childPath], {
          env: {
            ...process.env,
            OC_ADVISOR_CHILD_MODE: mode,
            OC_ADVISOR_DB: dbPath,
            OC_ADVISOR_INVOCATION: 'cinv-proc-replay',
            OC_ADVISOR_TOKEN_FILE: join(dir, 'consult.token'),
            ...extra,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (c) => {
          out += String(c)
        })
        child.stderr.on('data', (c) => {
          err += String(c)
        })
        child.on('exit', (code) => {
          if (code !== 0) reject(new Error(err || out || `exit ${code}`))
          else {
            const line = out
              .trim()
              .split('\n')
              .filter((row) => row.startsWith('{'))
              .pop()
            resolve(JSON.parse(line || '{}'))
          }
        })
      })
    const first = await run('consult')
    assert.equal(first.body.status, 'settled')
    assert.equal(first.body.advice, 'check the assertion first')
    assert.equal(first.admit, 1)
    const replay = await run('replay')
    assert.equal(replay.body.advice, 'check the assertion first')
    assert.equal(replay.body.reused, true)
    assert.equal(replay.admit, 0)
    assert.equal(replay.spawn, 0)
  })

  it('two process insertNew of same invocation different questions conflict at the route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-conflict-'))
    const dbPath = join(dir, 'advisor-consults.db')
    const barrier = join(dir, 'go')
    new AdvisorConsultStore(dbPath).close()
    const childPath = fileURLToPath(new URL('./advisorConsultStoreChild.ts', import.meta.url))
    const base = {
      userId: '3',
      sessionKey: PARENT_KEY,
      clientSessionId: 'wsess-advisor-route',
      originTurnKey: TURN_KEY,
      originTurnIndex: 1,
      configVersion: 'v1:advisor:gpt-6-astra',
      evidenceVersion: 'e'.repeat(64),
      advisorModel: 'gpt-6-astra',
      concern: '',
      snapshotJson: '{}',
      jobId: null,
      billingRequestId: null,
      state: 'accepted',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const run = (record: Record<string, unknown>) => {
      let released!: () => void
      const sawReady = new Promise<void>((r) => {
        released = r
      })
      const result = new Promise<any>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', childPath], {
          env: {
            ...process.env,
            OC_ADVISOR_DB: dbPath,
            OC_ADVISOR_RECORD: JSON.stringify(record),
            OC_ADVISOR_BARRIER: barrier,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (c) => {
          out += String(c)
          if (out.includes('ready')) released()
        })
        child.stderr.on('data', (c) => {
          err += String(c)
        })
        child.on('exit', (code) => {
          if (code !== 0) reject(new Error(err || out || `exit ${code}`))
          else {
            const line = out
              .trim()
              .split('\n')
              .filter((row) => row.startsWith('{'))
              .pop()
            resolve(JSON.parse(line || '{}'))
          }
        })
      })
      return { sawReady, result }
    }
    const a = run({ ...base, consultId: 'advc-a', invocationId: 'cinv-conflict-proc', question: 'why red?' })
    const b = run({
      ...base,
      consultId: 'advc-b',
      invocationId: 'cinv-conflict-proc',
      question: 'a different question',
    })
    await Promise.all([a.sawReady, b.sawReady])
    writeFileSync(barrier, 'go')
    const [one, two] = await Promise.all([a.result, b.result])
    assert.equal(one.consultId, two.consultId)
    const { gw, billing } = await makeGateway()
    gw._advisorConsults.close()
    gw._advisorConsults = new AdvisorConsultStore(dbPath)
    const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-conflict-proc' })
    const winnerQuestion = one.reused ? two.question : one.question
    const loserQuestion = winnerQuestion === 'why red?' ? 'a different question' : 'why red?'
    const ok = await http(gw, 'POST', '/api/agents/advisor/consult', { question: winnerQuestion }, headers)
    const conflict = await http(gw, 'POST', '/api/agents/advisor/consult', { question: loserQuestion }, headers)
    assert.equal(ok.status, 200)
    assert.equal(conflict.status, 409)
    assert.equal(billing.admits.length, 0)
    assert.equal(gw._spawnCount ?? 0, 0)
    gw._advisorConsults.close()
  })

  it('new process retryPending 2xx projects settle_pending to settled with original advice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-retry-'))
    const dbPath = join(dir, 'advisor-consults.db')
    const queuePath = join(dir, 'billing-queue.json')
    const childPath = fileURLToPath(new URL('./advisorConsultRouteChild.ts', import.meta.url))
    const run = (mode: string, extra: Record<string, string> = {}) =>
      new Promise<any>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', childPath], {
          env: {
            ...process.env,
            OC_ADVISOR_CHILD_MODE: mode,
            OC_ADVISOR_DB: dbPath,
            OC_ADVISOR_QUEUE: queuePath,
            OC_ADVISOR_INVOCATION: 'cinv-retry-settle',
            OC_ADVISOR_TOKEN_FILE: join(dir, 'consult.token'),
            ...extra,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let out = ''
        let err = ''
        child.stdout.on('data', (c) => {
          out += String(c)
        })
        child.stderr.on('data', (c) => {
          err += String(c)
        })
        child.on('exit', (code) => {
          if (code !== 0) reject(new Error(err || out || `exit ${code}`))
          else {
            const line = out
              .trim()
              .split('\n')
              .filter((row) => row.startsWith('{'))
              .pop()
            resolve(JSON.parse(line || '{}'))
          }
        })
      })
    const first = await run('settle-pending')
    assert.equal(first.body.status, 'settle_pending')
    assert.equal(first.body.advice, 'check the assertion first')
    const second = await run('retry-settle', { OC_ADVISOR_SETTLE_POSTS: '1' })
    assert.equal(second.consultState, 'settled')
    assert.equal(second.advice, 'check the assertion first')
    assert.equal(second.body.advice, 'check the assertion first')
    assert.equal(second.spawn, 0)
    assert.equal(second.settlePosts, 2)
  })
})
