import {
  attachmentTotalExceededFailureCode,
  parseAttachmentTotalExceeded,
  parseIdleRecoveryPending,
} from '@openclaude/protocol'

/** Never trust an arbitrary container error as a user-facing failure code. */
export function rejectedDispatchFailureCode(res: { kind: string; userFailureCode?: unknown }): string {
  if (res.kind === 'ok') {
    const minutes = parseIdleRecoveryPending(res.userFailureCode)
    if (minutes) return `IDLE_RECOVERY_PENDING:${minutes}`
    const parsed = parseAttachmentTotalExceeded(res.userFailureCode)
    if (parsed) return attachmentTotalExceededFailureCode(parsed.totalBytes)
  }
  return 'DISPATCH_NOT_ACCEPTED'
}
