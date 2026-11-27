/**
 * OCV5-908 Wave 3 (P2-2) — Shared PG-Authoritative Legacy Remote Track Retirement Gate.
 *
 * Governs the safe cutover & fail-closed retirement of `codex-app-server-v1` and
 * `cc5-interactive-v1` across Master and standalone blue-green `remote-relay` slots:
 * - Single authoritative persisted state in `system_settings['legacy_remote_tracks_retirement']`
 *   with monotonic `revision` so Master, Relay A/B, and restarted processes never diverge (B01).
 * - PostgreSQL transaction advisory-lock barrier (`pg_advisory_xact_lock` exclusive on `seal` vs
 *   `pg_advisory_xact_lock_shared` inside every legacy writer transaction: `placeRemoteLane`,
 *   `admitCommission`, `remoteNativeTurnBilling.admit`, `revertDriverV4ProfileToLegacy`) so zero
 *   in-flight legacy placements or journals can commit after `seal()` succeeds (B02 / B03).
 * - Single observed Promise chain on startup (zero unhandled rejections) and fast skip when
 *   `force_off` (B04).
 * - Atomic `unseal()` writes PG before updating local cache (W05).
 *
 * Architecture invariants:
 * - Zero `process.env` reads (R3-env); callers inject parsed `LegacyRetirementMode`.
 * - Zero writes to billing tables (only `system_settings` config key).
 * - Zero network I/O, zero forbidden crypto, zero engine/provider literal special cases.
 */
import type { PgQueryable } from '../../db/threeLayerStateStore.js'
import {
  LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY,
  type LegacyBillingReadOnlyShell,
  type LegacyHistoricalTurnRecord,
  type LegacyRetirementReadiness,
  createLegacyBillingReadOnlyShell,
  evaluateLegacyRetirementReadiness,
} from './legacyRetirement.js'

export const LEGACY_REMOTE_TRACK_RETIRED = 'LEGACY_REMOTE_TRACK_RETIRED' as const
export const LEGACY_RETIREMENT_BLOCKED = 'LEGACY_RETIREMENT_BLOCKED' as const
export const UNMIGRATED_LEGACY_MODEL_OFFERS = 'UNMIGRATED_LEGACY_MODEL_OFFERS' as const
export const LEGACY_RETIREMENT_SETTING_KEY = 'legacy_remote_tracks_retirement' as const
export const LEGACY_RETIREMENT_ADVISORY_LOCK_KEY = 'legacy-remote-tracks-retirement' as const

export type LegacyRetirementMode = 'auto' | 'force_off' | 'force_on'

export interface PersistedLegacyRetirementState {
  readonly version: 1
  readonly revision: number
  readonly enforced: boolean
  readonly sealedAt: string | null
  readonly unsealedAt: string | null
  readonly updatedAt: string | null
}

const DEFAULT_PERSISTED_STATE: PersistedLegacyRetirementState = Object.freeze({
  version: 1,
  revision: 0,
  enforced: false,
  sealedAt: null,
  unsealedAt: null,
  updatedAt: null,
})

export interface LegacyRetirementGateStatus {
  readonly enforced: boolean
  readonly revision: number
  readonly mode: LegacyRetirementMode
  readonly readiness: LegacyRetirementReadiness
  readonly retiredPlacementErrorCode: typeof LEGACY_REMOTE_TRACK_RETIRED
  readonly retiredBillingErrorCode: typeof LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY
  readonly sealedAt: string | null
  readonly unsealedAt: string | null
}

export interface LegacyRetirementGateLogger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
}

export interface LegacyRetirementPoolClient extends PgQueryable {
  release(): void
}

export interface LegacyRetirementPoolLike extends PgQueryable {
  connect?: () => Promise<LegacyRetirementPoolClient>
}

export class LegacyRetirementBlockedError extends Error {
  readonly code = LEGACY_RETIREMENT_BLOCKED
  readonly readiness: LegacyRetirementReadiness

  constructor(readiness: LegacyRetirementReadiness) {
    super(
      readiness.blockingReasons.length > 0
        ? `${LEGACY_RETIREMENT_BLOCKED}:${readiness.blockingReasons.join(',')}`
        : LEGACY_RETIREMENT_BLOCKED,
    )
    this.name = 'LegacyRetirementBlockedError'
    this.readiness = readiness
  }
}

/**
 * Resolves the legacy retirement mode from an injected flag string and selfhost flavor bit.
 * - Commercial (`!isSelfhostV5`): defaults to `force_off` (never auto-seals at startup) unless
 *   explicitly opted-in (`1`/`true`/`on`).
 * - Personal selfhost V5 (`isSelfhostV5`): defaults to `auto` (auto-seals at boot once readiness
 *   is green). Setting `0`/`false`/`off` disables automatic sealing on startup; authoritative global
 *   unseal/rollback of an already-sealed PG state MUST go through `unseal()` / the admin `/unseal`
 *   endpoint so PG `system_settings['legacy_remote_tracks_retirement']` is updated atomically.
 */
export function parseLegacyRetirementMode(
  rawFlag: string | undefined,
  isSelfhostV5: boolean,
): LegacyRetirementMode {
  const normalized = (rawFlag ?? '').trim().toLowerCase()
  if (normalized === '0' || normalized === 'false' || normalized === 'off') {
    return 'force_off'
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'on') {
    return 'force_on'
  }
  if (normalized === 'auto') {
    return 'auto'
  }
  return isSelfhostV5 ? 'auto' : 'force_off'
}

export function parsePersistedLegacyRetirementState(raw: unknown): PersistedLegacyRetirementState {
  let obj: Record<string, unknown> | null = null
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>
      }
    } catch {
      return DEFAULT_PERSISTED_STATE
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>
  }
  if (!obj) return DEFAULT_PERSISTED_STATE

  const revision =
    typeof obj.revision === 'number' && Number.isSafeInteger(obj.revision) && obj.revision >= 0
      ? obj.revision
      : 0
  const enforced = obj.enforced === true
  const sealedAt = typeof obj.sealedAt === 'string' && obj.sealedAt.length > 0 ? obj.sealedAt : null
  const unsealedAt =
    typeof obj.unsealedAt === 'string' && obj.unsealedAt.length > 0 ? obj.unsealedAt : null
  const updatedAt =
    typeof obj.updatedAt === 'string' && obj.updatedAt.length > 0 ? obj.updatedAt : null
  return Object.freeze({
    version: 1,
    revision,
    enforced,
    sealedAt,
    unsealedAt,
    updatedAt,
  })
}

/**
 * Strictly read-only read of the shared authoritative retirement state from PG `system_settings`.
 */
export async function readPersistedLegacyRetirementState(
  queryable: PgQueryable,
): Promise<PersistedLegacyRetirementState> {
  const res = await queryable.query<{ value: unknown }>(
    'SELECT value FROM system_settings WHERE key = $1 LIMIT 1',
    [LEGACY_RETIREMENT_SETTING_KEY],
  )
  if (res.rows.length === 0) return DEFAULT_PERSISTED_STATE
  return parsePersistedLegacyRetirementState(res.rows[0]?.value)
}

async function writePersistedLegacyRetirementStateTx(
  client: PgQueryable,
  state: PersistedLegacyRetirementState,
  updatedByUid = 3,
): Promise<void> {
  await client.query(
    `INSERT INTO system_settings (key, value, description, updated_at, updated_by)
     VALUES ($1, $2::jsonb, $3, NOW(), $4)
     ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            description = EXCLUDED.description,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by`,
    [
      LEGACY_RETIREMENT_SETTING_KEY,
      JSON.stringify(state),
      'Authoritative retirement state for legacy remote tracks (codex-app-server-v1 / cc5-interactive-v1)',
      updatedByUid,
    ],
  )
}

/**
 * Shared transaction-level commit barrier called inside EVERY legacy write transaction
 * (`placeRemoteLane`, `admitCommission`, `remoteNativeTurnBilling.admit`, `revertDriverV4ProfileToLegacy`).
 *
 * Acquires `pg_advisory_xact_lock_shared` so multiple legacy writers never block each other, while
 * strictly serializing against `seal()`'s exclusive `pg_advisory_xact_lock`:
 * - Any writer that enters before `seal()` commits BEFORE `seal()` runs its zero-count readiness query.
 * - Any writer that enters after `seal()` wakes up AFTER `seal()` commits, observes `enforced === true`
 *   in `system_settings`, and immediately fails closed before committing any legacy row.
 */
export async function assertLegacyTrackNotRetiredTx(
  client: PgQueryable,
  kind: 'placement' | 'billing',
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
    LEGACY_RETIREMENT_ADVISORY_LOCK_KEY,
  ])
  const persisted = await readPersistedLegacyRetirementState(client)
  if (persisted.enforced) {
    throw new Error(
      kind === 'billing' ? LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY : LEGACY_REMOTE_TRACK_RETIRED,
    )
  }
}

interface UnmigratedOfferRow extends Record<string, unknown> {
  canonical_model_id: string
  engine?: string | null
}

/**
 * Strictly read-only migration-coverage proof: lists every enabled legacy-only
 * `(canonical_model_id, engine)` pair (active/degraded legacy profile `driver_id IS NULL` on an
 * active/degraded node) lacking an active, verified (`execution_ready = TRUE`) `remote-driver-v4`
 * (`driver_id IS NOT NULL`) replacement offer on the SAME execution `engine` (matching Master
 * `cc5Runtime` and Relay `remoteRelay/main` candidate selection predicates).
 *
 * Prevents idle-time auto-seal or operator seal from bricking legacy-only model+engine offers
 * before same-engine v4 cutover coverage is complete.
 */
export async function evaluateUnmigratedLegacyModelOffers(
  queryable: PgQueryable,
): Promise<readonly string[]> {
  const res = await queryable.query<UnmigratedOfferRow>(
    `SELECT DISTINCT o.canonical_model_id, p.engine
       FROM remote_model_offers o
       JOIN remote_agent_profiles p ON p.id = o.profile_id
       JOIN remote_agent_nodes n ON n.id = p.node_id
      WHERE o.enabled = TRUE
        AND p.driver_id IS NULL
        AND p.status IN ('active', 'degraded')
        AND (p.disabled_by IS NULL OR p.disabled_by <> 'admin')
        AND n.status IN ('active', 'degraded')
        AND (n.disabled_by IS NULL OR n.disabled_by <> 'admin')
        AND NOT EXISTS (
          SELECT 1
            FROM remote_model_offers o2
            JOIN remote_agent_profiles p2 ON p2.id = o2.profile_id
            JOIN remote_agent_nodes n2 ON n2.id = p2.node_id
           WHERE o2.canonical_model_id = o.canonical_model_id
             AND o2.enabled = TRUE
             AND p2.driver_id IS NOT NULL
             AND p2.engine = p.engine
             AND p2.execution_ready = TRUE
             AND p2.status IN ('active', 'degraded')
             AND (p2.disabled_by IS NULL OR p2.disabled_by <> 'admin')
             AND n2.status IN ('active', 'degraded')
             AND (n2.disabled_by IS NULL OR n2.disabled_by <> 'admin')
        )
      ORDER BY o.canonical_model_id, p.engine`,
  )
  return Object.freeze(
    res.rows
      .map((row) => {
        const model = String(row.canonical_model_id ?? '').trim()
        const engine = typeof row.engine === 'string' ? row.engine.trim() : ''
        if (!model) return ''
        return engine ? `${model}@${engine}` : model
      })
      .filter((id) => id.length > 0),
  )
}

async function evaluateFullRetirementReadiness(
  queryable: PgQueryable,
  now: () => number,
): Promise<LegacyRetirementReadiness> {
  const [base, unmigratedModels] = await Promise.all([
    evaluateLegacyRetirementReadiness(queryable, { now }),
    evaluateUnmigratedLegacyModelOffers(queryable),
  ])
  if (unmigratedModels.length === 0) return base
  return Object.freeze({
    ...base,
    readyToRetire: false,
    blockingReasons: Object.freeze([...base.blockingReasons, UNMIGRATED_LEGACY_MODEL_OFFERS]),
  })
}

export interface LegacyTrackRetirementGateOptions {
  readonly queryable: LegacyRetirementPoolLike
  readonly mode?: LegacyRetirementMode
  readonly initialEnforced?: boolean
  readonly now?: () => number
  readonly log?: LegacyRetirementGateLogger
}

/**
 * Runtime enforcement gate for retired legacy remote tracks (`codex-app-server-v1`,
 * `cc5-interactive-v1`). Backed by PG `system_settings['legacy_remote_tracks_retirement']`
 * with exclusive transaction advisory locking on seal/unseal so Master and all remote-relay
 * slots observe a single monotonic revision.
 */
export class LegacyTrackRetirementGate {
  readonly retiredPlacementErrorCode = LEGACY_REMOTE_TRACK_RETIRED
  readonly retiredBillingErrorCode = LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY

  private readonly pool: LegacyRetirementPoolLike
  private readonly shell: LegacyBillingReadOnlyShell
  private readonly now: () => number
  private readonly log?: LegacyRetirementGateLogger
  private mode: LegacyRetirementMode
  private persisted: PersistedLegacyRetirementState
  private initPromise: Promise<LegacyRetirementGateStatus> | null = null
  private transitionQueue: Promise<void> = Promise.resolve()

  constructor(opts: LegacyTrackRetirementGateOptions) {
    this.pool = opts.queryable
    this.shell = createLegacyBillingReadOnlyShell(opts.queryable)
    this.now = opts.now ?? Date.now
    this.log = opts.log
    this.mode = opts.mode ?? 'auto'
    const nowIso = new Date(this.now()).toISOString()
    this.persisted = opts.initialEnforced
      ? Object.freeze({
          version: 1,
          revision: 1,
          enforced: true,
          sealedAt: nowIso,
          unsealedAt: null,
          updatedAt: nowIso,
        })
      : DEFAULT_PERSISTED_STATE
  }

  isRetired(): boolean {
    return this.persisted.enforced
  }

  getRevision(): number {
    return this.persisted.revision
  }

  getMode(): LegacyRetirementMode {
    return this.mode
  }

  private enqueueTransition<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.transitionQueue.then(fn, fn)
    this.transitionQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async runWithExclusiveTx<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
    if (typeof this.pool.connect !== 'function') {
      await this.pool.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        LEGACY_RETIREMENT_ADVISORY_LOCK_KEY,
      ])
      return await fn(this.pool)
    }
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        LEGACY_RETIREMENT_ADVISORY_LOCK_KEY,
      ])
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  private buildStatus(readiness: LegacyRetirementReadiness): LegacyRetirementGateStatus {
    return Object.freeze({
      enforced: this.persisted.enforced,
      revision: this.persisted.revision,
      mode: this.mode,
      readiness,
      retiredPlacementErrorCode: LEGACY_REMOTE_TRACK_RETIRED,
      retiredBillingErrorCode: LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY,
      sealedAt: this.persisted.sealedAt,
      unsealedAt: this.persisted.unsealedAt,
    })
  }

  /**
   * Synchronous fast-path check against local cached state (complemented by transactional
   * `assertLegacyTrackNotRetiredTx` inside every PG writer transaction).
   */
  assertLegacyPlacementAllowed(): void {
    if (this.persisted.enforced) {
      throw new Error(LEGACY_REMOTE_TRACK_RETIRED)
    }
  }

  /**
   * Refreshes local cached retirement state from the authoritative shared PG `system_settings` row.
   */
  async syncFromStore(): Promise<PersistedLegacyRetirementState> {
    const live = await readPersistedLegacyRetirementState(this.pool)
    if (live.revision >= this.persisted.revision) {
      this.persisted = live
    }
    return this.persisted
  }

  /**
   * Live authoritative placement check: awaits startup initialization, refreshes shared PG state,
   * and fails closed with `LEGACY_REMOTE_TRACK_RETIRED` if sealed by any process (regardless of
   * local startup `mode`, so `force_off` never diverges from the 4 transactional PG writers).
   */
  async assertLegacyPlacementAllowedAsync(): Promise<void> {
    if (this.initPromise) {
      try {
        await this.initPromise
      } catch (err) {
        void err
      }
    }
    await this.syncFromStore()
    this.assertLegacyPlacementAllowed()
  }

  assertLegacyBillingWriteAllowed(): void {
    if (this.persisted.enforced) {
      this.shell.assertWriteRejected()
    }
  }

  async assertLegacyBillingWriteAllowedAsync(): Promise<void> {
    if (this.initPromise) {
      try {
        await this.initPromise
      } catch (err) {
        void err
      }
    }
    await this.syncFromStore()
    this.assertLegacyBillingWriteAllowed()
  }

  async evaluateReadiness(): Promise<LegacyRetirementReadiness> {
    return await evaluateFullRetirementReadiness(this.pool, this.now)
  }

  async lookupHistoricalTurn(input: {
    readonly requestId: string
    readonly userId?: number | bigint
  }): Promise<LegacyHistoricalTurnRecord | null> {
    return await this.shell.lookupHistoricalTurn(input)
  }

  async listLegacyPendingCount(): Promise<number> {
    return await this.shell.listLegacyPendingCount()
  }

  async getStatus(): Promise<LegacyRetirementGateStatus> {
    const [live, readiness] = await Promise.all([
      readPersistedLegacyRetirementState(this.pool),
      this.evaluateReadiness(),
    ])
    if (live.revision >= this.persisted.revision) {
      this.persisted = live
    }
    return this.buildStatus(readiness)
  }

  /**
   * Startup initialization (single observed Promise chain — zero detached unhandled rejections):
   * - `force_off`: disables auto-sealing at boot; attempts a best-effort read of the authoritative
   *   PG `system_settings['legacy_remote_tracks_retirement']` row so if PG is already sealed, this
   *   instance honestly reports `enforced: true` (never claiming unsealed while the 4 transactional
   *   writers still reject). If PG is unreachable during `force_off` startup, logs a warning and
   *   returns `enforced: false` without failing boot (B04).
   * - `auto` / `force_on`: under exclusive PG advisory lock, restores persisted state or evaluates
   *   readiness and atomically seals `system_settings['legacy_remote_tracks_retirement']` when
   *   `readyToRetire === true`. Fails safe unsealed if active legacy bindings/journals remain.
   */
  initializeAtStartup(overrideMode?: LegacyRetirementMode): Promise<LegacyRetirementGateStatus> {
    if (overrideMode !== undefined) {
      this.mode = overrideMode
    }
    const run = this.enqueueTransition(async (): Promise<LegacyRetirementGateStatus> => {
      try {
        return this.mode === 'force_off'
          ? await this.runForceOffStartup()
          : await this.runActiveStartup()
      } finally {
        if (this.initPromise === run) {
          this.initPromise = null
        }
      }
    })
    this.initPromise = run
    return run
  }

  private async runForceOffStartup(): Promise<LegacyRetirementGateStatus> {
    const nowIso = new Date(this.now()).toISOString()
    let persistedFromDb: PersistedLegacyRetirementState | null = null
    try {
      persistedFromDb = await readPersistedLegacyRetirementState(this.pool)
    } catch (err) {
      this.log?.warn(
        '[commercial] force_off startup could not read persisted legacy retirement state; skipping auto-seal',
        { error: err instanceof Error ? err.message : String(err) },
      )
    }
    if (persistedFromDb && persistedFromDb.revision >= this.persisted.revision) {
      this.persisted = persistedFromDb
    }
    if (this.persisted.enforced) {
      this.log?.warn(
        '[commercial] legacy retirement auto-seal disabled (force_off), but PG remains authoritatively sealed — call /unseal to roll back globally',
        { mode: this.mode, revision: this.persisted.revision },
      )
    } else {
      this.log?.info('[commercial] legacy remote tracks auto-seal disabled by flag (force_off)', {
        mode: this.mode,
        revision: this.persisted.revision,
      })
    }
    const syntheticReadiness: LegacyRetirementReadiness = Object.freeze({
      readyToRetire: false,
      activeLegacyBindingCount: 0,
      unsettledLegacyJournalCount: 0,
      legacyBackendKinds: ['codex-app-server-v1', 'cc5-interactive-v1'] as const,
      legacyBillingRecoveryVersions: [
        'cc5-native-v1',
        'remote-native-v1',
        'remote-native-v2',
        'codex-remote-v1',
      ] as const,
      blockingReasons: Object.freeze(
        this.persisted.enforced
          ? ['AUTO_SEAL_DISABLED_PG_STILL_SEALED']
          : ['RETIREMENT_AUTO_SEAL_DISABLED_BY_FLAG'],
      ),
      evaluatedAt: nowIso,
    })
    return this.buildStatus(syntheticReadiness)
  }

  private async runActiveStartup(): Promise<LegacyRetirementGateStatus> {
    const { nextState, readiness } = await this.runWithExclusiveTx(async (client) => {
      const current = await readPersistedLegacyRetirementState(client)
      const r = await evaluateFullRetirementReadiness(client, this.now)
      if (this.mode === 'auto' && current.revision > 0 && !current.enforced && current.unsealedAt) {
        return { nextState: current, readiness: r }
      }
      if (current.enforced) {
        return { nextState: current, readiness: r }
      }
      if (r.readyToRetire) {
        const sealed: PersistedLegacyRetirementState = Object.freeze({
          version: 1,
          revision: current.revision + 1,
          enforced: true,
          sealedAt: r.evaluatedAt,
          unsealedAt: null,
          updatedAt: r.evaluatedAt,
        })
        await writePersistedLegacyRetirementStateTx(client, sealed)
        return { nextState: sealed, readiness: r }
      }
      return { nextState: current, readiness: r }
    })

    this.persisted = nextState
    if (nextState.enforced) {
      this.log?.info('[commercial] legacy remote tracks retired (v4-only enforced)', {
        mode: this.mode,
        revision: nextState.revision,
        activeLegacyBindingCount: readiness.activeLegacyBindingCount,
        unsettledLegacyJournalCount: readiness.unsettledLegacyJournalCount,
        evaluatedAt: readiness.evaluatedAt,
      })
    } else {
      this.log?.warn(
        '[commercial] legacy remote tracks NOT sealed at startup; active bindings/journals or operator unseal present',
        {
          mode: this.mode,
          revision: nextState.revision,
          activeLegacyBindingCount: readiness.activeLegacyBindingCount,
          unsettledLegacyJournalCount: readiness.unsettledLegacyJournalCount,
          blockingReasons: [...readiness.blockingReasons],
        },
      )
    }
    return this.buildStatus(readiness)
  }

  /**
   * Explicit operator seal: acquires exclusive PG advisory lock (draining all in-flight legacy
   * writer transactions), verifies live zero active legacy bindings & zero unsettled legacy
   * journals, and atomically persists `enforced = true` with incremented `revision`.
   */
  seal(adminUid = 3): Promise<LegacyRetirementGateStatus> {
    return this.enqueueTransition(async () => {
      const { nextState, readiness } = await this.runWithExclusiveTx(async (client) => {
        const current = await readPersistedLegacyRetirementState(client)
        const r = await evaluateFullRetirementReadiness(client, this.now)
        if (!r.readyToRetire) {
          throw new LegacyRetirementBlockedError(r)
        }
        const sealed: PersistedLegacyRetirementState = Object.freeze({
          version: 1,
          revision: current.revision + 1,
          enforced: true,
          sealedAt: r.evaluatedAt,
          unsealedAt: null,
          updatedAt: r.evaluatedAt,
        })
        await writePersistedLegacyRetirementStateTx(client, sealed, adminUid)
        return { nextState: sealed, readiness: r }
      })

      this.persisted = nextState
      this.log?.info('[commercial] legacy remote tracks sealed by operator', {
        revision: nextState.revision,
        evaluatedAt: readiness.evaluatedAt,
      })
      return this.buildStatus(readiness)
    })
  }

  /**
   * Atomic operator emergency unseal (persists PG `enforced = false` BEFORE updating local state;
   * if PG fails, throws cleanly without mutating local cache).
   */
  unseal(adminUid = 3): Promise<LegacyRetirementGateStatus> {
    return this.enqueueTransition(async () => {
      const nowIso = new Date(this.now()).toISOString()
      const { nextState, readiness } = await this.runWithExclusiveTx(async (client) => {
        const current = await readPersistedLegacyRetirementState(client)
        const unsealed: PersistedLegacyRetirementState = Object.freeze({
          version: 1,
          revision: current.revision + 1,
          enforced: false,
          sealedAt: current.sealedAt,
          unsealedAt: nowIso,
          updatedAt: nowIso,
        })
        await writePersistedLegacyRetirementStateTx(client, unsealed, adminUid)
        const r = await evaluateFullRetirementReadiness(client, this.now)
        return { nextState: unsealed, readiness: r }
      })

      this.persisted = nextState
      this.log?.warn('[commercial] legacy remote tracks unsealed by operator', {
        revision: nextState.revision,
        unsealedAt: nextState.unsealedAt,
        readyToRetire: readiness.readyToRetire,
      })
      return this.buildStatus(readiness)
    })
  }
}

export interface LegacyBillingGatePort {
  assertLegacyBillingWriteAllowed(): void
  assertLegacyBillingWriteAllowedAsync?(): Promise<void>
}

export async function assertLegacyBillingGateAllowed(
  gate: LegacyBillingGatePort | undefined,
): Promise<void> {
  if (!gate) return
  if (gate.assertLegacyBillingWriteAllowedAsync) {
    await gate.assertLegacyBillingWriteAllowedAsync()
  } else {
    gate.assertLegacyBillingWriteAllowed()
  }
}

export function bootstrapLegacyRetirementGate(opts: {
  queryable: LegacyRetirementPoolLike
  rawFlag: string | undefined
  isSelfhostV5: boolean
  log?: LegacyRetirementGateLogger
}): LegacyTrackRetirementGate {
  const gate = new LegacyTrackRetirementGate({
    queryable: opts.queryable,
    mode: parseLegacyRetirementMode(opts.rawFlag, opts.isSelfhostV5),
    log: opts.log,
  })
  if (opts.isSelfhostV5) {
    void gate.initializeAtStartup().catch((err: unknown) => {
      opts.log?.warn(
        '[commercial] legacy remote tracks startup readiness check failed (fail-safe unsealed)',
        { error: err instanceof Error ? err.message : String(err) },
      )
    })
  }
  return gate
}

export async function bootstrapLegacyRetirementGateAsync(opts: {
  queryable: LegacyRetirementPoolLike
  rawFlag: string | undefined
  isSelfhostV5: boolean
  log?: LegacyRetirementGateLogger
}): Promise<LegacyTrackRetirementGate> {
  const gate = new LegacyTrackRetirementGate({
    queryable: opts.queryable,
    mode: parseLegacyRetirementMode(opts.rawFlag, opts.isSelfhostV5),
    log: opts.log,
  })
  try {
    await gate.initializeAtStartup()
  } catch (err) {
    opts.log?.warn('legacy_retirement_startup_check_failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return gate
}
