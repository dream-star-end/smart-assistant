/**
 * OCV5-424 — the gemini pool's scheduling for Antigravity Google AI
 * subscription accounts (gemini_oauth_accounts, OCV5-415). Replaces the
 * interim copy of the policy: account-level outcomes now go through the shared
 * pool policy (policy/decide via policy/tableMembers), and recovery from an
 * auth cooldown is the shared recovery actor's probe (geminiPoolAdapter:
 * the stored grant still refreshes), not the next turn.
 *
 * Invariants (same for every pool):
 *   - never writes status='disabled' (admin intent only, disabled_by='admin');
 *   - every automatic state is a cooldown that expires or is probed, so nothing
 *     needs a human;
 *   - a 429 cools the account; the request is NOT retried on another account
 *     in-flight (anti-ban rule from http/proxy/core.ts).
 * A 5xx on a generate call is the model's, not the account's: it only moves
 * counters here and cools that model on that account in Redis
 * (antigravityModelCooldown.ts).
 */
import type { Pool } from 'pg'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import type { PoolOutcome } from './policy/outcome.js'
import { GEMINI_OAUTH_MEMBERS, applyTableMemberOutcome } from './policy/tableMembers.js'

export type AntigravityPoolOutcome =
  | { kind: 'success' }
  | { kind: 'rate_limited'; retryAfterMs: number | null }
  | { kind: 'quota_exhausted'; resetAt: Date | null }
  | { kind: 'auth_invalid' }
  | { kind: 'upstream_error' }
  /** 5xx on a generate call: the model, not the account (antigravityModelCooldown). */
  | { kind: 'model_unavailable' }
  | { kind: 'network' }
  | { kind: 'client_error' }

const SEC = 1000

/** Parse Retry-After (seconds or HTTP-date). */
export function parseRetryAfterMs(
  value: string | string[] | undefined,
  now: number,
): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return null
  const trimmed = raw.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * SEC
  const date = Date.parse(trimmed)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

/** Cloud Code upstream status → pool outcome. */
export function classifyAntigravityUpstream(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  now: number,
): AntigravityPoolOutcome {
  if (status < 400) return { kind: 'success' }
  if (status === 429)
    return { kind: 'rate_limited', retryAfterMs: parseRetryAfterMs(headers['retry-after'], now) }
  // 401 dead token; 403 PERMISSION_DENIED / VALIDATION_REQUIRED is account-level.
  if (status === 401 || status === 403) return { kind: 'auth_invalid' }
  if (status >= 500) return { kind: 'upstream_error' }
  return { kind: 'client_error' }
}

export interface AntigravityAccountPick {
  accountId: bigint
  email: string
}

/**
 * Healthiest selectable account: active first, then health, then the least
 * recently used. An expired rate-limit/quota/upstream cooldown is half-open;
 * an auth/credential cooldown waits for the recovery probe (a turn would only
 * fail again on a dead grant). `skip` drops accounts on which the turn's model
 * is cooling down.
 */
export async function pickAntigravityAccount(
  deps: {
    pool?: Pick<Pool, 'query'>
    skip?: (accountId: bigint) => Promise<boolean>
  } = {},
): Promise<AntigravityAccountPick | null> {
  const res = await (deps.pool ?? getPool()).query<{ id: string; email: string }>(
    `SELECT id::text AS id, email FROM gemini_oauth_accounts
      WHERE disabled_by IS NULL
        AND (status = 'active'
             OR (status = 'cooldown' AND cooldown_until <= NOW()
                 AND cooldown_reason IN ('rate_limited', 'quota', 'upstream')))
      ORDER BY (status = 'active') DESC, health_score DESC, last_used_at ASC NULLS FIRST, id ASC`,
  )
  for (const row of res.rows) {
    const accountId = BigInt(row.id)
    if (deps.skip && (await deps.skip(accountId))) continue
    return { accountId, email: row.email }
  }
  return null
}

/** Map an Antigravity outcome to the shared pool outcome (model_unavailable excluded). */
export function toPoolOutcome(
  outcome: Exclude<AntigravityPoolOutcome, { kind: 'model_unavailable' }>,
  detail: string | null,
): PoolOutcome {
  switch (outcome.kind) {
    case 'success':
      return { kind: 'success' }
    case 'rate_limited':
      return { kind: 'rate_limited', retryAfterMs: outcome.retryAfterMs }
    case 'quota_exhausted':
      return { kind: 'quota_exhausted', resetAt: outcome.resetAt }
    case 'auth_invalid':
      return { kind: 'auth_invalid', detail }
    case 'upstream_error':
      return { kind: 'upstream_error', detail }
    case 'network':
      return { kind: 'network', detail }
    case 'client_error':
      return { kind: 'client_error', detail }
  }
}

/**
 * Apply a turn's outcome to the account. Account-level outcomes use the shared
 * policy; a model 5xx only counts (its cooldown is per model, in Redis).
 */
export async function reportAntigravityOutcome(
  accountId: bigint,
  outcome: AntigravityPoolOutcome,
  detail: string | null,
  deps: { pool?: Pick<Pool, 'query'> } = {},
): Promise<void> {
  const id = accountId.toString()
  const msg = detail?.slice(0, 200) ?? null
  if (outcome.kind === 'model_unavailable') {
    await (deps.pool ?? getPool()).query(
      `UPDATE gemini_oauth_accounts SET fail_count = fail_count + 1, last_error = $2,
         last_used_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND disabled_by IS NULL`,
      [id, msg],
    )
    return
  }
  const changed = await applyTableMemberOutcome(
    GEMINI_OAUTH_MEMBERS,
    id,
    toPoolOutcome(outcome, msg),
    outcome.kind === 'success' ? null : msg,
  )
  if (changed && outcome.kind === 'auth_invalid') {
    // A dead grant must not be served from the token cache; the recovery probe refreshes it.
    await query(
      `UPDATE gemini_oauth_accounts SET access_expires_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND cooldown_reason = 'auth'`,
      [id],
    )
  }
}
