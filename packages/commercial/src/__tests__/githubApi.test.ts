/**
 * `/api/me/github*` + `/api/me/sessions/:sid/github-selection` 单元测试。
 *
 * 7 handlers × 关键路径:
 *   - GET    /api/me/github                                — public link 元
 *   - DELETE /api/me/github                                — revoke + cascade
 *   - GET    /api/me/github/repos                          — list repos
 *   - GET    /api/me/github/repos/:owner/:repo/branches    — list branches
 *   - GET    /api/me/sessions/:sid/github-selection        — read selection
 *   - PUT    /api/me/sessions/:sid/github-selection        — set selection
 *   - DELETE /api/me/sessions/:sid/github-selection        — clear selection
 *
 * 注入 GithubApiHandlerOverrides:
 *   - poolFactory:fake pg.Pool(query/connect 录用)
 *   - githubFetch:fake fetch(返预设 status + JSON / 抛 network err)
 *
 * 不打真 GitHub / 真 DB / 真 KMS(用 OPENCLAUDE_KMS_KEY env 注入 32-byte 全 0xab key 解密)。
 */

import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { before, describe, test } from 'node:test'
import { SignJWT } from 'jose'
import type { Pool, PoolClient } from 'pg'
import { encrypt } from '../crypto/aead.js'
import type { CommercialHttpDeps, RequestContext } from '../http/handlers.js'
import {
  handleDeleteMyGithub,
  handleDeleteSessionGithubSelection,
  handleGetMyGithub,
  handleGetSessionGithubSelection,
  handleListMyGithubBranches,
  handleListMyGithubRepos,
  handlePutSessionGithubSelection,
} from '../http/githubApi.js'

// ─── KMS key for getGithubLinkWithToken decrypt ────────────────────────
const TEST_KMS_KEY = Buffer.alloc(32, 0xab)

before(() => {
  process.env.OPENCLAUDE_KMS_KEY = TEST_KMS_KEY.toString('base64')
})

// ─── JWT helper ────────────────────────────────────────────────────────
const TEST_SECRET = 'test_jwt_secret_that_is_long_enough_for_hs256_at_least_32_bytes'
async function signUserJwt(userId: string): Promise<string> {
  return new SignJWT({ sub: userId, role: 'user', jti: 'test-jti' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(TEST_SECRET))
}

// ─── Fake req/res helpers ──────────────────────────────────────────────

interface FakeRes {
  statusCode: number
  headers: Record<string, string | string[] | number>
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
    statusCode: 200,
    setHeader(name: string, value: string | string[] | number) {
      out.headers[name] = value
    },
    getHeader(name: string) {
      return out.headers[name]
    },
    end(chunk?: string) {
      if (chunk) out.body = chunk
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

function makeReq(opts: {
  method?: string
  url?: string
  authorization?: string
  body?: string | object
}): IncomingMessage {
  const bodyStr =
    typeof opts.body === 'string'
      ? opts.body
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : ''
  // 用 Readable.from() 把 body 串成 async iterable,readRawBody 才能 for-await 读出来
  const stream = Readable.from(bodyStr ? [Buffer.from(bodyStr, 'utf8')] : [])
  // 在 stream 上叠加 IncomingMessage 形状的字段
  Object.assign(stream, {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    headers: {
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
      host: 'test.example',
    },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return stream as unknown as IncomingMessage
}

function makeCtx(): RequestContext {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  } as unknown as RequestContext['log']
  return {
    requestId: 'test-req',
    clientIp: '127.0.0.1',
    authBoundIp: '127.0.0.1',
    userAgent: 'test',
    log,
  }
}

function makeDeps(): CommercialHttpDeps {
  return {
    jwtSecret: TEST_SECRET,
    mailer: {} as CommercialHttpDeps['mailer'],
    redis: {} as CommercialHttpDeps['redis'],
    refreshCookieSecure: false,
  } as CommercialHttpDeps
}

// ─── Pool helpers ──────────────────────────────────────────────────────

interface QueryCall {
  sql: string
  params: unknown[]
}

interface MockResp {
  rowCount: number
  rows: Record<string, unknown>[]
}

/**
 * Configurable mock pg.Pool。
 *   - `defaultRows`: 不显式 hook 时所有 query 返回该值
 *   - `hook`: SQL pattern → 返回结果(同步;先匹配先用)
 *   - 模拟 BEGIN/COMMIT 走 client.connect():client 也走同一 hook
 */
function makePool(opts: {
  hook?: (sql: string, params: unknown[]) => MockResp | Error | undefined
  defaultRows?: MockResp
}): { pool: Pool; calls: QueryCall[]; clientCalls: QueryCall[] } {
  const calls: QueryCall[] = []
  const clientCalls: QueryCall[] = []
  const exec = (
    sql: string,
    params: unknown[],
    log: QueryCall[],
  ): MockResp | Promise<MockResp> => {
    log.push({ sql, params })
    if (opts.hook) {
      const r = opts.hook(sql, params)
      if (r instanceof Error) throw r
      if (r !== undefined) return r
    }
    return opts.defaultRows ?? { rowCount: 0, rows: [] }
  }
  const pool = {
    query: (sql: string, params?: unknown[]) => {
      try {
        const r = exec(sql, params ?? [], calls)
        return Promise.resolve(r)
      } catch (e) {
        return Promise.reject(e)
      }
    },
    connect: async (): Promise<PoolClient> => {
      return {
        query: (sql: string, params?: unknown[]) => {
          try {
            // BEGIN/COMMIT/ROLLBACK 直接通过
            if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
              clientCalls.push({ sql, params: params ?? [] })
              return Promise.resolve({ rowCount: 0, rows: [] })
            }
            const r = exec(sql, params ?? [], clientCalls)
            return Promise.resolve(r)
          } catch (e) {
            return Promise.reject(e)
          }
        },
        release: () => {},
      } as unknown as PoolClient
    },
  } as unknown as Pool
  return { pool, calls, clientCalls }
}

// ─── 共用 fixtures ─────────────────────────────────────────────────────

function rawLinkRow(token: string): Record<string, unknown> {
  const { ciphertext, nonce } = encrypt(token, TEST_KMS_KEY)
  return {
    user_id: '7',
    github_user_id: '12345',
    login: 'octocat',
    avatar_url: null,
    access_token_enc: ciphertext,
    access_token_nonce: nonce,
    scopes: 'repo read:user',
    revoked_at: null,
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// ─── GET /api/me/github ────────────────────────────────────────────────

describe('handleGetMyGithub', () => {
  test('returns linked:true with public fields when row exists', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({ url: '/api/me/github', authorization: `Bearer ${token}` })
    const fakeRes = makeRes()

    const { pool } = makePool({
      defaultRows: {
        rowCount: 1,
        rows: [{ login: 'octocat', avatar_url: null, scopes: 'repo' }],
      },
    })

    await handleGetMyGithub(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
    })
    assert.equal(fakeRes.statusCode, 200)
    const body = JSON.parse(fakeRes.body)
    assert.equal(body.linked, true)
    assert.equal(body.login, 'octocat')
    assert.equal(body.scopes, 'repo')
    assert.equal('accessToken' in body, false)
  })

  test('returns linked:false when no row', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({ url: '/api/me/github', authorization: `Bearer ${token}` })
    const fakeRes = makeRes()
    const { pool } = makePool({ defaultRows: { rowCount: 0, rows: [] } })
    await handleGetMyGithub(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
    })
    assert.equal(fakeRes.statusCode, 200)
    assert.deepEqual(JSON.parse(fakeRes.body), { linked: false })
  })

  test('no auth → 401', async () => {
    const req = makeReq({ url: '/api/me/github' })
    const fakeRes = makeRes()
    await assert.rejects(
      handleGetMyGithub(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => ({}) as unknown as Pool,
      }),
      (err: unknown) => err instanceof Error && (err as { status?: number }).status === 401,
    )
  })
})

// ─── DELETE /api/me/github ─────────────────────────────────────────────

describe('handleDeleteMyGithub', () => {
  test('cascades: revoke link + clear sessions in one transaction', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      method: 'DELETE',
      url: '/api/me/github',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()

    const { pool, clientCalls } = makePool({
      hook: (sql) => {
        if (/UPDATE github_links/.test(sql)) return { rowCount: 1, rows: [] }
        if (/UPDATE github_session_workspaces/.test(sql)) {
          return { rowCount: 3, rows: [] }
        }
        return undefined
      },
    })
    await handleDeleteMyGithub(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
    })
    assert.equal(fakeRes.statusCode, 200)
    const body = JSON.parse(fakeRes.body)
    assert.equal(body.revoked, true)
    assert.equal(body.sessionsCleared, 3)
    // 必须走 BEGIN+COMMIT 事务
    assert.ok(clientCalls.some((c) => /^BEGIN/i.test(c.sql)), 'must BEGIN')
    assert.ok(clientCalls.some((c) => /^COMMIT/i.test(c.sql)), 'must COMMIT')
    // error_code = 'user_revoked'
    const updateSession = clientCalls.find((c) => /UPDATE github_session_workspaces/.test(c.sql))
    assert.ok(updateSession, 'must UPDATE github_session_workspaces')
    assert.equal(updateSession.params[1], 'user_revoked')
  })
})

// ─── GET /api/me/github/repos ──────────────────────────────────────────

describe('handleListMyGithubRepos', () => {
  test('happy path: returns repo list, validates query, calls GitHub', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: '/api/me/github/repos?type=owner&page=2&per_page=50&sort=updated',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()

    const { pool } = makePool({
      hook: (sql) => {
        if (/SELECT user_id::text AS user_id/.test(sql)) {
          return { rowCount: 1, rows: [rawLinkRow('ghp_token')] }
        }
        return undefined
      },
    })

    let capturedUrl = ''
    let capturedAuth = ''
    const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input)
      const headers = new Headers(init?.headers ?? {})
      capturedAuth = headers.get('authorization') ?? ''
      return jsonResponse(200, [
        {
          id: 1,
          name: 'demo',
          full_name: 'octocat/demo',
          owner: { login: 'octocat', avatar_url: 'https://a/u' },
          private: false,
          default_branch: 'main',
          description: null,
          language: 'TS',
          stargazers_count: 0,
          updated_at: '2026-01-01T00:00:00Z',
          html_url: 'https://github.com/octocat/demo',
        },
      ])
    }

    await handleListMyGithubRepos(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
      githubFetch: fetchFn as typeof fetch,
    })
    assert.equal(fakeRes.statusCode, 200)
    const body = JSON.parse(fakeRes.body)
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].full_name, 'octocat/demo')
    assert.equal(body.page, 2)
    assert.equal(body.per_page, 50)
    // 'owner' 走 type=owner,不传 affiliation
    assert.match(capturedUrl, /type=owner/)
    assert.equal(/affiliation=/.test(capturedUrl), false)
    assert.match(capturedUrl, /sort=updated/)
    assert.match(capturedUrl, /page=2/)
    assert.match(capturedUrl, /per_page=50/)
    assert.equal(capturedAuth, 'Bearer ghp_token')
  })

  test("scope='all' uses affiliation, not type=all (GitHub 422)", async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: '/api/me/github/repos?type=all',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    const { pool } = makePool({
      hook: (sql) => {
        if (/SELECT user_id::text AS user_id/.test(sql)) {
          return { rowCount: 1, rows: [rawLinkRow('ghp_token')] }
        }
        return undefined
      },
    })
    let capturedUrl = ''
    const fetchFn = async (input: string | URL | Request) => {
      capturedUrl = String(input)
      return jsonResponse(200, [])
    }
    await handleListMyGithubRepos(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
      githubFetch: fetchFn as typeof fetch,
    })
    assert.equal(fakeRes.statusCode, 200)
    assert.match(capturedUrl, /affiliation=owner%2Ccollaborator%2Corganization_member/)
    assert.equal(/[?&]type=/.test(capturedUrl), false)
  })

  test('no GitHub link → 401 GITHUB_NOT_LINKED', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({ url: '/api/me/github/repos', authorization: `Bearer ${token}` })
    const fakeRes = makeRes()
    const { pool } = makePool({ defaultRows: { rowCount: 0, rows: [] } })
    await assert.rejects(
      handleListMyGithubRepos(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => pool,
        githubFetch: (async () => jsonResponse(200, [])) as typeof fetch,
      }),
      (err: unknown) =>
        err instanceof Error &&
        (err as { code?: string }).code === 'GITHUB_NOT_LINKED' &&
        (err as { status?: number }).status === 401,
    )
  })

  test('GitHub 401 → cascade revoke + 401 GITHUB_TOKEN_INVALID', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({ url: '/api/me/github/repos', authorization: `Bearer ${token}` })
    const fakeRes = makeRes()
    let revokeRan = false
    const { pool } = makePool({
      hook: (sql) => {
        if (/SELECT user_id::text AS user_id/.test(sql)) {
          return { rowCount: 1, rows: [rawLinkRow('ghp_token')] }
        }
        if (/UPDATE github_links/.test(sql)) {
          revokeRan = true
          return { rowCount: 1, rows: [] }
        }
        if (/UPDATE github_session_workspaces/.test(sql)) {
          return { rowCount: 0, rows: [] }
        }
        return undefined
      },
    })
    const fetchFn = async () =>
      new Response('{"message":"bad credentials"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    await assert.rejects(
      handleListMyGithubRepos(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => pool,
        githubFetch: fetchFn as typeof fetch,
      }),
      (err: unknown) =>
        err instanceof Error &&
        (err as { code?: string }).code === 'GITHUB_TOKEN_INVALID' &&
        (err as { status?: number }).status === 401,
    )
    assert.ok(revokeRan, 'must auto-revoke on token_invalid')
  })

  test('GitHub 401 + revoke fails → 503 GITHUB_TOKEN_REVOKE_FAILED (no auth oracle)', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({ url: '/api/me/github/repos', authorization: `Bearer ${token}` })
    const fakeRes = makeRes()
    // 注意:revoke 走 client.connect(),所以 connect() 后 client.query BEGIN 抛错
    const fakePool = {
      query: (sql: string, _params?: unknown[]) => {
        if (/SELECT user_id::text AS user_id/.test(sql)) {
          return Promise.resolve({ rowCount: 1, rows: [rawLinkRow('ghp_token')] })
        }
        return Promise.resolve({ rowCount: 0, rows: [] })
      },
      connect: async () =>
        ({
          query: () => Promise.reject(new Error('db down')),
          release: () => {},
        }) as unknown as PoolClient,
    } as unknown as Pool
    const fetchFn = async () =>
      new Response('{"message":"bad credentials"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    await assert.rejects(
      handleListMyGithubRepos(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => fakePool,
        githubFetch: fetchFn as typeof fetch,
      }),
      (err: unknown) => {
        if (!(err instanceof Error)) return false
        const e = err as { code?: string; status?: number; extraHeaders?: Record<string, unknown> }
        return (
          e.code === 'GITHUB_TOKEN_REVOKE_FAILED' &&
          e.status === 503 &&
          // 锁定前端 retry contract:Retry-After 必须保留
          e.extraHeaders?.['Retry-After'] === '5'
        )
      },
    )
  })

  test('invalid sort → 400 INVALID_SORT', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: '/api/me/github/repos?sort=stargazers',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    await assert.rejects(
      handleListMyGithubRepos(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => ({}) as unknown as Pool,
      }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'INVALID_SORT',
    )
  })

  test('per_page > 100 → 400 INVALID_QUERY', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: '/api/me/github/repos?per_page=500',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    await assert.rejects(
      handleListMyGithubRepos(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => ({}) as unknown as Pool,
      }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'INVALID_QUERY',
    )
  })
})

// ─── GET /api/me/github/repos/:owner/:repo/branches ────────────────────

describe('handleListMyGithubBranches', () => {
  test('happy path: returns branches with sha + protected', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: '/api/me/github/repos/octocat/demo/branches',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    const { pool } = makePool({
      hook: (sql) => {
        if (/SELECT user_id::text AS user_id/.test(sql)) {
          return { rowCount: 1, rows: [rawLinkRow('ghp_token')] }
        }
        return undefined
      },
    })
    let capturedUrl = ''
    const fetchFn = async (input: string | URL | Request) => {
      capturedUrl = String(input)
      return jsonResponse(200, [
        { name: 'main', commit: { sha: 'sha-main' }, protected: true },
        { name: 'feature/x', commit: { sha: 'sha-fx' }, protected: false },
      ])
    }
    await handleListMyGithubBranches(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
      githubFetch: fetchFn as typeof fetch,
    })
    assert.equal(fakeRes.statusCode, 200)
    const body = JSON.parse(fakeRes.body)
    assert.equal(body.items.length, 2)
    assert.equal(body.items[0].name, 'main')
    assert.equal(body.items[0].commit.sha, 'sha-main')
    assert.match(capturedUrl, /\/repos\/octocat\/demo\/branches/)
  })

  test('invalid owner → 400 INVALID_OWNER', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: '/api/me/github/repos/bad%20owner/demo/branches',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    await assert.rejects(
      handleListMyGithubBranches(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => ({}) as unknown as Pool,
      }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'INVALID_OWNER',
    )
  })

  test('GitHub 404 → 404 GITHUB_NOT_FOUND', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: '/api/me/github/repos/octocat/missing/branches',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    const { pool } = makePool({
      hook: (sql) => {
        if (/SELECT user_id::text AS user_id/.test(sql)) {
          return { rowCount: 1, rows: [rawLinkRow('ghp_token')] }
        }
        return undefined
      },
    })
    const fetchFn = async () =>
      new Response('{"message":"not found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    await assert.rejects(
      handleListMyGithubBranches(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => pool,
        githubFetch: fetchFn as typeof fetch,
      }),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === 'GITHUB_NOT_FOUND',
    )
  })
})

// ─── GET /api/me/sessions/:sid/github-selection ────────────────────────

const SESSION_ID = 'sess_abcdef12'

describe('handleGetSessionGithubSelection', () => {
  test('returns selected:false when no row', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    const { pool } = makePool({ defaultRows: { rowCount: 0, rows: [] } })
    await handleGetSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
    })
    assert.equal(fakeRes.statusCode, 200)
    assert.deepEqual(JSON.parse(fakeRes.body), { selected: false })
  })

  test("status='cleared' → selected:false + last_error_*", async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    const { pool } = makePool({
      defaultRows: {
        rowCount: 1,
        rows: [
          {
            user_id: '7',
            session_id: SESSION_ID,
            selection_version: '5',
            owner: 'octocat',
            repo: 'demo',
            branch: 'main',
            default_branch: 'main',
            status: 'cleared',
            head_sha: null,
            error_code: 'link_revoked',
            error_message: null,
            selected_at: new Date(),
            updated_at: new Date(),
          },
        ],
      },
    })
    await handleGetSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
    })
    assert.equal(fakeRes.statusCode, 200)
    const body = JSON.parse(fakeRes.body)
    assert.equal(body.selected, false)
    assert.equal(body.last_error_code, 'link_revoked')
  })

  test('selected:true with full row when active', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    const { pool } = makePool({
      defaultRows: {
        rowCount: 1,
        rows: [
          {
            user_id: '7',
            session_id: SESSION_ID,
            selection_version: '2',
            owner: 'octocat',
            repo: 'demo',
            branch: 'main',
            default_branch: 'main',
            status: 'ready',
            head_sha: 'sha-abc',
            error_code: null,
            error_message: null,
            selected_at: new Date(),
            updated_at: new Date(),
          },
        ],
      },
    })
    await handleGetSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
    })
    const body = JSON.parse(fakeRes.body)
    assert.equal(body.selected, true)
    assert.equal(body.owner, 'octocat')
    assert.equal(body.branch, 'main')
    assert.equal(body.status, 'ready')
    assert.equal(body.head_sha, 'sha-abc')
    assert.equal(body.selection_version, 2)
  })

  test('invalid session_id → 400', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      url: '/api/me/sessions/short/github-selection',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    await assert.rejects(
      handleGetSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => ({}) as unknown as Pool,
      }),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === 'INVALID_SESSION_ID',
    )
  })
})

// ─── PUT /api/me/sessions/:sid/github-selection ────────────────────────

describe('handlePutSessionGithubSelection', () => {
  function repoMetaJson(opts: { push?: boolean; defaultBranch?: string } = {}) {
    return {
      id: 1,
      name: 'demo',
      full_name: 'octocat/demo',
      owner: { login: 'octocat', avatar_url: null },
      private: false,
      default_branch: opts.defaultBranch ?? 'main',
      description: null,
      language: null,
      stargazers_count: 0,
      updated_at: null,
      html_url: '',
      permissions: {
        admin: false,
        maintain: false,
        push: opts.push ?? true,
        triage: false,
        pull: true,
      },
    }
  }
  const branchJson = {
    name: 'main',
    commit: { sha: 'sha-head' },
    protected: false,
  }

  test('happy path: validates repo+branch, then upserts', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      method: 'PUT',
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
      body: { owner: 'octocat', repo: 'demo', branch: 'main' },
    })
    const fakeRes = makeRes()
    const { pool, calls } = makePool({
      hook: (sql) => {
        if (/SELECT user_id::text AS user_id/.test(sql)) {
          return { rowCount: 1, rows: [rawLinkRow('ghp_token')] }
        }
        if (/INSERT INTO github_session_workspaces/.test(sql)) {
          return {
            rowCount: 1,
            rows: [
              {
                user_id: '7',
                session_id: SESSION_ID,
                selection_version: '1',
                owner: 'octocat',
                repo: 'demo',
                branch: 'main',
                default_branch: 'main',
                status: 'pending',
                head_sha: 'sha-head',
                error_code: null,
                error_message: null,
                selected_at: new Date(),
                updated_at: new Date(),
              },
            ],
          }
        }
        return undefined
      },
    })

    let calledRepo = false
    let calledBranch = false
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input)
      if (/\/repos\/octocat\/demo$/.test(url)) {
        calledRepo = true
        return jsonResponse(200, repoMetaJson({ push: true }))
      }
      if (/\/repos\/octocat\/demo\/branches\/main$/.test(url)) {
        calledBranch = true
        return jsonResponse(200, branchJson)
      }
      return jsonResponse(404, { message: 'unexpected url ' + url })
    }
    await handlePutSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
      githubFetch: fetchFn as typeof fetch,
    })
    assert.equal(fakeRes.statusCode, 200)
    const body = JSON.parse(fakeRes.body)
    assert.equal(body.selected, true)
    assert.equal(body.head_sha, 'sha-head')
    assert.equal(body.default_branch, 'main')
    assert.equal(body.status, 'pending')
    assert.ok(calledRepo, 'must GET /repos/:owner/:repo')
    assert.ok(calledBranch, 'must GET /repos/:owner/:repo/branches/:branch')
    // INSERT 命中
    assert.ok(
      calls.some((c) => /INSERT INTO github_session_workspaces/.test(c.sql)),
      'must upsert',
    )
  })

  test('no push permission → 403 GITHUB_REPO_NO_WRITE', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      method: 'PUT',
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
      body: { owner: 'octocat', repo: 'demo', branch: 'main' },
    })
    const fakeRes = makeRes()
    const { pool } = makePool({
      hook: (sql) => {
        if (/SELECT user_id::text AS user_id/.test(sql)) {
          return { rowCount: 1, rows: [rawLinkRow('ghp_token')] }
        }
        return undefined
      },
    })
    const fetchFn = async () => jsonResponse(200, repoMetaJson({ push: false }))
    await assert.rejects(
      handlePutSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => pool,
        githubFetch: fetchFn as typeof fetch,
      }),
      (err: unknown) =>
        err instanceof Error &&
        (err as { code?: string }).code === 'GITHUB_REPO_NO_WRITE' &&
        (err as { status?: number }).status === 403,
    )
  })

  test('repo 404 → 404 GITHUB_REPO_NOT_FOUND', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      method: 'PUT',
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
      body: { owner: 'octocat', repo: 'missing', branch: 'main' },
    })
    const fakeRes = makeRes()
    const { pool } = makePool({
      hook: (sql) => {
        if (/SELECT user_id::text AS user_id/.test(sql)) {
          return { rowCount: 1, rows: [rawLinkRow('ghp_token')] }
        }
        return undefined
      },
    })
    const fetchFn = async () =>
      new Response('{"message":"not found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    await assert.rejects(
      handlePutSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => pool,
        githubFetch: fetchFn as typeof fetch,
      }),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === 'GITHUB_REPO_NOT_FOUND',
    )
  })

  test('branch 404 → 404 GITHUB_BRANCH_NOT_FOUND', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      method: 'PUT',
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
      body: { owner: 'octocat', repo: 'demo', branch: 'gone' },
    })
    const fakeRes = makeRes()
    const { pool } = makePool({
      hook: (sql) => {
        if (/SELECT user_id::text AS user_id/.test(sql)) {
          return { rowCount: 1, rows: [rawLinkRow('ghp_token')] }
        }
        return undefined
      },
    })
    const fetchFn = async (input: string | URL | Request) => {
      const url = String(input)
      if (/\/repos\/octocat\/demo$/.test(url)) {
        return jsonResponse(200, repoMetaJson({ push: true }))
      }
      // branch not found
      return new Response('{"message":"branch not found"}', {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    await assert.rejects(
      handlePutSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => pool,
        githubFetch: fetchFn as typeof fetch,
      }),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === 'GITHUB_BRANCH_NOT_FOUND',
    )
  })

  test('invalid branch (whitespace) → 400 INVALID_BRANCH', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      method: 'PUT',
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
      body: { owner: 'octocat', repo: 'demo', branch: 'has space' },
    })
    const fakeRes = makeRes()
    await assert.rejects(
      handlePutSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => ({}) as unknown as Pool,
      }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'INVALID_BRANCH',
    )
  })

  test('non-object body → 400 INVALID_BODY', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      method: 'PUT',
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
      body: '"just a string"',
    })
    const fakeRes = makeRes()
    await assert.rejects(
      handlePutSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
        poolFactory: () => ({}) as unknown as Pool,
      }),
      (err: unknown) => err instanceof Error && (err as { code?: string }).code === 'INVALID_BODY',
    )
  })
})

// ─── DELETE /api/me/sessions/:sid/github-selection ─────────────────────

describe('handleDeleteSessionGithubSelection', () => {
  test('idempotent: clears row when present', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      method: 'DELETE',
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    const { pool, calls } = makePool({
      hook: (sql) => {
        if (/UPDATE github_session_workspaces/.test(sql)) {
          return {
            rowCount: 1,
            rows: [
              {
                user_id: '7',
                session_id: SESSION_ID,
                selection_version: '4',
                owner: 'octocat',
                repo: 'demo',
                branch: 'main',
                default_branch: 'main',
                status: 'cleared',
                head_sha: null,
                error_code: null,
                error_message: null,
                selected_at: new Date(),
                updated_at: new Date(),
              },
            ],
          }
        }
        return undefined
      },
    })
    await handleDeleteSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
    })
    assert.equal(fakeRes.statusCode, 200)
    assert.deepEqual(JSON.parse(fakeRes.body), { cleared: true })
    assert.ok(
      calls.some((c) => /UPDATE github_session_workspaces/.test(c.sql)),
      'must UPDATE',
    )
  })

  test('idempotent: returns cleared:true even when row missing', async () => {
    const token = await signUserJwt('7')
    const req = makeReq({
      method: 'DELETE',
      url: `/api/me/sessions/${SESSION_ID}/github-selection`,
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    const { pool } = makePool({ defaultRows: { rowCount: 0, rows: [] } })
    await handleDeleteSessionGithubSelection(req, fakeRes.res, makeCtx(), makeDeps(), {
      poolFactory: () => pool,
    })
    assert.equal(fakeRes.statusCode, 200)
    assert.deepEqual(JSON.parse(fakeRes.body), { cleared: true })
  })
})
