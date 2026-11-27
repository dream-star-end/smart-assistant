/**
 * OCV5-907 Wave 2 (P1-1 + R1/R2 Audit B1/B2/B3/B4/B6/W1/W5/W6/W7) — Container L4
 * runtime binder for `AuthorityStateBridge`.
 *
 * Key invariants:
 * - B1: Separates `observedAuthorityEpochs` (from GET/grants, used for B6 checkpoint
 *   scoping) from `ownedHeadEpochs` (provenance of the local head). Unowned legacy
 *   resume-map heads NEVER borrow an observed epoch — they only submit
 *   `createIfAbsentOnly: true` and are quarantined (memory + disk + live runner) on 409.
 * - B2: Uses narrow container-owned PATCH endpoints (`patchResumePointer`,
 *   `patchPromptState`) so placement fields (`pool_kind`, `operation_id`,
 *   `profile_id`) and master-reserved metadata (`pendingInstallMigration`,
 *   `_capsuleMeta`) are NEVER overwritten by routine container saves.
 * - B3 / W7: Per-session coalescing slot (`localRev` / `desired` / `inFlightRev`
 *   / `ackedFp`) + first-create chain provenance (`inheritCreatedEpoch`) ensures
 *   `A -> B` and `A -> reset` queued before initial create ACK inherit A's confirmed
 *   epoch without self-409, while unowned legacy heads never inherit GET epochs.
 * - B4: Explicit semantic resets & local compaction checkpoints persist durable
 *   pending-authority-ops on disk; compact resets wait for local checkpoint write
 *   confirmation before clearing the remote head (preserving summary durability).
 * - B6: Monotonic `epochRev` invalidates in-flight stale GET reads when a higher
 *   grant arrives; checkpoint installation re-verifies `observedAuthorityEpochs`.
 * - W1: Durable pending-ack intent is written BEFORE local consume; `hydrateSessionIfMissing`
 *   only replays pending entries for its own `sessionKey` (never blocking unrelated
 *   sessions), while cross-session replay runs in a bounded single-flight background task.
 * - W5: Enforces legacy CCB `historyContextVersion` compatibility, clears fields on
 *   null/empty authoritative values, and restores Antigravity `promptState` silently.
 * - W6: Negative-caches HTTP 404 (legacy Master without Wave 2 endpoints).
 *
 * Layer: gateway-turn (L4). Zero `process.env`, zero `R3-special-case`.
 */
import { join } from 'node:path'
import {
  AUTHORITY_ENGINE_KINDS,
  type AuthoritativeRollingCheckpoint,
  type AuthorityEngineKind,
  type SessionAuthorityStore,
  type SessionEnginePointer,
} from '@openclaude/protocol/storage-seam'
import { paths } from '@openclaude/storage'
import { createLogger } from './logger.js'
import {
  CCB_PROVIDER_TAG,
  CCB_RESUME_HISTORY_CONTEXT_VERSION,
  normalizeEngineTag,
  type ResumeStore,
} from './resumeStore.js'
import {
  enqueuePendingAuthorityAck,
  enqueuePendingAuthorityOp,
  listPendingAuthorityAcks,
  listPendingAuthorityOps,
  peekPendingCheckpoint,
  removePendingAuthorityAck,
  removePendingAuthorityOp,
  savePendingCheckpointWithGeneration,
  type PendingAuthorityOpEntry,
  type PersistedCheckpointRecord,
} from './sessionCheckpointStore.js'
import {
  restoreAntigravityPromptStateSilently,
  type AntigravityInjectedContextState,
} from './engine/antigravityPromptState.js'
import { readV3MasterSinkConfig } from './v3MasterSink.js'
import {
  AuthorityStateBridge,
  PlacementEpochConflictError,
  RemoteSessionAuthorityStore,
  isAuthorityEndpointUnsupportedError,
  type LocalPromptStateRecord,
  type NarrowResumePatchInput,
} from './storageSeam/index.js'

const log = createLogger({ module: 'turnAuthorityRuntime' })

const VALID_ENGINES: ReadonlySet<string> = new Set<string>(AUTHORITY_ENGINE_KINDS)
const UNSUPPORTED_NEG_CACHE_MS = 5 * 60_000
const BACKGROUND_REPLAY_BUDGET_MS = 8_000
const BACKGROUND_REPLAY_MIN_BACKOFF_MS = 500
const BACKGROUND_REPLAY_MAX_BACKOFF_MS = 30_000
const CONVERSATION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ContainerAuthorityCredentials { readonly masterBaseUrl: string; readonly containerToken: string; readonly capsuleRuntimeDisabled?: boolean }

export function resolveContainerAuthorityCredentials(env?: NodeJS.ProcessEnv): ContainerAuthorityCredentials | null {
  const cfg = readV3MasterSinkConfig(env)
  if (!cfg) return null
  return { masterBaseUrl: cfg.baseUrl, containerToken: cfg.bearer, ...(cfg.capsuleRuntimeDisabled ? { capsuleRuntimeDisabled: true } : {}) }
}

function toAuthorityEngine(raw: string | undefined): AuthorityEngineKind {
  const normalized = normalizeEngineTag(raw)
  return VALID_ENGINES.has(normalized) ? (normalized as AuthorityEngineKind) : CCB_PROVIDER_TAG
}

function isConflictErr(err: unknown): boolean {
  if (err instanceof PlacementEpochConflictError) return true
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (
      code === 'SESSION_PLACEMENT_EPOCH_MISMATCH' ||
      code === 'SESSION_PLACEMENT_MIGRATING' ||
      code === 'CHECKPOINT_PLACEMENT_EPOCH_MISMATCH' ||
      code === 'PLACEMENT_EPOCH_CONFLICT'
    ) {
      return true
    }
    const msg = (err as { message?: unknown }).message
    if (
      typeof msg === 'string' &&
      (msg.includes('SESSION_PLACEMENT_EPOCH_MISMATCH') ||
        msg.includes('SESSION_PLACEMENT_MIGRATING') ||
        msg.includes('CHECKPOINT_PLACEMENT_EPOCH_MISMATCH') ||
        msg.includes('PLACEMENT_EPOCH_CONFLICT'))
    ) {
      return true
    }
  }
  return false
}

function extractPromptState(
  sessionKey: string,
  meta: Readonly<Record<string, unknown>> | null | undefined,
): AntigravityInjectedContextState | null {
  if (!meta) return null
  const raw =
    meta.promptState && typeof meta.promptState === 'object' && !Array.isArray(meta.promptState)
      ? (meta.promptState as Record<string, unknown>)
      : meta
  if (
    typeof raw.conversationId !== 'string' ||
    !CONVERSATION_UUID_RE.test(raw.conversationId) ||
    typeof raw.inputsKey !== 'string' ||
    raw.inputsKey.length !== 64 ||
    typeof raw.injectedAfterBaseline !== 'number' ||
    !Number.isSafeInteger(raw.injectedAfterBaseline) ||
    raw.injectedAfterBaseline < -1
  ) {
    return null
  }
  let slotHashes: Record<string, string> | undefined
  if (raw.slotHashes && typeof raw.slotHashes === 'object' && !Array.isArray(raw.slotHashes)) {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw.slotHashes as Record<string, unknown>)) {
      if (typeof v === 'string') clean[k] = v
    }
    slotHashes = clean
  }
  return {
    v: 1,
    sessionKey,
    conversationId: raw.conversationId,
    inputsKey: raw.inputsKey,
    ...(slotHashes ? { slotHashes } : {}),
    injectedAfterBaseline: raw.injectedAfterBaseline,
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : Date.now(),
  }
}

export interface ResumePointerSyncSnapshot {
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

type DesiredResumeOp =
  | {
      readonly kind: 'upsert'
      readonly rev: number
      readonly fp: string
      readonly snap: ResumePointerSyncSnapshot
      readonly sourceEpoch: number | undefined
      readonly inheritCreatedEpoch: boolean
    }
  | {
      readonly kind: 'reset'
      readonly rev: number
      readonly fp: string
      readonly engine: AuthorityEngineKind
      readonly sourceEpoch: number | undefined
      readonly inheritCreatedEpoch: boolean
      readonly pendingOpId: string
      readonly afterCheckpointGeneration?: string
    }

interface SessionSyncSlot {
  localRev: number
  epochRev: number
  desired: DesiredResumeOp | null
  inFlightRev: number
  ackedFp: string | null
  running: boolean
  resetTombstone: boolean
  quarantined: boolean
  quarantinedHead: string | null
  activePromise: Promise<void> | null
}

export interface AuthorityStateRuntimeOptions {
  readonly tenantId?: string
  readonly resumeStore: ResumeStore
  readonly authorityStore?: SessionAuthorityStore | null
  readonly checkpointBaseDir?: string
  readonly antigravityRootDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => number
  /** B1: Callback invoked on HTTP 409 quarantine to unbind live runner & persist cleaned disk map. */
  readonly onConflictQuarantine?: (sessionKey: string) => void
}

export interface HydrateSessionResult {
  readonly pointer: SessionEnginePointer | null
  readonly pointerHydrated: boolean
  readonly checkpointHydrated: boolean
  readonly promptStateHydrated: boolean
  readonly authorityDegraded: boolean
}

export class AuthorityStateRuntime {
  readonly tenantId: string
  readonly bridge: AuthorityStateBridge
  readonly authorityStore: SessionAuthorityStore | null
  /** B1: Observed authoritative epochs (from GET/grants). Used for B6 scoping ONLY — never authorizes unowned local heads. */
  readonly observedAuthorityEpochs = new Map<string, number>()
  /** B1: Provenance epochs for local heads actually adopted from or confirmed by Master. */
  readonly ownedHeadEpochs = new Map<string, number>()
  /** Back-compat alias exposing owned head epochs for diagnostic/tests. */
  get knownEpochs(): Map<string, number> {
    return this.ownedHeadEpochs
  }
  private readonly resumeStore: ResumeStore
  private readonly checkpointBaseDir?: string
  private readonly antigravityRootDir: string
  private readonly now: () => number
  private readonly onConflictQuarantine?: (sessionKey: string) => void
  private readonly slots = new Map<string, SessionSyncSlot>()
  private readonly sideOps = new Set<Promise<void>>()
  private readonly inFlightCheckpointWrites = new Map<
    string,
    { readonly generation: string; readonly promise: Promise<boolean> }
  >()
  private readonly enabled: boolean
  private unsupportedUntilMs = 0
  private backgroundReplayPromise: Promise<void> | null = null
  private backgroundReplayNextAllowedMs = 0
  private backgroundReplayFailures = 0

  constructor(options: AuthorityStateRuntimeOptions) {
    this.tenantId = options.tenantId ?? 'container-self'
    this.resumeStore = options.resumeStore
    this.checkpointBaseDir = options.checkpointBaseDir
    this.antigravityRootDir = options.antigravityRootDir ?? join(paths.home, 'antigravity-cli')
    this.now = options.now ?? (() => Date.now())
    this.onConflictQuarantine = options.onConflictQuarantine

    let authorityStore = options.authorityStore ?? null
    if (!authorityStore) {
      const creds = resolveContainerAuthorityCredentials(options.env)
      if (creds) {
        authorityStore = new RemoteSessionAuthorityStore({
          masterBaseUrl: creds.masterBaseUrl,
          containerToken: creds.containerToken,
        })
      }
    }
    this.authorityStore = authorityStore
    this.enabled = authorityStore !== null
    this.bridge = new AuthorityStateBridge({
      tenantId: this.tenantId,
      authorityStore,
      defaultPoolKind: 'local_container',
    })
  }

  get isRemoteEnabled(): boolean {
    if (!this.enabled) return false
    return this.now() >= this.unsupportedUntilMs
  }

  getOwnedHeadEpoch(sessionKey: string): number | undefined {
    return this.ownedHeadEpochs.get(sessionKey)
  }

  getObservedAuthorityEpoch(sessionKey: string): number | undefined {
    return this.observedAuthorityEpochs.get(sessionKey)
  }

  private slotFor(sessionKey: string): SessionSyncSlot {
    let slot = this.slots.get(sessionKey)
    if (!slot) {
      slot = {
        localRev: 0,
        epochRev: 0,
        desired: null,
        inFlightRev: 0,
        ackedFp: null,
        running: false,
        resetTombstone: false,
        quarantined: false,
        quarantinedHead: null,
        activePromise: null,
      }
      this.slots.set(sessionKey, slot)
    }
    return slot
  }

  private handlePossibleUnsupported(err: unknown): boolean {
    if (isAuthorityEndpointUnsupportedError(err)) {
      this.unsupportedUntilMs = this.now() + UNSUPPORTED_NEG_CACHE_MS
      log.warn('master authority-state endpoint returned 404; negative-caching remote sync', {
        cooldownMs: UNSUPPORTED_NEG_CACHE_MS,
      })
      return true
    }
    return false
  }

  private trackSideOp(p: Promise<void>): Promise<void> {
    this.sideOps.add(p)
    void p.finally(() => this.sideOps.delete(p))
    return p
  }

  /**
   * B1 / B6: Record an observed authoritative placementEpoch (from GET or verified grant).
   * Bumps `slot.epochRev` to invalidate any older in-flight GET reads, WITHOUT granting
   * write provenance to an unowned legacy disk head.
   */
  recordObservedEpoch(sessionKey: string, placementEpoch: number): void {
    if (Number.isSafeInteger(placementEpoch) && placementEpoch >= 1) {
      const prev = this.observedAuthorityEpochs.get(sessionKey) ?? 0
      if (placementEpoch > prev) {
        this.observedAuthorityEpochs.set(sessionKey, placementEpoch)
        this.slotFor(sessionKey).epochRev += 1
      }
    }
  }

  /**
   * B1: Record epoch provenance for a local head confirmed by Master (adopted via
   * authoritative hydration or returned by our own successful write).
   */
  recordOwnedEpoch(sessionKey: string, placementEpoch: number): void {
    if (Number.isSafeInteger(placementEpoch) && placementEpoch >= 1) {
      this.recordObservedEpoch(sessionKey, placementEpoch)
      const prev = this.ownedHeadEpochs.get(sessionKey) ?? 0
      if (placementEpoch > prev) {
        this.ownedHeadEpochs.set(sessionKey, placementEpoch)
      }
    }
  }

  /**
   * B1 / B6: External grant hook called by `prepareSessionAuthorityBeforeCreate`.
   * Updates observed epoch and invalidates older in-flight reads, never bestowing
   * write authority on an unowned legacy local head.
   */
  recordKnownEpoch(sessionKey: string, placementEpoch: number): void {
    this.recordObservedEpoch(sessionKey, placementEpoch)
  }

  /** B1: Isolate local stale resume head (memory + disk + live runner) upon HTTP 409 conflict. */
  private quarantineOnConflict(
    sessionKey: string,
    slot: SessionSyncSlot,
    err: unknown,
    failedHead?: string | null,
  ): void {
    const staleHead = failedHead ?? this.resumeStore.ids.get(sessionKey) ?? null
    slot.localRev += 1
    slot.desired = null
    slot.ackedFp = null
    slot.quarantined = true
    slot.quarantinedHead = staleHead
    this.ownedHeadEpochs.delete(sessionKey)
    this.resumeStore.forget(sessionKey)
    if (this.onConflictQuarantine) {
      try {
        this.onConflictQuarantine(sessionKey)
      } catch (cbErr) {
        log.warn('onConflictQuarantine callback failed', {
          sessionKey,
          error: cbErr instanceof Error ? cbErr.message : String(cbErr),
        })
      }
    }
    log.warn('authority conflict quarantined stale local resume head', {
      sessionKey,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  /** W5: Apply authoritative pointer into local ResumeStore with legacy compatibility & clear semantics. */
  private applyAuthoritativePointerLocally(
    sessionKey: string,
    pointer: SessionEnginePointer,
  ): boolean {
    this.recordOwnedEpoch(sessionKey, pointer.placementEpoch)
    if (pointer.nativeSessionId === null || pointer.nativeSessionId === '') {
      this.resumeStore.forget(sessionKey)
      if (pointer.rejectedIds.length > 0) {
        this.resumeStore.rejected.set(sessionKey, new Set(pointer.rejectedIds))
      } else {
        this.resumeStore.rejected.delete(sessionKey)
      }
      return false
    }
    // W5: Legacy CCB contract compatibility — never revive obsolete historyContextVersion
    if (
      pointer.engine === CCB_PROVIDER_TAG &&
      pointer.historyContextVersion !== CCB_RESUME_HISTORY_CONTEXT_VERSION
    ) {
      log.info('authority read-through skipped obsolete CCB historyContextVersion', {
        sessionKey,
        historyContextVersion: pointer.historyContextVersion ?? null,
      })
      return false
    }
    this.resumeStore.ids.set(sessionKey, pointer.nativeSessionId)
    this.resumeStore.provider.set(sessionKey, pointer.engine)
    this.resumeStore.timestamps.set(sessionKey, Date.parse(pointer.updatedAt) || this.now())
    if (pointer.history.length > 0) {
      this.resumeStore.history.set(sessionKey, [...pointer.history])
    } else {
      this.resumeStore.history.delete(sessionKey)
    }
    if (pointer.rejectedIds.length > 0) {
      this.resumeStore.rejected.set(sessionKey, new Set(pointer.rejectedIds))
    } else {
      this.resumeStore.rejected.delete(sessionKey)
    }
    const cost = pointer.usageBaseline?.totalCostUsd
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      this.resumeStore.lastCost.set(sessionKey, cost)
    } else {
      this.resumeStore.lastCost.delete(sessionKey)
    }
    if (pointer.promotedFromHistory) {
      this.resumeStore.promotedFromHistory.set(sessionKey, pointer.nativeSessionId)
    } else {
      this.resumeStore.promotedFromHistory.delete(sessionKey)
    }
    return true
  }

  /**
   * W1: Replay pending authority acks. When `onlySessionKey` is provided, replays
   * strictly that session's pending acks (never blocking unrelated sessions).
   */
  async replayPendingAcks(onlySessionKey?: string): Promise<void> {
    if (!this.isRemoteEnabled || !this.authorityStore) return
    const pending = listPendingAuthorityAcks(this.checkpointBaseDir).filter(
      (entry) => !onlySessionKey || entry.sessionKey === onlySessionKey,
    )
    const startedAt = this.now()
    for (const entry of pending) {
      if (!this.isRemoteEnabled) break
      if (!onlySessionKey && this.now() - startedAt >= BACKGROUND_REPLAY_BUDGET_MS) break
      try {
        await this.authorityStore.ackCheckpoint(
          this.tenantId,
          entry.sessionKey,
          entry.generation,
          entry.turnKey,
        )
        removePendingAuthorityAck(entry.sessionKey, entry.generation, this.checkpointBaseDir)
      } catch (err) {
        if (this.handlePossibleUnsupported(err)) break
        if (isConflictErr(err)) {
          removePendingAuthorityAck(entry.sessionKey, entry.generation, this.checkpointBaseDir)
        }
      }
    }
  }

  /**
   * B4: Replay durable pending checkpoints and resets in causal order (checkpoints
   * always confirmed on Master before any reset that depends on them).
   */
  async replayPendingOps(onlySessionKey?: string): Promise<boolean> {
    if (!this.isRemoteEnabled || !this.authorityStore) return true
    const pending = listPendingAuthorityOps(this.checkpointBaseDir).filter(
      (entry) => !onlySessionKey || entry.sessionKey === onlySessionKey,
    )
    if (pending.length === 0) return true

    const failedCheckpoints = new Set<string>()
    const startedAt = this.now()
    let allSucceeded = true

    // Phase 1: Replay durable checkpoints first so compact summaries always precede resets.
    for (const entry of pending) {
      if (entry.kind !== 'checkpoint') continue
      if (!this.isRemoteEnabled) return false
      if (!onlySessionKey && this.now() - startedAt >= BACKGROUND_REPLAY_BUDGET_MS) return false
      const ok = await this.sendCheckpointRecord(entry)
      if (!ok) {
        failedCheckpoints.add(`${entry.sessionKey}::${entry.generation}`)
        allSucceeded = false
      }
    }

    // Phase 2: Replay durable resets whose prerequisite checkpoint (if any) is confirmed.
    for (const entry of pending) {
      if (entry.kind !== 'reset') continue
      if (!this.isRemoteEnabled) return false
      if (!onlySessionKey && this.now() - startedAt >= BACKGROUND_REPLAY_BUDGET_MS) return false
      if (
        entry.afterCheckpointGeneration &&
        failedCheckpoints.has(`${entry.sessionKey}::${entry.afterCheckpointGeneration}`)
      ) {
        allSucceeded = false
        continue
      }
      const ok = await this.sendDurableReset(entry)
      if (!ok) allSucceeded = false
    }

    return allSucceeded
  }

  /**
   * W1 / B4: Single-flight, non-blocking background replay for all container sessions'
   * pending acks and durable ops (with time budget and exponential backoff).
   */
  triggerBackgroundReplay(): void {
    if (!this.isRemoteEnabled || !this.authorityStore) return
    if (this.backgroundReplayPromise) return
    if (this.now() < this.backgroundReplayNextAllowedMs) return
    const hasWork =
      listPendingAuthorityAcks(this.checkpointBaseDir).length > 0 ||
      listPendingAuthorityOps(this.checkpointBaseDir).length > 0
    if (!hasWork) return

    const run = (async () => {
      try {
        await this.replayPendingAcks()
        const opsOk = await this.replayPendingOps()
        const remaining =
          listPendingAuthorityAcks(this.checkpointBaseDir).length +
          listPendingAuthorityOps(this.checkpointBaseDir).length
        if (opsOk && remaining === 0) {
          this.backgroundReplayFailures = 0
          this.backgroundReplayNextAllowedMs = 0
        } else {
          this.backgroundReplayFailures = Math.min(this.backgroundReplayFailures + 1, 8)
          const backoff = Math.min(
            BACKGROUND_REPLAY_MAX_BACKOFF_MS,
            BACKGROUND_REPLAY_MIN_BACKOFF_MS * 2 ** (this.backgroundReplayFailures - 1),
          )
          this.backgroundReplayNextAllowedMs = this.now() + backoff
        }
      } finally {
        this.backgroundReplayPromise = null
      }
    })()
    this.backgroundReplayPromise = run
    this.trackSideOp(run)
  }

  private async sendCheckpointRecord(
    entry: Extract<PendingAuthorityOpEntry, { readonly kind: 'checkpoint' }>,
  ): Promise<boolean> {
    if (!this.authorityStore) return false
    const parts = entry.sessionKey.split(':')
    const sessionId = parts[parts.length - 1] || entry.sessionKey
    const engine = toAuthorityEngine(entry.engine)
    try {
      await this.authorityStore.saveCheckpoint(this.tenantId, {
        sessionKey: entry.sessionKey,
        sessionId,
        checkpointGeneration: entry.generation,
        placementEpoch: entry.placementEpoch,
        mode: 'anchored_v2',
        anchorSeq: 0,
        sourceEngine: engine,
        summary: entry.summary,
        ...(entry.instructions ? { instructions: entry.instructions } : {}),
        ackedByTurnKey: null,
        ackedAt: null,
        createdAt: new Date(entry.createdAt).toISOString(),
      })
      removePendingAuthorityOp(entry.id, this.checkpointBaseDir)
      return true
    } catch (err) {
      if (this.handlePossibleUnsupported(err) || isConflictErr(err)) {
        removePendingAuthorityOp(entry.id, this.checkpointBaseDir)
        return true
      }
      log.warn('authority checkpoint write-through deferred for durable retry', {
        sessionKey: entry.sessionKey,
        generation: entry.generation,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  private async sendDurableReset(
    entry: Extract<PendingAuthorityOpEntry, { readonly kind: 'reset' }>,
  ): Promise<boolean> {
    if (!this.authorityStore) return false
    const engine = toAuthorityEngine(entry.engine)
    const slot = this.slotFor(entry.sessionKey)
    const sourceEpoch =
      entry.expectedPlacementEpoch ?? this.ownedHeadEpochs.get(entry.sessionKey)
    try {
      const updated = await this.executeNarrowResumeOp(entry.sessionKey, {
        kind: 'reset',
        rev: slot.localRev,
        fp: `durable-reset:${entry.id}`,
        engine,
        sourceEpoch,
        inheritCreatedEpoch: false,
        pendingOpId: entry.id,
      })
      this.recordOwnedEpoch(entry.sessionKey, updated.placementEpoch)
      removePendingAuthorityOp(entry.id, this.checkpointBaseDir)
      return true
    } catch (err) {
      if (this.handlePossibleUnsupported(err)) {
        removePendingAuthorityOp(entry.id, this.checkpointBaseDir)
        return true
      }
      if (isConflictErr(err)) {
        this.quarantineOnConflict(entry.sessionKey, slot, err)
        removePendingAuthorityOp(entry.id, this.checkpointBaseDir)
        return true
      }
      log.warn('authority reset write-through deferred for durable retry', {
        sessionKey: entry.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  /**
   * B5 / B6 / W1 / W5: Read-through hydration called inside `getOrCreate` BEFORE
   * runner construction, backend freshness checks, and cost baseline seeding.
   * - Never waits on unrelated sessions' pending acks/ops (W1).
   * - Invalidates stale GET responses if a newer grant arrived mid-flight (B6).
   * - Never grants write provenance to an unowned legacy local head (B1).
   */
  async hydrateSessionIfMissing(sessionKey: string): Promise<HydrateSessionResult> {
    if (!this.isRemoteEnabled || !this.authorityStore) {
      return {
        pointer: null,
        pointerHydrated: false,
        checkpointHydrated: false,
        promptStateHydrated: false,
        authorityDegraded: false,
      }
    }

    // W1 / B4: Replay ONLY this session's own durable pending acks/ops synchronously.
    // Cross-session background replay is kicked off after this hydrate returns so
    // foreground session hydration always gets first priority and never waits on others.
    await this.replayPendingAcks(sessionKey)
    await this.replayPendingOps(sessionKey)

    if (!this.isRemoteEnabled) {
      return {
        pointer: null,
        pointerHydrated: false,
        checkpointHydrated: false,
        promptStateHydrated: false,
        authorityDegraded: false,
      }
    }

    const slot = this.slotFor(sessionKey)
    const startRev = slot.localRev
    const startEpochRev = slot.epochRev
    let authorityDegraded = false
    let remotePointer: SessionEnginePointer | null = null
    let pointerHydrated = false
    let promptStateHydrated = false
    let checkpointHydrated = false

    const hasPendingDurableReset = listPendingAuthorityOps(this.checkpointBaseDir).some(
      (op) => op.kind === 'reset' && op.sessionKey === sessionKey,
    )
    const needPointer =
      !slot.resetTombstone &&
      !hasPendingDurableReset &&
      (!this.resumeStore.ids.has(sessionKey) || slot.quarantined)
    const localHasCheckpoint = peekPendingCheckpoint(sessionKey, this.checkpointBaseDir) !== null

    // Always read authoritative pointer when pointer is missing, quarantined, or we need its
    // current epoch to safely scope checkpoint read-through (B6).
    if (needPointer || !localHasCheckpoint) {
      try {
        const fetched = await this.authorityStore.getPointer(this.tenantId, sessionKey)
        const minObserved = this.observedAuthorityEpochs.get(sessionKey) ?? 0
        // B6: Discard stale pointer response if a higher verified grant arrived mid-flight.
        const stalePointer =
          slot.epochRev !== startEpochRev ||
          (fetched !== null && fetched.placementEpoch < minObserved)
        if (!stalePointer) {
          remotePointer = fetched
          if (remotePointer) {
            // B1: Record ONLY in observedAuthorityEpochs (never ownedHeadEpochs unless adopted!)
            this.recordObservedEpoch(sessionKey, remotePointer.placementEpoch)
          }
          if (
            needPointer &&
            remotePointer &&
            slot.localRev === startRev &&
            !slot.resetTombstone &&
            !hasPendingDurableReset
          ) {
            pointerHydrated = this.applyAuthoritativePointerLocally(sessionKey, remotePointer)
            slot.quarantined = false
            slot.quarantinedHead = null
            const promptState = extractPromptState(sessionKey, remotePointer.promptCacheMeta)
            if (promptState) {
              restoreAntigravityPromptStateSilently(this.antigravityRootDir, promptState)
              promptStateHydrated = true
            }
          }
        }
      } catch (err) {
        if (!this.handlePossibleUnsupported(err)) {
          authorityDegraded = true
        }
      }
    }

    // B6: Independent checkpoint read-through bound strictly to current authoritative epoch.
    const postPointerEpochRev = slot.epochRev
    if (
      this.isRemoteEnabled &&
      !authorityDegraded &&
      peekPendingCheckpoint(sessionKey, this.checkpointBaseDir) === null
    ) {
      const observedNow = this.observedAuthorityEpochs.get(sessionKey)
      const targetEpoch =
        remotePointer && (observedNow === undefined || remotePointer.placementEpoch >= observedNow)
          ? remotePointer.placementEpoch
          : observedNow
      if (targetEpoch !== undefined) {
        try {
          let remoteCp: AuthoritativeRollingCheckpoint | null
          if (this.authorityStore instanceof RemoteSessionAuthorityStore) {
            remoteCp = await this.authorityStore.getLatestCheckpoint(
              this.tenantId,
              sessionKey,
              targetEpoch,
            )
          } else {
            const candidate = await this.authorityStore.getLatestCheckpoint(
              this.tenantId,
              sessionKey,
            )
            remoteCp = candidate && candidate.placementEpoch === targetEpoch ? candidate : null
          }
          const latestObserved = this.observedAuthorityEpochs.get(sessionKey) ?? 0
          if (
            remoteCp &&
            !remoteCp.ackedAt &&
            !remoteCp.ackedByTurnKey &&
            remoteCp.placementEpoch === targetEpoch &&
            remoteCp.placementEpoch >= latestObserved &&
            slot.localRev === startRev &&
            slot.epochRev === postPointerEpochRev &&
            peekPendingCheckpoint(sessionKey, this.checkpointBaseDir) === null
          ) {
            try {
              savePendingCheckpointWithGeneration(sessionKey, remoteCp.summary, {
                generation: remoteCp.checkpointGeneration,
                placementEpoch: remoteCp.placementEpoch,
                ...(remoteCp.instructions ? { instructions: remoteCp.instructions } : {}),
                ...(this.checkpointBaseDir ? { baseDir: this.checkpointBaseDir } : {}),
              })
              checkpointHydrated = true
            } catch (cpErr) {
              const msg = cpErr instanceof Error ? cpErr.message : String(cpErr)
              if (
                msg !== 'CHECKPOINT_GENERATION_ALREADY_CONSUMED' &&
                msg !== 'CHECKPOINT_STALE_PLACEMENT_EPOCH'
              ) {
                log.warn('authority checkpoint hydration local write failed', {
                  sessionKey,
                  error: msg,
                })
              }
            }
          }
        } catch (err) {
          if (!this.handlePossibleUnsupported(err)) {
            authorityDegraded = true
          }
        }
      }
    }

    this.triggerBackgroundReplay()

    return {
      pointer: remotePointer,
      pointerHydrated,
      checkpointHydrated,
      promptStateHydrated,
      authorityDegraded,
    }
  }

  /**
   * B1 / B3 / W7: Coalesced write-through of resume snapshots.
   * - Uses `ownedHeadEpochs` ONLY (never `observedAuthorityEpochs`) so an unowned
   *   legacy disk head cannot clobber a newer Master epoch (B1).
   * - Ignores racing re-saves of a quarantined head (B1).
   * - Tags operations queued behind an in-flight create with `inheritCreatedEpoch`
   *   so `A -> B` before A's ACK inherits A's confirmed epoch (B3).
   */
  syncResumeSnapshots(snapshots: readonly ResumePointerSyncSnapshot[]): void {
    if (!this.isRemoteEnabled || !this.authorityStore) return
    for (const snap of snapshots) {
      const slot = this.slotFor(snap.sessionKey)
      if (slot.quarantined && slot.quarantinedHead !== null && snap.nativeSessionId === slot.quarantinedHead) {
        continue
      }
      const engine = toAuthorityEngine(snap.providerTag)
      const fp = JSON.stringify([
        'upsert',
        snap.nativeSessionId,
        engine,
        snap.history ?? [],
        snap.rejectedIds ?? [],
        snap.lastCost ?? null,
        snap.promotedFromHistory ?? false,
      ])
      if (!slot.running && slot.desired === null && slot.ackedFp === fp) {
        continue
      }
      const ownedEpoch = this.ownedHeadEpochs.get(snap.sessionKey)
      const inheritCreatedEpoch =
        ownedEpoch === undefined && (slot.running || slot.desired !== null)
      slot.localRev += 1
      slot.resetTombstone = false
      slot.quarantined = false
      slot.quarantinedHead = null
      slot.desired = {
        kind: 'upsert',
        rev: slot.localRev,
        fp,
        snap,
        sourceEpoch: ownedEpoch,
        inheritCreatedEpoch,
      }
      this.pumpSlot(snap.sessionKey, slot)
    }
  }

  /**
   * B4 / B3: Explicit semantic reset / forget tombstone.
   * - Persists a durable `pending_reset` op on disk so transient network errors
   *   never lose a semantic reset.
   * - If a local compaction checkpoint write is in-flight for this session, links
   *   `afterCheckpointGeneration` so the remote reset NEVER runs until Master
   *   confirms the checkpoint summary.
   */
  syncResumeReset(sessionKey: string, providerTag?: string): void {
    const slot = this.slotFor(sessionKey)
    const ownedEpoch = this.ownedHeadEpochs.get(sessionKey)
    const inheritCreatedEpoch =
      ownedEpoch === undefined && (slot.running || slot.desired !== null)
    slot.localRev += 1
    slot.resetTombstone = true
    slot.quarantined = false
    slot.quarantinedHead = null
    if (!this.isRemoteEnabled || !this.authorityStore) {
      slot.desired = null
      return
    }
    const engine = toAuthorityEngine(providerTag)
    const inFlightCp = this.inFlightCheckpointWrites.get(sessionKey)
    const pendingOpId = `reset:${sessionKey}`
    enqueuePendingAuthorityOp(
      {
        kind: 'reset',
        id: pendingOpId,
        sessionKey,
        engine,
        ...(ownedEpoch !== undefined ? { expectedPlacementEpoch: ownedEpoch } : {}),
        ...(inFlightCp ? { afterCheckpointGeneration: inFlightCp.generation } : {}),
        createdAt: this.now(),
      },
      this.checkpointBaseDir,
    )
    const fp = JSON.stringify(['reset', engine, slot.localRev])
    slot.desired = {
      kind: 'reset',
      rev: slot.localRev,
      fp,
      engine,
      sourceEpoch: ownedEpoch,
      inheritCreatedEpoch,
      pendingOpId,
      ...(inFlightCp ? { afterCheckpointGeneration: inFlightCp.generation } : {}),
    }
    this.pumpSlot(sessionKey, slot)
  }

  private pumpSlot(sessionKey: string, slot: SessionSyncSlot): void {
    if (slot.running) return
    slot.running = true
    const run = (async () => {
      let chainCreatedEpoch: number | undefined
      try {
        while (slot.desired !== null && this.isRemoteEnabled && this.authorityStore) {
          const op = slot.desired
          slot.desired = null
          slot.inFlightRev = op.rev

          // B4: If this reset follows a compact checkpoint, wait for the checkpoint write first.
          if (op.kind === 'reset') {
            const cpTracker = this.inFlightCheckpointWrites.get(sessionKey)
            if (cpTracker && (!op.afterCheckpointGeneration || cpTracker.generation === op.afterCheckpointGeneration)) {
              const cpConfirmed = await cpTracker.promise
              if (!cpConfirmed) {
                log.warn('deferring remote reset until compact checkpoint is confirmed on master', {
                  sessionKey,
                  generation: cpTracker.generation,
                })
                this.triggerBackgroundReplay()
                continue
              }
            }
          }

          const effectiveEpoch =
            op.sourceEpoch ?? (op.inheritCreatedEpoch ? chainCreatedEpoch : undefined)
          const effectiveOp: DesiredResumeOp =
            effectiveEpoch !== op.sourceEpoch
              ? { ...op, sourceEpoch: effectiveEpoch }
              : op

          try {
            const updated = await this.executeNarrowResumeOp(sessionKey, effectiveOp)
            this.recordOwnedEpoch(sessionKey, updated.placementEpoch)
            if (effectiveOp.sourceEpoch === undefined) {
              chainCreatedEpoch = updated.placementEpoch
            }
            if (op.kind === 'reset') {
              removePendingAuthorityOp(op.pendingOpId, this.checkpointBaseDir)
            }
            // B3: NEVER write `updated` back into local ResumeStore!
            if (slot.localRev === op.rev) {
              slot.ackedFp = op.fp
            }
          } catch (err) {
            if (this.handlePossibleUnsupported(err)) {
              if (op.kind === 'reset') {
                removePendingAuthorityOp(op.pendingOpId, this.checkpointBaseDir)
              }
              slot.desired = null
              break
            }
            if (isConflictErr(err)) {
              if (op.kind === 'reset') {
                removePendingAuthorityOp(op.pendingOpId, this.checkpointBaseDir)
              }
              this.quarantineOnConflict(
                sessionKey,
                slot,
                err,
                op.kind === 'upsert' ? op.snap.nativeSessionId : null,
              )
              break
            }
            log.warn('authority pointer write-through degraded (non-fatal)', {
              sessionKey,
              kind: op.kind,
              error: err instanceof Error ? err.message : String(err),
            })
            if (op.kind === 'reset') {
              this.triggerBackgroundReplay()
            }
          } finally {
            slot.inFlightRev = 0
          }
        }
      } finally {
        slot.running = false
        slot.activePromise = null
        if (slot.desired !== null && this.isRemoteEnabled) {
          this.pumpSlot(sessionKey, slot)
        }
      }
    })()
    slot.activePromise = run
  }

  private async executeNarrowResumeOp(
    sessionKey: string,
    op: DesiredResumeOp,
  ): Promise<SessionEnginePointer> {
    const store = this.authorityStore!
    if (store instanceof RemoteSessionAuthorityStore) {
      if (op.kind === 'reset') {
        const patch: NarrowResumePatchInput = {
          sessionKey,
          engine: op.engine,
          nativeSessionId: null,
          reset: true,
          ...(op.sourceEpoch !== undefined
            ? { expectedPlacementEpoch: op.sourceEpoch }
            : { createIfAbsentOnly: true }),
        }
        return store.patchResumePointer(patch)
      }
      const engine = toAuthorityEngine(op.snap.providerTag)
      const patch: NarrowResumePatchInput = {
        sessionKey,
        engine,
        nativeSessionId: op.snap.nativeSessionId,
        history: op.snap.history ?? [],
        rejectedIds: op.snap.rejectedIds ?? [],
        ...(op.snap.lastCost !== undefined ? { totalCostUsd: op.snap.lastCost } : {}),
        historyContextVersion:
          engine === CCB_PROVIDER_TAG ? CCB_RESUME_HISTORY_CONTEXT_VERSION : null,
        promotedFromHistory: op.snap.promotedFromHistory ?? false,
        ...(op.sourceEpoch !== undefined
          ? { expectedPlacementEpoch: op.sourceEpoch }
          : { createIfAbsentOnly: true }),
      }
      return store.patchResumePointer(patch)
    }

    // Fallback for in-memory test SessionAuthorityStore implementations: preserve
    // master-owned placement & reserved promptCacheMeta fields while enforcing B1.
    const existing = await store.getPointer(this.tenantId, sessionKey)
    if (op.sourceEpoch === undefined && existing) {
      if (
        op.kind === 'reset' ||
        existing.engine !== toAuthorityEngine(op.snap.providerTag) ||
        existing.nativeSessionId !== op.snap.nativeSessionId
      ) {
        throw new PlacementEpochConflictError(sessionKey, 1, existing.placementEpoch)
      }
      return existing
    }
    const engine = op.kind === 'reset' ? op.engine : toAuthorityEngine(op.snap.providerTag)
    const nextUsage: Record<string, number> | null =
      op.kind === 'upsert' && op.snap.lastCost !== undefined
        ? { ...(existing?.usageBaseline ?? {}), totalCostUsd: op.snap.lastCost }
        : (existing?.usageBaseline ?? null)
    const pointer: SessionEnginePointer = {
      sessionKey,
      placementEpoch: op.sourceEpoch ?? existing?.placementEpoch ?? 1,
      poolKind: existing?.poolKind ?? 'local_container',
      engine,
      nativeSessionId: op.kind === 'reset' ? null : op.snap.nativeSessionId,
      operationId: existing?.operationId ?? null,
      profileId: existing?.profileId ?? null,
      capsuleId: existing?.capsuleId ?? null,
      history: op.kind === 'reset' ? [] : [...(op.snap.history ?? [])],
      rejectedIds: op.kind === 'reset' ? [...(existing?.rejectedIds ?? [])] : [...(op.snap.rejectedIds ?? [])],
      promptCacheMeta: existing?.promptCacheMeta ?? null,
      usageBaseline: nextUsage,
      historyContextVersion:
        op.kind === 'reset'
          ? (existing?.historyContextVersion ?? null)
          : engine === CCB_PROVIDER_TAG
            ? CCB_RESUME_HISTORY_CONTEXT_VERSION
            : null,
      promotedFromHistory: op.kind === 'reset' ? false : (op.snap.promotedFromHistory ?? false),
      migrationState: existing?.migrationState ?? 'active',
      activeMigrationId: existing?.activeMigrationId ?? null,
      updatedAt: new Date(this.now()).toISOString(),
    }
    return store.upsertPointer(
      this.tenantId,
      pointer,
      op.sourceEpoch ?? (existing ? existing.placementEpoch : undefined),
    )
  }

  /**
   * B4: Durable write-through of locally generated rolling compaction checkpoint.
   * Persists to `pending-authority-ops.json` BEFORE sending and exposes an in-flight
   * promise so a following compact reset waits for summary confirmation first.
   */
  syncLocalCheckpointWriteThrough(
    record: PersistedCheckpointRecord,
    providerTag?: string,
  ): Promise<void> {
    if (!this.isRemoteEnabled || !this.authorityStore) return Promise.resolve()
    const engine = toAuthorityEngine(providerTag ?? this.resumeStore.provider.get(record.sessionKey))
    const epoch =
      record.placementEpoch ??
      this.ownedHeadEpochs.get(record.sessionKey) ??
      this.observedAuthorityEpochs.get(record.sessionKey) ??
      1
    const pendingOp: Extract<PendingAuthorityOpEntry, { readonly kind: 'checkpoint' }> = {
      kind: 'checkpoint',
      id: `ckpt:${record.sessionKey}:${record.generation}`,
      sessionKey: record.sessionKey,
      generation: record.generation,
      summary: record.summary,
      ...(record.instructions ? { instructions: record.instructions } : {}),
      engine,
      placementEpoch: epoch,
      createdAt: record.createdAt,
    }
    enqueuePendingAuthorityOp(pendingOp, this.checkpointBaseDir)

    const resultPromise = this.sendCheckpointRecord(pendingOp).finally(() => {
      const cur = this.inFlightCheckpointWrites.get(record.sessionKey)
      if (cur && cur.generation === record.generation) {
        this.inFlightCheckpointWrites.delete(record.sessionKey)
      }
    })
    this.inFlightCheckpointWrites.set(record.sessionKey, {
      generation: record.generation,
      promise: resultPromise,
    })
    return this.trackSideOp(resultPromise.then(() => undefined))
  }

  /** W1: Persist durable ack intent BEFORE local pending checkpoint consumption. */
  persistPendingCheckpointAckIntent(
    sessionKey: string,
    checkpointGeneration: string,
    turnKey: string,
  ): void {
    if (!this.isRemoteEnabled || !this.authorityStore) return
    enqueuePendingAuthorityAck(
      { sessionKey, generation: checkpointGeneration, turnKey, createdAt: this.now() },
      this.checkpointBaseDir,
    )
  }

  /** W1: Generation-CAS ack with durable disk pending-ack retry queue on failure. */
  ackCheckpointWriteThrough(
    sessionKey: string,
    checkpointGeneration: string,
    turnKey: string,
  ): Promise<void> {
    if (!this.isRemoteEnabled || !this.authorityStore) return Promise.resolve()
    this.persistPendingCheckpointAckIntent(sessionKey, checkpointGeneration, turnKey)
    return this.trackSideOp(
      (async () => {
        try {
          await this.authorityStore!.ackCheckpoint(
            this.tenantId,
            sessionKey,
            checkpointGeneration,
            turnKey,
          )
          removePendingAuthorityAck(sessionKey, checkpointGeneration, this.checkpointBaseDir)
        } catch (err) {
          if (this.handlePossibleUnsupported(err)) {
            removePendingAuthorityAck(sessionKey, checkpointGeneration, this.checkpointBaseDir)
            return
          }
          if (isConflictErr(err)) {
            removePendingAuthorityAck(sessionKey, checkpointGeneration, this.checkpointBaseDir)
            return
          }
          log.warn('authority checkpoint ack write-through deferred for retry', {
            sessionKey,
            checkpointGeneration,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })(),
    )
  }

  /** B2: Narrow prompt-state merge (never overwrites pendingInstallMigration / _capsuleMeta). */
  syncPromptStateWriteThrough(
    record: LocalPromptStateRecord,
    engine: AuthorityEngineKind,
  ): Promise<void> {
    if (!this.isRemoteEnabled || !this.authorityStore) return Promise.resolve()
    const expectedEpoch =
      record.placementEpoch ??
      this.ownedHeadEpochs.get(record.sessionKey) ??
      this.observedAuthorityEpochs.get(record.sessionKey) ??
      1
    return this.trackSideOp(
      (async () => {
        try {
          if (this.authorityStore instanceof RemoteSessionAuthorityStore) {
            const ptr = await this.authorityStore.patchPromptState(record, engine, expectedEpoch)
            this.recordOwnedEpoch(record.sessionKey, ptr.placementEpoch)
          } else {
            await this.bridge.writePromptState({
              record,
              engine,
              placementEpoch: expectedEpoch,
              expectedPlacementEpoch: expectedEpoch,
            })
          }
        } catch (err) {
          if (this.handlePossibleUnsupported(err)) return
          if (isConflictErr(err)) {
            log.warn('authority prompt-state write-through rejected by epoch conflict', {
              sessionKey: record.sessionKey,
              error: err instanceof Error ? err.message : String(err),
            })
            return
          }
          log.warn('authority prompt-state write-through failed (degraded)', {
            sessionKey: record.sessionKey,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })(),
    )
  }

  /** W7: Drain until ALL coalescing slots and side ops stabilize (no missed tail writes). */
  async flush(): Promise<void> {
    for (let guard = 0; guard < 32; guard++) {
      const pending: Promise<void>[] = [...this.sideOps]
      for (const [key, slot] of this.slots) {
        if (slot.desired !== null && !slot.running && this.isRemoteEnabled) {
          this.pumpSlot(key, slot)
        }
        if (slot.activePromise) pending.push(slot.activePromise)
      }
      if (pending.length === 0) break
      await Promise.allSettled(pending)
    }
  }
}
