/**
 * OCV5-890 Wave 2 — Phase 3 Legacy Remote Track Retirement Gate & Read-Only Billing Shell.
 *
 * Governs safe retirement of the legacy remote execution tracks (`codex-app-server-v1`,
 * `cc5-interactive-v1`) and their historical billing recovery versions once all traffic
 * has converged onto the unified three-layer inference pool.
 *
 * Hard architecture invariants:
 * - Strictly READ-ONLY SQL (`SELECT` only — ZERO DML writes to billing tables!).
 * - Zero environment-variable reads, zero network I/O, zero forbidden crypto,
 *   zero engine/provider literal special cases.
 */
import type { PgQueryable } from '../../db/threeLayerStateStore.js'

export const LEGACY_REMOTE_BACKEND_KINDS = [
  'codex-app-server-v1',
  'cc5-interactive-v1',
] as const
export type LegacyRemoteBackendKind = (typeof LEGACY_REMOTE_BACKEND_KINDS)[number]

export const LEGACY_BILLING_RECOVERY_VERSIONS = [
  'cc5-native-v1',
  'remote-native-v1',
  'remote-native-v2',
  'codex-remote-v1',
] as const
export type LegacyBillingRecoveryVersion = (typeof LEGACY_BILLING_RECOVERY_VERSIONS)[number]

/**
 * Shared read-only predicate matching every historical legacy remote billing journal shape
 * (real CC5/Codex writer `{ remoteNativeBillingRecovery: 'cc5-native-v1' | 'remote-native-v2',
 * remoteNative: { scope: { backendKind } } }`, nested `{ remoteNativeBillingRecovery: { version } }`,
 * flat `{ recoveryVersion }`, and `{ executionBackend: { kind } }`), while strictly excluding
 * unified `remote-native-v4` journals.
 */
function buildLegacyJournalMatchPredicate(versionsParam: string, backendsParam: string): string {
  return `(
    ctx->>'remoteNativeBillingRecovery' = ANY(${versionsParam}::text[])
    OR ctx->'remoteNativeBillingRecovery'->>'version' = ANY(${versionsParam}::text[])
    OR ctx->>'recoveryVersion' = ANY(${versionsParam}::text[])
    OR (
      ctx ? 'remoteNativeBillingRecovery'
      AND COALESCE(
        ctx->'remoteNativeBillingRecovery'->>'version',
        ctx->>'remoteNativeBillingRecovery',
        ''
      ) <> 'remote-native-v4'
    )
    OR (
      ctx ? 'remoteNative'
      AND COALESCE(
        ctx->'remoteNativeBillingRecovery'->>'version',
        ctx->>'remoteNativeBillingRecovery',
        ''
      ) <> 'remote-native-v4'
    )
    OR ctx#>>'{executionBackend,kind}' = ANY(${backendsParam}::text[])
    OR ctx#>>'{remoteNative,scope,backendKind}' = ANY(${backendsParam}::text[])
  )`
}

export const LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY =
  'LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY' as const

export interface LegacyRetirementReadiness {
  readonly readyToRetire: boolean
  readonly activeLegacyBindingCount: number
  readonly unsettledLegacyJournalCount: number
  readonly legacyBackendKinds: readonly LegacyRemoteBackendKind[]
  readonly legacyBillingRecoveryVersions: readonly LegacyBillingRecoveryVersion[]
  readonly blockingReasons: readonly string[]
  readonly evaluatedAt: string
}

export interface LegacyHistoricalTurnRecord {
  readonly requestId: string
  readonly userId: string
  readonly state: 'inflight' | 'finalizing' | 'committed' | 'aborted'
  readonly precheckCredits: number
  readonly finalCredits: number | null
  readonly ledgerId: string | null
  readonly usageId: string | null
  readonly errorMsg: string | null
  readonly billingRecoveryVersion: string | null
  readonly backendKind: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface LegacyBillingReadOnlyShell {
  readonly readOnly: true
  readonly retiredErrorCode: typeof LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY
  lookupHistoricalTurn(input: {
    readonly requestId: string
    readonly userId?: number | bigint
  }): Promise<LegacyHistoricalTurnRecord | null>
  listLegacyPendingCount(): Promise<number>
  createJournal(input?: unknown): never
  recordJournalWrite(input?: unknown): never
  assertWriteRejected(): never
}

interface CountRow extends Record<string, unknown> {
  cnt: string | number
}

interface JournalRow extends Record<string, unknown> {
  request_id: string
  user_id: string | number
  state: string
  precheck_credits: string | number
  final_credits: string | number | null
  ledger_id: string | number | null
  usage_id: string | number | null
  error_msg: string | null
  ctx: unknown
  created_at: unknown
  updated_at: unknown
}

function parseNonNegativeCount(raw: unknown): number {
  const n = Number(raw ?? 0)
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error('LEGACY_RETIREMENT_COUNT_INVALID')
  }
  return n
}

function toIsoString(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString()
  if (typeof raw === 'string' && raw.length > 0) return raw
  return new Date(0).toISOString()
}

function parseCtxObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function normalizeOptionalUserId(userId?: number | bigint): string | null {
  if (userId === undefined) return null
  if (typeof userId === 'bigint') {
    if (userId <= 0n) throw new Error('LEGACY_BILLING_USER_ID_INVALID')
    return userId.toString()
  }
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('LEGACY_BILLING_USER_ID_INVALID')
  }
  return String(userId)
}

/**
 * Evaluates whether legacy remote backends (`codex-app-server-v1`, `cc5-interactive-v1`)
 * and legacy billing recovery tracks can be safely retired.
 *
 * Strictly read-only: issues ONLY `SELECT COUNT(*)` queries against
 * `remote_agent_bindings` and `request_finalize_journal`.
 */
export async function evaluateLegacyRetirementReadiness(
  queryable: PgQueryable,
  options: { readonly now?: () => number } = {},
): Promise<LegacyRetirementReadiness> {
  const backendKinds = [...LEGACY_REMOTE_BACKEND_KINDS]
  const recoveryVersions = [...LEGACY_BILLING_RECOVERY_VERSIONS]

  const [bindingsRes, journalsRes] = await Promise.all([
    queryable.query<CountRow>(
      `SELECT COUNT(*)::text AS cnt
         FROM remote_agent_bindings b
         LEFT JOIN remote_agent_profiles p ON p.id = b.profile_id
        WHERE b.state <> 'released'
          AND (
            b.driver_id IS NULL
            OR b.remote_protocol_version < 4
            OR p.execution_manifest->>'backendKind' = ANY($1::text[])
          )`,
      [backendKinds],
    ),
    queryable.query<CountRow>(
      `SELECT COUNT(*)::text AS cnt
         FROM request_finalize_journal
        WHERE state IN ('inflight', 'finalizing')
          AND ${buildLegacyJournalMatchPredicate('$1', '$2')}`,
      [recoveryVersions, backendKinds],
    ),
  ])

  const activeLegacyBindingCount = parseNonNegativeCount(bindingsRes.rows[0]?.cnt)
  const unsettledLegacyJournalCount = parseNonNegativeCount(journalsRes.rows[0]?.cnt)

  const blockingReasons: string[] = []
  if (activeLegacyBindingCount > 0) {
    blockingReasons.push('ACTIVE_LEGACY_BINDINGS_REMAINING')
  }
  if (unsettledLegacyJournalCount > 0) {
    blockingReasons.push('UNSETTLED_LEGACY_BILLING_JOURNALS_REMAINING')
  }

  const nowMs = (options.now ?? Date.now)()
  return Object.freeze({
    readyToRetire: activeLegacyBindingCount === 0 && unsettledLegacyJournalCount === 0,
    activeLegacyBindingCount,
    unsettledLegacyJournalCount,
    legacyBackendKinds: LEGACY_REMOTE_BACKEND_KINDS,
    legacyBillingRecoveryVersions: LEGACY_BILLING_RECOVERY_VERSIONS,
    blockingReasons: Object.freeze(blockingReasons),
    evaluatedAt: new Date(nowMs).toISOString(),
  })
}

/**
 * Creates a strictly read-only historical billing shell for retired Phase 3 legacy
 * remote billing tracks. Every write/journal creation path fails closed with
 * `LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY`.
 */
export function createLegacyBillingReadOnlyShell(
  queryable: PgQueryable,
): LegacyBillingReadOnlyShell {
  const backendKinds = [...LEGACY_REMOTE_BACKEND_KINDS]
  const recoveryVersions = [...LEGACY_BILLING_RECOVERY_VERSIONS]

  const rejectWrite = (): never => {
    throw new Error(LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY)
  }

  return Object.freeze({
    readOnly: true as const,
    retiredErrorCode: LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY,

    async lookupHistoricalTurn(input: {
      readonly requestId: string
      readonly userId?: number | bigint
    }): Promise<LegacyHistoricalTurnRecord | null> {
      if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0) {
        throw new Error('LEGACY_BILLING_REQUEST_ID_INVALID')
      }
      const requestId = input.requestId.trim()
      const uid = normalizeOptionalUserId(input.userId)

      const sql =
        uid !== null
          ? `SELECT request_id, user_id, state, precheck_credits, final_credits,
                    ledger_id, usage_id, error_msg, ctx, created_at, updated_at
               FROM request_finalize_journal
              WHERE request_id = $1
                AND user_id = $2
                AND ${buildLegacyJournalMatchPredicate('$3', '$4')}
              LIMIT 1`
          : `SELECT request_id, user_id, state, precheck_credits, final_credits,
                    ledger_id, usage_id, error_msg, ctx, created_at, updated_at
               FROM request_finalize_journal
              WHERE request_id = $1
                AND ${buildLegacyJournalMatchPredicate('$2', '$3')}
              LIMIT 1`

      const params =
        uid !== null
          ? [requestId, uid, recoveryVersions, backendKinds]
          : [requestId, recoveryVersions, backendKinds]

      const res = await queryable.query<JournalRow>(sql, params)
      const row = res.rows[0]
      if (!row) return null

      const ctx = parseCtxObject(row.ctx)
      const execBackend =
        ctx.executionBackend &&
        typeof ctx.executionBackend === 'object' &&
        !Array.isArray(ctx.executionBackend)
          ? (ctx.executionBackend as Record<string, unknown>)
          : null
      const remoteNativeObj =
        ctx.remoteNative &&
        typeof ctx.remoteNative === 'object' &&
        !Array.isArray(ctx.remoteNative)
          ? (ctx.remoteNative as Record<string, unknown>)
          : null
      const remoteNativeScope =
        remoteNativeObj?.scope &&
        typeof remoteNativeObj.scope === 'object' &&
        !Array.isArray(remoteNativeObj.scope)
          ? (remoteNativeObj.scope as Record<string, unknown>)
          : null
      const recoveryObj =
        ctx.remoteNativeBillingRecovery &&
        typeof ctx.remoteNativeBillingRecovery === 'object' &&
        !Array.isArray(ctx.remoteNativeBillingRecovery)
          ? (ctx.remoteNativeBillingRecovery as Record<string, unknown>)
          : null
      const billingRecoveryVersion =
        typeof ctx.remoteNativeBillingRecovery === 'string'
          ? ctx.remoteNativeBillingRecovery
          : typeof recoveryObj?.version === 'string'
            ? recoveryObj.version
            : typeof ctx.recoveryVersion === 'string'
              ? ctx.recoveryVersion
              : null
      const backendKind =
        typeof execBackend?.kind === 'string'
          ? execBackend.kind
          : typeof remoteNativeScope?.backendKind === 'string'
            ? remoteNativeScope.backendKind
            : null

      return Object.freeze({
        requestId: String(row.request_id),
        userId: String(row.user_id),
        state: row.state as LegacyHistoricalTurnRecord['state'],
        precheckCredits: Number(row.precheck_credits),
        finalCredits:
          row.final_credits === null || row.final_credits === undefined
            ? null
            : Number(row.final_credits),
        ledgerId:
          row.ledger_id === null || row.ledger_id === undefined ? null : String(row.ledger_id),
        usageId:
          row.usage_id === null || row.usage_id === undefined ? null : String(row.usage_id),
        errorMsg: row.error_msg ?? null,
        billingRecoveryVersion,
        backendKind,
        createdAt: toIsoString(row.created_at),
        updatedAt: toIsoString(row.updated_at),
      })
    },

    async listLegacyPendingCount(): Promise<number> {
      const res = await queryable.query<CountRow>(
        `SELECT COUNT(*)::text AS cnt
           FROM request_finalize_journal
          WHERE state IN ('inflight', 'finalizing')
            AND ${buildLegacyJournalMatchPredicate('$1', '$2')}`,
        [recoveryVersions, backendKinds],
      )
      return parseNonNegativeCount(res.rows[0]?.cnt)
    },

    createJournal: rejectWrite,
    recordJournalWrite: rejectWrite,
    assertWriteRejected: rejectWrite,
  })
}
