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
 *   waiting ──tryAnswer──► answered_in_window   (HTTP waiter consumes; no dispatchInbound)
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

export class AskUserWaiter {
  private phase: AskUserWaiterPhase = 'waiting'
  private result: AskUserWaiterResult | null = null
  private resolveWait: ((result: AskUserWaiterResult) => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly waitPromise: Promise<AskUserWaiterResult>

  constructor() {
    this.waitPromise = new Promise((resolve) => {
      this.resolveWait = resolve
    })
  }

  getPhase(): AskUserWaiterPhase {
    return this.phase
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
