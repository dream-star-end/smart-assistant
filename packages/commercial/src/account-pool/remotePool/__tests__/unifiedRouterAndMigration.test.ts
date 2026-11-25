import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  DEFAULT_POOL_FALLBACK_POLICY,
  computeCacheAffinityKey,
  computeStickyHomeKey,
  type AuthorityEngineKind,
  type CredentialLeaseHandle,
  type DriverCapabilityManifest,
  type EngineStateCapsuleRef,
  type InferenceEngineFamily,
  type InferencePoolKind,
  type LogicalModelCapability,
  type LogicalModelPoolBinding,
  type ManagedJobSummary,
  type PlacementDescriptor,
  type PlacementMigrationRecord,
  type PoolFallbackPolicy,
  type SessionEnginePointer,
} from '@openclaude/protocol'
import {
  PgLogicalModelBindingStore,
  type AbortPlacementMigrationCas,
  type AbortPlacementMigrationResult,
  type BeginPlacementMigrationCas,
  type BeginPlacementMigrationResult,
  type CommitPlacementMigrationCas,
  type CommitPlacementMigrationResult,
  type PgQueryResult,
  type PgQueryable,
  type SaveRollingCheckpointInput,
  type SaveRollingCheckpointResult,
} from '../../../db/threeLayerStateStore.js'
import {
  LEGACY_BILLING_RECOVERY_VERSIONS,
  LEGACY_REMOTE_BACKEND_KINDS,
  LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY,
  createLegacyBillingReadOnlyShell,
  evaluateLegacyRetirementReadiness,
} from '../legacyRetirement.js'
import {
  MigrationCoordinator,
  type ExecEnvAttachmentSnapshot,
  type MigrationAuthorityStorePort,
  type MigrationCapsulePort,
  type MigrationCredentialLeasePort,
  type MigrationDriverPort,
  type MigrationExecEnvPort,
  type PendingCredentialReconciliationStore,
} from '../migrationCoordinator.js'
import {
  PRE_DISPATCH_RETRYABLE_ERROR_CODES,
  UnifiedPlacementRouter,
  poolCandidateKey,
  type PoolCandidateDescriptor,
} from '../unifiedPlacementRouter.js'

const tempReconcileDirs: string[] = []

function makeTempReconcileDir(prefix = 'ocv5-mig-reconcile-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempReconcileDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempReconcileDirs.length > 0) {
    rmSync(tempReconcileDirs.pop()!, { recursive: true, force: true })
  }
})

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function makeModelCap(
  logicalModel: string,
  overrides: Partial<LogicalModelCapability> = {},
): LogicalModelCapability {
  const cap: LogicalModelCapability = {
    logicalModel,
    supportsVision: true,
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    supportedServiceTiers: ['standard', 'fast'],
    supportsReadOnly: true,
    supportsConsultTurn: true,
    supportsHermeticNoTools: true,
    supportsSwarm: true,
    contextWindow: 200_000,
    ...overrides,
  }
  return Object.freeze(cap)
}

function makeManifest(
  poolKind: InferencePoolKind,
  driverId: string,
  models: readonly LogicalModelCapability[],
  engineFamily: InferenceEngineFamily = 'cc',
  authorityEngine: AuthorityEngineKind = 'ccb',
): DriverCapabilityManifest {
  return Object.freeze({
    schemaVersion: 5,
    poolKind,
    engineFamily,
    authorityEngine,
    driverId,
    driverVersion: '5.0.0',
    observedAt: '2026-11-25T10:00:00.000Z',
    models,
  })
}

function makeCandidate(
  overrides: Partial<PoolCandidateDescriptor> & {
    readonly poolKind: InferencePoolKind
    readonly driverId: string
    readonly manifest: DriverCapabilityManifest
  },
): PoolCandidateDescriptor {
  return Object.freeze({
    healthy: true,
    draining: false,
    activeSlots: 1,
    maxSlots: 8,
    weight: 100,
    rttMsP50: 40,
    ...overrides,
  })
}

class InMemoryBindingDb implements PgQueryable {
  readonly rows: Array<{
    logical_model_id: string
    pool_kind: InferencePoolKind
    driver_id: string
    canonical_model_id: string
    priority: number
    capabilities_json: LogicalModelCapability
    enabled: boolean
  }> = []

  addBinding(b: LogicalModelPoolBinding): void {
    this.rows.push({
      logical_model_id: b.logicalModelId,
      pool_kind: b.poolKind,
      driver_id: b.driverId,
      canonical_model_id: b.canonicalModelId,
      priority: b.priority,
      capabilities_json: b.capabilities,
      enabled: b.enabled,
    })
  }

  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PgQueryResult<R>> {
    const logicalModel = String(params[0])
    const remoteOnly = sql.includes("pool_kind = 'remote_pool'")
    const matched = this.rows
      .filter(
        (r) =>
          r.logical_model_id === logicalModel &&
          r.enabled &&
          (!remoteOnly || r.pool_kind === 'remote_pool'),
      )
      .sort((a, b) => a.priority - b.priority || a.driver_id.localeCompare(b.driver_id))
    return { rows: matched as unknown as R[], rowCount: matched.length }
  }
}

class InMemoryAuthorityStore implements MigrationAuthorityStorePort {
  pointer: SessionEnginePointer
  readonly migrations = new Map<string, PlacementMigrationRecord>()
  readonly checkpoints: Array<{
    readonly checkpointGeneration: string
    readonly input: SaveRollingCheckpointInput
  }> = []
  private migCounter = 0

  constructor(initial: PlacementDescriptor, userId = 42, sessionKey = 'sess-mig-1') {
    this.pointer = Object.freeze({
      sessionKey,
      placementEpoch: initial.placementEpoch,
      poolKind: initial.poolKind,
      engine: initial.engine,
      nativeSessionId: 'native-init-1',
      operationId: initial.operationId ?? null,
      profileId: initial.profileId ?? null,
      capsuleId: null,
      history: [],
      rejectedIds: [],
      promptCacheMeta: null,
      usageBaseline: null,
      historyContextVersion: null,
      promotedFromHistory: false,
      migrationState: 'active',
      activeMigrationId: null,
      updatedAt: '2026-11-25T10:00:00.000Z',
    })
    void userId
  }

  async getEnginePointer(): Promise<SessionEnginePointer | null> {
    return this.pointer
  }

  async getPlacementMigration(migrationId: string): Promise<PlacementMigrationRecord | null> {
    return this.migrations.get(migrationId) ?? null
  }

  async beginPlacementMigration(
    cas: BeginPlacementMigrationCas,
  ): Promise<BeginPlacementMigrationResult> {
    if (this.pointer.migrationState === 'migrating') {
      return Object.freeze({
        applied: false as const,
        currentEpoch: this.pointer.placementEpoch,
        reason: 'already_migrating' as const,
        activeMigrationId: this.pointer.activeMigrationId,
      })
    }
    if (this.pointer.placementEpoch !== cas.expectedPlacementEpoch) {
      return Object.freeze({
        applied: false as const,
        currentEpoch: this.pointer.placementEpoch,
        reason: 'epoch_mismatch' as const,
      })
    }
    this.migCounter += 1
    const migrationId = cas.migrationId ?? `mig-test-0000${this.migCounter}`
    const record: PlacementMigrationRecord = Object.freeze({
      migrationId,
      tenantId: String(cas.userId),
      sessionKey: cas.sessionKey,
      fromEpoch: cas.expectedPlacementEpoch,
      toEpoch: cas.expectedPlacementEpoch + 1,
      state: 'migrating',
      fromPlacement: cas.fromPlacement,
      toPlacement: cas.toPlacement,
      capsuleRef: null,
      continuityTier: null,
      reason: cas.reason ?? null,
      createdAt: '2026-11-25T10:01:00.000Z',
      completedAt: null,
    })
    this.migrations.set(migrationId, record)
    this.pointer = Object.freeze({
      ...this.pointer,
      migrationState: 'migrating',
      activeMigrationId: migrationId,
    })
    return Object.freeze({
      applied: true as const,
      migration: record,
      currentEpoch: cas.expectedPlacementEpoch,
    })
  }

  async commitPlacementMigration(
    cas: CommitPlacementMigrationCas,
  ): Promise<CommitPlacementMigrationResult> {
    const existing = this.migrations.get(cas.migrationId)
    if (!existing || existing.state !== 'migrating') {
      return Object.freeze({ applied: false as const })
    }
    const committed: PlacementMigrationRecord = Object.freeze({
      ...existing,
      state: 'committed',
      continuityTier: cas.continuityTier,
      capsuleRef: cas.capsuleRef ?? null,
      completedAt: '2026-11-25T10:02:00.000Z',
    })
    this.migrations.set(cas.migrationId, committed)
    this.pointer = Object.freeze({
      ...this.pointer,
      placementEpoch: committed.toEpoch,
      migrationState: 'active',
      activeMigrationId: null,
      poolKind: committed.toPlacement.poolKind,
      engine: committed.toPlacement.engine,
      nativeSessionId: cas.nativeSessionId ?? null,
      operationId: cas.operationId ?? committed.toPlacement.operationId ?? null,
      profileId: cas.profileId ?? committed.toPlacement.profileId ?? null,
      capsuleId: cas.capsuleId ?? cas.capsuleRef?.capsuleId ?? null,
      updatedAt: '2026-11-25T10:02:00.000Z',
    })
    return Object.freeze({
      applied: true as const,
      migration: committed,
      pointer: this.pointer,
    })
  }

  async abortPlacementMigration(
    cas: AbortPlacementMigrationCas,
  ): Promise<AbortPlacementMigrationResult> {
    const existing = this.migrations.get(cas.migrationId)
    if (!existing || existing.state !== 'migrating') {
      return Object.freeze({ applied: false as const })
    }
    const aborted: PlacementMigrationRecord = Object.freeze({
      ...existing,
      state: 'aborted',
      reason: cas.reason,
      completedAt: '2026-11-25T10:02:00.000Z',
    })
    this.migrations.set(cas.migrationId, aborted)
    this.pointer = Object.freeze({
      ...this.pointer,
      migrationState: 'active',
      activeMigrationId: null,
    })
    return Object.freeze({
      applied: true as const,
      migration: aborted,
      pointer: this.pointer,
    })
  }

  async saveRollingCheckpoint(
    input: SaveRollingCheckpointInput,
  ): Promise<SaveRollingCheckpointResult> {
    assert.equal(
      input.expectedPlacementEpoch,
      this.pointer.placementEpoch,
      'rolling checkpoint must match pre-commit placementEpoch',
    )
    const checkpointGeneration = `cp-gen-${this.checkpoints.length + 1}`
    this.checkpoints.push({ checkpointGeneration, input })
    return Object.freeze({
      checkpointGeneration,
      createdAtMs: Date.parse('2026-11-25T10:01:30.000Z'),
    })
  }
}

describe('UnifiedPlacementRouter — logical model decoupling, capability superset, affinity & failover', () => {
  it('enforces compile-time & runtime PoolFallbackPolicy invariants fail-closed', () => {
    assert.throws(
      () =>
        new UnifiedPlacementRouter({
          fallbackPolicy: {
            ...DEFAULT_POOL_FALLBACK_POLICY,
            neverSilentDowngradeModel: false as unknown as true,
          },
        }),
      /POOL_FALLBACK_POLICY_INVARIANT_VIOLATION/,
    )
    assert.throws(
      () =>
        new UnifiedPlacementRouter({
          fallbackPolicy: {
            ...DEFAULT_POOL_FALLBACK_POLICY,
            requireCapabilitySuperset: false as unknown as true,
          },
        }),
      /POOL_FALLBACK_POLICY_INVARIANT_VIOLATION/,
    )
    assert.throws(
      () =>
        new UnifiedPlacementRouter({
          fallbackPolicy: {
            ...DEFAULT_POOL_FALLBACK_POLICY,
            allowCrossPoolOnPostDispatchFailure: true as unknown as false,
          },
        }),
      /POOL_FALLBACK_POLICY_INVARIANT_VIOLATION/,
    )
  })

  it('decouples logical model ids, maps <base>-remote alias to pin_remote, and filters via PgLogicalModelBindingStore', async () => {
    const localCap = makeModelCap('claude-opus-4-7')
    const remoteCap = makeModelCap('claude-opus-4-7')
    const localCand = makeCandidate({
      poolKind: 'local_pool',
      driverId: 'local-cc',
      profileId: 'local-p1',
      nodeId: 'local-n1',
      weight: 500,
      manifest: makeManifest('local_pool', 'local-cc', [localCap]),
    })
    const remoteCand = makeCandidate({
      poolKind: 'remote_pool',
      driverId: 'remote-cc-v4',
      profileId: 'remote-p1',
      nodeId: 'remote-n1',
      weight: 100,
      manifest: makeManifest('remote_pool', 'remote-cc-v4', [remoteCap]),
    })

    const bindingDb = new InMemoryBindingDb()
    bindingDb.addBinding({
      logicalModelId: 'claude-opus-4-7',
      poolKind: 'local_pool',
      driverId: 'local-cc',
      canonicalModelId: 'claude-opus-4-7',
      priority: 1,
      capabilities: localCap,
      enabled: true,
    })
    bindingDb.addBinding({
      logicalModelId: 'claude-opus-4-7',
      poolKind: 'remote_pool',
      driverId: 'remote-cc-v4',
      canonicalModelId: 'claude-opus-4-7',
      priority: 2,
      capabilities: remoteCap,
      enabled: true,
    })
    const bindingStore = new PgLogicalModelBindingStore(bindingDb)

    const router = new UnifiedPlacementRouter({
      candidates: [localCand, remoteCand],
      bindingStore,
    })

    // Legacy `<base>-remote` alias pins remote_pool even though local has 5x weight
    const remoteAliasRes = await router.routeTurn({
      rawModelId: 'claude-opus-4-7-remote',
      sessionKey: 'sess-alias-1',
      tenantId: 'tenant-1',
    })
    assert.ok(remoteAliasRes.ok, 'expected legacy -remote alias route to succeed')
    assert.equal(remoteAliasRes.logicalModel, 'claude-opus-4-7')
    assert.equal(remoteAliasRes.isLegacyRemoteAlias, true)
    assert.equal(remoteAliasRes.effectivePoolPreference, 'pin_remote')
    assert.equal(remoteAliasRes.selected.poolKind, 'remote_pool')
    assert.equal(remoteAliasRes.selected.driverId, 'remote-cc-v4')

    // Disabling remote binding prevents routing to remote even if manifest exists
    bindingDb.rows[1]!.enabled = false
    const disabledRes = await router.routeTurn({
      rawModelId: 'claude-opus-4-7-remote',
      sessionKey: 'sess-alias-1',
    })
    assert.ok(!disabledRes.ok && disabledRes.code === 'CAPABILITY_UNSATISFIED')
    assert.ok(
      disabledRes.unsatisfiedByCandidate[poolCandidateKey(remoteCand)]?.some((r) =>
        r.startsWith('logical_model_binding_absent:'),
      ),
    )
  })

  it('preserves steady-state sticky placement & cacheAffinityKey hit, switches on capability gaps with zero silent downgrade, and absorbs cold cache on drain', async () => {
    const affinityKey = computeCacheAffinityKey({
      tenantId: 'u-100',
      sessionKey: 'sess-sticky-1',
      logicalModel: 'gpt-5-4',
    })

    const localLimited = makeCandidate({
      poolKind: 'local_pool',
      driverId: 'local-codex',
      profileId: 'local-p1',
      nodeId: 'local-n1',
      weight: 50,
      cachedAffinityKeys: new Set([affinityKey]),
      manifest: makeManifest(
        'local_pool',
        'local-codex',
        [
          makeModelCap('gpt-5-4', {
            supportsVision: false,
            supportedServiceTiers: ['standard'],
            supportsConsultTurn: false,
          }),
        ],
        'codex',
        'codex',
      ),
    })

    const remoteFull = makeCandidate({
      poolKind: 'remote_pool',
      driverId: 'remote-codex-v4',
      profileId: 'remote-p1',
      nodeId: 'remote-n1',
      weight: 400,
      manifest: makeManifest(
        'remote_pool',
        'remote-codex-v4',
        [
          makeModelCap('gpt-5-4', {
            supportsVision: true,
            supportedServiceTiers: ['standard', 'fast', 'ultrafast'],
            supportsConsultTurn: true,
          }),
        ],
        'codex',
        'codex',
      ),
    })

    const router = new UnifiedPlacementRouter({
      candidates: [localLimited, remoteFull],
    })

    // 1. Steady-state turn stays pinned to warm local cache despite remote having 8x weight
    const steady = await router.routeTurn({
      rawModelId: 'gpt-5-4',
      sessionKey: 'sess-sticky-1',
      tenantId: 'u-100',
      cacheAffinityKey: affinityKey,
      currentPoolKind: 'local_pool',
      currentDriverId: 'local-codex',
      currentProfileId: 'local-p1',
    })
    assert.ok(steady.ok)
    assert.equal(steady.selected.poolKind, 'local_pool')
    assert.equal(steady.stickyHomePreserved, true)
    assert.equal(steady.cacheAffinityHit, true)
    assert.equal(steady.migrationRequired, false)
    assert.equal(steady.migrationTrigger, 'none')
    assert.equal(steady.coldCacheBudgetAction, 'none')

    // 2. Capability-driven cutover for vision + ultrafast + consultTurn
    const capSwitch = await router.routeTurn({
      rawModelId: 'gpt-5-4',
      sessionKey: 'sess-sticky-1',
      tenantId: 'u-100',
      cacheAffinityKey: affinityKey,
      currentPoolKind: 'local_pool',
      currentDriverId: 'local-codex',
      currentProfileId: 'local-p1',
      requiredCapabilities: {
        needsVision: true,
        serviceTier: 'ultrafast',
        consultTurn: true,
      },
    })
    assert.ok(capSwitch.ok)
    assert.equal(capSwitch.selected.poolKind, 'remote_pool')
    assert.equal(capSwitch.migrationRequired, true)
    assert.equal(capSwitch.migrationTrigger, 'capability_driven')
    assert.equal(capSwitch.coldCacheBudgetAction, 'require_consent_or_budget_check')

    // 3. Zero silent downgrade when NO candidate satisfies required effort
    const unsatisfied = await router.routeTurn({
      rawModelId: 'gpt-5-4',
      sessionKey: 'sess-sticky-1',
      requiredCapabilities: {
        reasoningEffort: 'xhigh',
      },
    })
    assert.ok(!unsatisfied.ok && unsatisfied.code === 'CAPABILITY_UNSATISFIED')
    assert.ok(
      unsatisfied.unsatisfiedByCandidate[poolCandidateKey(localLimited)]?.includes(
        'reasoning_effort_unsupported:xhigh',
      ),
    )
    assert.ok(
      unsatisfied.unsatisfiedByCandidate[poolCandidateKey(remoteFull)]?.includes(
        'reasoning_effort_unsupported:xhigh',
      ),
    )

    // 4. Drain cutover absorbs cold cache cost (`platform_absorb_on_drain`)
    const drainingRemote = makeCandidate({
      ...remoteFull,
      draining: true,
    })
    const healthyLocalFull = makeCandidate({
      ...localLimited,
      manifest: makeManifest(
        'local_pool',
        'local-codex',
        [
          makeModelCap('gpt-5-4', {
            supportsVision: true,
            supportedServiceTiers: ['standard', 'fast', 'ultrafast'],
            supportsConsultTurn: true,
          }),
        ],
        'codex',
        'codex',
      ),
      cachedAffinityKeys: new Set(),
    })
    const drainRouter = new UnifiedPlacementRouter({
      candidates: [drainingRemote, healthyLocalFull],
    })
    const drainCutover = await drainRouter.routeTurn({
      rawModelId: 'gpt-5-4',
      sessionKey: 'sess-sticky-1',
      tenantId: 'u-100',
      currentPoolKind: 'remote_pool',
      currentDriverId: 'remote-codex-v4',
      currentProfileId: 'remote-p1',
    })
    assert.ok(drainCutover.ok)
    assert.equal(drainCutover.selected.poolKind, 'local_pool')
    assert.equal(drainCutover.migrationRequired, true)
    assert.equal(drainCutover.migrationTrigger, 'drain_cutover')
    assert.equal(drainCutover.coldCacheBudgetAction, 'platform_absorb_on_drain')

    // 5. All capable candidates draining / exhausted -> INFERENCE_POOL_UNAVAILABLE with counts
    const exhaustedLocal = makeCandidate({
      ...healthyLocalFull,
      activeSlots: 8,
      maxSlots: 8,
    })
    const unavailableRouter = new UnifiedPlacementRouter({
      candidates: [drainingRemote, exhaustedLocal],
    })
    const unavail = await unavailableRouter.routeTurn({
      rawModelId: 'gpt-5-4',
      sessionKey: 'sess-sticky-1',
    })
    assert.ok(!unavail.ok && unavail.code === 'INFERENCE_POOL_UNAVAILABLE')
    assert.equal(unavail.drainingCount, 1)
    assert.equal(unavail.exhaustedCount, 1)

    // 6. User preference switch triggers 'user_preference'
    const prefRouter = new UnifiedPlacementRouter({
      candidates: [remoteFull, healthyLocalFull],
    })
    const userPref = await prefRouter.routeTurn({
      rawModelId: 'gpt-5-4',
      sessionKey: 'sess-sticky-1',
      poolPreference: 'prefer_local',
      currentPoolKind: 'remote_pool',
      currentDriverId: 'remote-codex-v4',
      currentProfileId: 'remote-p1',
    })
    assert.ok(userPref.ok)
    assert.equal(userPref.selected.poolKind, 'local_pool')
    assert.equal(userPref.migrationRequired, true)
    assert.equal(userPref.migrationTrigger, 'user_preference')
  })

  it('enforces pre-dispatch failover with zero-credit abandon vs post-dispatch hard replay fence', async () => {
    const modelCap = makeModelCap('claude-opus-4-7')
    const remoteCand = makeCandidate({
      poolKind: 'remote_pool',
      driverId: 'remote-cc-v4',
      profileId: 'remote-p1',
      nodeId: 'remote-n1',
      manifest: makeManifest('remote_pool', 'remote-cc-v4', [modelCap]),
    })
    const localCand = makeCandidate({
      poolKind: 'local_pool',
      driverId: 'local-cc',
      profileId: 'local-p1',
      nodeId: 'local-n1',
      manifest: makeManifest('local_pool', 'local-cc', [modelCap]),
    })

    const router = new UnifiedPlacementRouter({
      candidates: [remoteCand, localCand],
    })

    const baseInput = {
      rawModelId: 'claude-opus-4-7',
      sessionKey: 'sess-failover-1',
      tenantId: 'u-7',
    }

    // Every retryable pre-dispatch error code allows cross-pool failover with mustAbandonPriorZeroCredit
    for (const errorCode of PRE_DISPATCH_RETRYABLE_ERROR_CODES) {
      const decision = await router.decideRetryAfterFailure({
        dispatched: false,
        failedCandidateKey: poolCandidateKey(remoteCand),
        errorCode,
        allowCrossPoolMigration: true,
        attemptCount: 1,
        originalRouteInput: baseInput,
      })
      assert.ok(decision.allowRetry, `expected retry for ${errorCode}`)
      assert.equal(decision.mustAbandonPriorZeroCredit, true)
      assert.equal(decision.nextRoute.selected.poolKind, 'local_pool')
      assert.notEqual(decision.nextRoute.selectedCandidateKey, poolCandidateKey(remoteCand))
    }

    // Disallowing cross-pool migration blocks failover to another pool when no same-pool sibling exists
    const samePoolOnly = await router.decideRetryAfterFailure({
      dispatched: false,
      failedCandidateKey: poolCandidateKey(remoteCand),
      errorCode: 'REMOTE_POOL_DRAINING_RETRY_LATER',
      allowCrossPoolMigration: false,
      attemptCount: 1,
      originalRouteInput: baseInput,
    })
    assert.ok(!samePoolOnly.allowRetry)
    assert.equal(samePoolOnly.code, 'INFERENCE_POOL_UNAVAILABLE')

    // Post-dispatch failure is ALWAYS fail-closed, even for retryable error codes
    const postDispatch = await router.decideRetryAfterFailure({
      dispatched: true,
      failedCandidateKey: poolCandidateKey(remoteCand),
      errorCode: 'UPSTREAM_PRE_ADMIT_503',
      allowCrossPoolMigration: true,
      attemptCount: 1,
      originalRouteInput: baseInput,
    })
    assert.ok(
      !postDispatch.allowRetry &&
        postDispatch.code === 'POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN',
    )
    assert.equal(postDispatch.mustSettleCurrentFirst, true)

    // Non-retryable pre-dispatch error & max attempts exhaustion both refuse retry
    const nonRetryable = await router.decideRetryAfterFailure({
      dispatched: false,
      failedCandidateKey: poolCandidateKey(remoteCand),
      errorCode: 'AUTH_ACCOUNT_REVOKED',
      allowCrossPoolMigration: true,
      attemptCount: 1,
      originalRouteInput: baseInput,
    })
    assert.ok(!nonRetryable.allowRetry)
    assert.equal(nonRetryable.code, 'PRE_DISPATCH_ERROR_NOT_RETRYABLE')

    const exhausted = await router.decideRetryAfterFailure({
      dispatched: false,
      failedCandidateKey: poolCandidateKey(remoteCand),
      errorCode: 'UPSTREAM_PRE_ADMIT_429',
      allowCrossPoolMigration: true,
      attemptCount: DEFAULT_POOL_FALLBACK_POLICY.maxPreDispatchFallbackAttempts + 1,
      originalRouteInput: baseInput,
    })
    assert.ok(!exhausted.allowRetry)
    assert.equal(exhausted.code, 'PRE_DISPATCH_FALLBACK_ATTEMPTS_EXHAUSTED')

    const disabledPolicy: PoolFallbackPolicy = {
      ...DEFAULT_POOL_FALLBACK_POLICY,
      allowPreDispatchPoolFallback: false,
    }
    const noFallbackRouter = new UnifiedPlacementRouter({
      candidates: [remoteCand, localCand],
      fallbackPolicy: disabledPolicy,
    })
    const disabledDecision = await noFallbackRouter.decideRetryAfterFailure({
      dispatched: false,
      failedCandidateKey: poolCandidateKey(remoteCand),
      errorCode: 'UPSTREAM_PRE_ADMIT_429',
      allowCrossPoolMigration: true,
      originalRouteInput: baseInput,
    })
    assert.ok(!disabledDecision.allowRetry)
    assert.equal(disabledDecision.code, 'PRE_DISPATCH_FALLBACK_DISABLED')
  })
})

describe('MigrationCoordinator — Local -> Remote -> Local seamless handoff, degrade tiers & rollback', () => {
  const stickyKey = computeStickyHomeKey('sess-mig-1')
  const localPlacement: PlacementDescriptor = Object.freeze({
    poolKind: 'local_container',
    engine: 'ccb',
    driverId: 'local-cc',
    placementEpoch: 1,
    containerId: 'ctr-1',
    profileId: 'local-prof-1',
    stickyHomeKey: stickyKey,
  })
  const remotePlacement: PlacementDescriptor = Object.freeze({
    poolKind: 'remote_pool',
    engine: 'ccb',
    driverId: 'remote-cc-v4',
    placementEpoch: 2,
    hostId: 'remote-node-1',
    profileId: 'remote-prof-1',
    operationId: 'op-remote-1',
    stickyHomeKey: stickyKey,
  })
  const localReturnPlacement: PlacementDescriptor = Object.freeze({
    poolKind: 'local_container',
    engine: 'ccb',
    driverId: 'local-cc',
    placementEpoch: 3,
    containerId: 'ctr-1',
    profileId: 'local-prof-1',
    stickyHomeKey: stickyKey,
  })

  function createHarness() {
    const authorityStore = new InMemoryAuthorityStore(localPlacement)
    const activeJobs: ManagedJobSummary[] = [
      {
        jobId: 'job-oc-bash-991',
        leaseId: 'exec-lease-1',
        lifecycleClass: 'managed_job',
        state: 'running',
        label: 'dev-server',
        startedAt: '2026-11-25T09:50:00.000Z',
      },
    ]

    let currentFencingToken = 'fence-e000001-g000001-initial00000'
    let currentBrainGen = 1
    let forceRebindFailure = false
    let forcePrewarmFailure = false
    let forceSourceUnreachable = false
    let forceDegradeFailure = false
    const revokedFencingTokens: string[] = []
    const issuedLeases: CredentialLeaseHandle[] = []
    const revokedLeaseIds: Array<{ leaseId: string; reason: string }> = []
    const prewarmCalls: Array<{ stickyHomeKey: string; frozenPromptSha256?: string }> = []

    const attachmentBase: ExecEnvAttachmentSnapshot = Object.freeze({
      leaseId: 'exec-lease-1',
      channelKind: 'uds_jsonrpc',
      workspaceTreeSha256: sha256('workspace-tree-v1'),
      policyDigest: sha256('policy-v1'),
      toolCatalogSha256: sha256('tools-v1'),
      attachedAt: '2026-11-25T09:45:00.000Z',
      activeJobs,
      activePreviews: ['preview-3000'],
      activeSwarmMembers: ['worker-a'],
    })

    const capsuleRef: EngineStateCapsuleRef = Object.freeze({
      capsuleId: sha256('capsule-epoch-1'),
      engine: 'ccb',
      portability: 'portable',
      placementEpoch: 1,
      totalBytes: 4096,
      fileCount: 2,
      createdAt: '2026-11-25T10:01:10.000Z',
    })

    const capsuleStore: MigrationCapsulePort = {
      async exportCapsule() {
        return { ok: true, capsuleRef }
      },
      async importCapsule() {
        return { ok: true, nativeSessionId: 'native-remote-hot-2', continuityTier: 'hot_native' }
      },
      async degradeToTranscript() {
        if (forceDegradeFailure) {
          return { ok: false, reason: 'transcript_tape_corrupt' }
        }
        return {
          ok: true,
          tier: 'tape_rebuilt',
          summary: 'Rebuilt lossless tape summary across remote node outage',
          anchorSeq: 48,
          instructions: 'Continue active oc_bash dev-server inspection',
          nativeSessionId: null,
          mode: 'anchored_v2',
        }
      },
    }

    const execEnv: MigrationExecEnvPort = {
      async quiesce() {
        return { quiesced: true, activeToolCalls: 0 }
      },
      async exportAttachmentDigest() {
        return attachmentBase
      },
      async rebindBrain(args) {
        if (forceRebindFailure) {
          return { ok: false, reason: 'exec_env_rebind_rejected' }
        }
        assert.ok(args.nextBrainGen > currentBrainGen, 'brainGen must strictly increase')
        assert.ok(
          args.nextFencingToken > currentFencingToken,
          'fencingToken must monotonically increase',
        )
        const prev = args.previousFencingToken ?? currentFencingToken
        revokedFencingTokens.push(prev)
        currentBrainGen = args.nextBrainGen
        currentFencingToken = args.nextFencingToken
        return {
          ok: true,
          brainGen: currentBrainGen,
          fencingToken: currentFencingToken,
          revokedPreviousFencingToken: prev,
          attachment: attachmentBase,
        }
      },
    }

    const credentialLeases: MigrationCredentialLeasePort = {
      async issueLease(req) {
        const lease: CredentialLeaseHandle = Object.freeze({
          leaseId: `cred-lease-${issuedLeases.length + 1}`,
          tenantId: req.tenantId,
          profileId: req.profileId,
          engine: req.engine,
          mountKind: req.mountKind,
          noRefreshToken: true,
          issuedAt: '2026-11-25T10:01:00.000Z',
          expiresAt: '2026-11-25T10:16:00.000Z',
        })
        issuedLeases.push(lease)
        return lease
      },
      async revokeLease(leaseId, reason) {
        revokedLeaseIds.push({ leaseId, reason })
        return true
      },
    }

    const drivers: MigrationDriverPort = {
      async stopLane() {
        if (forceSourceUnreachable) {
          return { stopped: false, reachable: false, reason: 'ssh_host_unreachable' }
        }
        return { stopped: true, reachable: true, dualProofVerified: true }
      },
      async prewarm(args) {
        prewarmCalls.push({
          stickyHomeKey: args.stickyHomeKey,
          frozenPromptSha256: args.frozenPromptSha256,
        })
        if (forcePrewarmFailure) {
          return { ready: false, reason: 'target_pool_overloaded' }
        }
        return { ready: true, prewarmedKey: `${args.targetPlacement.driverId}:${args.stickyHomeKey}` }
      },
    }

    const coordinator = new MigrationCoordinator({
      authorityStore,
      capsuleStore,
      execEnv,
      credentialLeases,
      drivers,
      reconciliationWalDir: makeTempReconcileDir(),
    })

    return {
      authorityStore,
      coordinator,
      activeJobs,
      revokedFencingTokens,
      issuedLeases,
      revokedLeaseIds,
      prewarmCalls,
      setForceRebindFailure: (v: boolean) => {
        forceRebindFailure = v
      },
      setForcePrewarmFailure: (v: boolean) => {
        forcePrewarmFailure = v
      },
      setForceSourceUnreachable: (v: boolean) => {
        forceSourceUnreachable = v
      },
      setForceDegradeFailure: (v: boolean) => {
        forceDegradeFailure = v
      },
      getCurrentBrainGen: () => currentBrainGen,
      getCurrentFencingToken: () => currentFencingToken,
    }
  }

  it('rejects handoff fail-closed when settledToolsProven is false or epoch conflicts', async () => {
    const h = createHarness()

    const unsettled = await h.coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: false,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
    })
    assert.ok(!unsettled.ok)
    assert.equal(unsettled.code, 'MIGRATION_UNSETTLED_TOOLS_IN_FLIGHT')
    assert.equal(h.authorityStore.pointer.placementEpoch, 1)

    const epochConflict = await h.coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 99,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
    })
    assert.ok(!epochConflict.ok)
    assert.equal(epochConflict.code, 'MIGRATION_EPOCH_CONFLICT')
    assert.equal(epochConflict.conflictReason, 'epoch_mismatch')
    assert.equal(epochConflict.placementEpoch, 1)
  })

  it('executes full Local -> Remote (Tier 1 hot_native) -> Local (source unreachable Tier 2 tape_rebuilt) preserving activeJobs and monotonic fencingToken', async () => {
    const h = createHarness()

    // Phase A: Local (epoch 1) -> Remote (epoch 2) via Tier 1 hot capsule
    const toRemote = await h.coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
      currentFencingToken: h.getCurrentFencingToken(),
      previousCredentialLeaseId: 'cred-lease-local-0',
      frozenPromptSha256: sha256('frozen-prompt-1'),
      nativeSessionId: 'native-init-1',
    })

    assert.ok(toRemote.ok)
    assert.equal(toRemote.fromEpoch, 1)
    assert.equal(toRemote.toEpoch, 2)
    assert.equal(toRemote.continuityTier, 'hot_native')
    assert.equal(toRemote.notifyContextRebuilt, false)
    assert.equal(toRemote.nativeSessionId, 'native-remote-hot-2')
    assert.equal(toRemote.brainGen, 2)
    assert.equal(toRemote.attachment.activeJobs?.[0]?.jobId, 'job-oc-bash-991')
    assert.equal(toRemote.previousCredentialRevoked, true)
    assert.equal(h.authorityStore.pointer.placementEpoch, 2)
    assert.equal(h.authorityStore.pointer.poolKind, 'remote_pool')
    assert.ok(
      h.revokedLeaseIds.some((r) => r.leaseId === 'cred-lease-local-0'),
      'old credential lease must be revoked after commit',
    )
    assert.equal(h.prewarmCalls[0]?.stickyHomeKey, stickyKey)

    const remoteFencingToken = toRemote.fencingToken
    const remoteCredLeaseId = toRemote.issuedCredentialLease!.leaseId

    // Phase B: Remote (epoch 2) -> Local (epoch 3) while remote node is unreachable -> Tier 2 tape_rebuilt
    h.setForceSourceUnreachable(true)
    const backToLocal = await h.coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 2,
      fromPlacement: remotePlacement,
      toPlacement: localReturnPlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: toRemote.brainGen,
      currentFencingToken: remoteFencingToken,
      previousCredentialLeaseId: remoteCredLeaseId,
    })

    assert.ok(backToLocal.ok)
    assert.equal(backToLocal.fromEpoch, 2)
    assert.equal(backToLocal.toEpoch, 3)
    assert.equal(backToLocal.continuityTier, 'tape_rebuilt')
    assert.equal(backToLocal.notifyContextRebuilt, true)
    assert.ok(backToLocal.degradedReasons.includes('ssh_host_unreachable'))
    assert.equal(backToLocal.checkpointGeneration, 'cp-gen-1')
    assert.equal(h.authorityStore.checkpoints.length, 1)
    assert.equal(backToLocal.brainGen, 3)
    assert.ok(backToLocal.fencingToken > remoteFencingToken)
    assert.equal(backToLocal.revokedPreviousFencingToken, remoteFencingToken)
    assert.equal(backToLocal.attachment.activeJobs?.[0]?.jobId, 'job-oc-bash-991')
    assert.equal(h.authorityStore.pointer.placementEpoch, 3)
    assert.equal(h.authorityStore.pointer.poolKind, 'local_container')
    assert.ok(h.revokedLeaseIds.some((r) => r.leaseId === remoteCredLeaseId))
  })

  it('aborts migration without flipping placementEpoch and revokes candidate lease when rebindBrain or prewarm fails', async () => {
    // Case 1: rebindBrain failure
    const h1 = createHarness()
    h1.setForceRebindFailure(true)
    const rebindFail = await h1.coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
    })
    assert.ok(!rebindFail.ok)
    assert.equal(rebindFail.code, 'MIGRATION_EXEC_ENV_REBIND_FAILED')
    // ExecEnv was quiesced and forceRebindFailure also blocks rollback rebind -> honest rolledBack=false!
    assert.equal(rebindFail.rolledBack, false)
    assert.equal(rebindFail.recoveryRequired, true)
    assert.equal(h1.authorityStore.pointer.placementEpoch, 1)
    assert.equal(h1.authorityStore.pointer.migrationState, 'active')
    assert.equal(h1.authorityStore.migrations.get(rebindFail.migrationId!)?.state, 'aborted')
    assert.equal(h1.revokedLeaseIds.length, 1)

    // Case 2: target prewarm rejection -> full rollback including higher-gen source ExecEnv restore
    const h2 = createHarness()
    h2.setForcePrewarmFailure(true)
    const prewarmFail = await h2.coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
    })
    assert.ok(!prewarmFail.ok)
    assert.equal(prewarmFail.code, 'MIGRATION_TARGET_PREWARM_FAILED')
    assert.equal(prewarmFail.rolledBack, true)
    assert.equal(prewarmFail.restoredSourceLease?.brainGen, 3)
    assert.ok(prewarmFail.restoredSourceLease?.fencingToken)
    assert.equal(h2.authorityStore.pointer.placementEpoch, 1)
    assert.equal(h2.authorityStore.pointer.migrationState, 'active')
    assert.equal(h2.authorityStore.migrations.get(prewarmFail.migrationId!)?.state, 'aborted')
    assert.equal(h2.revokedLeaseIds.length, 1)
  })

  it('B08(a): epoch conflict exits before quiesce so source ExecEnv stays active and callable', async () => {
    const authorityStore = new InMemoryAuthorityStore(localPlacement)
    let quiesceCalls = 0
    let leaseState: 'active' | 'quiescing' = 'active'
    const activeToken = 'fence-e000001-g000001-source000001'
    let toolCallsExecuted = 0

    const invokeTool = (fencingToken: string, brainGen: number) => {
      if (leaseState === 'quiescing') throw new Error('EXEC_LEASE_QUIESCING')
      if (fencingToken !== activeToken || brainGen < 1) throw new Error('EXEC_FENCING_TOKEN_STALE')
      toolCallsExecuted += 1
      return { ok: true, count: toolCallsExecuted }
    }

    const coordinator = new MigrationCoordinator({
      authorityStore,
      reconciliationWalDir: makeTempReconcileDir(),
      capsuleStore: {
        async exportCapsule() {
          return { ok: false, reason: 'unused' }
        },
        async importCapsule() {
          return { ok: false, reason: 'unused' }
        },
        async degradeToTranscript() {
          return { ok: false, reason: 'unused' }
        },
      },
      execEnv: {
        async quiesce() {
          quiesceCalls += 1
          leaseState = 'quiescing'
          return { quiesced: true, activeToolCalls: 0 }
        },
        async exportAttachmentDigest() {
          return {
            leaseId: 'exec-lease-1',
            channelKind: 'uds_jsonrpc',
            workspaceTreeSha256: sha256('wt'),
            policyDigest: sha256('pol'),
            toolCatalogSha256: sha256('cat'),
            attachedAt: '2026-11-25T10:00:00.000Z',
          }
        },
        async rebindBrain() {
          return { ok: false, reason: 'should_not_be_called' }
        },
      },
      credentialLeases: {
        async issueLease() {
          throw new Error('should_not_be_called')
        },
        async revokeLease() {
          return true
        },
      },
      drivers: {
        async stopLane() {
          return { stopped: true, reachable: true }
        },
        async prewarm() {
          return { ready: true }
        },
      },
    })

    const conflict = await coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 99,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
      currentFencingToken: activeToken,
    })

    assert.ok(!conflict.ok)
    assert.equal(conflict.code, 'MIGRATION_EPOCH_CONFLICT')
    assert.equal(quiesceCalls, 0, 'source ExecEnv MUST NOT be quiesced on epoch conflict')
    assert.equal(leaseState, 'active')
    assert.deepEqual(invokeTool(activeToken, 1), { ok: true, count: 1 })
  })

  it('B08(b): post-rebind prewarm rejection restores source ExecEnv with strictly higher rollbackBrainGen & fresh token that executes tools while old revoked tokens stay rejected', async () => {
    const authorityStore = new InMemoryAuthorityStore(localPlacement)
    const initialToken = 'fence-e000001-g000001-initial00000'
    let leaseState: 'active' | 'quiescing' = 'active'
    let activeBrainGen = 1
    let activeToken = initialToken
    let activePlacement: PlacementDescriptor = localPlacement
    const revokedTokens = new Set<string>()
    const tracker: { targetFailedToken: string | null } = { targetFailedToken: null }
    let toolRuns = 0

    const invokeSourceTool = (token: string, brainGen: number) => {
      if (leaseState === 'quiescing') {
        return { status: 'denied' as const, errorCode: 'EXEC_LEASE_QUIESCING' }
      }
      if (revokedTokens.has(token) || token !== activeToken || brainGen < activeBrainGen) {
        return { status: 'denied' as const, errorCode: 'EXEC_FENCING_TOKEN_STALE' }
      }
      toolRuns += 1
      return { status: 'ok' as const, output: `ran:${toolRuns}` }
    }

    const attachmentBase: ExecEnvAttachmentSnapshot = Object.freeze({
      leaseId: 'exec-lease-1',
      channelKind: 'uds_jsonrpc',
      workspaceTreeSha256: sha256('wt-b08b'),
      policyDigest: sha256('pol-b08b'),
      toolCatalogSha256: sha256('cat-b08b'),
      attachedAt: '2026-11-25T10:00:00.000Z',
    })

    const coordinator = new MigrationCoordinator({
      authorityStore,
      reconciliationWalDir: makeTempReconcileDir(),
      capsuleStore: {
        async exportCapsule() {
          return {
            ok: true,
            capsuleRef: {
              capsuleId: sha256('cap-b08b'),
              engine: 'ccb',
              portability: 'portable',
              placementEpoch: 1,
              totalBytes: 128,
              fileCount: 1,
              createdAt: '2026-11-25T10:00:00.000Z',
            },
          }
        },
        async importCapsule() {
          return { ok: true, nativeSessionId: 'unused', continuityTier: 'hot_native' }
        },
        async degradeToTranscript() {
          return { ok: false, reason: 'unused' }
        },
      },
      execEnv: {
        async quiesce() {
          leaseState = 'quiescing'
          return { quiesced: true, activeToolCalls: 0 }
        },
        async exportAttachmentDigest() {
          return attachmentBase
        },
        async rebindBrain(args) {
          assert.ok(args.nextBrainGen > activeBrainGen, 'rollback brainGen must strictly increase')
          assert.ok(
            !revokedTokens.has(args.nextFencingToken) && args.nextFencingToken !== activeToken,
            'rollback must never resurrect a revoked fencingToken',
          )
          revokedTokens.add(activeToken)
          activeBrainGen = args.nextBrainGen
          activeToken = args.nextFencingToken
          activePlacement = args.targetPlacement
          leaseState = 'active'
          if (args.targetPlacement.poolKind === 'remote_pool') {
            tracker.targetFailedToken = args.nextFencingToken
          }
          return {
            ok: true,
            brainGen: activeBrainGen,
            fencingToken: activeToken,
            attachment: attachmentBase,
          }
        },
      },
      credentialLeases: {
        async issueLease(req) {
          return Object.freeze({
            leaseId: 'cred-candidate-b08b',
            tenantId: req.tenantId,
            profileId: req.profileId,
            engine: req.engine,
            mountKind: req.mountKind,
            noRefreshToken: true as const,
            issuedAt: '2026-11-25T10:00:00.000Z',
            expiresAt: '2026-11-25T10:15:00.000Z',
          })
        },
        async revokeLease() {
          return true
        },
      },
      drivers: {
        async stopLane() {
          return { stopped: true, reachable: true, dualProofVerified: true }
        },
        async prewarm() {
          return { ready: false, reason: 'target_prewarm_overloaded' }
        },
      },
    })

    const res = await coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
      currentFencingToken: initialToken,
    })

    assert.ok(!res.ok)
    assert.equal(res.code, 'MIGRATION_TARGET_PREWARM_FAILED')
    assert.equal(res.rolledBack, true)
    assert.equal(authorityStore.pointer.placementEpoch, 1)
    assert.equal(authorityStore.pointer.migrationState, 'active')
    assert.equal(activePlacement.poolKind, 'local_container')
    assert.ok(res.restoredSourceLease, 'restoredSourceLease must be returned on post-rebind rollback')
    assert.equal(res.restoredSourceLease.brainGen, 3)
    assert.notEqual(res.restoredSourceLease.fencingToken, initialToken)
    assert.notEqual(res.restoredSourceLease.fencingToken, tracker.targetFailedToken)

    // Old revoked source token (gen 1) AND failed target token (gen 2) MUST be rejected!
    assert.deepEqual(invokeSourceTool(initialToken, 1), {
      status: 'denied',
      errorCode: 'EXEC_FENCING_TOKEN_STALE',
    })
    assert.ok(tracker.targetFailedToken !== null)
    assert.deepEqual(invokeSourceTool(tracker.targetFailedToken, 2), {
      status: 'denied',
      errorCode: 'EXEC_FENCING_TOKEN_STALE',
    })

    // Source brain executes a real tool call with restored gen-3 rollbackFencingToken -> SUCCEEDS!
    assert.deepEqual(
      invokeSourceTool(res.restoredSourceLease.fencingToken, res.restoredSourceLease.brainGen),
      { status: 'ok', output: 'ran:1' },
    )
    assert.equal(toolRuns, 1)
  })

  it('B08(c): reports rolledBack=false + recoveryRequired=true if abortPlacementMigration or rollback rebindBrain throws, and recovers committed state on commit ack loss', async () => {
    // Subcase 1: abortPlacementMigration throws -> rolledBack MUST be false
    const storeAbortThrows = new InMemoryAuthorityStore(localPlacement)
    storeAbortThrows.abortPlacementMigration = async () => {
      throw new Error('PG_CONNECTION_RESET_DURING_ABORT')
    }
    const h1 = createHarness()
    const coordAbortThrows = new MigrationCoordinator({
      authorityStore: storeAbortThrows,
      reconciliationWalDir: makeTempReconcileDir(),
      capsuleStore: {
        async exportCapsule() {
          return { ok: false, reason: 'skip' }
        },
        async importCapsule() {
          return { ok: false, reason: 'skip' }
        },
        async degradeToTranscript() {
          return { ok: false, reason: 'skip' }
        },
      },
      execEnv: {
        async quiesce() {
          return { quiesced: true, activeToolCalls: 0 }
        },
        async exportAttachmentDigest() {
          return {
            leaseId: 'exec-lease-1',
            channelKind: 'uds_jsonrpc',
            workspaceTreeSha256: sha256('wt'),
            policyDigest: sha256('pol'),
            toolCatalogSha256: sha256('cat'),
            attachedAt: '2026-11-25T10:00:00.000Z',
          }
        },
        async rebindBrain(args) {
          return { ok: true, brainGen: args.nextBrainGen, fencingToken: args.nextFencingToken }
        },
      },
      credentialLeases: {
        async issueLease(req) {
          return Object.freeze({
            leaseId: 'cred-1',
            tenantId: req.tenantId,
            profileId: req.profileId,
            engine: req.engine,
            mountKind: req.mountKind,
            noRefreshToken: true as const,
            issuedAt: '2026-11-25T10:00:00.000Z',
            expiresAt: '2026-11-25T10:15:00.000Z',
          })
        },
        async revokeLease() {
          return true
        },
      },
      drivers: {
        async stopLane() {
          return { stopped: true, reachable: true }
        },
        async prewarm() {
          return { ready: false, reason: 'prewarm_denied' }
        },
      },
    })

    const abortErrRes = await coordAbortThrows.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
    })
    assert.ok(!abortErrRes.ok)
    assert.equal(abortErrRes.rolledBack, false)
    assert.equal(abortErrRes.recoveryRequired, true)
    void h1

    // Subcase 2: rollback rebindBrain throws -> rolledBack MUST be false
    const store2 = new InMemoryAuthorityStore(localPlacement)
    let rebindCalls = 0
    const coordRebindThrows = new MigrationCoordinator({
      authorityStore: store2,
      reconciliationWalDir: makeTempReconcileDir(),
      capsuleStore: {
        async exportCapsule() {
          return { ok: false, reason: 'skip' }
        },
        async importCapsule() {
          return { ok: false, reason: 'skip' }
        },
        async degradeToTranscript() {
          return { ok: false, reason: 'skip' }
        },
      },
      execEnv: {
        async quiesce() {
          return { quiesced: true, activeToolCalls: 0 }
        },
        async exportAttachmentDigest() {
          return {
            leaseId: 'exec-lease-1',
            channelKind: 'uds_jsonrpc',
            workspaceTreeSha256: sha256('wt'),
            policyDigest: sha256('pol'),
            toolCatalogSha256: sha256('cat'),
            attachedAt: '2026-11-25T10:00:00.000Z',
          }
        },
        async rebindBrain(args) {
          rebindCalls += 1
          if (rebindCalls === 2) {
            throw new Error('EXEC_ENV_ROLLBACK_LINK_LOST')
          }
          return { ok: true, brainGen: args.nextBrainGen, fencingToken: args.nextFencingToken }
        },
      },
      credentialLeases: {
        async issueLease(req) {
          return Object.freeze({
            leaseId: 'cred-2',
            tenantId: req.tenantId,
            profileId: req.profileId,
            engine: req.engine,
            mountKind: req.mountKind,
            noRefreshToken: true as const,
            issuedAt: '2026-11-25T10:00:00.000Z',
            expiresAt: '2026-11-25T10:15:00.000Z',
          })
        },
        async revokeLease() {
          return true
        },
      },
      drivers: {
        async stopLane() {
          return { stopped: true, reachable: true }
        },
        async prewarm() {
          return { ready: false, reason: 'prewarm_denied' }
        },
      },
    })

    const rebindRollbackErrRes = await coordRebindThrows.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
    })
    assert.ok(!rebindRollbackErrRes.ok)
    assert.equal(rebindRollbackErrRes.rolledBack, false)
    assert.equal(rebindRollbackErrRes.recoveryRequired, true)

    // Subcase 3: commitPlacementMigration throws AFTER PG actually committed -> read-back confirms committed and does NOT roll back!
    const storeAckLost = new InMemoryAuthorityStore(localPlacement)
    const origCommit = storeAckLost.commitPlacementMigration.bind(storeAckLost)
    storeAckLost.commitPlacementMigration = async (cas) => {
      await origCommit(cas)
      throw new Error('PG_ACK_SOCKET_TIMEOUT')
    }
    let rollbackAttempted = false
    const coordAckLost = new MigrationCoordinator({
      authorityStore: storeAckLost,
      reconciliationWalDir: makeTempReconcileDir(),
      capsuleStore: {
        async exportCapsule() {
          return {
            ok: true,
            capsuleRef: {
              capsuleId: sha256('cap-ack'),
              engine: 'ccb',
              portability: 'portable',
              placementEpoch: 1,
              totalBytes: 64,
              fileCount: 1,
              createdAt: '2026-11-25T10:00:00.000Z',
            },
          }
        },
        async importCapsule() {
          return { ok: true, nativeSessionId: 'native-remote-committed', continuityTier: 'hot_native' }
        },
        async degradeToTranscript() {
          return { ok: false, reason: 'unused' }
        },
      },
      execEnv: {
        async quiesce() {
          return { quiesced: true, activeToolCalls: 0 }
        },
        async exportAttachmentDigest() {
          return {
            leaseId: 'exec-lease-1',
            channelKind: 'uds_jsonrpc',
            workspaceTreeSha256: sha256('wt'),
            policyDigest: sha256('pol'),
            toolCatalogSha256: sha256('cat'),
            attachedAt: '2026-11-25T10:00:00.000Z',
          }
        },
        async rebindBrain(args) {
          if (args.targetPlacement.poolKind === 'local_container') {
            rollbackAttempted = true
          }
          return { ok: true, brainGen: args.nextBrainGen, fencingToken: args.nextFencingToken }
        },
      },
      credentialLeases: {
        async issueLease(req) {
          return Object.freeze({
            leaseId: 'cred-ack',
            tenantId: req.tenantId,
            profileId: req.profileId,
            engine: req.engine,
            mountKind: req.mountKind,
            noRefreshToken: true as const,
            issuedAt: '2026-11-25T10:00:00.000Z',
            expiresAt: '2026-11-25T10:15:00.000Z',
          })
        },
        async revokeLease() {
          return true
        },
      },
      drivers: {
        async stopLane() {
          return { stopped: true, reachable: true }
        },
        async prewarm() {
          return { ready: true }
        },
      },
    })

    const ackLostRes = await coordAckLost.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
    })
    assert.ok(ackLostRes.ok, 'must recognize committed PG state on read-back instead of rolling back')
    assert.equal(ackLostRes.toEpoch, 2)
    assert.equal(storeAckLost.pointer.placementEpoch, 2)
    assert.equal(rollbackAttempted, false)
  })

  it('supports Tier 3 cold_degraded fallback and prewarm / drain / reopen control operations', async () => {
    const h = createHarness()
    h.setForceSourceUnreachable(true)
    h.setForceDegradeFailure(true)

    const coldRes = await h.coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-mig-1',
      sessionId: 'sid-1',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-1',
      currentBrainGen: 1,
      allowColdFallback: true,
    })
    assert.ok(coldRes.ok)
    assert.equal(coldRes.continuityTier, 'cold_degraded')
    assert.equal(coldRes.notifyContextRebuilt, true)

    const prewarmOut = await h.coordinator.prewarm({
      sessionKey: 'sess-mig-1',
      targetPlacement: remotePlacement,
      frozenPromptSha256: sha256('prompt-prewarm'),
    })
    assert.equal(prewarmOut.ready, true)
    assert.equal(prewarmOut.stickyHomeKey, stickyKey)

    const drainOut = await h.coordinator.drain({ releaseRunId: 'rel-100' })
    assert.equal(drainOut.drained, true)
    assert.equal(drainOut.releaseRunId, 'rel-100')
    assert.equal(h.coordinator.isDraining, true)

    const reopened = h.coordinator.reopen()
    assert.equal(reopened.draining, false)
    assert.equal(h.coordinator.isDraining, false)
  })
})

describe('legacyRetirement — Phase 3 readiness gate & read-only historical billing shell', () => {
  function makeReadOnlyQueryable(counts: {
    activeLegacyBindings: number
    unsettledLegacyJournals: number
    historicalRows?: readonly Record<string, unknown>[]
  }) {
    const executedSql: string[] = []
    const queryable: PgQueryable = {
      async query<R extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: unknown[] = [],
      ): Promise<PgQueryResult<R>> {
        executedSql.push(sql)
        assert.equal(
          /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i.test(sql),
          false,
          `legacyRetirement must never execute write SQL: ${sql}`,
        )
        if (sql.includes('FROM remote_agent_bindings')) {
          return {
            rows: [{ cnt: String(counts.activeLegacyBindings) } as unknown as R],
            rowCount: 1,
          }
        }
        if (sql.includes('COUNT(*)') && sql.includes('FROM request_finalize_journal')) {
          return {
            rows: [{ cnt: String(counts.unsettledLegacyJournals) } as unknown as R],
            rowCount: 1,
          }
        }
        if (sql.includes('FROM request_finalize_journal')) {
          const reqId = String(params[0])
          const matched = (counts.historicalRows ?? []).filter(
            (r) => String(r.request_id) === reqId,
          )
          return { rows: matched as unknown as R[], rowCount: matched.length }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    return { queryable, executedSql }
  }

  it('blocks retirement when legacy bindings or unsettled legacy journals remain, and passes only when both reach zero', async () => {
    assert.deepEqual(LEGACY_REMOTE_BACKEND_KINDS, ['codex-app-server-v1', 'cc5-interactive-v1'])
    assert.deepEqual(LEGACY_BILLING_RECOVERY_VERSIONS, [
      'cc5-native-v1',
      'remote-native-v1',
      'remote-native-v2',
      'codex-remote-v1',
    ])

    const blockedBoth = makeReadOnlyQueryable({
      activeLegacyBindings: 3,
      unsettledLegacyJournals: 2,
    })
    const resBlocked = await evaluateLegacyRetirementReadiness(blockedBoth.queryable)
    assert.equal(resBlocked.readyToRetire, false)
    assert.equal(resBlocked.activeLegacyBindingCount, 3)
    assert.equal(resBlocked.unsettledLegacyJournalCount, 2)
    assert.deepEqual(resBlocked.blockingReasons, [
      'ACTIVE_LEGACY_BINDINGS_REMAINING',
      'UNSETTLED_LEGACY_BILLING_JOURNALS_REMAINING',
    ])

    const blockedBindingsOnly = makeReadOnlyQueryable({
      activeLegacyBindings: 1,
      unsettledLegacyJournals: 0,
    })
    const resBindings = await evaluateLegacyRetirementReadiness(blockedBindingsOnly.queryable)
    assert.equal(resBindings.readyToRetire, false)
    assert.deepEqual(resBindings.blockingReasons, ['ACTIVE_LEGACY_BINDINGS_REMAINING'])

    const ready = makeReadOnlyQueryable({
      activeLegacyBindings: 0,
      unsettledLegacyJournals: 0,
    })
    const resReady = await evaluateLegacyRetirementReadiness(ready.queryable)
    assert.equal(resReady.readyToRetire, true)
    assert.equal(resReady.activeLegacyBindingCount, 0)
    assert.equal(resReady.unsettledLegacyJournalCount, 0)
    assert.deepEqual(resReady.blockingReasons, [])
  })

  it('provides read-only historical lookup and rejects all active journal writes', async () => {
    const mock = makeReadOnlyQueryable({
      activeLegacyBindings: 0,
      unsettledLegacyJournals: 1,
      historicalRows: [
        {
          request_id: 'req-legacy-001',
          user_id: '42',
          state: 'committed',
          precheck_credits: '500',
          final_credits: '120',
          ledger_id: '9001',
          usage_id: '8001',
          error_msg: null,
          ctx: {
            remoteNativeBillingRecovery: 'remote-native-v2',
            executionBackend: { kind: 'codex-app-server-v1' },
          },
          created_at: '2026-11-20T08:00:00.000Z',
          updated_at: '2026-11-20T08:00:05.000Z',
        },
      ],
    })

    const shell = createLegacyBillingReadOnlyShell(mock.queryable)
    assert.equal(shell.readOnly, true)
    assert.equal(shell.retiredErrorCode, LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY)

    const turn = await shell.lookupHistoricalTurn({ requestId: 'req-legacy-001', userId: 42 })
    assert.ok(turn !== null)
    assert.equal(turn.requestId, 'req-legacy-001')
    assert.equal(turn.userId, '42')
    assert.equal(turn.state, 'committed')
    assert.equal(turn.finalCredits, 120)
    assert.equal(turn.billingRecoveryVersion, 'remote-native-v2')
    assert.equal(turn.backendKind, 'codex-app-server-v1')

    const missing = await shell.lookupHistoricalTurn({ requestId: 'req-missing' })
    assert.equal(missing, null)

    const pending = await shell.listLegacyPendingCount()
    assert.equal(pending, 1)

    assert.throws(() => shell.createJournal({ requestId: 'new-1' }), /LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY/)
    assert.throws(() => shell.recordJournalWrite({ requestId: 'new-2' }), /LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY/)
    assert.throws(() => shell.assertWriteRejected(), /LEGACY_REMOTE_BILLING_RETIRED_READ_ONLY/)
  })
})

describe('OCV5-890 B08-R2: MigrationCoordinator preserves target credential lease when commit outcome is unknown', () => {
  it('fails closed before PG begin when durable reconciliation store is missing, and aborts cleanly before PG commit if intent persistence fails', async () => {
    const localPlacement: PlacementDescriptor = {
      poolKind: 'local_container',
      engine: 'ccb',
      driverId: 'local-cc',
      placementEpoch: 1,
      containerId: 'cid-req-1',
    }
    const remotePlacement: PlacementDescriptor = {
      poolKind: 'remote_pool',
      engine: 'ccb',
      driverId: 'cc',
      placementEpoch: 2,
      profileId: 'prof-req-1',
      operationId: '66666666-6666-4666-8666-666666666666',
    }

    // 1. No reconciliationWalDir & no pendingReconciliationStore -> rejected BEFORE beginPlacementMigration
    const storeNoWal = new InMemoryAuthorityStore(localPlacement)
    let beginCalls = 0
    const origBegin = storeNoWal.beginPlacementMigration.bind(storeNoWal)
    storeNoWal.beginPlacementMigration = async (cas) => {
      beginCalls += 1
      return await origBegin(cas)
    }
    const noWalCoord = new MigrationCoordinator({
      authorityStore: storeNoWal,
      capsuleStore: {
        async exportCapsule() {
          return { ok: false, reason: 'unused' }
        },
        async importCapsule() {
          return { ok: false, reason: 'unused' }
        },
        async degradeToTranscript() {
          return { ok: false, reason: 'unused' }
        },
      },
      execEnv: {
        async quiesce() {
          return { quiesced: true, activeToolCalls: 0 }
        },
        async exportAttachmentDigest() {
          return {
            leaseId: 'exec-req-1',
            channelKind: 'uds_jsonrpc',
            workspaceTreeSha256: sha256('wt'),
            policyDigest: sha256('pol'),
            toolCatalogSha256: sha256('cat'),
            attachedAt: '2026-11-25T10:00:00.000Z',
          }
        },
        async rebindBrain(args) {
          return { ok: true, brainGen: args.nextBrainGen, fencingToken: args.nextFencingToken }
        },
      },
      credentialLeases: {
        async issueLease() {
          throw new Error('must_not_issue_without_reconciliation_store')
        },
        async revokeLease() {
          return true
        },
      },
      drivers: {
        async stopLane() {
          return { stopped: true, reachable: true }
        },
        async prewarm() {
          return { ready: true }
        },
      },
    })
    const noWalRes = await noWalCoord.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-req-1',
      sessionId: 'sid-req-1',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-req-1',
      currentBrainGen: 1,
    })
    assert.ok(!noWalRes.ok)
    assert.equal(noWalRes.code, 'MIGRATION_RECONCILIATION_STORE_REQUIRED')
    assert.equal(beginCalls, 0)

    // 2. Pre-commit reconciliation intent persistence throws -> NEVER calls commitPlacementMigration, safely rolls back!
    const storePersistFail = new InMemoryAuthorityStore(localPlacement)
    let commitCalls = 0
    storePersistFail.commitPlacementMigration = async () => {
      commitCalls += 1
      throw new Error('must_never_commit_when_intent_persist_fails')
    }
    const revokedOnAbort: string[] = []
    const failingStore: PendingCredentialReconciliationStore = {
      put() {
        throw new Error('DISK_ENOSPC_INTENT_WRITE')
      },
      get: () => null,
      delete: () => {},
      list: () => [],
    }
    const persistFailCoord = new MigrationCoordinator({
      authorityStore: storePersistFail,
      pendingReconciliationStore: failingStore,
      capsuleStore: {
        async exportCapsule() {
          return { ok: false, reason: 'skip' }
        },
        async importCapsule() {
          return { ok: false, reason: 'skip' }
        },
        async degradeToTranscript() {
          return { ok: false, reason: 'skip' }
        },
      },
      execEnv: {
        async quiesce() {
          return { quiesced: true, activeToolCalls: 0 }
        },
        async exportAttachmentDigest() {
          return {
            leaseId: 'exec-req-2',
            channelKind: 'uds_jsonrpc',
            workspaceTreeSha256: sha256('wt2'),
            policyDigest: sha256('pol2'),
            toolCatalogSha256: sha256('cat2'),
            attachedAt: '2026-11-25T10:00:00.000Z',
          }
        },
        async rebindBrain(args) {
          return { ok: true, brainGen: args.nextBrainGen, fencingToken: args.nextFencingToken }
        },
      },
      credentialLeases: {
        async issueLease(req) {
          return Object.freeze({
            leaseId: 'cred-candidate-abort-on-persist-fail',
            tenantId: req.tenantId,
            profileId: req.profileId,
            engine: req.engine,
            mountKind: req.mountKind,
            noRefreshToken: true as const,
            issuedAt: '2026-11-25T10:00:00.000Z',
            expiresAt: '2026-11-25T10:15:00.000Z',
          })
        },
        async revokeLease(id) {
          revokedOnAbort.push(id)
          return true
        },
      },
      drivers: {
        async stopLane() {
          return { stopped: true, reachable: true }
        },
        async prewarm() {
          return { ready: true }
        },
      },
    })
    const persistFailRes = await persistFailCoord.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-req-2',
      sessionId: 'sid-req-2',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-req-2',
      currentBrainGen: 1,
      allowColdFallback: true,
    })
    assert.ok(!persistFailRes.ok)
    assert.equal(persistFailRes.code, 'MIGRATION_RECONCILIATION_PERSIST_FAILED')
    assert.equal(persistFailRes.rolledBack, true)
    assert.equal(commitCalls, 0, 'PG commit MUST NEVER run if pre-commit reconciliation intent failed to persist')
    assert.deepEqual(revokedOnAbort, ['cred-candidate-abort-on-persist-fail'])
    assert.equal(storePersistFail.pointer.placementEpoch, 1)
  })

  it('uses real disk reconciliationWalDir across restarted coordinators: retains committed record on first source-revoke failure, keeps target executable, and deletes only after convergence', async () => {
    const reconciliationWalDir = makeTempReconcileDir('ocv5-b08-disk-commit-')
    const localPlacement: PlacementDescriptor = {
      poolKind: 'local_container',
      engine: 'ccb',
      driverId: 'local-cc',
      placementEpoch: 1,
      containerId: 'cid-99',
    }
    const remotePlacement: PlacementDescriptor = {
      poolKind: 'remote_pool',
      engine: 'ccb',
      driverId: 'cc',
      placementEpoch: 2,
      profileId: 'prof-target-b08-r2',
      operationId: '77777777-7777-4777-8777-777777777777',
    }
    const authorityStore = new InMemoryAuthorityStore(localPlacement)
    let pgReadbackFailOnce = true
    const originalCommit = authorityStore.commitPlacementMigration.bind(authorityStore)
    const originalGetMig = authorityStore.getPlacementMigration.bind(authorityStore)

    authorityStore.commitPlacementMigration = async (cas) => {
      // PG actually commits, THEN connection drops before ack returns!
      await originalCommit(cas)
      throw new Error('PG_COMMIT_ACK_LOST_EOF')
    }
    authorityStore.getPlacementMigration = async (migrationId) => {
      if (pgReadbackFailOnce) {
        pgReadbackFailOnce = false
        throw new Error('PG_READBACK_TRANSIENT_TIMEOUT')
      }
      return await originalGetMig(migrationId)
    }

    const activeCredentials = new Set<string>(['cred-source-old-b08-r2'])
    const revokedLeases: string[] = []
    const issuedLeases: string[] = []
    let failSourceRevokeOnce = true
    let activeBrainGen = 1
    let activeToken = 'ft-b08-r2-gen-1'
    const attachmentBase: ExecEnvAttachmentSnapshot = Object.freeze({
      leaseId: 'exec-lease-b08-r2',
      channelKind: 'uds_jsonrpc',
      workspaceTreeSha256: sha256('wt-b08-r2'),
      policyDigest: sha256('pol-b08-r2'),
      toolCatalogSha256: sha256('cat-b08-r2'),
      attachedAt: '2026-11-25T10:00:00.000Z',
    })

    const makeCoordinator = () =>
      new MigrationCoordinator({
        authorityStore,
        reconciliationWalDir,
        capsuleStore: {
          async exportCapsule() {
            return {
              ok: true,
              capsuleRef: {
                capsuleId: 'cap-b08-r2',
                engine: 'ccb',
                portability: 'portable',
                placementEpoch: 1,
                totalBytes: 64,
                fileCount: 1,
                manifestBlobId: 'blob-cap-b08-r2',
                createdAt: '2026-11-25T10:00:00.000Z',
              },
            }
          },
          async importCapsule() {
            return { ok: true, nativeSessionId: 'native-target-b08-r2', continuityTier: 'hot_native' }
          },
          async degradeToTranscript() {
            return { ok: false, reason: 'unused' }
          },
        },
        execEnv: {
          async quiesce() {
            return { quiesced: true, activeToolCalls: 0 }
          },
          async exportAttachmentDigest() {
            return attachmentBase
          },
          async rebindBrain(args) {
            activeBrainGen = args.nextBrainGen
            activeToken = args.nextFencingToken
            return { ok: true, brainGen: activeBrainGen, fencingToken: activeToken, attachment: attachmentBase }
          },
        },
        credentialLeases: {
          async issueLease(req) {
            const leaseId = 'cred-target-b08-r2-must-survive'
            issuedLeases.push(leaseId)
            activeCredentials.add(leaseId)
            return Object.freeze({
              leaseId,
              tenantId: req.tenantId,
              profileId: req.profileId,
              engine: req.engine,
              mountKind: req.mountKind,
              noRefreshToken: true as const,
              issuedAt: '2026-11-25T10:00:00.000Z',
              expiresAt: '2026-11-25T10:15:00.000Z',
            })
          },
          async revokeLease(leaseId) {
            if (leaseId === 'cred-source-old-b08-r2' && failSourceRevokeOnce) {
              failSourceRevokeOnce = false
              throw new Error('SOURCE_REVOKE_TRANSIENT_TIMEOUT')
            }
            revokedLeases.push(leaseId)
            activeCredentials.delete(leaseId)
            return true
          },
        },
        drivers: {
          async stopLane() {
            return { stopped: true, reachable: true, dualProofVerified: true }
          },
          async prewarm() {
            return { ready: true, prewarmedKey: 'home-b08-r2' }
          },
        },
      })

    const coordinator = makeCoordinator()
    const res = await coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-b08-r2',
      sessionId: 'sid-b08-r2',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-b08-r2',
      currentBrainGen: 1,
      currentFencingToken: 'ft-b08-r2-gen-1',
      previousCredentialLeaseId: 'cred-source-old-b08-r2',
    })

    assert.ok(!res.ok)
    assert.equal(res.code, 'MIGRATION_COMMIT_CONFLICT')
    assert.equal(res.rolledBack, false, 'PG actually committed so rollback must NOT report true')
    assert.equal(res.recoveryRequired, true)
    assert.equal(issuedLeases.length, 1)
    assert.deepEqual(
      revokedLeases,
      [],
      'target candidate credential lease MUST NOT be revoked when PG commit outcome is unknown and abort did not apply',
    )
    assert.equal(activeBrainGen, 2, 'ExecEnv must remain on target brainGen=2 instead of split-braining backward')
    assert.equal(res.preservedCandidateLease?.leaseId, 'cred-target-b08-r2-must-survive')

    // Restart #1 from real disk reconciliationWalDir: reads committed, 1st source revoke throws ->
    // MUST RETAIN record on disk (`stillPending: true`, `fullyConverged: false`) while target remains active!
    const restarted1 = makeCoordinator()
    assert.equal((await restarted1.listPendingCredentialReconciliations()).length, 1)
    const partial = await restarted1.reconcilePendingCredentialCleanup(res.migrationId!)
    assert.ok(partial !== null && partial.status === 'committed')
    assert.equal(partial.targetCredentialPreserved, true)
    assert.equal(partial.sourceCredentialRevoked, false)
    assert.equal(partial.fullyConverged, false)
    assert.equal(partial.stillPending, true)
    assert.equal(activeCredentials.has('cred-target-b08-r2-must-survive'), true)
    assert.equal(
      (await restarted1.listPendingCredentialReconciliations()).length,
      1,
      'pending record MUST NOT be deleted when source credential revocation failed',
    )

    // Restart #2 from real disk reconciliationWalDir: source revoke succeeds -> record deleted, target STILL active!
    const restarted2 = makeCoordinator()
    const converged = await restarted2.reconcilePendingCredentialCleanup(res.migrationId!)
    assert.ok(converged !== null && converged.status === 'committed')
    assert.equal(converged.targetCredentialPreserved, true)
    assert.equal(converged.targetCredentialLease?.leaseId, 'cred-target-b08-r2-must-survive')
    assert.equal(converged.sourceCredentialRevoked, true)
    assert.equal(converged.fullyConverged, true)
    assert.equal(converged.stillPending, false)
    assert.equal(converged.pointer?.placementEpoch, 2)
    assert.equal(converged.pointer?.poolKind, 'remote_pool')

    assert.deepEqual(revokedLeases, ['cred-source-old-b08-r2'])
    assert.equal(activeCredentials.has('cred-target-b08-r2-must-survive'), true)
    assert.equal(activeCredentials.has('cred-source-old-b08-r2'), false)
    assert.equal((await restarted2.listPendingCredentialReconciliations()).length, 0)

    const executeTargetTurnWithCredential = (leaseId: string, brainGen: number) => {
      if (!activeCredentials.has(leaseId)) throw new Error('CREDENTIAL_LEASE_REVOKED')
      if (brainGen !== activeBrainGen) throw new Error('EXEC_FENCING_TOKEN_STALE')
      return { ok: true, executedOn: authorityStore.pointer.poolKind }
    }
    assert.deepEqual(
      executeTargetTurnWithCredential(converged.targetCredentialLease!.leaseId, activeBrainGen),
      { ok: true, executedOn: 'remote_pool' },
    )
  })

  it('uses real disk reconciliationWalDir on aborted recovery: persists partial progress when target revoke succeeds but source ExecEnv restore fails, then finishes remaining step on restart', async () => {
    const reconciliationWalDir = makeTempReconcileDir('ocv5-b08-disk-abort-')
    const localPlacement: PlacementDescriptor = {
      poolKind: 'local_container',
      engine: 'ccb',
      driverId: 'local-cc',
      placementEpoch: 1,
      containerId: 'cid-100',
    }
    const remotePlacement: PlacementDescriptor = {
      poolKind: 'remote_pool',
      engine: 'ccb',
      driverId: 'cc',
      placementEpoch: 2,
      profileId: 'prof-target-b08-abort',
      operationId: '88888888-8888-4888-8888-888888888888',
    }
    const authorityStore = new InMemoryAuthorityStore(localPlacement)
    let pgDown = true
    let failSourceRestoreOnce = true
    const origGetMig = authorityStore.getPlacementMigration.bind(authorityStore)
    const origAbort = authorityStore.abortPlacementMigration.bind(authorityStore)

    authorityStore.commitPlacementMigration = async () => {
      // PG dropped connection BEFORE committing (migration remains in 'migrating')
      throw new Error('PG_NETWORK_PARTITION_BEFORE_COMMIT')
    }
    authorityStore.getPlacementMigration = async (migrationId) => {
      if (pgDown) throw new Error('PG_STILL_UNREACHABLE')
      return await origGetMig(migrationId)
    }
    authorityStore.abortPlacementMigration = async (cas) => {
      if (pgDown) throw new Error('PG_STILL_UNREACHABLE')
      return await origAbort(cas)
    }

    const activeCredentials = new Set<string>(['cred-source-abort-test'])
    const revokedLeases: string[] = []
    let activeBrainGen = 1
    let activePlacement: PlacementDescriptor = localPlacement

    const makeCoordinator = () =>
      new MigrationCoordinator({
        authorityStore,
        reconciliationWalDir,
        capsuleStore: {
          async exportCapsule() {
            return { ok: false, reason: 'skip' }
          },
          async importCapsule() {
            return { ok: false, reason: 'skip' }
          },
          async degradeToTranscript() {
            return { ok: false, reason: 'skip' }
          },
        },
        execEnv: {
          async quiesce() {
            return { quiesced: true, activeToolCalls: 0 }
          },
          async exportAttachmentDigest() {
            return {
              leaseId: 'exec-lease-b08-abort',
              channelKind: 'uds_jsonrpc',
              workspaceTreeSha256: sha256('wt-abort'),
              policyDigest: sha256('pol-abort'),
              toolCatalogSha256: sha256('cat-abort'),
              attachedAt: '2026-11-25T10:00:00.000Z',
            }
          },
          async rebindBrain(args) {
            if (args.targetPlacement.poolKind === 'local_container' && failSourceRestoreOnce) {
              failSourceRestoreOnce = false
              throw new Error('EXEC_ENV_SOURCE_RESTORE_TRANSIENT_FAILURE')
            }
            activeBrainGen = args.nextBrainGen
            activePlacement = args.targetPlacement
            return { ok: true, brainGen: args.nextBrainGen, fencingToken: args.nextFencingToken }
          },
        },
        credentialLeases: {
          async issueLease(req) {
            const leaseId = 'cred-target-abort-deferred'
            activeCredentials.add(leaseId)
            return Object.freeze({
              leaseId,
              tenantId: req.tenantId,
              profileId: req.profileId,
              engine: req.engine,
              mountKind: req.mountKind,
              noRefreshToken: true as const,
              issuedAt: '2026-11-25T10:00:00.000Z',
              expiresAt: '2026-11-25T10:15:00.000Z',
            })
          },
          async revokeLease(leaseId) {
            revokedLeases.push(leaseId)
            activeCredentials.delete(leaseId)
            return true
          },
        },
        drivers: {
          async stopLane() {
            return { stopped: true, reachable: true }
          },
          async prewarm() {
            return { ready: true }
          },
        },
      })

    const coordinator = makeCoordinator()
    const res = await coordinator.handoff({
      userId: 42,
      tenantId: '42',
      sessionKey: 'sess-b08-abort',
      sessionId: 'sid-b08-abort',
      expectedPlacementEpoch: 1,
      fromPlacement: localPlacement,
      toPlacement: remotePlacement,
      settledToolsProven: true,
      execEnvLeaseId: 'exec-lease-b08-abort',
      currentBrainGen: 1,
      previousCredentialLeaseId: 'cred-source-abort-test',
      allowColdFallback: true,
    })

    assert.ok(!res.ok)
    assert.equal(res.rolledBack, false)
    assert.deepEqual(revokedLeases, [], 'must NOT revoke target lease while PG abort is unconfirmed')

    // Restart #1 while PG is still unreachable -> stays unknown, revokes nothing, keeps disk record
    const restartedWhileDown = makeCoordinator()
    const stillUnknown = await restartedWhileDown.reconcilePendingCredentialCleanup(res.migrationId!)
    assert.equal(stillUnknown?.status, 'unknown')
    assert.deepEqual(revokedLeases, [])
    assert.equal((await restartedWhileDown.listPendingCredentialReconciliations()).length, 1)

    // PG comes back online -> Restart #2 CAS-aborts PG & revokes target lease, but source ExecEnv restore fails ->
    // MUST persist partial progress (`targetLeaseRevoked: true, sourceExecEnvRestored: false`) and RETAIN disk record!
    pgDown = false
    const restartedPartial = makeCoordinator()
    const partialAbort = await restartedPartial.reconcilePendingCredentialCleanup(res.migrationId!)
    assert.ok(partialAbort !== null && partialAbort.status === 'aborted')
    assert.equal(partialAbort.targetCredentialRevoked, true)
    assert.equal(partialAbort.sourceExecEnvRestored, false)
    assert.equal(partialAbort.fullyConverged, false)
    assert.equal(partialAbort.stillPending, true)
    assert.deepEqual(revokedLeases, ['cred-target-abort-deferred'])
    const persistedPartial = await restartedPartial.getPendingCredentialReconciliation(res.migrationId!)
    assert.equal(persistedPartial?.pgDecision, 'aborted')
    assert.equal(persistedPartial?.targetLeaseRevoked, true)
    assert.equal(persistedPartial?.sourceExecEnvRestored, false)

    // Restart #3 finishes ONLY the missing source ExecEnv restore (zero duplicate target revoke) & deletes disk record!
    const restartedFinal = makeCoordinator()
    const converged = await restartedFinal.reconcilePendingCredentialCleanup(res.migrationId!)
    assert.ok(converged !== null && converged.status === 'aborted')
    assert.equal(converged.targetCredentialRevoked, true)
    assert.equal(converged.sourceExecEnvRestored, true)
    assert.equal(converged.sourceCredentialPreserved, true)
    assert.equal(converged.fullyConverged, true)
    assert.equal(converged.stillPending, false)
    assert.deepEqual(revokedLeases, ['cred-target-abort-deferred'])
    assert.equal(activeCredentials.has('cred-source-abort-test'), true)
    assert.equal(activeCredentials.has('cred-target-abort-deferred'), false)
    assert.equal(converged.restoredSourceLease?.brainGen, 3)
    assert.equal(activeBrainGen, 3)
    assert.equal(activePlacement.poolKind, 'local_container')
    assert.equal((await restartedFinal.listPendingCredentialReconciliations()).length, 0)
  })
})
