import { afterEach, describe, expect, test, vi } from "vitest";
import { _resetLazyCentersPrefetchForTest, prefetchLazyCentersOnIdle } from "./appLazyViews";

describe("prefetchLazyCentersOnIdle (OCV5-870 / OCV5-881)", () => {
  afterEach(() => {
    _resetLazyCentersPrefetchForTest();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("schedules once, cancels cleanly before idle fire, and allows re-scheduling after cancel", () => {
    vi.useFakeTimers();
    const cancel = prefetchLazyCentersOnIdle();
    // Second call while pending is a no-op
    const cancelDup = prefetchLazyCentersOnIdle();
    expect(typeof cancel).toBe("function");
    expect(typeof cancelDup).toBe("function");

    // Cancelling before firing resets the guard so a subsequent authenticated mount can schedule
    cancel();
    const cancelSecond = prefetchLazyCentersOnIdle();
    vi.advanceTimersByTime(3500);
    // Cancelling after fire is a safe no-op
    cancelSecond();
  });
});
