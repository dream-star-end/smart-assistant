/**
 * Chat timeline paint-window geometry.
 *
 * Indexing uses measured row-height prefix sums. Unmeasured rows fall back to
 * an estimate: the caller passes the median of rows already measured in this
 * session (`rowHeightEstimatePx`), or 200px before anything is measured. Idle
 * warmup force-visibles already-mounted rows for one frame so
 * `content-visibility: auto` records last remembered size, then measures.
 */

export const PAINT_ESTIMATE_PX = 200;
/** Fewer measured rows than this and the median is too noisy to beat 200px. */
export const ESTIMATE_MIN_SAMPLES = 4;
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

export function itemHeightPx(
  key: string,
  heights: Map<string, number>,
  estimatePx: number = PAINT_ESTIMATE_PX,
): number {
  return heights.get(key) ?? estimatePx;
}

export function medianPx(values: readonly number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v) && v > 0);
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Estimate for rows the cache has not measured yet. A row that mounts with the
 * wrong `contain-intrinsic-size` lays out at that size while skipped and grows
 * to its real height when it becomes relevant; above the viewport that growth
 * is a visible jump on every row scrolled past. The median of rows already
 * measured in this session tracks the real distribution (message rows are
 * rarely 200px) far better than the CSS constant.
 */
export function rowHeightEstimatePx(
  heights: Map<string, number>,
  fallback: number = PAINT_ESTIMATE_PX,
  minSamples: number = ESTIMATE_MIN_SAMPLES,
): number {
  if (heights.size < minSamples) return fallback;
  return medianPx(Array.from(heights.values())) ?? fallback;
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
  estimatePx: number = PAINT_ESTIMATE_PX,
): number {
  if (count <= 0 || offsetPx <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < count; i += 1) {
    const height = itemHeightPx(keyAt(i), heights, estimatePx);
    if (acc + height > offsetPx) return i;
    acc += height;
  }
  return count;
}

export function overscanPx(clientHeight: number): number {
  const height = Math.max(0, clientHeight);
  return Math.max(height, Math.round(PAINT_OVERSCAN_VIEWPORTS * height));
}

/** Pin is in the painted span or within PAINT_MIN_ITEMS of either edge. */
export function pinNearPaintRange(
  pin: number,
  start: number,
  end: number,
  slack: number = PAINT_MIN_ITEMS,
): boolean {
  if (pin < start) return start - pin <= slack;
  if (pin >= end) return pin - end <= slack;
  return true;
}

export function computePaintRange(args: {
  count: number;
  scrollTop: number;
  clientHeight: number;
  followBottom: boolean;
  keyAt: (index: number) => string;
  heights: Map<string, number>;
  /** Inclusive index that must stay mounted (e.g. the in-flight user bubble). */
  pinStart?: number;
  /** Height assumed for unmeasured rows; see rowHeightEstimatePx. */
  estimatePx?: number;
}): { start: number; end: number } {
  const { count, scrollTop, clientHeight, followBottom, keyAt, heights, pinStart } = args;
  const estimatePx = args.estimatePx ?? PAINT_ESTIMATE_PX;
  if (count <= 0) return { start: 0, end: 0 };
  const extra = overscanPx(clientHeight);

  let start: number;
  let end: number;
  if (followBottom) {
    let acc = 0;
    start = count;
    const target = clientHeight + extra;
    while (start > 0 && acc < target) {
      start -= 1;
      acc += itemHeightPx(keyAt(start), heights, estimatePx);
    }
    start = Math.min(start, Math.max(0, count - PAINT_MIN_ITEMS));
    end = count;
  } else {
    start = indexAtOffsetPx(count, Math.max(0, scrollTop - extra), keyAt, heights, estimatePx);
    end = indexAtOffsetPx(
      count,
      Math.max(0, scrollTop) + clientHeight + extra,
      keyAt,
      heights,
      estimatePx,
    );
    if (end < count) end += 1;
    end = Math.min(count, Math.max(end, start + PAINT_MIN_ITEMS));
    start = Math.min(start, Math.max(0, count - PAINT_MIN_ITEMS));
  }
  if (typeof pinStart === "number" && Number.isFinite(pinStart)) {
    const pin = Math.max(0, Math.min(Math.floor(pinStart), count - 1));
    if (pinNearPaintRange(pin, start, end)) {
      start = Math.min(start, pin);
      end = Math.max(end, pin + 1);
    }
  }
  return { start, end };
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
  estimatePx: number = PAINT_ESTIMATE_PX,
): number {
  let height = 0;
  for (let i = from; i < to; i += 1) {
    height += itemHeightPx(keyAt(i), heights, estimatePx);
  }
  return height;
}

/** True when [start, end) still covers the viewport. Slack is 1px for subpixel clamp. */
export function paintRangeCoversViewport(args: {
  start: number;
  end: number;
  count: number;
  scrollTop: number;
  clientHeight: number;
  keyAt: (index: number) => string;
  heights: Map<string, number>;
  estimatePx?: number;
}): boolean {
  const { start, end, count, scrollTop, clientHeight, keyAt, heights } = args;
  const estimatePx = args.estimatePx ?? PAINT_ESTIMATE_PX;
  if (count <= 0 || end <= start) return false;
  const top = measuredRangePx(0, start, keyAt, heights, estimatePx);
  const painted = measuredRangePx(start, end, keyAt, heights, estimatePx);
  const total = top + painted + measuredRangePx(end, count, keyAt, heights, estimatePx);
  const viewEnd = Math.min(scrollTop + Math.max(0, clientHeight), total);
  return top <= scrollTop + 1 && top + painted >= viewEnd - 1;
}

/**
 * Keep hysteresis only when the previous window still covers the viewport
 * (and any pinned row). Always absorb a tail `end` growth so a newly appended
 * optimistic user row cannot sit in the bottom spacer until the next scroll.
 */
export function selectPaintRange(args: {
  prev: { start: number; end: number };
  next: { start: number; end: number };
  followBottom: boolean;
  count: number;
  scrollTop: number;
  clientHeight: number;
  keyAt: (index: number) => string;
  heights: Map<string, number>;
  pinStart?: number;
  estimatePx?: number;
}): { start: number; end: number } {
  const { prev, next, followBottom, pinStart } = args;
  if (followBottom) return next;
  const pinOk =
    typeof pinStart !== "number" ||
    !pinNearPaintRange(pinStart, prev.start, prev.end) ||
    (pinStart >= prev.start && pinStart < prev.end);
  if (
    pinOk &&
    paintRangeCoversViewport({ ...args, start: prev.start, end: prev.end }) &&
    paintRangeSettled(prev, next)
  ) {
    return { start: prev.start, end: Math.max(prev.end, next.end) };
  }
  return next;
}

/**
 * Cache only relevant row heights. `content-visibility: auto` skipped rows
 * report contain-intrinsic-size (200px); writing that back poisons spacers.
 */
export function measureMountedRowHeight(el: HTMLElement): number | null {
  if (typeof el.checkVisibility === "function") {
    try {
      if (!el.checkVisibility({ contentVisibilityAuto: true })) return null;
    } catch {
      /* jsdom / engines without the contentVisibilityAuto flag */
    }
  }
  const height = el.offsetHeight;
  return height > 0 ? height : null;
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
