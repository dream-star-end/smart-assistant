/**
 * msc-config 阶段 A 审计用例:/api/agents 与 /api/config 的配置面契约(真 HTTP listener)。
 *
 *   - PUT /api/agents/:id 对 permissionMode / toolsets 零校验,任意值直写 agents.yaml
 *     (docs/audit/msc-config.md CFG-07);
 *   - GET /api/agents、GET /api/agents/:id 原样返回 AgentDef,含 mcpServers[].env(可放第三方 key)
 *     (CFG-08);
 *   - GET /api/config 不回 accessToken / OAuth token / MCP env(回归锁,当前已满足)。
 *
 * 阶段 B(t-1868 / t-1962)已把上述红灯全部转绿并补齐 persona / cwd / mcpServers 形状 / POST /
 * /api/config 405 / 外部写入热生效用例;编号以 docs/audit/msc-config.md §4 为准(CFG-05/06/07)。
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
  let lastGateway: { deps: { agentsConfig: { agents: any[] } } } | null = null
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
    lastGateway = gw as unknown as { deps: { agentsConfig: { agents: any[] } } }
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

  // CFG-17(阶段 B):/api/config 是只读投影,非 GET 一律 405;body 先构造再发,不再「200 + 空体」。
  it('non-GET /api/config is rejected with 405 and never returns a half-written 200', async () => {
    await withServer(async (base) => {
      for (const method of ['PUT', 'POST', 'DELETE']) {
        const res = await json(base, method, '/api/config', { gateway: { port: 1 } })
        assert.equal(res.status, 405, `${method} expected 405, got ${res.status}: ${res.text}`)
      }
      const ok = await json(base, 'GET', '/api/config')
      assert.equal(ok.status, 200, ok.text)
      assert.equal(ok.body.gateway?.port, 0)
    })
  })

  // CFG-06(阶段 B 已修):agent 级 mcpServers[].env 是凭据载体,列表/详情面投影为 envKeys。
  it('GET /api/agents and GET /api/agents/:id do not expose per-agent mcpServers env values', async () => {
    await withServer(async (base) => {
      const list = await json(base, 'GET', '/api/agents')
      assert.equal(list.status, 200, list.text)
      assert.ok(!list.text.includes(MCP_SECRET), 'GET /api/agents leaked mcpServers[].env')
      const coder = list.body.agents.find((a: any) => a.id === 'coder')
      assert.deepEqual(coder?.mcpServers?.[0]?.envKeys, ['SEARCH_API_KEY'])
      assert.equal(coder?.mcpServers?.[0]?.env, undefined)
      assert.equal(coder?.mcpServers?.[0]?.command, 'npx')
      const item = await json(base, 'GET', '/api/agents/coder')
      assert.equal(item.status, 200, item.text)
      assert.ok(!item.text.includes(MCP_SECRET), 'GET /api/agents/:id leaked mcpServers[].env')
      // 投影只在响应层:磁盘上的 env 原样保留(subprocessRunner 仍能注入)。
      const onDisk = (await readAgentsConfig()).agents.find((a) => a.id === 'coder')
      assert.equal(onDisk?.mcpServers?.[0]?.env?.SEARCH_API_KEY, MCP_SECRET)
    })
  })

  // CFG-07(阶段 B 已修,无争议部分):persona 限 HOME 内、cwd 非根非系统目录;只对新写入生效。
  it('PUT /api/agents/:id rejects persona outside OPENCLAUDE_HOME and root/system cwd with 400', async () => {
    await withServer(async (base) => {
      const outside = process.platform === 'win32' ? 'C:\\evil\\CLAUDE.md' : '/etc/evil/CLAUDE.md'
      const p = await json(base, 'PUT', '/api/agents/coder', { persona: outside })
      assert.equal(p.status, 400, `persona outside HOME expected 400, got ${p.status}: ${p.text}`)
      const root = process.platform === 'win32' ? 'C:\\' : '/'
      const c = await json(base, 'PUT', '/api/agents/coder', { cwd: root })
      assert.equal(c.status, 400, `root cwd expected 400, got ${c.status}: ${c.text}`)
      const rel = await json(base, 'PUT', '/api/agents/coder', { cwd: 'relative/dir' })
      assert.equal(rel.status, 400, `relative cwd expected 400, got ${rel.status}: ${rel.text}`)
      const onDisk = (await readAgentsConfig()).agents.find((a) => a.id === 'coder')
      assert.equal(onDisk?.persona, undefined)
      assert.equal(onDisk?.cwd, undefined)
      // 合法值照常落盘:HOME 内 persona + 合法 permissionMode;空串清除展示类字段。
      const ok = await json(base, 'PUT', '/api/agents/coder', {
        persona: join(home, 'agents', 'coder', 'CLAUDE.md'),
        permissionMode: 'plan',
        displayName: 'Coder',
      })
      assert.equal(ok.status, 200, ok.text)
      const cleared = await json(base, 'PUT', '/api/agents/coder', { displayName: '' })
      assert.equal(cleared.status, 200, cleared.text)
      const after = (await readAgentsConfig()).agents.find((a) => a.id === 'coder')
      assert.equal(after?.permissionMode, 'plan')
      assert.equal(after?.displayName, undefined, 'empty string must clear displayName')
      assert.equal(
        after?.mcpServers?.[0]?.env?.SEARCH_API_KEY,
        MCP_SECRET,
        'env untouched by unrelated PUT',
      )
    })
  })

  // CFG-05(阶段 B 已修):permissionMode 必须在 5 个合法枚举内,否则 400,不落盘。
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

  // CFG-05(阶段 B 已修):toolsets / mcpServers 做 shape 校验(string[] / McpServerConfig[])。
  it('PUT /api/agents/:id rejects a non-array toolsets with 400 and leaves agents.yaml untouched', async () => {
    await withServer(async (base) => {
      const res = await json(base, 'PUT', '/api/agents/coder', { toolsets: 'coding' })
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`)
      const onDisk = (await readAgentsConfig()).agents.find((a) => a.id === 'coder')
      assert.equal(onDisk?.toolsets, undefined, 'invalid toolsets must not be persisted')
      const bad = await json(base, 'PUT', '/api/agents/coder', { mcpServers: { id: 'x' } })
      assert.equal(
        bad.status,
        400,
        `non-array mcpServers expected 400, got ${bad.status}: ${bad.text}`,
      )
      const badEntry = await json(base, 'PUT', '/api/agents/coder', {
        mcpServers: [{ id: 'x', command: '' }],
      })
      assert.equal(
        badEntry.status,
        400,
        `empty command expected 400, got ${badEntry.status}: ${badEntry.text}`,
      )
    })
  })

  // CFG-10(阶段 B):agents.yaml 单一内存权威 —— 外部写入(CLI / 手改 / 市场同步)经 mtime 缓存刷新
  // 后,构造期快照 deps.agentsConfig(Router / /v1 / /api/file cwd 白名单的来源)同步换新。
  it('external agents.yaml edits refresh deps.agentsConfig via the mtime cache (single authority)', async () => {
    await withServer(async (base) => {
      const gwOf = async () => {
        // 通过一次枚举请求触发 _getAgentsConfig;拿 Gateway 实例看快照。
        const list = await json(base, 'GET', '/api/agents')
        assert.equal(list.status, 200, list.text)
        return list
      }
      await gwOf()
      await new Promise((r) => setTimeout(r, 25))
      const newCwd = process.platform === 'win32' ? 'C:\\work\\coder' : '/home/agent/coder'
      const before = await readAgentsConfig()
      await writeAgentsConfig({
        ...before,
        agents: before.agents.map((a) => (a.id === 'coder' ? { ...a, cwd: newCwd } : a)),
      })
      const list = await gwOf()
      assert.equal(list.body.agents.find((a: any) => a.id === 'coder')?.cwd, newCwd)
      // 快照亦已同步(不是只有枚举面热、白名单面冷)
      const snapshot = lastGateway?.deps.agentsConfig.agents.find((a: any) => a.id === 'coder')
      assert.equal(snapshot?.cwd, newCwd, 'deps.agentsConfig must follow the mtime-cache refresh')
    })
  })

  // CFG-05(阶段 B):POST /api/agents 同样走 validateAgentPatch;创建响应亦脱敏。
  it('POST /api/agents validates fields and returns the projected agent', async () => {
    await withServer(async (base) => {
      const bad = await json(base, 'POST', '/api/agents', { id: 'newbie', permissionMode: 'yolo' })
      assert.equal(bad.status, 400, `expected 400, got ${bad.status}: ${bad.text}`)
      assert.equal(
        (await readAgentsConfig()).agents.some((a) => a.id === 'newbie'),
        false,
      )
      const ok = await json(base, 'POST', '/api/agents', {
        id: 'newbie',
        permissionMode: 'acceptEdits',
        mcpServers: [{ id: 'm', command: 'npx', env: { K: MCP_SECRET } }],
      })
      assert.equal(ok.status, 201, ok.text)
      assert.ok(!ok.text.includes(MCP_SECRET), 'POST response leaked mcpServers[].env')
      assert.deepEqual(ok.body.agent?.mcpServers?.[0]?.envKeys, ['K'])
      const onDisk = (await readAgentsConfig()).agents.find((a) => a.id === 'newbie')
      assert.equal(onDisk?.mcpServers?.[0]?.env?.K, MCP_SECRET)
    })
  })
})
