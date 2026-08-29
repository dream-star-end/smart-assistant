import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('skill-eval MCP server', () => {
  it('hides mutation tools and rejects a direct create_reminder call before transport', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-skill-eval-mcp-'))
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string',
      ),
    )
    env.HOME = home
    env.OPENCLAUDE_SKILL_EVAL_MODE = '1'
    env.OPENCLAUDE_GATEWAY_PORT = '9'
    delete env.OPENCLAUDE_SKILL_TRAIN_RUN_ID

    const transport = new StdioClientTransport({
      command: join(root, 'node_modules/.bin/tsx'),
      args: ['packages/mcp-memory/src/index.ts'],
      cwd: root,
      env,
      stderr: 'pipe',
    })
    const client = new Client(
      { name: 'skill-eval-policy-test', version: '1.0.0' },
      { capabilities: {} },
    )

    try {
      await client.connect(transport)
      const listed = await client.listTools()
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        ['skill_list', 'skill_search', 'skill_view', 'list_reminders'],
      )

      const result = await client.callTool({
        name: 'create_reminder',
        arguments: {
          schedule: '*/30 * * * *',
          message: 'must not persist',
          oneshot: false,
          kind: 'task',
        },
      })
      assert.equal(result.isError, true)
      const content = (result as { content?: unknown }).content
      assert.ok(Array.isArray(content))
      assert.match(
        (content[0] as { text?: string }).text ?? '',
        /create_reminder.*disabled in eval sessions/,
      )
    } finally {
      await client.close()
      await rm(home, { recursive: true, force: true })
    }
  })
})
