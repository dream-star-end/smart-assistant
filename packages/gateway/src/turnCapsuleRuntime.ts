/**
 * OCV5-907 Wave 2 (P1-2 + R1 Audit B2/B7/W6) — Container L4 runtime binder for
 * `UniversalEngineStateCapsuleStore`.
 *
 * Connects the 6-engine table-driven `UniversalEngineStateCapsuleStore` to Master's
 * content-addressed Artifact Blob Store (`/internal/v3/artifact-blobs/*`) and
 * `AuthorityStateRuntime` narrow capsule PATCH (`PATCH /capsule`).
 *
 * Production recovery ladder (B7):
 *   `tryWarmCapsuleRestoreForSession` is invoked inside `_getOrCreateExclusive`
 *   BEFORE runner construction when the authoritative pointer carries a `capsuleId`
 *   and local native state is missing. Corrupt/incompatible capsules or pending
 *   restore markers fail closed for native resume and transition cleanly to
 *   `tape_rebuilt` / `cold_degraded`.
 *
 * Layer: gateway-turn (L4). Zero `process.env`, zero `R3-special-case`.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AuthorityEngineKind,
  EngineStateCapsulePortability,
  SessionEnginePointer,
} from '@openclaude/protocol/storage-seam'
import { paths } from '@openclaude/storage'
import { createLogger } from './logger.js'
import {
  AuthorityStateRuntime,
  resolveContainerAuthorityCredentials,
} from './turnAuthorityRuntime.js'
import {
  ANTIGRAVITY_PROMPT_STATE_ENGINE,
  setAntigravityPromptStateObserver,
} from './engine/antigravityPromptState.js'
import { setLocalCheckpointSavedObserver } from './sessionCheckpointStore.js'
import type { SessionManager } from './sessionManager.js'
import {
  RemoteArtifactBlobStore,
  RemoteSessionAuthorityStore,
  UniversalEngineStateCapsuleStore,
  hasPendingRestoreMarker,
  type ChunkedArtifactBlobStore,
  type ExportCapsuleResult,
  type ImportCapsuleResult,
} from './storageSeam/index.js'

const log = createLogger({ module: 'turnCapsuleRuntime' })

const CAPSULE_META_KEY = '_capsuleMeta'

export interface CapsuleRuntimeOptions {
  readonly tenantId?: string
  readonly stateRoot?: string
  readonly blobStore?: ChunkedArtifactBlobStore | null
  readonly authorityRuntime?: AuthorityStateRuntime | null
  readonly env?: NodeJS.ProcessEnv
}

export interface ExportSessionCapsuleInput {
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly engineVersion: string
  readonly placementEpoch: number
  readonly expectedPlacementEpoch?: number
  readonly nativeSessionId?: string | null
  readonly sourceRoot: string
  readonly sourceCwd?: string
  readonly portability?: EngineStateCapsulePortability
}

export interface ExportSessionCapsuleOutcome {
  readonly exported: ExportCapsuleResult
  readonly manifestBlobId: string
  readonly authorityUpdated: boolean
}

export interface ImportSessionCapsuleInput {
  readonly sessionKey: string
  readonly engine: AuthorityEngineKind
  readonly targetRoot: string
  readonly targetEngineVersion?: string
  readonly targetCwd?: string
  readonly promptStateRoot?: string
  readonly pointer?: SessionEnginePointer | null
}

export type WarmCapsuleRestoreOutcome =
  | { readonly status: 'not_applicable' }
  | { readonly status: 'restored'; readonly capsuleId: string }
  | { readonly status: 'degraded'; readonly reason: string; readonly capsuleId: string }

function extractManifestBlobId(
  meta: Readonly<Record<string, unknown>> | null | undefined,
  capsuleId: string,
): string | undefined {
  if (!meta) return undefined
  const capsuleMeta = meta[CAPSULE_META_KEY]
  if (!capsuleMeta || typeof capsuleMeta !== 'object' || Array.isArray(capsuleMeta)) {
    return undefined
  }
  const rec = capsuleMeta as Record<string, unknown>
  if (rec.capsuleId === capsuleId && typeof rec.manifestBlobId === 'string' && rec.manifestBlobId) {
    return rec.manifestBlobId
  }
  return undefined
}

export class EngineCapsuleRuntime {
  readonly tenantId: string
  readonly stateRoot: string
  readonly blobStore: ChunkedArtifactBlobStore | null
  readonly capsuleStore: UniversalEngineStateCapsuleStore | null
  private readonly authorityRuntime: AuthorityStateRuntime | null

  constructor(options: CapsuleRuntimeOptions = {}) {
    this.tenantId = options.tenantId ?? 'container-self'
    this.stateRoot = options.stateRoot ?? join(paths.home, 'capsule-state')
    this.authorityRuntime = options.authorityRuntime ?? null

    const explicitlyDisabled = options.env?.OC_CAPSULE_RUNTIME_ENABLED === '0'
    let blobStore = explicitlyDisabled ? null : (options.blobStore ?? null)
    if (!explicitlyDisabled && !blobStore) {
      const creds = resolveContainerAuthorityCredentials(options.env)
      if (creds && !creds.capsuleRuntimeDisabled) {
        blobStore = new RemoteArtifactBlobStore({
          masterBaseUrl: creds.masterBaseUrl,
          containerToken: creds.containerToken,
        })
      }
    }
    this.blobStore = blobStore
    this.capsuleStore = blobStore
      ? new UniversalEngineStateCapsuleStore({
          blobStore,
          stateRoot: this.stateRoot,
        })
      : null
  }

  get isEnabled(): boolean {
    return this.capsuleStore !== null
  }

  hasPendingRestore(nativeSessionId: string): boolean {
    return hasPendingRestoreMarker(this.stateRoot, nativeSessionId)
  }

  /** Export native engine state to CAS and publish via narrow `PATCH /capsule` (B2). */
  async exportSessionCapsuleToAuthority(
    input: ExportSessionCapsuleInput,
  ): Promise<ExportSessionCapsuleOutcome | null> {
    if (!this.capsuleStore || !this.blobStore) return null

    const exported = await this.capsuleStore.exportCapsule({
      tenantId: this.tenantId,
      sessionKey: input.sessionKey,
      engine: input.engine,
      engineVersion: input.engineVersion,
      placementEpoch: input.placementEpoch,
      ...(input.nativeSessionId !== undefined ? { nativeSessionId: input.nativeSessionId } : {}),
      sourceRoot: input.sourceRoot,
      ...(input.sourceCwd ? { sourceCwd: input.sourceCwd } : {}),
      ...(input.portability ? { portability: input.portability } : {}),
    })

    const sidecarPayload = Buffer.from(
      JSON.stringify({
        manifest: exported.manifest,
        ...(input.sourceCwd ? { sourceCwd: input.sourceCwd } : {}),
        ...(exported.promptCacheMeta ? { promptCacheMeta: exported.promptCacheMeta } : {}),
        ...(exported.usageBaseline ? { usageBaseline: exported.usageBaseline } : {}),
        blobRefs: exported.blobRefs,
      }),
      'utf8',
    )
    const manifestBlob = await this.blobStore.put({
      tenantId: this.tenantId,
      kind: 'capsule_file',
      mimeType: 'application/json',
      bytes: new Uint8Array(sidecarPayload),
      logicalName: `${exported.ref.capsuleId}.manifest.json`,
      containerRelativePath: `capsules/${exported.ref.capsuleId}.manifest.json`,
    })

    let authorityUpdated = false
    const authStore = this.authorityRuntime?.authorityStore
    if (this.authorityRuntime?.isRemoteEnabled && authStore) {
      try {
        const expectedEpoch = input.expectedPlacementEpoch ?? input.placementEpoch
        if (authStore instanceof RemoteSessionAuthorityStore) {
          const ptr = await authStore.patchCapsuleRef({
            sessionKey: input.sessionKey,
            engine: input.engine,
            expectedPlacementEpoch: expectedEpoch,
            capsuleId: exported.ref.capsuleId,
            manifestBlobId: manifestBlob.blobId,
            engineVersion: input.engineVersion,
            createdAt: exported.ref.createdAt,
            ...(input.nativeSessionId !== undefined ? { nativeSessionId: input.nativeSessionId } : {}),
            ...(exported.usageBaseline !== undefined ? { usageBaseline: exported.usageBaseline } : {}),
          })
          this.authorityRuntime.recordOwnedEpoch(input.sessionKey, ptr.placementEpoch)
          authorityUpdated = true
        } else {
          const existing = await authStore.getPointer(this.tenantId, input.sessionKey)
          const mergedMeta: Record<string, unknown> = {
            ...(existing?.promptCacheMeta ?? {}),
            [CAPSULE_META_KEY]: {
              capsuleId: exported.ref.capsuleId,
              manifestBlobId: manifestBlob.blobId,
              engine: input.engine,
              engineVersion: input.engineVersion,
              placementEpoch: input.placementEpoch,
              createdAt: exported.ref.createdAt,
            },
          }
          const writeRes = await this.authorityRuntime.bridge.writePointer({
            sessionKey: input.sessionKey,
            placementEpoch: input.placementEpoch,
            ...(input.expectedPlacementEpoch !== undefined
              ? { expectedPlacementEpoch: input.expectedPlacementEpoch }
              : {}),
            poolKind: existing?.poolKind,
            engine: input.engine,
            nativeSessionId:
              input.nativeSessionId ?? existing?.nativeSessionId ?? null,
            operationId: existing?.operationId,
            profileId: existing?.profileId,
            capsuleId: exported.ref.capsuleId,
            promptCacheMeta: mergedMeta,
            usageBaseline: exported.usageBaseline ?? existing?.usageBaseline ?? null,
          })
          authorityUpdated = !writeRes.authorityDegraded
        }
      } catch (err) {
        log.warn('capsule export succeeded in CAS but authority pointer update failed', {
          sessionKey: input.sessionKey,
          capsuleId: exported.ref.capsuleId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return {
      exported,
      manifestBlobId: manifestBlob.blobId,
      authorityUpdated,
    }
  }

  async importSessionCapsuleFromAuthority(
    input: ImportSessionCapsuleInput,
  ): Promise<ImportCapsuleResult | null> {
    if (!this.capsuleStore) return null
    let pointer = input.pointer ?? null
    if (!pointer && this.authorityRuntime?.isRemoteEnabled && this.authorityRuntime.authorityStore) {
      pointer = await this.authorityRuntime.authorityStore.getPointer(
        this.tenantId,
        input.sessionKey,
      )
    }
    if (!pointer?.capsuleId || pointer.engine !== input.engine) {
      return null
    }
    if (!existsSync(input.targetRoot)) {
      mkdirSync(input.targetRoot, { recursive: true, mode: 0o700 })
    }
    const manifestBlobId = extractManifestBlobId(pointer.promptCacheMeta, pointer.capsuleId)
    return this.capsuleStore.importCapsule({
      tenantId: this.tenantId,
      capsuleId: pointer.capsuleId,
      targetRoot: input.targetRoot,
      stateRoot: this.stateRoot,
      expectedSessionKey: input.sessionKey,
      expectedEngine: input.engine,
      ...(pointer.nativeSessionId ? { expectedNativeSessionId: pointer.nativeSessionId } : {}),
      ...(input.targetEngineVersion ? { targetEngineVersion: input.targetEngineVersion } : {}),
      ...(input.targetCwd ? { targetCwd: input.targetCwd } : {}),
      ...(input.promptStateRoot ? { promptStateRoot: input.promptStateRoot } : {}),
      ...(manifestBlobId ? { manifestBlobId } : {}),
    })
  }

  /**
   * B7: Production source-side capsule publisher called on consistent stopped-runner
   * boundaries (`retireKeepResume` / planned `shutdownAll`).
   */
  async exportSessionCapsuleForBoundary(input: {
    readonly sessionKey: string
    readonly engine: AuthorityEngineKind
    readonly nativeSessionId: string
    readonly sourceRoot: string
    readonly sourceCwd?: string
    readonly engineVersion: string
  }): Promise<boolean> {
    if (!this.isEnabled) return false
    const placementEpoch =
      this.authorityRuntime?.getOwnedHeadEpoch(input.sessionKey) ??
      this.authorityRuntime?.getObservedAuthorityEpoch(input.sessionKey) ??
      1
    const outcome = await this.exportSessionCapsuleToAuthority({
      sessionKey: input.sessionKey,
      engine: input.engine,
      engineVersion: input.engineVersion,
      placementEpoch,
      expectedPlacementEpoch: placementEpoch,
      nativeSessionId: input.nativeSessionId,
      sourceRoot: input.sourceRoot,
      ...(input.sourceCwd ? { sourceCwd: input.sourceCwd } : {}),
    })
    return Boolean(outcome?.authorityUpdated)
  }

  /**
   * B7: Production warm-capsule recovery entry invoked by `_getOrCreateExclusive`
   * before runner construction. Checks pending restore markers and attempts
   * capsule import; returns `degraded` on corruption/incompatibility so the
   * caller clears native resume and falls back cleanly to `tape_rebuilt`.
   */
  async tryWarmCapsuleRestoreForSession(
    input: ImportSessionCapsuleInput,
  ): Promise<WarmCapsuleRestoreOutcome> {
    if (!this.capsuleStore) return { status: 'not_applicable' }
    const pointer = input.pointer
    if (!pointer?.capsuleId || pointer.engine !== input.engine) {
      return { status: 'not_applicable' }
    }
    if (pointer.nativeSessionId && this.hasPendingRestore(pointer.nativeSessionId)) {
      return {
        status: 'degraded',
        reason: 'pending_restore_marker_present',
        capsuleId: pointer.capsuleId,
      }
    }
    try {
      const res = await this.importSessionCapsuleFromAuthority(input)
      if (!res) return { status: 'not_applicable' }
      if (res.status === 'imported') {
        return { status: 'restored', capsuleId: pointer.capsuleId }
      }
      return {
        status: 'degraded',
        reason: `${res.status}:${res.reason}`,
        capsuleId: pointer.capsuleId,
      }
    } catch (err) {
      return {
        status: 'degraded',
        reason: err instanceof Error ? err.message : String(err),
        capsuleId: pointer.capsuleId,
      }
    }
  }
}

/**
 * Install Wave 2 `AuthorityStateRuntime` and `EngineCapsuleRuntime` onto a
 * container `SessionManager`. W6: isolates optional capsule runtime init so a
 * read-only or unavailable capsule state directory can never crash Gateway boot.
 */
export function installTurnAuthorityRuntime(sessions: SessionManager): {
  readonly authorityRuntime: AuthorityStateRuntime
  readonly capsuleRuntime: EngineCapsuleRuntime | undefined
} {
  const resumeStore = sessions.getResumeStore()
  const authorityRuntime = new AuthorityStateRuntime({
    resumeStore,
    onConflictQuarantine: (sessionKey) => sessions.quarantineSessionResume(sessionKey),
  })
  sessions.authorityStateRuntime = authorityRuntime

  let capsuleRuntime: EngineCapsuleRuntime | undefined
  try {
    capsuleRuntime = new EngineCapsuleRuntime({ authorityRuntime })
    sessions.capsuleRuntime = capsuleRuntime
  } catch (err) {
    log.warn('capsule runtime disabled due to initialization failure (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
    capsuleRuntime = undefined
  }

  if (authorityRuntime.isRemoteEnabled) {
    setAntigravityPromptStateObserver((state) => {
      void authorityRuntime.syncPromptStateWriteThrough(state, ANTIGRAVITY_PROMPT_STATE_ENGINE)
    })
    setLocalCheckpointSavedObserver((record) => {
      void authorityRuntime.syncLocalCheckpointWriteThrough(record)
    })
    authorityRuntime.triggerBackgroundReplay()
  }
  return { authorityRuntime, capsuleRuntime }
}
