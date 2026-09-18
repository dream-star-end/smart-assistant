import * as assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { type V3ContainerStatus, V3_CONTAINER_PORT } from '../agent-sandbox/v3supervisor.js'
import {
  COLLAB_BRIDGE_AGENT_HEADER,
  COLLAB_BRIDGE_MODEL_HEADER,
  COLLAB_BRIDGE_SESSION_HEADER,
} from '@openclaude/gateway'
import { containerApiProxy, matchContainerApiProxyRoute } from '../http/containerApiProxy.js'

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
  return {
    requestId: 'req_1',
    clientIp: '1.2.3.4',
    authBoundIp: '127.0.0.1',
    userAgent: 'ua',
    log: { info() {}, warn() {}, error() {}, debug() {} },
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

  it('rejects oversized request bodies before dispatch', async () => {
    let dispatched = false
    const req = makeReq({
      method: 'PUT',
      url: '/api/agents/main/memory/user',
      body: Buffer.alloc(513 * 1024),
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
})
