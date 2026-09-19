/**
 * cursorUsageSweeper — hourly Sand (Grok Bot) pool usage refresh for Cursor
 * account-session rows (0262).
 *
 * Before this, the only place the platform learned a Cursor account's Sand
 * usage was the admin "Cursor 额度 / 用量" modal (on demand, 60s in-memory
 * cache, never persisted). Scheduling could therefore not prefer the account
 * with the most remaining Sand quota, the soonest weekly reset, or the soonest
 * plan expiry. This sweeper writes the secret-free numbers onto the row so:
 *
 *   1. the admin accounts table shows them inline (no modal round trip);
 *   2. cursorMaterializer can project them into a `.slot-weight` sidecar for
 *      the container wrapper's first-touch account choice (new users land on
 *      the account with the most headroom / closest to being wasted).
 *
 * Scope: `provider='cursor' AND cursor_credential_kind='session' AND status
 * IN ('active','cooldown')`. `crsr_` API-key rows have no cursor.com face
 * (`no_auth_id`) and are skipped. Disabled/banned rows are skipped: nothing
 * routes to them and their tokens may be dead.
 *
 * Failure model: per-account isolation. One rejected session must not starve
 * the others. A failed refresh leaves the previous numbers in place and
 * records `cursor_usage_error`; a success clears it. Never logs tokens.
 */
import {
  CursorUsageUnavailableError,
  fetchCursorSessionUsage,
  setCachedCursorUsage,
  type CursorUsageSnapshot,
} from "../admin/cursorSessionUsage.js";
import { getPool } from "../db/index.js";
import { getCursorTokenSnapshot, listAccounts, type AccountRow } from "./store.js";
import { scheduleCursorAuthSync } from "./cursorMaterializer.js";
import { weightInputsCrossedBucket } from "./poolWeight.js";
import {
  USAGE_SWEEP_DEFAULT_INTERVAL_MS,
  USAGE_SWEEP_MAX_ERROR_LEN,
  shortUsageError,
  sweepUsageOnce,
  startUsageSweeper,
  type UsageSweepSummary,
  type UsageSweeperSpec,
} from "./usageSweeper.js";

export const CURSOR_USAGE_SWEEP_INTERVAL_MS = USAGE_SWEEP_DEFAULT_INTERVAL_MS;
const MAX_ERROR_LEN = USAGE_SWEEP_MAX_ERROR_LEN;

export interface CursorUsageColumnPatch {
  cursor_sand_usage_pct: number | null;
  cursor_sand_period_start: Date | null;
  cursor_sand_next_reset_at: Date | null;
  cursor_sand_access_state: string | null;
  cursor_plan_membership: string | null;
  cursor_billing_cycle_end: Date | null;
}

function dateOrNull(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function pctOrNull(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // NUMERIC(5,2): clamp into what the column can hold.
  return Math.min(999.99, Math.max(0, Math.round(value * 100) / 100));
}

/** Pure: pick the persisted columns out of a usage snapshot. */
export function cursorUsagePatchFromSnapshot(snap: CursorUsageSnapshot): CursorUsageColumnPatch {
  return {
    cursor_sand_usage_pct: pctOrNull(snap.sand.usage_percent),
    cursor_sand_period_start: dateOrNull(snap.sand.period_start),
    cursor_sand_next_reset_at: dateOrNull(snap.sand.next_reset_at),
    cursor_sand_access_state: snap.sand.access_state ?? null,
    cursor_plan_membership: snap.plan.membership_type ?? null,
    cursor_billing_cycle_end: dateOrNull(snap.plan.billing_cycle_end),
  };
}

/**
 * Did the scheduling-relevant numbers change enough to warrant a new pool
 * projection? Bucketed so a 0.3% drift every hour does not churn generations.
 */
export function cursorUsageWeightInputsChanged(
  before: Pick<AccountRow, "cursor_sand_usage_pct" | "cursor_sand_next_reset_at" | "cursor_billing_cycle_end">,
  after: CursorUsageColumnPatch,
): boolean {
  return weightInputsCrossedBucket(
    [[before.cursor_sand_usage_pct, after.cursor_sand_usage_pct]],
    [
      [before.cursor_sand_next_reset_at, after.cursor_sand_next_reset_at],
      [before.cursor_billing_cycle_end, after.cursor_billing_cycle_end],
    ],
  );
}

function shortError(err: unknown): string {
  return err instanceof CursorUsageUnavailableError
    ? shortUsageError(err, err.code, Object.keys(err.details))
    : shortUsageError(err);
}

/** Secret-free snapshot for the JSONB fallback: drop nothing but be explicit. */
function snapshotForStorage(snap: CursorUsageSnapshot): CursorUsageSnapshot {
  return JSON.parse(JSON.stringify(snap)) as CursorUsageSnapshot;
}

export interface RefreshCursorAccountUsageDeps {
  fetchUsage?: typeof fetchCursorSessionUsage;
  getTokenSnapshot?: typeof getCursorTokenSnapshot;
  query?: (text: string, params: unknown[]) => Promise<unknown>;
  now?: () => number;
  /** Called when scheduling-relevant inputs moved; default re-materializes the pool. */
  onWeightInputsChanged?: (accountId: bigint) => void;
}

export type RefreshCursorAccountUsageResult =
  | { ok: true; snapshot: CursorUsageSnapshot; weightInputsChanged: boolean }
  | { ok: false; reason: string; skipped?: "not_session" | "expired" | "missing" };

/**
 * Refresh one account: fetch → persist columns + snapshot → refresh the
 * modal cache → nudge the materializer when the weight inputs moved.
 * Shared by the hourly sweeper and the manual `?refresh=1` admin route.
 */
export async function refreshCursorAccountUsage(
  account: AccountRow,
  deps: RefreshCursorAccountUsageDeps = {},
): Promise<RefreshCursorAccountUsageResult> {
  const fetchUsage = deps.fetchUsage ?? fetchCursorSessionUsage;
  const getTokenSnapshot = deps.getTokenSnapshot ?? getCursorTokenSnapshot;
  const query = deps.query ?? ((text: string, params: unknown[]) => getPool().query(text, params));
  const now = deps.now ?? Date.now;
  const onWeightInputsChanged = deps.onWeightInputsChanged
    ?? (() => scheduleCursorAuthSync("cursor.usage-refresh"));
  const id = account.id;

  if (account.provider !== "cursor" || account.cursor_credential_kind !== "session") {
    return { ok: false, reason: "not a Cursor session credential", skipped: "not_session" };
  }
  const tokenSnap = await getTokenSnapshot(id);
  if (!tokenSnap) return { ok: false, reason: "account not found", skipped: "missing" };
  let accessToken: string | null = null;
  try {
    if (tokenSnap.expires_at && tokenSnap.expires_at.getTime() <= now()) {
      await query(
        `UPDATE claude_accounts SET cursor_usage_error = $2 WHERE id = $1`,
        [id.toString(), "session_expired"],
      );
      return { ok: false, reason: "session expired", skipped: "expired" };
    }
    accessToken = tokenSnap.token.toString("utf8");
  } finally {
    tokenSnap.token.fill(0);
    tokenSnap.refresh?.fill(0);
  }

  let snapshot: CursorUsageSnapshot;
  try {
    snapshot = await fetchUsage({
      accessToken,
      authId: account.cursor_auth_id,
      machineId: tokenSnap.machine_id,
    });
  } catch (err) {
    const reason = shortError(err);
    await query(
      `UPDATE claude_accounts SET cursor_usage_error = $2 WHERE id = $1`,
      [id.toString(), reason],
    );
    return { ok: false, reason };
  } finally {
    accessToken = null;
  }

  const patch = cursorUsagePatchFromSnapshot(snapshot);
  const weightInputsChanged = cursorUsageWeightInputsChanged(account, patch);
  const sandFailed = snapshot.sand.usage_percent === null && Object.keys(snapshot.errors).some((k) => k.startsWith("sand_"));
  await query(
    `UPDATE claude_accounts
        SET cursor_sand_usage_pct     = COALESCE($2::numeric, cursor_sand_usage_pct),
            cursor_sand_period_start  = COALESCE($3::timestamptz, cursor_sand_period_start),
            cursor_sand_next_reset_at = COALESCE($4::timestamptz, cursor_sand_next_reset_at),
            cursor_sand_access_state  = COALESCE($5::text, cursor_sand_access_state),
            cursor_plan_membership    = COALESCE($6::text, cursor_plan_membership),
            cursor_billing_cycle_end  = COALESCE($7::timestamptz, cursor_billing_cycle_end),
            cursor_usage_updated_at   = NOW(),
            cursor_usage_error        = $8::text,
            cursor_usage_snapshot     = $9::jsonb
      WHERE id = $1`,
    [
      id.toString(),
      patch.cursor_sand_usage_pct,
      patch.cursor_sand_period_start,
      patch.cursor_sand_next_reset_at,
      patch.cursor_sand_access_state,
      patch.cursor_plan_membership,
      patch.cursor_billing_cycle_end,
      sandFailed ? `sand_unavailable:${Object.keys(snapshot.errors).filter((k) => k.startsWith("sand_")).join(",")}`.slice(0, MAX_ERROR_LEN) : null,
      JSON.stringify(snapshotForStorage(snapshot)),
    ],
  );
  setCachedCursorUsage(id.toString(), snapshot, now());
  if (weightInputsChanged) onWeightInputsChanged(id);
  return { ok: true, snapshot, weightInputsChanged };
}

export interface CursorUsageSweepDeps extends RefreshCursorAccountUsageDeps {
  listCursorAccounts?: () => Promise<AccountRow[]>;
  sleep?: (ms: number) => Promise<void>;
}

export type CursorUsageSweepSummary = UsageSweepSummary;

export function isCursorUsageSweepCandidate(row: AccountRow): boolean {
  return row.provider === "cursor"
    && row.cursor_credential_kind === "session"
    && (row.status === "active" || row.status === "cooldown")
    && row.cursor_auth_id !== null;
}

/**
 * Provider strategy for the shared usage-sweep skeleton (usageSweeper.ts).
 * Pool sync is debounced, so the per-account nudge is suppressed during a
 * sweep and fired once at the end via onAnyWeightChanged.
 */
const CURSOR_USAGE_SWEEP: UsageSweeperSpec<CursorUsageSweepDeps> = {
  label: "cursor usage sweep",
  provider: "cursor",
  isCandidate: isCursorUsageSweepCandidate,
  refresh: (row, deps) => refreshCursorAccountUsage(row, { ...deps, onWeightInputsChanged: () => {} }),
  onAnyWeightChanged: (deps) => {
    (deps.onWeightInputsChanged ?? (() => scheduleCursorAuthSync("cursor.usage-sweep")))(0n);
  },
  listRows: (deps) => (deps.listCursorAccounts ?? (() => listAccounts({ provider: "cursor", limit: 500 })))(),
};

/** One pass over every eligible Cursor session row. Never throws. */
export function sweepCursorUsageOnce(deps: CursorUsageSweepDeps = {}): Promise<CursorUsageSweepSummary> {
  return sweepUsageOnce({ ...CURSOR_USAGE_SWEEP, sleep: deps.sleep }, deps);
}

export function startCursorUsageSweeper(
  opts: { intervalMs?: number; runOnStart?: boolean; deps?: CursorUsageSweepDeps } = {},
): { stop: () => void; runOnceForTest: () => Promise<CursorUsageSweepSummary> } {
  const deps = opts.deps ?? {};
  return startUsageSweeper({ ...CURSOR_USAGE_SWEEP, sleep: deps.sleep }, { intervalMs: opts.intervalMs, runOnStart: opts.runOnStart, deps });
}
