/**
 * Verification budget & authorization policy for `remote-driver-v4` commissioning (`OCV5-749`, R12).
 *
 * Stored in `system_settings['remote_driver_verification_policy']`. Enforces:
 * - Fail-closed profile binding (`profileId`, `accountFingerprint`, `authEpoch`, `policySha256`) for auto runs
 * - Rolling 24h run count ceiling (`maxRunsPerDay`)
 * - PostgreSQL advisory-locked (`pg_advisory_xact_lock`) per-run turn cap, per-run credit cap
 *   (accounting for in-flight journal reservations + worst-case per-turn overrun), and daily credit cap.
 */
import type { Pool } from 'pg'

export const REMOTE_DRIVER_VERIFICATION_POLICY_KEY = 'remote_driver_verification_policy'
const ADVISORY_LOCK_KEY = 'remote-driver-verify-budget'

function need(condition: unknown, code = 'REMOTE_VERIFICATION_POLICY_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

export interface AuthorizedVerificationProfileBinding {
  readonly profileId: string
  readonly driverId: string
  readonly accountFingerprint: string | null
  readonly authEpoch: string | null
  readonly policySha256: string
  readonly authorizedByUid: number
  readonly authorizedAt: string
}

export interface RemoteDriverVerificationPolicy {
  readonly version: 1
  readonly uid: 3
  readonly autoVerifyEnabled: boolean
  readonly effort: 'low'
  readonly maxPaidTurnsPerRun: number
  readonly maxCreditsPerRun: number
  readonly maxCreditsPerDay: number
  readonly maxRunsPerDay: number
  readonly perTurnReservationCredits: number
  readonly perTurnMaxOverrunCredits: number
  readonly allowedCanonicalModels: Readonly<Record<string, string>>
  readonly authorizedProfiles: Readonly<Record<string, AuthorizedVerificationProfileBinding>>
}

export const DEFAULT_VERIFICATION_POLICY: RemoteDriverVerificationPolicy = Object.freeze({
  version: 1,
  uid: 3,
  autoVerifyEnabled: true,
  effort: 'low',
  maxPaidTurnsPerRun: 16,
  maxCreditsPerRun: 500,
  maxCreditsPerDay: 2000,
  maxRunsPerDay: 6,
  perTurnReservationCredits: 20,
  perTurnMaxOverrunCredits: 20,
  allowedCanonicalModels: Object.freeze({
    codex: 'gpt-6-luna-remote',
    cc: 'claude-haiku-5-5-remote',
  }),
  authorizedProfiles: Object.freeze({}),
})

function validatePositiveInt(value: unknown, min: number, max: number, code: string): number {
  const n = typeof value === 'number' ? value : Number.NaN
  need(Number.isSafeInteger(n) && n >= min && n <= max, code)
  return n
}

function validateNonNegativeInt(value: unknown, max: number, code: string): number {
  const n = typeof value === 'number' ? value : Number.NaN
  need(Number.isSafeInteger(n) && n >= 0 && n <= max, code)
  return n
}

function validateBinding(raw: unknown): AuthorizedVerificationProfileBinding {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'REMOTE_VERIFICATION_POLICY_INVALID')
  const r = raw as Record<string, unknown>
  need(
    typeof r.profileId === 'string' && r.profileId.length > 0,
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  need(
    typeof r.driverId === 'string' && r.driverId.length > 0,
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  need(
    r.accountFingerprint === null || typeof r.accountFingerprint === 'string',
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  need(
    r.authEpoch === null || typeof r.authEpoch === 'string',
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  need(
    typeof r.policySha256 === 'string' && /^[a-f0-9]{64}$/.test(r.policySha256),
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  need(
    typeof r.authorizedByUid === 'number' && Number.isSafeInteger(r.authorizedByUid),
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  need(
    typeof r.authorizedAt === 'string' && r.authorizedAt.length > 0,
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  return {
    profileId: r.profileId,
    driverId: r.driverId,
    accountFingerprint: r.accountFingerprint,
    authEpoch: r.authEpoch,
    policySha256: r.policySha256,
    authorizedByUid: r.authorizedByUid,
    authorizedAt: r.authorizedAt,
  }
}

export function normalizeVerificationPolicy(raw: unknown): RemoteDriverVerificationPolicy {
  if (raw === undefined || raw === null) {
    return DEFAULT_VERIFICATION_POLICY
  }
  need(typeof raw === 'object' && !Array.isArray(raw), 'REMOTE_VERIFICATION_POLICY_INVALID')
  const r = raw as Record<string, unknown>
  if (r.version !== undefined) need(r.version === 1, 'REMOTE_VERIFICATION_POLICY_INVALID')
  if (r.uid !== undefined) need(r.uid === 3, 'REMOTE_VERIFICATION_POLICY_INVALID')
  if (r.effort !== undefined) need(r.effort === 'low', 'REMOTE_VERIFICATION_POLICY_INVALID')

  const autoVerifyEnabled =
    r.autoVerifyEnabled === undefined
      ? DEFAULT_VERIFICATION_POLICY.autoVerifyEnabled
      : Boolean(r.autoVerifyEnabled)
  if (r.autoVerifyEnabled !== undefined) {
    need(typeof r.autoVerifyEnabled === 'boolean', 'REMOTE_VERIFICATION_POLICY_INVALID')
  }

  const maxPaidTurnsPerRun = validatePositiveInt(
    r.maxPaidTurnsPerRun ?? DEFAULT_VERIFICATION_POLICY.maxPaidTurnsPerRun,
    1,
    200,
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  const maxCreditsPerRun = validatePositiveInt(
    r.maxCreditsPerRun ?? DEFAULT_VERIFICATION_POLICY.maxCreditsPerRun,
    1,
    100_000,
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  const maxCreditsPerDay = validatePositiveInt(
    r.maxCreditsPerDay ?? DEFAULT_VERIFICATION_POLICY.maxCreditsPerDay,
    maxCreditsPerRun,
    1_000_000,
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  const maxRunsPerDay = validatePositiveInt(
    r.maxRunsPerDay ?? DEFAULT_VERIFICATION_POLICY.maxRunsPerDay,
    1,
    200,
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  const perTurnReservationCredits = validatePositiveInt(
    r.perTurnReservationCredits ?? DEFAULT_VERIFICATION_POLICY.perTurnReservationCredits,
    1,
    maxCreditsPerRun,
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )
  const perTurnMaxOverrunCredits = validateNonNegativeInt(
    r.perTurnMaxOverrunCredits ?? DEFAULT_VERIFICATION_POLICY.perTurnMaxOverrunCredits,
    Math.max(0, maxCreditsPerRun - 1),
    'REMOTE_VERIFICATION_POLICY_INVALID',
  )

  const allowedCanonicalModels: Record<string, string> = {
    ...DEFAULT_VERIFICATION_POLICY.allowedCanonicalModels,
  }
  if (r.allowedCanonicalModels !== undefined) {
    need(
      r.allowedCanonicalModels &&
        typeof r.allowedCanonicalModels === 'object' &&
        !Array.isArray(r.allowedCanonicalModels),
      'REMOTE_VERIFICATION_POLICY_INVALID',
    )
    for (const [k, v] of Object.entries(r.allowedCanonicalModels as Record<string, unknown>)) {
      need(
        typeof k === 'string' && k.length > 0 && typeof v === 'string' && v.length > 0,
        'REMOTE_VERIFICATION_POLICY_INVALID',
      )
      allowedCanonicalModels[k] = v
    }
  }

  const authorizedProfiles: Record<string, AuthorizedVerificationProfileBinding> = {}
  if (r.authorizedProfiles !== undefined) {
    need(
      r.authorizedProfiles &&
        typeof r.authorizedProfiles === 'object' &&
        !Array.isArray(r.authorizedProfiles),
      'REMOTE_VERIFICATION_POLICY_INVALID',
    )
    for (const [k, v] of Object.entries(r.authorizedProfiles as Record<string, unknown>)) {
      const parsed = validateBinding(v)
      need(parsed.profileId === k, 'REMOTE_VERIFICATION_POLICY_INVALID')
      authorizedProfiles[k] = parsed
    }
  }

  return Object.freeze({
    version: 1,
    uid: 3,
    autoVerifyEnabled,
    effort: 'low',
    maxPaidTurnsPerRun,
    maxCreditsPerRun,
    maxCreditsPerDay,
    maxRunsPerDay,
    perTurnReservationCredits,
    perTurnMaxOverrunCredits,
    allowedCanonicalModels: Object.freeze(allowedCanonicalModels),
    authorizedProfiles: Object.freeze(authorizedProfiles),
  })
}

export async function loadVerificationPolicy(pool: Pool): Promise<RemoteDriverVerificationPolicy> {
  const res = await pool.query<{ value: unknown }>(
    'SELECT value FROM system_settings WHERE key = $1 LIMIT 1',
    [REMOTE_DRIVER_VERIFICATION_POLICY_KEY],
  )
  if (res.rows.length === 0) {
    return DEFAULT_VERIFICATION_POLICY
  }
  return normalizeVerificationPolicy(res.rows[0]!.value)
}

export async function upsertVerificationPolicy(
  pool: Pool,
  patch: Partial<Omit<RemoteDriverVerificationPolicy, 'version' | 'uid'>>,
  updatedByUid = 3,
): Promise<RemoteDriverVerificationPolicy> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ADVISORY_LOCK_KEY])
    const existingRes = await client.query<{ value: unknown }>(
      'SELECT value FROM system_settings WHERE key = $1 FOR UPDATE',
      [REMOTE_DRIVER_VERIFICATION_POLICY_KEY],
    )
    const current =
      existingRes.rows.length > 0
        ? normalizeVerificationPolicy(existingRes.rows[0]!.value)
        : DEFAULT_VERIFICATION_POLICY
    const merged = normalizeVerificationPolicy({
      ...current,
      ...patch,
      allowedCanonicalModels: {
        ...current.allowedCanonicalModels,
        ...(patch.allowedCanonicalModels ?? {}),
      },
      authorizedProfiles: {
        ...current.authorizedProfiles,
        ...(patch.authorizedProfiles ?? {}),
      },
    })
    await client.query(
      `INSERT INTO system_settings (key, value, description, updated_at, updated_by)
       VALUES ($1, $2::jsonb, $3, NOW(), $4)
       ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value,
              description = EXCLUDED.description,
              updated_at = NOW(),
              updated_by = EXCLUDED.updated_by`,
      [
        REMOTE_DRIVER_VERIFICATION_POLICY_KEY,
        JSON.stringify(merged),
        'OCV5-749 R12 remote driver commissioning & drift verification budget/authorization policy',
        updatedByUid,
      ],
    )
    await client.query('COMMIT')
    return merged
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function authorizeProfileInVerificationPolicy(
  pool: Pool,
  binding: AuthorizedVerificationProfileBinding,
): Promise<RemoteDriverVerificationPolicy> {
  const validated = validateBinding(binding)
  return await upsertVerificationPolicy(
    pool,
    {
      authorizedProfiles: {
        [validated.profileId]: validated,
      },
    },
    validated.authorizedByUid,
  )
}

export async function assertVerificationRunAuthorized(
  pool: Pool,
  runId: string,
  options?: { readonly allowManualUnbound?: boolean },
): Promise<{
  readonly policy: RemoteDriverVerificationPolicy
  readonly canonicalModel: string
}> {
  const policy = await loadVerificationPolicy(pool)
  const runRes = await pool.query<Record<string, any>>(
    `SELECT r.id, r.profile_id, r.driver_id, r.auto_eligible, r.state,
            p.account_fingerprint, p.auth_epoch,
            p.execution_manifest->>'policySha256' AS manifest_policy_sha256
       FROM remote_driver_verification_runs r
       JOIN remote_agent_profiles p ON p.id = r.profile_id
      WHERE r.id = $1`,
    [runId],
  )
  need(runRes.rows.length === 1, 'REMOTE_VERIFICATION_RUN_NOT_FOUND')
  const row = runRes.rows[0]!

  const driverId = String(row.driver_id)
  const canonicalModel = policy.allowedCanonicalModels[driverId]
  need(
    typeof canonicalModel === 'string' && canonicalModel.length > 0,
    'REMOTE_VERIFICATION_MODEL_NOT_ALLOWED',
  )

  const requireBoundProfile = !options?.allowManualUnbound
  if (requireBoundProfile) {
    const profileId = String(row.profile_id)
    const bound = policy.authorizedProfiles[profileId]
    need(bound !== undefined, 'REMOTE_VERIFICATION_PROFILE_NOT_AUTHORIZED')
    const actualFingerprint = row.account_fingerprint ? String(row.account_fingerprint) : null
    const actualAuthEpoch = row.auth_epoch ? String(row.auth_epoch) : null
    const actualPolicySha = row.manifest_policy_sha256 ? String(row.manifest_policy_sha256) : ''
    need(
      bound.driverId === driverId &&
        bound.accountFingerprint === actualFingerprint &&
        bound.authEpoch === actualAuthEpoch &&
        bound.policySha256 === actualPolicySha,
      'REMOTE_VERIFICATION_PROFILE_NOT_AUTHORIZED',
    )
  }

  const dailyCountRes = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
       FROM remote_driver_verification_runs
      WHERE id <> $1
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND state IN ('running', 'passed', 'failed')`,
    [runId],
  )
  const dailyRuns = Number(dailyCountRes.rows[0]?.cnt ?? 0)
  need(dailyRuns < policy.maxRunsPerDay, 'REMOTE_VERIFICATION_DAILY_RUN_CAP_EXCEEDED')

  return { policy, canonicalModel }
}

export async function admitVerificationTurnBudget(
  pool: Pool,
  input: { readonly runId: string; readonly requestId: string; readonly reserveCredits?: number },
): Promise<{
  readonly settledRunCredits: number
  readonly inflightReservedCredits: number
  readonly paidTurnsSoFar: number
}> {
  const policy = await loadVerificationPolicy(pool)
  const reserveCredits =
    input.reserveCredits === undefined
      ? policy.perTurnReservationCredits
      : validatePositiveInt(
          input.reserveCredits,
          1,
          policy.maxCreditsPerRun,
          'REMOTE_VERIFICATION_POLICY_INVALID',
        )
  const runPrefix = `rdv-${input.runId}-%`
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ADVISORY_LOCK_KEY])

    const turnsRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM turn_dispatches
        WHERE billing_request_id LIKE $1`,
      [runPrefix],
    )
    const paidTurnsSoFar = Number(turnsRes.rows[0]?.cnt ?? 0)
    need(paidTurnsSoFar < policy.maxPaidTurnsPerRun, 'REMOTE_VERIFICATION_TURN_CAP_EXCEEDED')

    const runUsageRes = await client.query<{ settled: string }>(
      `SELECT COALESCE(SUM(cost_credits), 0)::text AS settled
         FROM usage_records
        WHERE request_id LIKE $1`,
      [runPrefix],
    )
    const settledRunCredits = Number(runUsageRes.rows[0]?.settled ?? 0)

    const runInflightRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM request_finalize_journal
        WHERE request_id LIKE $1
          AND state IN ('inflight', 'finalizing')`,
      [runPrefix],
    )
    const inflightReservedCredits = Number(runInflightRes.rows[0]?.cnt ?? 0) * reserveCredits

    need(
      settledRunCredits + inflightReservedCredits + reserveCredits <=
        policy.maxCreditsPerRun - policy.perTurnMaxOverrunCredits,
      'REMOTE_VERIFICATION_RUN_BUDGET_EXCEEDED',
    )

    const dayUsageRes = await client.query<{ settled: string }>(
      `SELECT COALESCE(SUM(cost_credits), 0)::text AS settled
         FROM usage_records
        WHERE request_id LIKE 'rdv-%'
          AND created_at >= NOW() - INTERVAL '24 hours'`,
    )
    const daySettled = Number(dayUsageRes.rows[0]?.settled ?? 0)

    const dayInflightRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM request_finalize_journal
        WHERE request_id LIKE 'rdv-%'
          AND state IN ('inflight', 'finalizing')`,
    )
    const dayInflight = Number(dayInflightRes.rows[0]?.cnt ?? 0) * reserveCredits

    need(
      daySettled + dayInflight + reserveCredits <= policy.maxCreditsPerDay,
      'REMOTE_VERIFICATION_DAILY_BUDGET_EXCEEDED',
    )

    await client.query('COMMIT')
    return { settledRunCredits, inflightReservedCredits, paidTurnsSoFar }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
