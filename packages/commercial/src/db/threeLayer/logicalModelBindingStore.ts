/**
 * OCV5-890 / OCV5-928 — `PgLogicalModelBindingStore` (`model_logical_pool_bindings`).
 *
 * Layer: platform-pg (L2, subdomain db-core rank 0).
 * Zero `process.env`; zero dynamic SQL interpolation; all functions <= 85L, CC <= 15.
 */
import {
  resolveLogicalModelId,
  type InferencePoolKind,
  type LogicalModelCapability,
  type LogicalModelPoolBinding,
} from '@openclaude/protocol'
import {
  DRIVER_ID_RE,
  INFERENCE_POOL_SET,
  MODEL_ID_RE,
  assertCondition,
  parseJsonValue,
  type InspectedModelPoolBindings,
  type PgQueryable,
  type ResolvedModelPoolBindings,
} from './types.js'

interface BindingRow extends Record<string, unknown> {
  logical_model_id: string
  pool_kind: string
  driver_id: string
  canonical_model_id: string
  priority: string | number
  capabilities_json: unknown
  enabled: boolean
}

function mapBindingRow(row: BindingRow): LogicalModelPoolBinding {
  const parsedCaps = parseJsonValue(row.capabilities_json)
  const capabilities = (
    parsedCaps && typeof parsedCaps === 'object' && !Array.isArray(parsedCaps)
      ? Object.freeze({ ...(parsedCaps as LogicalModelCapability) })
      : Object.freeze({
          logicalModel: String(row.logical_model_id),
          supportsVision: false,
          supportedEfforts: Object.freeze([]),
          defaultEffort: null,
          supportedServiceTiers: Object.freeze([]),
          supportsReadOnly: false,
          supportsConsultTurn: false,
          supportsHermeticNoTools: false,
          supportsSwarm: false,
        })
  ) as LogicalModelCapability

  return Object.freeze({
    logicalModelId: String(row.logical_model_id),
    poolKind: row.pool_kind as InferencePoolKind,
    driverId: String(row.driver_id),
    canonicalModelId: String(row.canonical_model_id),
    priority: Number(row.priority),
    capabilities,
    enabled: Boolean(row.enabled),
  })
}

export class PgLogicalModelBindingStore {
  private readonly pool: PgQueryable

  constructor(pool: PgQueryable) {
    this.pool = pool
  }

  async resolveBindingsForModel(rawModelId: string): Promise<ResolvedModelPoolBindings> {
    const resolved = resolveLogicalModelId(rawModelId)
    const res = resolved.isLegacyRemoteAlias
      ? await this.pool.query<BindingRow>(
          `SELECT logical_model_id, pool_kind, driver_id, canonical_model_id,
                  priority, capabilities_json, enabled
             FROM model_logical_pool_bindings
            WHERE logical_model_id = $1 AND enabled = TRUE AND pool_kind = 'remote_pool'
            ORDER BY priority ASC, driver_id ASC`,
          [resolved.logicalModel],
        )
      : await this.pool.query<BindingRow>(
          `SELECT logical_model_id, pool_kind, driver_id, canonical_model_id,
                  priority, capabilities_json, enabled
             FROM model_logical_pool_bindings
            WHERE logical_model_id = $1 AND enabled = TRUE
            ORDER BY priority ASC, driver_id ASC`,
          [resolved.logicalModel],
        )
    return Object.freeze({
      resolved,
      bindings: Object.freeze(res.rows.map(mapBindingRow)),
    })
  }

  /**
   * N01: Authoritative binding inspection distinguishing unconfigured, all-disabled, and read error.
   */
  async inspectLogicalModelBindings(rawModelId: string): Promise<InspectedModelPoolBindings> {
    const resolved = resolveLogicalModelId(rawModelId)
    const res = resolved.isLegacyRemoteAlias
      ? await this.pool.query<BindingRow>(
          `SELECT logical_model_id, pool_kind, driver_id, canonical_model_id,
                  priority, capabilities_json, enabled
             FROM model_logical_pool_bindings
            WHERE logical_model_id = $1 AND pool_kind = 'remote_pool'
            ORDER BY priority ASC, driver_id ASC`,
          [resolved.logicalModel],
        )
      : await this.pool.query<BindingRow>(
          `SELECT logical_model_id, pool_kind, driver_id, canonical_model_id,
                  priority, capabilities_json, enabled
             FROM model_logical_pool_bindings
            WHERE logical_model_id = $1
            ORDER BY priority ASC, driver_id ASC`,
          [resolved.logicalModel],
        )
    const allConfiguredBindings = Object.freeze(res.rows.map(mapBindingRow))
    const enabledBindings = Object.freeze(allConfiguredBindings.filter((b) => b.enabled))
    const totalCount = allConfiguredBindings.length
    return Object.freeze({
      status: totalCount === 0 ? ('unconfigured' as const) : ('configured' as const),
      resolved,
      bindings: enabledBindings,
      enabledBindings,
      allConfiguredBindings,
      totalCount,
      hasConfiguredBindings: totalCount > 0,
    })
  }

  async resolveBindingsStateForModel(rawModelId: string): Promise<InspectedModelPoolBindings> {
    return this.inspectLogicalModelBindings(rawModelId)
  }

  async upsertPoolBinding(binding: LogicalModelPoolBinding): Promise<LogicalModelPoolBinding> {
    assertCondition(
      typeof binding.logicalModelId === 'string' && MODEL_ID_RE.test(binding.logicalModelId),
      'MODEL_BINDING_LOGICAL_ID_INVALID',
    )
    assertCondition(INFERENCE_POOL_SET.has(binding.poolKind), 'MODEL_BINDING_POOL_KIND_INVALID')
    assertCondition(
      typeof binding.driverId === 'string' && DRIVER_ID_RE.test(binding.driverId),
      'MODEL_BINDING_DRIVER_ID_INVALID',
    )
    assertCondition(
      typeof binding.canonicalModelId === 'string' && MODEL_ID_RE.test(binding.canonicalModelId),
      'MODEL_BINDING_CANONICAL_ID_INVALID',
    )
    assertCondition(
      typeof binding.priority === 'number' && Number.isSafeInteger(binding.priority),
      'MODEL_BINDING_PRIORITY_INVALID',
    )

    const res = await this.pool.query<BindingRow>(
      `INSERT INTO model_logical_pool_bindings (
         logical_model_id, pool_kind, driver_id, canonical_model_id,
         priority, capabilities_json, enabled
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (logical_model_id, pool_kind, driver_id) DO UPDATE SET
         canonical_model_id = EXCLUDED.canonical_model_id,
         priority = EXCLUDED.priority,
         capabilities_json = EXCLUDED.capabilities_json,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()
       RETURNING logical_model_id, pool_kind, driver_id, canonical_model_id,
                 priority, capabilities_json, enabled`,
      [
        binding.logicalModelId,
        binding.poolKind,
        binding.driverId,
        binding.canonicalModelId,
        binding.priority,
        JSON.stringify(binding.capabilities),
        binding.enabled,
      ],
    )
    return mapBindingRow(res.rows[0]!)
  }

  async setPoolBindingEnabled(
    logicalModelId: string,
    poolKind: InferencePoolKind,
    driverId: string,
    enabled: boolean,
  ): Promise<boolean> {
    assertCondition(MODEL_ID_RE.test(logicalModelId), 'MODEL_BINDING_LOGICAL_ID_INVALID')
    assertCondition(INFERENCE_POOL_SET.has(poolKind), 'MODEL_BINDING_POOL_KIND_INVALID')
    assertCondition(DRIVER_ID_RE.test(driverId), 'MODEL_BINDING_DRIVER_ID_INVALID')

    const res = await this.pool.query<{ binding_id: string | number }>(
      `UPDATE model_logical_pool_bindings
          SET enabled = $4,
              updated_at = NOW()
        WHERE logical_model_id = $1
          AND pool_kind = $2
          AND driver_id = $3
        RETURNING binding_id`,
      [logicalModelId, poolKind, driverId, enabled],
    )
    return res.rows.length > 0
  }

  async listAllEnabledBindings(): Promise<readonly LogicalModelPoolBinding[]> {
    const res = await this.pool.query<BindingRow>(
      `SELECT logical_model_id, pool_kind, driver_id, canonical_model_id,
              priority, capabilities_json, enabled
         FROM model_logical_pool_bindings
        WHERE enabled = TRUE
        ORDER BY logical_model_id ASC, priority ASC, driver_id ASC`,
    )
    return Object.freeze(res.rows.map(mapBindingRow))
  }
}
