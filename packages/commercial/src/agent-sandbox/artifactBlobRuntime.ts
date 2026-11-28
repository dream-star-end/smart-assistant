/**
 * OCV5-907 / OCV5-928 — Master runtime assembly & directory bridge for `LocalCasArtifactBlobStore`.
 *
 * Security & correctness invariants (OCV5-928 R1/R2 + Arch Steward):
 * - B1: NEVER materializes CAS blobs into user-writable Docker volume directories; any
 *   on-disk cache lives exclusively under Master-owned `<casRootDir>/media-bridge/u<uid>`
 *   with `lstat` symlink rejection and `trustedRootDir` realpath containment.
 * - B2: Physical volume ownership (`remote-host` / `local_direct`) stays intact in
 *   `createCasBridgedUserMediaResolver` so Gateway preserves remote `hostUuid`, remote
 *   reads/uploads, remote quota, and local resilience when CAS metadata is unavailable.
 * - B3/B4: Per-file mirror, authorization, atomic registration, and durable soft-delete live
 *   in `./artifactBlobMediaMirror.js` and are re-exported explicitly here.
 *
 * Layer: app-container (L4). Zero `process.env` reads; `0` `syncIo`.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, unlink } from 'node:fs/promises'
import * as path from 'node:path'
import type { ArtifactBlobRef } from '@openclaude/protocol'
import type { FlavorIdentity } from '../flavor/assertFlavor.js'
import { PgArtifactBlobMetaStore, type PgTransactionPool } from '../db/threeLayerStateStore.js'
import { isMasterArtifactCasEnabled } from './artifactCasEnv.js'
import {
  candidateFilenamesForMediaBlob,
  inferMediaMimeType,
  isNewerMediaBlob,
  listLocalCasDiskMediaBlobs,
  lstatNoFollow,
  masterCasBindings,
  resolveCasStoreRuntimeBinding,
  safeMediaBasename,
  selectNewestActiveMediaBlob,
  type MasterCasRuntimeBinding,
  type TenantBlobLister,
} from './artifactBlobCore.js'
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

export {
  candidateFilenamesForMediaBlob,
  inferMediaMimeType,
  listLocalCasDiskMediaBlobs,
  resolveCasStoreRuntimeBinding,
  safeMediaBasename,
  selectNewestActiveMediaBlob,
  type MasterCasRuntimeBinding,
  type TenantBlobLister,
}
export {
  MediaAccessDeniedError,
  buildCasPolicyCheckPaths,
  createCasBridgedRemoteHostUploadPusher,
  createCasBridgedRemoteMediaPuller,
  createCasMediaChunkMirrorCallbacks,
  deleteMasterMediaUploadInCas,
  openMasterCasMediaFallback,
  readMasterMediaBytesFromCas,
  registerMasterMediaUploadInCas,
  resolveAuthorizedCasMediaBlob,
} from './artifactBlobMediaMirror.js'

const ARTIFACT_BLOB_TICKET_DOMAIN = 'openclaude:v5:artifact-blob-ticket:v1:'
const DOCKER_VOLUME_DATA_SEGMENT_RE = /(?:^|\/)_data(?:\/|$)/

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
