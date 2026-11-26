/**
 * OCV5-907 Wave 2 (P1-1 / P1-2 + R1/R2 Audit B4/B5/B7/W1) — Narrow session-layer
 * ports & pre-create recovery / boundary export helpers for `AuthorityStateRuntime`
 * and `EngineCapsuleRuntime`.
 *
 * Layer: gateway-session (L3). Imports only `@openclaude/protocol/storage-seam`,
 * `@openclaude/storage`, `resumeStore.ts`, `engine/resumeArtifacts.ts`, and
 * `sessionManagerLog.ts` (zero upward/same-layer violations).
 */
import { join } from 'node:path'
import type {
  AuthorityEngineKind,
  SessionEnginePointer,
} from '@openclaude/protocol/storage-seam'
import { paths } from '@openclaude/storage'
import {
  ENGINE_CAPSULE_SCHEMA_VERSION,
  isCapsuleSupportedEngine,
  probeResumeArtifactForCapsule,
  resolveEngineNativeStateRoot as resolveNativeRoot,
  type ResumeArtifactContext,
} from './engine/resumeArtifacts.js'
import { normalizeEngineTag, type ResumeStore } from './resumeStore.js'
import { log } from './sessionManagerLog.js'

export interface SessionResumeSyncSnapshot {
  readonly sessionKey: string
  readonly nativeSessionId: string
  readonly providerTag?: string
  readonly history?: readonly string[]
  readonly rejectedIds?: readonly string[]
  readonly lastCost?: number
  readonly costImprecise?: boolean
  readonly promotedFromHistory?: boolean
  readonly capsuleId?: string | null
}

export interface SessionHydrateResult {
  readonly pointer: SessionEnginePointer | null
  readonly pointerHydrated: boolean
  readonly checkpointHydrated: boolean
  readonly promptStateHydrated: boolean
  readonly authorityDegraded: boolean
}

export interface SessionAuthorityRuntimePort {
  readonly isRemoteEnabled: boolean
  recordKnownEpoch(sessionKey: string, placementEpoch: number): void
  hydrateSessionIfMissing(sessionKey: string): Promise<SessionHydrateResult>
  syncResumeSnapshots(snapshots: readonly SessionResumeSyncSnapshot[]): void
  syncResumeReset(sessionKey: string, providerTag?: string): void
  persistPendingCheckpointAckIntent?(
    sessionKey: string,
    checkpointGeneration: string,
    turnKey: string,
  ): void
  ackCheckpointWriteThrough(
    sessionKey: string,
    checkpointGeneration: string,
    turnKey: string,
  ): Promise<void>
  flush(): Promise<void>
}

export interface SessionCapsuleRuntimePort {
  readonly isEnabled: boolean
  hasPendingRestore(nativeSessionId: string): boolean
  tryWarmCapsuleRestoreForSession(input: {
    readonly sessionKey: string
    readonly engine: AuthorityEngineKind
    readonly targetRoot: string
    readonly targetEngineVersion?: string
    readonly targetCwd?: string
    readonly promptStateRoot?: string
    readonly pointer?: SessionEnginePointer | null
  }): Promise<
    | { readonly status: 'not_applicable' }
    | { readonly status: 'restored'; readonly capsuleId: string }
    | { readonly status: 'degraded'; readonly reason: string; readonly capsuleId: string }
  >
  exportSessionCapsuleForBoundary?(input: {
    readonly sessionKey: string
    readonly engine: AuthorityEngineKind
    readonly nativeSessionId: string
    readonly sourceRoot: string
    readonly sourceCwd?: string
    readonly engineVersion: string
  }): Promise<boolean>
}

export function resolveEngineNativeStateRoot(
  engine: AuthorityEngineKind,
  ctx?: ResumeArtifactContext,
): string {
  return resolveNativeRoot(engine, ctx)
}

export function collectResumeSyncSnapshots(
  resumeStore: ResumeStore,
): SessionResumeSyncSnapshot[] {
  const snapshots: SessionResumeSyncSnapshot[] = []
  for (const [sessionKey, nativeSessionId] of resumeStore.ids) {
    const providerTag = resumeStore.provider.get(sessionKey)
    const history = resumeStore.history.get(sessionKey)
    const lastCost = resumeStore.lastCost.get(sessionKey)
    const costImprecise = resumeStore.costImprecise.get(sessionKey)
    const promoted = resumeStore.promotedFromHistory.get(sessionKey) === nativeSessionId
    snapshots.push({
      sessionKey,
      nativeSessionId,
      ...(providerTag !== undefined ? { providerTag } : {}),
      ...(history !== undefined ? { history } : {}),
      rejectedIds: [...(resumeStore.rejected.get(sessionKey) ?? [])],
      ...(lastCost !== undefined ? { lastCost } : {}),
      ...(costImprecise !== undefined ? { costImprecise } : {}),
      ...(promoted ? { promotedFromHistory: true } : {}),
    })
  }
  return snapshots
}

export interface PreCreateExistingSessionHandle {
  ccbSessionId?: string | null
  _lastCcbCumulativeCost?: number
  readonly runner?: {
    readonly isRunning?: boolean
    shutdown?: () => Promise<void>
    setResumeSessionId?: (id: string) => void
  }
}

/**
 * B5 / B7: Execute authority pointer/checkpoint hydration AND Tier 1.5
 * `warm_capsule` recovery inside `_getOrCreateExclusive` BEFORE runner
 * construction, backend freshness checks, and cost baseline seeding.
 */
export async function prepareSessionAuthorityBeforeCreate(args: {
  readonly authorityRuntime: SessionAuthorityRuntimePort | undefined
  readonly capsuleRuntime: SessionCapsuleRuntimePort | undefined
  readonly resumeStore: ResumeStore
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly workspaceCwd?: string
  readonly placementEpoch?: number
  readonly artifactContext?: ResumeArtifactContext
  readonly existingSession?: PreCreateExistingSessionHandle
}): Promise<void> {
  const rt = args.authorityRuntime
  if (!rt) return
  if (args.placementEpoch !== undefined) {
    rt.recordKnownEpoch(args.sessionKey, args.placementEpoch)
  }
  if (!rt.isRemoteEnabled) return

  let hydrated: SessionHydrateResult
  try {
    hydrated = await rt.hydrateSessionIfMissing(args.sessionKey)
  } catch (err) {
    log.warn('authority pre-create hydration failed (non-fatal)', {
      sessionKey: args.sessionKey,
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  // B7: If authoritative pointer references a capsule for this engine and local
  // native state is missing on a fresh/rebuilt volume (or a pending restore marker
  // blocks native resume), run Tier 1.5 warm_capsule recovery before runner spawn.
  const ptr = hydrated.pointer
  const cap = args.capsuleRuntime
  const probeCtx: ResumeArtifactContext = {
    ...(args.artifactContext ?? {}),
    ...(args.workspaceCwd ? { workspacePath: args.workspaceCwd } : {}),
  }
  if (cap?.isEnabled && ptr?.capsuleId && ptr.engine === args.engine) {
    const nativeId = ptr.nativeSessionId ?? undefined
    const hasMarker = nativeId ? cap.hasPendingRestore(nativeId) : false
    const strictProbe = nativeId
      ? probeResumeArtifactForCapsule(args.engine, nativeId, probeCtx)
      : 'missing'
    if (hasMarker || strictProbe === 'missing') {
      const targetRoot = resolveEngineNativeStateRoot(args.engine, probeCtx)
      const outcome = await cap.tryWarmCapsuleRestoreForSession({
        sessionKey: args.sessionKey,
        engine: args.engine,
        targetRoot,
        targetEngineVersion: ENGINE_CAPSULE_SCHEMA_VERSION,
        ...(args.workspaceCwd ? { targetCwd: args.workspaceCwd } : {}),
        promptStateRoot: join(probeCtx.openclaudeHome ?? paths.home, 'antigravity-cli'),
        pointer: ptr,
      })
      let degradedReason: string | null =
        outcome.status === 'degraded' ? outcome.reason : null
      // Verify restored transcript is actually visible at the engine's real root.
      if (outcome.status === 'restored' && nativeId) {
        const postProbe = probeResumeArtifactForCapsule(args.engine, nativeId, probeCtx)
        if (postProbe === 'missing') {
          degradedReason = 'restored_artifact_not_visible_at_engine_root'
        }
      }
      if (degradedReason) {
        log.warn('warm capsule recovery degraded; clearing native head for tape_rebuilt/cold fallback', {
          sessionKey: args.sessionKey,
          capsuleId: ptr.capsuleId,
          reason: degradedReason,
        })
        args.resumeStore.ids.delete(args.sessionKey)
        args.resumeStore.history.delete(args.sessionKey)
        args.resumeStore.promotedFromHistory.delete(args.sessionKey)
      }
    }
  }

  // B5: If an idle prewarmed runner already exists without a bound native ID,
  // tear down any cold running subprocess BEFORE rebinding so the first turn
  // spawns with the resumed native ID and matches the authoritative cost baseline.
  if (hydrated.pointerHydrated && args.existingSession && !args.existingSession.ccbSessionId) {
    const recoveredId = args.resumeStore.ids.get(args.sessionKey)
    const recoveredProvider = normalizeEngineTag(args.resumeStore.provider.get(args.sessionKey))
    if (recoveredId && recoveredProvider === args.engine) {
      if (args.existingSession.runner?.isRunning && args.existingSession.runner.shutdown) {
        try {
          await args.existingSession.runner.shutdown()
        } catch (err) {
          log.warn('failed shutting down cold prewarmed runner before authority rebind', {
            sessionKey: args.sessionKey,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      args.existingSession.runner?.setResumeSessionId?.(recoveredId)
      args.existingSession.ccbSessionId = recoveredId
      const baselineCost = args.resumeStore.lastCost.get(args.sessionKey)
      if (typeof baselineCost === 'number' && Number.isFinite(baselineCost) && baselineCost >= 0) {
        args.existingSession._lastCcbCumulativeCost = baselineCost
      }
    }
  }
}

/**
 * B7: Source-side production capsule publisher called on consistent stopped-runner
 * boundaries (`retireKeepResume` / planned `shutdownAll`) so target containers
 * receive an up-to-date CAS capsule before cold restart or cross-host migration.
 */
export async function exportSessionCapsuleOnSafeBoundary(args: {
  readonly capsuleRuntime: SessionCapsuleRuntimePort | undefined
  readonly sessionKey: string
  readonly engine: string | undefined
  readonly nativeSessionId: string | null | undefined
  readonly sourceCwd?: string
  readonly artifactContext?: ResumeArtifactContext
}): Promise<boolean> {
  const cap = args.capsuleRuntime
  if (!cap?.isEnabled || !cap.exportSessionCapsuleForBoundary) return false
  if (!args.nativeSessionId) return false
  const normalized = normalizeEngineTag(args.engine)
  if (!isCapsuleSupportedEngine(normalized)) {
    return false
  }
  const probeCtx: ResumeArtifactContext = {
    ...(args.artifactContext ?? {}),
    ...(args.sourceCwd ? { workspacePath: args.sourceCwd } : {}),
  }
  const probe = probeResumeArtifactForCapsule(normalized, args.nativeSessionId, probeCtx)
  if (probe !== 'present') return false
  const sourceRoot = resolveEngineNativeStateRoot(normalized, probeCtx)
  try {
    return await cap.exportSessionCapsuleForBoundary({
      sessionKey: args.sessionKey,
      engine: normalized,
      nativeSessionId: args.nativeSessionId,
      sourceRoot,
      ...(args.sourceCwd ? { sourceCwd: args.sourceCwd } : {}),
      engineVersion: ENGINE_CAPSULE_SCHEMA_VERSION,
    })
  } catch (err) {
    log.warn('boundary capsule export failed (non-fatal)', {
      sessionKey: args.sessionKey,
      engine: normalized,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

export function notifyAuthorityCheckpointAck(args: {
  readonly authorityRuntime: SessionAuthorityRuntimePort | undefined
  readonly sessionKey: string
  readonly checkpointGeneration: string
  readonly turnKey: string
}): void {
  if (!args.authorityRuntime?.isRemoteEnabled) return
  void args.authorityRuntime.ackCheckpointWriteThrough(
    args.sessionKey,
    args.checkpointGeneration,
    args.turnKey,
  )
}
