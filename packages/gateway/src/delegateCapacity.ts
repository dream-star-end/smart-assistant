/**
 * Delegate concurrency-cap copy. Review vs non-review use different effective
 * maxima (reserved slot). The numeric caps themselves live on Gateway;
 * this module only formats the user/model-visible reject string.
 */

export const DELEGATE_MAX_CONCURRENT_DELEGATIONS = 5
export const DELEGATE_REVIEW_RESERVED_SLOTS = 1

export function delegateConcurrencyCap(isReview: boolean): number {
  return isReview
    ? DELEGATE_MAX_CONCURRENT_DELEGATIONS
    : DELEGATE_MAX_CONCURRENT_DELEGATIONS - DELEGATE_REVIEW_RESERVED_SLOTS
}

export function formatDelegateConcurrencyReject(args: {
  isReview: boolean
  inUse: number
  perParentInUse?: number
  perParentMax?: number
  waitedS?: number
  queueFull?: boolean
  queueMaxWaiters?: number
}): string {
  const max = delegateConcurrencyCap(args.isReview)
  const role = args.isReview ? 'review' : 'non-review'
  const parts = [`max ${max} ${role}`, `in-use ${args.inUse}/${max}`]
  if (!args.isReview && args.perParentMax != null && args.perParentInUse != null) {
    const full = args.perParentInUse >= args.perParentMax
    parts.push(`per-parent ${args.perParentInUse}/${args.perParentMax}${full ? ' full' : ''}`)
  }
  let msg = `too many concurrent delegations (${parts.join('; ')})`
  if (args.queueFull) {
    const n = args.queueMaxWaiters ?? 8
    msg += `; 排队等待者已满(${n} 个)`
  } else if (args.waitedS !== undefined) {
    msg += `; 已等待 ${args.waitedS}s 资源仍紧张,请稍后重试`
  }
  return msg
}
