import { describe, expect, test } from "vitest";
import {
  PAINT_ESTIMATE_PX,
  PAINT_MIN_ITEMS,
  computePaintRange,
  createRowGeometryWarmup,
  indexAtOffsetPx,
  measureRowSlice,
} from "./timelinePaint";

function keys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `row-${i}`);
}

function keyAt(ids: string[]) {
  return (index: number) => ids[index] ?? "";
}

describe("computePaintRange prefix sums", () => {
  test("unmeasured rows fall back to 200px", () => {
    const ids = keys(20);
    const heights = new Map<string, number>();
    expect(indexAtOffsetPx(20, 0, keyAt(ids), heights)).toBe(0);
    expect(indexAtOffsetPx(20, 199, keyAt(ids), heights)).toBe(0);
    expect(indexAtOffsetPx(20, 200, keyAt(ids), heights)).toBe(1);
    expect(indexAtOffsetPx(20, 201, keyAt(ids), heights)).toBe(1);
    expect(indexAtOffsetPx(20, 10_000, keyAt(ids), heights)).toBe(20);

    const range = computePaintRange({
      count: 20,
      scrollTop: 0,
      clientHeight: 400,
      followBottom: false,
      keyAt: keyAt(ids),
      heights,
    });
    expect(range.start).toBe(0);
    expect(range.end).toBeGreaterThanOrEqual(PAINT_MIN_ITEMS);
    expect(range.end).toBeLessThanOrEqual(20);
  });

  test("measured heights locate start/end by pixel, mixed with 200px holes", () => {
    const ids = keys(30);
    const heights = new Map<string, number>([
      ["row-0", 100],
      ["row-1", 400],
      // row-2 unmeasured → 200
      ["row-3", 800],
    ]);
    // prefix: 0, 100, 500, 700, 1500, then +200 each
    expect(indexAtOffsetPx(30, 99, keyAt(ids), heights)).toBe(0);
    expect(indexAtOffsetPx(30, 100, keyAt(ids), heights)).toBe(1);
    expect(indexAtOffsetPx(30, 500, keyAt(ids), heights)).toBe(2);
    expect(indexAtOffsetPx(30, 700, keyAt(ids), heights)).toBe(3);
    expect(indexAtOffsetPx(30, 1500, keyAt(ids), heights)).toBe(4);

    const range = computePaintRange({
      count: 30,
      scrollTop: 500,
      clientHeight: 200,
      followBottom: false,
      keyAt: keyAt(ids),
      heights,
    });
    // overscan ≥ 200; startPx ≈ 200 → row 1; endPx ≈ 1000 → inside 800px row 3
    expect(range.start).toBeGreaterThan(0);
    expect(range.start).toBeLessThanOrEqual(2);
    expect(range.end).toBeGreaterThan(3);
    expect(range.end).toBeLessThan(30);
  });

  test("followBottom walks from the tail using measured heights", () => {
    const ids = keys(20);
    const heights = new Map<string, number>(ids.map((id) => [id, 500]));
    const range = computePaintRange({
      count: 20,
      scrollTop: 9000,
      clientHeight: 400,
      followBottom: true,
      keyAt: keyAt(ids),
      heights,
    });
    expect(range.end).toBe(20);
    expect(range.start).toBeGreaterThan(0);
    expect(range.start).toBeLessThan(20);
    expect(range.end - range.start).toBeGreaterThanOrEqual(PAINT_MIN_ITEMS);
  });
});

describe("idle row-geometry warmup", () => {
  function fakeRow(key: string, height: number): HTMLElement {
    return {
      getAttribute: (name: string) => (name === "data-chat-virtual-key" ? key : null),
      offsetHeight: height,
    } as HTMLElement;
  }

  test("slice fills the cache from the bottom and stops when idle work is done", () => {
    const rows = [
      fakeRow("a", 120),
      fakeRow("b", 240),
      fakeRow("c", 360),
      fakeRow("d", 480),
    ];
    const cache = new Map<string, number>();
    expect(measureRowSlice(rows, cache, 2)).toBe(2);
    expect(cache.get("d")).toBe(480);
    expect(cache.get("c")).toBe(360);
    expect(cache.has("b")).toBe(false);
    expect(measureRowSlice(rows, cache, 2)).toBe(2);
    expect(cache.get("a")).toBe(120);
    expect(cache.get("b")).toBe(240);
    expect(measureRowSlice(rows, cache, 2)).toBe(0);
  });

  test("user abort stops further slices", () => {
    const rows = Array.from({ length: 20 }, (_, i) => fakeRow(`r${i}`, 220 + i));
    const cache = new Map<string, number>();
    const queued: Array<() => void> = [];
    const warmup = createRowGeometryWarmup({
      getRows: () => rows,
      cache,
      sliceSize: 4,
      schedule: (cb) => {
        queued.push(cb);
        return () => {
          const at = queued.indexOf(cb);
          if (at >= 0) queued.splice(at, 1);
        };
      },
    });
    warmup.start();
    expect(queued).toHaveLength(1);
    queued.shift()?.();
    expect(cache.size).toBe(4);
    expect(queued).toHaveLength(1);
    warmup.abort();
    expect(warmup.aborted()).toBe(true);
    expect(queued).toHaveLength(0);
    expect(cache.size).toBe(4);
  });

  test("unmeasured 0-height rows do not spin the idle loop", () => {
    const rows = [fakeRow("z", 0), fakeRow("y", 0)];
    const cache = new Map<string, number>();
    const queued: Array<() => void> = [];
    const warmup = createRowGeometryWarmup({
      getRows: () => rows,
      cache,
      sliceSize: 4,
      schedule: (cb) => {
        queued.push(cb);
        return () => undefined;
      },
    });
    warmup.start();
    queued.shift()?.();
    expect(cache.size).toBe(0);
    expect(queued).toHaveLength(0);
  });

  test("fallback estimate is the documented 200px", () => {
    expect(PAINT_ESTIMATE_PX).toBe(200);
  });
});
