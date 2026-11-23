import * as assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import type { Pool } from 'pg'
import { type V3ContainerStatus, V3_CONTAINER_PORT } from '../agent-sandbox/v3supervisor.js'
import {
  COLLAB_BRIDGE_AGENT_HEADER,
  COLLAB_BRIDGE_MODEL_HEADER,
  COLLAB_BRIDGE_SESSION_HEADER,
} from '@openclaude/gateway'
import { signAccess } from '../auth/jwt.js'
import { resetPool, setPoolOverride } from '../db/index.js'
import { containerApiProxy, matchContainerApiProxyRoute } from '../http/containerApiProxy.js'
import { createCommercialHandler } from '../http/router.js'
import { _clearMaintenanceCache } from '../middleware/maintenanceMode.js'

function makeReq(opts: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: Buffer | string
}) {
  const req = Readable.from(opts.body ? [opts.body] : []) as Readable & {
    method: string
    url: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  req.method = opts.method ?? 'GET'
  req.url = opts.url ?? '/api/tasks'
  req.headers = opts.headers ?? { host: 'claudeai.chat' }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

function makeRes() {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number
    headersSent: boolean
    writableEnded: boolean
    headers: Record<string, string | string[]>
    body: Buffer
    writeHead: (status: number, headers?: Record<string, string | string[]>) => void
    end: (body?: string | Buffer) => void
    destroy: () => void
    setHeader: (k: string, v: string) => void
  }
  res.statusCode = 200
  res.headersSent = false
  res.writableEnded = false
  res.headers = {}
  res.body = Buffer.alloc(0)
  res.writeHead = (status, headers = {}) => {
    res.statusCode = status
    res.headersSent = true
    res.headers = { ...res.headers, ...headers }
  }
  res.end = (body) => {
    if (body !== undefined) res.body = Buffer.isBuffer(body) ? body : Buffer.from(body)
    res.writableEnded = true
  }
  res.destroy = () => {
    res.writableEnded = true
  }
  res.setHeader = (k, v) => {
    res.headers[k] = v
  }
  return res
}

function makeStatus(overrides: Partial<V3ContainerStatus> = {}): V3ContainerStatus {
  return {
    containerId: 7,
    userId: 7,
    state: 'running',
    boundIp: '172.30.0.42',
    port: V3_CONTAINER_PORT,
    hostId: 'self',
    lastWsActivity: null,
    dockerContainerId: '0123456789abcdef',
    ...overrides,
  }
}

function makeCtx() {
  const log = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return log
    },
  }
  return {
    requestId: 'req_1',
    clientIp: '1.2.3.4',
    authBoundIp: '127.0.0.1',
    userAgent: 'ua',
    log,
  }
}

describe('containerApiProxy', () => {
  it('matches only commercial-safe container routes', () => {
    assert.equal(matchContainerApiProxyRoute('/api/tasks', 'POST'), true)
    assert.equal(matchContainerApiProxyRoute('/api/tasks-executions', 'GET'), true)
    assert.equal(matchContainerApiProxyRoute('/api/agents', 'GET'), true)
    // v5 纯市场:不允许经容器代理创建容器内 agent(POST 已砍,其它 agent 走市场安装)。
    assert.equal(matchContainerApiProxyRoute('/api/agents', 'POST'), false)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/memory/user', 'PUT'), true)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/memory/usage', 'GET'), true)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/memory/usage', 'POST'), false)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/message', 'POST'), false)
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      assert.equal(
        matchContainerApiProxyRoute('/api/agents/advisor/consult', method),
        false,
        `consult must not be commercially proxied (${method})`,
      )
    }
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/auto-dream-optimizer', 'GET'), true)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/auto-dream-optimizer', 'POST'), true)
    assert.equal(
      matchContainerApiProxyRoute('/api/agents/main/auto-dream-optimizer/cancel', 'POST'),
      true,
    )
    for (const action of ['apply', 'dismiss']) {
      assert.equal(
        matchContainerApiProxyRoute(
          `/api/agents/main/auto-dream-optimizer/proposals/${'a'.repeat(32)}/${action}`,
          'POST',
        ),
        true,
      )
    }
    assert.equal(
      matchContainerApiProxyRoute('/api/agents/main/auto-dream-optimizer/cancel', 'GET'),
      false,
    )
    assert.equal(
      matchContainerApiProxyRoute(
        `/api/agents/main/auto-dream-optimizer/proposals/${'a'.repeat(31)}/apply`,
        'POST',
      ),
      false,
    )
    assert.equal(
      matchContainerApiProxyRoute('/api/agents/main./auto-dream-optimizer', 'POST'),
      false,
    )
    // v5 轻量组队:旧团队路由已从容器代理 allowlist 移除(浏览器→容器不再放行)。
    assert.equal(matchContainerApiProxyRoute('/api/agent-teams', 'GET'), false)
    assert.equal(matchContainerApiProxyRoute('/api/agent-teams/dev_team', 'DELETE'), false)
    assert.equal(matchContainerApiProxyRoute('/api/team-runs/trun-abc123', 'GET'), false)
    assert.equal(matchContainerApiProxyRoute('/api/tasks-executions', 'POST'), false)
    // Clarvy 上下文健康与记忆/技能归档代理白名单(OCV5-859)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/context-health', 'GET'), true)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/context-health', 'POST'), false)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/context-hygiene/run', 'POST'), true)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/context-hygiene/run', 'GET'), false)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/context-hygiene/history', 'GET'), true)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/context-hygiene/history', 'POST'), false)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/memory/archive', 'GET'), true)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/memory/archive', 'POST'), true)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/memory/archive', 'DELETE'), false)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/memory/archive/restore', 'POST'), true)
    assert.equal(matchContainerApiProxyRoute('/api/agents/main/memory/archive/restore', 'GET'), false)
    assert.equal(matchContainerApiProxyRoute('/api/skills/archive', 'GET'), true)
    assert.equal(matchContainerApiProxyRoute('/api/skills/archive', 'POST'), false)
    assert.equal(matchContainerApiProxyRoute('/api/skills/archive/restore', 'POST'), true)
    assert.equal(matchContainerApiProxyRoute('/api/skills/archive/restore', 'GET'), false)
    assert.equal(matchContainerApiProxyRoute('/api/skills/my-skill/archive', 'POST'), true)
    assert.equal(matchContainerApiProxyRoute('/api/skills/my-skill/archive', 'GET'), false)
  })

  it('proxies local JSON API calls with bridge headers and stripped auth', async () => {
    const captured: { current?: { options: any; body: Buffer } } = {}
    const responseBody = Buffer.from('{"ok":true}')
    const httpRequestImpl = (options: any) => {
      const req = new EventEmitter() as EventEmitter & {
        write: (chunk: Buffer) => void
        end: () => void
        destroy: (err?: Error) => void
      }
      const chunks: Buffer[] = []
      req.write = (chunk) => {
        chunks.push(Buffer.from(chunk))
      }
      req.destroy = (err?: Error) => {
        if (err) req.emit('error', err)
      }
      req.end = () => {
        captured.current = { options, body: Buffer.concat(chunks) }
        const upstream = Readable.from([responseBody]) as Readable & {
          statusCode: number
          headers: Record<string, string>
          socket: { setTimeout: () => void }
        }
        upstream.statusCode = 200
        upstream.headers = {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': 'x=y',
        }
        upstream.socket = { setTimeout() {} }
        queueMicrotask(() => req.emit('response', upstream))
      }
      return req as any
    }

    const req = makeReq({
      method: 'PUT',
      url: '/api/agents/main/memory/user',
      headers: {
        host: 'claudeai.chat',
        authorization: 'Bearer commercial-token',
        cookie: 'oc=secret',
        'content-type': 'application/json',
        'x-request-id': 'req_1',
      },
      body: Buffer.from('{"text":"hello"}'),
    })
    const res = makeRes()
    await containerApiProxy(
      req as any,
      res as any,
      makeCtx() as any,
      {
        v3: {} as any,
        bridgeSecret: 'bridge-secret',
        getStatus: async () => makeStatus(),
        httpRequestImpl: httpRequestImpl as any,
      },
      7n,
    )

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(res.headers['set-cookie'], undefined)
    assert.equal(res.body.toString(), '{"ok":true}')
    if (!captured.current) throw new Error('upstream request was not captured')
    const got = captured.current
    assert.equal(got.options.host, '172.30.0.42')
    assert.equal(got.options.port, V3_CONTAINER_PORT)
    assert.equal(got.options.method, 'PUT')
    assert.equal(got.options.path, '/api/agents/main/memory/user')
    assert.equal(got.options.headers.authorization, undefined)
    assert.equal(got.options.headers.cookie, undefined)
    assert.equal(got.options.headers['X-OpenClaude-Container-Id'], '7')
    assert.equal(
      got.options.headers['X-OpenClaude-Bridge-Nonce'],
      createHmac('sha256', 'bridge-secret').update('7').digest('hex'),
    )
    assert.equal(got.body.toString(), '{"text":"hello"}')
  })

  it('OCV5-659 body read failures are connection errors and never forwarded', async () => {
    for (const partial of [false, true]) {
      const failure = Object.assign(new Error('private body detail must not be logged'), { code: 'ECONNRESET', status: 413 })
      const req = Object.assign(Readable.from((async function* () {
        if (partial) yield Buffer.from('{"incomplete":')
        throw failure
      })()), {
        method: partial ? 'PUT' : 'GET',
        url: partial ? '/api/agents/main/memory/user' : '/api/features',
        headers: { host: 'claudeai.chat' },
        aborted: !partial,
      })
      const res = makeRes()
      const logs: unknown[][] = []
      const ctx = makeCtx()
      ctx.log.warn = (...args: unknown[]) => { logs.push(args) }
      await containerApiProxy(req as any, res as any, ctx as any, {
        v3: {} as any, bridgeSecret: 'bridge-secret',
        getStatus: async () => { assert.fail('incomplete body must not reach container lookup') },
      }, 7n)
      assert.equal(res.statusCode, 400)
      const body = JSON.parse(res.body.toString())
      assert.equal(body.error.code, 'REQUEST_BODY_READ_FAILED')
      assert.equal(body.userError.category, 'connection')
      assert.doesNotMatch(res.body.toString(), /PAYLOAD_TOO_LARGE|private body detail/)
      assert.equal(logs.length, 1)
      assert.deepEqual(logs[0], ['container_api_request_body_read_failed', {
        uid: '7', method: req.method,
        route: partial ? '/api/agents/:id/memory/:target' : '/api/features',
        reason: partial ? 'read_failed' : 'aborted',
      }])
    }
  })

  it('OCV5-659 complete request at the byte cap still reaches container lookup', async () => {
    const req = makeReq({ method: 'PUT', url: '/api/agents/main/memory/user', body: Buffer.alloc(512 * 1024) })
    const res = makeRes()
    let lookups = 0
    await containerApiProxy(req as any, res as any, makeCtx() as any, {
      v3: {} as any, bridgeSecret: 'bridge-secret',
      getStatus: async () => { lookups++; return null },
    }, 7n)
    assert.equal(lookups, 1)
    assert.equal(res.statusCode, 503)
    assert.match(res.body.toString(), /CONTAINER_NOT_RUNNING/)
  })

  it('rejects oversized request bodies before dispatch', async () => {
    let dispatched = false
    const req = makeReq({
      method: 'PUT',
      url: '/api/agents/main/memory/user',
      body: Buffer.alloc(512 * 1024 + 1),
    })
    const res = makeRes()
    await containerApiProxy(
      req as any,
      res as any,
      makeCtx() as any,
      {
        v3: {} as any,
        bridgeSecret: 'bridge-secret',
        getStatus: async () => makeStatus(),
        httpRequestImpl: (() => {
          dispatched = true
          throw new Error('should not dispatch')
        }) as any,
      },
      7n,
    )
    assert.equal(res.statusCode, 413)
    assert.equal(dispatched, false)
    assert.match(res.body.toString(), /PAYLOAD_TOO_LARGE/)
  })

  it('rejects non-v3 container endpoints before dispatch', async () => {
    let dispatched = false
    const req = makeReq({ method: 'GET', url: '/api/tasks' })
    const res = makeRes()
    await containerApiProxy(
      req as any,
      res as any,
      makeCtx() as any,
      {
        v3: {} as any,
        bridgeSecret: 'bridge-secret',
        getStatus: async () => makeStatus({ boundIp: '127.0.0.1' }),
        httpRequestImpl: (() => {
          dispatched = true
          throw new Error('should not dispatch')
        }) as any,
      },
      7n,
    )
    assert.equal(res.statusCode, 502)
    assert.equal(dispatched, false)
    assert.match(res.body.toString(), /BAD_GATEWAY/)
  })

  it('zeros remote node-agent psk after tunnel dispatch attempts', async () => {
    const psk = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const req = makeReq({ method: 'GET', url: '/api/tasks' })
    const res = makeRes()
    await containerApiProxy(
      req as any,
      res as any,
      makeCtx() as any,
      {
        v3: {} as any,
        bridgeSecret: 'bridge-secret',
        selfHostId: 'self',
        getStatus: async () => makeStatus({ hostId: 'remote' }),
        getHostById: async () => ({}) as any,
        rowToTarget: (() => ({
          id: 'remote',
          host: 'remote.invalid',
          port: 9444,
          ca: Buffer.alloc(0),
          certFingerprintSha256: 'f'.repeat(64),
          psk,
        })) as any,
        tunnelDial: (async () => {
          throw new Error('dial failed')
        }) as any,
      },
      7n,
    )
    assert.equal(res.statusCode, 502)
    assert.equal(psk.equals(Buffer.alloc(psk.length)), true)
  })

  it('strips forged collab headers and attaches looked-up parent for collaboration-config', async () => {
    const captured: { current?: { options: any; body: Buffer } } = {}
    const httpRequestImpl = (options: any) => {
      const req = new EventEmitter() as EventEmitter & {
        write: (chunk: Buffer) => void
        end: () => void
        destroy: (err?: Error) => void
      }
      const chunks: Buffer[] = []
      req.write = (chunk) => {
        chunks.push(Buffer.from(chunk))
      }
      req.destroy = (err?: Error) => {
        if (err) req.emit('error', err)
      }
      req.end = () => {
        captured.current = { options, body: Buffer.concat(chunks) }
        const upstream = Readable.from([Buffer.from('{"ok":true}')]) as Readable & {
          statusCode: number
          headers: Record<string, string>
          socket: { setTimeout: () => void }
        }
        upstream.statusCode = 200
        upstream.headers = { 'content-type': 'application/json' }
        upstream.socket = { setTimeout() {} }
        queueMicrotask(() => req.emit('response', upstream))
      }
      return req as any
    }
    const req = makeReq({
      method: 'PUT',
      url: '/api/collaboration-config',
      headers: {
        host: 'claudeai.chat',
        authorization: 'Bearer commercial-token',
        [COLLAB_BRIDGE_SESSION_HEADER]: 'forged',
        [COLLAB_BRIDGE_AGENT_HEADER]: 'coder',
        [COLLAB_BRIDGE_MODEL_HEADER]: 'evil-model',
        'content-type': 'application/json',
      },
      body: Buffer.from(JSON.stringify({
        sessionId: 'fresh-1',
        mode: 'advisor',
        advisorModel: 'gpt-6-astra',
        expectedRev: 0,
      })),
    })
    const res = makeRes()
    await containerApiProxy(
      req as any,
      res as any,
      makeCtx() as any,
      {
        v3: {} as any,
        bridgeSecret: 'bridge-secret',
        getStatus: async () => makeStatus(),
        httpRequestImpl: httpRequestImpl as any,
        lookupCollabSessionParent: async ({ uid, sessionId }) => {
          assert.equal(uid, 7n)
          assert.equal(sessionId, 'fresh-1')
          return { agentId: 'main', modelId: 'glm-5.2' }
        },
      },
      7n,
    )
    assert.equal(res.statusCode, 200)
    if (!captured.current) throw new Error('upstream request was not captured')
    const headers = captured.current.options.headers as Record<string, string>
    assert.equal(headers.authorization, undefined)
    assert.equal(headers[COLLAB_BRIDGE_SESSION_HEADER], 'fresh-1')
    assert.equal(headers[COLLAB_BRIDGE_AGENT_HEADER], 'main')
    assert.equal(headers[COLLAB_BRIDGE_MODEL_HEADER], 'glm-5.2')
  })

  it('fail-closes collab-config when owner is missing or lookup throws', async () => {
    let dispatched = 0
    const httpRequestImpl = (() => {
      dispatched += 1
      throw new Error('should not dispatch')
    }) as any
    const missing = makeRes()
    await containerApiProxy(
      makeReq({
        method: 'GET',
        url: '/api/collaboration-config?sessionId=missing-1',
      }) as any,
      missing as any,
      makeCtx() as any,
      {
        v3: {} as any,
        bridgeSecret: 'bridge-secret',
        getStatus: async () => makeStatus(),
        httpRequestImpl,
        lookupCollabSessionParent: async () => null,
      },
      7n,
    )
    assert.equal(missing.statusCode, 404)
    assert.match(missing.body.toString(), /SESSION_NOT_FOUND/)

    const boom = makeRes()
    await containerApiProxy(
      makeReq({
        method: 'GET',
        url: '/api/collaboration-config?sessionId=boom-1',
      }) as any,
      boom as any,
      makeCtx() as any,
      {
        v3: {} as any,
        bridgeSecret: 'bridge-secret',
        getStatus: async () => makeStatus(),
        httpRequestImpl,
        lookupCollabSessionParent: async () => {
          throw new Error('pg unavailable')
        },
      },
      7n,
    )
    assert.equal(boom.statusCode, 503)
    assert.match(boom.body.toString(), /COLLAB_SESSION_LOOKUP_FAILED/)
    assert.notEqual(boom.statusCode, 401)
    assert.equal(dispatched, 0)
  })

  it('promotes upstream timeout from CONNECT_MS to IDLE_MS upon socket connect for slow browser actions', async () => {
    let initialTimeout = 0
    const promotedTimeouts: number[] = []
    const httpRequestImpl = ((options: { timeout?: number }) => {
      initialTimeout = options.timeout ?? 0
      const reqEmitter = new EventEmitter() as EventEmitter & {
        setTimeout: (ms: number) => void
        write: (buf: Buffer) => boolean
        end: () => void
        destroy: () => void
      }
      reqEmitter.setTimeout = (ms: number) => {
        promotedTimeouts.push(ms)
      }
      reqEmitter.write = () => true
      reqEmitter.destroy = () => {}
      reqEmitter.end = () => {
        const fakeSocket = new EventEmitter() as EventEmitter & { connecting: boolean }
        fakeSocket.connecting = true
        reqEmitter.emit('socket', fakeSocket)
        fakeSocket.emit('connect')
        const resp = new EventEmitter() as EventEmitter & {
          statusCode: number
          headers: Record<string, string>
          socket: { setTimeout: (ms: number) => void }
        }
        resp.statusCode = 200
        resp.headers = { 'content-type': 'application/json' }
        resp.socket = { setTimeout: () => {} }
        reqEmitter.emit('response', resp)
        resp.emit('data', Buffer.from('{"available":true,"active":true}'))
        resp.emit('end')
      }
      return reqEmitter
    }) as any

    const res = makeRes()
    await containerApiProxy(
      makeReq({ method: 'POST', url: '/api/agents/main/browser/action', body: '{"action":"open"}' }) as any,
      res as any,
      makeCtx() as any,
      {
        v3: {} as any,
        bridgeSecret: 'bridge-secret',
        getStatus: async () => makeStatus(),
        httpRequestImpl,
      },
      7n,
    )
    assert.equal(res.statusCode, 200)
    assert.equal(initialTimeout, 3_000)
    assert.ok(promotedTimeouts.includes(60_000), `expected IDLE_MS(60000), got ${JSON.stringify(promotedTimeouts)}`)
  })
})

describe('Clarvy context-health & archive router firewall (OCV5-859)', () => {
  const JWT_SECRET = 'c'.repeat(64)
  const CLARVY_ROUTES: ReadonlyArray<{ method: string; path: string; wrongMethod: string }> = [
    { method: 'GET', path: '/api/agents/main/context-health', wrongMethod: 'POST' },
    { method: 'POST', path: '/api/agents/main/context-hygiene/run', wrongMethod: 'GET' },
    { method: 'GET', path: '/api/agents/main/context-hygiene/history', wrongMethod: 'POST' },
    { method: 'GET', path: '/api/agents/main/memory/archive', wrongMethod: 'DELETE' },
    { method: 'POST', path: '/api/agents/main/memory/archive', wrongMethod: 'PUT' },
    { method: 'POST', path: '/api/agents/main/memory/archive/restore', wrongMethod: 'GET' },
    // /api/skills/:name allows GET/PUT/DELETE, so POST is the disallowed method on /api/skills/archive.
    { method: 'GET', path: '/api/skills/archive', wrongMethod: 'POST' },
    { method: 'POST', path: '/api/skills/archive/restore', wrongMethod: 'GET' },
    { method: 'POST', path: '/api/skills/my-skill/archive', wrongMethod: 'DELETE' },
  ]

  function makeStubPool(): Pool {
    return {
      async query(sql: string) {
        const text = sql.replace(/\s+/g, ' ')
        if (text.includes('FROM system_settings')) {
          return {
            rowCount: 1,
            rows: [{ value: false, description: null, updated_at: new Date(), updated_by: '1' }],
          }
        }
        if (text.includes('FROM users')) {
          return { rowCount: 1, rows: [{ role: 'user', status: 'active' }] }
        }
        return { rowCount: 0, rows: [] }
      },
      async connect() {
        throw new Error('not used')
      },
      async end() {},
      on() {
        return this
      },
    } as unknown as Pool
  }

  afterEach(async () => {
    _clearMaintenanceCache()
    await resetPool()
  })

  it('unauthenticated and gateway-only/cross-layer credential requests to Clarvy routes fail closed with 401 UNAUTHORIZED (never fall through to gateway)', async () => {
    const pool = makeStubPool()
    setPoolOverride(pool)
    const { token: userToken } = await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)
    const { token: foreignGatewayToken } = await signAccess(
      { sub: '42', role: 'user' },
      'different-gateway-access-token-secret',
    )
    const handler = createCommercialHandler(
      {
        jwtSecret: JWT_SECRET,
        mailer: { async send() {} },
        redis: { async incr() { return 1 }, async expire() { return 1 } },
        turnstileBypass: true,
        verifyEmailUrlBase: 'https://test.local',
        resetPasswordUrlBase: 'https://test.local',
        v3Supervisor: { pool } as any,
        bridgeSecret: 'bridge-secret',
      },
      { logger: makeCtx().log as any },
    )

    const credVariants: Array<{ name: string; headers: Record<string, string> }> = [
      { name: 'no credentials', headers: {} },
      // Gateway extractToken() accepts `sec-websocket-protocol: bearer, <tok>` and raw `Authorization: <tok>`
      // without `Bearer ` prefix, whereas commercial extractTokenFromReq() ignores both.
      // Clarvy routes MUST terminate with 401 in commercial instead of returning false to gateway.
      {
        name: 'sec-websocket-protocol bearer user JWT (gateway-only extraction)',
        headers: { 'sec-websocket-protocol': `bearer, ${userToken}` },
      },
      {
        name: 'raw Authorization header without Bearer prefix (gateway-only extraction)',
        headers: { authorization: userToken },
      },
      {
        name: 'non-commercial gateway-signed JWT',
        headers: { authorization: `Bearer ${foreignGatewayToken}` },
      },
    ]

    for (const v of credVariants) {
      for (const r of CLARVY_ROUTES) {
        const req = makeReq({ method: r.method, url: r.path, headers: v.headers })
        const res = makeRes()
        const handled = await handler(req as any, res as any)
        assert.equal(
          handled,
          true,
          `${r.method} ${r.path} (${v.name}) must terminate in commercial and NEVER fall through to gateway`,
        )
        assert.equal(
          res.statusCode,
          401,
          `${r.method} ${r.path} (${v.name}) expected 401, got ${res.statusCode} ${res.body.toString()}`,
        )
        assert.equal(JSON.parse(res.body.toString()).error?.code, 'UNAUTHORIZED')
      }
    }
  })

  it('blocks commercial users on host fallback (proxy off or disallowed method) with 403 FORBIDDEN', async () => {
    const pool = makeStubPool()
    setPoolOverride(pool)
    const { token } = await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)

    // 1) Without v3Supervisor (host fallback): allowed methods must be blocked with 403 FORBIDDEN.
    const hostFallbackHandler = createCommercialHandler(
      {
        jwtSecret: JWT_SECRET,
        mailer: { async send() {} },
        redis: { async incr() { return 1 }, async expire() { return 1 } },
        turnstileBypass: true,
        verifyEmailUrlBase: 'https://test.local',
        resetPasswordUrlBase: 'https://test.local',
      },
      { logger: makeCtx().log as any },
    )
    for (const r of CLARVY_ROUTES) {
      const req = makeReq({
        method: r.method,
        url: r.path,
        headers: { host: 'claudeai.chat', authorization: `Bearer ${token}` },
      })
      const res = makeRes()
      const handled = await hostFallbackHandler(req as any, res as any)
      assert.equal(handled, true, `${r.method} ${r.path} must be intercepted by BLOCKED_FOR_USER_RULES`)
      assert.equal(res.statusCode, 403, `${r.method} ${r.path} body=${res.body.toString()}`)
      assert.equal(JSON.parse(res.body.toString()).error?.code, 'FORBIDDEN')
    }

    // 2) With v3Supervisor enabled: disallowed methods and %-encoded agent/skill segments still hit 403 FORBIDDEN.
    const proxyHandler = createCommercialHandler(
      {
        jwtSecret: JWT_SECRET,
        mailer: { async send() {} },
        redis: { async incr() { return 1 }, async expire() { return 1 } },
        turnstileBypass: true,
        verifyEmailUrlBase: 'https://test.local',
        resetPasswordUrlBase: 'https://test.local',
        v3Supervisor: { pool } as any,
        bridgeSecret: 'bridge-secret',
      },
      { logger: makeCtx().log as any },
    )
    for (const r of CLARVY_ROUTES) {
      const req = makeReq({
        method: r.wrongMethod,
        url: r.path,
        headers: { host: 'claudeai.chat', authorization: `Bearer ${token}` },
      })
      const res = makeRes()
      const handled = await proxyHandler(req as any, res as any)
      assert.equal(handled, true, `${r.wrongMethod} ${r.path} must be blocked`)
      assert.equal(res.statusCode, 403, `${r.wrongMethod} ${r.path} body=${res.body.toString()}`)
    }

    for (const encodedPath of ['/api/agents/ma%69n/context-health', '/api/skills/my%2dskill/archive']) {
      const req = makeReq({
        method: 'GET',
        url: encodedPath,
        headers: { host: 'claudeai.chat', authorization: `Bearer ${token}` },
      })
      const res = makeRes()
      const handled = await proxyHandler(req as any, res as any)
      assert.equal(handled, true, `${encodedPath} must be blocked`)
      assert.equal(res.statusCode, 403, `${encodedPath} must return 403`)
    }
  })

  it('authenticated commercial users still enter containerApiProxy before BLOCKED_FOR_USER_RULES', async () => {
    const pool = makeStubPool()
    setPoolOverride(pool)
    const { token } = await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)
    const readyCalls: string[] = []
    const handler = createCommercialHandler(
      {
        jwtSecret: JWT_SECRET,
        mailer: { async send() {} },
        redis: { async incr() { return 1 }, async expire() { return 1 } },
        turnstileBypass: true,
        verifyEmailUrlBase: 'https://test.local',
        resetPasswordUrlBase: 'https://test.local',
        v3Supervisor: { pool } as any,
        bridgeSecret: 'bridge-secret',
        ensureContainerReady: async (uid) => {
          readyCalls.push(uid.toString())
        },
      },
      { logger: makeCtx().log as any },
    )

    const req = makeReq({
      method: 'GET',
      url: '/api/agents/main/context-health',
      headers: { host: 'claudeai.chat', authorization: `Bearer ${token}` },
    })
    const res = makeRes()
    const handled = await handler(req as any, res as any)
    assert.equal(handled, true)
    assert.deepEqual(readyCalls, ['42'], 'must dispatch through containerApiProxy, not BLOCKED_FOR_USER_RULES')
    assert.notEqual(res.statusCode, 403)
    assert.notEqual(res.statusCode, 404)
  })
})
