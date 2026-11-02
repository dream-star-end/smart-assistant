/** A subscription-window rejection is not an arbitrary rate limit. This
 * observer belongs to one decoder/round and never reads synthetic error text. */
export const BOX_CLI_QUOTA_EXHAUSTED = "BOX_CLI_QUOTA_EXHAUSTED";
export const BOX_QUOTA_WINDOWS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const;
export type BoxQuotaWindow = typeof BOX_QUOTA_WINDOWS[number];
export interface BoxQuotaEvidence { quotaWindow: BoxQuotaWindow; quotaResetAtMs?: number }
const windows: ReadonlySet<string> = new Set(BOX_QUOTA_WINDOWS);
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class BoxCliQuotaObserver {
  private sessionId: string | undefined;
  private bindingRejected = false;
  private pending: BoxQuotaEvidence | undefined;
  constructor(expectedNativeSessionId?: string) {
    if (typeof expectedNativeSessionId === "string" && SESSION.test(expectedNativeSessionId)) {
      this.sessionId = expectedNativeSessionId;
    }
  }
  /** Called only after the decoder accepts the CLI init. A quota event
   * cannot establish its own session authority. A conflicting init fails closed. */
  bindNativeSession(sessionId: unknown): void {
    this.pending = undefined;
    if (typeof sessionId !== "string" || !SESSION.test(sessionId)) return;
    if (this.sessionId !== undefined && this.sessionId !== sessionId) {
      this.bindingRejected = true; this.sessionId = undefined;
    } else if (!this.bindingRejected) this.sessionId = sessionId;
  }
  /** rateLimited is supplied by the existing synthetic API refusal validator.
   * Only the immediately adjacent, same-session rejection can qualify it. */
  take(record: unknown, rateLimited = false): BoxQuotaEvidence | null {
    const pending = this.pending;
    this.pending = undefined;
    if (!object(record) || this.bindingRejected || this.sessionId === undefined
      || record.session_id !== this.sessionId) return null;
    if (record.type === "rate_limit_event") {
      const info = record.rate_limit_info;
      if (!object(info) || info.status !== "rejected" || info.overageStatus !== "rejected"
        || (info.isUsingOverage !== undefined && info.isUsingOverage !== false)
        || typeof info.rateLimitType !== "string"
        || !windows.has(info.rateLimitType)) return null;
      const resetAtMs = typeof info.resetsAt === "number" ? info.resetsAt * 1000 : NaN;
      this.pending = { quotaWindow: info.rateLimitType as BoxQuotaWindow,
        ...(Number.isSafeInteger(resetAtMs) && resetAtMs > 0 && resetAtMs <= 8_640_000_000_000_000
          ? { quotaResetAtMs: resetAtMs } : {}) };
      return null;
    }
    return rateLimited && pending ? pending : null;
  }
}
