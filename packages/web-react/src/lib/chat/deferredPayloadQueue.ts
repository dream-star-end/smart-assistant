type DeferredPayloadRun<T> = (signal: AbortSignal) => Promise<T | null>;

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
  generation: number;
};

/**
 * Small shared admission queue for immutable deferred payloads.
 *
 * Page size and record size remain unlimited totals: this only bounds how many
 * whole-record buffers may be downloading/parsing at once. Requests for the
 * same immutable identity share one task. Successfully verified results stay
 * resident for this page lifetime, so a virtual-row remount never replaces
 * real content with a loader or downloads the same bytes again. There is no
 * content/count cap: refresh, logout or an account switch destroys the cache.
 */
export class DeferredPayloadQueue<T> {
  private readonly entries = new Map<string, DeferredPayloadEntry<T>>();
  private readonly queued: DeferredPayloadEntry<T>[] = [];
  private readonly completed = new Map<string, T>();
  private active = 0;
  private generation = 0;

  constructor(private readonly maxActive = 2) {}

  request(
    key: string,
    run: DeferredPayloadRun<T>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.completed.has(key)) return Promise.resolve(this.completed.get(key)!);

    return new Promise<T | null>((resolve) => {
      let entry = this.entries.get(key);
      if (!entry) {
        entry = {
          key,
          run,
          controller: new AbortController(),
          subscribers: new Set(),
          state: "queued",
          generation: this.generation,
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

  /** Synchronous first-paint lookup for virtual rows remounting in this page. */
  peek(key: string): T | null {
    return this.completed.get(key) ?? null;
  }

  /** Account/session teardown: no old-identity task may survive into the next view. */
  cancelAll(): void {
    this.generation += 1;
    this.completed.clear();
    this.queued.length = 0;
    for (const entry of [...this.entries.values()]) {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      for (const subscriber of entry.subscribers) {
        if (subscriber.onAbort && subscriber.signal) {
          subscriber.signal.removeEventListener("abort", subscriber.onAbort);
        }
        subscriber.resolve(null);
      }
      entry.subscribers.clear();
      if (entry.state === "active") {
        this.active -= 1;
        entry.controller.abort();
      }
      entry.state = "finished";
    }
    this.pump();
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

    if (entry.state === "queued") {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      const index = this.queued.indexOf(entry);
      if (index >= 0) this.queued.splice(index, 1);
      entry.state = "finished";
      this.pump();
      return;
    }
    // At most two already-started immutable reads may finish without a mounted
    // subscriber. Keeping them alive is what makes quick scroll + remount
    // resident instead of repeatedly aborting and restarting the same bytes.
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
    if (value !== null && entry.generation === this.generation) {
      this.completed.set(entry.key, value);
    }
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
