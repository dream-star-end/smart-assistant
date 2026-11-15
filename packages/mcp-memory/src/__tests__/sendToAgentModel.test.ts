/**
 * Real MCP stdio entry for send_to_agent model forwarding & local validation (OCV5-752):
 * - Valid model is trimmed and forwarded to POST /api/agents/:id/delegate
 * - Omitted / whitespace model omits `model` from the request body
 * - Invalid model is rejected locally without sending any HTTP request
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/sendToAgentModel.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

interface RecordedRequest {
  method: string | undefined
  url: string | undefined
  body: Record<string, unknown>
}

function toolText(result: unknown): string {
  const content = (result as { content?: unknown }).content
  assert.ok(Array.isArray(content) && content.length > 0)
  return String((content[0] as { text?: string }).text ?? '')
}

async function withMockGatewayAndMcp(
  run: (ctx: { client: Client; requests: RecordedRequest[] }) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = []
  let seq = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      requests.push({ method: req.method, url: req.url, body })
      seq += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'running',
          jobId: `dlgjob-${seq}`,
          sessionKey: `agent:research-assistant:delegate:${seq}`,
        }),
      )
    })
  })
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const port = (server.address() as AddressInfo).port
  const home = await mkdtemp(join(tmpdir(), 'oc-send-to-agent-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
  env.HOME = home
  env.OPENCLAUDE_HOME = home
  env.OPENCLAUDE_AGENT_ID = 'coding-assistant'
  env.OPENCLAUDE_GATEWAY_PORT = String(port)
  env.OPENCLAUDE_GATEWAY_TOKEN = 'test-gateway-token'

  const transport = new StdioClientTransport({
    command: join(root, 'node_modules/.bin/tsx'),
    args: ['packages/mcp-memory/src/index.ts'],
    cwd: root,
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'send-to-agent-model-test', version: '1.0.0' }, { capabilities: {} })
  try {
    await client.connect(transport)
    await run({ client, requests })
  } finally {
    await client.close()
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((err) => (err ? rejectClose(err) : resolveClose())),
    )
    await rm(home, { recursive: true, force: true })
  }
}

describe('send_to_agent model parameter', () => {
  it('forwards valid model, omits model when absent/blank, and rejects invalid model locally', { timeout: 60_000 }, async () => {
    await withMockGatewayAndMcp(async ({ client, requests }) => {
      const { tools } = await client.listTools()
      const def = tools.find((tool) => tool.name === 'send_to_agent')
      assert.ok(def, 'send_to_agent tool definition must exist')
      const props = (def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      assert.ok('model' in props, 'send_to_agent schema must expose model')

      // 1. Valid model (with surrounding whitespace) is trimmed and forwarded
      const withModel = await client.callTool({
        name: 'send_to_agent',
        arguments: {
          agentId: 'research-assistant',
          message: 'check event timeline',
          model: ' gpt-6-astra ',
        },
      })
      assert.notEqual(withModel.isError, true, toolText(withModel))
      assert.equal(requests.length, 1)
      assert.equal(requests[0].method, 'POST')
      assert.equal(requests[0].url, '/api/agents/research-assistant/delegate')
      assert.equal(requests[0].body.model, 'gpt-6-astra')
      assert.equal(requests[0].body.goal, 'check event timeline')
      assert.equal(requests[0].body.async, true)
      assert.equal(requests[0].body.callbackOnComplete, 'origin-inject')

      // 2. Omitted model does not include `model` in the request body
      const withoutModel = await client.callTool({
        name: 'send_to_agent',
        arguments: {
          agentId: 'research-assistant',
          message: 'no model override',
        },
      })
      assert.notEqual(withoutModel.isError, true, toolText(withoutModel))
      assert.equal(requests.length, 2)
      assert.equal('model' in requests[1].body, false)

      // 3. Blank model also omits `model` from the request body
      const blankModel = await client.callTool({
        name: 'send_to_agent',
        arguments: {
          agentId: 'research-assistant',
          message: 'blank model override',
          model: '   ',
        },
      })
      assert.notEqual(blankModel.isError, true, toolText(blankModel))
      assert.equal(requests.length, 3)
      assert.equal('model' in requests[2].body, false)

      // 4. Invalid model is blocked locally and makes zero gateway requests
      for (const badModel of ['cursor grok', 'bad/model']) {
        const rejected = await client.callTool({
          name: 'send_to_agent',
          arguments: {
            agentId: 'research-assistant',
            message: 'should fail locally',
            model: badModel,
          },
        })
        assert.equal(rejected.isError, true)
        assert.match(toolText(rejected), /model 无效/)
        assert.equal(requests.length, 3, `invalid model ${badModel} must not hit gateway`)
      }
    })
  })
})
