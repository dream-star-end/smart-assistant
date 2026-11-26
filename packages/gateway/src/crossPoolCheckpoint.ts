/**
 * OCV5-902 P0-1 — Container-side verified cross-pool checkpoint ingestion, install receipt
 * emission, and migration-aware stored-resume isolation (`gateway-runtime`, L3).
 *
 * Strictly fail-closed: accepts `frame._crossPoolCheckpoint` ONLY when backed by a
 * cryptographically verified `turnAuthority.poolMigration` grant (`allowBackendTransition === true`,
 * `continuityTier === 'tape_rebuilt'`, exact `migrationId` & `placementEpoch` match) AND an exact
 * SHA-256 match over `summary`. Any failure is ignored safely without fabricating state or crashing.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { RemoteExecutionBackend } from '@openclaude/protocol'
import { paths } from '@openclaude/storage'
import { isCc5ResumeId, parseCc5ResumeId } from './engine/cc5ResumeId.js'
import type { TurnExecutionDescriptor } from './modelAuthority.js'
import { isRemoteV4ResumeId, parseRemoteV4ResumeId } from './remotePool/resumeId.js'
import type { PersistedCheckpointRecord } from './sessionCheckpointStore.js'

export const CROSS_POOL_CHECKPOINT_FIELD = '_crossPoolCheckpoint' as const
export const CROSS_POOL_CHECKPOINT_WIRE_VERSION = 1 as const
export const CROSS_POOL_CHECKPOINT_MAX_SUMMARY_CHARS = 16_384
export const MIGRATION_INSTALL_RECEIPT_TYPE = 'outbound.control.migration_install_receipt' as const

const SHA256_HEX_RE = /^[0-9a-f]{64}$/

function defaultSaveCheckpointWithGeneration(
  sessionKey: string,
  summary: string,
  opts: { generation: string; instructions?: string; baseDir?: string; placementEpoch?: number },
): PersistedCheckpointRecord {
  const dir = opts.baseDir ?? join(paths.home, 'checkpoints')
  const hash = createHash('sha256').update(sessionKey).digest('hex').slice(0, 32)
  const filePath = join(dir, `${hash}.json`)
  const watermarkPath = join(dir, `${hash}.watermark.json`)

  let highestEpoch = 0
  let consumedGenerations: string[] = []
  try {
    const wmSt = lstatSync(watermarkPath)
    if (!wmSt.isSymbolicLink() && wmSt.isFile()) {
      const wm = JSON.parse(readFileSync(watermarkPath, 'utf8')) as {
        sessionKey?: unknown
        highestPlacementEpoch?: unknown
        consumedGenerations?: unknown
      }
      if (wm && wm.sessionKey === sessionKey) {
        if (Array.isArray(wm.consumedGenerations)) {
          consumedGenerations = wm.consumedGenerations.filter(
            (g): g is string => typeof g === 'string' && g.length > 0,
          )
        }
        if (
          typeof wm.highestPlacementEpoch === 'number' &&
          Number.isSafeInteger(wm.highestPlacementEpoch) &&
          wm.highestPlacementEpoch >= 1
        ) {
          highestEpoch = wm.highestPlacementEpoch
        }
      }
    }
  } catch {
    // ENOENT or unreadable watermark
  }
  if (consumedGenerations.includes(opts.generation)) {
    throw new Error('CHECKPOINT_GENERATION_ALREADY_CONSUMED')
  }

  let existing: PersistedCheckpointRecord | null = null
  try {
    const existingSt = lstatSync(filePath)
    if (!existingSt.isSymbolicLink() && existingSt.isFile()) {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<PersistedCheckpointRecord>
      if (
        parsed &&
        parsed.sessionKey === sessionKey &&
        typeof parsed.generation === 'string' &&
        parsed.generation.length > 0 &&
        typeof parsed.summary === 'string' &&
        parsed.summary.trim().length > 0
      ) {
        const ep =
          typeof parsed.placementEpoch === 'number' &&
          Number.isSafeInteger(parsed.placementEpoch) &&
          parsed.placementEpoch >= 1
            ? parsed.placementEpoch
            : undefined
        if (ep !== undefined && ep > highestEpoch) highestEpoch = ep
        existing = {
          sessionKey: parsed.sessionKey,
          generation: parsed.generation,
          summary: parsed.summary,
          createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
          ...(typeof parsed.instructions === 'string' ? { instructions: parsed.instructions } : {}),
          ...(ep !== undefined ? { placementEpoch: ep } : {}),
        }
      }
    }
  } catch {
    // ENOENT or unreadable existing file: fall through to atomic write with safety checks.
  }

  if (opts.placementEpoch !== undefined && highestEpoch > 0 && opts.placementEpoch < highestEpoch) {
    throw new Error('CHECKPOINT_STALE_PLACEMENT_EPOCH')
  }
  if (existing && existing.generation === opts.generation) {
    return existing
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const dirSt = lstatSync(dir)
  if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
    throw new Error('CHECKPOINT_DIR_UNSAFE')
  }
  try {
    const fileSt = lstatSync(filePath)
    if (fileSt.isSymbolicLink() || !fileSt.isFile()) {
      throw new Error('CHECKPOINT_FILE_UNSAFE')
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
  }

  const record: PersistedCheckpointRecord = {
    sessionKey,
    generation: opts.generation,
    summary: summary.trim(),
    createdAt: Date.now(),
    ...(opts.instructions?.trim() ? { instructions: opts.instructions.trim() } : {}),
    ...(opts.placementEpoch !== undefined ? { placementEpoch: opts.placementEpoch } : {}),
  }
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const realDir = realpathSync(dir)
  writeFileSync(tmpPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
  if (!realpathSync(tmpPath).startsWith(realDir)) {
    rmSync(tmpPath, { force: true })
    throw new Error('CHECKPOINT_PATH_ESCAPE')
  }
  renameSync(tmpPath, filePath)
  if (opts.placementEpoch !== undefined && opts.placementEpoch > highestEpoch) {
    const wmTmp = `${watermarkPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(
      wmTmp,
      JSON.stringify({
        sessionKey,
        highestPlacementEpoch: opts.placementEpoch,
        consumedGenerations: consumedGenerations.slice(-64),
      }),
      { encoding: 'utf8', mode: 0o600 },
    )
    if (!realpathSync(wmTmp).startsWith(realDir)) {
      rmSync(wmTmp, { force: true })
      throw new Error('CHECKPOINT_PATH_ESCAPE')
    }
    renameSync(wmTmp, watermarkPath)
  }
  return record
}

export type CrossPoolCheckpointRejectReason =
  | 'missing'
  | 'invalid_shape'
  | 'missing_authority'
  | 'migration_not_allowed'
  | 'tier_mismatch'
  | 'migration_id_mismatch'
  | 'epoch_mismatch'
  | 'sha256_mismatch'
  | 'stale_epoch'
  | 'already_consumed'
  | 'persist_failed'

export type IngestCrossPoolCheckpointResult =
  | {
      readonly accepted: true
      readonly generation: string
      readonly migrationId: string
      readonly placementEpoch: number
    }
  | {
      readonly accepted: false
      readonly reason: CrossPoolCheckpointRejectReason
      readonly generation?: string
      readonly migrationId?: string
      readonly placementEpoch?: number
    }

export interface IngestCrossPoolCheckpointOptions {
  readonly baseDir?: string
  readonly saveCheckpoint?: (
    sessionKey: string,
    summary: string,
    opts: { generation: string; instructions?: string; baseDir?: string; placementEpoch?: number },
  ) => PersistedCheckpointRecord
}

export interface MigrationInstallReceiptFrame {
  readonly type: typeof MIGRATION_INSTALL_RECEIPT_TYPE
  readonly sessionKey: string
  readonly channel: string
  readonly peer?: { readonly id: string; readonly kind: string }
  readonly clientMessageId?: string
  readonly dispatchId?: string
  readonly attemptNo?: number
  readonly migrationId: string
  readonly placementEpoch: number
  readonly continuityTier: string
  readonly checkpointGeneration: string | null
  readonly _userId?: string
}

export interface BuildMigrationInstallReceiptInput {
  readonly sessionKey: string
  readonly migrationId: string
  readonly placementEpoch: number
  readonly continuityTier: string
  readonly checkpointGeneration: string | null
  readonly clientMessageId?: string
  readonly dispatchId?: string
  readonly attemptNo?: number
  readonly channel?: string
  readonly peer?: { readonly id: string; readonly kind: string }
  readonly userId?: string
}

export interface FinalizeInboundCrossPoolMigrationOptions {
  readonly dispatchContext?: {
    readonly dispatchId?: string
    readonly attemptNo?: number
    readonly clientMessageId?: string
  }
  readonly clientMessageId?: string
  readonly userId?: string
  readonly baseDir?: string
  readonly saveCheckpoint?: IngestCrossPoolCheckpointOptions['saveCheckpoint']
}

export interface FinalizeInboundCrossPoolMigrationResult {
  readonly handled: boolean
  readonly receiptSent: boolean
  readonly ingestResult?: IngestCrossPoolCheckpointResult
  readonly receipt?: MigrationInstallReceiptFrame
  readonly fatalError?: string
}

export interface MigrationAwareStoredResumeResult {
  readonly effectiveStoredResumeId: string | undefined
  readonly clearStaleResume: boolean
}

/**
 * OCV5-902 B1: Constructs a validated `outbound.control.migration_install_receipt` frame.
 * Enforces that `tape_rebuilt` receipts ALWAYS carry a non-empty `checkpointGeneration`.
 */
export function buildMigrationInstallReceipt(
  input: BuildMigrationInstallReceiptInput,
): MigrationInstallReceiptFrame | null {
  const sessionKey = typeof input.sessionKey === 'string' ? input.sessionKey.trim() : ''
  const migrationId = typeof input.migrationId === 'string' ? input.migrationId.trim() : ''
  const continuityTier =
    typeof input.continuityTier === 'string' ? input.continuityTier.trim() : ''
  if (
    sessionKey.length === 0 ||
    migrationId.length < 8 ||
    migrationId.length > 128 ||
    typeof input.placementEpoch !== 'number' ||
    !Number.isSafeInteger(input.placementEpoch) ||
    input.placementEpoch < 1 ||
    continuityTier.length === 0
  ) {
    return null
  }
  const checkpointGeneration =
    input.checkpointGeneration === null
      ? null
      : typeof input.checkpointGeneration === 'string' &&
          input.checkpointGeneration.trim().length > 0 &&
          input.checkpointGeneration.trim().length <= 128
        ? input.checkpointGeneration.trim()
        : undefined
  if (checkpointGeneration === undefined) return null
  if (continuityTier === 'tape_rebuilt' && checkpointGeneration === null) {
    return null
  }
  const clientMessageId =
    typeof input.clientMessageId === 'string' && input.clientMessageId.trim().length > 0
      ? input.clientMessageId.trim()
      : undefined
  const dispatchId =
    typeof input.dispatchId === 'string' && input.dispatchId.trim().length > 0
      ? input.dispatchId.trim()
      : undefined
  const attemptNo =
    typeof input.attemptNo === 'number' &&
    Number.isSafeInteger(input.attemptNo) &&
    input.attemptNo >= 1
      ? input.attemptNo
      : undefined
  const channel =
    typeof input.channel === 'string' && input.channel.trim().length > 0
      ? input.channel.trim()
      : 'webchat'
  const peer =
    input.peer &&
    typeof input.peer.id === 'string' &&
    input.peer.id.length > 0 &&
    typeof input.peer.kind === 'string' &&
    input.peer.kind.length > 0
      ? { id: input.peer.id, kind: input.peer.kind }
      : undefined
  const userId =
    typeof input.userId === 'string' && input.userId.length > 0 ? input.userId : undefined

  return Object.freeze({
    type: MIGRATION_INSTALL_RECEIPT_TYPE,
    sessionKey,
    channel,
    ...(peer ? { peer } : {}),
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(dispatchId ? { dispatchId } : {}),
    ...(attemptNo !== undefined ? { attemptNo } : {}),
    migrationId,
    placementEpoch: input.placementEpoch,
    continuityTier,
    checkpointGeneration,
    ...(userId ? { _userId: userId } : {}),
  })
}

/**
 * Validates `frame._crossPoolCheckpoint` against the Ed25519-verified `turnAuthority` and
 * persists it atomically (idempotent by `generation`, watermark-guarded by `placementEpoch`
 * & consumed generations) for `sessionSubmit` consumption.
 */
export function ingestVerifiedCrossPoolCheckpoint(
  frame: unknown,
  turnAuthority: Pick<TurnExecutionDescriptor, 'poolMigration'> | undefined,
  sessionKey: string,
  opts?: IngestCrossPoolCheckpointOptions,
): IngestCrossPoolCheckpointResult {
  if (!frame || typeof frame !== 'object') {
    return Object.freeze({ accepted: false as const, reason: 'missing' as const })
  }
  const raw = (frame as Record<string, unknown>)[CROSS_POOL_CHECKPOINT_FIELD]
  if (raw === undefined || raw === null) {
    return Object.freeze({ accepted: false as const, reason: 'missing' as const })
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return Object.freeze({ accepted: false as const, reason: 'invalid_shape' as const })
  }
  if (typeof sessionKey !== 'string' || sessionKey.trim().length === 0) {
    return Object.freeze({ accepted: false as const, reason: 'invalid_shape' as const })
  }

  const rec = raw as Record<string, unknown>
  const summary = rec.summary
  const sha256 = rec.sha256
  const generation = rec.generation
  const migrationId = rec.migrationId
  const placementEpoch = rec.placementEpoch
  const instructions = rec.instructions

  if (
    rec.v !== CROSS_POOL_CHECKPOINT_WIRE_VERSION ||
    typeof summary !== 'string' ||
    summary.trim().length === 0 ||
    summary.length > CROSS_POOL_CHECKPOINT_MAX_SUMMARY_CHARS ||
    typeof sha256 !== 'string' ||
    !SHA256_HEX_RE.test(sha256) ||
    typeof generation !== 'string' ||
    generation.trim().length === 0 ||
    generation.length > 128 ||
    typeof migrationId !== 'string' ||
    migrationId.trim().length < 8 ||
    migrationId.length > 128 ||
    typeof placementEpoch !== 'number' ||
    !Number.isSafeInteger(placementEpoch) ||
    placementEpoch < 1 ||
    (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 4_096))
  ) {
    return Object.freeze({ accepted: false as const, reason: 'invalid_shape' as const })
  }

  const pm = turnAuthority?.poolMigration
  if (!pm) {
    return Object.freeze({ accepted: false as const, reason: 'missing_authority' as const })
  }
  if (pm.allowBackendTransition !== true) {
    return Object.freeze({ accepted: false as const, reason: 'migration_not_allowed' as const })
  }
  if (pm.continuityTier !== 'tape_rebuilt') {
    return Object.freeze({ accepted: false as const, reason: 'tier_mismatch' as const })
  }
  if (pm.migrationId !== migrationId) {
    return Object.freeze({ accepted: false as const, reason: 'migration_id_mismatch' as const })
  }
  if (pm.placementEpoch !== placementEpoch) {
    return Object.freeze({ accepted: false as const, reason: 'epoch_mismatch' as const })
  }

  const computedSha256 = createHash('sha256').update(summary, 'utf8').digest('hex')
  if (computedSha256 !== sha256) {
    return Object.freeze({ accepted: false as const, reason: 'sha256_mismatch' as const })
  }

  const genTrimmed = generation.trim()
  const persist = opts?.saveCheckpoint ?? defaultSaveCheckpointWithGeneration
  try {
    persist(sessionKey, summary, {
      generation: genTrimmed,
      placementEpoch,
      ...(typeof instructions === 'string' && instructions.trim().length > 0
        ? { instructions: instructions.trim() }
        : {}),
      ...(opts?.baseDir !== undefined ? { baseDir: opts.baseDir } : {}),
    })
  } catch (err) {
    const code = err instanceof Error ? err.message : ''
    if (code === 'CHECKPOINT_STALE_PLACEMENT_EPOCH') {
      return Object.freeze({ accepted: false as const, reason: 'stale_epoch' as const })
    }
    if (code === 'CHECKPOINT_GENERATION_ALREADY_CONSUMED') {
      return Object.freeze({
        accepted: false as const,
        reason: 'already_consumed' as const,
        generation: genTrimmed,
        migrationId,
        placementEpoch,
      })
    }
    return Object.freeze({ accepted: false as const, reason: 'persist_failed' as const })
  }

  return Object.freeze({
    accepted: true as const,
    generation: genTrimmed,
    migrationId,
    placementEpoch,
  })
}

/**
 * OCV5-902 B1: Post-`getOrCreate` container hook.
 * - For `tape_rebuilt`: persists the verified checkpoint to disk FIRST and emits
 *   `outbound.control.migration_install_receipt` when `ingestResult.accepted === true`,
 *   OR re-emits the idempotent install proof when `ingestResult.reason === 'already_consumed'`
 *   (so a dropped receipt on an earlier completed turn still converges Master's PG pending state
 *   without re-injecting the summary).
 * - On `persist_failed`, returns `fatalError: 'CROSS_POOL_CHECKPOINT_PERSIST_FAILED'` and never
 *   emits an install receipt so the turn fails closed instead of running without its warm summary.
 * - For non-`tape_rebuilt` (e.g. `cold_degraded`): emits the receipt with
 *   `checkpointGeneration: null` after `getOrCreate` succeeds.
 * - No-op when `turnAuthority?.poolMigration` is absent.
 */
export function finalizeInboundCrossPoolMigration(
  frame: unknown,
  turnAuthority: Pick<TurnExecutionDescriptor, 'poolMigration'> | undefined,
  sessionKey: string,
  deliver: (receipt: MigrationInstallReceiptFrame) => void,
  opts?: FinalizeInboundCrossPoolMigrationOptions,
): FinalizeInboundCrossPoolMigrationResult {
  const pm = turnAuthority?.poolMigration
  if (!pm || pm.allowBackendTransition !== true) {
    return Object.freeze({ handled: false, receiptSent: false })
  }

  const frameRec = frame && typeof frame === 'object' ? (frame as Record<string, unknown>) : null
  const channel = typeof frameRec?.channel === 'string' ? frameRec.channel : undefined
  const rawPeer =
    frameRec?.peer && typeof frameRec.peer === 'object'
      ? (frameRec.peer as { id?: unknown; kind?: unknown })
      : null
  const peer =
    rawPeer && typeof rawPeer.id === 'string' && typeof rawPeer.kind === 'string'
      ? { id: rawPeer.id, kind: rawPeer.kind }
      : undefined
  const clientMessageId = opts?.clientMessageId ?? opts?.dispatchContext?.clientMessageId

  if (pm.continuityTier === 'tape_rebuilt') {
    const ingestResult = ingestVerifiedCrossPoolCheckpoint(frame, turnAuthority, sessionKey, {
      ...(opts?.baseDir !== undefined ? { baseDir: opts.baseDir } : {}),
      ...(opts?.saveCheckpoint !== undefined ? { saveCheckpoint: opts.saveCheckpoint } : {}),
    })
    if (!ingestResult.accepted) {
      if (
        ingestResult.reason === 'already_consumed' &&
        typeof ingestResult.generation === 'string' &&
        typeof ingestResult.migrationId === 'string' &&
        typeof ingestResult.placementEpoch === 'number'
      ) {
        const reemitReceipt = buildMigrationInstallReceipt({
          sessionKey,
          migrationId: ingestResult.migrationId,
          placementEpoch: ingestResult.placementEpoch,
          continuityTier: 'tape_rebuilt',
          checkpointGeneration: ingestResult.generation,
          clientMessageId,
          dispatchId: opts?.dispatchContext?.dispatchId,
          attemptNo: opts?.dispatchContext?.attemptNo,
          channel,
          peer,
          userId: opts?.userId,
        })
        if (reemitReceipt) {
          deliver(reemitReceipt)
          return Object.freeze({
            handled: true,
            receiptSent: true,
            ingestResult,
            receipt: reemitReceipt,
          })
        }
      }
      const fatalError =
        ingestResult.reason === 'persist_failed'
          ? 'CROSS_POOL_CHECKPOINT_PERSIST_FAILED'
          : undefined
      return Object.freeze({
        handled: true,
        receiptSent: false,
        ingestResult,
        ...(fatalError ? { fatalError } : {}),
      })
    }
    const receipt = buildMigrationInstallReceipt({
      sessionKey,
      migrationId: ingestResult.migrationId,
      placementEpoch: ingestResult.placementEpoch,
      continuityTier: 'tape_rebuilt',
      checkpointGeneration: ingestResult.generation,
      clientMessageId,
      dispatchId: opts?.dispatchContext?.dispatchId,
      attemptNo: opts?.dispatchContext?.attemptNo,
      channel,
      peer,
      userId: opts?.userId,
    })
    if (!receipt) {
      return Object.freeze({ handled: true, receiptSent: false, ingestResult })
    }
    deliver(receipt)
    return Object.freeze({ handled: true, receiptSent: true, ingestResult, receipt })
  }

  const receipt = buildMigrationInstallReceipt({
    sessionKey,
    migrationId: pm.migrationId,
    placementEpoch: pm.placementEpoch,
    continuityTier: pm.continuityTier ?? 'cold_degraded',
    checkpointGeneration: null,
    clientMessageId,
    dispatchId: opts?.dispatchContext?.dispatchId,
    attemptNo: opts?.dispatchContext?.attemptNo,
    channel,
    peer,
    userId: opts?.userId,
  })
  if (!receipt) {
    return Object.freeze({ handled: true, receiptSent: false })
  }
  deliver(receipt)
  return Object.freeze({ handled: true, receiptSent: true, receipt })
}

/**
 * OCV5-902 B3: Migration-aware isolation of stored native resume IDs during runner creation.
 * - Ordinary turns (`hasAuthorizedMigration === false`): preserves strict operationId matching
 *   for `cc5-interactive-v1` and `remote-driver-v4` (throws `CC5_TEST_REMOTE_RESUME_UNSUPPORTED`).
 * - Authorized cross-pool migrations (`hasAuthorizedMigration === true`): isolates foreign/local
 *   stored resume IDs when migrating to remote, and isolates bound remote resume IDs when
 *   migrating to local, returning `clearStaleResume: true` so the target runner starts fresh
 *   and consumes the verified persisted checkpoint without contamination.
 */
export function resolveMigrationAwareStoredResume(input: {
  readonly storedResumeId?: string
  readonly executionBackend?: RemoteExecutionBackend
  readonly hasAuthorizedMigration: boolean
}): MigrationAwareStoredResumeResult {
  const { storedResumeId, executionBackend, hasAuthorizedMigration } = input
  const cc5Backend = executionBackend?.kind === 'cc5-interactive-v1' ? executionBackend : undefined
  const v4Backend = executionBackend?.kind === 'remote-driver-v4' ? executionBackend : undefined

  if (cc5Backend && storedResumeId) {
    if (parseCc5ResumeId(storedResumeId)?.bindingId !== cc5Backend.operationId) {
      if (hasAuthorizedMigration) {
        return Object.freeze({ effectiveStoredResumeId: undefined, clearStaleResume: true })
      }
      throw new Error('CC5_TEST_REMOTE_RESUME_UNSUPPORTED')
    }
    return Object.freeze({ effectiveStoredResumeId: storedResumeId, clearStaleResume: false })
  }

  if (v4Backend && storedResumeId) {
    if (parseRemoteV4ResumeId(storedResumeId)?.bindingId !== v4Backend.operationId) {
      if (hasAuthorizedMigration) {
        return Object.freeze({ effectiveStoredResumeId: undefined, clearStaleResume: true })
      }
      throw new Error('CC5_TEST_REMOTE_RESUME_UNSUPPORTED')
    }
    return Object.freeze({ effectiveStoredResumeId: storedResumeId, clearStaleResume: false })
  }

  if (executionBackend && storedResumeId && hasAuthorizedMigration) {
    return Object.freeze({ effectiveStoredResumeId: undefined, clearStaleResume: true })
  }

  if (!executionBackend && storedResumeId && hasAuthorizedMigration) {
    if (isRemoteV4ResumeId(storedResumeId) || isCc5ResumeId(storedResumeId)) {
      return Object.freeze({ effectiveStoredResumeId: undefined, clearStaleResume: true })
    }
  }

  return Object.freeze({ effectiveStoredResumeId: storedResumeId, clearStaleResume: false })
}
