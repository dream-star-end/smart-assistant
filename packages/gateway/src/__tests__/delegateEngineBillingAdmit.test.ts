/**
 * handleDelegateTask × engine-reported 委派计费:
 *   (a) codex/grok submit 收到 32-hex requestId
 *   (b) codex_billing 事件 live settle 一次且带 mode=delegate 归因
 *   (c) glm 委派不签 requestId
 *   (d) 委派失败时 journal 被 abandon
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/delegateEngineBillingAdmit.test.ts
 */
import assert from 'node:assert/strict'
import { after, afterEach, describe, it } from 'node:test'

import { Gateway, PerTurnDelegationGuard } from '../server.js'
import type { DelegateEngineBillingClient } from '../delegateEngineBilling.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-engine-billing'
const REQUEST_ID = 'ab'.repeat(16)

const ENV_KEYS = ['OC_MODEL_AUTHORITY'] as const
const ORIG_ENV: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) ORIG_ENV[k] = process.env[k]
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (ORIG_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIG_ENV[k]
  }
}
afterEach(() => {
  process.env.OC_MODEL_AUTHORITY = '0'
})
after(() => {
  restoreEnv()
})
process.env.OC_MODEL_AUTHORITY = '0'

function makeBillingClient(): DelegateEngineBillingClient & {
  admits: unknown[]
  settles: unknown[]
  abandons: string[]
} {
  const admits: unknown[] = []
  const settles: unknown[] = []
  const abandons: string[] = []
  return {
    admits,
    settles,
    abandons,
    async admit(input) {
      admits.push(input)
      return { requestId: REQUEST_ID, engineSessionId: `oceng-${'b'.repeat(48)}` }
    },
    async settle(billing) {
      settles.push(billing)
    },
    async abandon(requestId) {
      abandons.push(requestId)
    },
  }
}

function makeGateway(opts?: {
  billing?: DelegateEngineBillingClient
  emitBilling?: boolean
  submitError?: Error
}): any {
  const billing = opts?.billing ?? makeBillingClient()
  const agent = { id: 'main', provider: 'anthropic', model: 'glm-5.2' }
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw.clientsByPeer = new Map()
  gw.lastActiveChannel = new Map()
  gw._seenIdempotencyKeys = new Map()
  gw._activeDelegations = 0
  gw._activeDelegationsByParent = new Map()
  gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
  gw._delegateEngineBilling = billing
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.rateLimiter = { check: () => true }
  gw.router = { route: () => ({ sessionKey: PARENT_KEY, agent }) }
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
    agents: [
      agent,
      { id: 'coding-assistant', model: 'glm-5.3-zai' },
      { id: 'auditor', model: 'gpt-5.6-sol' },
    ],
  })
  gw._isIdempotencyDuplicate = () => false
  gw._markIdempotencyKey = () => {}
  gw._runLog = { start: () => ({}), complete: () => {} }
  gw._lastSubmitRequestId = 'UNSET'
  gw.sessions = {
    destroySession: async () => {},
    beginClientTurn: () => {},
    endClientTurn: () => {},
    getByKey: () => ({
      _teamModeTurn: true,
      _currentTurnUserText: '测试任务',
      sessionKey: PARENT_KEY,
      channel: 'webchat',
      peerId: 'wsess-engine-billing',
    }),
    getOrCreate: async () => ({
      agentId: 'auditor',
      currentTurnStatus: null,
      runner: { interrupt: () => {}, sendPermissionResponse: () => {}, off: () => {}, on: () => {} },
    }),
    submit: async (
      _session: unknown,
      _payload: string,
      onEvent: (e: any) => void,
      _effort?: string | null,
      _model?: string,
      requestId?: string,
    ) => {
      gw._lastSubmitRequestId = requestId
      if (opts?.submitError) throw opts.submitError
      if (opts?.emitBilling) {
        onEvent({
          kind: 'codex_billing',
          requestId,
          engineSessionId: `oceng-${'b'.repeat(48)}`,
          status: 'success',
          durationMs: 11,
          usage: { input_tokens: 8, output_tokens: 3 },
          delegateAgentId: 'auditor',
          parentSessionId: 'wsess-engine-billing',
        })
      }
      onEvent({ kind: 'block', block: { kind: 'text', text: '子任务完成' } })
      onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
    },
    bufferPendingAgentGroup: () => true,
  }
  gw.deliver = () => {}
  return gw
}

async function delegate(
  gw: any,
  targetAgentId: string,
  body: Record<string, unknown>,
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
  await gw.handleDelegateTask(req, res, targetAgentId)
  return { status, body: raw ? JSON.parse(raw) : {} }
}

function memberBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: '实现子任务',
    context: '上下文…',
    sourceAgent: 'main',
    parentSessionKey: PARENT_KEY,
    ...extra,
  }
}

describe('handleDelegateTask engine-reported billing', () => {
  it('(a) codex 委派 submit 收到 32-hex requestId', async () => {
    const billing = makeBillingClient()
    const gw = makeGateway({ billing })
    const r = await delegate(gw, 'auditor', memberBody({ model: 'gpt-5.6-sol' }))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(gw._lastSubmitRequestId, REQUEST_ID)
    assert.equal((billing.admits[0] as { engine: string }).engine, 'codex')
    assert.equal((billing.admits[0] as { model: string }).model, 'gpt-5.6-sol')
    assert.match(gw._lastSubmitRequestId, /^[0-9a-f]{32}$/)
  })

  it('(b) 收到 codex_billing 后 live settle 一次且带 delegate 归因', async () => {
    const billing = makeBillingClient()
    const gw = makeGateway({ billing, emitBilling: true })
    const r = await delegate(gw, 'auditor', memberBody({ model: 'gpt-5.6-sol' }))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(billing.settles.length, 1)
    assert.equal(billing.abandons.length, 0)
    const settled = billing.settles[0] as {
      requestId: string
      delegateAgentId?: string
      parentSessionId?: string
      kind?: string
    }
    assert.equal(settled.requestId, REQUEST_ID)
    assert.equal(settled.delegateAgentId, 'auditor')
    assert.equal(settled.parentSessionId, 'wsess-engine-billing')
    assert.equal(settled.kind, undefined)
  })

  it('(c) glm 委派仍不签 requestId、不调 admit', async () => {
    const billing = makeBillingClient()
    const gw = makeGateway({ billing })
    const r = await delegate(gw, 'coding-assistant', memberBody({ model: 'glm-5.3-zai' }))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(gw._lastSubmitRequestId, undefined)
    assert.equal(billing.admits.length, 0)
    assert.equal(billing.settles.length, 0)
    assert.equal(billing.abandons.length, 0)
  })

  it('(d) 委派失败时 journal 被收口', async () => {
    const billing = makeBillingClient()
    const gw = makeGateway({ billing, submitError: new Error('runner crashed') })
    const r = await delegate(gw, 'auditor', memberBody({ model: 'gpt-5.6-sol' }))
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, false)
    assert.equal(billing.admits.length, 1)
    assert.equal(billing.settles.length, 0)
    assert.deepEqual(billing.abandons, [REQUEST_ID])
  })
})
