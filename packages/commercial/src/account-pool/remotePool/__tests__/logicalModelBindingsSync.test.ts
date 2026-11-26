import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { LogicalModelPoolBinding } from '@openclaude/protocol'
import type {
  ModelCapabilityProfile,
  ModelExecutionDescriptor,
} from '../../../billing/modelCatalog.js'
import {
  PgLogicalModelBindingStore,
  type PgQueryResult,
  type PgQueryable,
} from '../../../db/threeLayerStateStore.js'
import {
  DEFAULT_LOCAL_POOL_PRIORITY,
  DEFAULT_REMOTE_POOL_PRIORITY,
  deriveLogicalModelBindingsFromCatalog,
  resolveSelfhostLogicalModelPoolTarget,
  selectPeekBindingCandidate,
  syncLogicalModelPoolBindingsFromCatalog,
  validateExecutableBindingTuple,
  type CatalogBindingSourceEntry,
} from '../logicalModelBindingsSync.js'

function makeProfile(overrides?: Partial<ModelCapabilityProfile>): ModelCapabilityProfile {
  return {
    supportsVision: true,
    reasoning: {
      supported: ['low', 'medium', 'high'],
      codexModelDefault: 'medium',
    },
    ccb: {
      capabilityZero: false,
      supportsThinking: true,
    },
    ...overrides,
  }
}

function makeDescriptor(
  canonicalModel: string,
  overrides?: Partial<ModelExecutionDescriptor>,
): ModelExecutionDescriptor {
  return {
    canonicalModel,
    engine: 'codex',
    providerId: 'codex',
    upstreamModelId: canonicalModel,
    contextWindow: 256_000,
    capabilityProfile: makeProfile(),
    capabilitySchemaVersion: 1,
    defaultEffort: 'medium',
    placement: canonicalModel.endsWith('-remote') ? 'remote_pool' : 'local',
    ...overrides,
  }
}

interface StoredRow {
  logical_model_id: string
  pool_kind: string
  driver_id: string
  canonical_model_id: string
  priority: number
  capabilities_json: unknown
  enabled: boolean
  updated_at: string
}

class InMemoryBindingPool implements PgQueryable {
  readonly rows = new Map<string, StoredRow>()
  failNextRead = false
  queryCount = 0

  key(logicalModelId: string, poolKind: string, driverId: string): string {
    return `${logicalModelId}|${poolKind}|${driverId}`
  }

  seed(row: Omit<StoredRow, 'updated_at'>): void {
    this.rows.set(this.key(row.logical_model_id, row.pool_kind, row.driver_id), {
      ...row,
      updated_at: '2026-01-01T00:00:00.000Z',
    })
  }

  async query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<PgQueryResult<R>> {
    this.queryCount += 1
    if (sql.includes('INSERT INTO model_logical_pool_bindings')) {
      const [
        logicalModelId,
        poolKind,
        driverId,
        canonicalModelId,
        priority,
        capabilitiesJson,
        enabled,
      ] = params as [string, string, string, string, number, string, boolean]
      const k = this.key(logicalModelId, poolKind, driverId)
      const existing = this.rows.get(k)
      const preservesOverrides = sql.includes(
        'WHEN model_logical_pool_bindings.canonical_model_id = EXCLUDED.canonical_model_id',
      )
      let next: StoredRow
      if (!existing) {
        next = {
          logical_model_id: logicalModelId,
          pool_kind: poolKind,
          driver_id: driverId,
          canonical_model_id: canonicalModelId,
          priority,
          capabilities_json: JSON.parse(capabilitiesJson),
          enabled,
          updated_at: new Date().toISOString(),
        }
      } else if (preservesOverrides) {
        const sameTarget = existing.canonical_model_id === canonicalModelId
        next = {
          ...existing,
          capabilities_json: sameTarget ? JSON.parse(capabilitiesJson) : existing.capabilities_json,
          enabled: sameTarget && enabled === false ? false : existing.enabled,
          updated_at: new Date().toISOString(),
        }
      } else {
        next = {
          ...existing,
          canonical_model_id: canonicalModelId,
          priority,
          capabilities_json: JSON.parse(capabilitiesJson),
          enabled,
          updated_at: new Date().toISOString(),
        }
      }
      this.rows.set(k, next)
      return { rows: [{ enabled: next.enabled } as unknown as R], rowCount: 1 }
    }

    if (sql.includes('UPDATE model_logical_pool_bindings')) {
      const [logicalModelId, poolKind, driverId, capabilitiesJson, enabled, expectedCanonicalModelId] =
        params as [string, string, string, string, boolean, string?]
      const k = this.key(logicalModelId, poolKind, driverId)
      const existing = this.rows.get(k)
      if (!existing) {
        return { rows: [], rowCount: 0 }
      }
      if (
        sql.includes('AND canonical_model_id = $6') &&
        existing.canonical_model_id !== expectedCanonicalModelId
      ) {
        return { rows: [], rowCount: 0 }
      }
      const nextEnabled = sql.includes('CASE WHEN $5 = FALSE THEN FALSE ELSE enabled END')
        ? enabled === false
          ? false
          : existing.enabled
        : enabled
      const next: StoredRow = {
        ...existing,
        capabilities_json: JSON.parse(capabilitiesJson),
        enabled: nextEnabled,
        updated_at: new Date().toISOString(),
      }
      this.rows.set(k, next)
      return { rows: [{ enabled: next.enabled } as unknown as R], rowCount: 1 }
    }

    if (sql.includes('FROM model_logical_pool_bindings')) {
      if (this.failNextRead) {
        this.failNextRead = false
        throw new Error('PG_CONNECTION_LOST')
      }
      const hasLogicalWhere = sql.includes('WHERE logical_model_id = $1')
      const logicalModelId = hasLogicalWhere ? (params[0] as string) : null
      const remoteOnly = sql.includes("pool_kind = 'remote_pool'")
      const enabledOnly = sql.includes('enabled = TRUE')
      const matched = [...this.rows.values()]
        .filter((r) => (logicalModelId === null ? true : r.logical_model_id === logicalModelId))
        .filter((r) => (!remoteOnly ? true : r.pool_kind === 'remote_pool'))
        .filter((r) => (!enabledOnly ? true : r.enabled === true))
        .sort((a, b) => a.priority - b.priority || a.driver_id.localeCompare(b.driver_id))
      return { rows: matched as unknown as R[], rowCount: matched.length }
    }

    throw new Error(`Unexpected SQL in test mock: ${sql}`)
  }
}

describe('deriveLogicalModelBindingsFromCatalog', () => {
  it('derives active and disabled bindings across all authority engines and skips staged/retired', () => {
    const entries: CatalogBindingSourceEntry[] = [
      {
        modelId: 'gpt-6.2-astra-remote',
        engine: 'codex',
        upstreamModelId: 'gpt-6.2-astra',
        contextWindow: 256_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'remote_pool',
      },
      {
        modelId: 'gpt-6.2-astra',
        engine: 'codex',
        upstreamModelId: 'gpt-6.2-astra',
        contextWindow: 256_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'local',
      },
      {
        modelId: 'claude-sonnet-5-remote',
        engine: 'ccb',
        upstreamModelId: 'claude-sonnet-5',
        contextWindow: 200_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'remote_pool',
      },
      {
        modelId: 'claude-sonnet-5',
        engine: 'ccb',
        upstreamModelId: 'claude-sonnet-5',
        contextWindow: 200_000,
        capabilityProfile: makeProfile(),
        state: 'disabled',
        placement: 'local',
      },
      {
        modelId: 'gemini-3-pro',
        engine: 'antigravity',
        contextWindow: 1_000_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'local',
      },
      {
        modelId: 'grok-4',
        engine: 'grok',
        contextWindow: 128_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'local',
      },
      {
        modelId: 'cursor-fast',
        engine: 'cursor',
        contextWindow: 128_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'local',
      },
      {
        modelId: 'zcode-v1',
        engine: 'zcode',
        contextWindow: 128_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'local',
      },
      {
        modelId: 'staged-model',
        engine: 'codex',
        capabilityProfile: makeProfile(),
        state: 'staged',
        placement: 'local',
      },
      {
        modelId: 'retired-model',
        engine: 'ccb',
        capabilityProfile: makeProfile(),
        state: 'retired',
        placement: 'remote_pool',
      },
      {
        modelId: 'unknown-engine-model',
        engine: 'mystery-engine',
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'local',
      },
    ]

    const derived = deriveLogicalModelBindingsFromCatalog(entries)
    assert.equal(derived.length, 8)

    const byKey = new Map<string, LogicalModelPoolBinding>(
      derived.map((b) => [`${b.logicalModelId}|${b.poolKind}|${b.driverId}`, b]),
    )

    const remoteAstra = byKey.get('gpt-6.2-astra|remote_pool|codex')
    assert.ok(remoteAstra)
    assert.equal(remoteAstra.canonicalModelId, 'gpt-6.2-astra-remote')
    assert.equal(remoteAstra.priority, DEFAULT_REMOTE_POOL_PRIORITY)
    assert.equal(remoteAstra.enabled, true)
    assert.equal(remoteAstra.capabilities.contextWindow, 256_000)
    assert.equal(remoteAstra.capabilities.supportsVision, true)
    assert.equal(remoteAstra.capabilities.supportsReadOnly, true)
    assert.equal(remoteAstra.capabilities.supportsSwarm, false)

    const localAstra = byKey.get('gpt-6.2-astra|local_pool|local-codex')
    assert.ok(localAstra)
    assert.equal(localAstra.canonicalModelId, 'gpt-6.2-astra')
    assert.equal(localAstra.priority, DEFAULT_LOCAL_POOL_PRIORITY)
    assert.equal(localAstra.enabled, true)

    const remoteCc = byKey.get('claude-sonnet-5|remote_pool|cc')
    assert.ok(remoteCc)
    assert.equal(remoteCc.capabilities.supportsSwarm, true)

    const disabledCc = byKey.get('claude-sonnet-5|local_pool|local-cc')
    assert.ok(disabledCc)
    assert.equal(disabledCc.enabled, false)

    assert.ok(byKey.get('gemini-3-pro|local_pool|local-antigravity'))
    assert.ok(byKey.get('grok-4|local_pool|local-grok'))
    assert.ok(byKey.get('cursor-fast|local_pool|local-cursor'))
    assert.ok(byKey.get('zcode-v1|local_pool|local-zcode'))
  })

  it('prefers active over disabled when deduplicating the same (logicalModelId, poolKind, driverId)', () => {
    const entries: CatalogBindingSourceEntry[] = [
      {
        modelId: 'gpt-6.2-astra-remote',
        engine: 'codex',
        contextWindow: 128_000,
        capabilityProfile: makeProfile({ supportsVision: false }),
        state: 'disabled',
        placement: 'remote_pool',
      },
      {
        modelId: 'gpt-6.2-astra-remote',
        engine: 'codex',
        contextWindow: 256_000,
        capabilityProfile: makeProfile({ supportsVision: true }),
        state: 'active',
        placement: 'remote_pool',
      },
      {
        modelId: 'gpt-6.2-astra-remote',
        engine: 'codex',
        contextWindow: 64_000,
        capabilityProfile: makeProfile({ supportsVision: false }),
        state: 'disabled',
        placement: 'remote_pool',
      },
    ]

    const derived = deriveLogicalModelBindingsFromCatalog(entries)
    assert.equal(derived.length, 1)
    assert.equal(derived[0]!.enabled, true)
    assert.equal(derived[0]!.capabilities.contextWindow, 256_000)
    assert.equal(derived[0]!.capabilities.supportsVision, true)
  })
})

describe('syncLogicalModelPoolBindingsFromCatalog', () => {
  it('never resurrects disabled catalog models and preserves admin overrides unless overwriteAdminOverrides=true', async () => {
    const pool = new InMemoryBindingPool()
    // Pre-existing admin overrides:
    // 1. Admin disabled remote_pool binding and changed its priority to 25 (catalog is still active).
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra-remote',
      priority: 25,
      capabilities_json: {},
      enabled: false,
    })
    // 2. Previously enabled local_pool binding whose catalog entry is now disabled.
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 80,
      capabilities_json: {},
      enabled: true,
    })

    const entries: CatalogBindingSourceEntry[] = [
      {
        modelId: 'gpt-6.2-astra-remote',
        engine: 'codex',
        contextWindow: 256_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'remote_pool',
      },
      {
        modelId: 'gpt-6.2-astra',
        engine: 'codex',
        contextWindow: 256_000,
        capabilityProfile: makeProfile(),
        state: 'disabled',
        placement: 'local',
      },
      {
        modelId: 'claude-opus-5',
        engine: 'ccb',
        contextWindow: 200_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'local',
      },
      {
        modelId: 'staged-only',
        engine: 'ccb',
        capabilityProfile: makeProfile(),
        state: 'staged',
        placement: 'local',
      },
    ]

    // Default sync (overwriteAdminOverrides: false)
    const r1 = await syncLogicalModelPoolBindingsFromCatalog(pool, entries)
    assert.deepEqual(r1, { synced: 3, enabled: 1, disabled: 2, skipped: 1 })

    // Admin override on active remote_pool binding MUST be preserved (enabled=false, priority=25)
    const remoteRow = pool.rows.get(pool.key('gpt-6.2-astra', 'remote_pool', 'codex'))!
    assert.equal(remoteRow.enabled, false)
    assert.equal(remoteRow.priority, 25)
    assert.equal((remoteRow.capabilities_json as { contextWindow?: number }).contextWindow, 256_000)

    // Disabled catalog entry MUST force enabled=false (never resurrect)
    const localRow = pool.rows.get(pool.key('gpt-6.2-astra', 'local_pool', 'local-codex'))!
    assert.equal(localRow.enabled, false)
    assert.equal(localRow.priority, 80)

    // Brand new active entry inserted with defaults
    const newRow = pool.rows.get(pool.key('claude-opus-5', 'local_pool', 'local-cc'))!
    assert.equal(newRow.enabled, true)
    assert.equal(newRow.priority, DEFAULT_LOCAL_POOL_PRIORITY)

    // Explicit overwriteAdminOverrides: true resets active row to enabled=true, priority=50
    // while STILL keeping disabled catalog entry enabled=false!
    const r2 = await syncLogicalModelPoolBindingsFromCatalog(
      pool,
      async () => ({ entries }),
      { overwriteAdminOverrides: true },
    )
    assert.deepEqual(r2, { synced: 3, enabled: 2, disabled: 1, skipped: 1 })

    const remoteRowAfter = pool.rows.get(pool.key('gpt-6.2-astra', 'remote_pool', 'codex'))!
    assert.equal(remoteRowAfter.enabled, true)
    assert.equal(remoteRowAfter.priority, DEFAULT_REMOTE_POOL_PRIORITY)

    const localRowAfter = pool.rows.get(pool.key('gpt-6.2-astra', 'local_pool', 'local-codex'))!
    assert.equal(localRowAfter.enabled, false)
    assert.equal(localRowAfter.priority, DEFAULT_LOCAL_POOL_PRIORITY)
  })

  it('B7: preserves admin-overridden canonical_model_id on normal sync, refreshes actual target capabilities, disables when actual target goes offline, and resets only on overwriteAdminOverrides=true', async () => {
    const pool = new InMemoryBindingPool()
    // Admin overrode gpt-6.2-astra local_pool canonical_model_id to gpt-6.2-astra-alt
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra-alt',
      priority: 15,
      capabilities_json: { contextWindow: 100_000 },
      enabled: true,
    })
    // Admin created a custom logical model binding pointing to gpt-6.2-astra-alt
    pool.seed({
      logical_model_id: 'team-coding-default',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra-alt',
      priority: 20,
      capabilities_json: { contextWindow: 100_000 },
      enabled: true,
    })

    const activeEntries: CatalogBindingSourceEntry[] = [
      {
        modelId: 'gpt-6.2-astra',
        engine: 'codex',
        contextWindow: 128_000,
        capabilityProfile: makeProfile({ supportsVision: false }),
        state: 'active',
        placement: 'local',
      },
      {
        modelId: 'gpt-6.2-astra-alt',
        engine: 'codex',
        contextWindow: 512_000,
        capabilityProfile: makeProfile({ supportsVision: true }),
        state: 'active',
        placement: 'local',
      },
    ]

    // 1. Normal sync (simulating restart): keeps overridden canonical_model_id & priority,
    // refreshes capabilities from actual target gpt-6.2-astra-alt!
    await syncLogicalModelPoolBindingsFromCatalog(pool, activeEntries)
    const overriddenRow = pool.rows.get(pool.key('gpt-6.2-astra', 'local_pool', 'local-codex'))!
    assert.equal(overriddenRow.canonical_model_id, 'gpt-6.2-astra-alt')
    assert.equal(overriddenRow.priority, 15)
    assert.equal(overriddenRow.enabled, true)
    assert.equal((overriddenRow.capabilities_json as { contextWindow?: number }).contextWindow, 512_000)
    assert.equal((overriddenRow.capabilities_json as { supportsVision?: boolean }).supportsVision, true)

    const customRow = pool.rows.get(pool.key('team-coding-default', 'local_pool', 'local-codex'))!
    assert.equal(customRow.canonical_model_id, 'gpt-6.2-astra-alt')
    assert.equal(customRow.enabled, true)
    assert.equal((customRow.capabilities_json as { contextWindow?: number }).contextWindow, 512_000)

    // 2. Actual target gpt-6.2-astra-alt becomes disabled in catalog (while default gpt-6.2-astra is still active):
    // normal sync MUST force enabled=false on both overridden & custom rows, while preserving canonical_model_id & priority!
    const disabledAltEntries: CatalogBindingSourceEntry[] = [
      activeEntries[0]!,
      { ...activeEntries[1]!, state: 'disabled' },
    ]
    await syncLogicalModelPoolBindingsFromCatalog(pool, disabledAltEntries)
    const afterDisable = pool.rows.get(pool.key('gpt-6.2-astra', 'local_pool', 'local-codex'))!
    assert.equal(afterDisable.canonical_model_id, 'gpt-6.2-astra-alt')
    assert.equal(afterDisable.priority, 15)
    assert.equal(afterDisable.enabled, false)

    const customAfterDisable = pool.rows.get(
      pool.key('team-coding-default', 'local_pool', 'local-codex'),
    )!
    assert.equal(customAfterDisable.canonical_model_id, 'gpt-6.2-astra-alt')
    assert.equal(customAfterDisable.priority, 20)
    assert.equal(customAfterDisable.enabled, false)

    // 3. Explicit overwriteAdminOverrides=true resets derived row back to default canonical & priority & enabled=true
    await syncLogicalModelPoolBindingsFromCatalog(pool, disabledAltEntries, {
      overwriteAdminOverrides: true,
    })
    const afterOverwrite = pool.rows.get(pool.key('gpt-6.2-astra', 'local_pool', 'local-codex'))!
    assert.equal(afterOverwrite.canonical_model_id, 'gpt-6.2-astra')
    assert.equal(afterOverwrite.priority, DEFAULT_LOCAL_POOL_PRIORITY)
    assert.equal(afterOverwrite.enabled, true)
    assert.equal((afterOverwrite.capabilities_json as { contextWindow?: number }).contextWindow, 128_000)
  })

  it('B7 R2 concurrency: normal sync never re-enables concurrently disabled custom/overridden rows and CAS-guards canonical_model_id against concurrent PUT', async () => {
    const basePool = new InMemoryBindingPool()
    basePool.seed({
      logical_model_id: 'team-disabled-custom',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra-alt',
      priority: 20,
      capabilities_json: { contextWindow: 100_000 },
      enabled: true,
    })
    basePool.seed({
      logical_model_id: 'team-cas-custom',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra-alt',
      priority: 25,
      capabilities_json: { contextWindow: 100_000 },
      enabled: true,
    })

    // Simulate concurrent admin mutations happening right after sync's initial SELECT
    let racedOnce = false
    const racingPool: PgQueryable = {
      async query<R extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ): Promise<PgQueryResult<R>> {
        const res = await basePool.query<R>(sql, params)
        if (!racedOnce && sql.includes('FROM model_logical_pool_bindings')) {
          racedOnce = true
          // Replace rows with fresh objects (like PG MVCC) so SELECT's snapshot still sees pre-race state
          const k1 = basePool.key('team-disabled-custom', 'local_pool', 'local-codex')
          basePool.rows.set(k1, { ...basePool.rows.get(k1)!, enabled: false })
          const k2 = basePool.key('team-cas-custom', 'local_pool', 'local-codex')
          basePool.rows.set(k2, {
            ...basePool.rows.get(k2)!,
            canonical_model_id: 'gpt-6.2-astra',
            capabilities_json: { contextWindow: 999_000 },
          })
        }
        return res
      },
    }

    const entries: CatalogBindingSourceEntry[] = [
      {
        modelId: 'gpt-6.2-astra',
        engine: 'codex',
        contextWindow: 128_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'local',
      },
      {
        modelId: 'gpt-6.2-astra-alt',
        engine: 'codex',
        contextWindow: 512_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'local',
      },
    ]

    await syncLogicalModelPoolBindingsFromCatalog(racingPool, entries)

    const disabledRow = basePool.rows.get(basePool.key('team-disabled-custom', 'local_pool', 'local-codex'))!
    assert.equal(disabledRow.enabled, false, 'concurrent admin disable MUST NOT be overwritten back to true')
    assert.equal((disabledRow.capabilities_json as { contextWindow?: number }).contextWindow, 512_000)

    const casRow = basePool.rows.get(basePool.key('team-cas-custom', 'local_pool', 'local-codex'))!
    assert.equal(casRow.canonical_model_id, 'gpt-6.2-astra')
    assert.equal(
      (casRow.capabilities_json as { contextWindow?: number }).contextWindow,
      999_000,
      'stale UPDATE MUST skip row whose canonical_model_id changed concurrently',
    )
  })
})

describe('validateExecutableBindingTuple (B6)', () => {
  it('accepts valid local and remote tuples and rejects unsupported pool, engine, placement mismatch, and driver mismatch', () => {
    assert.deepEqual(
      validateExecutableBindingTuple({
        poolKind: 'local_pool',
        driverId: 'local-codex',
        catalogEntry: { engine: 'codex', placement: 'local' },
      }),
      {
        ok: true,
        poolKind: 'local_pool',
        authEngine: 'codex',
        expectedDriverId: 'local-codex',
      },
    )
    assert.deepEqual(
      validateExecutableBindingTuple({
        poolKind: 'remote_pool',
        driverId: 'cc',
        catalogEntry: { engine: 'ccb', placement: 'remote_pool' },
      }),
      {
        ok: true,
        poolKind: 'remote_pool',
        authEngine: 'ccb',
        expectedDriverId: 'cc',
      },
    )

    const boxRes = validateExecutableBindingTuple({
      poolKind: 'box_pool',
      driverId: 'codex',
      catalogEntry: { engine: 'codex', placement: 'local' },
    })
    assert.equal(boxRes.ok, false)
    if (!boxRes.ok) assert.equal(boxRes.code, 'MODEL_POOL_KIND_UNSUPPORTED')

    const engineRes = validateExecutableBindingTuple({
      poolKind: 'local_pool',
      driverId: 'local-unknown',
      catalogEntry: { engine: 'mystery', placement: 'local' },
    })
    assert.equal(engineRes.ok, false)
    if (!engineRes.ok) assert.equal(engineRes.code, 'MODEL_POOL_ENGINE_UNSUPPORTED')

    const placementRes = validateExecutableBindingTuple({
      poolKind: 'remote_pool',
      driverId: 'codex',
      catalogEntry: { engine: 'codex', placement: 'local' },
    })
    assert.equal(placementRes.ok, false)
    if (!placementRes.ok) assert.equal(placementRes.code, 'MODEL_POOL_PLACEMENT_MISMATCH')

    const driverRes = validateExecutableBindingTuple({
      poolKind: 'local_pool',
      driverId: 'codex',
      catalogEntry: { engine: 'codex', placement: 'local' },
    })
    assert.equal(driverRes.ok, false)
    if (!driverRes.ok) assert.equal(driverRes.code, 'MODEL_POOL_DRIVER_MISMATCH')
  })
})

describe('resolveSelfhostLogicalModelPoolTarget', () => {
  function makeCatalog(
    activeModels: readonly string[],
    aliases?: Readonly<Record<string, ModelExecutionDescriptor>>,
  ) {
    const map = new Map<string, ModelExecutionDescriptor>(
      activeModels.map((id) => [id, makeDescriptor(id)]),
    )
    if (aliases) {
      for (const [alias, desc] of Object.entries(aliases)) {
        map.set(alias, desc)
      }
    }
    return {
      resolve(id: string): ModelExecutionDescriptor | null {
        return map.get(id) ?? null
      },
    }
  }

  it('passes through unconfigured logical models to local_pool (100% backward compat)', async () => {
    const pool = new InMemoryBindingPool()
    const store = new PgLogicalModelBindingStore(pool)
    const res = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: makeCatalog(['gpt-6.2-astra']),
    })
    assert.deepEqual(res, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra',
      poolKind: 'local_pool',
      logicalModelId: 'gpt-6.2-astra',
      source: 'unconfigured_passthrough',
    })
  })

  it('B4: defaults to local-first priority (local=50 < remote=100) and falls through when higher priority is disallowed or absent in catalog', async () => {
    assert.equal(DEFAULT_LOCAL_POOL_PRIORITY, 50)
    assert.equal(DEFAULT_REMOTE_POOL_PRIORITY, 100)
    assert.ok(DEFAULT_LOCAL_POOL_PRIORITY < DEFAULT_REMOTE_POOL_PRIORITY)

    const pool = new InMemoryBindingPool()
    const store = new PgLogicalModelBindingStore(pool)
    await syncLogicalModelPoolBindingsFromCatalog(pool, [
      {
        modelId: 'gpt-6.2-astra-remote',
        engine: 'codex',
        contextWindow: 256_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'remote_pool',
      },
      {
        modelId: 'gpt-6.2-astra',
        engine: 'codex',
        contextWindow: 256_000,
        capabilityProfile: makeProfile(),
        state: 'active',
        placement: 'local',
      },
    ])

    // Both active & allowed -> picks local_pool (priority 50) by default
    const rLocalDefault = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: makeCatalog(['gpt-6.2-astra-remote', 'gpt-6.2-astra']),
    })
    assert.deepEqual(rLocalDefault, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra',
      poolKind: 'local_pool',
      driverId: 'local-codex',
      logicalModelId: 'gpt-6.2-astra',
      source: 'logical_pool_binding',
    })

    // User denied local model -> falls through to remote_pool (priority 100)
    const rRemoteFallback = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: makeCatalog(['gpt-6.2-astra-remote', 'gpt-6.2-astra']),
      isModelAllowed: (id) => id === 'gpt-6.2-astra-remote',
    })
    assert.deepEqual(rRemoteFallback, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra-remote',
      poolKind: 'remote_pool',
      driverId: 'codex',
      logicalModelId: 'gpt-6.2-astra',
      source: 'logical_pool_binding',
    })

    // Neither binding exists in active catalog -> fail-closed MODEL_POOL_BINDING_UNAVAILABLE
    const rUnavailable = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: makeCatalog([]),
    })
    assert.deepEqual(rUnavailable, { ok: false, code: 'MODEL_POOL_BINDING_UNAVAILABLE' })
  })

  it('B4: preserves activeSessionPoolKind stickiness across priority changes and flags poolTransitionRequired only when active pool is disabled', async () => {
    const pool = new InMemoryBindingPool()
    const store = new PgLogicalModelBindingStore(pool)
    const catalog = makeCatalog(['gpt-6.2-astra', 'gpt-6.2-astra-remote'])

    // Admin lowered remote priority to 10 (< local 50)
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra-remote',
      priority: 10,
      capabilities_json: {},
      enabled: true,
    })
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 50,
      capabilities_json: {},
      enabled: true,
    })

    // New session (no activeSessionPoolKind) picks remote (priority 10)
    const rNew = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: catalog,
    })
    assert.deepEqual(rNew, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra-remote',
      poolKind: 'remote_pool',
      driverId: 'codex',
      logicalModelId: 'gpt-6.2-astra',
      source: 'logical_pool_binding',
    })

    // Active local session stays sticky on local_pool even though remote has priority 10
    const rStickyLocal = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: catalog,
      activeSessionPoolKind: 'local_pool',
    })
    assert.deepEqual(rStickyLocal, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra',
      poolKind: 'local_pool',
      driverId: 'local-codex',
      logicalModelId: 'gpt-6.2-astra',
      source: 'sticky_session_pool_binding',
    })

    // Disable local_pool -> active local session must transition to remote_pool with explicit poolTransitionRequired
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 50,
      capabilities_json: {},
      enabled: false,
    })
    const rTransitionToRemote = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: catalog,
      activeSessionPoolKind: 'local_pool',
    })
    assert.deepEqual(rTransitionToRemote, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra-remote',
      poolKind: 'remote_pool',
      driverId: 'codex',
      logicalModelId: 'gpt-6.2-astra',
      source: 'logical_pool_binding',
      poolTransitionRequired: {
        fromPoolKind: 'local_pool',
        toPoolKind: 'remote_pool',
      },
    })

    // Reverse direction: restore local priority=50 < remote priority=100, both enabled
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 50,
      capabilities_json: {},
      enabled: true,
    })
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra-remote',
      priority: 100,
      capabilities_json: {},
      enabled: true,
    })

    // Active remote session stays sticky on remote_pool even though local has priority 50
    const rStickyRemote = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: catalog,
      activeSessionPoolKind: 'remote_pool',
    })
    assert.deepEqual(rStickyRemote, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra-remote',
      poolKind: 'remote_pool',
      driverId: 'codex',
      logicalModelId: 'gpt-6.2-astra',
      source: 'sticky_session_pool_binding',
    })

    // Disable remote_pool -> active remote session transitions to local_pool with poolTransitionRequired
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra-remote',
      priority: 100,
      capabilities_json: {},
      enabled: false,
    })
    const rTransitionToLocal = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: catalog,
      activeSessionPoolKind: 'remote_pool',
    })
    assert.deepEqual(rTransitionToLocal, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra',
      poolKind: 'local_pool',
      driverId: 'local-codex',
      logicalModelId: 'gpt-6.2-astra',
      source: 'logical_pool_binding',
      poolTransitionRequired: {
        fromPoolKind: 'remote_pool',
        toPoolKind: 'local_pool',
      },
    })
  })

  it('B6: skips invalid historical binding tuples (bad placement, wrong driver, box_pool) and fails closed when no legal tuple remains', async () => {
    const pool = new InMemoryBindingPool()
    const store = new PgLogicalModelBindingStore(pool)
    const catalog = makeCatalog(['gpt-6.2-astra', 'gpt-6.2-astra-remote'])

    // Bad row 1: remote_pool pointing to local canonical (placement mismatch)
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 5,
      capabilities_json: {},
      enabled: true,
    })
    // Bad row 2: local_pool with wrong driver_id ('codex' instead of 'local-codex')
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 10,
      capabilities_json: {},
      enabled: true,
    })
    // Bad row 3: unsupported box_pool
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'box_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 15,
      capabilities_json: {},
      enabled: true,
    })

    // Only bad rows exist -> MUST fail-closed MODEL_POOL_BINDING_UNAVAILABLE (never silently misroute!)
    const rAllBad = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: catalog,
    })
    assert.deepEqual(rAllBad, { ok: false, code: 'MODEL_POOL_BINDING_UNAVAILABLE' })

    // Add one valid lower-priority row -> skips all 3 bad rows and selects the valid one
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 50,
      capabilities_json: {},
      enabled: true,
    })
    const rFallbackValid = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: catalog,
    })
    assert.deepEqual(rFallbackValid, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra',
      poolKind: 'local_pool',
      driverId: 'local-codex',
      logicalModelId: 'gpt-6.2-astra',
      source: 'logical_pool_binding',
    })
  })

  it('B5: normalizes ordinary catalog aliases to canonical logical bindings (incl. N01 disabled) and resolves pure logical names', async () => {
    const pool = new InMemoryBindingPool()
    const store = new PgLogicalModelBindingStore(pool)
    const canonicalDesc = makeDescriptor('deepseek-v4-flash', { placement: 'local' })
    const remoteDesc = makeDescriptor('deepseek-v4-flash-remote', { placement: 'remote_pool' })
    const catalog = makeCatalog(['deepseek-v4-flash', 'deepseek-v4-flash-remote'], {
      'deepseek-chat': canonicalDesc,
    })

    // Seed an active remote binding under canonical logical name AND a stale disabled row under old alias
    pool.seed({
      logical_model_id: 'deepseek-chat',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'deepseek-v4-flash',
      priority: 50,
      capabilities_json: {},
      enabled: false,
    })
    pool.seed({
      logical_model_id: 'deepseek-v4-flash',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'deepseek-v4-flash-remote',
      priority: 40,
      capabilities_json: {},
      enabled: true,
    })

    // Alias 'deepseek-chat' normalizes to 'deepseek-v4-flash' and inherits its active remote binding
    const rAliasActive = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'deepseek-chat',
      bindingStore: store,
      catalogSnapshot: catalog,
    })
    assert.deepEqual(rAliasActive, {
      ok: true,
      canonicalModelId: 'deepseek-v4-flash-remote',
      poolKind: 'remote_pool',
      driverId: 'codex',
      logicalModelId: 'deepseek-v4-flash',
      source: 'logical_pool_binding',
    })

    // Disable canonical's binding -> alias MUST inherit N01 MODEL_POOL_BINDING_DISABLED!
    pool.seed({
      logical_model_id: 'deepseek-v4-flash',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'deepseek-v4-flash-remote',
      priority: 40,
      capabilities_json: {},
      enabled: false,
    })
    const rAliasDisabled = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'deepseek-chat',
      bindingStore: store,
      catalogSnapshot: catalog,
    })
    assert.deepEqual(rAliasDisabled, { ok: false, code: 'MODEL_POOL_BINDING_DISABLED' })

    // Pure logical name (not in catalog at all) resolves via bindingStore to active canonical
    pool.seed({
      logical_model_id: 'team-fast-lane',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'deepseek-v4-flash-remote',
      priority: 30,
      capabilities_json: {},
      enabled: true,
    })
    const rPureLogical = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'team-fast-lane',
      bindingStore: store,
      catalogSnapshot: catalog,
    })
    assert.deepEqual(rPureLogical, {
      ok: true,
      canonicalModelId: remoteDesc.canonicalModel,
      poolKind: 'remote_pool',
      driverId: 'codex',
      logicalModelId: 'team-fast-lane',
      source: 'logical_pool_binding',
    })
  })

  it('W1/B5: selectPeekBindingCandidate filters per-user permissions without mutating global cache and shares alias/tuple/stickiness rules', () => {
    const localBinding: LogicalModelPoolBinding = Object.freeze({
      logicalModelId: 'gpt-6.2-astra',
      poolKind: 'local_pool',
      driverId: 'local-codex',
      canonicalModelId: 'gpt-6.2-astra',
      priority: 50,
      capabilities: Object.freeze({
        logicalModel: 'gpt-6.2-astra',
        upstreamModelId: 'gpt-6.2-astra',
        supportsVision: true,
        supportedEfforts: Object.freeze(['medium'] as const),
        defaultEffort: 'medium',
        supportedServiceTiers: Object.freeze(['standard'] as const),
        supportsReadOnly: true,
        supportsConsultTurn: true,
        supportsHermeticNoTools: true,
        supportsSwarm: false,
        supportsAdaptiveThinking: true,
        contextWindow: 256_000,
      }),
      enabled: true,
    })
    const remoteBinding: LogicalModelPoolBinding = Object.freeze({
      ...localBinding,
      poolKind: 'remote_pool',
      driverId: 'codex',
      canonicalModelId: 'gpt-6.2-astra-remote',
      priority: 100,
    })
    const badTupleBinding: LogicalModelPoolBinding = Object.freeze({
      ...localBinding,
      poolKind: 'remote_pool',
      driverId: 'codex',
      canonicalModelId: 'gpt-6.2-astra',
      priority: 1,
    })

    const originalList = Object.freeze([badTupleBinding, localBinding, remoteBinding])
    const cache = new Map<string, readonly LogicalModelPoolBinding[]>([
      ['gpt-6.2-astra', originalList],
    ])
    const catalog = makeCatalog(['gpt-6.2-astra', 'gpt-6.2-astra-remote'], {
      'gpt-6.2-alias': makeDescriptor('gpt-6.2-astra'),
    })

    // User A only allowed remote -> gets remote, skips badTupleBinding (priority 1)
    const userA = selectPeekBindingCandidate({
      rawModelId: 'gpt-6.2-astra',
      cachedBindingsByLogical: cache,
      catalogSnapshot: catalog,
      isModelAllowed: (id) => id === 'gpt-6.2-astra-remote',
    })
    assert.equal(userA, 'gpt-6.2-astra-remote')

    // User B allowed both -> still gets local (global cache order untouched!)
    const userB = selectPeekBindingCandidate({
      rawModelId: 'gpt-6.2-alias',
      cachedBindingsByLogical: cache,
      catalogSnapshot: catalog,
    })
    assert.equal(userB, 'gpt-6.2-astra')
    assert.deepEqual(cache.get('gpt-6.2-astra'), originalList)

    // Active remote session sticks to remote
    const stickyRemote = selectPeekBindingCandidate({
      rawModelId: 'gpt-6.2-astra',
      cachedBindingsByLogical: cache,
      catalogSnapshot: catalog,
      activeSessionPoolKind: 'remote_pool',
    })
    assert.equal(stickyRemote, 'gpt-6.2-astra-remote')
  })

  it('enforces N01 fail-closed MODEL_POOL_BINDING_DISABLED when all configured bindings are disabled', async () => {
    const pool = new InMemoryBindingPool()
    const store = new PgLogicalModelBindingStore(pool)
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra-remote',
      priority: 50,
      capabilities_json: {},
      enabled: false,
    })
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 100,
      capabilities_json: {},
      enabled: false,
    })

    const res = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: makeCatalog(['gpt-6.2-astra', 'gpt-6.2-astra-remote']),
    })
    assert.deepEqual(res, { ok: false, code: 'MODEL_POOL_BINDING_DISABLED' })
  })

  it('handles legacy -remote alias: allows when unconfigured or enabled, fail-closed when remote_pool bindings are all disabled', async () => {
    const pool = new InMemoryBindingPool()
    const store = new PgLogicalModelBindingStore(pool)

    // Unconfigured -> allowed as legacy_remote_alias
    const rUnconfigured = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra-remote',
      bindingStore: store,
      catalogSnapshot: makeCatalog(['gpt-6.2-astra-remote']),
    })
    assert.deepEqual(rUnconfigured, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra-remote',
      poolKind: 'remote_pool',
      logicalModelId: 'gpt-6.2-astra',
      source: 'legacy_remote_alias',
    })

    // Local enabled, remote disabled -> -remote alias MUST fail-closed N01!
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'local_pool',
      driver_id: 'local-codex',
      canonical_model_id: 'gpt-6.2-astra',
      priority: 100,
      capabilities_json: {},
      enabled: true,
    })
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra-remote',
      priority: 50,
      capabilities_json: {},
      enabled: false,
    })

    const rDisabledRemote = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra-remote',
      bindingStore: store,
      catalogSnapshot: makeCatalog(['gpt-6.2-astra-remote', 'gpt-6.2-astra']),
    })
    assert.deepEqual(rDisabledRemote, { ok: false, code: 'MODEL_POOL_BINDING_DISABLED' })

    // Re-enable remote_pool binding -> allowed as legacy_remote_alias
    pool.seed({
      logical_model_id: 'gpt-6.2-astra',
      pool_kind: 'remote_pool',
      driver_id: 'codex',
      canonical_model_id: 'gpt-6.2-astra-remote',
      priority: 50,
      capabilities_json: {},
      enabled: true,
    })
    const rEnabledRemote = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra-remote',
      bindingStore: store,
      catalogSnapshot: makeCatalog(['gpt-6.2-astra-remote']),
    })
    assert.deepEqual(rEnabledRemote, {
      ok: true,
      canonicalModelId: 'gpt-6.2-astra-remote',
      poolKind: 'remote_pool',
      driverId: 'codex',
      logicalModelId: 'gpt-6.2-astra',
      source: 'legacy_remote_alias',
    })
  })

  it('fails closed with MODEL_POOL_BINDING_READ_FAILED when bindingStore throws', async () => {
    const pool = new InMemoryBindingPool()
    const store = new PgLogicalModelBindingStore(pool)

    pool.failNextRead = true
    const rLogical = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra',
      bindingStore: store,
      catalogSnapshot: makeCatalog(['gpt-6.2-astra']),
    })
    assert.deepEqual(rLogical, { ok: false, code: 'MODEL_POOL_BINDING_READ_FAILED' })

    pool.failNextRead = true
    const rLegacy = await resolveSelfhostLogicalModelPoolTarget({
      rawModelId: 'gpt-6.2-astra-remote',
      bindingStore: store,
      catalogSnapshot: makeCatalog(['gpt-6.2-astra-remote']),
    })
    assert.deepEqual(rLegacy, { ok: false, code: 'MODEL_POOL_BINDING_READ_FAILED' })
  })
})
