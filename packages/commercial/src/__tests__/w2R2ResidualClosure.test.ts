/**
 * OCV5-928 Batch 1 — T2 R2 Residual Closure Suite (B2a/b/c/d, B4 same-ms & cache, B5 Web frame).
 *
 * Directly reproduces and locks down all counterexamples from `ocv5-928-batch1-audit-r2.md`
 * on real Gateway HTTP handlers, CAS runtime/store, `sealAuthorityFieldsOrReject`, and `remoteRelay`.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import { createServer, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import pg from 'pg'
import { WebSocket } from 'ws'
import { CC5_TEST_ENABLED_ENV, CC5_TEST_UID_ENV, REMOTE_DRIVER_BACKEND } from '@openclaude/protocol'
import { remotePoolBackendOf } from '@openclaude/gateway/remote-pool'
import {
  _resolveMediaDirs,
  _sendMediaResolveError,
  handleMediaGet,
  type HttpMiscHandlersHost,
} from '../../../gateway/src/httpMiscHandlers.js'
import { openFileHardened, readBody } from '../../../gateway/src/gatewayHttp.js'
import { RemoteReleaseDrainCoordinator } from '../account-pool/remotePool/drainGate.js'
import { computeProbeFingerprintTs } from '../account-pool/remotePool/driftCoordinator.js'
import { loadRemoteDriverRegistry } from '../account-pool/remotePool/registry.js'
import { placeSelfhostRemoteLaneWithRetry } from '../account-pool/remotePool/sharedLanePlacementRuntime.js'
import {
  createMasterArtifactBlobStore,
  openMasterCasMediaFallback,
  readMasterMediaBytesFromCas,
  registerMasterMediaUploadInCas,
  resolveMasterMediaDirsWithCasBridge,
} from '../agent-sandbox/artifactBlobRuntime.js'
import { LocalCasArtifactBlobStore } from '../agent-sandbox/artifactBlobStore.js'
import { createMasterCc5Runtime, selectMasterCc5Backend } from '../agent-sandbox/cc5Runtime.js'
import { createRemoteRelayClient } from '../agent-sandbox/remoteRelayClient.js'
import { buildUserMediaHostDir } from '../agent-sandbox/userMedia.js'
import {
  bindStreamClientCancelCleanup,
  buildNodeAgentGetPathAndHeaders,
  pipeNodeAgentGetResponse,
} from '../compute-pool/nodeAgentRangeStream.js'
import { parseRelayRequiredTurnCapabilities } from '../remoteRelay/protocol.js'
import { createRemoteRelayRpcServer } from '../remoteRelay/server.js'
import { sealAuthorityFieldsOrReject } from '../ws/bridge/connectionAuthority.js'
import type { BridgeConnectionCtx } from '../ws/bridge/types.js'
import { createMockCasMetaPgPool } from './casMetaTestPool.js'

const HEX64_A = 'a'.repeat(64)
const PROFILE_A_LIMITED = '11111111-1111-4111-8111-111111111111'
const PROFILE_B_FULL = '22222222-2222-4222-8222-222222222222'
const NODE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NODE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function createOrderedCasMetaPool(fixedIso?: string) {
  return createMockCasMetaPgPool(fixedIso ? { fixedIso } : undefined)
}

function makeGatewayHost(commercial: NonNullable<HttpMiscHandlersHost['deps']['commercial']>): HttpMiscHandlersHost {
  const noop = () => undefined
  const log = { info: noop, warn: noop, error: noop, debug: noop } as unknown as HttpMiscHandlersHost['log']
  const host: Partial<HttpMiscHandlersHost> = {
    deps: {
      config: {} as HttpMiscHandlersHost['deps']['config'],
      agentsConfig: { agents: [] } as unknown as HttpMiscHandlersHost['deps']['agentsConfig'],
      commercial,
    },
    log,
    getUserId: (req) => String(req.headers['x-oc-user-id'] ?? 'c:42'),
    sendError: (res, status, message) => {
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: message }))
      }
    },
    sendInternalError: (res) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal error' }))
      }
    },
    sendJson: (res, status, payload) => {
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
    },
  }
  host._resolveMediaDirs = _resolveMediaDirs.bind(host as HttpMiscHandlersHost)
  host._sendMediaResolveError = _sendMediaResolveError.bind(host as HttpMiscHandlersHost)
  host.openFileHardened = openFileHardened.bind(host as unknown as Parameters<typeof openFileHardened>[0])
  host.readBody = readBody.bind(host as unknown as Parameters<typeof readBody>[0])
  return host as HttpMiscHandlersHost
}

async function withMediaHttpServer<T>(host: HttpMiscHandlersHost, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/api/media/')) {
      void handleMediaGet.call(host, req, res, url.pathname.slice('/api/media/'.length))
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const addr = srv.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    srv.closeAllConnections?.()
    await new Promise<void>((resolve) => srv.close(() => resolve()))
  }
}

test('R2-Residual-B2a/b/c/d: Node I/O -> CAS fallback, bounded Range/HEAD read, missing-object clean 404, and alias-wide 403 policy', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ocv5-r2-res-b2-'))
  try {
    const casDb = createOrderedCasMetaPool()
    const { store: blobStore, rootDir: casRoot } = createMasterArtifactBlobStore({
      openClaudeHome: tmpRoot,
      pgPool: casDb.pool,
    })
    const bigRemote = Buffer.alloc(1024 * 1024, 0x41)
    Buffer.from('SLICE-0123').copy(bigRemote, 100)
    const remoteFiles = new Map<string, Buffer>([[`${buildUserMediaHostDir(42, 'generated')}/movie.bin`, bigRemote]])
    let throwNodeIo = false
    let upstreamBytesRead = 0
    let casFallbackCalls = 0

    await registerMasterMediaUploadInCas({
      blobStore,
      tenantId: 'c:42',
      kind: 'upload',
      filename: 'cas-survived.txt',
      bytes: Buffer.from('healthy-cas-bytes-on-node-io-error'),
    })
    const ghostRef = await blobStore.put({
      tenantId: 'c:42',
      kind: 'generated',
      bytes: Buffer.from('ghost-object-will-vanish'),
      mimeType: 'text/plain',
      logicalName: 'ghost.txt',
    })
    await unlink(path.join(casRoot, 'objects', ghostRef.sha256.slice(0, 2), ghostRef.sha256))

    const secretRef = await blobStore.put({
      tenantId: 'c:42',
      kind: 'upload',
      bytes: Buffer.from('{"token":"redacted"}'),
      mimeType: 'application/json',
      logicalName: 'auth.json',
    })

    const host = makeGatewayHost({
      handle: async () => false,
      handleWsUpgrade: () => false,
      shutdown: async () => undefined,
      resolveUserMediaDirs: async () => ({
        kind: 'fail',
        reason: 'remote-host',
        uid: 42,
        hostUuid: '11111111-2222-3333-4444-555555555555',
        uploads: buildUserMediaHostDir(42, 'uploads'),
        generated: buildUserMediaHostDir(42, 'generated'),
        logCtx: { uid: 42 },
      }),
      openRemoteHostMedia: async ({ remotePath, dest, resolveRange, isHead, onReady }) => {
        if (throwNodeIo) throw new Error('ECONNREFUSED node-agent down')
        const full = remoteFiles.get(remotePath)
        if (!full) return 'missing'
        const range = isHead ? null : resolveRange ? resolveRange(full.length) : null
        const len = range ? range.end - range.start + 1 : full.length
        if (!onReady({ size: full.length, range, contentLength: len })) return 'rejected'
        if (isHead) return 'ok'
        const slice = range ? full.subarray(range.start, range.end + 1) : full
        upstreamBytesRead += slice.length
        dest.end(slice)
        return 'ok'
      },
      openCasMediaFallback: async (args) => {
        casFallbackCalls += 1
        return openMasterCasMediaFallback({ blobStore, ...args })
      },
    })

    await withMediaHttpServer(host, async (baseUrl) => {
      // B2-b: HEAD reads 0 upstream bytes; Range reads ONLY 10 bytes (not 1 MiB).
      upstreamBytesRead = 0
      const headRes = await fetch(`${baseUrl}/api/media/movie.bin`, { method: 'HEAD', headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(headRes.status, 200)
      assert.equal(headRes.headers.get('content-length'), String(bigRemote.length))
      assert.equal(upstreamBytesRead, 0)

      const rangeRes = await fetch(`${baseUrl}/api/media/movie.bin`, {
        headers: { 'x-oc-user-id': 'c:42', Range: 'bytes=100-109' },
      })
      assert.equal(rangeRes.status, 206)
      assert.equal(await rangeRes.text(), 'SLICE-0123')
      assert.equal(upstreamBytesRead, 10)

      // B2-a: Node I/O error with healthy CAS copy -> 200 from CAS; without CAS copy -> 502.
      throwNodeIo = true
      casFallbackCalls = 0
      const ioFallbackOk = await fetch(`${baseUrl}/api/media/cas-survived.txt`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(ioFallbackOk.status, 200)
      assert.equal(await ioFallbackOk.text(), 'healthy-cas-bytes-on-node-io-error')
      assert.equal(casFallbackCalls, 1)

      const ioFallbackMiss = await fetch(`${baseUrl}/api/media/nonexistent-everywhere.txt`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(ioFallbackMiss.status, 502)

      // B2-c: Metadata hit + missing CAS object -> clean 404 with ended body (never hanging 200).
      throwNodeIo = false
      const ghostRes = await fetch(`${baseUrl}/api/media/ghost.txt`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(ghostRes.status, 404)
      assert.equal(await ghostRes.text(), 'not found')

      // B2-d: Sensitive filename (`auth.json`) blocked 403 by BOTH logical name AND sha256 alias.
      const byLogical = await fetch(`${baseUrl}/api/media/auth.json`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(byLogical.status, 403)
      const byDigestAlias = await fetch(`${baseUrl}/api/media/${secretRef.sha256}.json`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(byDigestAlias.status, 403)
    })

    // B2-b unit verification of nodeAgentRangeStream query/header & cancel cleanup.
    const hdrs: Record<string, string> = {}
    const builtPath = buildNodeAgentGetPathAndHeaders('/var/vol/f.bin', hdrs, { start: 10, end: 19 })
    assert.ok(builtPath.endsWith('&offset=10&length=10'))
    assert.equal(hdrs.range, 'bytes=10-19')

    let destroyedUpstream = false
    const fakeRes = Readable.from([Buffer.from('0123456789ABCDEFGHIJZZZZZZZZ')]) as unknown as IncomingMessage
    fakeRes.statusCode = 200
    fakeRes.headers = {}
    const origDestroy = fakeRes.destroy.bind(fakeRes)
    fakeRes.destroy = ((err?: Error) => {
      destroyedUpstream = true
      return origDestroy(err)
    }) as IncomingMessage['destroy']
    const sink = new PassThrough()
    const collected: Buffer[] = []
    sink.on('data', (c: Buffer) => collected.push(c))
    await new Promise<void>((resolve, reject) => {
      pipeNodeAgentGetResponse(fakeRes, sink, { start: 10, end: 19 }, (err) => (err ? reject(err) : resolve()))
    })
    assert.equal(Buffer.concat(collected).toString('utf8'), 'ABCDEFGHIJ')
    assert.equal(destroyedUpstream, true)

    const cancelSink = new EventEmitter() as unknown as NodeJS.WritableStream
    let reqDestroyed = false
    const fakeReq = { destroyed: false, destroy() { this.destroyed = true; reqDestroyed = true } } as unknown as ClientRequest
    bindStreamClientCancelCleanup(cancelSink, fakeReq)
    cancelSink.emit('close')
    assert.equal(reqDestroyed, true)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('R2-Residual-B4: Same-millisecond [v2, v1] tie-breaker, v1->v2->v1 revert, and mutable no-cache + ETag/304', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ocv5-r2-res-b4-'))
  try {
    const fixedIso = '2026-11-28T12:00:00.123Z'
    const fixedMs = Date.parse(fixedIso)
    const casDb = createOrderedCasMetaPool(fixedIso)
    const { store: pgStore } = createMasterArtifactBlobStore({ openClaudeHome: tmpRoot, pgPool: casDb.pool })

    await pgStore.put({ tenantId: 'c:42', kind: 'generated', bytes: Buffer.from('same-ms-v1-old'), mimeType: 'text/plain', logicalName: 'same-ms.txt' })
    const v2 = await pgStore.put({ tenantId: 'c:42', kind: 'generated', bytes: Buffer.from('same-ms-v2-newest'), mimeType: 'text/plain', logicalName: 'same-ms.txt' })
    assert.equal(casDb.rows.length, 2)
    assert.equal(casDb.rows[0]?.created_at, casDb.rows[1]?.created_at)

    const directBytes = await readMasterMediaBytesFromCas({ blobStore: pgStore, tenantId: 'c:42', filename: 'same-ms.txt' })
    assert.equal(directBytes?.toString('utf8'), 'same-ms-v2-newest')

    const remoteLoc = {
      kind: 'fail' as const,
      reason: 'remote-host' as const,
      uid: 42,
      hostUuid: '11111111-2222-3333-4444-555555555555',
      uploads: buildUserMediaHostDir(42, 'uploads'),
      generated: buildUserMediaHostDir(42, 'generated'),
      logCtx: { uid: 42 },
    }
    const bridged = await resolveMasterMediaDirsWithCasBridge(remoteLoc, { blobStore: pgStore })
    assert.equal(bridged.kind, 'ok')
    assert.equal(await readFile(path.join(bridged.generated, 'same-ms.txt'), 'utf8'), 'same-ms-v2-newest')

    // Local disk CAS (no PG) at frozen millisecond also selects v2.
    const localCas = new LocalCasArtifactBlobStore({ rootDir: path.join(tmpRoot, 'local-cas'), now: () => fixedMs })
    await localCas.put({ tenantId: 'c:42', kind: 'upload', bytes: Buffer.from('local-v1'), mimeType: 'text/plain', logicalName: 'note.txt' })
    await localCas.put({ tenantId: 'c:42', kind: 'upload', bytes: Buffer.from('local-v2'), mimeType: 'text/plain', logicalName: 'note.txt' })
    assert.equal((await readMasterMediaBytesFromCas({ blobStore: localCas, tenantId: 'c:42', filename: 'note.txt' }))?.toString('utf8'), 'local-v2')

    const host = makeGatewayHost({
      handle: async () => false,
      handleWsUpgrade: () => false,
      shutdown: async () => undefined,
      resolveUserMediaDirs: async () => remoteLoc,
      openCasMediaFallback: (args) => openMasterCasMediaFallback({ blobStore: pgStore, ...args }),
    })

    await withMediaHttpServer(host, async (baseUrl) => {
      const mutableRes = await fetch(`${baseUrl}/api/media/same-ms.txt`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(mutableRes.status, 200)
      assert.equal(mutableRes.headers.get('cache-control'), 'private, no-cache, must-revalidate')
      const etagV2 = mutableRes.headers.get('etag')
      assert.equal(etagV2, `"${v2.sha256}"`)
      assert.equal(await mutableRes.text(), 'same-ms-v2-newest')

      const notMod = await fetch(`${baseUrl}/api/media/same-ms.txt`, {
        headers: { 'x-oc-user-id': 'c:42', 'If-None-Match': etagV2! },
      })
      assert.equal(notMod.status, 304)

      const immutRes = await fetch(`${baseUrl}/api/media/${v2.sha256}.txt`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(immutRes.status, 200)
      assert.equal(immutRes.headers.get('cache-control'), 'private, max-age=3600, immutable')

      // Revert v1 -> v2 -> v1: cached client sending v2 ETag gets 200 with v1 bytes!
      await registerMasterMediaUploadInCas({
        blobStore: pgStore,
        tenantId: 'c:42',
        kind: 'generated',
        filename: 'same-ms.txt',
        bytes: Buffer.from('same-ms-v1-old'),
      })
      const revertedRes = await fetch(`${baseUrl}/api/media/same-ms.txt`, {
        headers: { 'x-oc-user-id': 'c:42', 'If-None-Match': etagV2! },
      })
      assert.equal(revertedRes.status, 200)
      assert.equal(await revertedRes.text(), 'same-ms-v1-old')
    })
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

function createWebFramePlacementPool(opts: { nowMs: number; allowUltrafastOnB: boolean }) {
  const reg = loadRemoteDriverRegistry().get('cc')!
  const policySha256 = 'c'.repeat(64)
  const digests = { driverDigest: reg.driverDigest, coreDigest: reg.coreDigest, policySha256 }
  const observedAt = new Date(opts.nowMs - 5_000).toISOString()
  const baseModelA = {
    upstreamModelId: 'claude-sonnet-4-6',
    displayName: 'claude-sonnet-4-6',
    supportsVision: false,
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportsAdaptiveThinking: true,
  }
  const snapA = {
    schemaVersion: 4 as const, engineId: 'cc', driverId: 'cc', driverVersion: reg.driverVersion,
    source: 'cli:probe' as const, freshness: 'cli-observed' as const, authPresent: true, accountObserved: true,
    cliVersion: '2.1.112', cliSha256: HEX64_A, models: [baseModelA], rawResponseSha256: 'b'.repeat(64), observedAt,
  }
  const fpA = computeProbeFingerprintTs(snapA, digests)

  const snapBForFp = {
    ...snapA,
    models: [{ ...baseModelA, supportsVision: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
  }
  const fpB = computeProbeFingerprintTs(snapBForFp, digests)
  const snapBStored = {
    ...snapBForFp,
    models: [{
      ...snapBForFp.models[0]!,
      ...(opts.allowUltrafastOnB ? { supportedServiceTiers: ['standard', 'fast', 'ultrafast'] } : {}),
    }],
  }

  const committedBindings: Array<{ profileId: string; nodeId: string; sshHost: string }> = []
  const offerRows = [
    {
      id: PROFILE_A_LIMITED, profile_id: PROFILE_A_LIMITED, node_id: NODE_A, driver_id: 'cc', engine: 'ccb',
      profile_name: 'prof-a', status: 'active', disabled_by: null, execution_ready: true,
      execution_manifest: { policySha256 }, verified_fingerprint: fpA, probe_snapshot: snapA,
      probed_at: observedAt, last_probe_ok_at: observedAt, weight: 300, health_score: 100,
      max_concurrent_lanes: 5, active_slots: 0, hot_slots: 0, max_hot_slots: 5,
      upstream_model_id: 'claude-sonnet-4-6', canonical_model_id: 'claude-sonnet-4-6-remote',
      label: 'node-a', ssh_host: '10.10.0.1', ssh_port: 22, ssh_user: 'ubuntu', host_key_fp: 'SHA256:nodeA',
      key_id: 'rpoolv4', rtt_ms_p50: 10, node_status: 'active', has_healthy_legacy_offer: false,
    },
    {
      id: PROFILE_B_FULL, profile_id: PROFILE_B_FULL, node_id: NODE_B, driver_id: 'cc', engine: 'ccb',
      profile_name: 'prof-b', status: 'active', disabled_by: null, execution_ready: true,
      execution_manifest: { policySha256 }, verified_fingerprint: fpB, probe_snapshot: snapBStored,
      probed_at: observedAt, last_probe_ok_at: observedAt, weight: 50, health_score: 100,
      max_concurrent_lanes: 5, active_slots: 0, hot_slots: 0, max_hot_slots: 5,
      upstream_model_id: 'claude-sonnet-4-6', canonical_model_id: 'claude-sonnet-4-6-remote',
      label: 'node-b', ssh_host: '10.10.0.2', ssh_port: 22, ssh_user: 'ubuntu', host_key_fp: 'SHA256:nodeB',
      key_id: 'rpoolv4', rtt_ms_p50: 20, node_status: 'active', has_healthy_legacy_offer: false,
    },
  ]

  let pendingTxRow: { profileId: string; nodeId: string; sshHost: string } | null = null
  const queryImpl = async (sql: string, params: readonly unknown[] = []) => {
    const norm = sql.replace(/\s+/g, ' ').trim()
    if (norm === 'BEGIN' || norm === 'ROLLBACK') {
      if (norm === 'ROLLBACK') pendingTxRow = null
      return { rows: [], rowCount: 0 }
    }
    if (norm === 'COMMIT') {
      if (pendingTxRow) committedBindings.push(pendingTxRow)
      pendingTxRow = null
      return { rows: [], rowCount: 0 }
    }
    if (/^SELECT pg_advisory_xact_lock/i.test(norm)) return { rows: [], rowCount: 0 }
    if (norm.includes('FROM model_logical_pool_bindings')) {
      throw Object.assign(new Error('missing table'), { code: '42P01' })
    }
    if (norm.includes('SELECT COUNT(*)::int AS profile_used FROM remote_agent_bindings')) {
      return { rows: [{ profile_used: 0 }], rowCount: 1 }
    }
    if (norm.includes('FROM request_finalize_journal')) return { rows: [], rowCount: 0 }
    if (norm.startsWith('INSERT INTO remote_agent_bindings')) {
      pendingTxRow = {
        nodeId: String(params[6]),
        profileId: String(params[7]),
        sshHost: String(params[7]) === PROFILE_B_FULL ? '10.10.0.2' : '10.10.0.1',
      }
      return { rows: [], rowCount: 1 }
    }
    if (norm.startsWith('UPDATE remote_agent_bindings')) return { rows: [], rowCount: 1 }
    if (norm.startsWith('UPDATE remote_agent_profiles')) return { rows: [], rowCount: 1 }
    if (norm.includes('FROM remote_agent_bindings')) return { rows: [], rowCount: 0 }
    if (norm.includes('FROM remote_model_offers')) return { rows: offerRows, rowCount: offerRows.length }
    return { rows: [], rowCount: 0 }
  }
  const pool = new pg.Pool({ max: 1, idleTimeoutMillis: 1 })
  Reflect.set(pool, 'query', queryImpl)
  Reflect.set(pool, 'connect', async () => ({ query: queryImpl, release: () => undefined }))
  return { pool, committedBindings }
}

test('R2-Residual-B5: Real Web InboundMessage (content.media image + effortLevel=max + serviceTier=ultrafast) derives capabilities through sealAuthorityFieldsOrReject & remoteRelay', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'oc-drvtest-r2-res-b5-'))
  try {
    // 1. Relay protocol accepts full protocol enums (`max`, `fast`, `ultrafast`).
    assert.deepEqual(parseRelayRequiredTurnCapabilities({ needsVision: true, reasoningEffort: 'max', serviceTier: 'ultrafast' }), {
      needsVision: true,
      reasoningEffort: 'max',
      serviceTier: 'ultrafast',
    })
    assert.deepEqual(parseRelayRequiredTurnCapabilities({ reasoningEffort: 'max', serviceTier: 'fast' }), {
      reasoningEffort: 'max',
      serviceTier: 'fast',
    })

    const nowMs = Date.parse('2026-11-28T12:00:00.000Z')
    const drainGate = new RemoteReleaseDrainCoordinator()
    const env = { [CC5_TEST_ENABLED_ENV]: '1', [CC5_TEST_UID_ENV]: '42', OC_REMOTE_V4_DRAIN_SOCKET: 'none' }
    const webInboundFrame: Record<string, unknown> = {
      type: 'inbound.message',
      idempotencyKey: 'idem-web-1',
      channel: 'webchat',
      peer: { id: 'sess_web_1', kind: 'dm' },
      content: {
        text: 'Inspect this screenshot deeply',
        media: [{ kind: 'image', url: '/api/media/screen.png', mimeType: 'image/png' }],
      },
      effortLevel: 'max',
      serviceTier: 'ultrafast',
    }

    // 2. Real `sealAuthorityFieldsOrReject` with NO pre-filled `requiredCapabilities` extracts Web fields & binds PROFILE_B_FULL.
    const dbOk = createWebFramePlacementPool({ nowMs, allowUltrafastOnB: true })
    let capturedSelectorCaps: unknown
    const inProcRuntime = createMasterCc5Runtime(
      {
        selfhost: true, authorityReady: true, env,
        financeFactory: (() => ({ admitTurn: async () => ({ requestId: 'r1' }), completeTurn: async () => undefined, failTurn: async () => undefined })) as unknown as NonNullable<Parameters<typeof createMasterCc5Runtime>[0]['financeFactory']>,
      },
      {
        pool: () => dbOk.pool, drainGate, baseRoot: path.join(tmpRoot, 'b1'), evidenceRoot: path.join(tmpRoot, 'e1'),
        v4PlacementOptions: { now: () => nowMs, localSandboxDir: tmpRoot },
        create: (cfg) => ({
          prepare: async () => ({ mountSource: tmpRoot, containerDbId: '101' }),
          bindCreated: async () => undefined, activate: async () => undefined, release: async () => undefined, releaseChat: async () => undefined,
          ensureLane: async (req) => remotePoolBackendOf((await cfg.hooks.place({ ...req, dockerId: HEX64_A })).v4!.binding),
        }),
      },
    )

    const makeBridgeCtx = (selector: BridgeConnectionCtx['shared']['deps']['cc5BackendSelector'], onSendErr?: (code: string) => void): BridgeConnectionCtx =>
      ({
        uid: 42n,
        containerId: 101,
        containerChallenge: 'chal-1',
        cleaned: false,
        userWs: { readyState: WebSocket.CLOSED } as unknown as WebSocket,
        readEpochAtSign: async () => 1n,
        modelCheckerHandle: null,
        authorityDeps: {
          signer: {
            signBundle: (b: Record<string, unknown>) => ({ bundle: { payload: b, signature: 'sig', keyId: 'k1' } }),
          },
        },
        shared: { deps: { cc5BackendSelector: selector } },
        onSendErr,
      }) as unknown as BridgeConnectionCtx

    const sealed = await sealAuthorityFieldsOrReject(
      makeBridgeCtx((selInput) => {
        capturedSelectorCaps = selInput.requiredCapabilities
        return selectMasterCc5Backend(inProcRuntime, selInput, true, env)
      }),
      {
        exec: {
          canonicalModel: 'claude-sonnet-4-6-remote',
          engine: 'ccb',
          placement: 'remote_pool',
          securityEpoch: 1,
          executionRevision: 'rev-1',
          descriptor: {},
          auxModels: [],
        } as unknown as Parameters<typeof sealAuthorityFieldsOrReject>[1]['exec'],
        inboundFrame: webInboundFrame,
        turn: { sessionKey: 'agent:main:webchat:dm:web_real_frame_1' } as Parameters<typeof sealAuthorityFieldsOrReject>[1]['turn'],
        log: null,
      },
    )
    assert.ok(sealed)
    assert.deepEqual(capturedSelectorCaps, {
      needsVision: true,
      reasoningEffort: 'max',
      serviceTier: 'ultrafast',
    })
    assert.equal(dbOk.committedBindings.length, 1)
    assert.equal(dbOk.committedBindings[0]?.profileId, PROFILE_B_FULL)
    assert.equal(dbOk.committedBindings[0]?.sshHost, '10.10.0.2')

    // 3. When NO profile supports `ultrafast`, `sealAuthorityFieldsOrReject` fails closed (0 bindings).
    const dbNoUltra = createWebFramePlacementPool({ nowMs, allowUltrafastOnB: false })
    const noUltraRuntime = createMasterCc5Runtime(
      {
        selfhost: true, authorityReady: true, env,
        financeFactory: (() => ({ admitTurn: async () => ({ requestId: 'r2' }), completeTurn: async () => undefined, failTurn: async () => undefined })) as unknown as NonNullable<Parameters<typeof createMasterCc5Runtime>[0]['financeFactory']>,
      },
      {
        pool: () => dbNoUltra.pool, drainGate, baseRoot: path.join(tmpRoot, 'b2'), evidenceRoot: path.join(tmpRoot, 'e2'),
        v4PlacementOptions: { now: () => nowMs, localSandboxDir: tmpRoot },
        create: (cfg) => ({
          prepare: async () => ({ mountSource: tmpRoot, containerDbId: '101' }),
          bindCreated: async () => undefined, activate: async () => undefined, release: async () => undefined, releaseChat: async () => undefined,
          ensureLane: async (req) => remotePoolBackendOf((await cfg.hooks.place({ ...req, dockerId: HEX64_A })).v4!.binding),
        }),
      },
    )
    let rejectedCode: string | undefined
    const rejectedSeal = await sealAuthorityFieldsOrReject(
      makeBridgeCtx((selInput) => selectMasterCc5Backend(noUltraRuntime, selInput, true, env)),
      {
        exec: {
          canonicalModel: 'claude-sonnet-4-6-remote',
          engine: 'ccb',
          placement: 'remote_pool',
          securityEpoch: 1,
          executionRevision: 'rev-1',
          descriptor: {},
          auxModels: [],
        } as unknown as Parameters<typeof sealAuthorityFieldsOrReject>[1]['exec'],
        inboundFrame: webInboundFrame,
        turn: { sessionKey: 'agent:main:webchat:dm:web_real_frame_reject' } as Parameters<typeof sealAuthorityFieldsOrReject>[1]['turn'],
        onReject: (code) => { rejectedCode = code },
        log: null,
      },
    )
    assert.equal(rejectedSeal, null)
    assert.ok(rejectedCode)
    assert.equal(dbNoUltra.committedBindings.length, 0)

    // 4. Standalone AF_UNIX remoteRelay end-to-end with `{ needsVision: true, reasoningEffort: 'max', serviceTier: 'ultrafast' }`.
    const relayDb = createWebFramePlacementPool({ nowMs, allowUltrafastOnB: true })
    const relaySock = path.join(tmpRoot, 'relay-r2-b5.sock')
    const relayServer = await createRemoteRelayRpcServer({
      socketPath: relaySock,
      secret: 'r2-b5-secret',
      slot: 'A',
      instanceId: 'inst-r2-b5',
      drainGate,
      pool: () => relayDb.pool,
      runtime: {
        prepare: async () => ({ mountSource: tmpRoot, containerDbId: '101' }),
        bindCreated: async () => undefined, activate: async () => undefined, release: async () => undefined, releaseChat: async () => undefined,
        ensureLane: async (req) =>
          remotePoolBackendOf(
            (
              await placeSelfhostRemoteLaneWithRetry(
                { ...req, dockerId: HEX64_A },
                {
                  getPool: () => relayDb.pool,
                  drainGate,
                  controllerPath: '/nonexistent/controller.py',
                  v4PlacementOptions: { now: () => nowMs, localSandboxDir: tmpRoot },
                },
              )
            ).v4!.binding,
          ),
      },
    })
    try {
      const client = createRemoteRelayClient({ socketPath: relaySock, secret: 'r2-b5-secret' })
      const backend = await client.ensureLane({
        uid: 42,
        containerDbId: '101',
        sessionKey: 'agent:main:webchat:dm:relay_max_ultrafast_1',
        canonicalModel: 'claude-sonnet-4-6-remote',
        requiredCapabilities: { needsVision: true, reasoningEffort: 'max', serviceTier: 'ultrafast' },
      })
      assert.equal(backend.kind, REMOTE_DRIVER_BACKEND)
      assert.equal(relayDb.committedBindings.length, 1)
      assert.equal(relayDb.committedBindings[0]?.profileId, PROFILE_B_FULL)
    } finally {
      await relayServer.close()
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})
