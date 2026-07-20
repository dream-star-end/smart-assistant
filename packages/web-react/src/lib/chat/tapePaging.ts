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
};

export type PagingClaim = {
  readonly generation: string;
  readonly token: number;
};

export function turnProcessPagingGeneration(
  historyGeneration: number | string,
  process: { id: string; _turnTapeId?: string; _turnTapeSha256?: string },
): string {
  return `${String(historyGeneration)}::${process.id}::${process._turnTapeId ?? ""}::${process._turnTapeSha256 ?? ""}`;
}

/** Stable per-MessageList owner for one automatic latest-tail read plus the
 * explicit-click FIFO shared by every older archive/tape page. */
export class UserUpwardPagingController {
  private interactionEpoch = 0;
  private nextToken = 0;
  private activeClaim: PagingClaim | null = null;
  private explicitPending = 0;
  private explicitTail: Promise<void> = Promise.resolve();
  private readonly explicitRequests = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, PagingGenerationState>();
  private readonly settledListeners = new Set<() => void>();

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

  /**
   * Explicit history requests share one FIFO across archive and tape pages.
   * This keeps their independent viewport anchors from consuming each
   * other's DOM insertion. Repeated clicks for the same immutable cursor
   * reuse the same promise instead of adding another request.
   */
  runExplicit<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.explicitRequests.get(key) as Promise<T> | undefined;
    if (existing) return existing;

    this.explicitPending += 1;
    const waitForAutomaticTail = () => {
      if (!this.activeClaim) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const unsubscribe = this.subscribeSettled(() => {
          if (this.activeClaim) return;
          unsubscribe();
          resolve();
        });
      });
    };
    const request = this.explicitTail.then(async () => {
      await waitForAutomaticTail();
      return task();
    });
    this.explicitTail = request.then(() => undefined, () => undefined);
    this.explicitRequests.set(key, request);
    const release = () => {
      if (this.explicitRequests.get(key) === request) {
        this.explicitRequests.delete(key);
      }
      this.explicitPending -= 1;
      for (const listener of [...this.settledListeners]) listener();
    };
    void request.then(release, release);
    return request;
  }

  begin(generation: string, initialized: boolean): PagingClaim | null {
    // Initialized cursors are never admitted automatically. Their visible
    // button invokes the exact cursor request directly.
    if (initialized) return null;
    const state = this.generations.get(generation) ?? {
      tailStarted: false,
    };
    this.generations.set(generation, state);
    if (this.activeClaim) return null;
    if (this.explicitPending > 0) return null;
    if (state.tailStarted) return null;
    state.tailStarted = true;
    const claim = { generation, token: ++this.nextToken };
    this.activeClaim = claim;
    return claim;
  }

  /** Only the request owning the token may release the controller-wide claim. */
  settle(claim: PagingClaim): void {
    if (this.activeClaim?.token !== claim.token) return;
    this.activeClaim = null;
    for (const listener of [...this.settledListeners]) listener();
  }

  reset(generation: string): void {
    this.generations.delete(generation);
  }
}
