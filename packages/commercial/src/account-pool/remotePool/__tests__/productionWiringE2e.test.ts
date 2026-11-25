import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MODEL_AUTHORITY_FIELD,
  REMOTE_DRIVER_BACKEND,
  computeSchemaFilteredArgsSha256,
  computeToolIdempotencyKey,
  parseAuthorityKeyring,
  type LogicalModelCapability,
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
import { remoteV4ResumeId } from '../../../../../gateway/src/remotePool/resumeId.js'
import { AuthoritySigner } from '../../../ws/authoritySigner.js'
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
import {
  LEGACY_BILLING_RECOVERY_VERSIONS,
  createLegacyBillingReadOnlyShell,
  evaluateLegacyRetirementReadiness,
} from '../legacyRetirement.js'
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
      const list = db.checkpoints.get(k) ?? []
      if (list.length === 0) return { rows: [], rowCount: 0 }
      return { rows: [{ ...list[list.length - 1]! }], rowCount: 1 }
    }

    // request_finalize_journal (B06 authoritative pending billing query)
    if (sql.includes('FROM request_finalize_journal') && sql.startsWith('SELECT')) {
      const uidStr = String(params[0])
      const versions = params[1] as string[]
      const opId = params[2] == null ? null : String(params[2])
      const sessKey = params[3] == null ? null : String(params[3])
      const hit = db.pendingJournals.some(
        (j) =>
          j.userId === uidStr &&
          versions.includes(j.version) &&
          (j.state === 'inflight' || j.state === 'finalizing') &&
          ((opId !== null && j.operationId === opId) ||
            (sessKey !== null && j.sessionKey === sessKey)),
      )
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
  it('B01 positive 2-turn loop: Turn 1 remote_pool -> Turn 2 pre-dispatch fallback -> PG epoch CAS + migrationGrant + cc5SessionBackend + ExecEnv rebind + single billing settlement', async () => {
    const pgPool = new MockThreeLayerPgPool()
    const authorityStore = new PgSessionAuthorityStateStore(pgPool)
    const bindingStore = new PgLogicalModelBindingStore(pgPool)

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

    const uid = 42
    const containerId = 99
    const sessionKey = 'agent:main:webchat:dm:prod-e2e-2turn'
    const turn1OpId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const storedRemoteResume = remoteV4ResumeId(turn1OpId, 'native-turn-1')

    // ── Turn 1: executed on remote_pool, persisted PG pointer (epoch=1), ran tool on ExecEnv lease ──
    const ptrTurn1 = await authorityStore.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: 'remote_pool',
      engine: 'ccb',
      nativeSessionId: 'native-turn-1',
      operationId: turn1OpId,
      profileId: 'prof-remote-1',
    })
    assert.equal(ptrTurn1.placementEpoch, 1)
    assert.equal(ptrTurn1.poolKind, 'remote_pool')

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

    // ── Turn 2: remote_pool fails pre-dispatch -> real selfhost selector migrates to local_pool ──
    const selector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache,
      selfhost: true,
      authorityStore,
      bindingStore,
    })

    const fb = await selector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'),
      requiredCapabilities: { needsVision: true, reasoningEffort: 'high' },
    })

    assert.ok(fb !== null, 'fallback selector must authorize same-logical-model local fallback')
    assert.equal(fb.fallbackPool, 'local_pool')
    assert.equal(fb.executionBackend, undefined)
    assert.equal(fb.resolvedCanonicalModel, 'claude-opus-4-6')
    assert.equal(fb.logicalModel, 'claude-opus-4-6')
    assert.equal(fb.migrationGrant.allowBackendTransition, true)
    assert.equal(fb.migrationGrant.placementEpoch, 2)
    assert.equal(fb.migrationGrant.continuityTier, 'tape_rebuilt')

    // Verify PG pointer CAS atomically moved to epoch=2, local_container
    const ptrTurn2 = await authorityStore.getEnginePointer(uid, sessionKey)
    assert.ok(ptrTurn2 !== null)
    assert.equal(ptrTurn2.placementEpoch, 2)
    assert.equal(ptrTurn2.poolKind, 'local_container')
    assert.equal(ptrTurn2.migrationState, 'active')
    const migRecord = await authorityStore.getPlacementMigration(fb.migrationGrant.migrationId)
    assert.equal(migRecord?.state, 'committed')
    assert.equal(migRecord?.fromEpoch, 1)
    assert.equal(migRecord?.toEpoch, 2)

    // Sign poolMigration inside the real Ed25519 ModelAuthorityBundle (same contract as userChatBridge -> gateway)
    const signer = AuthoritySigner.createEphemeral()
    const keyring = parseAuthorityKeyring(signer.publicKeyringEnv())
    const consumer = new ModelAuthorityConsumer({
      keyring,
      uid,
      containerId,
      required: true,
    })
    const localExecDesc = snapshot.resolve('claude-opus-4-6')!
    const localCapProfile = JSON.parse(JSON.stringify(localExecDesc.capabilityProfile))
    const minted = signer.signBundle({
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
      securityEpoch: 1,
      poolMigration: fb.migrationGrant,
    })
    const verifiedTurnAuthority = consumer.consume(
      {
        model: localExecDesc.canonicalModel,
        [MODEL_AUTHORITY_FIELD]: minted.bundle,
      },
      { challenge: 'conn-challenge-e2e-1' },
    )
    assert.deepEqual(verifiedTurnAuthority.poolMigration, fb.migrationGrant)

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
      securityEpoch: 1,
    })
    const verifiedWithoutGrant = consumer.consume(
      {
        model: localExecDesc.canonicalModel,
        poolMigration: fb.migrationGrant,
        [MODEL_AUTHORITY_FIELD]: mintedWithoutGrant.bundle,
      },
      { challenge: 'conn-challenge-e2e-1' },
    )
    assert.equal(verifiedWithoutGrant.poolMigration, undefined)

    // Tampered authority envelope with modified poolMigration MUST be cryptographically rejected
    const tamperedEnvelope = JSON.parse(
      Buffer.from(minted.bundle.authority, 'base64url').toString('utf8'),
    ) as { payload: { poolMigration: { placementEpoch: number } } }
    tamperedEnvelope.payload.poolMigration.placementEpoch = 999
    const tamperedAuthority = Buffer.from(JSON.stringify(tamperedEnvelope), 'utf8').toString('base64url')
    assert.throws(
      () =>
        consumer.consume(
          {
            model: localExecDesc.canonicalModel,
            [MODEL_AUTHORITY_FIELD]: { authority: tamperedAuthority, lease: minted.bundle.lease },
          },
          { challenge: 'conn-challenge-e2e-1' },
        ),
      (err: unknown) => err instanceof AuthorityRejected && err.code === 'verify_fail',
    )

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

    // Single unique terminal billing settlement for Turn 2 (idempotent by billingRequestId)
    const settledLedger = new Map<string, { credits: number; pool: string }>()
    const settleOnce = (requestId: string, credits: number, pool: string) => {
      if (!settledLedger.has(requestId)) settledLedger.set(requestId, { credits, pool })
    }
    settleOnce('req-turn-2', 42, 'local_pool')
    settleOnce('req-turn-2', 42, 'local_pool')
    assert.equal(settledLedger.size, 1)
    assert.deepEqual(settledLedger.get('req-turn-2'), { credits: 42, pool: 'local_pool' })

    // ── Turn 3: remote_pool recovers -> returnToRemoteGrantResolver advances PG epoch 2 -> 3 ──
    const turn3OpId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const turn3Backend = Object.freeze({
      kind: REMOTE_DRIVER_BACKEND,
      version: 4 as const,
      driverId: 'cc',
      driverVersion: '5.0.0',
      engineId: 'claude-code',
      authorityEngine: 'ccb' as const,
      sessionKey,
      operationId: turn3OpId,
      generation: '1',
      profileId: 'prof-remote-1',
      authEpoch: '1',
    })
    const returnResolver = createSelfhostReturnToRemoteGrantResolver({
      pool: pgPool,
      selfhost: true,
    })
    const returnGrant = await returnResolver({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      executionBackend: turn3Backend,
    })
    assert.ok(returnGrant !== null, 'return-to-remote resolver must authorize transition from local_container')
    assert.equal(returnGrant.placementEpoch, 3)
    assert.equal(returnGrant.allowBackendTransition, true)
    assert.equal(returnGrant.continuityTier, 'tape_rebuilt')

    const ptrTurn3 = await authorityStore.getEnginePointer(uid, sessionKey)
    assert.equal(ptrTurn3?.placementEpoch, 3)
    assert.equal(ptrTurn3?.poolKind, 'remote_pool')
    assert.equal(ptrTurn3?.operationId, turn3OpId)
    assert.equal(ptrTurn3?.nativeSessionId, 'native-turn-1', 'commitPlacementMigration must not wipe nativeSessionId when omitted')

    // Sign Turn 3 executionBackend + poolMigration and verify via ModelAuthorityConsumer -> gateway admission
    const remoteExecDesc = snapshot.resolve('claude-opus-4-6-remote')!
    const mintedTurn3 = signer.signBundle({
      uid,
      containerId,
      connectionChallenge: 'conn-challenge-e2e-1',
      canonicalModel: remoteExecDesc.canonicalModel,
      engine: 'ccb',
      executionDescriptor: {
        capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
        contextWindow: remoteExecDesc.contextWindow,
        supportsVision: remoteExecDesc.capabilityProfile.supportsVision,
        supportedEfforts: [...remoteExecDesc.capabilityProfile.reasoning.supported],
        capabilityProfile: JSON.parse(JSON.stringify(remoteExecDesc.capabilityProfile)),
      },
      auxModels: [],
      executionBackend: turn3Backend,
      poolMigration: returnGrant,
      executionRevision: 'rev-e2e-3',
      securityEpoch: 7,
    })
    const verifiedTurn3 = consumer.consume(
      {
        model: remoteExecDesc.canonicalModel,
        [MODEL_AUTHORITY_FIELD]: mintedTurn3.bundle,
      },
      { challenge: 'conn-challenge-e2e-1' },
    )
    assert.deepEqual(verifiedTurn3.poolMigration, returnGrant)
    assert.deepEqual(verifiedTurn3.executionBackend, turn3Backend)
    await assertFreshCc5Session({
      storedResumeId: undefined,
      executionBackend: verifiedTurn3.executionBackend,
      sessionIds: [sessionKey],
      hasPersistedTurnActivity: async () => true,
      poolMigration: verifiedTurn3.poolMigration,
    })
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

    // Bootstrap-style implicit wiring: ONLY `{ pool, catalogCache, selfhost: true }` (no explicit bindingStore)
    const bootstrapSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache,
      selfhost: true,
    })

    await authorityStore.upsertEnginePointer({
      userId: uid,
      sessionKey,
      poolKind: 'remote_pool',
      engine: 'ccb',
      operationId: opId,
    })

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

    // 4) B06-R2: Pending billing journal + REMOTE_LANE_PROFILE_UNAVAILABLE (0 healthy remote profiles) -> MUST REJECT!
    pgPool.state.pendingJournals.push({
      userId: String(uid),
      version: REMOTE_DRIVER_V4_BILLING_RECOVERY_VERSION,
      operationId: opId,
      sessionKey,
      state: 'inflight',
    })
    const deniedPendingBill = await bootstrapSelector({
      uid,
      containerId,
      sessionKey,
      canonicalModel: 'claude-opus-4-6-remote',
      engine: 'ccb',
      cause: new Error('REMOTE_LANE_PROFILE_UNAVAILABLE'),
      expectedSecurityEpoch: 7,
    })
    assert.equal(deniedPendingBill, null, 'B06: unsettled billing journal must block local fallback even when remote reports profile unavailable')
    assert.equal((await authorityStore.getEnginePointer(uid, sessionKey))?.placementEpoch, 1)

    // 5) Once billing settles, fallback succeeds and honestly reports `cold_degraded` (no checkpoint/history)
    pgPool.state.pendingJournals[0]!.state = 'committed'
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
    assert.equal(allowedCold.migrationGrant.placementEpoch, 2)
    assert.equal(
      allowedCold.migrationGrant.continuityTier,
      'cold_degraded',
      'B01: without persisted checkpoint or history, selector must report cold_degraded instead of tape_rebuilt',
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
    ])
    const strictFenceSelector = createSelfhostCrossPoolFallbackSelector({
      pool: pgPool,
      catalogCache: { assertFresh: async () => fullLocalSnapshot },
      selfhost: true,
      authorityStore,
    })
    // Non-egress-billed engine (codex) must fail closed at post-classification seal point
    // so local Codex billing route/journal can never be bypassed.
    assert.equal(
      await strictFenceSelector({
        uid: 42,
        containerId: 99,
        sessionKey: 'agent:main:webchat:dm:codex-billing-guard',
        canonicalModel: 'gpt-6-luna-remote',
        engine: 'codex',
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

  it('B14: local AntigravityAdapter unconditionally rejects readOnly turns with ANTIGRAVITY_READ_ONLY_UNSUPPORTED (no boolean bypass)', async () => {
    const adapter = new AntigravityAdapter({
      sessionKey: 'agent:main:webchat:dm:b14-agy-readonly',
      agentId: 'main',
      agentBaseDir: '/tmp/oc-b14-test',
      config: { gateway: { port: 18789, accessToken: 'test-token' } } as any,
      model: 'antigravity-gemini-4-carbon',
      // Attempt to pass the removed fake boolean bypass: MUST still fail closed!
      ...({ toolBrokerReadOnlyGuard: true } as Record<string, unknown>),
    } as any)
    const run = adapter.submitTurn({
      input: 'inspect files read-only',
      readOnly: true,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    })
    await assert.rejects(() => run.submitted, /ANTIGRAVITY_READ_ONLY_UNSUPPORTED/)
  })
})
