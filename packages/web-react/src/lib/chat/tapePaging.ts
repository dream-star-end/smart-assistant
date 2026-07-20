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
  inflight: boolean;
  consumedEpoch: number;
};

/**
 * Stable per-MessageList paging intent. Virtual rows may unmount at any time;
 * keeping the gesture epoch here prevents remounts or layout scrolls from
 * cascading through several cursors without a new upward user action.
 */
export class UserUpwardPagingController {
  private intentEpoch = 0;
  private lastScrollTop: number | null = null;
  private readonly generations = new Map<string, PagingGenerationState>();

  signalUpwardIntent(): void {
    this.intentEpoch += 1;
  }

  syncScrollTop(scrollTop: number): void {
    if (Number.isFinite(scrollTop)) this.lastScrollTop = scrollTop;
  }

  signalPointerScroll(scrollTop: number, emitIntent = true): boolean {
    if (!Number.isFinite(scrollTop)) return false;
    const movedUp = this.lastScrollTop !== null && scrollTop < this.lastScrollTop - 0.5;
    if (movedUp && emitIntent) {
      this.signalUpwardIntent();
    }
    this.lastScrollTop = scrollTop;
    return movedUp && emitIntent;
  }

  begin(generation: string, initialized: boolean): boolean {
    const state = this.generations.get(generation) ?? {
      tailStarted: false,
      inflight: false,
      consumedEpoch: 0,
    };
    this.generations.set(generation, state);
    if (state.inflight) return false;
    if (!initialized) {
      if (state.tailStarted) return false;
      state.tailStarted = true;
      state.inflight = true;
      return true;
    }
    if (this.intentEpoch <= state.consumedEpoch) return false;
    state.inflight = true;
    return true;
  }

  /** Consume every gesture observed while this request was in flight. */
  settle(generation: string): void {
    const state = this.generations.get(generation);
    if (!state) return;
    state.inflight = false;
    state.consumedEpoch = this.intentEpoch;
  }

  reset(generation: string): void {
    this.generations.delete(generation);
  }
}
