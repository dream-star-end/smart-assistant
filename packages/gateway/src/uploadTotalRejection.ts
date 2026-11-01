import {
  attachmentTotalExceededFailureCode,
  attachmentTotalLimitMessage,
  parseAttachmentTotalExceeded,
} from '@openclaude/protocol'


/** Sum every attachment. Callers reject with this total, never with the prefix that first crossed the cap. */
export function messageAttachmentTotal(sizes: readonly number[]): number {
  let total = 0
  for (const size of sizes) {
    if (!Number.isFinite(size) || size < 0) {
      throw new RangeError('attachment size must be a non-negative finite number')
    }
    total += size
  }
  if (!Number.isSafeInteger(Math.floor(total))) {
    throw new RangeError('attachment total is not a safe integer')
  }
  return total
}

/** Stamp the frame the durable admission finally will read. Returns the user-facing reason. */
export function noteAttachmentTotalRejection(frame: object, totalBytes: number): string {
  const message = attachmentTotalLimitMessage(totalBytes)
  ;(frame as { __oc_upload_user_failure_code?: string }).__oc_upload_user_failure_code =
    attachmentTotalExceededFailureCode(totalBytes)
  return message
}

/** Only the attachment-total code is forwarded. Other reject reasons stay generic. */
export function readUploadUserFailureCode(frame: object): string | undefined {
  const code = (frame as { __oc_upload_user_failure_code?: unknown }).__oc_upload_user_failure_code
  const parsed = parseAttachmentTotalExceeded(code)
  return parsed ? attachmentTotalExceededFailureCode(parsed.totalBytes) : undefined
}
