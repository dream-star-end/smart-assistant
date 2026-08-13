import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import { matchCommercialContainerApiProxy } from '@openclaude/gateway'
import { signAccess } from '../auth/jwt.js'
import { createCommercialHandler } from '../http/router.js'
import { readBlockedForUserPatterns } from './helpers/containerRouteInventory.js'

const JWT_SECRET = 'z'.repeat(64)

function makePool(role: 'user' | 'admin'): Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (/FROM users/i.test(sql)) {
        return { rowCount: 1, rows: [{ id: String(params?.[0] ?? '1'), role }] }
      }
      return { rowCount: 0, rows: [] }
    },
  } as unknown as Pool
}

function makeReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): IncomingMessage {
  const stream = Readable.from([])
  Object.assign(stream, {
    method,
    url,
    headers: { host: 'claudeai.chat', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return stream as unknown as IncomingMessage
}

function makeRes(): { statusCode: number; body: string; res: ServerResponse } {
  const out = { statusCode: 200, body: '', res: null as unknown as ServerResponse }
  let headersSent = false
  const res = {
    get headersSent() {
      return headersSent
    },
    setHeader() {},
    getHeader() {
      return undefined
    },
    writeHead(status: number) {
      out.statusCode = status
      headersSent = true
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) out.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    },
  } as unknown as ServerResponse
  Object.defineProperty(res, 'statusCode', {
    get() {
      return out.statusCode
    },
    set(v: number) {
      out.statusCode = v
    },
  })
  out.res = res
  return out
}

const noopRedis = {
  get: async () => null,
  set: async () => 'OK',
  incr: async () => 1,
  expire: async () => 1,
  del: async () => 1,
} as never

describe('workspace inspect commercial routes', () => {
  it('allowlist: GET proxyable, POST not', () => {
    assert.ok(matchCommercialContainerApiProxy('/api/workspace/git-snapshot', 'GET'))
    assert.ok(matchCommercialContainerApiProxy('/api/workspace/list-dir', 'GET'))
    assert.equal(matchCommercialContainerApiProxy('/api/workspace/git-snapshot', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/workspace/list-dir', 'POST'), null)
  })

  it('BLOCKED_FOR_USER_RULES covers both inspect paths', async () => {
    const patterns = await readBlockedForUserPatterns()
    assert.ok(patterns.some((re) => re.test('/api/workspace/git-snapshot')))
    assert.ok(patterns.some((re) => re.test('/api/workspace/list-dir')))
  })

  it('admin + host-scope is 403 HOST_FORBIDDEN even without proxy deps', async () => {
    const handler = createCommercialHandler({
      jwtSecret: JWT_SECRET,
      mailer: { async send() {} },
      redis: noopRedis,
    })
    const { token } = await signAccess({ sub: '1', role: 'admin' }, JWT_SECRET)
    let hostHits = 0
    const out = makeRes()
    const handled = await handler(
      makeReq('GET', '/api/workspace/git-snapshot?sessionId=s1', {
        authorization: `Bearer ${token}`,
        'x-oc-host-scope': '1',
      }),
      out.res,
    )
    if (!handled) hostHits++
    assert.equal(handled, true)
    assert.equal(hostHits, 0)
    assert.equal(out.statusCode, 403)
    assert.ok(out.body.includes('HOST_FORBIDDEN'))
  })

  it('user and admin without host-scope enter container proxy (not host handler)', async () => {
    for (const role of ['user', 'admin'] as const) {
      const handler = createCommercialHandler({
        jwtSecret: JWT_SECRET,
        mailer: { async send() {} },
        redis: noopRedis,
        v3Supervisor: { pool: makePool(role), selfHostId: 'h1' } as never,
        bridgeSecret: 'b'.repeat(64),
      })
      const { token } = await signAccess({ sub: '42', role }, JWT_SECRET)
      let hostHits = 0
      const out = makeRes()
      const handled = await handler(
        makeReq('GET', '/api/workspace/list-dir?sessionId=s1', {
          authorization: `Bearer ${token}`,
        }),
        out.res,
      )
      if (!handled) hostHits++
      assert.equal(handled, true, role)
      assert.equal(hostHits, 0, role)
      assert.equal(out.body.includes('HOST_FORBIDDEN'), false, role)
    }
  })
})
