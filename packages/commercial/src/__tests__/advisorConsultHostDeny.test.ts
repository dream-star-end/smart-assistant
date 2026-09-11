/**
 * Advisor consult host deny: ordinary commercial users cannot proxy or execute
 * /api/agents/advisor/consult on the master. Adjacent allowlisted agent/collab
 * routes still enter the container proxy path.
 *
 * Run: node --import tsx --test packages/commercial/src/__tests__/advisorConsultHostDeny.test.ts
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, test } from 'node:test'
import type { Pool } from 'pg'

import { signAccess } from '../auth/jwt.js'
import { resetPool, setPoolOverride } from '../db/index.js'
import { createCommercialHandler } from '../http/router.js'
import { matchContainerApiProxyRoute } from '../http/containerApiProxy.js'
import { _clearMaintenanceCache } from '../middleware/maintenanceMode.js'
import { matchBridgeApiAllowlist } from '@openclaude/gateway'

const JWT_SECRET = 'z'.repeat(64)
const CONSULT = '/api/agents/advisor/consult'
const USER_ID = '7'
const ADMIN_ID = '9'

afterEach(async () => {
  _clearMaintenanceCache()
  await resetPool()
})

function fakePool(role: 'user' | 'admin' = 'user'): {
  pool: Pool
  queries: { sql: string; params: unknown[] }[]
} {
  const queries: { sql: string; params: unknown[] }[] = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params })
      const text = sql.replace(/\s+/g, ' ')
      if (text.includes('FROM users') && text.includes('role = ANY')) {
        return { rowCount: 1, rows: [{ id: USER_ID, role }] }
      }
      if (text.includes('FROM users') && text.includes('SELECT role, status')) {
        return { rowCount: 1, rows: [{ role, status: 'active' }] }
      }
      if (text.includes('FROM agent_containers')) {
        return { rowCount: 0, rows: [] }
      }
      if (text.includes('INSERT INTO security_events')) {
        return { rowCount: 1, rows: [] }
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
  return { pool, queries }
}

function noopRedis() {
  return {
    async incr() {
      return 1
    },
    async expire() {
      return 1
    },
  }
}

function makeReq(
  method: string,
  url: string,
  token?: string,
): IncomingMessage {
  const stream = Readable.from([])
  const headers: Record<string, string> = { host: 'claudeai.chat' }
  if (token) headers.authorization = `Bearer ${token}`
  Object.assign(stream, {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  })
  return stream as unknown as IncomingMessage
}

function makeRes() {
  const out = {
    statusCode: 200,
    headers: {} as Record<string, string | number | string[]>,
    body: '',
    headersSent: false,
    writableEnded: false,
  }
  const res = new EventEmitter() as EventEmitter & ServerResponse
  Object.assign(res, {
    setHeader(name: string, value: string | number | string[]) {
      out.headers[name.toLowerCase()] = value
    },
    getHeader(name: string) {
      return out.headers[name.toLowerCase()]
    },
    writeHead(status: number, headers?: Record<string, string | number>) {
      out.statusCode = status
      out.headersSent = true
      if (headers) {
        for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = v
      }
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) out.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
      out.writableEnded = true
      out.headersSent = true
    },
  })
  Object.defineProperty(res, 'statusCode', {
    get() {
      return out.statusCode
    },
    set(v: number) {
      out.statusCode = v
    },
  })
  Object.defineProperty(res, 'headersSent', {
    get() {
      return out.headersSent
    },
  })
  Object.defineProperty(res, 'writableEnded', {
    get() {
      return out.writableEnded
    },
  })
  return { out, res: res as unknown as ServerResponse }
}

async function handlerFor(role: 'user' | 'admin' = 'user') {
  const { pool, queries } = fakePool(role)
  setPoolOverride(pool)
  const handler = createCommercialHandler({
    jwtSecret: JWT_SECRET,
    mailer: { async send() {} },
    redis: noopRedis(),
    turnstileBypass: true,
    refreshCookieSecure: false,
    v3Supervisor: { pool } as never,
    bridgeSecret: 'a'.repeat(64),
  })
  return { handler, queries }
}

describe('advisor consult commercial host deny', () => {
  test('consult is not a commercial proxy matcher for any method', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      assert.equal(matchContainerApiProxyRoute(CONSULT, method), false)
      assert.equal(matchBridgeApiAllowlist(CONSULT, method), null)
    }
  })

  test('ordinary user: all methods + query are 403 handled, no proxy, no host execute', async () => {
    const { handler, queries } = await handlerFor('user')
    const tok = (await signAccess({ sub: USER_ID, role: 'user' }, JWT_SECRET)).token
    const methods = ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']
    for (const method of methods) {
      for (const url of [CONSULT, `${CONSULT}?foo=1`]) {
        queries.length = 0
        const { out, res } = makeRes()
        const handled = await handler(makeReq(method, url, tok), res)
        assert.equal(handled, true, `${method} ${url} must be handled`)
        assert.equal(out.statusCode, 403, `${method} ${url} status=${out.statusCode} body=${out.body}`)
        if (method !== 'HEAD') {
          assert.match(out.body, /not available in commercial mode/)
        }
        assert.equal(
          queries.some((q) => q.sql.includes('agent_containers')),
          false,
          `${method} ${url} must not enter container proxy lookup`,
        )
      }
    }
    const { out, res } = makeRes()
    const handled = await handler(makeReq('OPTIONS', CONSULT, tok), res)
    if (handled) {
      assert.equal(out.statusCode, 403, `OPTIONS handled status=${out.statusCode}`)
    }
  })

  test('adjacent allowlisted routes still enter container proxy, not host deny', async () => {
    const { handler, queries } = await handlerFor('user')
    const tok = (await signAccess({ sub: USER_ID, role: 'user' }, JWT_SECRET)).token
    const cases = [
      { method: 'GET', url: '/api/agents' },
      { method: 'GET', url: '/api/agents/main' },
      { method: 'PUT', url: '/api/agents/main' },
      { method: 'GET', url: '/api/collaboration-config' },
      { method: 'PUT', url: '/api/collaboration-config' },
    ]
    for (const { method, url } of cases) {
      assert.equal(matchContainerApiProxyRoute(url, method), true, `${method} ${url} matcher`)
      queries.length = 0
      const { out, res } = makeRes()
      const handled = await handler(makeReq(method, url, tok), res)
      assert.equal(handled, true, `${method} ${url} handled`)
      assert.notEqual(out.statusCode, 403, `${method} ${url} must not be host-deny 403, got ${out.statusCode} ${out.body}`)
      assert.match(out.body, /CONTAINER_NOT_RUNNING/, `${method} ${url} body=${out.body}`)
      assert.equal(
        queries.some((q) => q.sql.includes('agent_containers')),
        true,
        `${method} ${url} must look up the caller container`,
      )
    }
  })

  test('missing or invalid token falls through to original auth, not a forced 403', async () => {
    const { handler } = await handlerFor('user')
    for (const token of [undefined, 'not.a.jwt', (await signAccess({ sub: USER_ID, role: 'user' }, 'w'.repeat(64))).token]) {
      const { out, res } = makeRes()
      const handled = await handler(makeReq('POST', CONSULT, token), res)
      assert.equal(handled, false, `token=${String(token).slice(0, 12)} must fall through`)
      assert.equal(out.body, '')
    }
  })

  test('admin JWT does not execute consult; it falls through after DB double-check', async () => {
    const { handler, queries } = await handlerFor('admin')
    const tok = (await signAccess({ sub: ADMIN_ID, role: 'admin' }, JWT_SECRET)).token
    queries.length = 0
    const { out, res } = makeRes()
    const handled = await handler(makeReq('POST', CONSULT, tok), res)
    assert.equal(handled, false, 'admin bypass must not treat consult as executed')
    assert.equal(out.body, '')
    assert.equal(
      queries.some((q) => q.sql.includes('FROM users') && q.sql.includes('SELECT role, status')),
      true,
      'admin must hit DB role/status double-check',
    )
  })
})
