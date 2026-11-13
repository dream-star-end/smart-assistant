import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

test('OCV5-759 real MCP advertises on-demand discovery and serves concise baseline skills', { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'oc-prompt-cleanup-'))
  // No live credentials, user memories, model calls, or production gateway.
  const transport = new StdioClientTransport({
    command: join(root, 'node_modules/.bin/tsx'),
    args: ['packages/mcp-memory/src/index.ts'],
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      OPENCLAUDE_HOME: home,
      OPENCLAUDE_AGENT_ID: 'main',
      OPENCLAUDE_GATEWAY_PORT: '9',
      OPENCLAUDE_BASELINE_SKILLS_DIR: join(root, 'packages/commercial/agent-sandbox/ccb-baseline/skills'),
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'prompt-cleanup-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    const list = tools.find((tool) => tool.name === 'skill_list')!
    assert.ok(list)
    assert.match(list.description!, /inventory or catalog audit/)
    assert.doesNotMatch(list.description!, /Always check this first|Token-cheap/)
    assert.match(list.description!, /skill_search/)
    assert.match(list.description!, /skill_view/)

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args })
      assert.notEqual(result.isError, true, JSON.stringify(result))
      const content = result.content as Array<{ type: string; text?: string }>
      return content.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n')
    }
    const catalog = await call('skill_list', {})
    for (const [name, query] of [
      ['coding-suite', '编程'],
      ['scientific-figures', '科学示意图'],
      ['skill-search', '技能'],
      ['skill-authoring', 'skill'],
    ]) {
      assert.ok(catalog.includes(name))
      const results = await call('skill_search', { query, limit: 25 })
      assert.ok(results.includes(name), `${query} must discover ${name}`)
      const viewed = await call('skill_view', { name })
      assert.ok(viewed.includes(name))
      const description = viewed.match(/^description: (.+)$/m)?.[1]
      assert.ok(description && description.length < 150, `${name}: concise trigger metadata`)
      if (name === 'scientific-figures') {
        for (const rule of ['oc-figcheck', '--spec', '--backend pptx', '最多 3 轮', '严禁']) {
          assert.ok(viewed.includes(rule), `figure body must retain ${rule}`)
        }
      }
      if (name === 'coding-suite') {
        assert.ok(viewed.includes('仓库强制门禁'))
        assert.ok(viewed.includes('本次改动引入'))
        assert.ok(viewed.includes('不改测试让它假过'))
      }
    }
  } finally {
    await client.close()
    await rm(home, { recursive: true, force: true })
  }
})
