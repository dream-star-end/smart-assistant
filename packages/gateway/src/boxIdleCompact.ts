import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'



/** Same native command the model-switch path already sends. Idle does not reuse that switch. */
export const IDLE_COMPACT_PROMPT =
  '/compact preserve the user goal, decisions, constraints, current work, files, errors, and next steps'

const CLOSED = new Set(['terminal'])
const OPEN = new Set(['unknown', 'handoff', 'resuming', 'reserved', 'linked', 'prestart_stopped'])

export interface BoxChainTerminalRow {
  requestId: string
  boxState: string
  committed: boolean
  hasHandoff: boolean
  hasUnknown: boolean
}

/**
 * Caller-supplied projection of the Box journal chain.
 * Gateway re-checks every row. A bare boolean is not a proof.
 * The commercial read that fills this object is not in this package.
 */
export interface BoxChainTerminalProof {
  kind: 'box-chain-terminal-v1'
  sessionId: string
  revision: string
  requestId: string
  contextOwner: string
  canonicalModel: string
  rows: readonly BoxChainTerminalRow[]
}

export interface IdleCompactRecord {
  v: 1
  sessionKey: string
  revision: string
  sourceRequestId: string
  idleRequestId: string
  summaryText: string
  applied: boolean
  /** Next user must not reuse the pre-idle native pointer. */
  nativeMiss: true
}

export class IdleCompactRejected extends Error {
  constructor(readonly code:
    | 'IDLE_SESSION_BUSY'
    | 'IDLE_NOT_TERMINAL'
    | 'IDLE_UNKNOWN_CHAIN'
    | 'IDLE_CONTEXT_OWNER'
    | 'IDLE_SUMMARY_MISSING'
    | 'IDLE_HISTORY_PENDING'
    | 'IDLE_RECOVERY_CORRUPT'
    | 'PROTOCOL_CONTEXT_OWNER_UNRESOLVED') {
    super(code)
    this.name = 'IdleCompactRejected'
  }
}

async function authorityContract(): Promise<{ owner: string; model: string }> {
  const read = (mod: Record<string, unknown>) =>
    mod.BOX_NATIVE_CONTEXT_OWNER === 'box-native-v1' && mod.BOX_NATIVE_CONTEXT_MODEL === 'box-api-claude-opus-5-5'
      ? { owner: 'box-native-v1', model: 'box-api-claude-opus-5-5' }
      : undefined
  const packaged = read(await import('@openclaude/protocol') as Record<string, unknown>)
  if (packaged) return packaged
  // This worktree's node_modules link still resolves the pre-B snapshot.
  // Load the protocol source that belongs to the same commit instead of a second token.
  const source = new URL('../../protocol/src/modelAuthority.ts', import.meta.url).href
  const local = read(await import(source) as Record<string, unknown>)
  if (!local) throw new IdleCompactRejected('PROTOCOL_CONTEXT_OWNER_UNRESOLVED')
  return local
}

export async function assertIdleAdmission(input: {
  proof: BoxChainTerminalProof
  activeTurns: number
  activeClients: number
}): Promise<void> {
  if (input.activeTurns > 0 || input.activeClients > 0) {
    throw new IdleCompactRejected('IDLE_SESSION_BUSY')
  }
  const proof = input.proof
  if (!Array.isArray(proof.rows) || proof.rows.length === 0 || !proof.rows.some((row) => row.requestId === proof.requestId)) {
    throw new IdleCompactRejected('IDLE_NOT_TERMINAL')
  }
  for (const row of proof.rows) {
    if (row.hasUnknown || row.boxState === 'unknown' || OPEN.has(row.boxState)) {
      throw new IdleCompactRejected('IDLE_UNKNOWN_CHAIN')
    }
    if (row.hasHandoff || !row.committed || !CLOSED.has(row.boxState)) {
      throw new IdleCompactRejected('IDLE_NOT_TERMINAL')
    }
  }
  const contract = await authorityContract()
  if (
    proof.kind !== 'box-chain-terminal-v1' ||
    proof.contextOwner !== contract.owner ||
    proof.canonicalModel !== contract.model ||
    proof.revision.trim() === '' ||
    proof.requestId.trim() === '' ||
    proof.sessionId.trim() === ''
  ) {
    throw new IdleCompactRejected('IDLE_CONTEXT_OWNER')
  }
}

function fileFor(dir: string): string {
  return join(dir, 'idle-compact-recovery.json')
}

function readAll(dir: string): Record<string, IdleCompactRecord> {
  const path = fileFor(dir)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: Record<string, IdleCompactRecord> }
    return parsed.sessions ?? {}
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return {}
    throw new IdleCompactRejected('IDLE_RECOVERY_CORRUPT')
  }
}

function writeAll(dir: string, sessions: Record<string, IdleCompactRecord>): void {
  mkdirSync(dir, { recursive: true })
  const path = fileFor(dir)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ v: 1, sessions }))
  renameSync(tmp, path)
}

export function readIdleRecovery(dir: string, sessionKey: string): IdleCompactRecord | undefined {
  const row = readAll(dir)[sessionKey]
  if (!row) return undefined
  if (row.v !== 1 || typeof row.summaryText !== 'string' || typeof row.applied !== 'boolean') {
    throw new IdleCompactRejected('IDLE_RECOVERY_CORRUPT')
  }
  return row
}

export function assertNextUserMayStart(row: IdleCompactRecord | undefined): void {
  if (row && !row.applied) throw new IdleCompactRejected('IDLE_HISTORY_PENDING')
}

export function applyStoredIdleSummary(dir: string, sessionKey: string): IdleCompactRecord {
  const row = readIdleRecovery(dir, sessionKey)
  if (!row) throw new IdleCompactRejected('IDLE_SUMMARY_MISSING')
  if (row.applied) return row
  const applied: IdleCompactRecord = { ...row, applied: true, nativeMiss: true }
  const all = readAll(dir)
  all[sessionKey] = applied
  writeAll(dir, all)
  return applied
}

export async function runIdleCompact(input: {
  sessionKey: string
  activeTurns: number
  activeClients: number
  proof: BoxChainTerminalProof
  idleRequestId: string
  recoveryDir: string
  submit: (prompt: string) => Promise<void>
  readSummary: () => string | undefined
}): Promise<IdleCompactRecord> {
  const pending = readIdleRecovery(input.recoveryDir, input.sessionKey)
  if (pending && !pending.applied) {
    if (pending.revision !== input.proof.revision) throw new IdleCompactRejected('IDLE_HISTORY_PENDING')
    return applyStoredIdleSummary(input.recoveryDir, input.sessionKey)
  }
  await assertIdleAdmission(input)
  await input.submit(IDLE_COMPACT_PROMPT)
  const summaryText = input.readSummary()?.trim()
  if (!summaryText) throw new IdleCompactRejected('IDLE_SUMMARY_MISSING')
  const stored: IdleCompactRecord = {
    v: 1,
    sessionKey: input.sessionKey,
    revision: input.proof.revision,
    sourceRequestId: input.proof.requestId,
    idleRequestId: input.idleRequestId,
    summaryText,
    applied: false,
    nativeMiss: true,
  }
  const all = readAll(input.recoveryDir)
  all[input.sessionKey] = stored
  writeAll(input.recoveryDir, all)
  return applyStoredIdleSummary(input.recoveryDir, input.sessionKey)
}
