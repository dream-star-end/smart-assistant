/**
 * grokUsageSweeper — hourly credit / Grok Build usage refresh for
 * provider='grok' account rows (0276).
 *
 * Before this, the only place the platform learned a Grok account's remaining
 * credits was an on-demand admin modal (60s in-memory cache, never persisted).
 * This sweeper writes the secret-free numbers onto the row so the admin
 * accounts table can show them inline (no modal round trip). Grok does not
 * need a sidecar / materializer: AccountScheduler.pick WRH reads
 * grok_credit_usage_pct / grok_credit_period_end from claude_accounts
 * (grokCreditFactor). This file only writes those numbers onto the row, and
 * buckets them like Sand (`weightInputsChanged`) for logs / tests.
 *
 * Scope: `provider='grok' AND status IN ('active','cooldown')`. Disabled /
 * banned rows are skipped: nothing routes to them and their tokens may be dead.
 *
 * Failure model: per-account isolation. One rejected token must not starve
 * the others. A failed refresh leaves the previous numbers in place and
 * records `grok_usage_error`; a success clears it. Never logs tokens.
 *
 * Egress: xAI is reachable from the master host; the bound sing-box egress
 * is IPv6-only and RST. Always use `directEgressDispatcher()` (same as
 * internalGrokRelay).
 */
import type { Dispatcher } from "undici";
import { rootLogger } from "../logging/logger.js";
import {
  GrokUsageUnavailableError,
  fetchGrokAccountUsage,
  setCachedGrokUsage,
  type GrokUsageSnapshot,
} from "../admin/grokAccountUsage.js";
import { getPool } from "../db/index.js";
import { listAccounts, type AccountRow } from "./store.js";
import { getFreshGrokAccessToken, GrokOAuthRefreshError } from "./grokOAuth.js";
import { directEgressDispatcher } from "./egressDispatcher.js";
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

const log = rootLogger.child({ module: "grokUsageSweeper" });

export const GROK_USAGE_SWEEP_INTERVAL_MS = USAGE_SWEEP_DEFAULT_INTERVAL_MS;
const MAX_ERROR_LEN = USAGE_SWEEP_MAX_ERROR_LEN;

export interface GrokUsageColumnPatch {
  grok_credit_usage_pct: number | null;
  grok_build_usage_pct: number | null;
  grok_credit_period_start: Date | null;
  grok_credit_period_end: Date | null;
  grok_subscription_tier: string | null;
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
export function grokUsagePatchFromSnapshot(snap: GrokUsageSnapshot): GrokUsageColumnPatch {
  return {
    grok_credit_usage_pct: pctOrNull(snap.credits.usage_percent),
    grok_build_usage_pct: pctOrNull(snap.credits.grok_build_percent),
    grok_credit_period_start: dateOrNull(snap.credits.period_start),
    grok_credit_period_end: dateOrNull(snap.credits.period_end),
    grok_subscription_tier: snap.account.subscription_tier ?? null,
  };
}

/**
 * Did the scheduling-relevant numbers change enough to observe? Bucketed so a
 * 0.3% drift every hour does not look like a WRH weight move.
 */
export function grokUsageWeightInputsChanged(
  before: Pick<AccountRow, "grok_credit_usage_pct" | "grok_credit_period_end">,
  after: Pick<GrokUsageColumnPatch, "grok_credit_usage_pct" | "grok_credit_period_end">,
): boolean {
  return weightInputsCrossedBucket(
    [[before.grok_credit_usage_pct, after.grok_credit_usage_pct]],
    [[before.grok_credit_period_end, after.grok_credit_period_end]],
  );
}

function shortError(err: unknown): string {
  return err instanceof GrokUsageUnavailableError
    ? shortUsageError(err, err.code, Object.keys(err.details))
    : shortUsageError(err);
}

function oauthTerminalCode(err: GrokOAuthRefreshError): string {
  return err.oauthCode ?? String(err.statusCode);
}

/** Secret-free snapshot for the JSONB fallback: drop nothing but be explicit. */
function snapshotForStorage(snap: GrokUsageSnapshot): GrokUsageSnapshot {
  return JSON.parse(JSON.stringify(snap)) as GrokUsageSnapshot;
}

export interface RefreshGrokAccountUsageDeps {
  fetchUsage?: typeof fetchGrokAccountUsage;
  getToken?: typeof getFreshGrokAccessToken;
  query?: (text: string, params: unknown[]) => Promise<unknown>;
  now?: () => number;
  dispatcher?: Dispatcher;
}

export type RefreshGrokAccountUsageResult =
  | { ok: true; snapshot: GrokUsageSnapshot; weightInputsChanged: boolean }
  | { ok: false; reason: string; skipped?: "not_grok" | "missing" | "token_terminal" };

/**
 * Refresh one account: fetch → persist columns + snapshot → refresh the
 * modal cache. Shared by the hourly sweeper and the manual `?refresh=1`
 * admin route.
 */
export async function refreshGrokAccountUsage(
  account: AccountRow,
  deps: RefreshGrokAccountUsageDeps = {},
): Promise<RefreshGrokAccountUsageResult> {
  const fetchUsage = deps.fetchUsage ?? fetchGrokAccountUsage;
  const getToken = deps.getToken ?? getFreshGrokAccessToken;
  const query = deps.query ?? ((text: string, params: unknown[]) => getPool().query(text, params));
  const now = deps.now ?? Date.now;
  const dispatcher = deps.dispatcher ?? directEgressDispatcher();
  const id = account.id;

  if (account.provider !== "grok") {
    return { ok: false, reason: "not a Grok account", skipped: "not_grok" };
  }

  let accessToken: string | null = null;
  try {
    const tokenBuf = await getToken(id);
    try {
      accessToken = tokenBuf.toString("utf8");
    } finally {
      tokenBuf.fill(0);
    }
  } catch (err) {
    if (err instanceof Error && err.message === "GROK_ACCOUNT_NOT_FOUND") {
      return { ok: false, reason: "account not found", skipped: "missing" };
    }
    if (err instanceof GrokOAuthRefreshError && err.terminal) {
      const reason = `oauth_terminal:${oauthTerminalCode(err)}`.slice(0, MAX_ERROR_LEN);
      await query(
        `UPDATE claude_accounts SET grok_usage_error = $2 WHERE id = $1`,
        [id.toString(), reason],
      );
      return { ok: false, reason, skipped: "token_terminal" };
    }
    const reason = shortError(err);
    await query(
      `UPDATE claude_accounts SET grok_usage_error = $2 WHERE id = $1`,
      [id.toString(), reason],
    );
    return { ok: false, reason };
  }

  let snapshot: GrokUsageSnapshot;
  try {
    snapshot = await fetchUsage({
      accessToken,
      dispatcher,
      now,
    });
  } catch (err) {
    const reason = shortError(err);
    await query(
      `UPDATE claude_accounts SET grok_usage_error = $2 WHERE id = $1`,
      [id.toString(), reason],
    );
    return { ok: false, reason };
  } finally {
    accessToken = null;
  }

  const patch = grokUsagePatchFromSnapshot(snapshot);
  await query(
    `UPDATE claude_accounts
        SET grok_credit_usage_pct    = COALESCE($2::numeric, grok_credit_usage_pct),
            grok_build_usage_pct     = COALESCE($3::numeric, grok_build_usage_pct),
            grok_credit_period_start = COALESCE($4::timestamptz, grok_credit_period_start),
            grok_credit_period_end   = COALESCE($5::timestamptz, grok_credit_period_end),
            grok_subscription_tier   = COALESCE($6::text, grok_subscription_tier),
            grok_usage_updated_at    = NOW(),
            grok_usage_error         = NULL,
            grok_usage_snapshot      = $7::jsonb
      WHERE id = $1`,
    [
      id.toString(),
      patch.grok_credit_usage_pct,
      patch.grok_build_usage_pct,
      patch.grok_credit_period_start,
      patch.grok_credit_period_end,
      patch.grok_subscription_tier,
      JSON.stringify(snapshotForStorage(snapshot)),
    ],
  );
  // Compare against what actually landed: the UPDATE COALESCEs a null patch
  // value onto the previous column, so a missing number is "unchanged".
  const effective = {
    grok_credit_usage_pct: patch.grok_credit_usage_pct ?? account.grok_credit_usage_pct,
    grok_credit_period_end: patch.grok_credit_period_end ?? account.grok_credit_period_end,
  };
  const weightInputsChanged = grokUsageWeightInputsChanged(account, effective);
  if (weightInputsChanged) {
    log.info("grok usage sweep: weight inputs moved", {
      accountId: id.toString(),
      pct: effective.grok_credit_usage_pct,
    });
  }
  setCachedGrokUsage(id.toString(), snapshot, now());
  return { ok: true, snapshot, weightInputsChanged };
}

export interface GrokUsageSweepDeps extends RefreshGrokAccountUsageDeps {
  listGrokAccounts?: () => Promise<AccountRow[]>;
  sleep?: (ms: number) => Promise<void>;
}

export type GrokUsageSweepSummary = UsageSweepSummary;

export function isGrokUsageSweepCandidate(row: AccountRow): boolean {
  return row.provider === "grok"
    && (row.status === "active" || row.status === "cooldown");
}

/** Provider strategy for the shared usage-sweep skeleton (usageSweeper.ts). */
const GROK_USAGE_SWEEP: UsageSweeperSpec<GrokUsageSweepDeps> = {
  label: "grok usage sweep",
  provider: "grok",
  isCandidate: isGrokUsageSweepCandidate,
  refresh: (row, deps) => refreshGrokAccountUsage(row, deps),
  listRows: (deps) => (deps.listGrokAccounts ?? (() => listAccounts({ provider: "grok", limit: 500 })))(),
};

/** One pass over every eligible Grok account row. Never throws. */
export function sweepGrokUsageOnce(deps: GrokUsageSweepDeps = {}): Promise<GrokUsageSweepSummary> {
  return sweepUsageOnce({ ...GROK_USAGE_SWEEP, sleep: deps.sleep }, deps);
}

export function startGrokUsageSweeper(
  opts: { intervalMs?: number; runOnStart?: boolean; deps?: GrokUsageSweepDeps } = {},
): { stop: () => void; runOnceForTest: () => Promise<GrokUsageSweepSummary> } {
  const deps = opts.deps ?? {};
  return startUsageSweeper({ ...GROK_USAGE_SWEEP, sleep: deps.sleep }, { intervalMs: opts.intervalMs, runOnStart: opts.runOnStart, deps });
}
