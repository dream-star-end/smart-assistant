type OutboundPersistQueueState = {
  tail: Promise<void>;
  failedSeq: number | null;
};

/**
 * Serializes durable outbound writes per container/session namespace.
 *
 * A failure remains a monotonic barrier while at least one browser bridge is
 * attached to that namespace. Once the final browser bridge detaches, the
 * failed state is retired after its current tail drains, so a later reconnect
 * is not permanently poisoned by a failure from an earlier connection.
 */
export class OutboundPersistQueueCoordinator {
  constructor(private readonly isPermanentConflict: (error: unknown) => boolean) {}
  private readonly queues = new Map<string, OutboundPersistQueueState>();
  private readonly consumerCounts = new Map<string, number>();

  retain(key: string): void {
    this.consumerCounts.set(key, (this.consumerCounts.get(key) ?? 0) + 1);
  }

  release(key: string): void {
    const count = this.consumerCounts.get(key) ?? 0;
    if (count > 1) {
      this.consumerCounts.set(key, count - 1);
      return;
    }
    this.consumerCounts.delete(key);
    const state = this.queues.get(key);
    if (state !== undefined) this.scheduleCleanup(key, state, state.tail);
  }

  enqueue(
    key: string,
    frameSeq: number,
    work: () => Promise<void>,
    onFailure: (error: unknown) => void,
    onPermanentConflict?: (error: unknown) => void,
  ): void {
    let state = this.queues.get(key);
    if (!state) {
      state = { tail: Promise.resolve(), failedSeq: null };
      this.queues.set(key, state);
    }
    const task = state.tail.then(async () => {
      // A reconnect may replay the exact failed sequence from the container's
      // own ring. That exact retry is allowed to heal the namespace; a later
      // sequence must never overtake it while a browser generation is alive.
      if (state!.failedSeq !== null && state!.failedSeq !== frameSeq) {
        onFailure(new Error(`outbound durability blocked at frame ${state!.failedSeq}`));
        return;
      }
      try {
        await work();
        if (state!.failedSeq === frameSeq) state!.failedSeq = null;
      } catch (error) {
        if (this.isPermanentConflict(error)) {
          // An exact retry can turn a prior transient failure into a proven
          // permanent conflict. Retire only that same-sequence barrier; a
          // barrier for any other missing sequence must remain strict.
          if (state!.failedSeq === frameSeq) state!.failedSeq = null;
          onPermanentConflict?.(error);
          return;
        }
        state!.failedSeq = frameSeq;
        onFailure(error);
      }
    });
    state.tail = task;
    this.scheduleCleanup(key, state, task);
  }

  async drain(prefix?: string): Promise<void> {
    await Promise.allSettled([...this.queues.entries()]
      .filter(([key]) => prefix === undefined || key.startsWith(prefix))
      .map(([, state]) => state.tail));
  }

  snapshotForTest(): { queues: number; consumerKeys: number; consumers: number } {
    return {
      queues: this.queues.size,
      consumerKeys: this.consumerCounts.size,
      consumers: [...this.consumerCounts.values()].reduce((sum, count) => sum + count, 0),
    };
  }

  private scheduleCleanup(
    key: string,
    state: OutboundPersistQueueState,
    tail: Promise<void>,
  ): void {
    const cleanup = (): void => {
      if (
        this.queues.get(key) === state &&
        state.tail === tail &&
        (state.failedSeq === null || !this.consumerCounts.has(key))
      ) {
        this.queues.delete(key);
      }
    };
    void tail.then(cleanup, cleanup);
  }
}
