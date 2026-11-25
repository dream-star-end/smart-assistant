/**
 * OCV5-890 Wave 2 — Master Control-Plane Unified Placement Router.
 *
 * Routes turns across `local_pool`, `remote_pool`, and `box_pool` under strict
 * OCV5-890 architectural invariants:
 * - Logical model decoupling with `<base>-remote` degraded to a `pin_remote` alias.
 * - Red Line #1 (Capability Superset): NEVER silently downgrade a logical model or
 *   strip requested capabilities (vision, reasoning effort, service tier, read-only,
 *   consultTurn, hermeticNoTools, swarm).
 * - Cache-affinity & sticky-home preservation via Weighted Rendezvous Hashing (WRH)
 *   to preserve 94%+ implicit prompt-cache hit rate on steady-state turns.
 * - Pre-dispatch vs Post-dispatch failover fence: pre-dispatch admission failures may
 *   abandon the zero-credit prior attempt and re-route across pools; post-dispatch
 *   failures are ALWAYS fail-closed (`POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN`).
 *
 * Module: accounts (L3). Zero environment-variable reads, zero network I/O,
 * zero forbidden crypto, zero engine/provider literal special cases, zero billing SQL.
 */
import {
  DEFAULT_POOL_FALLBACK_POLICY,
  INFERENCE_POOL_KINDS,
  checkCapabilitySuperset,
  computeCacheAffinityKey,
  computeStickyHomeKey,
  resolveLogicalModelId,
  type CapabilitySupersetCheckResult,
  type DriverCapabilityManifest,
  type InferencePoolKind,
  type LogicalModelPoolBinding,
  type PoolFallbackPolicy,
  type RequiredTurnCapabilities,
  type ResolvedLogicalModelId,
  type TurnPoolPreference,
} from '@openclaude/protocol'
import type { ResolvedModelPoolBindings } from '../../db/threeLayerStateStore.js'
import { rankWRH } from '../policy/select.js'

export type RouterPoolPreference =
  | TurnPoolPreference
  | 'prefer_local'
  | 'prefer_remote'
  | 'prefer_box'

export type MigrationTrigger =
  | 'none'
  | 'capability_driven'
  | 'drain_cutover'
  | 'capacity_or_health'
  | 'user_preference'

export type ColdCacheBudgetAction =
  | 'none'
  | 'platform_absorb_on_drain'
  | 'require_consent_or_budget_check'

export const PRE_DISPATCH_RETRYABLE_ERROR_CODES = [
  'REMOTE_POOL_DRAINING_RETRY_LATER',
  'REMOTE_LANE_CAPACITY_EXHAUSTED',
  'REMOTE_DRIVER_PROBE_STALE',
  'REMOTE_NODE_MEMORY_EXHAUSTED',
  'UPSTREAM_PRE_ADMIT_429',
  'UPSTREAM_PRE_ADMIT_503',
] as const

export type PreDispatchRetryableErrorCode =
  (typeof PRE_DISPATCH_RETRYABLE_ERROR_CODES)[number]

const PRE_DISPATCH_RETRYABLE_ERROR_SET: ReadonlySet<string> = new Set<string>(
  PRE_DISPATCH_RETRYABLE_ERROR_CODES,
)

const VALID_POOL_KIND_SET: ReadonlySet<string> = new Set<string>(INFERENCE_POOL_KINDS)

const PINNED_POOL_BY_PREFERENCE: Readonly<
  Partial<Record<RouterPoolPreference, InferencePoolKind>>
> = Object.freeze({
  pin_local: 'local_pool',
  pin_remote: 'remote_pool',
  pin_box: 'box_pool',
})

const PREFERRED_POOL_BY_PREFERENCE: Readonly<
  Partial<Record<RouterPoolPreference, InferencePoolKind>>
> = Object.freeze({
  pin_local: 'local_pool',
  pin_remote: 'remote_pool',
  pin_box: 'box_pool',
  prefer_local: 'local_pool',
  prefer_remote: 'remote_pool',
  prefer_box: 'box_pool',
})

export interface LogicalModelBindingReader {
  resolveBindingsForModel(rawModelId: string): Promise<ResolvedModelPoolBindings>
}

export interface PoolCandidateDescriptor {
  readonly poolKind: InferencePoolKind
  readonly driverId: string
  readonly profileId?: string
  readonly nodeId?: string
  readonly manifest: DriverCapabilityManifest
  readonly healthy: boolean
  readonly draining: boolean
  readonly activeSlots: number
  readonly maxSlots: number
  readonly weight: number
  readonly rttMsP50?: number
  readonly cachedAffinityKeys?: ReadonlySet<string>
  readonly candidateKey?: string
}

export interface UnifiedPlacementRouterOptions {
  readonly candidates?: readonly PoolCandidateDescriptor[]
  readonly bindingStore?: LogicalModelBindingReader
  readonly fallbackPolicy?: PoolFallbackPolicy
}

export interface RouteTurnInput {
  readonly rawModelId: string
  readonly sessionKey: string
  readonly tenantId?: string
  readonly systemPromptSha256?: string
  readonly requiredCapabilities?: RequiredTurnCapabilities
  readonly poolPreference?: RouterPoolPreference
  readonly stickyHomeKey?: string
  readonly cacheAffinityKey?: string
  readonly currentPoolKind?: InferencePoolKind
  readonly currentDriverId?: string
  readonly currentProfileId?: string
  readonly currentNodeId?: string
  readonly excludedCandidateKeys?: ReadonlySet<string> | readonly string[]
  readonly candidates?: readonly PoolCandidateDescriptor[]
}

export interface RouteTurnSuccess {
  readonly ok: true
  readonly selected: PoolCandidateDescriptor
  readonly selectedCandidateKey: string
  readonly rankedCandidateKeys: readonly string[]
  readonly logicalModel: string
  readonly canonicalModelId: string
  readonly isLegacyRemoteAlias: boolean
  readonly effectivePoolPreference: RouterPoolPreference
  readonly stickyHomeKey: string
  readonly cacheAffinityKey?: string
  readonly stickyHomePreserved: boolean
  readonly cacheAffinityHit: boolean
  readonly migrationRequired: boolean
  readonly migrationTrigger: MigrationTrigger
  readonly coldCacheBudgetAction: ColdCacheBudgetAction
  readonly matchedCapability: CapabilitySupersetCheckResult
}

export interface RouteTurnCapabilityFailure {
  readonly ok: false
  readonly code: 'CAPABILITY_UNSATISFIED'
  readonly logicalModel: string
  readonly isLegacyRemoteAlias: boolean
  readonly effectivePoolPreference: RouterPoolPreference
  readonly unsatisfiedByCandidate: Readonly<Record<string, readonly string[]>>
}

export interface RouteTurnUnavailableFailure {
  readonly ok: false
  readonly code: 'INFERENCE_POOL_UNAVAILABLE'
  readonly logicalModel: string
  readonly isLegacyRemoteAlias: boolean
  readonly effectivePoolPreference: RouterPoolPreference
  readonly drainingCount: number
  readonly exhaustedCount: number
  readonly unhealthyCount: number
}

export type RouteTurnResult =
  | RouteTurnSuccess
  | RouteTurnCapabilityFailure
  | RouteTurnUnavailableFailure

export interface RetryAfterFailureInput {
  readonly dispatched: boolean
  readonly failedCandidateKey: string
  readonly failedPoolKind?: InferencePoolKind
  readonly errorCode: string
  readonly allowCrossPoolMigration: boolean
  readonly attemptCount?: number
  readonly originalRouteInput: RouteTurnInput
  readonly previouslyExcludedCandidateKeys?: readonly string[]
}

export type RetryAfterFailureDecision =
  | {
      readonly allowRetry: false
      readonly code: 'POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN'
      readonly mustSettleCurrentFirst: true
    }
  | {
      readonly allowRetry: false
      readonly code:
        | 'PRE_DISPATCH_FALLBACK_DISABLED'
        | 'PRE_DISPATCH_FALLBACK_ATTEMPTS_EXHAUSTED'
        | 'PRE_DISPATCH_ERROR_NOT_RETRYABLE'
        | 'CAPABILITY_UNSATISFIED'
        | 'INFERENCE_POOL_UNAVAILABLE'
      readonly mustSettleCurrentFirst: false
      readonly nextRoute?: RouteTurnResult
    }
  | {
      readonly allowRetry: true
      readonly mustAbandonPriorZeroCredit: true
      readonly nextRoute: RouteTurnSuccess
    }

export function poolCandidateKey(candidate: PoolCandidateDescriptor): string {
  if (candidate.candidateKey && candidate.candidateKey.trim().length > 0) {
    return candidate.candidateKey.trim()
  }
  return [
    candidate.poolKind,
    candidate.driverId,
    candidate.profileId ?? '-',
    candidate.nodeId ?? '-',
  ].join(':')
}

function assertFallbackPolicyInvariants(policy: PoolFallbackPolicy): PoolFallbackPolicy {
  if (
    policy.neverSilentDowngradeModel !== true ||
    policy.requireCapabilitySuperset !== true ||
    policy.allowCrossPoolOnPostDispatchFailure !== false
  ) {
    throw new Error('POOL_FALLBACK_POLICY_INVARIANT_VIOLATION')
  }
  if (
    typeof policy.allowPreDispatchPoolFallback !== 'boolean' ||
    typeof policy.maxPreDispatchFallbackAttempts !== 'number' ||
    !Number.isSafeInteger(policy.maxPreDispatchFallbackAttempts) ||
    policy.maxPreDispatchFallbackAttempts < 0 ||
    !Array.isArray(policy.allowedFallbackPools)
  ) {
    throw new Error('POOL_FALLBACK_POLICY_INVARIANT_VIOLATION')
  }
  for (const pool of policy.allowedFallbackPools) {
    if (!VALID_POOL_KIND_SET.has(pool)) {
      throw new Error('POOL_FALLBACK_POLICY_INVARIANT_VIOLATION')
    }
  }
  return Object.freeze({
    ...policy,
    allowedFallbackPools: Object.freeze([...policy.allowedFallbackPools]),
  })
}

function bindingLookupKey(poolKind: InferencePoolKind, driverId: string): string {
  return `${poolKind}::${driverId}`
}

function toExcludedSet(
  excluded?: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> {
  if (!excluded) return new Set<string>()
  return excluded instanceof Set ? excluded : new Set<string>(excluded)
}

function matchesCurrentPlacement(
  candidate: PoolCandidateDescriptor,
  input: RouteTurnInput,
): boolean {
  if (input.currentPoolKind === undefined) return false
  if (candidate.poolKind !== input.currentPoolKind) return false
  if (input.currentDriverId !== undefined && candidate.driverId !== input.currentDriverId) {
    return false
  }
  if (input.currentProfileId !== undefined && candidate.profileId !== input.currentProfileId) {
    return false
  }
  if (input.currentNodeId !== undefined && candidate.nodeId !== input.currentNodeId) {
    return false
  }
  return true
}

function checkBindingCapabilitiesSuperset(
  binding: LogicalModelPoolBinding,
  required: RequiredTurnCapabilities,
): readonly string[] {
  const cap = binding.capabilities
  const reasons: string[] = []
  if (required.needsVision === true && !cap.supportsVision) {
    reasons.push('binding_vision_unsupported')
  }
  if (
    required.reasoningEffort !== undefined &&
    !cap.supportedEfforts.includes(required.reasoningEffort)
  ) {
    reasons.push(`binding_reasoning_effort_unsupported:${required.reasoningEffort}`)
  }
  if (
    required.serviceTier !== undefined &&
    !cap.supportedServiceTiers.includes(required.serviceTier)
  ) {
    reasons.push(`binding_service_tier_unsupported:${required.serviceTier}`)
  }
  if (required.readOnly === true && !cap.supportsReadOnly) {
    reasons.push('binding_read_only_unsupported')
  }
  if (required.consultTurn === true && !cap.supportsConsultTurn) {
    reasons.push('binding_consult_turn_unsupported')
  }
  if (required.hermeticNoTools === true && !cap.supportsHermeticNoTools) {
    reasons.push('binding_hermetic_no_tools_unsupported')
  }
  if (required.needsSwarm === true && !cap.supportsSwarm) {
    reasons.push('binding_swarm_unsupported')
  }
  return reasons
}

export class UnifiedPlacementRouter {
  private readonly defaultCandidates: readonly PoolCandidateDescriptor[]
  private readonly bindingStore?: LogicalModelBindingReader
  readonly fallbackPolicy: PoolFallbackPolicy

  constructor(options: UnifiedPlacementRouterOptions = {}) {
    this.defaultCandidates = Object.freeze([...(options.candidates ?? [])])
    this.bindingStore = options.bindingStore
    this.fallbackPolicy = assertFallbackPolicyInvariants(
      options.fallbackPolicy ?? DEFAULT_POOL_FALLBACK_POLICY,
    )
  }

  async routeTurn(input: RouteTurnInput): Promise<RouteTurnResult> {
    const resolved: ResolvedLogicalModelId = resolveLogicalModelId(input.rawModelId)
    const effectivePoolPreference: RouterPoolPreference = resolved.isLegacyRemoteAlias
      ? 'pin_remote'
      : (input.poolPreference ?? 'auto')

    const stickyHomeKey = input.stickyHomeKey ?? computeStickyHomeKey(input.sessionKey)
    const cacheAffinityKey =
      input.cacheAffinityKey ??
      (input.tenantId !== undefined
        ? computeCacheAffinityKey({
            tenantId: input.tenantId,
            sessionKey: input.sessionKey,
            logicalModel: resolved.logicalModel,
            ...(input.systemPromptSha256 === undefined
              ? {}
              : { systemPromptSha256: input.systemPromptSha256 }),
          })
        : undefined)

    const allCandidates = input.candidates ?? this.defaultCandidates
    const excluded = toExcludedSet(input.excludedCandidateKeys)
    const nonExcluded = allCandidates.filter((c) => !excluded.has(poolCandidateKey(c)))

    // Optional PG binding store narrowing
    let bindingMap: Map<string, LogicalModelPoolBinding> | null = null
    if (this.bindingStore) {
      const bindingRes = await this.bindingStore.resolveBindingsForModel(input.rawModelId)
      bindingMap = new Map<string, LogicalModelPoolBinding>()
      for (const b of bindingRes.bindings) {
        if (b.enabled) {
          bindingMap.set(bindingLookupKey(b.poolKind, b.driverId), b)
        }
      }
    }

    // Apply hard pool pin before capability evaluation so pinned pools report accurate
    // capability vs availability errors.
    const pinnedPool = PINNED_POOL_BY_PREFERENCE[effectivePoolPreference]
    const poolScopedCandidates =
      pinnedPool !== undefined
        ? nonExcluded.filter((c) => c.poolKind === pinnedPool)
        : nonExcluded

    if (poolScopedCandidates.length === 0) {
      return Object.freeze({
        ok: false as const,
        code: 'INFERENCE_POOL_UNAVAILABLE' as const,
        logicalModel: resolved.logicalModel,
        isLegacyRemoteAlias: resolved.isLegacyRemoteAlias,
        effectivePoolPreference,
        drainingCount: 0,
        exhaustedCount: 0,
        unhealthyCount: 0,
      })
    }

    // Step 2: Red Line #1 — strict capability superset filtering (zero silent downgrade)
    const required = input.requiredCapabilities ?? {}
    const unsatisfiedByCandidate: Record<string, readonly string[]> = {}
    const capableCandidates: Array<{
      readonly candidate: PoolCandidateDescriptor
      readonly key: string
      readonly capabilityCheck: CapabilitySupersetCheckResult
      readonly binding?: LogicalModelPoolBinding
    }> = []

    for (const candidate of poolScopedCandidates) {
      const key = poolCandidateKey(candidate)
      const reasons: string[] = []

      if (
        candidate.manifest.poolKind !== candidate.poolKind ||
        candidate.manifest.driverId !== candidate.driverId
      ) {
        reasons.push('manifest_candidate_identity_mismatch')
      }

      let matchedBinding: LogicalModelPoolBinding | undefined
      if (bindingMap !== null) {
        matchedBinding = bindingMap.get(bindingLookupKey(candidate.poolKind, candidate.driverId))
        if (!matchedBinding) {
          reasons.push(`logical_model_binding_absent:${resolved.logicalModel}`)
        } else {
          reasons.push(...checkBindingCapabilitiesSuperset(matchedBinding, required))
        }
      }

      const superset = checkCapabilitySuperset(
        candidate.manifest,
        resolved.logicalModel,
        required,
      )
      if (!superset.satisfied) {
        reasons.push(...superset.unsatisfiedReasons)
      }

      if (reasons.length > 0) {
        unsatisfiedByCandidate[key] = Object.freeze(reasons)
      } else {
        capableCandidates.push({
          candidate,
          key,
          capabilityCheck: superset,
          binding: matchedBinding,
        })
      }
    }

    if (capableCandidates.length === 0) {
      return Object.freeze({
        ok: false as const,
        code: 'CAPABILITY_UNSATISFIED' as const,
        logicalModel: resolved.logicalModel,
        isLegacyRemoteAlias: resolved.isLegacyRemoteAlias,
        effectivePoolPreference,
        unsatisfiedByCandidate: Object.freeze(unsatisfiedByCandidate),
      })
    }

    // Step 3: Health, drain, and slot capacity filtering
    let drainingCount = 0
    let exhaustedCount = 0
    let unhealthyCount = 0
    const eligible: typeof capableCandidates = []

    for (const entry of capableCandidates) {
      const c = entry.candidate
      if (c.draining) {
        drainingCount += 1
        continue
      }
      if (!c.healthy) {
        unhealthyCount += 1
        continue
      }
      if (c.maxSlots <= 0 || c.activeSlots >= c.maxSlots) {
        exhaustedCount += 1
        continue
      }
      eligible.push(entry)
    }

    if (eligible.length === 0) {
      return Object.freeze({
        ok: false as const,
        code: 'INFERENCE_POOL_UNAVAILABLE' as const,
        logicalModel: resolved.logicalModel,
        isLegacyRemoteAlias: resolved.isLegacyRemoteAlias,
        effectivePoolPreference,
        drainingCount,
        exhaustedCount,
        unhealthyCount,
      })
    }

    // Step 4: Cache affinity + sticky home + pool preference + WRH ranking
    const preferredPool = PREFERRED_POOL_BY_PREFERENCE[effectivePoolPreference]
    const wrhKey = cacheAffinityKey ?? stickyHomeKey

    const ranked = rankWRH(eligible, {
      key: wrhKey,
      id: (entry) => entry.key,
      tier: (entry) => {
        const sticky = matchesCurrentPlacement(entry.candidate, input)
        const cacheHit =
          cacheAffinityKey !== undefined &&
          entry.candidate.cachedAffinityKeys?.has(cacheAffinityKey) === true

        if (preferredPool !== undefined) {
          const matchesPref = entry.candidate.poolKind === preferredPool
          if (matchesPref) {
            if (sticky && cacheHit) return 0
            if (sticky) return 1
            if (cacheHit) return 2
            return 3
          }
          // Non-preferred pool is strictly lower priority than any healthy preferred pool
          if (sticky && cacheHit) return 10
          if (sticky) return 11
          if (cacheHit) return 12
          return 13
        }

        // 'auto' preference: preserve sticky home and warm cache aggressively
        if (sticky && cacheHit) return 0
        if (sticky) return 1
        if (cacheHit) return 2
        return 3
      },
      weight: (entry) => {
        const c = entry.candidate
        const baseWeight = Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 100
        const slotUtilization = Math.min(1, Math.max(0, c.activeSlots) / Math.max(1, c.maxSlots))
        const slotFactor = 1 - slotUtilization * 0.4
        const rttFactor =
          c.rttMsP50 !== undefined && c.rttMsP50 > 100
            ? Math.max(0.3, 100 / c.rttMsP50)
            : 1
        const bindingPriorityFactor =
          entry.binding !== undefined
            ? 1 / (1 + Math.max(0, entry.binding.priority) * 0.1)
            : 1
        const cacheHit =
          cacheAffinityKey !== undefined &&
          c.cachedAffinityKeys?.has(cacheAffinityKey) === true
        const affinityMultiplier = cacheHit ? 2.5 : 1.0
        return Math.max(
          0.05,
          baseWeight * slotFactor * rttFactor * bindingPriorityFactor * affinityMultiplier,
        )
      },
    })

    const chosen = ranked[0]!
    const stickyHomePreserved =
      input.currentPoolKind === undefined || matchesCurrentPlacement(chosen.candidate, input)
    const cacheAffinityHit =
      cacheAffinityKey !== undefined &&
      chosen.candidate.cachedAffinityKeys?.has(cacheAffinityKey) === true

    const migrationRequired = input.currentPoolKind !== undefined && !stickyHomePreserved
    const migrationTrigger = this.determineMigrationTrigger({
      migrationRequired,
      input,
      allCandidates,
      excluded,
      effectivePoolPreference,
      logicalModel: resolved.logicalModel,
      required,
      bindingMap,
    })

    const coldCacheBudgetAction: ColdCacheBudgetAction = !migrationRequired
      ? 'none'
      : cacheAffinityHit
        ? 'none'
        : migrationTrigger === 'drain_cutover'
          ? 'platform_absorb_on_drain'
          : 'require_consent_or_budget_check'

    const canonicalModelId =
      chosen.binding?.canonicalModelId ??
      chosen.capabilityCheck.matchedModel?.logicalModel ??
      resolved.logicalModel

    return Object.freeze({
      ok: true as const,
      selected: chosen.candidate,
      selectedCandidateKey: chosen.key,
      rankedCandidateKeys: Object.freeze(ranked.map((r) => r.key)),
      logicalModel: resolved.logicalModel,
      canonicalModelId,
      isLegacyRemoteAlias: resolved.isLegacyRemoteAlias,
      effectivePoolPreference,
      stickyHomeKey,
      ...(cacheAffinityKey === undefined ? {} : { cacheAffinityKey }),
      stickyHomePreserved,
      cacheAffinityHit,
      migrationRequired,
      migrationTrigger,
      coldCacheBudgetAction,
      matchedCapability: chosen.capabilityCheck,
    })
  }

  async decideRetryAfterFailure(
    input: RetryAfterFailureInput,
  ): Promise<RetryAfterFailureDecision> {
    // Hard post-dispatch fence: cross-pool replay after dispatch is strictly forbidden.
    if (input.dispatched === true) {
      return Object.freeze({
        allowRetry: false as const,
        code: 'POST_DISPATCH_CROSS_POOL_REPLAY_FORBIDDEN' as const,
        mustSettleCurrentFirst: true as const,
      })
    }

    if (!this.fallbackPolicy.allowPreDispatchPoolFallback) {
      return Object.freeze({
        allowRetry: false as const,
        code: 'PRE_DISPATCH_FALLBACK_DISABLED' as const,
        mustSettleCurrentFirst: false as const,
      })
    }

    const attemptCount = input.attemptCount ?? 1
    if (attemptCount > this.fallbackPolicy.maxPreDispatchFallbackAttempts) {
      return Object.freeze({
        allowRetry: false as const,
        code: 'PRE_DISPATCH_FALLBACK_ATTEMPTS_EXHAUSTED' as const,
        mustSettleCurrentFirst: false as const,
      })
    }

    if (!PRE_DISPATCH_RETRYABLE_ERROR_SET.has(input.errorCode)) {
      return Object.freeze({
        allowRetry: false as const,
        code: 'PRE_DISPATCH_ERROR_NOT_RETRYABLE' as const,
        mustSettleCurrentFirst: false as const,
      })
    }

    const nextExcluded = new Set<string>(
      toExcludedSet(input.originalRouteInput.excludedCandidateKeys),
    )
    for (const key of input.previouslyExcludedCandidateKeys ?? []) {
      nextExcluded.add(key)
    }
    nextExcluded.add(input.failedCandidateKey)

    const sourceCandidates = input.originalRouteInput.candidates ?? this.defaultCandidates
    const failedCandidate = sourceCandidates.find(
      (c) => poolCandidateKey(c) === input.failedCandidateKey,
    )
    const failedPoolKind = input.failedPoolKind ?? failedCandidate?.poolKind

    const allowedPools = new Set<InferencePoolKind>(this.fallbackPolicy.allowedFallbackPools)
    const filteredCandidates = sourceCandidates.filter((c) => {
      if (nextExcluded.has(poolCandidateKey(c))) return false
      if (!input.allowCrossPoolMigration && failedPoolKind !== undefined) {
        return c.poolKind === failedPoolKind
      }
      return allowedPools.has(c.poolKind)
    })

    const nextRoute = await this.routeTurn({
      ...input.originalRouteInput,
      candidates: filteredCandidates,
      excludedCandidateKeys: nextExcluded,
    })

    if (!nextRoute.ok) {
      return Object.freeze({
        allowRetry: false as const,
        code: nextRoute.code,
        mustSettleCurrentFirst: false as const,
        nextRoute,
      })
    }

    return Object.freeze({
      allowRetry: true as const,
      mustAbandonPriorZeroCredit: true as const,
      nextRoute,
    })
  }

  private determineMigrationTrigger(ctx: {
    readonly migrationRequired: boolean
    readonly input: RouteTurnInput
    readonly allCandidates: readonly PoolCandidateDescriptor[]
    readonly excluded: ReadonlySet<string>
    readonly effectivePoolPreference: RouterPoolPreference
    readonly logicalModel: string
    readonly required: RequiredTurnCapabilities
    readonly bindingMap: Map<string, LogicalModelPoolBinding> | null
  }): MigrationTrigger {
    if (!ctx.migrationRequired) return 'none'

    const priorMatches = ctx.allCandidates.filter((c) => matchesCurrentPlacement(c, ctx.input))
    const preferredPool = PREFERRED_POOL_BY_PREFERENCE[ctx.effectivePoolPreference]

    // Evaluate why the prior placement was not retained
    if (priorMatches.length === 0) {
      if (preferredPool !== undefined && preferredPool !== ctx.input.currentPoolKind) {
        return 'user_preference'
      }
      return 'capacity_or_health'
    }

    let anyPriorCapable = false
    let anyPriorDraining = false
    let anyPriorHealthyWithCapacity = false

    for (const prior of priorMatches) {
      const priorKey = poolCandidateKey(prior)
      const cap = checkCapabilitySuperset(prior.manifest, ctx.logicalModel, ctx.required)
      const binding =
        ctx.bindingMap === null
          ? undefined
          : ctx.bindingMap.get(bindingLookupKey(prior.poolKind, prior.driverId))
      const bindingOk =
        ctx.bindingMap === null ||
        (binding !== undefined &&
          checkBindingCapabilitiesSuperset(binding, ctx.required).length === 0)
      const manifestIdentityOk =
        prior.manifest.poolKind === prior.poolKind && prior.manifest.driverId === prior.driverId

      if (cap.satisfied && bindingOk && manifestIdentityOk) {
        anyPriorCapable = true
      }
      if (prior.draining) {
        anyPriorDraining = true
      }
      if (
        !ctx.excluded.has(priorKey) &&
        prior.healthy &&
        !prior.draining &&
        prior.maxSlots > 0 &&
        prior.activeSlots < prior.maxSlots
      ) {
        anyPriorHealthyWithCapacity = true
      }
    }

    if (!anyPriorCapable) {
      return 'capability_driven'
    }
    if (anyPriorDraining) {
      return 'drain_cutover'
    }
    if (
      anyPriorHealthyWithCapacity &&
      preferredPool !== undefined &&
      preferredPool !== ctx.input.currentPoolKind
    ) {
      return 'user_preference'
    }
    return 'capacity_or_health'
  }
}
