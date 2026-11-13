import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TOOLS } from '../toolDefs.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const safe = ['skill_list', 'skill_search', 'skill_view', 'list_reminders', 'task_list', 'task_get', 'consult_advisor']

test('advisor read-only MCP removes mutators and rejects direct calls before gateway or file writes', { timeout: 90_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'advisor-readonly-mcp-'))
  const readable = join(home, 'outline.md')
  await writeFile(readable, 'READ_ONLY_EVIDENCE')
  let gatewayCalls = 0
  const gateway = createServer((_req, res) => { gatewayCalls += 1; res.writeHead(500); res.end('unexpected gateway call') })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const port = (gateway.address() as { port: number }).port
  try {
    for (const engine of ['ccb', 'codex', 'grok', 'cursor']) {
      const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))
      Object.assign(env, { HOME: home, OPENCLAUDE_HOME: home, OPENCLAUDE_AGENT_ID: 'main', OPENCLAUDE_ENGINE: engine, OPENCLAUDE_ADVISOR_READ_ONLY: '1', OPENCLAUDE_GATEWAY_PORT: String(port), OPENCLAUDE_GATEWAY_TOKEN: 'test' })
      for (const key of ['OPENCLAUDE_SKILL_TRAIN_RUN_ID', 'OPENCLAUDE_SKILL_EVAL_MODE', 'OPENCLAUDE_SKILL_EVAL_EXCLUDE', 'OPENCLAUDE_SKILL_EVAL_DRAFT_NAME', 'OPENCLAUDE_SKILL_EVAL_DRAFT_DIR']) delete env[key]
      const transport = new StdioClientTransport({ command: join(root, 'node_modules/.bin/tsx'), args: ['packages/mcp-memory/src/index.ts'], cwd: root, env, stderr: 'pipe' })
      const client = new Client({ name: 'advisor-readonly-test', version: '1' }, { capabilities: {} })
      try {
        await client.connect(transport)
        const tools = (await client.listTools()).tools
        const listed = tools.map((tool) => tool.name)
        assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false))
        for (const name of safe) assert.ok(listed.includes(name), `${engine} missing ${name}`)
        for (const name of ['oc_grep', 'oc_glob']) assert.ok(listed.includes(name), `${engine} missing ${name}`)
        const read = await client.callTool({ name: 'oc_grep', arguments: { pattern: '.', path: readable } })
        assert.notEqual(read.isError, true, JSON.stringify(read))
        assert.match(JSON.stringify(read.content), /READ_ONLY_EVIDENCE/)
        const mutators = TOOLS.filter((tool) => !safe.includes(tool.name) && !['ask_user', 'present_options', 'present_task_approval', 'project_search', 'oc_grep', 'oc_glob'].includes(tool.name))
        for (const { name } of [...mutators, { name: 'future_write_tool' }]) {
          assert.equal(listed.includes(name), false, `${engine} listed ${name}`)
          const result = await client.callTool({ name, arguments: { name: 'must-not-save', description: 'blocked', body: 'blocked', command: `touch ${join(home, 'written')}`, goal: 'must not delegate', question: 'must not call', schedule: '* * * * *' } })
          assert.equal(result.isError, true, `${engine} accepted ${name}`)
          assert.match(JSON.stringify(result.content), /advisor_read_only/, `${engine} did not reject ${name} at policy entry`)
        }
        assert.equal(gatewayCalls, 0, `${engine} reached a mutation/billing endpoint`)
        await assert.rejects(readFile(join(home, 'written')))
      } finally { await client.close() }
    }
  } finally {
    await new Promise<void>((resolve, reject) => gateway.close((err) => err ? reject(err) : resolve()))
    await rm(home, { recursive: true, force: true })
  }
})
