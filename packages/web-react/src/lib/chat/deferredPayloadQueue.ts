type DeferredPayloadRun<T> = (signal: AbortSignal) => Promise<T>;

type DeferredPayloadSubscriber<T> = {
  resolve: (value: T | null) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type DeferredPayloadEntry<T> = {
  key: string;
  run: DeferredPayloadRun<T>;
  controller: AbortController;
  subscribers: Set<DeferredPayloadSubscriber<T>>;
  state: "queued" | "active" | "finished";
};

/**
 * Small shared admission queue for immutable deferred payloads.
 *
 * Page size and record size remain unlimited totals: this only bounds how many
 * whole-record buffers may be downloading/parsing at once. Requests for the
 * same immutable identity share one task. Each viewport card owns a
 * subscription, so leaving overscan cancels queued work and aborts active work
 * once its last subscriber disappears.
 */
export class DeferredPayloadQueue<T> {
  private readonly entries = new Map<string, DeferredPayloadEntry<T>>();
  private readonly queued: DeferredPayloadEntry<T>[] = [];
  private active = 0;

  constructor(private readonly maxActive = 2) {}

  request(
    key: string,
    run: DeferredPayloadRun<T>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    if (signal?.aborted) return Promise.resolve(null);

    return new Promise<T | null>((resolve) => {
      let entry = this.entries.get(key);
      if (!entry) {
        entry = {
          key,
          run,
          controller: new AbortController(),
          subscribers: new Set(),
          state: "queued",
        };
        this.entries.set(key, entry);
        this.queued.push(entry);
      }

      const subscriber: DeferredPayloadSubscriber<T> = { resolve, signal };
      entry.subscribers.add(subscriber);
      if (signal) {
        subscriber.onAbort = () => this.unsubscribe(entry!, subscriber);
        signal.addEventListener("abort", subscriber.onAbort, { once: true });
      }
      this.pump();
    });
  }

  /** Account/session teardown: no old-identity task may survive into the next view. */
  cancelAll(): void {
    for (const entry of [...this.entries.values()]) {
      for (const subscriber of [...entry.subscribers]) {
        this.unsubscribe(entry, subscriber);
      }
    }
  }

  private unsubscribe(
    entry: DeferredPayloadEntry<T>,
    subscriber: DeferredPayloadSubscriber<T>,
  ): void {
    if (!entry.subscribers.delete(subscriber)) return;
    if (subscriber.onAbort && subscriber.signal) {
      subscriber.signal.removeEventListener("abort", subscriber.onAbort);
    }
    subscriber.resolve(null);
    if (entry.subscribers.size > 0) return;

    // Do not let a new subscriber attach to an already-aborted active entry.
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (entry.state === "queued") {
      const index = this.queued.indexOf(entry);
      if (index >= 0) this.queued.splice(index, 1);
      entry.state = "finished";
      this.pump();
      return;
    }
    if (entry.state === "active") entry.controller.abort();
  }

  private pump(): void {
    while (this.active < this.maxActive && this.queued.length > 0) {
      const entry = this.queued.shift()!;
      if (entry.state !== "queued" || entry.subscribers.size === 0) continue;
      entry.state = "active";
      this.active += 1;
      void Promise.resolve()
        .then(() => entry.run(entry.controller.signal))
        .then(
          (value) => this.finish(entry, value),
          () => this.finish(entry, null),
        );
    }
  }

  private finish(entry: DeferredPayloadEntry<T>, value: T | null): void {
    if (entry.state !== "active") return;
    entry.state = "finished";
    this.active -= 1;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    for (const subscriber of [...entry.subscribers]) {
      entry.subscribers.delete(subscriber);
      if (subscriber.onAbort && subscriber.signal) {
        subscriber.signal.removeEventListener("abort", subscriber.onAbort);
      }
      subscriber.resolve(value);
    }
    this.pump();
  }
}
