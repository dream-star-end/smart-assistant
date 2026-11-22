/**
 * Wave 4A R2 Audit Blockers Closure Test Suite (OCV5-832).
 *
 * Explicitly verifies all commercial/cross-boundary audit blockers end-to-end:
 *   - B2: Active commercial account DB verification (active -> 200, inactive -> 403 & zero side effects,
 *         DB unavailable -> fail-closed 503 / IM rejection) across all 4 HTTP groups + WeChat/QQ IM.
 *   - B3: Real pending-decision producers (`persistPermissionAuthority`, `proposeWrite`,
 *         `emitOutboundBrowserHandoffFrame` + persistent `PgBrowserHandoffStore` surviving restart)
 *         + idempotent deduplicated proactive IM push.
 *   - B4: IM `/sessions` & `/switch` only expose/accept continuable `wsess-<16hex>` sessions,
 *         explicitly reject web UUID sessions, and route the next inbound WeChat/QQ turn to the
 *         switched `(sessionId, agentId)` via real `makeInboundDispatcher`.
 *   - B5: REAL SQLite `openTaskboardDb` + REAL `handleTaskboardApi` HTTP server verifying:
 *         waiting_human approve -> done, restart-safe idempotent replay (handling container 403),
 *         opposite deny -> 409 conflict, reopened ticket -> 409 stale-version conflict,
 *         waiting_human reject -> ready + replay + opposite approve conflict,
 *         and backlog ticket -> 409 (NEVER approved as waiting_human).
 *   - B8: Sleeping / failing taskboard container surfaces in `warnings` and IM `/pending`
 *         warning notice (NEVER pretends "当前没有待拍板事项").
 *   - N2: Commercial Office preview sanitizes upstream container `RENDER_FAILED` stderr/paths.
 *
 * Run: tsx --test packages/commercial/src/__tests__/wave4AuditBlockers.test.ts
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import {
  createComment,
  createProject,
  createTicket,
  getTicket,
  openTaskboardDb,
  updateTicket,
} from '../../../gateway/src/taskboard/db/index.js'
import { handleTaskboardApi } from '../../../gateway/src/taskboard/http.js'
import type { V3SupervisorDeps } from '../agent-sandbox/v3supervisor.js'
import { signAccess } from '../auth/jwt.js'
import {
  CONTINUABLE_IM_SESSION_ID_RE,
  createChannelSessionController,
  createCommercialPendingDecisionsRuntime,
  createContainerTaskboardDecisionBackend,
} from '../bootstrap/pendingDecisionsBootstrap.js'
import { proposeWrite } from '../connectors/ledger.js'
import { persistPermissionAuthority } from '../dispatch/turnControlStore.js'
import type { CommercialHttpDeps } from '../http/handlers.js'
import { createCommercialHandler } from '../http/router.js'
import {
  InMemoryBrowserHandoffStore,
  OutboundBrowserHandoffFrameObserver,
  PgBrowserHandoffStore,
  createBrowserHandoffSource,
  createPendingDecisionsService,
  createTaskboardSource,
  emitOutboundBrowserHandoffFrame,
} from '../pendingDecisions/index.js'
import { makeInboundDispatcher } from '../wechat/inboundDispatcher.js'
import type { WechatSessionId } from '../wechat/types.js'

const JWT_SECRET = 'wave4-r2-audit-jwt-secret-32bytes!'
const BRIDGE_SECRET = 'wave4-r2-audit-bridge-secret-32b!'

function makeReq(opts: {
  method: string
  url: string
  token?: string
  cookieToken?: string
  body?: unknown
}): IncomingMessage {
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : ''
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage
  req.method = opts.method
  req.url = opts.url
  req.headers = {
    host: 'commercial.test',
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.cookieToken ? { cookie: `oc_session=${opts.cookieToken}` } : {}),
    ...(payload ? { 'content-type': 'application/json' } : {}),
  }
  Object.defineProperty(req, 'socket', {
    value: { remoteAddress: '127.0.0.1' },
    configurable: true,
  })
  return req
}

function makeRes() {
  let code = 200
  const headers: Record<string, string> = {}
  const chunks: Buffer[] = []
  let sent = false
  let ended = false
  const res = {
    get statusCode() {
      return code
    },
    set statusCode(v: number) {
      code = v
    },
    get headersSent() {
      return sent
    },
    get writableEnded() {
      return ended
    },
    setHeader(k: string, v: string | number | string[]) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
    },
    writeHead(status: number, hdrs?: Record<string, string | number | string[]>) {
      code = status
      sent = true
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v)
        }
      }
      return res
    },
    end(chunk?: string | Buffer) {
      sent = true
      ended = true
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    },
    destroy() {
      ended = true
    },
  } as unknown as ServerResponse
  return {
    res,
    status: () => code,
    headers,
    json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
  }
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: String(err) }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((e) => (e ? reject(e) : resolve()))
      }),
  }
}

/**
 * Stateful in-memory PostgreSQL table simulator for `pending_browser_handoffs`,
 * implementing the exact SQL queries used by `PgBrowserHandoffStore` so we can test
 * persistence across store/service reconstruction ("master restart").
 */
function createFakeBrowserHandoffsPgPool() {
  type Row = {
    id: string
    user_id: string
    session_id: string | null
    title: string
    url: string
    reason: string
    risk_level: string
    status: string
    metadata_json: unknown
    resolution_note: string | null
    created_at: string
    expires_at: string
    resolved_at: string | null
  }
  const rows = new Map<string, Row>()

  const pool = {
    rows,
    async query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (s.startsWith('CREATE TABLE') || s.startsWith('CREATE INDEX')) {
        return { rows: [], rowCount: 0 }
      }
      if (s.startsWith('INSERT INTO pending_browser_handoffs')) {
        const [id, user_id, session_id, title, url, reason, risk_level, metaJson, created_at, expires_at] =
          params as [string, string, string | null, string, string, string, string, string | null, string, string]
        if (rows.has(id)) {
          return { rows: [], rowCount: 0 }
        }
        const row: Row = {
          id,
          user_id,
          session_id,
          title,
          url,
          reason,
          risk_level,
          status: 'pending',
          metadata_json: metaJson ? JSON.parse(metaJson) : null,
          resolution_note: null,
          created_at,
          expires_at,
          resolved_at: null,
        }
        rows.set(id, row)
        return { rows: [row], rowCount: 1 }
      }
      if (s.includes('FROM pending_browser_handoffs WHERE user_id = $1')) {
        const [userId, nowIso, limit] = params as [string, string, number]
        const nowMs = new Date(nowIso).getTime()
        const matched = Array.from(rows.values())
          .filter(
            (r) =>
              r.user_id === userId &&
              r.status === 'pending' &&
              new Date(r.expires_at).getTime() > nowMs,
          )
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
          .slice(0, limit)
        return { rows: matched, rowCount: matched.length }
      }
      if (s.includes('FROM pending_browser_handoffs WHERE id = $1')) {
        const [id] = params as [string]
        const r = rows.get(id)
        return r ? { rows: [r], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (s.startsWith('UPDATE pending_browser_handoffs')) {
        const [desiredStatus, nowIso, note, id, userId] = params as [
          string,
          string,
          string | null,
          string,
          string,
        ]
        const row = rows.get(id)
        if (
          !row ||
          row.user_id !== userId ||
          row.status !== 'pending' ||
          new Date(row.expires_at).getTime() <= new Date(nowIso).getTime()
        ) {
          return { rows: [], rowCount: 0 }
        }
        row.status = desiredStatus
        row.resolved_at = nowIso
        row.resolution_note = note
        return { rows: [row], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  }
  return pool
}

describe('B2: Active commercial account verification across all 4 HTTP groups + WeChat/QQ IM', () => {
  it('enforces active -> 200, inactive/banned -> 403 with zero side effects, and DB error -> fail-closed 503 across all 4 HTTP route groups', async () => {
    const { token: activeToken } = await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)
    const { token: bannedToken } = await signAccess({ sub: '99', role: 'user' }, JWT_SECRET)
    let dbDown = false
    let sideEffects = 0

    const bhStore = new InMemoryBrowserHandoffStore()
    const createdBh = await bhStore.create({
      id: 'bh-b2-1',
      userId: '99',
      title: 'Test handoff',
      url: 'https://example.com',
      reason: 'login',
    })
    const docs = new Map<string, import('@openclaude/protocol/research').NormalizedDocument>()

    const makeHandler = () =>
      createCommercialHandler({
        jwtSecret: JWT_SECRET,
        mailer: { send: async () => {} } as unknown as CommercialHttpDeps['mailer'],
        redis: {} as unknown as CommercialHttpDeps['redis'],
        v3Supervisor: {} as V3SupervisorDeps,
        bridgeSecret: BRIDGE_SECRET,
        verifyActiveAccount: async (uid) => {
          if (dbDown) throw new Error('PG connection refused')
          return uid === '42'
        },
        pendingDecisionsService: createPendingDecisionsService({
          sources: [createBrowserHandoffSource(bhStore)],
        }),
        researchLibraryRouteDeps: {
          importDeps: {
            readConfig: async () =>
              ({
                enabled: true,
                config: {
                  litSources: { crossrefMailto: 'test@example.com' },
                  ingest: { engine: 'local' as const },
                },
              }) as never,
            isWorkspaceEnabled: () => false,
            findExistingDocByIdentifier: async () => null,
            getDocument: async (uid, docId) => docs.get(`${uid}:${docId}`) ?? null,
            putDocument: async (uid, doc) => {
              sideEffects += 1
              docs.set(`${uid}:${doc.docId}`, doc)
            },
          },
          spanDeps: {
            getDocument: async (uid, docId) => docs.get(`${uid}:${docId}`) ?? null,
          },
        },
        officePreviewRouteDeps: {
          previewImpl: async () => {
            sideEffects += 1
            return {
              kind: 'xlsx',
              filePath: '/tmp/a.xlsx',
              sha256: 'a'.repeat(64),
              mtimeMs: 1,
              cacheKey: 'k1',
              cached: true,
              maxRowsPerSheet: 500,
              sheets: [],
              errorCells: [],
              qaIssues: [],
            }
          },
        },
        swarmCommandRouteDeps: {
          verifySessionOwnership: async () => {
            sideEffects += 1
            return 'owner'
          },
        },
      })

    const handler = makeHandler()

    // 1) Inactive/banned user gets 403 across ALL 4 HTTP route groups with ZERO side effects
    const checks: Array<{ method: string; url: string; body?: unknown }> = [
      { method: 'GET', url: '/api/me/pending-decisions' },
      {
        method: 'POST',
        url: `/api/me/pending-decisions/${encodeURIComponent(`browser_handoff:${createdBh.id}`)}/resolve`,
        body: { decision: 'approve' },
      },
      {
        method: 'POST',
        url: '/api/me/research/library/import-ids',
        body: { bibtex: '@article{k, title={T}, author={A}, year={2024}}' },
      },
      { method: 'GET', url: '/api/me/research/library/doc-1/span/sp-1' },
      { method: 'GET', url: '/api/file/office-preview?path=%2Ftmp%2Fa.xlsx' },
      {
        method: 'POST',
        url: '/api/sessions/sess-1/swarm/command',
        body: { action: 'steer', target: 'w1', message: 'hi' },
      },
    ]

    for (const c of checks) {
      const res = makeRes()
      await handler(makeReq({ ...c, token: bannedToken }), res.res)
      assert.equal(res.status(), 403, `expected 403 for banned user on ${c.method} ${c.url}`)
    }
    assert.equal(sideEffects, 0, 'banned user must cause ZERO side effects')
    assert.equal((await bhStore.getById(createdBh.id))?.status, 'pending')

    // 2) DB unavailable -> fail-closed 503 (NEVER bypassed!)
    dbDown = true
    for (const c of checks) {
      const res = makeRes()
      await handler(makeReq({ ...c, token: activeToken }), res.res)
      assert.equal(res.status(), 503, `expected fail-closed 503 on DB error for ${c.method} ${c.url}`)
    }
    assert.equal(sideEffects, 0, 'DB outage must fail closed with ZERO side effects')

    // 3) Active user with cookie auth succeeds on research import & span too!
    dbDown = false
    const impRes = makeRes()
    await handler(
      makeReq({
        method: 'POST',
        url: '/api/me/research/library/import-ids',
        cookieToken: activeToken,
        body: { bibtex: '@article{b2, title={Cookie Auth Paper}, author={Alice}, year={2025}, abstract={Abstract text.}}' },
      }),
      impRes.res,
    )
    assert.equal(impRes.status(), 200)
    const docId = (impRes.json() as { imported: Array<{ docId: string }> }).imported[0]!.docId
    const spanId = docs.get(`42:${docId}`)!.spans[0]!.spanId
    const spanRes = makeRes()
    await handler(
      makeReq({
        method: 'GET',
        url: `/api/me/research/library/${docId}/span/${spanId}`,
        cookieToken: activeToken,
      }),
      spanRes.res,
    )
    assert.equal(spanRes.status(), 200)
  })

  it('blocks inactive/banned accounts and DB failures on WeChat & QQ remote-control commands with zero writes', async () => {
    let switchCalls = 0
    let dbDown = false
    const bhStore = new InMemoryBrowserHandoffStore()
    await bhStore.create({ id: 'bh-im-1', userId: '99', title: 'Login', url: 'https://x.test', reason: '2FA' })

    const runtime = createCommercialPendingDecisionsRuntime({
      pool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
      onControlAdmitted: () => {},
      browserHandoffStore: bhStore,
      verifyAccountActive: async (uid) => {
        if (dbDown) throw new Error('db down')
        return uid === '42'
      },
      wechatSessions: {
        listSessions: async () => [{ sessionId: 'wsess-1111111111111111', title: 'S1' }],
        getCurrentSessionId: async () => null,
        switchSession: async () => {
          switchCalls += 1
        },
      },
      qqSessions: {
        listSessions: async () => [{ sessionId: 'wsess-1111111111111111', title: 'S1' }],
        getCurrentSessionId: async () => null,
        switchSession: async () => {
          switchCalls += 1
        },
      },
    })

    try {
      for (const [handler, ch] of [
        [runtime.wechatRemoteControl, 'wechat'],
        [runtime.qqRemoteControl, 'qqbot'],
      ] as const) {
        const r1 = await handler.tryHandleCommand({ userId: '99', text: '/pending', originChannel: ch })
        assert.ok(r1?.includes('不可用') || r1?.includes('封禁'))
        const r2 = await handler.tryHandleCommand({ userId: '99', text: '/switch 1', originChannel: ch })
        assert.ok(r2?.includes('不可用') || r2?.includes('封禁'))
      }
      assert.equal(switchCalls, 0)

      dbDown = true
      const rDb = await runtime.wechatRemoteControl.tryHandleCommand({
        userId: '42',
        text: '/switch 1',
        originChannel: 'wechat',
      })
      assert.ok(rDb?.includes('校验暂时不可用'))
      assert.equal(switchCalls, 0)
    } finally {
      runtime.dispose()
    }
  })
})

describe('B3: Real pending-decision producers, persistent PgBrowserHandoffStore across restart, & deduped IM push', () => {
  it('triggers deduped proactive WeChat/QQ pushes from real persistPermissionAuthority, proposeWrite, and outbound browser_handoff cards', async () => {
    const prevKms = process.env.OPENCLAUDE_KMS_KEY
    process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')

    const bhPool = createFakeBrowserHandoffsPgPool()
    const pushedWechat: string[] = []
    const pushedQq: string[] = []

    const runtime = createCommercialPendingDecisionsRuntime({
      pool: bhPool as unknown as Pool,
      onControlAdmitted: () => {},
      verifyAccountActive: async () => true,
      pushToWechat: async (item) => {
        pushedWechat.push(item.id)
      },
      pushToQq: async (item) => {
        pushedQq.push(item.id)
      },
    })

    try {
      // 1) Real `persistPermissionAuthority`: 1st insert pushes once; duplicate refresh does NOT double-push
      let permCalls = 0
      const permPool = {
        query: async () => {
          permCalls += 1
          return { rows: [{ inserted: permCalls === 1 }], rowCount: 1 }
        },
      } as unknown as Pool

      const permInput = {
        userId: 42n,
        requestId: 'perm-real-1',
        sessionId: 'sess-p1',
        toolName: 'Bash',
        input: { command: 'rm -rf ./tmp-demo' },
        expiresAt: new Date(Date.now() + 600_000),
      }
      assert.equal(await persistPermissionAuthority(permPool, permInput), 'inserted')
      assert.equal(await persistPermissionAuthority(permPool, permInput), 'existing')
      await new Promise((r) => setTimeout(r, 15))
      assert.deepEqual(pushedWechat, ['turn_permission:perm-real-1'])
      assert.deepEqual(pushedQq, ['turn_permission:perm-real-1'])

      // 2) Real `proposeWrite`: interactive pending pushes once; account_preapproval does NOT push
      const ledgerClient = {
        query: async (sql: string) => {
          if (sql.includes('BEGIN') || sql.includes('COMMIT') || sql.includes('ROLLBACK') || sql.includes('advisory')) {
            return { rows: [], rowCount: 0 }
          }
          if (sql.includes('SELECT count(*)')) {
            return { rows: [{ n: '0' }], rowCount: 1 }
          }
          return { rows: [{ expires_at: new Date(Date.now() + 600_000) }], rowCount: 1 }
        },
        release: () => {},
      }
      const ledgerPool = { connect: async () => ledgerClient } as unknown as Pool

      const interactive = await proposeWrite(
        {
          userId: 42,
          connectionId: '11111111-1111-1111-1111-111111111111',
          connectionRevision: 1,
          provider: 'gmail',
          action: 'send_email',
          params: { to: 'boss@example.com' },
          summary: 'Send quarterly report',
        },
        ledgerPool,
      )
      await proposeWrite(
        {
          userId: 42,
          connectionId: '11111111-1111-1111-1111-111111111111',
          connectionRevision: 1,
          provider: 'gmail',
          action: 'send_email',
          params: { to: 'auto@example.com' },
          summary: 'Preapproved send',
          approval: { source: 'account_preapproval', policyVersion: 1 },
        },
        ledgerPool,
      )
      await new Promise((r) => setTimeout(r, 15))
      assert.deepEqual(pushedWechat, ['turn_permission:perm-real-1', `connector_write:${interactive.id}`])
      assert.deepEqual(pushedQq, ['turn_permission:perm-real-1', `connector_write:${interactive.id}`])

      // 3) Real outbound `browser_handoff` UI card -> persisted in PgBrowserHandoffStore + pushed once
      const handoffEvent = {
        userId: '42',
        sessionId: 'sess-bh-1',
        messageId: 'msg-bh-1',
        text: '请接管浏览器：\n```ui\n{"type":"browser_handoff","title":"请完成 GitHub 登录","url":"https://github.com/login","reason":"需要 2FA 验证码"}\n```',
      }
      emitOutboundBrowserHandoffFrame(handoffEvent)
      // Duplicate replay of exact same outbound frame must NOT duplicate DB row or IM push
      emitOutboundBrowserHandoffFrame(handoffEvent)
      await new Promise((r) => setTimeout(r, 25))

      assert.equal(bhPool.rows.size, 1, 'duplicate outbound handoff frame must persist only 1 row')
      const bhId = Array.from(bhPool.rows.keys())[0]!
      assert.deepEqual(pushedWechat, [
        'turn_permission:perm-real-1',
        `connector_write:${interactive.id}`,
        `browser_handoff:${bhId}`,
      ])
      assert.deepEqual(pushedQq, pushedWechat)

      // 4) Simulate master restart: brand-new PgBrowserHandoffStore + PendingDecisionsService
      const restartedStore = new PgBrowserHandoffStore({ pool: bhPool as unknown as Pool })
      const restartedService = createPendingDecisionsService({
        sources: [createBrowserHandoffSource(restartedStore)],
      })
      const listed = await restartedService.list('42')
      assert.equal(listed.items.length, 1)
      assert.equal(listed.items[0]!.id, `browser_handoff:${bhId}`)

      // Non-owner cannot resolve (403 FORBIDDEN)
      await assert.rejects(
        () => restartedService.resolve('99', `browser_handoff:${bhId}`, { decision: 'approve' }),
        (err: unknown) => (err as { code?: string })?.code === 'FORBIDDEN',
      )

      // Owner resolves -> approved, replay -> idempotentReplay=true, opposite -> 409 conflict
      const r1 = await restartedService.resolve('42', `browser_handoff:${bhId}`, { decision: 'approve' })
      assert.equal(r1.status, 'approved')
      assert.equal(r1.idempotentReplay, false)

      const r2 = await restartedService.resolve('42', `browser_handoff:${bhId}`, { decision: 'approve' })
      assert.equal(r2.status, 'approved')
      assert.equal(r2.idempotentReplay, true)

      await assert.rejects(
        () => restartedService.resolve('42', `browser_handoff:${bhId}`, { decision: 'deny' }),
        (err: unknown) => (err as { code?: string })?.code === 'CONFLICT_ALREADY_RESOLVED',
      )
    } finally {
      runtime.dispose()
      if (prevKms === undefined) delete process.env.OPENCLAUDE_KMS_KEY
      else process.env.OPENCLAUDE_KMS_KEY = prevKms
    }
  })

  it('B3 R2: reassembles browser_handoff cards split across streamed WS frames and fails closed without runtime DDL on missing table', async () => {
    const bhPool = createFakeBrowserHandoffsPgPool()
    const pushedWechat: string[] = []
    const pushedQq: string[] = []
    const runtime = createCommercialPendingDecisionsRuntime({
      pool: bhPool as unknown as Pool,
      onControlAdmitted: () => {},
      pushToWechat: async (item) => {
        pushedWechat.push(item.id)
      },
      pushToQq: async (item) => {
        pushedQq.push(item.id)
      },
    })
    const observer = new OutboundBrowserHandoffFrameObserver()

    try {
      const peer = { id: 'sess-stream-bh' }
      // Chunk 1: opening ui fence + partial JSON
      observer.observeOutboundFrame(
        '42',
        JSON.stringify({
          type: 'outbound.message',
          messageId: 'msg-stream-1',
          peer,
          isFinal: false,
          blocks: [{ kind: 'text', text: '需要人工接管：\n```ui\n{"type":"browser_handoff","title":"SSO 登录",' }],
        }),
      )
      // Chunk 2: remaining JSON + closing fence
      observer.observeOutboundFrame(
        '42',
        JSON.stringify({
          type: 'outbound.message',
          messageId: 'msg-stream-1',
          peer,
          isFinal: false,
          blocks: [{ kind: 'text', text: '"url":"https://sso.example.com","reason":"需要企业扫码"}\n```' }],
        }),
      )
      // Chunk 3: empty terminal frame (standard WebChat final)
      observer.observeOutboundFrame(
        '42',
        JSON.stringify({
          type: 'outbound.message',
          messageId: 'msg-stream-1',
          peer,
          isFinal: true,
          blocks: [],
        }),
      )
      await new Promise((r) => setTimeout(r, 30))

      assert.equal(bhPool.rows.size, 1, 'split-frame browser_handoff card must persist exactly once')
      const persisted = Array.from(bhPool.rows.values())[0]!
      assert.equal(persisted.title, 'SSO 登录')
      assert.equal(persisted.url, 'https://sso.example.com')
      assert.equal(pushedWechat.length, 1)
      assert.equal(pushedQq.length, 1)
      assert.equal(pushedWechat[0], `browser_handoff:${persisted.id}`)

      // Missing table (42P01) must fail closed with SOURCE_UNAVAILABLE and NEVER run CREATE TABLE DDL
      const executedSql: string[] = []
      const missingTablePool = {
        query: async (sql: string) => {
          executedSql.push(sql)
          const err = new Error('relation "pending_browser_handoffs" does not exist') as Error & { code: string }
          err.code = '42P01'
          throw err
        },
      } as unknown as Pool
      const storeNoDdl = new PgBrowserHandoffStore({ pool: missingTablePool })
      await assert.rejects(
        () => storeNoDdl.listPending('42', 10),
        (err: unknown) => (err as { code?: string })?.code === 'SOURCE_UNAVAILABLE',
      )
      assert.ok(
        !executedSql.some((s) => /CREATE\s+(TABLE|INDEX)/i.test(s)),
        'PgBrowserHandoffStore must never execute runtime DDL on request path',
      )
    } finally {
      runtime.dispose()
    }
  })
})

describe('B4: IM /sessions & /switch continuability + real inboundDispatcher routing (WeChat & QQ)', () => {
  it('filters out web UUID sessions, rejects unsupported /switch targets, and routes next WeChat & QQ inbound turn to switched (sessionId, agentId)', async () => {
    const webUuidSession = '123e4567-e89b-12d3-a456-426614174000'
    const wsessA = 'wsess-aaaaaaaaaaaaaaaa'
    const wsessB = 'wsess-bbbbbbbbbbbbbbbb'

    const rawSessions = [
      { id: webUuidSession, title: 'Web-only UUID session', agentId: 'main', updatedAt: 300 },
      { id: wsessB, title: 'Research IM thread', agentId: 'researcher', updatedAt: 200 },
      { id: wsessA, title: 'Default IM thread', agentId: 'main', updatedAt: 100 },
    ]

    for (const channel of ['wechat', 'qqbot'] as const) {
      let pointer: { sessionId: WechatSessionId; agentId?: string } | null = {
        sessionId: wsessA,
        agentId: 'main',
      }
      const controller = createChannelSessionController({
        pool: {} as Pool,
        channel,
        listSessionsRaw: async () => ({ sessions: rawSessions }),
        getPointerSessionId: async () => pointer?.sessionId ?? null,
        setPointerSessionId: async (_pool, _uid, sid, _now, agentId) => {
          pointer = { sessionId: sid, ...(agentId ? { agentId } : {}) }
          return true
        },
      })

      const runtime = createCommercialPendingDecisionsRuntime({
        pool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
        onControlAdmitted: () => {},
        browserHandoffStore: new InMemoryBrowserHandoffStore(),
        verifyAccountActive: async () => true,
        ...(channel === 'wechat' ? { wechatSessions: controller } : { qqSessions: controller }),
      })
      const im = channel === 'wechat' ? runtime.wechatRemoteControl : runtime.qqRemoteControl

      try {
        // 1) `/sessions` exposes ONLY continuable `wsess-` sessions (web UUID hidden)
        const listReply = await im.tryHandleCommand({
          userId: '42',
          text: '/sessions',
          originChannel: channel,
          channelName: channel === 'wechat' ? '微信' : 'QQ',
        })
        assert.ok(listReply?.includes(wsessB))
        assert.ok(listReply?.includes(wsessA))
        assert.ok(!listReply?.includes(webUuidSession), `${channel} /sessions must hide non-continuable web UUID session`)

        // 2) `/switch <web-uuid>` explicitly rejected (pointer unchanged!)
        const rejectReply = await im.tryHandleCommand({
          userId: '42',
          text: `/switch ${webUuidSession}`,
          originChannel: channel,
        })
        assert.ok(rejectReply && !rejectReply.includes('已切换到会话'))
        assert.equal(pointer?.sessionId, wsessA)

        // Direct controller check also throws ImSessionSwitchError on web UUID
        await assert.rejects(
          () => controller.switchSession('42', webUuidSession),
          (err: unknown) => (err as { code?: string })?.code === 'UNSUPPORTED_SESSION',
        )

        // 3) `/switch 1` switches pointer to wsessB + agentId='researcher'
        const okReply = await im.tryHandleCommand({
          userId: '42',
          text: '/switch 1',
          originChannel: channel,
        })
        assert.ok(okReply?.includes('已切换到会话'))
        assert.equal(pointer?.sessionId, wsessB)
        assert.equal(pointer?.agentId, 'researcher')

        // 4) Next normal inbound message through REAL `makeInboundDispatcher` hits switched sessionId & agentId!
        let dispatchedBody: Record<string, unknown> | null = null
        const dispatcher = makeInboundDispatcher({
          pgPool: {} as Pool,
          bridgeSecret: BRIDGE_SECRET,
          resolveContainerEndpoint: async () => ({
            kind: 'docker',
            containerId: 77,
            host: '127.0.0.1',
            port: 3001,
          }),
          transport: {
            supportsTunnel: false,
            post: async (_ep, _path, _headers, bodyJson) => {
              dispatchedBody = JSON.parse(bodyJson) as Record<string, unknown>
              return {
                status: 200,
                bodyText: JSON.stringify({
                  ok: true,
                  accepted: true,
                  sessionId: wsessB,
                  agentId: 'researcher',
                  runId: 'run-1',
                }),
              }
            },
          },
          upsertMasterClientSession: async () => {},
          softDeleteMasterSession: async () => {},
          channel: {
            id: channel,
            originChannel: channel,
            inboundPath:
              channel === 'wechat' ? '/internal/v3/wechat-inbound' : '/internal/v3/qqbot-inbound',
            compensatePath:
              channel === 'wechat'
                ? '/internal/v3/wechat-inbound-compensate'
                : '/internal/v3/qqbot-inbound-compensate',
            stopPath: channel === 'wechat' ? '/internal/v3/wechat-stop' : '/internal/v3/qqbot-stop',
            defaultSessionTitle: channel === 'wechat' ? '微信会话' : 'QQ会话',
            decorateInboundText: (t) => t,
            getCurrentSessionId: async () => pointer?.sessionId ?? null,
            getCurrentSessionPointer: async () => pointer,
            setCurrentSessionId: async (_conn, _uid, sid, _now, aid) => {
              pointer = { sessionId: sid, ...(aid ? { agentId: aid } : {}) }
              return true
            },
            markRunningSession: async () => {},
            listRunningSessions: async () => [],
          },
        })

        const outcome = await dispatcher.dispatch({
          bindingUserId: '42',
          senderId: 'sender_abc123',
          idempotencyKey: `msg-${channel}-1`,
          receivedAt: Date.now(),
          text: '继续刚才的科研文献分析',
        })
        assert.equal(outcome.kind, 'dispatched')
        assert.equal(outcome.sessionId, wsessB)
        assert.ok(dispatchedBody, 'container inbound must be called')
        const body = dispatchedBody as { peer: { id: string; displayName: string }; agentId: string }
        assert.equal(body.peer.id, wsessB)
        assert.equal(body.agentId, 'researcher', `${channel} inbound must route to switched agentId`)
        assert.ok(
          CONTINUABLE_IM_SESSION_ID_RE.test(body.peer.id),
          'peer.id must satisfy WSESS_RE for outbound reply delivery',
        )
      } finally {
        runtime.dispose()
      }
    }
  })

  it('B4 R2: reports explicit failure and NEVER claims switched when pointer setter returns false (WeChat & QQ)', async () => {
    const wsessA = 'wsess-aaaaaaaaaaaaaaaa' as WechatSessionId
    const wsessB = 'wsess-bbbbbbbbbbbbbbbb' as WechatSessionId

    for (const channel of ['wechat', 'qqbot'] as const) {
      const controller = createChannelSessionController({
        pool: {} as Pool,
        channel,
        listSessionsRaw: async () => ({
          sessions: [
            { id: wsessA, title: 'Session A', agentId: 'main', updatedAt: 200 },
            { id: wsessB, title: 'Session B', agentId: 'researcher', updatedAt: 100 },
          ],
        }),
        getPointerSessionId: async () => wsessA,
        // Simulate CAS / stale-pointer rejection where PG pointer table was NOT updated
        setPointerSessionId: async () => false,
      })

      const runtime = createCommercialPendingDecisionsRuntime({
        pool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
        onControlAdmitted: () => {},
        verifyAccountActive: async () => true,
        wechatSessions: channel === 'wechat' ? controller : undefined,
        qqSessions: channel === 'qqbot' ? controller : undefined,
      })
      const remote = channel === 'wechat' ? runtime.wechatRemoteControl : runtime.qqRemoteControl

      try {
        const listReply = await remote.tryHandleCommand({
          userId: '42',
          text: '/sessions',
          originChannel: channel,
        })
        assert.ok(listReply?.includes(wsessB))

        const switchReply = await remote.tryHandleCommand({
          userId: '42',
          text: '/switch 2',
          originChannel: channel,
        })
        assert.ok(switchReply, `${channel} /switch must return explicit failure reply`)
        assert.ok(
          !switchReply.includes('已切换到会话') && !switchReply.includes('将继续该会话上下文'),
          `${channel} must NOT falsely report switch success when pointer setter returned false: ${switchReply}`,
        )
        assert.ok(switchReply.includes('无法切换到会话'))
      } finally {
        runtime.dispose()
      }
    }
  })
})

describe('B5: REAL SQLite taskboard HTTP integration (idempotent replay across restart, conflict, reopen, & backlog fence)', () => {
  it('handles approve/replay/opposite/reopen/reject/backlog against real openTaskboardDb + handleTaskboardApi', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'oc-w4-real-tb-'))
    const db = openTaskboardDb(path.join(tmpDir, 'taskboard.db'))
    const proj = createProject(db, { name: 'Wave 4 Real TB', key: 'W4TB' })

    // Ticket A: waiting_human at version=2 (backlog -> ready -> waiting_human)
    const rawA = createTicket(db, { projectId: proj.id, type: 'bug', reporter: 'human', title: 'Ship Release A', status: 'ready' })
    const tA = updateTicket(db, rawA.id, rawA.version, { status: 'waiting_human' })
    assert.equal(tA.status, 'waiting_human')

    // Ticket B: waiting_human for reject path
    const rawB = createTicket(db, { projectId: proj.id, type: 'bug', reporter: 'human', title: 'Review Draft B', status: 'ready' })
    const tB = updateTicket(db, rawB.id, rawB.version, { status: 'waiting_human' })
    assert.equal(tB.status, 'waiting_human')

    // Ticket C: backlog (MUST NEVER be approved as waiting_human!)
    const tC = createTicket(db, { projectId: proj.id, type: 'bug', reporter: 'human', title: 'Backlog Idea C', status: 'backlog' })
    assert.equal(tC.status, 'backlog')

    const tbServer = await startServer(async (req, res) => {
      const handled = await handleTaskboardApi(req, res, { db, actor: 'human' })
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })

    const makeFreshSource = () =>
      createTaskboardSource(
        createContainerTaskboardDecisionBackend({
          v3Supervisor: {} as V3SupervisorDeps,
          bridgeSecret: BRIDGE_SECRET,
          clientOverrides: {
            getStatus: async (uid) => ({
              containerId: 88,
              userId: uid,
              dockerContainerId: 'docker-88',
              hostId: null,
              lastWsActivity: null,
              state: 'running',
              boundIp: '127.0.0.1',
              port: tbServer.port,
            }),
            isEndpointAllowed: () => true,
          },
        }),
      )

    try {
      const source1 = makeFreshSource()

      // List returns ONLY waiting_human tickets (tA and tB, NOT backlog tC)
      const listed = await source1.listPending('42', { limit: 20, nowMs: Date.now() })
      const listedIds = listed.map((i) => i.metadata.ticketId)
      assert.ok(listedIds.includes(tA.id))
      assert.ok(listedIds.includes(tB.id))
      assert.ok(!listedIds.includes(tC.id))

      // 1) Approve Ticket A -> 1st returns approved, real SQLite is done
      const aSourceId = `${tA.id}@v${tA.version}`
      const resA1 = await source1.resolve('42', aSourceId, { decision: 'approve' })
      assert.equal(resA1.status, 'approved')
      assert.equal(resA1.idempotentReplay, false)
      assert.equal(getTicket(db, tA.id)?.status, 'done')
      assert.equal(getTicket(db, tA.id)?.version, tA.version + 1)

      // 2) 2nd approve on a BRAND NEW backend instance (simulating master restart!)
      //    Real container `/approve` on `done` returns 403 same_status -> authoritative check returns idempotentReplay=true!
      const sourceRestarted = makeFreshSource()
      const resA2 = await sourceRestarted.resolve('42', aSourceId, { decision: 'approve' })
      assert.equal(resA2.status, 'approved')
      assert.equal(resA2.idempotentReplay, true)

      // 3) Opposite deny on already-approved Ticket A -> 409 CONFLICT_ALREADY_RESOLVED
      await assert.rejects(
        () => sourceRestarted.resolve('42', aSourceId, { decision: 'deny', reason: 'too late' }),
        (err: unknown) => (err as { code?: string; httpStatus?: number })?.code === 'CONFLICT_ALREADY_RESOLVED' &&
          (err as { httpStatus?: number })?.httpStatus === 409,
      )

      // 4) Reopen Ticket A (done -> ready -> waiting_human, bumping version) -> stale @v2 card MUST 409!
      const reopenedReady = updateTicket(db, tA.id, getTicket(db, tA.id)!.version, { status: 'ready' })
      updateTicket(db, tA.id, reopenedReady.version, { status: 'waiting_human' })
      await assert.rejects(
        () => sourceRestarted.resolve('42', aSourceId, { decision: 'approve' }),
        (err: unknown) => (err as { code?: string })?.code === 'CONFLICT_ALREADY_RESOLVED',
      )

      // 5) Reject Ticket B -> ready + comment; 2nd reject after restart -> idempotentReplay=true; opposite approve -> 409
      const bSourceId = `${tB.id}@v${tB.version}`
      const resB1 = await source1.resolve('42', bSourceId, { decision: 'deny', reason: 'Need more evidence' })
      assert.equal(resB1.status, 'denied')
      assert.equal(resB1.idempotentReplay, false)
      assert.equal(getTicket(db, tB.id)?.status, 'ready')

      const sourceRestartedB = makeFreshSource()
      const resB2 = await sourceRestartedB.resolve('42', bSourceId, { decision: 'deny', reason: 'retry' })
      assert.equal(resB2.status, 'denied')
      assert.equal(resB2.idempotentReplay, true)

      await assert.rejects(
        () => sourceRestartedB.resolve('42', bSourceId, { decision: 'approve' }),
        (err: unknown) => (err as { code?: string })?.code === 'CONFLICT_ALREADY_RESOLVED',
      )

      // 6) Backlog Ticket C MUST NEVER be approved through pending-decisions (409 + stays backlog in SQLite!)
      const cSourceId = `${tC.id}@v${tC.version}`
      await assert.rejects(
        () => source1.resolve('42', cSourceId, { decision: 'approve' }),
        (err: unknown) => (err as { code?: string; httpStatus?: number })?.code === 'CONFLICT_ALREADY_RESOLVED' &&
          (err as { httpStatus?: number })?.httpStatus === 409,
      )
      assert.equal(getTicket(db, tC.id)?.status, 'backlog', 'backlog ticket must remain untouched in SQLite')
    } finally {
      await tbServer.close()
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('B5 R2: deny->approve NEVER returns approved even when /comments returns 503 OR ticket has >500 historical comments', async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'oc-w4-real-tb-r2-'))
    const db = openTaskboardDb(path.join(tmpDir, 'taskboard.db'))
    const proj = createProject(db, { name: 'Wave 4 R2 TB', key: 'W4R2' })

    // Ticket 1: will test /comments returning 503 after deny
    const raw1 = createTicket(db, { projectId: proj.id, type: 'bug', reporter: 'human', title: 'Deny Then 503 Comments', status: 'ready' })
    const t1 = updateTicket(db, raw1.id, raw1.version, { status: 'waiting_human' })

    // Ticket 2: seed 520 historical comments BEFORE deny (exceeds single 500-item page!)
    const raw2 = createTicket(db, { projectId: proj.id, type: 'bug', reporter: 'human', title: 'Deny With 520 Comments', status: 'ready' })
    for (let i = 0; i < 520; i++) {
      createComment(db, {
        ticketId: raw2.id,
        authorKind: 'agent',
        author: 'agent:worker',
        body: `Historical log entry #${i}`,
      })
    }
    const t2 = updateTicket(db, raw2.id, raw2.version, { status: 'waiting_human' })

    let forceComments503 = false
    const tbServer = await startServer(async (req, res) => {
      if (forceComments503 && (req.url ?? '').includes('/comments')) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'comments temporarily unavailable' }))
        return
      }
      const handled = await handleTaskboardApi(req, res, { db, actor: 'human' })
      if (!handled) {
        res.writeHead(404)
        res.end()
      }
    })

    const makeFreshSource = () =>
      createTaskboardSource(
        createContainerTaskboardDecisionBackend({
          v3Supervisor: {} as V3SupervisorDeps,
          bridgeSecret: BRIDGE_SECRET,
          clientOverrides: {
            getStatus: async (uid) => ({
              containerId: 89,
              userId: uid,
              dockerContainerId: 'docker-89',
              hostId: null,
              lastWsActivity: null,
              state: 'running',
              boundIp: '127.0.0.1',
              port: tbServer.port,
            }),
            isEndpointAllowed: () => true,
          },
        }),
      )

    try {
      // Scenario 1: deny t1 -> ready, then /comments returns 503
      const s1 = `${t1.id}@v${t1.version}`
      const d1 = await makeFreshSource().resolve('42', s1, { decision: 'deny', reason: 'Needs fix' })
      assert.equal(d1.status, 'denied')
      assert.equal(getTicket(db, t1.id)?.status, 'ready')

      forceComments503 = true
      // Opposite approve MUST return 409 CONFLICT_ALREADY_RESOLVED (NEVER approved!)
      await assert.rejects(
        () => makeFreshSource().resolve('42', s1, { decision: 'approve' }),
        (err: unknown) =>
          (err as { code?: string; httpStatus?: number })?.code === 'CONFLICT_ALREADY_RESOLVED' &&
          (err as { httpStatus?: number })?.httpStatus === 409,
      )
      assert.equal(getTicket(db, t1.id)?.status, 'ready')

      // Deny replay while /comments is 503 MUST fail closed as SOURCE_UNAVAILABLE (never guess)
      await assert.rejects(
        () => makeFreshSource().resolve('42', s1, { decision: 'deny', reason: 'retry' }),
        (err: unknown) => (err as { code?: string })?.code === 'SOURCE_UNAVAILABLE',
      )

      // Scenario 2: no failure, ticket has 520 historical comments -> deny adds 521st comment on page 2
      forceComments503 = false
      const s2 = `${t2.id}@v${t2.version}`
      const d2 = await makeFreshSource().resolve('42', s2, { decision: 'deny', reason: 'Reject on page 2' })
      assert.equal(d2.status, 'denied')
      assert.equal(getTicket(db, t2.id)?.status, 'ready')

      // Opposite approve MUST return 409 CONFLICT_ALREADY_RESOLVED (SQLite stays ready!)
      await assert.rejects(
        () => makeFreshSource().resolve('42', s2, { decision: 'approve' }),
        (err: unknown) =>
          (err as { code?: string; httpStatus?: number })?.code === 'CONFLICT_ALREADY_RESOLVED' &&
          (err as { httpStatus?: number })?.httpStatus === 409,
      )
      assert.equal(getTicket(db, t2.id)?.status, 'ready')

      // Deny replay MUST paginate past 500 comments, find the 521st human reject comment, and succeed idempotently
      const d2Replay = await makeFreshSource().resolve('42', s2, { decision: 'deny', reason: 'retry' })
      assert.equal(d2Replay.status, 'denied')
      assert.equal(d2Replay.idempotentReplay, true)
    } finally {
      await tbServer.close()
      db.close()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('B8 + N2: Sleeping taskboard warnings & Office preview error sanitization', () => {
  it('B8: surfaces SOURCE_UNAVAILABLE warning in HTTP and IM /pending when taskboard container is sleeping or 503', async () => {
    const sleepingBackend = createContainerTaskboardDecisionBackend({
      v3Supervisor: {} as V3SupervisorDeps,
      bridgeSecret: BRIDGE_SECRET,
      clientOverrides: {
        getStatus: async () => null, // container sleeping/not running
      },
    })
    const bhStore = new InMemoryBrowserHandoffStore()

    const runtime = createCommercialPendingDecisionsRuntime({
      pool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
      onControlAdmitted: () => {},
      taskboardBackend: sleepingBackend,
      browserHandoffStore: bhStore,
      verifyAccountActive: async () => true,
    })

    try {
      // Case 1: No other items, taskboard sleeping -> HTTP returns warning & IM /pending warns explicitly
      const httpEmpty = await runtime.service.list('42')
      assert.equal(httpEmpty.items.length, 0)
      assert.ok(httpEmpty.warnings?.some((w) => w.source === 'taskboard' && w.code === 'SOURCE_UNAVAILABLE'))

      const imEmpty = await runtime.wechatRemoteControl.tryHandleCommand({
        userId: '42',
        text: '/pending',
        originChannel: 'wechat',
      })
      assert.ok(imEmpty && !imEmpty.includes('当前没有待拍板事项'), `must not falsely claim no pending decisions: ${imEmpty}`)
      assert.ok(imEmpty?.includes('任务单待验收') && (imEmpty.includes('休眠') || imEmpty.includes('不可用')))

      // Case 2: Another source has a pending item -> HTTP preserves healthy item + warnings; IM lists item + warning footer
      await bhStore.create({
        id: 'bh-b8-1',
        userId: '42',
        title: 'Confirm OAuth',
        url: 'https://oauth.test',
        reason: '2FA required',
      })
      const httpPartial = await runtime.service.list('42')
      assert.equal(httpPartial.items.length, 1)
      assert.equal(httpPartial.items[0]!.source, 'browser_handoff')
      assert.ok(httpPartial.warnings?.some((w) => w.source === 'taskboard'))

      const imPartial = await runtime.qqRemoteControl.tryHandleCommand({
        userId: '42',
        text: '/pending',
        originChannel: 'qqbot',
      })
      assert.ok(imPartial?.includes('Confirm OAuth'))
      assert.ok(imPartial?.includes('任务单待验收'))
    } finally {
      runtime.dispose()
    }
  })

  it('N2: sanitizes container Office RENDER_FAILED stderr/paths before returning error to browser', async () => {
    const { token } = await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)
    const leakPath = '/home/openclaude/private/secret-budget.pptx'
    const srv = await startServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            code: 'RENDER_FAILED',
            message: `soffice crashed on ${leakPath}: stderr Traceback /usr/lib/libreoffice`,
          },
        }),
      )
    })

    try {
      const handler = createCommercialHandler({
        jwtSecret: JWT_SECRET,
        mailer: { send: async () => {} } as unknown as CommercialHttpDeps['mailer'],
        redis: {} as unknown as CommercialHttpDeps['redis'],
        v3Supervisor: {} as V3SupervisorDeps,
        bridgeSecret: BRIDGE_SECRET,
        verifyActiveAccount: async () => true,
        officePreviewRouteDeps: {
          containerClientOverrides: {
            getStatus: async (uid) => ({
              containerId: 42,
              userId: uid,
              dockerContainerId: 'docker-42',
              hostId: null,
              lastWsActivity: null,
              state: 'running',
              boundIp: '127.0.0.1',
              port: srv.port,
            }),
            isEndpointAllowed: () => true,
          },
        },
      })

      const res = makeRes()
      await handler(
        makeReq({
          method: 'GET',
          url: `/api/file/office-preview?path=${encodeURIComponent(leakPath)}`,
          token,
        }),
        res.res,
      )
      assert.equal(res.status(), 500)
      const json = res.json() as { error: { code: string; message: string } }
      assert.equal(json.error.code, 'RENDER_FAILED')
      assert.equal(json.error.message, 'office preview rendering failed')
      assert.ok(!json.error.message.includes(leakPath))
      assert.ok(!json.error.message.includes('Traceback'))
    } finally {
      await srv.close()
    }
  })
})
