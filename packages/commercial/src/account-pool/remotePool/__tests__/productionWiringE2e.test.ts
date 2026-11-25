import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Pool } from 'pg'
import {
  MODEL_AUTHORITY_FIELD,
  REMOTE_DRIVER_BACKEND,
  REMOTE_DRIVER_PROTOCOL_VERSION,
  computeSchemaFilteredArgsSha256,
  computeToolIdempotencyKey,
  parseAuthorityKeyring,
  type LogicalModelCapability,
  type RemoteProbeSnapshot,
} from '@openclaude/protocol'
import {
  assertFreshCc5Session,
  cc5SessionBackend,
} from '../../../../../gateway/src/cc5SessionBackend.js'
import { AntigravityAdapter } from '../../../../../gateway/src/engine/antigravityAdapter.js'
import {
  ExecEnvLeaseManager,
  ToolBrokerServer,
} from '../../../../../gateway/src/execEnv/index.js'
import {
  AuthorityRejected,
  ModelAuthorityConsumer,
} from '../../../../../gateway/src/modelAuthority.js'
import { remotePoolBackendOf } from '../../../../../gateway/src/remotePool/types.js'
import { remoteV4ResumeId } from '../../../../../gateway/src/remotePool/resumeId.js'
import { AuthoritySigner } from '../../../ws/authoritySigner.js'
import { resolveRemotePoolBackendAndSeal } from '../../../ws/userChatBridgeRemotePoolSeal.js'
import {
  CAPABILITY_SCHEMA_VERSION,
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from '../../../billing/modelCatalog.js'
import {
  CODEX_REMOTE_BILLING_RECOVERY_VERSION,
  REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
  REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
} from '../../../billing/remoteNativeBillingIdentity.js'
import {
  PgLogicalModelBindingStore,
  PgSessionAuthorityStateStore,
  type PgQueryResult,
  type PgQueryable,
  type PgTransactionClient,
  type PgTransactionPool,
} from '../../../db/threeLayerStateStore.js'
import { buildSelfhostCrossPoolBridgeHooks } from '../../../bootstrap/chatBridgeBootstrap.js'
import { computeProbeFingerprintTs } from '../driftCoordinator.js'
import {
  LEGACY_BILLING_RECOVERY_VERSIONS,
  createLegacyBillingReadOnlyShell,
  evaluateLegacyRetirementReadiness,
} from '../legacyRetirement.js'
import { placeRemoteDriverLane, recordRemoteDriverLaneState } from '../placement.js'
import { loadRemoteDriverRegistry } from '../registry.js'
import {
  createSelfhostCrossPoolFallbackSelector,
  createSelfhostReturnToRemoteGrantResolver,
} from '../selfhostCrossPoolSelector.js'

interface MockPgState {
  pointers: Map<string, Record<string, unknown>>
  migrations: Map<string, Record<string, unknown>>
  bindings: Map<string, Record<string, unknown>>
  checkpoints: Map<string, Record<string, unknown>[]>
  pendingJournals: Array<{
    userId: string
    version: string
    operationId?: string
    sessionKey?: string
    state: string
  }>
  remoteBindings: Array<{
    uid: string
    sessionKey: string
    operationId: string
    runId?: string
    profileId?: string
    profileName?: string
    driverId?: string
    generation?: string
    nativeSessionId?: string | null
    state: string
    recoverySpec?: Record<string, unknown>
    updatedAtMs?: number
  }>
  remoteOffers: Array<Record<string, unknown>>
  failBindingReads: boolean
  clockMs: number
}

function clonePgState(s: MockPgState): MockPgState {
  const cloneMap = (m: Map<string, Record<string, unknown>>) =>
    new Map([...m.entries()].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))
  return {
    pointers: cloneMap(s.pointers),
    migrations: cloneMap(s.migrations),
    bindings: cloneMap(s.bindings),
    checkpoints: new Map(
      [...s.checkpoints.entries()].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]),
    ),
    pendingJournals: JSON.parse(JSON.stringify(s.pendingJournals)),
    remoteBindings: JSON.parse(JSON.stringify(s.remoteBindings)),
    remoteOffers: JSON.parse(JSON.stringify(s.remoteOffers)),
    failBindingReads: s.failBindingReads,
    clockMs: s.clockMs,
  }
}

class MockThreeLayerPgPool implements PgTransactionPool {
  state: MockPgState = {
    pointers: new Map(),
    migrations: new Map(),
    bindings: new Map(),
    checkpoints: new Map(),
    pendingJournals: [],
    remoteBindings: [],
    remoteOffers: [],
    failBindingReads: false,
    clockMs: Date.parse('2026-11-25T14:00:00.000Z'),
  }

  private nowIso(db: MockPgState): string {
    db.clockMs += 10
    if (db !== this.state && db.clockMs > this.state.clockMs) {
      this.state.clockMs = db.clockMs
    }
    return new Date(db.clockMs).toISOString()
  }

  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PgQueryResult<R>> {
    return this.execOn(this.state, sql, params) as PgQueryResult<R>
  }

  async connect(): Promise<PgTransactionClient> {
    let txState: MockPgState | null = null
    return {
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<PgQueryResult<R>> => {
        const trimmed = sql.trim().toUpperCase()
        if (trimmed === 'BEGIN') {
          txState = clonePgState(this.state)
          return { rows: [], rowCount: 0 }
        }
        if (trimmed === 'COMMIT') {
          if (txState) {
            this.state = txState
            txState = null
          }
          return { rows: [], rowCount: 0 }
        }
        if (trimmed === 'ROLLBACK') {
          txState = null
          return { rows: [], rowCount: 0 }
        }
        return this.execOn(txState ?? this.state, sql, params) as PgQueryResult<R>
      },
      release: () => {
        txState = null
      },
    }
  }

  private execOn(
    db: MockPgState,
    rawSql: string,
    params: unknown[],
  ): PgQueryResult<Record<string, unknown>> {
    const sql = rawSql.replace(/\s+/g, ' ').trim()

    if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 }
    }

    // session_engine_pointers
    if (sql.includes('FROM session_engine_pointers') && sql.startsWith('SELECT')) {
      const row = db.pointers.get(`${params[0]}:${params[1]}`)
      return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    if (sql.startsWith('INSERT INTO session_engine_pointers') && sql.includes('ON CONFLICT')) {
      const k = `${params[0]}:${params[1]}`
      const now = this.nowIso(db)
      const prev = db.pointers.get(k)
      const row: Record<string, unknown> = {
        user_id: String(params[0]),
        session_key: String(params[1]),
        placement_epoch: prev ? prev.placement_epoch : 1,
        pool_kind: params[2],
        engine: params[3],
        native_session_id: params[4],
        operation_id: params[5],
        profile_id: params[6],
        capsule_id: params[7],
        history_json: JSON.parse(String(params[8])),
        rejected_ids_json: JSON.parse(String(params[9])),
        prompt_cache_meta_json: params[10] === null ? null : JSON.parse(String(params[10])),
        usage_baseline_json: params[11] === null ? null : JSON.parse(String(params[11])),
        history_context_version: params[12],
        promoted_from_history: params[13],
        migration_state: prev ? prev.migration_state : 'active',
        active_migration_id: prev ? prev.active_migration_id : null,
        created_at: prev ? prev.created_at : now,
        updated_at: now,
      }
      db.pointers.set(k, row)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    if (sql.startsWith('INSERT INTO session_engine_pointers')) {
      const k = `${params[0]}:${params[1]}`
      const now = this.nowIso(db)
      const row: Record<string, unknown> = {
        user_id: String(params[0]),
        session_key: String(params[1]),
        placement_epoch: 1,
        pool_kind: params[2],
        engine: params[3],
        native_session_id: null,
        operation_id: params[4],
        profile_id: params[5],
        capsule_id: null,
        history_json: [],
        rejected_ids_json: [],
        prompt_cache_meta_json: null,
        usage_baseline_json: null,
        history_context_version: null,
        promoted_from_history: false,
        migration_state: 'migrating',
        active_migration_id: params[6],
        created_at: now,
        updated_at: now,
      }
      db.pointers.set(k, row)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    if (sql.startsWith('UPDATE session_engine_pointers SET migration_state = \'migrating\'')) {
      const k = `${params[0]}:${params[1]}`
      const row = db.pointers.get(k)
      if (!row || Number(row.placement_epoch) !== Number(params[2]) || row.migration_state !== 'active') {
        return { rows: [], rowCount: 0 }
      }
      row.migration_state = 'migrating'
      row.active_migration_id = params[3]
      row.updated_at = this.nowIso(db)
      return { rows: [{ placement_epoch: row.placement_epoch }], rowCount: 1 }
    }

    if (sql.startsWith('UPDATE session_engine_pointers SET placement_epoch = $3')) {
      const k = `${params[0]}:${params[1]}`
      const row = db.pointers.get(k)
      if (!row || row.active_migration_id !== params[11] || row.migration_state !== 'migrating') {
        return { rows: [], rowCount: 0 }
      }
      row.placement_epoch = Number(params[2])
      row.migration_state = 'active'
      row.active_migration_id = null
      row.pool_kind = params[3]
      row.engine = params[4]
      if (params[12] === true) row.native_session_id = params[5]
      row.operation_id = params[6]
      row.profile_id = params[7]
      if (params[13] === true) row.capsule_id = params[8]
      if (params[14] === true) {
        row.prompt_cache_meta_json = params[9] === null ? null : JSON.parse(String(params[9]))
      }
      if (params[15] === true) {
        row.usage_baseline_json = params[10] === null ? null : JSON.parse(String(params[10]))
      }
      row.updated_at = this.nowIso(db)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    if (sql.startsWith('UPDATE session_engine_pointers SET migration_state = \'active\'')) {
      const k = `${params[0]}:${params[1]}`
      const row = db.pointers.get(k)
      if (!row || row.active_migration_id !== params[2] || row.migration_state !== 'migrating') {
        return { rows: [], rowCount: 0 }
      }
      row.migration_state = 'active'
      row.active_migration_id = null
      row.updated_at = this.nowIso(db)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    if (sql.startsWith('UPDATE session_engine_pointers SET prompt_cache_meta_json = $3')) {
      const k = `${params[0]}:${params[1]}`
      const row = db.pointers.get(k)
      if (!row || Number(row.placement_epoch) !== Number(params[3])) {
        return { rows: [], rowCount: 0 }
      }
      row.prompt_cache_meta_json = params[2] === null ? null : JSON.parse(String(params[2]))
      row.updated_at = this.nowIso(db)
      return { rows: [{ placement_epoch: row.placement_epoch }], rowCount: 1 }
    }

    // session_placement_migrations
    if (sql.startsWith('INSERT INTO session_placement_migrations')) {
      const now = this.nowIso(db)
      const row: Record<string, unknown> = {
        migration_id: String(params[0]),
        user_id: String(params[1]),
        session_key: String(params[2]),
        from_epoch: Number(params[3]),
        to_epoch: Number(params[4]),
        state: 'migrating',
        from_placement_json: JSON.parse(String(params[5])),
        to_placement_json: JSON.parse(String(params[6])),
        capsule_ref_json: null,
        continuity_tier: null,
        reason: params[7],
        created_at: now,
        completed_at: null,
      }
      db.migrations.set(String(params[0]), row)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    if (sql.includes('FROM session_placement_migrations') && sql.startsWith('SELECT')) {
      const row = db.migrations.get(String(params[0]))
      return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    if (sql.startsWith('UPDATE session_placement_migrations SET state = \'committed\'')) {
      const row = db.migrations.get(String(params[0]))
      if (!row || row.state !== 'migrating') return { rows: [], rowCount: 0 }
      row.state = 'committed'
      row.continuity_tier = params[1]
      row.capsule_ref_json = params[2] === null ? null : JSON.parse(String(params[2]))
      row.completed_at = this.nowIso(db)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    if (sql.startsWith('UPDATE session_placement_migrations SET state = \'aborted\'')) {
      const row = db.migrations.get(String(params[0]))
      if (!row || row.state !== 'migrating') return { rows: [], rowCount: 0 }
      row.state = 'aborted'
      row.reason = params[1]
      row.completed_at = this.nowIso(db)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    // model_logical_pool_bindings
    if (sql.startsWith('INSERT INTO model_logical_pool_bindings')) {
      const key = `${params[0]}::${params[1]}::${params[2]}`
      const row: Record<string, unknown> = {
        logical_model_id: String(params[0]),
        pool_kind: String(params[1]),
        driver_id: String(params[2]),
        canonical_model_id: String(params[3]),
        priority: Number(params[4]),
        capabilities_json: JSON.parse(String(params[5])),
        enabled: Boolean(params[6]),
      }
      db.bindings.set(key, row)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    if (sql.includes('FROM model_logical_pool_bindings') && sql.startsWith('SELECT')) {
      if (db.failBindingReads) {
        throw new Error('MOCK_BINDING_STORE_READ_FAILURE')
      }
      const logicalModel = String(params[0])
      const remoteOnly = sql.includes("pool_kind = 'remote_pool'")
      const enabledOnly = sql.includes('AND enabled = TRUE')
      const rows = [...db.bindings.values()]
        .filter(
          (r) =>
            r.logical_model_id === logicalModel &&
            (!enabledOnly || r.enabled === true) &&
            (!remoteOnly || r.pool_kind === 'remote_pool'),
        )
        .sort((a, b) => Number(a.priority) - Number(b.priority))
      return { rows, rowCount: rows.length }
    }

    if (sql.startsWith('UPDATE model_logical_pool_bindings SET enabled = $4')) {
      const key = `${params[0]}::${params[1]}::${params[2]}`
      const row = db.bindings.get(key)
      if (!row) return { rows: [], rowCount: 0 }
      row.enabled = Boolean(params[3])
      return { rows: [{ binding_id: 1 }], rowCount: 1 }
    }

    // session_rolling_checkpoints
    if (sql.startsWith('INSERT INTO session_rolling_checkpoints')) {
      const k = `${params[0]}:${params[1]}`
      const list = db.checkpoints.get(k) ?? []
      const now = this.nowIso(db)
      const row: Record<string, unknown> = {
        user_id: String(params[0]),
        session_key: String(params[1]),
        session_id: String(params[2]),
        checkpoint_generation: String(params[3]),
        placement_epoch: Number(params[4]),
        mode: String(params[5]),
        anchor_seq: Number(params[6]),
        source_engine: String(params[7]),
        summary: String(params[8]),
        instructions: params[9] == null ? null : String(params[9]),
        acked_by_turn_key: null,
        acked_at: null,
        created_at: now,
      }
      list.push(row)
      db.checkpoints.set(k, list)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    if (sql.includes('FROM session_rolling_checkpoints') && sql.startsWith('SELECT')) {
      const k = `${params[0]}:${params[1]}`
      const hasEpochFilter = sql.includes('placement_epoch = $3')
      const expectedEpoch = hasEpochFilter ? Number(params[2]) : undefined
      const list = (db.checkpoints.get(k) ?? [])
        .filter(
          (c) =>
            c.acked_at === null &&
            (!hasEpochFilter || Number(c.placement_epoch) === expectedEpoch),
        )
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      if (list.length === 0) return { rows: [], rowCount: 0 }
      return { rows: [{ ...list[0]! }], rowCount: 1 }
    }

    // remote_agent_bindings & remote_model_offers (B01 + B06 faithful SQL predicate execution)
    if (sql.startsWith('INSERT INTO remote_agent_bindings')) {
      const opId = String(params[0])
      const existing = db.remoteBindings.find((b) => b.operationId === opId)
      if (existing && existing.state !== 'released') {
        return { rows: [], rowCount: 0 }
      }
      const recoverySpec = JSON.parse(String(params[16])) as Record<string, unknown>
      const manifestProfileName =
        (
          (recoverySpec.spec as Record<string, unknown> | undefined)?.manifest as
            | Record<string, unknown>
            | undefined
        )?.profileId
      const nowMs = Date.parse(this.nowIso(db))
      const entry = {
        uid: String(params[2]),
        sessionKey: String(params[5]),
        operationId: opId,
        runId: String(params[1]),
        profileId: String(params[7]),
        profileName: typeof manifestProfileName === 'string' ? manifestProfileName : undefined,
        driverId: String(params[18]),
        generation: String(params[13]),
        nativeSessionId: params[9] == null ? null : String(params[9]),
        state: 'preparing',
        recoverySpec,
        updatedAtMs: nowMs,
      }
      if (existing) {
        Object.assign(existing, entry)
      } else {
        db.remoteBindings.push(entry)
      }
      return { rows: [], rowCount: 1 }
    }

    if (sql.startsWith('UPDATE remote_agent_bindings SET state = $3')) {
      const opId = String(params[0])
      const gen = String(params[1])
      const nextState = String(params[2])
      const row = db.remoteBindings.find(
        (b) =>
          b.operationId === opId &&
          String(b.generation ?? '1') === gen &&
          (nextState !== 'running' || b.state === 'preparing' || b.state === 'running'),
      )
      if (!row) return { rows: [], rowCount: 0 }
      row.state = nextState
      row.updatedAtMs = Date.parse(this.nowIso(db))
      return { rows: [], rowCount: 1 }
    }

    if (
      sql.includes('FROM remote_agent_bindings') &&
      !sql.includes('FROM request_finalize_journal') &&
      sql.startsWith('SELECT')
    ) {
      if (sql.includes('COUNT(*)::int AS profile_used')) {
        const pid = String(params[0])
        const count = db.remoteBindings.filter(
          (b) => b.profileId === pid && b.state !== 'released',
        ).length
        return { rows: [{ profile_used: count }], rowCount: 1 }
      }
      const uidStr = String(params[0])
      const sessKey = String(params[1])
      if (sql.includes("AND state <> 'released'")) {
        const active = db.remoteBindings.filter(
          (b) => b.uid === uidStr && b.sessionKey === sessKey && b.state !== 'released',
        )
        if (sql.includes('LIMIT 1')) {
          return {
            rows: active.slice(0, 1).map((b) => ({ operation_id: b.operationId })),
            rowCount: Math.min(1, active.length),
          }
        }
        return {
          rows: active.map((b) => ({
            operation_id: b.operationId,
            generation: b.generation ?? '1',
            profile_id: b.profileId ?? '',
            profile_name:
              b.profileName ??
              (
                (b.recoverySpec?.spec as Record<string, unknown> | undefined)?.manifest as
                  | Record<string, unknown>
                  | undefined
              )?.profileId ??
              null,
            state: b.state,
          })),
          rowCount: active.length,
        }
      }
      const driverId = params[2] == null ? null : String(params[2])
      const sorted = db.remoteBindings
        .filter(
          (b) =>
            b.uid === uidStr &&
            b.sessionKey === sessKey &&
            (driverId === null || b.driverId === undefined || b.driverId === driverId),
        )
        .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
      const limitMatch = /\bLIMIT\s+(\d+)/i.exec(sql)
      const limited = limitMatch ? sorted.slice(0, Number(limitMatch[1])) : sorted
      return {
        rows: limited.map((b) => ({
          operation_id: b.operationId,
          run_id: b.runId ?? 'run-sticky-1',
          profile_id: b.profileId ?? 'prof-offline-1',
          generation: b.generation ?? '1',
          native_session_id: b.nativeSessionId ?? null,
        })),
        rowCount: limited.length,
      }
    }

    if (sql.includes('FROM remote_model_offers') && sql.startsWith('SELECT')) {
      const canonicalModel = String(params[0])
      const driverId = String(params[1])
      const matched = db.remoteOffers.filter(
        (o) =>
          o.canonical_model_id === canonicalModel &&
          o.enabled !== false &&
          (o.driver_id === driverId || o.driver_id === undefined),
      )
      return { rows: matched.map((o) => ({ ...o })), rowCount: matched.length }
    }

    // request_finalize_journal (B06 authoritative pending billing query with real EXISTS predicate)
    if (sql.includes('FROM request_finalize_journal') && sql.startsWith('SELECT')) {
      const uidStr = String(params[0])
      const versions = params[1] as string[]
      const opIds = Array.isArray(params[2])
        ? (params[2] as string[])
        : params[2] == null
          ? []
          : [String(params[2])]
      const sessKey = params[3] == null ? null : String(params[3])
      const usesExistsJoin = sql.includes('EXISTS ( SELECT 1 FROM remote_agent_bindings')
      const hit = db.pendingJournals.some((j) => {
        if (j.userId !== uidStr || !versions.includes(j.version)) return false
        if (j.state !== 'inflight' && j.state !== 'finalizing') return false
        if (opIds.length > 0 && j.operationId !== undefined && opIds.includes(j.operationId)) {
          return true
        }
        if (sessKey !== null && j.sessionKey === sessKey) {
          return true
        }
        if (usesExistsJoin && sessKey !== null && j.operationId !== undefined) {
          return db.remoteBindings.some(
            (b) => b.uid === uidStr && b.sessionKey === sessKey && b.operationId === j.operationId,
          )
        }
        return false
      })
      return hit ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    throw new Error(`Unexpected SQL in MockThreeLayerPgPool: ${sql}`)
  }
}

function makeCatalogSnapshot(entries: readonly ModelCatalogEntry[]): ModelCatalogSnapshot {
  const pricing = new Map<string, ModelCatalogPricing>()
  for (const e of entries) {
    pricing.set(e.modelId, {
      modelId: e.modelId,
      displayName: e.modelId,
      inputPerMtok: 100n,
      outputPerMtok: 200n,
      cacheReadPerMtok: 10n,
      cacheWritePerMtok: 25n,
      multiplier: '1',
      visibility: 'public',
      sortOrder: 1,
      defaultEffort: 'medium',
    })
  }
  return new ModelCatalogSnapshot({
    entries,
    aliases: new Map(),
    pricing,
    securityEpoch: 7n,
  })
}

function makeCatalogEntry(args: {
  entryId: number
  modelId: string
  engine: ModelCatalogEntry['engine']
  placement: 'local' | 'remote_pool'
  supportsVision?: boolean
  supportsThinking?: boolean
  supportedEfforts?: ('low' | 'medium' | 'high')[]
}): ModelCatalogEntry {
  return {
    entryId: args.entryId,
    modelId: args.modelId,
    engine: args.engine,
    providerId: args.engine === 'ccb' ? 'anthropic' : args.engine,
    upstreamModelId: args.modelId.replace(/-remote$/, ''),
    contextWindow: 200_000,
    capabilityProfile: {
      supportsVision: args.supportsVision ?? true,
      reasoning: {
        supported: args.supportedEfforts ?? ['low', 'medium', 'high'],
        codexModelDefault: null,
      },
      ccb: {
        capabilityZero: true,
        supportsThinking: args.supportsThinking ?? true,
      },
    },
    capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
    state: 'active',
    lockVersion: 1,
    placement: args.placement,
  }
}

function matchesLegacyJournalRow(
  ctx: Record<string, unknown>,
  recoveryVersions: readonly string[],
  backendKinds: readonly string[],
): boolean {
  const recovery = ctx.remoteNativeBillingRecovery
  const recoveryStr = typeof recovery === 'string' ? recovery : null
  const recoveryNestedVersion =
    recovery && typeof recovery === 'object' && !Array.isArray(recovery)
      ? (recovery as Record<string, unknown>).version
      : null
  const effectiveVersion =
    typeof recoveryNestedVersion === 'string'
      ? recoveryNestedVersion
      : typeof recoveryStr === 'string'
        ? recoveryStr
        : ''
  const flatRecovery = typeof ctx.recoveryVersion === 'string' ? ctx.recoveryVersion : null
  const execBackendKind =
    ctx.executionBackend && typeof ctx.executionBackend === 'object'
      ? (ctx.executionBackend as Record<string, unknown>).kind
      : null
  const remoteNativeBackendKind =
    ctx.remoteNative &&
    typeof ctx.remoteNative === 'object' &&
    (ctx.remoteNative as Record<string, unknown>).scope &&
    typeof (ctx.remoteNative as Record<string, unknown>).scope === 'object'
      ? ((ctx.remoteNative as Record<string, unknown>).scope as Record<string, unknown>).backendKind
      : null

  return (
    (recoveryStr !== null && recoveryVersions.includes(recoveryStr)) ||
    (typeof recoveryNestedVersion === 'string' &&
      recoveryVersions.includes(recoveryNestedVersion)) ||
    (flatRecovery !== null && recoveryVersions.includes(flatRecovery)) ||
    (Object.hasOwn(ctx, 'remoteNativeBillingRecovery') &&
      effectiveVersion !== REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION) ||
    (Object.hasOwn(ctx, 'remoteNative') &&
      effectiveVersion !== REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION) ||
    (typeof execBackendKind === 'string' && backendKinds.includes(execBackendKind)) ||
    (typeof remoteNativeBackendKind === 'string' && backendKinds.includes(remoteNativeBackendKind))
  )
}

describe('OCV5-890 B01/B05/B14 production wiring end-to-end verification', () => {
  it('B01 positive 3-turn loop via real resolveRemotePoolBackendAndSeal + placeRemoteDriverLane: Turn 1 remote -> Turn 2 fallback + Turn 2b local reuse (no epoch bump) -> Turn 3 remote recovery with live running lane & honest continuityTier', async () => {
    const pgPool = new MockThreeLayerPgPool()
    const authorityStore = new PgSessionAuthorityStateStore(pgPool)
    const bindingStore = new PgLogicalModelBindingStore(pgPool)
    const nowMs = Date.now()
    const ccReg = loadRemoteDriverRegistry().get('cc')!
    const policySha256 = '1'.repeat(64)
    const probeSnapshot: RemoteProbeSnapshot = {
      schemaVersion: REMOTE_DRIVER_PROTOCOL_VERSION,
      engineId: ccReg.engineId,
      driverId: ccReg.driverId,
      driverVersion: ccReg.driverVersion,
      source: 'cli:probe',
      freshness: 'cli-observed',
      authPresent: true,
      accountObserved: true,
      cliVersion: '2.1.0',
      cliSha256: '2'.repeat(64),
      rawResponseSha256: '3'.repeat(64),
      observedAt: new Date(nowMs).toISOString(),
      models: [
        {
          upstreamModelId: 'claude-opus-4-6',
          displayName: 'Claude Opus 4.6',
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          supportsAdaptiveThinking: true,
          supportsVision: true,
        },
      ],
    }
    const verifiedFp = computeProbeFingerprintTs(probeSnapshot, {
      driverDigest: ccReg.driverDigest,
      coreDigest: ccReg.coreDigest,
      policySha256,
    })
    const makeHealthyOffer = () => ({
      profile_id: '11111111-1111-4111-8111-111111111111',
      node_id: '22222222-2222-4222-8222-222222222222',
      offer_id: '33333333-3333-4333-8333-333333333333',
      engine: 'cc5',
      driver_id: 'cc',
      profile_name: 'prof-remote-1',
      upstream_model_id: 'claude-opus-4-6',
      canonical_model_id: 'claude-opus-4-6-remote',
      enabled: true,
      execution_ready: true,
      verified_fingerprint: verifiedFp,
      probe_snapshot: probeSnapshot,
      execution_manifest: { policySha256 },
      last_probe_ok_at: new Date(nowMs).toISOString(),
      max_concurrent_lanes: 4,
      weight: 100,
      health_score: 100,
      hot_slots: 0,
      active_slots: 0,
      max_hot_slots: 8,
      auth_epoch: 'epoch-1',
      label: 'node-remote-1',
      ssh_host: '127.0.0.1',
      ssh_port: 22,
      ssh_user: 'agent',
      host_key_fp: 'SHA256:testfp',
      key_id: 'rpoolv4',
      rtt_ms_p50: 25,
      node_status: 'active',
    })
    pgPool.state.remoteOffers.push(makeHealthyOffer())

    const logicalCaps: LogicalModelCapability = {
      logicalModel: 'claude-opus-4-6',
      upstreamModelId: 'claude-opus-4-6',
      supportsVision: true,
      supportedEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
      supportedServiceTiers: ['standard'],
      supportsReadOnly: true,
      supportsConsultTurn: true,
      supportsHermeticNoTools: true,
      supportsSwarm: true,
      supportsAdaptiveThinking: true,
      contextWindow: 200_000,
    }
    await bindingStore.upsertPoolBinding({
      logicalModelId: 'claude-opus-4-6',
      poolKind: 'remote_pool',
      driverId: 'cc',
      canonicalModelId: 'claude-opus-4-6-remote',
      priority: 1,
      capabilities: logicalCaps,
      enabled: true,
    })
    await bindingStore.upsertPoolBinding({
      logicalModelId: 'claude-opus-4-6',
      poolKind: 'local_pool',
      driverId: 'local-cc',
      canonicalModelId: 'claude-opus-4-6',
      priority: 2,
      capabilities: logicalCaps,
      enabled: true,
    })

    const snapshot = makeCatalogSnapshot([
      makeCatalogEntry({
        entryId: 1,
        modelId: 'claude-opus-4-6-remote',
        engine: 'ccb',
        placement: 'remote_pool',
      }),
      makeCatalogEntry({
        entryId: 2,
        modelId: 'claude-opus-4-6',
        engine: 'ccb',
        placement: 'local',
      }),
    ])
    const catalogCache = { assertFresh: async () => snapshot }
    const bootstrapHooks = buildSelfhostCrossPoolBridgeHooks({
      isSelfhostV5: true,
      pool: pgPool,
      modelCatalogCache: catalogCache,
    })

    const uid = 42
    const containerId = 99
    const dockerId = 'a'.repeat(64)
    const sessionKey = 'agent:main:webchat:dm:prod-e2e-3turn'

    const signer = AuthoritySigner.createEphemeral()
    const keyring = parseAuthorityKeyring(signer.publicKeyringEnv())
    const consumer = new ModelAuthorityConsumer({
      keyring,
      uid,
      containerId,
      required: true,
    })
    const makeSealExec = (modelId: string) => {
      const desc = snapshot.resolve(modelId)!
      return {
        canonicalModel: desc.canonicalModel,
        engine: desc.engine,
        placement: desc.placement === 'remote_pool' ? ('remote_pool' as const) : ('local' as const),
        securityEpoch: Number(snapshot.securityEpoch),
        descriptor: {
          capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
          contextWindow: desc.contextWindow,
          supportsVision: desc.capabilityProfile.supportsVision,
          supportedEfforts: [...desc.capabilityProfile.reasoning.supported],
          capabilityProfile: JSON.parse(JSON.stringify(desc.capabilityProfile)),
        },
      }
    }
    const signExec = (
      exec: ReturnType<typeof makeSealExec>,
      billingRequestId?: string,
      authorityTurnId?: string,
      executionBackend?: Parameters<AuthoritySigner['signBundle']>[0]['executionBackend'],
      poolMigration?: Parameters<AuthoritySigner['signBundle']>[0]['poolMigration'],
    ) =>
      signer.signBundle({
        uid,
        containerId,
        connectionChallenge: 'conn-challenge-e2e-1',
        canonicalModel: exec.canonicalModel,
        engine: exec.engine,
        executionDescriptor: exec.descriptor,
        auxModels: [],
        ...(executionBackend ? { executionBackend } : {}),
        ...(poolMigration ? { poolMigration } : {}),
        ...(authorityTurnId ? { authorityTurnId } : {}),
        ...(billingRequestId ? { billingRequestId } : {}),
        executionRevision: 'rev-e2e-1',
        securityEpoch: exec.securityEpoch,
      }).bundle

    // Production-equivalent backend selector: places via REAL `placeRemoteDriverLane` and transitions
    // the new lane binding to `running` via REAL `recordRemoteDriverLaneState` before returning backend!
    const cc5BackendSelector = async (req: {
      uid: number
      containerId: number
      sessionKey: string
      canonicalModel: string
    }) => {
      const placed = await placeRemoteDriverLane(
        {
          uid: req.uid,
          containerDbId: String(req.containerId),
          dockerId,
          sessionKey: req.sessionKey,
          canonicalModel: req.canonicalModel,
          driverId: 'cc',
        },
        {
          pool: pgPool as unknown as Pool,
          now: () => nowMs,
          localSandboxDir: '/tmp/oc-drvtest-e2e-seal',
        },
      )
      await recordRemoteDriverLaneState(
        placed.binding.operationId,
        placed.generation,
        'running',
        pgPool as unknown as Pool,
      )
      return remotePoolBackendOf(placed.binding)
    }

    // ── Turn 1: Real remote_pool placement & seal via resolveRemotePoolBackendAndSeal ──
    const turn1Sealed = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeSealExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector,
      crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
      returnToRemoteGrantResolver: bootstrapHooks.returnToRemoteGrantResolver,
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(turn1Sealed !== null)
    const verifiedTurn1 = consumer.consume(turn1Sealed, { challenge: 'conn-challenge-e2e-1' })
    assert.ok(verifiedTurn1.executionBackend !== undefined)
    assert.equal(verifiedTurn1.poolMigration, undefined)
    const turn1OpId = verifiedTurn1.executionBackend.operationId
    const storedRemoteResume = remoteV4ResumeId(turn1OpId, 'native-turn-1')

    // Persist PG pointer (epoch=1, remote_pool) + rolling checkpoint at epoch=1, and release Turn 1 lane
    const ptrTurn1 = await authorityStore.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: 'remote_pool',
      engine: 'ccb',
      nativeSessionId: 'native-turn-1',
      operationId: turn1OpId,
      profileId: 'prof-remote-1',
      capsuleId: 'a'.repeat(64),
      usageBaseline: { inputTokens: 800, outputTokens: 200 },
    })
    assert.equal(ptrTurn1.placementEpoch, 1)
    assert.equal(ptrTurn1.poolKind, 'remote_pool')
    await recordRemoteDriverLaneState(turn1OpId, '1', 'released', pgPool as unknown as Pool)

    // Persist a real rolling checkpoint during Turn 1 so fallback honestly proves `tape_rebuilt`
    await authorityStore.saveRollingCheckpoint({
      userId: uid,
      sessionKey,
      sessionId: 'sess-e2e-1',
      expectedPlacementEpoch: 1,
      mode: 'anchored_v2',
      anchorSeq: 12,
      sourceEngine: 'ccb',
      summary: 'Turn 1 summarized workspace README.md',
    })

    const leaseMgr = new ExecEnvLeaseManager()
    const lease1 = leaseMgr.issueLease({
      execEnvId: 'exec-env-e2e-1',
      incarnationId: 'inc-1',
      tenantId: String(uid),
      sessionKey,
      placementEpoch: 1,
      brainGen: 1,
    })
    const toolArgsSchema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    let toolRunCount = 0
    const broker = new ToolBrokerServer({
      leaseManager: leaseMgr,
      requireFencingToken: true,
    })
    broker.registerTool({
      canonicalName: 'read_file',
      description: 'Read a workspace file',
      inputSchema: toolArgsSchema,
      readOnly: true,
      handler: (args) => {
        toolRunCount += 1
        return { content: `read:${String(args.path)}`, run: toolRunCount }
      },
    })

    const turn1Args = { path: 'README.md' }
    const turn1Sha = computeSchemaFilteredArgsSha256(turn1Args, toolArgsSchema)
    const turn1Res = await broker.invoke({
      schemaVersion: 1,
      leaseId: lease1.leaseId,
      fencingToken: lease1.fencingToken,
      brainGen: 1,
      sessionKey,
      turnId: 'turn-e2e-0001',
      callId: 'call-e2e-0001',
      canonicalName: 'read_file',
      arguments: turn1Args,
      argsSha256: turn1Sha,
      idempotencyKey: computeToolIdempotencyKey(lease1.leaseId, 'turn-e2e-0001', 'call-e2e-0001'),
      attestation: {
        kind: 'schema_filtered_hook',
        argsSha256: turn1Sha,
        observedAt: new Date().toISOString(),
      },
    })
    assert.equal(turn1Res.status, 'ok')
    assert.equal(toolRunCount, 1)

    // ── Turn 2: remote_pool fails pre-dispatch (0 healthy remote offers) -> 2-phase fallback via real seal ──
    pgPool.state.remoteOffers.length = 0
    const selector = bootstrapHooks.crossPoolFallbackSelector!

    // Turn 2a (B01 Stage-1 rejection): target descriptor rejected before begin -> ZERO PG writes!
    const rejectedStage1 = await selector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'),
      expectedSecurityEpoch: 7,
      validateTargetSignable: async () => false,
    })
    assert.equal(rejectedStage1, null)
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.migrationState, 'active')
    assert.equal(pgPool.state.migrations.size, 0)

    // Turn 2b (B01 Stage-2 rejection + honest continuityTier without verifier):
    // Even though an unacked checkpoint exists at epoch 1, WITHOUT verifyContinuityApplied proof
    // the prepared grant MUST honestly report `cold_degraded` (NEVER fake `tape_rebuilt`)!
    let abortedMidMigrationId = ''
    let unverifiedTierSeen: string | undefined
    const rejectedStage2 = await selector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'),
      expectedSecurityEpoch: 7,
      validateTargetSignable: async () => true,
      beforeCommit: async (prepared) => {
        abortedMidMigrationId = prepared.migrationGrant.migrationId
        unverifiedTierSeen = prepared.migrationGrant.continuityTier
        const midPtr = await authorityStore.getEnginePointer(uid, sessionKey)
        assert.equal(midPtr?.placementEpoch, 1)
        assert.equal(midPtr?.migrationState, 'migrating')
        return false
      },
    })
    assert.equal(rejectedStage2, null)
    assert.equal(
      unverifiedTierSeen,
      'cold_degraded',
      'B01: peeking a checkpoint without verifyContinuityApplied proof must report cold_degraded',
    )
    const ptrAfterAbort = await authorityStore.getEnginePointer(uid, sessionKey)
    assert.equal(ptrAfterAbort?.placementEpoch, 1, 'rejected signing must NEVER advance PG epoch')
    assert.equal(ptrAfterAbort?.poolKind, 'remote_pool')
    assert.equal(ptrAfterAbort?.migrationState, 'active')
    assert.equal((await authorityStore.getPlacementMigration(abortedMidMigrationId))?.state, 'aborted')

    // Turn 2c (positive): real `resolveRemotePoolBackendAndSeal` triggers fallback when remote fails,
    // validates local target + signs Ed25519 bundle BEFORE PG commits, and commits epoch 1 -> 2!
    const turn2Sealed = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeSealExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector,
      crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
      returnToRemoteGrantResolver: bootstrapHooks.returnToRemoteGrantResolver,
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(turn2Sealed !== null, 'Turn 2 fallback via resolveRemotePoolBackendAndSeal must succeed')
    assert.equal(turn2Sealed.model, 'claude-opus-4-6')

    const verifiedTurnAuthority = consumer.consume(turn2Sealed, { challenge: 'conn-challenge-e2e-1' })
    assert.ok(verifiedTurnAuthority.poolMigration !== undefined)
    assert.equal(verifiedTurnAuthority.poolMigration.allowBackendTransition, true)
    assert.equal(verifiedTurnAuthority.poolMigration.placementEpoch, 2)
    assert.equal(
      verifiedTurnAuthority.poolMigration.continuityTier,
      'cold_degraded',
      'B01: without continuity application proof, bootstrap fallback must publish cold_degraded',
    )

    // Verify PG pointer CAS atomically moved to epoch=2, local_container while preserving metadata
    const ptrTurn2 = await authorityStore.getEnginePointer(uid, sessionKey)
    assert.ok(ptrTurn2 !== null)
    assert.equal(ptrTurn2.placementEpoch, 2)
    assert.equal(ptrTurn2.poolKind, 'local_container')
    assert.equal(ptrTurn2.migrationState, 'active')
    assert.equal(ptrTurn2.nativeSessionId, 'native-turn-1')
    assert.equal(ptrTurn2.capsuleId, 'a'.repeat(64))
    assert.deepEqual(ptrTurn2.usageBaseline, { inputTokens: 800, outputTokens: 200 })
    const migRecord = await authorityStore.getPlacementMigration(
      verifiedTurnAuthority.poolMigration.migrationId,
    )
    assert.equal(migRecord?.state, 'committed')
    assert.equal(migRecord?.fromEpoch, 1)
    assert.equal(migRecord?.toEpoch, 2)

    const localExecDesc = snapshot.resolve('claude-opus-4-6')!
    const localCapProfile = JSON.parse(JSON.stringify(localExecDesc.capabilityProfile))
    const signedTurn2Bundle = turn2Sealed[MODEL_AUTHORITY_FIELD] as ReturnType<
      AuthoritySigner['signBundle']
    >['bundle']

    // Unsigned top-level poolMigration field on a frame MUST be ignored when not signed in bundle
    const mintedWithoutGrant = signer.signBundle({
      uid,
      containerId,
      connectionChallenge: 'conn-challenge-e2e-1',
      canonicalModel: localExecDesc.canonicalModel,
      engine: 'ccb',
      executionDescriptor: {
        capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
        contextWindow: localExecDesc.contextWindow,
        supportsVision: localExecDesc.capabilityProfile.supportsVision,
        supportedEfforts: [...localExecDesc.capabilityProfile.reasoning.supported],
        capabilityProfile: localCapProfile,
      },
      auxModels: [],
      executionRevision: 'rev-e2e-1',
      securityEpoch: 7,
    })
    const verifiedWithoutGrant = consumer.consume(
      {
        model: localExecDesc.canonicalModel,
        poolMigration: verifiedTurnAuthority.poolMigration,
        [MODEL_AUTHORITY_FIELD]: mintedWithoutGrant.bundle,
      },
      { challenge: 'conn-challenge-e2e-1' },
    )
    assert.equal(verifiedWithoutGrant.poolMigration, undefined)

    // Tampered authority envelope with modified poolMigration MUST be cryptographically rejected
    const tamperedEnvelope = JSON.parse(
      Buffer.from(signedTurn2Bundle.authority, 'base64url').toString('utf8'),
    ) as { payload: { poolMigration: { placementEpoch: number } } }
    tamperedEnvelope.payload.poolMigration.placementEpoch = 999
    const tamperedAuthority = Buffer.from(JSON.stringify(tamperedEnvelope), 'utf8').toString('base64url')
    assert.throws(
      () =>
        consumer.consume(
          {
            model: localExecDesc.canonicalModel,
            [MODEL_AUTHORITY_FIELD]: { authority: tamperedAuthority, lease: signedTurn2Bundle.lease },
          },
          { challenge: 'conn-challenge-e2e-1' },
        ),
      (err: unknown) => err instanceof AuthorityRejected && err.code === 'verify_fail',
    )

    // ── Turn 2d (OCV5-893 B3 + B01 continued remote outage):
    // Before container confirms installation (`markPlacementMigrationInstalled`), retrying while
    // already on local_container MUST re-deliver the EXACT committed migrationGrant (even though
    // `nativeSessionId` is non-null!) without bumping placementEpoch or starting a new migration.
    // Once `markPlacementMigrationInstalled` clears `pendingInstallMigration`, subsequent local
    // reuse omits the grant for pure local continuation! ──
    const migrationsCountBeforeReuse = pgPool.state.migrations.size
    const turn2RedeliverSealed = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeSealExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector,
      crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
      returnToRemoteGrantResolver: bootstrapHooks.returnToRemoteGrantResolver,
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(turn2RedeliverSealed !== null)
    const verifiedRedeliver = consumer.consume(turn2RedeliverSealed, { challenge: 'conn-challenge-e2e-1' })
    assert.equal(
      verifiedRedeliver.poolMigration?.migrationId,
      verifiedTurnAuthority.poolMigration.migrationId,
      'B3: before installation is marked, retry must re-deliver exact committed migrationGrant even when nativeSessionId is non-null',
    )
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 2)
    assert.equal(pgPool.state.migrations.size, migrationsCountBeforeReuse)

    assert.equal(
      await authorityStore.markPlacementMigrationInstalled(
        uid,
        sessionKey,
        2,
        verifiedTurnAuthority.poolMigration.migrationId,
      ),
      true,
    )
    // Idempotent second call returns false
    assert.equal(
      await authorityStore.markPlacementMigrationInstalled(
        uid,
        sessionKey,
        2,
        verifiedTurnAuthority.poolMigration.migrationId,
      ),
      false,
    )

    const turn2ReuseSealed = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeSealExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector,
      crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
      returnToRemoteGrantResolver: bootstrapHooks.returnToRemoteGrantResolver,
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(turn2ReuseSealed !== null, 'continued outage while on local_container must directly reuse local placement')
    assert.equal(turn2ReuseSealed.model, 'claude-opus-4-6')
    const verifiedReuse = consumer.consume(turn2ReuseSealed, { challenge: 'conn-challenge-e2e-1' })
    assert.equal(verifiedReuse.poolMigration, undefined, 'after installation confirmed, same-pool local reuse must NOT re-issue migrationGrant')
    assert.equal(verifiedReuse.executionBackend, undefined)
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 2, 'same-pool local reuse must NOT bump placementEpoch')
    assert.equal(pgPool.state.migrations.size, migrationsCountBeforeReuse, 'same-pool local reuse must NOT begin a new migration')

    // Verify gateway session admission accepts the cryptographically verified migrationGrant
    const backendAfterMigration = cc5SessionBackend({
      executionAuthority: { source: 'bridge_signed', executionBackend: undefined },
      engineId: 'ccb',
      executionModel: 'claude-opus-4-6-remote',
      sessionKey,
      storedResumeId: storedRemoteResume,
      poolMigration: verifiedTurnAuthority.poolMigration,
    })
    assert.equal(backendAfterMigration, undefined)

    await assertFreshCc5Session({
      storedResumeId: storedRemoteResume,
      executionBackend: undefined,
      sessionIds: [sessionKey],
      hasPersistedTurnActivity: async () => true,
      poolMigration: verifiedTurnAuthority.poolMigration,
    })

    // Rebind the SAME ExecEnv lease to brainGen=2 for the local brain, execute tool, reject stale token
    leaseMgr.quiesceBrain(lease1.leaseId)
    const rebound = await leaseMgr.rebindBrain(lease1.leaseId, 2, 'ft_local_brain_gen_2')
    assert.equal(rebound.lease.leaseId, lease1.leaseId)
    assert.equal(rebound.lease.brainGen, 2)

    const turn2Args = { path: 'src/index.ts' }
    const turn2Sha = computeSchemaFilteredArgsSha256(turn2Args, toolArgsSchema)
    const turn2Res = await broker.invoke({
      schemaVersion: 1,
      leaseId: lease1.leaseId,
      fencingToken: rebound.lease.fencingToken,
      brainGen: 2,
      sessionKey,
      turnId: 'turn-e2e-0002',
      callId: 'call-e2e-0002',
      canonicalName: 'read_file',
      arguments: turn2Args,
      argsSha256: turn2Sha,
      idempotencyKey: computeToolIdempotencyKey(lease1.leaseId, 'turn-e2e-0002', 'call-e2e-0002'),
      attestation: {
        kind: 'schema_filtered_hook',
        argsSha256: turn2Sha,
        observedAt: new Date().toISOString(),
      },
    })
    assert.equal(turn2Res.status, 'ok')
    assert.equal(toolRunCount, 2)

    // Stale Turn 1 fencing token MUST be rejected with zero side effects
    const staleRes = await broker.invoke({
      schemaVersion: 1,
      leaseId: lease1.leaseId,
      fencingToken: lease1.fencingToken,
      brainGen: 1,
      sessionKey,
      turnId: 'turn-e2e-stale',
      callId: 'call-e2e-stale',
      canonicalName: 'read_file',
      arguments: turn2Args,
      argsSha256: turn2Sha,
      idempotencyKey: computeToolIdempotencyKey(lease1.leaseId, 'turn-e2e-stale', 'call-e2e-stale'),
      attestation: {
        kind: 'schema_filtered_hook',
        argsSha256: turn2Sha,
        observedAt: new Date().toISOString(),
      },
    })
    assert.equal(staleRes.status, 'denied')
    assert.equal(staleRes.errorCode, 'EXEC_FENCING_TOKEN_STALE')
    assert.equal(toolRunCount, 2)

    // ── Turn 3: remote_pool recovers -> REAL placeRemoteDriverLane writes `running` row -> resolveRemotePoolBackendAndSeal returns to remote! ──
    pgPool.state.remoteOffers.push(makeHealthyOffer())

    // Save a fresh rolling checkpoint at epoch=2 (current source epoch for return-to-remote)
    const cpEpoch2 = await authorityStore.saveRollingCheckpoint({
      userId: uid,
      sessionKey,
      sessionId: 'sess-e2e-1',
      expectedPlacementEpoch: 2,
      mode: 'anchored_v2',
      anchorSeq: 24,
      sourceEngine: 'ccb',
      summary: 'Turn 2 local summary ready for verified handoff',
    })

    // Turn 3a (negative): if ANOTHER stale `running` binding exists for a different operationId,
    // return-to-remote MUST STILL FAIL CLOSED (`return_to_remote_blocked`) and NOT advance PG epoch!
    const staleOtherOp = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    pgPool.state.remoteBindings.push({
      uid: String(uid),
      sessionKey,
      operationId: staleOtherOp,
      profileId: '99999999-9999-4999-8999-999999999999',
      profileName: 'prof-stale-old',
      driverId: 'cc',
      generation: '1',
      state: 'running',
      updatedAtMs: nowMs - 60_000,
    })
    let rejectedReturnReason = ''
    const blockedByStaleRunning = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeSealExec('claude-opus-4-6-remote'),
      log: null,
      // Simulate backend selector returning a new turn's backend while a stale running row still exists
      cc5BackendSelector: async () =>
        Object.freeze({
          kind: REMOTE_DRIVER_BACKEND,
          version: 4 as const,
          driverId: 'cc',
          driverVersion: '5.0.0',
          engineId: ccReg.engineId,
          authorityEngine: 'ccb' as const,
          sessionKey,
          operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          generation: '1',
          profileId: 'prof-remote-1',
          authEpoch: 'epoch-1',
        }),
      crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
      returnToRemoteGrantResolver: bootstrapHooks.returnToRemoteGrantResolver,
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async (_code, _msg, reason) => {
        rejectedReturnReason = reason
        return null
      },
    })
    assert.equal(blockedByStaleRunning, null)
    assert.equal(rejectedReturnReason, 'return_to_remote_blocked')
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 2)
    // Remove synthetic stale row so only real Turn 1 (released) exists before real Turn 3 placement
    pgPool.state.remoteBindings = pgPool.state.remoteBindings.filter(
      (b) => b.operationId !== staleOtherOp,
    )

    // Turn 3b (positive): REAL `placeRemoteDriverLane` + `recordRemoteDriverLaneState('running')`
    // writes this turn's `running` row inside `cc5BackendSelector`; `returnToRemoteGrantResolver`
    // excuses ONLY this turn's exact (operationId, generation, profileId) triple (zero self-blocking!),
    // verifies continuity via explicit `verifyContinuityApplied`, signs BEFORE commit, and advances epoch 2 -> 3!
    let verifiedCheckpointId = ''
    const verifiedReturnResolver = createSelfhostReturnToRemoteGrantResolver({
      pool: pgPool,
      selfhost: true,
      verifyContinuityApplied: async (ctx) => {
        assert.equal(ctx.sourcePlacementEpoch, 2)
        assert.equal(ctx.checkpoint.checkpointGeneration, cpEpoch2.checkpointGeneration)
        verifiedCheckpointId = ctx.checkpoint.checkpointGeneration
        return { applied: true, checkpointId: ctx.checkpoint.checkpointGeneration }
      },
    })
    const turn3Sealed = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      exec: makeSealExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector,
      crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
      returnToRemoteGrantResolver: verifiedReturnResolver,
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(turn3Sealed !== null, 'Turn 3 return-to-remote via real placeRemoteDriverLane + seal must NOT self-block')
    assert.equal(verifiedCheckpointId, cpEpoch2.checkpointGeneration)

    const verifiedTurn3 = consumer.consume(turn3Sealed, { challenge: 'conn-challenge-e2e-1' })
    assert.ok(verifiedTurn3.executionBackend !== undefined)
    assert.ok(verifiedTurn3.poolMigration !== undefined)
    assert.equal(verifiedTurn3.poolMigration.placementEpoch, 3)
    assert.equal(verifiedTurn3.poolMigration.allowBackendTransition, true)
    assert.equal(verifiedTurn3.poolMigration.continuityTier, 'tape_rebuilt')

    const ptrTurn3 = await authorityStore.getEnginePointer(uid, sessionKey)
    assert.equal(ptrTurn3?.placementEpoch, 3)
    assert.equal(ptrTurn3?.poolKind, 'remote_pool')
    assert.equal(ptrTurn3?.operationId, verifiedTurn3.executionBackend.operationId)
    assert.equal(ptrTurn3?.profileId, 'prof-remote-1')
    assert.equal(ptrTurn3?.nativeSessionId, 'native-turn-1', 'commitPlacementMigration must preserve nativeSessionId')
    assert.equal(ptrTurn3?.capsuleId, 'a'.repeat(64), 'commitPlacementMigration must preserve capsuleId')
    assert.deepEqual(ptrTurn3?.usageBaseline, { inputTokens: 800, outputTokens: 200 })

    // Verify Turn 3 gateway admission succeeds WITH grant and STILL throws WITHOUT grant!
    await assertFreshCc5Session({
      storedResumeId: undefined,
      executionBackend: verifiedTurn3.executionBackend,
      sessionIds: [sessionKey],
      hasPersistedTurnActivity: async () => true,
      poolMigration: verifiedTurn3.poolMigration,
    })
    await assert.rejects(
      () =>
        assertFreshCc5Session({
          storedResumeId: undefined,
          executionBackend: verifiedTurn3.executionBackend,
          sessionIds: [sessionKey],
          hasPersistedTurnActivity: async () => true,
        }),
      /CC5_BACKEND_REQUIRES_NEW_SESSION/,
    )
  })

  it('N01 + B06 + B01-R2: bootstrap implicit pool selector blocks when all configured bindings are disabled, on binding read error, on catalog epoch drift, or while pending billing journal exists; honest cold_degraded when no checkpoint exists', async () => {
    const pgPool = new MockThreeLayerPgPool()
    const authorityStore = new PgSessionAuthorityStateStore(pgPool)
    const bindingStore = new PgLogicalModelBindingStore(pgPool)
    const uid = 77
    const containerId = 101
    const sessionKey = 'agent:main:webchat:dm:n01-b06-bootstrap'
    const opId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

    const snap = makeCatalogSnapshot([
      makeCatalogEntry({
        entryId: 1,
        modelId: 'claude-opus-4-6-remote',
        engine: 'ccb',
        placement: 'remote_pool',
      }),
      makeCatalogEntry({
        entryId: 2,
        modelId: 'claude-opus-4-6',
        engine: 'ccb',
        placement: 'local',
      }),
    ])
    const catalogCache = { assertFresh: async () => snap }

    // Real chatBridgeBootstrap.ts implicit wiring: ONLY `{ isSelfhostV5, pool, modelCatalogCache }` (no explicit bindingStore)
    const bootstrapHooks = buildSelfhostCrossPoolBridgeHooks({
      isSelfhostV5: true,
      pool: pgPool,
      modelCatalogCache: catalogCache,
    })
    const bootstrapSelector = bootstrapHooks.crossPoolFallbackSelector!

    // Pointer has history but NO operationId (simulating Turn 1 placed only via remote_agent_bindings)
    // and NO rolling checkpoint (so continuityTier must stay `cold_degraded`, never fake `tape_rebuilt`).
    await authorityStore.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: 'remote_pool',
      engine: 'ccb',
      history: ['old-remote-native-id-1'],
    })
    // B06 > 16 historical bindings regression: seed 25 historical `released` bindings so the
    // oldest binding (`opId`, index 0) falls well beyond any `LIMIT 16` window!
    pgPool.state.remoteBindings.push({
      uid: String(uid),
      sessionKey,
      operationId: opId,
      profileId: 'prof-offline-oldest',
      driverId: 'cc',
      state: 'released',
      updatedAtMs: 1_000,
    })
    for (let i = 1; i <= 24; i += 1) {
      const hex = i.toString(16).padStart(12, '0')
      pgPool.state.remoteBindings.push({
        uid: String(uid),
        sessionKey,
        operationId: `00000000-0000-4000-8000-${hex}`,
        profileId: 'prof-offline-1',
        driverId: 'cc',
        state: 'released',
        updatedAtMs: 1_000 + i * 1_000,
      })
    }

    // 0) N01: Never-configured logical model (`totalCount === 0`) passes strict catalog+superset gate
    const unconfiguredFallback = await bootstrapSelector({
      uid,
      containerId,
      sessionKey: `${sessionKey}:unconfigured`,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_UNAVAILABLE'),
      expectedSecurityEpoch: 7,
    })
    assert.ok(unconfiguredFallback !== null, 'N01: unconfigured model with matching local catalog entry must succeed')
    assert.equal(unconfiguredFallback.migrationGrant?.placementEpoch, 2)

    // 1) N01: Configure local_pool binding, then explicitly disable the LAST enabled binding -> MUST REJECT!
    await bindingStore.upsertPoolBinding({
      logicalModelId: 'claude-opus-4-6',
      poolKind: 'local_pool',
      driverId: 'local-cc',
      canonicalModelId: 'claude-opus-4-6',
      priority: 1,
      capabilities: {
        logicalModel: 'claude-opus-4-6',
        upstreamModelId: 'claude-opus-4-6',
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
        supportedServiceTiers: ['standard'],
        supportsReadOnly: true,
        supportsConsultTurn: true,
        supportsHermeticNoTools: true,
        supportsSwarm: true,
        supportsAdaptiveThinking: true,
        contextWindow: 200_000,
      },
      enabled: true,
    })
    assert.equal(await bindingStore.setPoolBindingEnabled('claude-opus-4-6', 'local_pool', 'local-cc', false), true)
    const deniedDisabled = await bootstrapSelector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_UNAVAILABLE'),
      expectedSecurityEpoch: 7,
    })
    assert.equal(deniedDisabled, null, 'N01: disabling last configured binding must NOT degrade to unconfigured fallback')
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)

    // 2) N01: Binding-store read error -> MUST fail closed and NOT advance epoch
    await bindingStore.setPoolBindingEnabled('claude-opus-4-6', 'local_pool', 'local-cc', true)
    pgPool.state.failBindingReads = true
    const deniedReadErr = await bootstrapSelector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_UNAVAILABLE'),
      expectedSecurityEpoch: 7,
    })
    assert.equal(deniedReadErr, null, 'N01: binding read failure must fail closed')
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)
    pgPool.state.failBindingReads = false

    // 3) B01-R2: Catalog securityEpoch mismatch -> MUST fail BEFORE mutating PG epoch
    const deniedEpochDrift = await bootstrapSelector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_UNAVAILABLE'),
      expectedSecurityEpoch: 99,
    })
    assert.equal(deniedEpochDrift, null)
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)

    // 4) B06-R2 real combination:
    //    `released` remote binding (operationId=opId) + `inflight` billing journal referencing ONLY operationId
    //    (NO sessionKey in ctx, NO operationId on session_engine_pointers!) + 0 healthy remote profiles + eligible local CCB!
    pgPool.state.pendingJournals.push({
      userId: String(uid),
      version: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
      operationId: opId,
      state: 'inflight',
    })
    // 4a) placeRemoteDriverLane MUST throw REMOTE_OPERATION_BILLING_PENDING BEFORE REMOTE_LANE_PROFILE_UNAVAILABLE!
    await assert.rejects(
      () =>
        placeRemoteDriverLane(
          {
            uid,
            containerDbId: String(containerId),
            dockerId: 'b'.repeat(64),
            sessionKey,
            canonicalModel: 'claude-opus-4-6-remote',
            driverId: 'cc',
          },
          { pool: pgPool as unknown as Pool },
        ),
      /REMOTE_OPERATION_BILLING_PENDING/,
    )
    // 4b) Even if upper layer wrapped the error as REMOTE_LANE_PROFILE_UNAVAILABLE / REMOTE_LANE_UNAVAILABLE,
    //     bootstrap selector MUST check authoritative pending billing BEFORE deciding local fallback or signing!
    let signValidatorCalledWhilePending = false
    const deniedPendingBill = await bootstrapSelector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_PROFILE_UNAVAILABLE'),
      expectedSecurityEpoch: 7,
      validateTargetSignable: async () => {
        signValidatorCalledWhilePending = true
        return true
      },
    })
    assert.equal(deniedPendingBill, null, 'B06: unsettled inflight billing journal must block local fallback even with 0 remote profiles')
    assert.equal(signValidatorCalledWhilePending, false, 'B06: must reject BEFORE target signability / descriptor signing')
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)

    // 4c) Same for `finalizing` state!
    pgPool.state.pendingJournals[0]!.state = 'finalizing'
    const deniedFinalizingBill = await bootstrapSelector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('NO_ELIGIBLE_REMOTE_PROFILE'),
      expectedSecurityEpoch: 7,
    })
    assert.equal(deniedFinalizingBill, null, 'B06: finalizing billing journal must block local fallback')
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)

    // 4d) Unreleased remote binding (`state = 'running'`) must also block even after journal settles!
    pgPool.state.pendingJournals[0]!.state = 'committed'
    pgPool.state.remoteBindings[0]!.state = 'running'
    const deniedUnreleasedBinding = await bootstrapSelector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_UNAVAILABLE'),
      expectedSecurityEpoch: 7,
    })
    assert.equal(deniedUnreleasedBinding, null, 'B06: non-released remote binding must fail closed')
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)

    // 5) Once binding is released AND billing settles, fallback succeeds and honestly reports `cold_degraded`
    //    (even though pointer.history is non-empty, because NO persisted rolling checkpoint exists!)
    pgPool.state.remoteBindings[0]!.state = 'released'
    const allowedCold = await bootstrapSelector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_PROFILE_UNAVAILABLE'),
      expectedSecurityEpoch: 7,
    })
    assert.ok(allowedCold !== null)
    assert.equal(allowedCold.migrationGrant?.placementEpoch, 2)
    assert.equal(
      allowedCold.migrationGrant?.continuityTier,
      'cold_degraded',
      'B01: without persisted rolling checkpoint, selector must report cold_degraded instead of fabricating tape_rebuilt',
    )
  })

  it('B01 negative gates: non-selfhost, missing same-logical local model (no silent downgrade), capability shortfall, post-dispatch/billing-pending fence, and missing migrationGrant all fail closed', async () => {
    const pgPool = new MockThreeLayerPgPool()
    const authorityStore = new PgSessionAuthorityStateStore(pgPool)

    // Catalog has remote Opus + ONLY weaker local Haiku (NO local Opus!)
    const noSameLogicalSnapshot = makeCatalogSnapshot([
      makeCatalogEntry({
        entryId: 1,
        modelId: 'claude-opus-4-6-remote',
        engine: 'ccb',
        placement: 'remote_pool',
      }),
      makeCatalogEntry({
        entryId: 2,
        modelId: 'claude-haiku-4-5',
        engine: 'ccb',
        placement: 'local',
      }),
    ])

    const selectorNoLocal = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => noSameLogicalSnapshot },
      selfhost: true,
      authorityStore,
    })
    assert.equal(
      await selectorNoLocal({
        uid: 42,
        containerId: 99,
        sessionKey: 'agent:main:webchat:dm:no-downgrade',
        canonicalModel: 'claude-opus-4-6-remote',
        engine: 'ccb',
        cause: new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'),
      }),
      null,
      'must never silently downgrade claude-opus-4-6-remote to a weaker local model',
    )

    // Same logical model exists locally, but non-selfhost -> MUST return null
    const pairedSnapshot = makeCatalogSnapshot([
      makeCatalogEntry({
        entryId: 1,
        modelId: 'claude-opus-4-6-remote',
        engine: 'ccb',
        placement: 'remote_pool',
        supportsVision: true,
        supportedEfforts: ['low', 'medium', 'high'],
      }),
      makeCatalogEntry({
        entryId: 2,
        modelId: 'claude-opus-4-6',
        engine: 'ccb',
        placement: 'local',
        supportsVision: false,
        supportedEfforts: ['low', 'medium'],
      }),
    ])
    const nonSelfhostSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => pairedSnapshot },
      selfhost: false,
      authorityStore,
    })
    assert.equal(
      await nonSelfhostSelector({
        uid: 42,
        containerId: 99,
        sessionKey: 'agent:main:webchat:dm:non-selfhost',
        canonicalModel: 'claude-opus-4-6-remote',
        engine: 'ccb',
        cause: new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'),
      }),
      null,
    )

    // Selfhost=true but local lacks vision / high effort promised by remote -> capability superset rejects!
    const capGapSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => pairedSnapshot },
      selfhost: true,
      authorityStore,
    })
    assert.equal(
      await capGapSelector({
        uid: 42,
        containerId: 99,
        sessionKey: 'agent:main:webchat:dm:cap-gap',
        canonicalModel: 'claude-opus-4-6-remote',
        engine: 'ccb',
        cause: new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'),
        requiredCapabilities: { needsVision: true, reasoningEffort: 'high' },
      }),
      null,
    )

    // Post-dispatch OR unsettled billing fence -> MUST return null even if local matches
    const fullLocalSnapshot = makeCatalogSnapshot([
      makeCatalogEntry({
        entryId: 1,
        modelId: 'claude-opus-4-6-remote',
        engine: 'ccb',
        placement: 'remote_pool',
      }),
      makeCatalogEntry({
        entryId: 2,
        modelId: 'claude-opus-4-6',
        engine: 'ccb',
        placement: 'local',
      }),
      makeCatalogEntry({
        entryId: 3,
        modelId: 'gpt-6-luna-remote',
        engine: 'codex',
        placement: 'remote_pool',
      }),
      makeCatalogEntry({
        entryId: 4,
        modelId: 'gpt-6-luna',
        engine: 'codex',
        placement: 'local',
      }),
      makeCatalogEntry({
        entryId: 5,
        modelId: 'grok-4-build-remote',
        engine: 'grok',
        placement: 'remote_pool',
      }),
      makeCatalogEntry({
        entryId: 6,
        modelId: 'grok-4-build',
        engine: 'grok',
        placement: 'local',
      }),
    ])
    const strictFenceSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => fullLocalSnapshot },
      selfhost: true,
      authorityStore,
    })
    // Unsupported engine (grok) must still fail closed directly in selfhostCrossPoolSelector.
    assert.equal(
      await strictFenceSelector({
        uid: 42,
        containerId: 99,
        sessionKey: 'agent:main:webchat:dm:grok-unsupported-guard',
        canonicalModel: 'grok-4-build-remote',
        engine: 'grok',
        cause: new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'),
      }),
      null,
    )
    assert.equal(
      await strictFenceSelector({
        uid: 42,
        containerId: 99,
        sessionKey: 'agent:main:webchat:dm:post-dispatch',
        canonicalModel: 'claude-opus-4-6-remote',
        engine: 'ccb',
        cause: new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'),
        dispatched: true,
      }),
      null,
    )
    assert.equal(
      await strictFenceSelector({
        uid: 42,
        containerId: 99,
        sessionKey: 'agent:main:webchat:dm:billing-pending',
        canonicalModel: 'claude-opus-4-6-remote',
        engine: 'ccb',
        cause: new Error('REMOTE_OPERATION_BILLING_PENDING'),
      }),
      null,
    )

    // Missing CrossPoolMigrationGrant STILL throws CC5_BACKEND_SCOPE_CHANGED_NEW_CHAT_REQUIRED
    const storedResume = remoteV4ResumeId(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'native-old',
    )
    assert.throws(
      () =>
        cc5SessionBackend({
          executionAuthority: { source: 'bridge_signed', executionBackend: undefined },
          engineId: 'ccb',
          executionModel: 'claude-opus-4-6-remote',
          sessionKey: 'agent:main:webchat:dm:no-grant',
          storedResumeId: storedResume,
        }),
      /CC5_BACKEND_SCOPE_CHANGED_NEW_CHAT_REQUIRED/,
    )
    await assert.rejects(
      () =>
        assertFreshCc5Session({
          storedResumeId: storedResume,
          executionBackend: undefined,
          sessionIds: ['agent:main:webchat:dm:no-grant'],
          hasPersistedTurnActivity: async () => true,
        }),
      /CC5_BACKEND_REQUIRES_NEW_SESSION/,
    )
  })

  it('B05: legacyRetirement catches real remoteNativeTurnBilling cc5-native-v1 & remote-native-v2 writer ctx rows and ignores remote-native-v4', async () => {
    assert.ok(
      (LEGACY_BILLING_RECOVERY_VERSIONS as readonly string[]).includes(
        REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
      ),
      'LEGACY_BILLING_RECOVERY_VERSIONS must include real CC5 writer constant cc5-native-v1',
    )
    assert.ok(
      (LEGACY_BILLING_RECOVERY_VERSIONS as readonly string[]).includes(
        CODEX_REMOTE_BILLING_RECOVERY_VERSION,
      ),
      'LEGACY_BILLING_RECOVERY_VERSIONS must include real Codex writer constant remote-native-v2',
    )

    // Exact ctx shape written by remoteNativeTurnBilling.ts:492-502 (NO top-level executionBackend!)
    const cc5RealWriterRow = {
      request_id: 'req-cc5-real-001',
      user_id: '42',
      state: 'inflight',
      precheck_credits: '500',
      final_credits: null,
      ledger_id: null,
      usage_id: null,
      error_msg: null,
      ctx: {
        remoteNativeBillingRecovery: REMOTE_NATIVE_BILLING_RECOVERY_VERSION,
        remoteNative: {
          v: 1,
          scope: {
            uid: '42',
            containerDbId: '99',
            operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            backendKind: 'cc5-interactive-v1',
            canonicalModel: 'claude-opus-4-6-remote',
          },
          requestId: 'req-cc5-real-001',
          hostStartAttempted: true,
        },
      },
      created_at: '2026-11-25T10:00:00.000Z',
      updated_at: '2026-11-25T10:00:01.000Z',
    }
    const v4UnifiedRow = {
      request_id: 'req-v4-unified-001',
      user_id: '42',
      state: 'inflight',
      precheck_credits: '500',
      final_credits: null,
      ledger_id: null,
      usage_id: null,
      error_msg: null,
      ctx: {
        remoteNativeBillingRecovery: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
        remoteDriverV4: { v: 4, scope: { operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' } },
      },
      created_at: '2026-11-25T10:01:00.000Z',
      updated_at: '2026-11-25T10:01:01.000Z',
    }

    const journalRows: Array<Record<string, unknown>> = [cc5RealWriterRow, v4UnifiedRow]
    const executedSql: string[] = []

    const queryable: PgQueryable = {
      async query<R extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<PgQueryResult<R>> {
        const normalized = sql.replace(/\s+/g, ' ').trim()
        executedSql.push(normalized)
        assert.match(normalized, /^SELECT\b/i, 'legacyRetirement must remain strictly read-only')
        if (normalized.includes('FROM remote_agent_bindings')) {
          // All legacy bindings already released!
          return { rows: [{ cnt: '0' } as unknown as R], rowCount: 1 }
        }
        if (normalized.includes('COUNT(*)') && normalized.includes('FROM request_finalize_journal')) {
          const versions = params[0] as string[]
          const backends = params[1] as string[]
          const cnt = journalRows.filter(
            (r) =>
              (r.state === 'inflight' || r.state === 'finalizing') &&
              matchesLegacyJournalRow(r.ctx as Record<string, unknown>, versions, backends),
          ).length
          return { rows: [{ cnt: String(cnt) } as unknown as R], rowCount: 1 }
        }
        if (normalized.includes('FROM request_finalize_journal')) {
          const reqId = String(params[0])
          const hasUid = normalized.includes('AND user_id = $2')
          const uid = hasUid ? String(params[1]) : null
          const versions = (hasUid ? params[2] : params[1]) as string[]
          const backends = (hasUid ? params[3] : params[2]) as string[]
          const matched = journalRows.filter(
            (r) =>
              String(r.request_id) === reqId &&
              (uid === null || String(r.user_id) === uid) &&
              matchesLegacyJournalRow(r.ctx as Record<string, unknown>, versions, backends),
          )
          return { rows: matched as unknown as R[], rowCount: matched.length }
        }
        throw new Error(`Unexpected SQL: ${normalized}`)
      },
    }

    // 1) While real CC5 'cc5-native-v1' row is inflight (even with 0 active bindings),
    //    readyToRetire MUST be false!
    const blocked = await evaluateLegacyRetirementReadiness(queryable)
    assert.equal(blocked.readyToRetire, false)
    assert.equal(blocked.activeLegacyBindingCount, 0)
    assert.equal(blocked.unsettledLegacyJournalCount, 1)
    assert.deepEqual(blocked.blockingReasons, ['UNSETTLED_LEGACY_BILLING_JOURNALS_REMAINING'])

    // 2) Historical read-only shell MUST find the real CC5 writer row AND ignore v4 row
    const shell = createLegacyBillingReadOnlyShell(queryable)
    const found = await shell.lookupHistoricalTurn({ requestId: 'req-cc5-real-001', userId: 42 })
    assert.ok(found !== null)
    assert.equal(found.billingRecoveryVersion, REMOTE_NATIVE_BILLING_RECOVERY_VERSION)
    assert.equal(found.backendKind, 'cc5-interactive-v1')
    assert.equal(await shell.lookupHistoricalTurn({ requestId: 'req-v4-unified-001', userId: 42 }), null)
    assert.equal(await shell.listLegacyPendingCount(), 1)

    // 3) Once CC5 journal commits, only v4 inflight remains -> legacy retirement becomes ready
    cc5RealWriterRow.state = 'committed'
    cc5RealWriterRow.final_credits = '120' as unknown as null
    const ready = await evaluateLegacyRetirementReadiness(queryable)
    assert.equal(ready.readyToRetire, true)
    assert.equal(ready.unsettledLegacyJournalCount, 0)
  })

  it('OCV5-893: Codex & Antigravity cross-pool fallback with prepareLocalFallbackTransport, smooth remote recovery, and strict N01/B06/missing-prep/commit-fail compensation gates', async () => {
    const pgPool = new MockThreeLayerPgPool()
    const authorityStore = new PgSessionAuthorityStateStore(pgPool)
    const bindingStore = new PgLogicalModelBindingStore(pgPool)
    const uid = 88
    const containerId = 108

    const snapshot = makeCatalogSnapshot([
      makeCatalogEntry({
        entryId: 10,
        modelId: 'gpt-6-luna-remote',
        engine: 'codex',
        placement: 'remote_pool',
      }),
      makeCatalogEntry({
        entryId: 11,
        modelId: 'gpt-6-luna',
        engine: 'codex',
        placement: 'local',
      }),
      makeCatalogEntry({
        entryId: 12,
        modelId: 'antigravity-gemini-4-neon-remote',
        engine: 'antigravity',
        placement: 'remote_pool',
      }),
      makeCatalogEntry({
        entryId: 13,
        modelId: 'antigravity-gemini-4-neon',
        engine: 'antigravity',
        placement: 'local',
      }),
    ])
    const bootstrapHooks = buildSelfhostCrossPoolBridgeHooks({
      isSelfhostV5: true,
      pool: pgPool,
      modelCatalogCache: { assertFresh: async () => snapshot },
    })

    const signer = AuthoritySigner.createEphemeral()
    const consumer = new ModelAuthorityConsumer({
      keyring: parseAuthorityKeyring(signer.publicKeyringEnv()),
      uid,
      containerId,
      required: true,
    })
    const makeSealExec = (modelId: string) => {
      const desc = snapshot.resolve(modelId)!
      return {
        canonicalModel: desc.canonicalModel,
        engine: desc.engine,
        placement: desc.placement === 'remote_pool' ? ('remote_pool' as const) : ('local' as const),
        securityEpoch: Number(snapshot.securityEpoch),
        descriptor: {
          capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
          contextWindow: desc.contextWindow,
          supportsVision: desc.capabilityProfile.supportsVision,
          supportedEfforts: [...desc.capabilityProfile.reasoning.supported],
          capabilityProfile: JSON.parse(JSON.stringify(desc.capabilityProfile)),
        },
      }
    }
    const signExec = (
      exec: ReturnType<typeof makeSealExec>,
      billingRequestId?: string,
      authorityTurnId?: string,
      executionBackend?: Parameters<AuthoritySigner['signBundle']>[0]['executionBackend'],
      poolMigration?: Parameters<AuthoritySigner['signBundle']>[0]['poolMigration'],
    ) =>
      signer.signBundle({
        uid,
        containerId,
        connectionChallenge: 'conn-ocv5-893-e2e',
        canonicalModel: exec.canonicalModel,
        engine: exec.engine,
        executionDescriptor: exec.descriptor,
        auxModels: [],
        ...(executionBackend ? { executionBackend } : {}),
        ...(poolMigration ? { poolMigration } : {}),
        ...(authorityTurnId ? { authorityTurnId } : {}),
        ...(billingRequestId ? { billingRequestId } : {}),
        executionRevision: 'rev-893-e2e',
        securityEpoch: exec.securityEpoch,
      }).bundle

    // 1) Codex & Antigravity full loop: remote -> local fallback (with transport prep) -> remote recovery
    for (const cfg of [
      {
        engine: 'codex' as const,
        driverId: 'codex',
        remoteModel: 'gpt-6-luna-remote',
        localModel: 'gpt-6-luna',
        routeKey: '__oc_codex_route',
        routeValue: { baseUrl: 'http://127.0.0.1:18789/codex/t1', modelProvider: 'openai' },
      },
      {
        engine: 'antigravity' as const,
        driverId: 'antigravity',
        remoteModel: 'antigravity-gemini-4-neon-remote',
        localModel: 'antigravity-gemini-4-neon',
        routeKey: '__oc_antigravity_route',
        routeValue: { baseUrl: 'http://127.0.0.1:18789/agy/t1', routeToken: 't1', accessToken: 'ya29.x' },
      },
    ]) {
      const sessionKey = `agent:main:webchat:dm:893-e2e-${cfg.engine}`
      const turn1OpId = `10000000-0000-4000-8000-${cfg.engine === 'codex' ? '000000000001' : '000000000002'}`
      await authorityStore.upsertEnginePointer({
        userId: uid,
        sessionKey,
        poolKind: 'remote_pool',
        engine: cfg.engine,
        nativeSessionId: `native-${cfg.engine}-1`,
        operationId: turn1OpId,
        profileId: `prof-${cfg.engine}-1`,
      })

      // Negative A: Omitting prepareLocalFallbackTransport MUST fail closed without moving PG epoch
      const deniedNoPrep = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        exec: makeSealExec(cfg.remoteModel),
        billingRequestId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        log: null,
        cc5BackendSelector: async () => {
          throw new Error('REMOTE_LANE_CAPACITY_EXHAUSTED')
        },
        crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
        returnToRemoteGrantResolver: bootstrapHooks.returnToRemoteGrantResolver,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async () => null,
      })
      assert.equal(deniedNoPrep, null)
      assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)

      // Negative B: B06 unsettled billing journal rejects BEFORE calling prepareLocalFallbackTransport
      pgPool.state.pendingJournals.push({
        userId: String(uid),
        version: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
        operationId: turn1OpId,
        state: 'inflight',
      })
      let prepCallsDuringB06 = 0
      const deniedB06 = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        exec: makeSealExec(cfg.remoteModel),
        billingRequestId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        log: null,
        cc5BackendSelector: async () => {
          throw new Error('REMOTE_LANE_PROFILE_UNAVAILABLE')
        },
        crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
        returnToRemoteGrantResolver: bootstrapHooks.returnToRemoteGrantResolver,
        prepareLocalFallbackTransport: async () => {
          prepCallsDuringB06 += 1
          return null
        },
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async () => null,
      })
      assert.equal(deniedB06, null)
      assert.equal(prepCallsDuringB06, 0, 'B06 must reject before invoking prepareLocalFallbackTransport')
      assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)
      pgPool.state.pendingJournals.length = 0

      // Negative C: N01 all bindings explicitly disabled rejects BEFORE calling prepareLocalFallbackTransport
      await bindingStore.upsertPoolBinding({
        logicalModelId: cfg.localModel,
        poolKind: 'local_pool',
        driverId: `local-${cfg.driverId}`,
        canonicalModelId: cfg.localModel,
        priority: 1,
        capabilities: {
          logicalModel: cfg.localModel,
          upstreamModelId: cfg.localModel,
          supportsVision: true,
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          supportedServiceTiers: ['standard'],
          supportsReadOnly: true,
          supportsConsultTurn: true,
          supportsHermeticNoTools: true,
          supportsSwarm: false,
          supportsAdaptiveThinking: false,
          contextWindow: 200_000,
        },
        enabled: false,
      })
      let prepCallsDuringN01 = 0
      const deniedN01 = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        exec: makeSealExec(cfg.remoteModel),
        billingRequestId: 'cccccccccccccccccccccccccccccccc',
        log: null,
        cc5BackendSelector: async () => {
          throw new Error('REMOTE_LANE_UNAVAILABLE')
        },
        crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
        returnToRemoteGrantResolver: bootstrapHooks.returnToRemoteGrantResolver,
        prepareLocalFallbackTransport: async () => {
          prepCallsDuringN01 += 1
          return null
        },
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async () => null,
      })
      assert.equal(deniedN01, null)
      assert.equal(prepCallsDuringN01, 0, 'N01 disabled bindings must reject before invoking prepareLocalFallbackTransport')
      assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)
      await bindingStore.setPoolBindingEnabled(cfg.localModel, 'local_pool', `local-${cfg.driverId}`, true)

      // Positive Turn 2: remote unavailable -> local fallback succeeds with minted local route & budget
      let compensateCount = 0
      const reqIdFallback = 'dddddddddddddddddddddddddddddddd'
      const turn2Sealed = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        exec: makeSealExec(cfg.remoteModel),
        billingRequestId: reqIdFallback,
        log: null,
        cc5BackendSelector: async () => {
          throw new Error('REMOTE_LANE_CAPACITY_EXHAUSTED')
        },
        crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
        returnToRemoteGrantResolver: bootstrapHooks.returnToRemoteGrantResolver,
        prepareLocalFallbackTransport: async ({ localExec, billingRequestId }) => {
          assert.equal(localExec.canonicalModel, cfg.localModel)
          return {
            billingRequestId,
            extraFrameFields: {
              requestId: billingRequestId,
              _creditBudget: '4200',
              [cfg.routeKey]: cfg.routeValue,
            },
            compensate: () => {
              compensateCount += 1
            },
          }
        },
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async () => null,
      })
      assert.ok(turn2Sealed !== null)
      assert.equal(compensateCount, 0)
      assert.equal(turn2Sealed.model, cfg.localModel)
      assert.equal(turn2Sealed._creditBudget, '4200')
      assert.deepEqual(turn2Sealed[cfg.routeKey], cfg.routeValue)

      const verified2 = consumer.consume(turn2Sealed, { challenge: 'conn-ocv5-893-e2e' })
      assert.equal(verified2.engine, cfg.engine)
      assert.equal(verified2.poolMigration?.placementEpoch, 2)
      assert.equal(verified2.poolMigration?.allowBackendTransition, true)
      assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.poolKind, 'local_container')

      // Gateway admission accepts fallback transition with verified grant
      const storedRemoteResume = remoteV4ResumeId(turn1OpId, `native-${cfg.engine}-1`)
      assert.equal(
        cc5SessionBackend({
          executionAuthority: { source: 'bridge_signed', executionBackend: undefined },
          engineId: cfg.engine,
          executionModel: cfg.remoteModel,
          sessionKey,
          storedResumeId: storedRemoteResume,
          poolMigration: verified2.poolMigration,
        }),
        undefined,
      )

      // Positive Turn 3: remote recovers -> return-to-remote grant advances epoch 2 -> 3
      const recoveredBackend = Object.freeze({
        kind: REMOTE_DRIVER_BACKEND,
        version: 4 as const,
        driverId: cfg.driverId,
        driverVersion: '5.0.0',
        engineId: cfg.driverId,
        authorityEngine: cfg.engine,
        sessionKey,
        operationId: `20000000-0000-4000-8000-${cfg.engine === 'codex' ? '000000000001' : '000000000002'}`,
        generation: '1',
        profileId: `prof-${cfg.engine}-1`,
        authEpoch: 'epoch-1',
      })
      const turn3Sealed = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        exec: makeSealExec(cfg.remoteModel),
        billingRequestId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        log: null,
        cc5BackendSelector: async () => recoveredBackend,
        crossPoolFallbackSelector: bootstrapHooks.crossPoolFallbackSelector,
        returnToRemoteGrantResolver: bootstrapHooks.returnToRemoteGrantResolver,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeSealExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async () => null,
      })
      assert.ok(turn3Sealed !== null)
      const verified3 = consumer.consume(
        { ...turn3Sealed, requestId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        { challenge: 'conn-ocv5-893-e2e' },
      )
      assert.equal(verified3.poolMigration?.placementEpoch, 3)
      assert.equal(verified3.poolMigration?.allowBackendTransition, true)
      assert.equal(verified3.executionBackend?.operationId, recoveredBackend.operationId)
      assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.poolKind, 'remote_pool')

      await assertFreshCc5Session({
        storedResumeId: undefined,
        executionBackend: verified3.executionBackend,
        sessionIds: [sessionKey],
        hasPersistedTurnActivity: async () => true,
        poolMigration: verified3.poolMigration,
      })
    }
  })

  it('B14/OCV5-893: local AntigravityAdapter admits readOnly turns into sandbox while still requiring a master-owned relay route', async () => {
    const adapter = new AntigravityAdapter({
      sessionKey: 'agent:main:webchat:dm:b14-agy-readonly',
      agentId: 'main',
      agentBaseDir: '/tmp/oc-b14-test',
      config: { gateway: { port: 18789, accessToken: 'test-token' } } as any,
      model: 'antigravity-gemini-4-carbon',
    } as any)
    const run = adapter.submitTurn({
      input: 'inspect files read-only',
      readOnly: true,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await assert.rejects(() => run.submitted, /ANTIGRAVITY_ROUTE_REQUIRED/)
  })
})
