import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, it } from 'node:test'
import type {
  ArtifactBlobRef,
  AuthoritativeRollingCheckpoint,
  SessionAuthorityStore,
  SessionEnginePointer,
} from '@openclaude/protocol/storage-seam'
import {
  AuthorityStateBridge,
  InMemoryArtifactBlobStore,
  InMemorySessionAuthorityStore,
  type LocalCheckpointRecord,
  type LocalCheckpointStoreAdapter,
  type LocalPromptStateAdapter,
  type LocalPromptStateRecord,
  type LocalResumeStateEntry,
  type LocalResumeStoreAdapter,
  PlacementEpochConflictError,
  type TapeRecordInput,
  UniversalEngineStateCapsuleStore,
  buildAnchoredV2HandoffPackage,
  buildColdDegradedSuffix,
  encodeCcbProjectDir,
  hasPendingRestoreMarker,
  persistNativeTranscriptArchive,
  rebuildNativeTranscriptArchive,
} from '../index.js'

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `oc-storage-seam-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function makeMediaRef(id: string, name: string): ArtifactBlobRef {
  return {
    blobId: `blob_${id.padEnd(16, '0')}`,
    tenantId: 'tenant-1',
    sha256: sha256Hex(name),
    sizeBytes: 2048,
    mimeType: 'image/png',
    kind: 'upload',
    logicalName: name,
    storageBackend: 'local_cas',
  }
}

function makeLocalResumeAdapter(): {
  map: Map<string, LocalResumeStateEntry>
  adapter: LocalResumeStoreAdapter
} {
  const map = new Map<string, LocalResumeStateEntry>()
  return {
    map,
    adapter: {
      get: (key) => map.get(key) ?? null,
      set: (key, entry) => {
        map.set(key, entry)
      },
      delete: (key) => {
        map.delete(key)
      },
    },
  }
}

function makeLocalCheckpointAdapter(): {
  map: Map<string, LocalCheckpointRecord>
  adapter: LocalCheckpointStoreAdapter
} {
  const map = new Map<string, LocalCheckpointRecord>()
  return {
    map,
    adapter: {
      peek: (key) => map.get(key) ?? null,
      save: (rec) => {
        map.set(rec.sessionKey, rec)
      },
      ack: (key, gen) => {
        const cur = map.get(key)
        if (!cur || cur.generation !== gen) return false
        map.delete(key)
        return true
      },
      clear: (key) => {
        map.delete(key)
      },
    },
  }
}

function makeLocalPromptStateAdapter(): {
  map: Map<string, LocalPromptStateRecord>
  adapter: LocalPromptStateAdapter
} {
  const map = new Map<string, LocalPromptStateRecord>()
  return {
    map,
    adapter: {
      read: (key) => map.get(key) ?? null,
      write: (rec) => {
        map.set(rec.sessionKey, rec)
      },
      clear: (key) => {
        map.delete(key)
      },
    },
  }
}

describe('OCV5-890 Layer 1: UniversalEngineStateCapsuleStore', () => {
  it('exports and imports CCB capsule with chunked upload, credential filtering, staging cleanup, and cwd relocation', async () => {
    const stateRoot = makeTempDir('ccb-state')
    const sourceRoot = makeTempDir('ccb-src')
    const targetRoot = makeTempDir('ccb-dst')
    const outsideFile = join(makeTempDir('outside'), 'secret.txt')
    writeFileSync(outsideFile, 'top-secret')

    const oldCwd = '/workspace/old-repo'
    const newCwd = '/workspace/new-repo'
    const nativeSessionId = '11111111-2222-4333-8444-555555555555'
    const oldSlug = encodeCcbProjectDir(oldCwd)
    const projectDir = join(sourceRoot, 'projects', oldSlug)
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(join(sourceRoot, 'todos'), { recursive: true })
    mkdirSync(join(sourceRoot, '.ssh'), { recursive: true })

    // >2.5 KiB JSONL so chunked upload splits into multiple parts with chunkSizeBytes=1024
    const jsonlLines = Array.from({ length: 30 }, (_, idx) =>
      JSON.stringify({
        uuid: `00000000-0000-4000-8000-${String(idx).padStart(12, '0')}`,
        sessionId: nativeSessionId,
        type: idx % 2 === 0 ? 'user' : 'assistant',
        message: {
          role: idx % 2 === 0 ? 'user' : 'assistant',
          content: `turn-${idx}-${'x'.repeat(60)}`,
        },
      }),
    ).join('\n')
    writeFileSync(join(projectDir, `${nativeSessionId}.jsonl`), `${jsonlLines}\n`, 'utf8')
    writeFileSync(
      join(sourceRoot, 'todos', `${nativeSessionId}.json`),
      '{"items":["ship"]}\n',
      'utf8',
    )

    // Forbidden credential/config files + escaping symlink that MUST be excluded
    writeFileSync(join(sourceRoot, 'auth.json'), '{"token":"secret"}\n', 'utf8')
    writeFileSync(join(sourceRoot, 'openclaude.json'), '{"apiKey":"secret"}\n', 'utf8')
    writeFileSync(join(sourceRoot, '.ssh', 'id_rsa'), 'PRIVATE KEY\n', 'utf8')
    writeFileSync(join(projectDir, '.env'), 'SECRET=1\n', 'utf8')
    writeFileSync(join(projectDir, 'cert.pem'), 'PEM\n', 'utf8')
    symlinkSync(outsideFile, join(projectDir, 'escape.jsonl'))

    const blobStore = new InMemoryArtifactBlobStore()
    const store = new UniversalEngineStateCapsuleStore({
      blobStore,
      stateRoot,
      defaultChunkSizeBytes: 1024,
    })

    const exported = await store.exportCapsule({
      tenantId: 'tenant-1',
      principalId: 'user-42',
      sessionKey: 'sess:ccb:1',
      engine: 'ccb',
      engineVersion: '1.4.2',
      placementEpoch: 2,
      nativeSessionId,
      sourceRoot,
      sourceCwd: oldCwd,
      promptCacheMeta: {
        stickyLaunchSlotKey: 'slot-ccb-01',
      },
      usageBaseline: {
        totalCostUsd: 0.42,
      },
    })

    // Only the 2 whitelisted files are captured; all credentials and symlink are filtered out
    assert.deepEqual(
      exported.manifest.files.map((f) => f.logicalPath),
      [`projects/${oldSlug}/${nativeSessionId}.jsonl`, `todos/${nativeSessionId}.json`],
    )
    assert.ok(blobStore.chunkedUploadCalls >= 2)
    assert.ok(
      blobStore.partUploadCalls >= 3,
      'multi-part chunked upload should invoke putPart multiple times',
    )
    assert.equal(blobStore.completeUploadCalls, 2)
    assert.equal(
      readdirSync(join(stateRoot, 'staging')).length,
      0,
      'staging must be cleaned in finally',
    )

    const imported = await store.importCapsule({
      tenantId: 'tenant-1',
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      expectedPrincipalId: 'user-42',
      expectedSessionKey: 'sess:ccb:1',
      expectedEngine: 'ccb',
      expectedNativeSessionId: nativeSessionId,
      targetEngineVersion: '1.9.0',
      targetCwd: newCwd,
    })

    assert.equal(imported.status, 'imported')
    assert.equal(hasPendingRestoreMarker(stateRoot, nativeSessionId), false)
    assert.equal(imported.relocated.length, 1)
    const newSlug = encodeCcbProjectDir(newCwd)
    assert.deepEqual(imported.relocated[0], {
      from: `projects/${oldSlug}/${nativeSessionId}.jsonl`,
      to: `projects/${newSlug}/${nativeSessionId}.jsonl`,
    })
    assert.equal(
      readFileSync(join(targetRoot, 'projects', newSlug, `${nativeSessionId}.jsonl`), 'utf8'),
      `${jsonlLines}\n`,
    )
    assert.equal(
      readFileSync(join(targetRoot, 'todos', `${nativeSessionId}.json`), 'utf8'),
      '{"items":["ship"]}\n',
    )
    assert.equal(imported.usageBaseline?.totalCostUsd, 0.42)
    assert.equal(imported.promptCacheMeta?.stickyLaunchSlotKey, 'slot-ccb-01')
  })

  it('detects concurrent source mutation via 5-tuple fstat check and cleans staging on failure', async () => {
    const stateRoot = makeTempDir('tear-state')
    const sourceRoot = makeTempDir('tear-src')
    const dir = join(sourceRoot, 'sessions', '2026', '11', '25')
    mkdirSync(dir, { recursive: true })
    const rolloutPath = join(dir, 'rollout-20261125-aaa.jsonl')
    writeFileSync(rolloutPath, '{"type":"session_meta"}\n', 'utf8')

    const store = new UniversalEngineStateCapsuleStore({
      blobStore: new InMemoryArtifactBlobStore(),
      stateRoot,
    })

    await assert.rejects(
      () =>
        store.exportCapsule({
          tenantId: 'tenant-1',
          sessionKey: 'sess:codex:tear',
          engine: 'codex',
          engineVersion: '1.0.0',
          placementEpoch: 1,
          nativeSessionId: '22222222-2222-4222-8222-222222222222',
          sourceRoot,
          beforeUpload: () => {
            writeFileSync(
              rolloutPath,
              '{"type":"session_meta"}\n{"type":"response_item"}\n',
              'utf8',
            )
          },
        }),
      /CAPSULE_SOURCE_CHANGED/,
    )
    assert.equal(readdirSync(join(stateRoot, 'staging')).length, 0)
  })

  it('exports and imports Codex rollout capsule preserving cumulative usageBaseline and stickyLaunchSlotKey', async () => {
    const stateRoot = makeTempDir('codex-state')
    const sourceRoot = makeTempDir('codex-src')
    const targetRoot = makeTempDir('codex-dst')
    const threadId = '33333333-3333-4333-8333-333333333333'
    const relDir = join('sessions', '2026', '11', '25')
    mkdirSync(join(sourceRoot, relDir), { recursive: true })
    const rolloutRel = `${relDir}/rollout-20261125T040000Z-${threadId}.jsonl`
    const rolloutContent =
      '{"type":"session_meta","payload":{"id":"33333333-3333-4333-8333-333333333333"}}\n{"type":"response_item","payload":{"role":"assistant","text":"done"}}\n'
    writeFileSync(join(sourceRoot, rolloutRel), rolloutContent, 'utf8')

    const store = new UniversalEngineStateCapsuleStore({
      blobStore: new InMemoryArtifactBlobStore(),
      stateRoot,
    })

    const exported = await store.exportCapsule({
      tenantId: 'tenant-1',
      sessionKey: 'sess:codex:1',
      engine: 'codex',
      engineVersion: '1.2.0',
      placementEpoch: 3,
      nativeSessionId: threadId,
      sourceRoot,
      promptCacheMeta: { stickyLaunchSlotKey: 'codex-slot-7' },
      usageBaseline: { inputTokens: 12000, outputTokens: 3400, totalCostUsd: 0.18 },
    })

    const imported = await store.importCapsule({
      tenantId: 'tenant-1',
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      expectedSessionKey: 'sess:codex:1',
      expectedEngine: 'codex',
      expectedNativeSessionId: threadId,
      targetEngineVersion: '1.5.0',
    })

    assert.equal(imported.status, 'imported')
    assert.equal(readFileSync(join(targetRoot, rolloutRel), 'utf8'), rolloutContent)
    assert.deepEqual(imported.usageBaseline, {
      inputTokens: 12000,
      outputTokens: 3400,
      totalCostUsd: 0.18,
    })
    assert.equal(imported.promptCacheMeta?.stickyLaunchSlotKey, 'codex-slot-7')
  })

  it('exports and imports Antigravity SQLite capsule with WAL checkpointing and prompt-state preservation', async () => {
    const stateRoot = makeTempDir('agy-state')
    const sourceRoot = makeTempDir('agy-src')
    const targetRoot = makeTempDir('agy-dst')
    const conversationId = '44444444-4444-4444-8444-444444444444'
    const convDir = join(sourceRoot, 'conversations')
    mkdirSync(convDir, { recursive: true })
    const dbPath = join(convDir, `${conversationId}.db`)

    // Create a real WAL-mode SQLite DB with rows written into WAL
    const db = new Database(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, body TEXT)')
    db.prepare('INSERT INTO steps (idx, step_type, body) VALUES (?, ?, ?)').run(1, 1, 'hello agy')
    db.prepare('INSERT INTO steps (idx, step_type, body) VALUES (?, ?, ?)').run(2, 2, 'world agy')
    db.close()

    const checkpointedCalls: string[] = []
    const store = new UniversalEngineStateCapsuleStore({
      blobStore: new InMemoryArtifactBlobStore(),
      stateRoot,
    })

    const exported = await store.exportCapsule({
      tenantId: 'tenant-1',
      sessionKey: 'sess:agy:1',
      engine: 'antigravity',
      engineVersion: '2.1.0',
      placementEpoch: 4,
      nativeSessionId: conversationId,
      sourceRoot,
      promptCacheMeta: {
        stickyLaunchSlotKey: 'agy-slot-9',
        conversationId,
        inputsKey: 'inputs-key-sha256-abc',
        injectedAfterBaseline: 2,
        slotHashes: { SOUL: 'sha-soul', TOOLS: 'sha-tools' },
      },
      sqliteWalCheckpoint: (p) => {
        checkpointedCalls.push(p)
        const conn = new Database(p)
        try {
          conn.pragma('wal_checkpoint(TRUNCATE)')
        } finally {
          conn.close()
        }
      },
    })

    assert.deepEqual(checkpointedCalls, [dbPath])
    assert.deepEqual(exported.checkpointedSqlitePaths, [`conversations/${conversationId}.db`])
    assert.equal(exported.manifest.files.length, 1)
    assert.equal(exported.manifest.files[0]?.isSqlite, true)

    // Also verify default built-in PRAGMA wal_checkpoint(TRUNCATE) fallback works with no custom callback
    const exportedDefault = await store.exportCapsule({
      tenantId: 'tenant-1',
      sessionKey: 'sess:agy:1-default',
      engine: 'antigravity',
      engineVersion: '2.1.0',
      placementEpoch: 4,
      nativeSessionId: conversationId,
      sourceRoot,
    })
    assert.deepEqual(exportedDefault.checkpointedSqlitePaths, [
      `conversations/${conversationId}.db`,
    ])

    const imported = await store.importCapsule({
      tenantId: 'tenant-1',
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      expectedSessionKey: 'sess:agy:1',
      expectedEngine: 'antigravity',
      expectedNativeSessionId: conversationId,
      targetEngineVersion: '2.4.0',
    })

    assert.equal(imported.status, 'imported')
    assert.ok(imported.promptStatePath && existsSync(imported.promptStatePath))
    const psStat = statSync(imported.promptStatePath)
    assert.equal(psStat.mode & 0o077, 0, 'prompt-state file must be 0600')
    const promptState = JSON.parse(readFileSync(imported.promptStatePath, 'utf8')) as {
      v: number
      sessionKey: string
      conversationId: string
      inputsKey: string
      injectedAfterBaseline: number
    }
    assert.equal(promptState.v, 1)
    assert.equal(promptState.sessionKey, 'sess:agy:1')
    assert.equal(promptState.conversationId, conversationId)
    assert.equal(promptState.inputsKey, 'inputs-key-sha256-abc')
    assert.equal(promptState.injectedAfterBaseline, 2)

    // Verify imported SQLite DB has intact rows after WAL checkpoint truncation
    const restoredDb = new Database(join(targetRoot, 'conversations', `${conversationId}.db`), {
      readonly: true,
    })
    const rows = restoredDb.prepare('SELECT idx, body FROM steps ORDER BY idx').all() as Array<{
      idx: number
      body: string
    }>
    restoredDb.close()
    assert.deepEqual(
      rows.map((r) => ({ idx: r.idx, body: r.body })),
      [
        { idx: 1, body: 'hello agy' },
        { idx: 2, body: 'world agy' },
      ],
    )
  })

  it('rejects corrupt blob during import, preserves restore marker (exit-73), and refuses to overwrite target', async () => {
    const stateRoot = makeTempDir('corrupt-state')
    const sourceRoot = makeTempDir('corrupt-src')
    const targetRoot = makeTempDir('corrupt-dst')
    const sid = '55555555-5555-4555-8555-555555555555'
    mkdirSync(join(sourceRoot, 'sessions'), { recursive: true })
    writeFileSync(join(sourceRoot, 'sessions', `${sid}.jsonl`), '{"seq":1,"text":"good"}\n', 'utf8')

    // Pre-existing good file in targetRoot must remain untouched on corrupt import
    mkdirSync(join(targetRoot, 'sessions'), { recursive: true })
    writeFileSync(join(targetRoot, 'sessions', `${sid}.jsonl`), 'ORIGINAL_TARGET_CONTENT', 'utf8')

    const blobStore = new InMemoryArtifactBlobStore()
    const store = new UniversalEngineStateCapsuleStore({ blobStore, stateRoot })

    const exported = await store.exportCapsule({
      tenantId: 'tenant-1',
      sessionKey: 'sess:corrupt:1',
      engine: 'codex',
      engineVersion: '1.0.0',
      placementEpoch: 1,
      nativeSessionId: sid,
      sourceRoot,
    })

    const blobId = exported.manifest.files[0]!.blobId!
    blobStore.corruptBlobBytesForTest(
      'tenant-1',
      blobId,
      new TextEncoder().encode('{"seq":1,"text":"EVIL"}\n'),
    )

    const imported = await store.importCapsule({
      tenantId: 'tenant-1',
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      expectedSessionKey: 'sess:corrupt:1',
      expectedEngine: 'codex',
      expectedNativeSessionId: sid,
    })

    assert.equal(imported.status, 'corrupt')
    assert.match(imported.reason, /blob_sha256_mismatch/)
    assert.equal(hasPendingRestoreMarker(stateRoot, sid), true)
    assert.equal(
      readFileSync(join(targetRoot, 'sessions', `${sid}.jsonl`), 'utf8'),
      'ORIGINAL_TARGET_CONTENT',
    )
  })

  it('rejects identity mismatch and major-version incompatibility cleanly', async () => {
    const stateRoot = makeTempDir('compat-state')
    const sourceRoot = makeTempDir('compat-src')
    const targetRoot = makeTempDir('compat-dst')
    mkdirSync(join(sourceRoot, 'sessions'), { recursive: true })
    writeFileSync(join(sourceRoot, 'sessions', 'a.jsonl'), '{}\n', 'utf8')

    const store = new UniversalEngineStateCapsuleStore({
      blobStore: new InMemoryArtifactBlobStore(),
      stateRoot,
    })

    const exported = await store.exportCapsule({
      tenantId: 'tenant-1',
      principalId: 'user-A',
      sessionKey: 'sess:compat:1',
      engine: 'codex',
      engineVersion: '1.8.0',
      placementEpoch: 1,
      nativeSessionId: '66666666-6666-4666-8666-666666666666',
      sourceRoot,
    })

    const badSession = await store.importCapsule({
      tenantId: 'tenant-1',
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      expectedSessionKey: 'sess:other',
      expectedEngine: 'codex',
    })
    assert.equal(badSession.status, 'incompatible')

    const badPrincipal = await store.importCapsule({
      tenantId: 'tenant-1',
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      expectedPrincipalId: 'user-B',
      expectedSessionKey: 'sess:compat:1',
      expectedEngine: 'codex',
    })
    assert.equal(badPrincipal.status, 'incompatible')

    const badMajor = await store.importCapsule({
      tenantId: 'tenant-1',
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      expectedPrincipalId: 'user-A',
      expectedSessionKey: 'sess:compat:1',
      expectedEngine: 'codex',
      targetEngineVersion: '2.0.0',
    })
    assert.equal(badMajor.status, 'incompatible')
    assert.match(badMajor.reason, /engine_major_version_mismatch/)
  })

  it('enforces unified 0-based CAS multipart contract and restores multi-part + 0-byte capsule on fresh independent stateRootB via manifest (B09)', async () => {
    const stateRootA = makeTempDir('b09-state-a')
    const stateRootB = makeTempDir('b09-state-b')
    const sourceRoot = makeTempDir('b09-src')
    const targetRoot = makeTempDir('b09-dst')

    const blobStore = new InMemoryArtifactBlobStore()
    // Contract checks: missing filename, bad part sha256, and out-of-range index must be rejected!
    await assert.rejects(
      () =>
        blobStore.initiateChunkedUpload({
          tenantId: 'tenant-1',
          kind: 'capsule_file',
          filename: '',
          mimeType: 'application/x-ndjson',
          expectedSizeBytes: 10,
        }),
      /BLOB_FILENAME_INVALID/,
    )
    const testSess = await blobStore.initiateChunkedUpload({
      tenantId: 'tenant-1',
      kind: 'capsule_file',
      filename: 'probe.jsonl',
      mimeType: 'application/x-ndjson',
      expectedSizeBytes: 10,
      chunkBytes: 1024,
    })
    assert.equal(testSess.chunkCount, 1)
    await assert.rejects(
      () =>
        blobStore.putPart({
          uploadId: testSess.uploadId,
          tenantId: 'tenant-1',
          index: 1,
          bytes: new Uint8Array(10),
          sha256: sha256Hex(new Uint8Array(10)),
        }),
      /BLOB_PART_INDEX_OUT_OF_RANGE/,
    )
    await assert.rejects(
      () =>
        blobStore.putPart({
          uploadId: testSess.uploadId,
          tenantId: 'tenant-1',
          index: 0,
          bytes: new Uint8Array(10),
          sha256: '0'.repeat(64),
        }),
      /BLOB_PART_SHA256_MISMATCH/,
    )
    await blobStore.abortUpload('tenant-1', testSess.uploadId)

    // Real cross-node export (stateRootA) -> import (fresh independent stateRootB) with multi-part + 0-byte files!
    const sessionsDir = join(sourceRoot, 'sessions', '2026', '11', '25')
    mkdirSync(sessionsDir, { recursive: true })
    const sid = '12121212-3434-4567-8901-abcdefabcdef'
    const bigRel = `sessions/2026/11/25/rollout-${sid}.jsonl`
    const emptyRel = `sessions/2026/11/25/empty-${sid}.jsonl`
    const bigContent = `${'{"type":"response_item","text":"chunked-payload"}\n'.repeat(80)}`
    writeFileSync(join(sourceRoot, bigRel), bigContent, 'utf8')
    writeFileSync(join(sourceRoot, emptyRel), '', 'utf8')

    const storeA = new UniversalEngineStateCapsuleStore({
      blobStore,
      stateRoot: stateRootA,
      defaultChunkSizeBytes: 1024,
    })
    const exported = await storeA.exportCapsule({
      tenantId: 'tenant-1',
      sessionKey: 'sess:b09:cross-node',
      engine: 'codex',
      engineVersion: '1.2.0',
      placementEpoch: 2,
      nativeSessionId: sid,
      sourceRoot,
      chunkSizeBytes: 1024,
    })
    assert.equal(exported.manifest.files.length, 2)

    // Store B has a completely empty local index (stateRootB != stateRootA).
    const storeB = new UniversalEngineStateCapsuleStore({
      blobStore,
      stateRoot: stateRootB,
    })
    // Without manifest, stateRootB does not have the local index.
    const missing = await storeB.importCapsule({
      tenantId: 'tenant-1',
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      expectedSessionKey: 'sess:b09:cross-node',
      expectedEngine: 'codex',
    })
    assert.equal(missing.status, 'not_found')

    // With manifest supplied, stateRootB restores directly from shared blobStore with full SHA-256 verification!
    const restored = await storeB.importCapsule({
      tenantId: 'tenant-1',
      capsuleId: exported.manifest.capsuleId,
      manifest: exported.manifest,
      targetRoot,
      expectedSessionKey: 'sess:b09:cross-node',
      expectedEngine: 'codex',
      expectedNativeSessionId: sid,
      targetEngineVersion: '1.5.0',
    })
    assert.equal(restored.status, 'imported')
    assert.equal(readFileSync(join(targetRoot, bigRel), 'utf8'), bigContent)
    assert.equal(readFileSync(join(targetRoot, emptyRel), 'utf8'), '')
  })

  it('fails closed on busy SQLite WAL under fail_closed policy and preserves uncommitted-to-main WAL rows via VACUUM INTO under vacuum_into policy (B10)', async () => {
    const stateRoot = makeTempDir('b10-state')
    const sourceRoot = makeTempDir('b10-src')
    const targetRoot = makeTempDir('b10-dst')
    const conversationId = '98989898-1212-4343-8565-787878787878'
    const convDir = join(sourceRoot, 'conversations')
    mkdirSync(convDir, { recursive: true })
    const dbPath = join(convDir, `${conversationId}.db`)

    // Set up WAL-mode DB with 0 initial rows.
    const setupDb = new Database(dbPath)
    setupDb.exec('PRAGMA journal_mode = WAL')
    setupDb.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, body TEXT NOT NULL)')
    setupDb.close()

    // Connection A holds an active old read snapshot (0 rows), blocking wal_checkpoint(TRUNCATE).
    const readerConn = new Database(dbPath)
    // Connection B commits a brand-new row into the WAL while Connection A stays open!
    const writerConn = new Database(dbPath)
    try {
      readerConn.exec('BEGIN')
      const initialCount = readerConn.prepare('SELECT COUNT(*) AS cnt FROM steps').get() as {
        cnt: number
      }
      assert.equal(initialCount.cnt, 0)

      writerConn.prepare('INSERT INTO steps (idx, body) VALUES (?, ?)').run(1, 'committed-in-wal')

      // Confirm real SQLite PRAGMA wal_checkpoint(TRUNCATE) reports busy=1, log>=1, checkpointed=0!
      const probeConn = new Database(dbPath, { timeout: 250 })
      const probeRows = probeConn.pragma('wal_checkpoint(TRUNCATE)') as Array<{
        busy: number
        log: number
        checkpointed: number
      }>
      probeConn.close()
      assert.equal(probeRows[0]?.busy, 1)
      assert.ok((probeRows[0]?.log ?? 0) >= 1)
      assert.equal(probeRows[0]?.checkpointed, 0)

      const store = new UniversalEngineStateCapsuleStore({
        blobStore: new InMemoryArtifactBlobStore(),
        stateRoot,
      })

      // Verification 1: fail_closed policy MUST reject with CAPSULE_SQLITE_WAL_CHECKPOINT_BUSY!
      await assert.rejects(
        () =>
          store.exportCapsule({
            tenantId: 'tenant-1',
            sessionKey: 'sess:b10:busy',
            engine: 'antigravity',
            engineVersion: '2.1.0',
            placementEpoch: 1,
            nativeSessionId: conversationId,
            sourceRoot,
            sqliteBusyPolicy: 'fail_closed',
          }),
        /CAPSULE_SQLITE_WAL_CHECKPOINT_BUSY/,
      )
      assert.equal(readdirSync(join(stateRoot, 'staging')).length, 0)

      // Verification 2: vacuum_into policy exports consistent snapshot -> import restores the 1 committed row!
      const exported = await store.exportCapsule({
        tenantId: 'tenant-1',
        sessionKey: 'sess:b10:busy',
        engine: 'antigravity',
        engineVersion: '2.1.0',
        placementEpoch: 1,
        nativeSessionId: conversationId,
        sourceRoot,
        sqliteBusyPolicy: 'vacuum_into',
      })
      assert.equal(
        exported.sqliteSnapshotStrategies?.[`conversations/${conversationId}.db`],
        'vacuum_into',
      )

      const imported = await store.importCapsule({
        tenantId: 'tenant-1',
        capsuleId: exported.manifest.capsuleId,
        targetRoot,
        expectedSessionKey: 'sess:b10:busy',
        expectedEngine: 'antigravity',
        expectedNativeSessionId: conversationId,
        targetEngineVersion: '2.1.0',
      })
      assert.equal(imported.status, 'imported')

      const restoredDb = new Database(join(targetRoot, 'conversations', `${conversationId}.db`), {
        readonly: true,
      })
      const restoredRows = restoredDb.prepare('SELECT idx, body FROM steps ORDER BY idx').all() as Array<{
        idx: number
        body: string
      }>
      restoredDb.close()
      assert.deepEqual(restoredRows, [{ idx: 1, body: 'committed-in-wal' }])
    } finally {
      try {
        readerConn.exec('ROLLBACK')
      } catch {
        /* ignore */
      }
      readerConn.close()
      writerConn.close()
    }
  })
})

describe('OCV5-890 Layer 1: PG Tape Warm Rebuilder (Tier 2A / 2B / 3)', () => {
  const sampleMedia1 = makeMediaRef('img1', 'diagram.png')
  const sampleMedia2 = makeMediaRef('img2', 'trace.png')

  const sampleTape: TapeRecordInput[] = [
    {
      seq: 1,
      role: 'user',
      text: 'Build a three-layer storage pool for OpenClaude',
      mediaRefs: [sampleMedia1],
      timestampMs: Date.UTC(2026, 10, 25, 4, 0, 0),
    },
    {
      seq: 2,
      role: 'assistant',
      text: 'Plan: split Layer 1 capsule store, Tier 2A/2B/3 tape rebuilder, and authority bridge.',
      timestampMs: Date.UTC(2026, 10, 25, 4, 0, 5),
    },
    {
      seq: 3,
      role: 'tool',
      toolName: 'read_file',
      toolCallId: 'call_old_1',
      text: 'OLD_TOOL_OUTPUT_TURN_1',
      timestampMs: Date.UTC(2026, 10, 25, 4, 0, 10),
    },
    {
      seq: 4,
      role: 'user',
      text: 'Inspect validators and check architecture rules',
      timestampMs: Date.UTC(2026, 10, 25, 4, 1, 0),
    },
    {
      seq: 5,
      role: 'tool',
      toolName: 'grep',
      toolCallId: 'call_mid_2',
      text: 'RECENT_TOOL_OUTPUT_TURN_2_FULL_BODY',
      timestampMs: Date.UTC(2026, 10, 25, 4, 1, 5),
    },
    {
      seq: 6,
      role: 'assistant',
      text: 'Decision: use Record<AuthorityEngineKind, Adapter> table dispatch for zero R3-special-case.',
      timestampMs: Date.UTC(2026, 10, 25, 4, 1, 10),
    },
    {
      seq: 7,
      role: 'user',
      text: 'Run tests and attach trace image',
      mediaRefs: [sampleMedia2],
      timestampMs: Date.UTC(2026, 10, 25, 4, 2, 0),
    },
    {
      seq: 8,
      role: 'tool',
      toolName: 'run_command',
      toolCallId: 'call_latest_3',
      text: 'RECENT_TOOL_OUTPUT_TURN_3_FULL_BODY',
      timestampMs: Date.UTC(2026, 10, 25, 4, 2, 5),
    },
    {
      seq: 9,
      role: 'assistant',
      text: 'All checks passed.',
      timestampMs: Date.UTC(2026, 10, 25, 4, 2, 10),
    },
  ]

  it('rebuilds deterministic Tier 2A native archives for CCB, Codex, and Antigravity and persists to ArtifactBlobStore', async () => {
    const blobStore = new InMemoryArtifactBlobStore()

    // 1. CCB JSONL
    const ccb1 = rebuildNativeTranscriptArchive({
      engine: 'ccb',
      nativeSessionId: '77777777-7777-4777-8777-777777777777',
      cwd: '/workspace/app',
      records: sampleTape,
    })
    const ccb2 = rebuildNativeTranscriptArchive({
      engine: 'ccb',
      nativeSessionId: '77777777-7777-4777-8777-777777777777',
      cwd: '/workspace/app',
      records: sampleTape,
    })
    assert.equal(ccb1.sha256, ccb2.sha256, 'CCB Tier 2A rebuild must be deterministic')
    assert.equal(ccb1.format, 'ccb_jsonl')
    const ccbLines = ccb1.contentText
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as {
            uuid: string
            parentUuid: string | null
            sessionId: string
            cwd: string
            message: unknown
          },
      )
    assert.equal(ccbLines.length, sampleTape.length)
    assert.equal(ccbLines[0]!.parentUuid, null)
    for (let i = 1; i < ccbLines.length; i += 1) {
      assert.equal(ccbLines[i]!.parentUuid, ccbLines[i - 1]!.uuid)
      assert.equal(ccbLines[i]!.sessionId, '77777777-7777-4777-8777-777777777777')
      assert.equal(ccbLines[i]!.cwd, '/workspace/app')
    }
    const ccbRef = await persistNativeTranscriptArchive(blobStore, 'tenant-1', ccb1)
    assert.equal(ccbRef.kind, 'tape_archive')
    assert.equal(ccbRef.sha256, ccb1.sha256)

    // 2. Codex rollout JSONL
    const codex = rebuildNativeTranscriptArchive({
      engine: 'codex',
      nativeSessionId: '88888888-8888-4888-8888-888888888888',
      cwd: '/workspace/app',
      records: sampleTape,
    })
    assert.equal(codex.format, 'codex_rollout_jsonl')
    const codexLines = codex.contentText
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> })
    assert.equal(codexLines[0]!.type, 'session_meta')
    assert.ok(codexLines.some((l) => l.type === 'turn_context'))
    assert.ok(codexLines.some((l) => l.type === 'response_item'))

    // 3. Antigravity step replay archive JSON
    const agy = rebuildNativeTranscriptArchive({
      engine: 'antigravity',
      nativeSessionId: '99999999-9999-4999-8999-999999999999',
      cwd: '/workspace/app',
      records: sampleTape,
      promptCacheMeta: { inputsKey: 'k-123' },
    })
    assert.equal(agy.format, 'antigravity_step_archive_json')
    const agyParsed = JSON.parse(agy.contentText) as {
      conversation_id: string
      steps: Array<{ idx: number; seq: number; step_type: string }>
      promptCacheMeta: { inputsKey: string; injectedAfterBaseline: number }
    }
    assert.equal(agyParsed.conversation_id, '99999999-9999-4999-8999-999999999999')
    assert.equal(agyParsed.steps.length, sampleTape.length)
    assert.equal(agyParsed.steps[0]!.step_type, 'USER_INPUT')
    assert.equal(agyParsed.promptCacheMeta.inputsKey, 'k-123')
    assert.equal(agyParsed.promptCacheMeta.injectedAfterBaseline, sampleTape.length)
  })

  it('builds Tier 2B anchored_v2 handoff preserving first-turn goal, plan anchors, last 2 tool turns, and all mediaRefs', () => {
    const handoff = buildAnchoredV2HandoffPackage({
      records: sampleTape,
      targetContextWindowTokens: 32_000,
    })

    assert.equal(handoff.mode, 'anchored_v2')
    assert.equal(handoff.anchorSeq, 9)
    assert.equal(handoff.firstTurnGoal, 'Build a three-layer storage pool for OpenClaude')
    assert.ok(handoff.latestPlanAnchors.some((a) => a.includes('Plan:')))
    assert.ok(handoff.latestPlanAnchors.some((a) => a.includes('Decision:')))
    // Last 2 tool turns: call_mid_2 and call_latest_3 (NOT call_old_1)
    assert.deepEqual(
      handoff.recentToolOutputs.map((t) => t.toolCallId),
      ['call_mid_2', 'call_latest_3'],
    )
    assert.ok(handoff.summary.includes('RECENT_TOOL_OUTPUT_TURN_2_FULL_BODY'))
    assert.ok(handoff.summary.includes('RECENT_TOOL_OUTPUT_TURN_3_FULL_BODY'))
    // ALL mediaRefs retained (including first turn's diagram.png and later turn's trace.png)
    assert.deepEqual(
      handoff.mediaRefs.map((m) => m.blobId),
      [sampleMedia1.blobId, sampleMedia2.blobId],
    )
  })

  it('builds Tier 3 cold degraded suffix following [4, 16, 64] ladder and emitting sys.context_rebuilt notice', () => {
    const largeTape: TapeRecordInput[] = Array.from({ length: 80 }, (_, idx) => ({
      seq: idx + 1,
      role: idx % 2 === 0 ? 'user' : 'assistant',
      text: `message-${idx + 1}-${'a'.repeat(40)}`,
    }))

    // Tight budget forces step 4 (4 records ~260 bytes, 16 records ~1050 bytes)
    const step4 = buildColdDegradedSuffix({
      records: largeTape,
      ladderSteps: [4, 16, 64],
      maxBytes: 400,
      sessionKey: 'sess:cold:1',
      engine: 'ccb',
      reason: 'capsule_corrupt',
    })
    assert.equal(step4.tier, 'cold_degraded')
    assert.equal(step4.selectedStep, 4)
    assert.equal(step4.records.length, 4)
    assert.ok(step4.bytesUsed <= 400)
    assert.equal(step4.anchorSeq, 80)
    assert.equal(step4.notice.type, 'sys.context_rebuilt')
    assert.equal(step4.notice.reason, 'capsule_corrupt')
    assert.equal(step4.notice.truncatedRecords, 76)

    // Medium budget allows step 16
    const step16 = buildColdDegradedSuffix({
      records: largeTape,
      ladderSteps: [4, 16, 64],
      maxBytes: 1500,
    })
    assert.equal(step16.selectedStep, 16)
    assert.equal(step16.records.length, 16)
    assert.ok(step16.bytesUsed <= 1500)
  })

  it('resolves complete Tier 1 -> 1.5 -> 2A -> 2B -> 3 resume ladder with rejected ID skipping', async () => {
    const stateRoot = makeTempDir('ladder-state')
    const sourceRoot = makeTempDir('ladder-src')
    const targetRoot = makeTempDir('ladder-dst')
    const sid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    mkdirSync(join(sourceRoot, 'sessions'), { recursive: true })
    writeFileSync(join(sourceRoot, 'sessions', `${sid}.jsonl`), '{"seq":1}\n', 'utf8')

    const blobStore = new InMemoryArtifactBlobStore()
    const store = new UniversalEngineStateCapsuleStore({ blobStore, stateRoot })
    const exported = await store.exportCapsule({
      tenantId: 'tenant-1',
      sessionKey: 'sess:ladder:1',
      engine: 'codex',
      engineVersion: '1.0.0',
      placementEpoch: 1,
      nativeSessionId: sid,
      sourceRoot,
    })

    // Tier 1: hot_native
    const tier1 = await store.resolveResumeLadder({
      tenantId: 'tenant-1',
      sessionKey: 'sess:ladder:1',
      placementEpoch: 1,
      sourceEngine: 'codex',
      targetEngine: 'codex',
      nativeSessionId: sid,
      hotNativeAvailable: true,
      targetCwd: '/workspace',
    })
    assert.equal(tier1.result.tier, 'hot_native')
    assert.equal(tier1.subTier, '1')

    // Tier 1.5: hot_native unavailable -> warm_capsule import
    const tier15 = await store.resolveResumeLadder({
      tenantId: 'tenant-1',
      sessionKey: 'sess:ladder:1',
      placementEpoch: 2,
      sourceEngine: 'codex',
      targetEngine: 'codex',
      nativeSessionId: sid,
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      hotNativeAvailable: false,
      targetCwd: '/workspace',
    })
    assert.equal(tier15.result.tier, 'warm_capsule')
    assert.equal(tier15.subTier, '1.5')

    // Record rejected ID -> skips Tier 1 & Tier 1.5, degrades to Tier 2A (same engine + tape)
    store.recordRejectedResumeId('sess:ladder:1', sid)
    const tier2A = await store.resolveResumeLadder({
      tenantId: 'tenant-1',
      sessionKey: 'sess:ladder:1',
      placementEpoch: 3,
      sourceEngine: 'codex',
      targetEngine: 'codex',
      nativeSessionId: sid,
      capsuleId: exported.manifest.capsuleId,
      targetRoot,
      hotNativeAvailable: true,
      records: sampleTape,
      targetCwd: '/workspace',
    })
    assert.equal(tier2A.result.tier, 'tape_rebuilt')
    assert.equal(tier2A.subTier, '2A')
    assert.equal(tier2A.archive?.format, 'codex_rollout_jsonl')

    // Cross-engine switch (codex -> ccb) degrades to Tier 2B (anchored_v2)
    const tier2B = await store.resolveResumeLadder({
      tenantId: 'tenant-1',
      sessionKey: 'sess:ladder:1',
      placementEpoch: 4,
      sourceEngine: 'codex',
      targetEngine: 'ccb',
      records: sampleTape,
      targetCwd: '/workspace',
    })
    assert.equal(tier2B.result.tier, 'tape_rebuilt')
    assert.equal(tier2B.subTier, '2B')
    assert.equal(tier2B.handoff?.mode, 'anchored_v2')

    // No records + no capsule + no hot native -> Tier 3 cold_degraded
    const tier3 = await store.resolveResumeLadder({
      tenantId: 'tenant-1',
      sessionKey: 'sess:ladder:empty',
      placementEpoch: 5,
      sourceEngine: 'ccb',
      targetEngine: 'ccb',
      records: [],
      targetCwd: '/workspace',
    })
    assert.equal(tier3.result.tier, 'cold_degraded')
    assert.equal(tier3.subTier, '3')
    assert.equal(tier3.cold?.notice.type, 'sys.context_rebuilt')
  })
})

describe('OCV5-890 Layer 1: AuthorityStateBridge', () => {
  it('supports write-through, read-through hydration after container rebuild, and generation CAS ack without double-injection', async () => {
    const authorityStore = new InMemorySessionAuthorityStore()

    // Container A (pre-rebuild)
    const localResumeA = makeLocalResumeAdapter()
    const localCheckpointA = makeLocalCheckpointAdapter()
    const localPromptA = makeLocalPromptStateAdapter()

    const bridgeA = new AuthorityStateBridge({
      tenantId: 'tenant-1',
      authorityStore,
      localResumeStore: localResumeA.adapter,
      localCheckpointStore: localCheckpointA.adapter,
      localPromptState: localPromptA.adapter,
      defaultPoolKind: 'local_container',
    })

    const writePtr = await bridgeA.writePointer({
      sessionKey: 'sess:bridge:1',
      placementEpoch: 1,
      expectedPlacementEpoch: 0,
      engine: 'antigravity',
      nativeSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      history: ['old-conv-1'],
      rejectedIds: ['dead-conv-0'],
      lastCost: 1.25,
    })
    assert.equal(writePtr.authorityDegraded, false)
    assert.equal(
      localResumeA.map.get('sess:bridge:1')?.nativeSessionId,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )

    const writePrompt = await bridgeA.writePromptState({
      engine: 'antigravity',
      placementEpoch: 2,
      expectedPlacementEpoch: 1,
      record: {
        v: 1,
        sessionKey: 'sess:bridge:1',
        conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        inputsKey: 'inputs-sha-xyz',
        slotHashes: { SOUL: 'hash-soul' },
        injectedAfterBaseline: 5,
        updatedAt: Date.now(),
      },
    })
    assert.equal(writePrompt.authorityDegraded, false)

    const savedCp = await bridgeA.saveRollingCheckpoint({
      sessionKey: 'sess:bridge:1',
      sessionId: 'sid-1',
      checkpointGeneration: 'gen-001',
      placementEpoch: 2,
      mode: 'anchored_v2',
      anchorSeq: 42,
      sourceEngine: 'antigravity',
      summary: 'Anchored state before pool switch',
    })
    assert.equal(savedCp.authorityDegraded, false)
    assert.equal(localCheckpointA.map.get('sess:bridge:1')?.generation, 'gen-001')

    // Simulate container rebuild / pool switch: Container B starts with empty local stores
    const localResumeB = makeLocalResumeAdapter()
    const localCheckpointB = makeLocalCheckpointAdapter()
    const localPromptB = makeLocalPromptStateAdapter()

    const bridgeB = new AuthorityStateBridge({
      tenantId: 'tenant-1',
      authorityStore,
      localResumeStore: localResumeB.adapter,
      localCheckpointStore: localCheckpointB.adapter,
      localPromptState: localPromptB.adapter,
      defaultPoolKind: 'remote_pool',
    })

    // Read-through hydrates resume-map + prompt-state + pending rolling checkpoint
    const hydratedPtr = await bridgeB.readPointer('sess:bridge:1')
    assert.equal(hydratedPtr.hydratedFromAuthority, true)
    assert.equal(hydratedPtr.localEntry?.nativeSessionId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    assert.equal(
      localResumeB.map.get('sess:bridge:1')?.nativeSessionId,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )

    const hydratedPrompt = await bridgeB.readPromptState('sess:bridge:1')
    assert.equal(hydratedPrompt.record?.inputsKey, 'inputs-sha-xyz')
    assert.equal(hydratedPrompt.record?.injectedAfterBaseline, 5)

    const hydratedCp = await bridgeB.peekRollingCheckpoint('sess:bridge:1')
    assert.equal(hydratedCp.hydratedFromAuthority, true)
    assert.equal(hydratedCp.localRecord?.generation, 'gen-001')
    assert.equal(
      localCheckpointB.map.get('sess:bridge:1')?.summary,
      'Anchored state before pool switch',
    )

    // Generation CAS ack: wrong generation must fail and keep checkpoint intact
    const badAck = await bridgeB.ackRollingCheckpoint({
      sessionKey: 'sess:bridge:1',
      checkpointGeneration: 'gen-wrong',
      turnKey: 'turn-1',
    })
    assert.equal(badAck.acked, false)
    assert.ok(localCheckpointB.map.get('sess:bridge:1'))

    // Matching generation atomically consumes checkpoint in both authority & local
    const goodAck = await bridgeB.ackRollingCheckpoint({
      sessionKey: 'sess:bridge:1',
      checkpointGeneration: 'gen-001',
      turnKey: 'turn-1',
    })
    assert.equal(goodAck.acked, true)
    assert.equal(goodAck.authorityAcked, true)
    assert.equal(goodAck.localAcked, true)
    assert.equal(localCheckpointB.map.get('sess:bridge:1'), undefined)

    // Container C rebuild AFTER ack must NOT re-hydrate the consumed checkpoint (zero double-injection)
    const bridgeC = new AuthorityStateBridge({
      tenantId: 'tenant-1',
      authorityStore,
      localCheckpointStore: makeLocalCheckpointAdapter().adapter,
    })
    const postAckPeek = await bridgeC.peekRollingCheckpoint('sess:bridge:1')
    assert.equal(postAckPeek.localRecord, null)
    assert.equal(postAckPeek.hydratedFromAuthority, false)
  })

  it('fails open to local cache when authority is unreachable, but fails closed on PLACEMENT_EPOCH_CONFLICT', async () => {
    const unreachableAuthority: SessionAuthorityStore = {
      getEpoch: async () => {
        throw new Error('ECONNREFUSED')
      },
      getPointer: async () => {
        throw new Error('ECONNREFUSED')
      },
      upsertPointer: async () => {
        throw new Error('ECONNREFUSED')
      },
      getLatestCheckpoint: async () => {
        throw new Error('ECONNREFUSED')
      },
      saveCheckpoint: async () => {
        throw new Error('ECONNREFUSED')
      },
      ackCheckpoint: async () => {
        throw new Error('ECONNREFUSED')
      },
      beginPlacementMigration: async () => {
        throw new Error('ECONNREFUSED')
      },
      commitPlacementMigration: async () => {
        throw new Error('ECONNREFUSED')
      },
      abortPlacementMigration: async () => {
        throw new Error('ECONNREFUSED')
      },
    }

    const localResume = makeLocalResumeAdapter()
    const localCp = makeLocalCheckpointAdapter()
    const degradedBridge = new AuthorityStateBridge({
      tenantId: 'tenant-1',
      authorityStore: unreachableAuthority,
      localResumeStore: localResume.adapter,
      localCheckpointStore: localCp.adapter,
    })

    const res = await degradedBridge.writePointer({
      sessionKey: 'sess:degraded:1',
      placementEpoch: 1,
      engine: 'ccb',
      nativeSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })
    assert.equal(res.authorityDegraded, true)
    assert.equal(
      localResume.map.get('sess:degraded:1')?.nativeSessionId,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    )
    assert.equal(degradedBridge.getMetrics().authorityWritesDegraded, 1)

    // Strict epoch CAS conflict must throw (fail-closed fencing)
    const liveAuthority = new InMemorySessionAuthorityStore()
    const strictBridge = new AuthorityStateBridge({
      tenantId: 'tenant-1',
      authorityStore: liveAuthority,
      localResumeStore: makeLocalResumeAdapter().adapter,
    })
    await strictBridge.writePointer({
      sessionKey: 'sess:fenced:1',
      placementEpoch: 2,
      expectedPlacementEpoch: 0,
      engine: 'codex',
      nativeSessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    })
    await assert.rejects(
      () =>
        strictBridge.writePointer({
          sessionKey: 'sess:fenced:1',
          placementEpoch: 3,
          expectedPlacementEpoch: 1,
          engine: 'codex',
          nativeSessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        }),
      (err: unknown) => err instanceof PlacementEpochConflictError,
    )
  })

  it('never fails open on PG authority conflict codes (SESSION_PLACEMENT_MIGRATING / SESSION_PLACEMENT_EPOCH_MISMATCH / CHECKPOINT_PLACEMENT_EPOCH_MISMATCH) and refreshes stale local cache epoch on read (Warning #1)', async () => {
    const pgConflictCodes = [
      'SESSION_PLACEMENT_MIGRATING',
      'SESSION_PLACEMENT_EPOCH_MISMATCH',
      'CHECKPOINT_PLACEMENT_EPOCH_MISMATCH',
    ] as const

    for (const conflictCode of pgConflictCodes) {
      const conflictingAuthority: SessionAuthorityStore = {
        getEpoch: async () => null,
        getPointer: async () => null,
        upsertPointer: async () => {
          throw new Error(conflictCode)
        },
        getLatestCheckpoint: async () => null,
        saveCheckpoint: async () => {
          throw new Error(conflictCode)
        },
        ackCheckpoint: async () => {
          throw new Error(conflictCode)
        },
        beginPlacementMigration: async () => {
          throw new Error(conflictCode)
        },
        commitPlacementMigration: async () => {
          throw new Error(conflictCode)
        },
        abortPlacementMigration: async () => {
          throw new Error(conflictCode)
        },
      }

      const localResume = makeLocalResumeAdapter()
      const localCp = makeLocalCheckpointAdapter()
      const localPrompt = makeLocalPromptStateAdapter()
      const bridge = new AuthorityStateBridge({
        tenantId: 'tenant-1',
        authorityStore: conflictingAuthority,
        localResumeStore: localResume.adapter,
        localCheckpointStore: localCp.adapter,
        localPromptState: localPrompt.adapter,
      })

      await assert.rejects(
        () =>
          bridge.writePointer({
            sessionKey: `sess:pg-conflict:${conflictCode}`,
            placementEpoch: 1,
            expectedPlacementEpoch: 1,
            engine: 'ccb',
            nativeSessionId: 'nat-blocked',
          }),
        (err: unknown) =>
          err instanceof PlacementEpochConflictError && err.authorityErrorCode === conflictCode,
      )
      assert.equal(localResume.map.get(`sess:pg-conflict:${conflictCode}`), undefined)

      await assert.rejects(
        () =>
          bridge.saveRollingCheckpoint({
            sessionKey: `sess:pg-conflict:${conflictCode}`,
            sessionId: 'sid-1',
            checkpointGeneration: 'gen-blocked',
            placementEpoch: 1,
            mode: 'anchored_v2',
            anchorSeq: 1,
            sourceEngine: 'ccb',
            summary: 'must not fail open',
          }),
        (err: unknown) =>
          err instanceof PlacementEpochConflictError && err.authorityErrorCode === conflictCode,
      )
      assert.equal(localCp.map.get(`sess:pg-conflict:${conflictCode}`), undefined)

      await assert.rejects(
        () =>
          bridge.writePromptState({
            engine: 'antigravity',
            placementEpoch: 1,
            expectedPlacementEpoch: 1,
            record: {
              v: 1,
              sessionKey: `sess:pg-conflict:${conflictCode}`,
              conversationId: 'conv-blocked',
              inputsKey: 'inputs-blocked',
              injectedAfterBaseline: 1,
              updatedAt: Date.now(),
            },
          }),
        (err: unknown) =>
          err instanceof PlacementEpochConflictError && err.authorityErrorCode === conflictCode,
      )
      assert.equal(localPrompt.map.get(`sess:pg-conflict:${conflictCode}`), undefined)
      assert.equal(
        bridge.getMetrics().authorityWritesDegraded,
        0,
        `${conflictCode} must never be counted as degraded network fallback`,
      )
    }

    // Stale local cache epoch refresh on readPointer & readPromptState when authority advances from epoch 1 -> 2
    const authorityStore = new InMemorySessionAuthorityStore()
    const localResumeA = makeLocalResumeAdapter()
    const localPromptA = makeLocalPromptStateAdapter()
    const bridgeA = new AuthorityStateBridge({
      tenantId: 'tenant-1',
      authorityStore,
      localResumeStore: localResumeA.adapter,
      localPromptState: localPromptA.adapter,
    })

    await bridgeA.writePointer({
      sessionKey: 'sess:stale-cache',
      placementEpoch: 1,
      expectedPlacementEpoch: 0,
      engine: 'antigravity',
      nativeSessionId: 'conv-epoch-1',
    })
    await bridgeA.writePromptState({
      engine: 'antigravity',
      placementEpoch: 1,
      expectedPlacementEpoch: 1,
      record: {
        v: 1,
        sessionKey: 'sess:stale-cache',
        conversationId: 'conv-epoch-1',
        inputsKey: 'inputs-epoch-1',
        injectedAfterBaseline: 2,
        updatedAt: Date.now(),
      },
    })

    // Another node migrates session to epoch 2 directly in authorityStore!
    await authorityStore.upsertPointer(
      'tenant-1',
      {
        sessionKey: 'sess:stale-cache',
        placementEpoch: 2,
        poolKind: 'remote_pool',
        engine: 'antigravity',
        nativeSessionId: 'conv-epoch-2',
        history: ['conv-epoch-1'],
        rejectedIds: [],
        promptCacheMeta: {
          conversationId: 'conv-epoch-2',
          inputsKey: 'inputs-epoch-2',
          injectedAfterBaseline: 9,
          placementEpoch: 2,
        },
        usageBaseline: null,
        historyContextVersion: null,
        promotedFromHistory: false,
        migrationState: 'active',
        activeMigrationId: null,
        updatedAt: new Date().toISOString(),
      },
      1,
    )

    // Node A still has epoch 1 in local cache; readPointer MUST detect stale epoch and force refresh!
    const refreshedPtr = await bridgeA.readPointer('sess:stale-cache')
    assert.equal(refreshedPtr.hydratedFromAuthority, true)
    assert.equal(refreshedPtr.pointer?.placementEpoch, 2)
    assert.equal(refreshedPtr.localEntry?.nativeSessionId, 'conv-epoch-2')
    assert.equal(localResumeA.map.get('sess:stale-cache')?.placementEpoch, 2)
    assert.equal(localResumeA.map.get('sess:stale-cache')?.nativeSessionId, 'conv-epoch-2')

    // Also verify readPromptState refreshes when local prompt-state lags behind authority epoch!
    localPromptA.map.set('sess:stale-cache', {
      v: 1,
      sessionKey: 'sess:stale-cache',
      conversationId: 'conv-epoch-1',
      inputsKey: 'inputs-epoch-1',
      injectedAfterBaseline: 2,
      placementEpoch: 1,
      updatedAt: Date.now(),
    })
    const refreshedPrompt = await bridgeA.readPromptState('sess:stale-cache')
    assert.equal(refreshedPrompt.hydratedFromAuthority, true)
    assert.equal(refreshedPrompt.record?.conversationId, 'conv-epoch-2')
    assert.equal(refreshedPrompt.record?.inputsKey, 'inputs-epoch-2')
    assert.equal(refreshedPrompt.record?.injectedAfterBaseline, 9)
    assert.equal(localPromptA.map.get('sess:stale-cache')?.placementEpoch, 2)
  })
})
