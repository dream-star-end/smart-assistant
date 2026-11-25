/**
 * OCV5-892 B13 — Persistent Disk Spill Store for ToolBrokerServer.
 *
 * Persists oversized tool outputs under `<walDir>/spill/<sha256>.bin` using
 * crash-safe temp file creation (`O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW`),
 * `fsync`, atomic `rename`, and parent directory `fsync`.
 *
 * On cross-restart replay (`cached_receipt`), reads `<walDir>/spill/<sha256>.bin`
 * with `O_NOFOLLOW`, checks regular-file type, validates byte length and SHA-256
 * digest against the authoritative WAL receipt, and fails closed if missing or corrupt.
 *
 * Architecture invariants:
 * - Zero `node:sqlite`, `process.env`, network APIs, or forbidden crypto primitives.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

const SHA256_HEX_RE = /^[a-f0-9]{64}$/
const BLOB_ID_SHA256_RE = /^blob_([a-f0-9]{64})$/
const SAFE_LEGACY_BLOB_ID_RE = /^[A-Za-z0-9._-]{1,128}$/

function isSafeLegacyBlobId(raw: unknown): raw is string {
  return (
    typeof raw === 'string' &&
    SAFE_LEGACY_BLOB_ID_RE.test(raw) &&
    raw !== '.' &&
    raw !== '..' &&
    !raw.includes('..')
  )
}

export interface PersistedSpillBlobDescriptor {
  readonly blobId: string
  readonly sha256: string
  readonly mimeType: string
  readonly bytes: number
  readonly byteLength: number
  readonly path: string
}

export interface VerifiedSpillBlobPayload {
  readonly blobId: string
  readonly sha256: string
  readonly mimeType: string
  readonly bytes: Uint8Array
  readonly byteLength: number
}

export type DiskSpillReadResult =
  | ({ readonly ok: true } & VerifiedSpillBlobPayload)
  | {
      readonly ok: false
      readonly errorCode: 'TOOL_SPILLED_BLOB_MISSING' | 'TOOL_SPILLED_BLOB_CORRUPT'
      readonly message: string
    }

interface SpillBlobMetaJson {
  readonly schemaVersion: 1
  readonly blobId: string
  readonly sha256: string
  readonly mimeType: string
  readonly bytes: number
  readonly byteLength: number
}

function fsyncDirSync(dirPath: string): void {
  let dirFd: number | undefined
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0)
    dirFd = openSync(dirPath, flags)
    fsyncSync(dirFd)
  } finally {
    if (dirFd !== undefined) closeSync(dirFd)
  }
}

function writeAtomicFileSync(tmpPath: string, finalPath: string, data: Uint8Array | Buffer): void {
  let fd: number | undefined
  try {
    fd = openSync(
      tmpPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    let offset = 0
    while (offset < data.byteLength) {
      offset += writeSync(fd, data, offset, data.byteLength - offset)
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmpPath, finalPath)
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
    try {
      unlinkSync(tmpPath)
    } catch {}
    throw err
  }
}

export function extractSha256FromBlobRef(query: {
  readonly blobId?: string
  readonly sha256?: string
}): string | null {
  if (typeof query.sha256 === 'string' && SHA256_HEX_RE.test(query.sha256)) {
    return query.sha256
  }
  if (typeof query.blobId === 'string') {
    if (SHA256_HEX_RE.test(query.blobId)) {
      return query.blobId
    }
    const match = BLOB_ID_SHA256_RE.exec(query.blobId)
    if (match?.[1]) {
      return match[1]
    }
  }
  return null
}

export class ToolBrokerDiskSpillStore {
  readonly spillDir: string
  readonly legacySpillDir: string

  constructor(walDir: string) {
    this.spillDir = join(walDir, 'spill')
    this.legacySpillDir = join(walDir, 'spilled')
  }

  blobPathForSha256(sha256: string): string {
    return join(this.spillDir, `${sha256}.bin`)
  }

  metaPathForSha256(sha256: string): string {
    return join(this.spillDir, `${sha256}.meta.json`)
  }

  legacyBlobPathForId(blobId: string): string {
    return join(this.legacySpillDir, `${blobId}.bin`)
  }

  legacyMetaPathForId(blobId: string): string {
    return join(this.legacySpillDir, `${blobId}.meta.json`)
  }

  persistSync(bytes: Uint8Array, mimeType: string): PersistedSpillBlobDescriptor {
    mkdirSync(this.spillDir, { recursive: true, mode: 0o700 })
    const st = lstatSync(this.spillDir)
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error(`TOOL_WAL_DIR_INVALID:Spill directory is not a regular directory: ${this.spillDir}`)
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const blobId = `blob_${sha256}`
    const byteLength = bytes.byteLength
    const binPath = this.blobPathForSha256(sha256)
    const metaPath = this.metaPathForSha256(sha256)
    const nonce = randomUUID()
    const tmpBin = join(this.spillDir, `.${sha256}.${nonce}.bin.tmp`)
    const tmpMeta = join(this.spillDir, `.${sha256}.${nonce}.meta.tmp`)

    const meta: SpillBlobMetaJson = {
      schemaVersion: 1,
      blobId,
      sha256,
      mimeType,
      bytes: byteLength,
      byteLength,
    }

    writeAtomicFileSync(tmpBin, binPath, bytes)
    writeAtomicFileSync(tmpMeta, metaPath, Buffer.from(JSON.stringify(meta), 'utf8'))
    fsyncDirSync(this.spillDir)

    return Object.freeze({
      blobId,
      sha256,
      mimeType,
      bytes: byteLength,
      byteLength,
      path: binPath,
    })
  }

  readAndVerifySync(query: {
    readonly blobId?: string
    readonly sha256?: string
    readonly expectedBytes?: number
    readonly fallbackMimeType?: string
  }): DiskSpillReadResult {
    const expectedSha = extractSha256FromBlobRef(query)
    if (expectedSha === null) {
      // Legacy read-only fallback when caller only supplies a legacy `<24hex>` blobId
      // (without full 64-hex sha256): read `<walDir>/spilled/<legacyBlobId>.{meta.json,bin}`.
      if (isSafeLegacyBlobId(query.blobId)) {
        return this.readLegacyVerifiedSync({
          legacyBlobId: query.blobId,
          expectedSha: null,
          expectedBytes: query.expectedBytes,
          fallbackMimeType: query.fallbackMimeType,
        })
      }
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
        message: `Spilled blob reference lacks valid SHA-256 digest (blobId=${query.blobId ?? '<none>'})`,
      }
    }

    const binPath = this.blobPathForSha256(expectedSha)
    const metaPath = this.metaPathForSha256(expectedSha)

    let binStat: ReturnType<typeof lstatSync>
    try {
      binStat = lstatSync(binPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        // B13 upgrade compatibility: when canonical `<walDir>/spill/<sha256>.bin` is absent,
        // fall back read-only to legacy `<walDir>/spilled/<legacyBlobId>.bin` and verify
        // byte length + full receipt SHA-256 (fail-closed on any mismatch or symlink).
        if (isSafeLegacyBlobId(query.blobId)) {
          const legacyRes = this.readLegacyVerifiedSync({
            legacyBlobId: query.blobId,
            expectedSha,
            expectedBytes: query.expectedBytes,
            fallbackMimeType: query.fallbackMimeType,
          })
          if (legacyRes.ok || legacyRes.errorCode === 'TOOL_SPILLED_BLOB_CORRUPT') {
            return legacyRes
          }
        }
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_MISSING',
          message: `Persisted spilled output file is missing: ${binPath}`,
        }
      }
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
        message: `Failed to stat spilled output file ${binPath}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (!binStat.isFile() || binStat.isSymbolicLink()) {
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
        message: `Spilled output path is not a regular file: ${binPath}`,
      }
    }

    let meta: SpillBlobMetaJson | null = null
    let metaExists = false
    try {
      const metaStat = lstatSync(metaPath)
      metaExists = true
      if (!metaStat.isFile() || metaStat.isSymbolicLink()) {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
          message: `Spilled blob metadata is not a regular file: ${metaPath}`,
        }
      }
      const metaFd = openSync(metaPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        const parsed = JSON.parse(readFileSync(metaFd, 'utf8')) as Partial<SpillBlobMetaJson>
        if (
          typeof parsed.sha256 !== 'string' ||
          parsed.sha256 !== expectedSha ||
          typeof parsed.mimeType !== 'string' ||
          parsed.mimeType.length === 0 ||
          typeof parsed.bytes !== 'number'
        ) {
          return {
            ok: false,
            errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
            message: `Spilled blob metadata checksum/schema mismatch: ${metaPath}`,
          }
        }
        meta = {
          schemaVersion: 1,
          blobId: parsed.blobId ?? `blob_${expectedSha}`,
          sha256: parsed.sha256,
          mimeType: parsed.mimeType,
          bytes: parsed.bytes,
          byteLength: typeof parsed.byteLength === 'number' ? parsed.byteLength : parsed.bytes,
        }
      } finally {
        closeSync(metaFd)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
          message: `Spilled blob metadata unreadable: ${metaPath}`,
        }
      }
    }

    let fd: number | undefined
    try {
      fd = openSync(binPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const raw = readFileSync(fd)
      const actualByteLength = raw.byteLength

      if (query.expectedBytes !== undefined && actualByteLength !== query.expectedBytes) {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
          message: `Spilled blob byte length mismatch for ${expectedSha}: expected ${query.expectedBytes}, got ${actualByteLength}`,
        }
      }
      if (metaExists && meta !== null && actualByteLength !== meta.bytes) {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
          message: `Spilled blob byte length mismatch vs metadata for ${expectedSha}: expected ${meta.bytes}, got ${actualByteLength}`,
        }
      }

      const actualSha = createHash('sha256').update(raw).digest('hex')
      if (actualSha !== expectedSha) {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
          message: `Spilled blob SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`,
        }
      }

      return {
        ok: true,
        blobId: meta?.blobId ?? `blob_${expectedSha}`,
        sha256: expectedSha,
        mimeType: meta?.mimeType ?? query.fallbackMimeType ?? 'application/octet-stream',
        bytes: new Uint8Array(raw),
        byteLength: actualByteLength,
      }
    } catch (err) {
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
        message: `Failed reading spilled blob ${binPath}: ${err instanceof Error ? err.message : String(err)}`,
      }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {}
      }
    }
  }

  private readLegacyVerifiedSync(params: {
    readonly legacyBlobId: string
    readonly expectedSha: string | null
    readonly expectedBytes?: number
    readonly fallbackMimeType?: string
  }): DiskSpillReadResult {
    let dirStat: ReturnType<typeof lstatSync>
    try {
      dirStat = lstatSync(this.legacySpillDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_MISSING',
          message: `Legacy spill directory is absent: ${this.legacySpillDir}`,
        }
      }
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
        message: `Legacy spill directory unreadable: ${this.legacySpillDir}`,
      }
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
        message: `Legacy spill directory is not a regular directory: ${this.legacySpillDir}`,
      }
    }

    const binPath = this.legacyBlobPathForId(params.legacyBlobId)
    const metaPath = this.legacyMetaPathForId(params.legacyBlobId)

    let binStat: ReturnType<typeof lstatSync>
    try {
      binStat = lstatSync(binPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_MISSING',
          message: `Persisted legacy spilled output file is missing: ${binPath}`,
        }
      }
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
        message: `Failed to stat legacy spilled output file ${binPath}`,
      }
    }
    if (!binStat.isFile() || binStat.isSymbolicLink()) {
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
        message: `Legacy spilled output path is not a regular file: ${binPath}`,
      }
    }

    let resolvedSha = params.expectedSha
    let metaBytes: number | undefined
    let metaMimeType: string | undefined

    try {
      const metaStat = lstatSync(metaPath)
      if (!metaStat.isFile() || metaStat.isSymbolicLink()) {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
          message: `Legacy spilled blob metadata is not a regular file: ${metaPath}`,
        }
      }
      const metaFd = openSync(metaPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      try {
        const parsed = JSON.parse(readFileSync(metaFd, 'utf8')) as {
          readonly sha256?: unknown
          readonly mimeType?: unknown
          readonly bytes?: unknown
        }
        if (
          typeof parsed.sha256 !== 'string' ||
          !SHA256_HEX_RE.test(parsed.sha256) ||
          typeof parsed.mimeType !== 'string' ||
          parsed.mimeType.length === 0 ||
          typeof parsed.bytes !== 'number'
        ) {
          return {
            ok: false,
            errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
            message: `Legacy spilled blob metadata schema invalid: ${metaPath}`,
          }
        }
        if (resolvedSha !== null && parsed.sha256 !== resolvedSha) {
          return {
            ok: false,
            errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
            message: `Legacy spilled blob metadata SHA-256 mismatch: expected ${resolvedSha}, got ${parsed.sha256}`,
          }
        }
        resolvedSha = parsed.sha256
        metaBytes = parsed.bytes
        metaMimeType = parsed.mimeType
      } finally {
        closeSync(metaFd)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
          message: `Legacy spilled blob metadata unreadable: ${metaPath}`,
        }
      }
    }

    if (resolvedSha === null) {
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
        message: `Legacy spilled blob "${params.legacyBlobId}" lacks verifiable SHA-256 metadata`,
      }
    }

    let fd: number | undefined
    try {
      fd = openSync(binPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
      const raw = readFileSync(fd)
      const actualByteLength = raw.byteLength

      if (params.expectedBytes !== undefined && actualByteLength !== params.expectedBytes) {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
          message: `Legacy spilled blob byte length mismatch: expected ${params.expectedBytes}, got ${actualByteLength}`,
        }
      }
      if (metaBytes !== undefined && actualByteLength !== metaBytes) {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
          message: `Legacy spilled blob byte length mismatch vs metadata: expected ${metaBytes}, got ${actualByteLength}`,
        }
      }

      const actualSha = createHash('sha256').update(raw).digest('hex')
      if (actualSha !== resolvedSha) {
        return {
          ok: false,
          errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
          message: `Legacy spilled blob SHA-256 mismatch: expected ${resolvedSha}, got ${actualSha}`,
        }
      }

      const mimeType = metaMimeType ?? params.fallbackMimeType ?? 'application/octet-stream'
      const verifiedBytes = new Uint8Array(raw)
      // Best-effort atomic backfill into canonical `<walDir>/spill/<sha256>.bin` after verification.
      try {
        this.persistSync(verifiedBytes, mimeType)
      } catch {
        // Read-only fallback still succeeds even if canonical backfill cannot write.
      }

      return {
        ok: true,
        blobId: params.legacyBlobId,
        sha256: resolvedSha,
        mimeType,
        bytes: verifiedBytes,
        byteLength: actualByteLength,
      }
    } catch (err) {
      return {
        ok: false,
        errorCode: 'TOOL_SPILLED_BLOB_CORRUPT',
        message: `Failed reading legacy spilled blob ${binPath}: ${err instanceof Error ? err.message : String(err)}`,
      }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {}
      }
    }
  }
}
