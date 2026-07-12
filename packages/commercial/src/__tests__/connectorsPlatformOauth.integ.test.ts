/**
 * 连接器平台 · **平台自有 OAuth App(clientProvisioning='platform')端到端**(真 PG + 受控本地上游)。
 *
 * 对照组是 connectorsOauth2Flow.integ(BYOA:用户自己填 client_id/client_secret)。本文件锁死
 * "平台注册 App、用户一键授权"这条新路径的三件事:
 *
 *   ① **一键授权端到端**:admin provision 平台 app → 用户 POST oauth/start(body **不带**任何
 *      client 凭据)→ authorize URL 里是**平台的 client_id** → 回调换 token(mock token 端点)
 *      → identity 探针 → 连接落库。
 *   ② **client_secret 的流向**(本文件的核心价值):平台 secret **只**出现在
 *      「平台表密文」+「发往 token origin 的那一次交换请求 body」。它 **grep 不到** 于:
 *        - pending draft 密文(platform 模式压根不落 client 凭据);
 *        - 用户连接密文 connections.secret_enc(袋里只有 access_token[+refresh_token]);
 *        - authorize URL / api origin 的探针请求;
 *        - admin 列表 API 的响应(结构上就不返回 secret)。
 *   ③ **fail-closed**:platform 模式但未 provision → oauth/start 503 OAUTH_NOT_CONFIGURED,
 *      且该连接器**不出现在 catalog**;provision 之后两者同时恢复。
 *
 * 另含 platformOauthApps 存储层的加解密 roundtrip / AAD 绑定 / 列表不含 secret。
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
process.env.OC_CONNECTORS_OAUTH_REDIRECT_URI =
  'https://app.platoauth.test/api/connectors/oauth/callback'

import { signAccess } from '../auth/jwt.js'
import { decryptBagFromRow, getDeclarativeConnection } from '../connectors/engine/binding.js'
import { listDeclarativeCatalog } from '../connectors/engine/catalog.js'
import type { EngineHttpDeps } from '../connectors/engine/driver.js'
import { dispatchConnectorsRoute } from '../connectors/handlers.js'
import { oauthCookieName } from '../connectors/oauthPending.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import {
  deletePlatformOauthApp,
  getPlatformOauthApp,
  hasPlatformOauthApp,
  listPlatformOauthApps,
  upsertPlatformOauthApp,
} from '../connectors/platformOauthApps.js'
import { canonicalSha256Hex } from '../connectors/spec/canonical.js'
import { loadVerifiedContractWithMeta, securityApprove } from '../connectors/spec/review.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import type { CommercialHttpDeps, RequestContext } from '../http/handlers.js'
import { HttpError } from '../http/util.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const PUBLIC_IP = '93.184.216.34'
const JWT_SECRET = 'test-jwt-secret-platform-oauth-0123456789abcdef'

/** canary:**平台** OAuth App 的 client_secret。跑完只许出现在平台表密文 + token 请求 body。 */
const PLATFORM_CLIENT_SECRET = 'PS-CANARY-4c9e12b7-DO-NOT-LEAK-ffeeddccbbaa9988'
const PLATFORM_CLIENT_ID = 'platform-cid-xyz789'
const ACCESS_TOKEN = 'AT-CANARY-91af3d20-DO-NOT-LEAK-1122334455667788'
const REFRESH_TOKEN = 'RT-CANARY-6b0c8e51-DO-NOT-LEAK-99aabbccddeeff00'

const AUTHZ_ORIGIN = 'https://auth.platoauth.test:443'
const TOKEN_ORIGIN = 'https://token.platoauth.test:443'
const API_ORIGIN = 'https://api.platoauth.test:443'
const AUTHORIZE_ENDPOINT = 'https://auth.platoauth.test/oauth/authorize'
const TOKEN_ENDPOINT = 'https://token.platoauth.test/oauth/token'

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

// ─── 受控本地上游(token origin + api origin,按 path 分流) ────────────────

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
          res.statusCode = 200
          res.end(JSON.stringify({ id: 'PU-4242', login: 'platform-user' }))
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
      host: 'app.platoauth.test',
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

// ─── fixture:platform / byoa 两个 oauth2 连接器 ─────────────────────────────

function oauth2Spec(slug: string, provisioning: 'platform' | 'byoa'): Record<string, unknown> {
  return {
    id: slug,
    label: 'Demo Platform OAuth2',
    description: 'oauth2 connector with platform-provisioned client app',
    authMode: 'oauth2-auth-code',
    auth: {
      authorizeEndpoint: AUTHORIZE_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      clientProvisioning: provisioning,
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

const oauth2Decision = {
  audience: {
    authorizationOrigins: [AUTHZ_ORIGIN],
    tokenOrigins: [TOKEN_ORIGIN],
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
    [`plat-u${seq}-${Date.now()}@t.local`, role],
  )
  return Number(r.rows[0]!.id)
}

async function approvedConnector(
  provisioning: 'platform' | 'byoa',
  prefix: string,
): Promise<{ versionId: number; slug: string }> {
  seq += 1
  const slug = `${prefix}-${seq}-${Date.now() % 1_000_000}`
  const spec = oauth2Spec(slug, provisioning)
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
    securityDecision: oauth2Decision,
    expectedSpecHash: specHash,
    pool: getPool(),
  })
  return { versionId, slug }
}

async function bearerFor(userId: number): Promise<string> {
  const { token } = await signAccess({ sub: String(userId), role: 'user' }, JWT_SECRET)
  return `Bearer ${token}`
}

function cookieValue(headers: Record<string, string | string[] | number>, name: string): string {
  const raw = headers['Set-Cookie']
  const lines = Array.isArray(raw) ? raw : [String(raw)]
  for (const line of lines) {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(line)
    if (m?.[1]) return decodeURIComponent(m[1])
  }
  throw new Error(`cookie ${name} not found`)
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
  await runMigrations() // 含 0136 平台 OAuth App 表
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

/** oauth/start(**platform 模式:body 只有 versionId,不带任何 client 凭据**)。 */
async function oauthStart(
  userId: number,
  versionId: number,
  slug: string,
  extraBody: Record<string, unknown> = {},
): Promise<{ authorizeUrl: string; state: string; cookieNonce: string }> {
  const res = makeRes()
  await dispatchConnectorsRoute(
    makeReq({
      method: 'POST',
      url: '/api/connectors/declarative/oauth/start',
      authorization: await bearerFor(userId),
      body: { versionId, ...extraBody },
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

async function oauthCallback(opts: {
  state: string
  code: string
  cookie: string
}): Promise<string> {
  const res = makeRes()
  const url = `/api/connectors/oauth/callback?state=${encodeURIComponent(opts.state)}&code=${encodeURIComponent(opts.code)}`
  await dispatchConnectorsRoute(
    makeReq({ method: 'GET', url, cookie: opts.cookie }),
    res.res,
    makeCtx(),
    deps,
  )
  assert.equal(res.statusCode, 302)
  return String(res.headers.Location)
}

// ─── ① 存储层 ───────────────────────────────────────────────────────────────

describe('platformOauthApps · 存储层', () => {
  test('加解密 roundtrip:密文里 grep 不到 secret 明文;list 不含 secret;delete 生效', async (t) => {
    if (skipIfNoDb(t)) return
    const admin = await mkUser('admin')
    const slug = `store-app-${Date.now() % 1_000_000}`

    assert.equal(await hasPlatformOauthApp(slug), false)
    assert.equal(await getPlatformOauthApp(slug), null)

    await upsertPlatformOauthApp(
      {
        slug,
        clientId: PLATFORM_CLIENT_ID,
        clientSecret: PLATFORM_CLIENT_SECRET,
        updatedBy: admin,
      },
      getPool(),
    )

    // roundtrip:解密回来的正是原文。
    const got = await getPlatformOauthApp(slug)
    assert.deepEqual(got, {
      clientId: PLATFORM_CLIENT_ID,
      clientSecret: PLATFORM_CLIENT_SECRET,
    })
    assert.equal(await hasPlatformOauthApp(slug), true)

    // 落库的是**密文**:整行(含所有 BYTEA)里 grep 不到 secret 明文。
    const row = await query<{
      client_secret_enc: Buffer
      client_secret_nonce: Buffer
      updated_by: string | null
    }>(
      'SELECT client_secret_enc, client_secret_nonce, updated_by::text AS updated_by FROM connector_platform_oauth_apps WHERE slug = $1',
      [slug],
    )
    assert.equal(row.rowCount, 1)
    const enc = row.rows[0]!.client_secret_enc
    assert.ok(enc.length >= 16, 'ciphertext carries GCM tag')
    assert.equal(enc.toString('latin1').includes(PLATFORM_CLIENT_SECRET), false)
    assert.equal(row.rows[0]!.client_secret_nonce.length, 12)
    assert.equal(row.rows[0]!.updated_by, String(admin))

    // 列表投影**永不含 secret**。
    const list = await listPlatformOauthApps()
    const entry = list.find((a) => a.slug === slug)
    assert.ok(entry)
    assert.deepEqual(Object.keys(entry!).sort(), ['clientId', 'slug', 'updatedAt'])
    assert.equal(JSON.stringify(list).includes(PLATFORM_CLIENT_SECRET), false)

    // 轮换:换 secret → 新 aad_seed,旧密文作废;读回是新值。
    const rotated = 'PS-ROTATED-0000-1111-2222'
    await upsertPlatformOauthApp(
      { slug, clientId: PLATFORM_CLIENT_ID, clientSecret: rotated, updatedBy: admin },
      getPool(),
    )
    assert.equal((await getPlatformOauthApp(slug))?.clientSecret, rotated)

    // 删除。
    assert.equal(await deletePlatformOauthApp(slug), true)
    assert.equal(await deletePlatformOauthApp(slug), false) // 幂等:第二次没删到
    assert.equal(await getPlatformOauthApp(slug), null)
  })

  test('AAD 绑 slug:密文被移植到别的 slug 行 → 解密必失败(不是静默返回垃圾)', async (t) => {
    if (skipIfNoDb(t)) return
    const a = `aad-a-${Date.now() % 1_000_000}`
    const b = `aad-b-${Date.now() % 1_000_000}`
    await upsertPlatformOauthApp({ slug: a, clientId: 'cid-a', clientSecret: 'secret-a' })
    await upsertPlatformOauthApp({ slug: b, clientId: 'cid-b', clientSecret: 'secret-b' })
    // 把 a 的密文 + nonce + aad_seed 整体搬到 b 行(模拟 DB 层跨行移植攻击)。
    await query(
      `UPDATE connector_platform_oauth_apps SET
         client_secret_enc = src.client_secret_enc,
         client_secret_nonce = src.client_secret_nonce,
         aad_seed = src.aad_seed
       FROM (SELECT client_secret_enc, client_secret_nonce, aad_seed
               FROM connector_platform_oauth_apps WHERE slug = $1) src
       WHERE connector_platform_oauth_apps.slug = $2`,
      [a, b],
    )
    // AAD 里带着 slug → 用 b 的 AAD 解 a 的密文,tag 必然对不上。
    await assert.rejects(getPlatformOauthApp(b), (e: unknown) => e instanceof Error)
  })
})

// ─── ② platform 模式端到端 ──────────────────────────────────────────────────

describe('oauth2 · clientProvisioning=platform 一键授权', () => {
  test('provision → start(零凭据 body)→ 回调 → 连接落库;client_secret 只在平台表+token 请求里', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId, slug } = await approvedConnector('platform', 'plat')
    const admin = await mkUser('admin')
    const userId = await mkUser()
    await upsertPlatformOauthApp(
      {
        slug,
        clientId: PLATFORM_CLIENT_ID,
        clientSecret: PLATFORM_CLIENT_SECRET,
        updatedBy: admin,
      },
      getPool(),
    )
    server.requests.length = 0

    // ① start:body **不带** clientId/clientSecret(用户什么都没填)。
    const started = await oauthStart(userId, versionId, slug, { displayName: '一键授权连接' })
    const au = new URL(started.authorizeUrl)
    // authorize URL 里的 client_id 是**平台的**(用户根本没机会指定)。
    assert.equal(au.searchParams.get('client_id'), PLATFORM_CLIENT_ID)
    assert.equal(au.searchParams.get('response_type'), 'code')
    assert.equal(au.searchParams.get('code_challenge_method'), 'S256')
    assert.ok((au.searchParams.get('code_challenge') ?? '').length > 0)
    // 平台 secret 绝不进 authorize URL。
    assert.equal(started.authorizeUrl.includes(PLATFORM_CLIENT_SECRET), false)
    assert.equal(server.requests.length, 0, 'start 不发网')

    // pending draft 密文里**没有** client 凭据(platform 模式压根不落它们)。
    const pending = await query<{ draft_enc: Buffer | null }>(
      'SELECT draft_enc FROM connector_oauth_pending WHERE user_id = $1',
      [userId],
    )
    assert.equal(pending.rowCount, 1)
    const draftEnc = pending.rows[0]!.draft_enc!
    assert.equal(draftEnc.toString('latin1').includes(PLATFORM_CLIENT_SECRET), false)
    assert.equal(draftEnc.toString('latin1').includes(PLATFORM_CLIENT_ID), false)

    // ② callback。
    const location = await oauthCallback({
      state: started.state,
      code: 'PLATFORM-CODE-abc',
      cookie: `${oauthCookieName(slug)}=${encodeURIComponent(started.cookieNonce)}`,
    })
    assert.equal(location, `/?connector_linked=${encodeURIComponent(slug)}`)

    // ③ 上游流量:平台 client 凭据**只**出现在发往 token origin 的 form body。
    const tokenReq = server.requests.find((r) => r.path === '/oauth/token')
    const probeReq = server.requests.find((r) => r.path === '/user')
    assert.ok(tokenReq && probeReq)
    const form = new URLSearchParams(tokenReq!.body)
    assert.equal(form.get('grant_type'), 'authorization_code')
    assert.equal(form.get('code'), 'PLATFORM-CODE-abc')
    assert.equal(form.get('client_id'), PLATFORM_CLIENT_ID)
    assert.equal(form.get('client_secret'), PLATFORM_CLIENT_SECRET) // ← 唯一出场处
    assert.ok((form.get('code_verifier') ?? '').length >= 43)
    // 受众隔离:api origin 的探针只带换回的 access_token,不含任何 client 凭据。
    assert.equal(probeReq!.authorization, `Bearer ${ACCESS_TOKEN}`)
    assert.equal(probeReq!.body.includes(PLATFORM_CLIENT_SECRET), false)
    assert.equal(probeReq!.body, '')

    // ④ 连接落库:密文里 grep 不到平台 secret / token。
    const conn = await query<{ id: string; secret_enc: Buffer; meta: Record<string, unknown> }>(
      `SELECT id::text AS id, secret_enc, meta FROM connections
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    )
    assert.equal(conn.rowCount, 1)
    const cipher = conn.rows[0]!.secret_enc.toString('latin1')
    assert.equal(cipher.includes(PLATFORM_CLIENT_SECRET), false)
    assert.equal(cipher.includes(ACCESS_TOKEN), false)
    assert.equal(conn.rows[0]!.meta.account_hint, 'platform-user')

    // ⑤ 解密后的袋 = platform 形状:**只有 access_token + refresh_token,零 client 凭据**。
    const meta = await loadVerifiedContractWithMeta(versionId, getPool())
    const declRow = await getDeclarativeConnection(conn.rows[0]!.id, userId, getPool())
    assert.ok(declRow)
    const bag = decryptBagFromRow(declRow!, meta.contract)
    assert.deepEqual(bag, { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN })
    assert.equal('client_id' in bag, false)
    assert.equal('client_secret' in bag, false)
  })

  test('platform 模式:body 里塞 clientId/clientSecret 一律**忽略**(权威只认平台表)', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId, slug } = await approvedConnector('platform', 'ignore')
    const userId = await mkUser()
    await upsertPlatformOauthApp({
      slug,
      clientId: PLATFORM_CLIENT_ID,
      clientSecret: PLATFORM_CLIENT_SECRET,
    })
    server.requests.length = 0

    // 攻击者试图用自己的 client_id 冒充平台应用(把用户导去自己的 OAuth app)。
    const started = await oauthStart(userId, versionId, slug, {
      clientId: 'ATTACKER-CID',
      clientSecret: 'ATTACKER-SECRET',
    })
    const au = new URL(started.authorizeUrl)
    // URL 里仍是平台 client_id —— body 的凭据字段被完全忽略。
    assert.equal(au.searchParams.get('client_id'), PLATFORM_CLIENT_ID)
    assert.equal(started.authorizeUrl.includes('ATTACKER-CID'), false)

    // 走完回调:token 交换用的也是平台凭据,不是攻击者塞的那对。
    await oauthCallback({
      state: started.state,
      code: 'code-ignore',
      cookie: `${oauthCookieName(slug)}=${encodeURIComponent(started.cookieNonce)}`,
    })
    const tokenReq = server.requests.find((r) => r.path === '/oauth/token')
    const form = new URLSearchParams(tokenReq!.body)
    assert.equal(form.get('client_id'), PLATFORM_CLIENT_ID)
    assert.equal(form.get('client_secret'), PLATFORM_CLIENT_SECRET)
    assert.equal(tokenReq!.body.includes('ATTACKER-SECRET'), false)
  })
})

// ─── ③ fail-closed ──────────────────────────────────────────────────────────

describe('oauth2 · platform 未 provision → fail-closed', () => {
  test('oauth/start → 503 OAUTH_NOT_CONFIGURED;且不落 pending', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId, slug } = await approvedConnector('platform', 'noprov')
    const userId = await mkUser()
    assert.equal(await hasPlatformOauthApp(slug), false)

    await assert.rejects(
      oauthStart(userId, versionId, slug),
      (e: unknown) =>
        e instanceof HttpError && e.status === 503 && e.code === 'OAUTH_NOT_CONFIGURED',
    )
    const pending = await query('SELECT 1 FROM connector_oauth_pending WHERE user_id = $1', [
      userId,
    ])
    assert.equal(pending.rowCount, 0)
  })

  test('catalog:未 provision 的 platform 连接器**不出现**;provision 后出现(byoa 始终在)', async (t) => {
    if (skipIfNoDb(t)) return
    const plat = await approvedConnector('platform', 'catalog-plat')
    const byoa = await approvedConnector('byoa', 'catalog-byoa')

    // 未 provision:目录里没有 platform 那条(用户不该看见"点了必报错"的连接器)。
    const before = await listDeclarativeCatalog(getPool())
    assert.equal(
      before.some((c) => c.slug === plat.slug),
      false,
    )
    // byoa 不受影响,且仍要求用户直填 client 凭据。
    const byoaEntry = before.find((c) => c.slug === byoa.slug)
    assert.ok(byoaEntry)
    assert.deepEqual(byoaEntry!.requiredBindSources, ['client_id', 'client_secret'])
    // 目录显式给出模式(前端据此渲染 BYOA 表单 / 一键授权按钮,不靠反推空数组)。
    assert.equal(byoaEntry!.clientProvisioning, 'byoa')

    // provision 之后:platform 条目出现,且 requiredBindSources = [](一键授权,零表单字段)。
    await upsertPlatformOauthApp({
      slug: plat.slug,
      clientId: PLATFORM_CLIENT_ID,
      clientSecret: PLATFORM_CLIENT_SECRET,
    })
    const afterProvision = await listDeclarativeCatalog(getPool())
    const platEntry = afterProvision.find((c) => c.slug === plat.slug)
    assert.ok(platEntry, 'platform connector appears after provisioning')
    assert.deepEqual(platEntry!.requiredBindSources, [])
    assert.equal(platEntry!.authMode, 'oauth2-auth-code')
    assert.equal(platEntry!.clientProvisioning, 'platform')

    // 反 provision:又消失(admin 撤销 = 立刻停止新授权)。
    await deletePlatformOauthApp(plat.slug)
    const afterDelete = await listDeclarativeCatalog(getPool())
    assert.equal(
      afterDelete.some((c) => c.slug === plat.slug),
      false,
    )
  })

  test('授权中途 admin 删了平台 app → 回调 fail-closed(不落连接,不降级用 draft)', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId, slug } = await approvedConnector('platform', 'midrace')
    const userId = await mkUser()
    await upsertPlatformOauthApp({
      slug,
      clientId: PLATFORM_CLIENT_ID,
      clientSecret: PLATFORM_CLIENT_SECRET,
    })
    const started = await oauthStart(userId, versionId, slug)

    // 用户在授权页期间,admin 撤销了平台 app。
    await deletePlatformOauthApp(slug)

    const location = await oauthCallback({
      state: started.state,
      code: 'code-midrace',
      cookie: `${oauthCookieName(slug)}=${encodeURIComponent(started.cookieNonce)}`,
    })
    // OAUTH_NOT_CONFIGURED → wire 码 OAUTH_START_FAILED;绝不落连接。
    assert.equal(location, '/?connector_error=OAUTH_START_FAILED')
    const conn = await query(
      'SELECT 1 FROM connections WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    )
    assert.equal(conn.rowCount, 0)
  })
})
