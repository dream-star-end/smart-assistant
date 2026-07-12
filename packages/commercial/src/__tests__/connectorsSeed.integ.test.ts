/**
 * 默认连接器 seed 端到端(真 PG + 受控上游):seedDefaultConnectors → security_approved →
 * loadVerifiedContract 可载 → bind(identityProbe)→ execute read。证明"平台首方默认连接器"
 * 经完整审计路径落库后即可用,且 seed 幂等。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'
import { fetch as undiciFetch } from 'undici'

process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')

import { seedDefaultConnectors } from '../connectors/declarativeSeed.js'
import { bindDeclarativeConnector } from '../connectors/engine/bind.js'
import type { EngineHttpDeps } from '../connectors/engine/driver.js'
import { executeDeclarativeAction } from '../connectors/engine/execute.js'
import {
  executeDeclarativeWrite,
  proposeDeclarativeWrite,
} from '../connectors/engine/write.js'
import { approveConfirmation } from '../connectors/ledger.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { loadVerifiedContractWithMeta } from '../connectors/spec/review.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const PUBLIC_IP = '93.184.216.34'

let pgAvailable = false

async function dropAllTables(): Promise<void> {
  const db = await query<{ db: string }>('SELECT current_database() AS db')
  if (!/_test$/.test(db.rows[0]?.db ?? '')) throw new Error('refusing to drop non-test db')
  await query(`DO $$ DECLARE r RECORD; BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP
      EXECUTE 'DROP TABLE IF EXISTS public.'||quote_ident(r.tablename)||' CASCADE'; END LOOP; END $$;`)
}

interface CapturedRequest {
  path: string
  query: string
  body: string
}
interface TestServer {
  port: number
  setHandler(fn: (p: string) => { status: number; body: string }): void
  /** 最近一次收到的请求(path/query/原始 body),供写操作断言上游收到的体。 */
  lastRequest(): CapturedRequest | null
  close(): Promise<void>
}
function startServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    let handler: (p: string) => { status: number; body: string } = () => ({ status: 404, body: '{}' })
    let last: CapturedRequest | null = null
    const server: Server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        last = { path: u.pathname, query: u.search, body: Buffer.concat(chunks).toString('utf8') }
        const out = handler(u.pathname)
        res.statusCode = out.status
        res.setHeader('content-type', 'application/json')
        res.end(out.body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        setHandler: (fn) => {
          handler = fn
        },
        lastRequest: () => last,
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

async function mkUser(): Promise<number> {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, role)
     VALUES ($1,'x',TRUE,'user') RETURNING id::text AS id`,
    [`seed-u-${Date.now()}-${Math.floor(Number(process.hrtime.bigint() % 100000n))}@t.local`],
  )
  return Number(r.rows[0]!.id)
}

before(async () => {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    pgAvailable = true
  } catch {
    pgAvailable = false
  }
  await p.end().catch(() => {})
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await query('CREATE SCHEMA IF NOT EXISTS public')
  await dropAllTables()
  await runMigrations()
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

function skip(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not available')
    return true
  }
  return false
}

describe('默认连接器 seed', () => {
  test('seed 落 security_approved + 幂等 + 可载 + 可绑可读', async (t) => {
    if (skip(t)) return
    const server = await startServer()
    try {
      // ── seed ──────────────────────────────────────────────────────────────
      const first = await seedDefaultConnectors(getPool())
      assert.ok(first.seeded.includes('notion'), 'notion seeded')
      const second = await seedDefaultConnectors(getPool()) // 幂等
      assert.ok(second.skipped.includes('notion'), 'notion skipped on 2nd seed')
      assert.equal(second.seeded.length, 0)

      // 取 seeded 版本 id + 断言可载入验签。
      const v = await query<{ id: string }>(
        `SELECT id::text AS id FROM marketplace_skill_versions
          WHERE slug='notion' AND security_review_state='security_approved'`,
      )
      const versionId = Number(v.rows[0]!.id)
      const meta = await loadVerifiedContractWithMeta(versionId, getPool())
      assert.equal(meta.slug, 'notion')
      assert.equal(meta.contract.authMode, 'static-token')

      // ── bind(identityProbe 打 Notion /v1/users/me)+ read ────────────────
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      server.setHandler((p) => {
        if (p === '/v1/users/me')
          return { status: 200, body: JSON.stringify({ id: 'bot-1', bot: { workspace_name: 'WS' } }) }
        if (p === '/v1/pages/pg1')
          return { status: 200, body: JSON.stringify({ id: 'pg1', url: 'u', extra: 'LEAK' }) }
        return { status: 404, body: '{}' }
      })
      const user = await mkUser()
      const bind = await bindDeclarativeConnector(
        { userId: user, connectorVersionId: versionId, secrets: { access_token: 'ntn-secret-token' }, deps },
        getPool(),
      )
      assert.equal(bind.accountHint, 'WS')

      const page = await executeDeclarativeAction(
        { connectionId: bind.connectionId, userId: user, actionId: 'retrieve_page', params: { pageId: 'pg1' }, deps },
        getPool(),
      )
      // allowlist:extra 剥掉,只留声明的字段。
      assert.deepEqual(page, { id: 'pg1', url: 'u' })
    } finally {
      await server.close()
    }
  })

  test('飞书(token-exchange)默认:seed → bind(换 tenant token + bot 探针)', async (t) => {
    if (skip(t)) return
    const server = await startServer()
    try {
      await seedDefaultConnectors(getPool()) // 幂等
      const v = await query<{ id: string }>(
        `SELECT id::text AS id FROM marketplace_skill_versions
          WHERE slug='feishu' AND security_review_state='security_approved'`,
      )
      const versionId = Number(v.rows[0]!.id)
      const meta = await loadVerifiedContractWithMeta(versionId, getPool())
      assert.equal(meta.contract.authMode, 'token-exchange')

      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      const SECRET = 'FEISHU-APP-SECRET-CANARY'
      server.setHandler((p) => {
        if (p === '/open-apis/auth/v3/tenant_access_token/internal')
          return { status: 200, body: JSON.stringify({ code: 0, tenant_access_token: 't-abc', expire: 7200 }) }
        if (p === '/open-apis/bot/v3/info')
          return { status: 200, body: JSON.stringify({ code: 0, bot: { open_id: 'ou_1', app_name: 'MyBot' } }) }
        return { status: 404, body: '{}' }
      })
      const user = await mkUser()
      const bind = await bindDeclarativeConnector(
        {
          userId: user,
          connectorVersionId: versionId,
          secrets: { client_id: 'app-1', client_secret: SECRET },
          deps,
        },
        getPool(),
      )
      assert.equal(bind.accountHint, 'MyBot') // 从 /bot/app_name 派生

      // 连接密文里绝无 app_secret 明文。
      const row = await query<{ has: boolean; enc: Buffer }>(
        `SELECT (secret_enc IS NOT NULL) AS has, secret_enc AS enc FROM connections WHERE id=$1::bigint`,
        [bind.connectionId],
      )
      assert.equal(row.rows[0]!.has, true)
      assert.ok(!row.rows[0]!.enc.toString('latin1').includes(SECRET))
    } finally {
      await server.close()
    }
  })

  test('写对等:seed 的 notion create_page 走通写门(propose→approve→execute,嵌套体正确)', async (t) => {
    if (skip(t)) return
    const server = await startServer()
    try {
      await seedDefaultConnectors(getPool()) // 幂等
      const v = await query<{ id: string }>(
        `SELECT id::text AS id FROM marketplace_skill_versions
          WHERE slug='notion' AND security_review_state='security_approved'`,
      )
      const versionId = Number(v.rows[0]!.id)
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      server.setHandler((p) => {
        if (p === '/v1/users/me')
          return { status: 200, body: JSON.stringify({ id: 'bot-1', bot: { workspace_name: 'WS' } }) }
        if (p === '/v1/pages')
          return { status: 200, body: JSON.stringify({ id: 'new-pg', url: 'https://n/new', extra: 'LEAK' }) }
        return { status: 404, body: '{}' }
      })
      const user = await mkUser()
      const bind = await bindDeclarativeConnector(
        { userId: user, connectorVersionId: versionId, secrets: { access_token: 'ntn-tok' }, deps },
        getPool(),
      )
      // bind 只打了 whoami 探针,尚未碰 /v1/pages。
      assert.equal(server.lastRequest()?.path, '/v1/users/me')

      // ① propose(不 dispatch:上游不应收到 /v1/pages)。
      const prop = await proposeDeclarativeWrite(
        {
          connectionId: bind.connectionId,
          userId: user,
          actionId: 'create_page',
          params: { parentPageId: 'parent-1', title: '会议纪要' },
        },
        getPool(),
      )
      assert.equal(prop.effect, 'write')
      assert.equal(server.lastRequest()?.path, '/v1/users/me') // 仍是探针,未发写

      // ② 未确认执行 → 拒。
      await assert.rejects(
        executeDeclarativeWrite({ connectionId: bind.connectionId, userId: user, confirmId: prop.confirmId, deps }, getPool()),
      )

      // ③ 确认后执行 → 上游收到 POST /v1/pages,嵌套体正确;结果 allowlist 投影(extra 剥掉)。
      await approveConfirmation(prop.confirmId, user, getPool())
      const exec = await executeDeclarativeWrite(
        { connectionId: bind.connectionId, userId: user, confirmId: prop.confirmId, deps },
        getPool(),
      )
      const req = server.lastRequest()!
      assert.equal(req.path, '/v1/pages')
      const sent = JSON.parse(req.body)
      assert.equal(sent.parent.page_id, 'parent-1')
      assert.equal(sent.properties.title.title[0].text.content, '会议纪要')
      // 结果只留声明字段(extra 剥掉)。
      assert.equal(exec.kind, 'ok')
      if (exec.kind === 'ok') assert.deepEqual(exec.result, { id: 'new-pg', url: 'https://n/new' })
    } finally {
      await server.close()
    }
  })
})
