/**
 * poolWeight — provider-neutral weight primitives shared by every
 * subscription-quota account pool (CCB scheduler WRH, Grok Build WRH factor,
 * Cursor Sand `.slot-weight` sidecar).
 *
 * Before this file the same three ideas were hand-copied per provider:
 *
 *   - **headroom**: remaining share of a rolling quota window, so accounts with
 *     more room take more traffic;
 *   - **reset proximity**: the closer the window resets, the cheaper it is to
 *     burn what is left (unused quota is wasted at reset), so weight goes up;
 *   - **expiry proximity**: the CCB `subscriptionFactor` idea — a paid plan
 *     about to lapse should be drained first; an already-lapsed one is nearly
 *     worthless.
 *
 * plus the "did the inputs move enough to matter" bucketing used by the usage
 * sweepers to avoid churning WRH keys / pool generations on a 0.3% hourly drift.
 *
 * Every function here is pure. Provider modules keep their own NULL policy
 * (Grok treats unknown usage as neutral 1.0, Cursor as 0.5) by passing it in —
 * the primitives never guess a default.
 */

/** Hours from `now` to `d`; null when `d` is null or produces a non-finite delta. */
export function hoursUntil(d: Date | null | undefined, now: Date): number | null {
  if (d == null) return null;
  const ms = d.getTime() - now.getTime();
  return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

/**
 * Remaining quota share in (0, 1] from a used-percentage.
 *
 *   - `pct` null/NaN/negative → `unknown` (caller's neutral policy)
 *   - bucketed to `bucketPct` (default none) before computing so a 0.3% drift
 *     between sweeps does not move the weight (WRH keys stay put)
 *   - floored at `floor` (default 0.02) so an exhausted account still has a
 *     sliver — the whole pool may be exhausted and someone must serve.
 */
export function quotaHeadroom(
  pct: number | null | undefined,
  opts: { unknown: number; floor?: number; bucketPct?: number },
): number {
  if (pct == null || Number.isNaN(pct) || pct < 0) return opts.unknown;
  const floor = opts.floor ?? 0.02;
  const bucketed = opts.bucketPct && opts.bucketPct > 0
    ? Math.floor(pct / opts.bucketPct) * opts.bucketPct
    : pct;
  return Math.max(floor, Math.min(1, (100 - bucketed) / 100));
}

/**
 * Multiplier that grows as a quota window's reset approaches.
 *   null → 1 · <24h → 1.5 · <72h → 1.2 · else 1
 * Callers that treat an already-passed reset as "stale sweeper data" must
 * check `hoursUntil(...) <= 0` themselves before calling; this function does
 * not special-case the past (it returns 1.5 for a slightly negative delta,
 * matching the historical Cursor behaviour).
 */
export function resetProximityFactor(resetAt: Date | null | undefined, now: Date): number {
  const h = hoursUntil(resetAt, now);
  if (h === null) return 1;
  return h < 24 ? 1.5 : h < 72 ? 1.2 : 1;
}

/**
 * Multiplier that grows as a paid plan's expiry approaches and collapses once
 * it has passed (the account may stop working any moment).
 *   null → 1 · ≤0h → `expired` (default 0.2) · <72h → 1.5 · <168h → 1.2 · else 1
 */
export function expiryProximityFactor(
  expiresAt: Date | null | undefined,
  now: Date,
  opts: { expired?: number } = {},
): number {
  const h = hoursUntil(expiresAt, now);
  if (h === null) return 1;
  if (h <= 0) return opts.expired ?? 0.2;
  return h < 72 ? 1.5 : h < 168 ? 1.2 : 1;
}

/** 5%-wide bucket index of a used-percentage; null stays null. */
export function pctBucket(pct: number | null | undefined, width = 5): number | null {
  return pct == null ? null : Math.floor(pct / width);
}

/** UTC day index of a timestamp; null stays null. */
export function dayBucket(d: Date | null | undefined): number | null {
  return d == null ? null : Math.floor(d.getTime() / 86_400_000);
}

/**
 * Did any scheduling-relevant input cross a bucket boundary? `pcts` are
 * compared by 5% bucket, `dates` by UTC day. A null→value transition counts as
 * a change (first observation should re-project the pool).
 */
export function weightInputsCrossedBucket(
  pcts: ReadonlyArray<readonly [before: number | null | undefined, after: number | null | undefined]>,
  dates: ReadonlyArray<readonly [before: Date | null | undefined, after: Date | null | undefined]>,
): boolean {
  for (const [b, a] of pcts) if (pctBucket(b) !== pctBucket(a)) return true;
  for (const [b, a] of dates) if (dayBucket(b) !== dayBucket(a)) return true;
  return false;
}
