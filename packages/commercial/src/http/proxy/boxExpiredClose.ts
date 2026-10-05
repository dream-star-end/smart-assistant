/** OCV5-313: terminal journal state for a Box run that can no longer be alive
 * (older than BOX_RUN_EXPIRED_AFTER_MS) and whose keeper proof cannot be read:
 * the account is disabled or unreachable, or the proof files are gone. It
 * records that nothing was proven. No terminal proof is invented and no remote
 * cleanup is implied. */
export const BOX_EXPIRED_UNPROVEN_STATE = "expired_unproven";
/** Written by scripts/ocv5-289/boxUnreachableClose.ts (operator, OCV5-312). */
export const BOX_OPERATOR_UNREACHABLE_CLOSED_STATE = "operator_unreachable_closed";

const PRIOR_STATES: ReadonlySet<string> = new Set(["running", "unknown", "linked", "handoff"]);
const CAUSE = /^[A-Za-z0-9_]{1,64}$/;

/** One validator for every reader and writer of boxUnknownPhase. */
export function isBoxUnknownPhase(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_:]{1,80}$/.test(value);
}

export function isBoxExpiredCloseCause(value: unknown): value is string {
  return typeof value === "string" && CAUSE.test(value);
}

function record(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : null;
}
function epochMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && /^[0-9]{13}$/.test(String(value));
}

export interface BoxExpiredClose {
  readonly v: 1; readonly atMs: number; readonly priorBoxState: string; readonly cause: string;
}
/** Only the exact marker markRunExpiredUnproven writes. */
export function parseBoxExpiredClose(raw: unknown): BoxExpiredClose | null {
  const marker = record(raw);
  if (!marker || Object.keys(marker).sort().join(",") !== "atMs,cause,priorBoxState,v"
    || marker.v !== 1 || !epochMs(marker.atMs) || !isBoxExpiredCloseCause(marker.cause)
    || typeof marker.priorBoxState !== "string" || !PRIOR_STATES.has(marker.priorBoxState)) {
    return null;
  }
  return marker as unknown as BoxExpiredClose;
}

/** The operator's complete OCV5-312 marker; returns the state it replaced. */
export function parseBoxOperatorUnreachableClose(raw: unknown): string | null {
  const marker = record(raw);
  if (!marker || Object.keys(marker).sort().join(",")
      !== "accountStatus,atMs,priorBoxState,remoteCleanup,terminalProof,ticket,v"
    || marker.v !== 1 || typeof marker.ticket !== "string"
    || !/^OCV5-[0-9]{1,6}$/.test(marker.ticket) || marker.accountStatus !== "disabled"
    || marker.terminalProof !== false || marker.remoteCleanup !== false
    || !epochMs(marker.atMs) || typeof marker.priorBoxState !== "string"
    || !PRIOR_STATES.has(marker.priorBoxState)) return null;
  return marker.priorBoxState;
}
