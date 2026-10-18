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
import { ANTIGRAVITY_AUX_UPSTREAM_MODELS, antigravityAllowedUpstreamModels } from '@openclaude/protocol'
import type { AntigravityModelAvailability } from './antigravityQuota.js'
import { getPool } from '../db/index.js'
import { query } from '../db/queries.js'
import type { PoolOutcome } from './policy/outcome.js'
import { GEMINI_OAUTH_MEMBERS, applyTableMemberOutcome } from './policy/tableMembers.js'
import {
  affinitySettings,
  inflightCount,
  reserveInflight,
  resolveAffinity,
  underRateCap,
  type AffinityAction,
} from './policy/affinity.js'
import { healthWeight } from './policy/select.js'

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


/** Only known paid tiers are ranked; the 'lite' spelling still denotes Ultra. */
export function isAntigravityUltra(tier: string | null | undefined): boolean {
  return tier === 'g1-ultra-tier' || tier === 'g1-ultra-lite-tier'
}

export function antigravityAccountSupportsModel(models: AntigravityModelAvailability | null | undefined, modelId: string, now: number): boolean {
  // Preserve existing legacy accounts until their first background refresh.
  // Newly introduced Claude 5.5 must have affirmative directory evidence.
  if (!models) return !/^antigravity-claude-.*-5\.5$/.test(modelId)
  let ids = antigravityAllowedUpstreamModels(modelId).filter((id) => !(ANTIGRAVITY_AUX_UPSTREAM_MODELS as readonly string[]).includes(id))
  if (modelId === 'antigravity-gemini-3.8-flash' && models['gemini-3.8-flash-tiered']) ids = ['gemini-3.8-flash-tiered']
  if (ids.length === 0) return false
  return ids.every((id) => {
    const q = models[id]
    if (!q) return false
    if (q.remainingFraction !== 0) return true
    const reset = q.resetTime === null ? NaN : Date.parse(q.resetTime)
    return Number.isFinite(reset) && reset <= now
  })
}

export interface AntigravityAccountPick {
  accountId: bigint
  email: string
  /** How user affinity chose it (absent without a userId). */
  affinity?: AffinityAction
}

/** Affinity key of the Antigravity subscription pool (one binding per user). */
export const ANTIGRAVITY_AFFINITY_SERVICE = 'antigravity'

/**
 * Account for this turn. Selectable = active, or an expired rate-limit/quota/
 * upstream cooldown (half-open); an auth/credential cooldown waits for the
 * recovery probe. `skip` drops accounts on which the turn's model is cooling.
 *
 * With a userId the shared user affinity decides (docs/ocv5-424-user-affinity.md):
 * the user's bound account when selectable; another one for this turn only when
 * it is temporarily out (this model cooling, short cooldown); a rebind when it is
 * persistently out; new users go to the account with the fewest bound users.
 * Without a userId: healthiest, then least recently used (legacy order).
 */
export async function pickAntigravityAccount(
  deps: {
    pool?: Pick<Pool, 'query'>
    skip?: (accountId: bigint) => Promise<boolean>
    userId?: bigint | null
    modelId?: string
    /**
     * Reserve an in-flight unit for this turn under this token (the requestId) as
     * part of the pick, with no await between the cap check and the reservation.
     * The caller releases it with releaseInflight(token) if the turn is not admitted;
     * settlement releases it otherwise.
     */
    reserveToken?: string
  } = {},
): Promise<AntigravityAccountPick | null> {
  const res = await (deps.pool ?? getPool()).query<{
    id: string
    email: string
    health_score: number
    last_used_at: Date | null
    paid_tier: string | null
    status: string
    available_models: AntigravityModelAvailability | null
  }>(
    `SELECT id::text AS id, email, health_score, last_used_at, paid_tier, status, available_models FROM gemini_oauth_accounts
      WHERE disabled_by IS NULL
        AND (status = 'active'
             OR (status = 'cooldown' AND cooldown_until <= NOW()
                 AND cooldown_reason IN ('rate_limited', 'quota', 'upstream')))
      ORDER BY (status = 'active') DESC, health_score DESC, last_used_at ASC NULLS FIRST, id ASC`,
  )
  const usable: typeof res.rows = []
  for (const row of res.rows) {
    if (deps.modelId && !antigravityAccountSupportsModel(row.available_models, deps.modelId, Date.now())) continue
    if (deps.skip && (await deps.skip(BigInt(row.id)))) continue
    usable.push(row)
  }
  if (usable.length === 0) return null
  const tier = (r: typeof usable[number]): number => r.status === 'cooldown' ? 2 : isAntigravityUltra(r.paid_tier) ? 0 : 1
  usable.sort((a, b) => tier(a) - tier(b))
  if (deps.userId === undefined || deps.userId === null) {
    return { accountId: BigInt(usable[0].id), email: usable[0].email }
  }
  // Per-account caps (docs §6): an account at its in-flight or per-minute cap is
  // left out for this turn only (spill); when every account is capped, use them anyway.
  const caps = await affinitySettings()
  const open = usable.filter(
    (r) =>
      inflightCount(ANTIGRAVITY_AFFINITY_SERVICE, r.id) < caps.antigravityInflight &&
      underRateCap(ANTIGRAVITY_AFFINITY_SERVICE, r.id, caps.antigravityRatePerMin),
  )
  const uncapped = open.length > 0 ? open : usable
  const bestTier = Math.min(...uncapped.map(tier))
  const candidates = uncapped.filter((r) => tier(r) === bestTier)
  let resolved: Awaited<ReturnType<typeof resolveAffinity>> = null
  try {
    resolved = await resolveAffinity({
      service: ANTIGRAVITY_AFFINITY_SERVICE,
      userId: deps.userId,
      candidates: candidates.map((r) => ({
        memberKind: 'account' as const,
        id: r.id,
        capacity: healthWeight(r.health_score),
        lastUsedAt: r.last_used_at,
      })),
      maxUsers: caps.maxUsersPerSubscription,
      boundState: async (b) => {
        const st = await (deps.pool ?? getPool()).query<{
          status: string
          cooldown_reason: string | null
          cooldown_until: Date | null
        }>(
          'SELECT status, cooldown_reason, cooldown_until FROM gemini_oauth_accounts WHERE id = $1',
          [b.memberId],
        )
        const row = st.rows[0]
        return row
          ? {
              status: row.status,
              cooldownReason: row.cooldown_reason,
              cooldownUntil: row.cooldown_until,
            }
          : { status: null, cooldownReason: null, cooldownUntil: null }
      },
    })
  } catch {
    // Affinity is best-effort: the store failing must not block a turn (legacy order serves).
    resolved = null
  }
  const preferred = resolved ? candidates.find((r) => r.id === resolved!.member.id) ?? candidates[0] : candidates[0]
  let row = preferred
  if (deps.reserveToken) {
    // Atomic check-and-reserve: a concurrent turn may have filled the preferred
    // account since the filter above; then this turn spills to the least busy one.
    // Order over every usable account (not only the ones that passed the cap
    // filter before the awaits above): capacity freed meanwhile is seen here.
    const order = [preferred.id, ...usable.filter((r) => r.id !== preferred.id)
      .sort((a, b) => tier(a) - tier(b) || inflightCount(ANTIGRAVITY_AFFINITY_SERVICE, a.id) - inflightCount(ANTIGRAVITY_AFFINITY_SERVICE, b.id))
      .map((r) => r.id)]
    const id = reserveInflight(
      ANTIGRAVITY_AFFINITY_SERVICE,
      order,
      deps.reserveToken,
      caps.antigravityInflight,
      Date.now(),
      caps.antigravityRatePerMin,
    )
    row = usable.find((r) => r.id === id) ?? preferred
  }
  const action: AffinityAction | undefined = resolved ? (row.id === resolved.member.id ? resolved.action : 'spill') : undefined
  return { accountId: BigInt(row.id), email: row.email, ...(action ? { affinity: action } : {}) }
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
