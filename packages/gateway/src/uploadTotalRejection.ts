import {
  attachmentTotalExceededFailureCode,
  attachmentTotalLimitMessage,
  parseAttachmentTotalExceeded,
} from '@openclaude/protocol'

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
