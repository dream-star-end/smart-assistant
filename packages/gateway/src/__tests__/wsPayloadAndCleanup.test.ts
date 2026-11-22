import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, utimes, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import {
  DEFAULT_LEGACY_BASE64_MAX_BYTES,
  DEFAULT_WS_MAX_PAYLOAD_BYTES,
  MAX_WS_MAX_PAYLOAD_BYTES,
  formatLegacyBase64OversizeError,
  resolveLegacyBase64MaxBytes,
  resolveWsMaxPayloadBytes,
} from '../wsPayloadPolicy.js'
import { runStartupUploadTmpCleanup } from '../uploadTmpCleanup.js'
import { handleWsConnection, type WsConnectionHost } from '../wsConnection.js'

describe('wsPayloadPolicy (OCV5-825)', () => {
  it('defaults WS maxPayload to 16 MiB and supports env override with safe bounds', () => {
    assert.equal(resolveWsMaxPayloadBytes({}), DEFAULT_WS_MAX_PAYLOAD_BYTES)
    assert.equal(DEFAULT_WS_MAX_PAYLOAD_BYTES, 16 * 1024 * 1024)
    assert.equal(resolveWsMaxPayloadBytes({ OC_WS_MAX_PAYLOAD_BYTES: '33554432' }), 33554432)
    // Invalid / too small falls back to default
    assert.equal(resolveWsMaxPayloadBytes({ OC_WS_MAX_PAYLOAD_BYTES: 'abc' }), DEFAULT_WS_MAX_PAYLOAD_BYTES)
    assert.equal(resolveWsMaxPayloadBytes({ OC_WS_MAX_PAYLOAD_BYTES: '1024' }), DEFAULT_WS_MAX_PAYLOAD_BYTES)
    // Above ceiling clamps to 448 MiB
    assert.equal(
      resolveWsMaxPayloadBytes({ OC_WS_MAX_PAYLOAD_BYTES: String(999 * 1024 * 1024) }),
      MAX_WS_MAX_PAYLOAD_BYTES,
    )
  })

  it('caps legacy inline base64 attachments and formats actionable HTTP upload error', () => {
    assert.equal(resolveLegacyBase64MaxBytes({}), DEFAULT_LEGACY_BASE64_MAX_BYTES)
    assert.equal(resolveLegacyBase64MaxBytes({ OC_WS_LEGACY_BASE64_MAX_BYTES: '0' }), 0)
    const msg = formatLegacyBase64OversizeError(12 * 1024 * 1024, 8 * 1024 * 1024)
    assert.match(msg, /8MB/)
    assert.match(msg, /\/api\/uploads/)
    const disabledMsg = formatLegacyBase64OversizeError(2 * 1024 * 1024, 0)
    assert.match(disabledMsg, /已停用/)
    assert.match(disabledMsg, /\/api\/uploads/)
  })

  it('B1: oversized WS frame closes only the offending connection without uncaughtException, while other connections continue serving', async () => {
    const warnings: Array<{ msg: string; ctx?: Record<string, unknown> }> = []
    const wsClients = new Set<WebSocket>()
    const host = {
      _shuttingDown: false,
      _bridgeConnections: new WeakSet<WebSocket>(),
      _pendingRepoBinds: new Map(),
      _recentHelloPeers: new WeakMap(),
      wsClients,
      checkHttpAuth: () => true,
      getUserId: () => 'u-test',
      log: {
        info: () => {},
        debug: () => {},
        warn: (msg: string, ctx?: Record<string, unknown>) => warnings.push({ msg, ctx }),
        error: () => {},
      },
    } as unknown as WsConnectionHost

    const server = createServer()
    const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 })
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleWsConnection.call(host, ws, req)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }
    const url = `ws://127.0.0.1:${addr.port}/ws`

    let uncaught: unknown = null
    const onUncaught = (err: unknown) => {
      uncaught = err
    }
    process.on('uncaughtException', onUncaught)

    const clientA = new WebSocket(url)
    const clientB = new WebSocket(url)
    try {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          clientA.once('open', () => resolve())
          clientA.once('error', reject)
        }),
        new Promise<void>((resolve, reject) => {
          clientB.once('open', () => resolve())
          clientB.once('error', reject)
        }),
      ])

      const closeCodePromise = new Promise<number>((resolve) => {
        clientA.once('close', (code) => resolve(code))
      })
      clientA.on('error', () => {})
      // Exceed maxPayload (1024 bytes) on clientA
      clientA.send(JSON.stringify({ type: 'inbound.message', text: 'x'.repeat(4096) }))
      const closeCode = await closeCodePromise
      assert.equal(closeCode, 1009, 'oversized frame must close offending socket with 1009')
      assert.equal(uncaught, null, 'must NOT trigger uncaughtException in gateway process')
      assert.ok(
        warnings.some((w) => w.msg === 'ws.socket_error'),
        'server must isolate and log socket receiver error',
      )

      // clientB must remain unaffected and serve requests normally
      const pongPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        clientB.once('message', (data) => {
          try {
            resolve(JSON.parse(data.toString()))
          } catch (err) {
            reject(err)
          }
        })
      })
      clientB.send(JSON.stringify({ type: 'ping', id: 'healthy-sibling' }))
      const pong = await pongPromise
      assert.equal(pong.type, 'pong')
      assert.equal(pong.id, 'healthy-sibling')
    } finally {
      process.off('uncaughtException', onUncaught)
      try { clientA.terminate() } catch {}
      try { clientB.terminate() } catch {}
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('runStartupUploadTmpCleanup (non-blocking fs/promises)', () => {
  it('removes only stale .tmp-* files in legacy and per-user volumes and preserves fresh/normal files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-tmp-cleanup-'))
    const uploadsDir = join(root, 'uploads')
    const volsRoot = join(root, 'volumes')
    const userUploads = join(volsRoot, 'oc-v5-data-u42', '_data', 'uploads')
    const ignoredVolUploads = join(volsRoot, 'other-volume', '_data', 'uploads')
    await mkdir(uploadsDir, { recursive: true })
    await mkdir(userUploads, { recursive: true })
    await mkdir(ignoredVolUploads, { recursive: true })

    const nowMs = Date.now()
    const oldDate = new Date(nowMs - 2 * 60 * 60 * 1000)
    const freshDate = new Date(nowMs - 5 * 60 * 1000)

    const oldLegacyTmp = join(uploadsDir, '.tmp-old')
    const freshLegacyTmp = join(uploadsDir, '.tmp-fresh')
    const normalFile = join(uploadsDir, 'report.pdf')
    const oldUserTmp = join(userUploads, '.tmp-orphan')
    const oldIgnoredTmp = join(ignoredVolUploads, '.tmp-skip')

    await writeFile(oldLegacyTmp, 'x')
    await writeFile(freshLegacyTmp, 'x')
    await writeFile(normalFile, 'x')
    await writeFile(oldUserTmp, 'x')
    await writeFile(oldIgnoredTmp, 'x')
    await utimes(oldLegacyTmp, oldDate, oldDate)
    await utimes(freshLegacyTmp, freshDate, freshDate)
    await utimes(normalFile, oldDate, oldDate)
    await utimes(oldUserTmp, oldDate, oldDate)
    await utimes(oldIgnoredTmp, oldDate, oldDate)

    const infos: Array<{ msg: string; ctx?: Record<string, unknown> }> = []
    const warns: string[] = []
    try {
      const res = await runStartupUploadTmpCleanup({
        uploadsDir,
        includePerUserVolumes: true,
        volumesRoot: volsRoot,
        nowMs,
        log: {
          info: (msg, ctx) => infos.push({ msg, ctx }),
          warn: (msg) => warns.push(msg),
        },
      })
      assert.equal(res.legacyCleaned, 1)
      assert.equal(res.perUserCleaned, 1)
      assert.equal(res.perUserDirsSwept, 1)
      assert.equal(warns.length, 0)
      assert.deepEqual((await readdir(uploadsDir)).sort(), ['.tmp-fresh', 'report.pdf'])
      assert.deepEqual(await readdir(userUploads), [])
      assert.deepEqual(await readdir(ignoredVolUploads), ['.tmp-skip'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts cleanly when shouldAbort returns true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-tmp-abort-'))
    const uploadsDir = join(root, 'uploads')
    await mkdir(uploadsDir, { recursive: true })
    const f = join(uploadsDir, '.tmp-old')
    await writeFile(f, 'x')
    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(f, oldDate, oldDate)
    try {
      const res = await runStartupUploadTmpCleanup({
        uploadsDir,
        includePerUserVolumes: false,
        shouldAbort: () => true,
        log: { info: () => {}, warn: () => {} },
      })
      assert.equal(res.legacyCleaned, 0)
      assert.deepEqual(await readdir(uploadsDir), ['.tmp-old'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
