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
