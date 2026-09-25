/** Shared, dependency-light Cursor pool selection. Keep Box model resolution
 * out of the full external proxy module and its unrelated runtime imports. */
import type { AccountRow } from "./store.js";
import { computeCursorSlotWeight, cursorModelFamily } from "./cursorQuota.js";

/** Session tokens expiring within this window are treated as unusable. */
export const CURSOR_EXTERNAL_SESSION_MIN_REMAINING_MS = 60_000;

export function selectCursorAccount(args: {
  accounts: AccountRow[];
  model: string;
  now: Date;
  cooled: ReadonlySet<string>;
  sticky: bigint | null;
  random?: () => number;
}): AccountRow | null {
  const nowMs = args.now.getTime();
  let eligible = args.accounts.filter((row) => {
    if (row.provider !== "cursor") return false;
    if (row.status !== "active") return false;
    if (!row.cursor_sand_enabled) return false;
    if (row.cooldown_until && row.cooldown_until.getTime() > nowMs) return false;
    if (args.cooled.has(row.id.toString())) return false;
    if (row.cursor_credential_kind === "session") {
      // No server-side refresh: a session token that is (about to be) expired
      // would only produce a 401 → cooldown loop. Skip it up front.
      if (!row.oauth_expires_at) return false;
      if (row.oauth_expires_at.getTime() <= nowMs + CURSOR_EXTERNAL_SESSION_MIN_REMAINING_MS) return false;
    }
    return true;
  });
  if (eligible.length === 0) return null;
  if (cursorModelFamily(args.model) === "other_models") {
    // `other_models` = Claude / Gemini families; slots learned as `cursor_only`
    // (quota left only for Cursor's own grok/composer models) cannot serve
    // them. Fall back to the whole set if that filter empties (class may be stale).
    const narrowed = eligible.filter((row) => row.cursor_quota_class !== "cursor_only");
    if (narrowed.length > 0) eligible = narrowed;
  }
  if (args.sticky !== null) {
    const hit = eligible.find((row) => row.id === args.sticky);
    if (hit) return hit;
  }
  const weights = eligible.map((row) =>
    computeCursorSlotWeight(
      {
        sandUsagePct: row.cursor_sand_usage_pct,
        sandNextResetAt: row.cursor_sand_next_reset_at,
        billingCycleEnd: row.cursor_billing_cycle_end,
        sandAccessState: row.cursor_sand_access_state,
      },
      args.now,
    ),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = (args.random ?? Math.random)() * total;
  for (let i = 0; i < eligible.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return eligible[i]!;
  }
  return eligible[eligible.length - 1]!;
}
