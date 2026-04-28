import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  startLinuxdoOAuth,
  exchangeLinuxdoOAuth,
  setOAuthStateCookie,
  readOAuthStateCookie,
  clearOAuthStateCookie,
  readLinuxdoConfig,
  LinuxdoConfigMissingError,
  LinuxdoOAuthError,
  _resetPendingForTesting,
  _pendingSizeForTesting,
} from '../auth/linuxdo.js'

/**
 * LDC OAuth client 单元测试。覆盖:
 *   1. readLinuxdoConfig:env 缺失抛 LinuxdoConfigMissingError;齐了返默认 redirect。
 *   2. startLinuxdoOAuth:authUrl 含 client_id/redirect_uri/state,state 进 pending Map。
 *   3. setOAuthStateCookie / readOAuthStateCookie / clearOAuthStateCookie:
 *      Set-Cookie 头格式正确(SameSite=Lax + HttpOnly + Path=callback),
 *      读 cookie header 能拿回 state,clear 输出 Max-Age=0。
 *   4. exchangeLinuxdoOAuth:
 *      a) 未知 state → INVALID_STATE
 *      b) state 已被消费(replay)→ INVALID_STATE
 *      c) token endpoint 4xx → TOKEN_FAILED
 *      d) userinfo endpoint 4xx → USERINFO_FAILED
 *      e) userinfo 缺 id → USERINFO_INVALID
 *      f) happy path → 返合法字段(id 字符串化、email 小写、空 avatar 转 null)
 */

function makeRes(): {
  res: ServerResponse
  headers: Record<string, string | string[]>
} {
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

beforeEach(() => {
  _resetPendingForTesting()
})

describe('readLinuxdoConfig', () => {
  test('throws when client_id missing', () => {
    assert.throws(
      () => readLinuxdoConfig({ LINUXDO_CLIENT_SECRET: 'x' } as NodeJS.ProcessEnv),
      (err: unknown) => err instanceof LinuxdoConfigMissingError,
    )
  })
  test('throws when client_secret missing', () => {
    assert.throws(
      () => readLinuxdoConfig({ LINUXDO_CLIENT_ID: 'x' } as NodeJS.ProcessEnv),
      (err: unknown) => err instanceof LinuxdoConfigMissingError,
    )
  })
  test('default redirect when env set without LINUXDO_REDIRECT_URI', () => {
    const cfg = readLinuxdoConfig({
      LINUXDO_CLIENT_ID: 'cid',
      LINUXDO_CLIENT_SECRET: 'csec',
    } as NodeJS.ProcessEnv)
    assert.equal(cfg.clientId, 'cid')
    assert.equal(cfg.clientSecret, 'csec')
    assert.equal(cfg.redirectUri, 'https://claudeai.chat/api/auth/linuxdo/callback')
  })
  test('explicit LINUXDO_REDIRECT_URI overrides default', () => {
    const cfg = readLinuxdoConfig({
      LINUXDO_CLIENT_ID: 'cid',
      LINUXDO_CLIENT_SECRET: 'csec',
      LINUXDO_REDIRECT_URI: 'https://staging.claudeai.chat/api/auth/linuxdo/callback',
    } as NodeJS.ProcessEnv)
    assert.equal(cfg.redirectUri, 'https://staging.claudeai.chat/api/auth/linuxdo/callback')
  })
})

describe('startLinuxdoOAuth', () => {
  test('emits authUrl with required params + populates pending Map', () => {
    const result = startLinuxdoOAuth({
      clientId: 'CID',
      clientSecret: 'CSEC',
      redirectUri: 'https://test.example/cb',
    })
    const u = new URL(result.authUrl)
    assert.equal(u.host, 'connect.linux.do')
    assert.equal(u.pathname, '/oauth2/authorize')
    assert.equal(u.searchParams.get('client_id'), 'CID')
    assert.equal(u.searchParams.get('redirect_uri'), 'https://test.example/cb')
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('state'), result.state)
    assert.match(result.state, /^[a-f0-9]{32}$/)
    assert.equal(_pendingSizeForTesting(), 1)
  })
})

describe('OAuth state cookie helpers', () => {
  test('setOAuthStateCookie writes Set-Cookie with HttpOnly + SameSite=Lax + Path callback', () => {
    const { res, headers } = makeRes()
    setOAuthStateCookie(res, 'abc123', { secure: true })
    const cookie = headers['Set-Cookie']
    const cookieStr = Array.isArray(cookie) ? cookie[0] : (cookie as string)
    assert.match(cookieStr, /^oc_oauth_ld_state=abc123/)
    assert.match(cookieStr, /Max-Age=600/)
    assert.match(cookieStr, /Path=\/api\/auth\/linuxdo\/callback/)
    assert.match(cookieStr, /HttpOnly/)
    assert.match(cookieStr, /SameSite=Lax/)
    assert.match(cookieStr, /Secure/)
  })
  test('readOAuthStateCookie parses cookie header — must accept multiple cookies', () => {
    const req = makeReq('foo=bar; oc_oauth_ld_state=xyz789; baz=qux')
    assert.equal(readOAuthStateCookie(req), 'xyz789')
  })
  test('readOAuthStateCookie returns null when missing', () => {
    assert.equal(readOAuthStateCookie(makeReq('foo=bar')), null)
    assert.equal(readOAuthStateCookie(makeReq(undefined)), null)
  })
  test('clearOAuthStateCookie writes Max-Age=0', () => {
    const { res, headers } = makeRes()
    clearOAuthStateCookie(res, { secure: false })
    const cookie = headers['Set-Cookie']
    const cookieStr = Array.isArray(cookie) ? cookie[0] : (cookie as string)
    assert.match(cookieStr, /^oc_oauth_ld_state=;/)
    assert.match(cookieStr, /Max-Age=0/)
    assert.doesNotMatch(cookieStr, /Secure/)
  })
})

describe('exchangeLinuxdoOAuth', () => {
  const cfg = {
    clientId: 'CID',
    clientSecret: 'CSEC',
    redirectUri: 'https://test.example/cb',
  }

  test('unknown state → INVALID_STATE', async () => {
    await assert.rejects(
      exchangeLinuxdoOAuth('code', 'never-issued', { config: cfg, fetchImpl: failFetch }),
      (err: unknown) => err instanceof LinuxdoOAuthError && err.code === 'INVALID_STATE',
    )
  })

  test('state replay → second call INVALID_STATE', async () => {
    const { state } = startLinuxdoOAuth(cfg)
    const fetchImpl = makeFetch({
      tokenStatus: 200,
      tokenBody: { access_token: 'AT' },
      userStatus: 200,
      userBody: { id: 1, username: 'u', email: 'e@e' },
    })
    await exchangeLinuxdoOAuth('code', state, { config: cfg, fetchImpl })
    // 第二次同 state 必失败
    await assert.rejects(
      exchangeLinuxdoOAuth('code', state, { config: cfg, fetchImpl }),
      (err: unknown) => err instanceof LinuxdoOAuthError && err.code === 'INVALID_STATE',
    )
  })

  test('token endpoint 400 → TOKEN_FAILED', async () => {
    const { state } = startLinuxdoOAuth(cfg)
    await assert.rejects(
      exchangeLinuxdoOAuth('bad', state, {
        config: cfg,
        fetchImpl: makeFetch({ tokenStatus: 400 }),
      }),
      (err: unknown) => err instanceof LinuxdoOAuthError && err.code === 'TOKEN_FAILED',
    )
  })

  test('userinfo 401 → USERINFO_FAILED', async () => {
    const { state } = startLinuxdoOAuth(cfg)
    await assert.rejects(
      exchangeLinuxdoOAuth('code', state, {
        config: cfg,
        fetchImpl: makeFetch({
          tokenStatus: 200,
          tokenBody: { access_token: 'AT' },
          userStatus: 401,
        }),
      }),
      (err: unknown) => err instanceof LinuxdoOAuthError && err.code === 'USERINFO_FAILED',
    )
  })

  test('userinfo missing id → USERINFO_INVALID', async () => {
    const { state } = startLinuxdoOAuth(cfg)
    await assert.rejects(
      exchangeLinuxdoOAuth('code', state, {
        config: cfg,
        fetchImpl: makeFetch({
          tokenStatus: 200,
          tokenBody: { access_token: 'AT' },
          userStatus: 200,
          userBody: { username: 'no-id' },
        }),
      }),
      (err: unknown) => err instanceof LinuxdoOAuthError && err.code === 'USERINFO_INVALID',
    )
  })

  test('happy path: numeric id → string, email lowercased, missing avatar → null', async () => {
    const { state } = startLinuxdoOAuth(cfg)
    const info = await exchangeLinuxdoOAuth('code', state, {
      config: cfg,
      fetchImpl: makeFetch({
        tokenStatus: 200,
        tokenBody: { access_token: 'AT' },
        userStatus: 200,
        userBody: {
          id: 123,
          username: 'alice',
          email: 'Alice@LDO.example',
          trust_level: 2,
        },
      }),
    })
    assert.equal(info.providerUserId, '123')
    assert.equal(info.username, 'alice')
    assert.equal(info.email, 'alice@ldo.example')
    assert.equal(info.trustLevel, 2)
    assert.equal(info.avatarUrl, null)
  })
})

// ─── fetch helpers ─────────────────────────────────────────────────

function failFetch(): Promise<Response> {
  throw new Error('fetch should not be called for INVALID_STATE early reject')
}

interface FakeOpts {
  tokenStatus: number
  tokenBody?: unknown
  userStatus?: number
  userBody?: unknown
}

function makeFetch(opts: FakeOpts): typeof fetch {
  return (async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/oauth2/token')) {
      return new Response(JSON.stringify(opts.tokenBody ?? {}), {
        status: opts.tokenStatus,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/api/user')) {
      return new Response(JSON.stringify(opts.userBody ?? {}), {
        status: opts.userStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch
}
