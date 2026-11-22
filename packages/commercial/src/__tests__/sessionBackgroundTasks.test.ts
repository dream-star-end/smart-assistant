/**
 * Unit tests for Muse session job listing/cancellation and commercial
 * `sessionBackgroundTasksProxy` (OCV5-844).
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/sessionBackgroundTasks.test.ts
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { verifyInternalBridgeAuthDetailed } from '@openclaude/gateway'
import type { V3ContainerStatus, V3SupervisorDeps } from '../agent-sandbox/v3supervisor.js'
import { signAccess } from '../auth/jwt.js'
import type { Mailer } from '../auth/mail.js'
import type { CommercialHttpDeps } from '../http/handlers.js'
import { createCommercialHandler } from '../http/router.js'
import type { MuseBilling } from '../muse/billing.js'
import type { MuseDurability, MuseDurableState } from '../muse/durable.js'
import { MuseBridgeHub } from '../muse/hub.js'
import { MuseError } from '../muse/protocol.js'
import type {
  MuseJobFinish,
  MuseJobInsert,
  MuseJobRecord,
  MuseJobStatus,
  MuseSessionJobRecord,
  MuseStore,
} from '../muse/store.js'

const JWT_SECRET = 'test-commercial-jwt-secret-0123456789abcdef'
const BRIDGE_SECRET = 'test-bridge-secret-0123456789abcdef'

class FakeMuseStore implements MuseStore, MuseDurability {
  readonly rows = new Map<
    string,
    {
      id: string
      userId: string
      kind: 'image' | 'video'
      promptPreview: string
      status: MuseJobStatus
      errorCode: string | null
      queuedAt: number
      startedAt?: number
      finishedAt?: number
      durable?: MuseDurableState
    }
  >()
  async insertJob(row: MuseJobInsert): Promise<void> {
    this.rows.set(row.id, {
      id: row.id,
      userId: row.userId,
      kind: row.kind,
      promptPreview: row.promptPreview,
      status: 'queued',
      errorCode: null,
      queuedAt: Date.now(),
      durable: row.durable,
    })
  }
  async markRunning(id: string): Promise<void> {
    const r = this.rows.get(id)
    if (r) {
      r.status = 'running'
      r.startedAt = Date.now()
    }
  }
  async finishJob(id: string, fin: MuseJobFinish): Promise<void> {
    const r = this.rows.get(id)
    if (r && (r.status === 'queued' || r.status === 'running')) {
      r.status = fin.status
      r.errorCode = fin.errorCode
      r.finishedAt = Date.now()
    }
  }
  async countRecent(): Promise<{ hour: number; day: number }> {
    return { hour: 0, day: 0 }
  }
  async countSiteToday(): Promise<number> {
    return 0
  }
  async failOrphans(): Promise<number> {
    return 0
  }
  async findJob(userId: string, id: string): Promise<MuseJobRecord | null> {
    const r = this.rows.get(id)
    if (!r || r.userId !== userId) return null
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      errorCode: r.errorCode,
      files: null,
      snapshotId: null,
      durable: r.durable,
      debitedCredits: null,
    }
  }
  async listSessionJobs(userId: string, sessionId: string): Promise<MuseSessionJobRecord[]> {
    const out: MuseSessionJobRecord[] = []
    for (const r of this.rows.values()) {
      if (r.userId !== userId || r.durable?.sessionId !== sessionId) continue
      if (r.status === 'queued' || r.status === 'running' || (r.finishedAt && Date.now() - r.finishedAt < 10 * 60_000)) {
        out.push({
          id: r.id,
          kind: r.kind,
          status: r.status,
          promptPreview: r.promptPreview,
          queuedAt: r.queuedAt,
          ...(r.startedAt ? { startedAt: r.startedAt } : {}),
          ...(r.errorCode ? { errorCode: r.errorCode } : {}),
        })
      }
    }
    return out.sort((a, b) => b.queuedAt - a.queuedAt).slice(0, 10)
  }
  async cancelSessionJob(
    userId: string,
    sessionId: string,
    jobId: string,
  ): Promise<{ cancelled: boolean; status: MuseJobStatus } | null> {
    const r = this.rows.get(jobId)
    if (!r || r.userId !== userId || r.durable?.sessionId !== sessionId) return null
    if (r.status === 'queued' || r.status === 'running') {
      r.status = 'cancelled'
      r.errorCode = 'MUSE_CANCELLED'
      r.finishedAt = Date.now()
      return { cancelled: true, status: 'cancelled' }
    }
    return { cancelled: false, status: r.status }
  }
  async openCredits(): Promise<bigint> {
    return 0n
  }
  async findCredential(): Promise<{ id: string } | null> {
    return null
  }
  async touchCredential(): Promise<void> {}
  async validateOrigin(_userId: string, sessionKey: string): Promise<{ sessionId: string; agentId: string }> {
    const sid = sessionKey.includes(':') ? sessionKey.slice(sessionKey.lastIndexOf(':') + 1) : sessionKey
    return { sessionId: sid, agentId: 'main' }
  }
  async save(): Promise<void> {}
  async release(): Promise<void> {}
  async claim() {
    return []
  }
  async deliver(): Promise<void> {}
  async protectedFile(): Promise<boolean> {
    return false
  }
}

function makeReq(opts: { method: string; url: string; token?: string }): IncomingMessage {
  const stream = Readable.from([]) as unknown as IncomingMessage
  stream.method = opts.method
  stream.url = opts.url
  stream.headers = {
    host: 'localhost',
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
  }
  ;(stream as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: '127.0.0.1',
  }
  return stream
}

function makeRes() {
  let statusCode = 200
  let headersSent = false
  const headers: Record<string, string | string[]> = {}
  let body = ''
  const res = {
    get statusCode() {
      return statusCode
    },
    set statusCode(v: number) {
      statusCode = v
    },
    get headersSent() {
      return headersSent
    },
    setHeader(k: string, v: string | string[]) {
      headers[k.toLowerCase()] = v
    },
    getHeader(k: string) {
      return headers[k.toLowerCase()]
    },
    writeHead(code: number, h?: Record<string, string | string[]>) {
      statusCode = code
      if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v
    },
    end(chunk?: string | Buffer) {
      headersSent = true
      if (chunk) body += chunk.toString()
    },
  } as unknown as ServerResponse
  return {
    res,
    read: () => ({
      status: statusCode,
      json: body ? (JSON.parse(body) as Record<string, unknown>) : null,
    }),
  }
}

async function makeJwt(userId: string): Promise<string> {
  return (await signAccess({ sub: userId, role: 'user' }, JWT_SECRET)).token
}

describe('MuseBridgeHub session jobs query & cancel (OCV5-844)', () => {
  it('lists queued session jobs with live queuePosition/queueLength and cancels with zero billing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-muse-sess-'))
    const store = new FakeMuseStore()
    let settleCalls = 0
    const billing: MuseBilling = {
      price: () => 500n,
      ensureBalance: async () => {},
      settle: async () => {
        settleCalls += 1
        return { debitedCredits: 500n, ledgerId: 1n, clamped: false }
      },
      outcome: async () => ({ charged: false, debitedCredits: null }),
    }
    const hub = new MuseBridgeHub({
      store,
      durability: store,
      stateRoot: root,
      allowedUids: 'all',
      rate: { imagePerHour: 100, imagePerDay: 100, videoPerHour: 100, videoPerDay: 100 },
      cliTimeoutSec: { image: 60, video: 300 },
      billing,
      concurrency: 1,
    })
    try {
      hub.hello('cred-1', '0.5.0')
      const id1 = await hub.submit(
        '101',
        null,
        { kind: 'video', prompt: 'sunset over ocean' },
        { sessionKey: 'agent:main:webchat:dm:sess-v1' },
      )
      const id2 = await hub.submit(
        '101',
        null,
        { kind: 'video', prompt: 'neon city timelapse' },
        { sessionKey: 'agent:main:webchat:dm:sess-v1' },
      )

      const list = await hub.listSessionJobs('101', 'sess-v1')
      assert.equal(list.length, 2)
      const item1 = list.find((j) => j.id === id1)!
      const item2 = list.find((j) => j.id === id2)!
      assert.equal(item1.status, 'queued')
      assert.equal(item1.queuePosition, 1)
      assert.equal(item1.queueLength, 2)
      assert.equal(item2.queuePosition, 2)
      assert.equal(item2.queueLength, 2)

      // Cross-session and cross-user cancel rejected (null)
      assert.equal(await hub.cancelSessionJob('101', 'sess-other', id1), null)
      assert.equal(await hub.cancelSessionJob('999', 'sess-v1', id1), null)

      // Owner cancel succeeds with zero billing
      const cancelled = await hub.cancelSessionJob('101', 'sess-v1', id1)
      assert.deepEqual(cancelled, { ok: true, cancelled: true, status: 'cancelled' })
      assert.equal(settleCalls, 0, 'cancelled job must never settle/charge credits')

      // Repeat cancel is idempotent
      const again = await hub.cancelSessionJob('101', 'sess-v1', id1)
      assert.deepEqual(again, { ok: true, cancelled: false, status: 'cancelled' })

      // Refuse cancel while settling to prevent billing race
      const rawJobs = (hub as unknown as { jobs: Map<string, { settling: boolean }> }).jobs
      rawJobs.get(id2)!.settling = true
      const duringSettle = await hub.cancelSessionJob('101', 'sess-v1', id2)
      assert.deepEqual(duringSettle, { ok: true, cancelled: false, status: 'running' })
      rawJobs.get(id2)!.settling = false

      // PG fallback cancel when job is durable background and not in hub memory
      const bgId = 'mj_11111111-1111-1111-1111-111111111111'
      store.rows.set(bgId, {
        id: bgId,
        userId: '101',
        kind: 'video',
        promptPreview: 'durable background video',
        status: 'queued',
        errorCode: null,
        queuedAt: Date.now(),
        durable: {
          sessionId: 'sess-v1',
          agentId: 'main',
          spec: { kind: 'video', prompt: 'durable background video' },
          nonce: 'n1',
          background: true,
          backgroundFailures: 0,
          retryCount: 0,
          retryAt: 0,
          state: 'queued',
          expiresAt: Date.now() + 60_000,
        },
      })
      const dbCancel = await hub.cancelSessionJob('101', 'sess-v1', bgId)
      assert.deepEqual(dbCancel, { ok: true, cancelled: true, status: 'cancelled' })
      assert.equal(store.rows.get(bgId)?.status, 'cancelled')
      assert.equal(store.rows.get(bgId)?.errorCode, 'MUSE_CANCELLED')
    } finally {
      await hub.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws 503 MUSE_CANCEL_PERSIST_FAILED instead of returning 200 when durable PG cancel fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-muse-pgfail-'))
    const store = new FakeMuseStore()
    store.finishJob = async () => {
      throw new Error('pg write failed')
    }
    store.cancelSessionJob = async () => {
      throw new Error('pg conditional cancel failed')
    }
    const hub = new MuseBridgeHub({
      store,
      durability: store,
      stateRoot: root,
      allowedUids: 'all',
      rate: { imagePerHour: 100, imagePerDay: 100, videoPerHour: 100, videoPerDay: 100 },
      cliTimeoutSec: { image: 60, video: 300 },
    })
    try {
      hub.hello('cred-1', '0.5.0')
      const jobId = await hub.submit(
        '101',
        null,
        { kind: 'video', prompt: 'fail pg persist' },
        { sessionKey: 'agent:main:webchat:dm:sess-pgfail' },
      )
      await assert.rejects(
        () => hub.cancelSessionJob('101', 'sess-pgfail', jobId),
        (err: unknown) =>
          err instanceof MuseError &&
          err.status === 503 &&
          err.code === 'MUSE_CANCEL_PERSIST_FAILED',
      )

      // Also verify HTTP route maps MuseError(503) cleanly to 503 MUSE_CANCEL_PERSIST_FAILED
      const httpHandler = createCommercialHandler({
        jwtSecret: JWT_SECRET,
        mailer: { send: async () => {} } as unknown as Mailer,
        redis: { incr: async () => 1, expire: async () => 1 },
        verifyActiveAccount: async () => true,
        museHub: hub,
        sessionBackgroundTasksRouteDeps: {
          skipDbActiveCheck: true,
          verifySessionOwnership: async () => 'owner',
        },
      })
      const r503 = makeRes()
      const tok = await makeJwt('101')
      await httpHandler(
        makeReq({ method: 'POST', url: `/api/sessions/sess-pgfail/muse-jobs/${jobId}/cancel`, token: tok }),
        r503.res,
      )
      assert.equal(r503.read().status, 503)
      assert.equal((r503.read().json?.error as { code?: string })?.code, 'MUSE_CANCEL_PERSIST_FAILED')
    } finally {
      await hub.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('sessionBackgroundTasksProxy HTTP routes (OCV5-844)', () => {
  const baseDeps = (): CommercialHttpDeps => ({
    jwtSecret: JWT_SECRET,
    mailer: { send: async () => {} } as unknown as Mailer,
    redis: {
      incr: async () => 1,
      expire: async () => 1,
    },
    verifyActiveAccount: async () => true,
  })

  it('enforces 401/403/404 isolation and NEVER wakes a sleeping container', async () => {
    let ensureReadyCalls = 0
    const root = mkdtempSync(join(tmpdir(), 'oc-bg-proxy-sleep-'))
    const store = new FakeMuseStore()
    const hub = new MuseBridgeHub({
      store,
      durability: store,
      stateRoot: root,
      allowedUids: 'all',
      rate: { imagePerHour: 100, imagePerDay: 100, videoPerHour: 100, videoPerDay: 100 },
      cliTimeoutSec: { image: 60, video: 300 },
    })
    store.rows.set('mj_22222222-2222-2222-2222-222222222222', {
      id: 'mj_22222222-2222-2222-2222-222222222222',
      userId: '101',
      kind: 'video',
      promptPreview: 'sleeping container muse job',
      status: 'queued',
      errorCode: null,
      queuedAt: Date.now(),
      durable: {
        sessionId: 'sess-mine-01',
        agentId: 'main',
        spec: { kind: 'video', prompt: 'sleeping container muse job' },
        nonce: 'n2',
        background: true,
        backgroundFailures: 0,
        retryCount: 0,
        retryAt: 0,
        state: 'queued',
        expiresAt: Date.now() + 60_000,
      },
    })

    const handler = createCommercialHandler({
      ...baseDeps(),
      museHub: hub,
      v3Supervisor: { selfHostId: 'self' } as unknown as V3SupervisorDeps,
      bridgeSecret: BRIDGE_SECRET,
      ensureContainerReady: async () => {
        ensureReadyCalls += 1
      },
      sessionBackgroundTasksRouteDeps: {
        skipDbActiveCheck: true,
        isInflightSurfaceAdvertised: () => true,
        verifySessionOwnership: async (uid, sid) => {
          if (sid === 'sess-missing-99') return 'not_found'
          if (sid === 'sess-other-02') return 'forbidden'
          return uid === '101' && sid === 'sess-mine-01' ? 'owner' : 'forbidden'
        },
        getContainerStatus: async () => ({
          state: 'stopped',
          containerId: 77,
          boundIp: '127.0.0.1',
          port: 18789,
        } as unknown as V3ContainerStatus),
      },
    })

    try {
      // 401 unauthenticated
      const r401 = makeRes()
      assert.equal(await handler(makeReq({ method: 'GET', url: '/api/sessions/sess-mine-01/background-tasks' }), r401.res), true)
      assert.equal(r401.read().status, 401)

      const tok = await makeJwt('101')
      // 403 forbidden (another user's session)
      const r403 = makeRes()
      await handler(makeReq({ method: 'GET', url: '/api/sessions/sess-other-02/background-tasks', token: tok }), r403.res)
      assert.equal(r403.read().status, 403)

      // 404 missing session returns SESSION_NOT_FOUND (so frontend distinguishes from missing route)
      const r404 = makeRes()
      await handler(makeReq({ method: 'GET', url: '/api/sessions/sess-missing-99/background-tasks', token: tok }), r404.res)
      assert.equal(r404.read().status, 404)
      assert.equal((r404.read().json?.error as { code?: string })?.code, 'SESSION_NOT_FOUND')

      // 200 sleeping container: fail-open empty delegates, bgCommands, sessionCrons; real museJobs; NEVER wakes container
      const rSleep = makeRes()
      await handler(makeReq({ method: 'GET', url: '/api/sessions/sess-mine-01/background-tasks', token: tok }), rSleep.res)
      assert.equal(rSleep.read().status, 200)
      assert.deepEqual(rSleep.read().json?.delegates, [])
      assert.deepEqual(rSleep.read().json?.bgCommands, [])
      assert.deepEqual(rSleep.read().json?.sessionCrons, [])
      assert.equal((rSleep.read().json?.museJobs as unknown[]).length, 1)

      // 200 inflight-delegates while container sleeping: empty items, never wakes container
      const rInfl = makeRes()
      await handler(makeReq({ method: 'GET', url: '/api/sessions/sess-mine-01/inflight-delegates', token: tok }), rInfl.res)
      assert.equal(rInfl.read().status, 200)
      assert.deepEqual(rInfl.read().json, { enabled: true, items: [], nextCursor: null, truncated: false })

      // POST bg-command cancel while container sleeping → idempotent alreadyExited, never wakes container
      const rBgSleep = makeRes()
      await handler(makeReq({ method: 'POST', url: '/api/sessions/sess-mine-01/bg-commands/123-ocb_1/cancel', token: tok }), rBgSleep.res)
      assert.equal(rBgSleep.read().status, 200)
      assert.deepEqual(rBgSleep.read().json, { ok: true, cancelled: false, alreadyExited: true })

      // POST muse cancel works even while container is sleeping!
      const rMuse = makeRes()
      await handler(
        makeReq({
          method: 'POST',
          url: '/api/sessions/sess-mine-01/muse-jobs/mj_22222222-2222-2222-2222-222222222222/cancel',
          token: tok,
        }),
        rMuse.res,
      )
      assert.equal(rMuse.read().status, 200)
      assert.deepEqual(rMuse.read().json, { ok: true, cancelled: true, status: 'cancelled' })

      assert.equal(ensureReadyCalls, 0, 'background task routes must NEVER wake a sleeping container')
    } finally {
      await hub.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('proxies to running container with verified HMAC bridge auth and aggregates real delegates + bgCommands + museJobs', async () => {
    const containerId = 88
    const containerBridgeNonce = createHmac('sha256', BRIDGE_SECRET).update(String(containerId)).digest('hex')
    const containerEnv = {
      OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1',
      OC_CONTAINER_ID: String(containerId),
      OC_BRIDGE_NONCE: containerBridgeNonce,
    }
    const receivedPaths: string[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      const body = Buffer.concat(chunks)
      const auth = verifyInternalBridgeAuthDetailed(req, { env: containerEnv, body })
      if (!auth.ok) {
        res.writeHead(auth.status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, code: auth.code }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://container')
      receivedPaths.push(`${req.method} ${url.pathname}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (url.pathname === '/internal/sessions/sess-run-01/background-state') {
        res.end(
          JSON.stringify({
            delegates: [{ jobId: 'dlgjob-live-1', agentId: 'coder', state: 'running', goal: 'fix bug' }],
            nextCursor: null,
            truncated: false,
            bgCommands: [{ id: '444-ocb_1', jobId: 'ocb_1', commandPreview: 'npm test', startedAt: 1000, updatedAt: 1000 }],
            sessionCrons: [
              {
                id: 'cron-live-1',
                name: 'Follow up',
                enabled: true,
                schedule: '0 9 * * *',
                message: 'check status',
                nextRunAt: 1700003600000,
                resume: 'origin-session',
                sourceSessionKey: 'agent:main:webchat:dm:sess-run-01',
              },
            ],
          }),
        )
        return
      }
      if (url.pathname === '/internal/sessions/sess-run-01/inflight-delegates/dlgjob-live-1/cancel') {
        res.end(JSON.stringify({ ok: true, cancelled: true, state: 'cancelled' }))
        return
      }
      if (url.pathname === '/internal/sessions/sess-run-01/bg-commands/444-ocb_1/cancel') {
        res.end(JSON.stringify({ ok: true, cancelled: true }))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const runningStatus = {
      state: 'running',
      containerId,
      boundIp: '127.0.0.1',
      port,
    } as unknown as V3ContainerStatus

    const handler = createCommercialHandler({
      ...baseDeps(),
      v3Supervisor: { selfHostId: 'self' } as unknown as V3SupervisorDeps,
      bridgeSecret: BRIDGE_SECRET,
      sessionBackgroundTasksRouteDeps: {
        skipDbActiveCheck: true,
        isInflightSurfaceAdvertised: () => true,
        verifySessionOwnership: async () => 'owner',
        getContainerStatus: async () => runningStatus,
        containerClientOverrides: {
          isEndpointAllowed: () => true,
        },
      },
    })

    try {
      const tok = await makeJwt('101')
      // 1. GET /api/sessions/:id/background-tasks
      const r1 = makeRes()
      await handler(makeReq({ method: 'GET', url: '/api/sessions/sess-run-01/background-tasks', token: tok }), r1.res)
      assert.equal(r1.read().status, 200)
      assert.equal((r1.read().json?.delegates as Array<{ jobId: string }>)[0]?.jobId, 'dlgjob-live-1')
      assert.equal((r1.read().json?.bgCommands as Array<{ id: string }>)[0]?.id, '444-ocb_1')
      assert.equal((r1.read().json?.sessionCrons as Array<{ id: string }>)[0]?.id, 'cron-live-1')
      assert.deepEqual(r1.read().json?.museJobs, [])

      // 2. GET /api/sessions/:id/inflight-delegates reads real container delegates!
      const r2 = makeRes()
      await handler(makeReq({ method: 'GET', url: '/api/sessions/sess-run-01/inflight-delegates', token: tok }), r2.res)
      assert.equal(r2.read().status, 200)
      assert.equal(r2.read().json?.enabled, true)
      assert.equal((r2.read().json?.items as Array<{ jobId: string }>)[0]?.jobId, 'dlgjob-live-1')

      // 3. POST /api/sessions/:id/inflight-delegates/:jobId/cancel
      const r3 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/api/sessions/sess-run-01/inflight-delegates/dlgjob-live-1/cancel', token: tok }),
        r3.res,
      )
      assert.equal(r3.read().status, 200)
      assert.deepEqual(r3.read().json, { ok: true, cancelled: true, state: 'cancelled' })

      // 4. POST /api/sessions/:id/bg-commands/:jobId/cancel rejects malformed id at master edge
      const rBad = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/api/sessions/sess-run-01/bg-commands/..%2Fevil/cancel', token: tok }),
        rBad.res,
      )
      assert.equal(rBad.read().status, 400)

      // 5. Valid POST bg-command cancel
      const r4 = makeRes()
      await handler(
        makeReq({ method: 'POST', url: '/api/sessions/sess-run-01/bg-commands/444-ocb_1/cancel', token: tok }),
        r4.res,
      )
      assert.equal(r4.read().status, 200)
      assert.deepEqual(r4.read().json, { ok: true, cancelled: true })

      assert.deepEqual(receivedPaths, [
        'GET /internal/sessions/sess-run-01/background-state',
        'GET /internal/sessions/sess-run-01/background-state',
        'POST /internal/sessions/sess-run-01/inflight-delegates/dlgjob-live-1/cancel',
        'POST /internal/sessions/sess-run-01/bg-commands/444-ocb_1/cancel',
      ])
    } finally {
      server.close()
    }
  })
})
