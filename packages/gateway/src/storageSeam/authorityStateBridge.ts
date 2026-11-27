/**
 * OCV5-890 Wave 1B — Layer 1 Container Small-State Authority Bridge.
 *
 * Elevates container-local small state (`resume-map`, rolling `checkpoints`,
 * and `antigravityPromptState`) to L0 `SessionAuthorityStore` via:
 * - Write-through: authoritative store first (carrying `expectedPlacementEpoch`),
 *   synced to local cache; fail-open to local cache with `authorityDegraded: true`
 *   when authority is unreachable (explicit epoch conflicts remain fail-closed!).
 * - Read-through: auto-hydrates missing local state from authoritative store
 *   after pool switch or container rebuild.
 * - Generation CAS Ack: validates both authority and local `checkpointGeneration`
 *   so rolling checkpoints are consumed atomically only after first-turn delivery.
 *
 * V5 guardrails: zero `process.env`, zero `R2-same-layer` value imports from
 * `gateway-session` or `gateway-engines`, zero `R3-special-case` comparisons.
 */
import type {
  AuthoritativeRollingCheckpoint,
  AuthorityEngineKind,
  EngineStateCapsuleRef,
  PlacementMigrationRecord,
  ResumeLadderTier,
  RollingCheckpointMode,
  SessionAuthorityEpoch,
  SessionAuthorityStore,
  SessionEnginePointer,
  StoragePoolKind,
} from '@openclaude/protocol/storage-seam'

export interface LocalResumeStateEntry {
  readonly nativeSessionId: string | null
  readonly engine: AuthorityEngineKind
  readonly history: readonly string[]
  readonly rejectedIds: readonly string[]
  readonly placementEpoch?: number
  readonly lastCost?: number
  readonly costImprecise?: boolean
  readonly historyContextVersion?: number | null
  readonly promotedFromHistory?: boolean
  readonly usageBaseline?: Readonly<Record<string, number>> | null
  readonly updatedAtMs?: number
}

export interface LocalResumeStoreAdapter {
  get(sessionKey: string): LocalResumeStateEntry | null | Promise<LocalResumeStateEntry | null>
  set(sessionKey: string, entry: LocalResumeStateEntry): void | Promise<void>
  delete?(sessionKey: string): void | Promise<void>
}

export interface LocalCheckpointRecord {
  readonly sessionKey: string
  readonly generation: string
  readonly summary: string
  readonly createdAt: number
  readonly instructions?: string
}

export interface LocalCheckpointStoreAdapter {
  peek(sessionKey: string): LocalCheckpointRecord | null | Promise<LocalCheckpointRecord | null>
  save(record: LocalCheckpointRecord): void | Promise<void>
  ack(sessionKey: string, generation: string): boolean | Promise<boolean>
  clear?(sessionKey: string): void | Promise<void>
}

export interface LocalPromptStateRecord {
  readonly v: 1
  readonly sessionKey: string
  readonly conversationId: string
  readonly inputsKey: string
  readonly slotHashes?: Readonly<Record<string, string>>
  readonly injectedAfterBaseline: number
  readonly placementEpoch?: number
  readonly updatedAt: number
}

export interface LocalPromptStateAdapter {
  read(sessionKey: string): LocalPromptStateRecord | null | Promise<LocalPromptStateRecord | null>
  write(record: LocalPromptStateRecord): void | Promise<void>
  clear?(sessionKey: string): void | Promise<void>
}

export interface AuthorityStateBridgeOptions {
  readonly tenantId: string
  readonly authorityStore?: SessionAuthorityStore | null
  readonly localResumeStore?: LocalResumeStoreAdapter | null
  readonly localCheckpointStore?: LocalCheckpointStoreAdapter | null
  readonly localPromptState?: LocalPromptStateAdapter | null
  readonly defaultPoolKind?: StoragePoolKind
}

export interface AuthorityBridgeMetrics {
  authorityWritesOk: number
  authorityWritesDegraded: number
  authorityReadsOk: number
  authorityReadsDegraded: number
  readThroughHydrations: number
  checkpointAcksOk: number
  checkpointAcksRejected: number
}

export interface WritePointerInput {
  readonly sessionKey: string
  readonly placementEpoch: number
  readonly expectedPlacementEpoch?: number
  readonly poolKind?: StoragePoolKind
  readonly engine: AuthorityEngineKind
  readonly nativeSessionId: string | null
  readonly operationId?: string | null
  readonly profileId?: string | null
  readonly capsuleId?: string | null
  readonly history?: readonly string[]
  readonly rejectedIds?: readonly string[]
  readonly promptCacheMeta?: Readonly<Record<string, unknown>> | null
  readonly usageBaseline?: Readonly<Record<string, number>> | null
  readonly historyContextVersion?: number | null
  readonly promotedFromHistory?: boolean
  readonly migrationState?: 'active' | 'migrating'
  readonly activeMigrationId?: string | null
  readonly lastCost?: number
  readonly costImprecise?: boolean
}

export interface WritePointerResult {
  readonly pointer: SessionEnginePointer
  readonly authorityDegraded: boolean
}

export interface ReadPointerResult {
  readonly pointer: SessionEnginePointer | null
  readonly localEntry: LocalResumeStateEntry | null
  readonly hydratedFromAuthority: boolean
  readonly authorityDegraded: boolean
}

export interface SaveRollingCheckpointInput {
  readonly sessionKey: string
  readonly sessionId: string
  readonly checkpointGeneration: string
  readonly placementEpoch: number
  readonly mode: RollingCheckpointMode
  readonly anchorSeq: number
  readonly sourceEngine: AuthorityEngineKind
  readonly summary: string
  readonly instructions?: string | null
  readonly createdAt?: string
}

export interface SaveRollingCheckpointResult {
  readonly checkpoint: AuthoritativeRollingCheckpoint
  readonly localRecord: LocalCheckpointRecord
  readonly authorityDegraded: boolean
}

export interface PeekRollingCheckpointResult {
  readonly localRecord: LocalCheckpointRecord | null
  readonly authoritativeRecord: AuthoritativeRollingCheckpoint | null
  readonly hydratedFromAuthority: boolean
  readonly authorityDegraded: boolean
}

export interface AckRollingCheckpointInput {
  readonly sessionKey: string
  readonly checkpointGeneration: string
  readonly turnKey: string
}

export interface AckRollingCheckpointResult {
  readonly acked: boolean
  readonly authorityAcked: boolean
  readonly localAcked: boolean
  readonly authorityDegraded: boolean
  readonly reason?: string
}

export interface WritePromptStateInput {
  readonly record: LocalPromptStateRecord
  readonly engine: AuthorityEngineKind
  readonly placementEpoch: number
  readonly expectedPlacementEpoch?: number
  readonly poolKind?: StoragePoolKind
}

export interface WritePromptStateResult {
  readonly record: LocalPromptStateRecord
  readonly authorityDegraded: boolean
}

export interface ReadPromptStateResult {
  readonly record: LocalPromptStateRecord | null
  readonly hydratedFromAuthority: boolean
  readonly authorityDegraded: boolean
}

const AUTHORITY_CONFLICT_CODES = [
  'PLACEMENT_EPOCH_CONFLICT',
  'SESSION_PLACEMENT_MIGRATING',
  'SESSION_PLACEMENT_EPOCH_MISMATCH',
  'CHECKPOINT_PLACEMENT_EPOCH_MISMATCH',
] as const

export class PlacementEpochConflictError extends Error {
  readonly code = 'PLACEMENT_EPOCH_CONFLICT'
  constructor(
    readonly sessionKey: string,
    readonly expectedEpoch: number,
    readonly actualEpoch: number,
    readonly authorityErrorCode?: string,
  ) {
    super(
      authorityErrorCode
        ? `PLACEMENT_EPOCH_CONFLICT (${authorityErrorCode}): session=${sessionKey} expected=${expectedEpoch} actual=${actualEpoch}`
        : `PLACEMENT_EPOCH_CONFLICT: session=${sessionKey} expected=${expectedEpoch} actual=${actualEpoch}`,
    )
    this.name = 'PlacementEpochConflictError'
  }
}

function extractAuthorityConflictCode(err: unknown): string | null {
  if (err instanceof PlacementEpochConflictError) {
    return err.authorityErrorCode ?? err.code
  }
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') {
      for (const known of AUTHORITY_CONFLICT_CODES) {
        if (code === known) return known
      }
    }
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string') {
      for (const known of AUTHORITY_CONFLICT_CODES) {
        if (msg.includes(known)) return known
      }
    }
  }
  return null
}

export function isAuthorityConflictError(err: unknown): boolean {
  return extractAuthorityConflictCode(err) !== null
}

function toPlacementEpochConflictError(
  err: unknown,
  sessionKey: string,
  expectedEpoch: number,
): PlacementEpochConflictError {
  if (err instanceof PlacementEpochConflictError) return err
  const matchedCode = extractAuthorityConflictCode(err) ?? 'PLACEMENT_EPOCH_CONFLICT'
  return new PlacementEpochConflictError(sessionKey, expectedEpoch, -1, matchedCode)
}

function extractPromptStateFromMeta(
  sessionKey: string,
  meta: Readonly<Record<string, unknown>> | null | undefined,
  placementEpoch?: number,
): LocalPromptStateRecord | null {
  if (!meta) return null
  const candidate =
    meta.promptState && typeof meta.promptState === 'object' && !Array.isArray(meta.promptState)
      ? (meta.promptState as Record<string, unknown>)
      : meta
  if (
    typeof candidate.conversationId !== 'string' ||
    candidate.conversationId.length === 0 ||
    typeof candidate.inputsKey !== 'string' ||
    candidate.inputsKey.length === 0 ||
    typeof candidate.injectedAfterBaseline !== 'number' ||
    !Number.isFinite(candidate.injectedAfterBaseline)
  ) {
    return null
  }
  let slotHashes: Record<string, string> | undefined
  if (
    candidate.slotHashes &&
    typeof candidate.slotHashes === 'object' &&
    !Array.isArray(candidate.slotHashes)
  ) {
    const normalized: Record<string, string> = {}
    for (const [k, v] of Object.entries(candidate.slotHashes as Record<string, unknown>)) {
      if (typeof v === 'string') normalized[k] = v
    }
    slotHashes = normalized
  }
  const effectiveEpoch =
    placementEpoch ??
    (typeof candidate.placementEpoch === 'number' && Number.isSafeInteger(candidate.placementEpoch)
      ? candidate.placementEpoch
      : undefined)
  return {
    v: 1,
    sessionKey,
    conversationId: candidate.conversationId,
    inputsKey: candidate.inputsKey,
    ...(slotHashes ? { slotHashes } : {}),
    injectedAfterBaseline: candidate.injectedAfterBaseline,
    ...(effectiveEpoch !== undefined ? { placementEpoch: effectiveEpoch } : {}),
    updatedAt:
      typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : Date.now(),
  }
}

function toLocalResumeEntry(
  pointer: SessionEnginePointer,
  lastCost?: number,
  costImprecise?: boolean,
): LocalResumeStateEntry {
  const baselineCost =
    lastCost ??
    (typeof pointer.usageBaseline?.totalCostUsd === 'number'
      ? pointer.usageBaseline.totalCostUsd
      : undefined)
  return {
    nativeSessionId: pointer.nativeSessionId,
    engine: pointer.engine,
    history: [...pointer.history],
    rejectedIds: [...pointer.rejectedIds],
    placementEpoch: pointer.placementEpoch,
    ...(baselineCost !== undefined ? { lastCost: baselineCost } : {}),
    ...(costImprecise !== undefined ? { costImprecise } : {}),
    historyContextVersion: pointer.historyContextVersion ?? null,
    promotedFromHistory: pointer.promotedFromHistory,
    usageBaseline: pointer.usageBaseline ?? null,
    updatedAtMs: Date.parse(pointer.updatedAt) || Date.now(),
  }
}

function toLocalCheckpointRecord(cp: AuthoritativeRollingCheckpoint): LocalCheckpointRecord {
  const createdAtMs = Date.parse(cp.createdAt)
  return {
    sessionKey: cp.sessionKey,
    generation: cp.checkpointGeneration,
    summary: cp.summary,
    createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
    ...(typeof cp.instructions === 'string' && cp.instructions.length > 0
      ? { instructions: cp.instructions }
      : {}),
  }
}

export class AuthorityStateBridge {
  private readonly tenantId: string
  private readonly authorityStore: SessionAuthorityStore | null
  private readonly localResumeStore: LocalResumeStoreAdapter | null
  private readonly localCheckpointStore: LocalCheckpointStoreAdapter | null
  private readonly localPromptState: LocalPromptStateAdapter | null
  private readonly defaultPoolKind: StoragePoolKind
  private readonly metrics: AuthorityBridgeMetrics = {
    authorityWritesOk: 0,
    authorityWritesDegraded: 0,
    authorityReadsOk: 0,
    authorityReadsDegraded: 0,
    readThroughHydrations: 0,
    checkpointAcksOk: 0,
    checkpointAcksRejected: 0,
  }

  constructor(options: AuthorityStateBridgeOptions) {
    this.tenantId = options.tenantId
    this.authorityStore = options.authorityStore ?? null
    this.localResumeStore = options.localResumeStore ?? null
    this.localCheckpointStore = options.localCheckpointStore ?? null
    this.localPromptState = options.localPromptState ?? null
    this.defaultPoolKind = options.defaultPoolKind ?? 'local_container'
  }

  getMetrics(): Readonly<AuthorityBridgeMetrics> {
    return { ...this.metrics }
  }

  /** Write-through session engine pointer to authority store (with epoch CAS) + local resume-map. */
  async writePointer(input: WritePointerInput): Promise<WritePointerResult> {
    const nowIso = new Date().toISOString()
    const usageBaseline: Record<string, number> | null =
      input.usageBaseline || input.lastCost !== undefined
        ? {
            ...(input.usageBaseline ?? {}),
            ...(input.lastCost !== undefined ? { totalCostUsd: input.lastCost } : {}),
          }
        : null

    let pointer: SessionEnginePointer = {
      sessionKey: input.sessionKey,
      placementEpoch: input.placementEpoch,
      poolKind: input.poolKind ?? this.defaultPoolKind,
      engine: input.engine,
      nativeSessionId: input.nativeSessionId,
      ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
      ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
      ...(input.capsuleId !== undefined ? { capsuleId: input.capsuleId } : {}),
      history: [...(input.history ?? [])],
      rejectedIds: [...(input.rejectedIds ?? [])],
      promptCacheMeta: input.promptCacheMeta ?? null,
      usageBaseline,
      historyContextVersion: input.historyContextVersion ?? null,
      promotedFromHistory: input.promotedFromHistory ?? false,
      migrationState: input.migrationState ?? 'active',
      activeMigrationId: input.activeMigrationId ?? null,
      updatedAt: nowIso,
    }

    let authorityDegraded = false
    if (this.authorityStore) {
      try {
        pointer = await this.authorityStore.upsertPointer(
          this.tenantId,
          pointer,
          input.expectedPlacementEpoch,
        )
        this.metrics.authorityWritesOk += 1
      } catch (err) {
        if (isAuthorityConflictError(err)) {
          throw toPlacementEpochConflictError(
            err,
            input.sessionKey,
            input.expectedPlacementEpoch ?? input.placementEpoch,
          )
        }
        authorityDegraded = true
        this.metrics.authorityWritesDegraded += 1
      }
    }

    if (this.localResumeStore) {
      await this.localResumeStore.set(
        input.sessionKey,
        toLocalResumeEntry(pointer, input.lastCost, input.costImprecise),
      )
    }

    if (this.localPromptState) {
      const promptState = extractPromptStateFromMeta(
        input.sessionKey,
        pointer.promptCacheMeta,
        pointer.placementEpoch,
      )
      if (promptState) {
        await this.localPromptState.write(promptState)
      }
    }

    return { pointer, authorityDegraded }
  }

  /**
   * Read-through pointer: when authority is reachable, validates local cache
   * `placementEpoch` against authoritative `placementEpoch` and forces a refresh
   * whenever the local cache lags; auto-hydrates on local miss and falls back to
   * local cache when authority is unreachable.
   */
  async readPointer(
    sessionKey: string,
    opts?: { readonly preferAuthority?: boolean },
  ): Promise<ReadPointerResult> {
    const local = this.localResumeStore ? await this.localResumeStore.get(sessionKey) : null

    if (!this.authorityStore) {
      return {
        pointer: null,
        localEntry: local,
        hydratedFromAuthority: false,
        authorityDegraded: false,
      }
    }

    if (local && !opts?.preferAuthority) {
      try {
        const remoteEpoch = await this.authorityStore.getEpoch(this.tenantId, sessionKey)
        if (
          remoteEpoch &&
          local.placementEpoch !== undefined &&
          local.placementEpoch === remoteEpoch.placementEpoch
        ) {
          this.metrics.authorityReadsOk += 1
          return {
            pointer: null,
            localEntry: local,
            hydratedFromAuthority: false,
            authorityDegraded: false,
          }
        }
        const remote = await this.authorityStore.getPointer(this.tenantId, sessionKey)
        this.metrics.authorityReadsOk += 1
        if (!remote) {
          return {
            pointer: null,
            localEntry: local,
            hydratedFromAuthority: false,
            authorityDegraded: false,
          }
        }
        if (local.placementEpoch !== undefined && local.placementEpoch === remote.placementEpoch) {
          return {
            pointer: remote,
            localEntry: local,
            hydratedFromAuthority: false,
            authorityDegraded: false,
          }
        }
        const refreshedLocal = toLocalResumeEntry(remote)
        if (this.localResumeStore) {
          await this.localResumeStore.set(sessionKey, refreshedLocal)
        }
        if (this.localPromptState) {
          const promptState = extractPromptStateFromMeta(
            sessionKey,
            remote.promptCacheMeta,
            remote.placementEpoch,
          )
          if (promptState) {
            await this.localPromptState.write(promptState)
          }
        }
        this.metrics.readThroughHydrations += 1
        return {
          pointer: remote,
          localEntry: refreshedLocal,
          hydratedFromAuthority: true,
          authorityDegraded: false,
        }
      } catch {
        this.metrics.authorityReadsDegraded += 1
        return {
          pointer: null,
          localEntry: local,
          hydratedFromAuthority: false,
          authorityDegraded: true,
        }
      }
    }

    try {
      const remote = await this.authorityStore.getPointer(this.tenantId, sessionKey)
      this.metrics.authorityReadsOk += 1
      if (!remote) {
        return {
          pointer: null,
          localEntry: null,
          hydratedFromAuthority: false,
          authorityDegraded: false,
        }
      }

      const localEntry = toLocalResumeEntry(remote)
      if (this.localResumeStore) {
        await this.localResumeStore.set(sessionKey, localEntry)
      }
      if (this.localPromptState) {
        const promptState = extractPromptStateFromMeta(
          sessionKey,
          remote.promptCacheMeta,
          remote.placementEpoch,
        )
        if (promptState) {
          await this.localPromptState.write(promptState)
        }
      }
      this.metrics.readThroughHydrations += 1
      return {
        pointer: remote,
        localEntry,
        hydratedFromAuthority: true,
        authorityDegraded: false,
      }
    } catch {
      this.metrics.authorityReadsDegraded += 1
      return {
        pointer: null,
        localEntry: local,
        hydratedFromAuthority: false,
        authorityDegraded: true,
      }
    }
  }

  /** Write-through rolling checkpoint to authority store + local checkpoint file. */
  async saveRollingCheckpoint(
    input: SaveRollingCheckpointInput,
  ): Promise<SaveRollingCheckpointResult> {
    const trimmed = input.summary.trim()
    if (!trimmed) {
      throw new Error('EMPTY_CHECKPOINT_SUMMARY')
    }
    const createdAtIso = input.createdAt ?? new Date().toISOString()
    const checkpoint: AuthoritativeRollingCheckpoint = {
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      checkpointGeneration: input.checkpointGeneration,
      placementEpoch: input.placementEpoch,
      mode: input.mode,
      anchorSeq: input.anchorSeq,
      sourceEngine: input.sourceEngine,
      summary: trimmed,
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ackedByTurnKey: null,
      ackedAt: null,
      createdAt: createdAtIso,
    }
    const localRecord = toLocalCheckpointRecord(checkpoint)

    let authorityDegraded = false
    if (this.authorityStore) {
      try {
        await this.authorityStore.saveCheckpoint(this.tenantId, checkpoint)
        this.metrics.authorityWritesOk += 1
      } catch (err) {
        if (isAuthorityConflictError(err)) {
          throw toPlacementEpochConflictError(err, input.sessionKey, input.placementEpoch)
        }
        authorityDegraded = true
        this.metrics.authorityWritesDegraded += 1
      }
    }

    if (this.localCheckpointStore) {
      await this.localCheckpointStore.save(localRecord)
    }

    return { checkpoint, localRecord, authorityDegraded }
  }

  /**
   * Read-through rolling checkpoint: returns local pending checkpoint if present;
   * otherwise fetches from authority store and hydrates locally only if unacked.
   */
  async peekRollingCheckpoint(sessionKey: string): Promise<PeekRollingCheckpointResult> {
    if (this.localCheckpointStore) {
      const local = await this.localCheckpointStore.peek(sessionKey)
      if (local) {
        return {
          localRecord: local,
          authoritativeRecord: null,
          hydratedFromAuthority: false,
          authorityDegraded: false,
        }
      }
    }

    if (!this.authorityStore) {
      return {
        localRecord: null,
        authoritativeRecord: null,
        hydratedFromAuthority: false,
        authorityDegraded: false,
      }
    }

    try {
      const remote = await this.authorityStore.getLatestCheckpoint(this.tenantId, sessionKey)
      this.metrics.authorityReadsOk += 1
      if (!remote || remote.ackedByTurnKey || remote.ackedAt) {
        return {
          localRecord: null,
          authoritativeRecord: remote,
          hydratedFromAuthority: false,
          authorityDegraded: false,
        }
      }

      const localRecord = toLocalCheckpointRecord(remote)
      if (this.localCheckpointStore) {
        await this.localCheckpointStore.save(localRecord)
      }
      this.metrics.readThroughHydrations += 1
      return {
        localRecord,
        authoritativeRecord: remote,
        hydratedFromAuthority: true,
        authorityDegraded: false,
      }
    } catch {
      this.metrics.authorityReadsDegraded += 1
      return {
        localRecord: null,
        authoritativeRecord: null,
        hydratedFromAuthority: false,
        authorityDegraded: true,
      }
    }
  }

  /**
   * Generation CAS Ack: validates `checkpointGeneration` against authority store
   * AND local checkpoint store before atomically consuming the checkpoint.
   */
  async ackRollingCheckpoint(
    input: AckRollingCheckpointInput,
  ): Promise<AckRollingCheckpointResult> {
    let authorityAcked = false
    let authorityDegraded = false

    if (this.authorityStore) {
      try {
        authorityAcked = await this.authorityStore.ackCheckpoint(
          this.tenantId,
          input.sessionKey,
          input.checkpointGeneration,
          input.turnKey,
        )
        if (!authorityAcked) {
          this.metrics.checkpointAcksRejected += 1
          return {
            acked: false,
            authorityAcked: false,
            localAcked: false,
            authorityDegraded: false,
            reason: 'authority_generation_mismatch_or_already_acked',
          }
        }
      } catch (err) {
        if (isAuthorityConflictError(err)) {
          throw toPlacementEpochConflictError(err, input.sessionKey, -1)
        }
        authorityDegraded = true
        this.metrics.authorityWritesDegraded += 1
      }
    }

    let localAcked = false
    if (this.localCheckpointStore) {
      localAcked = await this.localCheckpointStore.ack(input.sessionKey, input.checkpointGeneration)
    }

    const acked = this.authorityStore
      ? authorityDegraded
        ? localAcked
        : authorityAcked
      : localAcked

    if (acked) {
      this.metrics.checkpointAcksOk += 1
    } else {
      this.metrics.checkpointAcksRejected += 1
    }

    return {
      acked,
      authorityAcked,
      localAcked,
      authorityDegraded,
      ...(acked ? {} : { reason: 'local_generation_mismatch' }),
    }
  }

  /** Write-through Antigravity prompt-state into authority pointer `promptCacheMeta` + local file. */
  async writePromptState(input: WritePromptStateInput): Promise<WritePromptStateResult> {
    const stampedRecord: LocalPromptStateRecord = {
      ...input.record,
      placementEpoch: input.placementEpoch,
    }
    let authorityDegraded = false
    if (this.authorityStore) {
      try {
        const existing = await this.authorityStore.getPointer(
          this.tenantId,
          input.record.sessionKey,
        )
        const mergedMeta: Record<string, unknown> = {
          ...(existing?.promptCacheMeta ?? {}),
          conversationId: stampedRecord.conversationId,
          inputsKey: stampedRecord.inputsKey,
          injectedAfterBaseline: stampedRecord.injectedAfterBaseline,
          ...(stampedRecord.slotHashes ? { slotHashes: stampedRecord.slotHashes } : {}),
          placementEpoch: input.placementEpoch,
          updatedAt: stampedRecord.updatedAt,
          promptState: stampedRecord,
        }
        const nextPointer: SessionEnginePointer = {
          sessionKey: stampedRecord.sessionKey,
          placementEpoch: input.placementEpoch,
          poolKind: input.poolKind ?? existing?.poolKind ?? this.defaultPoolKind,
          engine: existing?.engine ?? input.engine,
          nativeSessionId: existing?.nativeSessionId ?? stampedRecord.conversationId,
          operationId: existing?.operationId ?? null,
          profileId: existing?.profileId ?? null,
          capsuleId: existing?.capsuleId ?? null,
          history: existing?.history ?? [],
          rejectedIds: existing?.rejectedIds ?? [],
          promptCacheMeta: mergedMeta,
          usageBaseline: existing?.usageBaseline ?? null,
          historyContextVersion: existing?.historyContextVersion ?? null,
          promotedFromHistory: existing?.promotedFromHistory ?? false,
          migrationState: existing?.migrationState ?? 'active',
          activeMigrationId: existing?.activeMigrationId ?? null,
          updatedAt: new Date().toISOString(),
        }
        await this.authorityStore.upsertPointer(
          this.tenantId,
          nextPointer,
          input.expectedPlacementEpoch,
        )
        this.metrics.authorityWritesOk += 1
      } catch (err) {
        if (isAuthorityConflictError(err)) {
          throw toPlacementEpochConflictError(
            err,
            input.record.sessionKey,
            input.expectedPlacementEpoch ?? input.placementEpoch,
          )
        }
        authorityDegraded = true
        this.metrics.authorityWritesDegraded += 1
      }
    }

    if (this.localPromptState) {
      await this.localPromptState.write(stampedRecord)
    }

    return { record: stampedRecord, authorityDegraded }
  }

  /**
   * Read-through Antigravity prompt-state: validates local `placementEpoch` against
   * authority when reachable and forces refresh if stale; hydrates on local miss.
   */
  async readPromptState(sessionKey: string): Promise<ReadPromptStateResult> {
    const local = this.localPromptState ? await this.localPromptState.read(sessionKey) : null

    if (!this.authorityStore) {
      return {
        record: local,
        hydratedFromAuthority: false,
        authorityDegraded: false,
      }
    }

    if (local) {
      try {
        const remoteEpoch = await this.authorityStore.getEpoch(this.tenantId, sessionKey)
        if (
          remoteEpoch &&
          local.placementEpoch !== undefined &&
          local.placementEpoch >= remoteEpoch.placementEpoch
        ) {
          this.metrics.authorityReadsOk += 1
          return {
            record: local,
            hydratedFromAuthority: false,
            authorityDegraded: false,
          }
        }
        const remote = await this.authorityStore.getPointer(this.tenantId, sessionKey)
        this.metrics.authorityReadsOk += 1
        if (
          remote &&
          (local.placementEpoch === undefined || local.placementEpoch < remote.placementEpoch)
        ) {
          const promptState = extractPromptStateFromMeta(
            sessionKey,
            remote.promptCacheMeta,
            remote.placementEpoch,
          )
          if (promptState) {
            if (this.localPromptState) {
              await this.localPromptState.write(promptState)
            }
            this.metrics.readThroughHydrations += 1
            return {
              record: promptState,
              hydratedFromAuthority: true,
              authorityDegraded: false,
            }
          }
        }
        return {
          record: local,
          hydratedFromAuthority: false,
          authorityDegraded: false,
        }
      } catch {
        this.metrics.authorityReadsDegraded += 1
        return {
          record: local,
          hydratedFromAuthority: false,
          authorityDegraded: true,
        }
      }
    }

    try {
      const remote = await this.authorityStore.getPointer(this.tenantId, sessionKey)
      this.metrics.authorityReadsOk += 1
      const promptState = extractPromptStateFromMeta(
        sessionKey,
        remote?.promptCacheMeta,
        remote?.placementEpoch,
      )
      if (!promptState) {
        return {
          record: null,
          hydratedFromAuthority: false,
          authorityDegraded: false,
        }
      }
      if (this.localPromptState) {
        await this.localPromptState.write(promptState)
      }
      this.metrics.readThroughHydrations += 1
      return {
        record: promptState,
        hydratedFromAuthority: true,
        authorityDegraded: false,
      }
    } catch {
      this.metrics.authorityReadsDegraded += 1
      return {
        record: null,
        hydratedFromAuthority: false,
        authorityDegraded: true,
      }
    }
  }
}

/**
 * In-memory reference implementation of L0 `SessionAuthorityStore` with strict
 * placement-epoch CAS fencing, rolling checkpoint CAS ack, and migration lifecycle.
 */
export class InMemorySessionAuthorityStore implements SessionAuthorityStore {
  private readonly epochs = new Map<string, SessionAuthorityEpoch>()
  private readonly pointers = new Map<string, SessionEnginePointer>()
  private readonly checkpoints = new Map<string, AuthoritativeRollingCheckpoint>()
  private readonly migrations = new Map<string, PlacementMigrationRecord>()

  private key(tenantId: string, sessionKey: string): string {
    return `${tenantId}::${sessionKey}`
  }

  private migKey(tenantId: string, migrationId: string): string {
    return `${tenantId}::mig::${migrationId}`
  }

  async getEpoch(tenantId: string, sessionKey: string): Promise<SessionAuthorityEpoch | null> {
    return this.epochs.get(this.key(tenantId, sessionKey)) ?? null
  }

  async getPointer(tenantId: string, sessionKey: string): Promise<SessionEnginePointer | null> {
    return this.pointers.get(this.key(tenantId, sessionKey)) ?? null
  }

  async upsertPointer(
    tenantId: string,
    pointer: SessionEnginePointer,
    expectedEpoch?: number,
  ): Promise<SessionEnginePointer> {
    const k = this.key(tenantId, pointer.sessionKey)
    const current = this.pointers.get(k)
    if (current?.migrationState === 'migrating') {
      throw new Error('SESSION_PLACEMENT_MIGRATING')
    }
    const currentEpoch = current?.placementEpoch ?? 0
    if (expectedEpoch !== undefined && currentEpoch !== expectedEpoch) {
      throw new PlacementEpochConflictError(pointer.sessionKey, expectedEpoch, currentEpoch)
    }
    const stored: SessionEnginePointer = {
      ...pointer,
      createdAt: current?.createdAt ?? pointer.createdAt ?? pointer.updatedAt,
    }
    this.pointers.set(k, stored)
    this.epochs.set(k, {
      tenantId,
      sessionKey: pointer.sessionKey,
      placementEpoch: pointer.placementEpoch,
      migrationState: pointer.migrationState,
      activeMigrationId: pointer.activeMigrationId ?? null,
      updatedAt: pointer.updatedAt,
    })
    return stored
  }

  async getLatestCheckpoint(
    tenantId: string,
    sessionKey: string,
  ): Promise<AuthoritativeRollingCheckpoint | null> {
    return this.checkpoints.get(this.key(tenantId, sessionKey)) ?? null
  }

  async saveCheckpoint(
    tenantId: string,
    checkpoint: AuthoritativeRollingCheckpoint,
  ): Promise<void> {
    this.checkpoints.set(this.key(tenantId, checkpoint.sessionKey), { ...checkpoint })
  }

  async ackCheckpoint(
    tenantId: string,
    sessionKey: string,
    checkpointGeneration: string,
    turnKey: string,
  ): Promise<boolean> {
    const k = this.key(tenantId, sessionKey)
    const current = this.checkpoints.get(k)
    if (!current) return false
    if (current.checkpointGeneration !== checkpointGeneration) return false
    if (current.ackedByTurnKey || current.ackedAt) return false
    this.checkpoints.set(k, {
      ...current,
      ackedByTurnKey: turnKey,
      ackedAt: new Date().toISOString(),
    })
    return true
  }

  async beginPlacementMigration(
    tenantId: string,
    migration: Omit<PlacementMigrationRecord, 'state' | 'completedAt'>,
  ): Promise<PlacementMigrationRecord> {
    const rec: PlacementMigrationRecord = {
      ...migration,
      state: 'migrating',
      completedAt: null,
    }
    this.migrations.set(this.migKey(tenantId, migration.migrationId), rec)
    return rec
  }

  async commitPlacementMigration(
    tenantId: string,
    migrationId: string,
    outcome: {
      readonly continuityTier: ResumeLadderTier
      readonly capsuleRef?: EngineStateCapsuleRef | null
    },
  ): Promise<PlacementMigrationRecord> {
    const k = this.migKey(tenantId, migrationId)
    const existing = this.migrations.get(k)
    if (!existing) throw new Error('MIGRATION_NOT_FOUND')
    const updated: PlacementMigrationRecord = {
      ...existing,
      state: 'committed',
      continuityTier: outcome.continuityTier,
      capsuleRef: outcome.capsuleRef ?? existing.capsuleRef ?? null,
      completedAt: new Date().toISOString(),
    }
    this.migrations.set(k, updated)
    return updated
  }

  async abortPlacementMigration(
    tenantId: string,
    migrationId: string,
    reason: string,
  ): Promise<PlacementMigrationRecord> {
    const k = this.migKey(tenantId, migrationId)
    const existing = this.migrations.get(k)
    if (!existing) throw new Error('MIGRATION_NOT_FOUND')
    const updated: PlacementMigrationRecord = {
      ...existing,
      state: 'aborted',
      reason,
      completedAt: new Date().toISOString(),
    }
    this.migrations.set(k, updated)
    return updated
  }
}
