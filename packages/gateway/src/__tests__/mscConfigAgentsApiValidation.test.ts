/**
 * msc-config 阶段 A 审计用例:/api/agents 与 /api/config 的配置面契约(真 HTTP listener)。
 *
 *   - PUT /api/agents/:id 对 permissionMode / toolsets 零校验,任意值直写 agents.yaml
 *     (docs/audit/msc-config.md CFG-07);
 *   - GET /api/agents、GET /api/agents/:id 原样返回 AgentDef,含 mcpServers[].env(可放第三方 key)
 *     (CFG-08);
 *   - GET /api/config 不回 accessToken / OAuth token / MCP env(回归锁,当前已满足)。
 *
 * 红灯用例标注 TODO(msc-config): 阶段 B 修复。
 * 运行:npx tsx --test --test-concurrency=1 packages/gateway/src/__tests__/mscConfigAgentsApiValidation.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const ENV_KEYS = [
  'OC_MODEL_AUTHORITY',
  'OPENCLAUDE_V3_MASTER_BASE_URL',
  'OPENCLAUDE_V3_CONTAINER_TOKEN',
  'OC_USER_ID',
] as const
const saved: Record<string, string | undefined> = {}
before(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.OC_MODEL_AUTHORITY = '0'
  // 容器身份三件套必须整体缺席,fetchIdentityCompatProjection 才走「纯本地」分支(返回 undefined)。
  for (const key of ENV_KEYS.slice(1)) delete process.env[key]
})
after(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const home = mkdtempSync(join(tmpdir(), 'oc-gw-msc-config-agents-'))
process.env.OPENCLAUDE_HOME = home

const { Gateway } = await import('../server.js')
const { writeAgentsConfig, readAgentsConfig } = await import('@openclaude/storage')

const ACCESS = 'test-gateway-access-msc-config'
const MCP_SECRET = 'sk-live-should-never-leave-the-volume'
const OAUTH_SECRET = 'oauth-access-token-should-never-leave-the-volume'

async function json(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${ACCESS}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, text, body: parsed }
}

describe('msc-config · /api/agents & /api/config configuration surface', () => {
  async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
    await writeAgentsConfig({
      agents: [
        { id: 'main', model: 'glm-5.3-zai', permissionMode: 'default' },
        {
          id: 'coder',
          model: 'glm-5.3-zai',
          permissionMode: 'acceptEdits',
          mcpServers: [
            {
              id: 'search',
              command: 'npx',
              args: ['search-mcp'],
              env: { SEARCH_API_KEY: MCP_SECRET },
            },
          ],
        },
      ],
      routes: [],
      default: 'main',
    })
    const agentsConfig = await readAgentsConfig()
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: ACCESS },
        auth: {
          mode: 'subscription',
          claudeCodePath: '',
          claudeOAuth: {
            accessToken: OAUTH_SECRET,
            refreshToken: 'r',
            expiresAt: Date.now() + 3_600_000,
            scope: 's',
          },
        },
        sessions: { dbPath: join(home, 'sessions.db') },
        defaults: { model: 'glm-5.3-zai', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
        mcpServers: [
          { id: 'global-mcp', command: 'npx', args: ['x'], env: { GLOBAL_KEY: MCP_SECRET } },
        ],
      } as never,
      agentsConfig,
    })
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      ;(
        gw as unknown as { handleHttp: (r: IncomingMessage, s: ServerResponse) => void }
      ).handleHttp(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      await fn(`http://127.0.0.1:${port}`)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      )
    }
  }

  // 回归锁:/api/config 的响应逐字段核过,不含 accessToken / OAuth token / MCP env。
  it('GET /api/config never echoes gateway accessToken, OAuth tokens or MCP env values', async () => {
    await withServer(async (base) => {
      const res = await json(base, 'GET', '/api/config')
      assert.equal(res.status, 200, res.text)
      assert.ok(!res.text.includes(ACCESS), 'accessToken leaked')
      assert.ok(!res.text.includes(OAUTH_SECRET), 'claudeOAuth.accessToken leaked')
      assert.ok(!res.text.includes(MCP_SECRET), 'mcpServers[].env leaked')
      assert.equal(res.body.auth?.claudeOAuth?.active, true)
      assert.equal(res.body.gateway?.accessToken, undefined)
      assert.deepEqual(
        Object.keys(res.body.mcpServers?.[0] ?? {}).sort(),
        ['id', 'label', 'provider', 'tools']
          .filter((k) => k in (res.body.mcpServers?.[0] ?? {}))
          .sort(),
      )
    })
  })

  // TODO(msc-config): 阶段 B 修复 —— agent 级 mcpServers[].env 是凭据载体,列表/详情面必须脱敏。
  it('GET /api/agents and GET /api/agents/:id do not expose per-agent mcpServers env values', async () => {
    await withServer(async (base) => {
      const list = await json(base, 'GET', '/api/agents')
      assert.equal(list.status, 200, list.text)
      assert.ok(!list.text.includes(MCP_SECRET), 'GET /api/agents leaked mcpServers[].env')
      const item = await json(base, 'GET', '/api/agents/coder')
      assert.equal(item.status, 200, item.text)
      assert.ok(!item.text.includes(MCP_SECRET), 'GET /api/agents/:id leaked mcpServers[].env')
    })
  })

  // TODO(msc-config): 阶段 B 修复 —— permissionMode 必须在 5 个合法枚举内,否则 400,不落盘。
  it('PUT /api/agents/:id rejects an out-of-enum permissionMode with 400 and leaves agents.yaml untouched', async () => {
    await withServer(async (base) => {
      const res = await json(base, 'PUT', '/api/agents/coder', { permissionMode: 'yolo' })
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`)
      const onDisk = (await readAgentsConfig()).agents.find((a) => a.id === 'coder')
      assert.equal(
        onDisk?.permissionMode,
        'acceptEdits',
        'invalid permissionMode must not be persisted',
      )
    })
  })

  // TODO(msc-config): 阶段 B 修复 —— toolsets / mcpServers 需做 shape 校验(string[] / McpServerConfig[])。
  it('PUT /api/agents/:id rejects a non-array toolsets with 400 and leaves agents.yaml untouched', async () => {
    await withServer(async (base) => {
      const res = await json(base, 'PUT', '/api/agents/coder', { toolsets: 'coding' })
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`)
      const onDisk = (await readAgentsConfig()).agents.find((a) => a.id === 'coder')
      assert.equal(onDisk?.toolsets, undefined, 'invalid toolsets must not be persisted')
    })
  })
})
