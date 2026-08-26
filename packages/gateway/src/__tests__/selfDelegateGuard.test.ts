/**
 * Run: npx tsx --test packages/gateway/src/__tests__/selfDelegateGuard.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Gateway, PerTurnDelegationGuard } from '../server.js'
import {
  parseDelegateAllowSelf,
  rejectSelfDelegate,
  SELF_DELEGATE_ERROR,
} from '../delegateModel.js'

describe('rejectSelfDelegate', () => {
  it('same agent 拒绝', () => {
    const r = rejectSelfDelegate({ callerAgentId: 'main', targetAgentId: 'main' })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.match(r.error, /不能把任务委派给自己/)
      assert.match(r.error, /--allow-self/)
      assert.equal(r.error, SELF_DELEGATE_ERROR)
    }
  })

  it('allowSelf 放行', () => {
    assert.equal(
      rejectSelfDelegate({ callerAgentId: 'main', targetAgentId: 'main', allowSelf: true }).ok,
      true,
    )
    assert.equal(parseDelegateAllowSelf(true), true)
    assert.equal(parseDelegateAllowSelf('true'), true)
  })

  it('其他成员 / 无 sourceAgent 放行', () => {
    assert.equal(
      rejectSelfDelegate({ callerAgentId: 'main', targetAgentId: 'coding-assistant' }).ok,
      true,
    )
    assert.equal(rejectSelfDelegate({ callerAgentId: '', targetAgentId: 'main' }).ok, true)
    assert.equal(rejectSelfDelegate({ targetAgentId: 'main' }).ok, true)
  })
})

function makeGateway(): any {
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
    agents: [agent, { id: 'coding-assistant' }],
  })
  gw._runLog = { start: () => ({}), complete: () => {} }
  gw._submitted = []
  gw.sessions = {
    destroySession: async () => {},
    getByKey: () => ({ _teamModeTurn: true, _currentTurnUserText: '测试任务' }),
    getOrCreate: async (opts: any) => ({
      agentId: opts?.agent?.id ?? 'coding-assistant',
      currentTurnStatus: null,
      runner: {
        interrupt: () => {},
        sendPermissionResponse: () => {},
        on: () => {},
        off: () => {},
      },
    }),
    retireKeepResume: async () => {},
    forgetResume: () => {},
    submit: async (_session: unknown, _payload: string, onEvent: (e: any) => void) => {
      gw._submitted.push(_payload)
      onEvent({ kind: 'block', block: { kind: 'text', text: '子任务完成' } })
      onEvent({ kind: 'final', meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } })
    },
    bufferPendingAgentGroup: () => true,
  }
  gw.deliver = () => {}
  return gw
}

async function call(
  gw: any,
  body: Record<string, unknown>,
  targetAgentId: string,
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

describe('handleDelegateTask self-delegate HTTP', () => {
  it('source===target → 400 且不 submit', async () => {
    const gw = makeGateway()
    const r = await call(gw, { goal: '自诊断', sourceAgent: 'main' }, 'main')
    assert.equal(r.status, 400)
    assert.match(String(r.body.error ?? ''), /不能把任务委派给自己/)
    assert.equal(gw._submitted.length, 0)
  })

  it('allowSelf 覆盖后继续 submit', async () => {
    const gw = makeGateway()
    const r = await call(gw, { goal: '自调用', sourceAgent: 'main', allowSelf: true }, 'main')
    assert.equal(r.status, 200)
    assert.equal(gw._submitted.length, 1)
  })

  it('system/cron 无 sourceAgent 放行', async () => {
    const gw = makeGateway()
    const r = await call(gw, { goal: 'cron 任务' }, 'main')
    assert.equal(r.status, 200)
    assert.equal(gw._submitted.length, 1)
  })
})
