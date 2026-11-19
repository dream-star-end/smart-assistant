/**
 * Real stdio entry: oc_bash / oc_grep / oc_glob are listed and callable only
 * when OPENCLAUDE_ENGINE=antigravity.
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/localCliToolsMcp.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const LOCAL_CLI = ['oc_bash', 'oc_grep', 'oc_glob'] as const

function childEnv(engine: string | null, home: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  for (const key of [
    'OPENCLAUDE_SKILL_EVAL_MODE',
    'OPENCLAUDE_SKILL_EVAL_EXCLUDE',
    'OPENCLAUDE_SKILL_EVAL_DRAFT_NAME',
    'OPENCLAUDE_SKILL_EVAL_DRAFT_DIR',
    'OPENCLAUDE_SKILL_TRAIN_RUN_ID',
    'OPENCLAUDE_PROJECT_ID',
    'OC_P5_PROJECT_SEARCH',
  ]) {
    delete env[key]
  }
  if (engine === null) Reflect.deleteProperty(env, 'OPENCLAUDE_ENGINE')
  else env.OPENCLAUDE_ENGINE = engine
  env.HOME = home
  env.OPENCLAUDE_HOME = home
  env.OPENCLAUDE_GATEWAY_PORT = '9'
  env.OPENCLAUDE_AGENT_ID = 'main'
  return env
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function toolText(result: unknown): string {
  const content = (result as { content?: unknown }).content
  assert.ok(Array.isArray(content) && content.length > 0)
  return String((content[0] as { text?: string }).text ?? '')
}

async function withServer(
  engine: string | null,
  home: string,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: join(root, 'node_modules/.bin/tsx'),
    args: ['packages/mcp-memory/src/index.ts'],
    cwd: root,
    env: childEnv(engine, home),
    stderr: 'pipe',
  })
  const client = new Client(
    { name: 'local-cli-gate-test', version: '1.0.0' },
    { capabilities: {} },
  )
  try {
    await client.connect(transport)
    await run(client)
  } finally {
    await client.close()
  }
}

describe('local CLI MCP entry is Antigravity-only', () => {
  it('lists oc_bash and runs it when OPENCLAUDE_ENGINE=antigravity', { timeout: 90_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-cli-agy-'))
    try {
      await withServer('antigravity', home, async (client) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name)
        for (const name of LOCAL_CLI) assert.ok(names.includes(name), `${name} missing`)
        const result = await client.callTool({
          name: 'oc_bash',
          arguments: { command: 'echo agy-ok' },
        })
        assert.notEqual(result.isError, true, toolText(result))
        assert.match(toolText(result), /exit=0/)
        assert.match(toolText(result), /agy-ok/)
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('soft-yields over real stdio MCP and completes on follow-up job_id wait', { timeout: 90_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-cli-agy-yield-'))
    try {
      await withServer('antigravity', home, async (client) => {
        const first = await client.callTool({
          name: 'oc_bash',
          arguments: { command: 'printf "mcp-part-1\\n"; sleep 1.6; printf "mcp-part-2\\n"', timeout_ms: 1000 },
        })
        assert.notEqual(first.isError, true, toolText(first))
        assert.match(toolText(first), /status=running job_id=(ocb_\d+)/)
        assert.match(toolText(first), /mcp-part-1/)
        const jobId = /job_id=(ocb_\d+)/.exec(toolText(first))![1]!

        const second = await client.callTool({
          name: 'oc_bash',
          arguments: { job_id: jobId, timeout_ms: 5000 },
        })
        assert.notEqual(second.isError, true, toolText(second))
        assert.match(toolText(second), /^exit=0/m)
        assert.match(toolText(second), /mcp-part-2/)
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('reaps active TERM-ignoring oc_bash children and exits when stdio client closes', { timeout: 90_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-cli-agy-close-'))
    const childPidFile = join(home, 'child.pid')
    const mcpPidFile = join(home, 'mcp.pid')
    const isAlive = (pid: number): boolean => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      }
    }
    let childPid: number | undefined
    let mcpPid: number | undefined
    try {
      const transport = new StdioClientTransport({
        command: join(root, 'node_modules/.bin/tsx'),
        args: ['packages/mcp-memory/src/index.ts'],
        cwd: root,
        env: childEnv('antigravity', home),
        stderr: 'pipe',
      })
      const client = new Client(
        { name: 'local-cli-disconnect-test', version: '1.0.0' },
        { capabilities: {} },
      )
      await client.connect(transport)
      const yielded = await client.callTool({
        name: 'oc_bash',
        arguments: {
          command: `echo "$PPID" > ${shellSingleQuote(mcpPidFile)}; bash -c 'trap "" TERM; echo $$ > '${shellSingleQuote(childPidFile)}'; exec sleep 60' >/dev/null 2>&1 & wait`,
          timeout_ms: 1000,
        },
      })
      assert.notEqual(yielded.isError, true, toolText(yielded))
      assert.match(toolText(yielded), /status=running job_id=ocb_/)
      mcpPid = Number(readFileSync(mcpPidFile, 'utf8').trim())
      childPid = Number(readFileSync(childPidFile, 'utf8').trim())
      assert.ok(Number.isInteger(mcpPid) && mcpPid > 0)
      assert.ok(Number.isInteger(childPid) && childPid > 0)
      assert.equal(isAlive(childPid), true)

      await client.close()

      const deadline = Date.now() + 3_000
      while ((isAlive(childPid) || isAlive(mcpPid)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      assert.equal(isAlive(childPid), false, 'child process group must be SIGKILLed when MCP disconnects')
      assert.equal(isAlive(mcpPid), false, 'MCP process must exit promptly without hanging on child pipes')
    } finally {
      if (childPid && isAlive(childPid)) {
        try { process.kill(childPid, 'SIGKILL') } catch { /* already gone */ }
      }
      if (mcpPid && isAlive(mcpPid)) {
        try { process.kill(mcpPid, 'SIGKILL') } catch { /* already gone */ }
      }
      await rm(home, { recursive: true, force: true })
    }
  })

  it('hides the tools and does not execute oc_bash when the engine is grok', { timeout: 90_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-cli-grok-'))
    const marker = join(home, 'oc-bash-marker')
    try {
      await withServer('grok', home, async (client) => {
        const names = new Set((await client.listTools()).tools.map((tool) => tool.name))
        for (const name of LOCAL_CLI) assert.equal(names.has(name), false, name)
        const result = await client.callTool({
          name: 'oc_bash',
          arguments: { command: `touch ${shellSingleQuote(marker)}` },
        })
        assert.equal(result.isError, true)
        assert.equal(toolText(result), 'oc_bash 仅在 Antigravity 引擎可用')
        for (const name of ['oc_grep', 'oc_glob'] as const) {
          const denied = await client.callTool({
            name,
            arguments: { pattern: 'x', path: home },
          })
          assert.equal(denied.isError, true)
          assert.equal(toolText(denied), `${name} 仅在 Antigravity 引擎可用`)
        }
      })
      await assert.rejects(access(marker))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('hides the tools when OPENCLAUDE_ENGINE is unset', { timeout: 90_000 }, async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-cli-empty-'))
    try {
      await withServer(null, home, async (client) => {
        const names = new Set((await client.listTools()).tools.map((tool) => tool.name))
        for (const name of LOCAL_CLI) assert.equal(names.has(name), false, name)
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
