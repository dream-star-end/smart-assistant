/**
 * OCV5-928 Batch 1 — Cross-Family Architecture Steward Closure Suite (`Steward-B1`..`Steward-B5`).
 *
 * Reproduces and locks down all 5 P1 blockers from `ocv5-928-b1-steward-verdict-b97292980.json`:
 * 1. Steward-B1: Buffered (`GET /api/file`) and streaming (`GET /api/media`) CAS reads share the
 *    exact same canonical `policyCheckPaths` authorization BEFORE delivering any bytes.
 * 2. Steward-B2: Explicit node-agent `401`/`403` rejections (`AgentAuthError`, `'denied'`)
 *    terminate immediately with ZERO CAS fallback calls (`casFallbackCalls === 0`).
 * 3. Steward-B3: Real `POST /api/uploads/init` aged-upload cleanup (`httpUploadChunks.ts`)
 *    durably soft-deletes the CAS mirror so `GET`/`HEAD /api/media/<name>` immediately return `404`
 *    while preserving other active blobs sharing the same `sha256`.
 * 4. Steward-B4: Concurrent retries of `registerMasterMediaUploadInCas` across separate PG
 *    connections serialize on `pg_advisory_xact_lock`, reusing 1 row while preserving `A -> B -> A`.
 * 5. Steward-B5: Existing sticky session bindings NEVER bypass a disabled `model_logical_pool_bindings`
 *    row across `selectSelfhostRemoteDriverViaUnifiedRouter`, `placeSelfhostRemoteLaneOnce`, or
 *    in-transaction `placeRemoteDriverLane` (`0` new bindings committed).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import { UPLOAD_RETENTION_MS } from '@openclaude/protocol'
import { closeSessionsDb, getSessionsDb, paths } from '@openclaude/storage'
import {
  _resolveMediaDirs,
  _sendMediaResolveError,
  handleApiFile,
  handleMediaGet,
  type HttpMiscHandlersHost,
} from '../../../gateway/src/httpMiscHandlers.js'
import { handleChunkedUpload } from '../../../gateway/src/httpUploadChunks.js'
import { openFileHardened, readBody } from '../../../gateway/src/gatewayHttp.js'
import { RemoteReleaseDrainCoordinator } from '../account-pool/remotePool/drainGate.js'
import { computeProbeFingerprintTs } from '../account-pool/remotePool/driftCoordinator.js'
import { placeRemoteDriverLane } from '../account-pool/remotePool/placement.js'
import { loadRemoteDriverRegistry } from '../account-pool/remotePool/registry.js'
import { selectSelfhostRemoteDriverViaUnifiedRouter } from '../account-pool/remotePool/remoteDriverRouterSelection.js'
import { placeSelfhostRemoteLaneOnce } from '../account-pool/remotePool/sharedLanePlacementRuntime.js'
import {
  createCasBridgedRemoteMediaPuller,
  createCasMediaChunkMirrorCallbacks,
  createMasterArtifactBlobStore,
  openMasterCasMediaFallback,
  readMasterMediaBytesFromCas,
  registerMasterMediaUploadInCas,
} from '../agent-sandbox/artifactBlobRuntime.js'
import { buildUserMediaHostDir } from '../agent-sandbox/userMedia.js'
import { AgentAuthError } from '../compute-pool/nodeAgentClient.js'
import { createMockCasMetaPgPool } from './casMetaTestPool.js'

const HEX64_A = 'a'.repeat(64)
const PROFILE_STICKY = '11111111-1111-4111-8111-111111111111'
const NODE_STICKY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function makeGatewayHost(
  commercial: NonNullable<HttpMiscHandlersHost['deps']['commercial']>,
): HttpMiscHandlersHost {
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

async function withFullMediaHttpServer<T>(
  host: HttpMiscHandlersHost,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api/file') {
      void handleApiFile.call(host, req, res, url)
      return
    }
    if (url.pathname.startsWith('/api/media/')) {
      void handleMediaGet.call(host, req, res, url.pathname.slice('/api/media/'.length))
      return
    }
    if (url.pathname.startsWith('/api/uploads/')) {
      void handleChunkedUpload.call(host, req, res, url)
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

test('Steward-B1 & B2: Alias-consistent 403 across /api/media + /api/file, and 0 CAS calls on explicit node 401/403', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ocv5-steward-b12-'))
  try {
    const casDb = createMockCasMetaPgPool({ stepMsPerInsert: true })
    const { store: blobStore } = createMasterArtifactBlobStore({ openClaudeHome: tmpRoot, pgPool: casDb.pool })

    const secretRef = await blobStore.put({
      tenantId: 'c:42',
      kind: 'upload',
      bytes: Buffer.from('{"secret":"never-leak"}'),
      mimeType: 'application/json',
      logicalName: 'auth.json',
      containerRelativePath: 'uploads/auth.json',
    })
    await registerMasterMediaUploadInCas({
      blobStore,
      tenantId: 'c:42',
      kind: 'upload',
      filename: 'safe-cas.txt',
      bytes: Buffer.from('cas-copy-must-not-serve-on-node-403'),
    })

    let nodeMode: 'missing' | 'auth401' | 'auth403' | 'deniedOutcome' = 'missing'
    let casCalls = 0
    const remoteUploads = buildUserMediaHostDir(42, 'uploads')
    const remoteGenerated = buildUserMediaHostDir(42, 'generated')

    const pullRemote = createCasBridgedRemoteMediaPuller({
      getBlobStore: () => {
        casCalls += 1
        return blobStore
      },
      pullFromNodeAgent: async () => {
        if (nodeMode === 'auth401') throw new AgentAuthError('host-42', 401, 'bad psk')
        if (nodeMode === 'auth403') throw new AgentAuthError('host-42', 403, 'forbidden')
        return null
      },
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
        uploads: remoteUploads,
        generated: remoteGenerated,
        logCtx: { uid: 42 },
      }),
      pullRemoteHostMedia: pullRemote,
      openRemoteHostMedia: async () => {
        if (nodeMode === 'auth401') throw new AgentAuthError('host-42', 401, 'bad psk')
        if (nodeMode === 'auth403') throw new AgentAuthError('host-42', 403, 'forbidden')
        if (nodeMode === 'deniedOutcome') return 'denied'
        return 'missing'
      },
      openCasMediaFallback: async (args) => {
        casCalls += 1
        return openMasterCasMediaFallback({ blobStore, ...args })
      },
    })

    await withFullMediaHttpServer(host, async (baseUrl) => {
      // Steward-B1: exact same `<sha256>.json` alias of `auth.json` is rejected 403 on BOTH /api/media AND /api/file!
      nodeMode = 'missing'
      const mediaAliasRes = await fetch(`${baseUrl}/api/media/${secretRef.sha256}.json`, {
        headers: { 'x-oc-user-id': 'c:42' },
      })
      assert.equal(mediaAliasRes.status, 403)

      const apiFileAliasPath = `${remoteUploads}/${secretRef.sha256}.json`
      const fileAliasRes = await fetch(
        `${baseUrl}/api/file?path=${encodeURIComponent(apiFileAliasPath)}`,
        { headers: { 'x-oc-user-id': 'c:42' } },
      )
      assert.equal(fileAliasRes.status, 403)
      assert.equal(await fileAliasRes.text(), 'access denied')

      // Steward-B2: explicit node-agent 401/403/denied terminates with casCalls === 0!
      for (const mode of ['auth401', 'auth403', 'deniedOutcome'] as const) {
        nodeMode = mode
        casCalls = 0
        const mediaDenied = await fetch(`${baseUrl}/api/media/safe-cas.txt`, {
          headers: { 'x-oc-user-id': 'c:42' },
        })
        assert.ok(mediaDenied.status === 403 || mediaDenied.status === 502)
        assert.equal(casCalls, 0, `expected 0 CAS calls on /api/media for mode=${mode}`)
      }

      for (const mode of ['auth401', 'auth403'] as const) {
        nodeMode = mode
        casCalls = 0
        const fileDenied = await fetch(
          `${baseUrl}/api/file?path=${encodeURIComponent(`${remoteUploads}/safe-cas.txt`)}`,
          { headers: { 'x-oc-user-id': 'c:42' } },
        )
        assert.ok(fileDenied.status === 403 || fileDenied.status === 502)
        assert.equal(casCalls, 0, `expected 0 CAS calls on /api/file for mode=${mode}`)
      }
    })
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('Steward-B3: Real httpUploadChunks aged-upload cleanup invalidates CAS fallback on GET & HEAD while preserving shared-sha256 siblings', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ocv5-steward-b3-'))
  const origHome = paths.home
  const origSessionsDb = paths.sessionsDb
  const origUploadsDir = paths.uploadsDir
  try {
    await mkdir(path.join(tmpRoot, 'agents'), { recursive: true })
    paths.home = tmpRoot
    paths.sessionsDb = path.join(tmpRoot, 'sessions.db')
    paths.uploadsDir = path.join(tmpRoot, 'uploads-staging')
    getSessionsDb()

    const casDb = createMockCasMetaPgPool({ stepMsPerInsert: true })
    const { store: blobStore } = createMasterArtifactBlobStore({ openClaudeHome: tmpRoot, pgPool: casDb.pool })
    const sharedBytes = Buffer.from('shared-digest-payload-across-two-files')
    const sharedSha = createHash('sha256').update(sharedBytes).digest('hex')
    const agedName = `${sharedSha}.txt`
    const remoteUploads = buildUserMediaHostDir(42, 'uploads')
    const remoteGenerated = buildUserMediaHostDir(42, 'generated')
    const remoteFiles = new Map<string, { bytes: Buffer; mtimeMs: number }>([
      [`${remoteUploads}/${agedName}`, { bytes: sharedBytes, mtimeMs: Date.now() - UPLOAD_RETENTION_MS - 60_000 }],
    ])

    const callbacks = createCasMediaChunkMirrorCallbacks(() => blobStore)
    await callbacks.mirrorRemotePathBytes!(`${remoteUploads}/${agedName}`, sharedBytes)
    // Sibling generated file sharing identical content digest must remain readable after upload cleanup!
    await registerMasterMediaUploadInCas({
      blobStore,
      tenantId: 'c:42',
      kind: 'generated',
      filename: 'keep-sibling.txt',
      bytes: sharedBytes,
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
        uploads: remoteUploads,
        generated: remoteGenerated,
        logCtx: { uid: 42 },
      }),
      pushRemoteHostUpload: async () => undefined,
      sumRemoteUploadUsage: async () => {
        const files = [...remoteFiles.entries()].map(([p, v]) => ({
          name: path.posix.basename(p),
          size: v.bytes.length,
          mtimeMs: v.mtimeMs,
        }))
        const usedBytes = files.reduce((acc, f) => acc + f.size, 0)
        return { usedBytes, truncated: false, files }
      },
      deleteRemoteHostUpload: async ({ remotePath }) => {
        await callbacks.deleteRemotePathInCas!(remotePath)
        remoteFiles.delete(remotePath)
      },
      openRemoteHostMedia: async ({ remotePath, dest, onReady, isHead }) => {
        const entry = remoteFiles.get(remotePath)
        if (!entry) return 'missing'
        if (!onReady({ size: entry.bytes.length, range: null, contentLength: entry.bytes.length })) {
          return 'rejected'
        }
        if (!isHead) dest.end(entry.bytes)
        return 'ok'
      },
      openCasMediaFallback: callbacks.openCasMediaFallback,
    })

    await withFullMediaHttpServer(host, async (baseUrl) => {
      // Trigger REAL `httpUploadChunks.ts` aged-upload cleanup via POST /api/uploads/init!
      const initRes = await fetch(`${baseUrl}/api/uploads/init`, {
        method: 'POST',
        headers: { 'x-oc-user-id': 'c:42', 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'fresh.txt', size: 12, mimeType: 'text/plain' }),
      })
      assert.equal(initRes.status, 200)
      assert.equal(remoteFiles.has(`${remoteUploads}/${agedName}`), false)

      const getDeleted = await fetch(`${baseUrl}/api/media/${agedName}`, {
        headers: { 'x-oc-user-id': 'c:42' },
      })
      assert.equal(getDeleted.status, 404)

      const headDeleted = await fetch(`${baseUrl}/api/media/${agedName}`, {
        method: 'HEAD',
        headers: { 'x-oc-user-id': 'c:42' },
      })
      assert.equal(headDeleted.status, 404)

      // Shared-digest sibling remains 100% intact!
      const siblingBytes = await readMasterMediaBytesFromCas({
        blobStore,
        tenantId: 'c:42',
        filename: 'keep-sibling.txt',
        kind: 'generated',
      })
      assert.equal(siblingBytes?.toString('utf8'), sharedBytes.toString('utf8'))
    })
  } finally {
    closeSessionsDb()
    paths.home = origHome
    paths.sessionsDb = origSessionsDb
    paths.uploadsDir = origUploadsDir
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('Steward-B4: Concurrent retries across independent PG connections serialize atomically (1 row) while preserving A -> B -> A', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ocv5-steward-b4-'))
  try {
    const casDb = createMockCasMetaPgPool({ stepMsPerInsert: true })
    const { store: storeConn1 } = createMasterArtifactBlobStore({ openClaudeHome: tmpRoot, pgPool: casDb.pool })
    const { store: storeConn2 } = createMasterArtifactBlobStore({ openClaudeHome: tmpRoot, pgPool: casDb.pool })

    const bytesA = Buffer.from('version-A-concurrent-idempotent')
    const bytesB = Buffer.from('version-B-distinct-update')

    const [r1, r2, r3, r4] = await Promise.all([
      registerMasterMediaUploadInCas({ blobStore: storeConn1, tenantId: 'c:42', kind: 'upload', filename: 'doc.txt', bytes: bytesA }),
      registerMasterMediaUploadInCas({ blobStore: storeConn2, tenantId: 'c:42', kind: 'upload', filename: 'doc.txt', bytes: bytesA }),
      registerMasterMediaUploadInCas({ blobStore: storeConn1, tenantId: 'c:42', kind: 'upload', filename: 'doc.txt', bytes: bytesA }),
      registerMasterMediaUploadInCas({ blobStore: storeConn2, tenantId: 'c:42', kind: 'upload', filename: 'doc.txt', bytes: bytesA }),
    ])
    assert.ok(r1 && r2 && r3 && r4)
    assert.equal(casDb.getInsertCalls(), 1)
    assert.equal(r1.blobId, r2.blobId)
    assert.equal(r2.blobId, r3.blobId)
    assert.equal(r3.blobId, r4.blobId)

    // A -> B -> A valid update sequence produces v2 then v3!
    const rB = await registerMasterMediaUploadInCas({
      blobStore: storeConn1,
      tenantId: 'c:42',
      kind: 'upload',
      filename: 'doc.txt',
      bytes: bytesB,
    })
    assert.ok(rB && rB.blobId !== r1.blobId)
    assert.equal(casDb.getInsertCalls(), 2)

    const rARevert = await registerMasterMediaUploadInCas({
      blobStore: storeConn2,
      tenantId: 'c:42',
      kind: 'upload',
      filename: 'doc.txt',
      bytes: bytesA,
    })
    assert.ok(rARevert && rARevert.blobId !== rB.blobId && rARevert.blobId !== r1.blobId)
    assert.equal(casDb.getInsertCalls(), 3)
    const latest = await readMasterMediaBytesFromCas({ blobStore: storeConn1, tenantId: 'c:42', filename: 'doc.txt' })
    assert.equal(latest?.toString('utf8'), bytesA.toString('utf8'))
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('Steward-B5: Sticky session binding fails closed with 0 new bindings when model_logical_pool_bindings disables the model', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'oc-drvtest-steward-b5-'))
  try {
    const nowMs = Date.parse('2026-11-28T12:00:00.000Z')
    const reg = loadRemoteDriverRegistry().get('cc')!
    const policySha256 = 'c'.repeat(64)
    const observedAt = new Date(nowMs - 5_000).toISOString()
    const snap = {
      schemaVersion: 4 as const,
      engineId: 'cc',
      driverId: 'cc',
      driverVersion: reg.driverVersion,
      source: 'cli:probe' as const,
      freshness: 'cli-observed' as const,
      authPresent: true,
      accountObserved: true,
      cliVersion: '2.1.112',
      cliSha256: HEX64_A,
      models: [
        {
          upstreamModelId: 'claude-sonnet-4-6',
          displayName: 'claude-sonnet-4-6',
          supportsVision: true,
          supportedEfforts: ['low', 'medium', 'high'] as const,
          defaultEffort: 'medium' as const,
          supportsAdaptiveThinking: true,
        },
      ],
      rawResponseSha256: 'b'.repeat(64),
      observedAt,
    }
    const fp = computeProbeFingerprintTs(snap, {
      driverDigest: reg.driverDigest,
      coreDigest: reg.coreDigest,
      policySha256,
    })

    let insertedBindings = 0
    const queryImpl = async (sql: string) => {
      const norm = sql.replace(/\s+/g, ' ').trim()
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT|SELECT pg_advisory_xact_lock)/i.test(norm)) {
        return { rows: [], rowCount: 0 }
      }
      if (norm.includes('FROM model_logical_pool_bindings')) {
        if (norm.includes('enabled = TRUE')) return { rows: [], rowCount: 0 }
        return {
          rows: [
            {
              logical_model_id: 'claude-sonnet-4-6',
              pool_kind: 'remote_pool',
              driver_id: 'cc',
              canonical_model_id: 'claude-sonnet-4-6-remote',
              priority: 10,
              enabled: false,
              capabilities_json: {},
            },
          ],
          rowCount: 1,
        }
      }
      if (norm.includes("state <> 'released'")) return { rows: [], rowCount: 0 }
      if (norm.includes('FROM remote_agent_bindings')) {
        return {
          rows: [
            {
              driver_id: 'cc',
              operation_id: '33333333-3333-4333-8333-333333333333',
              run_id: '44444444-4444-4444-8444-444444444444',
              profile_id: PROFILE_STICKY,
              node_id: NODE_STICKY,
              generation: '1',
              native_session_id: 'sess-sticky-prior',
            },
          ],
          rowCount: 1,
        }
      }
      if (norm.includes('FROM remote_model_offers')) {
        return {
          rows: [
            {
              id: PROFILE_STICKY,
              profile_id: PROFILE_STICKY,
              node_id: NODE_STICKY,
              driver_id: 'cc',
              engine: 'ccb',
              profile_name: 'prof-sticky',
              status: 'active',
              disabled_by: null,
              execution_ready: true,
              execution_manifest: { policySha256 },
              verified_fingerprint: fp,
              probe_snapshot: snap,
              probed_at: observedAt,
              last_probe_ok_at: observedAt,
              weight: 100,
              health_score: 100,
              max_concurrent_lanes: 5,
              active_slots: 0,
              hot_slots: 0,
              max_hot_slots: 5,
              upstream_model_id: 'claude-sonnet-4-6',
              canonical_model_id: 'claude-sonnet-4-6-remote',
              label: 'node-sticky',
              ssh_host: '10.10.0.1',
              ssh_port: 22,
              ssh_user: 'ubuntu',
              host_key_fp: 'SHA256:nodeSticky',
              key_id: 'rpoolv4',
              rtt_ms_p50: 10,
              node_status: 'active',
              has_healthy_legacy_offer: false,
            },
          ],
          rowCount: 1,
        }
      }
      if (norm.startsWith('INSERT INTO remote_agent_bindings') || norm.startsWith('UPDATE remote_agent_bindings')) {
        insertedBindings += 1
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    const pool = new pg.Pool({ max: 1, idleTimeoutMillis: 1 })
    Reflect.set(pool, 'query', queryImpl)
    Reflect.set(pool, 'connect', async () => ({ query: queryImpl, release: () => undefined }))

    await assert.rejects(
      () =>
        selectSelfhostRemoteDriverViaUnifiedRouter(
          pool,
          {
            selfhost: true,
            uid: 42,
            sessionKey: 'agent:main:webchat:dm:sticky_disabled_model',
            canonicalModel: 'claude-sonnet-4-6-remote',
            engine: 'ccb',
          },
          { now: () => nowMs },
        ),
      /CAPABILITY_UNSATISFIED/,
    )

    const drainGate = new RemoteReleaseDrainCoordinator()
    await assert.rejects(
      () =>
        placeSelfhostRemoteLaneOnce(
          {
            uid: 42,
            containerDbId: '101',
            dockerId: HEX64_A,
            sessionKey: 'agent:main:webchat:dm:sticky_disabled_model',
            canonicalModel: 'claude-sonnet-4-6-remote',
            engine: 'ccb',
          },
          {
            getPool: () => pool,
            drainGate,
            controllerPath: '/nonexistent/controller.py',
            v4PlacementOptions: { now: () => nowMs, localSandboxDir: tmpRoot },
          },
        ),
      /CAPABILITY_UNSATISFIED/,
    )

    // Direct in-transaction guard also blocks even if router was bypassed!
    await assert.rejects(
      () =>
        placeRemoteDriverLane(
          {
            uid: 42,
            containerDbId: '101',
            dockerId: HEX64_A,
            sessionKey: 'agent:main:webchat:dm:sticky_disabled_model',
            canonicalModel: 'claude-sonnet-4-6-remote',
            driverId: 'cc',
          },
          { pool, drainGate, now: () => nowMs, localSandboxDir: tmpRoot },
        ),
      /CAPABILITY_UNSATISFIED/,
    )
    assert.equal(insertedBindings, 0)
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})
