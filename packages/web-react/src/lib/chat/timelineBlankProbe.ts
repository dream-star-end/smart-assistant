/**
 * Timeline blank-viewport probe (INC-20260905-TIMELINE-BLANK, not yet reproducible).
 *
 * Symptom: in a long session with many delegated sub-tasks, while a turn is in
 * flight the scroll viewport shows a large empty area above the composer. Every
 * lab reproduction so far rendered correctly, so this module observes the live
 * DOM in production and, when the viewport contains no painted timeline row for
 * a sustained period, captures a compact geometry snapshot:
 *
 *   1. kept in memory + localStorage (`oc.timelineBlank.last`) for manual pull
 *      via `window.__ocTimelineDump()`;
 *   2. reported as a bounded product-friction signal (surface=webchat,
 *      stage=timeline_paint, code=TIMELINE_BLANK_VIEWPORT) — counts only, no
 *      conversation content ever leaves the browser.
 *
 * The probe is passive: it never writes scrollTop, never changes layout, and is
 * throttled to one sample per SAMPLE_INTERVAL_MS via the scroll/RO/interval
 * hooks owned by MessageList.
 */

export const BLANK_SAMPLE_INTERVAL_MS = 1000;
/** Consecutive blank samples before we call it a real blank (filters one-frame paint gaps). */
export const BLANK_CONFIRM_SAMPLES = 3;
/** At most one report per session per this window; the snapshot still updates locally. */
export const BLANK_REPORT_COOLDOWN_MS = 5 * 60_000;
export const BLANK_STORAGE_KEY = "oc.timelineBlank.last";

export type RowGeometry = {
  key: string;
  /** Offset of the row's top edge relative to the scroller viewport top. */
  top: number;
  height: number;
  /** content-visibility skipped (`checkVisibility({contentVisibilityAuto:true}) === false`). */
  skipped: boolean;
  live: boolean;
  /** Height of the first child (the actual card); 0 means the card rendered nothing. */
  innerHeight: number;
  kind: string;
};

export type BlankProbeInput = {
  scroller: { scrollTop: number; scrollHeight: number; clientHeight: number };
  rows: RowGeometry[];
  spacerTop: { cssHeight: number; top: number } | null;
  spacerBottom: { cssHeight: number; top: number } | null;
  /** Footer (turn-activity) box relative to scroller top; null when absent. */
  footer: { top: number; height: number } | null;
  windowCount: number;
  paintCount: number;
  paintStart: number;
  paintEnd: number;
  sending: boolean;
  followBottom: boolean | null;
  messagesLength: number;
};

export type BlankClassification =
  | "ok"
  | "no_rows_mounted"
  | "rows_skipped_in_viewport"
  | "rows_zero_height_in_viewport"
  | "viewport_in_top_spacer"
  | "viewport_in_bottom_spacer"
  | "viewport_past_content"
  | "viewport_gap_unknown";

export type BlankSnapshot = {
  at: number;
  classification: BlankClassification;
  scroller: BlankProbeInput["scroller"];
  distBottom: number;
  windowCount: number;
  paintCount: number;
  paintStart: number;
  paintEnd: number;
  sending: boolean;
  followBottom: boolean | null;
  messagesLength: number;
  spacerTop: BlankProbeInput["spacerTop"];
  spacerBottom: BlankProbeInput["spacerBottom"];
  footer: BlankProbeInput["footer"];
  rowsMounted: number;
  rowsInViewport: number;
  rowsPaintedInViewport: number;
  rowsSkippedInViewport: number;
  rowsZeroHeightInViewport: number;
  /** Painted content covered px inside viewport. */
  paintedPxInViewport: number;
  /** Rows touching the viewport plus 2 neighbours on each side; keys are hashed ids, no text. */
  nearbyRows: RowGeometry[];
  /** Sum of row heights vs. root height: a mismatch means a spacer/height cache lies. */
  rowsHeightSum: number;
  tailRows: RowGeometry[];
};

function intersects(row: RowGeometry, clientHeight: number): boolean {
  return row.top < clientHeight && row.top + row.height > 0;
}

/** Pixels of `row` that fall inside [0, clientHeight). */
function coveredPx(row: RowGeometry, clientHeight: number): number {
  const top = Math.max(0, row.top);
  const bottom = Math.min(clientHeight, row.top + row.height);
  return Math.max(0, bottom - top);
}

export function classifyBlank(input: BlankProbeInput): BlankClassification {
  const { scroller, rows, spacerTop, spacerBottom, footer } = input;
  const vh = scroller.clientHeight;
  if (vh <= 0) return "ok";
  const inView = rows.filter((row) => intersects(row, vh));
  const painted = inView.filter((row) => !row.skipped && row.innerHeight > 0);
  const paintedPx = painted.reduce((acc, row) => acc + coveredPx(row, vh), 0);
  const footerPx = footer && footer.height > 0
    ? coveredPx({ key: "", top: footer.top, height: footer.height, skipped: false, live: false, innerHeight: footer.height, kind: "footer" }, vh)
    : 0;
  // Blank = less than a quarter of the viewport has any painted timeline pixels
  // while there is content that should be there (rows are mounted or spacers exist).
  if (paintedPx + footerPx >= vh * 0.25) return "ok";
  if (rows.length === 0) return input.windowCount > 0 ? "no_rows_mounted" : "ok";
  if (inView.length > 0) {
    if (inView.some((row) => row.skipped)) return "rows_skipped_in_viewport";
    if (inView.some((row) => row.innerHeight <= 0 || row.height <= 0)) return "rows_zero_height_in_viewport";
  }
  const spacerCovers = (spacer: BlankProbeInput["spacerTop"]) =>
    !!spacer && spacer.cssHeight > 0 && spacer.top < vh && spacer.top + spacer.cssHeight > 0;
  if (spacerCovers(spacerTop)) return "viewport_in_top_spacer";
  if (spacerCovers(spacerBottom)) return "viewport_in_bottom_spacer";
  const lastRow = rows[rows.length - 1];
  if (lastRow && lastRow.top + lastRow.height <= 0) return "viewport_past_content";
  return "viewport_gap_unknown";
}

export function buildSnapshot(input: BlankProbeInput, classification: BlankClassification, at: number): BlankSnapshot {
  const vh = input.scroller.clientHeight;
  const inViewIdx: number[] = [];
  input.rows.forEach((row, index) => { if (intersects(row, vh)) inViewIdx.push(index); });
  const inView = inViewIdx.map((index) => input.rows[index]!);
  const painted = inView.filter((row) => !row.skipped && row.innerHeight > 0);
  const lo = inViewIdx.length > 0 ? Math.max(0, inViewIdx[0]! - 2) : Math.max(0, input.rows.length - 4);
  const hi = inViewIdx.length > 0 ? Math.min(input.rows.length, inViewIdx[inViewIdx.length - 1]! + 3) : input.rows.length;
  return {
    at,
    classification,
    scroller: input.scroller,
    distBottom: input.scroller.scrollHeight - input.scroller.clientHeight - input.scroller.scrollTop,
    windowCount: input.windowCount,
    paintCount: input.paintCount,
    paintStart: input.paintStart,
    paintEnd: input.paintEnd,
    sending: input.sending,
    followBottom: input.followBottom,
    messagesLength: input.messagesLength,
    spacerTop: input.spacerTop,
    spacerBottom: input.spacerBottom,
    footer: input.footer,
    rowsMounted: input.rows.length,
    rowsInViewport: inView.length,
    rowsPaintedInViewport: painted.length,
    rowsSkippedInViewport: inView.filter((row) => row.skipped).length,
    rowsZeroHeightInViewport: inView.filter((row) => row.innerHeight <= 0 || row.height <= 0).length,
    paintedPxInViewport: painted.reduce((acc, row) => acc + coveredPx(row, vh), 0),
    nearbyRows: input.rows.slice(lo, hi),
    rowsHeightSum: input.rows.reduce((acc, row) => acc + row.height, 0),
    tailRows: input.rows.slice(-3),
  };
}

export type BlankProbeReport = {
  code: "TIMELINE_BLANK_VIEWPORT";
  classification: BlankClassification;
  snapshot: BlankSnapshot;
};

/**
 * Debounce blank samples into confirmed incidents. Pure state machine; the
 * caller feeds one classification per sample and receives a report only on the
 * transition into a confirmed blank (and again after cooldown if still blank).
 */
export function createBlankDetector(opts: {
  confirmSamples?: number;
  reportCooldownMs?: number;
} = {}) {
  const confirmSamples = opts.confirmSamples ?? BLANK_CONFIRM_SAMPLES;
  const cooldown = opts.reportCooldownMs ?? BLANK_REPORT_COOLDOWN_MS;
  let streak = 0;
  let lastReportAt = -Infinity;
  let confirmed = false;
  let lastSnapshot: BlankSnapshot | null = null;
  return {
    sample(input: BlankProbeInput, now: number): BlankProbeReport | null {
      const classification = classifyBlank(input);
      if (classification === "ok") {
        streak = 0;
        confirmed = false;
        return null;
      }
      streak += 1;
      const snapshot = buildSnapshot(input, classification, now);
      lastSnapshot = snapshot;
      if (streak < confirmSamples) return null;
      const dueToReport = !confirmed || now - lastReportAt >= cooldown;
      confirmed = true;
      if (!dueToReport || now - lastReportAt < cooldown) return null;
      lastReportAt = now;
      return { code: "TIMELINE_BLANK_VIEWPORT", classification, snapshot };
    },
    lastSnapshot: () => lastSnapshot,
    isConfirmed: () => confirmed,
  };
}

/** Collect geometry from the live DOM. Keys are truncated; no innerText is read. */
export function collectProbeInput(args: {
  scroller: HTMLElement;
  root: HTMLElement | null;
  paintStart: number;
  paintEnd: number;
  sending: boolean;
  followBottom: boolean | null;
  messagesLength: number;
}): BlankProbeInput {
  const { scroller, root } = args;
  const sr = scroller.getBoundingClientRect();
  const rows: RowGeometry[] = [];
  if (root) {
    for (const el of root.querySelectorAll<HTMLElement>("[data-chat-virtual-key]")) {
      const r = el.getBoundingClientRect();
      let skipped = false;
      if (typeof el.checkVisibility === "function") {
        try { skipped = !el.checkVisibility({ contentVisibilityAuto: true }); } catch { /* engines without the flag */ }
      }
      const inner = el.firstElementChild as HTMLElement | null;
      const key = el.getAttribute("data-chat-virtual-key") ?? "";
      rows.push({
        key: key.length > 48 ? `${key.slice(0, 20)}…${key.slice(-12)}` : key,
        top: Math.round(r.top - sr.top),
        height: Math.round(r.height),
        skipped,
        live: el.classList.contains("chat-timeline-row-live"),
        innerHeight: inner ? Math.round(inner.getBoundingClientRect().height) : 0,
        kind: key.split(":", 1)[0] ?? "",
      });
    }
  }
  const spacer = (id: string) => {
    const el = root?.querySelector<HTMLElement>(`[data-testid='${id}']`);
    if (!el) return null;
    return { cssHeight: Math.round(parseFloat(el.style.height) || 0), top: Math.round(el.getBoundingClientRect().top - sr.top) };
  };
  const footerEl = root?.querySelector<HTMLElement>("[data-testid='turn-activity-footer']");
  const fr = footerEl?.getBoundingClientRect();
  return {
    scroller: { scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
    rows,
    spacerTop: spacer("timeline-paint-spacer-top"),
    spacerBottom: spacer("timeline-paint-spacer-bottom"),
    footer: fr ? { top: Math.round(fr.top - sr.top), height: Math.round(fr.height) } : null,
    windowCount: Number(root?.getAttribute("data-timeline-window-count") ?? 0),
    paintCount: Number(root?.getAttribute("data-timeline-paint-count") ?? 0),
    paintStart: args.paintStart,
    paintEnd: args.paintEnd,
    sending: args.sending,
    followBottom: args.followBottom,
    messagesLength: args.messagesLength,
  };
}

export function persistSnapshot(sessionId: string | undefined, report: BlankProbeReport): void {
  try {
    const payload = { sessionId: sessionId ?? null, ...report, userAgent: navigator.userAgent.slice(0, 120) };
    localStorage.setItem(BLANK_STORAGE_KEY, JSON.stringify(payload));
  } catch { /* quota / privacy mode */ }
}

export function readPersistedSnapshot(): unknown {
  try {
    const raw = localStorage.getItem(BLANK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
