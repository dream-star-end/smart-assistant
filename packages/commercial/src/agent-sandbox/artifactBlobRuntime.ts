/**
 * OCV5-907 Wave 2 (P1-2) — Master runtime assembly for `LocalCasArtifactBlobStore`.
 *
 * Binds `LocalCasArtifactBlobStore` to PostgreSQL metadata (`PgArtifactBlobMetaStore`)
 * and a domain-separated SHA-256 ticket signing secret derived from the master
 * bridge secret, and provides a safe helper bridging `UserMediaLocation` with
 * `resolveMediaOrBlobBridge`.
 *
 * Layer: app-container (L4). Zero `process.env` reads; zero forbidden R3-crypto
 * calls (`createHash` only).
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
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
  parseUserVolumeMediaFilePath,
  type DockerLike,
  type PoolLike,
  type UserMediaLocation,
} from './userMedia.js'
import { PgArtifactBlobMetaStore, type PgTransactionPool } from '../db/threeLayerStateStore.js'

const ARTIFACT_BLOB_TICKET_DOMAIN = 'openclaude:v5:artifact-blob-ticket:v1:'
const SAFE_MEDIA_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

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
  /** Base OpenClaude home directory on master (e.g. `/root/.openclaude`). */
  readonly openClaudeHome: string
  /** Optional explicit override directory for the CAS store. */
  readonly casRootDir?: string
  /** PostgreSQL pool backing `artifact_blobs` and `artifact_blob_uploads`. */
  readonly pgPool: PgTransactionPool
  /** Master bridge secret used to derive a domain-separated signing key. */
  readonly bridgeSecret?: string
  /** Optional max blob bytes override. */
  readonly maxBlobBytes?: number
  /** Optional default chunk bytes override. */
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

/**
 * Flavor-aware bootstrap helper (OCV5-913 T2 B2): returns `undefined` on
 * commercial flavor / `FlavorIdentityError` unless explicitly opted in via
 * `OC_ARTIFACT_CAS_ENABLED=1`, leaving `/internal/v3/artifact-blobs/*`
 * fail-closed with 503 and 0 disk writes.
 */
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

/**
 * Resolve media location through `resolveMediaOrBlobBridge` bound to the
 * master CAS store so remote-host containers route through the blob bridge
 * instead of failing hard when the bridge is enabled.
 */
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
  const base = path.posix.basename(rawPath.replaceAll('\\', '/')).trim()
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

async function pathExistsKind(targetPath: string, expectDir: boolean): Promise<boolean> {
  try {
    const st = await stat(targetPath)
    return expectDir ? st.isDirectory() : st.isFile()
  } catch (err) {
    void err
    return false
  }
}

async function listLocalCasDiskMediaBlobs(
  metaDir: string,
  tenantId: string,
): Promise<readonly ArtifactBlobRef[]> {
  if (!(await pathExistsKind(metaDir, true))) return []
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

async function materializeSingleMediaBlob(
  blobStore: LocalCasArtifactBlobStore,
  blob: ArtifactBlobRef,
  targetDir: string,
): Promise<void> {
  for (const filename of candidateFilenamesForMediaBlob(blob)) {
    const dest = path.join(targetDir, filename)
    if (await pathExistsKind(dest, false)) continue
    try {
      await blobStore.materializeToPath({
        tenantId: blob.tenantId,
        blobId: blob.blobId,
        targetDir,
        relativePath: filename,
        mode: 0o444,
        allowHardlink: true,
        overwrite: false,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg !== 'BLOB_MATERIALIZE_TARGET_EXISTS') {
        void msg
      }
    }
  }
}

async function materializeTenantMediaBlobs(
  blobStore: LocalCasArtifactBlobStore,
  blobs: readonly ArtifactBlobRef[],
  uploadsDir: string,
  generatedDir: string,
): Promise<void> {
  for (const blob of blobs) {
    if (blob.kind === 'upload') {
      await materializeSingleMediaBlob(blobStore, blob, uploadsDir)
    } else if (blob.kind === 'generated') {
      await materializeSingleMediaBlob(blobStore, blob, generatedDir)
    }
  }
}

/**
 * Idempotently registers a user/container media payload in Master CAS (`artifact_blobs`).
 * Checks `headBySha256(tenantId, sha256)` first so repeated uploads of identical bytes
 * return the existing `ArtifactBlobRef` without creating duplicate rows.
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
  const existing = await opts.blobStore.headBySha256(opts.tenantId, sha256)
  if (existing && existing.kind === opts.kind && existing.logicalName === safeName) {
    return existing
  }
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

async function syncBridgeUploadsIntoCas(
  blobStore: LocalCasArtifactBlobStore,
  tenantId: string,
  uploadsDir: string,
): Promise<void> {
  if (!(await pathExistsKind(uploadsDir, true))) return
  const entries = await readdir(uploadsDir, { withFileTypes: true })
  for (const ent of entries) {
    if (!ent.isFile() || !SAFE_MEDIA_FILENAME_RE.test(ent.name)) continue
    try {
      const bytes = await readFile(path.join(uploadsDir, ent.name))
      await registerMasterMediaUploadInCas({
        blobStore,
        tenantId,
        kind: 'upload',
        filename: ent.name,
        bytes,
      })
    } catch (err) {
      void err
    }
  }
}

/**
 * Reads a tenant media file directly from Master CAS (`artifact_blobs`) by filename
 * (`logicalName`, `basename(containerRelativePath)`, or `<sha256>.<ext>`).
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
  for (const blob of blobs) {
    if (opts.kind !== undefined && blob.kind !== opts.kind) continue
    if (!candidateFilenamesForMediaBlob(blob).includes(safeName)) continue
    const bytes = await opts.blobStore.getBytes(opts.tenantId, blob.blobId)
    if (bytes) return Buffer.from(bytes)
  }
  return null
}

async function buildMaterializedBridgeLocation(
  blobStore: LocalCasArtifactBlobStore,
  uid: number,
  blobs: readonly ArtifactBlobRef[],
  explicitBridgeRoot?: string,
  ingestExistingUploads = false,
): Promise<{ readonly kind: 'ok'; readonly uid: number; readonly uploads: string; readonly generated: string } | null> {
  const binding = resolveCasStoreRuntimeBinding(blobStore)
  const bridgeBase = explicitBridgeRoot ?? (binding ? path.join(binding.rootDir, 'media-bridge') : null)
  if (!bridgeBase) return null
  const uploads = path.join(bridgeBase, `u${uid}`, 'uploads')
  const generated = path.join(bridgeBase, `u${uid}`, 'generated')
  await mkdir(uploads, { recursive: true })
  await mkdir(generated, { recursive: true })
  if (ingestExistingUploads) {
    await syncBridgeUploadsIntoCas(blobStore, `c:${uid}`, uploads)
  }
  const refreshedBlobs = ingestExistingUploads
    ? await listMediaBlobsForTenant(blobStore, `c:${uid}`)
    : blobs
  await materializeTenantMediaBlobs(blobStore, refreshedBlobs, uploads, generated)
  return { kind: 'ok', uid, uploads, generated }
}

/**
 * Production Master media resolver bridge (`W2-CS2`):
 * - Pipes `UserMediaLocation` through `resolveMasterMediaWithBlobBridge`.
 * - For `remote-host` (`bridged.kind === 'blob_bridge'`), materializes tenant CAS
 *   `artifact_blobs` into per-tenant Master CAS bridge dirs so `/api/media/*` serves
 *   HTTP 200 media bytes instead of HTTP 503.
 * - For `local_direct`, backfills any missing CAS blobs into local volume dirs (or
 *   CAS bridge dirs when the local mountpoint is absent on disk).
 * - For `volume-missing`, transparently serves from CAS when tenant media blobs exist.
 */
export async function resolveMasterMediaDirsWithCasBridge(
  location: UserMediaLocation,
  opts?: {
    readonly blobStore?: LocalCasArtifactBlobStore
    readonly enableBlobBridge?: boolean
    readonly bridgeRootDir?: string
  },
): Promise<UserMediaLocation> {
  const blobStore = opts?.blobStore
  const bridged = resolveMasterMediaWithBlobBridge(location, blobStore, opts?.enableBlobBridge)
  if (!blobStore || opts?.enableBlobBridge === false) {
    return location
  }

  if (bridged.kind === 'blob_bridge') {
    const bridgedLoc = await buildMaterializedBridgeLocation(
      blobStore,
      bridged.uid,
      [],
      opts?.bridgeRootDir,
      true,
    )
    return bridgedLoc ?? location
  }

  if (bridged.kind === 'local_direct') {
    const blobs = await listMediaBlobsForTenant(blobStore, `c:${bridged.uid}`)
    if (blobs.length === 0) return location
    const [hasUploads, hasGenerated] = await Promise.all([
      pathExistsKind(bridged.uploadsDir, true),
      pathExistsKind(bridged.generatedDir, true),
    ])
    if (hasUploads || hasGenerated) {
      if (hasUploads) await materializeTenantMediaBlobs(blobStore, blobs.filter((b) => b.kind === 'upload'), bridged.uploadsDir, bridged.generatedDir)
      if (hasGenerated) await materializeTenantMediaBlobs(blobStore, blobs.filter((b) => b.kind === 'generated'), bridged.uploadsDir, bridged.generatedDir)
      return location
    }
    const fallbackLoc = await buildMaterializedBridgeLocation(
      blobStore,
      bridged.uid,
      blobs,
      opts?.bridgeRootDir,
      false,
    )
    return fallbackLoc ?? location
  }

  if (location.kind === 'fail' && location.reason === 'volume-missing') {
    const rawUid = location.logCtx.uid
    if (typeof rawUid === 'number' && Number.isSafeInteger(rawUid) && rawUid > 0) {
      const blobs = await listMediaBlobsForTenant(blobStore, `c:${rawUid}`)
      if (blobs.length > 0) {
        const recovered = await buildMaterializedBridgeLocation(
          blobStore,
          rawUid,
          blobs,
          opts?.bridgeRootDir,
          false,
        )
        if (recovered) return recovered
      }
    }
  }

  return location
}

export function createCasBridgedUserMediaResolver(deps: {
  readonly pool: PoolLike
  readonly docker: DockerLike
  readonly getBlobStore: () => LocalCasArtifactBlobStore | undefined
  readonly bridgeRootDir?: string
}): (userId: string) => Promise<UserMediaLocation> {
  const baseResolver = createUserMediaResolver({ pool: deps.pool, docker: deps.docker })
  return async (userId: string): Promise<UserMediaLocation> => {
    const rawLocation = await baseResolver(userId)
    return resolveMasterMediaDirsWithCasBridge(rawLocation, {
      blobStore: deps.getBlobStore(),
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
      const casBytes = await readMasterMediaBytesFromCas({
        blobStore,
        tenantId: `c:${parsed.uid}`,
        filename: parsed.filename,
        kind: parsed.kind === 'uploads' ? 'upload' : 'generated',
      })
      if (casBytes !== null) return casBytes
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
    const blobStore = deps.getBlobStore()
    const parsed = parseUserVolumeMediaFilePath(args.remotePath)
    if (blobStore && parsed) {
      await registerMasterMediaUploadInCas({
        blobStore,
        tenantId: `c:${parsed.uid}`,
        kind: parsed.kind === 'uploads' ? 'upload' : 'generated',
        filename: parsed.filename,
        bytes: args.content,
      })
    }
    await deps.putToNodeAgent(args)
  }
}
