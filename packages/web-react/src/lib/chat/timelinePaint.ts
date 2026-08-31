/**
 * Chat timeline paint-window geometry.
 *
 * Indexing uses measured row-height prefix sums (unmeasured rows fall back to
 * 200px). Idle warmup force-visibles already-mounted rows for one frame so
 * `content-visibility: auto` records last remembered size, then measures.
 */

export const PAINT_ESTIMATE_PX = 200;
/** Floor so a tiny viewport still mounts a usable neighborhood. */
export const PAINT_MIN_ITEMS = 12;
/** Paint window turns on at the first-screen tail, not after a second +80 expand. */
export const PAINT_ENABLE_ITEMS = 80;
export const PAINT_ENABLE_VIEWPORT_PX = 360;
/** Overscan on each side, in viewports (≈1–2×). */
export const PAINT_OVERSCAN_VIEWPORTS = 1.5;
/** Skip setState when the window crawled by fewer than this many rows. */
export const PAINT_HYSTERESIS_ITEMS = 3;
export const ROW_WARMUP_SLICE = 6;
/** Initial tail locators to hydrate without waiting for the 600px IO. */
export const EAGER_PAYLOAD_TAIL_ITEMS = 8;
/** Nearby signed images to activate; keep tiny so we do not fill the 6-fetch gate. */
export const EAGER_MEDIA_TAIL_ITEMS = 2;

export function paintWindowEnabled(
  scroller: { clientHeight: number } | null | undefined,
  count: number,
): boolean {
  return Boolean(
    scroller &&
    scroller.clientHeight >= PAINT_ENABLE_VIEWPORT_PX &&
    count >= PAINT_ENABLE_ITEMS,
  );
}

export function itemHeightPx(key: string, heights: Map<string, number>): number {
  return heights.get(key) ?? PAINT_ESTIMATE_PX;
}

/**
 * First index whose block contains `offsetPx`, or `count` when the offset is
 * at/past the total height. Unmeasured rows contribute 200px.
 */
export function indexAtOffsetPx(
  count: number,
  offsetPx: number,
  keyAt: (index: number) => string,
  heights: Map<string, number>,
): number {
  if (count <= 0 || offsetPx <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < count; i += 1) {
    const height = itemHeightPx(keyAt(i), heights);
    if (acc + height > offsetPx) return i;
    acc += height;
  }
  return count;
}

export function overscanPx(clientHeight: number): number {
  const height = Math.max(0, clientHeight);
  return Math.max(height, Math.round(PAINT_OVERSCAN_VIEWPORTS * height));
}

export function computePaintRange(args: {
  count: number;
  scrollTop: number;
  clientHeight: number;
  followBottom: boolean;
  keyAt: (index: number) => string;
  heights: Map<string, number>;
}): { start: number; end: number } {
  const { count, scrollTop, clientHeight, followBottom, keyAt, heights } = args;
  if (count <= 0) return { start: 0, end: 0 };
  const extra = overscanPx(clientHeight);

  if (followBottom) {
    let acc = 0;
    let start = count;
    const target = clientHeight + extra;
    while (start > 0 && acc < target) {
      start -= 1;
      acc += itemHeightPx(keyAt(start), heights);
    }
    start = Math.min(start, Math.max(0, count - PAINT_MIN_ITEMS));
    return { start, end: count };
  }

  const start = indexAtOffsetPx(count, Math.max(0, scrollTop - extra), keyAt, heights);
  let end = indexAtOffsetPx(count, Math.max(0, scrollTop) + clientHeight + extra, keyAt, heights);
  if (end < count) end += 1;
  end = Math.min(count, Math.max(end, start + PAINT_MIN_ITEMS));
  const clampedStart = Math.min(start, Math.max(0, count - PAINT_MIN_ITEMS));
  return { start: clampedStart, end };
}

export function paintRangeSettled(
  prev: { start: number; end: number },
  next: { start: number; end: number },
  hysteresis: number = PAINT_HYSTERESIS_ITEMS,
): boolean {
  if (prev.start === next.start && prev.end === next.end) return true;
  return (
    Math.abs(prev.start - next.start) < hysteresis &&
    Math.abs(prev.end - next.end) < hysteresis
  );
}

export function measuredRangePx(
  from: number,
  to: number,
  keyAt: (index: number) => string,
  heights: Map<string, number>,
): number {
  let height = 0;
  for (let i = from; i < to; i += 1) {
    height += itemHeightPx(keyAt(i), heights);
  }
  return height;
}

/**
 * `content-visibility: auto` skips off-screen layout. Reading offsetHeight on a
 * skipped row returns the 200px intrinsic estimate and does not record last
 * remembered size. Warmup must force `visible`, wait a frame, then measure.
 */
export function restoreWarmupReveal(el: HTMLElement): void {
  if (el.style.contentVisibility === "visible") {
    el.style.removeProperty("content-visibility");
  }
}

export function isRevealedForMeasure(el: HTMLElement): boolean {
  if (el.style.contentVisibility !== "visible") return false;
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ contentVisibilityAuto: true });
  }
  return true;
}

/** Force-visible the next uncached slice (bottom-first). Caller waits a frame. */
export function revealWarmupSlice(
  rows: ArrayLike<HTMLElement>,
  cache: Map<string, number>,
  pending: HTMLElement[],
  sliceSize: number = ROW_WARMUP_SLICE,
  attempted?: Set<string>,
): number {
  const limit = Math.max(1, sliceSize);
  let revealed = 0;
  for (let i = rows.length - 1; i >= 0 && revealed < limit; i -= 1) {
    const row = rows[i];
    const key = row.getAttribute("data-chat-virtual-key");
    if (!key || cache.has(key) || attempted?.has(key)) continue;
    row.style.contentVisibility = "visible";
    pending.push(row);
    attempted?.add(key);
    revealed += 1;
  }
  return revealed;
}

/** Measure rows already forced visible. Skipped reads never enter the cache. */
export function measureRevealedSlice(
  slice: HTMLElement[],
  cache: Map<string, number>,
): number {
  let cached = 0;
  for (const row of slice) {
    try {
      const key = row.getAttribute("data-chat-virtual-key");
      if (!key || cache.has(key)) continue;
      if (!isRevealedForMeasure(row)) continue;
      const height = row.offsetHeight;
      if (height <= 0) continue;
      cache.set(key, height);
      cached += 1;
    } finally {
      restoreWarmupReveal(row);
    }
  }
  return cached;
}

export type IdleCancel = () => void;

export function scheduleIdle(cb: () => void): IdleCancel {
  const ric = globalThis.requestIdleCallback;
  if (typeof ric === "function") {
    const id = ric(() => cb(), { timeout: 1200 });
    return () => globalThis.cancelIdleCallback?.(id);
  }
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(() => cb());
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 0);
  return () => clearTimeout(id);
}

export function createRowGeometryWarmup(opts: {
  getRows: () => ArrayLike<HTMLElement>;
  cache: Map<string, number>;
  sliceSize?: number;
  schedule?: (cb: () => void) => IdleCancel;
}): { start: () => void; abort: () => void; aborted: () => boolean } {
  const sliceSize = opts.sliceSize ?? ROW_WARMUP_SLICE;
  const schedule = opts.schedule ?? scheduleIdle;
  let aborted = false;
  let cancel: IdleCancel | null = null;
  let pending: HTMLElement[] = [];
  const attempted = new Set<string>();

  const clearPending = () => {
    for (const row of pending) restoreWarmupReveal(row);
    pending = [];
  };

  const tick = () => {
    cancel = null;
    if (aborted) return;

    if (pending.length > 0) {
      const revealed = pending;
      pending = [];
      measureRevealedSlice(revealed, opts.cache);
      if (aborted) return;
      cancel = schedule(tick);
      return;
    }

    const revealed = revealWarmupSlice(
      opts.getRows(),
      opts.cache,
      pending,
      sliceSize,
      attempted,
    );
    if (aborted) {
      clearPending();
      return;
    }
    if (revealed <= 0) return;
    cancel = schedule(tick);
  };

  return {
    start() {
      if (aborted) return;
      cancel ??= schedule(tick);
    },
    abort() {
      aborted = true;
      cancel?.();
      cancel = null;
      clearPending();
    },
    aborted: () => aborted,
  };
}
