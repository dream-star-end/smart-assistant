import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { spawn } from 'node:child_process'
import { ADVISOR_READ_ONLY_MCP_TOOLS } from '@openclaude/protocol'
import { buildCodexLaunchOverrides } from '../codexLaunchOverrides.js'
import { CodexAdapter } from '../engine/codexAdapter.js'
import { advisorReadOnlyThreadConfig } from '../engine/codexAdvisorReadOnly.js'
import type { EngineCreateOpts } from '../engine/registry.js'
import { CodexAppServerRunner, __setCodexAppServerSpawnForTests } from '../engine/codexAppServerRunner.js'

class Proc extends EventEmitter {
  userAgent = 'openclaude-gateway/0.163.0 (linux)'
  killed = false
  exitCode: number | null = null
  signalCode: string | null = null
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  requests: any[] = []
  stdin = Object.assign(new EventEmitter(), {
    write: (line: string, callback?: () => void) => {
      const req = JSON.parse(line)
      this.requests.push(req)
      if (req.id !== undefined && req.method) {
        const result = req.method === 'initialize' ? { userAgent: this.userAgent }
          : req.method === 'config/read' ? { config: { mcp_servers: { inherited: {}, openclaude_memory: {} } } }
          : req.method === 'thread/start' ? { thread: { id: 'read-only-thread' } }
          : req.method === 'turn/start' ? { turn: { id: 'read-only-turn', status: 'inProgress' } } : {}
        this.frame({ id: req.id, result })
        if (req.method === 'turn/start') setImmediate(() => this.frame({
          method: 'turn/completed', params: { threadId: req.params.threadId, turn: { id: 'read-only-turn', status: 'completed' } },
        }))
      }
      callback?.()
      return true
    },
  })
  frame(frame: unknown): void { this.stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...frame as object })}\n`)) }
  kill(): boolean {
    this.killed = true
    this.exitCode = 0
    setImmediate(() => this.emit('close', 0, null))
    return true
  }
}

afterEach(() => __setCodexAppServerSpawnForTests(null))

test('Codex read-only turn replaces a warm process, removes native execution, and restores normal tools', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-advisor-readonly-'))
  const launches: { args: string[]; proc: Proc }[] = []
  __setCodexAppServerSpawnForTests(((_cmd: string, args: string[]) => {
    const proc = new Proc()
    launches.push({ args, proc })
    return proc
  }) as unknown as typeof spawn)
  const runner = new CodexAppServerRunner({ sessionKey: 'advisor:test', agentId: 'main', cwd, model: 'gpt-6.1-sol' })
  runner.on('error', () => {})
  try {
    await runner.preheat()
    await runner.submit('只读分析', undefined, undefined, false, undefined, null, true)
    assert.equal(launches.length, 2, 'read-only must replace the unrestricted preheat')
    const restricted = launches[1]
    assert.ok(restricted.args.includes('features.shell_tool=false'))
    assert.ok(restricted.args.includes('features.image_generation=false'))
    assert.ok(restricted.args.includes('features.apps=false'))
    for (const req of restricted.proc.requests.filter(r => ['thread/start', 'thread/resume', 'turn/start'].includes(r.method))) {
      assert.deepEqual(req.params.environments, [], `${req.method} must omit the native execution environment`)
      if (req.method === 'turn/start') assert.deepEqual(req.params.sandboxPolicy, { type: 'readOnly', networkAccess: false })
      else assert.equal(req.params.sandbox, 'read-only')
      if (req.method !== 'turn/start') {
        assert.equal(req.params.config.mcp_servers.inherited.enabled, false)
        assert.equal(req.params.config.mcp_servers.openclaude_memory.enabled, false, 'a naked launch cannot trust a user-configured platform namesake')
      }
    }
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval']) {
      restricted.proc.frame({ id: `deny:${method}`, method, params: {} })
      assert.equal(restricted.proc.requests.at(-1).result.decision, 'denied')
    }
    restricted.proc.frame({ id: 'permissions', method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { write: ['/tmp'] } } } })
    assert.deepEqual(restricted.proc.requests.at(-1).result.permissions, {})
    await runner.submit('同一只读轮重试', undefined, undefined, false, undefined, null, true)
    assert.equal(launches.length, 2, 'same restriction can safely reuse its process')
    await runner.submit('现在修改', undefined, undefined, false, undefined, null, false)
    assert.equal(launches.length, 3, 'the next normal turn must restore ordinary tools')
    assert.ok(!launches[2].args.includes('features.shell_tool=false'))
    const normalTurn = launches[2].proc.requests.find(r => r.method === 'turn/start')
    assert.equal(normalTurn.params.environments, undefined)
    assert.deepEqual(normalTurn.params.sandboxPolicy, { type: 'dangerFullAccess' })
  } finally {
    await runner.shutdown()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Codex configuration preserves only a verified platform MCP transport and strips null defaults', () => {
  const config = { config: { mcp_servers: {
    inherited: { command: 'dangerous', tool_timeout_sec: null },
    openclaude_memory: { command: 'trusted', args: ['mcp.js'], tool_timeout_sec: null, env: { TOKEN_FILE: '/safe/file' } },
  } } }
  const restricted = advisorReadOnlyThreadConfig(config, true) as any
  assert.equal(restricted.mcp_servers.inherited.enabled, false)
  assert.equal(restricted.agents.enabled, false)
  assert.equal(restricted.features.multi_agent, false)
  assert.equal(restricted.features.image_generation, false)
  assert.equal(restricted.mcp_servers.openclaude_memory.command, 'trusted')
  assert.deepEqual(restricted.mcp_servers.openclaude_memory.enabled_tools, [...ADVISOR_READ_ONLY_MCP_TOOLS])
  assert.deepEqual(restricted.mcp_servers.openclaude_memory.env, { TOKEN_FILE: '/safe/file', OPENCLAUDE_ADVISOR_READ_ONLY: '1' })
  assert.equal('tool_timeout_sec' in restricted.mcp_servers.openclaude_memory, false)
  assert.throws(() => advisorReadOnlyThreadConfig({}), /CONFIG_UNAVAILABLE/)
})

test('an incompatible Codex runtime fails closed before opening a restricted thread or turn', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-advisor-old-'))
  const proc = new Proc()
  proc.userAgent = 'openclaude-gateway/0.153.3 (linux)'
  __setCodexAppServerSpawnForTests((() => proc) as unknown as typeof spawn)
  const runner = new CodexAppServerRunner({ sessionKey: 'advisor:old', agentId: 'main', cwd })
  const messages: any[] = []
  runner.on('error', () => {})
  runner.on('message', message => messages.push(message))
  try {
    await runner.submit('只读', undefined, undefined, false, undefined, null, true)
    assert.ok(!proc.requests.some(r => r.method === 'thread/start' || r.method === 'turn/start'))
    assert.match(messages.find(m => m.type === 'result').result, /CODEX_ADVISOR_READ_ONLY_UNSUPPORTED/)
  } finally {
    await runner.shutdown()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Codex resumed advisor thread receives read-only environment and sandbox before its first turn', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-advisor-resume-'))
  const proc = new Proc()
  __setCodexAppServerSpawnForTests((() => proc) as unknown as typeof spawn)
  const runner = new CodexAppServerRunner({ sessionKey: 'advisor:resume', agentId: 'main', cwd, resumeSessionId: 'existing-thread' })
  runner.on('error', () => {})
  try {
    await runner.submit('只读分析', undefined, undefined, false, undefined, null, true)
    const resume = proc.requests.find(r => r.method === 'thread/resume')
    assert.deepEqual(resume.params.environments, [])
    assert.equal(resume.params.sandbox, 'read-only')
  } finally {
    await runner.shutdown()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('CodexAdapter forwards the frozen policy to the real queued runner', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-advisor-adapter-'))
  const proc = new Proc()
  let argv: string[] = []
  __setCodexAppServerSpawnForTests(((_cmd: string, args: string[]) => { argv = args; return proc }) as unknown as typeof spawn)
  const adapter = new CodexAdapter({ sessionKey: 'advisor:adapter', agentId: 'main', agentBaseDir: cwd } as EngineCreateOpts)
  adapter.on('error', () => {})
  try {
    const run = adapter.submitTurn({
      input: '分析', onEvent: () => {}, readOnly: true,
      sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    })
    await run.submitted
    assert.ok(argv.includes('features.shell_tool=false'))
    assert.deepEqual(proc.requests.find(r => r.method === 'turn/start').params.environments, [])
  } finally {
    await adapter.shutdown()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('Codex launch allows safe platform reads and consult while installing the MCP invocation guard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-advisor-mcp-'))
  try {
    const context = { agentId: 'main', sessionKey: 'agent:main:webchat:dm:advisor-probe', sessionDir: dir, gatewayPort: 18789, gatewayToken: 'test-token' }
    const restricted = await buildCodexLaunchOverrides({ ...context, readOnly: true })
    const allowed = restricted.argvOverrides.find(a => a.startsWith('mcp_servers.openclaude_memory.enabled_tools='))
    assert.ok(allowed, 'platform MCP must remain mounted')
    assert.deepEqual(JSON.parse(allowed.slice(allowed.indexOf('=') + 1)), [...ADVISOR_READ_ONLY_MCP_TOOLS])
    assert.ok(restricted.argvOverrides.find(a => a.startsWith('mcp_servers.openclaude_memory.env='))?.includes('"OPENCLAUDE_ADVISOR_READ_ONLY"="1"'))
    const ordinary = await buildCodexLaunchOverrides(context)
    assert.ok(!ordinary.argvOverrides.some(a => a.includes('enabled_tools=')))
    assert.ok(ordinary.argvOverrides.find(a => a.startsWith('mcp_servers.openclaude_memory.env='))?.includes('"OPENCLAUDE_ADVISOR_READ_ONLY"="0"'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('OCV5-798: readOnly turn forces Standard default even when serviceTier is fast/ultrafast', async () => {
  const { buildCodexTurnPolicyParams } = await import('../engine/codexAdvisorReadOnly.js')
  const roSol = buildCodexTurnPolicyParams('check', 'th1', {
    model: 'gpt-6.2-sol',
    serviceTier: 'ultrafast',
    mode: 'default',
    readOnly: true,
  })
  assert.equal(roSol.serviceTierForTurn, 'default')
  const normSol = buildCodexTurnPolicyParams('check', 'th1', {
    model: 'gpt-6.2-sol',
    serviceTier: 'ultrafast',
    mode: 'default',
    readOnly: false,
  })
  assert.equal(normSol.serviceTierForTurn, 'ultrafast')
})

test('OCV5-805: ensureCodexTurnServiceTierSupported checks model/list on every call, paginates, retries once, and times out cleanly', async () => {
  const {
    ensureCodexTurnServiceTierSupported,
    modelListAdvertisesServiceTier,
  } = await import('../engine/codexAdvisorReadOnly.js')

  assert.equal(modelListAdvertisesServiceTier({
    data: [{ id: 'gpt-6.2-sol', serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] }],
  }, 'gpt-6.2-sol', 'ultrafast'), true)
  assert.equal(modelListAdvertisesServiceTier({
    data: [{ id: 'gpt-6.2-sol', additionalSpeedTiers: ['fast', 'ultrafast'] }],
  }, 'gpt-6.2-sol', 'ultrafast'), true)
  assert.equal(modelListAdvertisesServiceTier({
    data: [{ id: 'gpt-6.2-sol', serviceTiers: [{ id: 'priority' }], additionalSpeedTiers: ['fast'] }],
  }, 'gpt-6.2-sol', 'ultrafast'), false)

  let calls = 0
  const paginatedList = async (cursor?: string) => {
    calls++
    if (!cursor) return { data: [{ id: 'gpt-6.2-astra', serviceTiers: [{ id: 'priority' }] }], nextCursor: 'p2' }
    return { data: [{ id: 'gpt-6.2-sol', serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] }], nextCursor: null }
  }
  await ensureCodexTurnServiceTierSupported({
    model: 'gpt-6.2-sol', readOnly: false, serviceTier: 'ultrafast', remote: false,
    initialized: { userAgent: 'codex-cli/0.170.0' }, listModels: paginatedList,
  })
  assert.equal(calls, 2)
  await ensureCodexTurnServiceTierSupported({
    model: 'gpt-6.2-sol', readOnly: false, serviceTier: 'ultrafast', remote: false,
    initialized: { userAgent: 'codex-cli/0.170.0' }, listModels: paginatedList,
  })
  assert.equal(calls, 4, 'must re-query live model/list on every Ultrafast turn without stale cross-turn cache')

  for (const skipOpts of [
    { model: 'gpt-6.2-sol', readOnly: false, serviceTier: 'fast' as const, remote: false, initialized: { userAgent: 'codex-cli/0.170.0' } },
    { model: 'gpt-6.2-sol', readOnly: true, serviceTier: 'ultrafast' as const, remote: false, initialized: { userAgent: 'codex-cli/0.170.0' } },
    { model: 'gpt-6.2-sol', readOnly: false, serviceTier: 'ultrafast' as const, remote: true, initialized: { userAgent: 'codex-cli/0.170.0' } },
    { model: 'gpt-6.2-sol', readOnly: false, serviceTier: 'ultrafast' as const, remote: false, initialized: {} },
  ]) {
    await ensureCodexTurnServiceTierSupported({ ...skipOpts, listModels: paginatedList })
  }
  assert.equal(calls, 4)

  let retryCalls = 0
  await ensureCodexTurnServiceTierSupported({
    model: 'gpt-6.2-sol', readOnly: false, serviceTier: 'ultrafast', remote: false,
    initialized: { userAgent: 'codex-cli/0.170.0' },
    listModels: async () => {
      retryCalls++
      return { data: [{ id: 'gpt-6.2-sol', serviceTiers: retryCalls >= 2 ? ['ultrafast'] : ['priority'] }] }
    },
    waitRetryMs: async () => {},
  })
  assert.equal(retryCalls, 2)

  const preAborted = new AbortController()
  preAborted.abort('user-stop')
  await assert.rejects(
    () => ensureCodexTurnServiceTierSupported({
      model: 'gpt-6.2-sol', readOnly: false, serviceTier: 'ultrafast', remote: false,
      initialized: { userAgent: 'codex-cli/0.170.0' }, signal: preAborted.signal,
      listModels: paginatedList,
    }),
    /user-stop/,
  )

  let receivedSignal: AbortSignal | undefined
  await assert.rejects(
    () => ensureCodexTurnServiceTierSupported({
      model: 'gpt-6.2-sol', readOnly: false, serviceTier: 'ultrafast', remote: false,
      initialized: { userAgent: 'codex-cli/0.170.0' }, timeoutMs: 25,
      listModels: (_cursor, signal) => new Promise((_resolve, reject) => {
        receivedSignal = signal
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    }),
    /CODEX_ULTRAFAST_UNAVAILABLE.*timed out/,
  )
  assert.equal(receivedSignal?.aborted, true)
})

test('OCV5-805: Ultrafast preflight stops A->B switchover, runs before native compaction >=80%, and handles hung timeout/stop/shutdown', async () => {
  const { _setUltrafastCheckTimeoutForTests } = await import('../engine/codexAdvisorReadOnly.js')

  interface ObservedBilling {
    requestId?: string
    terminalCode?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      reasoning_output_tokens?: number
    }
  }
  interface TierRpcRequest {
    id?: number
    method?: string
    params?: { threadId?: string; serviceTierForTurn?: string }
  }

  let catalogMode: 'ultrafast' | 'recover' | 'unavailable' | 'hang' = 'recover'
  let listCount = 0
  let seedHighWaterOnNextTurn = true
  let totalIn = 0
  let totalOut = 0
  let turnSeq = 0
  let onHungModelList: ((reqId: number) => void) | null = null
  const spawns: TierProc[] = []

  class TierProc extends Proc {
    override userAgent = 'codex-cli/0.170.0 (linux)'
    tierRequests: TierRpcRequest[] = []

    emitUsageFrame(turnId: string, addIn: number, addOut: number, lastTotalTokens: number): void {
      totalIn += addIn
      totalOut += addOut
      this.frame({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'uf-thread',
          turnId,
          tokenUsage: {
            modelContextWindow: 1000,
            last: {
              totalTokens: lastTotalTokens,
              inputTokens: addIn,
              outputTokens: addOut,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
            },
            total: {
              totalTokens: totalIn + totalOut,
              inputTokens: totalIn,
              outputTokens: totalOut,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
            },
          },
        },
      })
    }

    override stdin = Object.assign(new EventEmitter(), {
      write: (line: string, callback?: () => void) => {
        const req = JSON.parse(line) as TierRpcRequest
        this.requests.push(req)
        this.tierRequests.push(req)
        if (req.id !== undefined && req.method) {
          if (req.method === 'model/list') {
            listCount++
            if (catalogMode === 'hang') {
              const hungId = req.id
              setTimeout(() => onHungModelList?.(hungId), 15)
              callback?.()
              return true
            }
            const supported = catalogMode === 'ultrafast' || (catalogMode === 'recover' && listCount >= 2)
            this.frame({
              id: req.id,
              result: {
                data: [{ id: 'gpt-6.2-sol', serviceTiers: supported ? [{ id: 'priority' }, { id: 'ultrafast' }] : [{ id: 'priority' }] }],
              },
            })
            callback?.()
            return true
          }

          if (req.method === 'thread/compact/start') {
            const compactId = `compact-${++turnSeq}`
            this.frame({ id: req.id, result: {} })
            setImmediate(() => {
              this.frame({ method: 'turn/started', params: { threadId: 'uf-thread', turn: { id: compactId } } })
              this.frame({
                method: 'item/started',
                params: { threadId: 'uf-thread', turnId: compactId, item: { id: `ci-${turnSeq}`, type: 'contextCompaction' } },
              })
              this.emitUsageFrame(compactId, 90, 30, 120)
              this.frame({
                method: 'item/completed',
                params: { threadId: 'uf-thread', turnId: compactId, item: { id: `ci-${turnSeq}`, type: 'contextCompaction' } },
              })
              this.frame({ method: 'turn/completed', params: { threadId: 'uf-thread', turn: { id: compactId, status: 'completed' } } })
            })
            callback?.()
            return true
          }

          let result: unknown = {}
          if (req.method === 'initialize') result = { userAgent: this.userAgent }
          else if (req.method === 'thread/start' || req.method === 'thread/resume') result = { thread: { id: 'uf-thread' } }
          else if (req.method === 'turn/start') result = { turn: { id: `uf-turn-${++turnSeq}`, status: 'inProgress' } }
          this.frame({ id: req.id, result })

          if (req.method === 'turn/start') {
            const turnId = `uf-turn-${turnSeq}`
            const lastTokens = seedHighWaterOnNextTurn ? 900 : 200
            setImmediate(() => {
              this.frame({ method: 'turn/started', params: { threadId: 'uf-thread', turn: { id: turnId } } })
              this.emitUsageFrame(turnId, 80, 20, lastTokens)
              this.frame({ method: 'turn/completed', params: { threadId: 'uf-thread', turn: { id: turnId, status: 'completed' } } })
            })
          }
        }
        callback?.()
        return true
      },
    })
  }

  const cwd = await mkdtemp(join(tmpdir(), 'codex-ultrafast-gate-'))
  __setCodexAppServerSpawnForTests((() => {
    const p = new TierProc()
    spawns.push(p)
    return p
  }) as unknown as typeof spawn)

  const adapter = new CodexAdapter({
    sessionKey: 'ultrafast:gate', agentId: 'main', agentBaseDir: cwd, cwd, model: 'gpt-6.2-sol',
  } as unknown as EngineCreateOpts)
  const billings: ObservedBilling[] = []
  adapter.on('billing', (b) => billings.push(b as ObservedBilling))

  const reqMethods = (proc: TierProc) => proc.tierRequests.map((r) => r.method).filter((m): m is string => Boolean(m))
  const countMethod = (proc: TierProc, method: string) => reqMethods(proc).filter((m) => m === method).length
  const assertZeroUsage = (billing: ObservedBilling | undefined, code: string) => {
    assert.ok(billing, `missing billing event for ${code}`)
    assert.equal(billing.terminalCode, code)
    assert.equal(billing.usage?.input_tokens ?? 0, 0)
    assert.equal(billing.usage?.output_tokens ?? 0, 0)
    assert.equal(billing.usage?.cache_read_input_tokens ?? 0, 0)
    assert.equal(billing.usage?.reasoning_output_tokens ?? 0, 0)
    assert.equal(billing.usage, undefined)
  }

  try {
    // 1. P1-2 + P0 seeding: Turn 1 recovers on retry, sends ultrafast, seeds 900/1000 high-water on same TierProc.
    seedHighWaterOnNextTurn = true
    const t1 = adapter.submitTurn({
      input: 'turn-1-account-a', requestId: 'req-uf-a', serviceTier: 'ultrafast',
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    })
    await t1.submitted
    const s1 = await t1.summary
    assert.equal(s1?.isError, false)
    assert.equal(spawns.length, 1)
    assert.equal(listCount, 2)
    assert.equal(spawns[0].tierRequests.find((r) => r.method === 'turn/start')?.params?.serviceTierForTurn, 'ultrafast')
    const b1 = billings.find((b) => b.requestId === 'req-uf-a')
    assert.ok((b1?.usage?.input_tokens ?? 0) > 0 && (b1?.usage?.output_tokens ?? 0) > 0)

    // 2. Same-proc A->B switchover on >=80% high-water thread: Turn 2 MUST verify before thread/compact/start & turn/start.
    catalogMode = 'unavailable'
    listCount = 0
    const compactBefore2 = countMethod(spawns[0], 'thread/compact/start')
    const turnBefore2 = countMethod(spawns[0], 'turn/start')
    const t2 = adapter.submitTurn({
      input: 'turn-2-account-b-highwater', requestId: 'req-uf-ab', serviceTier: 'ultrafast',
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    })
    await t2.submitted
    const s2 = await t2.summary
    assert.equal(s2?.isError, true)
    assert.match(String(s2?.errorDetail ?? ''), /CODEX_ULTRAFAST_UNAVAILABLE/)
    assert.equal(spawns.length, 1, 'no proc restart between Account A and Account B')
    assert.equal(listCount, 2)
    assert.equal(countMethod(spawns[0], 'thread/compact/start'), compactBefore2, 'must refuse before thread/compact/start')
    assert.equal(countMethod(spawns[0], 'turn/start'), turnBefore2, 'must refuse before turn/start')
    assertZeroUsage(billings.find((b) => b.requestId === 'req-uf-ab'), 'CODEX_ERROR')

    // 3. Positive control on still-high-water thread: Ultrafast succeeds -> runs model/list BEFORE compact -> turn/start, bills >0.
    catalogMode = 'ultrafast'
    seedHighWaterOnNextTurn = true
    const reqMark3 = spawns[0].tierRequests.length
    const t3 = adapter.submitTurn({
      input: 'turn-3-highwater-pass', requestId: 'req-uf-pass', serviceTier: 'ultrafast',
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    })
    await t3.submitted
    const s3 = await t3.summary
    assert.equal(s3?.isError, false)
    const slice3 = spawns[0].tierRequests.slice(reqMark3).map((r) => r.method).filter((m): m is string => Boolean(m))
    const idxList = slice3.indexOf('model/list')
    const idxCompact = slice3.indexOf('thread/compact/start')
    const idxTurn = slice3.indexOf('turn/start')
    assert.ok(idxList !== -1 && idxCompact !== -1 && idxTurn !== -1, `expected model/list -> compact -> turn/start, got ${JSON.stringify(slice3)}`)
    assert.ok(idxList < idxCompact && idxCompact < idxTurn, `wrong order: ${JSON.stringify(slice3)}`)
    const b3 = billings.find((b) => b.requestId === 'req-uf-pass')
    assert.ok((b3?.usage?.input_tokens ?? 0) > 0 && (b3?.usage?.output_tokens ?? 0) > 0)

    // 4. Hung model/list timeout on same live proc -> fails closed (0 compact, 0 turn/start, 0 usage), ignores late reply, recovers!
    _setUltrafastCheckTimeoutForTests(40)
    catalogMode = 'hang'
    let hungRequestId = -1
    onHungModelList = (reqId) => { hungRequestId = reqId }
    const reqMark4 = spawns[0].tierRequests.length
    const t4 = adapter.submitTurn({
      input: 'turn-4-hung-timeout', requestId: 'req-uf-timeout', serviceTier: 'ultrafast',
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    })
    await t4.submitted
    const s4 = await t4.summary
    assert.equal(s4?.isError, true)
    assert.match(String(s4?.errorDetail ?? ''), /CODEX_ULTRAFAST_UNAVAILABLE.*timed out/)
    assert.equal(spawns[0].tierRequests.slice(reqMark4).some((r) => r.method === 'thread/compact/start' || r.method === 'turn/start'), false)
    assertZeroUsage(billings.find((b) => b.requestId === 'req-uf-timeout'), 'CODEX_ERROR')

    // Inject late model/list response for the aborted pending RPC, restore timeout/catalog, verify exact same TierProc recovers!
    assert.ok(hungRequestId > 0)
    spawns[0].frame({ id: hungRequestId, result: { data: [] } })
    _setUltrafastCheckTimeoutForTests(null)
    catalogMode = 'ultrafast'
    seedHighWaterOnNextTurn = true
    const t4b = adapter.submitTurn({
      input: 'turn-4b-recover', requestId: 'req-uf-recover-same-proc', serviceTier: 'ultrafast',
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    })
    await t4b.submitted
    assert.equal((await t4b.summary)?.isError, false)
    assert.equal(spawns.length, 1, 'timeout recovery must reuse the same proc')

    // 5. Stop (interrupt) during hung model/list while high-water >=80% -> USER_CANCELLED, 0 compact, 0 turn/start, 0 usage, next turn works!
    catalogMode = 'hang'
    onHungModelList = () => { adapter.interrupt() }
    const reqMark5 = spawns[0].tierRequests.length
    const t5 = adapter.submitTurn({
      input: 'turn-5-hung-stop', requestId: 'req-uf-stop', serviceTier: 'ultrafast',
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    })
    await t5.submitted
    const s5 = await t5.summary
    assert.equal(s5?.isError, true)
    assert.equal(s5?.stopReason, 'interrupted')
    assert.equal(spawns[0].tierRequests.slice(reqMark5).some((r) => r.method === 'thread/compact/start' || r.method === 'turn/start'), false)
    assertZeroUsage(billings.find((b) => b.requestId === 'req-uf-stop'), 'USER_CANCELLED')

    catalogMode = 'ultrafast'
    seedHighWaterOnNextTurn = false
    const t5b = adapter.submitTurn({
      input: 'turn-5b-after-stop', requestId: 'req-uf-after-stop', serviceTier: 'ultrafast',
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    })
    await t5b.submitted
    assert.equal((await t5b.summary)?.isError, false)

    // 6. Warning 2: adapter.shutdown() during hung model/list must NOT misclassify as USER_CANCELLED.
    catalogMode = 'hang'
    onHungModelList = () => { void adapter.shutdown() }
    const t6 = adapter.submitTurn({
      input: 'turn-6-hung-shutdown', requestId: 'req-uf-shutdown', serviceTier: 'ultrafast',
      onEvent: () => {}, sessionTotals: { totalCostUSD: 0, turns: 0 }, toolUseIdToName: new Map(),
    })
    await t6.submitted
    const s6 = await t6.summary
    assert.equal(s6?.isError, true)
    assert.notEqual(s6?.stopReason, 'interrupted')
    assert.notEqual(billings.find((b) => b.requestId === 'req-uf-shutdown')?.terminalCode, 'USER_CANCELLED')
  } finally {
    _setUltrafastCheckTimeoutForTests(null)
    await adapter.shutdown()
    await rm(cwd, { recursive: true, force: true })
  }
})
