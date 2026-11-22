/**
 * Session-scoped `oc_bash` background command snapshot reader & safe terminator (OCV5-844).
 *
 * `packages/mcp-memory/src/ocBashJobManager.ts` atomically writes active job snapshots to
 * `<registryDir>/<ownerPid>-<jobId>.json` including Linux `/proc/<pid>/stat` field 22
 * (`startTimeTicks`). This module reads/filters those snapshots per `sessionId`, reaps dead
 * or expired files, and terminates a targeted process group only after verifying both
 * `sessionId` ownership and `startTimeTicks` identity (eliminating PID-reuse kill risk).
 */
import { lstatSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const SESSION_BG_COMMAND_ID_RE = /^[0-9]+-ocb_[0-9]+$/
export const SESSION_BG_COMMANDS_MAX_ITEMS = 20
export const SESSION_BG_COMMAND_KILL_GRACE_MS = 400
const KILL_POLL_STEP_MS = 40

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
  readStartTimeTicks?: (pid: number) => number | null
  sendSignal?: (pidOrNegPgid: number, signal: NodeJS.Signals) => void
  killGraceMs?: number
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

export function parseProcStatStartTimeTicks(statLine: string): number | null {
  const rparen = statLine.lastIndexOf(')')
  if (rparen < 0) return null
  const rest = statLine.slice(rparen + 1).trim()
  if (!rest) return null
  const fields = rest.split(/\s+/)
  // Field 1=pid, 2=(comm); after last ')', index 0 is field 3 (state), so field 22 is index 19.
  const rawTicks = fields[19]
  if (!rawTicks || !/^\d+$/.test(rawTicks)) return null
  const ticks = Number(rawTicks)
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null
}

export function readLinuxProcStartTimeTicks(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  if (process.platform !== 'linux') return null
  try {
    return parseProcStatStartTimeTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
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
    const pgid = typeof raw.pgid === 'number' ? raw.pgid : pid
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
      !Number.isFinite(startedAt) ||
      !Number.isFinite(maxLifetimeAt)
    ) {
      return null
    }
    return {
      id,
      jobId,
      pid,
      pgid: Number.isInteger(pgid) && pgid > 1 ? pgid : pid,
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

function isSameLiveProcess(
  entry: SessionBgCommandSnapshot,
  now: number,
  ops: SessionBgCommandsOps,
): boolean {
  if (!Number.isInteger(entry.pid) || entry.pid <= 1) return false
  if (now >= entry.maxLifetimeAt) return false
  const isAlive = ops.isProcessAlive ?? defaultIsProcessAlive
  if (!isAlive(entry.pid)) return false
  const platform = ops.platform ?? process.platform
  const readTicks = ops.readStartTimeTicks ?? readLinuxProcStartTimeTicks
  if (platform === 'linux' || ops.readStartTimeTicks) {
    // Fail closed on Linux when startTimeTicks is missing or mismatched to prevent PID-reuse kills.
    if (entry.startTimeTicks === null) return false
    const currentTicks = readTicks(entry.pid)
    if (currentTicks === null || currentTicks !== entry.startTimeTicks) return false
  }
  return true
}

function sendGroupOrPidSignal(
  entry: Pick<SessionBgCommandSnapshot, 'pid' | 'pgid'>,
  signal: NodeJS.Signals,
  sendSignal: (target: number, sig: NodeJS.Signals) => void,
): boolean {
  const pgid = Number.isInteger(entry.pgid) && entry.pgid > 1 ? entry.pgid : entry.pid
  try {
    sendSignal(-pgid, signal)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ESRCH' && pgid === entry.pid) {
      // Group might not exist if process already exited or was not group leader; try pid directly.
    }
    try {
      sendSignal(entry.pid, signal)
      return true
    } catch {
      return false
    }
  }
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
    if (!isSameLiveProcess(entry, now, ops)) {
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
    unlinkSafe(filePath)
    return { ok: true, cancelled: false, alreadyExited: true }
  }
  if (entry.sessionId !== sid) {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'background command not found' }
  }

  const nowFn = ops.now ?? Date.now
  if (!isSameLiveProcess(entry, nowFn(), ops)) {
    unlinkSafe(filePath)
    return { ok: true, cancelled: false, alreadyExited: true }
  }

  const sendSignal = ops.sendSignal ?? defaultSendSignal
  const sleep = ops.sleep ?? defaultSleep
  const graceMs = Math.max(0, ops.killGraceMs ?? SESSION_BG_COMMAND_KILL_GRACE_MS)

  const sentTerm = sendGroupOrPidSignal(entry, 'SIGTERM', sendSignal)
  if (!sentTerm) {
    unlinkSafe(filePath)
    return { ok: true, cancelled: false, alreadyExited: true }
  }

  if (graceMs > 0) {
    let waited = 0
    while (waited < graceMs) {
      const step = Math.min(KILL_POLL_STEP_MS, graceMs - waited)
      await sleep(step)
      waited += step
      if (!isSameLiveProcess(entry, nowFn(), ops)) break
    }
  }

  // Re-verify process identity (pid + startTimeTicks) before escalating to SIGKILL.
  if (isSameLiveProcess(entry, nowFn(), ops)) {
    sendGroupOrPidSignal(entry, 'SIGKILL', sendSignal)
  }

  unlinkSafe(filePath)
  return { ok: true, cancelled: true }
}
