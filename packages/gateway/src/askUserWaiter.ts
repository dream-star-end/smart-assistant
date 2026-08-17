/**
 * Single-flight state machine for the Cursor ask_user 55s hybrid wait.
 *
 * A pending question is owned by at most one consumer. Transitions are
 * synchronous assignments on `phase`, which is atomic on the Node event
 * loop: `tryAnswer` and `tryRelease` both check `phase === 'waiting'` and
 * write the terminal state in the same turn, so a waitMs-boundary race
 * cannot both deliver the tool result *and* start a new turn, and cannot
 * drop the answer either.
 *
 * Once `answered_in_window`, the HTTP waiter must either write the tool
 * result or compensate via dispatchInbound. `tryClaimDelivery` is the
 * one-shot gate so those two outcomes cannot both happen for one requestId.
 *
 *   waiting ──tryAnswer──► answered_in_window   (HTTP waiter consumes; no dispatchInbound
 *                                                unless the response can no longer be written)
 *          └──tryRelease─► released_to_detached (timeout / client abort; later answers start a turn)
 */

export const ASK_USER_WAIT_MS = 55_000
export const ASK_USER_WAIT_MS_MAX = 55_000
/** Legacy clients omit waitMs; stay fully detached (immediate posted). */
export const ASK_USER_WAIT_MS_DEFAULT = 0

export type AskUserWaiterPhase = 'waiting' | 'answered_in_window' | 'released_to_detached'

export type AskUserWaiterAnswer = {
  behavior: 'allow' | 'deny'
  answers?: Record<string, string>
  answerText?: string
}

export type AskUserWaiterResult =
  | { status: 'answered'; answer: AskUserWaiterAnswer }
  | { status: 'posted' }

/**
 * Wait budget for the HTTP ask_user call.
 *
 * Missing / empty / non-numeric values MUST be 0: old mcp-memory clients
 * do not send waitMs and only tolerate ~15s HTTP. Defaulting those to 55s
 * would hold the response until after the client gave up; if the socket
 * was not destroyed, tryAnswer could then swallow the click in-window
 * and never start a new turn.
 *
 * Only an explicit finite number enters the hybrid window, clamped to
 * [0, ASK_USER_WAIT_MS_MAX] (55s, under the 60s MCP tools/call wall).
 */
export function resolveAskUserWaitMs(raw: unknown): number {
  if (raw == null || raw === '') return ASK_USER_WAIT_MS_DEFAULT
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return ASK_USER_WAIT_MS_DEFAULT
  return Math.max(0, Math.min(ASK_USER_WAIT_MS_MAX, Math.floor(n)))
}

/**
 * True when the in-flight HTTP waiter can no longer write a tool result
 * (client gone, response already finished, or the socket is already dead
 * even if 'close' has not been dispatched yet).
 */
export function askUserHttpUnwritable(
  req: {
    destroyed?: boolean
    aborted?: boolean
    socket?: { destroyed?: boolean } | null
  },
  res: {
    headersSent?: boolean
    writableEnded?: boolean
    destroyed?: boolean
    writable?: boolean
    socket?: { destroyed?: boolean } | null
  },
): boolean {
  return Boolean(
    req.destroyed ||
    req.aborted ||
    req.socket?.destroyed ||
    res.destroyed ||
    res.headersSent ||
    res.writableEnded ||
    res.writable === false ||
    res.socket?.destroyed,
  )
}

/** True when sendJson appears to have finished writing a complete response. */
export function askUserHttpWriteSucceeded(res: {
  destroyed?: boolean
  headersSent?: boolean
  writableEnded?: boolean
}): boolean {
  return Boolean(!res.destroyed && res.headersSent && res.writableEnded)
}

export class AskUserWaiter {
  private phase: AskUserWaiterPhase = 'waiting'
  private result: AskUserWaiterResult | null = null
  private resolveWait: ((result: AskUserWaiterResult) => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /**
   * One-shot delivery/compensation claim. Assigned synchronously inside
   * `tryClaimDelivery` so HTTP write and dispatchInbound cannot both fire.
   */
  private deliveryClaimed = false
  private readonly waitPromise: Promise<AskUserWaiterResult>

  constructor() {
    this.waitPromise = new Promise((resolve) => {
      this.resolveWait = resolve
    })
  }

  getPhase(): AskUserWaiterPhase {
    return this.phase
  }

  getAnswer(): AskUserWaiterAnswer | null {
    if (this.result?.status !== 'answered') return null
    return this.result.answer
  }

  /**
   * Claim exclusive right to deliver an in-window answer — either by writing
   * the HTTP tool result or by compensating with dispatchInbound.
   * Returns true iff this caller won. Must not await between the check and
   * the assignment.
   */
  tryClaimDelivery(): boolean {
    if (this.phase !== 'answered_in_window') return false
    if (this.deliveryClaimed) return false
    this.deliveryClaimed = true
    return true
  }

  /**
   * Claim the in-window answer. Returns true iff this caller won.
   * Must not await between the phase check and the write.
   */
  tryAnswer(answer: AskUserWaiterAnswer): boolean {
    if (this.phase !== 'waiting') return false
    this.phase = 'answered_in_window'
    this.result = { status: 'answered', answer }
    this.clearTimer()
    this.finish(this.result)
    return true
  }

  /**
   * Release the question back to detached semantics. Returns true iff this
   * caller won (timeout, client abort, or waitMs=0).
   */
  tryRelease(): boolean {
    if (this.phase !== 'waiting') return false
    this.phase = 'released_to_detached'
    this.result = { status: 'posted' }
    this.clearTimer()
    this.finish(this.result)
    return true
  }

  /** Arm the waitMs timer. No-op once the waiter is already terminal. */
  startTimer(waitMs: number): void {
    if (this.phase !== 'waiting') return
    if (waitMs <= 0) {
      this.tryRelease()
      return
    }
    this.timer = setTimeout(() => {
      this.tryRelease()
    }, waitMs)
  }

  wait(): Promise<AskUserWaiterResult> {
    return this.waitPromise
  }

  dispose(): void {
    this.tryRelease()
  }

  private finish(result: AskUserWaiterResult): void {
    const resolve = this.resolveWait
    this.resolveWait = null
    resolve?.(result)
  }

  private clearTimer(): void {
    if (this.timer == null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
