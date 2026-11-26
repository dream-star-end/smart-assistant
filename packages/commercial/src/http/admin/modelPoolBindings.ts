/**
 * OCV5-902 P0-2 — Admin HTTP API for `model_logical_pool_bindings`:
 *
 *   GET  /api/admin/pools/model-bindings       list all bindings (incl. disabled) + summary
 *   POST /api/admin/pools/model-bindings/sync  sync bindings from model_catalog (+ admin_audit)
 *   PUT  /api/admin/pools/model-bindings       upsert/update a single binding (+ active catalog guard + admin_audit)
 *
 * Auth boundary:
 *   `router.ts` runs the global `/api/admin/*` `requireAdminVerifyDb` gate before dispatch and
 *   attaches the verified `AuthedUser` via `setVerifiedAdminForRequest(req, admin)`.
 *   Handlers fail closed (401/403) if invoked directly without a verified admin principal.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  INFERENCE_POOL_KINDS,
  resolveLogicalModelId,
  type InferencePoolKind,
} from '@openclaude/protocol'
import { writeAdminAuditBestEffort } from '../../admin/audit.js'
import { parseCapabilityProfile } from '../../billing/modelCatalog.js'
import { peekModelCatalogCache } from '../../billing/modelCatalogRuntime.js'
import { getPool } from '../../db/index.js'
import type { PgQueryable } from '../../db/threeLayerStateStore.js'
import {
  DEFAULT_LOCAL_POOL_PRIORITY,
  DEFAULT_REMOTE_POOL_PRIORITY,
  deriveLogicalModelCapabilityFromCatalogEntry,
  loadCatalogBindingSourceEntriesFromDb,
  syncLogicalModelPoolBindingsFromCatalog,
  validateExecutableBindingTuple,
  type CatalogBindingSourceEntry,
} from '../../account-pool/remotePool/logicalModelBindingsSync.js'
import type { AuthedUser } from '../auth.js'
import type { CommercialHttpDeps, RequestContext } from '../handlers.js'
import { HttpError, readJsonBody, sendJson } from '../util.js'

const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
const DRIVER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const INFERENCE_POOL_SET: ReadonlySet<string> = new Set<string>(INFERENCE_POOL_KINDS)
const PRIORITY_MIN = 0
const PRIORITY_MAX = 10_000

const verifiedAdminByRequest = new WeakMap<IncomingMessage, AuthedUser>()

export function setVerifiedAdminForRequest(req: IncomingMessage, admin: AuthedUser): void {
  verifiedAdminByRequest.set(req, admin)
}

export function getVerifiedAdminForRequest(req: IncomingMessage): AuthedUser | null {
  return verifiedAdminByRequest.get(req) ?? null
}

function assertVerifiedAdmin(req: IncomingMessage): AuthedUser {
  const admin = verifiedAdminByRequest.get(req)
  if (!admin) {
    throw new HttpError(401, 'UNAUTHORIZED', 'admin authentication required')
  }
  if (admin.role !== 'admin') {
    throw new HttpError(403, 'FORBIDDEN', 'admin role required')
  }
  return admin
}

interface BindingDbRow extends Record<string, unknown> {
  binding_id: string | number
  logical_model_id: string
  pool_kind: string
  driver_id: string
  canonical_model_id: string
  priority: string | number
  capabilities_json: unknown
  enabled: boolean
  created_at?: unknown
  updated_at?: unknown
}

interface ActiveCatalogCheckRow extends Record<string, unknown> {
  model_id: string
  engine: string
  upstream_model_id: string | null
  context_window: number | null
  capability_profile: unknown
  state: string
  placement: string | null
  default_effort?: string | null
}

export interface ModelPoolBindingView {
  readonly binding_id: string
  readonly logical_model_id: string
  readonly pool_kind: InferencePoolKind
  readonly driver_id: string
  readonly canonical_model_id: string
  readonly priority: number
  readonly capabilities: unknown
  readonly enabled: boolean
  readonly created_at: string | null
  readonly updated_at: string | null
}

function toIsoOrNull(raw: unknown): string | null {
  if (raw instanceof Date) return raw.toISOString()
  if (typeof raw === 'string' && raw.length > 0) return raw
  return null
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
    return {}
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  return {}
}

function toBindingView(row: BindingDbRow): ModelPoolBindingView {
  return {
    binding_id: String(row.binding_id),
    logical_model_id: String(row.logical_model_id),
    pool_kind: row.pool_kind as InferencePoolKind,
    driver_id: String(row.driver_id),
    canonical_model_id: String(row.canonical_model_id),
    priority: Number(row.priority),
    capabilities: parseJsonObject(row.capabilities_json),
    enabled: Boolean(row.enabled),
    created_at: toIsoOrNull(row.created_at),
    updated_at: toIsoOrNull(row.updated_at),
  }
}

export interface ModelPoolBindingsHandlerDeps {
  readonly getPool?: () => PgQueryable
  readonly loadCatalogEntries?: (pool: PgQueryable) => Promise<readonly CatalogBindingSourceEntry[]>
  readonly writeAudit?: typeof writeAdminAuditBestEffort
}

async function defaultLoadCatalogEntries(
  pool: PgQueryable,
): Promise<readonly CatalogBindingSourceEntry[]> {
  const cache = peekModelCatalogCache()
  if (cache) {
    const snapshot = await cache.assertFresh()
    return snapshot.entries
  }
  return loadCatalogBindingSourceEntriesFromDb(pool)
}

export function createAdminModelPoolBindingsHandlers(overrides?: ModelPoolBindingsHandlerDeps) {
  const resolvePool = overrides?.getPool ?? (() => getPool())
  const loadEntries = overrides?.loadCatalogEntries ?? defaultLoadCatalogEntries
  const writeAudit = overrides?.writeAudit ?? writeAdminAuditBestEffort

  async function handleList(
    req: IncomingMessage,
    res: ServerResponse,
    _ctx: RequestContext,
    _deps: CommercialHttpDeps,
  ): Promise<void> {
    assertVerifiedAdmin(req)
    const pool = resolvePool()
    const result = await pool.query<BindingDbRow>(
      `SELECT binding_id::text AS binding_id,
              logical_model_id,
              pool_kind,
              driver_id,
              canonical_model_id,
              priority,
              capabilities_json,
              enabled,
              created_at,
              updated_at
         FROM model_logical_pool_bindings
        ORDER BY logical_model_id ASC, priority ASC, driver_id ASC`,
    )
    const bindings = result.rows.map(toBindingView)
    const enabledCount = bindings.filter((b) => b.enabled).length
    const logicalModels = new Set(bindings.map((b) => b.logical_model_id)).size
    sendJson(res, 200, {
      bindings,
      summary: {
        total: bindings.length,
        enabled: enabledCount,
        disabled: bindings.length - enabledCount,
        logical_models: logicalModels,
      },
    })
  }

  async function handleSync(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    _deps: CommercialHttpDeps,
  ): Promise<void> {
    const admin = assertVerifiedAdmin(req)
    const rawBody = await readJsonBody(req)
    let overwriteAdminOverrides = false
    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody !== 'object' || Array.isArray(rawBody)) {
        throw new HttpError(400, 'VALIDATION', 'request body must be a JSON object')
      }
      const bodyObj = rawBody as Record<string, unknown>
      if (
        bodyObj.overwrite_admin_overrides !== undefined &&
        typeof bodyObj.overwrite_admin_overrides !== 'boolean'
      ) {
        throw new HttpError(400, 'VALIDATION', 'overwrite_admin_overrides must be a boolean')
      }
      overwriteAdminOverrides = bodyObj.overwrite_admin_overrides === true
    }

    const pool = resolvePool()
    const stats = await syncLogicalModelPoolBindingsFromCatalog(
      pool,
      () => loadEntries(pool),
      { overwriteAdminOverrides },
    )

    await writeAudit(
      { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
      'model_pool_bindings.sync',
      'model_logical_pool_bindings:catalog_sync',
      null,
      {
        overwrite_admin_overrides: overwriteAdminOverrides,
        synced: stats.synced,
        enabled: stats.enabled,
        disabled: stats.disabled,
        skipped: stats.skipped,
      },
    )

    sendJson(res, 200, {
      ...stats,
      overwrite_admin_overrides: overwriteAdminOverrides,
    })
  }

  async function handlePut(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    _deps: CommercialHttpDeps,
  ): Promise<void> {
    const admin = assertVerifiedAdmin(req)
    const rawBody = await readJsonBody(req)
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      throw new HttpError(400, 'VALIDATION', 'request body must be a JSON object')
    }
    const body = rawBody as Record<string, unknown>

    const logicalModelId =
      typeof body.logical_model_id === 'string' ? body.logical_model_id.trim() : ''
    if (!MODEL_ID_RE.test(logicalModelId)) {
      throw new HttpError(400, 'VALIDATION', 'logical_model_id is required and must be a valid model id')
    }
    if (resolveLogicalModelId(logicalModelId).isLegacyRemoteAlias) {
      throw new HttpError(400, 'VALIDATION', 'logical_model_id must not end with -remote')
    }

    const poolKind = typeof body.pool_kind === 'string' ? body.pool_kind.trim() : ''
    if (!INFERENCE_POOL_SET.has(poolKind)) {
      throw new HttpError(400, 'VALIDATION', 'pool_kind must be local_pool, remote_pool, or box_pool')
    }
    if (poolKind === 'box_pool') {
      throw new HttpError(
        400,
        'MODEL_POOL_KIND_UNSUPPORTED',
        "pool_kind 'box_pool' is not supported in Wave 1",
      )
    }

    const driverId = typeof body.driver_id === 'string' ? body.driver_id.trim() : ''
    if (!DRIVER_ID_RE.test(driverId)) {
      throw new HttpError(400, 'VALIDATION', 'driver_id is required and must be a valid driver id')
    }

    let canonicalModelId: string | undefined
    if (body.canonical_model_id !== undefined) {
      if (typeof body.canonical_model_id !== 'string' || !MODEL_ID_RE.test(body.canonical_model_id.trim())) {
        throw new HttpError(400, 'VALIDATION', 'canonical_model_id must be a valid model id')
      }
      canonicalModelId = body.canonical_model_id.trim()
    }

    let priority: number | undefined
    if (body.priority !== undefined) {
      if (
        typeof body.priority !== 'number' ||
        !Number.isInteger(body.priority) ||
        body.priority < PRIORITY_MIN ||
        body.priority > PRIORITY_MAX
      ) {
        throw new HttpError(
          400,
          'VALIDATION',
          `priority must be an integer between ${PRIORITY_MIN} and ${PRIORITY_MAX}`,
        )
      }
      priority = body.priority
    }

    let enabled: boolean | undefined
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        throw new HttpError(400, 'VALIDATION', 'enabled must be a boolean')
      }
      enabled = body.enabled
    }

    if (canonicalModelId === undefined && priority === undefined && enabled === undefined) {
      throw new HttpError(
        400,
        'VALIDATION',
        'at least one of canonical_model_id, priority, or enabled must be provided',
      )
    }

    const pool = resolvePool()
    const existingRes = await pool.query<BindingDbRow>(
      `SELECT binding_id::text AS binding_id,
              logical_model_id,
              pool_kind,
              driver_id,
              canonical_model_id,
              priority,
              capabilities_json,
              enabled,
              created_at,
              updated_at
         FROM model_logical_pool_bindings
        WHERE logical_model_id = $1
          AND pool_kind = $2
          AND driver_id = $3
        LIMIT 1`,
      [logicalModelId, poolKind, driverId],
    )
    const existing = existingRes.rows[0] ?? null

    const targetCanonicalModelId = canonicalModelId ?? existing?.canonical_model_id ?? ''
    if (!targetCanonicalModelId) {
      throw new HttpError(
        400,
        'VALIDATION',
        'canonical_model_id is required when creating a new binding',
      )
    }
    const defaultPriority =
      poolKind === 'remote_pool' ? DEFAULT_REMOTE_POOL_PRIORITY : DEFAULT_LOCAL_POOL_PRIORITY
    const targetPriority = priority ?? (existing ? Number(existing.priority) : defaultPriority)
    const targetEnabled = enabled ?? (existing ? Boolean(existing.enabled) : true)

    let targetCapabilities: unknown = existing ? parseJsonObject(existing.capabilities_json) : {}

    // Security & executability invariants (B6):
    // 1. Validate `(pool_kind, driver_id, canonical_model_id)` against `model_catalog`
    //    (`state IN ('active', 'disabled')`) via `validateExecutableBindingTuple` for both
    //    enabled and disabled writes.
    // 2. Never allow enabling a binding whose `canonical_model_id` is not `active` in `model_catalog`.
    const catRes = await pool.query<ActiveCatalogCheckRow>(
      `SELECT mc.model_id,
              mc.engine,
              mc.upstream_model_id,
              mc.context_window,
              mc.capability_profile,
              mc.state,
              mc.placement,
              mp.default_effort
         FROM model_catalog mc
         LEFT JOIN model_pricing mp ON mp.model_id = mc.model_id
        WHERE mc.model_id = $1
          AND mc.state IN ('active', 'disabled')
        ORDER BY CASE WHEN mc.state = 'active' THEN 0 ELSE 1 END ASC,
                 mc.entry_id DESC
        LIMIT 1`,
      [targetCanonicalModelId],
    )
    const catalogRow = catRes.rows[0] ?? null
    if (!catalogRow) {
      if (targetEnabled || existing === null || canonicalModelId !== undefined) {
        throw new HttpError(
          400,
          'MODEL_NOT_ACTIVE_IN_CATALOG',
          `canonical_model_id '${targetCanonicalModelId}' is not active in model_catalog`,
        )
      }
    } else {
      const tupleCheck = validateExecutableBindingTuple({
        poolKind: poolKind as InferencePoolKind,
        driverId,
        catalogEntry: {
          engine: catalogRow.engine,
          placement: catalogRow.placement,
        },
      })
      if (!tupleCheck.ok) {
        throw new HttpError(400, tupleCheck.code, tupleCheck.message)
      }
      if (targetEnabled && catalogRow.state !== 'active') {
        throw new HttpError(
          400,
          'MODEL_NOT_ACTIVE_IN_CATALOG',
          `canonical_model_id '${targetCanonicalModelId}' is not active in model_catalog`,
        )
      }
      try {
        const profile = parseCapabilityProfile(catalogRow.model_id, catalogRow.capability_profile)
        targetCapabilities = deriveLogicalModelCapabilityFromCatalogEntry(
          logicalModelId,
          {
            modelId: catalogRow.model_id,
            engine: catalogRow.engine,
            upstreamModelId: catalogRow.upstream_model_id,
            contextWindow: catalogRow.context_window,
            capabilityProfile: profile,
            state: catalogRow.state,
            placement: catalogRow.placement === 'remote_pool' ? 'remote_pool' : 'local',
            defaultEffort: catalogRow.default_effort ?? null,
          },
          tupleCheck.authEngine,
        )
      } catch {
        // Preserve existing capabilities_json if catalog row has an unrecognized profile shape.
      }
    }

    const savedRes = await pool.query<BindingDbRow>(
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
       RETURNING binding_id::text AS binding_id,
                 logical_model_id,
                 pool_kind,
                 driver_id,
                 canonical_model_id,
                 priority,
                 capabilities_json,
                 enabled,
                 created_at,
                 updated_at`,
      [
        logicalModelId,
        poolKind,
        driverId,
        targetCanonicalModelId,
        targetPriority,
        JSON.stringify(targetCapabilities),
        targetEnabled,
      ],
    )

    const savedRow = savedRes.rows[0]
    if (!savedRow) {
      throw new HttpError(500, 'INTERNAL', 'failed to persist model pool binding')
    }
    const saved = toBindingView(savedRow)

    await writeAudit(
      { adminId: admin.id, ip: ctx.clientIp, userAgent: ctx.userAgent },
      'model_pool_bindings.put',
      `model_pool_binding:${logicalModelId}:${poolKind}:${driverId}`,
      existing
        ? {
            canonical_model_id: existing.canonical_model_id,
            priority: Number(existing.priority),
            enabled: Boolean(existing.enabled),
          }
        : null,
      {
        canonical_model_id: saved.canonical_model_id,
        priority: saved.priority,
        enabled: saved.enabled,
      },
    )

    sendJson(res, 200, { binding: saved, created: existing === null })
  }

  return {
    handleList,
    handleSync,
    handlePut,
  }
}

const defaultHandlers = createAdminModelPoolBindingsHandlers()

export const handleAdminModelPoolBindingsList = defaultHandlers.handleList
export const handleAdminModelPoolBindingsSync = defaultHandlers.handleSync
export const handleAdminModelPoolBindingPut = defaultHandlers.handlePut
