import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("./bodies");
  vi.resetModules();
  vi.useRealTimers();
});

describe("preloadToolBody", () => {
  test("a failed load is not cached: the next call loads again", async () => {
    vi.resetModules();
    let attempts = 0;
    vi.doMock("./bodies", () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk gone");
      return { ToolBody: () => null };
    });
    const { preloadToolBody } = await import("./lazyToolBody");

    await expect(preloadToolBody()).rejects.toThrow();
    const module = await preloadToolBody();
    expect(typeof module.ToolBody).toBe("function");
    expect(attempts).toBe(2);
  });

  test("the idle prefetch swallows a failed load instead of leaving an unhandled rejection", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.doMock("./bodies", () => {
      throw new Error("offline");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await import("./lazyToolBody");
      await vi.advanceTimersByTimeAsync(1500);
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
