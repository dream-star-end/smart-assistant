import { afterEach, expect, test, vi } from "vitest";
import {
  REFRESH_CROSS_TAB_LOCK_NAME,
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

test("serializes two overlapping lock holders", async () => {
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
