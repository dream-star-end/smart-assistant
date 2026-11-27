/**
 * OCV5-890 Wave 1B — Layer 1 Universal Cross-Engine State Capsule Store.
 *
 * Implements L0 `EngineStateCapsuleStore` and generalizes native state export/import
 * across all 6 engines via table-driven `Record<AuthorityEngineKind, EngineCapsuleAdapter>`:
 *   - Core: `ccb` (JSONL + cwd project dir relocation), `codex` (rollout JSONL + usage baseline),
 *           `antigravity` (SQLite `.db` + WAL checkpoint + `prompt-state` cache watermark)
 *   - Compatible: `grok`, `cursor` (SQLite), `zcode` (SQLite)
 *
 * Security & durability invariants:
 * - Zero `process.env`, zero `R3-special-case` engine equality checks.
 * - Staging copy with 5-tuple `fstat` anti-tear check; `finally` always cleans staging.
 * - Chunked upload (`initiateChunkedUpload` -> `putPart` -> `completeUpload`) to `ArtifactBlobStore`.
 * - Durable `restore-<nativeSessionId>.json` sentinel (`0o600` + fsync) kept on error/corruption
 *   for exit-73 write blocking via `hasPendingRestoreMarker`.
 * - Full Tier 1 -> Tier 1.5 -> Tier 2A -> Tier 2B -> Tier 3 resume ladder resolution.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import Database from 'better-sqlite3'
import {
  type ArtifactBlobKind,
  type ArtifactBlobPutInput,
  type ArtifactBlobRef,
  type ArtifactBlobStore,
  type AuthoritativeRollingCheckpoint,
  type AuthorityEngineKind,
  ENGINE_STATE_CAPSULE_MAX_BYTES,
  ENGINE_STATE_CAPSULE_MAX_FILES,
  type EngineStateCapsuleFileEntry,
  type EngineStateCapsuleManifest,
  type EngineStateCapsuleManifestBody,
  type EngineStateCapsulePortability,
  type EngineStateCapsuleRef,
  type EngineStateCapsuleStore,
  type ResumeLadderResult,
  computeEngineStateCapsuleId,
  isAllowedCapsuleLogicalPath,
  validateEngineStateCapsuleManifest,
} from '@openclaude/protocol/storage-seam'
import {
  type AnchoredV2HandoffPackage,
  type ColdDegradedSuffixResult,
  type NativeTranscriptArchiveResult,
  type TapeRecordInput,
  buildAnchoredV2HandoffPackage,
  buildColdDegradedSuffix,
  encodeCcbProjectDir,
  persistNativeTranscriptArchive,
  rebuildNativeTranscriptArchive,
} from './tapeWarmRebuilder.js'
import {
  checkImportNativeSessionOwnership,
  requireSessionOwnedPaths,
} from './capsuleSessionOwnership.js'

const DEFAULT_CHUNK_SIZE_BYTES = 4 * 1024 * 1024
const SQLITE_MAGIC = 'SQLite format 3\0'
const MAX_REJECTED_IDS_PER_SESSION = 32
const SQLITE_EXTENSIONS = ['.db', '.sqlite', '.sqlite3'] as const
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const

export interface ChunkedUploadSession {
  readonly uploadId: string
  readonly tenantId: string
  readonly kind: ArtifactBlobKind
  readonly filename: string
  readonly mimeType: string
  readonly expectedSizeBytes: number
  readonly chunkBytes: number
  readonly chunkCount: number
  readonly status: 'open'
  readonly containerRelativePath?: string
}

export interface ChunkedUploadPartReceipt {
  readonly uploadId: string
  readonly index: number
  readonly sizeBytes: number
  readonly sha256: string
  readonly status: 'recorded' | 'idempotent'
}

export interface ChunkedArtifactBlobStore extends ArtifactBlobStore {
  initiateChunkedUpload?(input: {
    readonly uploadId?: string
    readonly tenantId: string
    readonly kind: ArtifactBlobKind
    readonly filename: string
    readonly mimeType: string
    readonly expectedSizeBytes: number
    readonly chunkBytes?: number
    readonly containerRelativePath?: string
  }): Promise<ChunkedUploadSession>
  putPart?(input: {
    readonly uploadId: string
    readonly tenantId: string
    readonly index: number
    readonly bytes: Uint8Array
    readonly sha256: string
  }): Promise<ChunkedUploadPartReceipt>
  completeUpload?(input: {
    readonly uploadId: string
    readonly tenantId: string
    readonly expectedSha256?: string
    readonly blobId?: string
  }): Promise<ArtifactBlobRef>
  abortUpload?(tenantId: string, uploadId: string): Promise<void>
}

export type SqliteBusyPolicy = 'fail_closed' | 'vacuum_into'

export interface CapsulePromptCacheMeta {
  readonly stickyLaunchSlotKey?: string
  readonly inputsKey?: string
  readonly injectedAfterBaseline?: number
  readonly slotHashes?: Readonly<Record<string, string>>
  readonly conversationId?: string
  readonly [key: string]: unknown
}

export interface CapsuleSidecarMetadata {
  readonly manifest: EngineStateCapsuleManifest
  readonly principalId?: string
  readonly sourceCwd?: string
  readonly promptCacheMeta?: CapsulePromptCacheMeta | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
  readonly blobRefs: Readonly<Record<string, ArtifactBlobRef>>
}

export interface ExportCapsuleRequest {
  readonly tenantId: string
  readonly principalId?: string
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly engineVersion: string
  readonly placementEpoch: number
  readonly nativeSessionId?: string | null
  readonly sourceRoot: string
  readonly sourceCwd?: string
  readonly portability?: EngineStateCapsulePortability
  readonly promptCacheMeta?: CapsulePromptCacheMeta | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
  readonly sqliteWalCheckpoint?: (dbPath: string) => Promise<void> | void
  readonly sqliteBusyPolicy?: SqliteBusyPolicy
  readonly maxBytes?: number
  readonly maxFiles?: number
  readonly chunkSizeBytes?: number
  readonly createdAt?: string
  /** Optional test hook invoked after staging copy and before upload. */
  readonly beforeUpload?: () => Promise<void> | void
}

export interface ExportCapsuleResult {
  readonly manifest: EngineStateCapsuleManifest
  readonly ref: EngineStateCapsuleRef
  readonly blobRefs: Readonly<Record<string, ArtifactBlobRef>>
  readonly promptCacheMeta?: CapsulePromptCacheMeta | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
  readonly checkpointedSqlitePaths: readonly string[]
  readonly sqliteSnapshotStrategies?: Readonly<Record<string, 'wal_checkpoint' | 'vacuum_into'>>
}

export interface ImportCapsuleRequest {
  readonly tenantId: string
  readonly capsuleId: string
  readonly targetRoot: string
  readonly stateRoot?: string
  readonly expectedPrincipalId?: string
  readonly expectedSessionKey: string
  readonly expectedEngine: AuthorityEngineKind
  readonly expectedNativeSessionId?: string | null
  readonly targetEngineVersion?: string
  readonly targetCwd?: string
  readonly promptStateRoot?: string
  /** Optional cross-node manifest for importing into a fresh independent stateRoot. */
  readonly manifest?: EngineStateCapsuleManifest
  /** Optional blobId containing a serialized EngineStateCapsuleManifest or CapsuleSidecarMetadata. */
  readonly manifestBlobId?: string
  readonly principalId?: string
  readonly sourceCwd?: string
  readonly promptCacheMeta?: CapsulePromptCacheMeta | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
}

export interface RelocatedCapsulePath {
  readonly from: string
  readonly to: string
}

export type ImportCapsuleResult =
  | {
      readonly status: 'imported'
      readonly manifest: EngineStateCapsuleManifest
      readonly relocated: readonly RelocatedCapsulePath[]
      readonly promptCacheMeta?: CapsulePromptCacheMeta | null
      readonly usageBaseline?: Readonly<Record<string, number>> | null
      readonly promptStatePath?: string
    }
  | {
      readonly status: 'incompatible'
      readonly reason: string
    }
  | {
      readonly status: 'corrupt'
      readonly reason: string
      readonly restoreMarkerPath: string
    }
  | {
      readonly status: 'not_found'
      readonly reason: string
    }

export interface DegradeToTranscriptRequest {
  readonly tenantId: string
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly targetEngine?: AuthorityEngineKind
  readonly nativeSessionId: string
  readonly cwd: string
  readonly records: readonly TapeRecordInput[]
  readonly targetContextWindowTokens?: number
  readonly existingCheckpoint?: AuthoritativeRollingCheckpoint | null
  readonly ladderSteps?: readonly number[]
  readonly maxColdBytes?: number
  readonly sameEngineCompatible?: boolean
  readonly promptCacheMeta?: CapsulePromptCacheMeta | null
  readonly persistArchive?: boolean
  readonly reason?: string
}

export type DegradeToTranscriptResult =
  | {
      readonly tier: 'tape_rebuilt'
      readonly subTier: '2A'
      readonly archive: NativeTranscriptArchiveResult
      readonly archiveBlobRef?: ArtifactBlobRef
    }
  | {
      readonly tier: 'tape_rebuilt'
      readonly subTier: '2B'
      readonly handoff: AnchoredV2HandoffPackage
    }
  | {
      readonly tier: 'cold_degraded'
      readonly subTier: '3'
      readonly cold: ColdDegradedSuffixResult
    }

export interface ResolveResumeLadderRequest {
  readonly tenantId: string
  readonly sessionKey: string
  readonly placementEpoch: number
  readonly sourceEngine: AuthorityEngineKind
  readonly targetEngine: AuthorityEngineKind
  readonly targetEngineVersion?: string
  readonly nativeSessionId?: string | null
  readonly capsuleId?: string | null
  readonly capsuleManifest?: EngineStateCapsuleManifest
  readonly capsuleManifestBlobId?: string
  readonly targetRoot?: string
  readonly stateRoot?: string
  readonly targetCwd: string
  readonly promptStateRoot?: string
  readonly expectedPrincipalId?: string
  readonly hotNativeAvailable?: boolean
  readonly records?: readonly TapeRecordInput[]
  readonly targetContextWindowTokens?: number
  readonly existingCheckpoint?: AuthoritativeRollingCheckpoint | null
  readonly ladderSteps?: readonly number[]
  readonly maxColdBytes?: number
  readonly persistArchive?: boolean
}

export interface ResumeLadderResolution {
  readonly result: ResumeLadderResult
  readonly subTier: '1' | '1.5' | '2A' | '2B' | '3'
  readonly importedCapsule?: Extract<ImportCapsuleResult, { readonly status: 'imported' }>
  readonly archive?: NativeTranscriptArchiveResult
  readonly archiveBlobRef?: ArtifactBlobRef
  readonly handoff?: AnchoredV2HandoffPackage
  readonly cold?: ColdDegradedSuffixResult
}

export interface UniversalEngineStateCapsuleStoreOptions {
  readonly blobStore: ChunkedArtifactBlobStore
  readonly stateRoot: string
  readonly defaultSqliteWalCheckpoint?: (dbPath: string) => Promise<void> | void
  readonly defaultSqliteBusyPolicy?: SqliteBusyPolicy
  readonly defaultChunkSizeBytes?: number
}

interface EngineCapsuleAdapter {
  readonly defaultPortability: EngineStateCapsulePortability
  readonly isSqliteEngine: boolean
  readonly isSqliteFile: (logicalPath: string) => boolean
  readonly mimeTypeFor: (logicalPath: string) => string
  readonly relocatePath: (logicalPath: string, req: ImportCapsuleRequest) => string
  readonly postImport?: (
    req: ImportCapsuleRequest,
    envelope: CapsuleSidecarMetadata,
  ) => string | undefined
}

interface FileFingerprint {
  readonly dev: bigint
  readonly ino: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  )
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function syncDirectory(dirPath: string): void {
  const fd = openSync(dirPath, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function ensurePrivateDir(dirPath: string): void {
  if (!isAbsolute(dirPath)) {
    throw new Error('CAPSULE_ROOT_NOT_ABSOLUTE')
  }
  mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  const st = lstatSync(dirPath)
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error('CAPSULE_ROOT_UNSAFE')
  }
}

function assertSafeRootDir(rootDir: string, code: string): void {
  if (!isAbsolute(rootDir)) {
    throw new Error(`${code}_NOT_ABSOLUTE`)
  }
  const st = lstatSync(rootDir)
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`${code}_SYMLINK_OR_NOT_DIR`)
  }
  if (realpathSync(rootDir) !== rootDir) {
    throw new Error(`${code}_REALPATH_MISMATCH`)
  }
}

function statIfExists(targetPath: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(targetPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw err
  }
}

function safePathWithin(rootDir: string, logicalPath: string, createParents = false): string {
  if (
    logicalPath.length === 0 ||
    logicalPath.includes('\\') ||
    logicalPath.startsWith('/') ||
    logicalPath.split('/').some((seg) => seg.length === 0 || seg === '.' || seg === '..')
  ) {
    throw new Error(`CAPSULE_UNSAFE_PATH:${logicalPath}`)
  }
  const target = join(rootDir, logicalPath)
  if (relative(rootDir, target) !== logicalPath) {
    throw new Error(`CAPSULE_PATH_ESCAPE:${logicalPath}`)
  }

  let current = rootDir
  const segments = logicalPath.split('/')
  for (const seg of segments.slice(0, -1)) {
    current = join(current, seg)
    const st = statIfExists(current)
    if (!st) {
      if (!createParents) throw new Error(`CAPSULE_PARENT_MISSING:${logicalPath}`)
      mkdirSync(current, { mode: 0o700 })
      syncDirectory(current)
      syncDirectory(dirname(current))
    } else if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error(`CAPSULE_PATH_SYMLINK:${logicalPath}`)
    }
  }
  const targetStat = statIfExists(target)
  if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) {
    throw new Error(`CAPSULE_TARGET_SYMLINK:${logicalPath}`)
  }
  return target
}

function hasSqliteExtension(logicalPath: string): boolean {
  const lower = logicalPath.toLowerCase()
  return SQLITE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function isSqliteSidecar(logicalPath: string): boolean {
  const lower = logicalPath.toLowerCase()
  return SQLITE_SIDECAR_SUFFIXES.some((suffix) =>
    SQLITE_EXTENSIONS.some((ext) => lower.endsWith(`${ext}${suffix}`)),
  )
}

function defaultMimeTypeFor(logicalPath: string): string {
  const lower = logicalPath.toLowerCase()
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'application/x-ndjson'
  if (lower.endsWith('.json')) return 'application/json'
  if (hasSqliteExtension(lower)) return 'application/x-sqlite3'
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'text/plain'
  return 'application/octet-stream'
}

function isSqliteFileHeader(dbPath: string): boolean {
  const st = statIfExists(dbPath)
  if (!st || !st.isFile() || st.isSymbolicLink() || st.size < SQLITE_MAGIC.length) return false
  const fd = openSync(dbPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  const header = Buffer.alloc(SQLITE_MAGIC.length)
  try {
    const n = readSync(fd, header, 0, header.length, 0)
    return n >= SQLITE_MAGIC.length && header.toString('utf8') === SQLITE_MAGIC
  } finally {
    closeSync(fd)
  }
}

function isSqliteWalCheckpointBusyError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('CAPSULE_SQLITE_WAL_CHECKPOINT_BUSY')
}

function defaultSqliteWalCheckpoint(dbPath: string): void {
  if (!isSqliteFileHeader(dbPath)) return
  const db = new Database(dbPath, { timeout: 250 })
  try {
    const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      readonly busy?: unknown
      readonly log?: unknown
      readonly checkpointed?: unknown
    }>
    const row = Array.isArray(rows) ? rows[0] : undefined
    const busy = typeof row?.busy === 'number' ? row.busy : 1
    const log = typeof row?.log === 'number' ? row.log : 1
    const checkpointed = typeof row?.checkpointed === 'number' ? row.checkpointed : -1
    if (busy !== 0 || checkpointed < log) {
      throw new Error(
        `CAPSULE_SQLITE_WAL_CHECKPOINT_BUSY:busy=${busy},log=${log},checkpointed=${checkpointed}`,
      )
    }
  } finally {
    db.close()
  }
}

function snapshotSqliteViaVacuumInto(
  sourceDbPath: string,
  stagedPath: string,
): { readonly sha256: string; readonly sizeBytes: number } {
  const escapedTarget = stagedPath.replace(/'/g, "''")
  try {
    const db = new Database(sourceDbPath, { timeout: 5000 })
    try {
      db.exec(`VACUUM INTO '${escapedTarget}'`)
    } finally {
      db.close()
    }
    chmodSync(stagedPath, 0o600)
    const verifyDb = new Database(stagedPath, { readonly: true })
    try {
      const check = verifyDb.pragma('quick_check', { simple: true })
      if (check !== 'ok') {
        throw new Error(`integrity_check_failed:${String(check)}`)
      }
    } finally {
      verifyDb.close()
    }
    const fd = openSync(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const hash = createHash('sha256')
    const buf = Buffer.alloc(131072)
    let totalBytes = 0
    try {
      let n: number
      while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
        hash.update(buf.subarray(0, n))
        totalBytes += n
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    syncDirectory(dirname(stagedPath))
    return { sha256: hash.digest('hex'), sizeBytes: totalBytes }
  } catch (err) {
    try {
      if (existsSync(stagedPath)) unlinkSync(stagedPath)
    } catch {
      /* ignore cleanup error */
    }
    if (isSqliteWalCheckpointBusyError(err)) throw err
    throw new Error(
      `CAPSULE_SQLITE_WAL_CHECKPOINT_BUSY:vacuum_into_failed:${(err as Error).message}`,
    )
  }
}

function relocateCcbLogicalPath(logicalPath: string, req: ImportCapsuleRequest): string {
  if (!req.targetCwd) return logicalPath
  const parts = logicalPath.split('/')
  if (parts.length >= 3 && parts[0] === 'projects') {
    const newSlug = encodeCcbProjectDir(req.targetCwd)
    return ['projects', newSlug, ...parts.slice(2)].join('/')
  }
  return logicalPath
}

function writeAntigravityPromptStateOnImport(
  req: ImportCapsuleRequest,
  envelope: CapsuleSidecarMetadata,
): string | undefined {
  const meta = envelope.promptCacheMeta
  if (!meta) return undefined
  if (typeof meta.inputsKey !== 'string' || meta.inputsKey.length === 0) return undefined
  if (
    typeof meta.injectedAfterBaseline !== 'number' ||
    !Number.isFinite(meta.injectedAfterBaseline)
  ) {
    return undefined
  }
  const conversationId =
    (typeof meta.conversationId === 'string' && meta.conversationId.length > 0
      ? meta.conversationId
      : envelope.manifest.nativeSessionId) ?? ''
  if (!conversationId) return undefined

  const root = req.promptStateRoot ?? req.targetRoot
  assertSafeRootDir(root, 'CAPSULE_PROMPT_STATE_ROOT')
  const stateDir = join(root, 'prompt-state')
  ensurePrivateDir(stateDir)

  const fileName = `${sha256Hex(req.expectedSessionKey).slice(0, 32)}.json`
  const finalPath = safePathWithin(stateDir, fileName, false)
  const tmpPath = `${finalPath}.${randomUUID()}.tmp`

  const payload = {
    v: 1,
    sessionKey: req.expectedSessionKey,
    conversationId,
    inputsKey: meta.inputsKey,
    ...(meta.slotHashes ? { slotHashes: meta.slotHashes } : {}),
    injectedAfterBaseline: meta.injectedAfterBaseline,
    updatedAt: Date.now(),
  }

  const outFd = openSync(
    tmpPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const buf = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
    let offset = 0
    while (offset < buf.length) {
      offset += writeSync(outFd, buf, offset, buf.length - offset)
    }
    fsyncSync(outFd)
  } finally {
    closeSync(outFd)
  }
  renameSync(tmpPath, finalPath)
  syncDirectory(stateDir)
  return finalPath
}

const ENGINE_CAPSULE_ADAPTERS: Readonly<Record<AuthorityEngineKind, EngineCapsuleAdapter>> =
  Object.freeze({
    ccb: {
      defaultPortability: 'portable',
      isSqliteEngine: false,
      isSqliteFile: () => false,
      mimeTypeFor: defaultMimeTypeFor,
      relocatePath: relocateCcbLogicalPath,
    },
    codex: {
      defaultPortability: 'portable',
      isSqliteEngine: false,
      isSqliteFile: () => false,
      mimeTypeFor: defaultMimeTypeFor,
      relocatePath: (logicalPath) => logicalPath,
    },
    antigravity: {
      defaultPortability: 'same_engine_version',
      isSqliteEngine: true,
      isSqliteFile: hasSqliteExtension,
      mimeTypeFor: defaultMimeTypeFor,
      relocatePath: (logicalPath) => logicalPath,
      postImport: writeAntigravityPromptStateOnImport,
    },
    grok: {
      defaultPortability: 'portable',
      isSqliteEngine: false,
      isSqliteFile: () => false,
      mimeTypeFor: defaultMimeTypeFor,
      relocatePath: (logicalPath) => logicalPath,
    },
    cursor: {
      defaultPortability: 'same_engine_version',
      isSqliteEngine: true,
      isSqliteFile: hasSqliteExtension,
      mimeTypeFor: defaultMimeTypeFor,
      relocatePath: (logicalPath) => logicalPath,
    },
    zcode: {
      defaultPortability: 'same_engine_version',
      isSqliteEngine: true,
      isSqliteFile: hasSqliteExtension,
      mimeTypeFor: defaultMimeTypeFor,
      relocatePath: (logicalPath) => logicalPath,
    },
  })

function parseMajorVersion(version: string): number | null {
  const match = /^\s*v?(\d+)/i.exec(version)
  if (!match?.[1]) return null
  const major = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(major) ? major : null
}

function safeMarkerId(nativeSessionId: string): string {
  const trimmed = nativeSessionId.trim()
  if (/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) && !trimmed.includes('..')) {
    return trimmed
  }
  return sha256Hex(trimmed || 'default').slice(0, 32)
}

export function restoreMarkerPath(stateRoot: string, nativeSessionId: string): string {
  return join(stateRoot, `restore-${safeMarkerId(nativeSessionId)}.json`)
}

/**
 * Exit-73 guard: returns `true` whenever a durable restore sentinel exists
 * (file or symlink) so concurrent writers are blocked from dirty writes.
 */
export function hasPendingRestoreMarker(stateRoot: string, nativeSessionId: string): boolean {
  const marker = restoreMarkerPath(stateRoot, nativeSessionId)
  return statIfExists(marker) !== undefined
}

function writeRestoreMarker(stateRoot: string, nativeSessionId: string, capsuleId: string): string {
  ensurePrivateDir(stateRoot)
  const marker = restoreMarkerPath(stateRoot, nativeSessionId)
  const existing = statIfExists(marker)
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error('CAPSULE_RESTORE_MARKER_UNSAFE')
    }
    const parsed = JSON.parse(readFileSync(marker, 'utf8')) as { capsuleId?: string }
    if (parsed.capsuleId !== capsuleId) {
      throw new Error('CAPSULE_RESTORE_MARKER_CONFLICT')
    }
    return marker
  }
  const body = Buffer.from(
    `${JSON.stringify({ capsuleId, nativeSessionId, startedAt: new Date().toISOString() })}\n`,
    'utf8',
  )
  const fd = openSync(
    marker,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    let offset = 0
    while (offset < body.length) {
      offset += writeSync(fd, body, offset, body.length - offset)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(dirname(marker))
  return marker
}

function removeRestoreMarker(markerPath: string): void {
  unlinkSync(markerPath)
  syncDirectory(dirname(markerPath))
}

/**
 * Built-in in-memory `ChunkedArtifactBlobStore` implementation (supports both
 * single-shot `put` and chunked `initiateChunkedUpload` -> `putPart` -> `completeUpload`).
 */
export class InMemoryArtifactBlobStore implements ChunkedArtifactBlobStore {
  private readonly blobs = new Map<string, { ref: ArtifactBlobRef; bytes: Uint8Array }>()
  private readonly shaIndex = new Map<string, string>()
  private readonly uploads = new Map<
    string,
    {
      session: ChunkedUploadSession
      parts: Map<number, { bytes: Uint8Array; receipt: ChunkedUploadPartReceipt }>
    }
  >()

  chunkedUploadCalls = 0
  partUploadCalls = 0
  completeUploadCalls = 0

  private key(tenantId: string, blobId: string): string {
    return `${tenantId}::${blobId}`
  }

  private shaKey(tenantId: string, sha256: string): string {
    return `${tenantId}::sha::${sha256}`
  }

  async put(input: ArtifactBlobPutInput): Promise<ArtifactBlobRef> {
    const copy = new Uint8Array(input.bytes)
    const sha256 = sha256Hex(copy)
    const existingBlobId = this.shaIndex.get(this.shaKey(input.tenantId, sha256))
    if (existingBlobId) {
      const existing = this.blobs.get(this.key(input.tenantId, existingBlobId))
      if (existing) return existing.ref
    }
    const blobId = `blob_${randomUUID().replace(/-/g, '')}`
    const ref: ArtifactBlobRef = Object.freeze({
      blobId,
      tenantId: input.tenantId,
      sha256,
      sizeBytes: copy.byteLength,
      mimeType: input.mimeType,
      kind: input.kind,
      ...(input.logicalName ? { logicalName: input.logicalName } : {}),
      ...(input.containerRelativePath
        ? { containerRelativePath: input.containerRelativePath }
        : {}),
      storageBackend: 'local_cas',
      createdAt: new Date().toISOString(),
    })
    this.blobs.set(this.key(input.tenantId, blobId), { ref, bytes: copy })
    this.shaIndex.set(this.shaKey(input.tenantId, sha256), blobId)
    return ref
  }

  async initiateChunkedUpload(input: {
    readonly uploadId?: string
    readonly tenantId: string
    readonly kind: ArtifactBlobKind
    readonly filename: string
    readonly mimeType: string
    readonly expectedSizeBytes: number
    readonly chunkBytes?: number
    readonly containerRelativePath?: string
  }): Promise<ChunkedUploadSession> {
    this.chunkedUploadCalls += 1
    if (
      typeof input.filename !== 'string' ||
      input.filename.length === 0 ||
      input.filename.length > 256 ||
      /[\u0000-\u001F\u007F]/.test(input.filename)
    ) {
      throw new Error('BLOB_FILENAME_INVALID')
    }
    if (
      typeof input.expectedSizeBytes !== 'number' ||
      !Number.isSafeInteger(input.expectedSizeBytes) ||
      input.expectedSizeBytes < 0
    ) {
      throw new Error('BLOB_SIZE_LIMIT_EXCEEDED')
    }
    const chunkBytes = input.chunkBytes ?? DEFAULT_CHUNK_SIZE_BYTES
    if (typeof chunkBytes !== 'number' || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1024) {
      throw new Error('BLOB_CHUNK_BYTES_INVALID')
    }
    const chunkCount =
      input.expectedSizeBytes === 0 ? 1 : Math.ceil(input.expectedSizeBytes / chunkBytes)
    const uploadId = input.uploadId ?? `upl-${randomUUID()}`
    if (this.uploads.has(uploadId)) {
      throw new Error('BLOB_UPLOAD_ALREADY_EXISTS')
    }
    const session: ChunkedUploadSession = Object.freeze({
      uploadId,
      tenantId: input.tenantId,
      kind: input.kind,
      filename: input.filename,
      mimeType: input.mimeType,
      expectedSizeBytes: input.expectedSizeBytes,
      chunkBytes,
      chunkCount,
      status: 'open',
      ...(input.containerRelativePath
        ? { containerRelativePath: input.containerRelativePath }
        : {}),
    })
    this.uploads.set(uploadId, { session, parts: new Map() })
    return session
  }

  async putPart(input: {
    readonly uploadId: string
    readonly tenantId: string
    readonly index: number
    readonly bytes: Uint8Array
    readonly sha256: string
  }): Promise<ChunkedUploadPartReceipt> {
    this.partUploadCalls += 1
    const state = this.uploads.get(input.uploadId)
    if (!state || state.session.tenantId !== input.tenantId) {
      throw new Error('BLOB_UPLOAD_NOT_FOUND')
    }
    if (
      typeof input.index !== 'number' ||
      !Number.isSafeInteger(input.index) ||
      input.index < 0 ||
      input.index >= state.session.chunkCount
    ) {
      throw new Error('BLOB_PART_INDEX_OUT_OF_RANGE')
    }
    if (input.bytes.byteLength > state.session.chunkBytes) {
      throw new Error('BLOB_PART_SIZE_EXCEEDED')
    }
    if (typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)) {
      throw new Error('BLOB_PART_SHA256_INVALID')
    }
    const copy = new Uint8Array(input.bytes)
    const actualSha256 = sha256Hex(copy)
    if (actualSha256 !== input.sha256) {
      throw new Error('BLOB_PART_SHA256_MISMATCH')
    }
    const existing = state.parts.get(input.index)
    if (existing) {
      if (
        existing.receipt.sha256 === actualSha256 &&
        existing.receipt.sizeBytes === copy.byteLength
      ) {
        return Object.freeze({
          uploadId: input.uploadId,
          index: input.index,
          sizeBytes: copy.byteLength,
          sha256: actualSha256,
          status: 'idempotent',
        })
      }
      throw new Error('BLOB_PART_SHA256_MISMATCH')
    }
    let runningTotal = copy.byteLength
    for (const part of state.parts.values()) {
      runningTotal += part.receipt.sizeBytes
    }
    if (runningTotal > state.session.expectedSizeBytes) {
      throw new Error('BLOB_SIZE_LIMIT_EXCEEDED')
    }
    const receipt: ChunkedUploadPartReceipt = Object.freeze({
      uploadId: input.uploadId,
      index: input.index,
      sizeBytes: copy.byteLength,
      sha256: actualSha256,
      status: 'recorded',
    })
    state.parts.set(input.index, { bytes: copy, receipt })
    return receipt
  }

  async completeUpload(input: {
    readonly uploadId: string
    readonly tenantId: string
    readonly expectedSha256?: string
    readonly blobId?: string
  }): Promise<ArtifactBlobRef> {
    this.completeUploadCalls += 1
    const state = this.uploads.get(input.uploadId)
    if (!state || state.session.tenantId !== input.tenantId) {
      throw new Error('BLOB_UPLOAD_NOT_FOUND')
    }
    let totalBytes = 0
    const chunks: Uint8Array[] = []
    for (let index = 0; index < state.session.chunkCount; index += 1) {
      const stored = state.parts.get(index)
      if (!stored) {
        throw new Error('BLOB_UPLOAD_INCOMPLETE_PARTS')
      }
      chunks.push(stored.bytes)
      totalBytes += stored.bytes.byteLength
    }
    if (totalBytes !== state.session.expectedSizeBytes) {
      throw new Error('BLOB_UPLOAD_SIZE_MISMATCH')
    }
    const merged = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    const fullSha = sha256Hex(merged)
    if (input.expectedSha256 && fullSha !== input.expectedSha256) {
      throw new Error('BLOB_COMPLETE_SHA256_MISMATCH')
    }
    this.uploads.delete(input.uploadId)
    return this.put({
      tenantId: state.session.tenantId,
      kind: state.session.kind,
      mimeType: state.session.mimeType,
      bytes: merged,
      logicalName: state.session.filename,
      ...(state.session.containerRelativePath
        ? { containerRelativePath: state.session.containerRelativePath }
        : {}),
    })
  }

  async abortUpload(tenantId: string, uploadId: string): Promise<void> {
    const state = this.uploads.get(uploadId)
    if (state && state.session.tenantId === tenantId) {
      this.uploads.delete(uploadId)
    }
  }

  async getMetadata(tenantId: string, blobId: string): Promise<ArtifactBlobRef | null> {
    return this.blobs.get(this.key(tenantId, blobId))?.ref ?? null
  }

  async getBytes(tenantId: string, blobId: string): Promise<Uint8Array | null> {
    const entry = this.blobs.get(this.key(tenantId, blobId))
    return entry ? new Uint8Array(entry.bytes) : null
  }

  async headBySha256(tenantId: string, sha256: string): Promise<ArtifactBlobRef | null> {
    const blobId = this.shaIndex.get(this.shaKey(tenantId, sha256))
    if (!blobId) return null
    return this.getMetadata(tenantId, blobId)
  }

  async delete(tenantId: string, blobId: string): Promise<boolean> {
    const k = this.key(tenantId, blobId)
    const existing = this.blobs.get(k)
    if (!existing) return false
    this.blobs.delete(k)
    this.shaIndex.delete(this.shaKey(tenantId, existing.ref.sha256))
    return true
  }

  /** Test helper to simulate bit-rot or corrupted blob storage. */
  corruptBlobBytesForTest(tenantId: string, blobId: string, mutated: Uint8Array): void {
    const k = this.key(tenantId, blobId)
    const existing = this.blobs.get(k)
    if (!existing) throw new Error('BLOB_NOT_FOUND_FOR_CORRUPTION')
    this.blobs.set(k, { ref: existing.ref, bytes: new Uint8Array(mutated) })
  }
}

export class UniversalEngineStateCapsuleStore implements EngineStateCapsuleStore {
  private readonly blobStore: ChunkedArtifactBlobStore
  private readonly stateRoot: string
  private readonly indexDir: string
  private readonly stagingRoot: string
  private readonly defaultSqliteWalCheckpoint: (dbPath: string) => Promise<void> | void
  private readonly defaultSqliteBusyPolicy: SqliteBusyPolicy
  private readonly defaultChunkSizeBytes: number
  private readonly envelopes = new Map<string, CapsuleSidecarMetadata>()
  private readonly rejectedResumeIds = new Map<string, Set<string>>()

  constructor(options: UniversalEngineStateCapsuleStoreOptions) {
    this.blobStore = options.blobStore
    this.stateRoot = options.stateRoot
    ensurePrivateDir(this.stateRoot)
    this.indexDir = join(this.stateRoot, 'capsules')
    this.stagingRoot = join(this.stateRoot, 'staging')
    ensurePrivateDir(this.indexDir)
    ensurePrivateDir(this.stagingRoot)
    this.defaultSqliteWalCheckpoint =
      options.defaultSqliteWalCheckpoint ?? defaultSqliteWalCheckpoint
    this.defaultSqliteBusyPolicy = options.defaultSqliteBusyPolicy ?? 'vacuum_into'
    this.defaultChunkSizeBytes = Math.max(
      1024,
      options.defaultChunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES,
    )
  }

  private envelopeKey(tenantId: string, capsuleId: string): string {
    return `${tenantId}::${capsuleId}`
  }

  private indexFilePath(tenantId: string, capsuleId: string): string {
    const digest = sha256Hex(`${tenantId}:${capsuleId}`).slice(0, 40)
    return join(this.indexDir, `${digest}.json`)
  }

  private persistEnvelope(envelope: CapsuleSidecarMetadata): void {
    const key = this.envelopeKey(envelope.manifest.tenantId, envelope.manifest.capsuleId)
    this.envelopes.set(key, envelope)
    const targetPath = this.indexFilePath(envelope.manifest.tenantId, envelope.manifest.capsuleId)
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`
    const body = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8')
    const fd = openSync(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      let offset = 0
      while (offset < body.length) {
        offset += writeSync(fd, body, offset, body.length - offset)
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, targetPath)
    syncDirectory(this.indexDir)
  }

  private loadEnvelope(tenantId: string, capsuleId: string): CapsuleSidecarMetadata | null {
    const key = this.envelopeKey(tenantId, capsuleId)
    const cached = this.envelopes.get(key)
    if (cached) return cached
    const filePath = this.indexFilePath(tenantId, capsuleId)
    const st = statIfExists(filePath)
    if (!st || !st.isFile() || st.isSymbolicLink()) return null
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as CapsuleSidecarMetadata
      if (
        !parsed?.manifest ||
        parsed.manifest.tenantId !== tenantId ||
        parsed.manifest.capsuleId !== capsuleId
      ) {
        return null
      }
      this.envelopes.set(key, parsed)
      return parsed
    } catch {
      return null
    }
  }

  private async uploadFileChunked(input: {
    readonly tenantId: string
    readonly logicalPath: string
    readonly mimeType: string
    readonly stagedPath: string
    readonly expectedSizeBytes: number
    readonly expectedSha256: string
    readonly chunkSizeBytes: number
  }): Promise<ArtifactBlobRef> {
    const filename =
      input.logicalPath.length <= 256 ? input.logicalPath : input.logicalPath.slice(-256)
    if (
      this.blobStore.initiateChunkedUpload &&
      this.blobStore.putPart &&
      this.blobStore.completeUpload
    ) {
      const session = await this.blobStore.initiateChunkedUpload({
        tenantId: input.tenantId,
        kind: 'capsule_file',
        filename,
        mimeType: input.mimeType,
        expectedSizeBytes: input.expectedSizeBytes,
        chunkBytes: input.chunkSizeBytes,
        containerRelativePath: input.logicalPath,
      })
      const effectiveChunkBytes = Math.max(1024, session.chunkBytes || input.chunkSizeBytes)
      const fd = openSync(input.stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (input.expectedSizeBytes === 0) {
          const empty = new Uint8Array(0)
          await this.blobStore.putPart({
            uploadId: session.uploadId,
            tenantId: input.tenantId,
            index: 0,
            bytes: empty,
            sha256: sha256Hex(empty),
          })
        } else {
          const buffer = Buffer.alloc(Math.min(effectiveChunkBytes, input.expectedSizeBytes))
          let index = 0
          let remaining = input.expectedSizeBytes
          while (remaining > 0) {
            const want = Math.min(buffer.length, remaining)
            let filled = 0
            while (filled < want) {
              const n = readSync(fd, buffer, filled, want - filled, null)
              if (n <= 0) break
              filled += n
            }
            if (filled === 0) break
            const slice = new Uint8Array(buffer.subarray(0, filled))
            await this.blobStore.putPart({
              uploadId: session.uploadId,
              tenantId: input.tenantId,
              index,
              bytes: slice,
              sha256: sha256Hex(slice),
            })
            remaining -= filled
            index += 1
          }
        }
        return await this.blobStore.completeUpload({
          uploadId: session.uploadId,
          tenantId: input.tenantId,
          expectedSha256: input.expectedSha256,
        })
      } catch (err) {
        if (this.blobStore.abortUpload) {
          await this.blobStore.abortUpload(input.tenantId, session.uploadId).catch(() => {})
        }
        throw err
      } finally {
        closeSync(fd)
      }
    }

    const raw = readFileSync(input.stagedPath)
    return this.blobStore.put({
      tenantId: input.tenantId,
      kind: 'capsule_file',
      mimeType: input.mimeType,
      bytes: new Uint8Array(raw),
      logicalName: filename,
      containerRelativePath: input.logicalPath,
    })
  }

  /** L0 `EngineStateCapsuleStore.putCapsule`: validate manifest + persist blobs & index. */
  async putCapsule(
    manifest: EngineStateCapsuleManifest,
    files: ReadonlyMap<string, Uint8Array>,
  ): Promise<EngineStateCapsuleRef> {
    const validated = validateEngineStateCapsuleManifest(manifest)
    const adapter = ENGINE_CAPSULE_ADAPTERS[validated.engine]
    const blobRefs: Record<string, ArtifactBlobRef> = {}
    const updatedFiles: EngineStateCapsuleFileEntry[] = []

    for (const entry of validated.files) {
      const bytes = files.get(entry.logicalPath)
      if (!bytes) {
        throw new Error(`CAPSULE_MISSING_FILE_BYTES:${entry.logicalPath}`)
      }
      if (bytes.byteLength !== entry.sizeBytes || sha256Hex(bytes) !== entry.sha256) {
        throw new Error(`CAPSULE_FILE_DIGEST_MISMATCH:${entry.logicalPath}`)
      }
      const ref = await this.blobStore.put({
        tenantId: validated.tenantId,
        kind: 'capsule_file',
        mimeType: adapter.mimeTypeFor(entry.logicalPath),
        bytes,
        logicalName: entry.logicalPath,
        containerRelativePath: entry.logicalPath,
      })
      blobRefs[entry.logicalPath] = ref
      updatedFiles.push(entry)
    }

    const envelope: CapsuleSidecarMetadata = {
      manifest: validated,
      blobRefs,
    }
    this.persistEnvelope(envelope)

    return Object.freeze({
      capsuleId: validated.capsuleId,
      engine: validated.engine,
      portability: validated.portability,
      placementEpoch: validated.placementEpoch,
      totalBytes: validated.totalBytes,
      fileCount: updatedFiles.length,
      createdAt: validated.createdAt,
    })
  }

  async getManifest(
    tenantId: string,
    capsuleId: string,
  ): Promise<EngineStateCapsuleManifest | null> {
    const env = this.loadEnvelope(tenantId, capsuleId)
    return env ? env.manifest : null
  }

  async getFileBytes(
    tenantId: string,
    capsuleId: string,
    logicalPath: string,
  ): Promise<Uint8Array | null> {
    const env = this.loadEnvelope(tenantId, capsuleId)
    if (!env) return null
    const ref = env.blobRefs[logicalPath]
    const fileEntry = env.manifest.files.find((f) => f.logicalPath === logicalPath)
    const blobId = ref?.blobId ?? fileEntry?.blobId
    if (!blobId) return null
    return this.blobStore.getBytes(tenantId, blobId)
  }

  async deleteCapsule(tenantId: string, capsuleId: string): Promise<boolean> {
    const env = this.loadEnvelope(tenantId, capsuleId)
    if (!env) return false
    this.envelopes.delete(this.envelopeKey(tenantId, capsuleId))
    const filePath = this.indexFilePath(tenantId, capsuleId)
    try {
      if (existsSync(filePath)) unlinkSync(filePath)
    } catch {
      /* ignore */
    }
    return true
  }

  private collectAllowedFiles(
    sourceRoot: string,
    engine: AuthorityEngineKind,
    maxFiles: number,
  ): string[] {
    const discovered: string[] = []
    const walk = (relPrefix: string): void => {
      const absDir = relPrefix ? join(sourceRoot, relPrefix) : sourceRoot
      for (const entry of readdirSync(absDir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          walk(relPath)
          continue
        }
        if (!entry.isFile()) continue
        if (isSqliteSidecar(relPath)) continue
        if (!isAllowedCapsuleLogicalPath(engine, relPath)) continue
        discovered.push(relPath)
        if (discovered.length > maxFiles) {
          throw new Error('STORAGE_CAPSULE_TOO_MANY_FILES')
        }
      }
    }
    walk('')
    return discovered.sort()
  }

  /**
   * Export an immutable, verified cross-engine state capsule from `sourceRoot`:
   * 1. Validates non-symlink absolute `sourceRoot`.
   * 2. Runs SQLite WAL checkpoint truncation for SQLite engines before capture.
   * 3. Scans only whitelisted non-symlink regular files within byte/count bounds.
   * 4. Copies into `staging/<exportId>/` with 5-tuple `fstat` anti-tear checks.
   * 5. Uploads each staged file via chunked `ArtifactBlobStore` API.
   * 6. Computes & validates `EngineStateCapsuleManifest`, persists index, cleans staging.
   */
  async exportCapsule(req: ExportCapsuleRequest): Promise<ExportCapsuleResult> {
    assertSafeRootDir(req.sourceRoot, 'CAPSULE_SOURCE_ROOT')
    const adapter = ENGINE_CAPSULE_ADAPTERS[req.engine]
    if (!adapter) {
      throw new Error(`CAPSULE_UNSUPPORTED_ENGINE:${String(req.engine)}`)
    }

    const maxBytes = Math.min(
      req.maxBytes ?? ENGINE_STATE_CAPSULE_MAX_BYTES,
      ENGINE_STATE_CAPSULE_MAX_BYTES,
    )
    const maxFiles = Math.min(
      req.maxFiles ?? ENGINE_STATE_CAPSULE_MAX_FILES,
      ENGINE_STATE_CAPSULE_MAX_FILES,
    )
    const chunkSizeBytes = Math.max(1024, req.chunkSizeBytes ?? this.defaultChunkSizeBytes)
    const logicalPaths = requireSessionOwnedPaths(this.collectAllowedFiles(req.sourceRoot, req.engine, maxFiles), req.nativeSessionId)
    const busyPolicy: SqliteBusyPolicy = req.sqliteBusyPolicy ?? this.defaultSqliteBusyPolicy
    const checkpointedSqlitePaths: string[] = []
    const sqliteSnapshotStrategies: Record<string, 'wal_checkpoint' | 'vacuum_into'> = {}
    const vacuumIntoPaths = new Set<string>()
    if (adapter.isSqliteEngine) {
      const checkpointFn = req.sqliteWalCheckpoint ?? this.defaultSqliteWalCheckpoint
      for (const relPath of logicalPaths) {
        if (!adapter.isSqliteFile(relPath)) continue
        const absDbPath = safePathWithin(req.sourceRoot, relPath, false)
        try {
          await checkpointFn(absDbPath)
          if (req.sqliteWalCheckpoint) {
            defaultSqliteWalCheckpoint(absDbPath)
          }
          checkpointedSqlitePaths.push(relPath)
          sqliteSnapshotStrategies[relPath] = 'wal_checkpoint'
        } catch (err) {
          if (!isSqliteWalCheckpointBusyError(err) || busyPolicy === 'fail_closed') {
            throw err
          }
          vacuumIntoPaths.add(relPath)
        }
      }
    }

    const exportId = randomUUID()
    const stagingDir = join(this.stagingRoot, exportId)
    mkdirSync(stagingDir, { mode: 0o700 })

    try {
      const fingerprints = new Map<string, FileFingerprint>()
      const stagedEntries: Array<{
        readonly logicalPath: string
        readonly stagedPath: string
        readonly sha256: string
        readonly sizeBytes: number
        readonly mode: number
        readonly isSqlite: boolean
      }> = []
      let totalBytes = 0

      for (const relPath of logicalPaths) {
        const sourcePath = safePathWithin(req.sourceRoot, relPath, false)
        const before = lstatSync(sourcePath, { bigint: true })
        if (!before.isFile() || before.isSymbolicLink()) continue

        if (vacuumIntoPaths.has(relPath)) {
          const stagedPath = safePathWithin(stagingDir, relPath, true)
          const snap = snapshotSqliteViaVacuumInto(sourcePath, stagedPath)
          totalBytes += snap.sizeBytes
          if (totalBytes > maxBytes) {
            throw new Error('STORAGE_CAPSULE_SIZE_EXCEEDED')
          }
          checkpointedSqlitePaths.push(relPath)
          sqliteSnapshotStrategies[relPath] = 'vacuum_into'
          stagedEntries.push({
            logicalPath: relPath,
            stagedPath,
            sha256: snap.sha256,
            sizeBytes: snap.sizeBytes,
            mode: Number(before.mode & 0o777n),
            isSqlite: true,
          })
          continue
        }

        const fileSizeNum = Number(before.size)
        totalBytes += fileSizeNum
        if (totalBytes > maxBytes) {
          throw new Error('STORAGE_CAPSULE_SIZE_EXCEEDED')
        }

        const stagedPath = safePathWithin(stagingDir, relPath, true)
        const inFd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const outFd = openSync(
          stagedPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        const hash = createHash('sha256')
        const copyBuf = Buffer.alloc(131072)
        let copiedBytes = 0
        try {
          if (!sameFingerprint(before, fstatSync(inFd, { bigint: true }))) {
            throw new Error(`CAPSULE_SOURCE_CHANGED:${relPath}`)
          }
          let n: number
          while ((n = readSync(inFd, copyBuf, 0, copyBuf.length, null)) > 0) {
            hash.update(copyBuf.subarray(0, n))
            copiedBytes += n
            let offset = 0
            while (offset < n) {
              offset += writeSync(outFd, copyBuf, offset, n - offset)
            }
          }
          fsyncSync(outFd)
          if (
            BigInt(copiedBytes) !== before.size ||
            !sameFingerprint(before, fstatSync(inFd, { bigint: true }))
          ) {
            throw new Error(`CAPSULE_SOURCE_CHANGED:${relPath}`)
          }
        } finally {
          closeSync(inFd)
          closeSync(outFd)
        }

        fingerprints.set(relPath, before)
        stagedEntries.push({
          logicalPath: relPath,
          stagedPath,
          sha256: hash.digest('hex'),
          sizeBytes: copiedBytes,
          mode: Number(before.mode & 0o777n),
          isSqlite: adapter.isSqliteFile(relPath),
        })
      }

      if (req.beforeUpload) {
        await req.beforeUpload()
      }

      // Final 5-tuple stability re-check against source files before uploading.
      for (const [relPath, before] of fingerprints) {
        const sourcePath = safePathWithin(req.sourceRoot, relPath, false)
        const after = lstatSync(sourcePath, { bigint: true })
        if (!sameFingerprint(before, after)) {
          throw new Error(`CAPSULE_SOURCE_CHANGED:${relPath}`)
        }
      }

      const blobRefs: Record<string, ArtifactBlobRef> = {}
      const manifestFiles: EngineStateCapsuleFileEntry[] = []

      for (const item of stagedEntries) {
        const ref = await this.uploadFileChunked({
          tenantId: req.tenantId,
          logicalPath: item.logicalPath,
          mimeType: adapter.mimeTypeFor(item.logicalPath),
          stagedPath: item.stagedPath,
          expectedSizeBytes: item.sizeBytes,
          expectedSha256: item.sha256,
          chunkSizeBytes,
        })
        blobRefs[item.logicalPath] = ref
        manifestFiles.push(
          Object.freeze({
            logicalPath: item.logicalPath,
            sha256: item.sha256,
            sizeBytes: item.sizeBytes,
            blobId: ref.blobId,
            mode: item.mode,
            ...(item.isSqlite ? { isSqlite: true } : {}),
          }),
        )
      }

      const createdAt = req.createdAt ?? new Date().toISOString()
      const manifestBody: EngineStateCapsuleManifestBody = {
        schemaVersion: 1,
        tenantId: req.tenantId,
        sessionKey: req.sessionKey,
        engine: req.engine,
        engineVersion: req.engineVersion,
        portability: req.portability ?? adapter.defaultPortability,
        placementEpoch: req.placementEpoch,
        ...(req.nativeSessionId !== undefined ? { nativeSessionId: req.nativeSessionId } : {}),
        totalBytes,
        files: Object.freeze(manifestFiles),
        createdAt,
      }

      const capsuleId = computeEngineStateCapsuleId(manifestBody)
      const manifest = validateEngineStateCapsuleManifest({
        ...manifestBody,
        capsuleId,
      })

      const envelope: CapsuleSidecarMetadata = {
        manifest,
        ...(req.principalId ? { principalId: req.principalId } : {}),
        ...(req.sourceCwd ? { sourceCwd: req.sourceCwd } : {}),
        ...(req.promptCacheMeta !== undefined ? { promptCacheMeta: req.promptCacheMeta } : {}),
        ...(req.usageBaseline !== undefined ? { usageBaseline: req.usageBaseline } : {}),
        blobRefs,
      }
      this.persistEnvelope(envelope)

      const ref: EngineStateCapsuleRef = Object.freeze({
        capsuleId: manifest.capsuleId,
        engine: manifest.engine,
        portability: manifest.portability,
        placementEpoch: manifest.placementEpoch,
        totalBytes: manifest.totalBytes,
        fileCount: manifest.files.length,
        createdAt: manifest.createdAt,
      })

      return {
        manifest,
        ref,
        blobRefs,
        promptCacheMeta: envelope.promptCacheMeta ?? null,
        usageBaseline: envelope.usageBaseline ?? null,
        checkpointedSqlitePaths,
        ...(Object.keys(sqliteSnapshotStrategies).length > 0 ? { sqliteSnapshotStrategies } : {}),
      }
    } finally {
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true })
      }
    }
  }

  /**
   * Import a previously exported state capsule into `targetRoot`:
   * 1. Resolves envelope from local stateRoot index, explicit cross-node `req.manifest`,
   *    or shared `req.manifestBlobId` (enabling zero-source-index cross-host restore).
   * 2. Verifies principal/sessionKey/engine/nativeSessionId identity & major-version compatibility.
   * 3. Persists durable `restore-<nativeSessionId>.json` sentinel (`0o600` + fsync) BEFORE writes.
   * 4. Fetches and verifies SHA-256 of EVERY blob before modifying `targetRoot`; on corruption,
   *    keeps the restore marker and returns `{ status: 'corrupt' }`.
   * 5. Applies engine-specific path relocation & post-import hooks (e.g. CCB cwd dir, AGY prompt-state).
   * 6. Atomically removes the restore marker only after all writes are fsynced.
   */
  async importCapsule(req: ImportCapsuleRequest): Promise<ImportCapsuleResult> {
    let envelope = this.loadEnvelope(req.tenantId, req.capsuleId)
    if (!envelope && req.manifest) {
      let providedManifest: EngineStateCapsuleManifest
      try {
        providedManifest = validateEngineStateCapsuleManifest(req.manifest)
      } catch (err) {
        return {
          status: 'incompatible',
          reason: `manifest_invalid:${(err as Error).message}`,
        }
      }
      if (providedManifest.capsuleId !== req.capsuleId) {
        return { status: 'incompatible', reason: 'capsule_id_mismatch' }
      }
      envelope = {
        manifest: providedManifest,
        ...(req.principalId ? { principalId: req.principalId } : {}),
        ...(req.sourceCwd ? { sourceCwd: req.sourceCwd } : {}),
        ...(req.promptCacheMeta !== undefined ? { promptCacheMeta: req.promptCacheMeta } : {}),
        ...(req.usageBaseline !== undefined ? { usageBaseline: req.usageBaseline } : {}),
        blobRefs: {},
      }
    } else if (!envelope && req.manifestBlobId) {
      const rawBytes = await this.blobStore.getBytes(req.tenantId, req.manifestBlobId)
      if (rawBytes) {
        try {
          const parsed = JSON.parse(Buffer.from(rawBytes).toString('utf8')) as
            | CapsuleSidecarMetadata
            | EngineStateCapsuleManifest
          const rawManifest = 'manifest' in parsed ? parsed.manifest : parsed
          const validated = validateEngineStateCapsuleManifest(rawManifest)
          if (validated.capsuleId !== req.capsuleId) {
            return { status: 'incompatible', reason: 'capsule_id_mismatch' }
          }
          const sidecar = 'manifest' in parsed ? parsed : undefined
          envelope = {
            manifest: validated,
            ...(req.principalId ?? sidecar?.principalId
              ? { principalId: req.principalId ?? sidecar?.principalId }
              : {}),
            ...(req.sourceCwd ?? sidecar?.sourceCwd
              ? { sourceCwd: req.sourceCwd ?? sidecar?.sourceCwd }
              : {}),
            ...(req.promptCacheMeta !== undefined
              ? { promptCacheMeta: req.promptCacheMeta }
              : sidecar?.promptCacheMeta !== undefined
                ? { promptCacheMeta: sidecar.promptCacheMeta }
                : {}),
            ...(req.usageBaseline !== undefined
              ? { usageBaseline: req.usageBaseline }
              : sidecar?.usageBaseline !== undefined
                ? { usageBaseline: sidecar.usageBaseline }
                : {}),
            blobRefs: sidecar?.blobRefs ?? {},
          }
        } catch (err) {
          return {
            status: 'incompatible',
            reason: `manifest_invalid:${(err as Error).message}`,
          }
        }
      }
    }
    if (!envelope) {
      return { status: 'not_found', reason: 'capsule_not_found' }
    }

    let manifest: EngineStateCapsuleManifest
    try {
      manifest = validateEngineStateCapsuleManifest(envelope.manifest)
    } catch (err) {
      return {
        status: 'incompatible',
        reason: `manifest_invalid:${(err as Error).message}`,
      }
    }

    if (manifest.tenantId !== req.tenantId) {
      return { status: 'incompatible', reason: 'tenant_mismatch' }
    }
    if (manifest.sessionKey !== req.expectedSessionKey) {
      return { status: 'incompatible', reason: 'session_key_mismatch' }
    }
    if (manifest.engine !== req.expectedEngine) {
      return { status: 'incompatible', reason: 'engine_mismatch' }
    }
    if (
      req.expectedPrincipalId &&
      envelope.principalId &&
      envelope.principalId !== req.expectedPrincipalId
    ) {
      return { status: 'incompatible', reason: 'principal_mismatch' }
    }
    const adapter = ENGINE_CAPSULE_ADAPTERS[manifest.engine]
    const ownershipErr = checkImportNativeSessionOwnership(manifest, req.expectedNativeSessionId, (p) => adapter.relocatePath(p, req))
    if (ownershipErr) {
      return { status: 'incompatible', reason: ownershipErr }
    }
    if (manifest.portability === 'non_portable') {
      return { status: 'incompatible', reason: 'capsule_non_portable' }
    }
    if (req.targetEngineVersion) {
      const srcMajor = parseMajorVersion(manifest.engineVersion)
      const dstMajor = parseMajorVersion(req.targetEngineVersion)
      if (srcMajor !== null && dstMajor !== null && srcMajor !== dstMajor) {
        return {
          status: 'incompatible',
          reason: `engine_major_version_mismatch:${manifest.engineVersion}->${req.targetEngineVersion}`,
        }
      }
    }

    assertSafeRootDir(req.targetRoot, 'CAPSULE_TARGET_ROOT')
    const effectiveStateRoot = req.stateRoot ?? this.stateRoot
    const markerKey = req.expectedNativeSessionId ?? manifest.nativeSessionId ?? manifest.sessionKey
    const markerPath = writeRestoreMarker(effectiveStateRoot, markerKey, manifest.capsuleId)

    // Materialize and verify ALL blobs BEFORE overwriting any target file.
    const verifiedPayloads: Array<{
      readonly entry: EngineStateCapsuleFileEntry
      readonly bytes: Uint8Array
    }> = []

    for (const entry of manifest.files) {
      const blobId = envelope.blobRefs[entry.logicalPath]?.blobId ?? entry.blobId
      if (!blobId) {
        return {
          status: 'corrupt',
          reason: `missing_blob_id:${entry.logicalPath}`,
          restoreMarkerPath: markerPath,
        }
      }
      const bytes = await this.blobStore.getBytes(req.tenantId, blobId)
      if (!bytes) {
        return {
          status: 'corrupt',
          reason: `blob_missing:${entry.logicalPath}`,
          restoreMarkerPath: markerPath,
        }
      }
      if (bytes.byteLength !== entry.sizeBytes) {
        return {
          status: 'corrupt',
          reason: `blob_size_mismatch:${entry.logicalPath}`,
          restoreMarkerPath: markerPath,
        }
      }
      const actualSha = sha256Hex(bytes)
      if (actualSha !== entry.sha256) {
        return {
          status: 'corrupt',
          reason: `blob_sha256_mismatch:${entry.logicalPath}`,
          restoreMarkerPath: markerPath,
        }
      }
      verifiedPayloads.push({ entry, bytes })
    }

    const relocated: RelocatedCapsulePath[] = []

    for (const { entry, bytes } of verifiedPayloads) {
      const destLogicalPath = adapter.relocatePath(entry.logicalPath, req)
      if (!isAllowedCapsuleLogicalPath(manifest.engine, destLogicalPath)) {
        throw new Error(`CAPSULE_RELOCATED_PATH_FORBIDDEN:${destLogicalPath}`)
      }
      if (destLogicalPath !== entry.logicalPath) {
        relocated.push({ from: entry.logicalPath, to: destLogicalPath })
      }
      const targetPath = safePathWithin(req.targetRoot, destLogicalPath, true)
      const tmpPath = `${targetPath}.capsule-${randomUUID()}.tmp`
      const outFd = openSync(
        tmpPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        entry.mode && entry.mode > 0 ? entry.mode & 0o666 : 0o600,
      )
      try {
        let offset = 0
        while (offset < bytes.byteLength) {
          offset += writeSync(outFd, bytes, offset, bytes.byteLength - offset)
        }
        fsyncSync(outFd)
      } finally {
        closeSync(outFd)
      }
      renameSync(tmpPath, targetPath)
      syncDirectory(dirname(targetPath))
    }

    const promptStatePath = adapter.postImport?.(req, envelope)

    // Only remove sentinel marker after every file + post-import hook is durable.
    removeRestoreMarker(markerPath)

    return {
      status: 'imported',
      manifest,
      relocated,
      promptCacheMeta: envelope.promptCacheMeta ?? null,
      usageBaseline: envelope.usageBaseline ?? null,
      ...(promptStatePath ? { promptStatePath } : {}),
    }
  }

  /** Record a native resume ID rejected by an engine so Tier 1 skips it. */
  recordRejectedResumeId(sessionKey: string, nativeSessionId: string): void {
    const trimmed = nativeSessionId.trim()
    if (!trimmed) return
    const set = this.rejectedResumeIds.get(sessionKey) ?? new Set<string>()
    set.add(trimmed)
    if (set.size > MAX_REJECTED_IDS_PER_SESSION) {
      const oldest = set.values().next().value
      if (oldest !== undefined) set.delete(oldest)
    }
    this.rejectedResumeIds.set(sessionKey, set)
  }

  getRejectedResumeIds(sessionKey: string): readonly string[] {
    return [...(this.rejectedResumeIds.get(sessionKey) ?? [])]
  }

  isRejectedResumeId(sessionKey: string, nativeSessionId: string | null | undefined): boolean {
    if (!nativeSessionId) return false
    return this.rejectedResumeIds.get(sessionKey)?.has(nativeSessionId) ?? false
  }

  /**
   * Degrade seamlessly from capsule to Tier 2A (same-engine deterministic transcript
   * archive), Tier 2B (cross-engine / major-version `anchored_v2`), or Tier 3 (cold).
   */
  async degradeToTranscript(req: DegradeToTranscriptRequest): Promise<DegradeToTranscriptResult> {
    const targetEngine = req.targetEngine ?? req.engine
    const sameEngine = targetEngine === req.engine
    const canTier2A = sameEngine && req.sameEngineCompatible !== false && req.records.length > 0

    if (canTier2A) {
      const archive = rebuildNativeTranscriptArchive({
        engine: targetEngine,
        nativeSessionId: req.nativeSessionId,
        cwd: req.cwd,
        records: req.records,
        promptCacheMeta: req.promptCacheMeta ?? null,
      })
      const archiveBlobRef =
        req.persistArchive !== false
          ? await persistNativeTranscriptArchive(this.blobStore, req.tenantId, archive)
          : undefined
      return {
        tier: 'tape_rebuilt',
        subTier: '2A',
        archive,
        ...(archiveBlobRef ? { archiveBlobRef } : {}),
      }
    }

    if (req.records.length > 0 || req.existingCheckpoint) {
      const handoff = buildAnchoredV2HandoffPackage({
        records: req.records,
        targetContextWindowTokens: req.targetContextWindowTokens ?? 128_000,
        existingCheckpoint: req.existingCheckpoint ?? null,
      })
      return {
        tier: 'tape_rebuilt',
        subTier: '2B',
        handoff,
      }
    }

    const cold = buildColdDegradedSuffix({
      records: req.records,
      ladderSteps: req.ladderSteps,
      maxBytes: req.maxColdBytes ?? 8192,
      reason: req.reason ?? 'no_transcript_records_available',
      sessionKey: req.sessionKey,
      engine: targetEngine,
    })
    return {
      tier: 'cold_degraded',
      subTier: '3',
      cold,
    }
  }

  /**
   * Full resume ladder orchestrator:
   *   Tier 1   (`hot_native`)    -> local native state intact & not rejected & no restore marker
   *   Tier 1.5 (`warm_capsule`)  -> cross-pool/rebuilt state capsule import
   *   Tier 2A  (`tape_rebuilt`)  -> same-engine deterministic transcript rebuild
   *   Tier 2B  (`tape_rebuilt`)  -> cross-engine / major-version `anchored_v2` handoff
   *   Tier 3   (`cold_degraded`) -> `[4, 16, 64]` suffix + `sys.context_rebuilt` notice
   */
  async resolveResumeLadder(req: ResolveResumeLadderRequest): Promise<ResumeLadderResolution> {
    const effectiveStateRoot = req.stateRoot ?? this.stateRoot
    const sameEngine = req.sourceEngine === req.targetEngine
    const rejected = this.isRejectedResumeId(req.sessionKey, req.nativeSessionId)
    const pendingMarker = req.nativeSessionId
      ? hasPendingRestoreMarker(effectiveStateRoot, req.nativeSessionId)
      : false

    // Tier 1: Hot Native
    if (
      sameEngine &&
      req.hotNativeAvailable &&
      req.nativeSessionId &&
      !rejected &&
      !pendingMarker
    ) {
      return {
        subTier: '1',
        result: {
          tier: 'hot_native',
          sessionKey: req.sessionKey,
          placementEpoch: req.placementEpoch,
          engine: req.targetEngine,
          nativeSessionId: req.nativeSessionId,
          capsuleId: req.capsuleId ?? null,
          checkpointGeneration: req.existingCheckpoint?.checkpointGeneration ?? null,
          degradedReason: null,
        },
      }
    }

    let degradedReason: string | null = rejected
      ? 'native_session_rejected'
      : pendingMarker
        ? 'pending_restore_marker'
        : !sameEngine
          ? 'cross_engine_switch'
          : 'hot_native_unavailable'
    let majorVersionIncompatible = false

    // Tier 1.5: Warm Capsule
    if (sameEngine && req.capsuleId && req.targetRoot && !rejected) {
      const imported = await this.importCapsule({
        tenantId: req.tenantId,
        capsuleId: req.capsuleId,
        targetRoot: req.targetRoot,
        stateRoot: effectiveStateRoot,
        expectedPrincipalId: req.expectedPrincipalId,
        expectedSessionKey: req.sessionKey,
        expectedEngine: req.targetEngine,
        expectedNativeSessionId: req.nativeSessionId ?? undefined,
        targetEngineVersion: req.targetEngineVersion,
        targetCwd: req.targetCwd,
        promptStateRoot: req.promptStateRoot,
        ...(req.capsuleManifest ? { manifest: req.capsuleManifest } : {}),
        ...(req.capsuleManifestBlobId ? { manifestBlobId: req.capsuleManifestBlobId } : {}),
      })

      if (imported.status === 'imported') {
        return {
          subTier: '1.5',
          importedCapsule: imported,
          result: {
            tier: 'warm_capsule',
            sessionKey: req.sessionKey,
            placementEpoch: req.placementEpoch,
            engine: req.targetEngine,
            nativeSessionId: imported.manifest.nativeSessionId ?? req.nativeSessionId ?? null,
            capsuleId: imported.manifest.capsuleId,
            checkpointGeneration: req.existingCheckpoint?.checkpointGeneration ?? null,
            degradedReason: null,
          },
        }
      }

      degradedReason = `capsule_${imported.status}:${imported.reason}`
      if (
        imported.status === 'incompatible' &&
        imported.reason.startsWith('engine_major_version_mismatch')
      ) {
        majorVersionIncompatible = true
      }
    }

    const records = req.records ?? []
    // Tier 2A / 2B via degradeToTranscript
    if (records.length > 0 || req.existingCheckpoint) {
      const degraded = await this.degradeToTranscript({
        tenantId: req.tenantId,
        sessionKey: req.sessionKey,
        engine: req.sourceEngine,
        targetEngine: req.targetEngine,
        nativeSessionId: req.nativeSessionId ?? `rebuilt-${req.sessionKey}`,
        cwd: req.targetCwd,
        records,
        targetContextWindowTokens: req.targetContextWindowTokens,
        existingCheckpoint: req.existingCheckpoint,
        ladderSteps: req.ladderSteps,
        maxColdBytes: req.maxColdBytes,
        sameEngineCompatible: sameEngine && !majorVersionIncompatible,
        persistArchive: req.persistArchive,
        reason: degradedReason ?? undefined,
      })

      if (degraded.tier === 'tape_rebuilt') {
        if (degraded.subTier === '2A') {
          return {
            subTier: '2A',
            archive: degraded.archive,
            archiveBlobRef: degraded.archiveBlobRef,
            result: {
              tier: 'tape_rebuilt',
              sessionKey: req.sessionKey,
              placementEpoch: req.placementEpoch,
              engine: req.targetEngine,
              nativeSessionId: degraded.archive.nativeSessionId,
              capsuleId: req.capsuleId ?? null,
              checkpointGeneration: req.existingCheckpoint?.checkpointGeneration ?? null,
              degradedReason,
            },
          }
        }
        return {
          subTier: '2B',
          handoff: degraded.handoff,
          result: {
            tier: 'tape_rebuilt',
            sessionKey: req.sessionKey,
            placementEpoch: req.placementEpoch,
            engine: req.targetEngine,
            nativeSessionId: null,
            capsuleId: req.capsuleId ?? null,
            checkpointGeneration: req.existingCheckpoint?.checkpointGeneration ?? null,
            degradedReason,
          },
        }
      }

      return {
        subTier: '3',
        cold: degraded.cold,
        result: {
          tier: 'cold_degraded',
          sessionKey: req.sessionKey,
          placementEpoch: req.placementEpoch,
          engine: req.targetEngine,
          nativeSessionId: null,
          capsuleId: null,
          checkpointGeneration: null,
          degradedReason,
        },
      }
    }

    // Tier 3: Cold Degraded保底
    const cold = buildColdDegradedSuffix({
      records,
      ladderSteps: req.ladderSteps,
      maxBytes: req.maxColdBytes ?? 8192,
      reason: degradedReason ?? 'cold_degraded_fallback',
      sessionKey: req.sessionKey,
      engine: req.targetEngine,
    })

    return {
      subTier: '3',
      cold,
      result: {
        tier: 'cold_degraded',
        sessionKey: req.sessionKey,
        placementEpoch: req.placementEpoch,
        engine: req.targetEngine,
        nativeSessionId: null,
        capsuleId: null,
        checkpointGeneration: null,
        degradedReason,
      },
    }
  }
}
