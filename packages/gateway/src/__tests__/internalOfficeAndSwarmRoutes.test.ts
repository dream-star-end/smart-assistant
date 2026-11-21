/**
 * Container-gateway internal route tests for Wave 4A (OCV5-832):
 *   - `/internal/office-preview` & `/internal/office-preview/page` (incl. B7 anti-replay & N2 error sanitization)
 *   - `/internal/swarm/command` (incl. B6 no historical-board fallback & B7 anti-replay)
 *
 * Run: tsx --test packages/gateway/src/__tests__/internalOfficeAndSwarmRoutes.test.ts
 */

import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { antigravitySessionBrainDir } from '../engine/antigravityPlatform.js'
import { OfficePreviewError } from '../officePreview.js'
import {
  InternalBridgeReplayCache,
  buildSignedInternalBridgeHeaders,
  verifyInternalBridgeAuth,
  verifyInternalBridgeAuthDetailed,
} from '../routes/internalBridgeAuth.js'
import {
  CONTAINER_PAGE_TOKEN_PREFIX,
  ContainerOfficePreviewRegistry,
  handleInternalOfficePreview,
  handleInternalOfficePreviewPage,
} from '../routes/officePreviewRoute.js'
import {
  INTERNAL_SWARM_USER_ID_HEADER,
  handleInternalSwarmCommand,
  resolveAuthoritativeSessionSwarm,
} from '../routes/swarmCommandRoute.js'
import { SessionManager } from '../sessionManager.js'

const BRIDGE_SECRET = 'wave4-test-bridge-secret-32bytes!'
const CONTAINER_ID = '42'
const TRUST_IP = '172.31.0.1'
const VALID_NONCE = createHmac('sha256', BRIDGE_SECRET).update(CONTAINER_ID).digest('hex')
const COORD_CONV = '11111111-2222-3333-4444-555555555555'
const OLD_CONV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const NEW_CONV = '99999999-8888-7777-6666-555555555555'

const AUTH_ENV: NodeJS.ProcessEnv = {
  OPENCLAUDE_TRUST_BRIDGE_IP: TRUST_IP,
  OC_CONTAINER_ID: CONTAINER_ID,
  OC_BRIDGE_NONCE: VALID_NONCE,
}

function makeReq(opts: {
  method: string
  url: string
  remoteAddress?: string
  headers?: Record<string, string>
  body?: unknown
}): IncomingMessage {
  const payload =
    opts.body === undefined
      ? ''
      : typeof opts.body === 'string'
        ? opts.body
        : JSON.stringify(opts.body)
  const req = Readable.from(payload ? [Buffer.from(payload)] : []) as unknown as IncomingMessage
  req.method = opts.method
  req.url = opts.url
  const lowerHeaders: Record<string, string> = {}
  if (payload) lowerHeaders['content-type'] = 'application/json'
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    lowerHeaders[k.toLowerCase()] = v
  }
  req.headers = lowerHeaders
  Object.defineProperty(req, 'socket', {
    value: { remoteAddress: opts.remoteAddress ?? TRUST_IP },
    configurable: true,
  })
  return req
}

function signedAuthHeaders(opts: {
  method: string
  url: string
  body?: unknown
  nowMs?: number
  reqNonce?: string
  extra?: Record<string, string>
}): Record<string, string> {
  const payload =
    opts.body === undefined
      ? ''
      : typeof opts.body === 'string'
        ? opts.body
        : JSON.stringify(opts.body)
  const signed = buildSignedInternalBridgeHeaders({
    containerId: CONTAINER_ID,
    bridgeNonce: VALID_NONCE,
    method: opts.method,
    pathAndQuery: opts.url,
    body: payload,
    nowMs: opts.nowMs,
    reqNonce: opts.reqNonce,
  })
  return {
    ...signed,
    ...(opts.extra ?? {}),
  }
}

function makeRes() {
  let code = 200
  const headers: Record<string, string> = {}
  const chunks: Buffer[] = []
  const res = {
    get statusCode() {
      return code
    },
    set statusCode(v: number) {
      code = v
    },
    get headersSent() {
      return false
    },
    setHeader(k: string, v: string | number) {
      headers[k.toLowerCase()] = String(v)
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
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

describe('verifyInternalBridgeAuth (B7 per-request anti-replay signing)', () => {
  it('accepts valid IPv4 & IPv4-mapped IPv6 signed requests and rejects replay, tampering, skew, and missing env', () => {
    const cache = new InternalBridgeReplayCache()
    const nowMs = 1_700_000_000_000
    const url = '/internal/office-preview?b=2&a=1'

    const hdrs1 = signedAuthHeaders({ method: 'GET', url, nowMs, reqNonce: 'nonce-unique-00000001' })
    // B7 R2: wire headers MUST NEVER carry the shared per-container secret key material
    const lowerKeys1 = Object.keys(hdrs1).map((k) => k.toLowerCase()).sort()
    assert.deepEqual(
      lowerKeys1,
      ['x-oc-bridge-nonce', 'x-oc-bridge-sig', 'x-oc-bridge-ts', 'x-oc-container-id'],
    )
    assert.equal(lowerKeys1.includes('x-openclaude-bridge-nonce'), false)
    assert.equal(lowerKeys1.includes('x-oc-bridge-token'), false)
    assert.ok(
      !Object.values(hdrs1).some((v) => v.toLowerCase().includes(VALID_NONCE.toLowerCase())),
      'shared bridge signing key must never appear in request header values',
    )

    const okReq = makeReq({ method: 'GET', url, headers: hdrs1 })
    assert.deepEqual(
      verifyInternalBridgeAuthDetailed(okReq, { env: AUTH_ENV, now: () => nowMs, replayCache: cache }),
      { ok: true },
    )

    // Exact replay with same reqNonce -> 409 REPLAY_REJECTED
    const replayRes = verifyInternalBridgeAuthDetailed(
      makeReq({ method: 'GET', url, headers: hdrs1 }),
      { env: AUTH_ENV, now: () => nowMs + 100, replayCache: cache },
    )
    assert.equal(replayRes.ok, false)
    if (!replayRes.ok) {
      assert.equal(replayRes.status, 409)
      assert.equal(replayRes.code, 'REPLAY_REJECTED')
    }

    // Reordered query params (simulating Go tunnel url.Values.Encode) + IPv4-mapped IPv6 -> still valid!
    const hdrs2 = signedAuthHeaders({ method: 'GET', url: '/internal/office-preview?b=2&a=1', nowMs })
    const mappedReq = makeReq({
      method: 'GET',
      url: '/internal/office-preview?a=1&b=2',
      remoteAddress: `::ffff:${TRUST_IP}`,
      headers: hdrs2,
    })
    assert.equal(
      verifyInternalBridgeAuth(mappedReq, AUTH_ENV, { now: () => nowMs, replayCache: cache }),
      true,
    )

    // Tampered query/path -> 401
    const hdrs3 = signedAuthHeaders({ method: 'GET', url: '/internal/office-preview?path=/a.pptx', nowMs })
    assert.equal(
      verifyInternalBridgeAuth(
        makeReq({ method: 'GET', url: '/internal/office-preview?path=/b.pptx', headers: hdrs3 }),
        AUTH_ENV,
        { now: () => nowMs, replayCache: cache },
      ),
      false,
    )

    // Tampered POST body -> 401
    const hdrs4 = signedAuthHeaders({
      method: 'POST',
      url: '/internal/swarm/command?sessionId=s1',
      body: { action: 'steer', target: 'w1', message: 'a' },
      nowMs,
    })
    assert.equal(
      verifyInternalBridgeAuth(
        makeReq({
          method: 'POST',
          url: '/internal/swarm/command?sessionId=s1',
          headers: hdrs4,
          body: { action: 'steer', target: 'w1', message: 'tampered' },
        }),
        AUTH_ENV,
        {
          body: JSON.stringify({ action: 'steer', target: 'w1', message: 'tampered' }),
          now: () => nowMs,
          replayCache: cache,
        },
      ),
      false,
    )

    // Expired timestamp (>60s skew) -> 401
    const hdrsOld = signedAuthHeaders({ method: 'GET', url, nowMs: nowMs - 120_000 })
    assert.equal(
      verifyInternalBridgeAuth(makeReq({ method: 'GET', url, headers: hdrsOld }), AUTH_ENV, {
        now: () => nowMs,
        replayCache: cache,
      }),
      false,
    )

    // Legacy unsigned bridge headers (no X-Oc-Bridge-Sig) -> 401
    assert.equal(
      verifyInternalBridgeAuth(
        makeReq({
          method: 'GET',
          url,
          headers: { 'x-openclaude-container-id': CONTAINER_ID, 'x-openclaude-bridge-nonce': VALID_NONCE },
        }),
        AUTH_ENV,
        { now: () => nowMs, replayCache: cache },
      ),
      false,
    )

    // Wrong IP / wrong nonce / missing env -> false
    const hdrs5 = signedAuthHeaders({ method: 'GET', url, nowMs })
    assert.equal(
      verifyInternalBridgeAuth(
        makeReq({ method: 'GET', url, remoteAddress: '10.0.0.5', headers: hdrs5 }),
        AUTH_ENV,
        { now: () => nowMs, replayCache: cache },
      ),
      false,
    )
    assert.equal(verifyInternalBridgeAuth(makeReq({ method: 'GET', url, headers: hdrs5 }), {}), false)
  })

  it('B7 R2: replay cache rejects overload (503) instead of evicting unexpired nonces before TTL', () => {
    const tinyCache = new InternalBridgeReplayCache({ maxEntries: 2 })
    let nowMs = 1_700_000_000_000
    const url = '/internal/office-preview?a=1'

    const h1 = signedAuthHeaders({ method: 'GET', url, nowMs, reqNonce: 'nonce-cap-0000000001' })
    const h2 = signedAuthHeaders({ method: 'GET', url, nowMs, reqNonce: 'nonce-cap-0000000002' })
    const h3 = signedAuthHeaders({ method: 'GET', url, nowMs, reqNonce: 'nonce-cap-0000000003' })

    assert.deepEqual(
      verifyInternalBridgeAuthDetailed(makeReq({ method: 'GET', url, headers: h1 }), {
        env: AUTH_ENV,
        now: () => nowMs,
        replayCache: tinyCache,
      }),
      { ok: true },
    )
    assert.deepEqual(
      verifyInternalBridgeAuthDetailed(makeReq({ method: 'GET', url, headers: h2 }), {
        env: AUTH_ENV,
        now: () => nowMs,
        replayCache: tinyCache,
      }),
      { ok: true },
    )

    // Cache is full of unexpired nonces -> 3rd distinct nonce MUST be rejected with 503 REPLAY_CACHE_FULL
    const fullRes = verifyInternalBridgeAuthDetailed(makeReq({ method: 'GET', url, headers: h3 }), {
      env: AUTH_ENV,
      now: () => nowMs,
      replayCache: tinyCache,
    })
    assert.equal(fullRes.ok, false)
    if (!fullRes.ok) {
      assert.equal(fullRes.status, 503)
      assert.equal(fullRes.code, 'REPLAY_CACHE_FULL')
    }

    // Crucially, h1 was NOT evicted -> replaying h1 STILL returns 409 REPLAY_REJECTED!
    const replayH1 = verifyInternalBridgeAuthDetailed(makeReq({ method: 'GET', url, headers: h1 }), {
      env: AUTH_ENV,
      now: () => nowMs + 10_000,
      replayCache: tinyCache,
    })
    assert.equal(replayH1.ok, false)
    if (!replayH1.ok) {
      assert.equal(replayH1.status, 409)
      assert.equal(replayH1.code, 'REPLAY_REJECTED')
    }

    // After the 2*maxSkewMs TTL expires, expired entries are pruned and fresh requests succeed again
    nowMs += 125_000
    const h4 = signedAuthHeaders({ method: 'GET', url, nowMs, reqNonce: 'nonce-cap-0000000004' })
    assert.deepEqual(
      verifyInternalBridgeAuthDetailed(makeReq({ method: 'GET', url, headers: h4 }), {
        env: AUTH_ENV,
        now: () => nowMs,
        replayCache: tinyCache,
      }),
      { ok: true },
    )
  })
})

describe('internal office-preview routes', () => {
  it('enforces signed anti-replay auth, serves opaque handle + PNG bytes, and sanitizes RENDER_FAILED errors (N2)', async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'oc-int-office-'))
    const cacheDir = path.join(workDir, 'cache')
    const docsDir = path.join(workDir, 'docs')
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    mkdirSync(docsDir, { recursive: true })
    const deckPath = path.join(docsDir, 'demo.pptx')
    writeFileSync(deckPath, Buffer.from('PK\x03\x04fake-pptx-bytes'))
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])
    const registry = new ContainerOfficePreviewRegistry()
    const replayCache = new InternalBridgeReplayCache()

    try {
      // 1) Unauthenticated -> 401
      const unauthUrl = `/internal/office-preview?path=${encodeURIComponent(deckPath)}`
      const unauthRes = makeRes()
      await handleInternalOfficePreview(
        makeReq({ method: 'GET', url: unauthUrl }),
        unauthRes.res,
        new URL(unauthUrl, 'http://x'),
        { env: AUTH_ENV, replayCache, allowedRoots: [docsDir], cacheDir, registry },
      )
      assert.equal(unauthRes.status(), 401)

      // 2) Signed preview -> 200 with opaque cph: token (never raw cache path)
      const prevUrl = `/internal/office-preview?path=${encodeURIComponent(deckPath)}`
      const prevHeaders = signedAuthHeaders({ method: 'GET', url: prevUrl })
      const prevRes = makeRes()
      await handleInternalOfficePreview(
        makeReq({ method: 'GET', url: prevUrl, headers: prevHeaders }),
        prevRes.res,
        new URL(prevUrl, 'http://x'),
        {
          env: AUTH_ENV,
          replayCache,
          allowedRoots: [docsDir],
          cacheDir,
          registry,
          previewFn: async (fp) => {
            const pageFile = path.join(cacheDir, 'slide-1.png')
            writeFileSync(pageFile, pngBytes)
            return {
              kind: 'pptx',
              filePath: fp,
              sha256: 'a'.repeat(64),
              mtimeMs: 123456,
              cacheKey: 'pptx_demo_1',
              cached: false,
              pages: [{ index: 1, imgPath: pageFile, notes: 'Speaker note' }],
              qaIssues: [],
            }
          },
        },
      )
      assert.equal(prevRes.status(), 200)
      const body = prevRes.json() as { preview: { pages: Array<{ index: number; imgPath: string; notes?: string }> } }
      const token = body.preview.pages[0]!.imgPath
      assert.ok(token.startsWith(CONTAINER_PAGE_TOKEN_PREFIX))
      assert.ok(!token.includes(cacheDir))

      // 2b) Replaying the exact same signed preview request -> 409 REPLAY_REJECTED
      const replayRes = makeRes()
      await handleInternalOfficePreview(
        makeReq({ method: 'GET', url: prevUrl, headers: prevHeaders }),
        replayRes.res,
        new URL(prevUrl, 'http://x'),
        { env: AUTH_ENV, replayCache, allowedRoots: [docsDir], cacheDir, registry },
      )
      assert.equal(replayRes.status(), 409)
      assert.equal((replayRes.json() as { error: { code: string } }).error.code, 'REPLAY_REJECTED')

      // 3) Fetch rendered page image via opaque handle -> 200 PNG
      const [, handle, pageStr] = token.split(':')
      const pageUrl = `/internal/office-preview/page?handle=${encodeURIComponent(handle!)}&page=${pageStr}`
      const pageRes = makeRes()
      await handleInternalOfficePreviewPage(
        makeReq({ method: 'GET', url: pageUrl, headers: signedAuthHeaders({ method: 'GET', url: pageUrl }) }),
        pageRes.res,
        new URL(pageUrl, 'http://x'),
        { env: AUTH_ENV, replayCache, registry },
      )
      assert.equal(pageRes.status(), 200)
      assert.equal(pageRes.headers['content-type'], 'image/png')
      assert.deepEqual(pageRes.buf(), pngBytes)

      // 4) Raw ?path= rejected on /internal/office-preview/page -> 400
      const rawPathUrl = `/internal/office-preview/page?path=${encodeURIComponent(deckPath)}`
      const rawRes = makeRes()
      await handleInternalOfficePreviewPage(
        makeReq({ method: 'GET', url: rawPathUrl, headers: signedAuthHeaders({ method: 'GET', url: rawPathUrl }) }),
        rawRes.res,
        new URL(rawPathUrl, 'http://x'),
        { env: AUTH_ENV, replayCache, registry },
      )
      assert.equal(rawRes.status(), 400)
      assert.equal((rawRes.json() as { error: { code: string } }).error.code, 'RAW_PATH_FORBIDDEN')

      // 5) N2: RENDER_FAILED hides container path/stderr externally while logging internally
      const loggedErrors: Array<{ code: string; detail: string }> = []
      const failRes = makeRes()
      await handleInternalOfficePreview(
        makeReq({ method: 'GET', url: prevUrl, headers: signedAuthHeaders({ method: 'GET', url: prevUrl }) }),
        failRes.res,
        new URL(prevUrl, 'http://x'),
        {
          env: AUTH_ENV,
          replayCache,
          allowedRoots: [docsDir],
          cacheDir,
          registry,
          onErrorLog: (code, detail) => loggedErrors.push({ code, detail }),
          previewFn: async () => {
            throw new OfficePreviewError(
              'RENDER_FAILED',
              500,
              `soffice failed on ${deckPath}: Traceback /usr/bin/pdftoppm exited 1`,
            )
          },
        },
      )
      assert.equal(failRes.status(), 500)
      const failJson = failRes.json() as { error: { code: string; message: string } }
      assert.equal(failJson.error.code, 'RENDER_FAILED')
      assert.equal(failJson.error.message, 'office preview rendering failed')
      assert.ok(!failJson.error.message.includes(deckPath))
      assert.ok(!failJson.error.message.includes('Traceback'))
      assert.equal(loggedErrors.length, 1)
      assert.ok(loggedErrors[0]!.detail.includes('Traceback'))

      // 6) Symlink escape rejected -> 403
      const symLink = path.join(docsDir, 'escape.pptx')
      symlinkSync('/etc/hosts', symLink)
      const symUrl = `/internal/office-preview?path=${encodeURIComponent(symLink)}`
      const symRes = makeRes()
      await handleInternalOfficePreview(
        makeReq({ method: 'GET', url: symUrl, headers: signedAuthHeaders({ method: 'GET', url: symUrl }) }),
        symRes.res,
        new URL(symUrl, 'http://x'),
        { env: AUTH_ENV, replayCache, allowedRoots: [docsDir], cacheDir, registry },
      )
      assert.equal(symRes.status(), 403)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})

describe('internal swarm command route (B6 + B7)', () => {
  it('enforces signed anti-replay auth, resolves authoritative conversation, rejects client brainDir, and executes steer/terminate', async () => {
    const agyRoot = mkdtempSync(path.join(tmpdir(), 'oc-int-swarm-'))
    const sessionId = 'sess-w4-1'
    const sessionKey = `agent:main:webchat:dm:${sessionId}`
    const brainDir = antigravitySessionBrainDir(agyRoot, sessionKey)
    const swarmDir = path.join(brainDir, COORD_CONV, '.system_generated', 'swarm')
    mkdirSync(swarmDir, { recursive: true })
    writeFileSync(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Wave 4 Swarm',
        members: {
          coordinator: { role: 'coordinator', killed: false },
          'worker-1': { role: 'worker', killed: false },
        },
      }),
    )
    writeFileSync(
      path.join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: 'kickoff', time: '2026-11-21T00:00:00Z' })}\n`,
    )
    const replayCache = new InternalBridgeReplayCache()
    const lookupSessionTarget = (sid: string) =>
      sid === sessionId ? { sessionKey, conversationId: COORD_CONV } : null

    try {
      const resolved = resolveAuthoritativeSessionSwarm(sessionId, {
        antigravityRootDir: () => agyRoot,
        lookupSessionTarget,
      })
      assert.ok(resolved)
      assert.equal(resolved.brainDir, brainDir)
      assert.equal(resolved.conversationId, COORD_CONV)

      // 1) Unauthenticated -> 401
      const r401 = makeRes()
      await handleInternalSwarmCommand(
        makeReq({ method: 'POST', url: `/internal/swarm/command?sessionId=${sessionId}`, body: { action: 'steer', target: 'worker-1', message: 'hi' } }),
        r401.res,
        new URL(`/internal/swarm/command?sessionId=${sessionId}`, 'http://x'),
        { env: AUTH_ENV, replayCache, antigravityRootDir: () => agyRoot, lookupSessionTarget },
      )
      assert.equal(r401.status(), 401)

      // 2) Client-supplied brainDir rejected -> 400 FORBIDDEN_FIELD
      const brainBody = { action: 'steer', target: 'worker-1', message: 'hi', brainDir: '/etc' }
      const brainUrl = `/internal/swarm/command?sessionId=${sessionId}`
      const rBrain = makeRes()
      await handleInternalSwarmCommand(
        makeReq({
          method: 'POST',
          url: brainUrl,
          headers: signedAuthHeaders({
            method: 'POST',
            url: brainUrl,
            body: brainBody,
            extra: { [INTERNAL_SWARM_USER_ID_HEADER]: '42' },
          }),
          body: brainBody,
        }),
        rBrain.res,
        new URL(brainUrl, 'http://x'),
        { env: AUTH_ENV, replayCache, antigravityRootDir: () => agyRoot, lookupSessionTarget },
      )
      assert.equal(rBrain.status(), 400)
      assert.equal((rBrain.json() as { code: string }).code, 'FORBIDDEN_FIELD')

      // 3) Steer directive -> 200 & appended to board.jsonl
      const steerBody = { action: 'steer', target: 'worker-1', message: 'run unit tests first' }
      const steerHeaders = signedAuthHeaders({
        method: 'POST',
        url: brainUrl,
        body: steerBody,
        extra: { [INTERNAL_SWARM_USER_ID_HEADER]: '42' },
      })
      const rSteer = makeRes()
      await handleInternalSwarmCommand(
        makeReq({ method: 'POST', url: brainUrl, headers: steerHeaders, body: steerBody }),
        rSteer.res,
        new URL(brainUrl, 'http://x'),
        { env: AUTH_ENV, replayCache, antigravityRootDir: () => agyRoot, lookupSessionTarget },
      )
      assert.equal(rSteer.status(), 200)
      const steerJson = rSteer.json() as { ok: boolean; seq: number; agent: string; text: string }
      assert.equal(steerJson.ok, true)
      assert.equal(steerJson.seq, 2)
      assert.equal(steerJson.agent, 'user:42')

      // 3b) Replaying the exact same steer POST request -> 409 REPLAY_REJECTED (board untouched)
      const rReplay = makeRes()
      await handleInternalSwarmCommand(
        makeReq({ method: 'POST', url: brainUrl, headers: steerHeaders, body: steerBody }),
        rReplay.res,
        new URL(brainUrl, 'http://x'),
        { env: AUTH_ENV, replayCache, antigravityRootDir: () => agyRoot, lookupSessionTarget },
      )
      assert.equal(rReplay.status(), 409)
      assert.equal((rReplay.json() as { code: string }).code, 'REPLAY_REJECTED')

      // 4) Terminate non-coordinator member -> 200 status='requested'
      const termUrl = `/internal/swarm/command/${sessionId}`
      const termBody = { action: 'terminate', memberName: 'worker-1', reason: 'looping' }
      const rTerm = makeRes()
      await handleInternalSwarmCommand(
        makeReq({
          method: 'POST',
          url: termUrl,
          headers: signedAuthHeaders({
            method: 'POST',
            url: termUrl,
            body: termBody,
            extra: { [INTERNAL_SWARM_USER_ID_HEADER]: '42' },
          }),
          body: termBody,
        }),
        rTerm.res,
        new URL(termUrl, 'http://x'),
        { env: AUTH_ENV, replayCache, antigravityRootDir: () => agyRoot, lookupSessionTarget },
      )
      assert.equal(rTerm.status(), 200)
      const termJson = rTerm.json() as { ok: boolean; status: string; noticeSeq: number }
      assert.equal(termJson.ok, true)
      assert.equal(termJson.status, 'requested')
      assert.equal(termJson.noticeSeq, 3)

      const lines = readFileSync(path.join(swarmDir, 'board.jsonl'), 'utf8').trim().split('\n')
      assert.equal(lines.length, 3)
    } finally {
      rmSync(agyRoot, { recursive: true, force: true })
    }
  })

  it('B6: NEVER falls back to historical swarm board when authoritative current conversation has no swarm', async () => {
    const agyRoot = mkdtempSync(path.join(tmpdir(), 'oc-int-swarm-b6-'))
    const sessionId = 'sess-b6-1'
    const sessionKey = `agent:main:webchat:dm:${sessionId}`
    const brainDir = antigravitySessionBrainDir(agyRoot, sessionKey)

    // Historical conversation HAS an old swarm board + members.json
    const oldSwarmDir = path.join(brainDir, OLD_CONV, '.system_generated', 'swarm')
    mkdirSync(oldSwarmDir, { recursive: true })
    writeFileSync(
      path.join(oldSwarmDir, 'members.json'),
      JSON.stringify({
        title: 'Old Swarm',
        members: { coordinator: { role: 'coordinator', killed: false }, 'old-worker': { role: 'worker', killed: false } },
      }),
    )
    const oldBoardPath = path.join(oldSwarmDir, 'board.jsonl')
    const initialOldBoard = `${JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: 'old', time: '2026-11-20T00:00:00Z' })}\n`
    writeFileSync(oldBoardPath, initialOldBoard)

    // Current authoritative conversation NEW_CONV exists WITHOUT members.json
    mkdirSync(path.join(brainDir, NEW_CONV), { recursive: true })

    const replayCache = new InternalBridgeReplayCache()
    try {
      // Resolver MUST return null (never fall back to OLD_CONV)
      const resolved = resolveAuthoritativeSessionSwarm(sessionId, {
        antigravityRootDir: () => agyRoot,
        lookupSessionTarget: () => ({ sessionKey, brainDir, conversationId: NEW_CONV }),
      })
      assert.equal(resolved, null)

      // Also returns null when lookupSessionTarget returns null (no unbound directory scan)
      const resolvedUnbound = resolveAuthoritativeSessionSwarm(sessionId, {
        antigravityRootDir: () => agyRoot,
        lookupSessionTarget: () => null,
      })
      assert.equal(resolvedUnbound, null)

      // HTTP command against NEW_CONV returns 404 SWARM_NOT_FOUND & leaves OLD_CONV board byte-identical
      const url = `/internal/swarm/command?sessionId=${sessionId}`
      const body = { action: 'steer', target: 'old-worker', message: 'should never land on old board' }
      const res = makeRes()
      await handleInternalSwarmCommand(
        makeReq({
          method: 'POST',
          url,
          headers: signedAuthHeaders({
            method: 'POST',
            url,
            body,
            extra: { [INTERNAL_SWARM_USER_ID_HEADER]: '42' },
          }),
          body,
        }),
        res.res,
        new URL(url, 'http://x'),
        {
          env: AUTH_ENV,
          replayCache,
          antigravityRootDir: () => agyRoot,
          lookupSessionTarget: () => ({ sessionKey, brainDir, conversationId: NEW_CONV }),
        },
      )
      assert.equal(res.status(), 404)
      assert.equal((res.json() as { code: string }).code, 'SWARM_NOT_FOUND')
      assert.equal(readFileSync(oldBoardPath, 'utf8'), initialOldBoard, 'historical board.jsonl must remain byte-identical')

      // Once NEW_CONV has its own swarm, steer targets NEW_CONV while OLD_CONV remains byte-identical
      const newSwarmDir = path.join(brainDir, NEW_CONV, '.system_generated', 'swarm')
      mkdirSync(newSwarmDir, { recursive: true })
      writeFileSync(
        path.join(newSwarmDir, 'members.json'),
        JSON.stringify({
          title: 'Current Swarm',
          members: { coordinator: { role: 'coordinator', killed: false }, 'cur-worker': { role: 'worker', killed: false } },
        }),
      )
      const newBoardPath = path.join(newSwarmDir, 'board.jsonl')
      writeFileSync(newBoardPath, '')

      const curBody = { action: 'steer', target: 'cur-worker', message: 'hello current' }
      const curRes = makeRes()
      await handleInternalSwarmCommand(
        makeReq({
          method: 'POST',
          url,
          headers: signedAuthHeaders({
            method: 'POST',
            url,
            body: curBody,
            extra: { [INTERNAL_SWARM_USER_ID_HEADER]: '42' },
          }),
          body: curBody,
        }),
        curRes.res,
        new URL(url, 'http://x'),
        {
          env: AUTH_ENV,
          replayCache,
          antigravityRootDir: () => agyRoot,
          lookupSessionTarget: () => ({ sessionKey, brainDir, conversationId: NEW_CONV }),
        },
      )
      assert.equal(curRes.status(), 200)
      assert.equal(readFileSync(oldBoardPath, 'utf8'), initialOldBoard, 'historical board.jsonl must still be untouched')
      assert.ok(readFileSync(newBoardPath, 'utf8').includes('hello current'))
    } finally {
      rmSync(agyRoot, { recursive: true, force: true })
    }
  })

  it('B6 R2: cold recovery with multiple historical agent keys for same peer fails closed with 404 SWARM_NOT_FOUND', async () => {
    const agyRoot = mkdtempSync(path.join(tmpdir(), 'oc-int-swarm-cold-'))
    const peerId = 'sess-cold-ambig'
    const oldKey = `agent:main:webchat:dm:${peerId}`
    const newKey = `agent:researcher:webchat:dm:${peerId}`

    const oldBrainDir = antigravitySessionBrainDir(agyRoot, oldKey)
    const oldSwarmDir = path.join(oldBrainDir, OLD_CONV, '.system_generated', 'swarm')
    mkdirSync(oldSwarmDir, { recursive: true })
    writeFileSync(
      path.join(oldSwarmDir, 'members.json'),
      JSON.stringify({
        title: 'Historical Cold Swarm',
        members: {
          coordinator: { role: 'coordinator', killed: false },
          'old-worker': { role: 'worker', killed: false },
        },
      }),
    )
    const oldBoardPath = path.join(oldSwarmDir, 'board.jsonl')
    const initialOldBoard = `${JSON.stringify({ seq: 1, agent: 'coordinator', channel: 'main', text: 'old-cold', time: '2026-11-20T00:00:00Z' })}\n`
    writeFileSync(oldBoardPath, initialOldBoard)

    // Cold SessionManager state: live sessions & _sessionIdToKey are empty, _resumeMap has
    // TWO historical agent keys ending with `:${peerId}` (only oldKey has a swarm roster).
    const coldSessionMgr = {
      sessions: new Map(),
      _sessionIdToKey: new Map(),
      _resumeMap: new Map([
        [oldKey, OLD_CONV],
        [newKey, NEW_CONV],
      ]),
    } as unknown as SessionManager

    const lookupSessionTarget = (sid: string) =>
      SessionManager.prototype.resolveAntigravitySwarmTarget.call(coldSessionMgr, sid)

    try {
      assert.equal(
        lookupSessionTarget(peerId),
        null,
        'ambiguous multi-agent cold resumeMap must return null instead of picking first key',
      )
      assert.equal(
        resolveAuthoritativeSessionSwarm(peerId, {
          antigravityRootDir: () => agyRoot,
          lookupSessionTarget,
        }),
        null,
      )

      const url = `/internal/swarm/command?sessionId=${peerId}`
      const body = { action: 'steer', target: 'old-worker', message: 'must not land' }
      const res = makeRes()
      await handleInternalSwarmCommand(
        makeReq({
          method: 'POST',
          url,
          headers: signedAuthHeaders({
            method: 'POST',
            url,
            body,
            extra: { [INTERNAL_SWARM_USER_ID_HEADER]: '42' },
          }),
          body,
        }),
        res.res,
        new URL(url, 'http://x'),
        {
          env: AUTH_ENV,
          replayCache: new InternalBridgeReplayCache(),
          antigravityRootDir: () => agyRoot,
          lookupSessionTarget,
        },
      )
      assert.equal(res.status(), 404)
      assert.equal((res.json() as { code: string }).code, 'SWARM_NOT_FOUND')
      assert.equal(readFileSync(oldBoardPath, 'utf8'), initialOldBoard, 'historical board.jsonl must remain untouched')
    } finally {
      rmSync(agyRoot, { recursive: true, force: true })
    }
  })
})
