/**
 * Real HTTP listener: ACCESS/default owns selfhost collaboration-config.
 * Run: npx tsx --test packages/gateway/src/__tests__/collaborationConfigHttp.test.ts
 */
import * as assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'

const ENV_KEYS = [
  'OC_SELFHOST_ENGINE_LOCAL_TURNS',
  'OC_ADVISOR_OPEN_ENGINES',
  'OC_MODEL_AUTHORITY',
  'OPENCLAUDE_TRUST_BRIDGE_IP',
  'OC_CONTAINER_ID',
  'OC_BRIDGE_NONCE',
] as const
const saved: Record<string, string | undefined> = {}
before(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
  process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
  process.env.OC_MODEL_AUTHORITY = '0'
})
afterEach(() => {
  process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
  process.env.OC_ADVISOR_OPEN_ENGINES = 'codex'
  delete process.env.OPENCLAUDE_TRUST_BRIDGE_IP
  delete process.env.OC_CONTAINER_ID
  delete process.env.OC_BRIDGE_NONCE
})
after(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const home = mkdtempSync(join(tmpdir(), 'oc-gw-collab-http-'))
process.env.OPENCLAUDE_HOME = home

const { Gateway } = await import('../server.js')
const { signJwt } = await import('../auth.js')
const { _setModelCatalogClientForTests } = await import('../modelCatalogClient.js')
const {
  COLLAB_BRIDGE_AGENT_HEADER,
  COLLAB_BRIDGE_MODEL_HEADER,
  COLLAB_BRIDGE_SESSION_HEADER,
} = await import('../bridgeApiAllowlist.js')

const ACCESS = 'test-gateway-access-collab-http'
const jwt3 = signJwt({ userId: '3', exp: Math.floor(Date.now() / 1000) + 3600 }, ACCESS)
const NONCE = randomBytes(32).toString('hex')

function catalogView() {
  const models = [
    {
      modelId: 'glm-5.2',
      displayName: 'GLM-5.2',
      engine: 'ccb' as const,
      providerId: 'ccb',
      contextWindow: 200000,
      supportedEfforts: ['high'],
      supportsVision: false,
      capabilityZero: false,
      supportsThinking: true,
      defaultEffort: 'high',
      available: true,
    },
    {
      modelId: 'gpt-6-astra',
      displayName: 'GPT-6-Astra',
      engine: 'codex' as const,
      providerId: 'codex',
      contextWindow: 200000,
      supportedEfforts: [],
      supportsVision: false,
      capabilityZero: false,
      supportsThinking: false,
      defaultEffort: null,
      available: true,
    },
  ]
  return {
    models,
    projectionRevision: '1',
    availabilityRevision: '1',
    securityEpoch: '1',
    canonicalize: (id: string) => id,
    aliasEntries: () => [],
    isRoutable: (id: string) => models.some((row) => row.modelId === id),
    resolve: (id: string) => models.find((row) => row.modelId === id) ?? null,
    engineOf: (id: string) => models.find((row) => row.modelId === id)?.engine ?? null,
  }
}

async function json(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = {}
  try {
    parsed = text ? JSON.parse(text) : {}
  } catch {
    parsed = { raw: text }
  }
  return { status: res.status, body: parsed }
}

describe('Gateway HTTP collaboration-config ACCESS/default identity', () => {
  async function withServer(
    fn: (base: string, gw: InstanceType<typeof Gateway>) => Promise<void>,
  ): Promise<void> {
    _setModelCatalogClientForTests({
      getRoutingView: async () => catalogView(),
    } as never)
    const gw = new Gateway({
      config: {
        version: 1,
        gateway: { bind: '127.0.0.1', port: 0, accessToken: ACCESS },
        auth: { mode: 'subscription', claudeCodePath: '' },
        sessions: { dbPath: join(home, 'sessions.db') },
        defaults: { model: 'glm-5.2', permissionMode: 'default' },
        channels: { webchat: { enabled: true } },
      } as never,
      agentsConfig: {
        agents: [
          { id: 'main', model: 'glm-5.2' },
          { id: 'coder', model: 'glm-5.2' },
        ],
        routes: [],
        default: 'main',
      },
    })
    await (gw as unknown as { advisorConfigStore: () => { markEngineProven: (e: string) => Promise<unknown> } }).advisorConfigStore().markEngineProven('codex')
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      ;(gw as unknown as { handleHttp: (r: IncomingMessage, s: ServerResponse) => void }).handleHttp(
        req,
        res,
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    try {
      await fn(`http://127.0.0.1:${port}`, gw)
    } finally {
      _setModelCatalogClientForTests(null)
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
    }
  }

  it('ACCESS session PUT then collab GET/PUT advisor overlay reads back for default only', async () => {
    await withServer(async (base) => {
      const access = { authorization: `Bearer ${ACCESS}`, 'content-type': 'application/json' }
      const user3 = { authorization: `Bearer ${jwt3}`, 'content-type': 'application/json' }
      const sid = 'collabdef1'
      const putSess = await json(base, 'PUT', `/api/sessions/${sid}`, access, {
        agentId: 'main',
        title: 'default advisor',
        modelId: 'glm-5.2',
      })
      assert.equal(putSess.status, 200, JSON.stringify(putSess.body))

      const get1 = await json(base, 'GET', `/api/collaboration-config?sessionId=${sid}`, access)
      assert.equal(get1.status, 200, JSON.stringify(get1.body))
      assert.equal(get1.body.session.mode, 'solo')

      const putCfg = await json(base, 'PUT', '/api/collaboration-config', access, {
        sessionId: sid,
        mode: 'advisor',
        advisorModel: 'gpt-6-astra',
        expectedRev: get1.body.rev,
      })
      assert.equal(putCfg.status, 200, JSON.stringify(putCfg.body))
      assert.equal(putCfg.body.session.mode, 'advisor')
      assert.equal(putCfg.body.session.advisorModel, 'gpt-6-astra')
      assert.match(String(putCfg.body.session.configVersion), /v1:advisor:gpt-6-astra/)

      const get2 = await json(base, 'GET', `/api/collaboration-config?sessionId=${sid}`, access)
      assert.equal(get2.status, 200)
      assert.equal(get2.body.session.mode, 'advisor')
      assert.equal(get2.body.session.advisorModel, 'gpt-6-astra')

      const otherSid = 'collabjwt3'
      const jwtSess = await json(base, 'PUT', `/api/sessions/${otherSid}`, user3, {
        agentId: 'main',
        title: 'jwt3',
        modelId: 'glm-5.2',
      })
      assert.equal(jwtSess.status, 200, JSON.stringify(jwtSess.body))
      const steal = await json(base, 'GET', `/api/collaboration-config?sessionId=${otherSid}`, access)
      assert.equal(steal.status, 404)
      const jwtGet = await json(base, 'GET', `/api/collaboration-config?sessionId=${otherSid}`, user3)
      assert.equal(jwtGet.status, 200)
      assert.equal(jwtGet.body.session.mode, 'solo')
    })
  })

  it('rejects missing token, bad bearer, and does not treat 401 as 503', async () => {
    await withServer(async (base) => {
      const missing = await json(base, 'GET', '/api/collaboration-config', { 'content-type': 'application/json' })
      assert.equal(missing.status, 401)
      const bad = await json(base, 'GET', '/api/collaboration-config', {
        authorization: 'Bearer definitely-not-the-token',
        'content-type': 'application/json',
      })
      assert.equal(bad.status, 401)
      assert.notEqual(missing.status, 503)
      assert.notEqual(bad.status, 503)
    })
  })

  it('private bridge nonce can GET; bad nonce cannot', async () => {
    process.env.OPENCLAUDE_TRUST_BRIDGE_IP = '127.0.0.1'
    process.env.OC_CONTAINER_ID = '3'
    process.env.OC_BRIDGE_NONCE = NONCE
    await withServer(async (base) => {
      const ok = await json(base, 'GET', '/api/collaboration-config', {
        'x-openclaude-container-id': '3',
        'x-openclaude-bridge-nonce': NONCE,
        'content-type': 'application/json',
      })
      assert.equal(ok.status, 200, JSON.stringify(ok.body))
      const bad = await json(base, 'GET', '/api/collaboration-config', {
        'x-openclaude-container-id': '3',
        'x-openclaude-bridge-nonce': 'ab'.repeat(32),
        'content-type': 'application/json',
      })
      assert.equal(bad.status, 401)
    })
  })

  it('non-selfhost is 404; non-main session is 400; unknown parent fail-closes advisor PUT; CAS is 409', async () => {
    await withServer(async (base) => {
      const access = { authorization: `Bearer ${ACCESS}`, 'content-type': 'application/json' }
      delete process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS
      const closed = await json(base, 'GET', '/api/collaboration-config', access)
      assert.equal(closed.status, 404)
      process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'

      const coder = await json(base, 'PUT', '/api/sessions/collabcoder', access, {
        agentId: 'coder',
        title: 'not main',
        modelId: 'glm-5.2',
      })
      assert.equal(coder.status, 200)
      const notMain = await json(base, 'GET', '/api/collaboration-config?sessionId=collabcoder', access)
      assert.equal(notMain.status, 400)

      const sid = 'collabccb1'
      await json(base, 'PUT', `/api/sessions/${sid}`, access, {
        agentId: 'main',
        title: 'ccb',
        modelId: 'gpt-6-astra',
      })
      const unknownParent = await json(base, 'PUT', '/api/collaboration-config', access, {
        sessionId: sid,
        mode: 'advisor',
        advisorModel: 'gpt-6-astra',
        expectedRev: 0,
      })
      assert.equal(unknownParent.status, 409, JSON.stringify(unknownParent.body))

      const cas = await json(base, 'PUT', '/api/collaboration-config', access, {
        mode: 'solo',
        asDefault: true,
        expectedRev: 999,
      })
      assert.equal(cas.status, 409)
    })
  })

  it('bridge trusted parent lets missing local row read/write; forged ACCESS metadata does not', async () => {
    process.env.OPENCLAUDE_TRUST_BRIDGE_IP = '127.0.0.1'
    process.env.OC_CONTAINER_ID = '3'
    process.env.OC_BRIDGE_NONCE = NONCE
    await withServer(async (base) => {
      const sid = 'bridgefresh1'
      const trusted = {
        'x-openclaude-container-id': '3',
        'x-openclaude-bridge-nonce': NONCE,
        [COLLAB_BRIDGE_SESSION_HEADER]: sid,
        [COLLAB_BRIDGE_AGENT_HEADER]: 'main',
        [COLLAB_BRIDGE_MODEL_HEADER]: 'glm-5.2',
        'content-type': 'application/json',
      }
      const get = await json(base, 'GET', `/api/collaboration-config?sessionId=${sid}`, trusted)
      assert.equal(get.status, 200, JSON.stringify(get.body))
      assert.equal(get.body.session.mode, 'solo')

      const put = await json(base, 'PUT', '/api/collaboration-config', trusted, {
        sessionId: sid,
        mode: 'advisor',
        advisorModel: 'gpt-6-astra',
        expectedRev: get.body.rev,
      })
      assert.equal(put.status, 200, JSON.stringify(put.body))
      assert.equal(put.body.session.mode, 'advisor')

      const mismatch = await json(base, 'GET', `/api/collaboration-config?sessionId=${sid}`, {
        ...trusted,
        [COLLAB_BRIDGE_SESSION_HEADER]: 'other-session',
      })
      assert.equal(mismatch.status, 404)

      const noMeta = await json(base, 'GET', `/api/collaboration-config?sessionId=${sid}-missing`, {
        'x-openclaude-container-id': '3',
        'x-openclaude-bridge-nonce': NONCE,
        'content-type': 'application/json',
      })
      assert.equal(noMeta.status, 404)

      const coder = await json(base, 'GET', `/api/collaboration-config?sessionId=${sid}`, {
        ...trusted,
        [COLLAB_BRIDGE_AGENT_HEADER]: 'coder',
      })
      assert.equal(coder.status, 400)
    })
  })

  it('ACCESS forged collab metadata cannot mint a missing session', async () => {
    await withServer(async (base) => {
      const forged = {
        authorization: `Bearer ${ACCESS}`,
        'content-type': 'application/json',
        [COLLAB_BRIDGE_SESSION_HEADER]: 'forged-sid',
        [COLLAB_BRIDGE_AGENT_HEADER]: 'main',
        [COLLAB_BRIDGE_MODEL_HEADER]: 'glm-5.2',
      }
      const get = await json(base, 'GET', '/api/collaboration-config?sessionId=forged-sid', forged)
      assert.equal(get.status, 404)
      const put = await json(base, 'PUT', '/api/collaboration-config', forged, {
        sessionId: 'forged-sid',
        mode: 'team',
        expectedRev: 0,
      })
      assert.equal(put.status, 404)
    })
  })
})
