import { describe, expect, test, vi } from "vitest";
import { DeferredPayloadQueue } from "./deferredPayloadQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("DeferredPayloadQueue", () => {
  test("admits at most two whole records and preserves FIFO order", async () => {
    const queue = new DeferredPayloadQueue<string>(2);
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const request = (key: string) => queue.request(key, async () => {
      started.push(key);
      const gate = deferred<string>();
      gates.set(key, gate);
      return gate.promise;
    });

    const a = request("a");
    const b = request("b");
    const c = request("c");
    const d = request("d");
    await vi.waitFor(() => expect(started).toEqual(["a", "b"]));

    gates.get("b")!.resolve("B");
    await expect(b).resolves.toBe("B");
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]));
    gates.get("a")!.resolve("A");
    await expect(a).resolves.toBe("A");
    await vi.waitFor(() => expect(started).toEqual(["a", "b", "c", "d"]));

    gates.get("c")!.resolve("C");
    gates.get("d")!.resolve("D");
    await expect(Promise.all([c, d])).resolves.toEqual(["C", "D"]);
  });

  test("same immutable key shares one in-flight download", async () => {
    const queue = new DeferredPayloadQueue<object>(2);
    const gate = deferred<object>();
    const run = vi.fn(() => gate.promise);

    const first = queue.request("same", run);
    const second = queue.request("same", run);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const value = { exact: true };
    gate.resolve(value);

    await expect(first).resolves.toBe(value);
    await expect(second).resolves.toBe(value);
  });

  test("quick-scroll cancellation drops queued work and aborts an orphaned active fetch", async () => {
    const queue = new DeferredPayloadQueue<string>(1);
    const activeSubscriber = new AbortController();
    const queuedSubscriber = new AbortController();
    let internalSignal: AbortSignal | null = null;
    const activeRun = vi.fn((signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      internalSignal = signal;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    }));
    const queuedRun = vi.fn(async () => "queued");

    const active = queue.request("active", activeRun, activeSubscriber.signal);
    const queued = queue.request("queued", queuedRun, queuedSubscriber.signal);
    await vi.waitFor(() => expect(activeRun).toHaveBeenCalledTimes(1));
    queuedSubscriber.abort();
    await expect(queued).resolves.toBeNull();
    expect(queuedRun).not.toHaveBeenCalled();

    activeSubscriber.abort();
    await expect(active).resolves.toBeNull();
    await vi.waitFor(() => expect(internalSignal?.aborted).toBe(true));
  });

  test("failed identity can be retried as a fresh task", async () => {
    const queue = new DeferredPayloadQueue<string>(2);
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("range failed"))
      .mockResolvedValueOnce("complete exact payload");

    await expect(queue.request("retryable", run)).resolves.toBeNull();
    await expect(queue.request("retryable", run)).resolves.toBe("complete exact payload");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
