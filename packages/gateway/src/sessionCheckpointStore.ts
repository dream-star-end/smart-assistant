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
import { paths } from '@openclaude/storage'
import type { AgentSession } from './sessionTypes.js'

export interface PersistedCheckpointRecord {
  sessionKey: string
  generation: string
  summary: string
  createdAt: number
  instructions?: string
}

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

/** Atomically persist a rolling checkpoint (0600) before invalidating native resume handles. */
export function savePendingCheckpoint(
  sessionKey: string,
  summary: string,
  opts?: { instructions?: string; baseDir?: string },
): PersistedCheckpointRecord {
  const trimmed = summary.trim()
  if (!trimmed) throw new Error('EMPTY_CHECKPOINT_SUMMARY')
  const dir = checkpointRootDir(opts?.baseDir)
  ensureSafeCheckpointDir(dir)
  const filePath = checkpointFilePath(sessionKey, opts?.baseDir)
  ensureNotSymlinkIfExists(filePath)

  const record: PersistedCheckpointRecord = {
    sessionKey,
    generation: `${Date.now()}-${randomBytes(6).toString('hex')}`,
    summary: trimmed,
    createdAt: Date.now(),
    ...(opts?.instructions?.trim() ? { instructions: opts.instructions.trim() } : {}),
  }
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const realDir = realpathSync(dir)
  writeFileSync(tmpPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
  if (!realpathSync(tmpPath).startsWith(realDir)) {
    rmSync(tmpPath, { force: true })
    throw new Error('CHECKPOINT_PATH_ESCAPE')
  }
  renameSync(tmpPath, filePath)
  return record
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
      return {
        sessionKey: parsed.sessionKey,
        generation: parsed.generation,
        summary: parsed.summary,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
        ...(typeof parsed.instructions === 'string' ? { instructions: parsed.instructions } : {}),
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
    rmSync(checkpointFilePath(sessionKey, baseDir), { force: true })
    return true
  } catch {
    return false
  }
}

/** Unconditionally delete any persisted checkpoint for a destroyed session. Fail-open. */
export function clearPendingCheckpoint(sessionKey: string, baseDir?: string): void {
  try {
    rmSync(checkpointFilePath(sessionKey, baseDir), { force: true })
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
  return wrapPayload(checkpoint.summary, currentUserInput)
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
  if (outcome === 'failed') return false
  return ackPendingCheckpoint(session.sessionKey, generation, baseDir)
}
