/**
 * 声明式连接器 · oauth2-auth-code **HTTP 授权流**端到端(切片 B;真 PG + 受控本地上游)。
 *
 * 走的是真实路由入口(dispatchConnectorsRoute),不是直接调引擎:
 *   POST /api/connectors/declarative/oauth/start  → 落 pending(AEAD draft)+ Set-Cookie + authorizeUrl
 *   GET  /api/connectors/oauth/callback?state&code → 四因子消费 → exchangeAuthCode(mock token 端点)
 *                                                   → identity 探针(mock api 端点)→ 加密落 pin 连接 → 302
 *
 * 凭据不变量(本文件的核心价值):
 *   - authorizeUrl(要交给浏览器)里有 client_id / state / code_challenge(S256),**绝无**
 *     client_secret、**绝无** code_verifier(只有它的单向派生 challenge);
 *   - client_secret / code / code_verifier **只**出现在发往 **token origin** 的 form body 里
 *     (受众隔离:api origin 的探针请求里 grep 不到 client_secret);
 *   - 落库的 connections.secret_enc 是密文:**明文 grep 不到 client_secret**;解密后袋形状 =
 *     storedBagSources(access_token + client_id + client_secret + refresh_token)。
 *
 * 对抗:
 *   - 重放同一 state(第二次回调)→ 失败且**不重复绑定**(连接数不变);
 *   - cookie nonce 不匹配 → 失败,不落连接;
 *   - 非 oauth2 契约的 versionId 调 oauth/start → BAD_REQUEST;
 *   - oauth2 契约走直填 bind → BAD_REQUEST(直绑禁止,必须走授权流)。
 *
 * 无 PG → skip(REQUIRE_TEST_DB=1 时硬失败),照仓内 integ 惯例。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { after, before, describe, test } from 'node:test'
import { fetch as undiciFetch } from 'undici'

// KMS key 必须在任何 sign/verify/encrypt 前就位。
process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')
// OAuth 回跳地址(authorize 与 token 交换两阶段必须同值)。
process.env.OC_CONNECTORS_OAUTH_REDIRECT_URI =
  'https://app.oauth2.test/api/connectors/oauth/callback'

import { signAccess } from '../auth/jwt.js'
import { bindDeclarativeConnector } from '../connectors/engine/bind.js'
import { decryptBagFromRow, getDeclarativeConnection } from '../connectors/engine/binding.js'
import type { EngineHttpDeps } from '../connectors/engine/driver.js'
import { ConnectorError } from '../connectors/errors.js'
import { dispatchConnectorsRoute } from '../connectors/handlers.js'
import { oauthCookieName } from '../connectors/oauthPending.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { canonicalSha256Hex } from '../connectors/spec/canonical.js'
import { loadVerifiedContractWithMeta } from '../connectors/spec/review.js'
import { securityApprove } from '../connectors/spec/review.js'
import { computeAccountKey } from '../connectors/store.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import type { CommercialHttpDeps, RequestContext } from '../http/handlers.js'
import { HttpError } from '../http/util.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const PUBLIC_IP = '93.184.216.34'
/** HS256 要求 ≥32 字节。 */
const JWT_SECRET = 'test-jwt-secret-oauth2-flow-0123456789abcdef'

/** canary:用户 BYOA 应用的 client_secret。跑完必须只在 token 请求 body 里出现过。 */
const CLIENT_SECRET = 'CS-CANARY-7d3e91a4-DO-NOT-LEAK-fedcba9876543210'
const CLIENT_ID = 'cid-public-abc123'
/** canary:上游发的 access/refresh token。 */
const ACCESS_TOKEN = 'AT-CANARY-2f8b60c1-DO-NOT-LEAK-0011223344556677'
const REFRESH_TOKEN = 'RT-CANARY-5a1d47e9-DO-NOT-LEAK-8899aabbccddeeff'

const AUTHZ_ORIGIN = 'https://auth.oauth2.test:443'
const TOKEN_ORIGIN = 'https://token.oauth2.test:443'
const API_ORIGIN = 'https://api.oauth2.test:443'
const AUTHORIZE_ENDPOINT = 'https://auth.oauth2.test/oauth/authorize'
const TOKEN_ENDPOINT = 'https://token.oauth2.test/oauth/token'

let pgAvailable = false

async function probePg(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* */
    }
    return false
  }
}

async function dropAllTables(): Promise<void> {
  const db = await query<{ db: string }>('SELECT current_database() AS db')
  if (!/_test$/.test(db.rows[0]?.db ?? '')) throw new Error('refusing to drop non-test db')
  await query(`DO $$ DECLARE r RECORD; BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP
      EXECUTE 'DROP TABLE IF EXISTS public.'||quote_ident(r.tablename)||' CASCADE'; END LOOP; END $$;`)
}

// ─── 受控本地上游(同时扮演 token origin 与 api origin,按 path 分流) ──────────

interface Captured {
  method: string
  path: string
  authorization: string | undefined
  body: string
}
interface TestServer {
  port: number
  requests: Captured[]
  close(): Promise<void>
}

function startServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const requests: Captured[] = []
    const server: Server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        requests.push({
          method: req.method ?? '',
          path: u.pathname,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.setHeader('content-type', 'application/json')
        if (u.pathname === '/oauth/token') {
          // token 端点:回 access/refresh/expires。
          res.statusCode = 200
          res.end(
            JSON.stringify({
              access_token: ACCESS_TOKEN,
              refresh_token: REFRESH_TOKEN,
              expires_in: 3600,
            }),
          )
          return
        }
        if (u.pathname === '/user') {
          // identity 探针端点(api origin);多回一个 secret_field 验证 allowlist 剥字段。
          res.statusCode = 200
          res.end(
            JSON.stringify({ id: 'U-99887', login: 'octocat', secret_field: 'must-be-stripped' }),
          )
          return
        }
        res.statusCode = 404
        res.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

/** 把引擎的 https 目标改写到本地 http 服务器(保留 path/headers/body)。 */
function localFetch(port: number): NonNullable<EngineHttpDeps['fetchImpl']> {
  return async (input, init) => {
    const u = new URL(input)
    u.protocol = 'http:'
    u.hostname = '127.0.0.1'
    u.port = String(port)
    return undiciFetch(u.toString(), {
      method: init.method as string,
      headers: init.headers as Record<string, string> | undefined,
      body: init.body as string | undefined,
      redirect: 'error',
      signal: init.signal as AbortSignal | undefined,
    }) as unknown as Promise<Response>
  }
}

function okResolver(): DnsResolver {
  return {
    resolve4: async () => [PUBLIC_IP],
    resolve6: async () => {
      const e = new Error('nodata') as NodeJS.ErrnoException
      e.code = 'ENODATA'
      throw e
    },
  }
}

// ─── 假 req/res/ctx/deps ────────────────────────────────────────────────────

function makeReq(opts: {
  method: string
  url: string
  authorization?: string
  cookie?: string
  body?: unknown
}): IncomingMessage {
  const bodyStr = opts.body === undefined ? '' : JSON.stringify(opts.body)
  const stream = Readable.from(bodyStr ? [Buffer.from(bodyStr, 'utf8')] : [])
  Object.assign(stream, {
    method: opts.method,
    url: opts.url,
    headers: {
      host: 'app.oauth2.test',
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    socket: { remoteAddress: '127.0.0.1' },
  })
  return stream as unknown as IncomingMessage
}

interface FakeRes {
  statusCode: number
  headers: Record<string, string | string[] | number>
  body: string
  res: ServerResponse
}

function makeRes(): FakeRes {
  const out = { statusCode: 200, headers: {}, body: '' } as FakeRes
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
  out.res = res
  return out
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
  } as unknown as RequestContext
}

function makeDeps(port: number): CommercialHttpDeps {
  return {
    jwtSecret: JWT_SECRET,
    mailer: {} as CommercialHttpDeps['mailer'],
    redis: {} as CommercialHttpDeps['redis'],
    refreshCookieSecure: false,
    connectorEngineDeps: { resolver: okResolver(), fetchImpl: localFetch(port) },
  } as CommercialHttpDeps
}

// ─── fixture:oauth2-auth-code / static-token 两个声明式 connector ─────────────

function oauth2Spec(slug: string): Record<string, unknown> {
  return {
    id: slug,
    label: 'Demo OAuth2',
    description: 'oauth2 authorization code declarative connector',
    authMode: 'oauth2-auth-code',
    auth: {
      authorizeEndpoint: AUTHORIZE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      // BYOA(用户自带 App):本文件全部用例的原语义。platform 模式见 connectorsPlatformOauth.integ。
      clientProvisioning: 'byoa',
      clientAuth: 'form',
      scopeSeparator: ' ',
      scopes: ['read:user'],
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
        id: 'whoami',
        description: 'identity probe',
        request: { method: 'GET', pathTemplate: '/user' },
        params: { type: 'object', additionalProperties: false },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' }, login: { type: 'string' } },
        },
        usesSlot: 'api-token',
      },
    ],
    identity: { probeActionId: 'whoami', accountKeyPointer: '/id', accountHintPointer: '/login' },
  }
}

function staticTokenSpec(slug: string): Record<string, unknown> {
  return {
    id: slug,
    label: 'Demo Static',
    description: 'static token declarative connector',
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
        description: 'identity probe',
        request: { method: 'GET', pathTemplate: '/user' },
        params: { type: 'object', additionalProperties: false },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' }, login: { type: 'string' } },
        },
        usesSlot: 'api-token',
      },
    ],
    identity: { probeActionId: 'whoami', accountKeyPointer: '/id', accountHintPointer: '/login' },
  }
}

const oauth2Decision = {
  audience: {
    // 三集互斥:authorize(浏览器)/ token(发 client_secret)/ api(发 access_token)。
    authorizationOrigins: [AUTHZ_ORIGIN],
    tokenOrigins: [TOKEN_ORIGIN],
    apiOrigins: [API_ORIGIN],
    unauthenticatedUploadOrigins: [],
  },
  actions: {},
}
const staticDecision = {
  audience: {
    authorizationOrigins: [],
    tokenOrigins: [],
    apiOrigins: [API_ORIGIN],
    unauthenticatedUploadOrigins: [],
  },
  actions: {},
}

let seq = 0
async function mkUser(role: 'user' | 'admin' = 'user'): Promise<number> {
  seq += 1
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, role)
     VALUES ($1, 'x', TRUE, $2) RETURNING id::text AS id`,
    [`oauth2-u${seq}-${Date.now()}@t.local`, role],
  )
  return Number(r.rows[0]!.id)
}

/** 建 listing+version 并 securityApprove → 可绑的 versionId。 */
async function approvedConnector(
  make: (slug: string) => Record<string, unknown>,
  decision: unknown,
  prefix: string,
): Promise<{ versionId: number; slug: string }> {
  seq += 1
  const slug = `${prefix}-${seq}-${Date.now() % 1_000_000}`
  const spec = make(slug)
  const author = await mkUser()
  const reviewer = await mkUser('admin')
  const raw = JSON.stringify(spec)
  const specHash = canonicalSha256Hex(spec)
  await query(
    'INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind) VALUES ($1,$2,$3)',
    [slug, author, 'connector'],
  )
  const v = await query<{ id: string }>(
    `INSERT INTO marketplace_skill_versions
       (slug, version, name, description, raw_artifact, artifact_hash, embedding_hash, submitted_by, status)
     VALUES ($1,'1.0.0',$2,'d',$3,$4,$4,$5,'pending') RETURNING id::text AS id`,
    [slug, slug, raw, specHash, author],
  )
  const versionId = Number(v.rows[0]!.id)
  await securityApprove({
    versionId,
    reviewerUserId: reviewer,
    securityDecision: decision,
    expectedSpecHash: specHash,
    pool: getPool(),
  })
  return { versionId, slug }
}

async function bearerFor(userId: number): Promise<string> {
  const { token } = await signAccess({ sub: String(userId), role: 'user' }, JWT_SECRET)
  return `Bearer ${token}`
}

/** 从 Set-Cookie 头里取某 cookie 的值。 */
function cookieValue(headers: Record<string, string | string[] | number>, name: string): string {
  const raw = headers['Set-Cookie']
  const lines = Array.isArray(raw) ? raw : [String(raw)]
  for (const line of lines) {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(line)
    if (m?.[1]) return decodeURIComponent(m[1])
  }
  throw new Error(`cookie ${name} not found in ${JSON.stringify(lines)}`)
}

let server: TestServer
let deps: CommercialHttpDeps

before(async () => {
  pgAvailable = await probePg()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await query('CREATE SCHEMA IF NOT EXISTS public')
  await dropAllTables()
  await runMigrations() // 全量迁移含 0135(pending.provider → slug 形状)
  server = await startServer()
  deps = makeDeps(server.port)
})

after(async () => {
  if (server) await server.close()
  if (pgAvailable) {
    try {
      await dropAllTables()
    } catch {
      /* */
    }
    await closePool()
  }
})

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not available')
    return true
  }
  return false
}

/** 调 oauth/start,回 { authorizeUrl, state, cookieNonce }。 */
async function oauthStart(
  userId: number,
  versionId: number,
  slug: string,
  displayName?: string,
): Promise<{ authorizeUrl: string; state: string; cookieNonce: string }> {
  const res = makeRes()
  await dispatchConnectorsRoute(
    makeReq({
      method: 'POST',
      url: '/api/connectors/declarative/oauth/start',
      authorization: await bearerFor(userId),
      body: {
        versionId,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        ...(displayName ? { displayName } : {}),
      },
    }),
    res.res,
    makeCtx(),
    deps,
  )
  assert.equal(res.statusCode, 200)
  const { authorizeUrl } = JSON.parse(res.body) as { authorizeUrl: string }
  const state = new URL(authorizeUrl).searchParams.get('state') ?? ''
  const cookieNonce = cookieValue(res.headers, oauthCookieName(slug))
  return { authorizeUrl, state, cookieNonce }
}

/** 调 oauth/callback(浏览器导航),回 302 Location。 */
async function oauthCallback(opts: {
  state: string
  code: string
  cookie?: string
}): Promise<string> {
  const res = makeRes()
  const url = `/api/connectors/oauth/callback?state=${encodeURIComponent(opts.state)}&code=${encodeURIComponent(opts.code)}`
  await dispatchConnectorsRoute(
    makeReq({ method: 'GET', url, ...(opts.cookie ? { cookie: opts.cookie } : {}) }),
    res.res,
    makeCtx(),
    deps,
  )
  assert.equal(res.statusCode, 302)
  return String(res.headers.Location)
}

async function activeConnectionCount(userId: number): Promise<number> {
  const r = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM connections WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  )
  return Number(r.rows[0]!.n)
}

// ─── 主流程 ─────────────────────────────────────────────────────────────────

describe('oauth2-auth-code · start → callback → bound', () => {
  test('端到端授权流:authorizeUrl 零 secret → 换 token → 探针 → 落 pin 连接', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId, slug } = await approvedConnector(oauth2Spec, oauth2Decision, 'demo-oauth2')
    const userId = await mkUser()
    server.requests.length = 0

    // ① start:authorizeUrl 只带公开标识 + state + PKCE challenge。
    const started = await oauthStart(userId, versionId, slug, '我的 OAuth 连接')
    const au = new URL(started.authorizeUrl)
    assert.equal(`${au.protocol}//${au.host}`, 'https://auth.oauth2.test')
    assert.equal(au.pathname, '/oauth/authorize')
    assert.equal(au.searchParams.get('response_type'), 'code')
    assert.equal(au.searchParams.get('client_id'), CLIENT_ID)
    assert.equal(au.searchParams.get('redirect_uri'), process.env.OC_CONNECTORS_OAUTH_REDIRECT_URI)
    assert.equal(au.searchParams.get('scope'), 'read:user')
    assert.equal(au.searchParams.get('code_challenge_method'), 'S256')
    const challenge = au.searchParams.get('code_challenge') ?? ''
    assert.ok(challenge.length > 0, 'code_challenge present')
    assert.ok(started.state.length > 0, 'state present')
    // **零凭据**:authorize URL 里既无 client_secret,也无 code_verifier(只有单向派生的 challenge)。
    assert.equal(started.authorizeUrl.includes(CLIENT_SECRET), false)
    // start 阶段引擎不发任何网络请求(纯组 URL)。
    assert.equal(server.requests.length, 0)

    // pending 行落库:只存 hash,draft 是密文,provider = slug(0135 放开后合法)。
    const pending = await query<{
      provider: string
      draft_enc: Buffer | null
      consumed_at: Date | null
    }>('SELECT provider, draft_enc, consumed_at FROM connector_oauth_pending WHERE user_id = $1', [
      userId,
    ])
    assert.equal(pending.rowCount, 1)
    assert.equal(pending.rows[0]!.provider, slug)
    assert.equal(pending.rows[0]!.consumed_at, null)
    const draftEnc = pending.rows[0]!.draft_enc
    assert.ok(draftEnc && draftEnc.length > 0, 'draft encrypted')
    // draft 密文里 grep 不到 client_secret 明文。
    assert.equal(draftEnc!.toString('latin1').includes(CLIENT_SECRET), false)

    // ② callback:带 state + code + cookie nonce。
    const location = await oauthCallback({
      state: started.state,
      code: 'AUTH-CODE-xyz-123',
      cookie: `${oauthCookieName(slug)}=${encodeURIComponent(started.cookieNonce)}`,
    })
    assert.equal(location, `/?connector_linked=${encodeURIComponent(slug)}`)

    // ③ 上游流量:token 端点(form body 含交换凭据)+ api 探针(只带 Bearer)。
    const tokenReq = server.requests.find((r) => r.path === '/oauth/token')
    const probeReq = server.requests.find((r) => r.path === '/user')
    assert.ok(tokenReq, 'token endpoint called')
    assert.ok(probeReq, 'identity probe called')
    assert.equal(tokenReq!.method, 'POST')
    const form = new URLSearchParams(tokenReq!.body)
    assert.equal(form.get('grant_type'), 'authorization_code')
    assert.equal(form.get('code'), 'AUTH-CODE-xyz-123')
    assert.equal(form.get('client_id'), CLIENT_ID)
    assert.equal(form.get('client_secret'), CLIENT_SECRET) // 交换凭据只在这里
    assert.equal(form.get('redirect_uri'), process.env.OC_CONNECTORS_OAUTH_REDIRECT_URI)
    const verifier = form.get('code_verifier') ?? ''
    assert.ok(verifier.length >= 43, 'code_verifier sent to token origin')
    // PKCE 对账:发到 token origin 的 verifier 正是 authorize URL 里 challenge 的原像。
    const { createHash } = await import('node:crypto')
    assert.equal(createHash('sha256').update(verifier, 'ascii').digest('base64url'), challenge)

    // **受众隔离**:探针(api origin)只带换回的 access_token,body 里没有任何 client 凭据。
    assert.equal(probeReq!.authorization, `Bearer ${ACCESS_TOKEN}`)
    assert.equal(probeReq!.body.includes(CLIENT_SECRET), false)
    assert.equal(probeReq!.body, '')
    // token 请求没带 Bearer(client 凭据走 form,不是 API token)。
    assert.equal(tokenReq!.authorization, undefined)

    // ④ 连接落库:四个 pin + accountKey/accountHint + 密文。
    const conn = await query<{
      id: string
      provider: string
      display_name: string
      account_key: string
      connector_version_id: string | null
      spec_hash: Buffer | null
      exec_contract_hash: Buffer | null
      auth_contract_version: number | null
      secret_enc: Buffer | null
      meta: Record<string, unknown>
    }>(
      `SELECT id::text AS id, provider, display_name, account_key,
              connector_version_id::text AS connector_version_id, spec_hash, exec_contract_hash,
              auth_contract_version, secret_enc, meta
         FROM connections WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    )
    assert.equal(conn.rowCount, 1)
    const row = conn.rows[0]!
    assert.equal(row.provider, slug)
    assert.equal(row.display_name, '我的 OAuth 连接')
    assert.equal(row.connector_version_id, String(versionId))
    assert.equal(row.account_key, computeAccountKey(`${slug}:U-99887`))
    assert.equal(row.meta.account_hint, 'octocat')
    const meta = await loadVerifiedContractWithMeta(versionId, getPool())
    assert.equal(row.spec_hash?.toString('hex'), meta.contract.spec_hash)
    assert.equal(row.exec_contract_hash?.toString('hex'), meta.execContractHash)
    assert.equal(row.auth_contract_version, meta.authContractVersion)

    // **密文里 grep 不到 client_secret / access_token 明文**。
    const cipher = row.secret_enc!.toString('latin1')
    assert.equal(cipher.includes(CLIENT_SECRET), false)
    assert.equal(cipher.includes(ACCESS_TOKEN), false)
    assert.equal(cipher.includes(REFRESH_TOKEN), false)

    // 解密后的袋 == storedBagSources 形状(含 refresh_token,上游给了)。
    const declRow = await getDeclarativeConnection(row.id, userId, getPool())
    assert.ok(declRow)
    const bag = decryptBagFromRow(declRow!, meta.contract)
    assert.deepEqual(bag, {
      access_token: ACCESS_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
    })

    // pending 行已消费:draft 密文销毁。
    const after = await query<{ consumed_at: Date | null; draft_enc: Buffer | null }>(
      'SELECT consumed_at, draft_enc FROM connector_oauth_pending WHERE user_id = $1',
      [userId],
    )
    assert.notEqual(after.rows[0]!.consumed_at, null)
    assert.equal(after.rows[0]!.draft_enc, null)
  })
})

// ─── 对抗 ───────────────────────────────────────────────────────────────────

describe('oauth2-auth-code · 对抗', () => {
  test('重放同一 state(第二次回调)→ 失败且不重复绑定', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId, slug } = await approvedConnector(oauth2Spec, oauth2Decision, 'replay')
    const userId = await mkUser()
    const started = await oauthStart(userId, versionId, slug)
    const cookie = `${oauthCookieName(slug)}=${encodeURIComponent(started.cookieNonce)}`

    const first = await oauthCallback({ state: started.state, code: 'code-1', cookie })
    assert.equal(first, `/?connector_linked=${encodeURIComponent(slug)}`)
    assert.equal(await activeConnectionCount(userId), 1)

    // 重放:state 已消费 → STATE_MISMATCH,连接数不变(不重复绑定)。
    const replayed = await oauthCallback({ state: started.state, code: 'code-1', cookie })
    assert.equal(replayed, '/?connector_error=STATE_MISMATCH')
    assert.equal(await activeConnectionCount(userId), 1)
  })

  test('cookie nonce 不匹配 → 失败,不落连接', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId, slug } = await approvedConnector(oauth2Spec, oauth2Decision, 'badnonce')
    const userId = await mkUser()
    const started = await oauthStart(userId, versionId, slug)

    const location = await oauthCallback({
      state: started.state,
      code: 'code-2',
      cookie: `${oauthCookieName(slug)}=attacker-guessed-nonce`,
    })
    assert.equal(location, '/?connector_error=STATE_MISMATCH')
    assert.equal(await activeConnectionCount(userId), 0)

    // 缺 cookie(纯 CSRF:攻击者只有 state)→ 同样拒。
    const noCookie = await oauthCallback({ state: started.state, code: 'code-2' })
    assert.equal(noCookie, '/?connector_error=STATE_MISMATCH')
    assert.equal(await activeConnectionCount(userId), 0)
  })

  test('非 oauth2 契约的 versionId 调 oauth/start → BAD_REQUEST', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId, slug } = await approvedConnector(staticTokenSpec, staticDecision, 'static')
    const userId = await mkUser()
    await assert.rejects(
      oauthStart(userId, versionId, slug),
      (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === 'BAD_REQUEST',
    )
    // 没落 pending,没落连接。
    const pending = await query('SELECT 1 FROM connector_oauth_pending WHERE user_id = $1', [
      userId,
    ])
    assert.equal(pending.rowCount, 0)
    assert.equal(await activeConnectionCount(userId), 0)
  })

  test('oauth2 契约走直填 bind → BAD_REQUEST(直绑禁止,必须走授权流)', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId } = await approvedConnector(oauth2Spec, oauth2Decision, 'directbind')
    const userId = await mkUser()
    await assert.rejects(
      bindDeclarativeConnector(
        {
          userId,
          connectorVersionId: versionId,
          // 攻击者即便手里有一个 access_token,也无法经直填路径落库。
          secrets: {
            access_token: ACCESS_TOKEN,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
          },
          deps: { resolver: okResolver(), fetchImpl: localFetch(server.port) },
        },
        getPool(),
      ),
      (e: unknown) => e instanceof ConnectorError && e.code === 'BAD_REQUEST',
    )
    assert.equal(await activeConnectionCount(userId), 0)
  })
})
