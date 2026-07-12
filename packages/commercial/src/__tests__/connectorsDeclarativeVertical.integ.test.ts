/**
 * 连接器平台 · 声明式首垂直(static-token + Notion)端到端集成测试(真 PG + 受控本地上游)。
 *
 * 证明完整信任链(RFC §8b slice③):
 *   作者声明 spec → reviewer 编译签名成 exec_contract → 用户 bind(identityProbe 验 token +
 *   派生账号 + 加密落 pin 连接)→ execute read(引擎唯一 HTTP 出口注入凭据 + 结果 allowlist)。
 *
 * 不变量断言:
 *   - 凭据只由引擎 driver 注入(Authorization: Bearer <token> 出现在**发往上游**的请求头);
 *   - 凭据**绝不**出现在返回结果 / 错误 / 连接行明文里(token 是 canary,跑完 grep 不到);
 *   - 结果按签进 contract 的 result schema **allowlist 剥字段**(上游多返回的 secret_field 丢弃);
 *   - 连接行钉死四个 pin(connector_version_id / spec_hash / exec_contract_hash / auth_contract_version);
 *   - write effect action 在只读切片被 fail-closed(slice④ 才接确认门);
 *   - 跨用户读 → CONNECTION_NOT_FOUND;version revoke 后读 → RELINK_REQUIRED;
 *   - bind 时上游 401 → UPSTREAM_AUTH_FAILED(token 无效不落库)。
 *
 * 无 PG → skip(REQUIRE_TEST_DB=1 时硬失败),照仓内 integ 惯例。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { fetch as undiciFetch } from 'undici'

// KMS key 必须在任何 sign/verify/encrypt 前就位。
process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')

import { ConnectorError } from '../connectors/errors.js'
import { bindDeclarativeConnector } from '../connectors/engine/bind.js'
import type { EngineHttpDeps } from '../connectors/engine/driver.js'
import { executeDeclarativeAction } from '../connectors/engine/execute.js'
import {
  executeDeclarativeWrite,
  proposeDeclarativeWrite,
} from '../connectors/engine/write.js'
import { approveConfirmation } from '../connectors/ledger.js'
import { canonicalSha256Hex } from '../connectors/spec/canonical.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import { revokeExecVersion, securityApprove } from '../connectors/spec/review.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

/** canary:既作用户 token(凭据),又验证绝不外泄。 */
const TOKEN = 'DECL-TOKEN-CANARY-9f3a2b17-DO-NOT-LEAK-0123456789abcdef'
const PUBLIC_IP = '93.184.216.34'
const API_ORIGIN = 'https://api.notion.test:443'

let pgAvailable = false

async function probe(): Promise<boolean> {
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
  const name = db.rows[0]?.db ?? ''
  if (!/_test$/.test(name)) throw new Error(`refusing to drop tables on non-test database: ${name}`)
  await query(`
    DO $$ DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `)
}

// ─── 受控本地上游 ────────────────────────────────────────────────────────────

interface Captured {
  method: string
  path: string
  authorization: string | undefined
  body: string
}
interface TestServer {
  port: number
  requests: Captured[]
  setHandler(fn: (p: string) => { status: number; body: string }): void
  reset(): void
  close(): Promise<void>
}

function startServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const requests: Captured[] = []
    let handler: (p: string) => { status: number; body: string } = () => ({
      status: 200,
      body: '{}',
    })
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
        const out = handler(u.pathname)
        res.statusCode = out.status
        res.setHeader('content-type', 'application/json')
        res.end(out.body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        port,
        requests,
        setHandler: (fn) => {
          handler = fn
        },
        reset: () => {
          // 只清请求日志,保留 handler(避免 reset 后忘记重设 handler 的坑)。
          requests.length = 0
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

/** 把 driver 的 https 目标改写到本地 http 服务器(保留 path/headers)。 */
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

// ─── 声明式 spec fixture(带 identity 块 + whoami/get_page/create_page) ──────────

function notionSpec(slug: string): Record<string, unknown> {
  return {
    id: slug,
    label: 'Notion',
    description: 'notion declarative connector',
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
        request: { method: 'GET', pathTemplate: '/v1/users/me' },
        params: { type: 'object', additionalProperties: false },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { bot_id: { type: 'string' }, workspace_name: { type: 'string' } },
        },
        usesSlot: 'api-token',
      },
      {
        id: 'get_page',
        description: 'get a page',
        request: { method: 'GET', pathTemplate: '/v1/pages/{/params/pageId}' },
        params: {
          type: 'object',
          additionalProperties: false,
          properties: { pageId: { type: 'string' } },
          required: ['pageId'],
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' }, title: { type: 'string' } },
        },
        usesSlot: 'api-token',
      },
      {
        id: 'create_page',
        description: 'create a page (write — gated until slice④)',
        request: { method: 'POST', pathTemplate: '/v1/pages' },
        params: { type: 'object', additionalProperties: false },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' } },
        },
        usesSlot: 'api-token',
      },
    ],
    identity: {
      probeActionId: 'whoami',
      accountKeyPointer: '/bot_id',
      accountHintPointer: '/workspace_name',
    },
  }
}

const decision = {
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
    [`decl-u${seq}-${Date.now()}@t.local`, role],
  )
  return Number(r.rows[0]!.id)
}

/** 建 listing+version 并 securityApprove → 返回可绑定的 versionId + 本地编译产物。 */
async function approvedConnector(): Promise<{
  versionId: number
  slug: string
  specHash: string
  execContractHash: string
}> {
  seq += 1
  const slug = `notion-${seq}-${Date.now() % 1_000_000}`
  const spec = notionSpec(slug)
  const author = await mkUser()
  const reviewer = await mkUser('admin')
  const raw = JSON.stringify(spec)
  const specHash = canonicalSha256Hex(spec)
  await query('INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind) VALUES ($1,$2,$3)', [
    slug,
    author,
    'connector',
  ])
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
  const local = compileSpec(spec, decision)
  return { versionId, slug, specHash, execContractHash: local.execContractHash }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await query('CREATE SCHEMA IF NOT EXISTS public')
  await dropAllTables()
  await runMigrations() // 全量迁移含 0136
})

after(async () => {
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

function isConnErr(code: string) {
  return (e: unknown) => e instanceof ConnectorError && e.code === code
}

/** probe /v1/users/me 返回身份(含上游多塞的 leak 字段);其余路径按传入 handler。 */
function identityHandler(
  onOther?: (p: string) => { status: number; body: string },
): (p: string) => { status: number; body: string } {
  return (p) => {
    if (p === '/v1/users/me')
      return {
        status: 200,
        body: JSON.stringify({
          bot_id: 'bot-abc',
          workspace_name: 'My Workspace',
          leak_field: 'SHOULD-BE-STRIPPED',
        }),
      }
    return onOther?.(p) ?? { status: 404, body: '{}' }
  }
}

async function connectionRow(id: string): Promise<Record<string, unknown> | undefined> {
  const r = await query<Record<string, unknown>>(
    `SELECT provider, connector_version_id::text AS cvid,
            encode(spec_hash,'hex') AS sh, encode(exec_contract_hash,'hex') AS eh,
            auth_contract_version AS acv, (secret_enc IS NOT NULL) AS has_secret,
            secret_enc, meta, status
       FROM connections WHERE id = $1::bigint`,
    [id],
  )
  return r.rows[0]
}

// ─── 主链:bind → execute(happy path + 不变量) ──────────────────────────────

describe('声明式首垂直 static-token+Notion', () => {
  test('bind(identityProbe)→ 加密 pin 连接;execute(read)→ allowlist 结果;凭据不泄漏', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const conn = await approvedConnector()
      const user = await mkUser()
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }

      // ── bind ──────────────────────────────────────────────────────────────
      server.setHandler(identityHandler())
      const bind = await bindDeclarativeConnector(
        { userId: user, connectorVersionId: conn.versionId, secrets: { access_token: TOKEN }, deps },
        getPool(),
      )
      assert.equal(bind.rebound, false)
      assert.equal(bind.accountHint, 'My Workspace')
      // probe 请求带 driver 注入的 Authorization: Bearer <token>,打到 /v1/users/me。
      assert.equal(server.requests.length, 1)
      assert.equal(server.requests[0]!.path, '/v1/users/me')
      assert.equal(server.requests[0]!.authorization, `Bearer ${TOKEN}`)

      // ── 连接行:四个 pin 落齐 + secret 加密 + meta hint;明文里绝无 token ──────
      const row = await connectionRow(bind.connectionId)
      assert.ok(row)
      assert.equal(row.provider, conn.slug) // provider = listing slug(0136 放开)
      assert.equal(row.cvid, String(conn.versionId))
      assert.equal(row.sh, conn.specHash)
      assert.equal(row.eh, conn.execContractHash)
      assert.equal(Number(row.acv), 1)
      assert.equal(row.has_secret, true)
      assert.equal((row.meta as Record<string, unknown>).account_hint, 'My Workspace')
      // 密文列不得含明文 token。
      assert.ok(!(row.secret_enc as Buffer).toString('latin1').includes(TOKEN))

      // ── execute read:上游多返回 secret_field,应被 allowlist 剥 ──────────────
      server.reset()
      server.setHandler((p) =>
        p === '/v1/pages/page-1'
          ? {
              status: 200,
              body: JSON.stringify({ id: 'page-1', title: 'Hello', secret_field: 'LEAK-X' }),
            }
          : { status: 404, body: '{}' },
      )
      const out = await executeDeclarativeAction(
        { connectionId: bind.connectionId, userId: user, actionId: 'get_page', params: { pageId: 'page-1' }, deps },
        getPool(),
      )
      assert.deepEqual(out, { id: 'page-1', title: 'Hello' }) // secret_field 剥掉
      assert.equal(server.requests[0]!.path, '/v1/pages/page-1') // path 占位符 materialize
      assert.equal(server.requests[0]!.authorization, `Bearer ${TOKEN}`)
      // 结果里绝无 token。
      assert.ok(!JSON.stringify(out).includes(TOKEN))
    } finally {
      await server.close()
    }
  })

  test('write effect action 在只读切片 fail-closed(BAD_REQUEST)', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const conn = await approvedConnector()
      const user = await mkUser()
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      server.setHandler(identityHandler())
      const bind = await bindDeclarativeConnector(
        { userId: user, connectorVersionId: conn.versionId, secrets: { access_token: TOKEN }, deps },
        getPool(),
      )
      server.reset()
      await assert.rejects(
        executeDeclarativeAction(
          { connectionId: bind.connectionId, userId: user, actionId: 'create_page', params: {}, deps },
          getPool(),
        ),
        isConnErr('BAD_REQUEST'),
      )
      // write 被拒 → 根本没打上游。
      assert.equal(server.requests.length, 0)
    } finally {
      await server.close()
    }
  })

  test('跨用户读 → CONNECTION_NOT_FOUND', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const conn = await approvedConnector()
      const owner = await mkUser()
      const other = await mkUser()
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      server.setHandler(identityHandler())
      const bind = await bindDeclarativeConnector(
        { userId: owner, connectorVersionId: conn.versionId, secrets: { access_token: TOKEN }, deps },
        getPool(),
      )
      await assert.rejects(
        executeDeclarativeAction(
          { connectionId: bind.connectionId, userId: other, actionId: 'get_page', params: { pageId: 'p' }, deps },
          getPool(),
        ),
        isConnErr('CONNECTION_NOT_FOUND'),
      )
    } finally {
      await server.close()
    }
  })

  test('version revoke 后读 → RELINK_REQUIRED(fail-closed,须重绑)', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const conn = await approvedConnector()
      const user = await mkUser()
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      server.setHandler(identityHandler())
      const bind = await bindDeclarativeConnector(
        { userId: user, connectorVersionId: conn.versionId, secrets: { access_token: TOKEN }, deps },
        getPool(),
      )
      await revokeExecVersion(conn.versionId, getPool())
      await assert.rejects(
        executeDeclarativeAction(
          { connectionId: bind.connectionId, userId: user, actionId: 'get_page', params: { pageId: 'p' }, deps },
          getPool(),
        ),
        isConnErr('RELINK_REQUIRED'),
      )
    } finally {
      await server.close()
    }
  })

  test('bind 时上游 401 → UPSTREAM_AUTH_FAILED,不落连接', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const conn = await approvedConnector()
      const user = await mkUser()
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      server.setHandler(() => ({ status: 401, body: '{}' }))
      await assert.rejects(
        bindDeclarativeConnector(
          { userId: user, connectorVersionId: conn.versionId, secrets: { access_token: TOKEN }, deps },
          getPool(),
        ),
        isConnErr('UPSTREAM_AUTH_FAILED'),
      )
      const cnt = await query<{ n: string }>(
        'SELECT count(*)::text AS n FROM connections WHERE user_id = $1',
        [user],
      )
      assert.equal(cnt.rows[0]!.n, '0')
    } finally {
      await server.close()
    }
  })

  test('同账号重绑 rebound=true,仅一条活跃行', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const conn = await approvedConnector()
      const user = await mkUser()
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      server.setHandler(identityHandler())
      const first = await bindDeclarativeConnector(
        { userId: user, connectorVersionId: conn.versionId, secrets: { access_token: TOKEN }, deps },
        getPool(),
      )
      const second = await bindDeclarativeConnector(
        { userId: user, connectorVersionId: conn.versionId, secrets: { access_token: `${TOKEN}-v2` }, deps },
        getPool(),
      )
      assert.equal(first.rebound, false)
      assert.equal(second.rebound, true)
      const active = await query<{ n: string }>(
        'SELECT count(*)::text AS n FROM connections WHERE user_id = $1 AND revoked_at IS NULL',
        [user],
      )
      assert.equal(active.rows[0]!.n, '1')
    } finally {
      await server.close()
    }
  })
})

// ─── 写门:propose → approve → ledger-pinned execute(slice④) ───────────────────

/** 绑一条连接并返回 connectionId(内部消化 bind 的 probe 请求)。 */
async function boundConnection(
  server: TestServer,
  deps: EngineHttpDeps,
): Promise<{ connectionId: string; userId: number; versionId: number }> {
  const conn = await approvedConnector()
  const userId = await mkUser()
  server.setHandler(identityHandler())
  const bind = await bindDeclarativeConnector(
    { userId, connectorVersionId: conn.versionId, secrets: { access_token: TOKEN }, deps },
    getPool(),
  )
  server.reset()
  return { connectionId: bind.connectionId, userId, versionId: conn.versionId }
}

describe('声明式写门 propose→approve→execute', () => {
  test('happy path:propose 不 dispatch;approve 后 execute 发写 + allowlist + 幂等 replay', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      const { connectionId, userId } = await boundConnection(server, deps)

      // ── propose:确定性 plan-diff,绝不 dispatch ──────────────────────────────
      const prop = await proposeDeclarativeWrite(
        { connectionId, userId, actionId: 'create_page', params: {} },
        getPool(),
      )
      assert.equal(prop.effect, 'write')
      assert.equal(prop.plan.method, 'POST')
      assert.equal(prop.plan.path, '/v1/pages')
      assert.equal(server.requests.length, 0) // propose 不打上游

      // ── 未 approve 直接 execute → CONFIRMATION_NOT_APPROVED ────────────────────
      await assert.rejects(
        executeDeclarativeWrite({ connectionId, userId, confirmId: prop.confirmId, deps }, getPool()),
        isConnErr('CONFIRMATION_NOT_APPROVED'),
      )

      // ── approve → execute:发 POST /v1/pages + Bearer;结果 allowlist ─────────
      await approveConfirmation(prop.confirmId, userId, getPool())
      server.setHandler((p) =>
        p === '/v1/pages'
          ? { status: 200, body: JSON.stringify({ id: 'new-page', secret_field: 'LEAK-Y' }) }
          : { status: 404, body: '{}' },
      )
      const exec = await executeDeclarativeWrite(
        { connectionId, userId, confirmId: prop.confirmId, deps },
        getPool(),
      )
      assert.equal(exec.kind, 'ok')
      assert.deepEqual((exec as { result: unknown }).result, { id: 'new-page' }) // secret_field 剥掉
      assert.equal(server.requests.length, 1)
      assert.equal(server.requests[0]!.method, 'POST')
      assert.equal(server.requests[0]!.path, '/v1/pages')
      assert.equal(server.requests[0]!.authorization, `Bearer ${TOKEN}`)

      // ── 幂等 replay:同 confirmId 再 execute → replay,不二次 dispatch ─────────
      const replay = await executeDeclarativeWrite(
        { connectionId, userId, confirmId: prop.confirmId, deps },
        getPool(),
      )
      assert.equal(replay.kind, 'replay')
      assert.equal((replay as { status: string }).status, 'succeeded')
      assert.equal(server.requests.length, 1) // 仍是 1,未重发
    } finally {
      await server.close()
    }
  })

  test('read action 走 propose → BAD_REQUEST(读无需确认)', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      const { connectionId, userId } = await boundConnection(server, deps)
      await assert.rejects(
        proposeDeclarativeWrite(
          { connectionId, userId, actionId: 'get_page', params: { pageId: 'p' } },
          getPool(),
        ),
        isConnErr('BAD_REQUEST'),
      )
    } finally {
      await server.close()
    }
  })

  test('confirmId 张冠李戴到别的连接 execute → BAD_REQUEST(账本绑定校验)', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      const a = await boundConnection(server, deps)
      // 第二条连接(同一 user 便于对照,不同 connectionId)。
      server.setHandler(identityHandler())
      const conn2 = await approvedConnector()
      const bind2 = await bindDeclarativeConnector(
        { userId: a.userId, connectorVersionId: conn2.versionId, secrets: { access_token: `${TOKEN}-2` }, deps },
        getPool(),
      )
      server.reset()
      const prop = await proposeDeclarativeWrite(
        { connectionId: a.connectionId, userId: a.userId, actionId: 'create_page', params: {} },
        getPool(),
      )
      await approveConfirmation(prop.confirmId, a.userId, getPool())
      // 用 conn2 的 connectionId 执行 conn1 的 confirmId → 账本行 connection_id 不匹配。
      await assert.rejects(
        executeDeclarativeWrite(
          { connectionId: bind2.connectionId, userId: a.userId, confirmId: prop.confirmId, deps },
          getPool(),
        ),
        isConnErr('BAD_REQUEST'),
      )
    } finally {
      await server.close()
    }
  })
})

// ─── token-exchange 垂直(slice⑤ token 引擎:凭据→交换→缓存→注入) ─────────────

/** 交换凭据 canary:client_secret 只能出现在发往 /token 的 body,绝不进 API 请求。 */
const CLIENT_SECRET = 'EXCH-SECRET-CANARY-7a1b2c3d-DO-NOT-LEAK'
/** 交换换回的短寿命 access_token(≠ 上面的 secret)。 */
const EXCHANGED = 'EXCHANGED-ACCESS-abc123def456'

function tokenExchangeSpecFixture(slug: string): Record<string, unknown> {
  return {
    id: slug,
    label: 'Feishu-like',
    description: 'tenant token exchange connector',
    authMode: 'token-exchange',
    auth: {
      exchangeRequest: {
        method: 'POST',
        path: '/token',
        encoding: 'json',
        credentialFieldNames: { app_id: 'client_id', app_secret: 'client_secret' },
        staticFields: {},
      },
      tokenResponse: {},
      tokenOutputs: { accessToken: '/access_token', expiresIn: '/expires_in' },
      apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
    },
    originMode: 'fixed-reviewed',
    credentialPipeline: {
      nodes: [
        { id: 'tenant-token', authMode: 'token-exchange', subject: 'app', audience: 'token' },
        {
          id: 'api-cred',
          authMode: 'token-exchange',
          subject: 'app',
          audience: 'api',
          dependsOn: ['tenant-token'],
        },
      ],
    },
    actions: [
      {
        id: 'whoami',
        description: 'identity probe',
        request: { method: 'GET', pathTemplate: '/v1/users/me' },
        params: { type: 'object', additionalProperties: false },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { bot_id: { type: 'string' }, workspace_name: { type: 'string' } },
        },
        usesSlot: 'api-cred',
      },
      {
        id: 'get_page',
        description: 'get a page',
        request: { method: 'GET', pathTemplate: '/v1/pages/{/params/pageId}' },
        params: {
          type: 'object',
          additionalProperties: false,
          properties: { pageId: { type: 'string' } },
          required: ['pageId'],
        },
        result: {
          type: 'object',
          additionalProperties: false,
          properties: { id: { type: 'string' }, title: { type: 'string' } },
        },
        usesSlot: 'api-cred',
      },
    ],
    identity: {
      probeActionId: 'whoami',
      accountKeyPointer: '/bot_id',
      accountHintPointer: '/workspace_name',
    },
  }
}

const txDecision = {
  audience: {
    authorizationOrigins: [],
    tokenOrigins: [API_ORIGIN],
    apiOrigins: [API_ORIGIN],
    unauthenticatedUploadOrigins: [],
  },
  actions: {},
}

async function approvedTokenExchange(): Promise<{ versionId: number; slug: string }> {
  seq += 1
  const slug = `feishu-${seq}-${Date.now() % 1_000_000}`
  const spec = tokenExchangeSpecFixture(slug)
  const author = await mkUser()
  const reviewer = await mkUser('admin')
  const raw = JSON.stringify(spec)
  const specHash = canonicalSha256Hex(spec)
  await query('INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind) VALUES ($1,$2,$3)', [
    slug,
    author,
    'connector',
  ])
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
    securityDecision: txDecision,
    expectedSpecHash: specHash,
    pool: getPool(),
  })
  return { versionId, slug }
}

/** /token 返回可配 access_token+expires_in;/v1/users/me 身份;/v1/pages/* 页。 */
function exchangeHandler(expiresIn: number): (p: string) => { status: number; body: string } {
  return (p) => {
    if (p === '/token')
      return { status: 200, body: JSON.stringify({ access_token: EXCHANGED, expires_in: expiresIn }) }
    if (p === '/v1/users/me')
      return { status: 200, body: JSON.stringify({ bot_id: 'bot-x', workspace_name: 'WS' }) }
    if (p.startsWith('/v1/pages/'))
      return { status: 200, body: JSON.stringify({ id: p.split('/').pop(), title: 'T', secret: 'LEAK' }) }
    return { status: 404, body: '{}' }
  }
}

function countPath(server: TestServer, path: string): number {
  return server.requests.filter((r) => r.path === path).length
}

describe('声明式 token-exchange 垂直', () => {
  test('bind 换 token 跑探针;execute 换+缓存+注入;client_secret 只进 /token', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      const { versionId } = await approvedTokenExchange()
      const user = await mkUser()

      // ── bind:交换 → 探针 ────────────────────────────────────────────────────
      server.setHandler(exchangeHandler(7200))
      const bind = await bindDeclarativeConnector(
        {
          userId: user,
          connectorVersionId: versionId,
          secrets: { client_id: 'app-1', client_secret: CLIENT_SECRET },
          deps,
        },
        getPool(),
      )
      assert.equal(bind.accountHint, 'WS')
      const tokenReq = server.requests.find((r) => r.path === '/token')
      assert.ok(tokenReq, 'exchange happened')
      assert.ok(tokenReq!.body.includes(CLIENT_SECRET), 'client_secret in /token body')
      const probeReq = server.requests.find((r) => r.path === '/v1/users/me')
      assert.equal(probeReq!.authorization, `Bearer ${EXCHANGED}`) // 探针用换回的 token

      // ── execute:缓存 miss → 再换一次 + 落缓存 → 注入 API ──────────────────────
      server.reset()
      const out1 = await executeDeclarativeAction(
        { connectionId: bind.connectionId, userId: user, actionId: 'get_page', params: { pageId: 'p1' }, deps },
        getPool(),
      )
      assert.deepEqual(out1, { id: 'p1', title: 'T' }) // secret 剥掉
      assert.equal(countPath(server, '/token'), 1) // 首次 execute 换一次
      const apiReq = server.requests.find((r) => r.path === '/v1/pages/p1')
      assert.equal(apiReq!.authorization, `Bearer ${EXCHANGED}`)

      // ── 第二次 execute:缓存命中 → 不再打 /token ──────────────────────────────
      server.reset()
      await executeDeclarativeAction(
        { connectionId: bind.connectionId, userId: user, actionId: 'get_page', params: { pageId: 'p2' }, deps },
        getPool(),
      )
      assert.equal(countPath(server, '/token'), 0) // 命中缓存,零交换
      assert.equal(countPath(server, '/v1/pages/p2'), 1)

      // ── 不变量:client_secret 绝不出现在任何 /v1/* 请求(header/body) ─────────
      for (const r of server.requests.filter((x) => x.path.startsWith('/v1/'))) {
        assert.ok(!(r.authorization ?? '').includes(CLIENT_SECRET))
        assert.ok(!r.body.includes(CLIENT_SECRET))
      }
    } finally {
      await server.close()
    }
  })

  test('token 近过期 → 每次 execute 重换(缓存 skew 生效)', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      const { versionId } = await approvedTokenExchange()
      const user = await mkUser()
      server.setHandler(exchangeHandler(10)) // 10s TTL < 60s skew → 恒视作过期
      const bind = await bindDeclarativeConnector(
        {
          userId: user,
          connectorVersionId: versionId,
          secrets: { client_id: 'app-1', client_secret: CLIENT_SECRET },
          deps,
        },
        getPool(),
      )
      server.reset()
      await executeDeclarativeAction(
        { connectionId: bind.connectionId, userId: user, actionId: 'get_page', params: { pageId: 'a' }, deps },
        getPool(),
      )
      await executeDeclarativeAction(
        { connectionId: bind.connectionId, userId: user, actionId: 'get_page', params: { pageId: 'b' }, deps },
        getPool(),
      )
      assert.equal(countPath(server, '/token'), 2) // 两次都重换(近过期)
    } finally {
      await server.close()
    }
  })

  test('bind 交换 401 → UPSTREAM_AUTH_FAILED 不落连接', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      const { versionId } = await approvedTokenExchange()
      const user = await mkUser()
      server.setHandler((p) => (p === '/token' ? { status: 401, body: '{}' } : { status: 404, body: '{}' }))
      await assert.rejects(
        bindDeclarativeConnector(
          {
            userId: user,
            connectorVersionId: versionId,
            secrets: { client_id: 'app-1', client_secret: CLIENT_SECRET },
            deps,
          },
          getPool(),
        ),
        isConnErr('UPSTREAM_AUTH_FAILED'),
      )
      const cnt = await query<{ n: string }>(
        'SELECT count(*)::text AS n FROM connections WHERE user_id = $1',
        [user],
      )
      assert.equal(cnt.rows[0]!.n, '0')
    } finally {
      await server.close()
    }
  })

  test('交换 200 但无 access_token → UPSTREAM_AUTH_FAILED', async (t) => {
    if (skipIfNoDb(t)) return
    const server = await startServer()
    try {
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      const { versionId } = await approvedTokenExchange()
      const user = await mkUser()
      server.setHandler((p) =>
        p === '/token' ? { status: 200, body: JSON.stringify({ code: 99991663 }) } : { status: 404, body: '{}' },
      )
      await assert.rejects(
        bindDeclarativeConnector(
          {
            userId: user,
            connectorVersionId: versionId,
            secrets: { client_id: 'app-1', client_secret: CLIENT_SECRET },
            deps,
          },
          getPool(),
        ),
        isConnErr('UPSTREAM_AUTH_FAILED'),
      )
    } finally {
      await server.close()
    }
  })
})
