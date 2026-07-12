/**
 * 连接器平台 · oauth2 授权码流(切片 A:编译器 + 引擎核心)单测,不接真实网络。
 *
 * 覆盖:
 *   编译器
 *     - github-oauth 风格 spec 干净编译;execContract.oauth2 = Oauth2Config(剔除
 *       tokenOutputs/apiCredentialPlacements);tokenOutputs/placements 走各自权威通道。
 *     - **受众隔离守门**:authorize endpoint ∉ authorizationOrigins → AUDIENCE_MISSING;
 *       token endpoint ∉ tokenOrigins → AUDIENCE_MISSING。
 *   buildAuthorizeUrl(纯函数)
 *     - URL 含 response_type=code / client_id / redirect_uri / state / scope;PKCE required
 *       时含 code_challenge + method=S256;fixedExtraParams 进 query;**绝不含 client_secret**。
 *   exchangeAuthCode(注入 mock fetchImpl + resolver)
 *     - 请求发到 token origin;body 含 grant_type=authorization_code + code + code_verifier +
 *       client_secret;返回 accessToken/refreshToken/expiresInSec;非 2xx → UPSTREAM_AUTH_FAILED;
 *     - **client_secret/code 不出现在任何返回值/错误 message**(制造一次 401 断言脱敏)。
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'

import {
  bagToResolvedCredentials,
  oauth2ClientProvisioning,
  requiredBindSources,
  storedBagSources,
  validateSecretBag,
} from '../connectors/engine/credentialBag.js'
import type { EngineHttpDeps } from '../connectors/engine/driver.js'
import { buildAuthorizeUrl, exchangeAuthCode } from '../connectors/engine/oauth2.js'
import type { ResolvedCredentials } from '../connectors/engine/placement.js'
import { resolveApiCredentials } from '../connectors/engine/tokenEngine.js'
import { ConnectorError } from '../connectors/errors.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { generatePkceVerifier, pkceChallengeS256 } from '../connectors/pkce.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import type { ExecContractT } from '../connectors/spec/types.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'

function isSpecCode(code: string) {
  return (err: unknown) => err instanceof ConnectorSpecError && err.code === code
}

// ─── github-oauth 风格 fixture ────────────────────────────────────────────────

/** 唯一 canary secret(client_secret / code / verifier 用);跑完不得出现在返回值/错误里。 */
const SECRET = 'CANARY-OAUTH2-9f3c-DO-NOT-LEAK-8a71-abcdef0123456789'
const CODE = 'AUTHCODE-e2e7-DO-NOT-LEAK-4b8f'
const VERIFIER = 'PKCE-VERIFIER-c1a9-DO-NOT-LEAK-0f2d'

function githubSpec(): Record<string, unknown> {
  return {
    id: 'github-oauth',
    label: 'GitHub (OAuth)',
    description: 'github oauth authorization code',
    authMode: 'oauth2-auth-code',
    auth: {
      authorizeEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      // BYOA:用户自建 OAuth App(切片 B 原语义)。platform 模式另有专门用例。
      clientProvisioning: 'byoa',
      clientAuth: 'form',
      scopeSeparator: ' ',
      scopes: ['repo', 'read:user'],
      fixedExtraParams: { allow_signup: 'false' },
      refreshRotation: false,
      refreshEncoding: 'form',
      pkce: 'required',
      tokenOutputs: {
        accessToken: '/access_token',
        refreshToken: '/refresh_token',
        expiresIn: '/expires_in',
      },
      apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
    },
    originMode: 'fixed-reviewed',
    credentialPipeline: {
      nodes: [{ id: 'api-token', authMode: 'oauth2-auth-code', subject: 'user', audience: 'api' }],
    },
    actions: [
      {
        id: 'get_user',
        description: 'get authenticated user',
        request: { method: 'GET', pathTemplate: '/user' },
        params: { type: 'object', additionalProperties: false },
        result: { type: 'object', additionalProperties: false },
        usesSlot: 'api-token',
      },
    ],
  }
}

function githubDecision(): Record<string, unknown> {
  return {
    audience: {
      // authorize + token 端点都在 github.com;api 在 api.github.com(受众隔离,三集不同)。
      authorizationOrigins: ['https://github.com:443'],
      tokenOrigins: ['https://github.com:443'],
      apiOrigins: ['https://api.github.com:443'],
      unauthenticatedUploadOrigins: [],
    },
    actions: {},
  }
}

function compileGithub(
  patchSpec: (s: Record<string, unknown>) => void = () => {},
  patchDecision: (d: Record<string, unknown>) => void = () => {},
): ExecContractT {
  const spec = githubSpec()
  patchSpec(spec)
  const decision = githubDecision()
  patchDecision(decision)
  return compileSpec(spec, decision).execContract
}

// ─── 编译器 ────────────────────────────────────────────────────────────────

describe('compileSpec · oauth2-auth-code', () => {
  test('github-oauth 干净编译;execContract.oauth2 = Oauth2Config(无 tokenOutputs/placements)', () => {
    const c = compileGithub()
    assert.equal(c.authMode, 'oauth2-auth-code')
    assert.deepEqual((c as Record<string, unknown>).oauth2, {
      authorizeEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      clientProvisioning: 'byoa',
      clientAuth: 'form',
      scopeSeparator: ' ',
      scopes: ['repo', 'read:user'],
      fixedExtraParams: { allow_signup: 'false' },
      refreshRotation: false,
      refreshEncoding: 'form',
      pkce: 'required',
    })
    // tokenOutputs 走 ExecContract.tokenOutputs 通道;placements 走 action。
    assert.deepEqual(c.tokenOutputs, {
      accessToken: '/access_token',
      refreshToken: '/refresh_token',
      expiresIn: '/expires_in',
    })
    assert.deepEqual(c.actions[0]?.apiCredentialPlacements, [
      { source: 'access_token', placement: 'authorization-bearer' },
    ])
    // oauth2 载体不得夹带凭据输出字段。
    const oauth2 = (c as Record<string, unknown>).oauth2 as Record<string, unknown>
    assert.equal('tokenOutputs' in oauth2, false)
    assert.equal('apiCredentialPlacements' in oauth2, false)
  })

  test('确定性:同输入 → 同 execContract + 同 hash', () => {
    const a = compileSpec(githubSpec(), githubDecision())
    const b = compileSpec(githubSpec(), githubDecision())
    assert.deepEqual(a.execContract, b.execContract)
    assert.equal(a.execContractHash, b.execContractHash)
  })

  test('受众隔离:authorize endpoint ∉ authorizationOrigins → AUDIENCE_MISSING', () => {
    // authorizationOrigins 非空但不含 github.com(精确定位端点-受众不匹配,而非空集)。
    assert.throws(
      () =>
        compileGithub(undefined, (d) => {
          ;(d.audience as Record<string, unknown>).authorizationOrigins = [
            'https://accounts.example.com:443',
          ]
        }),
      isSpecCode('AUDIENCE_MISSING'),
    )
  })

  test('受众隔离:token endpoint ∉ tokenOrigins → AUDIENCE_MISSING', () => {
    assert.throws(
      () =>
        compileGithub(undefined, (d) => {
          ;(d.audience as Record<string, unknown>).tokenOrigins = ['https://other.example.com:443']
        }),
      isSpecCode('AUDIENCE_MISSING'),
    )
  })

  test('受众隔离:authorizationOrigins/tokenOrigins 为空 → AUDIENCE_MISSING', () => {
    assert.throws(
      () =>
        compileGithub(undefined, (d) => {
          ;(d.audience as Record<string, unknown>).authorizationOrigins = []
        }),
      isSpecCode('AUDIENCE_MISSING'),
    )
    assert.throws(
      () =>
        compileGithub(undefined, (d) => {
          ;(d.audience as Record<string, unknown>).tokenOrigins = []
        }),
      isSpecCode('AUDIENCE_MISSING'),
    )
  })

  test('endpoint 非 https / 带 query → 拒', () => {
    assert.throws(
      () =>
        compileGithub((s) => {
          ;(s.auth as Record<string, unknown>).authorizeEndpoint =
            'http://github.com/login/oauth/authorize'
        }),
      isSpecCode('BAD_ORIGIN'),
    )
    assert.throws(
      () =>
        compileGithub((s) => {
          ;(s.auth as Record<string, unknown>).tokenEndpoint =
            'https://github.com/login/oauth/access_token?x=1'
        }),
      isSpecCode('BAD_PATH_TEMPLATE'),
    )
  })

  test('endpoint path 双斜杠(host 注入形状)→ BAD_PATH_TEMPLATE', () => {
    // 注:`{…}`/`..`/`\` 会被 new URL 归一化中和(百分号编码 / 路径规约),运行期用同一份
    // 归一化结果,故无害不拦;`//` 是 new URL 会保留的形状 → validatePath 拦下。
    assert.throws(
      () =>
        compileGithub((s) => {
          ;(s.auth as Record<string, unknown>).authorizeEndpoint =
            'https://github.com/login//oauth/authorize'
        }),
      isSpecCode('BAD_PATH_TEMPLATE'),
    )
  })

  test('可选 refreshEndpoint 受 tokenOrigins 守门 + 携带进 oauth2', () => {
    const c = compileGithub((s) => {
      ;(s.auth as Record<string, unknown>).refreshEndpoint =
        'https://github.com/login/oauth/refresh'
    })
    assert.equal(
      ((c as Record<string, unknown>).oauth2 as Record<string, unknown>).refreshEndpoint,
      'https://github.com/login/oauth/refresh',
    )
    // refreshEndpoint 若落在 authorizationOrigins 之外的域 → tokenOrigins 守门拒。
    assert.throws(
      () =>
        compileGithub((s) => {
          ;(s.auth as Record<string, unknown>).refreshEndpoint = 'https://evil.example.com/refresh'
        }),
      isSpecCode('AUDIENCE_MISSING'),
    )
  })
})

// ─── buildAuthorizeUrl(纯函数) ───────────────────────────────────────────────

describe('buildAuthorizeUrl', () => {
  const OPTS = {
    clientId: 'cid-public-abc',
    redirectUri: 'https://app.example.com/oauth/callback',
    state: 'state-token-123',
    pkceChallenge: 'CHALLENGE-s256-xyz',
  }

  test('组授权 URL:核心参数 + scope + PKCE + fixedExtraParams', () => {
    const c = compileGithub()
    const url = buildAuthorizeUrl(c, OPTS)
    assert.ok(url.startsWith('https://github.com/login/oauth/authorize?'), url)
    const u = new URL(url)
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('client_id'), 'cid-public-abc')
    assert.equal(u.searchParams.get('redirect_uri'), 'https://app.example.com/oauth/callback')
    assert.equal(u.searchParams.get('state'), 'state-token-123')
    assert.equal(u.searchParams.get('scope'), 'repo read:user')
    assert.equal(u.searchParams.get('code_challenge'), 'CHALLENGE-s256-xyz')
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(u.searchParams.get('allow_signup'), 'false') // fixedExtraParams
    // 绝不含 client_secret(本函数根本不接收 secret)。
    assert.ok(!url.includes('client_secret'))
  })

  test('PKCE required 但未传 challenge → BAD_REQUEST', () => {
    const c = compileGithub()
    assert.throws(
      () => buildAuthorizeUrl(c, { ...OPTS, pkceChallenge: undefined }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
  })

  test('PKCE optional 时可省 challenge(不含 code_challenge)', () => {
    const c = compileGithub((s) => {
      ;(s.auth as Record<string, unknown>).pkce = 'optional'
    })
    const url = buildAuthorizeUrl(c, { ...OPTS, pkceChallenge: undefined })
    const u = new URL(url)
    assert.equal(u.searchParams.get('code_challenge'), null)
    assert.equal(u.searchParams.get('code_challenge_method'), null)
    assert.equal(u.searchParams.get('response_type'), 'code')
  })

  test('redirectUri 非 https → BAD_REQUEST', () => {
    const c = compileGithub()
    assert.throws(
      () => buildAuthorizeUrl(c, { ...OPTS, redirectUri: 'http://app.example.com/cb' }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
  })

  test('fixedExtraParams 不得覆盖核心协议参数', () => {
    const c = compileGithub((s) => {
      ;(s.auth as Record<string, unknown>).fixedExtraParams = {
        client_id: 'HIJACK',
        prompt: 'consent',
      }
    })
    const u = new URL(buildAuthorizeUrl(c, OPTS))
    assert.equal(u.searchParams.get('client_id'), 'cid-public-abc') // 未被 HIJACK 覆盖
    assert.equal(u.searchParams.get('prompt'), 'consent')
  })

  test('CRLF 注入(state 含 \\r\\n)→ BAD_REQUEST', () => {
    const c = compileGithub()
    assert.throws(
      () => buildAuthorizeUrl(c, { ...OPTS, state: 'a\r\nSet-Cookie: x' }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
  })
})

// ─── exchangeAuthCode(注入 mock fetchImpl + resolver) ──────────────────────────

/** 单一公网地址(happy path DNS 通过 pinnedHttpsFetch 的全记录校验)。 */
function okResolver(): DnsResolver {
  return {
    resolve4: async () => ['93.184.216.34'],
    resolve6: async () => {
      const e = new Error('nodata') as NodeJS.ErrnoException
      e.code = 'ENODATA'
      throw e
    },
  }
}

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/** 捕获请求 + 按脚本回响应的 mock fetchImpl。 */
function mockFetch(
  captured: Captured[],
  respond: () => { status: number; body: string },
): NonNullable<EngineHttpDeps['fetchImpl']> {
  return async (input, init) => {
    captured.push({
      url: input,
      method: String(init.method),
      headers: (init.headers as Record<string, string>) ?? {},
      body: String(init.body ?? ''),
    })
    const { status, body } = respond()
    return new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    }) as unknown as Response
  }
}

describe('exchangeAuthCode', () => {
  test('form 型:client_id/client_secret 进 body,发到 token origin,返回 tokens', async () => {
    const c = compileGithub()
    const captured: Captured[] = []
    const out = await exchangeAuthCode({
      contract: c,
      code: CODE,
      clientId: 'cid-public-abc',
      clientSecret: SECRET,
      redirectUri: 'https://app.example.com/oauth/callback',
      pkceVerifier: VERIFIER,
      deps: {
        resolver: okResolver(),
        fetchImpl: mockFetch(captured, () => ({
          status: 200,
          body: JSON.stringify({
            access_token: 'at-live-xyz',
            refresh_token: 'rt-live-xyz',
            expires_in: 3600,
          }),
        })),
      },
    })
    // 返回值。
    assert.deepEqual(out, {
      accessToken: 'at-live-xyz',
      refreshToken: 'rt-live-xyz',
      expiresInSec: 3600,
    })
    // 请求发到 token 端点(sole token origin)。
    assert.equal(captured.length, 1)
    assert.equal(captured[0]?.url, 'https://github.com/login/oauth/access_token')
    assert.equal(captured[0]?.method, 'POST')
    assert.equal(captured[0]?.headers['content-type'], 'application/x-www-form-urlencoded')
    // body 字段(form 型:client 凭据进 body,无 Basic 头)。
    const b = new URLSearchParams(captured[0]?.body ?? '')
    assert.equal(b.get('grant_type'), 'authorization_code')
    assert.equal(b.get('code'), CODE)
    assert.equal(b.get('redirect_uri'), 'https://app.example.com/oauth/callback')
    assert.equal(b.get('code_verifier'), VERIFIER)
    assert.equal(b.get('client_id'), 'cid-public-abc')
    assert.equal(b.get('client_secret'), SECRET)
    assert.equal(captured[0]?.headers.authorization, undefined)
    // 返回值不含 code/client_secret/verifier(它们只上行到 token origin)。
    const serialized = JSON.stringify(out)
    for (const s of [SECRET, CODE, VERIFIER]) assert.ok(!serialized.includes(s))
  })

  test('basic 型:client_id:client_secret 进 Authorization Basic,body 无 client_secret', async () => {
    const c = compileGithub((s) => {
      ;(s.auth as Record<string, unknown>).clientAuth = 'basic'
    })
    const captured: Captured[] = []
    await exchangeAuthCode({
      contract: c,
      code: CODE,
      clientId: 'cid-public-abc',
      clientSecret: SECRET,
      redirectUri: 'https://app.example.com/oauth/callback',
      pkceVerifier: VERIFIER,
      deps: {
        resolver: okResolver(),
        fetchImpl: mockFetch(captured, () => ({
          status: 200,
          body: JSON.stringify({ access_token: 'at-live-xyz' }),
        })),
      },
    })
    const authz = captured[0]?.headers.authorization ?? ''
    assert.ok(authz.startsWith('Basic '))
    assert.equal(
      Buffer.from(authz.slice('Basic '.length), 'base64').toString('utf8'),
      `cid-public-abc:${SECRET}`,
    )
    const b = new URLSearchParams(captured[0]?.body ?? '')
    assert.equal(b.get('client_secret'), null) // secret 不进 body
    assert.equal(b.get('client_id'), null)
    assert.equal(b.get('grant_type'), 'authorization_code')
    assert.equal(b.get('code_verifier'), VERIFIER)
  })

  test('非 2xx(401)→ UPSTREAM_AUTH_FAILED,错误 message 脱敏(无 code/secret)', async () => {
    const c = compileGithub()
    const captured: Captured[] = []
    let err: unknown
    try {
      await exchangeAuthCode({
        contract: c,
        code: CODE,
        clientId: 'cid-public-abc',
        clientSecret: SECRET,
        redirectUri: 'https://app.example.com/oauth/callback',
        pkceVerifier: VERIFIER,
        deps: {
          resolver: okResolver(),
          fetchImpl: mockFetch(captured, () => ({
            // 上游把 code 回显进 body —— 但 driver 非 2xx 吞 body(绝不读)。
            status: 401,
            body: JSON.stringify({ error: `bad code ${CODE} secret ${SECRET}` }),
          })),
        },
      })
    } catch (e) {
      err = e
    }
    assert.ok(err instanceof ConnectorError)
    assert.equal(err.code, 'UPSTREAM_AUTH_FAILED')
    for (const s of [SECRET, CODE, VERIFIER])
      assert.ok(!err.message.includes(s), `leaked in message: ${s}`)
  })

  test('2xx 但 accessToken 指针空 → UPSTREAM_AUTH_FAILED', async () => {
    const c = compileGithub()
    const captured: Captured[] = []
    await assert.rejects(
      exchangeAuthCode({
        contract: c,
        code: CODE,
        clientId: 'cid-public-abc',
        clientSecret: SECRET,
        redirectUri: 'https://app.example.com/oauth/callback',
        pkceVerifier: VERIFIER,
        deps: {
          resolver: okResolver(),
          fetchImpl: mockFetch(captured, () => ({
            status: 200,
            body: JSON.stringify({ note: 'no token' }),
          })),
        },
      }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'UPSTREAM_AUTH_FAILED',
    )
  })

  test('token endpoint origin ∉ tokenOrigins(篡改契约)→ BAD_REQUEST,不发出', async () => {
    const c = compileGithub()
    // 运行期把契约 token 受众改成别处,模拟契约与端点不一致 → 二次断言拦截,client_secret 不发出。
    const tampered = {
      ...c,
      credentialAudiencePolicy: {
        ...c.credentialAudiencePolicy,
        tokenOrigins: ['https://elsewhere.example.com:443'],
      },
    } as ExecContractT
    const captured: Captured[] = []
    await assert.rejects(
      exchangeAuthCode({
        contract: tampered,
        code: CODE,
        clientId: 'cid-public-abc',
        clientSecret: SECRET,
        redirectUri: 'https://app.example.com/oauth/callback',
        deps: {
          resolver: okResolver(),
          fetchImpl: mockFetch(captured, () => ({ status: 200, body: '{}' })),
        },
      }),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
    assert.equal(captured.length, 0) // 受众隔离:请求根本没发出
  })
})

// ─── credentialBag(切片 B:用户填的 ≠ 落库的) ──────────────────────────────

/** static-token 参照契约(用户填什么就存什么)。 */
function compileStaticToken(): ExecContractT {
  return compileSpec(
    {
      id: 'notion-decl',
      label: 'Notion',
      description: 'static token',
      authMode: 'static-token',
      auth: {
        apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
      },
      originMode: 'fixed-reviewed',
      credentialPipeline: {
        nodes: [{ id: 'api-token', authMode: 'static-token', subject: 'user', audience: 'api' }],
      },
      actions: [
        {
          id: 'whoami',
          description: 'probe',
          request: { method: 'GET', pathTemplate: '/v1/users/me' },
          params: { type: 'object', additionalProperties: false },
          result: { type: 'object', additionalProperties: false },
          usesSlot: 'api-token',
        },
      ],
    },
    {
      audience: {
        authorizationOrigins: [],
        tokenOrigins: [],
        apiOrigins: ['https://api.notion.com:443'],
        unauthenticatedUploadOrigins: [],
      },
      actions: {},
    },
  ).execContract
}

/** 同 github fixture,但 clientProvisioning='platform'(平台注册 App,用户一键授权)。 */
function compilePlatform(): ExecContractT {
  return compileGithub((s) => {
    ;(s.auth as Record<string, unknown>).clientProvisioning = 'platform'
  })
}

describe('credentialBag · oauth2-auth-code', () => {
  test('requiredBindSources:byoa 直填 client_id+client_secret;**platform 什么都不填**', () => {
    assert.deepEqual(requiredBindSources(compileGithub()), ['client_id', 'client_secret'])
    // platform:平台已注册 App → 用户一键授权,表单零字段。
    assert.deepEqual(requiredBindSources(compilePlatform()), [])
    // 对照:static-token 用户直填 access_token。
    assert.deepEqual(requiredBindSources(compileStaticToken()), ['access_token'])
  })

  test('oauth2ClientProvisioning:契约字段是唯一权威(byoa / platform)', () => {
    assert.equal(oauth2ClientProvisioning(compileGithub()), 'byoa')
    assert.equal(oauth2ClientProvisioning(compilePlatform()), 'platform')
    // 非 oauth2 契约问 provisioning = 编程错误 → fail-closed(不给默认值)。
    assert.throws(
      () => oauth2ClientProvisioning(compileStaticToken()),
      (e: unknown) => e instanceof ConnectorError && e.code === 'INTERNAL',
    )
  })

  test('storedBagSources:byoa 落 client 凭据;**platform 只落 access_token(client 凭据留平台表)**', () => {
    assert.deepEqual(storedBagSources(compileGithub()), {
      required: ['access_token', 'client_id', 'client_secret'],
      optional: ['refresh_token'],
    })
    // platform:袋里**结构上没有** client_id/client_secret —— 平台密钥不按用户数复制加密副本。
    assert.deepEqual(storedBagSources(compilePlatform()), {
      required: ['access_token'],
      optional: ['refresh_token'],
    })
    // 对照:static-token 两种形状恰好相等。
    assert.deepEqual(storedBagSources(compileStaticToken()), {
      required: ['access_token'],
      optional: [],
    })
  })

  test('validateSecretBag · platform 袋:多带 client_id/client_secret 一律拒(未知键)', () => {
    const { required, optional } = storedBagSources(compilePlatform())
    validateSecretBag({ access_token: 'at' }, required, optional)
    validateSecretBag({ access_token: 'at', refresh_token: 'rt' }, required, optional)
    // 即便是"看起来合法"的 client 凭据,在 platform 袋里也是未知键 → 拒(防止回调路径写错形状)。
    for (const evil of [
      { access_token: 'at', client_id: 'cid' },
      { access_token: 'at', client_secret: SECRET },
    ]) {
      assert.throws(
        () => validateSecretBag(evil, required, optional),
        (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
      )
    }
  })

  test('validateSecretBag:optional 可缺可有;required 缺一必拒;未知键必拒', () => {
    const { required, optional } = storedBagSources(compileGithub())
    // 无 refresh_token(上游没给)→ 放行。
    validateSecretBag(
      { access_token: 'at', client_id: 'cid', client_secret: 'cs' },
      required,
      optional,
    )
    // 带 refresh_token → 放行。
    validateSecretBag(
      { access_token: 'at', client_id: 'cid', client_secret: 'cs', refresh_token: 'rt' },
      required,
      optional,
    )
    // 缺必填 access_token → 拒。
    assert.throws(
      () => validateSecretBag({ client_id: 'cid', client_secret: 'cs' }, required, optional),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
    // 未知键 → 拒(哪怕必填都齐)。
    assert.throws(
      () =>
        validateSecretBag(
          { access_token: 'at', client_id: 'cid', client_secret: 'cs', evil: 'x' },
          required,
          optional,
        ),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
    // optional 未声明时(默认空)→ 多一个 refresh_token 也算未知键。
    assert.throws(
      () =>
        validateSecretBag(
          { access_token: 'at', client_id: 'cid', client_secret: 'cs', refresh_token: 'rt' },
          required,
        ),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
  })

  test('bagToResolvedCredentials:oauth2 只出 accessToken+clientId(secret/refresh 结构上不进注入层)', () => {
    const creds: ResolvedCredentials = bagToResolvedCredentials('oauth2-auth-code', {
      access_token: 'AT',
      client_id: 'CID',
      client_secret: SECRET,
      refresh_token: 'RT',
    })
    // 先断字段(deepEqual 的 `asserts actual is T` 会把 creds 收窄,故放最后)。
    assert.equal(creds.clientSecret, undefined)
    assert.equal(creds.refreshToken, undefined)
    // canary 不在注入层任何字段里。
    assert.equal(JSON.stringify(creds).includes(SECRET), false)
    assert.deepEqual(creds, { accessToken: 'AT', clientId: 'CID' })
  })

  test('bagToResolvedCredentials:platform 袋无 client_id → 只出 accessToken', () => {
    const creds: ResolvedCredentials = bagToResolvedCredentials('oauth2-auth-code', {
      access_token: 'AT',
      refresh_token: 'RT',
    })
    assert.deepEqual(creds, { accessToken: 'AT' })
    assert.equal('clientId' in creds, false)
  })

  test('resolveApiCredentials:oauth2 直接用落库的 access_token(不发网)', async () => {
    const creds = await resolveApiCredentials({
      contract: compileGithub(),
      bag: { access_token: 'AT', client_id: 'CID', client_secret: SECRET },
    })
    assert.deepEqual(creds, { accessToken: 'AT', clientId: 'CID' })
  })
})

// ─── PKCE 助手(上移 connectors/pkce.ts 后仍是同一算法) ─────────────────────

describe('pkce', () => {
  test('verifier 长度 ∈ RFC 7636 [43,128] 且每次不同;challenge = base64url(sha256(verifier))', async () => {
    const v1 = generatePkceVerifier()
    const v2 = generatePkceVerifier()
    assert.notEqual(v1, v2)
    assert.ok(v1.length >= 43 && v1.length <= 128, `verifier length ${v1.length}`)
    assert.match(v1, /^[A-Za-z0-9_-]+$/)
    const challenge = await pkceChallengeS256(v1)
    assert.equal(challenge, createHash('sha256').update(v1, 'ascii').digest('base64url'))
    assert.notEqual(challenge, v1) // 单向派生:URL 里那半 ≠ 交换时那半
  })
})
