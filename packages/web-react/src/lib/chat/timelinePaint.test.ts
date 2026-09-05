import { describe, expect, test } from "vitest";
import {
  PAINT_ESTIMATE_PX,
  PAINT_MIN_ITEMS,
  computePaintRange,
  createRowGeometryWarmup,
  indexAtOffsetPx,
  measureMountedRowHeight,
  measureRevealedSlice,
  measuredRangePx,
  medianPx,
  paintRangeCoversViewport,
  revealWarmupSlice,
  rowHeightEstimatePx,
  selectPaintRange,
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

  test("session median replaces the 200px estimate once enough rows are measured", () => {
    const few = new Map<string, number>([["a", 60], ["b", 64], ["c", 900]]);
    expect(rowHeightEstimatePx(few)).toBe(PAINT_ESTIMATE_PX);
    const enough = new Map<string, number>([["a", 60], ["b", 64], ["c", 900], ["d", 72]]);
    // 60,64,72,900 → median = (64+72)/2 = 68；单条 900px 代码块不能把估高拉走
    expect(rowHeightEstimatePx(enough)).toBe(68);
    expect(medianPx([])).toBeNull();
    expect(medianPx([5])).toBe(5);
    expect(medianPx([1, 3, 2])).toBe(2);
  });

  test("estimatePx drives unmeasured rows in prefix sums and spacers", () => {
    const ids = keys(20);
    const heights = new Map<string, number>([["row-0", 100]]);
    expect(indexAtOffsetPx(20, 100 + 59, keyAt(ids), heights, 60)).toBe(1);
    expect(indexAtOffsetPx(20, 100 + 60, keyAt(ids), heights, 60)).toBe(2);
    expect(measuredRangePx(0, 20, keyAt(ids), heights, 60)).toBe(100 + 19 * 60);
    // default remains 200px for callers that do not pass one
    expect(measuredRangePx(0, 20, keyAt(ids), heights)).toBe(100 + 19 * 200);
    const range = computePaintRange({
      count: 20,
      scrollTop: 0,
      clientHeight: 400,
      followBottom: false,
      keyAt: keyAt(ids),
      heights,
      estimatePx: 60,
    });
    // 400 + overscan 600 = 1000px → 100 + 15*60 = 1000 → end 索引 16，再 +1
    expect(range.start).toBe(0);
    expect(range.end).toBe(17);
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

  test("pinStart keeps the in-flight user row mounted when it is near the paint window", () => {
    const ids = keys(80);
    const heights = new Map<string, number>(ids.map((id) => [id, 200]));
    const range = computePaintRange({
      count: 80,
      scrollTop: 14_000,
      clientHeight: 600,
      followBottom: true,
      keyAt: keyAt(ids),
      heights,
      pinStart: 60,
    });
    expect(range.end).toBe(80);
    expect(range.start).toBeLessThanOrEqual(60);
    expect(range.start).toBe(60);
  });

  test("C: sending 但用户在顶部时，远处 pin 不把画窗 union 到 lastUser", () => {
    const ids = keys(300);
    const heights = new Map<string, number>();
    const base = computePaintRange({
      count: 300,
      scrollTop: 0,
      clientHeight: 600,
      followBottom: false,
      keyAt: keyAt(ids),
      heights,
    });
    const pinned = computePaintRange({
      count: 300,
      scrollTop: 0,
      clientHeight: 600,
      followBottom: false,
      keyAt: keyAt(ids),
      heights,
      pinStart: 280,
    });
    expect(pinned.start).toBe(base.start);
    expect(pinned.end).toBe(base.end);
    expect(pinned.end).toBeLessThanOrEqual(base.end + PAINT_MIN_ITEMS);
  });

  test("E: 不传 pinStart 时贴底画窗不钉上轮 user", () => {
    const ids = keys(80);
    const heights = new Map<string, number>(ids.map((id) => [id, 200]));
    const idle = computePaintRange({
      count: 80,
      scrollTop: 14_000,
      clientHeight: 600,
      followBottom: true,
      keyAt: keyAt(ids),
      heights,
    });
    const wouldPin = computePaintRange({
      count: 80,
      scrollTop: 14_000,
      clientHeight: 600,
      followBottom: true,
      keyAt: keyAt(ids),
      heights,
      pinStart: 20,
    });
    expect(idle.end).toBe(80);
    expect(idle.start).toBeGreaterThan(20);
    expect(wouldPin.start).toBe(idle.start);
    expect(wouldPin.end).toBe(idle.end);
  });

  test("viewport coverage is false when the painted span sits in a spacer below the view", () => {
    const ids = keys(81);
    const heights = new Map<string, number>();
    expect(paintRangeCoversViewport({
      start: 0,
      end: 80,
      count: 81,
      scrollTop: 15_600,
      clientHeight: 600,
      keyAt: keyAt(ids),
      heights,
    })).toBe(false);
    expect(paintRangeCoversViewport({
      start: 69,
      end: 81,
      count: 81,
      scrollTop: 15_600,
      clientHeight: 600,
      keyAt: keyAt(ids),
      heights,
    })).toBe(true);
  });

  test("selectPaintRange absorbs tail append instead of leaving the new row in the spacer", () => {
    const ids = keys(81);
    const heights = new Map<string, number>();
    const chosen = selectPaintRange({
      prev: { start: 55, end: 80 },
      next: { start: 56, end: 81 },
      followBottom: false,
      count: 81,
      scrollTop: 15_600,
      clientHeight: 600,
      keyAt: keyAt(ids),
      heights,
      pinStart: 80,
    });
    expect(chosen.end).toBe(81);
    expect(chosen.start).toBeLessThanOrEqual(80);
  });

  test("D: pin 不生效时近底 append 仍吸收 end，结果含新 user 下标 80", () => {
    const ids = keys(81);
    const heights = new Map<string, number>();
    const next = computePaintRange({
      count: 81,
      scrollTop: 15_600,
      clientHeight: 600,
      followBottom: false,
      keyAt: keyAt(ids),
      heights,
    });
    const chosen = selectPaintRange({
      prev: { start: 68, end: 80 },
      next,
      followBottom: false,
      count: 81,
      scrollTop: 15_600,
      clientHeight: 600,
      keyAt: keyAt(ids),
      heights,
    });
    expect(chosen.end).toBeGreaterThan(80);
    expect(chosen.start).toBeLessThanOrEqual(80);
  });

  test("hysteresis still holds when the previous window covers the viewport", () => {
    const ids = keys(80);
    const heights = new Map<string, number>();
    const chosen = selectPaintRange({
      prev: { start: 20, end: 50 },
      next: { start: 21, end: 51 },
      followBottom: false,
      count: 80,
      scrollTop: 6_000,
      clientHeight: 600,
      keyAt: keyAt(ids),
      heights,
    });
    expect(chosen).toEqual({ start: 20, end: 51 });
  });
});

describe("idle row-geometry warmup", () => {
  function fakeRow(key: string, realHeight: number): HTMLElement {
    const style = {
      contentVisibility: "",
      removeProperty(name: string) {
        if (name === "content-visibility") this.contentVisibility = "";
      },
    };
    return {
      getAttribute: (name: string) => (name === "data-chat-virtual-key" ? key : null),
      style,
      get offsetHeight() {
        return style.contentVisibility === "visible" ? realHeight : PAINT_ESTIMATE_PX;
      },
    } as unknown as HTMLElement;
  }

  test("片内行先被置 visible、隔帧测量、测完恢复 auto", () => {
    const rows = [
      fakeRow("a", 120),
      fakeRow("b", 240),
      fakeRow("c", 360),
      fakeRow("d", 480),
    ];
    const cache = new Map<string, number>();
    const queued: Array<() => void> = [];
    const warmup = createRowGeometryWarmup({
      getRows: () => rows,
      cache,
      sliceSize: 2,
      schedule: (cb) => {
        queued.push(cb);
        return () => {
          const at = queued.indexOf(cb);
          if (at >= 0) queued.splice(at, 1);
        };
      },
    });
    warmup.start();
    queued.shift()?.();
    expect(rows[3]!.style.contentVisibility).toBe("visible");
    expect(rows[2]!.style.contentVisibility).toBe("visible");
    expect(rows[1]!.style.contentVisibility).toBe("");
    expect(cache.size).toBe(0);

    queued.shift()?.();
    expect(cache.get("d")).toBe(480);
    expect(cache.get("c")).toBe(360);
    expect(rows.every((row) => row.style.contentVisibility === "")).toBe(true);

    queued.shift()?.();
    expect(rows[1]!.style.contentVisibility).toBe("visible");
    expect(rows[0]!.style.contentVisibility).toBe("visible");
    expect(cache.has("b")).toBe(false);

    queued.shift()?.();
    expect(cache.get("b")).toBe(240);
    expect(cache.get("a")).toBe(120);
    expect(rows.every((row) => row.style.contentVisibility === "")).toBe(true);
  });

  test("abort 时同步清掉强制 visible 的内联样式", () => {
    const rows = Array.from({ length: 8 }, (_, i) => fakeRow(`r${i}`, 220 + i));
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
    queued.shift()?.();
    expect(rows.filter((row) => row.style.contentVisibility === "visible")).toHaveLength(4);
    expect(cache.size).toBe(0);
    warmup.abort();
    expect(warmup.aborted()).toBe(true);
    expect(queued).toHaveLength(0);
    expect(rows.every((row) => row.style.contentVisibility === "")).toBe(true);
    expect(cache.size).toBe(0);
  });

  test("skipped 状态下的 200px 读数不会入 cache", () => {
    const rows = [fakeRow("z", 480), fakeRow("y", 360)];
    const cache = new Map<string, number>();
    expect(rows[0]!.offsetHeight).toBe(PAINT_ESTIMATE_PX);
    expect(measureRevealedSlice(rows, cache)).toBe(0);
    expect(cache.size).toBe(0);

    const pending: HTMLElement[] = [];
    expect(revealWarmupSlice(rows, cache, pending, 2)).toBe(2);
    expect(rows[0]!.style.contentVisibility).toBe("visible");
    expect(rows[0]!.offsetHeight).toBe(480);
    expect(measureRevealedSlice(pending, cache)).toBe(2);
    expect(cache.get("z")).toBe(480);
    expect(cache.get("y")).toBe(360);
    expect(rows.every((row) => row.style.contentVisibility === "")).toBe(true);
  });

  test("0 高行测完不再入队，避免 idle 空转", () => {
    const rows = [fakeRow("z", 0), fakeRow("y", 0)];
    const cache = new Map<string, number>();
    const queued: Array<() => void> = [];
    const warmup = createRowGeometryWarmup({
      getRows: () => rows,
      cache,
      sliceSize: 2,
      schedule: (cb) => {
        queued.push(cb);
        return () => {
          const at = queued.indexOf(cb);
          if (at >= 0) queued.splice(at, 1);
        };
      },
    });
    warmup.start();
    queued.shift()?.();
    expect(rows.every((row) => row.style.contentVisibility === "visible")).toBe(true);
    queued.shift()?.();
    expect(cache.size).toBe(0);
    expect(rows.every((row) => row.style.contentVisibility === "")).toBe(true);
    queued.shift()?.();
    expect(queued).toHaveLength(0);
    expect(cache.size).toBe(0);
  });

  test("fallback estimate is the documented 200px", () => {
    expect(PAINT_ESTIMATE_PX).toBe(200);
  });

  test("skipped content-visibility rows do not enter the height cache", () => {
    const skipped = {
      offsetHeight: PAINT_ESTIMATE_PX,
      checkVisibility: ({ contentVisibilityAuto }: { contentVisibilityAuto?: boolean }) => {
        expect(contentVisibilityAuto).toBe(true);
        return false;
      },
    } as unknown as HTMLElement;
    expect(measureMountedRowHeight(skipped)).toBeNull();

    const relevant = {
      offsetHeight: 480,
      checkVisibility: () => true,
    } as unknown as HTMLElement;
    expect(measureMountedRowHeight(relevant)).toBe(480);
  });
});
