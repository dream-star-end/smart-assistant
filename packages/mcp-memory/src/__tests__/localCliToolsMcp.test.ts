/**
 * Real stdio entry: oc_bash / oc_grep / oc_glob are listed and callable only
 * when OPENCLAUDE_ENGINE=antigravity.
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/localCliToolsMcp.test.ts
 */
import assert from 'node:assert/strict'
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
