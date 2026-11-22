/**
 * Session-scoped `oc_bash` background command snapshot reader & safe terminator (OCV5-844).
 *
 * `packages/mcp-memory/src/ocBashJobManager.ts` atomically writes active job snapshots to
 * `<registryDir>/<ownerPid>-<jobId>.json` including Linux `/proc/<pid>/stat` field 22
 * (`startTimeTicks`). This module reads/filters those snapshots per `sessionId`, verifies
 * process-group ownership (`pgid === pid`, `pgrp === entry.pgid`, `starttime` bounds), scans
 * all live members of the verified process group (including lingering descendants after leader
 * exit), and only deletes the snapshot / reports 200 after confirming the entire verified group
 * has exited.
 */
import { lstatSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const SESSION_BG_COMMAND_ID_RE = /^[0-9]+-ocb_[0-9]+$/
export const SESSION_BG_COMMANDS_MAX_ITEMS = 20
export const SESSION_BG_COMMAND_KILL_GRACE_MS = 400
export const SESSION_BG_COMMAND_KILL_CONFIRM_MS = 400
const KILL_POLL_STEP_MS = 40

export interface ProcStatInfo {
  state: string
  pgrp: number
  startTimeTicks: number
}

export interface SessionBgCommandSnapshot {
  id: string
  jobId: string
  pid: number
  pgid: number
  ownerPid: number
  startTimeTicks: number | null
  sessionKey: string
  sessionId: string
  commandPreview: string
  cwd?: string
  startedAt: number
  updatedAt: number
  maxLifetimeAt: number
}

export interface SessionBgCommandItem {
  id: string
  jobId: string
  commandPreview: string
  cwd?: string
  startedAt: number
  updatedAt: number
}

export type CancelSessionBgCommandResult =
  | { ok: true; cancelled: boolean; alreadyExited?: boolean }
  | { ok: false; status: number; code: string; error: string }

export interface SessionBgCommandsOps {
  now?: () => number
  platform?: NodeJS.Platform
  isProcessAlive?: (pid: number) => boolean
  /** Legacy test seam for starttime-only checks; superseded by `readProcStat`. */
  readStartTimeTicks?: (pid: number) => number | null
  /** Read parsed `/proc/<pid>/stat` (`state`, `pgrp`, `startTimeTicks`). */
  readProcStat?: (pid: number) => ProcStatInfo | null
  /** Enumerate all numeric PIDs from `/proc`. */
  listProcPids?: () => number[]
  sendSignal?: (pidOrNegPgid: number, signal: NodeJS.Signals) => void
  killGraceMs?: number
  killConfirmMs?: number
  sleep?: (ms: number) => Promise<void>
}

export function resolveSessionBgCommandsRegistryDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.OC_BASH_REGISTRY_DIR?.trim()
  if (explicit) return explicit
  const base =
    env.OPENCLAUDE_STATE_DIR?.trim() ||
    env.OPENCLAUDE_RUNTIME_DIR?.trim() ||
    '/home/agent/.openclaude'
  return join(base, 'run', 'oc-bash-jobs')
}

/**
 * Parse Linux `/proc/<pid>/stat` extracting:
 *   - field 3 (`state`): index 0 after last `)`
 *   - field 5 (`pgrp`): index 2 after last `)`
 *   - field 22 (`starttime`): index 19 after last `)`
 */
export function parseProcStatInfo(statLine: string): ProcStatInfo | null {
  const rparen = statLine.lastIndexOf(')')
  if (rparen < 0) return null
  const rest = statLine.slice(rparen + 1).trim()
  if (!rest) return null
  const fields = rest.split(/\s+/)
  const state = fields[0]
  const rawPgrp = fields[2]
  const rawTicks = fields[19]
  if (!state || !rawPgrp || !rawTicks) return null
  if (!/^-?\d+$/.test(rawPgrp) || !/^\d+$/.test(rawTicks)) return null
  const pgrp = Number(rawPgrp)
  const startTimeTicks = Number(rawTicks)
  if (!Number.isSafeInteger(pgrp) || !Number.isSafeInteger(startTimeTicks) || startTimeTicks < 0) {
    return null
  }
  return { state, pgrp, startTimeTicks }
}

export function parseProcStatStartTimeTicks(statLine: string): number | null {
  return parseProcStatInfo(statLine)?.startTimeTicks ?? null
}

export function readLinuxProcStatInfo(pid: number): ProcStatInfo | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  if (process.platform !== 'linux') return null
  try {
    return parseProcStatInfo(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

export function readLinuxProcStartTimeTicks(pid: number): number | null {
  return readLinuxProcStatInfo(pid)?.startTimeTicks ?? null
}

function defaultListLinuxProcPids(): number[] {
  if (process.platform !== 'linux') return []
  try {
    const entries = readdirSync('/proc')
    const pids: number[] = []
    for (const name of entries) {
      if (!/^[1-9][0-9]*$/.test(name)) continue
      const pid = Number(name)
      if (Number.isSafeInteger(pid) && pid > 1) pids.push(pid)
    }
    return pids
  } catch {
    return []
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function isStatAlive(stat: ProcStatInfo | null): stat is ProcStatInfo {
  if (!stat) return false
  // Zombie ('Z') or Dead ('X') processes have already terminated and cannot be signalled further.
  return stat.state !== 'Z' && stat.state !== 'X'
}

function defaultSendSignal(target: number, signal: NodeJS.Signals): void {
  process.kill(target, signal)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function unlinkSafe(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    /* ignore */
  }
}

function parseSnapshotFile(filePath: string, expectedId: string): SessionBgCommandSnapshot | null {
  try {
    const st = lstatSync(filePath)
    if (st.isSymbolicLink() || !st.isFile()) return null
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = typeof raw.id === 'string' ? raw.id : ''
    const jobId = typeof raw.jobId === 'string' ? raw.jobId : ''
    const pid = typeof raw.pid === 'number' ? raw.pid : Number.NaN
    const pgid = typeof raw.pgid === 'number' ? raw.pgid : Number.NaN
    const ownerPid = typeof raw.ownerPid === 'number' ? raw.ownerPid : 0
    const startTimeTicks =
      typeof raw.startTimeTicks === 'number' && Number.isSafeInteger(raw.startTimeTicks)
        ? raw.startTimeTicks
        : null
    const sessionKey = typeof raw.sessionKey === 'string' ? raw.sessionKey : ''
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
    const commandPreview = typeof raw.commandPreview === 'string' ? raw.commandPreview : ''
    const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : undefined
    const startedAt = typeof raw.startedAt === 'number' ? raw.startedAt : Number.NaN
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : startedAt
    const maxLifetimeAt = typeof raw.maxLifetimeAt === 'number' ? raw.maxLifetimeAt : Number.NaN
    if (
      id !== expectedId ||
      !jobId ||
      !Number.isInteger(pid) ||
      pid <= 1 ||
      !Number.isInteger(pgid) ||
      pgid !== pid ||
      !Number.isFinite(startedAt) ||
      !Number.isFinite(maxLifetimeAt)
    ) {
      return null
    }
    return {
      id,
      jobId,
      pid,
      pgid,
      ownerPid,
      startTimeTicks,
      sessionKey,
      sessionId,
      commandPreview,
      ...(cwd ? { cwd } : {}),
      startedAt,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : startedAt,
      maxLifetimeAt,
    }
  } catch {
    return null
  }
}

interface VerifiedGroupScan {
  /** True when the original leader PID now belongs to a different process or different pgrp. */
  identityMismatch: boolean
  /** Verified live PIDs belonging to `entry.pgid` with `starttime >= entry.startTimeTicks`. */
  members: number[]
}

function buildProcStatReader(ops: SessionBgCommandsOps): (pid: number) => ProcStatInfo | null {
  if (ops.readProcStat) return ops.readProcStat
  if (ops.readStartTimeTicks) {
    // Backwards-compatible adapter for unit tests that inject only `readStartTimeTicks`.
    const isAlive = ops.isProcessAlive ?? defaultIsProcessAlive
    return (pid: number) => {
      if (!isAlive(pid)) return null
      const ticks = ops.readStartTimeTicks!(pid)
      if (ticks === null) return null
      return { state: 'S', pgrp: pid, startTimeTicks: ticks }
    }
  }
  return readLinuxProcStatInfo
}

function scanVerifiedGroupMembers(
  entry: SessionBgCommandSnapshot,
  ops: SessionBgCommandsOps,
): VerifiedGroupScan {
  if (!Number.isInteger(entry.pid) || entry.pid <= 1 || entry.pgid !== entry.pid) {
    return { identityMismatch: true, members: [] }
  }
  const platform = ops.platform ?? process.platform
  const useProcInspection =
    platform === 'linux' || Boolean(ops.readProcStat || ops.readStartTimeTicks || ops.listProcPids)

  if (!useProcInspection) {
    const isAlive = ops.isProcessAlive ?? defaultIsProcessAlive
    return { identityMismatch: false, members: isAlive(entry.pid) ? [entry.pid] : [] }
  }

  // Fail closed when startTimeTicks is absent on Linux so we never risk killing a reused PID/PGID.
  if (entry.startTimeTicks === null) {
    return { identityMismatch: true, members: [] }
  }

  const readStat = buildProcStatReader(ops)
  const leaderStat = readStat(entry.pid)
  if (isStatAlive(leaderStat)) {
    if (leaderStat.pgrp !== entry.pgid || leaderStat.startTimeTicks !== entry.startTimeTicks) {
      return { identityMismatch: true, members: [] }
    }
  }

  const members: number[] = []
  const seen = new Set<number>()
  if (isStatAlive(leaderStat)) {
    members.push(entry.pid)
    seen.add(entry.pid)
  }

  const listPids =
    ops.listProcPids ??
    (ops.readProcStat || ops.readStartTimeTicks ? () => [entry.pid] : defaultListLinuxProcPids)
  for (const pid of listPids()) {
    if (seen.has(pid) || !Number.isInteger(pid) || pid <= 1) continue
    const stat = readStat(pid)
    if (!isStatAlive(stat)) continue
    if (stat.pgrp === entry.pgid && stat.startTimeTicks >= entry.startTimeTicks) {
      members.push(pid)
      seen.add(pid)
    }
  }

  return { identityMismatch: false, members }
}

function signalVerifiedGroup(
  entry: Pick<SessionBgCommandSnapshot, 'pid' | 'pgid'>,
  members: readonly number[],
  signal: NodeJS.Signals,
  sendSignal: (target: number, sig: NodeJS.Signals) => void,
  alsoSignalMembers: boolean,
): boolean {
  let delivered = false
  try {
    sendSignal(-entry.pgid, signal)
    delivered = true
  } catch {
    /* group kill failed (e.g., leader exited or ESRCH); fall through to member PIDs */
  }
  if (!delivered || alsoSignalMembers) {
    for (const pid of members) {
      try {
        sendSignal(pid, signal)
        delivered = true
      } catch {
        /* member already exited */
      }
    }
  }
  return delivered
}

export function listSessionBgCommands(
  sessionId: string,
  registryDir?: string,
  ops: SessionBgCommandsOps = {},
): SessionBgCommandItem[] {
  const sid = sessionId.trim()
  if (!sid) return []
  const dir = registryDir ?? resolveSessionBgCommandsRegistryDir()
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const now = (ops.now ?? Date.now)()
  const items: SessionBgCommandItem[] = []

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const stem = name.slice(0, -'.json'.length)
    if (!SESSION_BG_COMMAND_ID_RE.test(stem)) continue
    const filePath = join(dir, name)
    const entry = parseSnapshotFile(filePath, stem)
    if (!entry) {
      unlinkSafe(filePath)
      continue
    }
    if (now >= entry.maxLifetimeAt) {
      unlinkSafe(filePath)
      continue
    }
    const scan = scanVerifiedGroupMembers(entry, ops)
    if (scan.identityMismatch || scan.members.length === 0) {
      unlinkSafe(filePath)
      continue
    }
    if (entry.sessionId !== sid) continue
    items.push({
      id: entry.id,
      jobId: entry.jobId,
      commandPreview: entry.commandPreview,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
    })
  }

  items.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
  return items.slice(0, SESSION_BG_COMMANDS_MAX_ITEMS)
}

export async function cancelSessionBgCommand(
  sessionId: string,
  entryId: string,
  registryDir?: string,
  ops: SessionBgCommandsOps = {},
): Promise<CancelSessionBgCommandResult> {
  const sid = sessionId.trim()
  if (!sid) {
    return { ok: false, status: 400, code: 'INVALID_SESSION_ID', error: 'sessionId required' }
  }
  if (!SESSION_BG_COMMAND_ID_RE.test(entryId)) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_JOB_ID',
      error: 'invalid background command id',
    }
  }
  const dir = registryDir ?? resolveSessionBgCommandsRegistryDir()
  const filePath = join(dir, `${entryId}.json`)

  let st
  try {
    st = lstatSync(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { ok: true, cancelled: false, alreadyExited: true }
    }
    return { ok: false, status: 500, code: 'IO_ERROR', error: 'failed to read background command' }
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, status: 400, code: 'INVALID_JOB_ID', error: 'invalid background command entry' }
  }

  const entry = parseSnapshotFile(filePath, entryId)
  if (!entry) {
    return {
      ok: false,
      status: 409,
      code: 'BG_COMMAND_IDENTITY_INVALID',
      error: 'background command snapshot failed pgid/pid validation',
    }
  }
  if (entry.sessionId !== sid) {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'background command not found' }
  }

  const nowFn = ops.now ?? Date.now
  if (nowFn() >= entry.maxLifetimeAt) {
    unlinkSafe(filePath)
    return { ok: true, cancelled: false, alreadyExited: true }
  }

  let scan = scanVerifiedGroupMembers(entry, ops)
  if (scan.identityMismatch) {
    unlinkSafe(filePath)
    return { ok: true, cancelled: false, alreadyExited: true }
  }
  if (scan.members.length === 0) {
    unlinkSafe(filePath)
    return { ok: true, cancelled: false, alreadyExited: true }
  }

  const sendSignal = ops.sendSignal ?? defaultSendSignal
  const sleep = ops.sleep ?? defaultSleep
  const graceMs = Math.max(0, ops.killGraceMs ?? SESSION_BG_COMMAND_KILL_GRACE_MS)
  const confirmMs = Math.max(0, ops.killConfirmMs ?? SESSION_BG_COMMAND_KILL_CONFIRM_MS)

  // Phase 1: SIGTERM to verified process group (falling back to verified members if needed).
  const sentTerm = signalVerifiedGroup(entry, scan.members, 'SIGTERM', sendSignal, false)
  if (!sentTerm) {
    scan = scanVerifiedGroupMembers(entry, ops)
    if (scan.identityMismatch || scan.members.length === 0) {
      unlinkSafe(filePath)
      return { ok: true, cancelled: false, alreadyExited: true }
    }
  }

  // Wait up to graceMs for the entire verified group to exit cleanly.
  if (graceMs > 0) {
    let waited = 0
    while (waited < graceMs) {
      const step = Math.min(KILL_POLL_STEP_MS, graceMs - waited)
      await sleep(step)
      waited += step
      scan = scanVerifiedGroupMembers(entry, ops)
      if (scan.identityMismatch || scan.members.length === 0) break
    }
  } else {
    scan = scanVerifiedGroupMembers(entry, ops)
  }

  // Phase 2: escalate to SIGKILL on -pgid AND any remaining verified members, then confirm exit.
  if (!scan.identityMismatch && scan.members.length > 0) {
    signalVerifiedGroup(entry, scan.members, 'SIGKILL', sendSignal, true)
    if (confirmMs > 0) {
      let waited = 0
      while (waited < confirmMs) {
        const step = Math.min(KILL_POLL_STEP_MS, confirmMs - waited)
        await sleep(step)
        waited += step
        scan = scanVerifiedGroupMembers(entry, ops)
        if (scan.identityMismatch || scan.members.length === 0) break
      }
    } else {
      scan = scanVerifiedGroupMembers(entry, ops)
    }
  }

  // Never delete snapshot or report success if verified group members are still running.
  if (!scan.identityMismatch && scan.members.length > 0) {
    return {
      ok: false,
      status: 409,
      code: 'BG_COMMAND_CANCEL_UNCONFIRMED',
      error: `background command process group still has ${scan.members.length} live member(s)`,
    }
  }

  unlinkSafe(filePath)
  return { ok: true, cancelled: true }
}
