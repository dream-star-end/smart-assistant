/**
 * usageSweeper — the provider-neutral "hourly walk over the pool and refresh
 * each account's quota numbers" skeleton shared by cursorUsageSweeper and
 * grokUsageSweeper (and the next subscription provider).
 *
 * What lives here: candidate listing, per-account isolation (one bad token
 * must not starve the rest), inter-account pacing, the summary shape, the
 * v5-only guard, the in-flight de-dup and the boot delay.
 *
 * What stays per provider: how to obtain a token, what to fetch, which
 * columns to write, and what "the weight inputs moved" means — passed in as
 * `refresh`. Only that function knows the provider's columns.
 */
import { rootLogger } from "../logging/logger.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import { listAccounts, type AccountProvider, type AccountRow } from "./store.js";

/** Pace between accounts: both Cursor's web face and xAI billing rate-limit per session. */
export const USAGE_SWEEP_PER_ACCOUNT_GAP_MS = 1_500;
export const USAGE_SWEEP_DEFAULT_INTERVAL_MS = 60 * 60_000;
export const USAGE_SWEEP_MIN_INTERVAL_MS = 60_000;
/** Let the DB pool / materializer boot sync settle before the first pass. */
export const USAGE_SWEEP_BOOT_DELAY_MS = 15_000;
export const USAGE_SWEEP_MAX_ERROR_LEN = 200;

export interface UsageSweepSummary {
  scanned: number;
  refreshed: number;
  failed: number;
  skipped: number;
  weightChanged: number;
}

export const emptyUsageSweepSummary = (): UsageSweepSummary =>
  ({ scanned: 0, refreshed: 0, failed: 0, skipped: 0, weightChanged: 0 });

/** Per-account refresh outcome the skeleton understands. `skipped` is any
 * provider-specific reason the row was not attempted (wrong kind, expired…). */
export type UsageRefreshOutcome =
  | { ok: true; weightInputsChanged: boolean }
  | { ok: false; reason: string; skipped?: string };

export interface UsageSweeperSpec<Deps> {
  /** Log prefix / module tag, e.g. "cursor usage sweep". */
  label: string;
  provider: AccountProvider;
  /** Which rows of `provider` are worth refreshing (status, credential kind…). */
  isCandidate: (row: AccountRow) => boolean;
  /** Provider-specific single-account refresh. Must not throw for expected
   * failures (return ok:false); thrown errors are counted as failed too. */
  refresh: (row: AccountRow, deps: Deps) => Promise<UsageRefreshOutcome>;
  /** Optional hook when at least one account's weight inputs moved in a pass
   * (Cursor re-materializes the pool once, debounced). */
  onAnyWeightChanged?: (deps: Deps) => void;
  /** Rows to consider; default `listAccounts({ provider, limit: 500 })`. */
  listRows?: (deps: Deps) => Promise<AccountRow[]>;
  sleep?: (ms: number) => Promise<void>;
}

/** Truncate/normalise an error for a `*_usage_error` column. */
export function shortUsageError(err: unknown, code?: string, detailKeys?: string[]): string {
  if (code !== undefined) {
    const keys = (detailKeys ?? []).slice(0, 4).join(",");
    return `${code}${keys ? `:${keys}` : ""}`.slice(0, USAGE_SWEEP_MAX_ERROR_LEN);
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, USAGE_SWEEP_MAX_ERROR_LEN);
}

/** One pass over every candidate row. Never throws. */
export async function sweepUsageOnce<Deps>(spec: UsageSweeperSpec<Deps>, deps: Deps): Promise<UsageSweepSummary> {
  const log = rootLogger.child({ module: spec.label.replace(/\s+/g, "-") });
  const listRows = spec.listRows ?? (() => listAccounts({ provider: spec.provider, limit: 500 }));
  const sleep = spec.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const summary = emptyUsageSweepSummary();
  let rows: AccountRow[];
  try {
    rows = await listRows(deps);
  } catch (err) {
    log.warn(`${spec.label}: listing accounts failed`, { err: err instanceof Error ? err.message : String(err) });
    return summary;
  }
  const candidates = rows.filter(spec.isCandidate);
  summary.scanned = candidates.length;
  let anyWeightChanged = false;
  for (let i = 0; i < candidates.length; i += 1) {
    const row = candidates[i];
    try {
      const result = await spec.refresh(row, deps);
      if (result.ok) {
        summary.refreshed += 1;
        if (result.weightInputsChanged) {
          summary.weightChanged += 1;
          anyWeightChanged = true;
        }
      } else if (result.skipped) {
        summary.skipped += 1;
      } else {
        summary.failed += 1;
        log.info(`${spec.label}: account refresh failed`, { accountId: row.id.toString(), reason: result.reason });
      }
    } catch (err) {
      summary.failed += 1;
      log.warn(`${spec.label}: account refresh threw`, {
        accountId: row.id.toString(),
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (i < candidates.length - 1) await sleep(USAGE_SWEEP_PER_ACCOUNT_GAP_MS);
  }
  if (anyWeightChanged && spec.onAnyWeightChanged) spec.onAnyWeightChanged(deps);
  log.info(`${spec.label} done`, { ...summary });
  return summary;
}

export interface UsageSweeperHandle {
  stop: () => void;
  runOnceForTest: () => Promise<UsageSweepSummary>;
}

/**
 * Schedule `sweepUsageOnce` on an interval. v5-only: commercial (v3) masters
 * carry no subscription pools of these kinds. In-flight passes are de-duped;
 * the first pass waits `USAGE_SWEEP_BOOT_DELAY_MS`.
 */
export function startUsageSweeper<Deps>(
  spec: UsageSweeperSpec<Deps>,
  opts: { intervalMs?: number; runOnStart?: boolean; deps: Deps },
): UsageSweeperHandle {
  if (getRuntimeChannel() !== "v5") {
    return { stop: () => {}, runOnceForTest: async () => emptyUsageSweepSummary() };
  }
  const intervalMs = Math.max(USAGE_SWEEP_MIN_INTERVAL_MS, opts.intervalMs ?? USAGE_SWEEP_DEFAULT_INTERVAL_MS);
  let inFlight: Promise<UsageSweepSummary> | null = null;
  let stopped = false;
  const run = (): Promise<UsageSweepSummary> => {
    if (inFlight) return inFlight;
    const task = sweepUsageOnce(spec, opts.deps).finally(() => { if (inFlight === task) inFlight = null; });
    inFlight = task;
    return task;
  };
  const timer = setInterval(() => { if (!stopped) void run(); }, intervalMs);
  timer.unref?.();
  if (opts.runOnStart ?? true) {
    const boot = setTimeout(() => { if (!stopped) void run(); }, USAGE_SWEEP_BOOT_DELAY_MS);
    boot.unref?.();
  }
  return {
    stop: () => { stopped = true; clearInterval(timer); },
    runOnceForTest: run,
  };
}
