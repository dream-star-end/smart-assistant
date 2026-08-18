/**
 * Cursor ask_user MCP client helpers.
 *
 * Pinned CLI `2026.08.11-e8db854` hard-times out MCP `tools/call` at ~60.01s.
 * The timeout is not configurable and progress notifications cannot renew it.
 * 55s is the measured-safe wait; the HTTP client timeout sits a few seconds
 * above that wait budget but still under 60s so the tool always returns
 * before the wall. On any transport/HTTP failure we degrade to the detached
 * "already posted, end the turn" copy instead of throwing.
 */

export const ASK_USER_WAIT_MS = 55_000
/** A few seconds above the wait budget for persist + RTT; still < 60s. */
export const ASK_USER_HTTP_TIMEOUT_MS = 58_000

export const ASK_USER_POSTED_FALLBACK_MESSAGE = [
  'Your questions have been shown to the user in the web UI.',
  'End your turn now. Do not wait, poll, or call ask_user again for the same questions.',
  "The user's answer will arrive as your next ordinary user message.",
].join(' ')

export function remainingAskUserWaitMs(startedAt: number, now = Date.now()): number {
  return Math.max(0, Math.min(ASK_USER_WAIT_MS, ASK_USER_WAIT_MS - (now - startedAt)))
}

export function askUserHttpTimeoutMs(waitMs: number): number {
  return Math.min(ASK_USER_HTTP_TIMEOUT_MS, Math.max(5_000, waitMs + 3_000))
}

export function askUserPostedFallbackBody(): string {
  return JSON.stringify({
    status: 'posted',
    message: ASK_USER_POSTED_FALLBACK_MESSAGE,
  })
}

export function askUserToolPostedFallback(): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: askUserPostedFallbackBody() }] }
}

export function askUserToolResultFromGateway(res: {
  statusCode: number
  body: string
}): { content: Array<{ type: 'text'; text: string }> } {
  if (res.statusCode === 409) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'skipped',
          reason:
            'no active turn for interactive questions — present numbered options as plain text and end the turn',
        }),
      }],
    }
  }
  if (res.statusCode >= 200 && res.statusCode < 300) {
    const text = typeof res.body === 'string' && res.body.trim().length > 0
      ? res.body
      : askUserPostedFallbackBody()
    return { content: [{ type: 'text', text }] }
  }
  return askUserToolPostedFallback()
}
