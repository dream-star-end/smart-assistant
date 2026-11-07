import { canonicalUserFailureCode } from '@openclaude/protocol'

/** Never trust an arbitrary container error as a user-facing failure code. */
export function rejectedDispatchFailureCode(res: { kind: string; userFailureCode?: unknown }): string {
  return (res.kind === 'ok' ? canonicalUserFailureCode(res.userFailureCode) : undefined)
    ?? 'DISPATCH_NOT_ACCEPTED'
}
