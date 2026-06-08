import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'
import type { Pool } from 'pg'

const home = await mkdtemp(join(tmpdir(), 'oc-wechat-live-'))
process.env.OPENCLAUDE_HOME = home

const [{ createCommercialHandler }, liveShare, storage] = await Promise.all([
  import('../router.js'),
  import('../../wechat/liveShare.js'),
  import('@openclaude/storage'),
])

const KEY = liveShare.deriveWechatLiveLinkKey('c'.repeat(64))
const SESSION_ID = 'wsess-0123456789abcdef'
const USER_ID = 'c:42'
const NOW = 1_700_000_000_000

interface PoolCall {
  sql: string
  params: unknown[]
}

function makePool(activeSubs: Set<string>): { pool: Pool; calls: PoolCall[] } {
  const calls: PoolCall[] = []
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] })
      if (/FROM users/i.test(sql) && /status = 'active'/i.test(sql)) {
        const sub = String(params?.[0] ?? '')
        if (activeSubs.has(sub)) {
          return { rowCount: 1, rows: [{ id: sub, role: 'user' }] }
        }
        return { rowCount: 0, rows: [] }
      }
      throw new Error(`makePool: unexpected SQL: ${sql.slice(0, 160)}`)
    },
  } as unknown as Pool
  return { pool, calls }
}

function makeDeps(activeSubs = new Set(['42'])): { deps: unknown; poolCalls: PoolCall[] } {
  const { pool, calls } = makePool(activeSubs)
  return {
    deps: {
      jwtSecret: 'test_jwt_secret_that_is_long_enough_for_hs256_at_least_32_bytes',
      mailer: {},
      redis: {},
      wechatLiveLinkKey: KEY,
      v3Supervisor: { pool },
    },
    poolCalls: calls,
  }
}

function makeToken(
  opts: {
    sessionId?: string
    userId?: string
    ttlMs?: number
    nowMs?: number
  } = {},
): string {
  return liveShare.buildWechatLiveToken(KEY, {
    sessionId: opts.sessionId ?? SESSION_ID,
    userId: opts.userId ?? USER_ID,
    nowMs: opts.nowMs ?? Date.now(),
    ttlMs: opts.ttlMs ?? 60_000,
  }).token
}

function makeReq(method: string, url: string): IncomingMessage {
  const stream = Readable.from([])
  Object.assign(stream, {
    method,
    url,
    headers: { host: 'claudeai.chat' },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return stream as unknown as IncomingMessage
}

interface FakeRes {
  statusCode: number
  headers: Record<string, string | number | string[]>
  body: string
  res: ServerResponse
}

function makeRes(): FakeRes {
  const out: FakeRes = {
    statusCode: 200,
    headers: {},
    body: '',
    res: null as unknown as ServerResponse,
  }
  const res = {
    headersSent: false,
    setHeader(name: string, value: string | number | string[]) {
      out.headers[name.toLowerCase()] = value
    },
    getHeader(name: string) {
      return out.headers[name.toLowerCase()]
    },
    writeHead(
      this: { headersSent: boolean },
      status: number,
      headers?: Record<string, string | number>,
    ) {
      out.statusCode = status
      if (headers) {
        for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = v
      }
      this.headersSent = true
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) out.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
      out.statusCode = (this as unknown as { statusCode: number }).statusCode
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

async function call(method: string, url: string, activeSubs = new Set(['42'])) {
  const { deps, poolCalls } = makeDeps(activeSubs)
  const handler = createCommercialHandler(deps as Parameters<typeof createCommercialHandler>[0])
  const out = makeRes()
  const handled = await handler(makeReq(method, url), out.res)
  return { handled, out, poolCalls }
}

function parseJson(out: FakeRes): unknown {
  return JSON.parse(out.body)
}

async function seedSession(sessionId = SESSION_ID, userId = USER_ID): Promise<number> {
  await storage.upsertMasterClientSession({
    sessionId,
    userId,
    agentId: 'main',
    originChannel: 'wechat',
    title: '微信实时任务',
    createdAt: NOW,
    lastAt: NOW,
  })
  const updatedAt = NOW + Math.floor(Math.random() * 1000) + 100
  const db = await storage.getSessionsDb()
  db.prepare(
    'UPDATE client_sessions SET messages = ?, message_count = ?, updated_at = ?, last_at = ? WHERE id = ? AND user_id = ?',
  ).run(
    JSON.stringify([
      { id: 'u1', role: 'user', text: '用户问题', ts: NOW },
      { id: 'a1', role: 'assistant', text: '处理结果', ts: NOW + 1 },
    ]),
    2,
    updatedAt,
    updatedAt,
    sessionId,
    userId,
  )
  return updatedAt
}

describe('wechat live public page', () => {
  test('GET /wx/live is owned by commercial router and overrides CSP for nonce JS', async () => {
    const { handled, out } = await call('GET', `/wx/live?t=${makeToken()}`)
    assert.equal(handled, true)
    assert.equal(out.statusCode, 200)
    assert.equal(out.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(out.headers['cache-control'], 'no-store')
    assert.match(
      String(out.headers['content-security-policy']),
      /script-src 'nonce-[A-Za-z0-9_-]+'/,
    )
    assert.match(String(out.headers['content-security-policy']), /connect-src 'self'/)
    assert.match(out.body, /OpenClaude 微信实时过程/)
  })

  test('POST /wx/live returns router-managed 405', async () => {
    const { handled, out } = await call('POST', '/wx/live')
    assert.equal(handled, true)
    assert.equal(out.statusCode, 405)
  })

  test('GET /wx/live rejects missing or duplicate bearer token before serving HTML', async () => {
    assert.equal((await call('GET', '/wx/live')).out.statusCode, 400)
    const token = makeToken()
    assert.equal((await call('GET', `/wx/live?t=${token}&t=${token}`)).out.statusCode, 400)
    assert.equal((await call('GET', `/wx/live?%74=${token}&t=junk`)).out.statusCode, 400)
  })
})

describe('gateway-owned wechat binding routes', () => {
  test('binding and pairing API fall through to gateway instead of commercial 404', async () => {
    for (const [method, path] of [
      ['GET', '/api/wechat/binding'],
      ['POST', '/api/wechat/pair/start'],
    ] as const) {
      const { handled, out } = await call(method, path)
      assert.equal(handled, false, `${method} ${path} should be handled by gateway`)
      assert.equal(out.body, '')
    }
  })
})

describe('wechat live snapshot API', () => {
  test('valid token strips c: for active DB check and returns sanitized messages', async () => {
    await seedSession()
    const token = makeToken()
    const { handled, out, poolCalls } = await call('GET', `/api/wechat/live?t=${token}`)
    assert.equal(handled, true)
    assert.equal(out.statusCode, 200)
    assert.equal(poolCalls[0]!.params[0], '42')
    const body = parseJson(out) as { sessionId: string; messages: Array<{ text: string }> }
    assert.equal(body.sessionId, SESSION_ID)
    assert.deepEqual(
      body.messages.map((m) => m.text),
      ['用户问题', '处理结果'],
    )
  })

  test('tool messages are redacted to event cards', async () => {
    const sessionId = 'wsess-deadbeefcafebabe'
    await storage.upsertMasterClientSession({
      sessionId,
      userId: USER_ID,
      agentId: 'main',
      originChannel: 'wechat',
      title: '微信实时任务',
      createdAt: NOW,
      lastAt: NOW,
    })
    const db = await storage.getSessionsDb()
    db.prepare(
      'UPDATE client_sessions SET messages = ?, message_count = ?, updated_at = ?, last_at = ? WHERE id = ? AND user_id = ?',
    ).run(
      JSON.stringify([
        { id: 'u1', role: 'user', text: '帮我查一下', ts: NOW },
        {
          id: 't1',
          role: 'tool',
          name: 'web_fetch',
          content: [{ input: 'secret token', output: 'private result' }],
          ts: NOW + 1,
        },
        { id: 'a1', role: 'assistant', text: '完成', ts: NOW + 2 },
      ]),
      3,
      NOW + 10,
      NOW + 10,
      sessionId,
      USER_ID,
    )
    const token = makeToken({ sessionId })
    const { out } = await call('GET', `/api/wechat/live?t=${token}`)
    assert.equal(out.statusCode, 200)
    const body = parseJson(out) as { messages: Array<{ role: string; text: string; toolName?: string }> }
    assert.equal(body.messages[1]!.role, 'event')
    assert.equal(body.messages[1]!.toolName, 'web_fetch')
    assert.match(body.messages[1]!.text, /工具调用细节已隐藏/)
    assert.ok(!JSON.stringify(body).includes('secret token'))
    assert.ok(!JSON.stringify(body).includes('private result'))
  })

  test('assistant messages with tool payload are redacted and never JSON-stringified', async () => {
    const sessionId = 'wsess-3333333333333333'
    await storage.upsertMasterClientSession({
      sessionId,
      userId: USER_ID,
      agentId: 'main',
      originChannel: 'wechat',
      title: '微信实时任务',
      createdAt: NOW,
      lastAt: NOW,
    })
    const db = await storage.getSessionsDb()
    db.prepare(
      'UPDATE client_sessions SET messages = ?, message_count = ?, updated_at = ?, last_at = ? WHERE id = ? AND user_id = ?',
    ).run(
      JSON.stringify([
        { id: 'u1', role: 'user', text: '继续', ts: NOW },
        {
          id: 'a-tool',
          role: 'assistant',
          tool_calls: [{ function: { name: 'secret_tool', arguments: '{\"apiKey\":\"sk-secret\"}' } }],
          content: [{ kind: 'tool_result', output: 'private output' }],
          ts: NOW + 1,
        },
      ]),
      2,
      NOW + 11,
      NOW + 11,
      sessionId,
      USER_ID,
    )
    const token = makeToken({ sessionId })
    const { out } = await call('GET', `/api/wechat/live?t=${token}`)
    assert.equal(out.statusCode, 200)
    const body = parseJson(out) as { messages: Array<{ role: string; text: string }> }
    assert.equal(body.messages[1]!.role, 'event')
    assert.match(body.messages[1]!.text, /工具调用细节已隐藏/)
    const json = JSON.stringify(body)
    assert.ok(!json.includes('sk-secret'))
    assert.ok(!json.includes('private output'))
    assert.ok(!json.includes('tool_calls'))
  })

  test('since equal to updatedAt returns unchanged', async () => {
    const updatedAt = await seedSession('wsess-fedcba9876543210', USER_ID)
    const token = makeToken({ sessionId: 'wsess-fedcba9876543210' })
    const { out } = await call('GET', `/api/wechat/live?t=${token}&since=${updatedAt}`)
    assert.equal(out.statusCode, 200)
    assert.deepEqual(parseJson(out), { unchanged: true, updatedAt })
  })

  test('inactive user is forbidden', async () => {
    await seedSession('wsess-1111111111111111', USER_ID)
    const token = makeToken({ sessionId: 'wsess-1111111111111111' })
    const { out } = await call('GET', `/api/wechat/live?t=${token}`, new Set())
    assert.equal(out.statusCode, 403)
  })

  test('wrong session is not found', async () => {
    const token = makeToken({ sessionId: 'wsess-2222222222222222' })
    const { out } = await call('GET', `/api/wechat/live?t=${token}`)
    assert.equal(out.statusCode, 404)
  })

  test('missing, duplicate, bad and expired tokens map to stable errors', async () => {
    assert.equal((await call('GET', '/api/wechat/live')).out.statusCode, 400)
    const token = makeToken()
    assert.equal((await call('GET', `/api/wechat/live?t=${token}&t=${token}`)).out.statusCode, 400)
    assert.equal((await call('GET', `/api/wechat/live?%74=${token}&t=junk`)).out.statusCode, 400)
    assert.equal((await call('GET', '/api/wechat/live?t=bad.token')).out.statusCode, 403)
    const expired = makeToken({ nowMs: NOW, ttlMs: 1 })
    assert.equal((await call('GET', `/api/wechat/live?t=${expired}`)).out.statusCode, 410)
  })
})
