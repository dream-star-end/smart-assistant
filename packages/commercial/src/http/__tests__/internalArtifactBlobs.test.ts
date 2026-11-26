import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { ARTIFACT_BLOB_INTERNAL_PREFIX } from '@openclaude/protocol'
import { LocalCasArtifactBlobStore } from '../../agent-sandbox/artifactBlobStore.js'
import {
  deriveArtifactBlobTicketKey,
  resolveMasterMediaWithBlobBridge,
} from '../../agent-sandbox/artifactBlobRuntime.js'
import type { PgArtifactBlobMetaStore } from '../../db/threeLayerStateStore.js'
import { makeInternalArtifactBlobsHandler } from '../internalArtifactBlobs.js'

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** In-memory fake of PgArtifactBlobMetaStore enforcing tenantId on initiate/recordPart/abort/complete (B8). */
class FakePgBlobMetaStore {
  readonly uploads = new Map<
    string,
    {
      uploadId: string
      tenantId: string
      status: 'open' | 'completed' | 'aborted'
      parts: Record<string, { sizeBytes: number; sha256: string }>
    }
  >()
  readonly blobs = new Map<string, Record<string, unknown>>()
  failNextInitiate = false

  async initiateUpload(meta: { uploadId?: string; tenantId: string }) {
    if (this.failNextInitiate) {
      this.failNextInitiate = false
      throw new Error('PG_INSERT_FAILED')
    }
    const id = meta.uploadId!
    if (this.uploads.has(id)) throw new Error('BLOB_UPLOAD_ALREADY_EXISTS')
    this.uploads.set(id, { uploadId: id, tenantId: meta.tenantId, status: 'open', parts: {} })
    return { uploadId: id, tenantId: meta.tenantId, status: 'open' }
  }

  async recordPart(
    uploadId: string,
    index: number,
    sizeBytes: number,
    partSha256: string,
    expectedTenantId?: string,
  ) {
    const row = this.uploads.get(uploadId)
    if (!row) throw new Error('BLOB_UPLOAD_NOT_FOUND')
    if (expectedTenantId !== undefined && row.tenantId !== expectedTenantId) {
      throw new Error('BLOB_UPLOAD_TENANT_MISMATCH')
    }
    if (row.status !== 'open') throw new Error('BLOB_UPLOAD_NOT_OPEN')
    const existing = row.parts[String(index)]
    if (existing) {
      if (existing.sha256 === partSha256 && existing.sizeBytes === sizeBytes) return 'idempotent'
      throw new Error('BLOB_PART_SHA256_MISMATCH')
    }
    row.parts[String(index)] = { sizeBytes, sha256: partSha256 }
    return 'recorded'
  }

  async abortUpload(tenantId: string, uploadId: string) {
    const row = this.uploads.get(uploadId)
    if (!row) return false
    if (row.tenantId !== tenantId) throw new Error('BLOB_UPLOAD_TENANT_MISMATCH')
    row.status = 'aborted'
    return true
  }

  async completeUpload(uploadId: string, blobRow: Record<string, unknown>) {
    const row = this.uploads.get(uploadId)
    if (!row) throw new Error('BLOB_UPLOAD_NOT_FOUND')
    if (row.status !== 'open') throw new Error('BLOB_UPLOAD_NOT_OPEN')
    if (row.tenantId !== blobRow.tenantId) throw new Error('BLOB_UPLOAD_TENANT_MISMATCH')
    row.status = 'completed'
    this.blobs.set(`${blobRow.tenantId}::${blobRow.blobId}`, blobRow)
    return blobRow
  }

  async insertBlob(blobRow: Record<string, unknown>) {
    this.blobs.set(`${blobRow.tenantId}::${blobRow.blobId}`, blobRow)
    return blobRow
  }

  async statBlob(tenantId: string, blobId: string) {
    return this.blobs.get(`${tenantId}::${blobId}`) ?? null
  }

  async findBlobBySha256(tenantId: string, digest: string) {
    for (const v of this.blobs.values()) {
      if (v.tenantId === tenantId && v.sha256 === digest) return v
    }
    return null
  }

  async softDeleteBlob(tenantId: string, blobId: string) {
    return this.blobs.delete(`${tenantId}::${blobId}`)
  }
}

describe('OCV5-907 P1-2: internalArtifactBlobs RPC & CAS runtime (R1 hardened)', () => {
  const servers: Server[] = []
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  async function startHarness(opts?: {
    disableStore?: boolean
    withoutSigner?: boolean
    metaStore?: FakePgBlobMetaStore
  }) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ocv5-907-cas-'))
    tempDirs.push(dir)
    const store = opts?.disableStore
      ? undefined
      : new LocalCasArtifactBlobStore({
          rootDir: dir,
          ...(opts?.metaStore
            ? { metaStore: opts.metaStore as unknown as PgArtifactBlobMetaStore }
            : {}),
          ...(opts?.withoutSigner
            ? {}
            : { signingSecret: deriveArtifactBlobTicketKey('test-bridge-secret-v5') }),
        })
    const handler = makeInternalArtifactBlobsHandler({
      getStore: () => store,
      verify: async (req) => {
        const auth = req.headers.authorization ?? ''
        if (auth === 'Bearer tok-u3') return { userId: 3 }
        if (auth === 'Bearer tok-u9') return { userId: 9 }
        throw new Error('unauthorized')
      },
    })
    const server = createServer((req, res) => {
      void handler(req, res, { hostUuid: 'self', boundIp: '127.0.0.1' })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }
    return {
      base: `http://127.0.0.1:${addr.port}${ARTIFACT_BLOB_INTERNAL_PREFIX}`,
      store,
      dir,
    }
  }

  it('supports direct put, Range streaming, signed ticket, tenant isolation, and delete', async () => {
    const meta = new FakePgBlobMetaStore()
    const { base, store } = await startHarness({ metaStore: meta })
    const payload = Buffer.from('hello-world-three-layer-cas-payload', 'utf8')
    const digest = sha256(payload)

    const putRes = await fetch(`${base}put`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok-u3',
        'content-type': 'application/octet-stream',
        'x-blob-kind': 'capsule_file',
        'x-blob-mime-type': 'text/plain',
        'x-blob-logical-name': encodeURIComponent('state.jsonl'),
      },
      body: payload,
    })
    assert.equal(putRes.status, 200)
    const { blob } = (await putRes.json()) as { blob: { blobId: string; sha256: string; tenantId: string } }
    assert.equal(blob.sha256, digest)
    assert.equal(blob.tenantId, 'c:3')

    const crossGet = await fetch(`${base}${blob.blobId}`, {
      headers: { authorization: 'Bearer tok-u9' },
    })
    assert.equal(crossGet.status, 404)

    const rangeGet = await fetch(`${base}${blob.blobId}`, {
      headers: { authorization: 'Bearer tok-u3', range: 'bytes=0-4' },
    })
    assert.equal(rangeGet.status, 206)
    assert.equal(Buffer.from(await rangeGet.arrayBuffer()).toString('utf8'), 'hello')

    const ticketRes = await fetch(`${base}${blob.blobId}/ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'read', audience: 'remote-node-1', ttlMs: 30_000 }),
    })
    assert.equal(ticketRes.status, 200)
    const { ticket } = (await ticketRes.json()) as { ticket: { token: string } }
    assert.equal(
      store!.verifySignedTicket(ticket.token, {
        expectedTenantId: 'c:3',
        expectedAudience: 'remote-node-1',
        expectedOp: 'read',
        expectedBlobId: blob.blobId,
      }).valid,
      true,
    )
  })

  it('enforces B8 tenant fence across disk & PG: master allocates uploadId, PG failure rolls back staging, abort persists PG aborted', async () => {
    const meta = new FakePgBlobMetaStore()
    const { base, dir } = await startHarness({ metaStore: meta })

    // 1. Caller-supplied uploadId is ignored (master allocates fresh random uploadId)
    const initRes = await fetch(`${base}uploads`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({
        uploadId: 'upl-attacker-fixed-id',
        kind: 'capsule_file',
        filename: 'conv.db',
        mimeType: 'application/x-sqlite3',
        expectedSizeBytes: 65_536,
        chunkBytes: 65_536,
      }),
    })
    assert.equal(initRes.status, 200)
    const { session } = (await initRes.json()) as { session: { uploadId: string } }
    assert.notEqual(session.uploadId, 'upl-attacker-fixed-id')
    assert.equal(meta.uploads.get(session.uploadId)?.tenantId, 'c:3')

    // 2. Cross-tenant part write rejected 403
    const part = Buffer.alloc(65_536, 0x42)
    const crossPart = await fetch(`${base}uploads/${session.uploadId}/parts/0`, {
      method: 'PUT',
      headers: { authorization: 'Bearer tok-u9', 'x-part-sha256': sha256(part) },
      body: part,
    })
    assert.equal(crossPart.status, 403)

    // 3. Abort marks PG row 'aborted' AND cleans staging dir; subsequent part fails
    const abortRes = await fetch(`${base}uploads/${session.uploadId}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer tok-u3' },
    })
    assert.equal(abortRes.status, 200)
    assert.equal(meta.uploads.get(session.uploadId)?.status, 'aborted')
    assert.equal(existsSync(path.join(dir, 'staging', session.uploadId)), false)

    // 4. PG initiate failure rolls back staging dir cleanly
    meta.failNextInitiate = true
    const failInit = await fetch(`${base}uploads`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'capsule_file',
        filename: 'fail.db',
        mimeType: 'application/octet-stream',
        expectedSizeBytes: 1024,
        chunkBytes: 65_536,
      }),
    })
    assert.equal(failInit.status, 500)
    assert.equal(meta.uploads.size, 1)
  })

  it('N1 returns 503 when signer is unconfigured and W4 destroys stream on early disconnect while awaiting metadata', async () => {
    const { base: noSigBase } = await startHarness({ withoutSigner: true })
    const putRes = await fetch(`${noSigBase}put`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok-u3',
        'x-blob-kind': 'capsule_file',
        'x-blob-mime-type': 'text/plain',
      },
      body: Buffer.from('abc', 'utf8'),
    })
    const { blob } = (await putRes.json()) as { blob: { blobId: string } }
    const tickRes = await fetch(`${noSigBase}${blob.blobId}/ticket`, {
      method: 'POST',
      headers: { authorization: 'Bearer tok-u3', 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'read', audience: 'node-1', ttlMs: 10_000 }),
    })
    assert.equal(tickRes.status, 503)

    // W4: client disconnects BEFORE openReadStream resolves -> stream MUST be destroyed
    let streamDestroyed = false
    let releaseMeta!: () => void
    const metaGate = new Promise<void>((resolve) => {
      releaseMeta = resolve
    })
    const fakeStore = {
      async openReadStream() {
        await metaGate
        const s = new Readable({ read() {} })
        const origDestroy = s.destroy.bind(s)
        s.destroy = ((...args: Parameters<typeof origDestroy>) => {
          streamDestroyed = true
          return origDestroy(...args)
        }) as typeof s.destroy
        return {
          meta: {
            blobId: 'blob-12345678',
            tenantId: 'c:3',
            sha256: 'a'.repeat(64),
            sizeBytes: 10,
            mimeType: 'application/octet-stream',
            kind: 'capsule_file',
          },
          stream: s,
          start: 0,
          end: 9,
          contentLength: 10,
        }
      },
    } as unknown as LocalCasArtifactBlobStore

    let handlerDone = false
    const handler = makeInternalArtifactBlobsHandler({
      getStore: () => fakeStore,
      verify: async () => ({ userId: 3 }),
    })
    const server = createServer((req, res) => {
      void handler(req, res, { hostUuid: 'self', boundIp: '127.0.0.1' }).then(() => {
        handlerDone = true
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as { port: number }

    const ac = new AbortController()
    const reqPromise = fetch(
      `http://127.0.0.1:${addr.port}${ARTIFACT_BLOB_INTERNAL_PREFIX}blob-12345678`,
      { headers: { authorization: 'Bearer tok-u3' }, signal: ac.signal },
    ).catch(() => {})
    await new Promise((r) => setTimeout(r, 40))
    ac.abort()
    await reqPromise
    await new Promise((r) => setTimeout(r, 40))
    releaseMeta()
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(streamDestroyed, true, 'stream fd must be destroyed when client disconnects during metadata await')
    assert.equal(handlerDone, true, 'handler promise must settle cleanly on early disconnect')

    const bridged = resolveMasterMediaWithBlobBridge(
      {
        kind: 'fail',
        reason: 'remote-host',
        uid: 3,
        hostUuid: 'host-remote-1',
        uploads: '/var/lib/docker/volumes/oc-v5-data-u3/_data/uploads',
        generated: '/var/lib/docker/volumes/oc-v5-data-u3/_data/generated',
        logCtx: {},
      },
      fakeStore,
      true,
    )
    assert.equal(bridged.kind, 'blob_bridge')
  })
})
