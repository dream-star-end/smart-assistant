import { afterEach, expect, test, vi } from "vitest";
import {
  REFRESH_BC_CLAIM_WAIT_MS,
  REFRESH_CROSS_TAB_LOCK_NAME,
  withBroadcastClaim,
  withCrossTabRefreshLock,
} from "./refreshCrossTabLock";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("uses navigator.locks exclusive request when available", async () => {
  const order: string[] = [];
  const request = vi.fn(async (_name: string, _opts: unknown, cb: () => Promise<string>) => {
    order.push("lock-enter");
    const result = await cb();
    order.push("lock-exit");
    return result;
  });
  vi.stubGlobal("navigator", { locks: { request } });

  const out = await withCrossTabRefreshLock(async () => {
    order.push("run");
    return "ok";
  });

  expect(out).toBe("ok");
  expect(request).toHaveBeenCalledWith(
    REFRESH_CROSS_TAB_LOCK_NAME,
    { mode: "exclusive" },
    expect.any(Function),
  );
  expect(order).toEqual(["lock-enter", "run", "lock-exit"]);
});

test("falls through when locks API missing (unit/SSR)", async () => {
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("BroadcastChannel", undefined);
  const out = await withCrossTabRefreshLock(async () => 42);
  expect(out).toBe(42);
});

test("serializes two overlapping lock holders via Web Locks", async () => {
  type Waiter = { resolve: () => void };
  const queue: Waiter[] = [];
  let held = false;
  const request = vi.fn(async (_name: string, _opts: unknown, cb: () => Promise<number>) => {
    if (held) {
      await new Promise<void>((resolve) => queue.push({ resolve }));
    }
    held = true;
    try {
      return await cb();
    } finally {
      held = false;
      const next = queue.shift();
      next?.resolve();
    }
  });
  vi.stubGlobal("navigator", { locks: { request } });

  let concurrent = 0;
  let maxConcurrent = 0;
  const job = async (n: number) =>
    withCrossTabRefreshLock(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent -= 1;
      return n;
    });

  const [a, b] = await Promise.all([job(1), job(2)]);
  expect([a, b].sort()).toEqual([1, 2]);
  expect(maxConcurrent).toBe(1);
  expect(request).toHaveBeenCalledTimes(2);
});

/**
 * In-memory BroadcastChannel hub — delivers to other instances of the same name.
 * Models the browser: no history replay for late subscribers.
 */
function installFakeBroadcastChannel() {
  type Handler = (event: MessageEvent) => void;
  const rooms = new Map<string, Set<{ handler: Handler | null; closed: boolean }>>();

  class FakeBroadcastChannel {
    name: string;
    private handler: Handler | null = null;
    private closed = false;
    private slot: { handler: Handler | null; closed: boolean };

    constructor(name: string) {
      this.name = name;
      this.slot = { handler: null, closed: false };
      let set = rooms.get(name);
      if (!set) {
        set = new Set();
        rooms.set(name, set);
      }
      set.add(this.slot);
    }

    postMessage(data: unknown) {
      if (this.closed) return;
      const set = rooms.get(this.name);
      if (!set) return;
      for (const peer of set) {
        if (peer === this.slot || peer.closed) continue;
        peer.handler?.({ data } as MessageEvent);
      }
    }

    addEventListener(type: string, fn: Handler) {
      if (type === "message") {
        this.handler = fn;
        this.slot.handler = fn;
      }
    }

    removeEventListener(type: string, fn: Handler) {
      if (type === "message" && this.handler === fn) {
        this.handler = null;
        this.slot.handler = null;
      }
    }

    close() {
      this.closed = true;
      this.slot.closed = true;
      rooms.get(this.name)?.delete(this.slot);
    }
  }

  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  vi.stubGlobal("window", globalThis);
}

test("BroadcastChannel: late joiner waits — holder answers busy (Codex P1)", async () => {
  installFakeBroadcastChannel();
  vi.stubGlobal("navigator", {});

  let concurrent = 0;
  let maxConcurrent = 0;
  let aStarted!: () => void;
  const aEntered = new Promise<void>((r) => {
    aStarted = r;
  });
  let releaseA!: () => void;
  const aHold = new Promise<void>((r) => {
    releaseA = r;
  });

  const jobA = withBroadcastClaim(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    aStarted();
    await aHold;
    concurrent -= 1;
    return "a";
  });

  await aEntered;
  // A holds; B claims after A's claim window — must receive busy and wait.
  const jobBPromise = withBroadcastClaim(async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 10));
    concurrent -= 1;
    return "b";
  });

  // Give B time to claim + settle; must still be waiting (concurrent stays 1).
  await new Promise((r) => setTimeout(r, REFRESH_BC_CLAIM_WAIT_MS + 40));
  expect(maxConcurrent).toBe(1);
  expect(concurrent).toBe(1);

  releaseA();
  const [a, b] = await Promise.all([jobA, jobBPromise]);
  expect(a).toBe("a");
  expect(b).toBe("b");
  expect(maxConcurrent).toBe(1);
});

test("BroadcastChannel: overlapping acquires serialize", async () => {
  installFakeBroadcastChannel();
  vi.stubGlobal("navigator", {});

  let concurrent = 0;
  let maxConcurrent = 0;
  const job = async (n: number) =>
    withBroadcastClaim(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 40));
      concurrent -= 1;
      return n;
    });

  const [a, b] = await Promise.all([job(1), job(2)]);
  expect([a, b].sort()).toEqual([1, 2]);
  expect(maxConcurrent).toBe(1);
});
