import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BOX_NATIVE_CONTEXT_MODEL, BOX_NATIVE_CONTEXT_OWNER } from '@openclaude/protocol'
import type { IdleProofResponse } from './engine/boxIdleProofClient.js'

export const IDLE_COMPACT_PROMPT =
  '/compact preserve the user goal, decisions, constraints, current work, files, errors, and next steps'

export class IdleCompactRejected extends Error {
  constructor(readonly code:
    | 'IDLE_HISTORY_PENDING'
    | 'IDLE_ARTIFACT_MISSING'
    | 'IDLE_RECOVERY_CORRUPT'
    | 'IDLE_NOT_BOX') {
    super(code)
    this.name = 'IdleCompactRejected'
  }
}

export interface IdleFrozenTail {
  uuid: string
  parentUuid: string | null
  text?: string
  /** Original message. Present messages are not rewritten into user text. */
  message?: Record<string, unknown>
}

export interface IdleAttachment {
  uuid: string
  text?: string
  message?: Record<string, unknown>
}

export interface IdleArtifact {
  messages: Array<Record<string, unknown>>
  digest: string
}

export interface IdleOp {
  v: 1
  sessionKey: string
  sourceSessionId: string
  sourceTurnKey: string
  revision: string
  idleTurnKey: string
  frozenTail: IdleFrozenTail[]
  attachments: IdleAttachment[]
  summaryText?: string
  capsuleSha256?: string
  artifact?: IdleArtifact
  receiptDigest?: string
  /** `short`: native saw a short outer transcript and did not summarize.
   * `abandoned`: authoritative evidence that the idle turn cannot produce or
   * deliver a result (egress proved failure, the CCB turn is over and egress
   * never saw it after the grace window, or an operator reset replaced the
   * native session). Both settle the op. */
  disposition?: 'short' | 'abandoned'
  abandonReason?: 'idle_turn_failed' | 'idle_turn_never_sent' | 'operator_reset' | 'source_gone'
  /** Epoch ms when this process's idle CCB turn ended without a result
   * (timeout, crash or error). After that no new compact request can be sent. */
  idleStoppedAt?: number
}

export function idleUuid(opId: string, role: string): string {
  const hex = createHash('sha256').update(`${opId}:${role}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Pure assembly. Same op, summary, tail, and attachments always yield the same digest. */
export function assembleIdleArtifact(input: {
  opId: string
  summaryText: string
  tail: readonly IdleFrozenTail[]
  attachments: readonly IdleAttachment[]
}): IdleArtifact {
  const boundary = idleUuid(input.opId, 'boundary')
  const summary = idleUuid(input.opId, 'summary')
  const anchor = input.tail[input.tail.length - 1]?.uuid ?? null
  const kept = (item: { uuid: string; parentUuid: string | null; text?: string; message?: Record<string, unknown> }) =>
    item.message
      ? { ...item.message, uuid: item.uuid, parentUuid: item.message.parentUuid ?? item.parentUuid }
      : { uuid: item.uuid, parentUuid: item.parentUuid, type: 'user', text: item.text }
  const messages: Array<Record<string, unknown>> = [
    { uuid: boundary, type: 'system', subtype: 'compact_boundary', parentUuid: anchor },
    { uuid: summary, type: 'user', isSynthetic: true, parentUuid: boundary,
      message: { role: 'user', content: input.summaryText } },
    ...input.tail.map(kept),
    ...input.attachments.map((item) => item.message
      ? { ...item.message, uuid: item.uuid, parentUuid: item.message.parentUuid ?? summary }
      : { uuid: item.uuid, type: 'attachment', parentUuid: summary, text: item.text }),
  ]
  return {
    messages,
    digest: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
  }
}

export function boxTurnMayIdle(input: { model?: string; contextOwner?: string }): boolean {
  return input.model === BOX_NATIVE_CONTEXT_MODEL && input.contextOwner === BOX_NATIVE_CONTEXT_OWNER
}

function opPath(dir: string, op: { sessionKey: string; revision: string }): string {
  return join(dir, 'idle-ops', encodeURIComponent(op.sessionKey), `${op.revision}.json`)
}

/** Done when the loader receipt matches the artifact, or native skipped a short transcript. */
export function idleOpSettled(op: IdleOp): boolean {
  if (op.disposition === 'short' || op.disposition === 'abandoned') return true
  return Boolean(op.artifact && op.receiptDigest === op.artifact.digest)
}

/** This revision's native file is the short terminal for this op, not some other applied file. */
export function nativeShortForOp(native: IdleNativeFile | undefined, op: {
  idleTurnKey: string
  revision: string
  sourceSessionId: string
}): boolean {
  return !!native
    && native.applied === true
    && !native.summaryText
    && native.opId === op.idleTurnKey
    && native.revision === op.revision
    && native.sessionId === op.sourceSessionId
}

/** Same predicate submit() uses after finishIdleUnderLock. */
export function idleHistoryStillBlocked(input: {
  candidate: IdleSourceCandidate | undefined
  pending: IdleOp | undefined
  recovered: IdleOp | undefined
}): boolean {
  return Boolean(input.candidate || (input.pending && !idleOpSettled(input.recovered ?? input.pending)))
}

export function readPendingIdle(dir: string, sessionKey: string): IdleOp | undefined {
  const folder = join(dir, 'idle-ops', encodeURIComponent(sessionKey))
  let names: string[] = []
  try { names = readdirSync(folder) } catch { return undefined }
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
    const op = readIdleOp(dir, sessionKey, name.slice(0, -'.json'.length))
    if (op && !idleOpSettled(op)) return op
  }
  return undefined
}

export function readIdleOp(dir: string, sessionKey: string, revision: string): IdleOp | undefined {
  try {
    const parsed = JSON.parse(readFileSync(opPath(dir, { sessionKey, revision }), 'utf8')) as IdleOp
    if (parsed.v !== 1 || parsed.sessionKey !== sessionKey || parsed.revision !== revision) {
      throw new IdleCompactRejected('IDLE_RECOVERY_CORRUPT')
    }
    return parsed
  } catch (error) {
    if (error instanceof IdleCompactRejected) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new IdleCompactRejected('IDLE_RECOVERY_CORRUPT')
  }
}

export function writeIdleOp(dir: string, op: IdleOp): void {
  const path = opPath(dir, op)
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(op))
  renameSync(tmp, path)
}

/**
 * Create the op file once. The creator is the only caller allowed to send
 * the summary request. A later process sees the file and must not send again.
 */
export function startIdleOp(input: {
  dir: string
  sessionKey: string
  sourceSessionId: string
  sourceTurnKey: string
  revision: string
  idleTurnKey: string
  frozenTail: IdleFrozenTail[]
  attachments: IdleAttachment[]
}): { op: IdleOp; ownedDispatch: boolean } {
  const existing = readIdleOp(input.dir, input.sessionKey, input.revision)
  if (existing) return { op: existing, ownedDispatch: false }
  const op: IdleOp = {
    v: 1,
    sessionKey: input.sessionKey,
    sourceSessionId: input.sourceSessionId,
    sourceTurnKey: input.sourceTurnKey,
    revision: input.revision,
    idleTurnKey: input.idleTurnKey,
    frozenTail: input.frozenTail,
    attachments: input.attachments,
  }
  const path = opPath(input.dir, op)
  mkdirSync(join(path, '..'), { recursive: true })
  try {
    writeFileSync(path, JSON.stringify(op), { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = readIdleOp(input.dir, input.sessionKey, input.revision)
    if (!raced) throw new IdleCompactRejected('IDLE_RECOVERY_CORRUPT')
    return { op: raced, ownedDispatch: false }
  }
  return { op, ownedDispatch: true }
}

export interface IdleNativeFile {
  v: 1
  opId: string
  revision: string
  sessionId: string
  summaryText?: string
  modelCalls: number
  /** Set before the summary request. A later entry must not send another one. */
  modelStarted?: boolean
  applied?: boolean
  artifact?: IdleArtifact
  frozenTail: IdleFrozenTail[]
  attachments: IdleAttachment[]
}

export function idleNativeDir(home: string, sessionId: string): string {
  return join(home, 'idle-native', encodeURIComponent(sessionId))
}

export function idleNativePath(home: string, sessionId: string, revision: string): string {
  return join(idleNativeDir(home, sessionId), `${revision}.json`)
}

export function readIdleNative(home: string, sessionId: string, revision: string): IdleNativeFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(idleNativePath(home, sessionId, revision), 'utf8')) as IdleNativeFile
    if (parsed.v !== 1 || parsed.revision !== revision || parsed.sessionId !== sessionId) {
      throw new IdleCompactRejected('IDLE_RECOVERY_CORRUPT')
    }
    return parsed
  } catch (error) {
    if (error instanceof IdleCompactRejected) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new IdleCompactRejected('IDLE_RECOVERY_CORRUPT')
  }
}

export function writeIdleNative(home: string, file: IdleNativeFile): void {
  const path = idleNativePath(home, file.sessionId, file.revision)
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(file))
  renameSync(tmp, path)
}

export interface IdleSourceCandidate {
  v: 1
  sessionKey: string
  sessionId: string
  turnKey: string
  createdAt?: number
}

function candidatePath(dir: string, sessionKey: string): string {
  return join(dir, 'idle-candidates', `${encodeURIComponent(sessionKey)}.json`)
}

/** Written before the proof read, so a pending finalizer still blocks the next user. */
export function writeIdleCandidate(dir: string, candidate: IdleSourceCandidate): void {
  const path = candidatePath(dir, candidate.sessionKey)
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(candidate))
  renameSync(tmp, path)
}

export function readIdleCandidate(dir: string, sessionKey: string): IdleSourceCandidate | undefined {
  try {
    const parsed = JSON.parse(readFileSync(candidatePath(dir, sessionKey), 'utf8')) as IdleSourceCandidate
    if (parsed.v !== 1 || parsed.sessionKey !== sessionKey) return undefined
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new IdleCompactRejected('IDLE_RECOVERY_CORRUPT')
  }
}

export function clearIdleCandidate(dir: string, sessionKey: string): void {
  try { renameSync(candidatePath(dir, sessionKey), `${candidatePath(dir, sessionKey)}.done`) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** The idle turn's own committed capsule, not the source business proof.
 * A prepared native summary must match that text. With no native summary,
 * the capsule itself is the recovered text. A set, pending, or mismatch is not ready. */
export function idleSummaryAccepted(proof: IdleProofResponse, input: {
  sessionId: string
  idleTurnKey: string
  nativeSummary?: string
}): { summaryText: string; capsuleSha256: string } | undefined {
  if (proof.status !== 'terminal') return undefined
  if (proof.sessionId !== input.sessionId || proof.turnKey !== input.idleTurnKey) return undefined
  if (typeof proof.summaryText !== 'string' || proof.summaryText.length === 0) return undefined
  if (!/^[a-f0-9]{64}$/.test(proof.capsuleSha256)) return undefined
  if (input.nativeSummary !== undefined && proof.summaryText !== input.nativeSummary) return undefined
  return { summaryText: proof.summaryText, capsuleSha256: proof.capsuleSha256 }
}

/**
 * Advance one stored op without reserving a new turn.
 * `useProofSummary` is only for the compact request's own proof, never the
 * source user-turn leaf. `allowDispatch` is only the process that created the op.
 */
export function advanceIdleOp(input: {
  op: IdleOp
  proof: IdleProofResponse
  allowDispatch?: boolean
  useProofSummary?: boolean
  loadDigest?: (artifact: IdleArtifact) => string | undefined
}): { op: IdleOp; callModel: boolean } {
  let op = input.op
  for (let step = 0; step < 4; step++) {
    if (op.artifact && op.receiptDigest === op.artifact.digest) return { op, callModel: false }
    if (op.artifact && !op.receiptDigest) {
      if (!input.loadDigest) return { op, callModel: false }
      const loaded = input.loadDigest(op.artifact)
      if (loaded !== op.artifact.digest) throw new IdleCompactRejected('IDLE_ARTIFACT_MISSING')
      op = { ...op, receiptDigest: loaded }
      continue
    }
    if (op.summaryText && !op.artifact) {
      op = {
        ...op,
        artifact: assembleIdleArtifact({
          opId: op.idleTurnKey,
          summaryText: op.summaryText,
          tail: op.frozenTail,
          attachments: op.attachments,
        }),
      }
      continue
    }
    if (!op.summaryText && input.useProofSummary && input.proof.status === 'terminal'
      && input.proof.summaryText && input.proof.capsuleSha256) {
      op = { ...op, summaryText: input.proof.summaryText, capsuleSha256: input.proof.capsuleSha256 }
      continue
    }
    break
  }
  if (input.useProofSummary && input.proof.status === 'terminal_set') {
    return { op, callModel: false }
  }
  if (op.artifact && op.receiptDigest === op.artifact.digest) return { op, callModel: false }
  // The inner leaf's compactRequired is not the outer transcript. Native
  // measures that history after this dispatch and skips a short one.
  if (input.allowDispatch && !op.summaryText
    && (input.proof.status === 'terminal' || input.proof.status === 'terminal_set')
    && input.proof.revision === op.revision) {
    return { op, callModel: true }
  }
  return { op, callModel: false }
}

// ── OCV5-297: dispatch gate, abandonment, rotation, operator reset ─────────

/** After the idle CCB turn ended, egress must have seen any request it sent
 * within this window; a later `not_found` proves nothing was sent. */
export const IDLE_STOPPED_GRACE_MS = 120_000
/** Settled op files kept per session (newest by mtime). */
export const IDLE_OPS_KEEP = 3

/** Restores the pre-OCV5-297 behavior: dispatch an idle turn after every
 * terminal Box turn regardless of the leaf's compactRequired. */
export function idleCompactAlways(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OC_BOX_IDLE_COMPACT_ALWAYS === '1'
}

/** Bounded wait for a pending proof within one call. */
export function idleProofWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OC_BOX_IDLE_PROOF_WAIT_MS)
  return Number.isSafeInteger(raw) && raw >= 0 && raw <= 120_000 ? raw : 15_000
}

/** A source proof only asks for a new idle op when it can use one. */
export function sourceNeedsIdleOp(proof: IdleProofResponse, always = idleCompactAlways()): boolean {
  if (proof.status === 'terminal_set') return true
  if (proof.status !== 'terminal') return false
  return always || proof.compactRequired
}

/** Idle-turn evidence that settles an unfinished op without a summary. */
export function idleAbandonReason(op: IdleOp, idleProof: IdleProofResponse,
  now: number = Date.now()): IdleOp['abandonReason'] | undefined {
  if (idleOpSettled(op) || op.summaryText) return undefined
  if (idleProof.status === 'failed') return 'idle_turn_failed'
  if (idleProof.status === 'not_found' && typeof op.idleStoppedAt === 'number'
    && now - op.idleStoppedAt >= IDLE_STOPPED_GRACE_MS) return 'idle_turn_never_sent'
  return undefined
}

export function abandonIdleOp(dir: string, op: IdleOp, reason: NonNullable<IdleOp['abandonReason']>): IdleOp {
  const abandoned: IdleOp = { ...op, disposition: 'abandoned', abandonReason: reason }
  writeIdleOp(dir, abandoned)
  return abandoned
}

/** Current durable idle work for a session, if any. */
export function currentIdleSource(dir: string, sessionKey: string):
  { sessionId: string; turnKey: string } | undefined {
  const pending = readPendingIdle(dir, sessionKey)
  if (pending) return { sessionId: pending.sourceSessionId, turnKey: pending.sourceTurnKey }
  const candidate = readIdleCandidate(dir, sessionKey)
  return candidate ? { sessionId: candidate.sessionId, turnKey: candidate.turnKey } : undefined
}

function mtimeOf(path: string): number {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

/**
 * Keep the per-session op directory small so readPendingIdle stays O(1)-ish.
 * Only settled ops are removed (newest IDLE_OPS_KEEP kept); unsettled ops are
 * never touched. The native file of a removed revision goes with it. Stale
 * temp files older than an hour are cleaned too. Best effort, never throws.
 */
export function pruneIdleOps(dir: string, sessionKey: string, keep: number = IDLE_OPS_KEEP,
  now: number = Date.now()): number {
  const folder = join(dir, 'idle-ops', encodeURIComponent(sessionKey))
  let names: string[]
  try { names = readdirSync(folder) } catch { return 0 }
  let removed = 0
  const settled: Array<{ path: string; mtime: number; op: IdleOp }> = []
  for (const name of names) {
    const path = join(folder, name)
    if (name.endsWith('.tmp')) {
      if (now - mtimeOf(path) > 3_600_000) {
        try { rmSync(path, { force: true }); removed++ } catch { /* best effort */ }
      }
      continue
    }
    if (!name.endsWith('.json')) continue
    let op: IdleOp | undefined
    try { op = readIdleOp(dir, sessionKey, name.slice(0, -'.json'.length)) } catch { continue }
    if (op && idleOpSettled(op)) settled.push({ path, mtime: mtimeOf(path), op })
  }
  settled.sort((a, b) => b.mtime - a.mtime)
  for (const item of settled.slice(Math.max(0, keep))) {
    try {
      rmSync(item.path, { force: true })
      rmSync(idleNativePath(dir, item.op.sourceSessionId, item.op.revision), { force: true })
      removed++
    } catch { /* best effort */ }
  }
  return removed
}

export interface IdleResetMarker {
  v: 1
  sessionKey: string
  requestedAt: number
}

const SESSION_KEY = /^[A-Za-z0-9._:-]{1,256}$/

export function idleResetPath(dir: string, sessionKey: string): string {
  return join(dir, 'idle-reset', `${encodeURIComponent(sessionKey)}.json`)
}

/** Operator exit: ask the next submit to replace the native session and
 * abandon this session's unfinished idle work. */
export function requestIdleReset(dir: string, sessionKey: string, now: number = Date.now()): string {
  if (!SESSION_KEY.test(sessionKey)) throw new IdleCompactRejected('IDLE_RECOVERY_CORRUPT')
  const path = idleResetPath(dir, sessionKey)
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  const marker: IdleResetMarker = { v: 1, sessionKey, requestedAt: now }
  writeFileSync(tmp, JSON.stringify(marker))
  renameSync(tmp, path)
  return path
}

/** `corrupt` = a marker exists but does not name exactly this session. */
export function readIdleReset(dir: string, sessionKey: string): IdleResetMarker | 'corrupt' | undefined {
  let raw: string
  try { raw = readFileSync(idleResetPath(dir, sessionKey), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return 'corrupt'
  }
  try {
    const parsed = JSON.parse(raw) as IdleResetMarker
    if (parsed?.v !== 1 || parsed.sessionKey !== sessionKey
      || !Number.isSafeInteger(parsed.requestedAt)) return 'corrupt'
    return parsed
  } catch { return 'corrupt' }
}

export function consumeIdleReset(dir: string, sessionKey: string): void {
  const path = idleResetPath(dir, sessionKey)
  try { renameSync(path, `${path}.done`) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Settle every unfinished op of this session as operator_reset and drop the
 * candidate. Only valid after the native session has been replaced. */
export function abandonAllIdle(dir: string, sessionKey: string): number {
  let count = 0
  for (let guard = 0; guard < 1024; guard++) {
    const pending = readPendingIdle(dir, sessionKey)
    if (!pending) break
    abandonIdleOp(dir, pending, 'operator_reset')
    count++
  }
  clearIdleCandidate(dir, sessionKey)
  return count
}
