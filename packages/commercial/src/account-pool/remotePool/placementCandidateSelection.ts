/**
 * In-transaction `remote-driver-v4` candidate readiness, capability re-verification, and
 * sticky/router selection helpers (`OCV5-928` B5, `accounts` L3).
 */
import type { RemoteProbeSnapshot, RequiredTurnCapabilities } from '@openclaude/protocol'
import type { PoolClient } from 'pg'
import { type RemoteBrainEngine, rankRemotePoolCandidates } from '../remoteBrainPool.js'
import { verifyProfileReadyForV4 } from './driftCoordinator.js'
import type { RemoteDriverRegistryEntry } from './registry.js'
import { doesRemoteProfileSatisfyCapabilities } from './remoteDriverRouterSelection.js'

export interface StickyBindingSummary {
  readonly operation_id: string
  readonly run_id: string
  readonly profile_id: string
  readonly generation: string
  readonly native_session_id: string | null
}

export interface ReadyProfileEntry {
  readonly snapshot: RemoteProbeSnapshot
  readonly fingerprint: string
  readonly effectiveCap: number
}

export interface CollectedV4Candidates {
  readonly eligible: Array<Record<string, unknown>>
  readonly readyMap: Map<string, ReadyProfileEntry>
  readonly fullProfiles: Set<string>
  readonly reverifyProfiles: Set<string>
  readonly staleProfiles: Set<string>
  readonly capabilityUnsatisfiedProfiles: Set<string>
}

function effectiveProfileCap(
  row: Record<string, unknown>,
  reg: RemoteDriverRegistryEntry,
  sandboxMode?: 'account_mutex' | 'shared_node_cap_5',
): number {
  if (sandboxMode === 'account_mutex') return 1
  if (sandboxMode === 'shared_node_cap_5') return 5
  return Math.min(Number(row.max_concurrent_lanes), reg.profileMaxLanes)
}

export async function collectEligibleV4Candidates(params: {
  readonly client: PoolClient
  readonly candidates: ReadonlyArray<Record<string, unknown>>
  readonly reg: RemoteDriverRegistryEntry
  readonly canonicalModel: string
  readonly requiredCapabilities?: RequiredTurnCapabilities
  readonly nowMs: number
  readonly maxProbeAgeMs: number
  readonly testFaultSandboxMode?: 'account_mutex' | 'shared_node_cap_5'
}): Promise<CollectedV4Candidates> {
  const readyMap = new Map<string, ReadyProfileEntry>()
  const eligible: Array<Record<string, unknown>> = []
  const fullProfiles = new Set<string>()
  const reverifyProfiles = new Set<string>()
  const staleProfiles = new Set<string>()
  const capabilityUnsatisfiedProfiles = new Set<string>()
  const observedAtIso = new Date(params.nowMs).toISOString()

  for (const row of params.candidates) {
    const pid = String(row.profile_id)
    const check = verifyProfileReadyForV4(
      row,
      params.reg.driverDigest,
      params.reg.coreDigest,
      params.nowMs,
      params.maxProbeAgeMs,
    )
    if (!check.ready) {
      if (check.reason === 'reverify') reverifyProfiles.add(pid)
      else staleProfiles.add(pid)
      continue
    }
    if (
      !doesRemoteProfileSatisfyCapabilities({
        canonicalModel: params.canonicalModel,
        upstreamModelId: String(row.upstream_model_id ?? params.canonicalModel),
        probeSnapshot: check.snapshot,
        reg: params.reg,
        requiredCapabilities: params.requiredCapabilities,
        observedAt: observedAtIso,
      })
    ) {
      capabilityUnsatisfiedProfiles.add(pid)
      continue
    }
    const isSharedCap = params.testFaultSandboxMode === 'shared_node_cap_5'
    const usedRes = await params.client.query<{ profile_used: number }>(
      isSharedCap
        ? `SELECT COUNT(*)::int AS profile_used FROM remote_agent_bindings WHERE node_id = $1 AND state <> 'released'`
        : `SELECT COUNT(*)::int AS profile_used FROM remote_agent_bindings WHERE profile_id = $1 AND state <> 'released'`,
      [isSharedCap ? row.node_id : row.profile_id],
    )
    const used = Number(usedRes.rows[0]?.profile_used ?? 0)
    const cap = effectiveProfileCap(row, params.reg, params.testFaultSandboxMode)
    if (used >= cap) {
      fullProfiles.add(pid)
      continue
    }
    readyMap.set(pid, { snapshot: check.snapshot, fingerprint: check.fingerprint, effectiveCap: cap })
    eligible.push(row)
  }
  return { eligible, readyMap, fullProfiles, reverifyProfiles, staleProfiles, capabilityUnsatisfiedProfiles }
}

function findPreferredOrRankedRow(params: {
  readonly eligible: ReadonlyArray<Record<string, unknown>>
  readonly driverId: string
  readonly preferredProfileId?: string
  readonly preferredNodeId?: string
  readonly rankedCandidateKeys?: readonly string[]
}): Record<string, unknown> | undefined {
  if (params.preferredProfileId) {
    const direct = params.eligible.find(
      (r) =>
        String(r.profile_id) === params.preferredProfileId &&
        (!params.preferredNodeId || String(r.node_id) === params.preferredNodeId),
    )
    if (direct) return direct
  }
  if (!params.rankedCandidateKeys) return undefined
  for (const key of params.rankedCandidateKeys) {
    const parts = key.split(':')
    if (parts[0] !== 'remote_pool' || parts[1] !== params.driverId || !parts[2]) continue
    const hit = params.eligible.find(
      (r) =>
        String(r.profile_id) === parts[2] &&
        (!parts[3] || parts[3] === '-' || String(r.node_id) === parts[3]),
    )
    if (hit) return hit
  }
  return undefined
}

function rankFallbackRow(params: {
  readonly eligible: ReadonlyArray<Record<string, unknown>>
  readonly readyMap: ReadonlyMap<string, ReadyProfileEntry>
  readonly reg: RemoteDriverRegistryEntry
  readonly legacyProfileEngine: RemoteBrainEngine
  readonly affinityKey: string
}): Record<string, unknown> | undefined {
  const ranked = rankRemotePoolCandidates(
    params.eligible.map((r) => ({
      profileId: String(r.profile_id),
      nodeId: String(r.node_id),
      engine: (r.engine as RemoteBrainEngine | undefined) ?? params.legacyProfileEngine,
      profileName: String(r.profile_name),
      weight: Number(r.weight ?? 100),
      healthScore:
        r.node_status === 'degraded'
          ? Math.min(Number(r.health_score ?? 100), 60)
          : Number(r.health_score ?? 100),
      hotSlots: Number(r.hot_slots ?? 0),
      activeSlots: Number(r.active_slots ?? 0),
      maxHotSlots: Math.max(Number(r.max_hot_slots ?? 8), params.reg.profileMaxLanes),
      maxActiveSlots: params.readyMap.get(String(r.profile_id))!.effectiveCap,
      nodeRttMsP50: r.rtt_ms_p50 == null ? null : Number(r.rtt_ms_p50),
    })),
    params.affinityKey,
  )
  return params.eligible.find((r) => String(r.profile_id) === ranked[0]?.profileId)
}

function throwUnavailableReason(
  collected: CollectedV4Candidates,
  stickyProfileId?: string,
): never {
  const exhausted = (profiles: string[]) =>
    Object.assign(new Error('REMOTE_LANE_CAPACITY_EXHAUSTED'), { profiles })
  if (stickyProfileId !== undefined) {
    if (collected.capabilityUnsatisfiedProfiles.has(stickyProfileId)) throw new Error('CAPABILITY_UNSATISFIED')
    if (collected.reverifyProfiles.has(stickyProfileId)) throw new Error('REMOTE_DRIVER_REVERIFY_REQUIRED')
    if (collected.staleProfiles.has(stickyProfileId)) throw new Error('REMOTE_DRIVER_PROBE_STALE')
    if (collected.fullProfiles.has(stickyProfileId)) throw exhausted([stickyProfileId])
    throw new Error('REMOTE_LANE_PROFILE_UNAVAILABLE')
  }
  if (collected.fullProfiles.size > 0) throw exhausted([...collected.fullProfiles])
  if (collected.reverifyProfiles.size > 0) throw new Error('REMOTE_DRIVER_REVERIFY_REQUIRED')
  if (collected.staleProfiles.size > 0) throw new Error('REMOTE_DRIVER_PROBE_STALE')
  if (collected.capabilityUnsatisfiedProfiles.size > 0) throw new Error('CAPABILITY_UNSATISFIED')
  throw new Error('NO_ELIGIBLE_REMOTE_PROFILE')
}

export async function selectEligibleV4ProfileOrThrow(params: {
  readonly collected: CollectedV4Candidates
  readonly sticky?: StickyBindingSummary
  readonly allowStickyFailover?: boolean
  readonly reg: RemoteDriverRegistryEntry
  readonly legacyProfileEngine: RemoteBrainEngine
  readonly uidStr: string
  readonly effectiveSessionKey: string
  readonly canonicalModel: string
  readonly preferredProfileId?: string
  readonly preferredNodeId?: string
  readonly rankedCandidateKeys?: readonly string[]
  readonly guardPendingBilling: (priorOpId: string | null) => Promise<void>
}): Promise<{
  readonly selectedRow: Record<string, unknown>
  readonly verifiedProbe: RemoteProbeSnapshot
  readonly activeFingerprint: string
  readonly effectiveSticky?: StickyBindingSummary
  readonly migratedFromProfileId?: string
}> {
  const { collected, sticky } = params
  const priorOpId = sticky?.operation_id ?? null
  let effectiveSticky = sticky
  let migratedFromProfileId: string | undefined
  let selectedRow: Record<string, unknown> | undefined

  if (sticky) {
    selectedRow = collected.eligible.find((r) => String(r.profile_id) === sticky.profile_id)
    if (!selectedRow && params.allowStickyFailover === true && collected.eligible.length > 0) {
      migratedFromProfileId = sticky.profile_id
      effectiveSticky = undefined
    } else if (!selectedRow) {
      await params.guardPendingBilling(priorOpId)
      throwUnavailableReason(collected, sticky.profile_id)
    }
  }
  if (!effectiveSticky) {
    selectedRow =
      findPreferredOrRankedRow({
        eligible: collected.eligible,
        driverId: params.reg.driverId,
        preferredProfileId: params.preferredProfileId,
        preferredNodeId: params.preferredNodeId,
        rankedCandidateKeys: params.rankedCandidateKeys,
      }) ??
      rankFallbackRow({
        eligible: collected.eligible,
        readyMap: collected.readyMap,
        reg: params.reg,
        legacyProfileEngine: params.legacyProfileEngine,
        affinityKey: `${params.uidStr}:${params.effectiveSessionKey}:${params.canonicalModel}`,
      })
    if (!selectedRow) {
      await params.guardPendingBilling(priorOpId)
      throwUnavailableReason(collected)
    }
  }
  const info = collected.readyMap.get(String(selectedRow!.profile_id))!
  await params.guardPendingBilling(priorOpId)
  return {
    selectedRow: selectedRow!,
    verifiedProbe: info.snapshot,
    activeFingerprint: info.fingerprint,
    ...(effectiveSticky ? { effectiveSticky } : {}),
    ...(migratedFromProfileId ? { migratedFromProfileId } : {}),
  }
}
