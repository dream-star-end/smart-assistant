import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import {
  LocalCasArtifactBlobStore,
  resolveMediaOrBlobBridge,
} from '../artifactBlobStore.js'
import type { UserMediaLocation } from '../userMedia.js'

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

const tempRoots: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

after(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('OCV5-890 Wave 1B: LocalCasArtifactBlobStore', () => {
  it('supports single-shot put, stat, getBytes, ranged openReadStream, and tenant isolation', async () => {
    const rootDir = makeTempDir('oc-cas-put-')
    const store = new LocalCasArtifactBlobStore({
      rootDir,
      signingSecret: 'test-signing-secret-at-least-16-bytes',
    })

    const payload = Buffer.from('hello three-layer artifact blob store!', 'utf8')
    const ref = await store.put({
      tenantId: 'c:101',
      kind: 'upload',
      mimeType: 'text/plain',
      bytes: payload,
      logicalName: 'greeting.txt',
    })

    assert.equal(ref.sha256, sha256Bytes(payload))
    assert.equal(ref.sizeBytes, payload.byteLength)
    assert.equal(ref.storageBackend, 'local_cas')

    assert.deepEqual(await store.getMetadata('c:101', ref.blobId), ref)
    assert.equal(await store.getMetadata('c:202', ref.blobId), null)
    assert.equal((await store.headBySha256('c:101', ref.sha256))?.blobId, ref.blobId)

    const bytes = await store.getBytes('c:101', ref.blobId)
    assert.ok(bytes)
    assert.deepEqual(Buffer.from(bytes), payload)
    assert.equal(await store.getBytes('c:202', ref.blobId), null)

    const rangeHandle = await store.openReadStream('c:101', ref.blobId, {
      range: { start: 6, end: 16 },
    })
    assert.ok(rangeHandle)
    assert.equal(rangeHandle.contentLength, 11)
    const slice = await readStreamToBuffer(rangeHandle.stream)
    assert.equal(slice.toString('utf8'), 'three-layer')

    await assert.rejects(
      () => store.openReadStream('c:101', ref.blobId, { range: { start: 20, end: 10 } }),
      /BLOB_RANGE_INVALID/,
    )
  })

  it('handles out-of-order multipart uploads, idempotent retries, corrupted part rejection, and whole sha256 check', async () => {
    const rootDir = makeTempDir('oc-cas-multipart-')
    const store = new LocalCasArtifactBlobStore({
      rootDir,
      defaultChunkBytes: 65_536,
    })

    const part0 = Buffer.alloc(65_536, 0x41)
    const part1 = Buffer.alloc(65_536, 0x42)
    const part2 = Buffer.from('final-tail-bytes-for-part-2', 'utf8')
    const fullPayload = Buffer.concat([part0, part1, part2])
    const expectedWholeSha = sha256Bytes(fullPayload)

    const session = await store.initiateChunkedUpload({
      tenantId: 'c:42',
      kind: 'research',
      filename: 'bundle.bin',
      mimeType: 'application/octet-stream',
      expectedSizeBytes: fullPayload.byteLength,
      chunkBytes: 65_536,
    })
    assert.equal(session.chunkCount, 3)

    // Corrupted part rejected.
    await assert.rejects(
      () =>
        store.putPart({
          uploadId: session.uploadId,
          tenantId: 'c:42',
          index: 0,
          bytes: part0,
          sha256: sha256Bytes(part1),
        }),
      /BLOB_PART_SHA256_MISMATCH/,
    )

    // Out-of-order upload: part 2 -> part 0 -> duplicate part 0 -> part 1.
    const r2 = await store.putPart({
      uploadId: session.uploadId,
      tenantId: 'c:42',
      index: 2,
      bytes: part2,
      sha256: sha256Bytes(part2),
    })
    assert.equal(r2.status, 'recorded')

    const r0 = await store.putPart({
      uploadId: session.uploadId,
      tenantId: 'c:42',
      index: 0,
      bytes: part0,
      sha256: sha256Bytes(part0),
    })
    assert.equal(r0.status, 'recorded')

    // Retry identical part 0 -> idempotent.
    const r0Dup = await store.putPart({
      uploadId: session.uploadId,
      tenantId: 'c:42',
      index: 0,
      bytes: part0,
      sha256: sha256Bytes(part0),
    })
    assert.equal(r0Dup.status, 'idempotent')

    // Attempt to overwrite part 0 with different bytes -> rejected.
    await assert.rejects(
      () =>
        store.putPart({
          uploadId: session.uploadId,
          tenantId: 'c:42',
          index: 0,
          bytes: part1,
          sha256: sha256Bytes(part1),
        }),
      /BLOB_PART_SHA256_MISMATCH/,
    )

    // Complete before part 1 arrives -> rejected.
    await assert.rejects(
      () => store.completeUpload({ uploadId: session.uploadId, tenantId: 'c:42' }),
      /BLOB_UPLOAD_INCOMPLETE_PARTS/,
    )

    await store.putPart({
      uploadId: session.uploadId,
      tenantId: 'c:42',
      index: 1,
      bytes: part1,
      sha256: sha256Bytes(part1),
    })

    // Wrong expectedSha256 rejected without destroying parts.
    await assert.rejects(
      () =>
        store.completeUpload({
          uploadId: session.uploadId,
          tenantId: 'c:42',
          expectedSha256: '0'.repeat(64),
        }),
      /BLOB_COMPLETE_SHA256_MISMATCH/,
    )

    // Valid completion produces CAS object and cleans staging dir.
    const blob = await store.completeUpload({
      uploadId: session.uploadId,
      tenantId: 'c:42',
      expectedSha256: expectedWholeSha,
    })
    assert.equal(blob.sha256, expectedWholeSha)
    assert.equal(blob.sizeBytes, fullPayload.byteLength)
    assert.equal(existsSync(path.join(rootDir, 'staging', session.uploadId)), false)

    const readBack = await store.getBytes('c:42', blob.blobId)
    assert.ok(readBack)
    assert.deepEqual(Buffer.from(readBack), fullPayload)
  })

  it('defaults materializeToPath to safe copy isolating CAS from in-place edits, restricts hardlinks to explicit read-only opt-in, blocks traversal/symlinks, and detects CAS corruption', async () => {
    const rootDir = makeTempDir('oc-cas-mat-')
    const targetDir = makeTempDir('oc-cas-target-')
    const store = new LocalCasArtifactBlobStore({ rootDir })

    const content = Buffer.from('materialized-artifact-content', 'utf8')
    const blob = await store.put({
      tenantId: 'c:55',
      kind: 'generated',
      mimeType: 'text/plain',
      bytes: content,
    })

    const casObjPath = path.join(rootDir, 'objects', blob.sha256.slice(0, 2), blob.sha256)
    assert.equal(statSync(casObjPath).mode & 0o222, 0, 'CAS object itself must be stored read-only')

    // Default materialization MUST copy (independent inode), so in-place workspace edits never corrupt CAS.
    const defaultMat = await store.materializeToPath({
      tenantId: 'c:55',
      blobId: blob.blobId,
      targetDir,
      relativePath: 'nested/out-default.txt',
    })
    assert.equal(defaultMat.strategy, 'copy')
    assert.equal(defaultMat.sha256, blob.sha256)
    assert.notEqual(statSync(defaultMat.targetPath).ino, statSync(casObjPath).ino)
    assert.deepEqual(readFileSync(defaultMat.targetPath), content)

    // Mutate the materialized workspace file in place!
    writeFileSync(defaultMat.targetPath, Buffer.from('edited-in-workspace-by-user', 'utf8'))
    assert.equal(readFileSync(defaultMat.targetPath, 'utf8'), 'edited-in-workspace-by-user')

    // Original CAS blob AND a second materialization MUST still return intact original bytes & SHA-256!
    const casBytesAfterEdit = await store.getBytes('c:55', blob.blobId)
    assert.ok(casBytesAfterEdit)
    assert.deepEqual(Buffer.from(casBytesAfterEdit), content)
    assert.equal(sha256Bytes(casBytesAfterEdit), blob.sha256)

    const secondMat = await store.materializeToPath({
      tenantId: 'c:55',
      blobId: blob.blobId,
      targetDir,
      relativePath: 'nested/out-second.txt',
    })
    assert.equal(secondMat.strategy, 'copy')
    assert.equal(secondMat.sha256, blob.sha256)
    assert.deepEqual(readFileSync(secondMat.targetPath), content)

    // Even with allowHardlink=true, omitting mode or passing a writable mode (0o644) MUST still copy!
    const writableOptIn = await store.materializeToPath({
      tenantId: 'c:55',
      blobId: blob.blobId,
      targetDir,
      relativePath: 'nested/out-writable-optin.txt',
      allowHardlink: true,
      mode: 0o644,
    })
    assert.equal(writableOptIn.strategy, 'copy')
    assert.notEqual(statSync(writableOptIn.targetPath).ino, statSync(casObjPath).ino)

    const omittedModeOptIn = await store.materializeToPath({
      tenantId: 'c:55',
      blobId: blob.blobId,
      targetDir,
      relativePath: 'nested/out-nomode-optin.txt',
      allowHardlink: true,
    })
    assert.equal(omittedModeOptIn.strategy, 'copy')
    assert.notEqual(statSync(omittedModeOptIn.targetPath).ino, statSync(casObjPath).ino)

    // ONLY explicit { allowHardlink: true, mode: 0o444 } shares the read-only CAS inode!
    const linked = await store.materializeToPath({
      tenantId: 'c:55',
      blobId: blob.blobId,
      targetDir,
      relativePath: 'nested/out-link-ro.txt',
      allowHardlink: true,
      mode: 0o444,
    })
    assert.equal(linked.strategy, 'hardlink')
    assert.equal(linked.sha256, blob.sha256)
    assert.equal(statSync(linked.targetPath).ino, statSync(casObjPath).ino)
    assert.equal(statSync(linked.targetPath).mode & 0o222, 0)
    assert.deepEqual(readFileSync(linked.targetPath), content)

    // Existing file without overwrite=true rejected.
    await assert.rejects(
      () =>
        store.materializeToPath({
          tenantId: 'c:55',
          blobId: blob.blobId,
          targetDir,
          relativePath: 'nested/out-link-ro.txt',
        }),
      /BLOB_MATERIALIZE_TARGET_EXISTS/,
    )

    // Copy mode creates an independent inode with custom fileMode.
    const copied = await store.materializeToPath({
      tenantId: 'c:55',
      blobId: blob.blobId,
      targetDir,
      relativePath: 'nested/out-copy.txt',
      mode: 'copy',
      fileMode: 0o640,
    })
    assert.equal(copied.strategy, 'copy')
    assert.notEqual(statSync(copied.targetPath).ino, statSync(casObjPath).ino)
    assert.deepEqual(readFileSync(copied.targetPath), content)

    // Path traversal rejected.
    await assert.rejects(
      () =>
        store.materializeToPath({
          tenantId: 'c:55',
          blobId: blob.blobId,
          targetDir,
          relativePath: '../escape.txt',
        }),
      /BLOB_MATERIALIZE_PATH_ESCAPE/,
    )

    // Symlink intermediate dir rejected.
    const outsideDir = makeTempDir('oc-cas-outside-')
    symlinkSync(outsideDir, path.join(targetDir, 'symdir'))
    await assert.rejects(
      () =>
        store.materializeToPath({
          tenantId: 'c:55',
          blobId: blob.blobId,
          targetDir,
          relativePath: 'symdir/pwn.txt',
        }),
      /BLOB_MATERIALIZE_SYMLINK_FORBIDDEN/,
    )

    // Corrupt CAS object on disk -> integrity check fails closed.
    chmodSync(casObjPath, 0o600)
    writeFileSync(casObjPath, Buffer.from('corrupted-bytes', 'utf8'))
    await assert.rejects(
      () =>
        store.materializeToPath({
          tenantId: 'c:55',
          blobId: blob.blobId,
          targetDir,
          relativePath: 'fresh.txt',
          mode: 'copy',
        }),
      /BLOB_CONTENT_INTEGRITY_MISMATCH/,
    )
  })

  it('supports 0-byte chunked upload and real LocalCas + UniversalEngineStateCapsuleStore cross-node stateRootA -> stateRootB round-trip (B09)', async () => {
    const casRoot = makeTempDir('oc-cas-b09-cas-')
    const stateRootA = makeTempDir('oc-cas-b09-state-a-')
    const stateRootB = makeTempDir('oc-cas-b09-state-b-')
    const sourceRoot = makeTempDir('oc-cas-b09-src-')
    const targetRoot = makeTempDir('oc-cas-b09-dst-')

    const casStore = new LocalCasArtifactBlobStore({
      rootDir: casRoot,
      defaultChunkBytes: 65_536,
    })

    // 1. Direct 0-byte chunked upload verification on LocalCasArtifactBlobStore
    const emptyBytes = new Uint8Array(0)
    const emptySha = sha256Bytes(emptyBytes)
    const emptySession = await casStore.initiateChunkedUpload({
      tenantId: 'c:90',
      kind: 'capsule_file',
      filename: 'empty-marker.jsonl',
      mimeType: 'application/x-ndjson',
      expectedSizeBytes: 0,
      chunkBytes: 65_536,
    })
    assert.equal(emptySession.chunkCount, 1)
    const emptyPartRes = await casStore.putPart({
      uploadId: emptySession.uploadId,
      tenantId: 'c:90',
      index: 0,
      bytes: emptyBytes,
      sha256: emptySha,
    })
    assert.equal(emptyPartRes.status, 'recorded')
    const emptyBlob = await casStore.completeUpload({
      uploadId: emptySession.uploadId,
      tenantId: 'c:90',
      expectedSha256: emptySha,
    })
    assert.equal(emptyBlob.sizeBytes, 0)
    assert.equal(emptyBlob.sha256, emptySha)

    // 2. Real UniversalEngineStateCapsuleStore wired directly to real LocalCasArtifactBlobStore!
    // Use runtime URL import so packages/commercial tsconfig rootDir remains untouched.
    const capsuleModUrl = new URL(
      '../../../../gateway/src/storageSeam/engineStateCapsuleStore.js',
      import.meta.url,
    ).href
    const capsuleMod = (await import(capsuleModUrl)) as {
      UniversalEngineStateCapsuleStore: new (opts: {
        blobStore: LocalCasArtifactBlobStore
        stateRoot: string
        defaultChunkSizeBytes?: number
      }) => {
        exportCapsule: (req: Record<string, unknown>) => Promise<{
          manifest: {
            capsuleId: string
            files: Array<{ logicalPath: string; sha256: string; sizeBytes: number; blobId?: string }>
          }
        }>
        importCapsule: (req: Record<string, unknown>) => Promise<{
          status: string
          manifest?: { capsuleId: string }
        }>
      }
    }

    // Track every putPart call to verify 0-based index & exact per-part sha256!
    const recordedParts: Array<{ uploadId: string; index: number; sizeBytes: number; sha256: string }> = []
    const origPutPart = casStore.putPart.bind(casStore)
    casStore.putPart = async (input) => {
      const res = await origPutPart(input)
      recordedParts.push({
        uploadId: input.uploadId,
        index: input.index,
        sizeBytes: input.bytes.byteLength,
        sha256: input.sha256,
      })
      return res
    }

    // Populate sourceRoot with BOTH a multi-part non-empty file (> 140 KiB -> 3 parts at 64 KiB) AND a 0-byte empty file!
    const sessionsDir = path.join(sourceRoot, 'sessions', '2026', '11', '25')
    mkdirSync(sessionsDir, { recursive: true })
    const multiPartRel = 'sessions/2026/11/25/rollout-multipart.jsonl'
    const emptyRel = 'sessions/2026/11/25/rollout-empty.jsonl'
    const multiPartContent = Buffer.concat([
      Buffer.from(`${'{"line":"chunk0"}\n'.repeat(4000)}`, 'utf8'),
      Buffer.from(`${'{"line":"chunk1"}\n'.repeat(4000)}`, 'utf8'),
      Buffer.from('{"line":"tail"}\n', 'utf8'),
    ])
    assert.ok(multiPartContent.byteLength > 65_536 * 2, 'must span >= 3 chunks of 64 KiB')
    writeFileSync(path.join(sourceRoot, multiPartRel), multiPartContent)
    writeFileSync(path.join(sourceRoot, emptyRel), Buffer.alloc(0))

    const storeA = new capsuleMod.UniversalEngineStateCapsuleStore({
      blobStore: casStore,
      stateRoot: stateRootA,
      defaultChunkSizeBytes: 65_536,
    })

    const exported = await storeA.exportCapsule({
      tenantId: 'c:90',
      sessionKey: 'sess:cas-e2e:1',
      engine: 'codex',
      engineVersion: '1.3.0',
      placementEpoch: 5,
      nativeSessionId: '99999999-1111-4222-8333-444444444444',
      sourceRoot,
      chunkSizeBytes: 65_536,
    })

    assert.equal(exported.manifest.files.length, 2)
    // Verify 0-based part indices and per-part SHA-256s were sent for multi-part + 0-byte files!
    const byUpload = new Map<string, typeof recordedParts>()
    for (const p of recordedParts) {
      const list = byUpload.get(p.uploadId) ?? []
      list.push(p)
      byUpload.set(p.uploadId, list)
    }
    assert.equal(byUpload.size, 2, 'both capsule files must use chunked upload')
    const partCounts = [...byUpload.values()].map((list) => {
      assert.deepEqual(
        list.map((x) => x.index),
        list.map((_, i) => i),
        'part indices must be strictly 0-based contiguous',
      )
      for (const item of list) {
        assert.match(item.sha256, /^[0-9a-f]{64}$/)
      }
      return list.length
    })
    assert.ok(partCounts.includes(1), '0-byte file must upload 1 empty part at index=0')
    assert.ok(
      partCounts.some((c) => c >= 3),
      'non-empty file must upload >= 3 parts at 64 KiB chunk size',
    )

    // Node B has a completely fresh, empty stateRootB (zero local index shared with stateRootA)!
    const storeB = new capsuleMod.UniversalEngineStateCapsuleStore({
      blobStore: casStore,
      stateRoot: stateRootB,
    })
    const imported = await storeB.importCapsule({
      tenantId: 'c:90',
      capsuleId: exported.manifest.capsuleId,
      manifest: exported.manifest,
      targetRoot,
      expectedSessionKey: 'sess:cas-e2e:1',
      expectedEngine: 'codex',
      expectedNativeSessionId: '99999999-1111-4222-8333-444444444444',
      targetEngineVersion: '1.9.0',
    })
    assert.equal(imported.status, 'imported')

    const restoredMulti = readFileSync(path.join(targetRoot, multiPartRel))
    const restoredEmpty = readFileSync(path.join(targetRoot, emptyRel))
    assert.deepEqual(restoredMulti, multiPartContent)
    assert.equal(sha256Bytes(restoredMulti), sha256Bytes(multiPartContent))
    assert.equal(restoredEmpty.byteLength, 0)
    assert.equal(sha256Bytes(restoredEmpty), emptySha)
  })

  it('issues and verifies short-lived signed tickets and rejects tampered, expired, and cross-tenant tokens', async () => {
    let nowMs = Date.parse('2026-11-25T12:00:00.000Z')
    const rootDir = makeTempDir('oc-cas-ticket-')
    const store = new LocalCasArtifactBlobStore({
      rootDir,
      signingSecret: 'super-secret-ticket-key-for-tests-1234',
      now: () => nowMs,
    })

    const issued = store.issueSignedTicket({
      blobId: 'blob-12345678',
      tenantId: 'c:42',
      audience: 'remote-node-7',
      op: 'read',
      ttlMs: 30_000,
    })

    // Valid verification.
    const ok = store.verifySignedTicket(issued.token, {
      expectedTenantId: 'c:42',
      expectedAudience: 'remote-node-7',
      expectedOp: 'read',
      expectedBlobId: 'blob-12345678',
    })
    if (!ok.valid) assert.fail('expected valid signed ticket')
    assert.equal(ok.claims.blobId, 'blob-12345678')

    // Tampered token rejected.
    const [enc, sig] = issued.token.split('.')
    const tamperedSig = `${sig!.slice(0, -1)}${sig!.endsWith('a') ? 'b' : 'a'}`
    const badSig = store.verifySignedTicket(`${enc}.${tamperedSig}`, {
      expectedTenantId: 'c:42',
      expectedAudience: 'remote-node-7',
      expectedOp: 'read',
    })
    assert.deepEqual(badSig, { valid: false, reason: 'invalid_signature' })

    // Cross-tenant rejected.
    assert.deepEqual(
      store.verifySignedTicket(issued.token, {
        expectedTenantId: 'c:99',
        expectedAudience: 'remote-node-7',
        expectedOp: 'read',
      }),
      { valid: false, reason: 'tenant_mismatch' },
    )

    // Wrong audience rejected.
    assert.deepEqual(
      store.verifySignedTicket(issued.token, {
        expectedTenantId: 'c:42',
        expectedAudience: 'remote-node-8',
        expectedOp: 'read',
      }),
      { valid: false, reason: 'audience_mismatch' },
    )

    // Wrong op rejected.
    assert.deepEqual(
      store.verifySignedTicket(issued.token, {
        expectedTenantId: 'c:42',
        expectedAudience: 'remote-node-7',
        expectedOp: 'materialize',
      }),
      { valid: false, reason: 'op_mismatch' },
    )

    // Expired ticket rejected.
    nowMs += 31_000
    assert.deepEqual(
      store.verifySignedTicket(issued.token, {
        expectedTenantId: 'c:42',
        expectedAudience: 'remote-node-7',
        expectedOp: 'read',
      }),
      { valid: false, reason: 'expired' },
    )

    // Store without signer fails closed.
    const unsignedStore = new LocalCasArtifactBlobStore({
      rootDir: makeTempDir('oc-cas-unsigned-'),
    })
    assert.throws(
      () =>
        unsignedStore.issueSignedTicket({
          blobId: 'blob-12345678',
          tenantId: 'c:42',
          audience: 'node-1',
          op: 'read',
          ttlMs: 1000,
        }),
      /BLOB_TICKET_SIGNER_NOT_CONFIGURED/,
    )
  })

  it('enforces fail-closed GC and preserves shared CAS objects still referenced by live blobs', async () => {
    let nowMs = Date.parse('2026-11-25T10:00:00.000Z')
    const rootDir = makeTempDir('oc-cas-gc-')
    const store = new LocalCasArtifactBlobStore({
      rootDir,
      now: () => nowMs,
    })

    const sharedBytes = Buffer.from('deduped-content', 'utf8')
    const uniqueBytes = Buffer.from('orphan-content', 'utf8')

    const liveShared = await store.put({
      tenantId: 'c:1',
      kind: 'upload',
      mimeType: 'text/plain',
      bytes: sharedBytes,
    })
    const deadShared = await store.put({
      tenantId: 'c:1',
      kind: 'upload',
      mimeType: 'text/plain',
      bytes: sharedBytes,
    })
    const deadUnique = await store.put({
      tenantId: 'c:1',
      kind: 'upload',
      mimeType: 'text/plain',
      bytes: uniqueBytes,
    })

    nowMs += 2 * 60 * 60 * 1000

    // Incomplete reference proof MUST throw.
    await assert.rejects(
      () =>
        store.gcUnreferenced({
          completeReferenceProof: false,
          liveBlobIds: [liveShared.blobId],
          olderThanMs: 60 * 60 * 1000,
        }),
      /BLOB_GC_INCOMPLETE_REFERENCE_PROOF/,
    )

    const gcRes = await store.gcUnreferenced({
      completeReferenceProof: true,
      liveBlobIds: new Set([liveShared.blobId]),
      olderThanMs: 60 * 60 * 1000,
    })
    assert.equal(gcRes.deletedBlobIds.length, 2)
    assert.ok(gcRes.deletedBlobIds.includes(deadShared.blobId))
    assert.ok(gcRes.deletedBlobIds.includes(deadUnique.blobId))
    // Only unique object removed; shared object remains because liveShared still references it!
    assert.deepEqual(gcRes.removedObjectSha256s, [deadUnique.sha256])

    assert.ok(await store.getBytes('c:1', liveShared.blobId))
    assert.equal(await store.stat('c:1', deadShared.blobId), null)
    assert.equal(await store.stat('c:1', deadUnique.blobId), null)
  })

  it('bridges userMedia.ts remote-host results to ArtifactBlobStore while keeping local direct and hard failures fail-closed', () => {
    const localOk: UserMediaLocation = {
      kind: 'ok',
      uid: 42,
      uploads: '/var/lib/docker/volumes/oc-v5-data-u42/_data/uploads',
      generated: '/var/lib/docker/volumes/oc-v5-data-u42/_data/generated',
    }
    assert.deepEqual(resolveMediaOrBlobBridge(localOk), {
      kind: 'local_direct',
      uid: 42,
      uploadsDir: localOk.uploads,
      generatedDir: localOk.generated,
    })

    const remoteHost: UserMediaLocation = {
      kind: 'fail',
      reason: 'remote-host',
      uid: 42,
      hostUuid: 'host-uuid-9',
      uploads: '/var/lib/docker/volumes/oc-v5-data-u42/_data/uploads',
      generated: '/var/lib/docker/volumes/oc-v5-data-u42/_data/generated',
      logCtx: { uid: 42, host: 'worker-9' },
    }
    assert.deepEqual(resolveMediaOrBlobBridge(remoteHost), {
      kind: 'blob_bridge',
      uid: 42,
      hostUuid: 'host-uuid-9',
      uploadsDir: remoteHost.uploads,
      generatedDir: remoteHost.generated,
      tenantId: 'c:42',
    })

    assert.deepEqual(resolveMediaOrBlobBridge(remoteHost, { enableBlobBridge: false }), {
      kind: 'fail',
      reason: 'remote-host',
      logCtx: remoteHost.logCtx,
    })

    const notReady: UserMediaLocation = {
      kind: 'fail',
      reason: 'not-ready',
      logCtx: { uid: 42 },
    }
    assert.deepEqual(resolveMediaOrBlobBridge(notReady), {
      kind: 'fail',
      reason: 'not-ready',
      logCtx: { uid: 42 },
    })
  })
})
