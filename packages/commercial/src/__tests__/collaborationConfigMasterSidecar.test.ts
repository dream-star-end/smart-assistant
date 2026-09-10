/**
 * SIMULATED two-process collab-config topology (not live PG/Docker/WS/model/ledger).
 * Master Gateway HTTP + real containerApiProxy/nonce; sidecar is a second Gateway
 * with a private HOME and no session row. Final hop is redirected to loopback.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/collaborationConfigMasterSidecar.test.ts
 */
import * as assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '../../../..')
const TSX = join(REPO, 'node_modules/tsx/dist/loader.mjs')
const SECRET = 'review-fake-jwt-only'
const BRIDGE = 'review-fake-bridge-only'
const NONCE = createHmac('sha256', BRIDGE).update('3').digest('hex')
const ROLE = process.env.OC_M12_TOPOLOGY_ROLE
const temps: string[] = []

after(() => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

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

if (ROLE === 'sidecar' || ROLE === 'master') {
  const { Gateway, _setModelCatalogClientForTests } = await import('@openclaude/gateway')
  const { getClientSession, getClientSessionCollabParent, paths } = await import('@openclaude/storage')
  const { containerApiProxy, matchContainerApiProxyRoute } = await import('../http/containerApiProxy.js')
  const { V3_CONTAINER_PORT } = await import('../agent-sandbox/v3supervisor.js')
  _setModelCatalogClientForTests({
    getRoutingView: async () => catalogView(),
  } as never)
  const config = {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: 'sidecar-access-not-used-on-bridge' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: join(process.env.OPENCLAUDE_HOME!, 'sessions.db') },
    defaults: { model: 'glm-5.2', permissionMode: 'default' },
    channels: { webchat: { enabled: true } },
  }
  const gw = new Gateway({
    config,
    agentsConfig: { agents: [{ id: 'main', model: 'glm-5.2' }, { id: 'coder', model: 'glm-5.2' }], routes: [], default: 'main' },
    ...(ROLE === 'master'
      ? { commercial: { jwtSecret: Buffer.from(SECRET), handle: async () => false } }
      : {}),
  } as never)
  if (ROLE === 'sidecar') {
    await (gw as unknown as { advisorConfigStore: () => { markEngineProven: (e: string) => Promise<unknown> } })
      .advisorConfigStore()
      .markEngineProven('codex')
  }
  if (ROLE === 'master') {
    await (gw as unknown as { advisorConfigStore: () => { markEngineProven: (e: string) => Promise<unknown> } })
      .advisorConfigStore()
      .markEngineProven('codex')
  }
  const captured: Array<Record<string, string | undefined>> = []
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url!, 'http://local')
    if (ROLE === 'master' && matchContainerApiProxyRoute(url.pathname, req.method!)) {
      const claims = (gw as any).verifyCommercialJwt(String(req.headers.authorization || '').replace(/^Bearer /, ''))
      if (!claims) {
        res.writeHead(401)
        res.end('{}')
        return
      }
      await containerApiProxy(
        req,
        res,
        { requestId: 'm12-topology', log: { warn() {}, info() {} } } as any,
        {
          v3: {} as any,
          bridgeSecret: BRIDGE,
          getStatus: async (uid) => {
            if (uid !== 3) throw new Error('wrong UID')
            return { state: 'running', containerId: '3', boundIp: '172.31.0.3', port: V3_CONTAINER_PORT } as any
          },
          lookupCollabSessionParent: async ({ uid, sessionId }) => {
            const row = await getClientSessionCollabParent(sessionId, `c:${uid.toString()}`)
            if (!row) return null
            return { agentId: row.agentId, ...(row.modelId ? { modelId: row.modelId } : {}) }
          },
          httpRequestImpl: ((opts: any) => {
            if (opts.host !== '172.31.0.3' || opts.port !== V3_CONTAINER_PORT) {
              throw new Error('unexpected destination')
            }
            captured.push(opts.headers)
            return request({ ...opts, host: '127.0.0.1', port: Number(process.env.SIDECAR_PORT) })
          }) as any,
        },
        BigInt(claims.sub),
      )
      return
    }
    ;(gw as any).handleHttp(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.send?.({ ready: true, port: (server.address() as any).port, home: paths.home })
  process.on('message', async (m: any) => {
    if (m.cmd === 'row') process.send?.({ row: await getClientSession(m.id, m.user), id: m.id })
    if (m.cmd === 'headers') process.send?.({ headers: captured.at(-1) ?? null })
    if (m.cmd === 'end') {
      _setModelCatalogClientForTests(null)
      await new Promise<void>((resolve) => server.close(() => resolve()))
      process.exit(0)
    }
  })
} else {
  function jwt(sub: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ sub, role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url')
    return `${header}.${payload}.${createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url')}`
  }

  function spawn(role: string, extra: NodeJS.ProcessEnv = {}) {
    const home = mkdtempSync(join(tmpdir(), `oc-m12-${role}-`))
    temps.push(home)
    const child = fork(fileURLToPath(import.meta.url), [], {
      execArgv: ['--import', TSX],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        OPENCLAUDE_HOME: home,
        OC_SELFHOST_ENGINE_LOCAL_TURNS: '1',
        OC_ADVISOR_OPEN_ENGINES: 'codex',
        OC_MODEL_AUTHORITY: '0',
        OC_RUNTIME_CHANNEL: 'v5',
        OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1',
        OC_CONTAINER_ID: '3',
        OC_BRIDGE_NONCE: NONCE,
        OC_M12_TOPOLOGY_ROLE: role,
        ...extra,
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    return child
  }

  function next(child: ChildProcess): Promise<any> {
    return new Promise((resolve, reject) => {
      child.once('message', resolve)
      child.once('error', reject)
    })
  }

  describe('SIMULATED master session + sidecar collab-config (no live PG/Docker)', () => {
    it('fresh master session is readable on sidecar through actual proxy+nonce', async () => {
      const side = spawn('sidecar')
      const sr = await next(side)
      const master = spawn('master', { SIDECAR_PORT: String(sr.port) })
      const mr = await next(master)
      const token = jwt('3')
      const foreign = jwt('9')
      const dests: string[] = []
      async function call(
        path: string,
        method = 'GET',
        body?: unknown,
        auth = token,
      ): Promise<{ status: number; body: any }> {
        const url = `http://127.0.0.1:${mr.port}${path}`
        dests.push(url)
        const res = await fetch(url, {
          method,
          signal: AbortSignal.timeout(8000),
          headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: res.status, body: await res.json().catch(() => ({})) }
      }
      try {
        assert.notEqual(sr.home, mr.home)
        const put = await call('/api/sessions/m12-fresh-session', 'PUT', {
          agentId: 'main',
          modelId: 'glm-5.2',
          title: 'new advisor conversation',
          messages: [],
          _baseSyncedAt: 0,
        })
        assert.equal(put.status, 200, JSON.stringify(put.body))
        master.send({ cmd: 'row', id: 'm12-fresh-session', user: 'c:3' })
        const owned = await next(master)
        assert.equal(owned.row?.userId, 'c:3')
        side.send({ cmd: 'row', id: 'm12-fresh-session', user: 'default' })
        const local = await next(side)
        assert.equal(local.row, null)

        const agents = await call('/api/agents')
        assert.equal(agents.status, 200, JSON.stringify(agents.body))

        const get = await call('/api/collaboration-config?sessionId=m12-fresh-session')
        assert.equal(get.status, 200, JSON.stringify(get.body))
        assert.equal(get.body.session.mode, 'solo')
        const cfg = await call('/api/collaboration-config', 'PUT', {
          sessionId: 'm12-fresh-session',
          mode: 'advisor',
          advisorModel: 'gpt-6-astra',
          expectedRev: get.body.rev,
          asDefault: false,
        })
        assert.equal(cfg.status, 200, JSON.stringify(cfg.body))
        assert.equal(cfg.body.session.mode, 'advisor')
        master.send({ cmd: 'headers' })
        const hdrs = await next(master)
        assert.equal(hdrs.headers?.authorization, undefined)
        assert.equal(hdrs.headers?.['x-openclaude-collab-session-id'], 'm12-fresh-session')
        assert.equal(hdrs.headers?.['x-openclaude-collab-agent-id'], 'main')
        assert.equal(hdrs.headers?.['x-openclaude-collab-model-id'], 'glm-5.2')

        const missing = await call('/api/collaboration-config?sessionId=m12-missing')
        assert.equal(missing.status, 404)

        await call('/api/sessions/m12-foreign', 'PUT', {
          agentId: 'main',
          modelId: 'glm-5.2',
          title: 'other owner',
          messages: [],
          _baseSyncedAt: 0,
        }, foreign)
        const steal = await call('/api/collaboration-config?sessionId=m12-foreign')
        assert.equal(steal.status, 404)

        await call('/api/sessions/m12-coder', 'PUT', {
          agentId: 'coder',
          modelId: 'glm-5.2',
          title: 'not main',
          messages: [],
          _baseSyncedAt: 0,
        })
        const notMain = await call('/api/collaboration-config?sessionId=m12-coder')
        assert.equal(notMain.status, 400)

        await call('/api/sessions/m12-unknown-parent', 'PUT', {
          agentId: 'main',
          modelId: 'gpt-6-astra',
          title: 'codex parent',
          messages: [],
          _baseSyncedAt: 0,
        })
        const unknownParent = await call('/api/collaboration-config', 'PUT', {
          sessionId: 'm12-unknown-parent',
          mode: 'advisor',
          advisorModel: 'gpt-6-astra',
          expectedRev: 0,
        })
        assert.equal(unknownParent.status, 409)

        const cas = await call('/api/collaboration-config', 'PUT', {
          mode: 'solo',
          asDefault: true,
          expectedRev: 999,
        })
        assert.equal(cas.status, 409)

        const global = await call('/api/collaboration-config', 'PUT', {
          mode: 'solo',
          asDefault: true,
          expectedRev: cfg.body.rev,
        })
        assert.equal(global.status, 200, JSON.stringify(global.body))
        const overlay = await call('/api/collaboration-config?sessionId=m12-fresh-session')
        assert.equal(overlay.status, 200)
        assert.equal(overlay.body.session.mode, 'advisor')
        assert.equal(overlay.body.defaultMode, 'solo')

        const sidecarDirect = await fetch(
          `http://127.0.0.1:${sr.port}/api/collaboration-config?sessionId=forged-static`,
          {
            headers: {
              authorization: 'Bearer sidecar-access-not-used-on-bridge',
              'x-openclaude-collab-session-id': 'forged-static',
              'x-openclaude-collab-agent-id': 'main',
              'x-openclaude-collab-model-id': 'glm-5.2',
            },
          },
        )
        dests.push(`http://127.0.0.1:${sr.port}/api/collaboration-config?sessionId=forged-static`)
        assert.equal(sidecarDirect.status, 404)

        assert.ok(dests.every((url) => url.startsWith('http://127.0.0.1:')))
        assert.equal(dests.length > 0, true)
      } finally {
        master.send({ cmd: 'end' })
        side.send({ cmd: 'end' })
        await Promise.all([
          new Promise((resolve) => master.once('exit', resolve)),
          new Promise((resolve) => side.once('exit', resolve)),
        ])
      }
    })
  })
}
