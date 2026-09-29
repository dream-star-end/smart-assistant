import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  /** Native saw a short outer transcript and did not summarize. */
  disposition?: 'short'
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
  if (op.disposition === 'short') return true
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
  if (op.artifact && op.receiptDigest === op.artifact.digest) return { op, callModel: false }
  // The inner leaf's compactRequired is not the outer transcript. Native
  // measures that history after this dispatch and skips a short one.
  if (input.allowDispatch && !op.summaryText && input.proof.status === 'terminal'
    && input.proof.revision === op.revision) {
    return { op, callModel: true }
  }
  return { op, callModel: false }
}
