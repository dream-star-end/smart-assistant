/**
 * handleConsultAdvisor → SessionManager.submit → real CodexAppServerRunner spawn.
 * Fake app-server only; zero model / live token.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/advisorConsultSpawnRoute.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import type { spawn } from 'node:child_process'

import { CONSULT_INVOCATION_HEADER } from '@openclaude/protocol'

import { AdvisorConfigStore } from '../advisorConfigStore.js'
import { AdvisorConsultStore } from '../advisorConsultStore.js'
import {
  DELEGATE_CONTEXT_HEADER,
  issueConsultTurnToken,
  resetDelegateContextKeyForTests,
} from '../delegateContext.js'
import { DelegateJobStore } from '../delegateJobs.js'
import { __setCodexAppServerSpawnForTests } from '../engine/codexAppServerRunner.js'
import { CodexAdapter } from '../engine/codexAdapter.js'
import { Gateway, PerTurnDelegationGuard } from '../server.js'
import { SessionManager, type AgentSession } from '../sessionManager.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-advisor-spawn'
const TURN_KEY = 'a'.repeat(64)
const REQUEST_ID = 'ab'.repeat(16)

process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
process.env.OC_MODEL_AUTHORITY = '0'

afterEach(() => {
  __setCodexAppServerSpawnForTests(null)
  process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
  process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
  process.env.OC_MODEL_AUTHORITY = '0'
})
after(() => {
  resetDelegateContextKeyForTests()
  __setCodexAppServerSpawnForTests(null)
})

type JsonRpcRequest = { jsonrpc: string; id: number | string; method: string }

class FakeCodexProc extends EventEmitter {
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), {
    write: (line: string, callback?: (error?: Error | null) => void) => {
      const req = JSON.parse(String(line).trim()) as JsonRpcRequest
      const reply = (result: unknown) =>
        this.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result })}\n`))
      if (req.method === 'initialize') reply({})
      else if (req.method === 'thread/start') reply({ thread: { id: 'thr-adv-1' } })
      else if (req.method === 'thread/resume') reply({})
      else if (req.method === 'turn/start') {
        reply({ turn: { id: 'turn-1', status: 'inProgress' } })
        setImmediate(() => {
          this.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                jsonrpc: '2.0',
                method: 'turn/completed',
                params: { turn: { id: 'turn-1', status: 'completed', durationMs: 1 } },
              })}\n`,
            ),
          )
        })
      } else if (req.method === 'turn/interrupt') reply({})
      if (callback) setImmediate(() => callback())
      return true
    },
  })
  kill(): void {
    this.killed = true
    setImmediate(() => this.emit('close', 0, null))
  }
}

async function consult(gw: any, invocation: string) {
  const token = issueConsultTurnToken({
    agentId: 'main',
    sessionKey: PARENT_KEY,
    depth: 0,
    turnKey: TURN_KEY,
    turnIndex: 1,
    collabMode: 'advisor',
    configVersion: 'v1:advisor:gpt-6-astra',
  })
  const req: any = {
    method: 'POST',
    headers: {
      [DELEGATE_CONTEXT_HEADER]: token,
      [CONSULT_INVOCATION_HEADER]: invocation,
    },
  }
  gw.readBody = async () => JSON.stringify({ question: 'why red?' })
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

describe('handleConsultAdvisor real runner spawn', () => {
  it('old admit without route does not spawn codex; master official_oauth does', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-spawn-'))
    const savedEnv: Record<string, string | undefined> = {
      HOME: process.env.HOME,
      OPENCLAUDE_HOME: process.env.OPENCLAUDE_HOME,
      OPENCLAUDE_V3_MASTER_BASE_URL: process.env.OPENCLAUDE_V3_MASTER_BASE_URL,
      OPENCLAUDE_V3_CONTAINER_TOKEN: process.env.OPENCLAUDE_V3_CONTAINER_TOKEN,
      OC_RUNTIME_CHANNEL: process.env.OC_RUNTIME_CHANNEL,
      OC_USER_ID: process.env.OC_USER_ID,
    }
    process.env.HOME = dir
    process.env.OPENCLAUDE_HOME = dir
    delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
    delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
    delete process.env.OC_RUNTIME_CHANNEL
    delete process.env.OC_USER_ID
    try {
    const spawnCalls: string[][] = []
    __setCodexAppServerSpawnForTests(((cmd: string, args: string[]) => {
      spawnCalls.push(args)
      return new FakeCodexProc() as unknown as ReturnType<typeof spawn>
    }) as unknown as typeof spawn)

    const parent = {
      agentId: 'main',
      _collabModeTurn: 'advisor',
      _advisorTurn: { advisorModel: 'gpt-6-astra', configVersion: 'v1:advisor:gpt-6-astra' },
      _currentTurnKey: TURN_KEY,
      _currentTurnUserText: 'fix the red test',
      _injectedTurnConstraints: '',
      sessionKey: PARENT_KEY,
      channel: 'webchat',
      peerId: 'wsess-advisor-spawn',
      userId: '3',
      providerTag: 'ccb',
      runner: { getPartialSnapshot: () => ({ completedTools: [] }) },
    }
    const sm = new SessionManager({
      version: 1,
      gateway: { bind: '127.0.0.1', port: 19101, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: '' },
      sessions: { dbPath: join(dir, 'sessions.db') },
      defaults: { model: 'glm-5.2' },
    } as never)
    ;(sm as unknown as { _saveResumeMap: () => void })._saveResumeMap = () => {}

    const gw = Object.create(Gateway.prototype) as any
    gw._shuttingDown = false
    gw._activeDelegations = 0
    gw._activeDelegationsByParent = new Map()
    gw._runningDelegationsByParent = new Map()
    gw._hiddenDelegateGuard = new PerTurnDelegationGuard()
    gw._readDelegateMemoryPressure = () => null
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
        gateway: { bind: '127.0.0.1', port: 19101, accessToken: 'test' },
        auth: { mode: 'subscription', claudeCodePath: '/tmp/ccb' },
        defaults: { model: 'glm-5.2', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
      },
    }
    gw._getAgentsConfig = async () => ({
      default: 'main',
      agents: [{ id: 'main', provider: 'anthropic', model: 'glm-5.2' }],
    })
    const admits: unknown[] = []
    const abandons: string[] = []
    gw._delegateEngineBilling = {
      async admit(input: unknown) {
        admits.push(input)
        return { requestId: REQUEST_ID, engineSessionId: `oceng-${'b'.repeat(48)}` }
      },
      async settle() {},
      async abandon(id: string) {
        abandons.push(id)
      },
    }
    gw.sessions = {
      getByKey: (key: string) => (key === PARENT_KEY ? parent : undefined),
      destroySession: async () => {},
      getOrCreate: async () => {
        throw new Error('must not spawn without route')
      },
      submit: async () => {
        throw new Error('must not submit without route')
      },
    }
    const missing = await consult(gw, 'cinv-spawn-missing')
    assert.equal(missing.status, 503)
    assert.deepEqual(abandons, [REQUEST_ID])
    assert.equal(spawnCalls.length, 0)

    gw._delegateEngineBilling.admit = async (input: unknown) => {
      admits.push(input)
      return {
        requestId: REQUEST_ID,
        engineSessionId: `oceng-${'b'.repeat(48)}`,
        route: { kind: 'official_oauth', groupId: '42' },
      }
    }
    gw.sessions.getOrCreate = async (opts: { sessionKey: string; model?: string }) => {
      const adapter = new CodexAdapter({
        sessionKey: opts.sessionKey,
        agentId: 'advisor',
        agentBaseDir: dir,
        cwd: dir,
        model: 'gpt-6-astra',
        hermeticNoTools: true,
        config: gw.deps.config,
      } as never)
      const session = {
        sessionKey: opts.sessionKey,
        agentId: 'advisor',
        channel: 'advisor',
        peerId: 'wsess-advisor-spawn',
        title: 'advisor',
        startedAt: Date.now(),
        runner: adapter,
        ccbSessionId: null,
        lock: Promise.resolve(),
        lastUsedAt: 0,
        totalCostUSD: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        turns: 3,
        _lastCcbCumulativeCost: 0,
        toolUseIdToName: new Map(),
        executionTarget: { kind: 'local' },
        providerTag: 'codex',
        hermeticNoTools: true,
      } as unknown as AgentSession
      return session
    }
    gw.sessions.submit = (...args: unknown[]) =>
      (sm.submit as (...submitArgs: unknown[]) => Promise<void>)(...args)

    const ok = await consult(gw, 'cinv-spawn-official')
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.ok(spawnCalls.length >= 1, `spawnCalls=${spawnCalls.length}`)
    const args = spawnCalls[spawnCalls.length - 1]
    assert.ok(args.some((a) => a.includes('oc_chatgpt_official')), JSON.stringify(args))
    assert.ok(
      args.some((a) => a.includes('http://127.0.0.1:19101/internal/v3/codex-relay/backend-api/codex')),
      JSON.stringify(args),
    )
    assert.equal(args.some((a) => a.includes('api.openai.com')), false)
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
