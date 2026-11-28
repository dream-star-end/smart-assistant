/**
 * OCV5-915 P3-1 — Selfhost Remote Driver v4 Selection via `UnifiedPlacementRouter`.
 *
 * Bridges Master PG offers/profiles/probe snapshots and optional `PgLogicalModelBindingStore`
 * into `UnifiedPlacementRouter` (`PoolCandidateDescriptor` + WRH sticky/cache affinity +
 * capability superset + uncommissioned-staging guard).
 *
 * Strictly gated behind `selfhost === true` so commercial (`selfhost: false`) is untouched.
 *
 * Module: accounts (L3). Zero `process.env`, zero `@openclaude/gateway/*` imports, zero
 * `syncIo`, zero `emptyCatch`, zero `typeEscape`, zero engine-literal special cases.
 */
import type { Pool } from 'pg'
import {
  INFERENCE_SERVICE_TIERS,
  PLATFORM_REASONING_EFFORTS,
  authorityEngineToInferenceFamily,
  checkCapabilitySuperset,
  resolveLogicalModelId,
  validateDriverCapabilityManifest,
  validateRemoteProbeSnapshot,
  type DriverCapabilityManifest,
  type InferenceServiceTier,
  type LogicalModelCapability,
  type PlatformReasoningEffort,
  type RemoteDriverAuthorityEngine,
  type RequiredTurnCapabilities,
} from '@openclaude/protocol'
import { PgLogicalModelBindingStore } from '../../db/threeLayerStateStore.js'
import {
  legacyBindingEngineForAuthority,
  legacyProfileEngineForAuthority,
  loadRemoteDriverRegistry,
  type RemoteDriverRegistryEntry,
} from './registry.js'
import {
  UnifiedPlacementRouter,
  type LogicalModelBindingReader,
  type PoolCandidateDescriptor,
  type RouteTurnResult,
} from './unifiedPlacementRouter.js'

const EFFORT_SET: ReadonlySet<string> = new Set<string>(PLATFORM_REASONING_EFFORTS)
const DEFAULT_TIERS: readonly InferenceServiceTier[] = Object.freeze([...INFERENCE_SERVICE_TIERS])

interface StickyBindingRow {
  readonly driver_id: string | null
  readonly profile_id?: string | null
  readonly node_id?: string | null
}

interface OfferCandidateRow {
  readonly driver_id: string
  readonly profile_id?: string | null
  readonly node_id?: string | null
  readonly execution_ready?: boolean | null
  readonly verified_fingerprint?: string | null
  readonly weight?: number | string | null
  readonly max_concurrent_lanes?: number | string | null
  readonly active_slots?: number | string | null
  readonly probe_snapshot?: unknown
  readonly upstream_model_id?: string | null
  readonly canonical_model_id?: string | null
  readonly rtt_ms_p50?: number | string | null
  readonly has_healthy_legacy_offer?: boolean | null
}

export interface SelectSelfhostRemoteDriverInput {
  readonly selfhost: boolean
  readonly uid: number | string
  readonly sessionKey: string
  readonly canonicalModel: string
  readonly engine?: RemoteDriverAuthorityEngine
  readonly requiredCapabilities?: RequiredTurnCapabilities
  readonly systemPromptSha256?: string
  readonly allowStickyFailover?: boolean
}

export interface SelectSelfhostRemoteDriverOptions {
  readonly registryPath?: string
  readonly bindingStore?: LogicalModelBindingReader
  readonly now?: () => number
  readonly cachedAffinityByProfile?: ReadonlyMap<string, ReadonlySet<string>>
  readonly onBindingReadError?: (error: unknown) => void
}

export interface SelfhostRemoteDriverSelectionResult {
  readonly driverId: string | null
  readonly selectedProfileId?: string
  readonly selectedNodeId?: string
  readonly source:
    | 'non_selfhost_bypass'
    | 'sticky_binding'
    | 'unified_placement_router'
    | 'commissioned_v4_fallback'
    | 'legacy_uncommissioned_guard'
    | 'no_eligible_candidate'
  readonly routeResult?: RouteTurnResult
  readonly stickyHomeKey?: string
  readonly cacheAffinityKey?: string
  readonly bindingStatus?: 'configured' | 'unconfigured' | 'read_error'
  readonly bindingReadError?: string
}

function toSafeInt(value: unknown, fallback: number, min = 0): number {
  const num = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.trunc(num))
}

function deriveModelCapabilityFromProbe(
  logicalModel: string,
  upstreamModelId: string,
  probeSnapshot: unknown,
): LogicalModelCapability {
  let supportsVision = false
  let supportedEfforts: readonly PlatformReasoningEffort[] = Object.freeze([
    ...PLATFORM_REASONING_EFFORTS,
  ])
  let defaultEffort: PlatformReasoningEffort | null = 'medium'
  let supportsAdaptiveThinking = true

  if (probeSnapshot !== null && probeSnapshot !== undefined) {
    try {
      const snap = validateRemoteProbeSnapshot(probeSnapshot)
      const matched =
        snap.models.find((m) => m.upstreamModelId === upstreamModelId) ??
        snap.models.find((m) => m.upstreamModelId === logicalModel) ??
        snap.models[0]
      if (matched) {
        supportsVision = matched.supportsVision
        const validEfforts = matched.supportedEfforts.filter((e): e is PlatformReasoningEffort =>
          EFFORT_SET.has(e),
        )
        supportedEfforts = Object.freeze(validEfforts)
        defaultEffort =
          matched.defaultEffort !== null && EFFORT_SET.has(matched.defaultEffort) &&
          validEfforts.includes(matched.defaultEffort as PlatformReasoningEffort)
            ? (matched.defaultEffort as PlatformReasoningEffort)
            : (validEfforts[0] ?? null)
        supportsAdaptiveThinking = matched.supportsAdaptiveThinking
      }
    } catch {
      // Malformed or incomplete probe snapshot falls back conservatively to no-vision default.
      supportsVision = false
    }
  }

  return Object.freeze({
    logicalModel,
    upstreamModelId,
    supportsVision,
    supportedEfforts,
    defaultEffort,
    supportedServiceTiers: DEFAULT_TIERS,
    supportsReadOnly: true,
    supportsConsultTurn: true,
    supportsHermeticNoTools: true,
    supportsSwarm: true,
    supportsAdaptiveThinking,
  })
}

export function doesRemoteProfileSatisfyCapabilities(params: {
  readonly canonicalModel: string
  readonly upstreamModelId: string
  readonly probeSnapshot: unknown
  readonly reg: RemoteDriverRegistryEntry
  readonly requiredCapabilities?: RequiredTurnCapabilities
  readonly observedAt?: string
}): boolean {
  if (!params.requiredCapabilities || Object.keys(params.requiredCapabilities).length === 0) {
    return true
  }
  const { logicalModel } = resolveLogicalModelId(params.canonicalModel)
  const normalizedUpstream =
    params.upstreamModelId.trim().length > 0 ? params.upstreamModelId.trim().toLowerCase() : logicalModel
  const capability = deriveModelCapabilityFromProbe(logicalModel, normalizedUpstream, params.probeSnapshot)
  const manifest: DriverCapabilityManifest = validateDriverCapabilityManifest({
    schemaVersion: 5,
    poolKind: 'remote_pool',
    engineFamily: authorityEngineToInferenceFamily(params.reg.authorityEngine),
    authorityEngine: params.reg.authorityEngine,
    driverId: params.reg.driverId,
    driverVersion: params.reg.driverVersion,
    observedAt: params.observedAt ?? '2026-01-01T00:00:00.000Z',
    models: [capability],
  })
  return checkCapabilitySuperset(manifest, logicalModel, params.requiredCapabilities).satisfied
}

function buildRemoteCandidateDescriptor(params: {
  readonly row: OfferCandidateRow
  readonly reg: RemoteDriverRegistryEntry
  readonly logicalModel: string
  readonly observedAt: string
  readonly cachedAffinityByProfile?: ReadonlyMap<string, ReadonlySet<string>>
}): PoolCandidateDescriptor {
  const { row, reg, logicalModel, observedAt } = params
  const profileId =
    typeof row.profile_id === 'string' && row.profile_id.length > 0
      ? row.profile_id
      : `profile-${reg.driverId}`
  const nodeId =
    typeof row.node_id === 'string' && row.node_id.length > 0 ? row.node_id : `node-${reg.driverId}`
  const upstreamModelId =
    typeof row.upstream_model_id === 'string' && row.upstream_model_id.trim().length > 0
      ? row.upstream_model_id.trim().toLowerCase()
      : logicalModel
  const capability = deriveModelCapabilityFromProbe(logicalModel, upstreamModelId, row.probe_snapshot)

  const manifest: DriverCapabilityManifest = validateDriverCapabilityManifest({
    schemaVersion: 5,
    poolKind: 'remote_pool',
    engineFamily: authorityEngineToInferenceFamily(reg.authorityEngine),
    authorityEngine: reg.authorityEngine,
    driverId: reg.driverId,
    driverVersion: reg.driverVersion,
    observedAt,
    models: [capability],
  })

  const maxConcurrentLanes = toSafeInt(row.max_concurrent_lanes, reg.profileMaxLanes, 1)
  const maxSlots = Math.max(1, Math.min(maxConcurrentLanes, reg.profileMaxLanes))
  const activeSlots = toSafeInt(row.active_slots, 0, 0)
  const baseWeight = toSafeInt(row.weight, 100, 1)
  const executionReady = row.execution_ready !== false
  const effectiveWeight = executionReady ? baseWeight * 2 : baseWeight
  const rttMsP50 =
    row.rtt_ms_p50 !== null && row.rtt_ms_p50 !== undefined
      ? toSafeInt(row.rtt_ms_p50, 0, 0)
      : undefined
  const cachedAffinityKeys = params.cachedAffinityByProfile?.get(profileId)

  return Object.freeze({
    poolKind: 'remote_pool' as const,
    driverId: reg.driverId,
    profileId,
    nodeId,
    manifest,
    healthy: true,
    draining: false,
    activeSlots,
    maxSlots,
    weight: effectiveWeight,
    ...(rttMsP50 === undefined ? {} : { rttMsP50 }),
    ...(cachedAffinityKeys === undefined ? {} : { cachedAffinityKeys }),
  })
}

interface ResolvedBindingReaderResult {
  readonly reader?: LogicalModelBindingReader
  readonly status: 'configured' | 'unconfigured' | 'read_error'
  readonly error?: string
}

function isUnconfiguredTableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { readonly code?: unknown }).code
  return code === '42P01' || code === '42703'
}

async function resolveOptionalBindingReader(
  pool: Pool,
  canonicalModel: string,
  explicitStore?: LogicalModelBindingReader,
  onBindingReadError?: (error: unknown) => void,
): Promise<ResolvedBindingReaderResult> {
  const store = explicitStore ?? new PgLogicalModelBindingStore(pool)
  try {
    if (store.inspectLogicalModelBindings) {
      const inspected = await store.inspectLogicalModelBindings(canonicalModel)
      if (inspected.status === 'unconfigured' || !inspected.hasConfiguredBindings) {
        return { status: 'unconfigured' }
      }
      return { reader: store, status: 'configured' }
    }
    const resolved = await store.resolveBindingsForModel(canonicalModel)
    return resolved.bindings.length > 0
      ? { reader: store, status: 'configured' }
      : { status: 'unconfigured' }
  } catch (err) {
    // Q1 compatibility: missing table/column (42P01/42703) means bindings were never configured.
    // Distinct DB/storage failures are surfaced instead of being silently conflated with unconfigured.
    if (isUnconfiguredTableError(err)) {
      return { status: 'unconfigured' }
    }
    const errorMessage = err instanceof Error ? err.message : String(err)
    onBindingReadError?.(err)
    return { status: 'read_error', error: errorMessage }
  }
}

interface StickyDriverMatch {
  readonly driverId: string
  readonly profileId?: string
  readonly nodeId?: string
}

interface BindingMeta {
  readonly bindingStatus: 'configured' | 'unconfigured' | 'read_error'
  readonly bindingReadError?: string
}

function buildStickyResult(
  stickyMatch: StickyDriverMatch,
  extra?: { readonly routeResult?: RouteTurnResult; readonly bindingMeta?: BindingMeta },
): SelfhostRemoteDriverSelectionResult {
  return Object.freeze({
    driverId: stickyMatch.driverId,
    ...(stickyMatch.profileId ? { selectedProfileId: stickyMatch.profileId } : {}),
    ...(stickyMatch.nodeId ? { selectedNodeId: stickyMatch.nodeId } : {}),
    source: 'sticky_binding' as const,
    ...(extra?.routeResult ? { routeResult: extra.routeResult } : {}),
    ...(extra?.bindingMeta ?? {}),
  })
}

async function queryStickyDriverMatch(
  pool: Pool,
  request: SelectSelfhostRemoteDriverInput,
  legacyBindEngine: string,
  authEngine: RemoteDriverAuthorityEngine,
  regMap: ReadonlyMap<string, RemoteDriverRegistryEntry>,
): Promise<StickyDriverMatch | null> {
  const stickyRows = (
    await pool.query<StickyBindingRow>(
      `SELECT driver_id, profile_id::text AS profile_id, node_id::text AS node_id
         FROM remote_agent_bindings
        WHERE uid = $1
          AND session_key = $2
          AND driver_id IS NOT NULL
          AND engine = $3
        ORDER BY updated_at DESC
        LIMIT 8`,
      [String(request.uid), request.sessionKey, legacyBindEngine],
    )
  ).rows

  for (const sticky of stickyRows) {
    const did = sticky?.driver_id ? String(sticky.driver_id) : ''
    if (did && regMap.get(did)?.authorityEngine === authEngine) {
      return {
        driverId: did,
        ...(sticky.profile_id ? { profileId: String(sticky.profile_id) } : {}),
        ...(sticky.node_id ? { nodeId: String(sticky.node_id) } : {}),
      }
    }
  }
  return null
}

async function queryRemoteOfferCandidates(
  pool: Pool,
  canonicalModel: string,
  legacyProfEngine: string,
): Promise<readonly OfferCandidateRow[]> {
  return (
    await pool.query<OfferCandidateRow>(
      `WITH active_model_offers AS (
         SELECT p.id AS raw_profile_id,
                p.driver_id,
                p.id::text AS profile_id,
                p.node_id::text AS node_id,
                p.execution_ready,
                p.verified_fingerprint,
                p.weight,
                p.max_concurrent_lanes,
                p.active_slots,
                p.probe_snapshot,
                o.upstream_model_id,
                o.canonical_model_id,
                n.rtt_ms_p50
           FROM remote_model_offers o
           JOIN remote_agent_profiles p ON p.id = o.profile_id
           JOIN remote_agent_nodes n ON n.id = p.node_id
          WHERE o.canonical_model_id = $1
            AND o.enabled = TRUE
            AND p.engine = $2
            AND p.status IN ('active', 'degraded')
            AND (p.disabled_by IS NULL OR p.disabled_by <> 'admin')
            AND n.status IN ('active', 'degraded')
            AND (n.disabled_by IS NULL OR n.disabled_by <> 'admin')
       )
       SELECT driver_id, profile_id, node_id, execution_ready, verified_fingerprint,
              weight, max_concurrent_lanes, active_slots, probe_snapshot,
              upstream_model_id, canonical_model_id, rtt_ms_p50,
              EXISTS (SELECT 1 FROM active_model_offers WHERE driver_id IS NULL) AS has_healthy_legacy_offer
         FROM active_model_offers
        WHERE driver_id IS NOT NULL
        ORDER BY execution_ready DESC, weight DESC, raw_profile_id ASC`,
      [canonicalModel, legacyProfEngine],
    )
  ).rows
}

function filterEligibleOfferRows(
  offerRows: readonly OfferCandidateRow[],
  authEngine: RemoteDriverAuthorityEngine,
  regMap: ReadonlyMap<string, RemoteDriverRegistryEntry>,
): {
  readonly eligibleRows: readonly OfferCandidateRow[]
  readonly blockedByUncommissionedGuard: boolean
  readonly hasCommissionedV4: boolean
} {
  const eligibleRows: OfferCandidateRow[] = []
  let blockedByUncommissionedGuard = false
  let hasCommissionedV4 = false
  for (const row of offerRows) {
    const reg = regMap.get(String(row.driver_id))
    if (!reg || reg.authorityEngine !== authEngine) continue
    const isCommissioned =
      row.execution_ready === true ||
      (row.verified_fingerprint !== null && row.verified_fingerprint !== undefined) ||
      (row.execution_ready === undefined && row.verified_fingerprint === undefined)
    if (isCommissioned) hasCommissionedV4 = true
    if (!isCommissioned && row.has_healthy_legacy_offer === true) {
      blockedByUncommissionedGuard = true
      continue
    }
    eligibleRows.push(row)
  }
  return { eligibleRows, blockedByUncommissionedGuard, hasCommissionedV4 }
}

async function routeEligibleOfferCandidates(params: {
  readonly pool: Pool
  readonly request: SelectSelfhostRemoteDriverInput
  readonly options: SelectSelfhostRemoteDriverOptions
  readonly logicalModel: string
  readonly observedAt: string
  readonly eligibleRows: readonly OfferCandidateRow[]
  readonly regMap: ReadonlyMap<string, RemoteDriverRegistryEntry>
  readonly stickyMatch: StickyDriverMatch | null
}): Promise<{ readonly routeResult: RouteTurnResult; readonly bindingMeta: BindingMeta }> {
  const { pool, request, options, logicalModel, observedAt, eligibleRows, regMap, stickyMatch } =
    params
  const candidates: PoolCandidateDescriptor[] = eligibleRows.map((row) =>
    buildRemoteCandidateDescriptor({
      row,
      reg: regMap.get(String(row.driver_id))!,
      logicalModel,
      observedAt,
      cachedAffinityByProfile: options.cachedAffinityByProfile,
    }),
  )
  const bindingResolution = await resolveOptionalBindingReader(
    pool,
    request.canonicalModel,
    options.bindingStore,
    options.onBindingReadError,
  )
  const bindingMeta: BindingMeta = {
    bindingStatus: bindingResolution.status,
    ...(bindingResolution.error === undefined ? {} : { bindingReadError: bindingResolution.error }),
  }
  const router = new UnifiedPlacementRouter({
    candidates,
    ...(bindingResolution.reader === undefined ? {} : { bindingStore: bindingResolution.reader }),
  })
  const keepSticky = stickyMatch !== null && request.allowStickyFailover !== true
  const routeResult = await router.routeTurn({
    rawModelId: request.canonicalModel,
    sessionKey: request.sessionKey,
    tenantId: String(request.uid),
    poolPreference: 'pin_remote',
    ...(request.requiredCapabilities ? { requiredCapabilities: request.requiredCapabilities } : {}),
    ...(request.systemPromptSha256 ? { systemPromptSha256: request.systemPromptSha256 } : {}),
    ...(keepSticky
      ? {
          currentPoolKind: 'remote_pool' as const,
          currentDriverId: stickyMatch.driverId,
          ...(stickyMatch.profileId ? { currentProfileId: stickyMatch.profileId } : {}),
          ...(stickyMatch.nodeId ? { currentNodeId: stickyMatch.nodeId } : {}),
        }
      : {}),
  })
  return { routeResult, bindingMeta }
}

function finalizeSelectionFromRoute(params: {
  readonly routeResult: RouteTurnResult
  readonly bindingMeta: BindingMeta
  readonly stickyMatch: StickyDriverMatch | null
  readonly allowStickyFailover: boolean
  readonly hasCommissionedV4: boolean
  readonly eligibleRows: readonly OfferCandidateRow[]
}): SelfhostRemoteDriverSelectionResult {
  const {
    routeResult,
    bindingMeta,
    stickyMatch,
    allowStickyFailover,
    hasCommissionedV4,
    eligibleRows,
  } = params
  if (routeResult.ok) {
    return Object.freeze({
      driverId: routeResult.selected.driverId,
      ...(routeResult.selected.profileId ? { selectedProfileId: routeResult.selected.profileId } : {}),
      ...(routeResult.selected.nodeId ? { selectedNodeId: routeResult.selected.nodeId } : {}),
      source: 'unified_placement_router' as const,
      routeResult,
      stickyHomeKey: routeResult.stickyHomeKey,
      ...(routeResult.cacheAffinityKey === undefined
        ? {}
        : { cacheAffinityKey: routeResult.cacheAffinityKey }),
      ...bindingMeta,
    })
  }
  if (routeResult.code === 'CAPABILITY_UNSATISFIED') {
    throw new Error('CAPABILITY_UNSATISFIED')
  }
  if (stickyMatch && !allowStickyFailover) {
    return buildStickyResult(stickyMatch, { routeResult, bindingMeta })
  }
  if (hasCommissionedV4) {
    const primary = eligibleRows[0]!
    return Object.freeze({
      driverId: String(primary.driver_id),
      ...(primary.profile_id ? { selectedProfileId: String(primary.profile_id) } : {}),
      ...(primary.node_id ? { selectedNodeId: String(primary.node_id) } : {}),
      source: 'commissioned_v4_fallback' as const,
      routeResult,
      ...bindingMeta,
    })
  }
  return Object.freeze({
    driverId: null,
    source: 'no_eligible_candidate' as const,
    routeResult,
    ...bindingMeta,
  })
}

/**
 * Selects the selfhost `remote-driver-v4` `driverId` through `UnifiedPlacementRouter`,
 * preserving Design §5.1 / §7 sticky v4 pinning, uncommissioned-staging guard, WRH
 * cache-affinity ranking, optional `PgLogicalModelBindingStore` narrowing, and Red Line #1
 * capability superset enforcement.
 */
export async function selectSelfhostRemoteDriverViaUnifiedRouter(
  pool: Pool,
  request: SelectSelfhostRemoteDriverInput,
  options: SelectSelfhostRemoteDriverOptions = {},
): Promise<SelfhostRemoteDriverSelectionResult> {
  if (request.selfhost !== true) {
    return Object.freeze({ driverId: null, source: 'non_selfhost_bypass' as const })
  }

  const authEngine: RemoteDriverAuthorityEngine = request.engine ?? 'ccb'
  const legacyBindEngine = legacyBindingEngineForAuthority(authEngine)
  const legacyProfEngine = legacyProfileEngineForAuthority(authEngine)
  const regMap = loadRemoteDriverRegistry(options.registryPath)
  const resolvedModel = resolveLogicalModelId(request.canonicalModel)
  const observedAt = new Date((options.now ?? Date.now)()).toISOString()
  const allowStickyFailover = request.allowStickyFailover === true

  const stickyMatch = await queryStickyDriverMatch(
    pool,
    request,
    legacyBindEngine,
    authEngine,
    regMap,
  )
  if (stickyMatch && !allowStickyFailover && !request.requiredCapabilities) {
    return buildStickyResult(stickyMatch)
  }

  const offerRows = await queryRemoteOfferCandidates(pool, request.canonicalModel, legacyProfEngine)
  if (offerRows.length === 0) {
    return stickyMatch && !allowStickyFailover
      ? buildStickyResult(stickyMatch)
      : Object.freeze({ driverId: null, source: 'no_eligible_candidate' as const })
  }

  const { eligibleRows, blockedByUncommissionedGuard, hasCommissionedV4 } = filterEligibleOfferRows(
    offerRows,
    authEngine,
    regMap,
  )
  if (eligibleRows.length === 0) {
    if (stickyMatch && !allowStickyFailover) return buildStickyResult(stickyMatch)
    return Object.freeze({
      driverId: null,
      source: blockedByUncommissionedGuard
        ? ('legacy_uncommissioned_guard' as const)
        : ('no_eligible_candidate' as const),
    })
  }

  const { routeResult, bindingMeta } = await routeEligibleOfferCandidates({
    pool,
    request,
    options,
    logicalModel: resolvedModel.logicalModel,
    observedAt,
    eligibleRows,
    regMap,
    stickyMatch,
  })
  return finalizeSelectionFromRoute({
    routeResult,
    bindingMeta,
    stickyMatch,
    allowStickyFailover,
    hasCommissionedV4,
    eligibleRows,
  })
}
