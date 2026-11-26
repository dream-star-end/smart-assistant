/**
 * OCV5-902 P0-2 — Logical Model <-> Execution Pool Binding Synchronization & Resolution.
 *
 * Bridges authoritative `model_catalog` entries into `model_logical_pool_bindings` and
 * provides pure read-side resolution for selfhost V5 logical model selection:
 * - `validateExecutableBindingTuple`: single authoritative physical tuple validator
 *   for `(pool_kind, driver_id, canonical_model_id)`
 * - `deriveLogicalModelBindingsFromCatalog`: pure derivation from active/disabled catalog entries
 * - `loadCatalogBindingSourceEntriesFromDb`: reads active/disabled catalog rows from PG
 * - `syncLogicalModelPoolBindingsFromCatalog`: idempotent sync preserving admin overrides
 *   (including custom `canonical_model_id` & `priority`) while re-validating actual targets
 *   and unconditionally forcing `enabled = FALSE` for disabled/invalid catalog rows
 * - `resolveSelfhostLogicalModelPoolTarget`: fail-closed N01 logical-model -> pool/canonical resolver
 *   with catalog alias normalization, physical tuple validation, and active-session pool stickiness
 * - `selectPeekBindingCandidate`: synchronous side-effect-free peek helper sharing the same logic
 *
 * Module: accounts (L3, allow: identity, catalog).
 * Invariants: zero `process.env`, zero network I/O, zero `node:crypto`,
 * zero engine/provider literal comparisons (table-driven via `Record<AuthorityEngineKind, ...>`),
 * zero billing SQL.
 */
import {
  AUTHORITY_ENGINE_KINDS,
  INFERENCE_SERVICE_TIERS,
  PLATFORM_REASONING_EFFORTS,
  resolveLogicalModelId,
  type AuthorityEngineKind,
  type InferenceEngineFamily,
  type InferencePoolKind,
  type InferenceServiceTier,
  type LogicalModelCapability,
  type LogicalModelPoolBinding,
  type PlatformReasoningEffort,
} from '@openclaude/protocol'
import {
  parseCapabilityProfile,
  type ModelCapabilityProfile,
  type ModelCatalogState,
  type ModelExecutionDescriptor,
  type ModelPlacement,
} from '../../billing/modelCatalog.js'
import type { PgLogicalModelBindingStore, PgQueryable } from '../../db/threeLayerStateStore.js'

export const DEFAULT_LOCAL_POOL_PRIORITY = 50
export const DEFAULT_REMOTE_POOL_PRIORITY = 100

export type ExecutableInferencePoolKind = 'local_pool' | 'remote_pool'

export type BindingTupleValidationFailureCode =
  | 'MODEL_POOL_KIND_UNSUPPORTED'
  | 'MODEL_POOL_ENGINE_UNSUPPORTED'
  | 'MODEL_POOL_PLACEMENT_MISMATCH'
  | 'MODEL_POOL_DRIVER_MISMATCH'

export interface ValidateExecutableBindingTupleInput {
  readonly poolKind: InferencePoolKind
  readonly driverId: string
  readonly catalogEntry: {
    readonly engine: string
    readonly placement?: string | null
  }
}

export type ValidateExecutableBindingTupleResult =
  | {
      readonly ok: true
      readonly poolKind: ExecutableInferencePoolKind
      readonly authEngine: AuthorityEngineKind
      readonly expectedDriverId: string
    }
  | {
      readonly ok: false
      readonly code: BindingTupleValidationFailureCode
      readonly message: string
    }

export interface PoolTransitionRequirement {
  readonly fromPoolKind: ExecutableInferencePoolKind
  readonly toPoolKind: ExecutableInferencePoolKind
}

const AUTHORITY_ENGINE_SET: ReadonlySet<string> = new Set<string>(AUTHORITY_ENGINE_KINDS)
const VALID_SERVICE_TIER_SET: ReadonlySet<string> = new Set<string>(INFERENCE_SERVICE_TIERS)
const VALID_EFFORT_SET: ReadonlySet<string> = new Set<string>(PLATFORM_REASONING_EFFORTS)

/**
 * Authoritative mapping from `AuthorityEngineKind` to `InferenceEngineFamily`.
 * Matches `selfhostCrossPoolSelector.ts` (`cc`/`local-cc`, `codex`/`local-codex`, etc.).
 */
export const ENGINE_FAMILY_BY_AUTHORITY: Readonly<
  Record<AuthorityEngineKind, InferenceEngineFamily>
> = Object.freeze({
  ccb: 'cc',
  codex: 'codex',
  antigravity: 'antigravity',
  grok: 'grok',
  cursor: 'cursor',
  zcode: 'zcode',
})

const READ_ONLY_SUPPORT_BY_ENGINE: Readonly<Record<AuthorityEngineKind, boolean>> = Object.freeze({
  ccb: true,
  codex: true,
  antigravity: true,
  grok: false,
  cursor: false,
  zcode: false,
})

const SWARM_SUPPORT_BY_ENGINE: Readonly<Record<AuthorityEngineKind, boolean>> = Object.freeze({
  ccb: true,
  codex: false,
  antigravity: false,
  grok: false,
  cursor: false,
  zcode: false,
})

export interface CatalogBindingSourceEntry {
  readonly modelId: string
  readonly engine: string
  readonly upstreamModelId?: string | null
  readonly contextWindow?: number | null
  readonly capabilityProfile: ModelCapabilityProfile
  readonly state: ModelCatalogState | string
  readonly placement?: ModelPlacement | null
  readonly defaultEffort?: PlatformReasoningEffort | string | null
}

export interface DeriveLogicalModelBindingsOptions {
  readonly defaultRemotePriority?: number
  readonly defaultLocalPriority?: number
}

export interface SyncLogicalModelBindingsOptions extends DeriveLogicalModelBindingsOptions {
  readonly overwriteAdminOverrides?: boolean
}

export interface SyncLogicalModelBindingsResult {
  readonly synced: number
  readonly enabled: number
  readonly disabled: number
  readonly skipped: number
}

export type CatalogBindingSourceInput =
  | readonly CatalogBindingSourceEntry[]
  | { readonly entries: readonly CatalogBindingSourceEntry[] }
  | (() => Promise<
      | readonly CatalogBindingSourceEntry[]
      | { readonly entries: readonly CatalogBindingSourceEntry[] }
    >)

export type SelfhostLogicalModelResolutionFailureCode =
  | 'MODEL_POOL_BINDING_DISABLED'
  | 'MODEL_POOL_BINDING_UNAVAILABLE'
  | 'MODEL_POOL_BINDING_READ_FAILED'

export type ResolveSelfhostLogicalModelPoolTargetResult =
  | {
      readonly ok: true
      readonly canonicalModelId: string
      readonly poolKind: InferencePoolKind
      readonly driverId?: string
      readonly logicalModelId: string
      readonly source:
        | 'legacy_remote_alias'
        | 'unconfigured_passthrough'
        | 'logical_pool_binding'
        | 'sticky_session_pool_binding'
      readonly poolTransitionRequired?: PoolTransitionRequirement
    }
  | {
      readonly ok: false
      readonly code: SelfhostLogicalModelResolutionFailureCode
    }

export interface ResolveSelfhostLogicalModelPoolTargetInput {
  readonly rawModelId: string
  readonly bindingStore: Pick<PgLogicalModelBindingStore, 'inspectLogicalModelBindings'>
  readonly catalogSnapshot: {
    resolve(id: string): ModelExecutionDescriptor | null
  }
  readonly isModelAllowed?: (canonicalModel: string) => boolean
  readonly activeSessionPoolKind?: ExecutableInferencePoolKind | null
}

export interface SelectPeekBindingCandidateInput {
  readonly rawModelId: string
  readonly cachedBindingsByLogical: ReadonlyMap<string, readonly LogicalModelPoolBinding[]>
  readonly catalogSnapshot?: {
    resolve(id: string): ModelExecutionDescriptor | null
  } | null
  readonly isModelAllowed?: (canonicalModel: string) => boolean
  readonly activeSessionPoolKind?: ExecutableInferencePoolKind | null
}

function isAuthorityEngine(value: string): value is AuthorityEngineKind {
  return AUTHORITY_ENGINE_SET.has(value)
}

function resolvePriority(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value
  }
  return fallback
}

function normalizeEffort(value: unknown): PlatformReasoningEffort | null {
  if (typeof value === 'string' && VALID_EFFORT_SET.has(value)) {
    return value as PlatformReasoningEffort
  }
  return null
}

function extractSupportedServiceTiers(profile: ModelCapabilityProfile): InferenceServiceTier[] {
  const tiers = new Set<InferenceServiceTier>(['standard'])
  const remoteCap = profile.remote
  if (remoteCap?.supports_fast === true) {
    tiers.add('fast')
  }
  for (const rawTier of remoteCap?.service_tiers ?? []) {
    if (VALID_SERVICE_TIER_SET.has(rawTier)) {
      tiers.add(rawTier as InferenceServiceTier)
    }
  }
  return [...tiers]
}

export function deriveLogicalModelCapabilityFromCatalogEntry(
  logicalModel: string,
  entry: CatalogBindingSourceEntry,
  authEngine: AuthorityEngineKind,
): LogicalModelCapability {
  const supportedEfforts = entry.capabilityProfile.reasoning.supported.filter((e) =>
    VALID_EFFORT_SET.has(e),
  )
  const defaultEffort =
    normalizeEffort(entry.defaultEffort) ??
    normalizeEffort(entry.capabilityProfile.reasoning.codexModelDefault)
  const readOnly = READ_ONLY_SUPPORT_BY_ENGINE[authEngine]
  return Object.freeze({
    logicalModel,
    upstreamModelId: entry.upstreamModelId ?? entry.modelId,
    supportsVision: entry.capabilityProfile.supportsVision === true,
    supportedEfforts: Object.freeze([...supportedEfforts]),
    defaultEffort,
    supportedServiceTiers: Object.freeze(extractSupportedServiceTiers(entry.capabilityProfile)),
    supportsReadOnly: readOnly,
    supportsConsultTurn: readOnly,
    supportsHermeticNoTools: readOnly,
    supportsSwarm: SWARM_SUPPORT_BY_ENGINE[authEngine],
    supportsAdaptiveThinking: entry.capabilityProfile.ccb.supportsThinking === true,
    contextWindow: entry.contextWindow ?? null,
  })
}

export function resolveBindingDriverIdForEngine(
  authEngine: AuthorityEngineKind,
  poolKind: 'remote_pool' | 'local_pool',
): string {
  const family = ENGINE_FAMILY_BY_AUTHORITY[authEngine]
  return poolKind === 'remote_pool' ? family : `local-${family}`
}

/**
 * Single authoritative physical tuple validator for `(pool_kind, driver_id, canonical_model_id)`.
 *
 * Enforces Wave 1 executability invariants on both control-plane PUT and data-plane resolution:
 * - Rejects unsupported pools (including `box_pool`) with `MODEL_POOL_KIND_UNSUPPORTED`.
 * - Rejects non-authority engines with `MODEL_POOL_ENGINE_UNSUPPORTED`.
 * - Enforces exact placement match (`remote_pool` <-> `placement === 'remote_pool'`,
 *   `local_pool` <-> `placement !== 'remote_pool'`) with `MODEL_POOL_PLACEMENT_MISMATCH`.
 * - Enforces exact driver id (`resolveBindingDriverIdForEngine`) with `MODEL_POOL_DRIVER_MISMATCH`.
 */
export function validateExecutableBindingTuple(
  input: ValidateExecutableBindingTupleInput,
): ValidateExecutableBindingTupleResult {
  if (input.poolKind !== 'local_pool' && input.poolKind !== 'remote_pool') {
    return Object.freeze({
      ok: false as const,
      code: 'MODEL_POOL_KIND_UNSUPPORTED' as const,
      message: `pool_kind '${String(input.poolKind)}' is not supported in Wave 1`,
    })
  }
  const engine = input.catalogEntry.engine
  if (!isAuthorityEngine(engine)) {
    return Object.freeze({
      ok: false as const,
      code: 'MODEL_POOL_ENGINE_UNSUPPORTED' as const,
      message: `catalog engine '${String(engine)}' is not supported for pool bindings`,
    })
  }
  const isRemotePlacement = input.catalogEntry.placement === 'remote_pool'
  if (
    (input.poolKind === 'remote_pool' && !isRemotePlacement) ||
    (input.poolKind === 'local_pool' && isRemotePlacement)
  ) {
    return Object.freeze({
      ok: false as const,
      code: 'MODEL_POOL_PLACEMENT_MISMATCH' as const,
      message: `pool_kind '${input.poolKind}' does not match catalog placement '${input.catalogEntry.placement ?? 'local'}'`,
    })
  }
  const expectedDriverId = resolveBindingDriverIdForEngine(engine, input.poolKind)
  if (input.driverId !== expectedDriverId) {
    return Object.freeze({
      ok: false as const,
      code: 'MODEL_POOL_DRIVER_MISMATCH' as const,
      message: `driver_id '${input.driverId}' does not match expected driver '${expectedDriverId}' for engine '${engine}' and pool_kind '${input.poolKind}'`,
    })
  }
  return Object.freeze({
    ok: true as const,
    poolKind: input.poolKind,
    authEngine: engine,
    expectedDriverId,
  })
}

/**
 * Pure derivation of `LogicalModelPoolBinding` rows from `model_catalog` entries.
 *
 * - Processes ONLY `state === 'active' || state === 'disabled'` with `engine` in `AUTHORITY_ENGINE_KINDS`.
 * - Skips `staged`, `retired`, unknown engines, and malformed model ids.
 * - Deduplicates on `(logicalModelId, poolKind, driverId)` preferring `active` over `disabled`.
 */
export function deriveLogicalModelBindingsFromCatalog(
  entries: readonly CatalogBindingSourceEntry[],
  opts?: DeriveLogicalModelBindingsOptions,
): readonly LogicalModelPoolBinding[] {
  const remotePriority = resolvePriority(opts?.defaultRemotePriority, DEFAULT_REMOTE_POOL_PRIORITY)
  const localPriority = resolvePriority(opts?.defaultLocalPriority, DEFAULT_LOCAL_POOL_PRIORITY)
  const deduped = new Map<string, LogicalModelPoolBinding>()

  for (const entry of entries) {
    if (entry.state !== 'active' && entry.state !== 'disabled') {
      continue
    }
    if (!isAuthorityEngine(entry.engine)) {
      continue
    }
    let logicalModelId: string
    try {
      logicalModelId = resolveLogicalModelId(entry.modelId).logicalModel
    } catch {
      continue
    }
    const poolKind: 'remote_pool' | 'local_pool' =
      entry.placement === 'remote_pool' ? 'remote_pool' : 'local_pool'
    const driverId = resolveBindingDriverIdForEngine(entry.engine, poolKind)
    const priority = poolKind === 'remote_pool' ? remotePriority : localPriority
    const enabled = entry.state === 'active'
    const capabilities = deriveLogicalModelCapabilityFromCatalogEntry(
      logicalModelId,
      entry,
      entry.engine,
    )
    const candidate: LogicalModelPoolBinding = Object.freeze({
      logicalModelId,
      poolKind,
      driverId,
      canonicalModelId: entry.modelId.trim(),
      priority,
      capabilities,
      enabled,
    })

    const key = `${logicalModelId}\u0000${poolKind}\u0000${driverId}`
    const existing = deduped.get(key)
    if (!existing) {
      deduped.set(key, candidate)
    } else if (!existing.enabled && candidate.enabled) {
      // Active entry always supersedes disabled entry for the same binding key.
      deduped.set(key, candidate)
    }
  }

  return Object.freeze(
    [...deduped.values()].sort(
      (a, b) =>
        a.logicalModelId.localeCompare(b.logicalModelId) ||
        a.priority - b.priority ||
        a.driverId.localeCompare(b.driverId),
    ),
  )
}

interface CatalogDbRow extends Record<string, unknown> {
  model_id: string
  engine: string
  upstream_model_id: string | null
  context_window: number | null
  capability_profile: unknown
  state: string
  placement: string | null
  default_effort: string | null
}

/**
 * Loads `active` and `disabled` catalog entries directly from PostgreSQL for binding sync.
 */
export async function loadCatalogBindingSourceEntriesFromDb(
  pool: PgQueryable,
): Promise<readonly CatalogBindingSourceEntry[]> {
  const res = await pool.query<CatalogDbRow>(
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
      WHERE mc.state IN ('active', 'disabled')
      ORDER BY mc.model_id ASC, mc.entry_id DESC`,
  )
  const out: CatalogBindingSourceEntry[] = []
  for (const row of res.rows) {
    let capabilityProfile: ModelCapabilityProfile
    try {
      capabilityProfile = parseCapabilityProfile(row.model_id, row.capability_profile)
    } catch {
      continue
    }
    out.push({
      modelId: row.model_id,
      engine: row.engine,
      upstreamModelId: row.upstream_model_id,
      contextWindow: row.context_window,
      capabilityProfile,
      state: row.state,
      placement: row.placement === 'remote_pool' ? 'remote_pool' : 'local',
      defaultEffort: row.default_effort,
    })
  }
  return Object.freeze(out)
}

async function resolveCatalogEntriesInput(
  input: CatalogBindingSourceInput,
): Promise<readonly CatalogBindingSourceEntry[]> {
  const loaded = typeof input === 'function' ? await input() : input
  if (Array.isArray(loaded)) {
    return loaded
  }
  return (loaded as { readonly entries: readonly CatalogBindingSourceEntry[] }).entries
}

interface ExistingBindingDbRow extends Record<string, unknown> {
  logical_model_id: string
  pool_kind: string
  driver_id: string
  canonical_model_id: string
  priority: string | number
  capabilities_json: unknown
  enabled: boolean
}

const SELECT_EXISTING_BINDINGS_SQL = `
SELECT logical_model_id,
       pool_kind,
       driver_id,
       canonical_model_id,
       priority,
       capabilities_json,
       enabled
  FROM model_logical_pool_bindings`

const UPSERT_PRESERVE_ADMIN_OVERRIDES_SQL = `
INSERT INTO model_logical_pool_bindings (
  logical_model_id, pool_kind, driver_id, canonical_model_id,
  priority, capabilities_json, enabled
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
ON CONFLICT (logical_model_id, pool_kind, driver_id) DO UPDATE SET
  capabilities_json = CASE
    WHEN model_logical_pool_bindings.canonical_model_id = EXCLUDED.canonical_model_id
    THEN EXCLUDED.capabilities_json
    ELSE model_logical_pool_bindings.capabilities_json
  END,
  enabled = CASE
    WHEN model_logical_pool_bindings.canonical_model_id = EXCLUDED.canonical_model_id
         AND EXCLUDED.enabled = FALSE
    THEN FALSE
    ELSE model_logical_pool_bindings.enabled
  END,
  updated_at = NOW()
RETURNING enabled`

const UPDATE_EXISTING_PRESERVE_TARGET_SQL = `
UPDATE model_logical_pool_bindings
   SET capabilities_json = $4::jsonb,
       enabled = CASE WHEN $5 = FALSE THEN FALSE ELSE enabled END,
       updated_at = NOW()
 WHERE logical_model_id = $1
   AND pool_kind = $2
   AND driver_id = $3
   AND canonical_model_id = $6
RETURNING enabled`

const UPSERT_OVERWRITE_ADMIN_OVERRIDES_SQL = `
INSERT INTO model_logical_pool_bindings (
  logical_model_id, pool_kind, driver_id, canonical_model_id,
  priority, capabilities_json, enabled
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
ON CONFLICT (logical_model_id, pool_kind, driver_id) DO UPDATE SET
  canonical_model_id = EXCLUDED.canonical_model_id,
  priority = EXCLUDED.priority,
  capabilities_json = EXCLUDED.capabilities_json,
  enabled = EXCLUDED.enabled,
  updated_at = NOW()
RETURNING enabled`

function bindingTupleKey(logicalModelId: string, poolKind: string, driverId: string): string {
  return `${logicalModelId}\u0000${poolKind}\u0000${driverId}`
}

function serializeCapabilitiesJson(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify(parsed)
      }
    } catch {
      return '{}'
    }
    return '{}'
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return JSON.stringify(raw)
  }
  return '{}'
}

function indexCatalogEntriesByModelId(
  rawEntries: readonly CatalogBindingSourceEntry[],
): Map<string, CatalogBindingSourceEntry> {
  const index = new Map<string, CatalogBindingSourceEntry>()
  for (const entry of rawEntries) {
    if (entry.state !== 'active' && entry.state !== 'disabled') {
      continue
    }
    const modelId = entry.modelId.trim()
    if (!modelId) continue
    const prev = index.get(modelId)
    if (!prev || (prev.state !== 'active' && entry.state === 'active')) {
      index.set(modelId, entry)
    }
  }
  return index
}

function evaluateExistingBindingAgainstCatalog(
  existing: ExistingBindingDbRow,
  catalogByModelId: ReadonlyMap<string, CatalogBindingSourceEntry>,
): {
  readonly nextCapabilitiesJson: string
  readonly nextEnabled: boolean
  readonly isActiveAndValid: boolean
} {
  const actualEntry = catalogByModelId.get(String(existing.canonical_model_id).trim())
  const tupleCheck = actualEntry
    ? validateExecutableBindingTuple({
        poolKind: existing.pool_kind as InferencePoolKind,
        driverId: String(existing.driver_id),
        catalogEntry: {
          engine: actualEntry.engine,
          placement: actualEntry.placement,
        },
      })
    : null
  const isActiveAndValid = Boolean(actualEntry && actualEntry.state === 'active' && tupleCheck?.ok)
  const nextCapabilitiesJson =
    actualEntry && tupleCheck?.ok
      ? JSON.stringify(
          deriveLogicalModelCapabilityFromCatalogEntry(
            String(existing.logical_model_id),
            actualEntry,
            tupleCheck.authEngine,
          ),
        )
      : serializeCapabilitiesJson(existing.capabilities_json)
  const nextEnabled = isActiveAndValid ? Boolean(existing.enabled) : false
  return { nextCapabilitiesJson, nextEnabled, isActiveAndValid }
}

/**
 * Idempotently syncs `model_catalog` entries into `model_logical_pool_bindings`.
 *
 * Security invariants:
 * 1. Never resurrects disabled/invalid catalog models: `state !== 'active'` or tuple mismatch
 *    ALWAYS forces `enabled = FALSE` (for derived rows, overridden rows, and custom logical rows).
 * 2. Preserves admin overrides when `overwriteAdminOverrides !== true`:
 *    - Existing rows keep `canonical_model_id` and `priority`;
 *    - Capabilities and `enabled` are re-validated against the row's ACTUAL `canonical_model_id`
 *      in `model_catalog` and `validateExecutableBindingTuple`.
 * 3. Only `overwriteAdminOverrides === true` resets `canonical_model_id`, `priority`, `enabled`,
 *    and `capabilities_json` back to derived defaults.
 */
export async function syncLogicalModelPoolBindingsFromCatalog(
  pool: PgQueryable,
  catalogEntriesOrLoader: CatalogBindingSourceInput,
  opts?: SyncLogicalModelBindingsOptions,
): Promise<SyncLogicalModelBindingsResult> {
  const rawEntries = await resolveCatalogEntriesInput(catalogEntriesOrLoader)
  const derived = deriveLogicalModelBindingsFromCatalog(rawEntries, opts)
  const skipped = Math.max(0, rawEntries.length - derived.length)
  const overwrite = opts?.overwriteAdminOverrides === true
  const catalogByModelId = indexCatalogEntriesByModelId(rawEntries)

  const existingRes = await pool.query<ExistingBindingDbRow>(SELECT_EXISTING_BINDINGS_SQL)
  const existingByKey = new Map<string, ExistingBindingDbRow>()
  for (const row of existingRes.rows) {
    existingByKey.set(
      bindingTupleKey(String(row.logical_model_id), String(row.pool_kind), String(row.driver_id)),
      row,
    )
  }

  let synced = 0
  let enabled = 0
  let disabled = 0
  const processedKeys = new Set<string>()

  for (const binding of derived) {
    const key = bindingTupleKey(binding.logicalModelId, binding.poolKind, binding.driverId)
    processedKeys.add(key)

    let res: { readonly rows: ReadonlyArray<{ enabled?: boolean }> }
    let fallbackEnabled = binding.enabled

    if (overwrite) {
      res = await pool.query<{ enabled?: boolean }>(UPSERT_OVERWRITE_ADMIN_OVERRIDES_SQL, [
        binding.logicalModelId,
        binding.poolKind,
        binding.driverId,
        binding.canonicalModelId,
        binding.priority,
        JSON.stringify(binding.capabilities),
        binding.enabled,
      ])
    } else {
      const existing = existingByKey.get(key)
      if (!existing) {
        res = await pool.query<{ enabled?: boolean }>(UPSERT_PRESERVE_ADMIN_OVERRIDES_SQL, [
          binding.logicalModelId,
          binding.poolKind,
          binding.driverId,
          binding.canonicalModelId,
          binding.priority,
          JSON.stringify(binding.capabilities),
          binding.enabled,
        ])
      } else if (String(existing.canonical_model_id) !== binding.canonicalModelId) {
        // Admin overrode canonical_model_id via PUT: keep canonical_model_id & priority,
        // re-validate active status + tuple + capabilities against the actual target with CAS.
        const evaluated = evaluateExistingBindingAgainstCatalog(existing, catalogByModelId)
        fallbackEnabled = evaluated.nextEnabled
        res = await pool.query<{ enabled?: boolean }>(UPDATE_EXISTING_PRESERVE_TARGET_SQL, [
          binding.logicalModelId,
          binding.poolKind,
          binding.driverId,
          evaluated.nextCapabilitiesJson,
          evaluated.isActiveAndValid,
          String(existing.canonical_model_id),
        ])
      } else {
        // Same canonical_model_id: refresh capabilities with canonical CAS, preserve priority,
        // force enabled=FALSE if catalog is disabled, and NEVER re-enable a concurrently disabled row.
        fallbackEnabled = binding.enabled ? Boolean(existing.enabled) : false
        res = await pool.query<{ enabled?: boolean }>(UPDATE_EXISTING_PRESERVE_TARGET_SQL, [
          binding.logicalModelId,
          binding.poolKind,
          binding.driverId,
          JSON.stringify(binding.capabilities),
          binding.enabled,
          binding.canonicalModelId,
        ])
      }
    }

    synced += 1
    const effectiveEnabled =
      typeof res.rows[0]?.enabled === 'boolean' ? res.rows[0].enabled : fallbackEnabled
    if (effectiveEnabled) {
      enabled += 1
    } else {
      disabled += 1
    }
  }

  // Re-validate admin-created custom logical model rows not present in derived defaults:
  // refresh capabilities when active & valid; force enabled = FALSE when disabled/missing/invalid.
  for (const [key, existing] of existingByKey) {
    if (processedKeys.has(key)) {
      continue
    }
    const evaluated = evaluateExistingBindingAgainstCatalog(existing, catalogByModelId)
    if (evaluated.isActiveAndValid || Boolean(existing.enabled)) {
      await pool.query<{ enabled?: boolean }>(UPDATE_EXISTING_PRESERVE_TARGET_SQL, [
        String(existing.logical_model_id),
        String(existing.pool_kind),
        String(existing.driver_id),
        evaluated.nextCapabilitiesJson,
        evaluated.isActiveAndValid,
        String(existing.canonical_model_id),
      ])
    }
  }

  return Object.freeze({ synced, enabled, disabled, skipped })
}

function safeResolveCatalogDescriptor(
  catalogSnapshot: { resolve(id: string): ModelExecutionDescriptor | null } | null | undefined,
  modelId: string,
): ModelExecutionDescriptor | null {
  if (!catalogSnapshot) return null
  try {
    return catalogSnapshot.resolve(modelId)
  } catch {
    return null
  }
}

interface NormalizedLogicalLookup {
  readonly trimmedRaw: string
  readonly isLegacyRemoteAlias: boolean
  readonly logicalModelId: string
  readonly resolvedCatalogCanonical: string | null
  readonly resolvedCatalogPlacement: ModelPlacement | null
}

function resolveNormalizedLogicalLookup(
  rawModelId: string,
  catalogSnapshot?: { resolve(id: string): ModelExecutionDescriptor | null } | null,
): NormalizedLogicalLookup | null {
  const trimmedRaw = typeof rawModelId === 'string' ? rawModelId.trim() : ''
  let parsed: ReturnType<typeof resolveLogicalModelId>
  try {
    parsed = resolveLogicalModelId(trimmedRaw)
  } catch {
    return null
  }
  if (parsed.isLegacyRemoteAlias) {
    return {
      trimmedRaw,
      isLegacyRemoteAlias: true,
      logicalModelId: parsed.logicalModel,
      resolvedCatalogCanonical: null,
      resolvedCatalogPlacement: null,
    }
  }
  const desc = safeResolveCatalogDescriptor(catalogSnapshot, trimmedRaw)
  if (desc && desc.canonicalModel && desc.canonicalModel !== trimmedRaw) {
    try {
      const normalized = resolveLogicalModelId(desc.canonicalModel)
      return {
        trimmedRaw,
        isLegacyRemoteAlias: false,
        logicalModelId: normalized.logicalModel,
        resolvedCatalogCanonical: desc.canonicalModel,
        resolvedCatalogPlacement: desc.placement ?? null,
      }
    } catch {
      // Fall back to parsed.logicalModel if canonicalModel is unparseable.
    }
  }
  return {
    trimmedRaw,
    isLegacyRemoteAlias: false,
    logicalModelId: parsed.logicalModel,
    resolvedCatalogCanonical: desc ? desc.canonicalModel : null,
    resolvedCatalogPlacement: desc ? (desc.placement ?? null) : null,
  }
}

interface SelectedQualifiedBinding {
  readonly binding: LogicalModelPoolBinding
  readonly sticky: boolean
  readonly poolTransitionRequired?: PoolTransitionRequirement
}

function selectQualifiedBinding(input: {
  readonly enabledBindings: readonly LogicalModelPoolBinding[]
  readonly catalogSnapshot?: { resolve(id: string): ModelExecutionDescriptor | null } | null
  readonly isModelAllowed?: (canonicalModel: string) => boolean
  readonly activeSessionPoolKind?: ExecutableInferencePoolKind | null
  readonly applyStickiness: boolean
}): SelectedQualifiedBinding | null {
  const ordered = input.enabledBindings
    .filter((b) => b.enabled !== false)
    .sort((a, b) => a.priority - b.priority || a.driverId.localeCompare(b.driverId))

  const qualified: LogicalModelPoolBinding[] = []
  for (const binding of ordered) {
    if (binding.poolKind !== 'local_pool' && binding.poolKind !== 'remote_pool') {
      continue
    }
    if (input.catalogSnapshot) {
      const descriptor = safeResolveCatalogDescriptor(input.catalogSnapshot, binding.canonicalModelId)
      if (!descriptor) {
        continue
      }
      const tupleCheck = validateExecutableBindingTuple({
        poolKind: binding.poolKind,
        driverId: binding.driverId,
        catalogEntry: {
          engine: descriptor.engine,
          placement: descriptor.placement,
        },
      })
      if (!tupleCheck.ok) {
        continue
      }
    }
    if (input.isModelAllowed && !input.isModelAllowed(binding.canonicalModelId)) {
      continue
    }
    qualified.push(binding)
  }

  if (qualified.length === 0) {
    return null
  }

  const activePool =
    input.activeSessionPoolKind === 'local_pool' || input.activeSessionPoolKind === 'remote_pool'
      ? input.activeSessionPoolKind
      : null

  if (input.applyStickiness && activePool) {
    const stickyMatch = qualified.find((b) => b.poolKind === activePool)
    if (stickyMatch) {
      return { binding: stickyMatch, sticky: true }
    }
    const best = qualified[0]!
    return {
      binding: best,
      sticky: false,
      poolTransitionRequired: Object.freeze({
        fromPoolKind: activePool,
        toPoolKind: best.poolKind as ExecutableInferencePoolKind,
      }),
    }
  }

  return { binding: qualified[0]!, sticky: false }
}

/**
 * Pure synchronous peek helper for global binding caches (zero cache mutation / W1 safe).
 *
 * Reuses the exact same catalog alias normalization, physical tuple validation, user
 * authorization filtering, and active-session pool stickiness logic as
 * `resolveSelfhostLogicalModelPoolTarget`.
 */
export function selectPeekBindingCandidate(input: SelectPeekBindingCandidateInput): string | null {
  const lookup = resolveNormalizedLogicalLookup(input.rawModelId, input.catalogSnapshot)
  if (!lookup) {
    return null
  }
  const cached = input.cachedBindingsByLogical.get(lookup.logicalModelId)
  if (!cached || cached.length === 0) {
    return null
  }
  const scoped = lookup.isLegacyRemoteAlias
    ? cached.filter((b) => b.poolKind === 'remote_pool')
    : cached
  const selected = selectQualifiedBinding({
    enabledBindings: scoped,
    catalogSnapshot: input.catalogSnapshot,
    ...(input.isModelAllowed ? { isModelAllowed: input.isModelAllowed } : {}),
    ...(input.activeSessionPoolKind !== undefined
      ? { activeSessionPoolKind: input.activeSessionPoolKind }
      : {}),
    applyStickiness: !lookup.isLegacyRemoteAlias,
  })
  return selected ? selected.binding.canonicalModelId : null
}

/**
 * Pure async resolver for selfhost V5 logical model -> execution pool / canonical model routing.
 *
 * - Legacy `-remote` alias: checks remote_pool bindings; fail-closed (`MODEL_POOL_BINDING_DISABLED`)
 *   when configured with 0 enabled bindings; validates executable tuple when configured;
 *   otherwise preserves legacy `-remote` target.
 * - Logical model (non-`-remote`):
 *   - Normalizes ordinary catalog compatibility aliases to their canonical model's logical key
 *     so aliases inherit canonical bindings and N01 disabled rules; pure logical names not in
 *     catalog continue resolving by their own logical key.
 *   - `unconfigured`: passthrough (100% backward compatible).
 *   - `configured` with 0 enabled bindings: fail-closed (`MODEL_POOL_BINDING_DISABLED`, N01).
 *   - `configured` with enabled bindings: filters candidates through active `catalogSnapshot`,
 *     `validateExecutableBindingTuple`, and `isModelAllowed`. When `activeSessionPoolKind` is
 *     set, prefers staying on the active session's pool (`sticky_session_pool_binding`) and
 *     marks `poolTransitionRequired` only when the active pool has no legal binding remaining.
 *     If none qualify, fail-closed (`MODEL_POOL_BINDING_UNAVAILABLE`).
 * - Any `bindingStore` read failure: fail-closed (`MODEL_POOL_BINDING_READ_FAILED`).
 */
export async function resolveSelfhostLogicalModelPoolTarget(
  input: ResolveSelfhostLogicalModelPoolTargetInput,
): Promise<ResolveSelfhostLogicalModelPoolTargetResult> {
  const lookup = resolveNormalizedLogicalLookup(input.rawModelId, input.catalogSnapshot)
  if (!lookup) {
    return Object.freeze({ ok: false as const, code: 'MODEL_POOL_BINDING_UNAVAILABLE' as const })
  }

  if (lookup.isLegacyRemoteAlias) {
    let inspected: Awaited<
      ReturnType<PgLogicalModelBindingStore['inspectLogicalModelBindings']>
    >
    try {
      inspected = await input.bindingStore.inspectLogicalModelBindings(lookup.trimmedRaw)
    } catch {
      return Object.freeze({ ok: false as const, code: 'MODEL_POOL_BINDING_READ_FAILED' as const })
    }
    if (inspected.status === 'unconfigured') {
      return Object.freeze({
        ok: true as const,
        canonicalModelId: lookup.trimmedRaw,
        poolKind: 'remote_pool' as const,
        logicalModelId: lookup.logicalModelId,
        source: 'legacy_remote_alias' as const,
      })
    }
    if (inspected.enabledBindings.length === 0) {
      return Object.freeze({ ok: false as const, code: 'MODEL_POOL_BINDING_DISABLED' as const })
    }
    const remoteEnabled = inspected.enabledBindings.filter((b) => b.poolKind === 'remote_pool')
    const selected = selectQualifiedBinding({
      enabledBindings: remoteEnabled,
      catalogSnapshot: input.catalogSnapshot,
      ...(input.isModelAllowed ? { isModelAllowed: input.isModelAllowed } : {}),
      applyStickiness: false,
    })
    if (!selected) {
      return Object.freeze({ ok: false as const, code: 'MODEL_POOL_BINDING_UNAVAILABLE' as const })
    }
    return Object.freeze({
      ok: true as const,
      canonicalModelId: selected.binding.canonicalModelId,
      poolKind: 'remote_pool' as const,
      driverId: selected.binding.driverId,
      logicalModelId: lookup.logicalModelId,
      source: 'legacy_remote_alias' as const,
    })
  }

  let inspected: Awaited<ReturnType<PgLogicalModelBindingStore['inspectLogicalModelBindings']>>
  try {
    inspected = await input.bindingStore.inspectLogicalModelBindings(lookup.logicalModelId)
  } catch {
    return Object.freeze({ ok: false as const, code: 'MODEL_POOL_BINDING_READ_FAILED' as const })
  }

  if (inspected.status === 'unconfigured') {
    const passthroughCanonical = lookup.resolvedCatalogCanonical ?? lookup.trimmedRaw
    const passthroughPoolKind: ExecutableInferencePoolKind =
      lookup.resolvedCatalogPlacement === 'remote_pool' ? 'remote_pool' : 'local_pool'
    const activePool =
      input.activeSessionPoolKind === 'local_pool' || input.activeSessionPoolKind === 'remote_pool'
        ? input.activeSessionPoolKind
        : null
    return Object.freeze({
      ok: true as const,
      canonicalModelId: passthroughCanonical,
      poolKind: passthroughPoolKind,
      logicalModelId: lookup.logicalModelId,
      source: 'unconfigured_passthrough' as const,
      ...(activePool && activePool !== passthroughPoolKind
        ? {
            poolTransitionRequired: Object.freeze({
              fromPoolKind: activePool,
              toPoolKind: passthroughPoolKind,
            }),
          }
        : {}),
    })
  }

  if (inspected.enabledBindings.length === 0) {
    return Object.freeze({ ok: false as const, code: 'MODEL_POOL_BINDING_DISABLED' as const })
  }

  const selected = selectQualifiedBinding({
    enabledBindings: inspected.enabledBindings,
    catalogSnapshot: input.catalogSnapshot,
    ...(input.isModelAllowed ? { isModelAllowed: input.isModelAllowed } : {}),
    ...(input.activeSessionPoolKind !== undefined
      ? { activeSessionPoolKind: input.activeSessionPoolKind }
      : {}),
    applyStickiness: true,
  })
  if (!selected) {
    return Object.freeze({ ok: false as const, code: 'MODEL_POOL_BINDING_UNAVAILABLE' as const })
  }

  return Object.freeze({
    ok: true as const,
    canonicalModelId: selected.binding.canonicalModelId,
    poolKind: selected.binding.poolKind,
    driverId: selected.binding.driverId,
    logicalModelId: lookup.logicalModelId,
    source: selected.sticky
      ? ('sticky_session_pool_binding' as const)
      : ('logical_pool_binding' as const),
    ...(selected.poolTransitionRequired
      ? { poolTransitionRequired: selected.poolTransitionRequired }
      : {}),
  })
}
