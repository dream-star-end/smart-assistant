/**
 * OCV5-928 — Leaf runtime binding & media filename/version helpers for `LocalCasArtifactBlobStore`.
 *
 * Acyclic leaf shared by `artifactBlobRuntime.ts` and `artifactBlobMediaMirror.ts`
 * (`app-container` L4; `0` `syncIo`, `0` `process.env`, `0` circular value imports).
 */
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { validateArtifactBlobRef, type ArtifactBlobRef } from '@openclaude/protocol'
import type { LocalCasArtifactBlobStore } from './artifactBlobStore.js'

const SAFE_MEDIA_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

export interface TenantBlobLister {
  listTenantBlobs(tenantId: string): Promise<readonly ArtifactBlobRef[]>
}

export interface MasterCasRuntimeBinding {
  readonly rootDir: string
  readonly metaStore?: TenantBlobLister
}

export const masterCasBindings = new WeakMap<LocalCasArtifactBlobStore, MasterCasRuntimeBinding>()

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

function isTenantBlobLister(candidate: unknown): candidate is TenantBlobLister {
  if (!candidate || typeof candidate !== 'object') return false
  return typeof Reflect.get(candidate, 'listTenantBlobs') === 'function'
}

export function resolveCasStoreRuntimeBinding(
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

export function inferMediaMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase()
  return MEDIA_MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export function safeMediaBasename(rawPath: string | undefined): string | null {
  if (!rawPath) return null
  const normalized = rawPath.replaceAll('\\', '/').trim()
  if (normalized.includes('..') || normalized.startsWith('/')) return null
  const base = path.posix.basename(normalized)
  return SAFE_MEDIA_FILENAME_RE.test(base) ? base : null
}

export function candidateFilenamesForMediaBlob(blob: ArtifactBlobRef): readonly string[] {
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

export async function lstatNoFollow(targetPath: string) {
  try {
    return await lstat(targetPath)
  } catch (err) {
    void err
    return null
  }
}

export async function listLocalCasDiskMediaBlobs(
  metaDir: string,
  tenantId: string,
): Promise<readonly ArtifactBlobRef[]> {
  const dirStat = await lstatNoFollow(metaDir)
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return []
  const entries = await readdir(metaDir, { withFileTypes: true })
  const rows: Array<{ readonly ref: ArtifactBlobRef; readonly ts: number; readonly mtimeNs: bigint }> = []
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue
    try {
      const fullPath = path.join(metaDir, ent.name)
      const [raw, st] = await Promise.all([readFile(fullPath, 'utf8'), stat(fullPath, { bigint: true })])
      const parsed = validateArtifactBlobRef(JSON.parse(raw))
      if (parsed.tenantId === tenantId && (parsed.kind === 'upload' || parsed.kind === 'generated')) {
        const ts = Date.parse(parsed.createdAt)
        rows.push({ ref: parsed, ts: Number.isFinite(ts) ? ts : 0, mtimeNs: st.mtimeNs })
      }
    } catch (err) {
      void err
    }
  }
  rows.sort((a, b) => {
    if (a.ts !== b.ts) return b.ts - a.ts
    if (a.ref.blobId !== b.ref.blobId) return b.ref.blobId.localeCompare(a.ref.blobId)
    return a.mtimeNs === b.mtimeNs ? 0 : a.mtimeNs > b.mtimeNs ? -1 : 1
  })
  return rows.map((r) => r.ref)
}

export function isNewerMediaBlob(candidate: ArtifactBlobRef, incumbent: ArtifactBlobRef): boolean {
  const candTs = Date.parse(candidate.createdAt)
  const incTs = Date.parse(incumbent.createdAt)
  if (Number.isFinite(candTs) && Number.isFinite(incTs) && candTs !== incTs) {
    return candTs > incTs
  }
  return false
}

export function selectNewestActiveMediaBlob(
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
