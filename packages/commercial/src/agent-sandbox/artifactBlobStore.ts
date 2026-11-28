/**
 * OCV5-890 Wave 1B — Content-Addressed Artifact Blob Store & Remote Media Bridge (`app-container` L4).
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  ARTIFACT_BLOB_KINDS,
  ARTIFACT_BLOB_MAX_BYTES,
  validateArtifactBlobRef,
  type ArtifactBlobKind,
  type ArtifactBlobPutInput,
  type ArtifactBlobRef,
  type ArtifactBlobStore,
} from '@openclaude/protocol'
import type { PgArtifactBlobMetaStore } from '../db/threeLayerStateStore.js'
import type { UserMediaLocation } from './userMedia.js'

export interface LocalCasArtifactBlobStoreOptions {
  readonly rootDir: string
  readonly metaStore?: PgArtifactBlobMetaStore
  readonly signingSecret?: string | Uint8Array
  readonly ticketSigner?: (payload: string) => string
  readonly maxBlobBytes?: number
  readonly defaultChunkBytes?: number
  readonly now?: () => number
}

export interface InitiateChunkedUploadInput {
  readonly uploadId?: string
  readonly tenantId: string
  readonly kind: ArtifactBlobKind
  readonly filename: string
  readonly mimeType: string
  readonly expectedSizeBytes: number
  readonly chunkBytes?: number
  readonly containerRelativePath?: string
}

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
}

export interface PutUploadPartInput {
  readonly uploadId: string
  readonly tenantId: string
  readonly index: number
  readonly bytes: Uint8Array
  readonly sha256: string
}

export interface PutUploadPartResult {
  readonly uploadId: string
  readonly index: number
  readonly sizeBytes: number
  readonly sha256: string
  readonly status: 'recorded' | 'idempotent'
}

export interface CompleteChunkedUploadInput {
  readonly uploadId: string
  readonly tenantId: string
  readonly expectedSha256?: string
  readonly blobId?: string
}

export interface BlobReadStreamOptions {
  readonly range?: {
    readonly start: number
    readonly end?: number
  }
}

export interface BlobReadStreamHandle {
  readonly meta: ArtifactBlobRef
  readonly stream: Readable
  readonly start: number
  readonly end: number
  readonly contentLength: number
}

export interface MaterializeBlobInput {
  readonly tenantId: string
  readonly blobId: string
  readonly targetDir: string
  readonly relativePath: string
  /** Strategy (`'copy'` | `'hardlink_or_copy'`) or POSIX mode; defaults to safe copy. */
  readonly mode?: 'hardlink_or_copy' | 'copy' | number
  /** Opt-in hardlink (only when target & CAS object are both read-only `(mode & 0o222) === 0`). */
  readonly allowHardlink?: boolean
  readonly fileMode?: number
  readonly overwrite?: boolean
  /** Optional trusted root directory; `targetDir` must resolve strictly inside it without symlinks. */
  readonly trustedRootDir?: string
}

export interface MaterializeBlobResult {
  readonly targetPath: string
  readonly sha256: string
  readonly sizeBytes: number
  readonly strategy: 'hardlink' | 'copy'
}

export type BlobTicketOperation = 'read' | 'write' | 'materialize'

export interface IssueSignedBlobTicketInput {
  readonly blobId: string
  readonly tenantId: string
  readonly audience: string
  readonly op: BlobTicketOperation
  readonly ttlMs: number
}

export interface SignedBlobTicketClaims {
  readonly v: 1
  readonly blobId: string
  readonly tenantId: string
  readonly audience: string
  readonly op: BlobTicketOperation
  readonly issuedAtMs: number
  readonly expiresAtMs: number
}

export interface IssuedSignedBlobTicket {
  readonly token: string
  readonly claims: SignedBlobTicketClaims
}

export interface VerifySignedBlobTicketOptions {
  readonly expectedTenantId: string
  readonly expectedAudience: string
  readonly expectedOp: BlobTicketOperation
  readonly expectedBlobId?: string
  readonly nowMs?: number
}

export type VerifySignedBlobTicketResult =
  | { readonly valid: true; readonly claims: SignedBlobTicketClaims }
  | {
      readonly valid: false
      readonly reason:
        | 'malformed'
        | 'invalid_signature'
        | 'expired'
        | 'tenant_mismatch'
        | 'audience_mismatch'
        | 'op_mismatch'
        | 'blob_mismatch'
    }

export interface LocalCasGcOptions {
  readonly completeReferenceProof: boolean
  readonly liveBlobIds: ReadonlySet<string> | readonly string[]
  readonly olderThanMs: number
  readonly nowMs?: number
  readonly tenantId?: string
  readonly dryRun?: boolean
}

export interface LocalCasGcResult {
  readonly deletedBlobIds: readonly string[]
  readonly removedObjectSha256s: readonly string[]
  readonly cutoffIso: string
}

export interface ResolveMediaOrBlobBridgeOptions {
  readonly enableBlobBridge?: boolean
  readonly blobStore?: ArtifactBlobStore
}

export type MediaOrBlobBridgeResolution =
  | {
      readonly kind: 'local_direct'
      readonly uid: number
      readonly uploadsDir: string
      readonly generatedDir: string
    }
  | {
      readonly kind: 'blob_bridge'
      readonly uid: number
      readonly hostUuid: string
      readonly uploadsDir: string
      readonly generatedDir: string
      readonly tenantId: string
    }
  | {
      readonly kind: 'fail'
      readonly reason:
        | 'invalid-uid'
        | 'not-ready'
        | 'volume-missing'
        | 'ambiguous'
        | 'daemon-error'
        | 'remote-host'
      readonly logCtx: Record<string, unknown>
    }

interface StagingPartEntry {
  readonly sizeBytes: number
  readonly sha256: string
}

interface StagingManifest {
  readonly uploadId: string
  readonly tenantId: string
  readonly kind: ArtifactBlobKind
  readonly filename: string
  readonly mimeType: string
  readonly expectedSizeBytes: number
  readonly chunkBytes: number
  readonly chunkCount: number
  readonly containerRelativePath?: string
  readonly status: 'open' | 'completed' | 'aborted'
  readonly createdAt: string
  readonly parts: Record<string, StagingPartEntry>
}

const CHUNK_BYTES_MIN = 65_536
const CHUNK_BYTES_MAX = 16_777_216
const CHUNK_BYTES_DEFAULT = 1_048_576
const CHUNK_COUNT_MAX = 4_096
const MAX_TICKET_TTL_MS = 24 * 60 * 60 * 1000
const TICKET_DOMAIN_PREFIX = 'oc-blob-ticket-v1:'

const SHA256_RE = /^[0-9a-f]{64}$/
const BLOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/
const BLOB_KIND_SET: ReadonlySet<string> = new Set<string>(ARTIFACT_BLOB_KINDS)
const TICKET_OP_SET: ReadonlySet<string> = new Set<string>(['read', 'write', 'materialize'])
const HARDLINK_FALLBACK_CODES: ReadonlySet<string> = new Set<string>([
  'EXDEV',
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EMLINK',
  'EACCES',
  'ENOSYS',
])

let monotonicBlobSeq = 0
function nextSortableBlobId(nowMs: number): string {
  return `blob-${nowMs.toString(36).padStart(9, '0')}-${(++monotonicBlobSeq).toString(36).padStart(6, '0')}-${randomUUID().slice(0, 12)}`
}
function assertCondition(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

function sha256HexOfBuffer(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256DigestBytes(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest()
}

/**
 * Pure RFC 2104 keyed SHA-256 MAC implemented via `createHash('sha256')`.
 */
function rfc2104Sha256Hex(key: Uint8Array, message: string): string {
  const blockSize = 64
  let keyBlock = key.byteLength > blockSize ? sha256DigestBytes(key) : Buffer.from(key)
  if (keyBlock.byteLength < blockSize) {
    const padded = Buffer.alloc(blockSize)
    keyBlock.copy(padded)
    keyBlock = padded
  }
  const oKeyPad = Buffer.alloc(blockSize)
  const iKeyPad = Buffer.alloc(blockSize)
  for (let i = 0; i < blockSize; i += 1) {
    const b = keyBlock[i]!
    oKeyPad[i] = b ^ 0x5c
    iKeyPad[i] = b ^ 0x36
  }
  const inner = createHash('sha256').update(iKeyPad).update(message, 'utf8').digest()
  return createHash('sha256').update(oKeyPad).update(inner).digest('hex')
}

/**
 * Constant-time UTF-8 string comparison using XOR accumulation across all bytes.
 */
function constantTimeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  let diff = bufA.byteLength ^ bufB.byteLength
  const maxLen = Math.max(bufA.byteLength, bufB.byteLength)
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0)
  }
  return diff === 0
}

function parseSafeRelativeSegments(relativePath: string): string[] {
  assertCondition(
    typeof relativePath === 'string' &&
      relativePath.length > 0 &&
      relativePath.length <= 512 &&
      !CONTROL_CHAR_RE.test(relativePath) &&
      !relativePath.startsWith('/') &&
      !relativePath.startsWith('\\') &&
      !relativePath.includes('\\'),
    'BLOB_MATERIALIZE_PATH_ESCAPE',
  )
  const segments = relativePath.split('/')
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i]!
    assertCondition(
      seg.length > 0 && seg !== '.' && seg !== '..' && !(i === 0 && seg.includes(':')),
      'BLOB_MATERIALIZE_PATH_ESCAPE',
    )
  }
  return segments
}

function readRegularFileNoFollowAndHash(filePath: string): {
  readonly bytes: Buffer
  readonly sha256: string
  readonly sizeBytes: number
} {
  const fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const st = fstatSync(fd)
    assertCondition(st.isFile(), 'BLOB_FILE_NOT_REGULAR')
    const chunks: Buffer[] = []
    const hash = createHash('sha256')
    const buf = Buffer.allocUnsafe(65_536)
    let total = 0
    while (true) {
      const n = readSync(fd, buf, 0, buf.byteLength, null)
      if (n <= 0) break
      const slice = Buffer.from(buf.subarray(0, n))
      hash.update(slice)
      chunks.push(slice)
      total += n
    }
    return {
      bytes: Buffer.concat(chunks, total),
      sha256: hash.digest('hex'),
      sizeBytes: total,
    }
  } finally {
    closeSync(fd)
  }
}

async function lstatExistingOrNull(targetPath: string) {
  try {
    return await lstat(targetPath)
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

async function resolveVerifiedMaterializeTargetDir(targetDir: string, trustedRootDir?: string): Promise<string> {
  assertCondition(typeof targetDir === 'string' && targetDir.length > 0, 'BLOB_MATERIALIZE_TARGET_DIR_INVALID')
  const targetDirLstat = await lstatExistingOrNull(targetDir)
  assertCondition(targetDirLstat !== null, 'BLOB_MATERIALIZE_TARGET_DIR_INVALID')
  assertCondition(!targetDirLstat.isSymbolicLink(), 'BLOB_MATERIALIZE_SYMLINK_FORBIDDEN')
  assertCondition(targetDirLstat.isDirectory(), 'BLOB_MATERIALIZE_TARGET_DIR_INVALID')
  const realTargetDir = await realpath(targetDir)
  if (trustedRootDir !== undefined) {
    assertCondition(typeof trustedRootDir === 'string' && trustedRootDir.length > 0, 'BLOB_MATERIALIZE_UNTRUSTED_TARGET_DIR')
    const rootLstat = await lstatExistingOrNull(trustedRootDir)
    assertCondition(rootLstat !== null && !rootLstat.isSymbolicLink() && rootLstat.isDirectory(), 'BLOB_MATERIALIZE_UNTRUSTED_TARGET_DIR')
    const realTrustedRoot = await realpath(trustedRootDir)
    assertCondition(realTargetDir === realTrustedRoot || realTargetDir.startsWith(`${realTrustedRoot}${path.sep}`), 'BLOB_MATERIALIZE_UNTRUSTED_TARGET_DIR')
  }
  return realTargetDir
}

function syncDirectoryBestEffort(dirPath: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dirPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0))
    fsyncSync(fd)
  } catch { /* unsupported fsync */ } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

function writeAtomicFileNoFollow(
  targetPath: string,
  bytes: Uint8Array,
  fileMode?: number,
): void {
  const dir = path.dirname(targetPath)
  const tmpPath = path.join(dir, `.tmp-${randomUUID()}`)
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0)
  const fd = openSync(tmpPath, flags, 0o600)
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = writeSync(fd, bytes, offset, bytes.byteLength - offset)
      if (written <= 0) break
      offset += written
    }
    fsyncSync(fd)
  } catch (err) {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    throw err
  }
  closeSync(fd)
  if (fileMode !== undefined) {
    chmodSync(tmpPath, fileMode)
  }
  try {
    renameSync(tmpPath, targetPath)
    syncDirectoryBestEffort(dir)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    throw err
  }
}

export class LocalCasArtifactBlobStore implements ArtifactBlobStore {
  private readonly rootDir: string
  private readonly objectsDir: string
  private readonly stagingDir: string
  private readonly metaDir: string
  private readonly metaStore?: PgArtifactBlobMetaStore
  private readonly signer?: (payload: string) => string
  private readonly maxBlobBytes: number
  private readonly defaultChunkBytes: number
  private readonly now: () => number

  constructor(options: LocalCasArtifactBlobStoreOptions) {
    assertCondition(
      typeof options.rootDir === 'string' && options.rootDir.trim().length > 0,
      'BLOB_STORE_ROOT_DIR_INVALID',
    )
    this.rootDir = path.resolve(options.rootDir)
    this.objectsDir = path.join(this.rootDir, 'objects')
    this.stagingDir = path.join(this.rootDir, 'staging')
    this.metaDir = path.join(this.rootDir, 'meta')
    mkdirSync(this.objectsDir, { recursive: true })
    mkdirSync(this.stagingDir, { recursive: true })
    mkdirSync(this.metaDir, { recursive: true })

    this.metaStore = options.metaStore
    this.now = options.now ?? (() => Date.now())

    const maxBytes = options.maxBlobBytes ?? ARTIFACT_BLOB_MAX_BYTES
    assertCondition(
      typeof maxBytes === 'number' &&
        Number.isSafeInteger(maxBytes) &&
        maxBytes > 0 &&
        maxBytes <= ARTIFACT_BLOB_MAX_BYTES,
      'BLOB_STORE_MAX_BYTES_INVALID',
    )
    this.maxBlobBytes = maxBytes

    const chunkBytes = options.defaultChunkBytes ?? CHUNK_BYTES_DEFAULT
    assertCondition(
      typeof chunkBytes === 'number' &&
        Number.isSafeInteger(chunkBytes) &&
        chunkBytes >= CHUNK_BYTES_MIN &&
        chunkBytes <= CHUNK_BYTES_MAX,
      'BLOB_STORE_CHUNK_BYTES_INVALID',
    )
    this.defaultChunkBytes = chunkBytes

    if (options.ticketSigner) {
      this.signer = options.ticketSigner
    } else if (options.signingSecret !== undefined) {
      const secretBytes =
        typeof options.signingSecret === 'string'
          ? Buffer.from(options.signingSecret, 'utf8')
          : Buffer.from(options.signingSecret)
      assertCondition(secretBytes.byteLength >= 16, 'BLOB_TICKET_SECRET_TOO_SHORT')
      this.signer = (payload: string) =>
        rfc2104Sha256Hex(secretBytes, `${TICKET_DOMAIN_PREFIX}${payload}`)
    }
  }

  private objectPathForSha256(sha256: string): string {
    assertCondition(SHA256_RE.test(sha256), 'BLOB_SHA256_INVALID')
    return path.join(this.objectsDir, sha256.slice(0, 2), sha256)
  }

  private localMetaPath(blobId: string): string {
    assertCondition(BLOB_ID_RE.test(blobId), 'BLOB_ID_INVALID')
    return path.join(this.metaDir, `${blobId}.json`)
  }

  private stagingUploadDir(uploadId: string): string {
    assertCondition(BLOB_ID_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    return path.join(this.stagingDir, uploadId)
  }

  private readStagingManifest(uploadId: string): StagingManifest {
    const manifestPath = path.join(this.stagingUploadDir(uploadId), 'manifest.json')
    assertCondition(existsSync(manifestPath), 'BLOB_UPLOAD_NOT_FOUND')
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as StagingManifest
    return raw
  }

  private writeStagingManifest(uploadId: string, manifest: StagingManifest): void {
    const manifestPath = path.join(this.stagingUploadDir(uploadId), 'manifest.json')
    writeAtomicFileNoFollow(manifestPath, Buffer.from(JSON.stringify(manifest), 'utf8'))
  }

  private saveLocalMeta(ref: ArtifactBlobRef): void {
    writeAtomicFileNoFollow(this.localMetaPath(ref.blobId), Buffer.from(JSON.stringify(ref), 'utf8'))
  }

  private loadLocalMeta(tenantId: string, blobId: string): ArtifactBlobRef | null {
    if (!BLOB_ID_RE.test(blobId)) return null
    const p = this.localMetaPath(blobId)
    if (!existsSync(p)) return null
    const parsed = validateArtifactBlobRef(JSON.parse(readFileSync(p, 'utf8')))
    if (parsed.tenantId !== tenantId) return null
    return parsed
  }

  private listAllLocalMeta(): ArtifactBlobRef[] {
    if (!existsSync(this.metaDir)) return []
    const out: ArtifactBlobRef[] = []
    for (const ent of readdirSync(this.metaDir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue
      try {
        const parsed = validateArtifactBlobRef(
          JSON.parse(readFileSync(path.join(this.metaDir, ent.name), 'utf8')),
        )
        out.push(parsed)
      } catch {
        // Ignore corrupt/temp entries during scan.
      }
    }
    return out
  }

  async put(input: ArtifactBlobPutInput): Promise<ArtifactBlobRef> {
    assertCondition(TENANT_ID_RE.test(input.tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(BLOB_KIND_SET.has(input.kind), 'BLOB_KIND_INVALID')
    assertCondition(input.bytes instanceof Uint8Array, 'BLOB_BYTES_INVALID')
    assertCondition(input.bytes.byteLength <= this.maxBlobBytes, 'BLOB_SIZE_LIMIT_EXCEEDED')

    const sha256 = sha256HexOfBuffer(input.bytes)
    const objectPath = this.objectPathForSha256(sha256)
    mkdirSync(path.dirname(objectPath), { recursive: true })
    writeAtomicFileNoFollow(objectPath, input.bytes, 0o444)

    const nowMs = this.now()
    const blobId = nextSortableBlobId(nowMs)
    const createdAt = new Date(nowMs).toISOString()
    const ref = validateArtifactBlobRef({
      blobId,
      tenantId: input.tenantId,
      sha256,
      sizeBytes: input.bytes.byteLength,
      mimeType: input.mimeType,
      kind: input.kind,
      ...(input.logicalName === undefined ? {} : { logicalName: input.logicalName }),
      ...(input.containerRelativePath === undefined
        ? {}
        : { containerRelativePath: input.containerRelativePath }),
      storageBackend: 'local_cas',
      storageUri: `cas://sha256/${sha256}`,
      createdAt,
    })

    if (this.metaStore) {
      return this.metaStore.insertBlob({
        ...ref,
        storageUri: ref.storageUri!,
      })
    }
    this.saveLocalMeta(ref)
    return ref
  }

  async initiateChunkedUpload(input: InitiateChunkedUploadInput): Promise<ChunkedUploadSession> {
    const uploadId = input.uploadId ?? `upl-${randomUUID()}`
    assertCondition(BLOB_ID_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    assertCondition(TENANT_ID_RE.test(input.tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(BLOB_KIND_SET.has(input.kind), 'BLOB_KIND_INVALID')
    assertCondition(
      typeof input.filename === 'string' &&
        input.filename.length > 0 &&
        input.filename.length <= 256 &&
        !CONTROL_CHAR_RE.test(input.filename),
      'BLOB_FILENAME_INVALID',
    )
    assertCondition(
      typeof input.mimeType === 'string' &&
        input.mimeType.length > 0 &&
        input.mimeType.length <= 128,
      'BLOB_MIME_TYPE_INVALID',
    )
    assertCondition(
      typeof input.expectedSizeBytes === 'number' &&
        Number.isSafeInteger(input.expectedSizeBytes) &&
        input.expectedSizeBytes >= 0 &&
        input.expectedSizeBytes <= this.maxBlobBytes,
      'BLOB_SIZE_LIMIT_EXCEEDED',
    )

    const chunkBytes = input.chunkBytes ?? this.defaultChunkBytes
    assertCondition(
      typeof chunkBytes === 'number' &&
        Number.isSafeInteger(chunkBytes) &&
        chunkBytes >= CHUNK_BYTES_MIN &&
        chunkBytes <= CHUNK_BYTES_MAX,
      'BLOB_CHUNK_BYTES_INVALID',
    )
    const chunkCount =
      input.expectedSizeBytes === 0 ? 1 : Math.ceil(input.expectedSizeBytes / chunkBytes)
    assertCondition(chunkCount >= 1 && chunkCount <= CHUNK_COUNT_MAX, 'BLOB_CHUNK_COUNT_INVALID')

    const uploadDir = this.stagingUploadDir(uploadId)
    assertCondition(!existsSync(uploadDir), 'BLOB_UPLOAD_ALREADY_EXISTS')
    mkdirSync(uploadDir, { recursive: true })

    const manifest: StagingManifest = {
      uploadId,
      tenantId: input.tenantId,
      kind: input.kind,
      filename: input.filename,
      mimeType: input.mimeType,
      expectedSizeBytes: input.expectedSizeBytes,
      chunkBytes,
      chunkCount,
      ...(input.containerRelativePath === undefined
        ? {}
        : { containerRelativePath: input.containerRelativePath }),
      status: 'open',
      createdAt: new Date(this.now()).toISOString(),
      parts: {},
    }
    this.writeStagingManifest(uploadId, manifest)

    if (this.metaStore) {
      try {
        await this.metaStore.initiateUpload({
          uploadId,
          tenantId: input.tenantId,
          kind: input.kind,
          filename: input.filename,
          mimeType: input.mimeType,
          expectedSizeBytes: input.expectedSizeBytes,
          chunkBytes,
          chunkCount,
        })
      } catch (err) {
        rmSync(uploadDir, { recursive: true, force: true })
        throw err
      }
    }

    return Object.freeze({
      uploadId,
      tenantId: input.tenantId,
      kind: input.kind,
      filename: input.filename,
      mimeType: input.mimeType,
      expectedSizeBytes: input.expectedSizeBytes,
      chunkBytes,
      chunkCount,
      status: 'open',
    })
  }

  async putPart(input: PutUploadPartInput): Promise<PutUploadPartResult> {
    assertCondition(BLOB_ID_RE.test(input.uploadId), 'BLOB_UPLOAD_ID_INVALID')
    assertCondition(TENANT_ID_RE.test(input.tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(
      typeof input.index === 'number' && Number.isSafeInteger(input.index) && input.index >= 0,
      'BLOB_PART_INDEX_INVALID',
    )
    assertCondition(input.bytes instanceof Uint8Array, 'BLOB_BYTES_INVALID')
    assertCondition(
      typeof input.sha256 === 'string' && SHA256_RE.test(input.sha256),
      'BLOB_PART_SHA256_INVALID',
    )

    const manifest = this.readStagingManifest(input.uploadId)
    assertCondition(manifest.tenantId === input.tenantId, 'BLOB_UPLOAD_TENANT_MISMATCH')
    assertCondition(manifest.status === 'open', 'BLOB_UPLOAD_NOT_OPEN')
    assertCondition(input.index < manifest.chunkCount, 'BLOB_PART_INDEX_OUT_OF_RANGE')
    assertCondition(input.bytes.byteLength <= manifest.chunkBytes, 'BLOB_PART_SIZE_EXCEEDED')

    const actualSha256 = sha256HexOfBuffer(input.bytes)
    assertCondition(actualSha256 === input.sha256, 'BLOB_PART_SHA256_MISMATCH')

    const partKey = String(input.index)
    const partPath = path.join(this.stagingUploadDir(input.uploadId), `part-${input.index}`)
    const existing = manifest.parts[partKey]

    if (existing) {
      if (
        existing.sha256 === actualSha256 &&
        existing.sizeBytes === input.bytes.byteLength &&
        existsSync(partPath)
      ) {
        if (this.metaStore) {
          await this.metaStore.recordPart(
            input.uploadId,
            input.index,
            input.bytes.byteLength,
            actualSha256,
            input.tenantId,
          )
        }
        return Object.freeze({
          uploadId: input.uploadId,
          index: input.index,
          sizeBytes: input.bytes.byteLength,
          sha256: actualSha256,
          status: 'idempotent',
        })
      }
      throw new Error('BLOB_PART_SHA256_MISMATCH')
    }

    let runningTotal = input.bytes.byteLength
    for (const part of Object.values(manifest.parts)) {
      runningTotal += part.sizeBytes
    }
    assertCondition(
      runningTotal <= manifest.expectedSizeBytes && runningTotal <= this.maxBlobBytes,
      'BLOB_SIZE_LIMIT_EXCEEDED',
    )

    writeAtomicFileNoFollow(partPath, input.bytes)
    manifest.parts[partKey] = {
      sizeBytes: input.bytes.byteLength,
      sha256: actualSha256,
    }
    this.writeStagingManifest(input.uploadId, manifest)

    if (this.metaStore) {
      await this.metaStore.recordPart(
        input.uploadId,
        input.index,
        input.bytes.byteLength,
        actualSha256,
        input.tenantId,
      )
    }

    return Object.freeze({
      uploadId: input.uploadId,
      index: input.index,
      sizeBytes: input.bytes.byteLength,
      sha256: actualSha256,
      status: 'recorded',
    })
  }

  async completeUpload(input: CompleteChunkedUploadInput): Promise<ArtifactBlobRef> {
    assertCondition(BLOB_ID_RE.test(input.uploadId), 'BLOB_UPLOAD_ID_INVALID')
    assertCondition(TENANT_ID_RE.test(input.tenantId), 'BLOB_TENANT_ID_INVALID')
    if (input.expectedSha256 !== undefined) {
      assertCondition(SHA256_RE.test(input.expectedSha256), 'BLOB_SHA256_INVALID')
    }

    const manifest = this.readStagingManifest(input.uploadId)
    assertCondition(manifest.tenantId === input.tenantId, 'BLOB_UPLOAD_TENANT_MISMATCH')
    assertCondition(manifest.status === 'open', 'BLOB_UPLOAD_NOT_OPEN')

    const uploadDir = this.stagingUploadDir(input.uploadId)
    for (let i = 0; i < manifest.chunkCount; i += 1) {
      assertCondition(manifest.parts[String(i)] !== undefined, 'BLOB_UPLOAD_INCOMPLETE_PARTS')
      assertCondition(existsSync(path.join(uploadDir, `part-${i}`)), 'BLOB_UPLOAD_INCOMPLETE_PARTS')
    }

    const assembledTmpPath = path.join(uploadDir, `assembled-${randomUUID()}.tmp`)
    const wholeHash = createHash('sha256')
    let totalBytes = 0
    const openFlags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0)
    const outFd = openSync(assembledTmpPath, openFlags, 0o600)
    try {
      for (let i = 0; i < manifest.chunkCount; i += 1) {
        const expectedPart = manifest.parts[String(i)]!
        const partData = readRegularFileNoFollowAndHash(path.join(uploadDir, `part-${i}`))
        assertCondition(
          partData.sha256 === expectedPart.sha256 && partData.sizeBytes === expectedPart.sizeBytes,
          'BLOB_PART_SHA256_MISMATCH',
        )
        wholeHash.update(partData.bytes)
        totalBytes += partData.sizeBytes
        assertCondition(totalBytes <= this.maxBlobBytes, 'BLOB_SIZE_LIMIT_EXCEEDED')
        let offset = 0
        while (offset < partData.bytes.byteLength) {
          const written = writeSync(outFd, partData.bytes, offset, partData.bytes.byteLength - offset)
          if (written <= 0) break
          offset += written
        }
      }
      fsyncSync(outFd)
    } catch (err) {
      try { closeSync(outFd) } catch { /* ignore */ }
      try { unlinkSync(assembledTmpPath) } catch { /* ignore */ }
      throw err
    }
    closeSync(outFd)

    const wholeSha256 = wholeHash.digest('hex')
    if (totalBytes !== manifest.expectedSizeBytes) {
      unlinkSync(assembledTmpPath)
      throw new Error('BLOB_UPLOAD_SIZE_MISMATCH')
    }
    if (input.expectedSha256 !== undefined && wholeSha256 !== input.expectedSha256) {
      unlinkSync(assembledTmpPath)
      throw new Error('BLOB_COMPLETE_SHA256_MISMATCH')
    }

    const objectPath = this.objectPathForSha256(wholeSha256)
    mkdirSync(path.dirname(objectPath), { recursive: true })
    chmodSync(assembledTmpPath, 0o444)
    renameSync(assembledTmpPath, objectPath)
    syncDirectoryBestEffort(path.dirname(objectPath))

    const nowMs = this.now()
    const blobId = input.blobId ?? nextSortableBlobId(nowMs)
    const createdAt = new Date(nowMs).toISOString()
    const ref = validateArtifactBlobRef({
      blobId,
      tenantId: manifest.tenantId,
      sha256: wholeSha256,
      sizeBytes: totalBytes,
      mimeType: manifest.mimeType,
      kind: manifest.kind,
      logicalName: manifest.filename,
      ...(manifest.containerRelativePath === undefined
        ? {}
        : { containerRelativePath: manifest.containerRelativePath }),
      storageBackend: 'local_cas',
      storageUri: `cas://sha256/${wholeSha256}`,
      createdAt,
    })

    let persisted: ArtifactBlobRef = ref
    if (this.metaStore) {
      persisted = await this.metaStore.completeUpload(input.uploadId, {
        ...ref,
        storageUri: ref.storageUri!,
      })
    } else {
      this.saveLocalMeta(ref)
    }

    rmSync(uploadDir, { recursive: true, force: true })
    return persisted
  }

  async abortUpload(tenantId: string, uploadId: string): Promise<void> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(BLOB_ID_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    const uploadDir = this.stagingUploadDir(uploadId)
    if (existsSync(uploadDir)) {
      const manifestPath = path.join(uploadDir, 'manifest.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StagingManifest
        if (manifest.tenantId !== tenantId) {
          throw new Error('BLOB_UPLOAD_TENANT_MISMATCH')
        }
      }
    }
    if (this.metaStore) {
      await this.metaStore.abortUpload(tenantId, uploadId)
    }
    if (existsSync(uploadDir)) {
      rmSync(uploadDir, { recursive: true, force: true })
    }
  }

  async stat(tenantId: string, blobId: string): Promise<ArtifactBlobRef | null> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(BLOB_ID_RE.test(blobId), 'BLOB_ID_INVALID')
    if (this.metaStore) {
      return this.metaStore.statBlob(tenantId, blobId)
    }
    return this.loadLocalMeta(tenantId, blobId)
  }

  async getMetadata(tenantId: string, blobId: string): Promise<ArtifactBlobRef | null> {
    return this.stat(tenantId, blobId)
  }

  async headBySha256(tenantId: string, sha256: string): Promise<ArtifactBlobRef | null> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(SHA256_RE.test(sha256), 'BLOB_SHA256_INVALID')
    if (this.metaStore) {
      return this.metaStore.findBlobBySha256(tenantId, sha256)
    }
    const matches = this.listAllLocalMeta().filter(
      (m) => m.tenantId === tenantId && m.sha256 === sha256,
    )
    return matches[0] ?? null
  }

  async getBytes(tenantId: string, blobId: string): Promise<Uint8Array | null> {
    const meta = await this.stat(tenantId, blobId)
    if (!meta) return null
    const objectPath = this.objectPathForSha256(meta.sha256)
    if (!existsSync(objectPath)) return null
    const data = readRegularFileNoFollowAndHash(objectPath)
    assertCondition(
      data.sha256 === meta.sha256 && data.sizeBytes === meta.sizeBytes,
      'BLOB_CONTENT_INTEGRITY_MISMATCH',
    )
    return data.bytes
  }

  async openReadStream(
    tenantId: string,
    blobId: string,
    opts?: BlobReadStreamOptions,
  ): Promise<BlobReadStreamHandle | null> {
    const meta = await this.stat(tenantId, blobId)
    if (!meta) return null
    const objectPath = this.objectPathForSha256(meta.sha256)
    if (!existsSync(objectPath)) return null

    if (meta.sizeBytes === 0) {
      if (opts?.range !== undefined) {
        assertCondition(
          opts.range.start === 0 && (opts.range.end === undefined || opts.range.end === 0),
          'BLOB_RANGE_INVALID',
        )
      }
      return Object.freeze({
        meta,
        stream: Readable.from([]),
        start: 0,
        end: 0,
        contentLength: 0,
      })
    }

    const start = opts?.range?.start ?? 0
    const end = opts?.range?.end ?? meta.sizeBytes - 1
    assertCondition(
      Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= 0 &&
        end >= start &&
        end < meta.sizeBytes,
      'BLOB_RANGE_INVALID',
    )

    const stream = createReadStream(objectPath, { start, end })
    return Object.freeze({
      meta,
      stream,
      start,
      end,
      contentLength: end - start + 1,
    })
  }

  async materializeToPath(input: MaterializeBlobInput): Promise<MaterializeBlobResult> {
    const meta = await this.stat(input.tenantId, input.blobId)
    assertCondition(meta !== null, 'BLOB_NOT_FOUND')
    const objectPath = this.objectPathForSha256(meta.sha256)
    assertCondition(existsSync(objectPath), 'BLOB_OBJECT_MISSING')

    const segments = parseSafeRelativeSegments(input.relativePath)
    const realTargetDir = await resolveVerifiedMaterializeTargetDir(input.targetDir, input.trustedRootDir)

    let currentDir = realTargetDir
    for (let i = 0; i < segments.length - 1; i += 1) {
      currentDir = path.join(currentDir, segments[i]!)
      if (existsSync(currentDir)) {
        const st = lstatSync(currentDir)
        assertCondition(!st.isSymbolicLink() && st.isDirectory(), 'BLOB_MATERIALIZE_SYMLINK_FORBIDDEN')
      } else {
        mkdirSync(currentDir)
      }
    }

    const finalPath = path.join(currentDir, segments[segments.length - 1]!)
    assertCondition(
      finalPath.startsWith(`${realTargetDir}${path.sep}`),
      'BLOB_MATERIALIZE_PATH_ESCAPE',
    )

    if (existsSync(finalPath)) {
      const existingStat = lstatSync(finalPath)
      assertCondition(!existingStat.isSymbolicLink(), 'BLOB_MATERIALIZE_SYMLINK_FORBIDDEN')
      assertCondition(input.overwrite === true, 'BLOB_MATERIALIZE_TARGET_EXISTS')
    }

    // Verify source CAS object integrity before materializing via O_NOFOLLOW.
    const verifiedSource = readRegularFileNoFollowAndHash(objectPath)
    assertCondition(
      verifiedSource.sha256 === meta.sha256 && verifiedSource.sizeBytes === meta.sizeBytes,
      'BLOB_CONTENT_INTEGRITY_MISMATCH',
    )

    const requestedFileMode = typeof input.mode === 'number' ? input.mode : input.fileMode
    const allowHardlink = input.allowHardlink === true && input.mode !== 'copy'
    const targetModeIsReadOnly =
      requestedFileMode !== undefined &&
      Number.isSafeInteger(requestedFileMode) &&
      requestedFileMode >= 0 &&
      (requestedFileMode & 0o222) === 0
    const casStat = lstatSync(objectPath)
    const casObjectIsReadOnly =
      !casStat.isSymbolicLink() && casStat.isFile() && (casStat.mode & 0o222) === 0
    const canHardlink = allowHardlink && targetModeIsReadOnly && casObjectIsReadOnly

    let strategy: 'hardlink' | 'copy' = 'copy'
    if (canHardlink) {
      const tmpLinkPath = path.join(currentDir, `.link-${randomUUID()}`)
      try {
        linkSync(objectPath, tmpLinkPath)
        renameSync(tmpLinkPath, finalPath)
        syncDirectoryBestEffort(currentDir)
        strategy = 'hardlink'
      } catch (err) {
        try {
          if (existsSync(tmpLinkPath)) unlinkSync(tmpLinkPath)
        } catch {
          // ignore
        }
        const errCode =
          err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : ''
        if (!HARDLINK_FALLBACK_CODES.has(errCode)) {
          throw err
        }
        writeAtomicFileNoFollow(finalPath, verifiedSource.bytes, requestedFileMode)
        strategy = 'copy'
      }
    } else {
      writeAtomicFileNoFollow(finalPath, verifiedSource.bytes, requestedFileMode)
      strategy = 'copy'
    }

    // Post-materialization O_NOFOLLOW integrity check.
    const verifiedTarget = readRegularFileNoFollowAndHash(finalPath)
    assertCondition(
      verifiedTarget.sha256 === meta.sha256 && verifiedTarget.sizeBytes === meta.sizeBytes,
      'BLOB_CONTENT_INTEGRITY_MISMATCH',
    )

    return Object.freeze({
      targetPath: finalPath,
      sha256: verifiedTarget.sha256,
      sizeBytes: verifiedTarget.sizeBytes,
      strategy,
    })
  }

  async delete(tenantId: string, blobId: string): Promise<boolean> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(BLOB_ID_RE.test(blobId), 'BLOB_ID_INVALID')
    if (this.metaStore) {
      return this.metaStore.softDeleteBlob(tenantId, blobId)
    }
    const existing = this.loadLocalMeta(tenantId, blobId)
    if (!existing) return false
    unlinkSync(this.localMetaPath(blobId))
    return true
  }

  issueSignedTicket(input: IssueSignedBlobTicketInput): IssuedSignedBlobTicket {
    assertCondition(this.signer !== undefined, 'BLOB_TICKET_SIGNER_NOT_CONFIGURED')
    assertCondition(BLOB_ID_RE.test(input.blobId), 'BLOB_ID_INVALID')
    assertCondition(TENANT_ID_RE.test(input.tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(
      typeof input.audience === 'string' &&
        input.audience.length > 0 &&
        input.audience.length <= 128 &&
        !CONTROL_CHAR_RE.test(input.audience),
      'BLOB_TICKET_AUDIENCE_INVALID',
    )
    assertCondition(TICKET_OP_SET.has(input.op), 'BLOB_TICKET_OP_INVALID')
    assertCondition(
      typeof input.ttlMs === 'number' &&
        Number.isSafeInteger(input.ttlMs) &&
        input.ttlMs > 0 &&
        input.ttlMs <= MAX_TICKET_TTL_MS,
      'BLOB_TICKET_TTL_INVALID',
    )

    const issuedAtMs = this.now()
    const claims: SignedBlobTicketClaims = Object.freeze({
      v: 1,
      blobId: input.blobId,
      tenantId: input.tenantId,
      audience: input.audience,
      op: input.op,
      issuedAtMs,
      expiresAtMs: issuedAtMs + input.ttlMs,
    })
    const encoded = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
    const sig = this.signer(encoded)
    return Object.freeze({
      token: `${encoded}.${sig}`,
      claims,
    })
  }

  verifySignedTicket(
    token: string,
    opts: VerifySignedBlobTicketOptions,
  ): VerifySignedBlobTicketResult {
    assertCondition(this.signer !== undefined, 'BLOB_TICKET_SIGNER_NOT_CONFIGURED')
    if (typeof token !== 'string' || token.length === 0) {
      return Object.freeze({ valid: false, reason: 'malformed' })
    }
    const parts = token.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return Object.freeze({ valid: false, reason: 'malformed' })
    }
    const [encoded, providedSig] = parts
    const expectedSig = this.signer(encoded!)
    if (!constantTimeEqualStrings(expectedSig, providedSig!)) {
      return Object.freeze({ valid: false, reason: 'invalid_signature' })
    }

    let raw: unknown
    try {
      raw = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))
    } catch {
      return Object.freeze({ valid: false, reason: 'malformed' })
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return Object.freeze({ valid: false, reason: 'malformed' })
    }
    const c = raw as Record<string, unknown>
    if (
      c.v !== 1 ||
      typeof c.blobId !== 'string' ||
      typeof c.tenantId !== 'string' ||
      typeof c.audience !== 'string' ||
      typeof c.op !== 'string' ||
      !TICKET_OP_SET.has(c.op) ||
      typeof c.issuedAtMs !== 'number' ||
      typeof c.expiresAtMs !== 'number'
    ) {
      return Object.freeze({ valid: false, reason: 'malformed' })
    }

    const nowMs = opts.nowMs ?? this.now()
    if (nowMs >= c.expiresAtMs) {
      return Object.freeze({ valid: false, reason: 'expired' })
    }
    if (c.tenantId !== opts.expectedTenantId) {
      return Object.freeze({ valid: false, reason: 'tenant_mismatch' })
    }
    if (c.audience !== opts.expectedAudience) {
      return Object.freeze({ valid: false, reason: 'audience_mismatch' })
    }
    if (c.op !== opts.expectedOp) {
      return Object.freeze({ valid: false, reason: 'op_mismatch' })
    }
    if (opts.expectedBlobId !== undefined && c.blobId !== opts.expectedBlobId) {
      return Object.freeze({ valid: false, reason: 'blob_mismatch' })
    }

    const claims: SignedBlobTicketClaims = Object.freeze({
      v: 1,
      blobId: c.blobId,
      tenantId: c.tenantId,
      audience: c.audience,
      op: c.op as BlobTicketOperation,
      issuedAtMs: c.issuedAtMs,
      expiresAtMs: c.expiresAtMs,
    })
    return Object.freeze({ valid: true, claims })
  }

  async gcUnreferenced(opts: LocalCasGcOptions): Promise<LocalCasGcResult> {
    if (opts.completeReferenceProof !== true) {
      throw new Error('BLOB_GC_INCOMPLETE_REFERENCE_PROOF')
    }
    assertCondition(
      typeof opts.olderThanMs === 'number' &&
        Number.isFinite(opts.olderThanMs) &&
        opts.olderThanMs >= 0,
      'BLOB_GC_OLDER_THAN_INVALID',
    )

    const nowMs = opts.nowMs ?? this.now()
    const cutoffMs = nowMs - opts.olderThanMs
    const cutoffIso = new Date(cutoffMs).toISOString()

    if (this.metaStore) {
      const res = await this.metaStore.gcUnreferencedBlobs({
        completeReferenceProof: true,
        liveBlobIds: opts.liveBlobIds,
        olderThanMs: opts.olderThanMs,
        nowMs,
        ...(opts.tenantId === undefined ? {} : { tenantId: opts.tenantId }),
        ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
      })
      return Object.freeze({
        deletedBlobIds: res.markedDeletedBlobIds,
        removedObjectSha256s: Object.freeze([]),
        cutoffIso: res.cutoffIso,
      })
    }

    const liveSet = new Set<string>(opts.liveBlobIds)
    const allMeta = this.listAllLocalMeta()
    const deletedIds: string[] = []
    const retainedSha256s = new Set<string>()
    const candidateSha256s = new Set<string>()

    for (const meta of allMeta) {
      const createdMs = meta.createdAt ? Date.parse(meta.createdAt) : 0
      const tenantMatch = opts.tenantId === undefined || meta.tenantId === opts.tenantId
      const isCandidate = tenantMatch && !liveSet.has(meta.blobId) && createdMs < cutoffMs
      if (isCandidate) {
        deletedIds.push(meta.blobId)
        candidateSha256s.add(meta.sha256)
        if (!opts.dryRun) {
          const p = this.localMetaPath(meta.blobId)
          if (existsSync(p)) unlinkSync(p)
        }
      } else {
        retainedSha256s.add(meta.sha256)
      }
    }

    const removedObjectSha256s: string[] = []
    for (const sha of candidateSha256s) {
      if (retainedSha256s.has(sha)) continue
      removedObjectSha256s.push(sha)
      if (!opts.dryRun) {
        const objPath = this.objectPathForSha256(sha)
        if (existsSync(objPath)) unlinkSync(objPath)
      }
    }

    return Object.freeze({
      deletedBlobIds: Object.freeze(deletedIds),
      removedObjectSha256s: Object.freeze(removedObjectSha256s),
      cutoffIso,
    })
  }
}

/** Bridges `userMedia.ts` `UserMediaLocation` with `ArtifactBlobStore`. */
export function resolveMediaOrBlobBridge(
  location: UserMediaLocation,
  opts: ResolveMediaOrBlobBridgeOptions = {},
): MediaOrBlobBridgeResolution {
  if (location.kind === 'ok') {
    return Object.freeze({
      kind: 'local_direct',
      uid: location.uid,
      uploadsDir: location.uploads,
      generatedDir: location.generated,
    })
  }
  if (location.reason === 'remote-host') {
    if (opts.enableBlobBridge === false) {
      return Object.freeze({
        kind: 'fail',
        reason: 'remote-host',
        logCtx: location.logCtx,
      })
    }
    return Object.freeze({
      kind: 'blob_bridge',
      uid: location.uid,
      hostUuid: location.hostUuid,
      uploadsDir: location.uploads,
      generatedDir: location.generated,
      tenantId: `c:${location.uid}`,
    })
  }
  return Object.freeze({ kind: 'fail', reason: location.reason, logCtx: location.logCtx })
}
