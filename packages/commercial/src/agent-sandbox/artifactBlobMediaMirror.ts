/**
 * OCV5-928 — Master CAS per-file media mirror, authorization, & streaming helpers (`app-container` L4).
 *
 * Extracted from `artifactBlobRuntime.ts` so single-file read/write/delete & remote mirror
 * operations share a single canonical policy-check pipeline, atomic version registration,
 * durable logical soft-delete, and explicit node-denial pass-through (`0` `syncIo`, `0` `process.env`).
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ArtifactBlobRef } from '@openclaude/protocol'
import { isNodeAgentExplicitDenialError } from '../compute-pool/nodeAgentRangeStream.js'
import type { CasMediaChunkMirrorCallbacks } from '../compute-pool/remoteHostChunkHooks.js'
import type { CompleteBlobRowInput } from '../db/threeLayerStateStore.js'
import type { LocalCasArtifactBlobStore } from './artifactBlobStore.js'
import {
  inferMediaMimeType,
  listLocalCasDiskMediaBlobs,
  resolveCasStoreRuntimeBinding,
  safeMediaBasename,
  selectNewestActiveMediaBlob,
} from './artifactBlobCore.js'
import { parseUserVolumeMediaFilePath } from './userMedia.js'

const IMMUTABLE_DIGEST_RE = /^[0-9a-f]{64}(?:\.[a-z0-9]{1,16})?$/i
const localRegisterLocks = new Map<string, Promise<unknown>>()
let monotonicMirrorSeq = 0

export class MediaAccessDeniedError extends Error {
  readonly httpStatus = 403
  constructor(filename: string) {
    super(`CAS media access denied: ${filename}`)
    this.name = 'MediaAccessDeniedError'
  }
}

export interface IndexedMediaMetaStore {
  findNewestMediaBlob(
    tenantId: string,
    safeName: string,
    kind?: 'upload' | 'generated',
  ): Promise<ArtifactBlobRef | null>
  registerLogicalMediaBlobAtomically(
    blobRow: CompleteBlobRowInput,
    ensureObjectStored: () => Promise<void>,
  ): Promise<ArtifactBlobRef>
  softDeleteLogicalMediaBlobs(
    tenantId: string,
    kind: 'upload' | 'generated',
    safeName: string,
  ): Promise<number>
}

function asIndexedMediaMetaStore(raw: unknown): IndexedMediaMetaStore | null {
  if (!raw || typeof raw !== 'object') return null
  const cand = raw as Partial<IndexedMediaMetaStore>
  if (
    typeof cand.findNewestMediaBlob === 'function' &&
    typeof cand.registerLogicalMediaBlobAtomically === 'function' &&
    typeof cand.softDeleteLogicalMediaBlobs === 'function'
  ) {
    return cand as IndexedMediaMetaStore
  }
  return null
}

function nextMirrorBlobId(): string {
  monotonicMirrorSeq = (monotonicMirrorSeq + 1) % 1_000_000
  const tsHex = Date.now().toString(16).padStart(12, '0')
  const seqHex = monotonicMirrorSeq.toString(16).padStart(5, '0')
  return `blob-${tsHex}-${seqHex}-${randomUUID().slice(0, 8)}`
}

async function withLocalKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = localRegisterLocks.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  localRegisterLocks.set(key, settled)
  try {
    return await run
  } finally {
    if (localRegisterLocks.get(key) === settled) localRegisterLocks.delete(key)
  }
}

async function ensureCasObjectFileAsync(
  casRootDir: string,
  sha256: string,
  bytes: Uint8Array,
): Promise<void> {
  const objDir = path.join(casRootDir, 'objects', sha256.slice(0, 2))
  const objPath = path.join(objDir, sha256)
  const existing = await lstat(objPath).catch(() => null)
  if (existing && !existing.isSymbolicLink() && existing.isFile() && existing.size === bytes.byteLength) {
    return
  }
  await mkdir(objDir, { recursive: true })
  const tmpPath = path.join(objDir, `.tmp-${randomUUID()}`)
  const handle = await open(
    tmpPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close().catch(() => undefined)
  }
  await chmod(tmpPath, 0o444)
  await rename(tmpPath, objPath)
}

export function buildCasPolicyCheckPaths(
  meta: ArtifactBlobRef,
  requestedName: string,
): readonly string[] {
  const dirSeg = meta.kind === 'upload' ? 'uploads' : 'generated'
  const paths = new Set<string>([`/${dirSeg}/${requestedName}`])
  if (meta.logicalName) paths.add(`/${dirSeg}/${meta.logicalName}`)
  if (meta.containerRelativePath) paths.add(`/${meta.containerRelativePath.replace(/^\/+/, '')}`)
  return [...paths]
}

export async function resolveAuthorizedCasMediaBlob(opts: {
  readonly blobStore: LocalCasArtifactBlobStore
  readonly tenantId: string
  readonly filename: string
  readonly kind?: 'upload' | 'generated'
  readonly isFileBlocked?: (pathOrName: string) => boolean
}): Promise<{
  readonly meta: ArtifactBlobRef
  readonly safeName: string
  readonly policyCheckPaths: readonly string[]
  readonly isImmutableDigest: boolean
} | null> {
  const safeName = safeMediaBasename(opts.filename)
  if (!safeName) return null
  const binding = resolveCasStoreRuntimeBinding(opts.blobStore)
  const indexed = asIndexedMediaMetaStore(binding?.metaStore)
  let picked: ArtifactBlobRef | null = null
  if (indexed) {
    picked = await indexed.findNewestMediaBlob(opts.tenantId, safeName, opts.kind)
  } else if (binding) {
    const blobs = binding.metaStore
      ? (await binding.metaStore.listTenantBlobs(opts.tenantId)).filter(
          (b) => b.kind === 'upload' || b.kind === 'generated',
        )
      : await listLocalCasDiskMediaBlobs(path.join(binding.rootDir, 'meta'), opts.tenantId)
    picked =
      opts.kind !== undefined
        ? selectNewestActiveMediaBlob(blobs, safeName, opts.kind)
        : (selectNewestActiveMediaBlob(blobs, safeName, 'upload') ??
          selectNewestActiveMediaBlob(blobs, safeName, 'generated'))
  }
  if (!picked) return null
  const meta = await opts.blobStore.stat(opts.tenantId, picked.blobId)
  if (!meta) return null
  const policyCheckPaths = buildCasPolicyCheckPaths(meta, safeName)
  if (opts.isFileBlocked && policyCheckPaths.some((p) => opts.isFileBlocked!(p))) {
    throw new MediaAccessDeniedError(safeName)
  }
  const isImmutableDigest =
    IMMUTABLE_DIGEST_RE.test(safeName) &&
    safeName.toLowerCase().startsWith(meta.sha256.toLowerCase())
  return { meta, safeName, policyCheckPaths, isImmutableDigest }
}

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
  const relDir = opts.kind === 'upload' ? 'uploads' : 'generated'
  const mimeType = opts.mimeType ?? inferMediaMimeType(safeName)
  const binding = resolveCasStoreRuntimeBinding(opts.blobStore)
  const indexed = asIndexedMediaMetaStore(binding?.metaStore)
  if (binding && indexed) {
    return indexed.registerLogicalMediaBlobAtomically(
      {
        blobId: nextMirrorBlobId(),
        tenantId: opts.tenantId,
        sha256,
        sizeBytes: opts.bytes.byteLength,
        mimeType,
        kind: opts.kind,
        logicalName: safeName,
        containerRelativePath: `${relDir}/${safeName}`,
        storageBackend: 'local_cas',
        storageUri: `cas://sha256/${sha256}`,
      },
      () => ensureCasObjectFileAsync(binding.rootDir, sha256, opts.bytes),
    )
  }
  const blobStore = opts.blobStore
  return withLocalKeyLock(`${opts.tenantId}:${opts.kind}:${safeName}`, async () => {
    const resolved = await resolveAuthorizedCasMediaBlob({
      blobStore,
      tenantId: opts.tenantId,
      filename: safeName,
      kind: opts.kind,
    })
    if (resolved && resolved.meta.sha256 === sha256) return resolved.meta
    return blobStore.put({
      tenantId: opts.tenantId,
      kind: opts.kind,
      bytes: opts.bytes,
      mimeType,
      logicalName: safeName,
      containerRelativePath: `${relDir}/${safeName}`,
    })
  })
}

export async function deleteMasterMediaUploadInCas(opts: {
  readonly blobStore?: LocalCasArtifactBlobStore
  readonly tenantId: string
  readonly kind: 'upload' | 'generated'
  readonly filename: string
}): Promise<number> {
  if (!opts.blobStore) return 0
  const safeName = safeMediaBasename(opts.filename)
  if (!safeName) return 0
  const binding = resolveCasStoreRuntimeBinding(opts.blobStore)
  if (!binding) return 0
  const uidMatch = /^c:([1-9][0-9]{0,18})$/.exec(opts.tenantId)
  if (uidMatch) {
    const dirSeg = opts.kind === 'upload' ? 'uploads' : 'generated'
    const cachedPath = path.join(binding.rootDir, 'media-bridge', `u${uidMatch[1]}`, dirSeg, safeName)
    await unlink(cachedPath).catch(() => undefined)
  }
  const indexed = asIndexedMediaMetaStore(binding.metaStore)
  if (indexed) {
    return indexed.softDeleteLogicalMediaBlobs(opts.tenantId, opts.kind, safeName)
  }
  const blobs = binding.metaStore
    ? await binding.metaStore.listTenantBlobs(opts.tenantId)
    : await listLocalCasDiskMediaBlobs(path.join(binding.rootDir, 'meta'), opts.tenantId)
  let deleted = 0
  for (const b of blobs) {
    if (b.kind === opts.kind && (b.logicalName === safeName || b.sha256 === safeName.split('.')[0])) {
      if (await opts.blobStore.delete(opts.tenantId, b.blobId)) deleted += 1
    }
  }
  return deleted
}

export async function readMasterMediaBytesFromCas(opts: {
  readonly blobStore?: LocalCasArtifactBlobStore
  readonly tenantId: string
  readonly filename: string
  readonly kind?: 'upload' | 'generated'
  readonly isFileBlocked?: (pathOrName: string) => boolean
}): Promise<Buffer | null> {
  if (!opts.blobStore) return null
  const resolved = await resolveAuthorizedCasMediaBlob({
    blobStore: opts.blobStore,
    tenantId: opts.tenantId,
    filename: opts.filename,
    kind: opts.kind,
    isFileBlocked: opts.isFileBlocked,
  })
  if (!resolved) return null
  const bytes = await opts.blobStore.getBytes(opts.tenantId, resolved.meta.blobId)
  return bytes ? Buffer.from(bytes) : null
}

export async function openMasterCasMediaFallback(opts: {
  readonly blobStore?: LocalCasArtifactBlobStore
  readonly userId: string
  readonly filename: string
  readonly dest: NodeJS.WritableStream
  readonly resolveRange?: (totalSize: number) => { readonly start: number; readonly end: number } | null
  readonly isHead?: boolean
  readonly isFileBlocked?: (pathOrName: string) => boolean
  readonly onReady: (info: {
    readonly totalSize: number
    readonly range: { readonly start: number; readonly end: number } | null
    readonly contentLength: number
    readonly sha256?: string
    readonly isImmutableDigest?: boolean
    readonly policyCheckPaths?: readonly string[]
  }) => boolean
}): Promise<'ok' | 'missing' | 'rejected'> {
  if (!opts.blobStore || !/^c:[1-9][0-9]{0,18}$/.test(opts.userId)) return 'missing'
  let resolved: Awaited<ReturnType<typeof resolveAuthorizedCasMediaBlob>>
  try {
    resolved = await resolveAuthorizedCasMediaBlob({
      blobStore: opts.blobStore,
      tenantId: opts.userId,
      filename: opts.filename,
      isFileBlocked: opts.isFileBlocked,
    })
  } catch (err) {
    if (err instanceof MediaAccessDeniedError) return 'rejected'
    throw err
  }
  if (!resolved) return 'missing'
  const { meta, policyCheckPaths, isImmutableDigest } = resolved
  const range = opts.isHead ? null : opts.resolveRange ? opts.resolveRange(meta.sizeBytes) : null
  const handle = await opts.blobStore.openReadStream(
    opts.userId,
    meta.blobId,
    range ? { range } : undefined,
  )
  if (!handle) return 'missing'
  const contentLength = range ? range.end - range.start + 1 : meta.sizeBytes
  if (
    !opts.onReady({
      totalSize: meta.sizeBytes,
      range,
      contentLength,
      sha256: meta.sha256,
      isImmutableDigest,
      policyCheckPaths,
    })
  ) {
    handle.stream.destroy()
    return 'rejected'
  }
  if (opts.isHead) {
    handle.stream.destroy()
    return 'ok'
  }
  const onClose = () => handle.stream.destroy()
  opts.dest.once('close', onClose)
  try {
    await pipeline(handle.stream, opts.dest)
    return 'ok'
  } catch (err) {
    const destroyable = opts.dest as { destroy?: (error?: Error) => void; destroyed?: boolean }
    if (!destroyable.destroyed) {
      destroyable.destroy?.(err instanceof Error ? err : new Error(String(err)))
    }
    throw err
  } finally {
    opts.dest.removeListener('close', onClose)
  }
}

export function createCasBridgedRemoteMediaPuller(deps: {
  readonly getBlobStore: () => LocalCasArtifactBlobStore | undefined
  readonly pullFromNodeAgent: (args: {
    readonly hostUuid: string
    readonly remotePath: string
  }) => Promise<Buffer | null>
}) {
  return async (args: {
    hostUuid: string
    remotePath: string
    isFileBlocked?: (pathOrName: string) => boolean
  }): Promise<Buffer | null> => {
    let remoteErr: unknown
    let hasRemoteErr = false
    try {
      const hit = await deps.pullFromNodeAgent(args)
      if (hit !== null) return hit
    } catch (err) {
      if (isNodeAgentExplicitDenialError(err)) throw err
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
          isFileBlocked: args.isFileBlocked,
        })
        if (casBytes !== null) return casBytes
      } catch (err) {
        if (err instanceof MediaAccessDeniedError) throw err
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
): CasMediaChunkMirrorCallbacks {
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
    deleteRemotePathInCas: async (remotePath) => {
      const blobStore = getBlobStore()
      const parsed = parseUserVolumeMediaFilePath(remotePath)
      if (!blobStore || !parsed) return
      await deleteMasterMediaUploadInCas({
        blobStore,
        tenantId: `c:${parsed.uid}`,
        kind: parsed.kind === 'uploads' ? 'upload' : 'generated',
        filename: parsed.filename,
      })
    },
    openCasMediaFallback: (args) =>
      openMasterCasMediaFallback({ blobStore: getBlobStore(), ...args }),
  }
}
