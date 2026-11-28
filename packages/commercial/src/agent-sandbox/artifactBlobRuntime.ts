/**
 * OCV5-907 / OCV5-928 — Master runtime assembly for `LocalCasArtifactBlobStore`.
 *
 * Security & correctness invariants (OCV5-928 R1 B1–B4):
 * - B1: NEVER materializes CAS blobs into user-writable Docker volume directories; any
 *   on-disk cache lives exclusively under Master-owned `<casRootDir>/media-bridge/u<uid>`
 *   with `lstat` symlink rejection and `trustedRootDir` realpath containment.
 * - B2: Physical volume ownership (`remote-host` / `local_direct`) stays intact in
 *   `createCasBridgedUserMediaResolver` so Gateway preserves remote `hostUuid`, remote
 *   reads/uploads, remote quota, and local resilience when CAS metadata is unavailable.
 * - B3: Zero reverse upload ingestion on read paths; write-side CAS registration is
 *   strictly idempotent by `(tenantId, kind, filename, sha256)`.
 * - B4: Resolves the newest active blob version per `(tenantId, kind, filename)` and
 *   prunes/overwrites stale cache entries so `v1 -> v2` updates and deletes take effect immediately.
 *
 * Layer: app-container (L4). Zero `process.env` reads; `createHash` only.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, unlink } from 'node:fs/promises'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { validateArtifactBlobRef, type ArtifactBlobRef } from '@openclaude/protocol'
import type { FlavorIdentity } from '../flavor/assertFlavor.js'
import { isMasterArtifactCasEnabled } from './artifactCasEnv.js'
import {
  LocalCasArtifactBlobStore,
  resolveMediaOrBlobBridge,
  type MediaOrBlobBridgeResolution,
} from './artifactBlobStore.js'
import {
  createUserMediaResolver,
  isUserVolumeMediaPath,
  parseUserVolumeMediaFilePath,
  type DockerLike,
  type PoolLike,
  type UserMediaLocation,
} from './userMedia.js'
import { PgArtifactBlobMetaStore, type PgTransactionPool } from '../db/threeLayerStateStore.js'

const ARTIFACT_BLOB_TICKET_DOMAIN = 'openclaude:v5:artifact-blob-ticket:v1:'
const SAFE_MEDIA_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const DOCKER_VOLUME_DATA_SEGMENT_RE = /(?:^|\/)_data(?:\/|$)/

interface TenantBlobLister {
  listTenantBlobs(tenantId: string): Promise<readonly ArtifactBlobRef[]>
}

interface MasterCasRuntimeBinding {
  readonly rootDir: string
  readonly metaStore?: TenantBlobLister
}

const masterCasBindings = new WeakMap<LocalCasArtifactBlobStore, MasterCasRuntimeBinding>()

const MEDIA_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json', '.txt': 'text/plain',
}

function defaultExtForMimeType(mime: string): string {
  for (const [ext, candidate] of Object.entries(MEDIA_MIME_BY_EXT)) {
    if (candidate === mime && ext !== '.jpeg') return ext
  }
  return ''
}

export interface MasterArtifactBlobStoreOptions {
  readonly openClaudeHome: string
  readonly casRootDir?: string
  readonly pgPool: PgTransactionPool
  readonly bridgeSecret?: string
  readonly maxBlobBytes?: number
  readonly defaultChunkBytes?: number
}

export function deriveArtifactBlobTicketKey(bridgeSecret: string): Uint8Array {
  const digest = createHash('sha256')
    .update(ARTIFACT_BLOB_TICKET_DOMAIN, 'utf8')
    .update(bridgeSecret, 'utf8')
    .digest()
  return new Uint8Array(digest)
}

export function resolveMasterArtifactCasDir(
  openClaudeHome: string,
  explicitCasRootDir?: string,
): string {
  const trimmed = explicitCasRootDir?.trim()
  if (trimmed) return path.resolve(trimmed)
  return path.join(openClaudeHome, 'artifact-cas')
}

export function createMasterArtifactBlobStore(
  opts: MasterArtifactBlobStoreOptions,
): {
  readonly store: LocalCasArtifactBlobStore
  readonly metaStore: PgArtifactBlobMetaStore
  readonly rootDir: string
} {
  const rootDir = resolveMasterArtifactCasDir(opts.openClaudeHome, opts.casRootDir)
  const metaStore = new PgArtifactBlobMetaStore(opts.pgPool)
  const signingSecret =
    opts.bridgeSecret && opts.bridgeSecret.length > 0
      ? deriveArtifactBlobTicketKey(opts.bridgeSecret)
      : undefined
  const store = new LocalCasArtifactBlobStore({
    rootDir,
    metaStore,
    ...(signingSecret ? { signingSecret } : {}),
    ...(opts.maxBlobBytes !== undefined ? { maxBlobBytes: opts.maxBlobBytes } : {}),
    ...(opts.defaultChunkBytes !== undefined ? { defaultChunkBytes: opts.defaultChunkBytes } : {}),
  })
  masterCasBindings.set(store, { rootDir, metaStore })
  return { store, metaStore, rootDir }
}

export interface ConditionalMasterArtifactBlobStoreOptions extends MasterArtifactBlobStoreOptions {
  readonly env: NodeJS.ProcessEnv
  readonly identity?: () => FlavorIdentity
}

export function maybeCreateMasterArtifactBlobStore(
  opts: ConditionalMasterArtifactBlobStoreOptions,
): {
  readonly store: LocalCasArtifactBlobStore
  readonly metaStore: PgArtifactBlobMetaStore
  readonly rootDir: string
} | undefined {
  if (!isMasterArtifactCasEnabled({ env: opts.env, identity: opts.identity })) {
    return undefined
  }
  return createMasterArtifactBlobStore(opts)
}

export function initMasterArtifactBlobStoreForBootstrap(
  opts: ConditionalMasterArtifactBlobStoreOptions,
): LocalCasArtifactBlobStore | undefined {
  try {
    const created = maybeCreateMasterArtifactBlobStore(opts)
    if (!created) {
      console.log('[commercial] artifact CAS blob store DISABLED by flavor gate (set OC_ARTIFACT_CAS_ENABLED=1 to opt in)')
      return undefined
    }
    console.log('[commercial] artifact CAS blob store ready', {
      rootDir: created.rootDir,
      ticketSigning: Boolean(opts.bridgeSecret),
    })
    return created.store
  } catch (err) {
    console.error('[commercial] artifact CAS blob store init failed; blob RPC DISABLED', {
      error: (err as Error)?.message ?? String(err),
    })
    return undefined
  }
}

export function resolveMasterMediaWithBlobBridge(
  location: UserMediaLocation,
  blobStore?: LocalCasArtifactBlobStore,
  enableBlobBridge = true,
): MediaOrBlobBridgeResolution {
  return resolveMediaOrBlobBridge(location, {
    enableBlobBridge: enableBlobBridge && Boolean(blobStore),
    ...(blobStore ? { blobStore } : {}),
  })
}

function isTenantBlobLister(candidate: unknown): candidate is TenantBlobLister {
  if (!candidate || typeof candidate !== 'object') return false
  const fn = Reflect.get(candidate, 'listTenantBlobs')
  return typeof fn === 'function'
}

function resolveCasStoreRuntimeBinding(
  blobStore: LocalCasArtifactBlobStore,
): MasterCasRuntimeBinding | null {
  const bound = masterCasBindings.get(blobStore)
  if (bound) return bound
  const rawRoot = Reflect.get(blobStore, 'rootDir')
  if (typeof rawRoot !== 'string' || rawRoot.length === 0) return null
  const rawMeta = Reflect.get(blobStore, 'metaStore')
  const binding: MasterCasRuntimeBinding = {
    rootDir: rawRoot,
    ...(isTenantBlobLister(rawMeta) ? { metaStore: rawMeta } : {}),
  }
  masterCasBindings.set(blobStore, binding)
  return binding
}

function inferMediaMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return MEDIA_MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

function safeMediaBasename(rawPath: string | undefined): string | null {
  if (!rawPath) return null
  const normalized = rawPath.replaceAll('\\', '/').trim()
  if (normalized.includes('..') || normalized.startsWith('/')) return null
  const base = path.posix.basename(normalized)
  return SAFE_MEDIA_FILENAME_RE.test(base) ? base : null
}

function candidateFilenamesForMediaBlob(blob: ArtifactBlobRef): readonly string[] {
  const names = new Set<string>()
  const fromLogical = safeMediaBasename(blob.logicalName)
  const fromRel = safeMediaBasename(blob.containerRelativePath)
  if (fromLogical) names.add(fromLogical)
  if (fromRel) names.add(fromRel)
  const extFromName = path.extname(fromLogical ?? fromRel ?? '').toLowerCase()
  const ext =
    extFromName && /^[.][a-z0-9]{1,10}$/.test(extFromName)
      ? extFromName
      : defaultExtForMimeType(blob.mimeType.toLowerCase())
  const digestName = `${blob.sha256}${ext}`
  if (SAFE_MEDIA_FILENAME_RE.test(digestName)) names.add(digestName)
  return [...names]
}

async function lstatNoFollow(targetPath: string) {
  try {
    return await lstat(targetPath)
  } catch (err) {
    void err
    return null
  }
}

async function listLocalCasDiskMediaBlobs(
  metaDir: string,
  tenantId: string,
): Promise<readonly ArtifactBlobRef[]> {
  const dirStat = await lstatNoFollow(metaDir)
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return []
  const entries = await readdir(metaDir, { withFileTypes: true })
  const out: ArtifactBlobRef[] = []
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue
    try {
      const raw = await readFile(path.join(metaDir, ent.name), 'utf8')
      const parsed = validateArtifactBlobRef(JSON.parse(raw))
      if (
        parsed.tenantId === tenantId &&
        (parsed.kind === 'upload' || parsed.kind === 'generated')
      ) {
        out.push(parsed)
      }
    } catch (err) {
      void err
    }
  }
  return out
}

async function listMediaBlobsForTenant(
  blobStore: LocalCasArtifactBlobStore,
  tenantId: string,
): Promise<readonly ArtifactBlobRef[]> {
  const binding = resolveCasStoreRuntimeBinding(blobStore)
  if (!binding) return []
  if (binding.metaStore) {
    const all = await binding.metaStore.listTenantBlobs(tenantId)
    return all.filter((b) => b.kind === 'upload' || b.kind === 'generated')
  }
  return listLocalCasDiskMediaBlobs(path.join(binding.rootDir, 'meta'), tenantId)
}

function isNewerMediaBlob(candidate: ArtifactBlobRef, incumbent: ArtifactBlobRef): boolean {
  const candTs = Date.parse(candidate.createdAt)
  const incTs = Date.parse(incumbent.createdAt)
  if (Number.isFinite(candTs) && Number.isFinite(incTs) && candTs !== incTs) {
    return candTs > incTs
  }
  return true
}

function selectNewestActiveMediaBlob(
  blobs: readonly ArtifactBlobRef[],
  safeName: string,
  kind?: 'upload' | 'generated',
): ArtifactBlobRef | null {
  let winner: ArtifactBlobRef | null = null
  for (const blob of blobs) {
    if (kind !== undefined && blob.kind !== kind) continue
    if (!candidateFilenamesForMediaBlob(blob).includes(safeName)) continue
    if (winner === null || isNewerMediaBlob(blob, winner)) {
      winner = blob
    }
  }
  return winner
}

function selectActiveMediaBlobMap(
  blobs: readonly ArtifactBlobRef[],
  kind: 'upload' | 'generated',
): Map<string, ArtifactBlobRef> {
  const active = new Map<string, ArtifactBlobRef>()
  for (const blob of blobs) {
    if (blob.kind !== kind) continue
    for (const filename of candidateFilenamesForMediaBlob(blob)) {
      const existing = active.get(filename)
      if (!existing || isNewerMediaBlob(blob, existing)) {
        active.set(filename, blob)
      }
    }
  }
  return active
}

function assertTrustedBridgeRootPath(candidateRoot: string): string {
  const resolved = path.resolve(candidateRoot)
  const normalized = resolved.replaceAll('\\', '/')
  if (
    DOCKER_VOLUME_DATA_SEGMENT_RE.test(normalized) ||
    isUserVolumeMediaPath(`${normalized}/uploads`) ||
    parseUserVolumeMediaFilePath(`${normalized}/uploads/probe.txt`) !== null
  ) {
    throw new Error('BLOB_BRIDGE_UNTRUSTED_TARGET_DIR')
  }
  return resolved
}

async function ensureTrustedPrivateDir(dirPath: string, realBridgeRoot?: string): Promise<string> {
  const existing = await lstatNoFollow(dirPath)
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error('BLOB_BRIDGE_SYMLINK_FORBIDDEN')
    }
  } else {
    await mkdir(dirPath, { recursive: true, mode: 0o700 })
    const created = await lstatNoFollow(dirPath)
    if (!created || created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error('BLOB_BRIDGE_SYMLINK_FORBIDDEN')
    }
  }
  const realDir = await realpath(dirPath)
  if (
    realBridgeRoot !== undefined &&
    realDir !== realBridgeRoot &&
    !realDir.startsWith(`${realBridgeRoot}${path.sep}`)
  ) {
    throw new Error('BLOB_BRIDGE_UNTRUSTED_TARGET_DIR')
  }
  return realDir
}

async function fileMatchesSha256NoFollow(filePath: string, expectedSha256: string): Promise<boolean> {
  const st = await lstatNoFollow(filePath)
  if (!st || st.isSymbolicLink() || !st.isFile()) return false
  try {
    const bytes = await readFile(filePath)
    return createHash('sha256').update(bytes).digest('hex') === expectedSha256
  } catch (err) {
    void err
    return false
  }
}

async function syncMaterializedKindDir(opts: {
  readonly blobStore: LocalCasArtifactBlobStore
  readonly activeMap: ReadonlyMap<string, ArtifactBlobRef>
  readonly targetDir: string
  readonly trustedRootDir: string
}): Promise<void> {
  const entries = await readdir(opts.targetDir, { withFileTypes: true })
  for (const ent of entries) {
    if (!opts.activeMap.has(ent.name)) {
      await unlink(path.join(opts.targetDir, ent.name)).catch(() => undefined)
    }
  }
  for (const [filename, blob] of opts.activeMap.entries()) {
    const dest = path.join(opts.targetDir, filename)
    const destStat = await lstatNoFollow(dest)
    if (destStat?.isSymbolicLink()) {
      throw new Error('BLOB_BRIDGE_SYMLINK_FORBIDDEN')
    }
    if (destStat && (await fileMatchesSha256NoFollow(dest, blob.sha256))) {
      continue
    }
    await opts.blobStore.materializeToPath({
      tenantId: blob.tenantId,
      blobId: blob.blobId,
      targetDir: opts.targetDir,
      trustedRootDir: opts.trustedRootDir,
      relativePath: filename,
      mode: 0o444,
      allowHardlink: true,
      overwrite: true,
    })
  }
}

/**
 * Idempotently registers a user/container media payload in Master CAS (`artifact_blobs`).
 * Deduplicates across all active tenant blobs matching `(kind, filename, sha256)` so
 * multi-alias files sharing a digest never accumulate duplicate metadata rows.
 */
export async function registerMasterMediaUploadInCas(opts: {
  readonly blobStore?: LocalCasArtifactBlobStore
  readonly tenantId: string
  readonly kind: 'upload' | 'generated'
  readonly filename: string
  readonly bytes: Uint8Array
  readonly mimeType?: string
}): Promise<ArtifactBlobRef | null> {
  if (!opts.blobStore) return null
  const safeName = safeMediaBasename(opts.filename)
  if (!safeName) return null
  const sha256 = createHash('sha256').update(opts.bytes).digest('hex')
  const head = await opts.blobStore.headBySha256(opts.tenantId, sha256)
  if (head && head.kind === opts.kind && candidateFilenamesForMediaBlob(head).includes(safeName)) {
    return head
  }
  const tenantBlobs = await listMediaBlobsForTenant(opts.blobStore, opts.tenantId)
  const matched = tenantBlobs.find(
    (b) => b.kind === opts.kind && b.sha256 === sha256 && candidateFilenamesForMediaBlob(b).includes(safeName),
  )
  if (matched) return matched
  const relDir = opts.kind === 'upload' ? 'uploads' : 'generated'
  return opts.blobStore.put({
    tenantId: opts.tenantId,
    kind: opts.kind,
    bytes: opts.bytes,
    mimeType: opts.mimeType ?? inferMediaMimeType(safeName),
    logicalName: safeName,
    containerRelativePath: `${relDir}/${safeName}`,
  })
}

/**
 * Reads the newest active tenant media file directly from Master CAS (`artifact_blobs`)
 * by filename (`logicalName`, `basename(containerRelativePath)`, or `<sha256>.<ext>`).
 */
export async function readMasterMediaBytesFromCas(opts: {
  readonly blobStore?: LocalCasArtifactBlobStore
  readonly tenantId: string
  readonly filename: string
  readonly kind?: 'upload' | 'generated'
}): Promise<Buffer | null> {
  if (!opts.blobStore) return null
  const safeName = safeMediaBasename(opts.filename)
  if (!safeName) return null
  const blobs = await listMediaBlobsForTenant(opts.blobStore, opts.tenantId)
  if (opts.kind !== undefined) {
    const picked = selectNewestActiveMediaBlob(blobs, safeName, opts.kind)
    if (!picked) return null
    const bytes = await opts.blobStore.getBytes(opts.tenantId, picked.blobId)
    return bytes ? Buffer.from(bytes) : null
  }
  // Match Gateway media precedence: uploads first, then generated.
  const picked =
    selectNewestActiveMediaBlob(blobs, safeName, 'upload') ??
    selectNewestActiveMediaBlob(blobs, safeName, 'generated')
  if (!picked) return null
  const bytes = await opts.blobStore.getBytes(opts.tenantId, picked.blobId)
  return bytes ? Buffer.from(bytes) : null
}

/**
 * Streams the newest active tenant media file from Master CAS with full HTTP Range & HEAD parity.
 */
export async function openMasterCasMediaFallback(opts: {
  readonly blobStore?: LocalCasArtifactBlobStore
  readonly userId: string
  readonly filename: string
  readonly dest: NodeJS.WritableStream
  readonly resolveRange?: (totalSize: number) => { readonly start: number; readonly end: number } | null
  readonly isHead?: boolean
  readonly onReady: (info: {
    readonly totalSize: number
    readonly range: { readonly start: number; readonly end: number } | null
    readonly contentLength: number
  }) => boolean
}): Promise<'ok' | 'missing' | 'rejected'> {
  if (!opts.blobStore || !/^c:[1-9][0-9]{0,18}$/.test(opts.userId)) return 'missing'
  const safeName = safeMediaBasename(opts.filename)
  if (!safeName) return 'missing'
  const blobs = await listMediaBlobsForTenant(opts.blobStore, opts.userId)
  const picked =
    selectNewestActiveMediaBlob(blobs, safeName, 'upload') ??
    selectNewestActiveMediaBlob(blobs, safeName, 'generated')
  if (!picked) return 'missing'
  const meta = await opts.blobStore.stat(opts.userId, picked.blobId)
  if (!meta) return 'missing'
  const range = opts.isHead ? null : (opts.resolveRange ? opts.resolveRange(meta.sizeBytes) : null)
  const contentLength = range ? range.end - range.start + 1 : meta.sizeBytes
  if (!opts.onReady({ totalSize: meta.sizeBytes, range, contentLength })) {
    return 'rejected'
  }
  if (opts.isHead) return 'ok'
  const handle = await opts.blobStore.openReadStream(
    opts.userId,
    meta.blobId,
    range ? { range } : undefined,
  )
  await pipeline(handle.stream, opts.dest)
  return 'ok'
}

async function buildMaterializedBridgeLocation(
  blobStore: LocalCasArtifactBlobStore,
  uid: number,
  blobs: readonly ArtifactBlobRef[],
  explicitBridgeRoot?: string,
): Promise<{ readonly kind: 'ok'; readonly uid: number; readonly uploads: string; readonly generated: string } | null> {
  if (!Number.isSafeInteger(uid) || uid <= 0) return null
  const binding = resolveCasStoreRuntimeBinding(blobStore)
  const rawBase = explicitBridgeRoot ?? (binding ? path.join(binding.rootDir, 'media-bridge') : null)
  if (!rawBase) return null
  const bridgeBase = assertTrustedBridgeRootPath(rawBase)
  const realBridgeRoot = await ensureTrustedPrivateDir(bridgeBase)
  const tenantDir = path.join(realBridgeRoot, `u${uid}`)
  await ensureTrustedPrivateDir(tenantDir, realBridgeRoot)
  const uploads = await ensureTrustedPrivateDir(path.join(tenantDir, 'uploads'), realBridgeRoot)
  const generated = await ensureTrustedPrivateDir(path.join(tenantDir, 'generated'), realBridgeRoot)
  await syncMaterializedKindDir({
    blobStore,
    activeMap: selectActiveMediaBlobMap(blobs, 'upload'),
    targetDir: uploads,
    trustedRootDir: realBridgeRoot,
  })
  await syncMaterializedKindDir({
    blobStore,
    activeMap: selectActiveMediaBlobMap(blobs, 'generated'),
    targetDir: generated,
    trustedRootDir: realBridgeRoot,
  })
  return { kind: 'ok', uid, uploads, generated }
}

/**
 * Master CAS media directory bridge:
 * - NEVER writes into user-writable Docker volume dirs (`B1`).
 * - Zero reverse upload ingestion on read (`B3`).
 * - Updates/prunes Master's private `<casRootDir>/media-bridge/u<uid>` cache by active digest (`B4`).
 * - When `preserveRemoteHost` is `true` (default in `createCasBridgedUserMediaResolver`),
 *   keeps `remote-host` & healthy `local_direct` physical locations untouched (`B2`) so Gateway
 *   preserves `hostUuid`, remote node reads/uploads, remote quota, and local resilience.
 */
async function resolveLocalDirectMediaWithCas(
  location: UserMediaLocation,
  bridged: Extract<MediaOrBlobBridgeResolution, { readonly kind: 'local_direct' }>,
  blobStore: LocalCasArtifactBlobStore,
  bridgeRootDir?: string,
): Promise<UserMediaLocation> {
  const [uploadsStat, generatedStat] = await Promise.all([
    lstatNoFollow(bridged.uploadsDir),
    lstatNoFollow(bridged.generatedDir),
  ])
  if (uploadsStat?.isSymbolicLink() || generatedStat?.isSymbolicLink()) {
    throw new Error('BLOB_BRIDGE_SYMLINK_FORBIDDEN')
  }
  if (uploadsStat?.isDirectory() || generatedStat?.isDirectory()) {
    return location
  }
  try {
    const blobs = await listMediaBlobsForTenant(blobStore, `c:${bridged.uid}`)
    if (blobs.length === 0) return location
    return (await buildMaterializedBridgeLocation(blobStore, bridged.uid, blobs, bridgeRootDir)) ?? location
  } catch (err) {
    void err
    return location
  }
}

async function recoverVolumeMissingFromCas(
  location: Extract<UserMediaLocation, { readonly kind: 'fail' }>,
  blobStore: LocalCasArtifactBlobStore,
  bridgeRootDir?: string,
): Promise<UserMediaLocation> {
  const rawUid = location.logCtx.uid
  if (typeof rawUid !== 'number' || !Number.isSafeInteger(rawUid) || rawUid <= 0) {
    return location
  }
  try {
    const blobs = await listMediaBlobsForTenant(blobStore, `c:${rawUid}`)
    if (blobs.length === 0) return location
    return (await buildMaterializedBridgeLocation(blobStore, rawUid, blobs, bridgeRootDir)) ?? location
  } catch (err) {
    void err
    return location
  }
}

export async function resolveMasterMediaDirsWithCasBridge(
  location: UserMediaLocation,
  opts?: {
    readonly blobStore?: LocalCasArtifactBlobStore
    readonly enableBlobBridge?: boolean
    readonly bridgeRootDir?: string
    readonly preserveRemoteHost?: boolean
  },
): Promise<UserMediaLocation> {
  const blobStore = opts?.blobStore
  const bridged = resolveMasterMediaWithBlobBridge(location, blobStore, opts?.enableBlobBridge)
  if (!blobStore || opts?.enableBlobBridge === false || opts?.preserveRemoteHost === true) {
    return location
  }
  if (bridged.kind === 'blob_bridge') {
    const blobs = await listMediaBlobsForTenant(blobStore, bridged.tenantId)
    return (await buildMaterializedBridgeLocation(blobStore, bridged.uid, blobs, opts?.bridgeRootDir)) ?? location
  }
  if (bridged.kind === 'local_direct') {
    return resolveLocalDirectMediaWithCas(location, bridged, blobStore, opts?.bridgeRootDir)
  }
  if (location.kind === 'fail' && location.reason === 'volume-missing') {
    return recoverVolumeMissingFromCas(location, blobStore, opts?.bridgeRootDir)
  }
  return location
}

export function createCasBridgedUserMediaResolver(deps: {
  readonly pool: PoolLike
  readonly docker: DockerLike
  readonly getBlobStore: () => LocalCasArtifactBlobStore | undefined
  readonly bridgeRootDir?: string
  readonly preserveRemoteHost?: boolean
}): (userId: string) => Promise<UserMediaLocation> {
  const baseResolver = createUserMediaResolver({ pool: deps.pool, docker: deps.docker })
  return async (userId: string): Promise<UserMediaLocation> => {
    const rawLocation = await baseResolver(userId)
    // Production default: preserve physical `remote-host` and healthy `local_direct` ownership
    // so Gateway handles per-file CAS fallback without losing `hostUuid` or remote upload/quota.
    const preserveRemoteHost = deps.preserveRemoteHost ?? true
    if (preserveRemoteHost) {
      return rawLocation
    }
    return resolveMasterMediaDirsWithCasBridge(rawLocation, {
      blobStore: deps.getBlobStore(),
      preserveRemoteHost: false,
      ...(deps.bridgeRootDir ? { bridgeRootDir: deps.bridgeRootDir } : {}),
    })
  }
}

export function createCasBridgedRemoteMediaPuller(deps: {
  readonly getBlobStore: () => LocalCasArtifactBlobStore | undefined
  readonly pullFromNodeAgent: (args: {
    readonly hostUuid: string
    readonly remotePath: string
  }) => Promise<Buffer | null>
}) {
  return async (args: { hostUuid: string; remotePath: string }): Promise<Buffer | null> => {
    let remoteErr: unknown
    let hasRemoteErr = false
    try {
      const hit = await deps.pullFromNodeAgent(args)
      if (hit !== null) return hit
    } catch (err) {
      remoteErr = err
      hasRemoteErr = true
    }
    const blobStore = deps.getBlobStore()
    const parsed = parseUserVolumeMediaFilePath(args.remotePath)
    if (blobStore && parsed) {
      try {
        const casBytes = await readMasterMediaBytesFromCas({
          blobStore,
          tenantId: `c:${parsed.uid}`,
          filename: parsed.filename,
          kind: parsed.kind === 'uploads' ? 'upload' : 'generated',
        })
        if (casBytes !== null) return casBytes
      } catch (err) {
        void err
      }
    }
    if (hasRemoteErr) {
      throw remoteErr instanceof Error ? remoteErr : new Error(String(remoteErr))
    }
    return null
  }
}

export function createCasBridgedRemoteHostUploadPusher(deps: {
  readonly getBlobStore: () => LocalCasArtifactBlobStore | undefined
  readonly putToNodeAgent: (args: {
    readonly hostUuid: string
    readonly remotePath: string
    readonly content: Buffer
  }) => Promise<void>
}) {
  return async (args: {
    hostUuid: string
    remotePath: string
    content: Buffer
  }): Promise<void> => {
    // B2: Only report upload success AFTER remote host (`node-agent`) persists the bytes
    // so the remote container is guaranteed able to read the uploaded file.
    await deps.putToNodeAgent(args)
    const blobStore = deps.getBlobStore()
    const parsed = parseUserVolumeMediaFilePath(args.remotePath)
    if (blobStore && parsed) {
      try {
        await registerMasterMediaUploadInCas({
          blobStore,
          tenantId: `c:${parsed.uid}`,
          kind: parsed.kind === 'uploads' ? 'upload' : 'generated',
          filename: parsed.filename,
          bytes: args.content,
        })
      } catch (err) {
        void err
      }
    }
  }
}

export function createCasMediaChunkMirrorCallbacks(
  getBlobStore: () => LocalCasArtifactBlobStore | undefined,
): import('../compute-pool/remoteHostChunkHooks.js').CasMediaChunkMirrorCallbacks {
  return {
    mirrorRemotePathBytes: async (remotePath, bytes) => {
      const blobStore = getBlobStore()
      const parsed = parseUserVolumeMediaFilePath(remotePath)
      if (!blobStore || !parsed) return
      await registerMasterMediaUploadInCas({
        blobStore,
        tenantId: `c:${parsed.uid}`,
        kind: parsed.kind === 'uploads' ? 'upload' : 'generated',
        filename: parsed.filename,
        bytes,
      })
    },
    openCasMediaFallback: (args) =>
      openMasterCasMediaFallback({ blobStore: getBlobStore(), ...args }),
  }
}
