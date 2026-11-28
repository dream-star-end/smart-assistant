/**
 * OCV5-928 Batch 1 R2 — Media CAS Bridge Closure Suite (T2 Audit Blockers B1–B4).
 *
 * Verifies real Gateway HTTP handlers (`handleMediaGet`, `handleUpload`, `handleChunkedUpload`)
 * and Master CAS bridge (`artifactBlobRuntime` / `artifactBlobStore`).
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import pg from 'pg'
import {
  _resolveMediaDirs,
  _sendMediaResolveError,
  handleMediaGet,
  handleUpload,
  type HttpMiscHandlersHost,
} from '../../../gateway/src/httpMiscHandlers.js'
import { handleChunkedUpload } from '../../../gateway/src/httpUploadChunks.js'
import { openFileHardened, readBody } from '../../../gateway/src/gatewayHttp.js'
import {
  createMasterArtifactBlobStore,
  createCasBridgedRemoteMediaPuller,
  openMasterCasMediaFallback,
  registerMasterMediaUploadInCas,
  resolveMasterMediaDirsWithCasBridge,
} from '../agent-sandbox/artifactBlobRuntime.js'
import type { LocalCasArtifactBlobStore } from '../agent-sandbox/artifactBlobStore.js'
import {
  buildUserMediaHostDir,
  parseUserVolumeMediaFilePath,
  type DockerLike,
} from '../agent-sandbox/userMedia.js'
import {
  createCasAwareRemoteHostUploadPusher,
  createCasAwareUserMediaResolver,
} from '../bootstrap/runtimeSupervisorBootstrap.js'

function createStatefulCasMetaPool(opts?: { throwOnSelect?: () => boolean }) {
  const rows = new Map<string, Record<string, unknown>>()
  let insertCalls = 0
  const pool = new pg.Pool({ max: 1, idleTimeoutMillis: 1 })
  Reflect.set(pool, 'query', async (sql: string, params: readonly unknown[] = []) => {
    const norm = sql.replace(/\s+/g, ' ').trim()
    if (opts?.throwOnSelect?.() && norm.startsWith('SELECT')) {
      throw new Error('CAS_PG_METADATA_DOWN')
    }
    if (norm.startsWith('INSERT INTO artifact_blobs')) {
      insertCalls += 1
      const row: Record<string, unknown> = {
        blob_id: String(params[0]),
        tenant_id: String(params[1]),
        sha256: String(params[2]),
        size_bytes: Number(params[3]),
        mime_type: String(params[4]),
        kind: String(params[5]),
        logical_name: params[6] === null ? null : String(params[6]),
        container_relative_path: params[7] === null ? null : String(params[7]),
        storage_backend: String(params[8]),
        storage_uri: String(params[9]),
        created_at: new Date(Date.now() + insertCalls).toISOString(),
        deleted_at: null,
      }
      rows.set(String(row.blob_id), row)
      return { rows: [row], rowCount: 1 }
    }
    if (norm.startsWith('UPDATE artifact_blobs SET deleted_at')) {
      const hit = rows.get(String(params[1]))
      if (hit && hit.tenant_id === String(params[0]) && hit.deleted_at === null) {
        hit.deleted_at = new Date().toISOString()
        return { rows: [{ blob_id: hit.blob_id }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (norm.includes('FROM artifact_blobs WHERE tenant_id = $1 AND blob_id = $2')) {
      const hit = rows.get(String(params[1]))
      const out = hit && hit.tenant_id === String(params[0]) && hit.deleted_at === null ? [hit] : []
      return { rows: out, rowCount: out.length }
    }
    if (norm.includes('FROM artifact_blobs WHERE tenant_id = $1 AND sha256 = $2')) {
      const active = [...rows.values()]
        .filter((r) => r.tenant_id === String(params[0]) && r.sha256 === String(params[1]) && r.deleted_at === null)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      return { rows: active.slice(0, 1), rowCount: active.length > 0 ? 1 : 0 }
    }
    if (norm.includes('FROM artifact_blobs WHERE tenant_id = $1 AND deleted_at IS NULL')) {
      const active = [...rows.values()]
        .filter((r) => r.tenant_id === String(params[0]) && r.deleted_at === null)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      return { rows: active, rowCount: active.length }
    }
    return { rows: [], rowCount: 0 }
  })
  return {
    pool,
    getActiveCount: () => [...rows.values()].filter((r) => r.deleted_at === null).length,
    getInsertCalls: () => insertCalls,
  }
}

function buildGatewayHost(
  commercial: NonNullable<HttpMiscHandlersHost['deps']['commercial']>,
  agentCwds: readonly string[] = [],
): HttpMiscHandlersHost {
  const noop = () => undefined
  const log = { info: noop, warn: noop, error: noop, debug: noop } as unknown as HttpMiscHandlersHost['log']
  const host: Partial<HttpMiscHandlersHost> = {
    deps: {
      config: {} as HttpMiscHandlersHost['deps']['config'],
      agentsConfig: {
        agents: agentCwds.map((cwd, i) => ({ id: `a${i}`, cwd })),
      } as unknown as HttpMiscHandlersHost['deps']['agentsConfig'],
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

async function withRealGatewayMediaServer<T>(
  host: HttpMiscHandlersHost,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/api/media/')) {
      void handleMediaGet.call(host, req, res, url.pathname.slice('/api/media/'.length))
      return
    }
    if (url.pathname === '/api/uploads' && req.method === 'POST') {
      void handleUpload.call(host, req, res)
      return
    }
    if (url.pathname.startsWith('/api/uploads/')) {
      void handleChunkedUpload.call(host, req, res, url)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : 0
  try {
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('R2-B1: Master rejects untrusted/symlinked media targets with zero out-of-root writes', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ocv5-r2-b1-'))
  try {
    const { pool } = createStatefulCasMetaPool()
    const { store: blobStore, rootDir } = createMasterArtifactBlobStore({
      openClaudeHome: tmpRoot,
      pgPool: pool,
    })
    const created = await blobStore.put({
      tenantId: 'c:42',
      kind: 'generated',
      bytes: Buffer.from('tenant-secret-artifact'),
      mimeType: 'text/plain',
      logicalName: 'secret.txt',
    })
    const victimDir = path.join(tmpRoot, 'victim-outside-root')
    await mkdir(victimDir, { recursive: true })

    await assert.rejects(
      () =>
        blobStore.materializeToPath({
          tenantId: 'c:42',
          blobId: created.blobId,
          targetDir: victimDir,
          trustedRootDir: path.join(rootDir, 'media-bridge'),
          relativePath: 'secret.txt',
        }),
      /BLOB_MATERIALIZE_UNTRUSTED_TARGET_DIR/,
    )

    const fakeVolumeRoot = path.join(tmpRoot, 'volumes', 'oc-v5-data-u42', '_data')
    await mkdir(fakeVolumeRoot, { recursive: true })
    await assert.rejects(
      () =>
        resolveMasterMediaDirsWithCasBridge(
          {
            kind: 'fail',
            reason: 'remote-host',
            uid: 42,
            hostUuid: '11111111-2222-3333-4444-555555555555',
            uploads: buildUserMediaHostDir(42, 'uploads'),
            generated: buildUserMediaHostDir(42, 'generated'),
            logCtx: { uid: 42 },
          },
          { blobStore, bridgeRootDir: fakeVolumeRoot },
        ),
      /BLOB_BRIDGE_UNTRUSTED_TARGET_DIR/,
    )

    const tenantBridgeDir = path.join(rootDir, 'media-bridge', 'u42')
    await mkdir(tenantBridgeDir, { recursive: true })
    await symlink(victimDir, path.join(tenantBridgeDir, 'generated'))
    await assert.rejects(
      () =>
        resolveMasterMediaDirsWithCasBridge(
          {
            kind: 'fail',
            reason: 'remote-host',
            uid: 42,
            hostUuid: '11111111-2222-3333-4444-555555555555',
            uploads: buildUserMediaHostDir(42, 'uploads'),
            generated: buildUserMediaHostDir(42, 'generated'),
            logCtx: { uid: 42 },
          },
          { blobStore },
        ),
      /BLOB_BRIDGE_SYMLINK_FORBIDDEN/,
    )
    assert.deepEqual(await readdir(victimDir), [])
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

function buildRemoteAndLocalTestHarness(opts: {
  localRoot: string
  blobStore: LocalCasArtifactBlobStore
  getActiveCas: () => LocalCasArtifactBlobStore | undefined
  remoteFiles: Map<string, Buffer>
  onNodeRead: () => void
  onRemoteQuota: () => void
  shouldFailRemotePut: () => boolean
}) {
  const placementPool = new pg.Pool({ max: 1, idleTimeoutMillis: 1 })
  Reflect.set(placementPool, 'query', async (_sql: string, values?: unknown[]) => {
    const uid = Number(values?.[0])
    if (uid === 42) {
      return { rows: [{ host_name: 'worker-eu-1', host_uuid: '11111111-2222-3333-4444-555555555555', container_id: '420' }] }
    }
    return { rows: [{ host_name: 'self', host_uuid: '00000000-0000-0000-0000-000000000000', container_id: '70' }] }
  })
  const docker: DockerLike = {
    getVolume: (name: string) => ({
      inspect: async () => {
        if (name.endsWith('-u7')) return { Mountpoint: opts.localRoot }
        throw Object.assign(new Error('missing volume'), { statusCode: 404 })
      },
    }),
  }
  const baseProdResolver = createCasAwareUserMediaResolver({
    pool: placementPool,
    docker,
    getBlobStore: opts.getActiveCas,
  })
  const prodResolver = async (userId: string) => {
    const resolved = await baseProdResolver(userId)
    if (resolved.kind === 'ok' && resolved.uid === 7) {
      return {
        kind: 'ok' as const,
        uid: 7,
        uploads: path.join(opts.localRoot, 'uploads'),
        generated: path.join(opts.localRoot, 'generated'),
      }
    }
    return resolved
  }
  const pushUpload = createCasAwareRemoteHostUploadPusher({
    getBlobStore: opts.getActiveCas,
    putToNodeAgent: async ({ remotePath, content }) => {
      if (opts.shouldFailRemotePut()) throw new Error('NODE_AGENT_UNREACHABLE')
      opts.remoteFiles.set(remotePath, Buffer.from(content))
    },
  })
  const pullRemote = createCasBridgedRemoteMediaPuller({
    getBlobStore: opts.getActiveCas,
    pullFromNodeAgent: async ({ remotePath }) => {
      opts.onNodeRead()
      return opts.remoteFiles.get(remotePath) ?? null
    },
  })
  return buildGatewayHost({
    handle: () => false,
    handleWsUpgrade: () => false,
    shutdown: async () => undefined,
    resolveUserMediaDirs: prodResolver,
    ensureContainerReady: async () => ({ ok: true }),
    pushRemoteHostUpload: pushUpload,
    pushRemoteHostUploadFromPath: async ({ hostUuid, remotePath, localPath }) => {
      await pushUpload({ hostUuid, remotePath, content: await readFile(localPath) })
    },
    pullRemoteHostMedia: pullRemote,
    openRemoteHostMedia: async ({ remotePath, dest, onReady }) => {
      opts.onNodeRead()
      const hit = opts.remoteFiles.get(remotePath)
      if (!hit) return 'missing'
      if (!onReady({ size: hit.length })) return 'rejected'
      dest.end(hit)
      return 'ok'
    },
    openCasMediaFallback: (args) => openMasterCasMediaFallback({ blobStore: opts.getActiveCas(), ...args }),
    sumRemoteUploadUsage: async ({ remoteDir }) => {
      opts.onRemoteQuota()
      const files: Array<{ name: string; size: number; mtimeMs: number }> = []
      let usedBytes = 0
      for (const [k, v] of opts.remoteFiles.entries()) {
        if (k.startsWith(`${remoteDir}/`)) {
          files.push({ name: path.posix.basename(k), size: v.length, mtimeMs: Date.now() })
          usedBytes += v.length
        }
      }
      return { usedBytes, truncated: false, files }
    },
    assembleRemoteHostUpload: async ({ remoteDir, uploadId, count, ext, expectedSize }) => {
      const parts: Buffer[] = []
      for (let i = 0; i < count; i += 1) {
        const partKey = `${remoteDir}/.part-${uploadId}-${i}`
        const p = opts.remoteFiles.get(partKey)
        assert.ok(p, `missing remote chunk ${partKey}`)
        parts.push(p)
        opts.remoteFiles.delete(partKey)
      }
      const full = Buffer.concat(parts)
      assert.equal(full.length, expectedSize)
      const sha256 = createHash('sha256').update(full).digest('hex')
      opts.remoteFiles.set(`${remoteDir}/${sha256}.${ext}`, full)
      const active = opts.getActiveCas()
      const parsed = parseUserVolumeMediaFilePath(`${remoteDir}/${sha256}.${ext}`)
      if (active && parsed) {
        await registerMasterMediaUploadInCas({
          blobStore: active,
          tenantId: `c:${parsed.uid}`,
          kind: 'upload',
          filename: parsed.filename,
          bytes: full,
        })
      }
      return { sha256, size: full.length }
    },
    deleteRemoteHostUpload: async ({ remotePath }) => {
      opts.remoteFiles.delete(remotePath)
    },
  }, [opts.localRoot])
}

test('R2-B2: Real Gateway GET, single upload, and chunked upload preserve remote host, Range, quota, and local resilience', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ocv5-r2-b2-'))
  try {
    let casMetaDown = false
    const casDb = createStatefulCasMetaPool({ throwOnSelect: () => casMetaDown })
    const { store: blobStore } = createMasterArtifactBlobStore({ openClaudeHome: tmpRoot, pgPool: casDb.pool })
    const remoteFiles = new Map<string, Buffer>()
    let nodeReadCount = 0
    let remoteQuotaChecks = 0
    let failRemotePut = false

    const remoteHistBytes = Buffer.from('0123456789-remote-historical-only')
    remoteFiles.set(`${buildUserMediaHostDir(42, 'generated')}/legacy-only.txt`, remoteHistBytes)
    const localRoot = path.join(tmpRoot, 'local-vol-u7')
    await mkdir(path.join(localRoot, 'uploads'), { recursive: true })
    await mkdir(path.join(localRoot, 'generated'), { recursive: true })
    await writeFile(path.join(localRoot, 'generated', 'healthy-local.txt'), 'local-ok-bytes')

    let activeCas: LocalCasArtifactBlobStore | undefined = undefined
    const gatewayHost = buildRemoteAndLocalTestHarness({
      localRoot,
      blobStore,
      getActiveCas: () => activeCas,
      remoteFiles,
      onNodeRead: () => { nodeReadCount += 1 },
      onRemoteQuota: () => { remoteQuotaChecks += 1 },
      shouldFailRemotePut: () => failRemotePut,
    })

    await withRealGatewayMediaServer(gatewayHost, async (baseUrl) => {
      nodeReadCount = 0
      const resOff = await fetch(`${baseUrl}/api/media/legacy-only.txt`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(resOff.status, 200)
      assert.equal(await resOff.text(), remoteHistBytes.toString('utf8'))
      assert.ok(nodeReadCount > 0)

      activeCas = blobStore
      nodeReadCount = 0
      const resOn = await fetch(`${baseUrl}/api/media/legacy-only.txt`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(resOn.status, 200)
      assert.equal(await resOn.text(), remoteHistBytes.toString('utf8'))
      assert.ok(nodeReadCount > 0)

      const resRange = await fetch(`${baseUrl}/api/media/legacy-only.txt`, {
        headers: { 'x-oc-user-id': 'c:42', Range: 'bytes=0-9' },
      })
      assert.equal(resRange.status, 206)
      assert.equal(await resRange.text(), '0123456789')

      const singlePayload = Buffer.from('remote-single-upload-bytes-v5')
      const singleSha = createHash('sha256').update(singlePayload).digest('hex')
      failRemotePut = true
      const failedUp = await fetch(`${baseUrl}/api/uploads`, {
        method: 'POST',
        headers: { 'x-oc-user-id': 'c:42', 'content-type': 'text/plain', 'x-filename': 'note.txt' },
        body: singlePayload,
      })
      assert.equal(failedUp.status, 502)
      assert.equal(casDb.getActiveCount(), 0)

      failRemotePut = false
      const okUp = await fetch(`${baseUrl}/api/uploads`, {
        method: 'POST',
        headers: { 'x-oc-user-id': 'c:42', 'content-type': 'text/plain', 'x-filename': 'note.txt' },
        body: singlePayload,
      })
      assert.equal(okUp.status, 200)
      assert.equal(((await okUp.json()) as { digest: string }).digest, singleSha)
      assert.ok(remoteQuotaChecks >= 2)
      assert.deepEqual(remoteFiles.get(`${buildUserMediaHostDir(42, 'uploads')}/${singleSha}.txt`), singlePayload)

      const chunkPayload = Buffer.from('chunked-remote-upload-complete-payload')
      const chunkSha = createHash('sha256').update(chunkPayload).digest('hex')
      const initRes = await fetch(`${baseUrl}/api/uploads/init`, {
        method: 'POST',
        headers: { 'x-oc-user-id': 'c:42', 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'bundle.txt', size: chunkPayload.length, mimeType: 'text/plain' }),
      })
      assert.equal(initRes.status, 200)
      const { uploadId } = (await initRes.json()) as { uploadId: string }
      const putChunkRes = await fetch(`${baseUrl}/api/uploads/${uploadId}/chunks/0`, {
        method: 'PUT',
        headers: { 'x-oc-user-id': 'c:42', 'content-length': String(chunkPayload.length) },
        body: chunkPayload,
      })
      assert.equal(putChunkRes.status, 204)
      const completeRes = await fetch(`${baseUrl}/api/uploads/${uploadId}/complete`, {
        method: 'POST',
        headers: { 'x-oc-user-id': 'c:42' },
      })
      assert.equal(completeRes.status, 200)
      assert.equal(((await completeRes.json()) as { digest: string }).digest, chunkSha)
      assert.deepEqual(remoteFiles.get(`${buildUserMediaHostDir(42, 'uploads')}/${chunkSha}.txt`), chunkPayload)

      casMetaDown = true
      const localRes = await fetch(`${baseUrl}/api/media/healthy-local.txt`, { headers: { 'x-oc-user-id': 'c:7' } })
      assert.equal(localRes.status, 200)
      assert.equal(await localRes.text(), 'local-ok-bytes')
    })
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})

test('R2-B3/B4: Zero read-side CAS metadata growth and immediate v1->v2 freshness + delete invalidation', async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'ocv5-r2-b34-'))
  try {
    const casDb = createStatefulCasMetaPool()
    const { store: blobStore } = createMasterArtifactBlobStore({ openClaudeHome: tmpRoot, pgPool: casDb.pool })
    const remoteLoc = {
      kind: 'fail' as const,
      reason: 'remote-host' as const,
      uid: 42,
      hostUuid: '11111111-2222-3333-4444-555555555555',
      uploads: buildUserMediaHostDir(42, 'uploads'),
      generated: buildUserMediaHostDir(42, 'generated'),
      logCtx: { uid: 42 },
    }
    const gatewayHost = buildRemoteAndLocalTestHarness({
      localRoot: path.join(tmpRoot, 'unused'),
      blobStore,
      getActiveCas: () => blobStore,
      remoteFiles: new Map(),
      onNodeRead: () => undefined,
      onRemoteQuota: () => undefined,
      shouldFailRemotePut: () => false,
    })

    await withRealGatewayMediaServer(gatewayHost, async (baseUrl) => {
      await registerMasterMediaUploadInCas({
        blobStore,
        tenantId: 'c:42',
        kind: 'upload',
        filename: 'chart.txt',
        bytes: Buffer.from('chart-immutable-bytes'),
      })
      assert.equal(casDb.getActiveCount(), 1)
      for (let i = 0; i < 4; i += 1) {
        await resolveMasterMediaDirsWithCasBridge(remoteLoc, { blobStore })
      }
      await Promise.all(
        Array.from({ length: 4 }, () => fetch(`${baseUrl}/api/media/chart.txt`, { headers: { 'x-oc-user-id': 'c:42' } })),
      )
      assert.equal(casDb.getInsertCalls(), 1)
      assert.equal(casDb.getActiveCount(), 1)

      const v1 = await blobStore.put({
        tenantId: 'c:42',
        kind: 'generated',
        bytes: Buffer.from('report-v1-stale'),
        mimeType: 'text/plain',
        logicalName: 'report.txt',
      })
      const v1Bridge = await resolveMasterMediaDirsWithCasBridge(remoteLoc, { blobStore })
      assert.equal(v1Bridge.kind, 'ok')
      assert.equal(await readFile(path.join(v1Bridge.generated, 'report.txt'), 'utf8'), 'report-v1-stale')

      const v2 = await blobStore.put({
        tenantId: 'c:42',
        kind: 'generated',
        bytes: Buffer.from('report-v2-fresh-updated'),
        mimeType: 'text/plain',
        logicalName: 'report.txt',
      })
      const v2Http = await fetch(`${baseUrl}/api/media/report.txt`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(v2Http.status, 200)
      assert.equal(await v2Http.text(), 'report-v2-fresh-updated')

      const v2Range = await fetch(`${baseUrl}/api/media/report.txt`, {
        headers: { 'x-oc-user-id': 'c:42', Range: 'bytes=7-14' },
      })
      assert.equal(v2Range.status, 206)
      assert.equal(await v2Range.text(), 'v2-fresh')

      const v2Bridge = await resolveMasterMediaDirsWithCasBridge(remoteLoc, { blobStore })
      assert.equal(v2Bridge.kind, 'ok')
      assert.equal(await readFile(path.join(v2Bridge.generated, 'report.txt'), 'utf8'), 'report-v2-fresh-updated')

      await blobStore.delete('c:42', v1.blobId)
      await blobStore.delete('c:42', v2.blobId)
      const afterDelHttp = await fetch(`${baseUrl}/api/media/report.txt`, { headers: { 'x-oc-user-id': 'c:42' } })
      assert.equal(afterDelHttp.status, 404)
      const afterDelBridge = await resolveMasterMediaDirsWithCasBridge(remoteLoc, { blobStore })
      assert.equal(afterDelBridge.kind, 'ok')
      await assert.rejects(() => readFile(path.join(afterDelBridge.generated, 'report.txt')), /ENOENT/)
    })
  } finally {
    await rm(tmpRoot, { recursive: true, force: true })
  }
})
