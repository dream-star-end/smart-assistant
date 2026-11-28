type OutboundPersistQueueState = {
  tail: Promise<void>;
  failedSeq: number | null;
};

function isPermanentLiveFrameConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { liveFramePermanentConflict?: unknown }).liveFramePermanentConflict === true
  );
}

/**
 * Serializes durable outbound writes per container/session namespace.
 *
 * A failure remains a monotonic barrier while at least one browser bridge is
 * attached to that namespace. Once the final browser bridge detaches, the
 * failed state is retired after its current tail drains, so a later reconnect
 * is not permanently poisoned by a failure from an earlier connection.
 */
export class _OutboundPersistQueueCoordinator {
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
    const currentState = state;
    const task = currentState.tail.then(async () => {
      if (currentState.failedSeq !== null && currentState.failedSeq !== frameSeq) {
        onFailure(new Error(`outbound durability blocked at frame ${currentState.failedSeq}`));
        return;
      }
      try {
        await work();
        if (currentState.failedSeq === frameSeq) currentState.failedSeq = null;
      } catch (error) {
        if (isPermanentLiveFrameConflict(error)) {
          if (currentState.failedSeq === frameSeq) currentState.failedSeq = null;
          onPermanentConflict?.(error);
          return;
        }
        currentState.failedSeq = frameSeq;
        onFailure(error);
      }
    });
    currentState.tail = task;
    this.scheduleCleanup(key, currentState, task);
  }

  async drain(keys?: Iterable<string>): Promise<void> {
    if (!keys) {
      await Promise.allSettled([...this.queues.values()].map((state) => state.tail));
      return;
    }
    const tails: Promise<void>[] = [];
    for (const key of keys) {
      const state = this.queues.get(key);
      if (state) tails.push(state.tail);
    }
    if (tails.length > 0) {
      await Promise.allSettled(tails);
    }
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
