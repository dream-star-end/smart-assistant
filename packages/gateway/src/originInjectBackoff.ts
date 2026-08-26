import type { CronOriginFireResult } from './cronOriginSession.js'

/** Shared with send_to_agent origin-inject: 12 attempts, 500ms → 5s. */
export const ORIGIN_INJECT_RETRY_BUDGET = 12
export const ORIGIN_INJECT_INITIAL_DELAY_MS = 500
export const ORIGIN_INJECT_MAX_DELAY_MS = 5_000

export function createUnrefSleep(): (ms: number) => Promise<void> {
  return (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
}

/**
 * Bounded backoff for origin-inject. Same budget/semantics as
 * injectSendToAgentCallback: retry retryable_failure (BUSY / NO_TRANSPORT /
 * persist/dispatch), stop on injected or fallback, give up after 12 tries.
 */
export async function runBoundedOriginInjectBackoff(opts: {
  tryOnce: () => Promise<CronOriginFireResult>
  isShuttingDown?: () => boolean
  shouldAbort?: () => boolean
  sleep?: (ms: number) => Promise<void>
  onBudgetExhausted?: () => void
}): Promise<CronOriginFireResult> {
  const sleep = opts.sleep ?? createUnrefSleep()
  let delayMs = ORIGIN_INJECT_INITIAL_DELAY_MS
  for (let attemptNo = 0; attemptNo < ORIGIN_INJECT_RETRY_BUDGET; attemptNo += 1) {
    if (opts.isShuttingDown?.()) return { kind: 'fallback' }
    if (opts.shouldAbort?.()) return { kind: 'fallback' }
    const attempt = await opts.tryOnce()
    if (attempt.kind === 'injected' || attempt.kind === 'fallback' || attempt.kind === 'terminal_failure') {
      return attempt
    }
    await sleep(delayMs)
    delayMs = Math.min(delayMs * 2, ORIGIN_INJECT_MAX_DELAY_MS)
  }
  opts.onBudgetExhausted?.()
  return { kind: 'fallback' }
}
