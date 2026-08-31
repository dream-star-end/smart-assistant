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
  // 引擎进程死了但容器还活着（容器内崩溃/被杀）时，containerRunning 永远为 true，
  // 旧判据会把这种 tapeless dispatch 永远 skip：不中断、不恢复、不出终态卡，用户端
  // 永远停在「已发送」（2026-08-31 webmtd63p5mm747zh 实锤）。存活的引擎在 accepted
  // 后必会尽快发出至少一帧（ack/thinking）；从无任何帧且静默超阈 = 引擎已死，
  // 与容器存活与否无关。
  if (
    !partsComplete &&
    row.lastFrameAtMs === null &&
    quietMs >= ENGINE_DEAD_QUIET_MS
  ) {
    return "interrupt_tapeless";
  }
  return "skip";
}
