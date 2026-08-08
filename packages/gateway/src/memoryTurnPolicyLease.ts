import {
  MEMORY_TURN_POLICY_REFRESH_MS,
  type MemoryTurnPolicyDecision,
  clearMemoryTurnPolicy,
  writeMemoryTurnPolicy,
} from '@openclaude/storage'

interface LeaseDeps {
  write?: typeof writeMemoryTurnPolicy
  clear?: typeof clearMemoryTurnPolicy
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
}

export async function startMemoryTurnPolicyLease(args: {
  sessionKey: string
  decision: MemoryTurnPolicyDecision
  logicalTurnAbort: AbortController
  interrupt: () => unknown
  onRefreshFailure: (err: unknown) => void
  deps?: LeaseDeps
}): Promise<{ stop: () => Promise<void> }> {
  const write = args.deps?.write ?? writeMemoryTurnPolicy
  const clear = args.deps?.clear ?? clearMemoryTurnPolicy
  const setIntervalFn = args.deps?.setInterval ?? globalThis.setInterval
  const clearIntervalFn = args.deps?.clearInterval ?? globalThis.clearInterval
  await write(args.sessionKey, args.decision)

  let stopped = false
  let failed = false
  let pending = Promise.resolve()
  const renew = () => {
    if (stopped || failed) return
    pending = pending
      .then(() => write(args.sessionKey, args.decision))
      .catch((err) => {
        if (stopped || failed) return
        failed = true
        const abortError = Object.assign(new Error('memory turn policy refresh failed'), {
          cause: err,
        })
        args.logicalTurnAbort.abort(abortError)
        try { args.interrupt() } catch {}
        args.onRefreshFailure(err)
      })
  }
  const timer = setIntervalFn(renew, MEMORY_TURN_POLICY_REFRESH_MS)
  timer.unref?.()
  return {
    stop: async () => {
      stopped = true
      clearIntervalFn(timer)
      await pending
      // If unlink fails, leave an explicit deny record rather than a stale
      // allow. A deny write failure is still followed by unlink.
      await write(args.sessionKey, { allowed: false, reason: 'clean_default' }).catch(() => {})
      await clear(args.sessionKey)
    },
  }
}
