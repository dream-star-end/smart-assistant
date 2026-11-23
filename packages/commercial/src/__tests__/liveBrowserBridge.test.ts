import * as assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  LIVE_BROWSER_ASSERTION_HEADER,
  LIVE_BROWSER_INTERNAL_WS_PATH,
  LIVE_BROWSER_PUBLIC_WS_PATH,
  LIVE_BROWSER_TICKET_PROTOCOL,
  decodeLiveBrowserFrame,
  encodeLiveBrowserFrame,
} from '@openclaude/protocol'
import {
  verifyContainerPreviewAssertion,
  verifyLiveBrowserAssertion,
} from '@openclaude/protocol/containerPreviewAuth'
import { WebSocket, WebSocketServer } from 'ws'

import { signAccess } from '../auth/jwt.js'
import { createCommercialPendingDecisionsRuntime } from '../bootstrap/pendingDecisionsBootstrap.js'
import { handleCreateLiveBrowserStreamTicket } from '../http/liveBrowserTicket.js'
import {
  emitOutboundBrowserHandoffFrame,
  extractBrowserHandoffCardsFromText,
} from '../pendingDecisions/pgBrowserHandoffStore.js'
import { InMemoryBrowserHandoffStore } from '../pendingDecisions/sources.js'
import { AuthoritySigner } from '../ws/authoritySigner.js'
import {
  claimUnavailableLiveBrowserUpgrade,
  createLiveBrowserBridge,
} from '../ws/liveBrowserBridge.js'
import { LIVE_BROWSER_TICKET_TTL_MS, LiveBrowserTicketStore } from '../ws/liveBrowserTickets.js'
import { _buildTunnelHeaders } from '../ws/tunnelContainerSocket.js'

const JWT_SECRET = 'test-live-browser-jwt-secret-32-chars!!'

function makeFakeRes() {
  const headers = new Map<string, string>()
  let statusCode = 0
  let body = ''
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value))
    },
    writeHead(code: number, hdrs?: Record<string, string | number>) {
      statusCode = code
      ;(res as { statusCode: number }).statusCode = code
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          headers.set(k.toLowerCase(), String(v))
        }
      }
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += chunk.toString()
    },
  } as unknown as ServerResponse
  return {
    res,
    headers,
    get statusCode() {
      return statusCode || res.statusCode
    },
    json() {
      return body ? JSON.parse(body) : null
    },
  }
}

describe('LiveBrowserTicketStore & tunnel headers', () => {
  it('issues, atomically consumes once, expires, and replaces per-(uid, agentId) slot', () => {
    let now = 1_700_000_000_000
    const store = new LiveBrowserTicketStore(() => now)

    const t1 = store.issue(42n, 'main')
    assert.equal(t1.uid, 42n)
    assert.equal(t1.agentId, 'main')
    assert.equal(t1.expiresAt, now + LIVE_BROWSER_TICKET_TTL_MS)

    // Re-issuing for same (uid, agentId) invalidates prior pending ticket
    const t2 = store.issue(42n, 'main')
    assert.equal(store.consume(t1.ticket), null)

    // Atomic one-time consume
    const rec = store.consume(t2.ticket)
    assert.deepEqual(rec, { uid: 42n, agentId: 'main', expiresAt: now + LIVE_BROWSER_TICKET_TTL_MS })
    assert.equal(store.consume(t2.ticket), null)

    // Expired ticket rejected
    const t3 = store.issue(42n, 'coder')
    now += LIVE_BROWSER_TICKET_TTL_MS + 1
    assert.equal(store.consume(t3.ticket), null)

    // Invalid agentId rejected
    assert.throws(() => store.issue(42n, '../etc/passwd'))
  })

  it('writes X-OpenClaude-Live-Browser-Assertion in tunnel headers without affecting preview header', () => {
    const headers = _buildTunnelHeaders('deadbeef', 'trace-123', undefined, 'lb-assertion-token')
    assert.equal(headers.Authorization, 'Bearer deadbeef')
    assert.equal(headers['X-Connection-Trace-Id'], 'trace-123')
    assert.equal(headers['X-OpenClaude-Live-Browser-Assertion'], 'lb-assertion-token')
    assert.equal(headers['X-OpenClaude-Preview-Assertion'], undefined)
  })
})

describe('POST /api/agents/:id/browser/stream-ticket', () => {
  it('enforces auth, active DB check, availability, and mints a one-time stream ticket', async () => {
    const tickets = new LiveBrowserTicketStore()
    const { token } = await signAccess({ sub: '42', role: 'user' }, JWT_SECRET)

    const fakeCtx = {
      requestId: 'req-1',
      clientIp: '127.0.0.1',
      authBoundIp: '127.0.0.1',
      userAgent: 'test',
      log: { info() {}, warn() {}, error() {}, debug() {}, child() { return this } },
    } as any

    const fakeRes = makeFakeRes()
    await handleCreateLiveBrowserStreamTicket(
      {
        method: 'POST',
        url: '/api/agents/main/browser/stream-ticket',
        headers: { authorization: `Bearer ${token}` },
      } as IncomingMessage,
      fakeRes.res,
      fakeCtx,
      {
        jwtSecret: JWT_SECRET,
        v3Supervisor: { pool: {} } as any,
        verifyActiveAccount: async (uid: string) => uid === '42',
        liveBrowserTickets: tickets,
        liveBrowserStreamAvailable: () => true,
      } as any,
    )

    assert.equal(fakeRes.statusCode, 201)
    assert.equal(fakeRes.headers.get('cache-control'), 'no-store')
    const body = fakeRes.json()
    assert.equal(body.agentId, 'main')
    assert.equal(body.wsPath, LIVE_BROWSER_PUBLIC_WS_PATH)
    assert.equal(body.protocol, LIVE_BROWSER_TICKET_PROTOCOL)
    assert.equal(typeof body.ticket, 'string')
    assert.equal(tickets.consume(body.ticket)?.agentId, 'main')
  })
})

describe('createLiveBrowserBridge', () => {
  it('validates origin + ticket, signs domain-isolated Ed25519 assertion, and relays JSON + binary OCLB frames', async () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'lb-signer-'))
    const signer = AuthoritySigner.loadOrCreate(join(keyDir, 'keys.json'))
    const tickets = new LiveBrowserTicketStore()

    // Mock container WS server
    let receivedAssertion = ''
    let receivedPath = ''
    const containerWss = new WebSocketServer({ noServer: true })
    const containerServer = createServer()
    containerServer.on('upgrade', (req, socket, head) => {
      receivedPath = new URL(req.url ?? '/', 'http://x').pathname
      receivedAssertion = String(req.headers[LIVE_BROWSER_ASSERTION_HEADER] ?? '')
      containerWss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: 'ready', protocolVersion: 1, agentId: 'main', state: { active: true } }))
        ws.send(
          encodeLiveBrowserFrame({
            seq: 1,
            width: 800,
            height: 600,
            format: 'jpeg',
            settled: true,
            payload: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
          }),
          { binary: true },
        )
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', ts: msg.ts, serverTs: 999 }))
          } else if (msg.type === 'handoff_watch') {
            if (msg.resumeWhen === null) {
              ws.send(
                JSON.stringify({
                  type: 'handoff_vetoed',
                  reason: 'visible_otp_or_captcha_input',
                  url: 'https://github.com/sessions/two-factor',
                  detectedAt: 123999,
                }),
              )
            } else {
              ws.send(
                JSON.stringify({
                  type: 'handoff_ready',
                  signal: 'resume_when_matched',
                  url: 'https://github.com/org/repo',
                  title: 'org/repo',
                  detectedAt: 123456,
                }),
              )
            }
          }
        })
      })
    })
    await new Promise<void>((resolve) => containerServer.listen(0, '127.0.0.1', resolve))
    const containerPort = (containerServer.address() as { port: number }).port

    const bridge = createLiveBrowserBridge({
      tickets,
      signer,
      allowedOrigin: 'https://app.example.com',
      resolveContainerEndpoint: async () => ({
        host: '127.0.0.1',
        port: containerPort,
        containerId: 777,
      }),
    })

    const publicServer = createServer()
    publicServer.on('upgrade', (req, socket, head) => {
      if (!bridge.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => publicServer.listen(0, '127.0.0.1', resolve))
    const publicPort = (publicServer.address() as { port: number }).port

    try {
      const issued = tickets.issue(42n, 'main')

      // Wrong origin -> 403
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const bad = new WebSocket(`ws://127.0.0.1:${publicPort}${LIVE_BROWSER_PUBLIC_WS_PATH}`, [
              LIVE_BROWSER_TICKET_PROTOCOL,
              `ticket.${issued.ticket}`,
            ], { origin: 'https://evil.example.com' })
            bad.once('open', () => resolve())
            bad.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
            bad.once('error', reject)
          }),
        /HTTP 403/,
      )

      // Valid origin + subprotocol ticket -> upgrades and relays frames
      const client = new WebSocket(
        `ws://127.0.0.1:${publicPort}${LIVE_BROWSER_PUBLIC_WS_PATH}`,
        [LIVE_BROWSER_TICKET_PROTOCOL, `ticket.${issued.ticket}`],
        { origin: 'https://app.example.com' },
      )
      const texts: any[] = []
      const frames: ReturnType<typeof decodeLiveBrowserFrame>[] = []
      client.on('message', (data, isBinary) => {
        if (isBinary) frames.push(decodeLiveBrowserFrame(Buffer.from(data as any)))
        else texts.push(JSON.parse(data.toString()))
      })
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve())
        client.once('error', reject)
      })
      assert.equal(client.protocol, LIVE_BROWSER_TICKET_PROTOCOL)

      // Wait for relayed ready + binary OCLB frame
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 3_000
        const poll = () => {
          if (texts.some((t) => t.type === 'ready') && frames.length >= 1) return resolve()
          if (Date.now() > deadline) return reject(new Error('timed out waiting for relayed frames'))
          setTimeout(poll, 15)
        }
        poll()
      })

      assert.equal(receivedPath, LIVE_BROWSER_INTERNAL_WS_PATH)
      const verified = verifyLiveBrowserAssertion(receivedAssertion, signer.publicKeyring())
      assert.equal(verified.uid, 42)
      assert.equal(verified.containerId, 777)
      assert.equal(verified.agentId, 'main')
      // Domain isolation: live-browser assertion must fail container-preview verifier
      assert.throws(() => verifyContainerPreviewAssertion(receivedAssertion, signer.publicKeyring()))

      assert.equal(frames[0]!.seq, 1)
      assert.equal(frames[0]!.width, 800)
      assert.equal(frames[0]!.settled, true)

      // Client -> Container -> Client roundtrip (ping + handoff_watch -> handoff_ready & handoff_vetoed)
      client.send(JSON.stringify({ type: 'ping', ts: 555 }))
      client.send(
        JSON.stringify({
          type: 'handoff_watch',
          resumeWhen: { urlLeave: ['/login'], urlMatch: ['github.com/org/repo'] },
        }),
      )
      client.send(JSON.stringify({ type: 'handoff_watch', resumeWhen: null }))
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2_000
        const poll = () => {
          if (
            texts.some((t) => t.type === 'pong' && t.ts === 555) &&
            texts.some(
              (t) =>
                t.type === 'handoff_ready' &&
                t.signal === 'resume_when_matched' &&
                t.url === 'https://github.com/org/repo',
            ) &&
            texts.some(
              (t) =>
                t.type === 'handoff_vetoed' &&
                t.reason === 'visible_otp_or_captcha_input' &&
                t.url === 'https://github.com/sessions/two-factor',
            )
          ) {
            return resolve()
          }
          if (Date.now() > deadline) return reject(new Error('timed out waiting for pong/handoff_ready/handoff_vetoed'))
          setTimeout(poll, 15)
        }
        poll()
      })

      // Unknown client control message type must be rejected by bridge security check
      client.send(JSON.stringify({ type: 'evil_unknown_cmd' }))
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2_000
        const poll = () => {
          if (texts.some((t) => t.type === 'error' && t.code === 'BAD_MESSAGE')) return resolve()
          if (Date.now() > deadline) return reject(new Error('timed out waiting for BAD_MESSAGE'))
          setTimeout(poll, 15)
        }
        poll()
      })

      // Ticket cannot be replayed
      await assert.rejects(
        () =>
          new Promise<void>((resolve, reject) => {
            const replay = new WebSocket(
              `ws://127.0.0.1:${publicPort}${LIVE_BROWSER_PUBLIC_WS_PATH}`,
              [LIVE_BROWSER_TICKET_PROTOCOL, `ticket.${issued.ticket}`],
              { origin: 'https://app.example.com' },
            )
            replay.once('open', () => resolve())
            replay.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
            replay.once('error', reject)
          }),
        /HTTP 401/,
      )

      client.close()
    } finally {
      await bridge.shutdown()
      await new Promise<void>((resolve) => publicServer.close(() => resolve()))
      await new Promise<void>((resolve) => containerWss.close(() => resolve()))
      await new Promise<void>((resolve) => containerServer.close(() => resolve()))
      rmSync(keyDir, { recursive: true, force: true })
    }
  })

  it('P0 #1: handles client closing while resolveContainerEndpoint is pending with zero uncaught errors', async () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'lb-p0-'))
    const signer = AuthoritySigner.loadOrCreate(join(keyDir, 'keys.json'))
    const tickets = new LiveBrowserTicketStore()
    let releaseResolve!: (ep: { host: string; port: number; containerId: number }) => void
    const resolvePromise = new Promise<{ host: string; port: number; containerId: number }>((r) => {
      releaseResolve = r
    })
    let containerSocketCreated = false

    const bridge = createLiveBrowserBridge({
      tickets,
      signer,
      allowedOrigin: 'https://app.example.com',
      resolveContainerEndpoint: () => resolvePromise,
      createContainerSocket: (host, port) => {
        containerSocketCreated = true
        return new WebSocket(`ws://${host}:${port}/ws/live-browser`)
      },
    })

    const publicServer = createServer()
    publicServer.on('upgrade', (req, socket, head) => {
      if (!bridge.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => publicServer.listen(0, '127.0.0.1', resolve))
    const publicPort = (publicServer.address() as { port: number }).port

    const uncaught: Error[] = []
    const onUncaught = (err: Error) => uncaught.push(err)
    process.on('uncaughtException', onUncaught)

    try {
      const issued = tickets.issue(42n, 'main')
      const client = new WebSocket(
        `ws://127.0.0.1:${publicPort}${LIVE_BROWSER_PUBLIC_WS_PATH}`,
        [LIVE_BROWSER_TICKET_PROTOCOL, `ticket.${issued.ticket}`],
        { origin: 'https://app.example.com' },
      )
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve())
        client.once('error', reject)
      })
      // Client disconnects BEFORE resolveContainerEndpoint finishes
      const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))
      client.close()
      await closed
      await new Promise((r) => setTimeout(r, 20))

      // Now resolver resolves to a closed port: bridge MUST NOT construct WS or throw uncaught error
      releaseResolve({ host: '127.0.0.1', port: 1, containerId: 777 })
      await new Promise((r) => setTimeout(r, 60))

      assert.equal(containerSocketCreated, false)
      assert.equal(uncaught.length, 0)
    } finally {
      process.off('uncaughtException', onUncaught)
      await bridge.shutdown()
      await new Promise<void>((resolve) => publicServer.close(() => resolve()))
      rmSync(keyDir, { recursive: true, force: true })
    }
  })

  it('P1 #8 & #9: enforces 1 stream per uid across agents, default global cap 8 (9th -> 503), and never strands pendingUids', async () => {
    const keyDir = mkdtempSync(join(tmpdir(), 'lb-cap-'))
    const signer = AuthoritySigner.loadOrCreate(join(keyDir, 'keys.json'))
    const tickets = new LiveBrowserTicketStore()

    const containerWss = new WebSocketServer({ noServer: true })
    const containerServer = createServer()
    containerServer.on('upgrade', (req, socket, head) => {
      containerWss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: 'ready', protocolVersion: 1, agentId: 'main', state: { active: true } }))
      })
    })
    await new Promise<void>((resolve) => containerServer.listen(0, '127.0.0.1', resolve))
    const containerPort = (containerServer.address() as { port: number }).port

    const bridge = createLiveBrowserBridge({
      tickets,
      signer,
      allowedOrigin: 'https://app.example.com',
      resolveContainerEndpoint: async (uid) => ({
        host: '127.0.0.1',
        port: containerPort,
        containerId: Number(uid) + 100,
      }),
    })

    const publicServer = createServer()
    publicServer.on('upgrade', (req, socket, head) => {
      if (!bridge.handleUpgrade(req, socket, head)) socket.destroy()
    })
    await new Promise<void>((resolve) => publicServer.listen(0, '127.0.0.1', resolve))
    const publicPort = (publicServer.address() as { port: number }).port

    const clients: WebSocket[] = []
    const connectUid = async (uid: bigint, agentId: string): Promise<WebSocket> => {
      const issued = tickets.issue(uid, agentId)
      const ws = new WebSocket(
        `ws://127.0.0.1:${publicPort}${LIVE_BROWSER_PUBLIC_WS_PATH}`,
        [LIVE_BROWSER_TICKET_PROTOCOL, `ticket.${issued.ticket}`],
        { origin: 'https://app.example.com' },
      )
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
        ws.once('error', reject)
      })
      clients.push(ws)
      return ws
    }

    try {
      // Open 1st stream for uid=1 agent=main, then 2nd stream for uid=1 agent=coder -> replaces main!
      const u1Main = await connectUid(1n, 'main')
      const u1MainClosed = new Promise<{ code: number; reason: string }>((resolve) =>
        u1Main.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
      )
      await connectUid(1n, 'coder')
      const closedInfo = await u1MainClosed
      assert.equal(closedInfo.code, 1000)
      assert.match(closedInfo.reason, /replaced/)
      assert.equal(bridge.activeCount(), 1)

      // Fill remaining 7 distinct uids (total = 8, default globalCap)
      for (let u = 2n; u <= 8n; u += 1n) {
        await connectUid(u, 'main')
      }
      assert.equal(bridge.activeCount(), 8)

      // 9th distinct uid must be rejected with 503
      await assert.rejects(() => connectUid(9n, 'main'), /HTTP 503/)

      // Same-uid replacement for uid=1 still succeeds even when global pool is full (8/8)!
      await connectUid(1n, 'researcher')
      assert.equal(bridge.activeCount(), 8)
    } finally {
      for (const c of clients) {
        try { c.close() } catch {}
      }
      await bridge.shutdown()
      await new Promise<void>((resolve) => publicServer.close(() => resolve()))
      await new Promise<void>((resolve) => containerWss.close(() => resolve()))
      await new Promise<void>((resolve) => containerServer.close(() => resolve()))
      rmSync(keyDir, { recursive: true, force: true })
    }
  })
  it('R2 #2: claimUnavailableLiveBrowserUpgrade claims /ws/live-browser with 503 so master never falls back to standalone handler', () => {
    const writes: string[] = []
    let destroyed = false
    const fakeSocket = {
      write(chunk: string) {
        writes.push(chunk)
        return true
      },
      destroy() {
        destroyed = true
      },
    } as any

    // Unrelated WS path is not claimed
    assert.equal(
      claimUnavailableLiveBrowserUpgrade({ url: '/ws/user-chat-bridge' } as IncomingMessage, fakeSocket),
      false,
    )
    assert.equal(writes.length, 0)
    assert.equal(destroyed, false)

    // /ws/live-browser IS claimed with 503 Service Unavailable + socket.destroy()
    assert.equal(
      claimUnavailableLiveBrowserUpgrade(
        { url: `${LIVE_BROWSER_PUBLIC_WS_PATH}?agentId=main` } as IncomingMessage,
        fakeSocket,
      ),
      true,
    )
    assert.match(writes[0] ?? '', /^HTTP\/1\.1 503 Service Unavailable/)
    assert.equal(destroyed, true)
  })
})

describe('pendingDecisionsBootstrap browser_handoff resolve loop', () => {
  it('fires onBrowserHandoffResolved hook on non-replay resolve', async () => {
    const store = new InMemoryBrowserHandoffStore()
    const resolvedEvents: Array<{ decisionId: string; userId: string; status: string }> = []
    const runtime = createCommercialPendingDecisionsRuntime({
      pool: {} as any,
      onControlAdmitted: () => {},
      browserHandoffStore: store,
      onBrowserHandoffResolved: (result, userId) => {
        resolvedEvents.push({ decisionId: result.id, userId, status: result.status })
      },
    })
    try {
      const rec = await store.create({
        id: 'bh-1',
        userId: 'c:42',
        sessionId: 'sess-1',
        title: 'Cloudflare Verify',
        url: 'https://example.com/login',
        reason: 'human verification',
      })
      const items = await runtime.service.list('c:42', { sources: ['browser_handoff'] })
      assert.equal(items.items.length, 1)
      const res = await runtime.service.resolve('c:42', items.items[0]!.id, {
        decision: 'approve',
      })
      assert.equal(res.status, 'approved')
      assert.equal(resolvedEvents.length, 1)
      assert.equal(resolvedEvents[0]!.userId, 'c:42')
      assert.equal(resolvedEvents[0]!.status, 'approved')
      assert.ok(rec.id === 'bh-1')
    } finally {
      runtime.dispose()
    }
  })

  it('extracts and persists optional resume_when while staying 100% backward compatible with legacy cards', async () => {
    const legacyText = [
      '请登录：',
      '```ui',
      JSON.stringify({
        type: 'browser_handoff',
        title: '旧版登录卡',
        url: 'https://github.com/login',
        reason: '需要登录',
      }),
      '```',
    ].join('\n')
    const legacyCards = extractBrowserHandoffCardsFromText(legacyText)
    assert.equal(legacyCards.length, 1)
    assert.equal(legacyCards[0]!.resumeWhen, undefined)

    const modernText = [
      '请完成登录与下载：',
      '```ui',
      JSON.stringify({
        type: 'browser_handoff',
        title: '新版自动继续卡',
        url: 'https://journal.example.org/login',
        reason: '登录后自动继续',
        continue_prompt: '继续解析论文',
        resume_when: {
          url_leave: ['/login', '/sso'],
          url_match: ['/paper/'],
          selector_gone: 'input[type="password"]',
          wait_download: true,
          auto_resume_delay_ms: 3000,
        },
      }),
      '```',
    ].join('\n')
    const modernCards = extractBrowserHandoffCardsFromText(modernText)
    assert.equal(modernCards.length, 1)
    assert.deepEqual(modernCards[0]!.resumeWhen, {
      urlLeave: ['/login', '/sso'],
      urlMatch: ['/paper/'],
      selectorGone: 'input[type="password"]',
      waitDownload: true,
      autoResumeDelayMs: 3000,
    })

    const store = new InMemoryBrowserHandoffStore()
    const runtime = createCommercialPendingDecisionsRuntime({
      pool: {} as any,
      onControlAdmitted: () => {},
      browserHandoffStore: store,
    })
    try {
      emitOutboundBrowserHandoffFrame({
        userId: 'c:42',
        sessionId: 'sess-rw',
        messageId: 'msg-1',
        text: modernText,
      })
      await new Promise((r) => setTimeout(r, 30))
      const listed = await store.listPending('c:42', 10)
      assert.equal(listed.length, 1)
      assert.deepEqual(listed[0]!.metadata?.resumeWhen, modernCards[0]!.resumeWhen)
      assert.equal(listed[0]!.metadata?.continuePrompt, '继续解析论文')

      // B7: pending-decisions source must expose persisted resumeWhen & continuePrompt to frontend inbox
      const pendingList = await runtime.service.list('c:42', { sources: ['browser_handoff'] })
      assert.equal(pendingList.items.length, 1)
      assert.deepEqual(pendingList.items[0]!.metadata.resumeWhen, modernCards[0]!.resumeWhen)
      assert.equal(pendingList.items[0]!.metadata.continuePrompt, '继续解析论文')

      // Legacy persisted handoff without resumeWhen omits it cleanly
      await store.create({
        id: 'bh-legacy',
        userId: 'c:42',
        sessionId: 'sess-legacy',
        title: '旧版卡片',
        url: 'https://github.com/login',
        reason: '登录',
      })
      const pendingWithLegacy = await runtime.service.list('c:42', { sources: ['browser_handoff'] })
      const legacyItem = pendingWithLegacy.items.find((i) => i.sourceId === 'bh-legacy')
      assert.ok(legacyItem)
      assert.equal(legacyItem.metadata.resumeWhen, undefined)
    } finally {
      runtime.dispose()
    }
  })
})
