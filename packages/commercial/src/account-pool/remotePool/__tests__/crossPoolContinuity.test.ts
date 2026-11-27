import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  MODEL_AUTHORITY_FIELD,
  REMOTE_DRIVER_BACKEND,
  parseAuthorityKeyring,
  type RemoteExecutionBackend,
} from '@openclaude/protocol'
import {
  MIGRATION_INSTALL_RECEIPT_TYPE,
  finalizeInboundCrossPoolMigration,
  ingestVerifiedCrossPoolCheckpoint,
} from '../../../../../gateway/src/crossPoolCheckpoint.js'
import { ModelAuthorityConsumer } from '../../../../../gateway/src/modelAuthority.js'
import {
  peekPendingCheckpoint,
  savePendingCheckpointWithGeneration,
} from '../../../../../gateway/src/sessionCheckpointStore.js'
import {
  CAPABILITY_SCHEMA_VERSION,
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from '../../../billing/modelCatalog.js'
import {
  PgSessionAuthorityStateStore,
  extractPendingInstallMigration,
  type PgQueryResult,
  type PgTransactionClient,
  type PgTransactionPool,
} from '../../../db/threeLayerStateStore.js'
import { AuthoritySigner } from '../../../ws/authoritySigner.js'
import {
  CROSS_POOL_CHECKPOINT_FIELD,
  buildCrossPoolCheckpointWirePayload,
  extractCrossPoolCheckpointGeneration,
  parseAndHandleMigrationInstallReceipt,
  resolveRemotePoolBackendAndSeal,
  shouldMarkInstallFromDispatchReceipt,
  tryMarkLegacyColdInstallFromReceipt,
  type CrossPoolMigrationCommittedMeta,
  type MigrationInstallDispatchLookupRecord,
} from '../../../ws/userChatBridgeRemotePoolSeal.js'
import {
  CROSS_POOL_CHECKPOINT_MAX_CHARS,
  buildCrossPoolAnchoredSummary,
  ensureCrossPoolRollingCheckpoint,
} from '../crossPoolContinuity.js'
import {
  createSelfhostCrossPoolFallbackSelector,
  createSelfhostForcedLocalMigrationResolver,
  createSelfhostReturnToRemoteGrantResolver,
} from '../selfhostCrossPoolSelector.js'

interface MockContinuityDb {
  pointers: Map<string, Record<string, unknown>>
  checkpoints: Map<string, Record<string, unknown>>
  migrations: Map<string, Record<string, unknown>>
  remoteBindings: Map<string, { operation_id: string; profile_id: string | null }>
  clockMs: number
}

function cloneDb(s: MockContinuityDb): MockContinuityDb {
  const cloneMap = <T>(m: Map<string, T>) =>
    new Map([...m.entries()].map(([k, v]) => [k, JSON.parse(JSON.stringify(v)) as T]))
  return {
    pointers: cloneMap(s.pointers),
    checkpoints: cloneMap(s.checkpoints),
    migrations: cloneMap(s.migrations),
    remoteBindings: cloneMap(s.remoteBindings),
    clockMs: s.clockMs,
  }
}

class InMemoryContinuityPgPool implements PgTransactionPool {
  state: MockContinuityDb = {
    pointers: new Map(),
    checkpoints: new Map(),
    migrations: new Map(),
    remoteBindings: new Map(),
    clockMs: Date.parse('2026-11-26T10:00:00.000Z'),
  }

  private nowIso(db: MockContinuityDb): string {
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
    let txState: MockContinuityDb | null = null
    return {
      query: async <R extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<PgQueryResult<R>> => {
        const upper = sql.trim().toUpperCase()
        if (upper === 'BEGIN') {
          txState = cloneDb(this.state)
          return { rows: [], rowCount: 0 }
        }
        if (upper === 'COMMIT') {
          if (txState) {
            this.state = txState
            txState = null
          }
          return { rows: [], rowCount: 0 }
        }
        if (upper === 'ROLLBACK') {
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
    db: MockContinuityDb,
    rawSql: string,
    params: unknown[],
  ): PgQueryResult<Record<string, unknown>> {
    const sql = rawSql.replace(/\s+/g, ' ').trim()
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 }
    }
    if (sql.includes('FROM session_engine_pointers') && sql.startsWith('SELECT')) {
      const row = db.pointers.get(`${params[0]}::${params[1]}`)
      return row ? { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.startsWith('INSERT INTO session_engine_pointers') && sql.includes('ON CONFLICT')) {
      const k = `${params[0]}::${params[1]}`
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
        promoted_from_history: Boolean(params[13]),
        migration_state: prev ? prev.migration_state : 'active',
        active_migration_id: prev ? prev.active_migration_id : null,
        created_at: prev ? prev.created_at : now,
        updated_at: now,
      }
      db.pointers.set(k, row)
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO session_engine_pointers')) {
      const k = `${params[0]}::${params[1]}`
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
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }
    if (sql.startsWith("UPDATE session_engine_pointers SET migration_state = 'migrating'")) {
      const row = db.pointers.get(`${params[0]}::${params[1]}`)
      if (!row || Number(row.placement_epoch) !== Number(params[2]) || row.migration_state !== 'active') {
        return { rows: [], rowCount: 0 }
      }
      row.migration_state = 'migrating'
      row.active_migration_id = params[3]
      row.updated_at = this.nowIso(db)
      return { rows: [{ placement_epoch: row.placement_epoch }], rowCount: 1 }
    }
    if (sql.startsWith('UPDATE session_engine_pointers SET placement_epoch = $3')) {
      const row = db.pointers.get(`${params[0]}::${params[1]}`)
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
      if (params[14] === true) {
        row.prompt_cache_meta_json = params[9] === null ? null : JSON.parse(String(params[9]))
      }
      row.updated_at = this.nowIso(db)
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }
    if (sql.startsWith("UPDATE session_engine_pointers SET migration_state = 'active'")) {
      const row = db.pointers.get(`${params[0]}::${params[1]}`)
      if (!row || row.active_migration_id !== params[2] || row.migration_state !== 'migrating') {
        return { rows: [], rowCount: 0 }
      }
      row.migration_state = 'active'
      row.active_migration_id = null
      row.updated_at = this.nowIso(db)
      return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
    }
    if (sql.startsWith('UPDATE session_engine_pointers SET prompt_cache_meta_json = $3')) {
      const row = db.pointers.get(`${params[0]}::${params[1]}`)
      if (!row || Number(row.placement_epoch) !== Number(params[3])) {
        return { rows: [], rowCount: 0 }
      }
      row.prompt_cache_meta_json = params[2] === null ? null : JSON.parse(String(params[2]))
      row.updated_at = this.nowIso(db)
      return { rows: [{ placement_epoch: row.placement_epoch }], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO session_rolling_checkpoints')) {
      const key = `${params[0]}::${params[1]}::${params[3]}`
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
      db.checkpoints.set(key, row)
      return {
        rows: [{ checkpoint_generation: row.checkpoint_generation, created_at: row.created_at }],
        rowCount: 1,
      }
    }
    if (sql.includes('FROM session_rolling_checkpoints') && sql.startsWith('SELECT')) {
      const uid = String(params[0])
      const sKey = String(params[1])
      const onlyUnacked = sql.includes('acked_at IS NULL')
      if (sql.includes('checkpoint_generation = $3')) {
        const gen = String(params[2])
        const row = db.checkpoints.get(`${uid}::${sKey}::${gen}`)
        if (!row || (onlyUnacked && row.acked_at !== null)) return { rows: [], rowCount: 0 }
        return { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 }
      }
      const hasEpoch = sql.includes('placement_epoch = $3')
      const expectedEpoch = hasEpoch ? Number(params[2]) : undefined
      const rows = [...db.checkpoints.values()]
        .filter(
          (r) =>
            r.user_id === uid &&
            r.session_key === sKey &&
            (!onlyUnacked || r.acked_at === null) &&
            (!hasEpoch || Number(r.placement_epoch) === expectedEpoch),
        )
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      return rows[0]
        ? { rows: [JSON.parse(JSON.stringify(rows[0]))], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (sql.startsWith('UPDATE session_rolling_checkpoints')) {
      const row = db.checkpoints.get(`${params[0]}::${params[1]}::${params[2]}`)
      if (!row || row.acked_at !== null) return { rows: [], rowCount: 0 }
      row.acked_by_turn_key = String(params[3])
      row.acked_at = this.nowIso(db)
      return { rows: [{ checkpoint_generation: row.checkpoint_generation }], rowCount: 1 }
    }
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
      return row ? { rows: [JSON.parse(JSON.stringify(row))], rowCount: 1 } : { rows: [], rowCount: 0 }
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
    if (sql.includes('FROM remote_agent_bindings') && !sql.includes('FROM request_finalize_journal')) {
      if (/\buser_id\b/i.test(sql) || !/\buid\s*=\s*\$1\b/i.test(sql)) {
        throw new Error('column "user_id" does not exist on remote_agent_bindings (schema uses uid)')
      }
      const rb = db.remoteBindings.get(`${params[0]}::${params[1]}`)
      return rb ? { rows: [JSON.parse(JSON.stringify(rb))], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (
      sql.includes('FROM model_logical_pool_bindings') ||
      sql.includes('FROM request_finalize_journal')
    ) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`Unexpected SQL in InMemoryContinuityPgPool: ${sql}`)
  }
}

function makeCatalog(): ModelCatalogSnapshot {
  const entries: ModelCatalogEntry[] = [
    {
      entryId: 1,
      modelId: 'claude-opus-4-6-remote',
      engine: 'ccb',
      providerId: 'anthropic',
      upstreamModelId: 'claude-opus-4-6',
      contextWindow: 200_000,
      capabilityProfile: {
        supportsVision: true,
        reasoning: { supported: ['low', 'medium', 'high'], codexModelDefault: null },
        ccb: { capabilityZero: true, supportsThinking: true },
      },
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      state: 'active',
      lockVersion: 1,
      placement: 'remote_pool',
    },
    {
      entryId: 2,
      modelId: 'claude-opus-4-6',
      engine: 'ccb',
      providerId: 'anthropic',
      upstreamModelId: 'claude-opus-4-6',
      contextWindow: 200_000,
      capabilityProfile: {
        supportsVision: true,
        reasoning: { supported: ['low', 'medium', 'high'], codexModelDefault: null },
        ccb: { capabilityZero: true, supportsThinking: true },
      },
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      state: 'active',
      lockVersion: 1,
      placement: 'local',
    },
  ]
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
  return new ModelCatalogSnapshot({ entries, aliases: new Map(), pricing, securityEpoch: 11n })
}

describe('OCV5-902 P0-1: Cross-Pool Continuity (tape_rebuilt)', () => {
  it('buildCrossPoolAnchoredSummary preserves first-turn goal, constraints/anchors, recent 2 turns, tools, and media while excluding current message', () => {
    const rawHistory = [
      {
        role: 'user',
        clientMessageId: 'cmid-1',
        text: '请重构 packages/commercial/src/db/threeLayerStateStore.ts 以支持跨池续聊 (OCV5-902)',
        seq: 1,
      },
      {
        role: 'assistant',
        text: '已检查基线提交 deadbeef1234，准备方案。',
        tool_calls: [{ name: 'read_file', path: 'packages/commercial/src/db/threeLayerStateStore.ts' }],
        seq: 2,
      },
      {
        role: 'user',
        clientMessageId: 'cmid-2',
        content: '严禁修改 packages/protocol/src/modelAuthority.ts；确定端口保持 18789，绝不执行 git push。',
        seq: 3,
      },
      {
        role: 'assistant',
        text: '明白，只改允许的文件，并检查了设计图。',
        media: [{ path: '/var/data/uploads/arch-diagram.png' }],
        tools: [{ toolName: 'grep_search', status: 'ok' }],
        seq: 4,
      },
      {
        role: 'user',
        clientMessageId: 'cmid-current',
        text: '继续执行当前这轮用户消息（应被排除）',
        seq: 5,
      },
    ]

    const built = buildCrossPoolAnchoredSummary(rawHistory, {
      excludeClientMessageId: 'cmid-current',
    })
    assert.ok(built !== null)
    assert.equal(built.messageCount, 4)
    assert.equal(built.anchorSeq, 4)
    assert.ok(built.summary.length <= CROSS_POOL_CHECKPOINT_MAX_CHARS)
    assert.ok(built.summary.includes('First-Turn Goal'))
    assert.ok(built.summary.includes('严禁修改 packages/protocol/src/modelAuthority.ts'))
    assert.ok(built.summary.includes('OCV5-902'))
    assert.ok(built.summary.includes('deadbeef1234'))
    assert.ok(built.summary.includes('/var/data/uploads/arch-diagram.png'))
    assert.ok(built.summary.includes('read_file'))
    assert.ok(built.summary.includes('grep_search'))
    assert.ok(!built.summary.includes('应被排除'))

    // Negative: empty or all-excluded history returns null (honest cold_degraded, never empty checkpoint)
    assert.equal(buildCrossPoolAnchoredSummary([]), null)
    assert.equal(
      buildCrossPoolAnchoredSummary([{ role: 'user', clientMessageId: 'only-1', text: 'hi' }], {
        excludeClientMessageId: 'only-1',
      }),
      null,
    )

    // Strict maxChars bounding
    const longMsg = 'A'.repeat(20_000)
    const bounded = buildCrossPoolAnchoredSummary([{ role: 'user', text: longMsg }], {
      maxChars: 1_200,
    })
    assert.ok(bounded !== null)
    assert.ok(bounded.summary.length <= 1_200)
  })

  it('PG pendingInstallMigration stays backward-compatible with legacy JSON rows and supports by-generation lookup + atomic install ack', async () => {
    const legacy = extractPendingInstallMigration({
      pendingInstallMigration: {
        migrationId: 'mig-legacy-0001',
        targetPoolKind: 'local_container',
        targetEpoch: 2,
        targetOperationId: null,
        continuityTier: 'cold_degraded',
        committedAtMs: 1700000000000,
      },
    })
    assert.ok(legacy !== null)
    assert.equal(legacy.migrationId, 'mig-legacy-0001')
    assert.equal(legacy.checkpointGeneration, null)

    const pgPool = new InMemoryContinuityPgPool()
    const store = new PgSessionAuthorityStateStore(pgPool)
    const uid = 51
    const sessionKey = 'agent:main:webchat:dm:p01-pg-compat'

    await store.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: 'remote_pool',
      engine: 'ccb',
      nativeSessionId: 'nat-r1',
    })

    const saved = await store.saveRollingCheckpoint({
      userId: uid,
      sessionKey,
      sessionId: 'sess-p01-1',
      expectedPlacementEpoch: 1,
      mode: 'anchored_v2',
      anchorSeq: 3,
      sourceEngine: 'ccb',
      summary: 'Epoch 1 warm summary',
    })

    const begun = await store.beginPlacementMigration({
      userId: uid,
      sessionKey,
      expectedPlacementEpoch: 1,
      fromPlacement: { poolKind: 'remote_pool', engine: 'ccb', driverId: 'cc', placementEpoch: 1 },
      toPlacement: {
        poolKind: 'local_container',
        engine: 'ccb',
        driverId: 'local-cc',
        placementEpoch: 2,
        containerId: '99',
      },
    })
    assert.equal(begun.applied, true)
    if (!begun.applied) return

    const committed = await store.commitPlacementMigration({
      migrationId: begun.migration.migrationId,
      userId: uid,
      sessionKey,
      continuityTier: 'tape_rebuilt',
      checkpointGeneration: saved.checkpointGeneration,
    })
    assert.equal(committed.applied, true)
    if (!committed.applied) return

    const pending = extractPendingInstallMigration(committed.pointer.promptCacheMeta)
    assert.equal(pending?.checkpointGeneration, saved.checkpointGeneration)

    // After epoch bumped 1 -> 2, peekRollingCheckpoint(..., 2) is null, but getRollingCheckpointByGeneration finds epoch-1 row!
    assert.equal(await store.peekRollingCheckpoint(uid, sessionKey, 2), null)
    const byGen = await store.getRollingCheckpointByGeneration(
      uid,
      sessionKey,
      saved.checkpointGeneration,
    )
    assert.ok(byGen !== null)
    assert.equal(byGen.placementEpoch, 1)
    assert.equal(byGen.summary, 'Epoch 1 warm summary')

    // B1: Omitting or mismatching checkpointGeneration on a warm pending install MUST fail closed
    const missingGenRes = await store.markPlacementMigrationInstalledAndAckCheckpoint(
      uid,
      sessionKey,
      2,
      begun.migration.migrationId,
      { consumedByTurnKey: 'turn-key-missing-gen' },
    )
    assert.deepEqual(missingGenRes, {
      installed: false,
      checkpointAcked: false,
      checkpointGeneration: null,
    })
    const wrongGenRes = await store.markPlacementMigrationInstalledAndAckCheckpoint(
      uid,
      sessionKey,
      2,
      begun.migration.migrationId,
      { checkpointGeneration: 'cp-wrong-gen', consumedByTurnKey: 'turn-key-wrong-gen' },
    )
    assert.deepEqual(wrongGenRes, {
      installed: false,
      checkpointAcked: false,
      checkpointGeneration: null,
    })

    // Exact generation clears pendingInstallMigration AND acks checkpoint atomically in 1 PG tx
    const installRes = await store.markPlacementMigrationInstalledAndAckCheckpoint(
      uid,
      sessionKey,
      2,
      begun.migration.migrationId,
      {
        checkpointGeneration: saved.checkpointGeneration,
        consumedByTurnKey: 'turn-key-p01-1',
        requireWarmCheckpointMatch: true,
      },
    )
    assert.deepEqual(installRes, {
      installed: true,
      checkpointAcked: true,
      checkpointGeneration: saved.checkpointGeneration,
    })

    // Second call is strictly idempotent (no-op)
    const installRes2 = await store.markPlacementMigrationInstalledAndAckCheckpoint(
      uid,
      sessionKey,
      2,
      begun.migration.migrationId,
      { checkpointGeneration: saved.checkpointGeneration },
    )
    assert.equal(installRes2.installed, false)
    assert.equal(installRes2.checkpointAcked, false)

    // Unacked lookup now returns null, while includeAcked sees ackedByTurnKey
    assert.equal(
      await store.getRollingCheckpointByGeneration(uid, sessionKey, saved.checkpointGeneration),
      null,
    )
    const ackedRow = await store.getRollingCheckpointByGeneration(
      uid,
      sessionKey,
      saved.checkpointGeneration,
      { includeAcked: true },
    )
    assert.equal(ackedRow?.ackedByTurnKey, 'turn-key-p01-1')
  })

  it('ensureCrossPoolRollingCheckpoint reuses existing unacked checkpoint and fails open on loader errors', async () => {
    const pgPool = new InMemoryContinuityPgPool()
    const store = new PgSessionAuthorityStateStore(pgPool)
    const uid = 52
    const sessionKey = 'agent:main:webchat:dm:p01-ensure'

    await store.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: 'remote_pool',
      engine: 'ccb',
    })

    let loaderCalls = 0
    const cp1 = await ensureCrossPoolRollingCheckpoint({
      authorityStore: store,
      uid,
      sessionKey,
      sessionId: 'sess-ensure-1',
      sourcePlacementEpoch: 1,
      sourceEngine: 'ccb',
      rawHistory: [{ role: 'user', text: '保持生产配置不变，不要删除数据库。' }],
      loadHistory: async () => {
        loaderCalls += 1
        return []
      },
    })
    assert.ok(cp1 !== null)
    assert.equal(loaderCalls, 0)

    // Second call reuses existing unacked checkpoint without saving a duplicate
    const cp2 = await ensureCrossPoolRollingCheckpoint({
      authorityStore: store,
      uid,
      sessionKey,
      sessionId: 'sess-ensure-1',
      sourcePlacementEpoch: 1,
      sourceEngine: 'ccb',
      loadHistory: async () => {
        loaderCalls += 1
        return [{ role: 'user', text: 'different history' }]
      },
    })
    assert.equal(cp2?.checkpointGeneration, cp1.checkpointGeneration)
    assert.equal(loaderCalls, 0)
    assert.equal(pgPool.state.checkpoints.size, 1)

    // Fail-open when loader throws on a fresh session
    const failed = await ensureCrossPoolRollingCheckpoint({
      authorityStore: store,
      uid,
      sessionKey: 'agent:main:webchat:dm:p01-ensure-err',
      sessionId: 'sess-err',
      sourcePlacementEpoch: 1,
      sourceEngine: 'ccb',
      loadHistory: async () => {
        throw new Error('DB_TEMP_DOWN')
      },
    })
    assert.equal(failed, null)
  })

  it('full closed loop: remote -> local (tape_rebuilt + wire payload + container ingest + first-frame redelivery + install ack) -> local -> remote recovery & honest cold_degraded on empty history', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ocv5-p01-loop-'))
    try {
      const pgPool = new InMemoryContinuityPgPool()
      const authorityStore = new PgSessionAuthorityStateStore(pgPool)
      const snapshot = makeCatalog()
      const uid = 60
      const containerId = 108
      const sessionKey = 'agent:main:webchat:dm:p01-full-loop'
      const sessionId = 'sess-p01-full-loop'

      const signer = AuthoritySigner.createEphemeral()
      const consumer = new ModelAuthorityConsumer({
        keyring: parseAuthorityKeyring(signer.publicKeyringEnv()),
        uid,
        containerId,
        required: true,
      })

      const makeExec = (modelId: string) => {
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
        exec: ReturnType<typeof makeExec>,
        billingRequestId?: string,
        authorityTurnId?: string,
        executionBackend?: RemoteExecutionBackend,
        poolMigration?: Parameters<AuthoritySigner['signBundle']>[0]['poolMigration'],
      ) =>
        signer.signBundle({
          uid,
          containerId,
          connectionChallenge: 'conn-p01-1',
          canonicalModel: exec.canonicalModel,
          engine: exec.engine,
          executionDescriptor: exec.descriptor,
          auxModels: [],
          ...(executionBackend ? { executionBackend } : {}),
          ...(poolMigration ? { poolMigration } : {}),
          ...(authorityTurnId ? { authorityTurnId } : {}),
          ...(billingRequestId ? { billingRequestId } : {}),
          executionRevision: 'rev-p01',
          securityEpoch: exec.securityEpoch,
        }).bundle

      await authorityStore.upsertEnginePointer({
        userId: uid,
        sessionKey,
        poolKind: 'remote_pool',
        engine: 'ccb',
        nativeSessionId: 'remote-nat-1',
      })

      const fallbackSelector = createSelfhostCrossPoolFallbackSelector({
        pool: pgPool,
        catalogCache: { assertFresh: async () => snapshot },
        selfhost: true,
        authorityStore,
      })
      const returnResolver = createSelfhostReturnToRemoteGrantResolver({
        pool: pgPool,
        selfhost: true,
        authorityStore,
      })

      const historyTurn2 = [
        { role: 'user', clientMessageId: 'm1', text: '目标：修复 OCV5-902 跨池续聊，不要修改 modelAuthority.ts' },
        { role: 'assistant', text: '已完成初步排查，正在编写 deterministic checkpoint。' },
        { role: 'user', clientMessageId: 'm2-cur', text: '继续执行当前轮' },
      ]

      const committedMetas: CrossPoolMigrationCommittedMeta[] = []
      const turn2Sealed = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        sessionId,
        historicalMessages: historyTurn2,
        excludeClientMessageId: 'm2-cur',
        exec: makeExec('claude-opus-4-6-remote'),
        log: null,
        cc5BackendSelector: async () => {
          throw new Error('REMOTE_LANE_CAPACITY_EXHAUSTED')
        },
        crossPoolFallbackSelector: fallbackSelector,
        returnToRemoteGrantResolver: returnResolver,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        onMigrationCommitted: (meta) => committedMetas.push(meta),
        reject: async () => null,
      })

      assert.ok(turn2Sealed !== null)
      assert.equal(turn2Sealed.model, 'claude-opus-4-6')
      const cpGenTurn2 = extractCrossPoolCheckpointGeneration(turn2Sealed)
      assert.ok(cpGenTurn2 !== null)
      assert.equal(committedMetas.length, 1)
      assert.equal(committedMetas[0]!.continuityTier, 'tape_rebuilt')
      assert.equal(committedMetas[0]!.checkpointGeneration, cpGenTurn2)

      // Container verifies Ed25519 signature (strictly 4 fields on poolMigration!) and ingests checkpoint
      const verifiedTurn2 = consumer.consume(turn2Sealed, { challenge: 'conn-p01-1' })
      assert.equal(verifiedTurn2.poolMigration?.continuityTier, 'tape_rebuilt')
      assert.equal(verifiedTurn2.poolMigration?.placementEpoch, 2)
      assert.deepEqual(
        Object.keys(verifiedTurn2.poolMigration!).sort(),
        ['allowBackendTransition', 'continuityTier', 'migrationId', 'placementEpoch'],
      )

      const ingest2 = ingestVerifiedCrossPoolCheckpoint(turn2Sealed, verifiedTurn2, sessionKey, {
        baseDir: tmpDir,
        saveCheckpoint: savePendingCheckpointWithGeneration,
      })
      assert.deepEqual(ingest2, {
        accepted: true,
        generation: cpGenTurn2,
        migrationId: verifiedTurn2.poolMigration!.migrationId,
        placementEpoch: 2,
      })
      const persisted2 = peekPendingCheckpoint(sessionKey, tmpDir)
      assert.equal(persisted2?.generation, cpGenTurn2)
      assert.ok(persisted2?.summary.includes('OCV5-902'))

      // First-frame lost retry BEFORE markPlacementMigrationInstalled:
      // Must re-deliver exact migrationGrant AND exact _crossPoolCheckpoint without bumping epoch!
      const turn2Retry = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        sessionId,
        historicalMessages: historyTurn2,
        excludeClientMessageId: 'm2-cur',
        exec: makeExec('claude-opus-4-6-remote'),
        log: null,
        cc5BackendSelector: async () => {
          throw new Error('REMOTE_LANE_UNAVAILABLE')
        },
        crossPoolFallbackSelector: fallbackSelector,
        returnToRemoteGrantResolver: returnResolver,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async () => null,
      })
      assert.ok(turn2Retry !== null)
      assert.equal(extractCrossPoolCheckpointGeneration(turn2Retry), cpGenTurn2)
      const verifiedTurn2Retry = consumer.consume(turn2Retry, { challenge: 'conn-p01-1' })
      assert.equal(
        verifiedTurn2Retry.poolMigration?.migrationId,
        verifiedTurn2.poolMigration!.migrationId,
      )
      assert.equal(verifiedTurn2Retry.poolMigration?.continuityTier, 'tape_rebuilt')
      assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 2)

      // Container confirms installation -> clears pendingInstallMigration AND acks PG checkpoint
      const acked2 = await authorityStore.markPlacementMigrationInstalledAndAckCheckpoint(
        uid,
        sessionKey,
        2,
        verifiedTurn2.poolMigration!.migrationId,
        {
          checkpointGeneration: cpGenTurn2,
          consumedByTurnKey: 'turn-2-ok',
          requireWarmCheckpointMatch: true,
        },
      )
      assert.equal(acked2.installed, true)
      assert.equal(acked2.checkpointAcked, true)

      // Subsequent local turn omits grant and _crossPoolCheckpoint
      const turn2Steady = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        sessionId,
        historicalMessages: historyTurn2,
        exec: makeExec('claude-opus-4-6-remote'),
        log: null,
        cc5BackendSelector: async () => {
          throw new Error('REMOTE_LANE_UNAVAILABLE')
        },
        crossPoolFallbackSelector: fallbackSelector,
        returnToRemoteGrantResolver: returnResolver,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async () => null,
      })
      assert.ok(turn2Steady !== null)
      assert.equal(turn2Steady[CROSS_POOL_CHECKPOINT_FIELD], undefined)

      // Turn 3: Return to remote -> builds epoch-2 checkpoint, commits epoch 2 -> 3 with tape_rebuilt
      const remoteBackend: RemoteExecutionBackend = Object.freeze({
        kind: REMOTE_DRIVER_BACKEND,
        version: 4 as const,
        driverId: 'cc',
        driverVersion: '5.0.0',
        engineId: 'cc',
        authorityEngine: 'ccb' as const,
        sessionKey,
        operationId: '77777777-7777-4777-8777-777777777777',
        generation: '1',
        profileId: 'prof-cc-1',
        authEpoch: 'epoch-1',
      })
      const turn3Sealed = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        sessionId,
        historicalMessages: [
          ...historyTurn2,
          { role: 'assistant', text: '已在本地池完成 checkpoint 实现，准备切回远端池继续。' },
        ],
        exec: makeExec('claude-opus-4-6-remote'),
        log: null,
        cc5BackendSelector: async () => remoteBackend,
        crossPoolFallbackSelector: fallbackSelector,
        returnToRemoteGrantResolver: returnResolver,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async () => null,
      })
      assert.ok(turn3Sealed !== null)
      const cpGenTurn3 = extractCrossPoolCheckpointGeneration(turn3Sealed)
      assert.ok(cpGenTurn3 !== null && cpGenTurn3 !== cpGenTurn2)
      const verifiedTurn3 = consumer.consume(turn3Sealed, { challenge: 'conn-p01-1' })
      assert.equal(verifiedTurn3.poolMigration?.placementEpoch, 3)
      assert.equal(verifiedTurn3.poolMigration?.continuityTier, 'tape_rebuilt')

      // First-frame lost retry on return-to-remote re-delivers exact epoch-2 checkpoint by generation
      const turn3Retry = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        sessionId,
        exec: makeExec('claude-opus-4-6-remote'),
        log: null,
        cc5BackendSelector: async () => remoteBackend,
        crossPoolFallbackSelector: fallbackSelector,
        returnToRemoteGrantResolver: returnResolver,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async () => null,
      })
      assert.ok(turn3Retry !== null)
      assert.equal(extractCrossPoolCheckpointGeneration(turn3Retry), cpGenTurn3)

      // Negative: empty history degrades honestly to cold_degraded without _crossPoolCheckpoint
      const emptySessionKey = 'agent:main:webchat:dm:p01-empty-history'
      await authorityStore.upsertEnginePointer({
        userId: uid,
        sessionKey: emptySessionKey,
        poolKind: 'remote_pool',
        engine: 'ccb',
      })
      let coldMeta: CrossPoolMigrationCommittedMeta | undefined
      const coldSealed = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey: emptySessionKey,
        sessionId: 'sess-empty',
        historicalMessages: [],
        exec: makeExec('claude-opus-4-6-remote'),
        log: null,
        cc5BackendSelector: async () => {
          throw new Error('REMOTE_LANE_CAPACITY_EXHAUSTED')
        },
        crossPoolFallbackSelector: fallbackSelector,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        onMigrationCommitted: (meta) => {
          coldMeta = meta
        },
        reject: async () => null,
      })
      assert.ok(coldSealed !== null)
      assert.equal(coldSealed[CROSS_POOL_CHECKPOINT_FIELD], undefined)
      assert.equal(coldMeta?.continuityTier, 'cold_degraded')
      assert.equal(coldMeta?.checkpointGeneration, null)
      const verifiedCold = consumer.consume(coldSealed, { challenge: 'conn-p01-1' })
      assert.equal(verifiedCold.poolMigration?.continuityTier, 'cold_degraded')
      assert.equal(verifiedCold[MODEL_AUTHORITY_FIELD as never], undefined)

      // Negative: buildCrossPoolCheckpointWirePayload rejects non-tape_rebuilt grants
      assert.equal(
        buildCrossPoolCheckpointWirePayload(
          {
            sessionKey,
            sessionId,
            checkpointGeneration: 'cp-1',
            placementEpoch: 1,
            mode: 'anchored_v2',
            anchorSeq: 1,
            sourceEngine: 'ccb',
            summary: 'hello',
            instructions: null,
            ackedByTurnKey: null,
            ackedAt: null,
            createdAt: new Date().toISOString(),
          },
          {
            migrationId: 'mig-cold-123456',
            placementEpoch: 2,
            allowBackendTransition: true,
            continuityTier: 'cold_degraded',
          },
        ),
        null,
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('B1 4-case negative matrix + atomic single-tx rollback: queued crash, persist_failed, legacy container receipts, duplicate/mismatched install receipts', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ocv5-b1-neg-'))
    try {
      const pgPool = new InMemoryContinuityPgPool()
      const store = new PgSessionAuthorityStateStore(pgPool)
      const snapshot = makeCatalog()
      const uid = 71
      const containerId = 201
      const sessionKey = 'agent:main:webchat:dm:b1-neg-matrix'
      const sessionId = 'sess-b1-neg'
      const clientMessageId = 'cmid-b1-turn-2'
      const dispatchId = 'disp-b1-0001'

      const signer = AuthoritySigner.createEphemeral()
      const consumer = new ModelAuthorityConsumer({
        keyring: parseAuthorityKeyring(signer.publicKeyringEnv()),
        uid,
        containerId,
        required: true,
      })
      const makeExec = (modelId: string) => {
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
        exec: ReturnType<typeof makeExec>,
        billingRequestId?: string,
        authorityTurnId?: string,
        executionBackend?: RemoteExecutionBackend,
        poolMigration?: Parameters<AuthoritySigner['signBundle']>[0]['poolMigration'],
      ) =>
        signer.signBundle({
          uid,
          containerId,
          connectionChallenge: 'conn-b1-1',
          canonicalModel: exec.canonicalModel,
          engine: exec.engine,
          executionDescriptor: exec.descriptor,
          auxModels: [],
          ...(executionBackend ? { executionBackend } : {}),
          ...(poolMigration ? { poolMigration } : {}),
          ...(authorityTurnId ? { authorityTurnId } : {}),
          ...(billingRequestId ? { billingRequestId } : {}),
          executionRevision: 'rev-b1',
          securityEpoch: exec.securityEpoch,
        }).bundle

      await store.upsertEnginePointer({
        userId: uid,
        sessionKey,
        poolKind: 'remote_pool',
        engine: 'ccb',
        nativeSessionId: 'remote-nat-b1',
      })

      const fallbackSelector = createSelfhostCrossPoolFallbackSelector({
        pool: pgPool,
        catalogCache: { assertFresh: async () => snapshot },
        selfhost: true,
        authorityStore: store,
      })

      const sealed = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        sessionId,
        historicalMessages: [
          { role: 'user', clientMessageId: 'm1', text: '保持单事务原子清标' },
          { role: 'assistant', text: '明白，开始修复 B1。' },
        ],
        exec: makeExec('claude-opus-4-6-remote'),
        log: null,
        cc5BackendSelector: async () => {
          throw new Error('REMOTE_LANE_UNAVAILABLE')
        },
        crossPoolFallbackSelector: fallbackSelector,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async () => null,
      })
      assert.ok(sealed !== null)
      const verified = consumer.consume(sealed, { challenge: 'conn-b1-1' })
      const cpGen = extractCrossPoolCheckpointGeneration(sealed)!
      assert.ok(cpGen.length > 0)
      const migId = verified.poolMigration!.migrationId

      const pendingMeta = {
        sessionKey,
        placementEpoch: 2,
        migrationId: migId,
        continuityTier: 'tape_rebuilt',
        checkpointGeneration: cpGen,
      }
      const dispatchRec: MigrationInstallDispatchLookupRecord = {
        clientMessageId,
        dispatchId,
        attemptNo: 1,
        pendingMigrationInstall: pendingMeta,
      }

      // Case (a): Container emits `queued` and crashes before ingest -> NEVER marks installed!
      assert.equal(shouldMarkInstallFromDispatchReceipt(pendingMeta, 'queued'), false)
      // Case (c): Legacy container emits `queued`/`running`/`terminal` without migration_install_receipt ->
      // `tape_rebuilt` NEVER clears on generic dispatch receipt; only `cold_degraded` on running/terminal!
      assert.equal(shouldMarkInstallFromDispatchReceipt(pendingMeta, 'running'), false)
      assert.equal(shouldMarkInstallFromDispatchReceipt(pendingMeta, 'terminal'), false)
      const coldPending = {
        sessionKey,
        placementEpoch: 2,
        migrationId: migId,
        continuityTier: 'cold_degraded',
        checkpointGeneration: null,
      }
      assert.equal(shouldMarkInstallFromDispatchReceipt(coldPending, 'queued'), false)
      assert.equal(shouldMarkInstallFromDispatchReceipt(coldPending, 'running'), true)
      assert.equal(shouldMarkInstallFromDispatchReceipt(coldPending, 'terminal'), true)

      // PG still holds pendingInstallMigration & unacked checkpoint
      const ptrAfterQueued = await store.getEnginePointer(uid, sessionKey)
      assert.equal(extractPendingInstallMigration(ptrAfterQueued?.promptCacheMeta)?.migrationId, migId)
      assert.ok((await store.getRollingCheckpointByGeneration(uid, sessionKey, cpGen)) !== null)

      // Case (b): Container `ingest` fails (`persist_failed`) -> NO migration_install_receipt emitted!
      const emittedOnFail: unknown[] = []
      const failFinalize = finalizeInboundCrossPoolMigration(
        sealed,
        verified,
        sessionKey,
        (f) => emittedOnFail.push(f),
        {
          dispatchContext: { dispatchId, attemptNo: 1, clientMessageId },
          clientMessageId,
          baseDir: tmpDir,
          saveCheckpoint: () => {
            throw new Error('EACCES_DISK_FULL')
          },
        },
      )
      assert.equal(failFinalize.handled, true)
      assert.equal(failFinalize.receiptSent, false)
      assert.equal(failFinalize.ingestResult?.accepted, false)
      assert.equal(
        failFinalize.ingestResult?.accepted === false ? failFinalize.ingestResult.reason : null,
        'persist_failed',
      )
      assert.equal(emittedOnFail.length, 0)
      assert.ok((await store.getRollingCheckpointByGeneration(uid, sessionKey, cpGen)) !== null)

      // Case (d-1): Atomic single-transaction rollback if UPDATE session_rolling_checkpoints fails!
      const failingAckPool: PgTransactionPool = {
        query: (sql, params) => pgPool.query(sql, params),
        connect: async () => {
          const client = await pgPool.connect()
          return {
            query: async <R extends Record<string, unknown> = Record<string, unknown>>(
              sql: string,
              params?: unknown[],
            ) => {
              if (sql.includes('UPDATE session_rolling_checkpoints')) {
                throw new Error('SIMULATED_ACK_FAILURE_IN_TX')
              }
              return client.query<R>(sql, params)
            },
            release: () => client.release(),
          }
        },
      }
      const failingAckStore = new PgSessionAuthorityStateStore(failingAckPool)
      await assert.rejects(
        () =>
          failingAckStore.markPlacementMigrationInstalledAndAckCheckpoint(uid, sessionKey, 2, migId, {
            checkpointGeneration: cpGen,
            consumedByTurnKey: clientMessageId,
            requireWarmCheckpointMatch: true,
          }),
        /SIMULATED_ACK_FAILURE_IN_TX/,
      )
      // BOTH pendingInstallMigration AND unacked checkpoint must remain untouched (no half-commit!)
      const ptrAfterRollback = await store.getEnginePointer(uid, sessionKey)
      assert.equal(
        extractPendingInstallMigration(ptrAfterRollback?.promptCacheMeta)?.migrationId,
        migId,
      )
      assert.ok((await store.getRollingCheckpointByGeneration(uid, sessionKey, cpGen)) !== null)

      // Case (d-2): Container persists cleanly -> emits migration_install_receipt -> Master verifies & converges ONCE
      const emittedOk: unknown[] = []
      const okFinalize = finalizeInboundCrossPoolMigration(
        sealed,
        verified,
        sessionKey,
        (f) => emittedOk.push(f),
        {
          dispatchContext: { dispatchId, attemptNo: 1, clientMessageId },
          clientMessageId,
          baseDir: tmpDir,
          saveCheckpoint: savePendingCheckpointWithGeneration,
        },
      )
      assert.equal(okFinalize.receiptSent, true)
      assert.equal(emittedOk.length, 1)
      const receiptFrame = emittedOk[0] as Record<string, unknown>
      assert.equal(receiptFrame.type, MIGRATION_INSTALL_RECEIPT_TYPE)
      assert.equal(receiptFrame.checkpointGeneration, cpGen)

      // Simulate `queued` receipt already dropped `admittedDispatches`, retained in `pendingMigrationInstalls`
      const admittedDispatches = new Map<string, MigrationInstallDispatchLookupRecord>()
      const pendingMigrationInstalls = new Map<string, MigrationInstallDispatchLookupRecord>([
        [clientMessageId, dispatchRec],
      ])

      const pgCalls: Array<{ installed: boolean; checkpointAcked: boolean }> = []
      const markFn = async (args: {
        uid: number
        sessionKey: string
        placementEpoch: number
        migrationId: string
        checkpointGeneration: string | null
        consumedByTurnKey: string
        requireWarmCheckpointMatch: boolean
      }) => {
        const res = await store.markPlacementMigrationInstalledAndAckCheckpoint(
          args.uid,
          args.sessionKey,
          args.placementEpoch,
          args.migrationId,
          {
            checkpointGeneration: args.checkpointGeneration,
            consumedByTurnKey: args.consumedByTurnKey,
            requireWarmCheckpointMatch: args.requireWarmCheckpointMatch,
          },
        )
        pgCalls.push({ installed: res.installed, checkpointAcked: res.checkpointAcked })
        return res
      }

      // Mismatched checkpointGeneration is intercepted (return true) and NEVER calls PG
      assert.equal(
        parseAndHandleMigrationInstallReceipt(
          JSON.stringify({ ...receiptFrame, checkpointGeneration: 'cp-forged-999' }),
          {
            uid: BigInt(uid),
            admittedDispatches,
            pendingMigrationInstalls,
            markPlacementMigrationInstalled: markFn,
          },
        ),
        true,
      )
      assert.equal(pgCalls.length, 0)

      // Valid receipt converges PG once and clears pendingMigrationInstalls
      let installedNotified = 0
      assert.equal(
        parseAndHandleMigrationInstallReceipt(JSON.stringify(receiptFrame), {
          uid: BigInt(uid),
          admittedDispatches,
          pendingMigrationInstalls,
          markPlacementMigrationInstalled: markFn,
          onInstalled: () => {
            installedNotified += 1
          },
        }),
        true,
      )
      await new Promise((r) => setImmediate(r))
      assert.equal(pgCalls.length, 1)
      assert.deepEqual(pgCalls[0], { installed: true, checkpointAcked: true })
      assert.equal(installedNotified, 1)
      assert.equal(pendingMigrationInstalls.size, 0)

      // Duplicate receipt (even if re-checked against admittedDispatches) is strictly idempotent
      admittedDispatches.set(clientMessageId, dispatchRec)
      assert.equal(
        parseAndHandleMigrationInstallReceipt(JSON.stringify(receiptFrame), {
          uid: BigInt(uid),
          admittedDispatches,
          markPlacementMigrationInstalled: markFn,
        }),
        true,
      )
      await new Promise((r) => setImmediate(r))
      assert.equal(pgCalls.length, 2)
      assert.deepEqual(pgCalls[1], { installed: false, checkpointAcked: false })

      // Non-receipt frame passes through untouched (returns false)
      assert.equal(
        parseAndHandleMigrationInstallReceipt(JSON.stringify({ type: 'outbound.message' }), {
          uid: BigInt(uid),
          admittedDispatches,
        }),
        false,
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('B2 bidirectional negative tests: read failure or missing checkpoint row during redelivery never signs empty tape_rebuilt, preserves pendingInstall, and recovers once readable', async () => {
    const pgPool = new InMemoryContinuityPgPool()
    const authorityStore = new PgSessionAuthorityStateStore(pgPool)
    const snapshot = makeCatalog()
    const uid = 72
    const containerId = 202
    const sessionKey = 'agent:main:webchat:dm:b2-bidirectional'
    const sessionId = 'sess-b2-bi'

    const signer = AuthoritySigner.createEphemeral()
    const makeExec = (modelId: string) => {
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
      exec: ReturnType<typeof makeExec>,
      billingRequestId?: string,
      authorityTurnId?: string,
      executionBackend?: RemoteExecutionBackend,
      poolMigration?: Parameters<AuthoritySigner['signBundle']>[0]['poolMigration'],
    ) =>
      signer.signBundle({
        uid,
        containerId,
        connectionChallenge: 'conn-b2-1',
        canonicalModel: exec.canonicalModel,
        engine: exec.engine,
        executionDescriptor: exec.descriptor,
        auxModels: [],
        ...(executionBackend ? { executionBackend } : {}),
        ...(poolMigration ? { poolMigration } : {}),
        ...(authorityTurnId ? { authorityTurnId } : {}),
        ...(billingRequestId ? { billingRequestId } : {}),
        executionRevision: 'rev-b2',
        securityEpoch: exec.securityEpoch,
      }).bundle

    await authorityStore.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: 'remote_pool',
      engine: 'ccb',
    })

    let readMode: 'ok' | 'throw' | 'null' = 'ok'
    const origGetByGen = authorityStore.getRollingCheckpointByGeneration.bind(authorityStore)
    authorityStore.getRollingCheckpointByGeneration = async (...args) => {
      if (readMode === 'throw') throw new Error('PG_TRANSIENT_READ_ERR')
      if (readMode === 'null') return null
      return origGetByGen(...args)
    }

    const fallbackSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => snapshot },
      selfhost: true,
      authorityStore,
    })
    const returnResolver = createSelfhostReturnToRemoteGrantResolver({
      pool: pgPool,
      selfhost: true,
      authorityStore,
    })

    // Step 1: Initial remote -> local commits epoch 2 with tape_rebuilt
    const firstLocal = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      sessionId,
      historicalMessages: [{ role: 'user', text: '记住 B2 双向重投不变量' }],
      exec: makeExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector: async () => {
        throw new Error('REMOTE_LANE_UNAVAILABLE')
      },
      crossPoolFallbackSelector: fallbackSelector,
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(firstLocal !== null)
    const cpGenLocal = extractCrossPoolCheckpointGeneration(firstLocal)!
    assert.ok(cpGenLocal.length > 0)

    // Direction 1 (remote -> local redelivery): throw and null BOTH abort forward without signing empty tape_rebuilt
    for (const mode of ['throw', 'null'] as const) {
      readMode = mode
      const rejectReasons: string[] = []
      const blocked = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        sessionId,
        exec: makeExec('claude-opus-4-6-remote'),
        log: null,
        cc5BackendSelector: async () => {
          throw new Error('REMOTE_LANE_UNAVAILABLE')
        },
        crossPoolFallbackSelector: fallbackSelector,
        resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async (_c, _m, reason) => {
          rejectReasons.push(reason)
          return null
        },
      })
      assert.equal(blocked, null)
      assert.equal(rejectReasons.length, 1)
      // Pending install stays intact in PG
      const ptr = await authorityStore.getEnginePointer(uid, sessionKey)
      assert.equal(extractPendingInstallMigration(ptr?.promptCacheMeta)?.checkpointGeneration, cpGenLocal)
    }

    // Recovery: redelivery succeeds with exact same generation
    readMode = 'ok'
    const recoveredLocal = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      sessionId,
      exec: makeExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector: async () => {
        throw new Error('REMOTE_LANE_UNAVAILABLE')
      },
      crossPoolFallbackSelector: fallbackSelector,
      resolveLocalExec: async (m) => (snapshot.resolve(m) ? makeExec(m) : null),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(recoveredLocal !== null)
    assert.equal(extractCrossPoolCheckpointGeneration(recoveredLocal), cpGenLocal)
    const localMigId = extractPendingInstallMigration(
      (await authorityStore.getEnginePointer(uid, sessionKey))?.promptCacheMeta,
    )!.migrationId
    await authorityStore.markPlacementMigrationInstalledAndAckCheckpoint(uid, sessionKey, 2, localMigId, {
      checkpointGeneration: cpGenLocal,
      consumedByTurnKey: 'turn-b2-local-ok',
      requireWarmCheckpointMatch: true,
    })

    // Step 2: local -> remote commits epoch 3 with tape_rebuilt
    const remoteBackend: RemoteExecutionBackend = Object.freeze({
      kind: REMOTE_DRIVER_BACKEND,
      version: 4 as const,
      driverId: 'cc',
      driverVersion: '5.0.0',
      engineId: 'cc',
      authorityEngine: 'ccb' as const,
      sessionKey,
      operationId: '88888888-8888-4888-8888-888888888888',
      generation: '1',
      profileId: 'prof-cc-b2',
      authEpoch: 'epoch-1',
    })
    const firstReturn = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      sessionId,
      historicalMessages: [
        { role: 'user', text: '记住 B2 双向重投不变量' },
        { role: 'assistant', text: '本地轮已完成，准备切回远端。' },
      ],
      exec: makeExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector: async () => remoteBackend,
      returnToRemoteGrantResolver: returnResolver,
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(firstReturn !== null)
    const cpGenReturn = extractCrossPoolCheckpointGeneration(firstReturn)!
    assert.ok(cpGenReturn.length > 0 && cpGenReturn !== cpGenLocal)

    // Direction 2 (local -> remote redelivery): throw and null BOTH block with CROSS_POOL_CHECKPOINT_UNAVAILABLE
    for (const mode of ['throw', 'null'] as const) {
      readMode = mode
      const blockedCodes: string[] = []
      const directRes = await returnResolver({
        uid,
        containerId,
        sessionKey,
        sessionId,
        canonicalModel: 'claude-opus-4-6-remote',
        engine: 'ccb',
        executionBackend: remoteBackend,
        onBlocked: (c) => blockedCodes.push(c),
      })
      assert.equal(directRes, null)
      assert.deepEqual(blockedCodes, ['CROSS_POOL_CHECKPOINT_UNAVAILABLE'])

      const rejectReasons: string[] = []
      const sealedBlocked: Record<string, unknown> | null = await resolveRemotePoolBackendAndSeal({
        uid,
        containerId,
        sessionKey,
        sessionId,
        exec: makeExec('claude-opus-4-6-remote'),
        log: null,
        cc5BackendSelector: async (): Promise<RemoteExecutionBackend> => remoteBackend,
        returnToRemoteGrantResolver: returnResolver,
        readEpochAtSign: async () => snapshot.securityEpoch,
        signAuthorityBundle: signExec,
        reject: async (_c, _m, reason) => {
          rejectReasons.push(reason)
          return null
        },
      })
      assert.equal(sealedBlocked, null)
      assert.deepEqual(rejectReasons, ['return_to_remote_blocked'])
    }

    // Recovery: return-to-remote redelivery succeeds with exact same generation
    readMode = 'ok'
    const recoveredReturn = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      sessionId,
      exec: makeExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector: async () => remoteBackend,
      returnToRemoteGrantResolver: returnResolver,
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(recoveredReturn !== null)
    assert.equal(extractCrossPoolCheckpointGeneration(recoveredReturn), cpGenReturn)

    // Hard seal invariant: a selector returning tape_rebuilt with NO deliveredCheckpoint is rejected & compensated!
    const hardRejectReasons: string[] = []
    const badSeal = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey,
      sessionId,
      exec: makeExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector: async () => remoteBackend,
      returnToRemoteGrantResolver: async () => ({
        migrationId: 'mig-empty-carrier-01',
        placementEpoch: 4,
        allowBackendTransition: true,
        continuityTier: 'tape_rebuilt',
      }),
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async (_c, _m, reason) => {
        hardRejectReasons.push(reason)
        return null
      },
    })
    assert.equal(badSeal, null)
    assert.deepEqual(hardRejectReasons, ['missing_warm_checkpoint_carrier'])
  })

  it('B4 support: pre-rollout local session with hasLocalHistory migrates 1->2, and forced-local resolver enforces B06 + tape_rebuilt', async () => {
    const pgPool = new InMemoryContinuityPgPool()
    const authorityStore = new PgSessionAuthorityStateStore(pgPool)
    const snapshot = makeCatalog()
    const uid = 73
    const containerId = 203
    const signer = AuthoritySigner.createEphemeral()

    const makeExec = (modelId: string) => {
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
      exec: ReturnType<typeof makeExec>,
      billingRequestId?: string,
      authorityTurnId?: string,
      executionBackend?: RemoteExecutionBackend,
      poolMigration?: Parameters<AuthoritySigner['signBundle']>[0]['poolMigration'],
    ) =>
      signer.signBundle({
        uid,
        containerId,
        connectionChallenge: 'conn-b4-1',
        canonicalModel: exec.canonicalModel,
        engine: exec.engine,
        executionDescriptor: exec.descriptor,
        auxModels: [],
        ...(executionBackend ? { executionBackend } : {}),
        ...(poolMigration ? { poolMigration } : {}),
        ...(authorityTurnId ? { authorityTurnId } : {}),
        ...(billingRequestId ? { billingRequestId } : {}),
        executionRevision: 'rev-b4',
        securityEpoch: exec.securityEpoch,
      }).bundle

    // 1. Pre-rollout local session (no PG pointer row yet)
    const legacyKey = 'agent:main:webchat:dm:b4-legacy-local'
    const remoteBackend: RemoteExecutionBackend = Object.freeze({
      kind: REMOTE_DRIVER_BACKEND,
      version: 4 as const,
      driverId: 'cc',
      driverVersion: '5.0.0',
      engineId: 'cc',
      authorityEngine: 'ccb' as const,
      sessionKey: legacyKey,
      operationId: '99999999-9999-4999-8999-999999999999',
      generation: '1',
      profileId: 'prof-cc-b4',
      authEpoch: 'epoch-1',
    })
    const returnResolver = createSelfhostReturnToRemoteGrantResolver({
      pool: pgPool,
      selfhost: true,
      authorityStore,
    })

    // Without hasLocalHistory -> returns null (never guesses on brand-new sessions!)
    assert.equal(
      await returnResolver({
        uid,
        containerId,
        sessionKey: legacyKey,
        sessionId: 'sess-legacy',
        canonicalModel: 'claude-opus-4-6-remote',
        engine: 'ccb',
        executionBackend: remoteBackend,
      }),
      null,
    )
    assert.equal(await authorityStore.getEnginePointer(uid, legacyKey), null)

    // With hasLocalHistory: true -> runs full 1->2 migration + tape_rebuilt checkpoint
    const migratedLegacy = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey: legacyKey,
      sessionId: 'sess-legacy',
      hasLocalHistory: true,
      historicalMessages: [{ role: 'user', text: '上线前已有本地对话历史' }],
      exec: makeExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector: async () => remoteBackend,
      returnToRemoteGrantResolver: returnResolver,
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(migratedLegacy !== null)
    assert.ok(extractCrossPoolCheckpointGeneration(migratedLegacy) !== null)
    const legacyPtr = await authorityStore.getEnginePointer(uid, legacyKey)
    assert.equal(legacyPtr?.poolKind, 'remote_pool')
    assert.equal(legacyPtr?.placementEpoch, 2)

    // 2. Forced local migration (`MODEL_POOL_BINDING_FORCED_LOCAL`) when admin disables remote binding
    const activeRemoteKey = 'agent:main:webchat:dm:b4-forced-local'
    await authorityStore.upsertEnginePointer({
      userId: uid,
      sessionKey: activeRemoteKey,
      poolKind: 'remote_pool',
      engine: 'ccb',
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })
    let hasUnsettledBilling = true
    const forcedLocalResolver = createSelfhostForcedLocalMigrationResolver({
      pool: pgPool,
      selfhost: true,
      authorityStore,
      pendingBillingChecker: async () => hasUnsettledBilling,
    })

    // B06 blocks forced-local migration while billing is unsettled
    const blockedReasons: string[] = []
    const blockedForced = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey: activeRemoteKey,
      sessionId: 'sess-forced-local',
      historicalMessages: [{ role: 'user', text: '管理员关闭远端绑定时保持上下文' }],
      exec: makeExec('claude-opus-4-6'),
      log: null,
      forcedLocalMigrationResolver: forcedLocalResolver,
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async (_c, _m, reason) => {
        blockedReasons.push(reason)
        return null
      },
    })
    assert.equal(blockedForced, null)
    assert.deepEqual(blockedReasons, ['forced_local_migration_blocked'])
    assert.equal((await authorityStore.getEnginePointer(uid, activeRemoteKey))?.placementEpoch, 1)

    // Once billing settles, forced-local migrates 1->2 with tape_rebuilt checkpoint
    hasUnsettledBilling = false
    const forcedSealed = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey: activeRemoteKey,
      sessionId: 'sess-forced-local',
      historicalMessages: [{ role: 'user', text: '管理员关闭远端绑定时保持上下文' }],
      exec: makeExec('claude-opus-4-6'),
      log: null,
      forcedLocalMigrationResolver: forcedLocalResolver,
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(forcedSealed !== null)
    assert.ok(extractCrossPoolCheckpointGeneration(forcedSealed) !== null)
    const forcedPtr = await authorityStore.getEnginePointer(uid, activeRemoteKey)
    assert.equal(forcedPtr?.poolKind, 'local_container')
    assert.equal(forcedPtr?.placementEpoch, 2)
  })

  it('B4 R2 + B1 R2: persists initial remote placement pointer, reconstructs unpointed remote_agent_bindings on forced-local migration, and keeps pendingMigrationInstalls intact until PG install succeeds', async () => {
    const pgPool = new InMemoryContinuityPgPool()
    const authorityStore = new PgSessionAuthorityStateStore(pgPool)
    const snapshot = makeCatalog()
    const signer = AuthoritySigner.createEphemeral()
    const uid = 93
    const containerId = 710
    const makeExec = (canonicalModel: string) => {
      const desc = snapshot.resolve(canonicalModel)!
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
      exec: ReturnType<typeof makeExec>,
      billingRequestId?: string,
      authorityTurnId?: string,
      executionBackend?: RemoteExecutionBackend,
      poolMigration?: Parameters<AuthoritySigner['signBundle']>[0]['poolMigration'],
    ) =>
      signer.signBundle({
        uid,
        containerId,
        connectionChallenge: 'conn-b4-r2',
        canonicalModel: exec.canonicalModel,
        engine: exec.engine,
        executionDescriptor: exec.descriptor,
        auxModels: [],
        ...(executionBackend ? { executionBackend } : {}),
        ...(poolMigration ? { poolMigration } : {}),
        ...(authorityTurnId ? { authorityTurnId } : {}),
        ...(billingRequestId ? { billingRequestId } : {}),
        executionRevision: 'rev-b4-r2',
        securityEpoch: exec.securityEpoch,
      }).bundle

    // 1. First healthy direct remote turn invokes recordRemotePlacement (persisting epoch 1)
    const freshRemoteKey = 'agent:main:webchat:dm:b4-r2-fresh-remote'
    const freshBackend: RemoteExecutionBackend = Object.freeze({
      kind: REMOTE_DRIVER_BACKEND,
      version: 4 as const,
      driverId: 'cc',
      driverVersion: '5.0.0',
      engineId: 'cc',
      authorityEngine: 'ccb' as const,
      sessionKey: freshRemoteKey,
      operationId: '11111111-1111-4111-8111-111111111111',
      generation: '1',
      profileId: 'prof-direct-1',
      authEpoch: 'epoch-1',
    })
    const recordedPlacements: Array<{ uid: number; sessionKey: string; operationId: string; profileId?: string }> = []
    const sealedFresh = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey: freshRemoteKey,
      sessionId: 'sess-fresh',
      exec: makeExec('claude-opus-4-6-remote'),
      log: null,
      cc5BackendSelector: async () => freshBackend,
      recordRemotePlacement: async (args) => {
        recordedPlacements.push(args)
        await authorityStore.upsertEnginePointer({
          userId: args.uid,
          sessionKey: args.sessionKey,
          poolKind: 'remote_pool',
          engine: 'ccb',
          operationId: args.operationId,
          ...(args.profileId ? { profileId: args.profileId } : {}),
        })
      },
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(sealedFresh !== null)
    assert.equal(recordedPlacements.length, 1)
    assert.equal(recordedPlacements[0]!.operationId, freshBackend.operationId)
    assert.equal((await authorityStore.getEnginePointer(uid, freshRemoteKey))?.poolKind, 'remote_pool')

    // 2. Pre-existing remote session with NO pointer row yet, only remote_agent_bindings:
    //    - returnToRemoteGrantResolver MUST NOT treat it as a local session (even if hasLocalHistory=true)
    //    - forcedLocalMigrationResolver MUST reconstruct epoch 1 and migrate 1 -> 2 when remote is disabled
    const unpointedRemoteKey = 'agent:main:webchat:dm:b4-r2-unpointed-remote'
    pgPool.state.remoteBindings.set(`${uid}::${unpointedRemoteKey}`, {
      operation_id: '22222222-2222-4222-8222-222222222222',
      profile_id: 'prof-legacy-remote',
    })
    const returnResolver = createSelfhostReturnToRemoteGrantResolver({
      pool: pgPool,
      selfhost: true,
      authorityStore,
    })
    assert.equal(
      await returnResolver({
        uid,
        containerId,
        sessionKey: unpointedRemoteKey,
        sessionId: 'sess-unpointed',
        canonicalModel: 'claude-opus-4-6-remote',
        engine: 'ccb',
        hasLocalHistory: true,
        executionBackend: { ...freshBackend, sessionKey: unpointedRemoteKey },
      }),
      null,
      'unpointed session already present in remote_agent_bindings MUST NOT trigger fake local->remote migration',
    )

    const forcedLocalResolver = createSelfhostForcedLocalMigrationResolver({
      pool: pgPool,
      selfhost: true,
      authorityStore,
      pendingBillingChecker: async () => false,
    })
    const forcedSealed = await resolveRemotePoolBackendAndSeal({
      uid,
      containerId,
      sessionKey: unpointedRemoteKey,
      sessionId: 'sess-unpointed',
      historicalMessages: [{ role: 'user', text: '旧远端会话无 pointer 行时关闭远端绑定仍可温迁移' }],
      exec: makeExec('claude-opus-4-6'),
      log: null,
      forcedLocalMigrationResolver: forcedLocalResolver,
      readEpochAtSign: async () => snapshot.securityEpoch,
      signAuthorityBundle: signExec,
      reject: async () => null,
    })
    assert.ok(forcedSealed !== null)
    assert.ok(extractCrossPoolCheckpointGeneration(forcedSealed) !== null)
    const migratedPtr = await authorityStore.getEnginePointer(uid, unpointedRemoteKey)
    assert.equal(migratedPtr?.poolKind, 'local_container')
    assert.equal(migratedPtr?.placementEpoch, 2)

    // 3. B1 R2: pendingMigrationInstalls is NOT deleted when markPlacementMigrationInstalled returns false,
    //    and legacy cold_degraded follow-up `running` receipt clears ONLY on true (never on queued/tape_rebuilt).
    const pendingMap = new Map<string, MigrationInstallDispatchLookupRecord>()
    const warmRec: MigrationInstallDispatchLookupRecord = {
      clientMessageId: 'cmid-warm-retry',
      dispatchId: 'disp-warm-retry',
      attemptNo: 1,
      sessionId: 'sess-warm',
      pendingMigrationInstall: {
        sessionKey: unpointedRemoteKey,
        placementEpoch: 2,
        migrationId: 'mig-warm-retry-0001',
        continuityTier: 'tape_rebuilt',
        checkpointGeneration: 'cp-gen-retry-1',
      },
    }
    pendingMap.set(warmRec.clientMessageId, warmRec)

    let installResult = false
    const receiptJson = JSON.stringify({
      type: MIGRATION_INSTALL_RECEIPT_TYPE,
      clientMessageId: warmRec.clientMessageId,
      dispatchId: warmRec.dispatchId,
      attemptNo: 1,
      sessionKey: unpointedRemoteKey,
      migrationId: 'mig-warm-retry-0001',
      placementEpoch: 2,
      continuityTier: 'tape_rebuilt',
      checkpointGeneration: 'cp-gen-retry-1',
    })
    parseAndHandleMigrationInstallReceipt(receiptJson, {
      uid,
      admittedDispatches: new Map(),
      pendingMigrationInstalls: pendingMap,
      markPlacementMigrationInstalled: async () => installResult,
    })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(pendingMap.has(warmRec.clientMessageId), true, 'must keep pending entry when PG returned false')

    // Follow-up running receipt must NEVER clear a tape_rebuilt entry
    tryMarkLegacyColdInstallFromReceipt(
      {
        clientMessageId: warmRec.clientMessageId,
        dispatchId: warmRec.dispatchId,
        attemptNo: 1,
        sessionId: 'sess-warm',
        state: 'running',
      },
      {
        uid,
        pendingMigrationInstalls: pendingMap,
        markPlacementMigrationInstalled: async () => true,
      },
    )
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(pendingMap.has(warmRec.clientMessageId), true)

    // Retry of migration_install_receipt once PG returns true clears entry
    installResult = true
    parseAndHandleMigrationInstallReceipt(receiptJson, {
      uid,
      admittedDispatches: new Map(),
      pendingMigrationInstalls: pendingMap,
      markPlacementMigrationInstalled: async () => installResult,
    })
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(pendingMap.has(warmRec.clientMessageId), false)

    // Legacy cold_degraded follow-up `running` receipt clears entry (while `queued` does NOT)
    const coldRec: MigrationInstallDispatchLookupRecord = {
      clientMessageId: 'cmid-cold-followup',
      dispatchId: 'disp-cold-1',
      attemptNo: 1,
      sessionId: 'sess-cold',
      pendingMigrationInstall: {
        sessionKey: unpointedRemoteKey,
        placementEpoch: 3,
        migrationId: 'mig-cold-legacy-0001',
        continuityTier: 'cold_degraded',
      },
    }
    pendingMap.set(coldRec.clientMessageId, coldRec)
    tryMarkLegacyColdInstallFromReceipt(
      {
        clientMessageId: coldRec.clientMessageId,
        dispatchId: coldRec.dispatchId,
        attemptNo: 1,
        sessionId: 'sess-cold',
        state: 'queued',
      },
      { uid, pendingMigrationInstalls: pendingMap, markPlacementMigrationInstalled: async () => true },
    )
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(pendingMap.has(coldRec.clientMessageId), true, 'queued MUST NOT clear legacy cold_degraded')

    tryMarkLegacyColdInstallFromReceipt(
      {
        clientMessageId: coldRec.clientMessageId,
        dispatchId: coldRec.dispatchId,
        attemptNo: 1,
        sessionId: 'sess-cold',
        state: 'running',
      },
      { uid, pendingMigrationInstalls: pendingMap, markPlacementMigrationInstalled: async () => true },
    )
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(pendingMap.has(coldRec.clientMessageId), false, 'running follow-up MUST clear legacy cold_degraded')
  })
})
