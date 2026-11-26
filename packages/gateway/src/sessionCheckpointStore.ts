/**
 * Durable Rolling Checkpoint Store & Session Compaction Mutex (OCV5-840 B3 + B7).
 *
 * - Persists rolling checkpoint summaries atomically (0600) under
 *   `<OPENCLAUDE_HOME>/checkpoints/<sha256(sessionKey).slice(0, 32)>.json`
 *   BEFORE clearing native resume handles so gateway restarts, runner eviction,
 *   or pre-start turn failures never lose the compacted checkpoint.
 * - Uses explicit generation-checked ack: `submit()` peeks on entry and ONLY
 *   acks/deletes after the engine turn succeeds.
 * - Exports shared per-session compaction mutex so normal `submit()` cannot race
 *   with an in-progress `compactSession()`.
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
import type { AgentSession } from './sessionTypes.js'
import { reconcileAntigravitySwarmDirectiveAfterCompaction } from './engine/antigravitySwarmDirective.js'
import { isCc5ResumeId, parseCc5ResumeId } from './engine/cc5ResumeId.js'

export interface PersistedCheckpointRecord {
  sessionKey: string
  generation: string
  summary: string
  createdAt: number
  instructions?: string
  placementEpoch?: number
}

interface CheckpointWatermarkRecord {
  sessionKey: string
  highestPlacementEpoch?: number
  consumedGenerations: string[]
}

const MAX_CONSUMED_GENERATIONS_HISTORY = 64

const activeCompactions = new Set<string>()

export function isSessionCompacting(sessionKey: string): boolean {
  return activeCompactions.has(sessionKey)
}

export function markSessionCompacting(sessionKey: string): boolean {
  if (activeCompactions.has(sessionKey)) return false
  activeCompactions.add(sessionKey)
  return true
}

export function unmarkSessionCompacting(sessionKey: string): void {
  activeCompactions.delete(sessionKey)
}

export function checkpointRootDir(baseDir?: string): string {
  return baseDir ?? join(paths.home, 'checkpoints')
}

export function checkpointFilePath(sessionKey: string, baseDir?: string): string {
  const hash = createHash('sha256').update(sessionKey).digest('hex').slice(0, 32)
  return join(checkpointRootDir(baseDir), `${hash}.json`)
}

export function checkpointWatermarkFilePath(sessionKey: string, baseDir?: string): string {
  const hash = createHash('sha256').update(sessionKey).digest('hex').slice(0, 32)
  return join(checkpointRootDir(baseDir), `${hash}.watermark.json`)
}

function readCheckpointWatermark(sessionKey: string, baseDir?: string): CheckpointWatermarkRecord {
  const filePath = checkpointWatermarkFilePath(sessionKey, baseDir)
  try {
    const st = lstatSync(filePath)
    if (st.isSymbolicLink() || !st.isFile()) {
      return { sessionKey, consumedGenerations: [] }
    }
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<CheckpointWatermarkRecord>
    if (!parsed || parsed.sessionKey !== sessionKey) {
      return { sessionKey, consumedGenerations: [] }
    }
    const consumedGenerations = Array.isArray(parsed.consumedGenerations)
      ? parsed.consumedGenerations.filter((g): g is string => typeof g === 'string' && g.length > 0)
      : []
    const highestPlacementEpoch =
      typeof parsed.highestPlacementEpoch === 'number' &&
      Number.isSafeInteger(parsed.highestPlacementEpoch) &&
      parsed.highestPlacementEpoch >= 1
        ? parsed.highestPlacementEpoch
        : undefined
    return {
      sessionKey,
      consumedGenerations: consumedGenerations.slice(-MAX_CONSUMED_GENERATIONS_HISTORY),
      ...(highestPlacementEpoch !== undefined ? { highestPlacementEpoch } : {}),
    }
  } catch {
    return { sessionKey, consumedGenerations: [] }
  }
}

function writeCheckpointWatermark(record: CheckpointWatermarkRecord, baseDir?: string): void {
  const dir = checkpointRootDir(baseDir)
  ensureSafeCheckpointDir(dir)
  const filePath = checkpointWatermarkFilePath(record.sessionKey, baseDir)
  ensureNotSymlinkIfExists(filePath)
  const bounded: CheckpointWatermarkRecord = {
    sessionKey: record.sessionKey,
    consumedGenerations: record.consumedGenerations.slice(-MAX_CONSUMED_GENERATIONS_HISTORY),
    ...(record.highestPlacementEpoch !== undefined
      ? { highestPlacementEpoch: record.highestPlacementEpoch }
      : {}),
  }
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const realDir = realpathSync(dir)
  writeFileSync(tmpPath, JSON.stringify(bounded), { encoding: 'utf8', mode: 0o600 })
  if (!realpathSync(tmpPath).startsWith(realDir)) {
    rmSync(tmpPath, { force: true })
    throw new Error('CHECKPOINT_PATH_ESCAPE')
  }
  renameSync(tmpPath, filePath)
}

function ensureSafeCheckpointDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error('CHECKPOINT_DIR_UNSAFE')
  }
}

function ensureNotSymlinkIfExists(filePath: string): void {
  try {
    const st = lstatSync(filePath)
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error('CHECKPOINT_FILE_UNSAFE')
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw err
  }
}

/**
 * OCV5-902 P0-1 + W2: Atomically persist a rolling checkpoint (0600) with an explicit generation
 * and optional `placementEpoch` watermark.
 * - Rejects replay of any already-consumed generation (`CHECKPOINT_GENERATION_ALREADY_CONSUMED`).
 * - Rejects out-of-order older `placementEpoch` (`CHECKPOINT_STALE_PLACEMENT_EPOCH`).
 * - Idempotent: if an on-disk pending checkpoint already carries the exact same generation,
 *   returns it directly without rewriting disk.
 */
export function savePendingCheckpointWithGeneration(
  sessionKey: string,
  summary: string,
  opts: { generation: string; instructions?: string; baseDir?: string; placementEpoch?: number },
): PersistedCheckpointRecord {
  const trimmed = summary.trim()
  if (!trimmed) throw new Error('EMPTY_CHECKPOINT_SUMMARY')
  const generation = typeof opts.generation === 'string' ? opts.generation.trim() : ''
  if (!generation || generation.length > 128) throw new Error('EMPTY_CHECKPOINT_GENERATION')
  if (
    opts.placementEpoch !== undefined &&
    (typeof opts.placementEpoch !== 'number' ||
      !Number.isSafeInteger(opts.placementEpoch) ||
      opts.placementEpoch < 1)
  ) {
    throw new Error('INVALID_CHECKPOINT_PLACEMENT_EPOCH')
  }

  const watermark = readCheckpointWatermark(sessionKey, opts.baseDir)
  if (watermark.consumedGenerations.includes(generation)) {
    throw new Error('CHECKPOINT_GENERATION_ALREADY_CONSUMED')
  }

  const existing = peekPendingCheckpoint(sessionKey, opts.baseDir)
  const highestEpoch = Math.max(watermark.highestPlacementEpoch ?? 0, existing?.placementEpoch ?? 0)
  if (opts.placementEpoch !== undefined && highestEpoch > 0 && opts.placementEpoch < highestEpoch) {
    throw new Error('CHECKPOINT_STALE_PLACEMENT_EPOCH')
  }

  if (existing && existing.generation === generation) {
    return existing
  }

  const dir = checkpointRootDir(opts.baseDir)
  ensureSafeCheckpointDir(dir)
  const filePath = checkpointFilePath(sessionKey, opts.baseDir)
  ensureNotSymlinkIfExists(filePath)

  const record: PersistedCheckpointRecord = {
    sessionKey,
    generation,
    summary: trimmed,
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
  if (
    opts.placementEpoch !== undefined &&
    opts.placementEpoch > (watermark.highestPlacementEpoch ?? 0)
  ) {
    writeCheckpointWatermark(
      {
        sessionKey,
        highestPlacementEpoch: opts.placementEpoch,
        consumedGenerations: watermark.consumedGenerations,
      },
      opts.baseDir,
    )
  }
  return record
}

/** Atomically persist a rolling checkpoint (0600) before invalidating native resume handles. */
export function savePendingCheckpoint(
  sessionKey: string,
  summary: string,
  opts?: { instructions?: string; baseDir?: string },
): PersistedCheckpointRecord {
  return savePendingCheckpointWithGeneration(sessionKey, summary, {
    generation: `${Date.now()}-${randomBytes(6).toString('hex')}`,
    ...(opts?.instructions !== undefined ? { instructions: opts.instructions } : {}),
    ...(opts?.baseDir !== undefined ? { baseDir: opts.baseDir } : {}),
  })
}

/** Read pending checkpoint without deleting it. Fail-open on ENOENT or corrupt JSON. */
export function peekPendingCheckpoint(
  sessionKey: string,
  baseDir?: string,
): PersistedCheckpointRecord | null {
  const filePath = checkpointFilePath(sessionKey, baseDir)
  try {
    const st = lstatSync(filePath)
    if (st.isSymbolicLink() || !st.isFile()) return null
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedCheckpointRecord>
    if (
      parsed &&
      parsed.sessionKey === sessionKey &&
      typeof parsed.generation === 'string' &&
      parsed.generation.length > 0 &&
      typeof parsed.summary === 'string' &&
      parsed.summary.trim().length > 0
    ) {
      const watermark = readCheckpointWatermark(sessionKey, baseDir)
      if (watermark.consumedGenerations.includes(parsed.generation)) {
        return null
      }
      return {
        sessionKey: parsed.sessionKey,
        generation: parsed.generation,
        summary: parsed.summary,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
        ...(typeof parsed.instructions === 'string' ? { instructions: parsed.instructions } : {}),
        ...(typeof parsed.placementEpoch === 'number' &&
        Number.isSafeInteger(parsed.placementEpoch) &&
        parsed.placementEpoch >= 1
          ? { placementEpoch: parsed.placementEpoch }
          : {}),
      }
    }
    return null
  } catch {
    return null
  }
}

/** Acknowledge and delete a pending checkpoint ONLY when its generation still matches. */
export function ackPendingCheckpoint(
  sessionKey: string,
  generation: string,
  baseDir?: string,
): boolean {
  const current = peekPendingCheckpoint(sessionKey, baseDir)
  if (!current || current.generation !== generation) return false
  try {
    // W2: Atomically persist the consumed watermark BEFORE deleting the pending checkpoint file
    // so a crash between the two operations can never allow the same generation to be re-installed
    // (and peekPendingCheckpoint treats watermarked generations as already consumed).
    const watermark = readCheckpointWatermark(sessionKey, baseDir)
    const nextConsumed = watermark.consumedGenerations.includes(generation)
      ? watermark.consumedGenerations
      : [...watermark.consumedGenerations, generation]
    const nextHighestEpoch = Math.max(
      watermark.highestPlacementEpoch ?? 0,
      current.placementEpoch ?? 0,
    )
    writeCheckpointWatermark(
      {
        sessionKey,
        consumedGenerations: nextConsumed,
        ...(nextHighestEpoch > 0 ? { highestPlacementEpoch: nextHighestEpoch } : {}),
      },
      baseDir,
    )
    rmSync(checkpointFilePath(sessionKey, baseDir), { force: true })
    return true
  } catch {
    return false
  }
}

/** Unconditionally delete any persisted checkpoint and watermark for a destroyed session. Fail-open. */
export function clearPendingCheckpoint(sessionKey: string, baseDir?: string): void {
  try {
    rmSync(checkpointFilePath(sessionKey, baseDir), { force: true })
  } catch {
    /* fail-open */
  }
  try {
    rmSync(checkpointWatermarkFilePath(sessionKey, baseDir), { force: true })
  } catch {
    /* fail-open */
  }
}

/** Helper used by sessionSubmit.ts to inject a peeked checkpoint while keeping submit concise. */
export function applyPendingCheckpointToSession(
  session: AgentSession,
  checkpoint: PersistedCheckpointRecord,
  wrapPayload: (
    summary: string,
    input: string | Array<{ type: string; [key: string]: unknown }>,
  ) => string | Array<{ type: string; [key: string]: unknown }>,
  currentUserInput: string | Array<{ type: string; [key: string]: unknown }>,
): string | Array<{ type: string; [key: string]: unknown }> {
  session._historicalContextInjected = true
  session._historicalContextInjectedKey = `checkpoint-reset:${checkpoint.generation}`
  session._contextRebuildNotice = undefined
  session._forceHistoricalContextOnFirstTurn = false
  const swarmCompaction = session._antigravitySwarmCompaction
  const reconciledInput = swarmCompaction
    ? reconcileAntigravitySwarmDirectiveAfterCompaction(
        currentUserInput,
        swarmCompaction,
        { resetKind: 'rolling_checkpoint' },
      )
    : currentUserInput
  // Consume compaction context once reconciled for this rolling checkpoint so
  // AntigravityAdapter will not run a second strip pass on user body quotes (OCV5-882).
  if (swarmCompaction) session._antigravitySwarmCompaction = undefined
  return wrapPayload(checkpoint.summary, reconciledInput)
}

/** Restore session injection flags when a checkpoint-carrying turn fails before engine acceptance. */
export function resetUnackedCheckpointSessionFlags(
  session: AgentSession,
  generation: string,
): void {
  if (session._historicalContextInjectedKey === `checkpoint-reset:${generation}`) {
    session._historicalContextInjected = false
    session._historicalContextInjectedKey = undefined
    session._forceHistoricalContextOnFirstTurn = true
  }
}

/**
 * B7: Fail-closed turn terminal outcome tracking for checkpoint acknowledgment.
 * Real `_runOneTurn` marks `'failed'` on entry and ONLY flips to `'completed'`
 * when the engine produces a genuine non-error completed terminal. Crashed /
 * interrupted / errored turns that resolve without throwing therefore keep the
 * persisted checkpoint on disk for the next retry.
 */
const checkpointTurnOutcomes = new WeakMap<AgentSession, 'completed' | 'failed'>()

export function beginCheckpointTurnOutcome(session: AgentSession): void {
  checkpointTurnOutcomes.delete(session)
}

export function markCheckpointTurnOutcome(
  session: AgentSession,
  outcome: 'completed' | 'failed',
): void {
  checkpointTurnOutcomes.set(session, outcome)
}

export function ackPendingCheckpointIfTurnSucceeded(
  session: AgentSession,
  generation: string,
  baseDir?: string,
): boolean {
  const outcome = checkpointTurnOutcomes.get(session)
  checkpointTurnOutcomes.delete(session)
  if (outcome !== 'completed') return false
  return ackPendingCheckpoint(session.sessionKey, generation, baseDir)
}

const REMOTE_V4_RESUME_PREFIX = 'remotev4:'
const REMOTE_V4_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const REMOTE_V4_NATIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function parseBoundRemoteV4ResumeId(
  value: string | null | undefined,
): { readonly bindingId: string; readonly nativeId: string } | null {
  if (typeof value !== 'string' || !value.startsWith(REMOTE_V4_RESUME_PREFIX)) return null
  const rest = value.slice(REMOTE_V4_RESUME_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep !== 36) return null
  const bindingId = rest.slice(0, 36)
  const nativeId = rest.slice(37)
  if (!REMOTE_V4_UUID_RE.test(bindingId) || !REMOTE_V4_NATIVE_ID_RE.test(nativeId)) return null
  return { bindingId: bindingId.toLowerCase(), nativeId }
}

export interface MigrationAwareStoredResumeResult {
  readonly effectiveStoredResumeId: string | undefined
  readonly clearStaleResume: boolean
}

/**
 * OCV5-902 B3: Migration-aware isolation of stored native resume IDs during runner creation.
 * Lives in `gateway-session` (L3) alongside `sessionSubmit.ts` to keep zero cross-module L3 edges.
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
    if (parseBoundRemoteV4ResumeId(storedResumeId)?.bindingId !== v4Backend.operationId) {
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
    if (storedResumeId.startsWith(REMOTE_V4_RESUME_PREFIX) || isCc5ResumeId(storedResumeId)) {
      return Object.freeze({ effectiveStoredResumeId: undefined, clearStaleResume: true })
    }
  }

  return Object.freeze({ effectiveStoredResumeId: storedResumeId, clearStaleResume: false })
}
