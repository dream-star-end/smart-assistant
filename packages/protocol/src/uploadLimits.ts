// Single source for the per-file and per-message upload caps.
// The numeric values are a product limit: do not change them here to paper over a UX bug.
// 100MiB matches the single-request body cap. 2GiB is the referenced attachment total.
// Inline text stays at 300MiB because those bytes are copied into the frame.

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
