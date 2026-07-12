/**
 * GitHub OAuth handler 单元测试。
 *
 * 覆盖:
 *   1. handleGithubStart: 未登录 → 401; GitHub env 未配 → 503; 成功 → 200 JSON + Set-Cookie
 *      + pending state 落库(内存版 store)。
 *   2. handleGithubCallback: state 不匹配 → redirect github_error=state_mismatch
 *   3. handleGithubCallback: provider error(?error=access_denied) → redirect github_error=exchange_failed
 *   4. handleGithubCallback: start→callback 真回环(pending 消费拿回 userId)+ exchange + save → /?github_linked=1
 *   5. handleGithubCallback: pending 已消费(重放)→ state_mismatch
 *   6. handleGithubCallback: saveGithubLink conflict → github_error=account_already_linked
 *
 * 策略:
 *   - mock process.env GitHub OAuth 变量 + OPENCLAUDE_KMS_KEY(pending payload 加密)
 *   - 注入内存版 oauth_pending_states runner(忠实实现 INSERT / 原子 DELETE…RETURNING / GC)
 *   - mock exchanger 避免打 github.com;mock poolFactory 避免真 DB(github_links)
 */

import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, test } from 'node:test'
import type { Pool } from 'pg'
import type { QueryRunner } from '../db/queries.js'
import { exchangeGithubOAuth } from '../auth/github.js'
import type { CommercialHttpDeps, RequestContext } from '../http/handlers.js'
import { handleGithubCallback, handleGithubStart } from '../http/oauthGithub.js'

// ─── Test KMS key (pending payload 加密) ─────────────────────────────
const TEST_KMS_KEY = Buffer.alloc(32, 0xcd)
process.env.OPENCLAUDE_KMS_KEY = TEST_KMS_KEY.toString('base64')
// Inject GitHub OAuth env
process.env.GITHUB_OAUTH_CLIENT_ID = 'test_client_id'
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test_client_secret'
process.env.GITHUB_OAUTH_REDIRECT_URI = 'https://test.example/api/auth/github/callback'

// ─── 内存版 oauth_pending_states runner(对齐 0135:单 payload TEXT 列)─────────
// 忠实模拟三条 SQL:INSERT / 原子 DELETE…RETURNING(带 expires_at>now())/ GC。
function makeFakePendingRunner(): QueryRunner {
  const rows = new Map<string, { payload: string; expires_at: Date }>()
  return {
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
    async query(sql: string, params: readonly unknown[] = []): Promise<any> {
      if (sql.includes('INSERT INTO oauth_pending_states')) {
        const [stateHash, payload, expiresAt] = params as [string, string, Date]
        rows.set(stateHash, { payload, expires_at: expiresAt })
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('RETURNING payload')) {
        const [stateHash] = params as [string]
        const row = rows.get(stateHash)
        if (row && row.expires_at.getTime() > Date.now()) {
          rows.delete(stateHash)
          return { rows: [{ payload: row.payload }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('DELETE FROM oauth_pending_states WHERE expires_at')) {
        const [cutoff] = params as [Date]
        let n = 0
        for (const [k, v] of rows) {
          if (v.expires_at.getTime() <= cutoff.getTime()) {
            rows.delete(k)
            n += 1
          }
        }
        return { rows: [], rowCount: n }
      }
      throw new Error(`unexpected sql: ${sql}`)
    },
  } as unknown as QueryRunner
}

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

import { SignJWT } from 'jose'

async function makeJwt(userId: string, secret: string): Promise<string> {
  return new SignJWT({ sub: userId, role: 'user', jti: 'test-jti' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret))
}

const SECRET = 'test_jwt_secret_that_is_long_enough_for_hs256_at_least_32_bytes'

/** 发起 start,返回下发的 state(pending 已写进 runner)。 */
async function doStart(userId: string, runner: QueryRunner): Promise<string> {
  const token = await makeJwt(userId, SECRET)
  const req = makeReq({ method: 'POST', url: '/api/auth/github/start', authorization: `Bearer ${token}` })
  const res = makeRes()
  await handleGithubStart(req, res.res, makeCtx(), makeDeps({ jwtSecret: SECRET }), {
    pendingRunner: runner,
  })
  assert.equal(res.statusCode, 200)
  return (JSON.parse(res.body) as { state: string }).state
}

// ─── handleGithubStart tests ──────────────────────────────────────────

describe('handleGithubStart', () => {
  test('no auth header → 401', async () => {
    const req = makeReq({ method: 'POST', url: '/api/auth/github/start' })
    await assert.rejects(
      handleGithubStart(req, makeRes().res, makeCtx(), makeDeps(), {
        pendingRunner: makeFakePendingRunner(),
      }),
      (err: unknown) => err instanceof Error && err.message.includes('missing'),
    )
  })

  test('GitHub env missing → 503', async () => {
    const savedId = process.env.GITHUB_OAUTH_CLIENT_ID
    const savedSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET
    const savedUri = process.env.GITHUB_OAUTH_REDIRECT_URI
    Reflect.deleteProperty(process.env, 'GITHUB_OAUTH_CLIENT_ID')
    Reflect.deleteProperty(process.env, 'GITHUB_OAUTH_CLIENT_SECRET')
    Reflect.deleteProperty(process.env, 'GITHUB_OAUTH_REDIRECT_URI')
    try {
      const token = await makeJwt('1', SECRET)
      const req = makeReq({
        method: 'POST',
        url: '/api/auth/github/start',
        authorization: `Bearer ${token}`,
      })
      await assert.rejects(
        handleGithubStart(req, makeRes().res, makeCtx(), makeDeps({ jwtSecret: SECRET }), {
          pendingRunner: makeFakePendingRunner(),
        }),
        (err: unknown) => (err as { status?: number }).status === 503,
      )
    } finally {
      if (savedId !== undefined) process.env.GITHUB_OAUTH_CLIENT_ID = savedId
      if (savedSecret !== undefined) process.env.GITHUB_OAUTH_CLIENT_SECRET = savedSecret
      if (savedUri !== undefined) process.env.GITHUB_OAUTH_REDIRECT_URI = savedUri
    }
  })

  test('success → 200 JSON with authorizeUrl + state + Set-Cookie', async () => {
    const token = await makeJwt('42', SECRET)
    const req = makeReq({
      method: 'POST',
      url: '/api/auth/github/start',
      authorization: `Bearer ${token}`,
    })
    const fakeRes = makeRes()
    await handleGithubStart(req, fakeRes.res, makeCtx(), makeDeps({ jwtSecret: SECRET }), {
      pendingRunner: makeFakePendingRunner(),
    })
    assert.equal(fakeRes.statusCode, 200)
    const body = JSON.parse(fakeRes.body) as { authorizeUrl: string; state: string }
    assert.ok(body.authorizeUrl.includes('github.com/login/oauth/authorize'))
    assert.match(body.state, /^[a-f0-9]{32}$/)
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
    await handleGithubCallback(req, fakeRes.res, makeCtx(), makeDeps())
    assert.equal(fakeRes.statusCode, 302)
    assert.match(fakeRes.headers.Location as string, /github_error=state_mismatch/)
  })

  test('state mismatch (cookie ≠ query state) → redirect ?github_error=state_mismatch', async () => {
    const req = makeReq({
      url: '/api/auth/github/callback?state=abc&code=xyz',
      cookie: 'oc_oauth_gh_state=different_state',
    })
    const fakeRes = makeRes()
    await handleGithubCallback(req, fakeRes.res, makeCtx(), makeDeps())
    assert.equal(fakeRes.statusCode, 302)
    assert.match(fakeRes.headers.Location as string, /github_error=state_mismatch/)
  })

  test('provider error param → redirect ?github_error=exchange_failed (不消费 pending)', async () => {
    const state = 'literalstate123'
    const encoded = encodeURIComponent(state)
    const req = makeReq({
      url: `/api/auth/github/callback?state=${encoded}&error=access_denied`,
      cookie: `oc_oauth_gh_state=${encoded}`,
    })
    const fakeRes = makeRes()
    await handleGithubCallback(req, fakeRes.res, makeCtx(), makeDeps())
    assert.equal(fakeRes.statusCode, 302)
    assert.match(fakeRes.headers.Location as string, /github_error=exchange_failed/)
  })

  test('start→callback 真回环:consume 拿回 userId → exchange + save → /?github_linked=1', async () => {
    const runner = makeFakePendingRunner()
    const state = await doStart('7', runner)
    const encoded = encodeURIComponent(state)
    const req = makeReq({
      url: `/api/auth/github/callback?state=${encoded}&code=goodcode`,
      cookie: `oc_oauth_gh_state=${encoded}`,
    })
    const fakeRes = makeRes()

    let savedRow: unknown[] | null = null
    const fakePool = {
      query: async (_text: string, params?: unknown[]) => {
        savedRow = params ?? []
        return { rowCount: 1, rows: [] }
      },
    } as unknown as Pool

    const fakeExchanger: typeof exchangeGithubOAuth = async () => ({
      accessToken: 'ghp_token_xyz',
      scopes: 'repo read:user',
      githubUser: { id: 12345, login: 'octocat', avatar_url: null },
    })

    await handleGithubCallback(req, fakeRes.res, makeCtx(), makeDeps(), {
      exchanger: fakeExchanger,
      poolFactory: () => fakePool,
      pendingRunner: runner,
    })

    assert.equal(fakeRes.statusCode, 302)
    assert.equal(fakeRes.headers.Location, '/?github_linked=1')
    assert.ok(savedRow, 'pool.query must be invoked to write github_links')
    assert.equal((savedRow as unknown[])[0], 7) // user_id 来自 consume 出来的 pending payload
    assert.equal((savedRow as unknown[])[1], 12345) // github_user_id
    assert.equal((savedRow as unknown[])[2], 'octocat') // login
  })

  test('pending 重放:同一 state 第二次 callback → state_mismatch(原子单次消费)', async () => {
    const runner = makeFakePendingRunner()
    const state = await doStart('7', runner)
    const encoded = encodeURIComponent(state)
    const mkReq = () =>
      makeReq({
        url: `/api/auth/github/callback?state=${encoded}&code=goodcode`,
        cookie: `oc_oauth_gh_state=${encoded}`,
      })
    const fakeExchanger: typeof exchangeGithubOAuth = async () => ({
      accessToken: 'ghp',
      scopes: 'repo',
      githubUser: { id: 1, login: 'u', avatar_url: null },
    })
    const okOverrides = {
      exchanger: fakeExchanger,
      poolFactory: () => ({ query: async () => ({ rowCount: 1, rows: [] }) }) as unknown as Pool,
      pendingRunner: runner,
    }
    // 第一次消费成功
    const res1 = makeRes()
    await handleGithubCallback(mkReq(), res1.res, makeCtx(), makeDeps(), okOverrides)
    assert.equal(res1.headers.Location, '/?github_linked=1')
    // 第二次同 state:pending 已被删 → state_mismatch
    const res2 = makeRes()
    await handleGithubCallback(mkReq(), res2.res, makeCtx(), makeDeps(), okOverrides)
    assert.match(res2.headers.Location as string, /github_error=state_mismatch/)
  })

  test('saveGithubLink conflict → redirect ?github_error=account_already_linked', async () => {
    const runner = makeFakePendingRunner()
    const state = await doStart('8', runner)
    const encoded = encodeURIComponent(state)
    const req = makeReq({
      url: `/api/auth/github/callback?state=${encoded}&code=goodcode`,
      cookie: `oc_oauth_gh_state=${encoded}`,
    })
    const fakeRes = makeRes()
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
      accessToken: 'ghp_token',
      scopes: 'repo',
      githubUser: { id: 999, login: 'taken', avatar_url: null },
    })
    await handleGithubCallback(req, fakeRes.res, makeCtx(), makeDeps(), {
      exchanger: fakeExchanger,
      poolFactory: () => fakePool,
      pendingRunner: runner,
    })
    assert.equal(fakeRes.statusCode, 302)
    assert.match(fakeRes.headers.Location as string, /github_error=account_already_linked/)
  })

  test('exchanger throws GithubOAuthError → redirect ?github_error=exchange_failed', async () => {
    const runner = makeFakePendingRunner()
    const state = await doStart('9', runner)
    const encoded = encodeURIComponent(state)
    const req = makeReq({
      url: `/api/auth/github/callback?state=${encoded}&code=goodcode`,
      cookie: `oc_oauth_gh_state=${encoded}`,
    })
    const fakeRes = makeRes()
    const { GithubOAuthError } = await import('../auth/github.js')
    const fakeExchanger: typeof exchangeGithubOAuth = async () => {
      throw new GithubOAuthError('exchange_failed', 'simulated')
    }
    await handleGithubCallback(req, fakeRes.res, makeCtx(), makeDeps(), {
      exchanger: fakeExchanger,
      poolFactory: () => ({}) as unknown as Pool,
      pendingRunner: runner,
    })
    assert.equal(fakeRes.statusCode, 302)
    assert.match(fakeRes.headers.Location as string, /github_error=exchange_failed/)
  })
})
