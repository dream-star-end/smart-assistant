export type TapePageResultMeta = {
  nextCursor: number | null;
  total: number;
};

type TapePageBegin =
  | { kind: "start" }
  | { kind: "busy" }
  | { kind: "completed"; result: TapePageResultMeta };

/**
 * Page-lifetime network ledger for immutable tape cursors. It stores only the
 * tiny result metadata; the session message array remains the sole record
 * payload owner.
 */
export class TapePageRequestLedger {
  private readonly inflight = new Set<string>();
  private readonly completed = new Map<string, TapePageResultMeta>();

  begin(key: string): TapePageBegin {
    const result = this.completed.get(key);
    if (result) return { kind: "completed", result };
    if (this.inflight.has(key)) return { kind: "busy" };
    this.inflight.add(key);
    return { kind: "start" };
  }

  succeed(key: string, result: TapePageResultMeta): void {
    this.inflight.delete(key);
    this.completed.set(key, result);
  }

  fail(key: string): void {
    this.inflight.delete(key);
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const key of this.inflight) {
      if (key.startsWith(prefix)) this.inflight.delete(key);
    }
    for (const key of this.completed.keys()) {
      if (key.startsWith(prefix)) this.completed.delete(key);
    }
  }

  clear(): void {
    this.inflight.clear();
    this.completed.clear();
  }
}

type PagingGenerationState = {
  tailStarted: boolean;
  tailFailed: boolean;
};

export type PagingClaim = {
  readonly generation: string;
  readonly token: number;
};

/**
 * Stable per-MessageList paging intent. Virtual rows may unmount at any time;
 * keeping the gesture epoch here prevents remounts or layout scrolls from
 * cascading through several cursors without a new upward user action.
 */
export class UserUpwardPagingController {
  private intentEpoch = 0;
  private consumedEpoch = 0;
  private interactionEpoch = 0;
  private nextToken = 0;
  private lastScrollTop: number | null = null;
  private activeClaim: PagingClaim | null = null;
  private readonly generations = new Map<string, PagingGenerationState>();
  private readonly settledListeners = new Set<() => void>();

  signalUpwardIntent(): void {
    this.intentEpoch += 1;
    this.interactionEpoch += 1;
  }

  signalUserInteraction(): void {
    this.interactionEpoch += 1;
  }

  interactionVersion(): number {
    return this.interactionEpoch;
  }

  subscribeSettled(listener: () => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  syncScrollTop(scrollTop: number): void {
    if (Number.isFinite(scrollTop)) this.lastScrollTop = scrollTop;
  }

  signalPointerScroll(scrollTop: number, emitIntent = true): boolean {
    if (!Number.isFinite(scrollTop)) return false;
    const movedUp = this.lastScrollTop !== null && scrollTop < this.lastScrollTop - 0.5;
    const moved = this.lastScrollTop !== null && Math.abs(scrollTop - this.lastScrollTop) > 0.5;
    if (moved) this.interactionEpoch += 1;
    if (movedUp && emitIntent) {
      this.intentEpoch += 1;
    }
    this.lastScrollTop = scrollTop;
    return movedUp && emitIntent;
  }

  begin(generation: string, initialized: boolean, manual = false): PagingClaim | null {
    const state = this.generations.get(generation) ?? {
      tailStarted: false,
      tailFailed: false,
    };
    this.generations.set(generation, state);
    if (this.activeClaim) return null;
    if (!initialized) {
      if (state.tailStarted && !manual) return null;
      // A visible tape tail is part of the initial history viewport and loads
      // once automatically. The controller-wide claim still serializes tails
      // from different turns; only older cursors require an upward gesture.
      state.tailStarted = true;
      state.tailFailed = false;
    } else if (this.intentEpoch <= this.consumedEpoch) {
      return null;
    }
    const claim = { generation, token: ++this.nextToken };
    this.activeClaim = claim;
    return claim;
  }

  /** Only the request owning the token may release the controller-wide claim. */
  settle(claim: PagingClaim): void {
    if (this.activeClaim?.token !== claim.token) return;
    this.activeClaim = null;
    // Consume every gesture observed while this request was in flight so
    // trackpad inertia cannot immediately admit the next physical page.
    this.consumedEpoch = this.intentEpoch;
    for (const listener of [...this.settledListeners]) listener();
  }

  /** A failed initial-tail owner that disappeared cannot show its retry CTA. */
  rearmTail(claim: PagingClaim): void {
    if (this.activeClaim?.token !== claim.token) return;
    this.generations.delete(claim.generation);
  }

  markTailFailed(claim: PagingClaim): void {
    if (this.activeClaim?.token !== claim.token) return;
    const state = this.generations.get(claim.generation);
    if (state) state.tailFailed = true;
  }

  /** Local retry UI disappears with its virtual row; make the tail admissible again. */
  rearmFailedTail(generation: string): void {
    const state = this.generations.get(generation);
    if (!state?.tailFailed || this.activeClaim?.generation === generation) return;
    state.tailStarted = false;
    state.tailFailed = false;
  }

  reset(generation: string): void {
    this.generations.delete(generation);
  }
}
