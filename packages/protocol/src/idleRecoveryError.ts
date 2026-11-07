import { attachmentTotalExceededFailureCode, parseAttachmentTotalExceeded } from './uploadLimits.js'

export function parseIdleRecoveryPending(code: unknown): number | undefined {
  if (typeof code !== 'string') return undefined
  const match = /^IDLE_RECOVERY_PENDING:([1-9]|1[0-5])$/i.exec(code)
  return match ? Number(match[1]) : undefined
}
export function idleRecoveryPendingMessage(minutes: number): string {
  return `正在整理长对话，约 ${minutes} 分钟后可继续。本条消息尚未处理，未计费。`
}
/** Narrow durable pre-start rejection allowlist, shared by container and master. */
export function canonicalUserFailureCode(code: unknown): string | undefined {
  const minutes = parseIdleRecoveryPending(code)
  if (minutes) return `IDLE_RECOVERY_PENDING:${minutes}`
  const attachment = parseAttachmentTotalExceeded(code)
  return attachment ? attachmentTotalExceededFailureCode(attachment.totalBytes) : undefined
}
