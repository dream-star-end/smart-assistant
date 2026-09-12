/**
 * handleConsultAdvisor → SessionManager.submit → real CcbAdapter/SubprocessRunner spawn.
 * Fake CCB stdio only; zero model / live token.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/advisorConsultCcbSpawnRoute.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
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
import { SessionManager } from '../sessionManager.js'
import { __setCcbSpawnForTests } from '../subprocessRunner.js'

const PARENT_KEY = 'agent:main:webchat:dm:wsess-advisor-ccb-spawn'
const TURN_KEY = 'd'.repeat(64)
const CCB_BIN = join(process.cwd(), 'claude-code-best')

process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
process.env.OC_MODEL_AUTHORITY = '0'

afterEach(() => {
  __setCcbSpawnForTests(null)
  _setModelCatalogClientForTests(null)
  process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
  process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
  process.env.OC_MODEL_AUTHORITY = '0'
})
after(() => {
  resetDelegateContextKeyForTests()
  __setCcbSpawnForTests(null)
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

class FakeCcbProc extends EventEmitter {
  killed = false
  pid = 4242
  stdout: EventEmitter & { setEncoding: () => unknown }
  stderr: EventEmitter & { setEncoding: () => unknown }
  stdin: EventEmitter & { write: (line: string, cb?: (err?: Error | null) => void) => boolean }
  constructor() {
    super()
    this.stdout = Object.assign(new EventEmitter(), { setEncoding() { return this } })
    this.stderr = Object.assign(new EventEmitter(), { setEncoding() { return this } })
    const self = this
    this.stdin = Object.assign(new EventEmitter(), {
      write: (line: string, cb?: (err?: Error | null) => void) => {
        if (cb) setImmediate(() => cb())
        if (String(line).includes('"type":"user"')) {
          setImmediate(() => {
            self.stdout.emit(
              'data',
              `${JSON.stringify({
                type: 'stream_event',
                event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'use the failing assertion' } },
              })}\n`,
            )
            self.stdout.emit(
              'data',
              `${JSON.stringify({
                type: 'result',
                result: 'use the failing assertion',
                total_cost_usd: 0.01,
                usage: { input_tokens: 2, output_tokens: 4 },
                is_error: false,
                stop_reason: 'end_turn',
              })}\n`,
            )
          })
        }
        return true
      },
    })
  }
  kill(): void {
    this.killed = true
    setImmediate(() => {
      this.emit('exit', 0, null)
      this.emit('close', 0, null)
    })
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
    configVersion: 'v1:advisor:MiniMax-M3',
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

describe('handleConsultAdvisor real CCB runner spawn', () => {
  it('assembles hermetic advisor argv/env and returns completed without admit', async () => {
    mkdirSync(CCB_BIN, { recursive: true })
    const dir = await mkdtemp(join(tmpdir(), 'oc-adv-ccb-spawn-'))
    const spawnCalls: Array<{ args: string[]; env: Record<string, string | undefined> }> = []
    __setCcbSpawnForTests((opts) => {
      spawnCalls.push({ args: opts.args, env: opts.env as Record<string, string | undefined> })
      return new FakeCcbProc() as never
    })
    _setModelCatalogClientForTests({
      configured: true,
      getView: async () => ccbCatalogView(),
      getRoutingView: async () => ccbCatalogView(),
      getToken: async () => 'local-catalog-token',
    } as never)

    const parent = {
      agentId: 'main',
      _collabModeTurn: 'advisor',
      _advisorTurn: { advisorModel: 'MiniMax-M3', configVersion: 'v1:advisor:MiniMax-M3' },
      _currentTurnKey: TURN_KEY,
      _currentTurnUserText: 'fix the red test',
      _injectedTurnConstraints: '',
      sessionKey: PARENT_KEY,
      channel: 'webchat',
      peerId: 'wsess-advisor-ccb-spawn',
      userId: '3',
      providerTag: 'ccb',
      runner: { getPartialSnapshot: () => ({ completedTools: [] }) },
    }
    const sm = new SessionManager({
      version: 1,
      gateway: { bind: '127.0.0.1', port: 19102, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: CCB_BIN },
      sessions: { dbPath: join(dir, 'sessions.db') },
      defaults: { model: 'MiniMax-M3', permissionMode: 'default' },
      terminal: { type: 'local' },
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
        gateway: { bind: '127.0.0.1', port: 19102, accessToken: 'test' },
        auth: { mode: 'subscription', claudeCodePath: CCB_BIN },
        defaults: { model: 'MiniMax-M3', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
        terminal: { type: 'local' },
      },
    }
    gw._getAgentsConfig = async () => ({
      default: 'main',
      agents: [{ id: 'main', provider: 'anthropic', model: 'MiniMax-M3' }],
    })
    const admits: unknown[] = []
    gw._delegateEngineBilling = {
      async admit(input: unknown) {
        admits.push(input)
        throw new Error('CCB consult must not admit')
      },
      async settle() {
        throw new Error('CCB consult must not settle')
      },
      async abandon() {
        throw new Error('CCB consult must not abandon')
      },
    }
    gw.sessions = sm
    const origGetByKey = sm.getByKey.bind(sm)
    sm.getByKey = ((key: string) => (key === PARENT_KEY ? parent : origGetByKey(key))) as typeof sm.getByKey

    await gw._advisorConfig.markProvenCcbModel({ modelId: 'MiniMax-M3', providerId: 'minimax' })
    const ok = await consult(gw, 'cinv-ccb-spawn-ok')
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.status, 'completed', JSON.stringify(ok.body))
    assert.equal(ok.body.billingMode, 'proxy')
    assert.match(String(ok.body.advice ?? ''), /failing assertion/)
    assert.equal(admits.length, 0)
    assert.ok(spawnCalls.length >= 1, `spawnCalls=${spawnCalls.length}`)
    const last = spawnCalls[spawnCalls.length - 1]
    assert.ok(last.args.includes('--bare'))
    assert.ok(last.args.includes('--strict-mcp-config'))
    assert.equal(last.args.includes('--resume'), false)
    assert.equal(last.args.includes('--permission-prompt-tool'), false)
    const toolsAt = last.args.indexOf('--tools')
    assert.ok(toolsAt >= 0)
    assert.equal(last.args[toolsAt + 1], '')
    assert.equal(last.env.OPENCLAUDE_CCB_ADVISOR_HERMETIC, '1')
    assert.equal(last.env.CLAUDE_CODE_UNATTENDED_RETRY, '0')
    assert.equal(last.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL, '1')
    assert.ok(String(last.env.HOME ?? '').includes('home'))
    assert.ok(String(last.env.CLAUDE_CONFIG_DIR ?? '').includes('claude-config'))
    assert.notEqual(last.env.HOME, process.env.HOME)
    const extra = last.env.CLAUDE_CODE_EXTRA_METADATA ?? ''
    assert.match(extra, /advisor/)
    assert.match(extra, /oc_parent_turn_key/)
  })
})
