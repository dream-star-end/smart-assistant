/**
 * Visible-orphan classification for turnDispatchReconciler (design rev2 §方向2).
 * Pure so unit tests do not need a fake PG for the three branches.
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
  if (!partsComplete && quietMs >= ENGINE_DEAD_QUIET_MS && !row.containerRunning) {
    return "interrupt_tapeless";
  }
  return "skip";
}
