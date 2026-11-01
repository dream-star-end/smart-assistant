import {
  attachmentTotalExceededFailureCode,
  parseAttachmentTotalExceeded,
} from '@openclaude/protocol'

/** Container-supplied code is accepted only when it is the attachment-total shape. */
export function rejectedDispatchFailureCode(res: { kind: string; userFailureCode?: unknown }): string {
  if (res.kind === 'ok') {
    const parsed = parseAttachmentTotalExceeded(res.userFailureCode)
    if (parsed) return attachmentTotalExceededFailureCode(parsed.totalBytes)
  }
  return 'DISPATCH_NOT_ACCEPTED'
}
