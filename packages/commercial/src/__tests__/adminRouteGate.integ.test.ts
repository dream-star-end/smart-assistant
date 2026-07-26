/**
 * B2 集成:路由层 /api/admin/* admin 鉴权边界(router.ts dispatch gate)。
 *
 * 锁:requireAdminVerifyDb 在 route.handler 之前对所有 /api/admin/* 强制执行
 *   - 无 JWT → 401;非 admin → 403;active admin → 通过(200)
 *   - 降权 admin(DB role→user,JWT 仍 admin)→ 403(B5:只读路由也 DB 复核)
 *   - 封停 admin(DB status→banned)→ 403
 *   - GET /api/admin/metrics 走 self-auth 白名单(COMMERCIAL_METRICS_BEARER 抓取)→ 200
 *   - 错误 method 的 /api/admin/metrics(POST,未鉴权)→ 401(auth 先于 405,method-aware 白名单)
 *
 * 本地:TEST_DATABASE_URL=postgres://octest:octest@127.0.0.1:5432/openclaude_commercial_test \
 *      TEST_REDIS_URL=redis://127.0.0.1:6379 REQUIRE_TEST_DB=1 npx tsx --test adminRouteGate.integ.test.ts
 */

import assert from 'node:assert/strict'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'
import IORedis from 'ioredis'
import { signAccess } from '../auth/jwt.js'
import type { MailMessage, Mailer } from '../auth/mail.js'
import { closePool, createPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'
import { createCommercialHandler } from '../http/router.js'
import { wrapIoredis } from '../middleware/rateLimit.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379/0'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const JWT_SECRET = 'z'.repeat(64)
const METRICS_BEARER = 'b'.repeat(40)

let pgAvailable = false
let redis: IORedis | null = null
let server: Server | null = null
let baseUrl = ''
let prevMetricsBearer: string | undefined

class NoopMailer implements Mailer {
  async send(_msg: MailMessage): Promise<void> {}
}

function assertTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, '')
  if (!dbName.endsWith('_test')) throw new Error(`refusing non-test database: ${dbName}`)
}

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
      /* ignore */
    }
    return false
  }
}

async function probeRedis(): Promise<IORedis | null> {
  try {
    const r = new IORedis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 })
    await r.connect()
    await r.ping()
    return r
  } catch {
    return null
  }
}

before(async () => {
  pgAvailable = await probePg()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  assertTestDatabase(TEST_DB_URL)
  prevMetricsBearer = process.env.COMMERCIAL_METRICS_BEARER
  process.env.COMMERCIAL_METRICS_BEARER = METRICS_BEARER
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await query('DROP SCHEMA IF EXISTS public CASCADE')
  await query('CREATE SCHEMA public')
  await query('GRANT ALL ON SCHEMA public TO public')
  await runMigrations()
  redis = await probeRedis()
  // fixture fail-closed:缺 Redis 时此前静默降级(整份套件的 HTTP 路径不装配),
  // 于是"绿"只证明了没跑。REQUIRE_TEST_DB/CI 下必须红 —— 2026-07-26 门禁审计。
  if (!redis && REQUIRE_TEST_DB) {
    throw new Error("Redis test fixture required (TEST_REDIS_URL) — refusing to silently degrade")
  }
  if (!redis) return
  const handler = createCommercialHandler({
    jwtSecret: JWT_SECRET,
    mailer: new NoopMailer(),
    redis: wrapIoredis(redis),
    turnstileBypass: true,
    verifyEmailUrlBase: 'https://test.local',
    resetPasswordUrlBase: 'https://test.local',
    rateLimits: {
      register: { scope: 'reg_b2', windowSeconds: 60, max: 1000 },
      login: { scope: 'login_b2', windowSeconds: 60, max: 1000 },
      requestReset: { scope: 'rr_b2', windowSeconds: 60, max: 1000 },
    },
  })
  server = createServer(async (req, res) => {
    const handled = await handler(req, res)
    if (!handled) {
      res.statusCode = 404
      res.end('nope')
    }
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`
})

after(async () => {
  if (prevMetricsBearer === undefined) delete process.env.COMMERCIAL_METRICS_BEARER
  else process.env.COMMERCIAL_METRICS_BEARER = prevMetricsBearer
  if (server) {
    try {
      server.closeAllConnections()
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  }
  if (redis) {
    try {
      await redis.flushdb()
    } catch {
      /* ignore */
    }
    await redis.quit()
  }
  if (pgAvailable) await closePool()
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query('TRUNCATE TABLE refresh_tokens, users RESTART IDENTITY CASCADE')
  if (redis) await redis.flushdb()
})

function skipIfNoHttp(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable || !redis || !server) {
    t.skip('pg/redis/server not available')
    return true
  }
  return false
}

async function createUser(email: string, role: 'user' | 'admin' = 'user'): Promise<bigint> {
  const r = await query<{ id: string }>(
    "INSERT INTO users(email, password_hash, credits, role, status) VALUES ($1, 'argon2$stub', 0, $2, 'active') RETURNING id::text AS id",
    [email, role],
  )
  return BigInt(r.rows[0].id)
}

async function tokenFor(uid: bigint, role: 'user' | 'admin'): Promise<string> {
  const r = await signAccess({ sub: uid.toString(), role }, JWT_SECRET)
  return r.token
}

async function get(path: string, token?: string, method = 'GET'): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  return res.status
}

describe('B2 router admin gate', () => {
  test('无 JWT → /api/admin/users 401', async (t) => {
    if (skipIfNoHttp(t)) return
    assert.equal(await get('/api/admin/users'), 401)
  })

  test('非 admin JWT → 403', async (t) => {
    if (skipIfNoHttp(t)) return
    const u = await createUser('u@x.co', 'user')
    assert.equal(await get('/api/admin/users', await tokenFor(u, 'user')), 403)
  })

  test('active admin → 通过(非 401/403)', async (t) => {
    if (skipIfNoHttp(t)) return
    const a = await createUser('a@x.co', 'admin')
    const status = await get('/api/admin/users', await tokenFor(a, 'admin'))
    assert.ok(status !== 401 && status !== 403, `active admin should pass gate, got ${status}`)
  })

  test('降权 admin(DB role→user,JWT 仍 admin)→ 403(B5)', async (t) => {
    if (skipIfNoHttp(t)) return
    const a = await createUser('a2@x.co', 'admin')
    const tok = await tokenFor(a, 'admin') // JWT 里 role=admin
    await query("UPDATE users SET role='user' WHERE id=$1", [a.toString()])
    assert.equal(await get('/api/admin/users', tok), 403)
  })

  test('封停 admin(DB status→banned)→ 403', async (t) => {
    if (skipIfNoHttp(t)) return
    const a = await createUser('a3@x.co', 'admin')
    const tok = await tokenFor(a, 'admin')
    await query("UPDATE users SET status='banned' WHERE id=$1", [a.toString()])
    assert.equal(await get('/api/admin/users', tok), 403)
  })

  test('GET /api/admin/metrics + COMMERCIAL_METRICS_BEARER → 200(self-auth 白名单)', async (t) => {
    if (skipIfNoHttp(t)) return
    assert.equal(await get('/api/admin/metrics', METRICS_BEARER), 200)
  })

  test('POST /api/admin/metrics 未鉴权 → 401(auth 先于 405,method-aware 白名单)', async (t) => {
    if (skipIfNoHttp(t)) return
    assert.equal(await get('/api/admin/metrics', undefined, 'POST'), 401)
  })
})
