/** Durable circuit for exact static-provider subscription quota exhaustion. */

import { query, type QueryRunner } from "../db/queries.js";

const DEFAULT_RECHECK_MS = 30 * 60_000;
export const PROVIDER_QUOTA_PROBE_LEASE_MS = 60_000;
let testRunner: QueryRunner | undefined;

function runQuery(
  sql: string,
  params: unknown[],
  runner?: QueryRunner,
) {
  return query(sql, params, runner ?? testRunner);
}

function configuredRecheckMs(): number {
  const raw = Number(process.env.OC_PROVIDER_QUOTA_RECHECK_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? Math.floor(raw) : DEFAULT_RECHECK_MS;
}

/** Match only Moonshot's documented billing-cycle quota rejection. */
export function isMoonshotBillingQuotaExhausted(status: number, preview: string): boolean {
  if (status !== 403) return false;
  const normalized = preview.replace(/[’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  return normalized.includes("you've reached your usage limit for this billing cycle");
}

/** Retry-After accepts delta-seconds or an HTTP date. Past/invalid values use the configured poll. */
export function providerQuotaRetryAt(headers: Headers, now = Date.now()): Date {
  const raw = headers.get("retry-after")?.trim();
  if (raw) {
    const seconds = Number(raw);
    const at = Number.isFinite(seconds) ? now + seconds * 1_000 : Date.parse(raw);
    if (Number.isFinite(at) && at > now) return new Date(at);
  }
  return new Date(now + configuredRecheckMs());
}

export async function markProviderQuotaExhausted(
  providerId: string,
  retryAt: Date,
  runner?: QueryRunner,
): Promise<void> {
  await runQuery(
    `INSERT INTO provider_quota_blocks (provider_id, detected_at, retry_at, probe_lease_until)
     VALUES ($1, now(), $2, NULL)
     ON CONFLICT (provider_id) DO UPDATE
       SET detected_at=EXCLUDED.detected_at,
           retry_at=EXCLUDED.retry_at,
           probe_lease_until=NULL`,
    [providerId, retryAt],
    runner,
  );
}

/** Only one request may probe after retry_at; concurrent claimers lose atomically. */
export async function claimProviderQuotaProbe(
  providerId: string,
  now = Date.now(),
  runner?: QueryRunner,
): Promise<boolean> {
  const at = new Date(now);
  const leaseUntil = new Date(now + PROVIDER_QUOTA_PROBE_LEASE_MS);
  const result = await runQuery(
    `UPDATE provider_quota_blocks
        SET probe_lease_until=$3
      WHERE provider_id=$1
        AND retry_at <= $2
        AND (probe_lease_until IS NULL OR probe_lease_until <= $2)
      RETURNING provider_id`,
    [providerId, at, leaseUntil],
    runner,
  );
  return (result.rowCount ?? result.rows.length) === 1;
}

export async function clearProviderQuotaBlock(
  providerId: string,
  runner?: QueryRunner,
): Promise<void> {
  await runQuery(`DELETE FROM provider_quota_blocks WHERE provider_id=$1`, [providerId], runner);
}

/** Test seam for core-path tests; production never sets this. */
export function _setProviderQuotaRunnerForTest(runner?: QueryRunner): void {
  testRunner = runner;
}
