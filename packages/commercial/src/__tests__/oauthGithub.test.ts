/**
 * GitHub OAuth handler 单元测试。
 *
 * 覆盖:
 *   1. handleGithubStart: 未登录 → 401; GitHub env 未配 → 503; 成功 → 200 JSON + Set-Cookie
 *   2. handleGithubCallback: state 不匹配 → redirect github_error=state_mismatch
 *   3. handleGithubCallback: provider error(?error=access_denied) → redirect github_error=exchange_failed
 *   4. handleGithubCallback: exchange 成功 + saveGithubLink 成功 → redirect /?github_linked=1
 *   5. handleGithubCallback: saveGithubLink conflict → redirect github_error=account_already_linked
 *
 * 策略:
 *   - mock process.env GitHub OAuth 变量
 *   - mock getPool() 以避免真 DB
 *   - mock github.ts 的 pending Map 状态(通过 _test_clearPending / startGithubOAuth)
 *   - mock fetch 避免打 github.com
 */

import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, test } from 'node:test'
import type { Pool } from 'pg'
import {
  _test_clearPending,
  exchangeGithubOAuth,
  startGithubOAuth,
} from '../auth/github.js'
import type { CommercialHttpDeps, RequestContext } from '../http/handlers.js'
import { handleGithubCallback, handleGithubStart } from '../http/oauthGithub.js'

// ─── Test KMS key (needed for saveGithubLink encrypt) ─────────────────
const TEST_KMS_KEY = Buffer.alloc(32, 0xcd)
process.env.OPENCLAUDE_KMS_KEY = TEST_KMS_KEY.toString('base64')
// Inject GitHub OAuth env
process.env.GITHUB_OAUTH_CLIENT_ID = 'test_client_id'
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test_client_secret'
process.env.GITHUB_OAUTH_REDIRECT_URI = 'https://test.example/api/auth/github/callback'

// ─── Mock helpers ─────────────────────────────────────────────────────

function makeDeps(overrides: Partial<CommercialHttpDeps> = {}): CommercialHttpDeps {
  return {
    jwtSecret: 'test_jwt_secret_that_is_long_enough_for_hs256_at_least_32_bytes',
    mailer: {} as CommercialHttpDeps['mailer'],
    redis: {} as CommercialHttpDeps['redis'],
    refreshCookieSecure: false,
    ...overrides,
  } as CommercialHttpDeps
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

interface FakeResponse {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  res: ServerResponse
}

function makeRes(): FakeResponse {
  const out: FakeResponse = {
    statusCode: 200,
    headers: {},
    body: '',
    res: null as unknown as ServerResponse,
  }
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string | string[]) {
      out.headers[name] = value
      if (name.toLowerCase() === 'set-cookie') {
        out.headers['Set-Cookie'] = value
      }
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
  cookie?: string
}): IncomingMessage {
  return {
    method: opts.method ?? 'GET',
    url: opts.url ?? '/',
    headers: {
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      host: 'test.example',
    },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage
}

// A minimal valid JWT for testing — we'll use a real JWT signed with test secret
// instead of mocking requireAuth, we sign a token properly
import { SignJWT } from 'jose'

async function makeJwt(userId: string, secret: string): Promise<string> {
  return new SignJWT({ sub: userId, role: 'user', jti: 'test-jti' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret))
}

beforeEach(() => {
  _test_clearPending()
})

// ─── handleGithubStart tests ──────────────────────────────────────────

describe('handleGithubStart', () => {
  test('no auth header → 401', async () => {
    const req = makeReq({ method: 'POST', url: '/api/auth/github/start' })
    const fakeRes = makeRes()
    const ctx = makeCtx()
    const deps = makeDeps()

    await assert.rejects(handleGithubStart(req, fakeRes.res, ctx, deps), (err: unknown) => {
      // requireAuth throws HttpError(401)
      return err instanceof Error && err.message.includes('missing')
    })
  })

  test('GitHub env missing → 503', async () => {
    // Temporarily clear env vars using Reflect.deleteProperty (biome-safe alternative to delete)
    const savedId = process.env.GITHUB_OAUTH_CLIENT_ID
    const savedSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET
    const savedUri = process.env.GITHUB_OAUTH_REDIRECT_URI
    Reflect.deleteProperty(process.env, 'GITHUB_OAUTH_CLIENT_ID')
    Reflect.deleteProperty(process.env, 'GITHUB_OAUTH_CLIENT_SECRET')
    Reflect.deleteProperty(process.env, 'GITHUB_OAUTH_REDIRECT_URI')

    try {
      const secret = 'test_jwt_secret_that_is_long_enough_for_hs256_at_least_32_bytes'
      const token = await makeJwt('1', secret)
      const req = makeReq({
        method: 'POST',
        url: '/api/auth/github/start',
        authorization: `Bearer ${token}`,
      })
      const fakeRes = makeRes()
      const ctx = makeCtx()
      const deps = makeDeps({ jwtSecret: secret })

      await assert.rejects(handleGithubStart(req, fakeRes.res, ctx, deps), (err: unknown) => {
        return err instanceof Error && (err as unknown as { status?: number }).status === 503
      })
    } finally {
      if (savedId !== undefined) process.env.GITHUB_OAUTH_CLIENT_ID = savedId
      if (savedSecret !== undefined) process.env.GITHUB_OAUTH_CLIENT_SECRET = savedSecret
      if (savedUri !== undefined) process.env.GITHUB_OAUTH_REDIRECT_URI = savedUri
    }
  })

  test('success → 200 JSON with authorizeUrl + state + Set-Cookie', async () => {
    const secret = 'test_jwt_secret_that_is_long_enough_for_hs256_at_least_32_bytes'
    const token = await makeJwt('42', secret)
    const req = makeReq({
      method: 'POST',
      url: '/api/auth/github/start',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    const ctx = makeCtx()
    const deps = makeDeps({ jwtSecret: secret, refreshCookieSecure: false })

    await handleGithubStart(req, fakeRes.res, ctx, deps)

    assert.equal(fakeRes.statusCode, 200)
    const body = JSON.parse(fakeRes.body) as { authorizeUrl: string; state: string }
    assert.ok(body.authorizeUrl.includes('github.com/login/oauth/authorize'))
    assert.match(body.state, /^[a-f0-9]{32}$/)

    // Should set state cookie
    const cookie = fakeRes.headers['Set-Cookie']
    const cookieStr = Array.isArray(cookie) ? cookie[0] : (cookie as string)
    assert.match(cookieStr ?? '', /oc_oauth_gh_state=/)
    assert.match(cookieStr ?? '', /Path=\/api\/auth\/github\/callback/)
  })
})

// ─── handleGithubCallback tests ───────────────────────────────────────

describe('handleGithubCallback', () => {
  test('state mismatch (no cookie) → redirect ?github_error=state_mismatch', async () => {
    const req = makeReq({ url: '/api/auth/github/callback?state=abc&code=xyz' })
    const fakeRes = makeRes()
    const ctx = makeCtx()
    const deps = makeDeps()

    await handleGithubCallback(req, fakeRes.res, ctx, deps)

    assert.equal(fakeRes.statusCode, 302)
    const location = fakeRes.headers.Location as string
    assert.match(location, /github_error=state_mismatch/)
  })

  test('state mismatch (cookie ≠ query state) → redirect ?github_error=state_mismatch', async () => {
    const req = makeReq({
      url: '/api/auth/github/callback?state=abc&code=xyz',
      cookie: 'oc_oauth_gh_state=different_state',
    })
    const fakeRes = makeRes()
    const ctx = makeCtx()
    const deps = makeDeps()

    await handleGithubCallback(req, fakeRes.res, ctx, deps)

    assert.equal(fakeRes.statusCode, 302)
    const location = fakeRes.headers.Location as string
    assert.match(location, /github_error=state_mismatch/)
  })

  test('provider error param → redirect ?github_error=exchange_failed', async () => {
    // Use a valid state (put in pending Map)
    const { state } = startGithubOAuth({
      userId: 1,
      cfg: {
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        redirectUri: 'https://test.example/api/auth/github/callback',
        scopes: ['repo', 'read:user'],
      },
    })
    const encoded = encodeURIComponent(state)
    const req = makeReq({
      url: `/api/auth/github/callback?state=${encoded}&error=access_denied`,
      cookie: `oc_oauth_gh_state=${encoded}`,
    })
    const fakeRes = makeRes()
    const ctx = makeCtx()
    const deps = makeDeps()

    await handleGithubCallback(req, fakeRes.res, ctx, deps)

    assert.equal(fakeRes.statusCode, 302)
    const location = fakeRes.headers.Location as string
    assert.match(location, /github_error=exchange_failed/)
  })

  test('exchange + save success → redirect /?github_linked=1', async () => {
    // 使用 handleGithubCallback 的 overrides 注入 mock exchanger + poolFactory,
    // 验证整条 happy path:state 校验通过 → exchange OK → saveGithubLink OK → 302 /?github_linked=1
    const { state } = startGithubOAuth({
      userId: 7,
      cfg: {
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        redirectUri: 'https://test.example/api/auth/github/callback',
        scopes: ['repo', 'read:user'],
      },
    })
    const encoded = encodeURIComponent(state)
    const req = makeReq({
      url: `/api/auth/github/callback?state=${encoded}&code=goodcode`,
      cookie: `oc_oauth_gh_state=${encoded}`,
    })
    const fakeRes = makeRes()
    const ctx = makeCtx()
    const deps = makeDeps()

    let savedRow: unknown[] | null = null
    const fakePool = {
      query: async (_text: string, params?: unknown[]) => {
        savedRow = params ?? []
        return { rowCount: 1, rows: [] }
      },
    } as unknown as Pool

    const fakeExchanger: typeof exchangeGithubOAuth = async () => ({
      result: {
        accessToken: 'ghp_token_xyz',
        scopes: 'repo read:user',
        githubUser: { id: 12345, login: 'octocat', avatar_url: null },
      },
      userId: 7,
    })

    await handleGithubCallback(req, fakeRes.res, ctx, deps, {
      exchanger: fakeExchanger,
      poolFactory: () => fakePool,
    })

    assert.equal(fakeRes.statusCode, 302)
    assert.equal(fakeRes.headers.Location, '/?github_linked=1')
    assert.ok(savedRow, 'pool.query must be invoked to write github_links')
    assert.equal((savedRow as unknown[])[0], 7) // user_id
    assert.equal((savedRow as unknown[])[1], 12345) // github_user_id
    assert.equal((savedRow as unknown[])[2], 'octocat') // login
  })

  test('exchange success but saveGithubLink throws conflict → redirect ?github_error=account_already_linked', async () => {
    const { state } = startGithubOAuth({
      userId: 8,
      cfg: {
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        redirectUri: 'https://test.example/api/auth/github/callback',
        scopes: ['repo', 'read:user'],
      },
    })
    const encoded = encodeURIComponent(state)
    const req = makeReq({
      url: `/api/auth/github/callback?state=${encoded}&code=goodcode`,
      cookie: `oc_oauth_gh_state=${encoded}`,
    })
    const fakeRes = makeRes()
    const ctx = makeCtx()
    const deps = makeDeps()

    // Pool 模拟 partial UNIQUE INDEX 冲突 — 抛出带 23505 + 约束名的 pg 错
    const pgErr = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'github_links_github_user_id_unique',
    })
    const fakePool = {
      query: async () => {
        throw pgErr
      },
    } as unknown as Pool

    const fakeExchanger: typeof exchangeGithubOAuth = async () => ({
      result: {
        accessToken: 'ghp_token',
        scopes: 'repo',
        githubUser: { id: 999, login: 'taken', avatar_url: null },
      },
      userId: 8,
    })

    await handleGithubCallback(req, fakeRes.res, ctx, deps, {
      exchanger: fakeExchanger,
      poolFactory: () => fakePool,
    })

    assert.equal(fakeRes.statusCode, 302)
    const location = fakeRes.headers.Location as string
    assert.match(location, /github_error=account_already_linked/)
  })

  test('exchanger throws GithubOAuthError → redirect ?github_error=exchange_failed', async () => {
    const { state } = startGithubOAuth({
      userId: 9,
      cfg: {
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        redirectUri: 'https://test.example/api/auth/github/callback',
        scopes: ['repo', 'read:user'],
      },
    })
    const encoded = encodeURIComponent(state)
    const req = makeReq({
      url: `/api/auth/github/callback?state=${encoded}&code=goodcode`,
      cookie: `oc_oauth_gh_state=${encoded}`,
    })
    const fakeRes = makeRes()
    const ctx = makeCtx()
    const deps = makeDeps()

    const { GithubOAuthError } = await import('../auth/github.js')
    const fakeExchanger: typeof exchangeGithubOAuth = async () => {
      throw new GithubOAuthError('exchange_failed', 'simulated')
    }

    await handleGithubCallback(req, fakeRes.res, ctx, deps, {
      exchanger: fakeExchanger,
      poolFactory: () => ({}) as unknown as Pool,
    })

    assert.equal(fakeRes.statusCode, 302)
    const location = fakeRes.headers.Location as string
    assert.match(location, /github_error=exchange_failed/)
  })
})
