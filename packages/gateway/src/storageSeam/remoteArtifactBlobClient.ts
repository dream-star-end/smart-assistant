/**
 * OCV5-907 Wave 2 (P1-2) — Container-side HTTP client implementing
 * `ChunkedArtifactBlobStore` against Master `/internal/v3/artifact-blobs/*`.
 *
 * Security & durability invariants (R1 Audit W2 / W6):
 * - Zero `process.env` reads (base URL & container token injected by caller).
 * - `AbortController` deadline spans the ENTIRE request AND response body read
 *   (`res.json()` / `res.arrayBuffer()`), never cleared on response headers alone.
 * - Every early return cancels/drains `res.body` so sockets are never leaked.
 * - Verifies `x-blob-sha256` on `getBytes` downloads to detect in-transit corruption.
 */
import { createHash } from 'node:crypto'
import { ARTIFACT_BLOB_INTERNAL_PREFIX } from '@openclaude/protocol'
import type {
  ArtifactBlobKind,
  ArtifactBlobPutInput,
  ArtifactBlobRef,
} from '@openclaude/protocol/storage-seam'
import type {
  ChunkedArtifactBlobStore,
  ChunkedUploadPartReceipt,
  ChunkedUploadSession,
} from './engineStateCapsuleStore.js'

export type ArtifactBlobFetchImpl = (
  url: string,
  init?: RequestInit,
) => Promise<Response>

export interface RemoteArtifactBlobStoreOptions {
  readonly masterBaseUrl: string
  readonly containerToken: string
  readonly timeoutMs?: number
  readonly fetchImpl?: ArtifactBlobFetchImpl
}

const DEFAULT_TIMEOUT_MS = 30_000
const SHA256_RE = /^[0-9a-f]{64}$/

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '')
}

async function cancelBodySafe(res: Response): Promise<void> {
  try {
    if (res.body && !res.bodyUsed) {
      await res.body.cancel()
    }
  } catch {
    /* best effort */
  }
}

async function readJsonWithDeadline(
  res: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown> | null> {
  if (signal.aborted) {
    await cancelBodySafe(res)
    throw signal.reason instanceof Error ? signal.reason : new Error('ARTIFACT_BLOB_TIMEOUT')
  }
  const onAbort = () => {
    void cancelBodySafe(res)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const parsed: unknown = await new Promise<unknown>((resolve, reject) => {
      const abortReject = () =>
        reject(signal.reason instanceof Error ? signal.reason : new Error('ARTIFACT_BLOB_TIMEOUT'))
      signal.addEventListener('abort', abortReject, { once: true })
      res
        .json()
        .then(
          (val) => {
            signal.removeEventListener('abort', abortReject)
            resolve(val)
          },
          (err) => {
            signal.removeEventListener('abort', abortReject)
            if (signal.aborted) abortReject()
            else resolve(null)
            void err
          },
        )
    })
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function readBytesWithDeadline(
  res: Response,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) {
    await cancelBodySafe(res)
    throw signal.reason instanceof Error ? signal.reason : new Error('ARTIFACT_BLOB_TIMEOUT')
  }
  const onAbort = () => {
    void cancelBodySafe(res)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const ab = await new Promise<ArrayBuffer>((resolve, reject) => {
      const abortReject = () =>
        reject(signal.reason instanceof Error ? signal.reason : new Error('ARTIFACT_BLOB_TIMEOUT'))
      signal.addEventListener('abort', abortReject, { once: true })
      res
        .arrayBuffer()
        .then(
          (val) => {
            signal.removeEventListener('abort', abortReject)
            resolve(val)
          },
          (err) => {
            signal.removeEventListener('abort', abortReject)
            reject(signal.aborted ? new Error('ARTIFACT_BLOB_TIMEOUT') : err)
          },
        )
    })
    return new Uint8Array(ab)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function extractErrorCode(payload: Record<string, unknown> | null, status: number): string {
  const errObj = payload?.error
  if (errObj && typeof errObj === 'object' && !Array.isArray(errObj)) {
    const code = (errObj as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return `ARTIFACT_BLOB_HTTP_${status}`
}

export class RemoteArtifactBlobStore implements ChunkedArtifactBlobStore {
  private readonly baseUrl: string
  private readonly containerToken: string
  private readonly timeoutMs: number
  private readonly fetchImpl: ArtifactBlobFetchImpl

  constructor(options: RemoteArtifactBlobStoreOptions) {
    this.baseUrl = normalizeBaseUrl(options.masterBaseUrl)
    this.containerToken = options.containerToken
    this.timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  /** W2: Timer covers BOTH fetch headers AND full body consumption inside `consume`. */
  private async withRequestDeadline<T>(
    subpath: string,
    init: RequestInit,
    consume: (res: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new Error(`ARTIFACT_BLOB_TIMEOUT:${subpath}`)),
      this.timeoutMs,
    )
    const url = `${this.baseUrl}${ARTIFACT_BLOB_INTERNAL_PREFIX}${subpath}`
    try {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${this.containerToken}`)
      const res = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: controller.signal,
      })
      return await consume(res, controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  async put(input: ArtifactBlobPutInput): Promise<ArtifactBlobRef> {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'x-blob-kind': input.kind,
      'x-blob-mime-type': input.mimeType,
    }
    if (input.logicalName) {
      headers['x-blob-logical-name'] = encodeURIComponent(input.logicalName)
    }
    if (input.containerRelativePath) {
      headers['x-blob-container-rel-path'] = encodeURIComponent(input.containerRelativePath)
    }
    return this.withRequestDeadline(
      'put',
      { method: 'POST', headers, body: Buffer.from(input.bytes) },
      async (res, signal) => {
        const payload = await readJsonWithDeadline(res, signal)
        if (!res.ok) throw new Error(extractErrorCode(payload, res.status))
        const blob = payload?.blob as ArtifactBlobRef | undefined
        if (!blob) throw new Error('ARTIFACT_BLOB_EMPTY_RESPONSE')
        return blob
      },
    )
  }

  async getMetadata(_tenantId: string, blobId: string): Promise<ArtifactBlobRef | null> {
    return this.withRequestDeadline(
      `${encodeURIComponent(blobId)}/meta`,
      { method: 'GET', headers: { accept: 'application/json' } },
      async (res, signal) => {
        if (res.status === 404) {
          await cancelBodySafe(res)
          return null
        }
        const payload = await readJsonWithDeadline(res, signal)
        if (!res.ok) throw new Error(extractErrorCode(payload, res.status))
        return (payload?.blob as ArtifactBlobRef | undefined) ?? null
      },
    )
  }

  async getBytes(_tenantId: string, blobId: string): Promise<Uint8Array | null> {
    return this.withRequestDeadline(
      encodeURIComponent(blobId),
      { method: 'GET' },
      async (res, signal) => {
        if (res.status === 404) {
          await cancelBodySafe(res)
          return null
        }
        if (!res.ok) {
          const payload = await readJsonWithDeadline(res, signal)
          throw new Error(extractErrorCode(payload, res.status))
        }
        const bytes = await readBytesWithDeadline(res, signal)
        const expectedSha = res.headers.get('x-blob-sha256')?.trim().toLowerCase()
        if (expectedSha && SHA256_RE.test(expectedSha)) {
          const actualSha = createHash('sha256').update(bytes).digest('hex')
          if (actualSha !== expectedSha) {
            throw new Error('BLOB_CONTENT_INTEGRITY_MISMATCH')
          }
        }
        return bytes
      },
    )
  }

  async headBySha256(_tenantId: string, sha256: string): Promise<ArtifactBlobRef | null> {
    return this.withRequestDeadline(
      `by-sha256/${encodeURIComponent(sha256)}`,
      { method: 'GET', headers: { accept: 'application/json' } },
      async (res, signal) => {
        if (res.status === 404) {
          await cancelBodySafe(res)
          return null
        }
        const payload = await readJsonWithDeadline(res, signal)
        if (!res.ok) throw new Error(extractErrorCode(payload, res.status))
        return (payload?.blob as ArtifactBlobRef | undefined) ?? null
      },
    )
  }

  async delete(_tenantId: string, blobId: string): Promise<boolean> {
    return this.withRequestDeadline(
      encodeURIComponent(blobId),
      { method: 'DELETE', headers: { accept: 'application/json' } },
      async (res, signal) => {
        const payload = await readJsonWithDeadline(res, signal)
        if (!res.ok) throw new Error(extractErrorCode(payload, res.status))
        return payload?.deleted === true
      },
    )
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
    return this.withRequestDeadline(
      'uploads',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          kind: input.kind,
          filename: input.filename,
          mimeType: input.mimeType,
          expectedSizeBytes: input.expectedSizeBytes,
          ...(input.chunkBytes !== undefined ? { chunkBytes: input.chunkBytes } : {}),
          ...(input.containerRelativePath
            ? { containerRelativePath: input.containerRelativePath }
            : {}),
        }),
      },
      async (res, signal) => {
        const payload = await readJsonWithDeadline(res, signal)
        if (!res.ok) throw new Error(extractErrorCode(payload, res.status))
        const session = payload?.session as ChunkedUploadSession | undefined
        if (!session) throw new Error('ARTIFACT_BLOB_UPLOAD_EMPTY_SESSION')
        return session
      },
    )
  }

  async putPart(input: {
    readonly uploadId: string
    readonly tenantId: string
    readonly index: number
    readonly bytes: Uint8Array
    readonly sha256: string
  }): Promise<ChunkedUploadPartReceipt> {
    return this.withRequestDeadline(
      `uploads/${encodeURIComponent(input.uploadId)}/parts/${input.index}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          'x-part-sha256': input.sha256,
          accept: 'application/json',
        },
        body: Buffer.from(input.bytes),
      },
      async (res, signal) => {
        const payload = await readJsonWithDeadline(res, signal)
        if (!res.ok) throw new Error(extractErrorCode(payload, res.status))
        const part = payload?.part as ChunkedUploadPartReceipt | undefined
        if (!part) throw new Error('ARTIFACT_BLOB_PART_EMPTY_RECEIPT')
        return part
      },
    )
  }

  async completeUpload(input: {
    readonly uploadId: string
    readonly tenantId: string
    readonly expectedSha256?: string
    readonly blobId?: string
  }): Promise<ArtifactBlobRef> {
    return this.withRequestDeadline(
      `uploads/${encodeURIComponent(input.uploadId)}/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
          ...(input.blobId ? { blobId: input.blobId } : {}),
        }),
      },
      async (res, signal) => {
        const payload = await readJsonWithDeadline(res, signal)
        if (!res.ok) throw new Error(extractErrorCode(payload, res.status))
        const blob = payload?.blob as ArtifactBlobRef | undefined
        if (!blob) throw new Error('ARTIFACT_BLOB_COMPLETE_EMPTY_RESPONSE')
        return blob
      },
    )
  }

  async abortUpload(_tenantId: string, uploadId: string): Promise<void> {
    await this.withRequestDeadline(
      `uploads/${encodeURIComponent(uploadId)}`,
      { method: 'DELETE', headers: { accept: 'application/json' } },
      async (res, signal) => {
        if (res.status === 404) {
          await cancelBodySafe(res)
          return
        }
        const payload = await readJsonWithDeadline(res, signal)
        if (!res.ok) throw new Error(extractErrorCode(payload, res.status))
      },
    )
  }
}
