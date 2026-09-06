/**
 * grokUsageSweeper — hourly credit / Grok Build usage refresh for
 * provider='grok' account rows (0276).
 *
 * Before this, the only place the platform learned a Grok account's remaining
 * credits was an on-demand admin modal (60s in-memory cache, never persisted).
 * This sweeper writes the secret-free numbers onto the row so the admin
 * accounts table can show them inline (no modal round trip). Grok has no
 * `.slot-weight` sidecar / materializer — unlike cursorUsageSweeper, there is
 * no pool-projection nudge.
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
import { getRuntimeChannel } from "../runtimeChannel.js";
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

const log = rootLogger.child({ module: "grokUsageSweeper" });

export const GROK_USAGE_SWEEP_INTERVAL_MS = 60 * 60_000;
const MIN_INTERVAL_MS = 60_000;
/** xAI billing is not a hot path; pace the batch a little. */
const PER_ACCOUNT_GAP_MS = 1_500;
const MAX_ERROR_LEN = 200;

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

function shortError(err: unknown): string {
  if (err instanceof GrokUsageUnavailableError) {
    const keys = Object.keys(err.details).slice(0, 4).join(",");
    return `${err.code}${keys ? `:${keys}` : ""}`.slice(0, MAX_ERROR_LEN);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, MAX_ERROR_LEN);
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
  | { ok: true; snapshot: GrokUsageSnapshot }
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
  setCachedGrokUsage(id.toString(), snapshot, now());
  return { ok: true, snapshot };
}

export interface GrokUsageSweepDeps extends RefreshGrokAccountUsageDeps {
  listGrokAccounts?: () => Promise<AccountRow[]>;
  sleep?: (ms: number) => Promise<void>;
}

export interface GrokUsageSweepSummary {
  scanned: number;
  refreshed: number;
  failed: number;
  skipped: number;
}

export function isGrokUsageSweepCandidate(row: AccountRow): boolean {
  return row.provider === "grok"
    && (row.status === "active" || row.status === "cooldown");
}

/** One pass over every eligible Grok account row. Never throws. */
export async function sweepGrokUsageOnce(deps: GrokUsageSweepDeps = {}): Promise<GrokUsageSweepSummary> {
  const listGrokAccounts = deps.listGrokAccounts
    ?? (() => listAccounts({ provider: "grok", limit: 500 }));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const summary: GrokUsageSweepSummary = { scanned: 0, refreshed: 0, failed: 0, skipped: 0 };
  let rows: AccountRow[];
  try {
    rows = await listGrokAccounts();
  } catch (err) {
    log.warn("grok usage sweep: listing accounts failed", { err: err instanceof Error ? err.message : String(err) });
    return summary;
  }
  const candidates = rows.filter(isGrokUsageSweepCandidate);
  summary.scanned = candidates.length;
  for (let i = 0; i < candidates.length; i += 1) {
    const row = candidates[i];
    try {
      const result = await refreshGrokAccountUsage(row, deps);
      if (result.ok) {
        summary.refreshed += 1;
      } else if (result.skipped) {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
        log.info("grok usage sweep: account refresh failed", { accountId: row.id.toString(), reason: result.reason });
      }
    } catch (err) {
      summary.failed += 1;
      log.warn("grok usage sweep: account refresh threw", {
        accountId: row.id.toString(),
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (i < candidates.length - 1) await sleep(PER_ACCOUNT_GAP_MS);
  }
  log.info("grok usage sweep done", { ...summary });
  return summary;
}

export function startGrokUsageSweeper(
  opts: { intervalMs?: number; runOnStart?: boolean; deps?: GrokUsageSweepDeps } = {},
): { stop: () => void; runOnceForTest: () => Promise<GrokUsageSweepSummary> } {
  if (getRuntimeChannel() !== "v5") {
    // Commercial (v3) masters have no Grok subscription pool; do not schedule.
    return { stop: () => {}, runOnceForTest: async () => ({ scanned: 0, refreshed: 0, failed: 0, skipped: 0 }) };
  }
  const intervalMs = Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? GROK_USAGE_SWEEP_INTERVAL_MS);
  let inFlight: Promise<GrokUsageSweepSummary> | null = null;
  let stopped = false;
  const run = (): Promise<GrokUsageSweepSummary> => {
    if (inFlight) return inFlight;
    const task = sweepGrokUsageOnce(opts.deps).finally(() => { if (inFlight === task) inFlight = null; });
    inFlight = task;
    return task;
  };
  const timer = setInterval(() => { if (!stopped) void run(); }, intervalMs);
  timer.unref?.();
  if (opts.runOnStart ?? true) {
    // Let the DB pool settle first.
    const boot = setTimeout(() => { if (!stopped) void run(); }, 15_000);
    boot.unref?.();
  }
  return {
    stop: () => { stopped = true; clearInterval(timer); },
    runOnceForTest: run,
  };
}
