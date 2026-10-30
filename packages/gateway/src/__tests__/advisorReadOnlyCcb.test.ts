import './helpers/subprocessRunnerSpawnEnvIsolate.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SubprocessRunner, __setCcbSpawnForTests } from '../subprocessRunner.js'
import type { SpawnOpts } from '../terminalBackend.js'

class Child extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
  stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
  stdin = Object.assign(new EventEmitter(), {
    write(_line: string, cb?: () => void) { cb?.(); return true }, end: () => { setImmediate(() => this.finish()) },
  })
  finish() { this.emit('exit', 0, null); this.stdout.emit('close'); this.stderr.emit('close'); this.emit('close', 0, null) }
}

test('CCB warm transitions rebuild the tool surface and drop external MCP before user input', async () => {
  const captures: Array<{ args: string[]; config: any; env: Record<string, string> }> = []
  let child: Child | undefined
  __setCcbSpawnForTests((opts: SpawnOpts) => {
    const file = opts.args[opts.args.indexOf('--mcp-config') + 1]!
    captures.push({ args: opts.args, config: JSON.parse(readFileSync(file, 'utf8')), env: opts.env })
    child = new Child()
    return child as never
  })
  const runner = new SubprocessRunner({
    sessionKey: 'agent:main:webchat:dm:advisor-readonly', agentId: 'main',
    agentBaseDir: process.env.OPENCLAUDE_HOME!,
    agentMcpServers: [{ id: 'rogue-agent', command: 'mutation-server' }],
    config: {
      auth: { mode: 'subscription', claudeCodePath: process.cwd() + '/claude-code-best', claudeCodeRuntime: 'node' },
      gateway: { port: 0, accessToken: 'test' }, provider: 'anthropic',
      defaults: { permissionMode: 'bypassPermissions' }, terminal: { type: 'local' },
      mcpServers: [{ id: 'rogue-global', command: 'mutation-server' }],
    },
  } as never)
  let recycled = 0
  const shutdown = runner.shutdown.bind(runner)
  runner.shutdown = async () => { recycled++; await shutdown() }
  try {
    for (const readOnly of [false, true, true, false]) {
      runner.setReadOnly(readOnly)
      await runner.submit('verify the outline')
    }
    assert.equal(captures.length, 3, 'same-policy warm submit reuses the process')
    assert.equal(recycled, 2, 'both restriction edges recycle before submitting')
    const [normal, restricted, restored] = captures
    assert.equal(normal!.args.includes('--tools'), false)
    assert.equal(restored!.args.includes('--tools'), false)
    assert.equal(restricted!.args[restricted!.args.indexOf('--tools') + 1], 'Read,Glob,Grep')
    assert.equal(restricted!.args.includes('--strict-mcp-config'), true)
    assert.deepEqual(Object.keys(restricted!.config.mcpServers), ['openclaude-memory'])
    assert.equal(restricted!.config.mcpServers['openclaude-memory'].env.OPENCLAUDE_ADVISOR_READ_ONLY, '1')
    assert.equal(restricted!.env.ENABLE_SEARCH_EXTRA_TOOLS, 'false')
    assert.equal(restored!.config.mcpServers['openclaude-memory'].env.OPENCLAUDE_ADVISOR_READ_ONLY, '0')
    assert.ok(restored!.config.mcpServers['rogue-global'])
    assert.ok(restored!.config.mcpServers['rogue-agent'])
  } finally {
    await shutdown()
    __setCcbSpawnForTests(null)
  }
})
