import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  computeEngineStateCapsuleId,
  type EngineStateCapsuleManifest,
  type EngineStateCapsuleManifestBody,
} from '@openclaude/protocol/storage-seam'
import {
  InMemoryArtifactBlobStore,
  UniversalEngineStateCapsuleStore,
  hasPendingRestoreMarker,
} from '../engineStateCapsuleStore.js'
import { EngineCapsuleRuntime } from '../../turnCapsuleRuntime.js'

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

describe('OCV5-913 T2 B1: per-session capsule file ownership & no cross-session clobbering', () => {
  const tempDirs: string[] = []
  const makeDir = (label: string) => {
    const d = mkdtempSync(join(tmpdir(), `ocv5-913-b1-${label}-`))
    tempDirs.push(d)
    return d
  }

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('exports ONLY session A files from a shared engine root and restores A while keeping sibling session B newer bytes intact', async () => {
    const stateRoot = makeDir('state')
    const sourceRoot = makeDir('src')
    const targetRoot = makeDir('dst')

    const idA = '11111111-1111-4111-8111-111111111111'
    const idB = '22222222-2222-4222-8222-222222222222'
    const relDir = join('sessions', '2026', '11', '27')
    const relA = `${relDir}/rollout-20261127T010000Z-${idA}.jsonl`
    const relB = `${relDir}/rollout-20261127T010000Z-${idB}.jsonl`

    mkdirSync(join(sourceRoot, relDir), { recursive: true })
    writeFileSync(join(sourceRoot, relA), '{"session":"A","rev":"exported"}\n', 'utf8')
    writeFileSync(join(sourceRoot, relB), '{"session":"B","rev":"old"}\n', 'utf8')

    // Target volume is missing A but holds NEWER B.
    mkdirSync(join(targetRoot, relDir), { recursive: true })
    writeFileSync(join(targetRoot, relB), '{"session":"B","rev":"current"}\n', 'utf8')

    const store = new UniversalEngineStateCapsuleStore({
      blobStore: new InMemoryArtifactBlobStore(),
      stateRoot,
    })

    const exported = await store.exportCapsule({
      tenantId: 'c:42',
      sessionKey: 'sess:A',
      engine: 'codex',
      engineVersion: '1.0.0',
      placementEpoch: 1,
      nativeSessionId: idA,
      sourceRoot,
    })

    assert.deepEqual(
      exported.manifest.files.map((f) => f.logicalPath),
      [relA],
      'export for A must exclude sibling session B rollout',
    )

    const imported = await store.importCapsule({
      tenantId: 'c:42',
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      expectedSessionKey: 'sess:A',
      expectedEngine: 'codex',
      expectedNativeSessionId: idA,
      targetEngineVersion: '1.0.0',
    })

    assert.equal(imported.status, 'imported')
    assert.equal(readFileSync(join(targetRoot, relA), 'utf8'), '{"session":"A","rev":"exported"}\n')
    assert.equal(
      readFileSync(join(targetRoot, relB), 'utf8'),
      '{"session":"B","rev":"current"}\n',
      'existing sibling session B must remain byte-identical',
    )
  })

  it('refuses legacy unfiltered capsule containing sibling session B before touching disk (degrades safely)', async () => {
    const stateRoot = makeDir('legacy-state')
    const targetRoot = makeDir('legacy-dst')

    const idA = '33333333-3333-4333-8333-333333333333'
    const idB = '44444444-4444-4444-8444-444444444444'
    const relDir = join('sessions', '2026', '11', '27')
    const relA = `${relDir}/rollout-20261127T010000Z-${idA}.jsonl`
    const relB = `${relDir}/rollout-20261127T010000Z-${idB}.jsonl`

    mkdirSync(join(targetRoot, relDir), { recursive: true })
    writeFileSync(join(targetRoot, relB), '{"session":"B","rev":"current"}\n', 'utf8')

    const blobStore = new InMemoryArtifactBlobStore()
    const bytesA = new TextEncoder().encode('{"session":"A","rev":"old"}\n')
    const bytesB = new TextEncoder().encode('{"session":"B","rev":"old"}\n')
    const refA = await blobStore.put({
      tenantId: 'c:42',
      kind: 'capsule_file',
      mimeType: 'application/x-ndjson',
      bytes: bytesA,
      logicalName: relA,
    })
    const refB = await blobStore.put({
      tenantId: 'c:42',
      kind: 'capsule_file',
      mimeType: 'application/x-ndjson',
      bytes: bytesB,
      logicalName: relB,
    })

    const body: EngineStateCapsuleManifestBody = {
      schemaVersion: 1,
      tenantId: 'c:42',
      sessionKey: 'sess:A',
      engine: 'codex',
      engineVersion: '1.0.0',
      placementEpoch: 1,
      portability: 'portable',
      nativeSessionId: idA,
      totalBytes: bytesA.byteLength + bytesB.byteLength,
      files: [
        {
          logicalPath: relA,
          sha256: sha256Hex(bytesA),
          sizeBytes: bytesA.byteLength,
          blobId: refA.blobId,
          mode: 0o600,
          isSqlite: false,
        },
        {
          logicalPath: relB,
          sha256: sha256Hex(bytesB),
          sizeBytes: bytesB.byteLength,
          blobId: refB.blobId,
          mode: 0o600,
          isSqlite: false,
        },
      ],
      createdAt: new Date().toISOString(),
    }
    const manifest: EngineStateCapsuleManifest = {
      ...body,
      capsuleId: computeEngineStateCapsuleId(body),
    }

    const store = new UniversalEngineStateCapsuleStore({ blobStore, stateRoot })
    const res = await store.importCapsule({
      tenantId: 'c:42',
      capsuleId: manifest.capsuleId,
      manifest,
      targetRoot,
      expectedSessionKey: 'sess:A',
      expectedEngine: 'codex',
      expectedNativeSessionId: idA,
    })

    assert.equal(res.status, 'incompatible')
    assert.match(res.reason, /capsule_file_ownership_unverified/)
    assert.equal(hasPendingRestoreMarker(stateRoot, idA), false)
    assert.equal(
      readFileSync(join(targetRoot, relB), 'utf8'),
      '{"session":"B","rev":"current"}\n',
      'legacy capsule import must NEVER overwrite existing sibling session B',
    )
  })

  it('refuses export and import of unowned shared multi-session SQLite DBs', async () => {
    const stateRoot = makeDir('shared-db-state')
    const sourceRoot = makeDir('shared-db-src')
    const targetRoot = makeDir('shared-db-dst')

    mkdirSync(join(sourceRoot, 'state'), { recursive: true })
    writeFileSync(join(sourceRoot, 'state', 'shared.db'), 'OLD_SHARED_DB', 'utf8')
    mkdirSync(join(targetRoot, 'state'), { recursive: true })
    writeFileSync(join(targetRoot, 'state', 'shared.db'), 'CURRENT_SHARED_DB', 'utf8')

    const blobStore = new InMemoryArtifactBlobStore()
    const store = new UniversalEngineStateCapsuleStore({ blobStore, stateRoot })
    const idA = '55555555-5555-4555-8555-555555555555'

    await assert.rejects(
      () =>
        store.exportCapsule({
          tenantId: 'c:42',
          sessionKey: 'sess:shared',
          engine: 'cursor',
          engineVersion: '1.0.0',
          placementEpoch: 1,
          nativeSessionId: idA,
          sourceRoot,
        }),
      /CAPSULE_NO_SESSION_OWNED_FILES/,
    )

    const bytesDb = new TextEncoder().encode('OLD_SHARED_DB')
    const refDb = await blobStore.put({
      tenantId: 'c:42',
      kind: 'capsule_file',
      mimeType: 'application/x-sqlite3',
      bytes: bytesDb,
      logicalName: 'state/shared.db',
    })
    const body: EngineStateCapsuleManifestBody = {
      schemaVersion: 1,
      tenantId: 'c:42',
      sessionKey: 'sess:shared',
      engine: 'cursor',
      engineVersion: '1.0.0',
      placementEpoch: 1,
      portability: 'same_engine_version',
      nativeSessionId: idA,
      totalBytes: bytesDb.byteLength,
      files: [
        {
          logicalPath: 'state/shared.db',
          sha256: sha256Hex(bytesDb),
          sizeBytes: bytesDb.byteLength,
          blobId: refDb.blobId,
          mode: 0o600,
          isSqlite: true,
        },
      ],
      createdAt: new Date().toISOString(),
    }
    const manifest: EngineStateCapsuleManifest = {
      ...body,
      capsuleId: computeEngineStateCapsuleId(body),
    }

    const res = await store.importCapsule({
      tenantId: 'c:42',
      capsuleId: manifest.capsuleId,
      manifest,
      targetRoot,
      expectedSessionKey: 'sess:shared',
      expectedEngine: 'cursor',
      expectedNativeSessionId: idA,
    })

    assert.equal(res.status, 'incompatible')
    assert.match(res.reason, /capsule_file_ownership_unverified/)
    assert.equal(
      readFileSync(join(targetRoot, 'state', 'shared.db'), 'utf8'),
      'CURRENT_SHARED_DB',
      'existing shared SQLite DB must never be overwritten by single-session restore',
    )
  })

  it('disables EngineCapsuleRuntime when OC_CAPSULE_RUNTIME_ENABLED=0 even with master credentials', () => {
    const stateRoot = makeDir('disabled-rt')
    const rt = new EngineCapsuleRuntime({
      tenantId: 'c:42',
      stateRoot,
      env: {
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:18791',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.1.secret',
        OC_CAPSULE_RUNTIME_ENABLED: '0',
      },
    })
    assert.equal(rt.isEnabled, false)
    assert.equal(rt.blobStore, null)
    assert.equal(rt.capsuleStore, null)
  })
})
