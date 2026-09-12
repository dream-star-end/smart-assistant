/**
 * CCB advisor consult: no engine-reported admit, completed ≠ settled.
 * Run: npx tsx --test packages/gateway/src/__tests__/advisorConsultCcbRoute.test.ts
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
import { _setModelCatalogClientForTests } from '../modelCatalogClient.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-advisor-ccb'
const TURN_KEY = 'c'.repeat(64)

process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
process.env.OC_MODEL_AUTHORITY = '0'

afterEach(() => {
  process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
  process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
  process.env.OC_MODEL_AUTHORITY = '0'
  _setModelCatalogClientForTests(null)
})
after(() => {
  resetDelegateContextKeyForTests()
  _setModelCatalogClientForTests(null)
})

function ccbCatalogView() {
  const models = [
    {
      modelId: 'MiniMax-M3',
      displayName: 'MiniMax M3',
      engine: 'ccb' as const,
      providerId: 'minimax',
      contextWindow: 200000,
      supportedEfforts: ['high'],
      supportsVision: false,
      capabilityZero: false,
      supportsThinking: true,
      defaultEffort: 'high',
      available: true,
    },
    {
      modelId: 'glm-5.3-zai',
      displayName: 'GLM',
      engine: 'ccb' as const,
      providerId: 'zai',
      contextWindow: 200000,
      supportedEfforts: ['high'],
      supportsVision: false,
      capabilityZero: false,
      supportsThinking: true,
      defaultEffort: 'high',
      available: true,
    },
    {
      modelId: 'gpt-6-astra',
      displayName: 'GPT-6-Astra',
      engine: 'codex' as const,
      providerId: 'codex',
      contextWindow: 200000,
      supportedEfforts: [],
      supportsVision: false,
      capabilityZero: false,
      supportsThinking: false,
      defaultEffort: null,
      available: true,
    },
  ]
  return {
    models,
    projectionRevision: '1',
    availabilityRevision: '1',
    securityEpoch: '1',
    canonicalize: (id: string) => id,
    aliasEntries: () => [],
    isRoutable: (id: string) => models.some((row) => row.modelId === id),
    resolve: (id: string) => models.find((row) => row.modelId === id) ?? null,
    engineOf: (id: string) => models.find((row) => row.modelId === id)?.engine ?? null,
  }
}

async function withCcbCatalog<T>(fn: () => Promise<T>): Promise<T> {
  _setModelCatalogClientForTests({
    configured: true,
    getView: async () => ccbCatalogView(),
    getRoutingView: async () => ccbCatalogView(),
    getToken: async () => 'local-catalog-token',
  } as never)
  try {
    return await fn()
  } finally {
    _setModelCatalogClientForTests(null)
  }
}

async function http(
  gw: any,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const url = new URL(path, 'http://127.0.0.1')
  const req: any = { method, headers, url: path }
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
  } else {
    throw new Error(`unexpected path ${path}`)
  }
  return { status, body: raw ? JSON.parse(raw) : {} }
}

async function makeCcbGateway(opts?: { advisorModel?: string; emitTool?: boolean; emptyAdvice?: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-adv-ccb-'))
  const advisorModel = opts?.advisorModel ?? 'MiniMax-M3'
  const parent = {
    agentId: 'main',
    _collabModeTurn: 'advisor',
    _advisorTurn: { advisorModel, configVersion: `v1:advisor:${advisorModel}` },
    _currentTurnKey: TURN_KEY,
    _currentTurnUserText: 'fix the red test',
    _injectedTurnConstraints: 'keep the public API',
    sessionKey: PARENT_KEY,
    channel: 'webchat',
    peerId: 'wsess-advisor-ccb',
    userId: '3',
    providerTag: 'ccb',
    runner: { getPartialSnapshot: () => ({ completedTools: [] }) },
  }
  const admits: unknown[] = []
  const settles: unknown[] = []
  const abandons: string[] = []
  const gw = Object.create(Gateway.prototype) as any
  gw._shuttingDown = false
  gw._activeDelegations = 0
  gw._activeDelegationsByParent = new Map()
  gw._runningDelegationsByParent = new Map()
  gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
  gw._readDelegateMemoryPressure = () => null
  gw._delegateEngineBilling = {
    admits,
    settles,
    abandons,
    async admit(input: unknown) {
      admits.push(input)
      return { requestId: 'ab'.repeat(16), engineSessionId: `oceng-${'b'.repeat(48)}` }
    },
    async settle(frame: unknown) {
      settles.push(frame)
    },
    async abandon(id: string) {
      abandons.push(id)
    },
  }
  gw._advisorConsults = new AdvisorConsultStore(join(dir, 'advisor-consults.db'))
  gw._advisorConfig = new AdvisorConfigStore(join(dir, 'collaboration-config.json'))
  gw._delegateJobs = new DelegateJobStore({ ttlMs: 60_000 })
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.getUserId = () => '3'
  gw._loadClientSession = async () => null
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
    getOrCreate: async (createOpts: { advisorExecutionLock?: unknown; hermeticNoTools?: boolean }) => {
      gw._spawnCount = (gw._spawnCount ?? 0) + 1
      gw._lastCreateOpts = createOpts
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
      _traceId?: string,
      _conversationMode?: string,
      submitOpts?: { automaticRetryState?: { max?: number; attempt?: number } },
    ) => {
      gw._lastSubmitRequestId = requestId
      gw._lastSubmitOpts = submitOpts
      gw._submitCount = (gw._submitCount ?? 0) + 1
      if (opts?.emitTool) {
        onEvent({ kind: 'tool_use_detected', tool: { name: 'Bash', id: 't1', input: {} } })
      }
      if (!opts?.emptyAdvice) {
        onEvent({ kind: 'block', block: { kind: 'text', text: 'check the assertion first' } })
      }
    },
  }
  return { gw, admits, settles, abandons, dir }
}

function consultHeaders(over: Record<string, string> = {}, advisorModel = 'MiniMax-M3') {
  const token = issueConsultTurnToken({
    agentId: 'main',
    sessionKey: PARENT_KEY,
    depth: 0,
    turnKey: TURN_KEY,
    turnIndex: 1,
    collabMode: 'advisor',
    configVersion: `v1:advisor:${advisorModel}`,
  })
  return {
    [DELEGATE_CONTEXT_HEADER]: token,
    [CONSULT_INVOCATION_HEADER]: `cinv-ccb-${Math.random().toString(36).slice(2, 10)}`,
    ...over,
  }
}

describe('CCB advisor consult route', () => {
  it('unproven MiniMax is red; proven MiniMax completes with 0 admit and does not open GLM', async () => {
    await withCcbCatalog(async () => {
      const { gw, admits, settles, abandons } = await makeCcbGateway()
      const red = await http(
        gw,
        'POST',
        '/api/agents/advisor/consult',
        { question: 'why red?' },
        consultHeaders(),
      )
      assert.equal(red.status, 503, JSON.stringify(red.body))
      assert.equal(admits.length, 0)
      await gw._advisorConfig.markProvenCcbModel({ modelId: 'MiniMax-M3', providerId: 'minimax' })
      const listed = await http(gw, 'GET', '/api/collaboration-config')
      assert.equal(listed.status, 200)
      assert.deepEqual(
        listed.body.advisorModels.map((row: { id: string }) => row.id).sort(),
        ['MiniMax-M3', 'gpt-6-astra'].sort(),
      )
      assert.equal(
        listed.body.advisorModels.some((row: { id: string }) => row.id === 'glm-5.3-zai'),
        false,
      )
      const green = await http(
        gw,
        'POST',
        '/api/agents/advisor/consult',
        { question: 'why red?' },
        consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-ccb-green' }),
      )
      assert.equal(green.status, 200, JSON.stringify(green.body))
      assert.equal(green.body.status, 'completed')
      assert.equal(green.body.billingMode, 'proxy')
      assert.equal(green.body.advice, 'check the assertion first')
      assert.equal(green.body.requestId, undefined)
      assert.equal(admits.length, 0)
      assert.equal(settles.length, 0)
      assert.equal(abandons.length, 0)
      assert.equal(gw._lastSubmitRequestId, undefined)
      assert.equal(gw._lastSubmitOpts?.automaticRetryState?.max, 0)
      assert.equal(gw._lastCreateOpts?.hermeticNoTools, true)
      assert.equal(gw._lastCreateOpts?.advisorExecutionLock?.providerId, 'minimax')
      const rec = gw._advisorConsults.findById(green.body.consultId)
      assert.equal(rec.state, 'completed')
      assert.equal(rec.billingRequestId, null)
      const glmParent = await makeCcbGateway({ advisorModel: 'glm-5.3-zai' })
      glmParent.gw._advisorConfig = gw._advisorConfig
      const glm = await http(
        glmParent.gw,
        'POST',
        '/api/agents/advisor/consult',
        { question: 'why red?' },
        consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-ccb-glm' }, 'glm-5.3-zai'),
      )
      assert.equal(glm.status, 503, JSON.stringify(glm.body))
      assert.match(String(glm.body.error), /尚未完成无工具证明/)
    })
  })

  it('empty advice and tool events cannot complete; same invocation does not respawn', async () => {
    await withCcbCatalog(async () => {
      const empty = await makeCcbGateway({ emptyAdvice: true })
      await empty.gw._advisorConfig.markProvenCcbModel({ modelId: 'MiniMax-M3', providerId: 'minimax' })
      const failed = await http(
        empty.gw,
        'POST',
        '/api/agents/advisor/consult',
        { question: 'why red?' },
        consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-ccb-empty' }),
      )
      assert.equal(failed.body.status, 'failed')
      const tools = await makeCcbGateway({ emitTool: true })
      await tools.gw._advisorConfig.markProvenCcbModel({ modelId: 'MiniMax-M3', providerId: 'minimax' })
      const toolFail = await http(
        tools.gw,
        'POST',
        '/api/agents/advisor/consult',
        { question: 'why red?' },
        consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-ccb-tool' }),
      )
      assert.equal(toolFail.body.status, 'failed')
      const { gw } = await makeCcbGateway()
      await gw._advisorConfig.markProvenCcbModel({ modelId: 'MiniMax-M3', providerId: 'minimax' })
      const headers = consultHeaders({ [CONSULT_INVOCATION_HEADER]: 'cinv-ccb-reuse' })
      const first = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
      const second = await http(gw, 'POST', '/api/agents/advisor/consult', { question: 'why red?' }, headers)
      assert.equal(first.body.status, 'completed')
      assert.equal(second.body.reused, true)
      assert.equal(second.body.consultId, first.body.consultId)
      assert.equal(gw._spawnCount, 1)
    })
  })
})
