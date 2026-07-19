import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { before, beforeEach, describe, test } from 'node:test'
import { type ClientSession, getActiveBackend, setClientSessionsBackend } from '@openclaude/storage'
import type { Pool } from 'pg'
import { signAccess } from '../../auth/jwt.js'
import { setPoolOverride } from '../../db/index.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { deriveMediaSignKey, verifySignedUrl } from '../mediaSign.js'
import { HttpError } from '../util.js'
import {
  handleAdminGetSession,
  handleAdminSignSessionMedia,
  parseAdminSessionRoute,
  parseArchivePagingParams,
} from './sessions.js'

const JWT_SECRET = 'admin-session-viewer-test-secret-that-is-long-enough-for-hs256'
const MEDIA_SIGN_KEY = deriveMediaSignKey('7'.repeat(64))
const HOT_MESSAGES = [
  { id: 'u-hot', role: 'user', text: '最新问题', ts: 20, _seq: 20 },
  { id: 'tape-thinking', role: 'thinking', text: '逐步分析', ts: 21, _seq: 21 },
  { id: 'tape-tool', role: 'tool', text: '', ts: 21, _seq: 21, toolName: 'Bash' },
  { id: 'tape-answer', role: 'assistant', text: '完整回答', ts: 21, _seq: 21 },
]
const SESSION: ClientSession = {
  id: 'web-1',
  userId: 'c:1',
  agentId: 'main',
  title: '会话一',
  pinned: false,
  createdAt: 10,
  lastAt: 21,
  updatedAt: 22,
  messages: HOT_MESSAGES,
  archivedCount: 2,
  archivedThroughSeq: 10,
}
const ARCHIVED_MESSAGES = [
  { id: 'old-1', role: 'user', text: '更早问题', ts: 1, _seq: 8 },
  { id: 'old-2', role: 'assistant', text: '更早回答', ts: 2, _seq: 9 },
]

let adminToken = ''
let auditAfter: unknown[] = []
let archiveCalls: unknown[][] = []

const fakePool = {
  async query(sql: string, params: unknown[] = []) {
    if (sql.includes('SELECT role, status FROM users')) {
      return { rows: [{ role: 'admin', status: 'active' }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO admin_audit')) {
      auditAfter.push(params[4] == null ? null : JSON.parse(String(params[4])))
      return { rows: [{ id: '1' }], rowCount: 1 }
    }
    throw new Error(`unexpected pool query: ${sql}`)
  },
  async end() {},
} as unknown as Pool

before(async () => {
  setPoolOverride(fakePool)
  const sqlite = getActiveBackend()
  setClientSessionsBackend({
    ...sqlite,
    getClientSession: async (sessionId: string, userId?: string) =>
      sessionId === SESSION.id && (!userId || userId === SESSION.userId) ? SESSION : null,
    readArchivedMessages: async (sessionId: string, userId: string, beforeSeq = 0, limit = 100) => {
      archiveCalls.push([sessionId, userId, beforeSeq, limit])
      if (sessionId !== SESSION.id || userId !== SESSION.userId) {
        return { messages: [], oldestSeq: null, hasMore: false }
      }
      return { messages: ARCHIVED_MESSAGES, oldestSeq: 8, hasMore: false }
    },
  })
  adminToken = (await signAccess({ sub: '99', role: 'admin' }, JWT_SECRET)).token
})

beforeEach(() => {
  auditAfter = []
  archiveCalls = []
})

function makeReq(method: 'GET' | 'POST', url: string, body?: unknown): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(stream, {
    method,
    url,
    headers: {
      host: 'admin.test',
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return stream as unknown as IncomingMessage
}

function makeRes(): { res: ServerResponse; read: () => { status: number; body: any } } {
  let status = 200
  let body = ''
  const headers = new Map<string, string | number | string[]>()
  const res = {
    get statusCode() {
      return status
    },
    set statusCode(value: number) {
      status = value
    },
    setHeader(name: string, value: string | number | string[]) {
      headers.set(name, value)
    },
    getHeader(name: string) {
      return headers.get(name)
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += chunk.toString()
    },
  } as unknown as ServerResponse
  return { res, read: () => ({ status, body: body ? JSON.parse(body) : null }) }
}

const ctx = {
  requestId: 'req-admin-session',
  clientIp: '127.0.0.1',
  authBoundIp: '127.0.0.1',
  userAgent: 'test',
  log: {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return this
    },
  },
} as unknown as RequestContext
const deps = { jwtSecret: JWT_SECRET, mediaSignKey: MEDIA_SIGN_KEY } as CommercialHttpDeps

describe('admin session route parsing', () => {
  test('区分 detail / archive / media-sign，拒绝额外路径', () => {
    assert.deepEqual(parseAdminSessionRoute(new URL('https://x/api/admin/sessions/web-1')), {
      sessionId: 'web-1',
      kind: 'detail',
    })
    assert.deepEqual(
      parseAdminSessionRoute(new URL('https://x/api/admin/sessions/web-1/archive')),
      { sessionId: 'web-1', kind: 'archive' },
    )
    assert.deepEqual(
      parseAdminSessionRoute(new URL('https://x/api/admin/sessions/web-1/media-sign')),
      { sessionId: 'web-1', kind: 'media-sign' },
    )
    assert.throws(
      () => parseAdminSessionRoute(new URL('https://x/api/admin/sessions/web-1/archive/extra')),
      (err) => err instanceof HttpError && err.status === 400 && err.code === 'VALIDATION',
    )
  })

  test('archive cursor 默认值与边界校验', () => {
    assert.deepEqual(parseArchivePagingParams(new URL('https://x/a')), {
      before: 0,
      limit: 100,
    })
    assert.deepEqual(parseArchivePagingParams(new URL('https://x/a?before=9&limit=200')), {
      before: 9,
      limit: 200,
    })
    for (const query of ['before=-1', 'before=1.5', 'limit=0', 'limit=201']) {
      assert.throws(
        () => parseArchivePagingParams(new URL(`https://x/a?${query}`)),
        (err) => err instanceof HttpError && err.status === 400,
      )
    }
  })
})

describe('admin session chat/archive/media handlers', () => {
  test('detail/archive 只接受 GET，media-sign 只接受 POST', async () => {
    for (const path of ['/api/admin/sessions/web-1', '/api/admin/sessions/web-1/archive']) {
      const out = makeRes()
      await assert.rejects(
        () => handleAdminSignSessionMedia(makeReq('POST', path), out.res, ctx, deps),
        (err) =>
          err instanceof HttpError && err.status === 405 && err.code === 'METHOD_NOT_ALLOWED',
      )
    }

    const out = makeRes()
    await assert.rejects(
      () =>
        handleAdminGetSession(
          makeReq('GET', '/api/admin/sessions/web-1/media-sign'),
          out.res,
          ctx,
          deps,
        ),
      (err) => err instanceof HttpError && err.status === 405 && err.code === 'METHOD_NOT_ALLOWED',
    )
  })

  test('timeline view 返回真实终态与 process cursor，不受 legacy limit 切片', async () => {
    const out = makeRes()
    await handleAdminGetSession(
      makeReq('GET', '/api/admin/sessions/web-1?user_id=1&view=timeline&limit=1'),
      out.res,
      ctx,
      deps,
    )
    const result = out.read()
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.session.messages, HOT_MESSAGES)
    assert.equal(result.body.session.archived_count, 2)
    assert.equal(result.body.session.archived_through_seq, 10)
    assert.equal(auditAfter.length, 1)
    assert.deepEqual(auditAfter[0], {
      mode: 'timeline',
      session_id: 'web-1',
      target_user_id: 'c:1',
      scoped_user_id: 'c:1',
      returned_messages: HOT_MESSAGES.length,
      archived_count: 2,
      request_id: 'req-admin-session',
    })
  })

  test('user_id scope 不匹配时 fail-closed 为 404', async () => {
    const out = makeRes()
    await assert.rejects(
      () =>
        handleAdminGetSession(
          makeReq('GET', '/api/admin/sessions/web-1?user_id=2&view=timeline'),
          out.res,
          ctx,
          deps,
        ),
      (err) => err instanceof HttpError && err.status === 404 && err.code === 'NOT_FOUND',
    )
    assert.equal(auditAfter.length, 0)
  })

  test('archive 用服务端 owner + _seq cursor 读取并返回升序页', async () => {
    const out = makeRes()
    await handleAdminGetSession(
      makeReq('GET', '/api/admin/sessions/web-1/archive?user_id=1&before=10&limit=2'),
      out.res,
      ctx,
      deps,
    )
    const result = out.read()
    assert.equal(result.status, 200)
    assert.deepEqual(archiveCalls, [['web-1', 'c:1', 10, 2]])
    assert.deepEqual(result.body, {
      session_id: 'web-1',
      messages: ARCHIVED_MESSAGES,
      oldest_seq: 8,
      has_more: false,
    })
  })

  test('media-sign 从 storage 权威 session 派生 owner，且审计不落媒体路径', async () => {
    const out = makeRes()
    const mediaPath = '/api/media/photo.png?legacy=1'
    await handleAdminSignSessionMedia(
      makeReq('POST', '/api/admin/sessions/web-1/media-sign', {
        paths: [mediaPath, '/home/agent/.openclaude/uploads/report.pdf', '/etc/passwd'],
      }),
      out.res,
      ctx,
      deps,
    )
    const result = out.read()
    assert.equal(result.status, 200)
    assert.equal(Object.keys(result.body.urls).length, 2)
    assert.equal(result.body.urls['/etc/passwd'], undefined)

    for (const signedUrl of Object.values(result.body.urls) as string[]) {
      const token = new URL(signedUrl, 'https://x').searchParams.get('t')
      const verified = verifySignedUrl(MEDIA_SIGN_KEY, { t: token })
      assert.equal(verified.kind, 'ok')
      if (verified.kind === 'ok') assert.equal(verified.userId, 'c:1')
    }
    const audit = auditAfter.at(-1) as Record<string, unknown>
    assert.equal(audit.target_user_id, 'c:1')
    assert.equal(audit.requested_paths, 3)
    assert.equal(audit.signed_paths, 2)
    assert.ok(!JSON.stringify(audit).includes('photo.png'))
    assert.ok(!JSON.stringify(audit).includes('/home/agent'))
  })
})
