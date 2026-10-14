/**
 * TODO(OCV5-424): INTERIM account selection + outcome reporting for the
 * Antigravity gemini OAuth pool. Delete this file when the shared pool policy
 * (account-pool/policy/: classifyHttpOutcome + decide + rankWRH + registry
 * recovery actor) lands; register gemini_oauth_accounts there with
 * probe = "refresh succeeds". Agreed with the OCV5-424 session 2026-10-14.
 *
 * Until then this mirrors policy/decide.ts DEFAULT_POLICY numbers exactly and
 * keeps the same invariants:
 *   - never writes status='disabled' (that is admin intent only);
 *   - every automatic state is a cooldown with an expiry, so nothing needs a
 *     human: an expired cooldown is selectable again (half-open) and the next
 *     result decides. No timer or actor of its own.
 *   - a 429 cools the account; the request is NOT retried on another account
 *     in-flight (anti-ban rule from http/proxy/core.ts).
 */
import type { Pool } from "pg";
import { getPool } from "../db/index.js";

export type AntigravityPoolOutcome =
  | { kind: "success" }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "quota_exhausted"; resetAt: Date | null }
  | { kind: "auth_invalid" }
  | { kind: "upstream_error" }
  | { kind: "network" }
  | { kind: "client_error" };

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** DEFAULT_POLICY (OCV5-424 policy/decide.ts). */
export const ANTIGRAVITY_INTERIM_POLICY = {
  rateLimitMinMs: 15 * SEC,
  rateLimitMaxMs: 15 * MIN,
  rateLimitBaseMs: 30 * SEC,
  quotaDefaultMs: 1 * HOUR,
  quotaMaxMs: 7 * 24 * HOUR,
  authBaseMs: 5 * MIN,
  authMaxMs: 6 * HOUR,
  upstreamBaseMs: 10 * MIN,
  upstreamMaxMs: 1 * HOUR,
  upstreamStrikePenalty: 20,
  upstreamCooldownHealth: 40,
  successBonus: 10,
  halfOpenHealth: 50,
} as const;

function backoff(base: number, level: number, max: number): number {
  return Math.min(max, base * 2 ** Math.min(level, 20));
}

/** Parse Retry-After (seconds or HTTP-date). */
export function parseRetryAfterMs(value: string | string[] | undefined, now: number): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * SEC;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Cloud Code upstream status → pool outcome. */
export function classifyAntigravityUpstream(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  now: number,
): AntigravityPoolOutcome {
  if (status < 400) return { kind: "success" };
  if (status === 429) return { kind: "rate_limited", retryAfterMs: parseRetryAfterMs(headers["retry-after"], now) };
  // 401 dead token; 403 PERMISSION_DENIED / VALIDATION_REQUIRED is account-level.
  if (status === 401 || status === 403) return { kind: "auth_invalid" };
  if (status >= 500) return { kind: "upstream_error" };
  return { kind: "client_error" };
}

export interface AntigravityInterimTransition {
  status: "active" | "cooldown";
  cooldownUntil: Date | null;
  cooldownReason: "rate_limited" | "quota" | "auth" | "upstream" | null;
  backoffLevel: number;
  healthScore: number;
  success: boolean;
}

/** Pure transition (unit-tested). `null` = no state change. */
export function decideAntigravityInterim(
  state: { healthScore: number; backoffLevel: number; status: string },
  outcome: AntigravityPoolOutcome,
  now: number,
): AntigravityInterimTransition | null {
  const p = ANTIGRAVITY_INTERIM_POLICY;
  const level = state.backoffLevel;
  const cooldown = (ms: number, reason: AntigravityInterimTransition["cooldownReason"], health = state.healthScore) => ({
    status: "cooldown" as const,
    cooldownUntil: new Date(now + ms),
    cooldownReason: reason,
    backoffLevel: level + 1,
    healthScore: health,
    success: false,
  });
  switch (outcome.kind) {
    case "success":
      return {
        status: "active",
        cooldownUntil: null,
        cooldownReason: null,
        backoffLevel: 0,
        // An expired cooldown is half-open: it restarts from halfOpenHealth.
        healthScore: Math.min(100, (state.status === "cooldown" ? p.halfOpenHealth : state.healthScore) + p.successBonus),
        success: true,
      };
    case "rate_limited": {
      const ms = outcome.retryAfterMs !== null
        ? Math.min(p.rateLimitMaxMs, Math.max(p.rateLimitMinMs, outcome.retryAfterMs))
        : backoff(p.rateLimitBaseMs, level, p.rateLimitMaxMs);
      return cooldown(ms, "rate_limited");
    }
    case "quota_exhausted": {
      const ms = outcome.resetAt
        ? Math.min(p.quotaMaxMs, Math.max(p.rateLimitMinMs, outcome.resetAt.getTime() - now))
        : p.quotaDefaultMs;
      return cooldown(ms, "quota");
    }
    case "auth_invalid":
      return cooldown(backoff(p.authBaseMs, level, p.authMaxMs), "auth");
    case "upstream_error": {
      const health = Math.max(0, state.healthScore - p.upstreamStrikePenalty);
      if (health > p.upstreamCooldownHealth) {
        return { status: "active", cooldownUntil: null, cooldownReason: null, backoffLevel: level, healthScore: health, success: false };
      }
      return cooldown(backoff(p.upstreamBaseMs, level, p.upstreamMaxMs), "upstream", health);
    }
    case "network":
    case "client_error":
      return null;
  }
}

export interface AntigravityAccountPick {
  accountId: bigint;
  email: string;
}

/** Healthiest selectable account; expired cooldowns are half-open. */
export async function pickAntigravityAccount(
  deps: { pool?: Pick<Pool, "query"> } = {},
): Promise<AntigravityAccountPick | null> {
  const res = await (deps.pool ?? getPool()).query<{ id: string; email: string }>(
    `SELECT id::text AS id, email FROM gemini_oauth_accounts
      WHERE disabled_by IS NULL
        AND (status = 'active' OR (status = 'cooldown' AND cooldown_until <= NOW()))
      ORDER BY (status = 'active') DESC, health_score DESC, last_used_at ASC NULLS FIRST, id ASC
      LIMIT 1`,
  );
  const row = res.rows[0];
  return row ? { accountId: BigInt(row.id), email: row.email } : null;
}

/** Apply an outcome to the row (read-modify-write under a row lock). */
export async function reportAntigravityOutcome(
  accountId: bigint,
  outcome: AntigravityPoolOutcome,
  detail: string | null,
  deps: { pool?: Pick<Pool, "query">; now?: () => number } = {},
): Promise<void> {
  const pool = deps.pool ?? getPool();
  const now = (deps.now ?? Date.now)();
  const cur = await pool.query<{ status: string; health_score: number; backoff_level: number; disabled_by: string | null }>(
    "SELECT status, health_score, backoff_level, disabled_by FROM gemini_oauth_accounts WHERE id = $1",
    [accountId.toString()],
  );
  const row = cur.rows[0];
  if (!row || row.disabled_by !== null) return;
  const next = decideAntigravityInterim(
    { healthScore: row.health_score, backoffLevel: row.backoff_level, status: row.status },
    outcome,
    now,
  );
  if (next === null) return;
  await pool.query(
    `UPDATE gemini_oauth_accounts SET
       status = $2, cooldown_until = $3, cooldown_reason = $4, backoff_level = $5,
       health_score = $6,
       success_count = success_count + CASE WHEN $7 THEN 1 ELSE 0 END,
       fail_count = fail_count + CASE WHEN $7 THEN 0 ELSE 1 END,
       last_error = CASE WHEN $7 THEN NULL ELSE $8 END,
       -- a dead token must not be reused from the cache
       access_expires_at = CASE WHEN $4 = 'auth' THEN NOW() ELSE access_expires_at END,
       last_used_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND disabled_by IS NULL`,
    [accountId.toString(), next.status, next.cooldownUntil, next.cooldownReason,
      next.backoffLevel, next.healthScore, next.success, detail?.slice(0, 200) ?? null],
  );
}
