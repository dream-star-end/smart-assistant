/**
 * 声明式连接器 · 容器 RPC 路径端到端(真 PG + 受控上游 + 假容器身份)。
 * 证明 agent(经 oc-connect → /v3/connectors/{list,call})能列出并执行声明式连接:
 * LIST 见到声明式连接(动作由 pin 的 contract 派生)、CALL read → {kind:'result'} allowlist、
 * CALL 未知 action → {kind:'error', ACTION_UNKNOWN}。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { after, before, describe, test } from 'node:test'
import { fetch as undiciFetch } from 'undici'

process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')

import type { ContainerIdentityRepo } from '../auth/containerIdentity.js'
import { hashSecret } from '../auth/containerIdentity.js'
import { seedDefaultConnectors } from '../connectors/declarativeSeed.js'
import { bindDeclarativeConnector } from '../connectors/engine/bind.js'
import type { EngineHttpDeps } from '../connectors/engine/driver.js'
import { makeConnectorsRpcHandler } from '../connectors/rpc.js'
import type { DnsResolver } from '../connectors/outboundPolicy.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const PUBLIC_IP = '93.184.216.34'
const HOST_UUID = '11111111-1111-1111-1111-111111111111'
const BOUND_IP = '10.9.9.9'

let pgAvailable = false

async function dropAllTables(): Promise<void> {
  const db = await query<{ db: string }>('SELECT current_database() AS db')
  if (!/_test$/.test(db.rows[0]?.db ?? '')) throw new Error('refusing non-test db')
  await query(`DO $$ DECLARE r RECORD; BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP
      EXECUTE 'DROP TABLE IF EXISTS public.'||quote_ident(r.tablename)||' CASCADE'; END LOOP; END $$;`)
}

function startServer(): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1')
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        if (u.pathname === '/v1/users/me')
          return res.end(JSON.stringify({ id: 'bot-1', bot: { workspace_name: 'WS' } }))
        if (u.pathname === '/v1/pages/pg1')
          return res.end(JSON.stringify({ id: 'pg1', url: 'https://n/pg1', leak: 'X' }))
        res.statusCode = 404
        res.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
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

// ── 假容器身份 + mock req/res ──
function memRepo(containerId: number, userId: number, secretHash: Buffer): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp() {
      return { id: containerId, user_id: userId, bound_ip: BOUND_IP, host_uuid: HOST_UUID, secret_hash: secretHash }
    },
  }
}
function mockReq(url: string, token: string, body: unknown): IncomingMessage {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage & {
    method: string
    url: string
    headers: Record<string, string>
  }
  r.method = 'POST'
  r.url = url
  r.headers = { authorization: `Bearer ${token}` }
  return r as IncomingMessage
}
function mockRes(): { res: ServerResponse; parsed(): { status: number; env: Record<string, unknown> } } {
  const state = { status: 0, body: '' }
  const res = {
    statusCode: 0,
    setHeader() {},
    end(b?: string) {
      state.status = (this as ServerResponse).statusCode
      if (b) state.body = String(b)
    },
  } as unknown as ServerResponse
  return {
    res,
    parsed: () => ({ status: state.status, env: JSON.parse(state.body || '{}') as Record<string, unknown> }),
  }
}

let uSeq = 0
async function mkUser(): Promise<number> {
  uSeq += 1
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, role)
     VALUES ($1,'x',TRUE,'user') RETURNING id::text AS id`,
    [`rpc-u${uSeq}-${Date.now()}@t.local`],
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

describe('声明式连接器 · 容器 RPC', () => {
  test('LIST 见声明式连接;CALL read → result allowlist;未知 action → error', async (t) => {
    if (skip(t)) return
    const server = await startServer()
    try {
      const deps: EngineHttpDeps = { resolver: okResolver(), fetchImpl: localFetch(server.port) }
      await seedDefaultConnectors(getPool())
      const v = await query<{ id: string }>(
        `SELECT id::text AS id FROM marketplace_skill_versions
          WHERE slug='notion' AND security_review_state='security_approved'`,
      )
      const versionId = Number(v.rows[0]!.id)
      const userId = await mkUser()
      const bind = await bindDeclarativeConnector(
        { userId, connectorVersionId: versionId, secrets: { access_token: 'ntn-tok' }, deps },
        getPool(),
      )

      // 假容器身份:token oc-v3.<cid>.<secret>,secret_hash = hashSecret(secret)。
      const containerId = 4242
      const secret = randomBytes(32).toString('hex')
      const token = `oc-v3.${containerId}.${secret}`
      const handler = makeConnectorsRpcHandler({
        identityRepo: memRepo(containerId, userId, hashSecret(secret)),
        redis: null,
        resolver: okResolver(),
        fetchImpl: localFetch(server.port),
      })
      const ctx = { hostUuid: HOST_UUID, boundIp: BOUND_IP }

      // ── LIST ──
      {
        const m = mockRes()
        await handler(mockReq('/v3/connectors/list', token, {}), m.res, ctx)
        const { env } = m.parsed()
        const conns = env.connections as Array<Record<string, unknown>>
        const notion = conns.find((c) => c.id === bind.connectionId)
        assert.ok(notion, 'declarative notion connection listed')
        assert.equal(notion!.provider, 'notion')
        const actionIds = (notion!.actions as Array<{ id: string; readOnly: boolean }>).map((a) => a.id)
        assert.ok(actionIds.includes('retrieve_page'))
        assert.ok(actionIds.includes('whoami'))
        // whoami/retrieve_page 是 read。
        for (const a of notion!.actions as Array<{ id: string; readOnly: boolean }>)
          if (a.id === 'retrieve_page') assert.equal(a.readOnly, true)
      }

      // ── CALL read ──
      {
        const m = mockRes()
        await handler(
          mockReq('/v3/connectors/call', token, {
            connectionId: bind.connectionId,
            action: 'retrieve_page',
            params: { pageId: 'pg1' },
          }),
          m.res,
          ctx,
        )
        const { env } = m.parsed()
        assert.equal(env.kind, 'result')
        assert.deepEqual(env.result, { id: 'pg1', url: 'https://n/pg1' }) // leak 剥掉
      }

      // ── CALL 未知 action ──
      {
        const m = mockRes()
        await handler(
          mockReq('/v3/connectors/call', token, {
            connectionId: bind.connectionId,
            action: 'nonexistent',
            params: {},
          }),
          m.res,
          ctx,
        )
        const { env } = m.parsed()
        assert.equal(env.kind, 'error')
        assert.equal(env.code, 'ACTION_UNKNOWN')
      }

      // ── 跨用户(不同 userId 的容器)看不到该连接 ──
      {
        const otherUser = await mkUser()
        const h2 = makeConnectorsRpcHandler({
          identityRepo: memRepo(containerId, otherUser, hashSecret(secret)),
          redis: null,
          resolver: okResolver(),
          fetchImpl: localFetch(server.port),
        })
        const m = mockRes()
        await h2(
          mockReq('/v3/connectors/call', token, {
            connectionId: bind.connectionId,
            action: 'retrieve_page',
            params: { pageId: 'pg1' },
          }),
          m.res,
          ctx,
        )
        const { env } = m.parsed()
        assert.equal(env.kind, 'error')
        assert.equal(env.code, 'CONNECTION_NOT_FOUND')
      }
    } finally {
      await server.close()
    }
  })
})
