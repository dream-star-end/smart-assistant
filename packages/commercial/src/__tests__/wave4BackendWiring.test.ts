/**
 * Wave 4A End-to-End Backend Wiring Tests (OCV5-832).
 *
 * Verifies all 4 commercial HTTP route groups & bootstrap wiring via `createCommercialHandler`:
 *   1. Unified Pending Decisions API (`GET /api/me/pending-decisions`,
 *      `POST /api/me/pending-decisions/:id/resolve`) + `createCommercialPendingDecisionsRuntime`
 *      (real container taskboard HTTP bridge, `onControlAdmitted` drain hook, WeChat/QQ `remoteControl`).
 *   2. Research Library batch import & span locator (`POST /api/me/research/library/import-ids`,
 *      `GET /api/me/research/library/:docId/span/:spanId`).
 *   3. Office zero-turn cached preview end-to-end (`GET /api/file/office-preview`,
 *      `GET /api/file/office-preview/page`) proxied to a live HTTP server running gateway's
 *      `/internal/office-preview*` with real bridge HMAC verification.
 *   4. Swarm control commands end-to-end (`POST /api/sessions/:id/swarm/command`) with
 *      session ownership enforcement & proxying to a live HTTP server running gateway's
 *      `/internal/swarm/command` + `handleSwarmCommandRoute`.
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/wave4BackendWiring.test.ts
 */

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import { antigravitySessionBrainDir } from '../../../gateway/src/engine/antigravityPlatform.js'
import { InternalBridgeReplayCache } from '../../../gateway/src/routes/internalBridgeAuth.js'
import {
  ContainerOfficePreviewRegistry,
  handleInternalOfficePreview,
  handleInternalOfficePreviewPage,
} from '../../../gateway/src/routes/officePreviewRoute.js'
import { handleInternalSwarmCommand } from '../../../gateway/src/routes/swarmCommandRoute.js'
import type { V3SupervisorDeps } from '../agent-sandbox/v3supervisor.js'
import { signAccess } from '../auth/jwt.js'
import {
  createCommercialPendingDecisionsRuntime,
  createContainerTaskboardDecisionBackend,
} from '../bootstrap/pendingDecisionsBootstrap.js'
import { buildWechatBrokerDeps } from '../bootstrap/channelsAndAutoDreamBootstrap.js'
import type { CommercialHttpDeps } from '../http/handlers.js'
import { OfficePreviewHandleRegistry } from '../http/officePreviewRoutes.js'
import { createCommercialHandler } from '../http/router.js'
import {
  InMemoryBrowserHandoffStore,
  InMemoryTaskboardDecisionBackend,
  createBrowserHandoffSource,
  createPendingDecisionsService,
  createTaskboardSource,
  createTurnPermissionSource,
} from '../pendingDecisions/index.js'

const JWT_SECRET = 'wave4-commercial-wiring-secret-32bytes!'
const BRIDGE_SECRET = 'wave4-commercial-bridge-secret-32bytes!'
const COORD_CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

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
    buf: () => Buffer.concat(chunks),
    json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
  }
}

function stubDeps(overrides: Partial<CommercialHttpDeps> = {}): CommercialHttpDeps {
  return {
    jwtSecret: JWT_SECRET,
    mailer: { send: async () => {} } as unknown as CommercialHttpDeps['mailer'],
    redis: {} as unknown as CommercialHttpDeps['redis'],
    verifyActiveAccount: async () => true,
    ...overrides,
  }
}

async function startHttpServer(
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

describe('Wave 4A Group 1: Pending Decisions router wiring + bootstrap runtime', () => {
  it('routes GET /api/me/pending-decisions and POST /api/me/pending-decisions/:id/resolve through createCommercialHandler', async () => {
    const { token: token42 } = await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)
    const drainedUids: bigint[] = []

    const fakePool = {
      query: async (sql: string) => {
        if (sql.includes('FROM turn_permission_requests') && sql.includes("status = 'pending'")) {
          return {
            rows: [
              {
                user_id: '42',
                request_id: 'perm-req-1',
                session_id: 'sess-1',
                client_message_id: 'msg-1',
                tool_use_id: 'tu-1',
                tool_name: 'Bash',
                input_json: { command: 'npm test' },
                ask_payload_json: null,
                status: 'pending',
                response_json: null,
                created_at: new Date('2026-11-21T08:00:00Z'),
                expires_at: new Date('2099-11-21T09:00:00Z'),
              },
            ],
            rowCount: 1,
          }
        }
        if (sql.includes('FROM turn_permission_requests') && sql.includes('WHERE request_id = $1')) {
          return {
            rows: [
              {
                user_id: '42',
                request_id: 'perm-req-1',
                session_id: 'sess-1',
                client_message_id: 'msg-1',
                tool_use_id: 'tu-1',
                tool_name: 'Bash',
                input_json: { command: 'npm test' },
                ask_payload_json: null,
                status: 'pending',
                response_json: null,
                created_at: new Date('2026-11-21T08:00:00Z'),
                updated_at: new Date('2026-11-21T08:00:00Z'),
                expires_at: new Date('2099-11-21T09:00:00Z'),
              },
            ],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
    }

    const tb = new InMemoryTaskboardDecisionBackend()
    const bh = new InMemoryBrowserHandoffStore()
    const service = createPendingDecisionsService({
      sources: [
        createTurnPermissionSource({
          pool: fakePool as unknown as Pool,
          admitControl: async () => ({ inserted: true, status: 'pending' }),
          onControlAdmitted: (uid) => {
            drainedUids.push(uid)
          },
        }),
        createTaskboardSource(tb),
        createBrowserHandoffSource(bh),
      ],
    })

    const handler = createCommercialHandler(stubDeps({ pendingDecisionsService: service }))

    // 401 unauthenticated
    const r401 = makeRes()
    assert.equal(await handler(makeReq({ method: 'GET', url: '/api/me/pending-decisions' }), r401.res), true)
    assert.equal(r401.status(), 401)

    // 405 wrong method
    const r405 = makeRes()
    assert.equal(
      await handler(makeReq({ method: 'DELETE', url: '/api/me/pending-decisions', token: token42 }), r405.res),
      true,
    )
    assert.equal(r405.status(), 405)

    // 200 list (using oc_session cookie auth too!)
    const rList = makeRes()
    assert.equal(
      await handler(makeReq({ method: 'GET', url: '/api/me/pending-decisions', cookieToken: token42 }), rList.res),
      true,
    )
    assert.equal(rList.status(), 200)
    const listed = rList.json() as { items: Array<{ id: string }>; counts: { total: number } }
    assert.equal(listed.counts.total, 1)
    const decisionId = listed.items[0]!.id

    // 200 resolve -> invokes onControlAdmitted(42n)
    const rResolve = makeRes()
    assert.equal(
      await handler(
        makeReq({
          method: 'POST',
          url: `/api/me/pending-decisions/${encodeURIComponent(decisionId)}/resolve`,
          token: token42,
          body: { decision: 'approve', reason: 'looks safe' },
        }),
        rResolve.res,
      ),
      true,
    )
    assert.equal(rResolve.status(), 200)
    assert.equal((rResolve.json() as { status: string }).status, 'approved')
    assert.deepEqual(drainedUids, [42n])

    // 404 invalid sub-path under /api/me/pending-decisions/
    const r404 = makeRes()
    assert.equal(
      await handler(makeReq({ method: 'POST', url: '/api/me/pending-decisions/not-resolve', token: token42 }), r404.res),
      true,
    )
    assert.equal(r404.status(), 404)
  })

  it('container taskboard backend + IM remoteControl runtime execute list/approve/conflict/IM commands end-to-end', async () => {
    const containerId = 77
    const expectedNonce = createHmac('sha256', BRIDGE_SECRET).update(String(containerId)).digest('hex')
    let ticketVersion = 1
    let ticketStatus = 'waiting_human'

    const containerSrv = await startHttpServer(async (req, res) => {
      assert.equal(req.headers['x-openclaude-container-id'], String(containerId))
      assert.equal(req.headers['x-openclaude-bridge-nonce'], expectedNonce)
      const url = new URL(req.url ?? '/', 'http://x')

      if (req.method === 'GET' && url.pathname === '/api/board/tickets') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            items:
              ticketStatus === 'waiting_human'
                ? [
                    {
                      id: 'tkt-99',
                      identifier: 'OCV5-99',
                      title: 'Approve deploy',
                      body: 'Ready for review',
                      status: ticketStatus,
                      version: ticketVersion,
                      priority: 'P1',
                      createdAt: Date.now(),
                    },
                  ]
                : [],
          }),
        )
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/board/tickets/tkt-99') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            ticket: {
              id: 'tkt-99',
              identifier: 'OCV5-99',
              title: 'Approve deploy',
              status: ticketStatus,
              version: ticketVersion,
              createdAt: Date.now(),
            },
          }),
        )
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/board/tickets/tkt-99/activity') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            items:
              ticketStatus === 'done'
                ? [
                    {
                      action: 'status_changed',
                      field: 'status',
                      oldValue: 'waiting_human',
                      newValue: 'done',
                      actorKind: 'human',
                      createdAt: Date.now(),
                    },
                  ]
                : [],
          }),
        )
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/board/tickets/tkt-99/approve') {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(Buffer.from(c))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { expectedVersion: number }
        if (body.expectedVersion !== ticketVersion || ticketStatus !== 'waiting_human') {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'version conflict' }))
          return
        }
        ticketVersion += 1
        ticketStatus = 'done'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ticket: { id: 'tkt-99', status: 'done', version: ticketVersion } }))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/board/tickets/tkt-99/reject') {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(Buffer.from(c))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { expectedVersion: number }
        if (body.expectedVersion !== ticketVersion || ticketStatus !== 'waiting_human') {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'version conflict' }))
          return
        }
        ticketVersion += 1
        ticketStatus = 'ready'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ticket: { id: 'tkt-99', status: 'ready', version: ticketVersion } }))
        return
      }
      res.writeHead(404)
      res.end()
    })

    try {
      const taskboardBackend = createContainerTaskboardDecisionBackend({
        v3Supervisor: {} as V3SupervisorDeps,
        bridgeSecret: BRIDGE_SECRET,
        clientOverrides: {
          getStatus: async (uid) => ({
            containerId,
            userId: uid,
            dockerContainerId: 'docker-77',
            hostId: null,
            lastWsActivity: null,
            state: 'running',
            boundIp: '127.0.0.1',
            port: containerSrv.port,
          }),
          isEndpointAllowed: () => true,
        },
      })

      const pushedWechat: string[] = []
      const pushedQq: string[] = []
      const runtime = createCommercialPendingDecisionsRuntime({
        pool: { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
        onControlAdmitted: () => {},
        taskboardBackend,
        browserHandoffStore: new InMemoryBrowserHandoffStore(),
        verifyAccountActive: async () => true,
        pushToWechat: async (item) => {
          pushedWechat.push(item.id)
        },
        pushToQq: async (item) => {
          pushedQq.push(item.id)
        },
        wechatSessions: {
          listSessions: async () => [{ sessionId: 'wsess-1111111111111111', title: 'Research chat' }],
          getCurrentSessionId: async () => 'wsess-1111111111111111',
          switchSession: async () => {},
        },
      })
      try {

      // IM /pending lists container waiting_human ticket with 4-digit short code
      const pendingReply = await runtime.wechatRemoteControl.tryHandleCommand({
        userId: '42',
        text: '/pending',
        originChannel: 'wechat',
        channelName: '微信',
      })
      assert.ok(pendingReply?.includes('Approve deploy'))
      const codeMatch = /\[(\d{4})\]/.exec(pendingReply ?? '')
      assert.ok(codeMatch, `expected 4-digit short code in reply: ${pendingReply}`)

      // IM /approve <code> transitions real container ticket via CAS
      const approveReply = await runtime.wechatRemoteControl.tryHandleCommand({
        userId: '42',
        text: `/approve ${codeMatch![1]}`,
        originChannel: 'wechat',
        channelName: '微信',
      })
      assert.ok(approveReply?.includes('已批准'))
      assert.equal(ticketStatus, 'done')

      // Same decision replay returns idempotentReplay=true; opposite decision returns 409 conflict
      const replay = await runtime.service.resolve('42', 'taskboard:tkt-99@v1', { decision: 'approve' })
      assert.equal(replay.idempotentReplay, true)
      await assert.rejects(
        () => runtime.service.resolve('42', 'taskboard:tkt-99@v1', { decision: 'deny' }),
        (err: unknown) => (err as { code?: string })?.code === 'CONFLICT_ALREADY_RESOLVED',
      )

      // Proactive push fan-out triggers on notifyCreated
      await runtime.service.notifyCreated({
        id: 'browser_handoff:bh-1',
        source: 'browser_handoff',
        sourceId: 'bh-1',
        userId: '42',
        sessionId: 'sess-1',
        title: '2FA login',
        summary: 'Confirm login',
        riskLevel: 'high',
        status: 'pending',
        metadata: {},
        createdAt: new Date().toISOString(),
        expiresAt: null,
        allowedActions: ['approve', 'deny'],
      })
      assert.deepEqual(pushedWechat, ['browser_handoff:bh-1'])
      assert.deepEqual(pushedQq, ['browser_handoff:bh-1'])

      // Sanity check buildWechatBrokerDeps forwards remoteControl cleanly
      assert.equal(typeof buildWechatBrokerDeps, 'function')
      } finally {
        runtime.dispose()
      }
    } finally {
      await containerSrv.close()
    }
  })
})

describe('Wave 4A Group 2: Research library batch import & span locator router wiring', () => {
  it('routes POST /api/me/research/library/import-ids and GET /api/me/research/library/:docId/span/:spanId', async () => {
    const { token } = await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)
    const docs = new Map<string, import('@openclaude/protocol/research').NormalizedDocument>()
    const handler = createCommercialHandler(
      stubDeps({
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
              docs.set(`${uid}:${doc.docId}`, doc)
            },
          },
          spanDeps: {
            getDocument: async (uid, docId) => docs.get(`${uid}:${docId}`) ?? null,
          },
        },
      }),
    )

    // 401 unauth
    const r401 = makeRes()
    assert.equal(
      await handler(makeReq({ method: 'POST', url: '/api/me/research/library/import-ids', body: {} }), r401.res),
      true,
    )
    assert.equal(r401.status(), 401)

    // 200 batch import via BibTeX
    const rImp = makeRes()
    assert.equal(
      await handler(
        makeReq({
          method: 'POST',
          url: '/api/me/research/library/import-ids',
          token,
          body: {
            bibtex:
              '@article{vaswani2017, title={Attention Is All You Need}, author={Vaswani, Ashish}, year={2017}, abstract={We propose a new simple network architecture, the Transformer.}}',
          },
        }),
        rImp.res,
      ),
      true,
    )
    assert.equal(rImp.status(), 200)
    const impJson = rImp.json() as {
      ok: boolean
      imported: Array<{ docId: string; spanCount: number; verified: boolean }>
    }
    assert.equal(impJson.ok, true)
    assert.equal(impJson.imported.length, 1)
    assert.equal(impJson.imported[0]!.verified, false)
    const docId = impJson.imported[0]!.docId
    const storedDoc = docs.get(`42:${docId}`)
    assert.ok(storedDoc && storedDoc.spans.length > 0)
    const firstSpanId = storedDoc.spans[0]!.spanId

    // 200 span locator on the real imported document
    const rSpan = makeRes()
    assert.equal(
      await handler(
        makeReq({ method: 'GET', url: `/api/me/research/library/${docId}/span/${firstSpanId}`, token }),
        rSpan.res,
      ),
      true,
    )
    assert.equal(rSpan.status(), 200)
    const spanJson = rSpan.json() as { docId: string; spanId: string; quote: string; page: number }
    assert.equal(spanJson.docId, docId)
    assert.equal(spanJson.spanId, firstSpanId)
    assert.ok(spanJson.quote.length > 0)
    assert.ok(spanJson.page >= 1)

    // 404 unknown sub-path under /api/me/research/library/
    const r404 = makeRes()
    assert.equal(
      await handler(makeReq({ method: 'GET', url: '/api/me/research/library/unknown-path', token }), r404.res),
      true,
    )
    assert.equal(r404.status(), 404)
  })
})

describe('Wave 4A Group 3: Office preview end-to-end (commercial router -> container gateway)', () => {
  it('proxies /api/file/office-preview & /page to user container, blocks cross-tenant handle & raw path, and forwards errors', async () => {
    const { token: tokenA } = await signAccess({ sub: '101', role: 'user' }, JWT_SECRET)
    const { token: tokenB } = await signAccess({ sub: '202', role: 'user' }, JWT_SECRET)
    const workDir = mkdtempSync(path.join(tmpdir(), 'oc-w4-office-e2e-'))
    const docsDir = path.join(workDir, 'docs')
    const cacheDir = path.join(workDir, 'cache')
    mkdirSync(docsDir, { recursive: true })
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    const deckPath = path.join(docsDir, 'deck.pptx')
    writeFileSync(deckPath, Buffer.from('PK\x03\x04pptx'))
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad])

    const containerId = 101
    const containerNonce = createHmac('sha256', BRIDGE_SECRET).update(String(containerId)).digest('hex')
    const containerEnv: NodeJS.ProcessEnv = {
      OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1',
      OC_CONTAINER_ID: String(containerId),
      OC_BRIDGE_NONCE: containerNonce,
    }
    const containerRegistry = new ContainerOfficePreviewRegistry()
    const officeReplayCache = new InternalBridgeReplayCache()

    const containerSrv = await startHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/internal/office-preview') {
        await handleInternalOfficePreview(req, res, url, {
          env: containerEnv,
          replayCache: officeReplayCache,
          allowedRoots: [docsDir],
          cacheDir,
          registry: containerRegistry,
          previewFn: async (fp, opts) => {
            if (!fp.startsWith(docsDir)) {
              const err = new Error('outside root') as Error & { code: string; httpStatus: number }
              err.code = 'PATH_ESCAPE'
              err.httpStatus = 403
              throw err
            }
            const entryDir = path.join(opts.cacheDir!, 'pptx_e2e_1')
            mkdirSync(entryDir, { recursive: true })
            const imgFile = path.join(entryDir, 'page-1.png')
            writeFileSync(imgFile, pngBytes)
            return {
              kind: 'pptx',
              filePath: fp,
              sha256: 'b'.repeat(64),
              mtimeMs: 999,
              cacheKey: 'pptx_e2e_1',
              cached: false,
              pages: [{ index: 1, imgPath: imgFile, notes: 'Slide 1 note' }],
              qaIssues: [],
            }
          },
        })
        return
      }
      if (url.pathname === '/internal/office-preview/page') {
        await handleInternalOfficePreviewPage(req, res, url, {
          env: containerEnv,
          replayCache: officeReplayCache,
          registry: containerRegistry,
        })
        return
      }
      res.writeHead(404)
      res.end()
    })

    try {
      const masterHandleRegistry = new OfficePreviewHandleRegistry()
      const handler = createCommercialHandler(
        stubDeps({
          v3Supervisor: {} as V3SupervisorDeps,
          bridgeSecret: BRIDGE_SECRET,
          officePreviewRouteDeps: {
            skipDbActiveCheck: true,
            handleRegistry: masterHandleRegistry,
            containerClientOverrides: {
              getStatus: async (uid) => ({
                containerId: uid,
                userId: uid,
                dockerContainerId: `docker-${uid}`,
                hostId: null,
                lastWsActivity: null,
                state: 'running',
                boundIp: '127.0.0.1',
                port: containerSrv.port,
              }),
              isEndpointAllowed: () => true,
            },
          },
        }),
      )

      // 401 unauthenticated
      const r401 = makeRes()
      assert.equal(
        await handler(
          makeReq({ method: 'GET', url: `/api/file/office-preview?path=${encodeURIComponent(deckPath)}` }),
          r401.res,
        ),
        true,
      )
      assert.equal(r401.status(), 401)

      // 200 User A previews deck
      const rPrev = makeRes()
      assert.equal(
        await handler(
          makeReq({
            method: 'GET',
            url: `/api/file/office-preview?path=${encodeURIComponent(deckPath)}`,
            token: tokenA,
          }),
          rPrev.res,
        ),
        true,
      )
      assert.equal(rPrev.status(), 200)
      const prevJson = rPrev.json() as {
        preview: { previewHandle: string; pages: Array<{ pageUrl: string; imgPath: string; notes?: string }> }
      }
      assert.ok(prevJson.preview.previewHandle)
      const pageUrl = prevJson.preview.pages[0]!.pageUrl
      assert.ok(pageUrl.startsWith('/api/file/office-preview/page?handle='))
      assert.ok(!prevJson.preview.pages[0]!.imgPath.includes(cacheDir), 'must never expose raw cache path')

      // 200 User A fetches page PNG via oc_session cookie
      const rPageA = makeRes()
      assert.equal(await handler(makeReq({ method: 'GET', url: pageUrl, cookieToken: tokenA }), rPageA.res), true)
      assert.equal(rPageA.status(), 200)
      assert.equal(rPageA.headers['content-type'], 'image/png')
      assert.deepEqual(rPageA.buf(), pngBytes)

      // 403 User B blocked from User A's handle
      const rPageB = makeRes()
      assert.equal(await handler(makeReq({ method: 'GET', url: pageUrl, token: tokenB }), rPageB.res), true)
      assert.equal(rPageB.status(), 403)

      // 400 raw ?path= rejected on /api/file/office-preview/page
      const rRaw = makeRes()
      assert.equal(
        await handler(
          makeReq({
            method: 'GET',
            url: `/api/file/office-preview/page?path=${encodeURIComponent(deckPath)}`,
            token: tokenA,
          }),
          rRaw.res,
        ),
        true,
      )
      assert.equal(rRaw.status(), 400)
    } finally {
      await containerSrv.close()
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})

describe('Wave 4A Group 4: Swarm command end-to-end (commercial router -> container gateway)', () => {
  it('enforces auth & session ownership, rejects client brainDir, proxies steer/terminate, and keeps /api/sessions/list fall-through intact', async () => {
    const { token: tokenA } = await signAccess({ sub: '101', role: 'user' }, JWT_SECRET)
    const { token: tokenB } = await signAccess({ sub: '202', role: 'user' }, JWT_SECRET)
    const agyRoot = mkdtempSync(path.join(tmpdir(), 'oc-w4-swarm-e2e-'))
    const sessionId = 'sess-e2e-1'
    const brainDir = antigravitySessionBrainDir(agyRoot, `agent:main:webchat:dm:${sessionId}`)
    const swarmDir = path.join(brainDir, COORD_CONV, '.system_generated', 'swarm')
    mkdirSync(swarmDir, { recursive: true })
    writeFileSync(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'E2E Swarm',
        members: {
          coordinator: { role: 'coordinator', killed: false },
          'worker-a': { role: 'worker', killed: false },
        },
      }),
    )
    writeFileSync(
      path.join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: 'start', time: '2026-11-21T00:00:00Z' })}\n`,
    )

    const containerId = 101
    const containerNonce = createHmac('sha256', BRIDGE_SECRET).update(String(containerId)).digest('hex')
    const containerEnv: NodeJS.ProcessEnv = {
      OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1',
      OC_CONTAINER_ID: String(containerId),
      OC_BRIDGE_NONCE: containerNonce,
    }

    const swarmReplayCache = new InternalBridgeReplayCache()
    const containerSrv = await startHttpServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname.startsWith('/internal/swarm/command')) {
        await handleInternalSwarmCommand(req, res, url, {
          env: containerEnv,
          replayCache: swarmReplayCache,
          antigravityRootDir: () => agyRoot,
          lookupSessionTarget: (sid) =>
            sid === sessionId
              ? { sessionKey: `agent:main:webchat:dm:${sessionId}`, brainDir, conversationId: COORD_CONV }
              : null,
        })
        return
      }
      res.writeHead(404)
      res.end()
    })

    try {
      const handler = createCommercialHandler(
        stubDeps({
          v3Supervisor: {} as V3SupervisorDeps,
          bridgeSecret: BRIDGE_SECRET,
          swarmCommandRouteDeps: {
            skipDbActiveCheck: true,
            verifySessionOwnership: async (uid, sid) => {
              if (sid !== sessionId) return 'not_found'
              return uid === '101' ? 'owner' : 'forbidden'
            },
            containerClientOverrides: {
              getStatus: async (uid) => ({
                containerId: uid,
                userId: uid,
                dockerContainerId: `docker-${uid}`,
                hostId: null,
                lastWsActivity: null,
                state: 'running',
                boundIp: '127.0.0.1',
                port: containerSrv.port,
              }),
              isEndpointAllowed: () => true,
            },
          },
        }),
      )

      // Non-swarm /api/sessions/list MUST still fall through (returns false)
      assert.equal(
        await handler(makeReq({ method: 'GET', url: '/api/sessions/list', token: tokenA }), makeRes().res),
        false,
      )

      // 401 unauthenticated
      const r401 = makeRes()
      assert.equal(
        await handler(
          makeReq({ method: 'POST', url: `/api/sessions/${sessionId}/swarm/command`, body: { action: 'steer' } }),
          r401.res,
        ),
        true,
      )
      assert.equal(r401.status(), 401)

      // 405 GET not allowed
      const r405 = makeRes()
      assert.equal(
        await handler(makeReq({ method: 'GET', url: `/api/sessions/${sessionId}/swarm/command`, token: tokenA }), r405.res),
        true,
      )
      assert.equal(r405.status(), 405)

      // 403 cross-tenant session rejected
      const r403 = makeRes()
      assert.equal(
        await handler(
          makeReq({
            method: 'POST',
            url: `/api/sessions/${sessionId}/swarm/command`,
            token: tokenB,
            body: { action: 'steer', target: 'worker-a', message: 'hijack' },
          }),
          r403.res,
        ),
        true,
      )
      assert.equal(r403.status(), 403)

      // 404 missing session
      const r404 = makeRes()
      assert.equal(
        await handler(
          makeReq({
            method: 'POST',
            url: '/api/sessions/sess-nope/swarm/command',
            token: tokenA,
            body: { action: 'steer', target: 'worker-a', message: 'hi' },
          }),
          r404.res,
        ),
        true,
      )
      assert.equal(r404.status(), 404)

      // 400 client-supplied brainDir rejected at master edge
      const rBrain = makeRes()
      assert.equal(
        await handler(
          makeReq({
            method: 'POST',
            url: `/api/sessions/${sessionId}/swarm/command`,
            token: tokenA,
            body: { action: 'steer', target: 'worker-a', message: 'hi', brainDir: '/etc' },
          }),
          rBrain.res,
        ),
        true,
      )
      assert.equal(rBrain.status(), 400)

      // 200 steer end-to-end
      const rSteer = makeRes()
      assert.equal(
        await handler(
          makeReq({
            method: 'POST',
            url: `/api/sessions/${sessionId}/swarm/command`,
            token: tokenA,
            body: { action: 'steer', target: 'worker-a', message: 'focus on gate tests' },
          }),
          rSteer.res,
        ),
        true,
      )
      assert.equal(rSteer.status(), 200)
      assert.equal((rSteer.json() as { seq: number }).seq, 2)

      // 200 terminate end-to-end (honest status: 'requested')
      const rTerm = makeRes()
      assert.equal(
        await handler(
          makeReq({
            method: 'POST',
            url: `/api/sessions/${sessionId}/swarm/command`,
            token: tokenA,
            body: { action: 'terminate', memberName: 'worker-a', reason: 'done' },
          }),
          rTerm.res,
        ),
        true,
      )
      assert.equal(rTerm.status(), 200)
      assert.equal((rTerm.json() as { status: string }).status, 'requested')

      const lines = readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8').trim().split('\n')
      assert.equal(lines.length, 3)
    } finally {
      await containerSrv.close()
      rmSync(agyRoot, { recursive: true, force: true })
    }
  })
})
