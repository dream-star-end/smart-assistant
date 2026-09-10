/**
 * Subprocess helper for advisor consult recovery / route replay.
 * Modes: consult | replay | settle-pending | retry-settle
 */
import { CONSULT_INVOCATION_HEADER } from '@openclaude/protocol'

import { AdvisorConfigStore } from '../advisorConfigStore.js'
import { AdvisorConsultStore } from '../advisorConsultStore.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  DELEGATE_CONTEXT_HEADER,
  issueConsultTurnToken,
} from '../delegateContext.js'
import { createDelegateEngineBillingClient } from '../delegateEngineBilling.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-advisor-route'
const TURN_KEY = 'a'.repeat(64)
const REQUEST_ID = process.env.OC_ADVISOR_REQUEST_ID || 'ab'.repeat(16)

process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
process.env.OC_MODEL_AUTHORITY = '0'

const mode = process.env.OC_ADVISOR_CHILD_MODE || 'consult'
const dbPath = process.env.OC_ADVISOR_DB
const queuePath = process.env.OC_ADVISOR_QUEUE
const invocation = process.env.OC_ADVISOR_INVOCATION || 'cinv-child'
const question = process.env.OC_ADVISOR_QUESTION || 'why red?'
if (!dbPath) throw new Error('OC_ADVISOR_DB required')

function makeBillingStub() {
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
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const req: any = { method: 'POST', headers }
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
  await gw.handleConsultAdvisor(req, res)
  return { status, body: raw ? JSON.parse(raw) : {} }
}

async function makeGateway(opts?: { settleError?: boolean; billing?: any }) {
  const billing = opts?.billing ?? makeBillingStub()
  if (opts?.settleError && billing.settle) {
    const orig = billing.settle.bind(billing)
    billing.settle = async (frame: unknown) => {
      await orig(frame)
      throw new Error('master 503')
    }
  }
  const parent = {
    agentId: 'main',
    _collabModeTurn: 'advisor',
    _advisorTurn: { advisorModel: 'gpt-6-astra', configVersion: 'v1:advisor:gpt-6-astra' },
    _currentTurnKey: TURN_KEY,
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
  gw._advisorConsults = new AdvisorConsultStore(dbPath)
  gw._advisorConfig = new AdvisorConfigStore(
    String(dbPath).replace(/advisor-consults\.db$/, 'collaboration-config.json'),
  )
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
      gw._submitCount = (gw._submitCount ?? 0) + 1
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
      onEvent({ kind: 'block', block: { kind: 'text', text: 'check the assertion first' } })
    },
    interrupt: () => true,
  }
  return { gw, billing }
}

function tokenPath(): string {
  return process.env.OC_ADVISOR_TOKEN_FILE || join(dirname(String(dbPath)), 'consult.token')
}

function headers() {
  let token = process.env.OC_ADVISOR_TOKEN
  if (!token) {
    try {
      token = readFileSync(tokenPath(), 'utf8').trim()
    } catch {
      token = ''
    }
  }
  if (!token) {
    token = issueConsultTurnToken({
      agentId: 'main',
      sessionKey: PARENT_KEY,
      depth: 0,
      turnKey: TURN_KEY,
      turnIndex: 1,
      collabMode: 'advisor',
      configVersion: 'v1:advisor:gpt-6-astra',
    })
    writeFileSync(tokenPath(), token)
  }
  return {
    [DELEGATE_CONTEXT_HEADER]: token,
    [CONSULT_INVOCATION_HEADER]: invocation,
  }
}

const ENV = {
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:9',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'tok',
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    body: (async function* () {
      yield Buffer.from(JSON.stringify(body))
    })(),
  }
}

async function main() {
  if (mode === 'replay') {
    const { gw, billing } = await makeGateway()
    const r = await http(gw, { question }, headers())
    process.stdout.write(
      `${JSON.stringify({
        status: r.status,
        body: r.body,
        admit: billing.admits.length,
        spawn: gw._spawnCount ?? 0,
      })}\n`,
    )
    gw._advisorConsults.close()
    return
  }

  if (mode === 'settle-pending' || mode === 'retry-settle') {
    if (!queuePath) throw new Error('OC_ADVISOR_QUEUE required')
    let settlePosts = Number(process.env.OC_ADVISOR_SETTLE_POSTS || '0')
    const client = createDelegateEngineBillingClient({
      env: ENV,
      queuePath,
      retryMs: 60 * 60_000,
      startupRecovery: false,
      fetcher: (async (url: string) => {
        const path = String(url)
        if (path.includes('admit')) {
          return jsonResponse(200, {
            requestId: REQUEST_ID,
            engineSessionId: `oceng-${'b'.repeat(48)}`,
          })
        }
        if (path.includes('settle')) {
          settlePosts += 1
          if (settlePosts === 1) return jsonResponse(500, { error: { code: 'DELEGATE_ENGINE_BILLING_HTTP_500' } })
          return jsonResponse(200, { settled: true })
        }
        return jsonResponse(200, { ok: true })
      }) as any,
    })
    const { gw } = await makeGateway({ billing: client })
    if (mode === 'settle-pending') {
      const r = await http(gw, { question }, headers())
      process.stdout.write(
        `${JSON.stringify({
          status: r.status,
          body: r.body,
          admit: 1,
          settlePosts,
        })}\n`,
      )
    } else {
      await client.retryPending?.()
      const r = await http(gw, { question }, headers())
      const rec = gw._advisorConsults.findByInvocation({
        userId: '3',
        originTurnKey: TURN_KEY,
        invocationId: invocation,
      })
      process.stdout.write(
        `${JSON.stringify({
          status: r.status,
          body: r.body,
          consultState: rec?.state,
          advice: rec?.advice,
          spawn: gw._spawnCount ?? 0,
          settlePosts,
        })}\n`,
      )
    }
    gw._advisorConsults.close()
    return
  }

  const { gw, billing } = await makeGateway()
  const r = await http(gw, { question }, headers())
  process.stdout.write(
    `${JSON.stringify({
      status: r.status,
      body: r.body,
      admit: billing.admits.length,
      spawn: gw._spawnCount ?? 0,
    })}\n`,
  )
  gw._advisorConsults.close()
}

await main()
