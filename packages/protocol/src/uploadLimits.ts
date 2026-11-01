// Single source for the per-file and per-message upload caps.
// The numeric values are a product limit: do not change them here to paper over a UX bug.
// 100MiB matches the single-request body cap. 2GiB is the referenced attachment total.
// Inline text stays at 300MiB because those bytes are copied into the frame.
// An assembled file may be 1GiB, but only via 16MiB chunks. One HTTP body stays at 100MiB.

export const MAX_UPLOAD_SINGLE_BYTES = 100 * 1024 * 1024
export const MAX_UPLOAD_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_INLINE_TEXT_BYTES = 300 * 1024 * 1024

const UPLOAD_MIB = 1024 * 1024

/** Rounded mebibytes, so 345,649,213 bytes is 330MB. */
export function formatUploadMegabytes(bytes: number): number {
  return Math.round(bytes / UPLOAD_MIB)
}

/** How many messages the user should split a too-large selection into. */
export function attachmentSplitCount(totalBytes: number, limitBytes = MAX_UPLOAD_TOTAL_BYTES): number {
  if (!(totalBytes > limitBytes)) return 1
  return Math.max(2, Math.ceil(totalBytes / limitBytes))
}

export function attachmentTotalLimitMessage(totalBytes: number, limitBytes = MAX_UPLOAD_TOTAL_BYTES): string {
  const totalMb = formatUploadMegabytes(totalBytes)
  const limitMb = formatUploadMegabytes(limitBytes)
  const parts = attachmentSplitCount(totalBytes, limitBytes)
  const partText = parts === 2 ? '两' : String(parts)
  return `附件合计 ${totalMb}MB，超过 ${limitMb}MB 上限，请分${partText}条发送`
}

/** Durable failure_code. Bytes are the measured total, not the rounded label. */
export function attachmentTotalExceededFailureCode(totalBytes: number): string {
  const whole = Math.floor(totalBytes)
  if (!Number.isSafeInteger(whole) || whole < 0) {
    throw new RangeError('attachment total bytes must be a non-negative safe integer')
  }
  return `ATTACHMENT_TOTAL_EXCEEDED:${whole}`
}

const ATTACHMENT_TOTAL_CODE = /^attachment_total_exceeded:(\d+)$/i

/** Accept only this code shape. Anything else must stay a generic dispatch failure. */
export function parseAttachmentTotalExceeded(raw: unknown): { totalBytes: number } | null {
  if (typeof raw !== 'string') return null
  const match = ATTACHMENT_TOTAL_CODE.exec(raw.trim())
  if (!match) return null
  const totalBytes = Number(match[1])
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) return null
  return { totalBytes }
}

/** Assembled file cap. This is not the single HTTP body cap. */
export const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024
/** Fixed chunk size inside the 8–32MiB window. The last chunk may be shorter. */
export const UPLOAD_CHUNK_BYTES = 16 * 1024 * 1024
/** Largest chunk request the server will accept. */
export const MAX_UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024
/** Free per-user uploads. Full means delete old files. No charge. */
export const MAX_USER_UPLOAD_QUOTA_BYTES = 10 * 1024 * 1024 * 1024
export const UPLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const UPLOAD_PART_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function uploadFileTooLarge(sizeBytes: number): boolean {
  return !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_UPLOAD_FILE_BYTES
}

export function uploadChunkCount(sizeBytes: number, chunkBytes = UPLOAD_CHUNK_BYTES): number {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new RangeError('upload size must be a positive safe integer')
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 8 * 1024 * 1024 || chunkBytes > MAX_UPLOAD_CHUNK_BYTES) {
    throw new RangeError('chunk size must be inside 8–32MiB')
  }
  if (sizeBytes > MAX_UPLOAD_FILE_BYTES) {
    throw new RangeError('upload size exceeds the assembled file cap')
  }
  return Math.ceil(sizeBytes / chunkBytes)
}

export function uploadChunkLength(sizeBytes: number, index: number, chunkBytes = UPLOAD_CHUNK_BYTES): number {
  const count = uploadChunkCount(sizeBytes, chunkBytes)
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new RangeError('chunk index out of range')
  }
  const start = index * chunkBytes
  return Math.min(chunkBytes, sizeBytes - start)
}

export function uploadFileLimitMessage(sizeBytes: number): string {
  const totalMb = formatUploadMegabytes(sizeBytes)
  const limitMb = formatUploadMegabytes(MAX_UPLOAD_FILE_BYTES)
  return `单个文件 ${totalMb}MB，超过 ${limitMb}MB 上限`
}

export function uploadQuotaExceeded(
  usedBytes: number,
  incomingBytes: number,
  limitBytes = MAX_USER_UPLOAD_QUOTA_BYTES,
): boolean {
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) return true
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0) return true
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) return true
  return usedBytes + incomingBytes > limitBytes
}

export function uploadQuotaMessage(
  usedBytes: number,
  incomingBytes: number,
  limitBytes = MAX_USER_UPLOAD_QUOTA_BYTES,
): string {
  const usedMb = formatUploadMegabytes(Math.max(0, usedBytes))
  const sumMb = formatUploadMegabytes(Math.max(0, usedBytes) + Math.max(0, incomingBytes))
  const limitMb = formatUploadMegabytes(limitBytes)
  return `上传空间已用 ${usedMb}MB，加上这个文件共 ${sumMb}MB，超过 ${limitMb}MB 免费额度。请删除旧文件后再上传。本次不收费。`
}

/** Keep a file that is still inside the retention window, or that a recent session still names. */
export function shouldDeleteAgedUpload(
  ageMs: number,
  referencedByRecentSession: boolean,
  retentionMs = UPLOAD_RETENTION_MS,
): boolean {
  if (!(ageMs >= retentionMs)) return false
  if (referencedByRecentSession) return false
  return true
}

const UPLOAD_PART_NAME = /^\.part-[a-f0-9]{32}-\d+$/
const UPLOAD_META_NAME = /^\.upload-[a-f0-9]{32}\.json$/

export function isStaleUploadPartName(name: string, ageMs: number, maxAgeMs = UPLOAD_PART_MAX_AGE_MS): boolean {
  if (!UPLOAD_PART_NAME.test(name) && !UPLOAD_META_NAME.test(name)) return false
  return ageMs >= maxAgeMs
}

/** A quota or single-file refusal will not succeed if the user only retries. */
export function uploadFailureCanContinue(message: string | undefined): boolean {
  if (!message) return true
  if (message.includes('请删除旧文件') || message.includes('免费额度')) return false
  if (message.includes('单个文件') && message.includes('超过')) return false
  return true
}
