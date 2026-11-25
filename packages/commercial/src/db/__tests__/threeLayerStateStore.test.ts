import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { LogicalModelCapability, PlacementDescriptor } from '@openclaude/protocol'
import {
  PgArtifactBlobMetaStore,
  PgLogicalModelBindingStore,
  PgSessionAuthorityStateStore,
  type PgQueryResult,
  type PgTransactionClient,
  type PgTransactionPool,
} from '../threeLayerStateStore.js'

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

interface MockDbState {
  pointers: Map<string, Record<string, unknown>>
  checkpoints: Map<string, Record<string, unknown>>
  migrations: Map<string, Record<string, unknown>>
  bindings: Map<string, Record<string, unknown>>
  blobs: Map<string, Record<string, unknown>>
  uploads: Map<string, Record<string, unknown>>
  bindingSeq: number
  clockMs: number
}

function cloneState(s: MockDbState): MockDbState {
  const cloneMap = (m: Map<string, Record<string, unknown>>) =>
    new Map([...m.entries()].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]))
  return {
    pointers: cloneMap(s.pointers),
    checkpoints: cloneMap(s.checkpoints),
    migrations: cloneMap(s.migrations),
    bindings: cloneMap(s.bindings),
    blobs: cloneMap(s.blobs),
    uploads: cloneMap(s.uploads),
    bindingSeq: s.bindingSeq,
    clockMs: s.clockMs,
  }
}

class InMemoryThreeLayerPgPool implements PgTransactionPool {
  state: MockDbState = {
    pointers: new Map(),
    checkpoints: new Map(),
    migrations: new Map(),
    bindings: new Map(),
    blobs: new Map(),
    uploads: new Map(),
    bindingSeq: 0,
    clockMs: Date.parse('2026-11-25T10:00:00.000Z'),
  }
  readonly advisoryLocks: string[] = []
  private readonly lockQueues = new Map<string, Promise<void>>()
  beforeOnConflictUpsert?: (db: MockDbState, key: string) => void
  onAdvisoryLockAcquired?: (lockKey: string, count: number) => Promise<void> | void
  failBindingReads = false

  advanceClock(ms: number): void {
    this.state.clockMs += ms
  }

  private async acquireAdvisoryLock(lockKey: string): Promise<() => void> {
    const prev = this.lockQueues.get(lockKey) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => {
      release = resolve
    })
    this.lockQueues.set(lockKey, prev.then(() => next))
    await prev
    this.advisoryLocks.push(lockKey)
    if (this.onAdvisoryLockAcquired) {
      await this.onAdvisoryLockAcquired(lockKey, this.advisoryLocks.length)
    }
    return () => {
      release()
    }
  }

  private nowIso(db: MockDbState = this.state): string {
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
    let txState: MockDbState | null = null
    let heldReleases: Array<() => void> = []
    const releaseLocks = () => {
      for (const fn of heldReleases) fn()
      heldReleases = []
    }
    return {
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<PgQueryResult<R>> => {
        const trimmed = sql.trim().toUpperCase()
        if (trimmed === 'BEGIN') {
          txState = cloneState(this.state)
          return { rows: [], rowCount: 0 }
        }
        if (trimmed === 'COMMIT') {
          if (txState) {
            this.state = txState
            txState = null
          }
          releaseLocks()
          return { rows: [], rowCount: 0 }
        }
        if (trimmed === 'ROLLBACK') {
          txState = null
          releaseLocks()
          return { rows: [], rowCount: 0 }
        }
        const normalized = sql.replace(/\s+/g, ' ').trim()
        if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
          const lockKey = String(params[0])
          const rel = await this.acquireAdvisoryLock(lockKey)
          heldReleases.push(rel)
          // Refresh tx snapshot after acquiring transaction lock (READ COMMITTED semantics).
          if (txState) {
            txState = cloneState(this.state)
          }
          return {
            rows: [{ pg_advisory_xact_lock: '' } as unknown as R],
            rowCount: 1,
          }
        }
        return this.execOn(txState ?? this.state, sql, params) as PgQueryResult<R>
      },
      release: () => {
        txState = null
        releaseLocks()
      },
    }
  }

  private execOn(
    db: MockDbState,
    rawSql: string,
    params: unknown[],
  ): PgQueryResult<Record<string, unknown>> {
    const sql = rawSql.replace(/\s+/g, ' ').trim()

    if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
      this.advisoryLocks.push(String(params[0]))
      return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 }
    }

    // ── session_engine_pointers ──
    if (sql.includes('FROM session_engine_pointers') && sql.startsWith('SELECT')) {
      const key = `${params[0]}::${params[1]}`
      const row = db.pointers.get(key)
      return { rows: row ? [JSON.parse(JSON.stringify(row))] : [], rowCount: row ? 1 : 0 }
    }

    if (sql.startsWith('INSERT INTO session_engine_pointers') && sql.includes('ON CONFLICT')) {
      const key = `${params[0]}::${params[1]}`
      if (this.beforeOnConflictUpsert) {
        this.beforeOnConflictUpsert(db, key)
      }
      const existing = db.pointers.get(key)
      if (existing && sql.includes('WHERE session_engine_pointers.placement_epoch = $15')) {
        const guardedEpoch = Number(params[14])
        if (
          existing.migration_state !== 'active' ||
          Number(existing.placement_epoch) !== guardedEpoch
        ) {
          return { rows: [], rowCount: 0 }
        }
      }
      const now = this.nowIso(db)
      const next: Record<string, unknown> = {
        user_id: String(params[0]),
        session_key: String(params[1]),
        placement_epoch: existing ? existing.placement_epoch : 1,
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
        promoted_from_history: Boolean(params[13]),
        migration_state: existing ? existing.migration_state : 'active',
        active_migration_id: existing ? existing.active_migration_id : null,
        updated_at: now,
        created_at: existing ? existing.created_at : now,
      }
      db.pointers.set(key, next)
      return { rows: [JSON.parse(JSON.stringify(next))], rowCount: 1 }
    }

    if (sql.startsWith('INSERT INTO session_engine_pointers')) {
      const key = `${params[0]}::${params[1]}`
      const now = this.nowIso(db)
      const next: Record<string, unknown> = {
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
        updated_at: now,
        created_at: now,
      }
      db.pointers.set(key, next)
      return { rows: [], rowCount: 1 }
    }

    if (sql.startsWith('UPDATE session_engine_pointers SET rejected_ids_json')) {
      const key = `${params[0]}::${params[1]}`
      const row = db.pointers.get(key)
      if (!row) return { rows: [], rowCount: 0 }
      const list = Array.isArray(row.rejected_ids_json)
        ? [...(row.rejected_ids_json as string[])]
        : []
      const id = String(params[2])
      if (!list.includes(id)) list.push(id)
      row.rejected_ids_json = list
      row.updated_at = this.nowIso(db)
      return { rows: [], rowCount: 1 }
    }

    if (sql.startsWith("UPDATE session_engine_pointers SET migration_state = 'migrating'")) {
      const key = `${params[0]}::${params[1]}`
      const row = db.pointers.get(key)
      if (
        !row ||
        Number(row.placement_epoch) !== Number(params[2]) ||
        row.migration_state !== 'active'
      ) {
        return { rows: [], rowCount: 0 }
      }
      row.migration_state = 'migrating'
      row.active_migration_id = params[3]
      row.updated_at = this.nowIso(db)
      return { rows: [{ placement_epoch: row.placement_epoch }], rowCount: 1 }
    }

    if (sql.startsWith('UPDATE session_engine_pointers SET placement_epoch = $3')) {
      const key = `${params[0]}::${params[1]}`
      const row = db.pointers.get(key)
      if (
        !row ||
        row.active_migration_id !== params[11] ||
        row.migration_state !== 'migrating'
      ) {
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
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }

    if (sql.startsWith("UPDATE session_engine_pointers SET migration_state = 'active'")) {
      const key = `${params[0]}::${params[1]}`
      const row = db.pointers.get(key)
      if (
        !row ||
        row.active_migration_id !== params[2] ||
        row.migration_state !== 'migrating'
      ) {
        return { rows: [], rowCount: 0 }
      }
      row.migration_state = 'active'
      row.active_migration_id = null
      row.updated_at = this.nowIso(db)
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }

    if (sql.startsWith('UPDATE session_engine_pointers SET prompt_cache_meta_json = $3')) {
      const key = `${params[0]}::${params[1]}`
      const row = db.pointers.get(key)
      if (!row || Number(row.placement_epoch) !== Number(params[3])) {
        return { rows: [], rowCount: 0 }
      }
      row.prompt_cache_meta_json = params[2] === null ? null : JSON.parse(String(params[2]))
      row.updated_at = this.nowIso(db)
      return { rows: [{ placement_epoch: row.placement_epoch }], rowCount: 1 }
    }

    // ── session_rolling_checkpoints ──
    if (sql.startsWith('INSERT INTO session_rolling_checkpoints')) {
      const key = `${params[0]}::${params[1]}::${params[3]}`
      const now = this.nowIso(db)
      const row: Record<string, unknown> = {
        user_id: String(params[0]),
        session_key: String(params[1]),
        session_id: String(params[2]),
        checkpoint_generation: String(params[3]),
        placement_epoch: Number(params[4]),
        mode: params[5],
        anchor_seq: Number(params[6]),
        source_engine: params[7],
        summary: params[8],
        instructions: params[9],
        acked_by_turn_key: null,
        acked_at: null,
        created_at: now,
      }
      db.checkpoints.set(key, row)
      return {
        rows: [{ checkpoint_generation: row.checkpoint_generation, created_at: row.created_at }],
        rowCount: 1,
      }
    }

    if (sql.includes('FROM session_rolling_checkpoints') && sql.startsWith('SELECT')) {
      const uid = String(params[0])
      const sKey = String(params[1])
      const hasEpochFilter = sql.includes('placement_epoch = $3')
      const expectedEpoch = hasEpochFilter ? Number(params[2]) : undefined
      const rows = [...db.checkpoints.values()]
        .filter(
          (r) =>
            r.user_id === uid &&
            r.session_key === sKey &&
            r.acked_at === null &&
            (!hasEpochFilter || Number(r.placement_epoch) === expectedEpoch),
        )
        .sort((a, b) => {
          const cmp = String(b.created_at).localeCompare(String(a.created_at))
          if (cmp !== 0) return cmp
          return String(b.checkpoint_generation).localeCompare(String(a.checkpoint_generation))
        })
      return {
        rows: rows[0] ? [JSON.parse(JSON.stringify(rows[0]))] : [],
        rowCount: rows[0] ? 1 : 0,
      }
    }

    if (sql.startsWith('UPDATE session_rolling_checkpoints')) {
      const key = `${params[0]}::${params[1]}::${params[2]}`
      const row = db.checkpoints.get(key)
      if (!row || row.acked_at !== null) return { rows: [], rowCount: 0 }
      row.acked_by_turn_key = params[3]
      row.acked_at = this.nowIso(db)
      return { rows: [{ checkpoint_generation: row.checkpoint_generation }], rowCount: 1 }
    }

    // ── session_placement_migrations ──
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
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }

    if (sql.includes('FROM session_placement_migrations') && sql.startsWith('SELECT')) {
      const row = db.migrations.get(String(params[0]))
      return { rows: row ? [JSON.parse(JSON.stringify(row))] : [], rowCount: row ? 1 : 0 }
    }

    if (sql.startsWith("UPDATE session_placement_migrations SET state = 'committed'")) {
      const row = db.migrations.get(String(params[0]))
      if (!row || row.state !== 'migrating') return { rows: [], rowCount: 0 }
      row.state = 'committed'
      row.continuity_tier = params[1]
      row.capsule_ref_json = params[2] === null ? null : JSON.parse(String(params[2]))
      row.completed_at = this.nowIso(db)
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }

    if (sql.startsWith("UPDATE session_placement_migrations SET state = 'aborted'")) {
      const row = db.migrations.get(String(params[0]))
      if (!row || row.state !== 'migrating') return { rows: [], rowCount: 0 }
      row.state = 'aborted'
      row.reason = params[1]
      row.completed_at = this.nowIso(db)
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }

    // ── model_logical_pool_bindings ──
    if (sql.startsWith('INSERT INTO model_logical_pool_bindings')) {
      const key = `${params[0]}::${params[1]}::${params[2]}`
      const existing = db.bindings.get(key)
      const now = this.nowIso(db)
      const row: Record<string, unknown> = {
        binding_id: existing ? existing.binding_id : ++db.bindingSeq,
        logical_model_id: params[0],
        pool_kind: params[1],
        driver_id: params[2],
        canonical_model_id: params[3],
        priority: Number(params[4]),
        capabilities_json: JSON.parse(String(params[5])),
        enabled: Boolean(params[6]),
        created_at: existing ? existing.created_at : now,
        updated_at: now,
      }
      db.bindings.set(key, row)
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }

    if (sql.startsWith('UPDATE model_logical_pool_bindings SET enabled')) {
      const key = `${params[0]}::${params[1]}::${params[2]}`
      const row = db.bindings.get(key)
      if (!row) return { rows: [], rowCount: 0 }
      row.enabled = Boolean(params[3])
      row.updated_at = this.nowIso(db)
      return { rows: [{ binding_id: row.binding_id }], rowCount: 1 }
    }

    if (sql.includes('FROM model_logical_pool_bindings') && sql.startsWith('SELECT')) {
      if (this.failBindingReads) {
        throw new Error('MOCK_PG_BINDING_READ_ERROR')
      }
      const enabledOnly = sql.includes('enabled = TRUE')
      let rows = [...db.bindings.values()]
      if (enabledOnly) {
        rows = rows.filter((r) => r.enabled === true)
      }
      if (sql.includes('WHERE logical_model_id = $1')) {
        rows = rows.filter((r) => r.logical_model_id === params[0])
      }
      if (sql.includes("pool_kind = 'remote_pool'")) {
        rows = rows.filter((r) => r.pool_kind === 'remote_pool')
      }
      rows.sort((a, b) => {
        if (!sql.includes('WHERE logical_model_id = $1')) {
          const m = String(a.logical_model_id).localeCompare(String(b.logical_model_id))
          if (m !== 0) return m
        }
        const p = Number(a.priority) - Number(b.priority)
        if (p !== 0) return p
        return String(a.driver_id).localeCompare(String(b.driver_id))
      })
      return { rows: rows.map((r) => JSON.parse(JSON.stringify(r))), rowCount: rows.length }
    }

    // ── artifact_blob_uploads ──
    if (sql.startsWith('INSERT INTO artifact_blob_uploads')) {
      const now = this.nowIso(db)
      const row: Record<string, unknown> = {
        upload_id: params[0],
        tenant_id: params[1],
        kind: params[2],
        filename: params[3],
        mime_type: params[4],
        expected_size_bytes: Number(params[5]),
        chunk_bytes: Number(params[6]),
        chunk_count: Number(params[7]),
        received_parts_json: {},
        status: 'open',
        completed_blob_id: null,
        created_at: now,
        updated_at: now,
      }
      db.uploads.set(String(params[0]), row)
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }

    if (sql.includes('FROM artifact_blob_uploads') && sql.startsWith('SELECT')) {
      const row = db.uploads.get(String(params[0]))
      return { rows: row ? [JSON.parse(JSON.stringify(row))] : [], rowCount: row ? 1 : 0 }
    }

    if (sql.startsWith('UPDATE artifact_blob_uploads SET received_parts_json')) {
      const row = db.uploads.get(String(params[0]))
      if (!row) return { rows: [], rowCount: 0 }
      row.received_parts_json = JSON.parse(String(params[1]))
      row.updated_at = this.nowIso(db)
      return { rows: [], rowCount: 1 }
    }

    if (sql.startsWith("UPDATE artifact_blob_uploads SET status = 'completed'")) {
      const row = db.uploads.get(String(params[0]))
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'completed'
      row.completed_blob_id = params[1]
      row.updated_at = this.nowIso(db)
      return { rows: [], rowCount: 1 }
    }

    // ── artifact_blobs ──
    if (sql.startsWith('INSERT INTO artifact_blobs')) {
      const now = this.nowIso(db)
      const row: Record<string, unknown> = {
        blob_id: params[0],
        tenant_id: params[1],
        sha256: params[2],
        size_bytes: Number(params[3]),
        mime_type: params[4],
        kind: params[5],
        logical_name: params[6],
        container_relative_path: params[7],
        storage_backend: params[8],
        storage_uri: params[9],
        deleted_at: null,
        created_at: now,
      }
      db.blobs.set(String(params[0]), row)
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }

    if (sql.includes('FROM artifact_blobs') && sql.includes('WHERE tenant_id = $1 AND blob_id = $2')) {
      const row = db.blobs.get(String(params[1]))
      if (!row || row.tenant_id !== params[0] || row.deleted_at !== null) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }

    if (sql.includes('FROM artifact_blobs') && sql.includes('WHERE tenant_id = $1 AND sha256 = $2')) {
      const rows = [...db.blobs.values()]
        .filter((r) => r.tenant_id === params[0] && r.sha256 === params[1] && r.deleted_at === null)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      return {
        rows: rows[0] ? [JSON.parse(JSON.stringify(rows[0]))] : [],
        rowCount: rows[0] ? 1 : 0,
      }
    }

    if (sql.includes('FROM artifact_blobs') && sql.includes('WHERE tenant_id = $1')) {
      const hasKind = sql.includes('AND kind = $2')
      const rows = [...db.blobs.values()]
        .filter(
          (r) =>
            r.tenant_id === params[0] &&
            r.deleted_at === null &&
            (!hasKind || r.kind === params[1]),
        )
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      return { rows: rows.map((r) => JSON.parse(JSON.stringify(r))), rowCount: rows.length }
    }

    if (sql.startsWith('UPDATE artifact_blobs SET deleted_at = NOW() WHERE tenant_id = $1')) {
      const row = db.blobs.get(String(params[1]))
      if (!row || row.tenant_id !== params[0] || row.deleted_at !== null) {
        return { rows: [], rowCount: 0 }
      }
      row.deleted_at = this.nowIso(db)
      return { rows: [{ blob_id: row.blob_id }], rowCount: 1 }
    }

    if (
      (sql.startsWith('UPDATE artifact_blobs SET deleted_at = NOW() WHERE deleted_at IS NULL') ||
        sql.startsWith('SELECT blob_id FROM artifact_blobs WHERE deleted_at IS NULL')) &&
      sql.includes('created_at < $1::timestamptz')
    ) {
      const cutoffMs = Date.parse(String(params[0]))
      const liveSet = new Set<string>(params[1] as string[])
      const tenantFilter = params.length > 2 ? String(params[2]) : undefined
      const isDryRun = sql.startsWith('SELECT')
      const matched: Record<string, unknown>[] = []
      const now = this.nowIso(db)
      for (const row of db.blobs.values()) {
        if (row.deleted_at !== null) continue
        if (tenantFilter !== undefined && row.tenant_id !== tenantFilter) continue
        if (liveSet.has(String(row.blob_id))) continue
        if (Date.parse(String(row.created_at)) < cutoffMs) {
          if (!isDryRun) row.deleted_at = now
          matched.push({ blob_id: row.blob_id })
        }
      }
      return { rows: matched, rowCount: matched.length }
    }

    throw new Error(`UNHANDLED_MOCK_SQL: ${sql}`)
  }
}

const SAMPLE_CAPS: LogicalModelCapability = {
  logicalModel: 'claude-opus-4-7',
  upstreamModelId: 'claude-opus-4-7',
  supportsVision: true,
  supportedEfforts: ['low', 'medium', 'high'],
  defaultEffort: 'high',
  supportedServiceTiers: ['standard', 'fast'],
  supportsReadOnly: true,
  supportsConsultTurn: true,
  supportsHermeticNoTools: true,
  supportsSwarm: true,
  contextWindow: 1_000_000,
}

const LOCAL_PLACEMENT: PlacementDescriptor = {
  poolKind: 'local_container',
  engine: 'ccb',
  driverId: 'local-ccb-v5',
  placementEpoch: 1,
  containerId: 'ctr-42',
  profileId: 'prof-local-1',
}

const REMOTE_PLACEMENT: PlacementDescriptor = {
  poolKind: 'remote_pool',
  engine: 'codex',
  driverId: 'remote-codex-v5',
  placementEpoch: 2,
  hostId: 'node-remote-7',
  profileId: 'prof-remote-9',
}

describe('OCV5-890 Wave 1B: PgSessionAuthorityStateStore', () => {
  it('upserts pointers, caps deduped history to 4 entries, and enforces stale epoch + migrating guards', async () => {
    const pool = new InMemoryThreeLayerPgPool()
    const store = new PgSessionAuthorityStateStore(pool)

    assert.equal(await store.getEnginePointer(42, 'sess-1'), null)

    // Write 6 sequential nativeSessionIds to verify 4-entry dedup cap.
    for (let i = 1; i <= 6; i += 1) {
      await store.upsertEnginePointer({
        userId: 42,
        sessionKey: 'sess-1',
        engine: 'ccb',
        nativeSessionId: `nat-${i}`,
        expectedPlacementEpoch: 1,
      })
    }

    const ptr = await store.getEnginePointer(42, 'sess-1')
    assert.ok(ptr)
    assert.equal(ptr.nativeSessionId, 'nat-6')
    assert.deepEqual(ptr.history, ['nat-5', 'nat-4', 'nat-3', 'nat-2'])
    assert.equal(ptr.placementEpoch, 1)

    // Stale expectedPlacementEpoch fails closed.
    await assert.rejects(
      () =>
        store.upsertEnginePointer({
          userId: 42,
          sessionKey: 'sess-1',
          engine: 'ccb',
          nativeSessionId: 'nat-7',
          expectedPlacementEpoch: 2,
        }),
      /SESSION_PLACEMENT_EPOCH_MISMATCH/,
    )
  })

  it('dedups rejected resume IDs and walks the 4-tier resume ladder accurately', async () => {
    const pool = new InMemoryThreeLayerPgPool()
    const store = new PgSessionAuthorityStateStore(pool)

    // Tier 4: cold_degraded when no state exists.
    const cold = await store.resolveResumeLadder(7n, 'sess-ladder', 'ccb')
    assert.equal(cold.tier, 'cold_degraded')
    assert.equal(cold.placementEpoch, 1)

    await store.upsertEnginePointer({
      userId: 7n,
      sessionKey: 'sess-ladder',
      engine: 'ccb',
      nativeSessionId: 'nat-active',
      history: ['nat-prev'],
      capsuleId: sha256Hex('capsule-1'),
    })

    // Tier 1: hot_native picks active nativeSessionId.
    const hot1 = await store.resolveResumeLadder(7n, 'sess-ladder', 'ccb')
    assert.equal(hot1.tier, 'hot_native')
    assert.equal(hot1.nativeSessionId, 'nat-active')

    // Reject active nativeSessionId (twice to verify idempotent dedup).
    await store.recordRejectedResumeId(7n, 'sess-ladder', 'nat-active')
    await store.recordRejectedResumeId(7n, 'sess-ladder', 'nat-active')
    const afterReject = await store.getEnginePointer(7n, 'sess-ladder')
    assert.deepEqual(afterReject?.rejectedIds, ['nat-active'])

    // Tier 1 fallback: promotes non-rejected history entry.
    const hot2 = await store.resolveResumeLadder(7n, 'sess-ladder', 'ccb')
    assert.equal(hot2.tier, 'hot_native')
    assert.equal(hot2.nativeSessionId, 'nat-prev')

    // Reject history entry -> Tier 2: warm_capsule.
    await store.recordRejectedResumeId(7n, 'sess-ladder', 'nat-prev')
    const warm = await store.resolveResumeLadder(7n, 'sess-ladder', 'ccb')
    assert.equal(warm.tier, 'warm_capsule')
    assert.equal(warm.capsuleId, sha256Hex('capsule-1'))

    // Save rolling checkpoint and switch engine -> Tier 3: tape_rebuilt.
    const cp = await store.saveRollingCheckpoint({
      userId: 7n,
      sessionKey: 'sess-ladder',
      sessionId: 'sid-7',
      expectedPlacementEpoch: 1,
      mode: 'anchored_v2',
      anchorSeq: 12,
      sourceEngine: 'ccb',
      summary: 'handoff summary',
    })
    const rebuilt = await store.resolveResumeLadder(7n, 'sess-ladder', 'codex')
    assert.equal(rebuilt.tier, 'tape_rebuilt')
    assert.equal(rebuilt.checkpointGeneration, cp.checkpointGeneration)
    assert.equal(rebuilt.degradedReason, 'engine_switched')
  })

  it('enforces placement epoch on saveRollingCheckpoint and generation CAS on ackRollingCheckpoint', async () => {
    const pool = new InMemoryThreeLayerPgPool()
    const store = new PgSessionAuthorityStateStore(pool)

    await store.upsertEnginePointer({
      userId: 10,
      sessionKey: 'sess-cp',
      engine: 'codex',
      nativeSessionId: 'thr-1',
    })

    // Wrong epoch fails closed.
    await assert.rejects(
      () =>
        store.saveRollingCheckpoint({
          userId: 10,
          sessionKey: 'sess-cp',
          sessionId: 'sid-10',
          expectedPlacementEpoch: 2,
          mode: 'anchored_v2',
          anchorSeq: 1,
          sourceEngine: 'codex',
          summary: 'stale epoch write',
        }),
      /CHECKPOINT_PLACEMENT_EPOCH_MISMATCH/,
    )

    const cp1 = await store.saveRollingCheckpoint({
      userId: 10,
      sessionKey: 'sess-cp',
      sessionId: 'sid-10',
      expectedPlacementEpoch: 1,
      mode: 'anchored_v2',
      anchorSeq: 5,
      sourceEngine: 'codex',
      summary: 'first checkpoint',
    })
    const cp2 = await store.saveRollingCheckpoint({
      userId: 10,
      sessionKey: 'sess-cp',
      sessionId: 'sid-10',
      expectedPlacementEpoch: 1,
      mode: 'native_handoff',
      anchorSeq: 8,
      sourceEngine: 'codex',
      summary: 'latest checkpoint',
      instructions: 'continue editing',
    })
    assert.ok(cp2.createdAtMs >= cp1.createdAtMs)

    const peeked = await store.peekRollingCheckpoint(10, 'sess-cp')
    assert.equal(peeked?.checkpointGeneration, cp2.checkpointGeneration)
    assert.equal(peeked?.summary, 'latest checkpoint')

    // B01: expectedEpoch filter matches current epoch and rejects stale/mismatched epoch.
    const peekedEpoch1 = await store.peekRollingCheckpoint(10, 'sess-cp', 1)
    assert.equal(peekedEpoch1?.checkpointGeneration, cp2.checkpointGeneration)
    assert.equal(await store.peekRollingCheckpoint(10, 'sess-cp', 2), null)

    // Wrong generation fails CAS.
    assert.equal(
      await store.ackRollingCheckpoint({
        userId: 10,
        sessionKey: 'sess-cp',
        checkpointGeneration: 'cp-nonexistent',
        consumedByTurnKey: 'turn-1',
      }),
      false,
    )

    // Matching generation succeeds once, second ack returns false.
    assert.equal(
      await store.ackRollingCheckpoint({
        userId: 10,
        sessionKey: 'sess-cp',
        checkpointGeneration: cp2.checkpointGeneration,
        consumedByTurnKey: 'turn-1',
      }),
      true,
    )
    assert.equal(
      await store.ackRollingCheckpoint({
        userId: 10,
        sessionKey: 'sess-cp',
        checkpointGeneration: cp2.checkpointGeneration,
        consumedByTurnKey: 'turn-2',
      }),
      false,
    )

    // Peek now returns cp1 (still unacked).
    const nextPeek = await store.peekRollingCheckpoint(10, 'sess-cp')
    assert.equal(nextPeek?.checkpointGeneration, cp1.checkpointGeneration)
  })

  it('runs begin/commit/abort placement migration CAS with advisory lock and epoch invariants', async () => {
    const pool = new InMemoryThreeLayerPgPool()
    const store = new PgSessionAuthorityStateStore(pool)

    // Begin on nonexistent pointer with stale epoch 2 -> rejected.
    const staleInit = await store.beginPlacementMigration({
      userId: 99,
      sessionKey: 'sess-mig',
      expectedPlacementEpoch: 2,
      fromPlacement: LOCAL_PLACEMENT,
      toPlacement: REMOTE_PLACEMENT,
    })
    if (staleInit.applied) assert.fail('expected stale epoch begin to be rejected')
    assert.equal(staleInit.currentEpoch, 1)

    // Begin on nonexistent pointer with epoch 1 -> initializes pointer and enters migrating.
    const began = await store.beginPlacementMigration({
      userId: 99,
      sessionKey: 'sess-mig',
      expectedPlacementEpoch: 1,
      fromPlacement: LOCAL_PLACEMENT,
      toPlacement: REMOTE_PLACEMENT,
      reason: 'pool_rebalance',
    })
    if (!began.applied) assert.fail('expected beginPlacementMigration to apply')
    assert.equal(began.migration.fromEpoch, 1)
    assert.equal(began.migration.toEpoch, 2)
    assert.equal(began.migration.state, 'migrating')
    assert.ok(pool.advisoryLocks.includes('session-migrate:99:sess-mig'))

    // Concurrent begin while migrating -> conflict rejected.
    const concurrent = await store.beginPlacementMigration({
      userId: 99,
      sessionKey: 'sess-mig',
      expectedPlacementEpoch: 1,
      fromPlacement: LOCAL_PLACEMENT,
      toPlacement: REMOTE_PLACEMENT,
    })
    if (concurrent.applied) assert.fail('expected concurrent begin to be rejected')
    assert.equal(concurrent.reason, 'already_migrating')
    assert.equal(concurrent.activeMigrationId, began.migration.migrationId)

    // Pointer upsert while migrating -> rejected.
    await assert.rejects(
      () =>
        store.upsertEnginePointer({
          userId: 99,
          sessionKey: 'sess-mig',
          engine: 'ccb',
          nativeSessionId: 'nat-blocked',
        }),
      /SESSION_PLACEMENT_MIGRATING/,
    )

    // Abort migration -> state becomes 'aborted', pointer returns to 'active', epoch stays 1!
    const aborted = await store.abortPlacementMigration({
      migrationId: began.migration.migrationId,
      reason: 'target_host_unavailable',
    })
    if (!aborted.applied) assert.fail('expected abortPlacementMigration to apply')
    assert.equal(aborted.migration.state, 'aborted')
    assert.equal(aborted.migration.reason, 'target_host_unavailable')
    assert.equal(aborted.pointer?.migrationState, 'active')
    assert.equal(aborted.pointer?.placementEpoch, 1)
    assert.equal(aborted.pointer?.activeMigrationId, null)

    // Second abort on already-aborted migration -> applied: false.
    assert.equal(
      (
        await store.abortPlacementMigration({
          migrationId: began.migration.migrationId,
          reason: 'duplicate',
        })
      ).applied,
      false,
    )

    // Start a fresh migration at epoch 1 and commit it -> epoch flips to 2!
    const began2 = await store.beginPlacementMigration({
      userId: 99,
      sessionKey: 'sess-mig',
      expectedPlacementEpoch: 1,
      fromPlacement: LOCAL_PLACEMENT,
      toPlacement: REMOTE_PLACEMENT,
    })
    if (!began2.applied) assert.fail('expected second beginPlacementMigration to apply')

    const committed = await store.commitPlacementMigration({
      migrationId: began2.migration.migrationId,
      continuityTier: 'warm_capsule',
      nativeSessionId: 'codex-thread-2',
      capsuleId: sha256Hex('cap-2'),
      promptCacheMeta: { affinityKey: 's-0123456789abcdef' },
      usageBaseline: { inputTokens: 1200, outputTokens: 300 },
    })
    if (!committed.applied) assert.fail('expected commitPlacementMigration to apply')
    assert.equal(committed.migration.state, 'committed')
    assert.ok(committed.migration.completedAt)
    assert.equal(committed.pointer.placementEpoch, 2)
    assert.equal(committed.pointer.migrationState, 'active')
    assert.equal(committed.pointer.activeMigrationId, null)
    assert.equal(committed.pointer.poolKind, 'remote_pool')
    assert.equal(committed.pointer.engine, 'codex')
    assert.equal(committed.pointer.nativeSessionId, 'codex-thread-2')
    assert.equal(committed.pointer.profileId, 'prof-remote-9')
    assert.equal(committed.pointer.capsuleId, sha256Hex('cap-2'))
    assert.deepEqual(committed.pointer.usageBaseline, { inputTokens: 1200, outputTokens: 300 })

    // Duplicate commit -> applied: false.
    assert.equal(
      (
        await store.commitPlacementMigration({
          migrationId: began2.migration.migrationId,
          continuityTier: 'warm_capsule',
        })
      ).applied,
      false,
    )

    // Lookup committed migration record.
    const fetched = await store.getPlacementMigration(began2.migration.migrationId)
    assert.equal(fetched?.state, 'committed')
    assert.equal(fetched?.continuityTier, 'warm_capsule')

    // Stale begin at epoch 1 now fails with currentEpoch = 2.
    const staleAfterCommit = await store.beginPlacementMigration({
      userId: 99,
      sessionKey: 'sess-mig',
      expectedPlacementEpoch: 1,
      fromPlacement: LOCAL_PLACEMENT,
      toPlacement: REMOTE_PLACEMENT,
    })
    if (staleAfterCommit.applied) assert.fail('expected stale epoch after commit to fail')
    assert.equal(staleAfterCommit.currentEpoch, 2)
    assert.equal(staleAfterCommit.reason, 'epoch_mismatch')

    // B01: Commit with omitted nativeSessionId/capsuleId/promptCacheMeta/usageBaseline MUST preserve existing values.
    const began3 = await store.beginPlacementMigration({
      userId: 99,
      sessionKey: 'sess-mig',
      expectedPlacementEpoch: 2,
      fromPlacement: REMOTE_PLACEMENT,
      toPlacement: { ...LOCAL_PLACEMENT, placementEpoch: 3 },
    })
    if (!began3.applied) assert.fail('expected third beginPlacementMigration to apply')
    const committed3 = await store.commitPlacementMigration({
      migrationId: began3.migration.migrationId,
      continuityTier: 'cold_degraded',
    })
    if (!committed3.applied) assert.fail('expected third commitPlacementMigration to apply')
    assert.equal(committed3.pointer.placementEpoch, 3)
    assert.equal(committed3.pointer.poolKind, 'local_container')
    assert.equal(committed3.pointer.nativeSessionId, 'codex-thread-2')
    assert.equal(committed3.pointer.capsuleId, sha256Hex('cap-2'))
    assert.equal(committed3.pointer.promptCacheMeta?.affinityKey, 's-0123456789abcdef')
    assert.equal(
      (committed3.pointer.promptCacheMeta?.pendingInstallMigration as { migrationId?: string } | undefined)?.migrationId,
      began3.migration.migrationId,
    )
    assert.equal(
      await store.markPlacementMigrationInstalled(99, 'sess-mig', 3, began3.migration.migrationId),
      true,
    )
    assert.deepEqual((await store.getEnginePointer(99, 'sess-mig'))?.promptCacheMeta, {
      affinityKey: 's-0123456789abcdef',
    })
    assert.deepEqual(committed3.pointer.usageBaseline, { inputTokens: 1200, outputTokens: 300 })
  })

  it('serializes empty-row first upsertEnginePointer with beginPlacementMigration via shared advisory lock and enforces ON CONFLICT WHERE guard (Warning #4)', async () => {
    const pool = new InMemoryThreeLayerPgPool()
    const store = new PgSessionAuthorityStateStore(pool)

    // 1. Hold advisory lock inside beginPlacementMigration while a concurrent empty-row upsertEnginePointer races in.
    let releasePause!: () => void
    const pauseGate = new Promise<void>((resolve) => {
      releasePause = resolve
    })
    let firstLockEntered!: () => void
    const firstLockSignal = new Promise<void>((resolve) => {
      firstLockEntered = resolve
    })
    pool.onAdvisoryLockAcquired = async (_key, count) => {
      if (count === 1) {
        firstLockEntered()
        await pauseGate
      }
    }

    const migrationPromise = store.beginPlacementMigration({
      userId: 303,
      sessionKey: 'sess-empty-race',
      expectedPlacementEpoch: 1,
      fromPlacement: LOCAL_PLACEMENT,
      toPlacement: REMOTE_PLACEMENT,
      reason: 'first_migration_race',
    })
    await firstLockSignal

    // Launch empty-row first write while beginPlacementMigration holds the advisory lock.
    const upsertPromise = store.upsertEnginePointer({
      userId: 303,
      sessionKey: 'sess-empty-race',
      engine: 'ccb',
      nativeSessionId: 'nat-racing-writer',
      expectedPlacementEpoch: 1,
    })

    // Release migration tx; upsertEnginePointer MUST run second, observe migrating state, and fail-closed!
    releasePause()
    const migResult = await migrationPromise
    assert.equal(migResult.applied, true)
    await assert.rejects(() => upsertPromise, /SESSION_PLACEMENT_MIGRATING/)

    // Both transactions MUST have acquired the exact same advisory lock key!
    assert.deepEqual(pool.advisoryLocks, [
      'session-migrate:303:sess-empty-race',
      'session-migrate:303:sess-empty-race',
    ])
    const ptrAfterRace = await store.getEnginePointer(303, 'sess-empty-race')
    assert.equal(ptrAfterRace?.migrationState, 'migrating')
    assert.equal(ptrAfterRace?.nativeSessionId, null)

    // 2. Double-insurance ON CONFLICT DO UPDATE WHERE guard: if row flips to migrating or epoch advances
    // right before conflict resolution, rowCount===0 re-read MUST fail-closed with the exact conflict error!
    pool.onAdvisoryLockAcquired = undefined
    const pool2 = new InMemoryThreeLayerPgPool()
    const store2 = new PgSessionAuthorityStateStore(pool2)
    pool2.beforeOnConflictUpsert = (db, key) => {
      db.pointers.set(key, {
        user_id: '404',
        session_key: 'sess-guard-mig',
        placement_epoch: 1,
        pool_kind: 'local_container',
        engine: 'ccb',
        native_session_id: null,
        operation_id: null,
        profile_id: null,
        capsule_id: null,
        history_json: [],
        rejected_ids_json: [],
        prompt_cache_meta_json: null,
        usage_baseline_json: null,
        history_context_version: null,
        promoted_from_history: false,
        migration_state: 'migrating',
        active_migration_id: 'mig-conflict-1',
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
    }
    await assert.rejects(
      () =>
        store2.upsertEnginePointer({
          userId: 404,
          sessionKey: 'sess-guard-mig',
          engine: 'ccb',
          nativeSessionId: 'nat-late',
          expectedPlacementEpoch: 1,
        }),
      /SESSION_PLACEMENT_MIGRATING/,
    )

    pool2.beforeOnConflictUpsert = (db, key) => {
      db.pointers.set(key, {
        user_id: '404',
        session_key: 'sess-guard-epoch',
        placement_epoch: 2,
        pool_kind: 'remote_pool',
        engine: 'codex',
        native_session_id: 'nat-epoch-2',
        operation_id: null,
        profile_id: null,
        capsule_id: null,
        history_json: [],
        rejected_ids_json: [],
        prompt_cache_meta_json: null,
        usage_baseline_json: null,
        history_context_version: null,
        promoted_from_history: false,
        migration_state: 'active',
        active_migration_id: null,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })
    }
    await assert.rejects(
      () =>
        store2.upsertEnginePointer({
          userId: 404,
          sessionKey: 'sess-guard-epoch',
          engine: 'ccb',
          nativeSessionId: 'nat-stale-1',
          expectedPlacementEpoch: 1,
        }),
      /SESSION_PLACEMENT_EPOCH_MISMATCH/,
    )
  })
})

describe('OCV5-890 Wave 1B: PgLogicalModelBindingStore', () => {
  it('resolves priority-ordered bindings, routes -remote legacy aliases strictly to remote_pool, and toggles enablement', async () => {
    const pool = new InMemoryThreeLayerPgPool()
    const store = new PgLogicalModelBindingStore(pool)

    await store.upsertPoolBinding({
      logicalModelId: 'claude-opus-4-7',
      poolKind: 'remote_pool',
      driverId: 'remote-cc-primary',
      canonicalModelId: 'claude-opus-4-7',
      priority: 20,
      capabilities: SAMPLE_CAPS,
      enabled: true,
    })
    await store.upsertPoolBinding({
      logicalModelId: 'claude-opus-4-7',
      poolKind: 'local_pool',
      driverId: 'local-ccb',
      canonicalModelId: 'claude-opus-4-7',
      priority: 10,
      capabilities: SAMPLE_CAPS,
      enabled: true,
    })
    await store.upsertPoolBinding({
      logicalModelId: 'claude-opus-4-7',
      poolKind: 'remote_pool',
      driverId: 'remote-cc-fast',
      canonicalModelId: 'claude-opus-4-7',
      priority: 5,
      capabilities: SAMPLE_CAPS,
      enabled: true,
    })

    const autoRes = await store.resolveBindingsForModel('claude-opus-4-7')
    assert.equal(autoRes.resolved.logicalModel, 'claude-opus-4-7')
    assert.equal(autoRes.resolved.poolPreference, 'auto')
    assert.equal(autoRes.resolved.isLegacyRemoteAlias, false)
    assert.deepEqual(
      autoRes.bindings.map((b) => b.driverId),
      ['remote-cc-fast', 'local-ccb', 'remote-cc-primary'],
    )

    // Legacy -remote alias filters strictly to remote_pool + pins remote.
    const remoteRes = await store.resolveBindingsForModel('claude-opus-4-7-remote')
    assert.equal(remoteRes.resolved.logicalModel, 'claude-opus-4-7')
    assert.equal(remoteRes.resolved.poolPreference, 'pin_remote')
    assert.equal(remoteRes.resolved.isLegacyRemoteAlias, true)
    assert.deepEqual(
      remoteRes.bindings.map((b) => b.driverId),
      ['remote-cc-fast', 'remote-cc-primary'],
    )

    // Disable remote-cc-fast and verify listAllEnabledBindings & resolve reflect it.
    assert.equal(
      await store.setPoolBindingEnabled('claude-opus-4-7', 'remote_pool', 'remote-cc-fast', false),
      true,
    )
    const afterDisable = await store.listAllEnabledBindings()
    assert.deepEqual(
      afterDisable.map((b) => b.driverId),
      ['local-ccb', 'remote-cc-primary'],
    )
  })

  it('N01: inspectLogicalModelBindings strictly distinguishes unconfigured vs configured-all-disabled vs read failure', async () => {
    const pool = new InMemoryThreeLayerPgPool()
    const store = new PgLogicalModelBindingStore(pool)

    // 1) Never configured -> status: 'unconfigured', totalCount: 0
    const unconfigured = await store.inspectLogicalModelBindings('claude-opus-4-7')
    assert.equal(unconfigured.status, 'unconfigured')
    assert.equal(unconfigured.totalCount, 0)
    assert.equal(unconfigured.enabledBindings.length, 0)
    assert.equal(unconfigured.hasConfiguredBindings, false)

    // 2) Configured with enabled + disabled bindings -> status: 'configured'
    await store.upsertPoolBinding({
      logicalModelId: 'claude-opus-4-7',
      poolKind: 'local_pool',
      driverId: 'local-cc',
      canonicalModelId: 'claude-opus-4-7',
      priority: 1,
      capabilities: SAMPLE_CAPS,
      enabled: true,
    })
    await store.upsertPoolBinding({
      logicalModelId: 'claude-opus-4-7',
      poolKind: 'remote_pool',
      driverId: 'remote-cc',
      canonicalModelId: 'claude-opus-4-7-remote',
      priority: 2,
      capabilities: SAMPLE_CAPS,
      enabled: false,
    })
    const partial = await store.inspectLogicalModelBindings('claude-opus-4-7')
    assert.equal(partial.status, 'configured')
    assert.equal(partial.totalCount, 2)
    assert.equal(partial.enabledBindings.length, 1)
    assert.equal(partial.enabledBindings[0]!.driverId, 'local-cc')
    assert.equal(partial.hasConfiguredBindings, true)

    // 3) Disable the last enabled binding -> status remains 'configured' (totalCount: 2, enabledBindings: [])
    assert.equal(
      await store.setPoolBindingEnabled('claude-opus-4-7', 'local_pool', 'local-cc', false),
      true,
    )
    const allDisabled = await store.inspectLogicalModelBindings('claude-opus-4-7')
    assert.equal(allDisabled.status, 'configured')
    assert.equal(allDisabled.totalCount, 2)
    assert.equal(allDisabled.enabledBindings.length, 0)
    assert.equal(allDisabled.hasConfiguredBindings, true)

    // 4) Underlying DB read failure MUST propagate (never silently return 'unconfigured')
    pool.failBindingReads = true
    await assert.rejects(
      () => store.inspectLogicalModelBindings('claude-opus-4-7'),
      /MOCK_PG_BINDING_READ_ERROR/,
    )
  })
})

describe('OCV5-890 Wave 1B: PgArtifactBlobMetaStore', () => {
  it('supports idempotent part recording, rejects tampered parts, and enforces fail-closed GC reference proof', async () => {
    const pool = new InMemoryThreeLayerPgPool()
    const store = new PgArtifactBlobMetaStore(pool)

    const upload = await store.initiateUpload({
      uploadId: 'upl-test-0001',
      tenantId: 'c:42',
      kind: 'upload',
      filename: 'spec.pdf',
      mimeType: 'application/pdf',
      expectedSizeBytes: 100_000,
      chunkBytes: 65_536,
      chunkCount: 2,
    })
    assert.equal(upload.status, 'open')

    const part0Sha = sha256Hex('part-0-content')
    assert.equal(await store.recordPart('upl-test-0001', 0, 65_536, part0Sha), 'recorded')
    // Duplicate same index + same sha256 -> idempotent.
    assert.equal(await store.recordPart('upl-test-0001', 0, 65_536, part0Sha), 'idempotent')
    // Same index + different sha256 -> fail-closed mismatch!
    await assert.rejects(
      () => store.recordPart('upl-test-0001', 0, 65_536, sha256Hex('tampered-part-0')),
      /BLOB_PART_SHA256_MISMATCH/,
    )

    const wholeSha = sha256Hex('whole-file')
    const blob1 = await store.completeUpload('upl-test-0001', {
      blobId: 'blob-00000001',
      tenantId: 'c:42',
      sha256: wholeSha,
      sizeBytes: 100_000,
      mimeType: 'application/pdf',
      kind: 'upload',
      logicalName: 'spec.pdf',
      storageBackend: 'local_cas',
      storageUri: `cas://sha256/${wholeSha}`,
    })
    assert.equal(blob1.blobId, 'blob-00000001')
    assert.equal((await store.statBlob('c:42', 'blob-00000001'))?.sha256, wholeSha)
    assert.equal(await store.statBlob('c:99', 'blob-00000001'), null)

    // Add a second live blob and a recent unreferenced blob.
    const blob2Sha = sha256Hex('live-blob')
    await store.insertBlob({
      blobId: 'blob-00000002',
      tenantId: 'c:42',
      sha256: blob2Sha,
      sizeBytes: 128,
      mimeType: 'text/plain',
      kind: 'generated',
      storageUri: `cas://sha256/${blob2Sha}`,
    })

    // Advance clock 2 hours, then insert a fresh blob.
    pool.advanceClock(2 * 60 * 60 * 1000)
    const blob3Sha = sha256Hex('fresh-blob')
    await store.insertBlob({
      blobId: 'blob-00000003',
      tenantId: 'c:42',
      sha256: blob3Sha,
      sizeBytes: 64,
      mimeType: 'text/plain',
      kind: 'generated',
      storageUri: `cas://sha256/${blob3Sha}`,
    })

    assert.equal((await store.listTenantBlobs('c:42')).length, 3)
    assert.equal((await store.listTenantBlobs('c:42', 'generated')).length, 2)

    // GC without completeReferenceProof=true MUST throw fail-closed!
    await assert.rejects(
      () =>
        store.gcUnreferencedBlobs({
          completeReferenceProof: false,
          liveBlobIds: ['blob-00000002'],
          olderThanMs: 60 * 60 * 1000,
          nowMs: pool.state.clockMs,
        }),
      /BLOB_GC_INCOMPLETE_REFERENCE_PROOF/,
    )
    // Nothing was deleted.
    assert.equal((await store.listTenantBlobs('c:42')).length, 3)

    // GC with completeReferenceProof=true deletes only blob-00000001 (unreferenced & >1h old).
    const gcRes = await store.gcUnreferencedBlobs({
      completeReferenceProof: true,
      liveBlobIds: new Set(['blob-00000002']),
      olderThanMs: 60 * 60 * 1000,
      nowMs: pool.state.clockMs,
    })
    assert.deepEqual(gcRes.markedDeletedBlobIds, ['blob-00000001'])
    assert.equal(gcRes.markedDeletedCount, 1)
    assert.equal(await store.statBlob('c:42', 'blob-00000001'), null)
    assert.ok(await store.statBlob('c:42', 'blob-00000002'))
    assert.ok(await store.statBlob('c:42', 'blob-00000003'))
  })
})
