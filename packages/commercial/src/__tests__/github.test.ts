/**
 * GitHub OAuth client 单元测试。覆盖:
 *   1. readGithubConfig: env 缺失抛 GithubConfigMissingError;全有时解析正确。
 *   2. startGithubOAuth: 生成合法 authorizeUrl + state(纯函数,pending 迁 PG 后不写进程内 Map)。
 *   3. Cookie helpers: setGithubStateCookie / readGithubStateCookie / clearGithubStateCookie。
 *   4. exchangeGithubOAuth(纯外部 I/O,不再消费 pending state):
 *      a) token endpoint 400 → exchange_failed
 *      b) token endpoint body.error → exchange_failed
 *      c) 网络超时 → exchange_failed
 *      d) GitHub user endpoint 401 → exchange_failed
 *      e) user endpoint missing id → exchange_failed
 *      f) happy path → 正确返回 accessToken + scopes + githubUser
 *
 * 注:state 的原子单次消费(anti-replay/TTL)已迁 PG,单测见 oauthPendingStore.test.ts;
 * handler 端编排见 oauthGithub.test.ts。
 */

import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, test } from 'node:test'
import {
  GithubConfigMissingError,
  GithubOAuthError,
  clearGithubStateCookie,
  exchangeGithubOAuth,
  readGithubConfig,
  readGithubStateCookie,
  setGithubStateCookie,
  startGithubOAuth,
} from '../auth/github.js'

// ─── helpers ─────────────────────────────────────────────────────────

function makeRes(): { res: ServerResponse; headers: Record<string, string | string[]> } {
  const headers: Record<string, string | string[]> = {}
  const res = {
    setHeader(name: string, value: string | string[]) {
      headers[name] = value
    },
    getHeader(name: string) {
      return headers[name]
    },
  } as unknown as ServerResponse
  return { res, headers }
}

function makeReq(cookieHeader: string | undefined): IncomingMessage {
  return { headers: cookieHeader ? { cookie: cookieHeader } : {} } as IncomingMessage
}

const testCfg = {
  clientId: 'gh_client_id',
  clientSecret: 'gh_client_secret',
  redirectUri: 'https://test.example/api/auth/github/callback',
  scopes: ['repo', 'read:user'],
}

// ─── readGithubConfig ─────────────────────────────────────────────────

describe('readGithubConfig', () => {
  test('throws when CLIENT_ID missing', () => {
    assert.throws(
      () =>
        readGithubConfig({
          GITHUB_OAUTH_CLIENT_SECRET: 'sec',
          GITHUB_OAUTH_REDIRECT_URI: 'https://x.example/cb',
        } as NodeJS.ProcessEnv),
      (err: unknown) => err instanceof GithubConfigMissingError,
    )
  })

  test('throws when CLIENT_SECRET missing', () => {
    assert.throws(
      () =>
        readGithubConfig({
          GITHUB_OAUTH_CLIENT_ID: 'cid',
          GITHUB_OAUTH_REDIRECT_URI: 'https://x.example/cb',
        } as NodeJS.ProcessEnv),
      (err: unknown) => err instanceof GithubConfigMissingError,
    )
  })

  test('throws when REDIRECT_URI missing', () => {
    assert.throws(
      () =>
        readGithubConfig({
          GITHUB_OAUTH_CLIENT_ID: 'cid',
          GITHUB_OAUTH_CLIENT_SECRET: 'sec',
        } as NodeJS.ProcessEnv),
      (err: unknown) => err instanceof GithubConfigMissingError,
    )
  })

  test('returns parsed config when all env vars present', () => {
    const cfg = readGithubConfig({
      GITHUB_OAUTH_CLIENT_ID: 'cid',
      GITHUB_OAUTH_CLIENT_SECRET: 'sec',
      GITHUB_OAUTH_REDIRECT_URI: 'https://x.example/api/auth/github/callback',
    } as NodeJS.ProcessEnv)
    assert.equal(cfg.clientId, 'cid')
    assert.equal(cfg.clientSecret, 'sec')
    assert.equal(cfg.redirectUri, 'https://x.example/api/auth/github/callback')
    assert.deepEqual(cfg.scopes, ['repo', 'read:user'])
  })
})

// ─── startGithubOAuth ────────────────────────────────────────────────

describe('startGithubOAuth', () => {
  test('emits authorizeUrl with required params (纯函数,无进程内副作用)', () => {
    const result = startGithubOAuth({ cfg: testCfg })
    const u = new URL(result.authorizeUrl)
    assert.equal(u.host, 'github.com')
    assert.equal(u.pathname, '/login/oauth/authorize')
    assert.equal(u.searchParams.get('client_id'), 'gh_client_id')
    assert.equal(u.searchParams.get('redirect_uri'), testCfg.redirectUri)
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('state'), result.state)
    assert.match(result.state, /^[a-f0-9]{32}$/)
  })

  test('每次调用 state 唯一(16 字节随机)', () => {
    const a = startGithubOAuth({ cfg: testCfg })
    const b = startGithubOAuth({ cfg: testCfg })
    assert.notEqual(a.state, b.state)
  })
})

// ─── GitHub state cookie helpers ──────────────────────────────────────

describe('GitHub state cookie helpers', () => {
  test('setGithubStateCookie writes HttpOnly + SameSite=Lax + Path=callback + Secure', () => {
    const { res, headers } = makeRes()
    setGithubStateCookie(res, 'mystate', { secure: true })
    const cookie = headers['Set-Cookie']
    const cookieStr = Array.isArray(cookie) ? cookie[0] : (cookie as string)
    assert.match(cookieStr, /^oc_oauth_gh_state=mystate/)
    assert.match(cookieStr, /Max-Age=600/)
    assert.match(cookieStr, /Path=\/api\/auth\/github\/callback/)
    assert.match(cookieStr, /HttpOnly/)
    assert.match(cookieStr, /SameSite=Lax/)
    assert.match(cookieStr, /Secure/)
  })

  test('setGithubStateCookie without Secure when secure=false', () => {
    const { res, headers } = makeRes()
    setGithubStateCookie(res, 'mystate', { secure: false })
    const cookie = headers['Set-Cookie']
    const cookieStr = Array.isArray(cookie) ? cookie[0] : (cookie as string)
    assert.doesNotMatch(cookieStr, /Secure/)
  })

  test('readGithubStateCookie parses multi-cookie header', () => {
    const req = makeReq('foo=bar; oc_oauth_gh_state=abc123; baz=qux')
    assert.equal(readGithubStateCookie(req), 'abc123')
  })

  test('readGithubStateCookie returns null when missing', () => {
    assert.equal(readGithubStateCookie(makeReq('foo=bar')), null)
    assert.equal(readGithubStateCookie(makeReq(undefined)), null)
  })

  test('clearGithubStateCookie writes Max-Age=0', () => {
    const { res, headers } = makeRes()
    clearGithubStateCookie(res, { secure: false })
    const cookie = headers['Set-Cookie']
    const cookieStr = Array.isArray(cookie) ? cookie[0] : (cookie as string)
    assert.match(cookieStr, /^oc_oauth_gh_state=;/)
    assert.match(cookieStr, /Max-Age=0/)
    assert.doesNotMatch(cookieStr, /Secure/)
  })
})

// ─── exchangeGithubOAuth ─────────────────────────────────────────────

describe('exchangeGithubOAuth', () => {
  test('token endpoint 400 → exchange_failed', async () => {
    await assert.rejects(
      exchangeGithubOAuth({
        code: 'bad',
        cfg: testCfg,
        deps: { fetchImpl: makeFetch({ tokenStatus: 400 }) },
      }),
      (err: unknown) => err instanceof GithubOAuthError && err.code === 'exchange_failed',
    )
  })

  test('token endpoint body.error → exchange_failed', async () => {
    await assert.rejects(
      exchangeGithubOAuth({
        code: 'bad',
        cfg: testCfg,
        deps: {
          fetchImpl: makeFetch({
            tokenStatus: 200,
            tokenBody: { error: 'bad_verification_code', error_description: 'bad code' },
          }),
        },
      }),
      (err: unknown) => err instanceof GithubOAuthError && err.code === 'exchange_failed',
    )
  })

  test('network timeout on token endpoint → exchange_failed', async () => {
    await assert.rejects(
      exchangeGithubOAuth({
        code: 'c',
        cfg: testCfg,
        deps: { fetchImpl: throwingFetch('network timeout') },
      }),
      (err: unknown) => err instanceof GithubOAuthError && err.code === 'exchange_failed',
    )
  })

  test('GitHub user endpoint 401 → exchange_failed', async () => {
    await assert.rejects(
      exchangeGithubOAuth({
        code: 'c',
        cfg: testCfg,
        deps: {
          fetchImpl: makeFetch({
            tokenStatus: 200,
            tokenBody: { access_token: 'AT', scope: 'repo' },
            userStatus: 401,
          }),
        },
      }),
      (err: unknown) => err instanceof GithubOAuthError && err.code === 'exchange_failed',
    )
  })

  test('user endpoint missing id → exchange_failed', async () => {
    await assert.rejects(
      exchangeGithubOAuth({
        code: 'c',
        cfg: testCfg,
        deps: {
          fetchImpl: makeFetch({
            tokenStatus: 200,
            tokenBody: { access_token: 'AT', scope: 'repo' },
            userStatus: 200,
            userBody: { login: 'no-id' },
          }),
        },
      }),
      (err: unknown) => err instanceof GithubOAuthError && err.code === 'exchange_failed',
    )
  })

  test('happy path: returns accessToken + scopes + githubUser', async () => {
    const result = await exchangeGithubOAuth({
      code: 'validcode',
      cfg: testCfg,
      deps: {
        fetchImpl: makeFetch({
          tokenStatus: 200,
          tokenBody: { access_token: 'ghp_mytoken', scope: 'repo read:user' },
          userStatus: 200,
          userBody: {
            id: 12345,
            login: 'octocat',
            avatar_url: 'https://avatars.githubusercontent.com/u/1',
          },
        }),
      },
    })
    assert.equal(result.accessToken, 'ghp_mytoken')
    assert.equal(result.scopes, 'repo read:user')
    assert.equal(result.githubUser.id, 12345)
    assert.equal(result.githubUser.login, 'octocat')
    assert.equal(result.githubUser.avatar_url, 'https://avatars.githubusercontent.com/u/1')
  })

  test('happy path: missing avatar_url → null', async () => {
    const result = await exchangeGithubOAuth({
      code: 'c',
      cfg: testCfg,
      deps: {
        fetchImpl: makeFetch({
          tokenStatus: 200,
          tokenBody: { access_token: 'tok', scope: 'repo,read:user' },
          userStatus: 200,
          userBody: { id: 1, login: 'ghost' },
        }),
      },
    })
    assert.equal(result.githubUser.avatar_url, null)
  })

  test('comma-separated scope (real GitHub OAuth App format) → canonicalized to space', async () => {
    const result = await exchangeGithubOAuth({
      code: 'c',
      cfg: testCfg,
      deps: {
        fetchImpl: makeFetch({
          tokenStatus: 200,
          tokenBody: { access_token: 'tok', scope: 'repo,read:user' },
          userStatus: 200,
          userBody: { id: 5, login: 'u' },
        }),
      },
    })
    assert.equal(result.scopes, 'repo read:user')
  })

  test('missing required scope (no repo) → exchange_failed', async () => {
    await assert.rejects(
      exchangeGithubOAuth({
        code: 'c',
        cfg: testCfg,
        deps: {
          fetchImpl: makeFetch({
            tokenStatus: 200,
            tokenBody: { access_token: 'tok', scope: 'read:user' },
            userStatus: 200,
            userBody: { id: 1, login: 'u' },
          }),
        },
      }),
      (err: unknown) => err instanceof GithubOAuthError && err.code === 'exchange_failed',
    )
  })

  test('empty scope string → exchange_failed (no required scope granted)', async () => {
    await assert.rejects(
      exchangeGithubOAuth({
        code: 'c',
        cfg: testCfg,
        deps: {
          fetchImpl: makeFetch({
            tokenStatus: 200,
            tokenBody: { access_token: 'tok', scope: '' },
            userStatus: 200,
            userBody: { id: 1, login: 'u' },
          }),
        },
      }),
      (err: unknown) => err instanceof GithubOAuthError && err.code === 'exchange_failed',
    )
  })
})

// ─── fetch mock helpers ───────────────────────────────────────────────

function throwingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message)
  }) as typeof fetch
}

interface FakeOpts {
  tokenStatus: number
  tokenBody?: unknown
  userStatus?: number
  userBody?: unknown
}

function makeFetch(opts: FakeOpts): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('login/oauth/access_token')) {
      // 回归断言:确保 token 端点请求一直带 UA / Accept / signal / JSON body
      const headers = (init?.headers ?? {}) as Record<string, string>
      assert.equal(init?.method, 'POST')
      assert.equal(headers['User-Agent'], 'OpenClaude/v3')
      assert.equal(headers.Accept, 'application/json')
      assert.equal(headers['Content-Type'], 'application/json')
      assert.ok(init?.signal, 'token fetch must pass AbortSignal')
      assert.ok(typeof init?.body === 'string', 'token fetch body must be string JSON')
      return new Response(JSON.stringify(opts.tokenBody ?? {}), {
        status: opts.tokenStatus,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('api.github.com/user')) {
      const headers = (init?.headers ?? {}) as Record<string, string>
      assert.equal(headers['User-Agent'], 'OpenClaude/v3')
      assert.equal(headers.Accept, 'application/vnd.github+json')
      assert.match(headers.Authorization ?? '', /^Bearer .+/)
      assert.ok(init?.signal, 'user fetch must pass AbortSignal')
      return new Response(JSON.stringify(opts.userBody ?? {}), {
        status: opts.userStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch
}
