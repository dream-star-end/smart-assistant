/**
 * Visible-orphan classification for turnDispatchReconciler (design rev2 §方向2).
 * Pure so unit tests do not need a fake PG for the three branches.
 *
 * OCV5-57: zero PG dispatch frames is not by itself a kill signal. Persist can
 * lag hours behind a live engine (89f18ffe, 2026-08-31). Liveness evidence
 * (turn_traces.first_visible_at, optional persist-backlog flag) must skip the
 * 15min tapeless interrupt. OCV5-43 (engine died during hydrate, no frames,
 * no first_visible, container still running) still interrupts at 15min.
 */
export const PARTS_COMPLETE_QUIET_MS = 2 * 60_000;
export const ENGINE_DEAD_QUIET_MS = 15 * 60_000;
export const HARD_CAP_AGE_MS = 6 * 60 * 60_000;

export type VisibleOrphanAction =
  | "skip"
  | "converge_only"
  | "complete_from_frames"
  | "interrupt_tapeless"
  | "fence_hard_cap";

export interface VisibleOrphanEvidence {
  tapeVisibleAt: number | null;
  tapePartCount: number | null;
  tapePartsRows: number;
  lastFrameAtMs: number | null;
  acceptedOrAdmittedAtMs: number;
  containerRunning: boolean;
  nowMs: number;
  /**
   * `turn_traces.first_visible_at` for this dispatch. Written on the first
   * thinking/text/tool before live-frame persist, so it survives PG persist lag.
   */
  firstVisibleAtMs: number | null;
  /**
   * True when in-process persist evidence says last_frame_at is not a reliable
   * kill signal (frames may exist in memory but not yet in PG).
   *
   * Reconciler currently always passes false: `_OutboundPersistQueueCoordinator`
   * in userChatBridge is per-bridge, keyed by container/session namespace, and
   * is not dispatch-addressable without a cross-module registry. Do not invent
   * that registry in this patch.
   */
  persistBacklogUndetermined?: boolean;
}

/** Interrupt and 6h hard-cap must fence the producer so leftover frames/settlement are rejected. */
export function shouldFenceProducer(action: VisibleOrphanAction): boolean {
  return action === "interrupt_tapeless" || action === "fence_hard_cap";
}

function hasEngineLiveness(row: VisibleOrphanEvidence): boolean {
  return row.firstVisibleAtMs != null || row.persistBacklogUndetermined === true;
}

/**
 * Session-key shape from userChatBridge CG2d:
 * `agent:<aid>:webchat:dm:<sessionId>`. Direct equality covers tests/unknown-peer.
 */
export function traceSessionKeyMatchesSession(sessionKey: string, sessionId: string): boolean {
  return sessionKey === sessionId || sessionKey.endsWith(`:${sessionId}`);
}

export type TraceFirstVisibleRow = {
  dispatchId: string | null;
  userId: string;
  sessionKey: string;
  firstVisibleAtMs: number | null;
};

export type DispatchFirstVisibleKey = {
  dispatchId: string;
  userId: string;
  sessionId: string;
  admittedAtMs: number;
  nextAdmittedAtMs: number | null;
};

/**
 * Pure equivalent of the closeVisibleOrphans first_visible subquery.
 * Primary: turn_traces.dispatch_id. Fallback when backfill missed: same
 * user + session_key, first_visible in [admitted_at, next_admitted_at).
 * turn_traces has no client_message_id column (0126+0170); the time window
 * is the turn isolator (see visibleOrphan.test.ts uniqueness cases).
 */
export function firstVisibleAtMsForDispatch(
  traces: readonly TraceFirstVisibleRow[],
  dispatch: DispatchFirstVisibleKey,
): number | null {
  let min: number | null = null;
  for (const tr of traces) {
    if (tr.firstVisibleAtMs == null) continue;
    const byDispatch = tr.dispatchId === dispatch.dispatchId;
    const byFallback =
      tr.dispatchId == null &&
      tr.userId === dispatch.userId &&
      traceSessionKeyMatchesSession(tr.sessionKey, dispatch.sessionId) &&
      tr.firstVisibleAtMs >= dispatch.admittedAtMs &&
      (dispatch.nextAdmittedAtMs === null || tr.firstVisibleAtMs < dispatch.nextAdmittedAtMs);
    if (!byDispatch && !byFallback) continue;
    if (min === null || tr.firstVisibleAtMs < min) min = tr.firstVisibleAtMs;
  }
  return min;
}

export function classifyVisibleOrphan(row: VisibleOrphanEvidence): VisibleOrphanAction {
  const quietMs = row.lastFrameAtMs === null
    ? row.nowMs - row.acceptedOrAdmittedAtMs
    : Math.max(0, row.nowMs - row.lastFrameAtMs);
  const ageMs = row.nowMs - row.acceptedOrAdmittedAtMs;
  if (row.tapeVisibleAt !== null) return "converge_only";
  const partsComplete =
    row.tapePartCount !== null &&
    row.tapePartCount > 0 &&
    row.tapePartsRows === row.tapePartCount;
  if (partsComplete && quietMs >= PARTS_COMPLETE_QUIET_MS) return "complete_from_frames";
  if (ageMs >= HARD_CAP_AGE_MS && quietMs >= ENGINE_DEAD_QUIET_MS) return "fence_hard_cap";
  // OCV5-57 audit r1 B1 (captain 2026-08-31): containerRunning=false means the
  // user has no active container, so the engine is dead. 15min terminal is
  // correct; first_visible / persist-backlog liveness evidence does not apply.
  if (!partsComplete && quietMs >= ENGINE_DEAD_QUIET_MS && !row.containerRunning) {
    return "interrupt_tapeless";
  }
  // OCV5-43 webmtd63p5mm747zh: engine died inside a still-running container
  // during hydrate. No frames, no first_visible → interrupt at 15min even
  // while containerRunning. Zero PG dispatch frames is NOT enough when the
  // engine already produced visible content (OCV5-57 89f18ffe persist lag).
  if (
    !partsComplete &&
    row.lastFrameAtMs === null &&
    quietMs >= ENGINE_DEAD_QUIET_MS &&
    !hasEngineLiveness(row)
  ) {
    return "interrupt_tapeless";
  }
  return "skip";
}
