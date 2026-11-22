/**
 * Visibility context tracker for FIRST_TEXT_PAINT telemetry (OCV5-40).
 *
 * Tracks document visibility transitions across the entire turn window
 * (user submit -> first text WS frame -> second rAF commit paint) so that:
 *   1. Nocturnal/backgrounded mobile or hidden desktop tabs never pollute
 *      foreground `FIRST_TEXT_PAINT` latency percentiles.
 *   2. Every `FIRST_TEXT_PAINT` / `FIRST_TEXT_PAINT_AFTER_BACKGROUND` report
 *      carries bounded visibility lifecycle (`path`) and hidden-duration/share
 *      context (`reason`) within the existing `/api/client-errors` schema.
 */

export type FirstTextPaintVisibilityPath =
  | "visible"
  | "hidden_during_wait"
  | "hidden_at_frame"
  | "hidden_during_paint"
  | "hidden_at_paint";

export type FirstTextPaintVisibilitySummary = {
  visibilityState: DocumentVisibilityState;
  wasHidden: boolean;
  hiddenBeforeFrame: boolean;
  hiddenDuringPaint: boolean;
  hiddenDurationMs: number;
  visibleLatencyMs: number;
  visibilityPath: FirstTextPaintVisibilityPath;
  visibilityReason: string;
};

type VisibilitySample = {
  at: number;
  hidden: boolean;
  isChange: boolean;
};

const MAX_VISIBILITY_SAMPLES = 128;

let listenerInstalled = false;
let boundVisibilityHandler: (() => void) | null = null;
const samples: VisibilitySample[] = [];

export function currentDocumentVisibilityState(): DocumentVisibilityState {
  if (typeof document === "undefined") return "visible";
  return document.visibilityState === "hidden" ? "hidden" : "visible";
}

function isDocumentHidden(): boolean {
  return currentDocumentVisibilityState() !== "visible";
}

function appendSample(at: number, hidden: boolean, isChange: boolean): void {
  const safeAt = Number.isFinite(at) ? at : Date.now();
  const last = samples[samples.length - 1];
  if (last && last.at === safeAt && last.hidden === hidden && !isChange) return;
  if (last && safeAt < last.at) {
    // Keep samples monotonically ordered when tests manipulate Date.now().
    const idx = samples.findIndex((item) => item.at > safeAt);
    if (idx >= 0) {
      samples.splice(idx, 0, { at: safeAt, hidden, isChange });
    } else {
      samples.push({ at: safeAt, hidden, isChange });
    }
  } else {
    samples.push({ at: safeAt, hidden, isChange });
  }
  if (samples.length > MAX_VISIBILITY_SAMPLES) {
    samples.splice(0, samples.length - MAX_VISIBILITY_SAMPLES);
  }
}

export function ensureFirstTextPaintVisibilityTracking(anchorAt?: number): void {
  if (typeof document === "undefined") return;
  if (!listenerInstalled) {
    listenerInstalled = true;
    boundVisibilityHandler = () => {
      appendSample(Date.now(), isDocumentHidden(), true);
    };
    document.addEventListener("visibilitychange", boundVisibilityHandler);
  }
  if (anchorAt !== undefined) {
    appendSample(anchorAt, isDocumentHidden(), false);
  } else if (samples.length === 0) {
    appendSample(Date.now(), isDocumentHidden(), false);
  }
}

export function resetFirstTextPaintVisibilityForTests(): void {
  if (listenerInstalled && boundVisibilityHandler && typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", boundVisibilityHandler);
  }
  listenerInstalled = false;
  boundVisibilityHandler = null;
  samples.length = 0;
}

export function measureHiddenWindow(
  startMs: number,
  endMs: number,
  sampleLog: ReadonlyArray<VisibilitySample> = samples,
  currentHidden: boolean = isDocumentHidden(),
): { wasHidden: boolean; hiddenDurationMs: number } {
  const safeEnd = Math.max(startMs, endMs);
  if (safeEnd === startMs) {
    return { wasHidden: currentHidden, hiddenDurationMs: 0 };
  }

  let initialHidden: boolean | undefined;
  for (let i = sampleLog.length - 1; i >= 0; i--) {
    const sample = sampleLog[i]!;
    if (sample.at <= startMs) {
      initialHidden = sample.hidden;
      break;
    }
  }
  if (initialHidden === undefined) {
    const firstChangeInWindow = sampleLog.find(
      (sample) => sample.isChange && sample.at > startMs && sample.at <= safeEnd,
    );
    initialHidden = firstChangeInWindow ? !firstChangeInWindow.hidden : currentHidden;
  }

  let hidden = initialHidden;
  let cursor = startMs;
  let hiddenDurationMs = 0;
  let wasHidden = hidden;

  for (const sample of sampleLog) {
    if (sample.at <= startMs) continue;
    if (sample.at > safeEnd) break;
    if (hidden) {
      hiddenDurationMs += Math.max(0, sample.at - cursor);
      wasHidden = true;
    }
    cursor = sample.at;
    hidden = sample.hidden;
    if (hidden) wasHidden = true;
  }

  if (hidden) {
    hiddenDurationMs += Math.max(0, safeEnd - cursor);
    wasHidden = true;
  }
  if (currentHidden) wasHidden = true;

  const total = safeEnd - startMs;
  return {
    wasHidden,
    hiddenDurationMs: Math.min(total, Math.max(0, Math.round(hiddenDurationMs))),
  };
}

function hiddenDurationBucket(hiddenDurationMs: number): string {
  if (hiddenDurationMs < 5_000) return "lt5s";
  if (hiddenDurationMs < 30_000) return "5s_30s";
  if (hiddenDurationMs < 120_000) return "30s_2m";
  if (hiddenDurationMs < 900_000) return "2m_15m";
  if (hiddenDurationMs < 3_600_000) return "15m_60m";
  return "gt60m";
}

export function classifyFirstTextPaintVisibility(input: {
  latencyMs: number;
  backgroundAtFrame: boolean;
  hiddenBeforeFrame?: boolean;
  hiddenDuringPaint?: boolean;
  visibilityState: DocumentVisibilityState;
  hiddenDurationMs: number;
}): {
  wasHidden: boolean;
  visibilityPath: FirstTextPaintVisibilityPath;
  visibilityReason: string;
} {
  const hiddenMs = Math.max(0, Math.min(input.latencyMs, Math.round(input.hiddenDurationMs)));
  const wasHidden = Boolean(
    input.backgroundAtFrame ||
      input.hiddenBeforeFrame ||
      input.hiddenDuringPaint ||
      input.visibilityState !== "visible" ||
      hiddenMs > 0,
  );
  let visibilityPath: FirstTextPaintVisibilityPath = "visible";
  if (wasHidden) {
    if (input.visibilityState !== "visible") {
      visibilityPath = "hidden_at_paint";
    } else if (input.backgroundAtFrame) {
      visibilityPath = "hidden_at_frame";
    } else if (input.hiddenDuringPaint) {
      visibilityPath = "hidden_during_paint";
    } else {
      visibilityPath = "hidden_during_wait";
    }
  }
  let visibilityReason = "hidden_0s";
  if (wasHidden) {
    if (hiddenMs <= 0) {
      visibilityReason = "hidden_brief";
    } else {
      const share = hiddenMs * 2 >= input.latencyMs ? "mostly_hidden" : "mostly_visible";
      visibilityReason = `hidden_${hiddenDurationBucket(hiddenMs)}_${share}`;
    }
  }
  return { wasHidden, visibilityPath, visibilityReason };
}

export function summarizeFirstTextPaintVisibility(input: {
  startedAt: number;
  frameAt?: number;
  paintedAt: number;
  backgroundAtFrame: boolean;
  hiddenBeforeFrame?: boolean;
  hiddenDuringPaintObserved?: boolean;
}): FirstTextPaintVisibilitySummary {
  const latencyMs = Math.max(0, Math.round(input.paintedAt - input.startedAt));
  const visibilityState = currentDocumentVisibilityState();
  const currentHidden = visibilityState !== "visible";
  const frameAt =
    typeof input.frameAt === "number" && Number.isFinite(input.frameAt)
      ? Math.max(input.startedAt, Math.min(input.paintedAt, input.frameAt))
      : undefined;

  const fullWindow = measureHiddenWindow(input.startedAt, input.paintedAt, samples, currentHidden);
  const preFrameWindow =
    frameAt !== undefined
      ? measureHiddenWindow(input.startedAt, frameAt, samples, input.backgroundAtFrame)
      : undefined;
  const paintWindow =
    frameAt !== undefined
      ? measureHiddenWindow(frameAt, input.paintedAt, samples, currentHidden)
      : undefined;

  const hiddenBeforeFrame = Boolean(input.hiddenBeforeFrame || preFrameWindow?.wasHidden);
  const hiddenDuringPaint = Boolean(input.hiddenDuringPaintObserved || paintWindow?.wasHidden);
  const hiddenDurationMs = fullWindow.hiddenDurationMs;
  const visibleLatencyMs = Math.max(0, latencyMs - hiddenDurationMs);

  const classified = classifyFirstTextPaintVisibility({
    latencyMs,
    backgroundAtFrame: input.backgroundAtFrame,
    hiddenBeforeFrame,
    hiddenDuringPaint,
    visibilityState,
    hiddenDurationMs,
  });

  return {
    visibilityState,
    wasHidden: classified.wasHidden,
    hiddenBeforeFrame,
    hiddenDuringPaint,
    hiddenDurationMs,
    visibleLatencyMs,
    visibilityPath: classified.visibilityPath,
    visibilityReason: classified.visibilityReason,
  };
}
