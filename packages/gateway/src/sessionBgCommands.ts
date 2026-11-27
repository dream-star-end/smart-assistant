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
import { lstat, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { JOB_LIFECYCLE_CLASSES, type JobLifecycleClass } from '@openclaude/protocol'
import { parseProcStatFull } from '@openclaude/storage'

const JOB_LIFECYCLE_CLASS_SET: ReadonlySet<string> = new Set<string>(JOB_LIFECYCLE_CLASSES)

function parseSnapshotLifecycleClass(raw: unknown): JobLifecycleClass {
  return typeof raw === 'string' && JOB_LIFECYCLE_CLASS_SET.has(raw)
    ? (raw as JobLifecycleClass)
    : 'ephemeral_turn'
}

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
  lifecycleClass?: JobLifecycleClass
  leaseId?: string
  stdoutLogPath?: string
  stderrLogPath?: string
}

export type SessionBgCommandOwnerFilter =
  | string
  | { readonly sessionKey: string; readonly sessionId?: string }

export interface SessionBgCommandItem {
  id: string
  jobId: string
  commandPreview: string
  cwd?: string
  startedAt: number
  updatedAt: number
  lifecycleClass: JobLifecycleClass
}

export interface ReapSessionBgCommandsResult {
  readonly reapedIds: readonly string[]
  readonly preservedIds: readonly string[]
  readonly failedIds: readonly string[]
}

export interface SweepExpiredSessionBgCommandsResult {
  readonly reapedIds: readonly string[]
  readonly cleanedStaleIds: readonly string[]
  readonly failedIds: readonly string[]
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
  return parseProcStatFull(statLine)
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

function unlinkSafe(filePath: string | undefined): void {
  if (!filePath) return
  try {
    unlinkSync(filePath)
  } catch (err) {
    void err
  }
}

/**
 * F01: Strictly unlink ONLY canonical job log files derived from validated `entryId` inside
 * `<registryDir>/logs` (never trusting raw path strings from snapshot JSON, never following
 * symlinks, and verifying `dirname(realpath(target)) === realpath(logsDir)` before unlink).
 */
async function unlinkCanonicalJobLogsAsync(registryDir: string, entryId: string): Promise<void> {
  if (!SESSION_BG_COMMAND_ID_RE.test(entryId)) return
  const logsDir = join(registryDir, 'logs')
  let realLogsDir: string
  try {
    const dirStat = await lstat(logsDir)
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return
    realLogsDir = await realpath(logsDir)
  } catch {
    return
  }
  const canonicalNames = [
    `${entryId}.stdout.log`,
    `${entryId}.stdout.log.1`,
    `${entryId}.stderr.log`,
    `${entryId}.stderr.log.1`,
  ]
  for (const name of canonicalNames) {
    const candidate = join(realLogsDir, name)
    try {
      const st = await lstat(candidate)
      if (st.isSymbolicLink() || !st.isFile()) continue
      const realCandidate = await realpath(candidate)
      if (dirname(realCandidate) !== realLogsDir) continue
      await unlink(realCandidate)
    } catch (err) {
      void err
    }
  }
}

function shouldUnlinkOwnedLogs(
  entry: Pick<SessionBgCommandSnapshot, 'ownerPid'>,
  ops: SessionBgCommandsOps,
  opts?: { readonly forceUnlinkLogs?: boolean },
): boolean {
  if (opts?.forceUnlinkLogs) return true
  const isAlive = ops.isProcessAlive ?? defaultIsProcessAlive
  const ownerAlive =
    Number.isInteger(entry.ownerPid) && entry.ownerPid > 1 && isAlive(entry.ownerPid)
  return !ownerAlive
}

async function unlinkSnapshotAndOwnedLogsAsync(
  registryDir: string,
  filePath: string,
  entry: Pick<SessionBgCommandSnapshot, 'id' | 'ownerPid'>,
  ops: SessionBgCommandsOps,
  opts?: { readonly forceUnlinkLogs?: boolean },
): Promise<void> {
  unlinkSafe(filePath)
  if (shouldUnlinkOwnedLogs(entry, ops, opts)) {
    await unlinkCanonicalJobLogsAsync(registryDir, entry.id)
  }
}

function scheduleUnlinkSnapshotAndOwnedLogs(
  registryDir: string,
  filePath: string,
  entry: Pick<SessionBgCommandSnapshot, 'id' | 'ownerPid'>,
  ops: SessionBgCommandsOps,
): void {
  unlinkSafe(filePath)
  if (shouldUnlinkOwnedLogs(entry, ops)) {
    void unlinkCanonicalJobLogsAsync(registryDir, entry.id)
  }
}

function matchesOwner(
  entry: Pick<SessionBgCommandSnapshot, 'sessionKey' | 'sessionId'>,
  owner: SessionBgCommandOwnerFilter,
): boolean {
  if (typeof owner === 'string') {
    const sid = owner.trim()
    return sid.length > 0 && (entry.sessionId === sid || entry.sessionKey === sid)
  }
  const key = owner.sessionKey.trim()
  if (!key || !entry.sessionKey) return false
  return entry.sessionKey === key
}

function optNonEmptyString(val: unknown): string | undefined {
  return typeof val === 'string' && val ? val : undefined
}

function parseSnapshotOptionalFields(raw: Record<string, unknown>): Pick<
  SessionBgCommandSnapshot,
  'cwd' | 'lifecycleClass' | 'leaseId' | 'stdoutLogPath' | 'stderrLogPath'
> {
  const cwd = optNonEmptyString(raw.cwd)
  const leaseId = optNonEmptyString(raw.leaseId)
  const stdoutLogPath = optNonEmptyString(raw.stdoutLogPath)
  const stderrLogPath = optNonEmptyString(raw.stderrLogPath)
  return {
    lifecycleClass: parseSnapshotLifecycleClass(raw.lifecycleClass),
    ...(cwd ? { cwd } : {}),
    ...(leaseId ? { leaseId } : {}),
    ...(stdoutLogPath ? { stdoutLogPath } : {}),
    ...(stderrLogPath ? { stderrLogPath } : {}),
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
    const startedAt = typeof raw.startedAt === 'number' ? raw.startedAt : Number.NaN
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : startedAt
    const maxLifetimeAt = typeof raw.maxLifetimeAt === 'number' ? raw.maxLifetimeAt : Number.NaN
    if (
      id !== expectedId || !jobId || !Number.isInteger(pid) || pid <= 1 ||
      pgid !== pid || !Number.isFinite(startedAt) || !Number.isFinite(maxLifetimeAt)
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
      sessionKey: typeof raw.sessionKey === 'string' ? raw.sessionKey : '',
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
      commandPreview: typeof raw.commandPreview === 'string' ? raw.commandPreview : '',
      startedAt,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : startedAt,
      maxLifetimeAt,
      ...parseSnapshotOptionalFields(raw),
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
  } catch (err) {
    void err
  }
  if (!delivered || alsoSignalMembers) {
    for (const pid of members) {
      try {
        sendSignal(pid, signal)
        delivered = true
      } catch (err) {
        void err
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
    const scan = scanVerifiedGroupMembers(entry, ops)
    if (scan.identityMismatch || scan.members.length === 0) {
      scheduleUnlinkSnapshotAndOwnedLogs(dir, filePath, entry, ops)
      continue
    }
    // B07: Never hide a live expired process by unlinking its snapshot while members are alive,
    // and never emit OS signals from this read-only listing path. Live expired processes remain
    // visible until actively terminated & confirmed empty by `sweepExpiredSessionBgCommands` or
    // `cancelSessionBgCommand`.
    if (entry.sessionId !== sid) continue
    items.push({
      id: entry.id,
      jobId: entry.jobId,
      commandPreview: entry.commandPreview,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      lifecycleClass: entry.lifecycleClass ?? 'ephemeral_turn',
    })
  }

  items.sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id))
  return items.slice(0, SESSION_BG_COMMANDS_MAX_ITEMS)
}

async function pollUntilGroupEmpty(
  entry: SessionBgCommandSnapshot,
  ops: SessionBgCommandsOps,
  maxWaitMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<VerifiedGroupScan> {
  if (maxWaitMs <= 0) return scanVerifiedGroupMembers(entry, ops)
  let waited = 0
  let scan = scanVerifiedGroupMembers(entry, ops)
  while (waited < maxWaitMs && !scan.identityMismatch && scan.members.length > 0) {
    const step = Math.min(KILL_POLL_STEP_MS, maxWaitMs - waited)
    await sleep(step)
    waited += step
    scan = scanVerifiedGroupMembers(entry, ops)
  }
  return scan
}

async function terminateVerifiedSnapshotEntry(
  registryDir: string,
  filePath: string,
  entry: SessionBgCommandSnapshot,
  ops: SessionBgCommandsOps,
): Promise<CancelSessionBgCommandResult> {
  let scan = scanVerifiedGroupMembers(entry, ops)
  if (scan.identityMismatch || scan.members.length === 0) {
    await unlinkSnapshotAndOwnedLogsAsync(registryDir, filePath, entry, ops)
    return { ok: true, cancelled: false, alreadyExited: true }
  }
  const sendSignal = ops.sendSignal ?? defaultSendSignal
  const sleep = ops.sleep ?? defaultSleep
  const graceMs = Math.max(0, ops.killGraceMs ?? SESSION_BG_COMMAND_KILL_GRACE_MS)
  const confirmMs = Math.max(0, ops.killConfirmMs ?? SESSION_BG_COMMAND_KILL_CONFIRM_MS)

  if (!signalVerifiedGroup(entry, scan.members, 'SIGTERM', sendSignal, false)) {
    scan = scanVerifiedGroupMembers(entry, ops)
    if (scan.identityMismatch || scan.members.length === 0) {
      await unlinkSnapshotAndOwnedLogsAsync(registryDir, filePath, entry, ops)
      return { ok: true, cancelled: false, alreadyExited: true }
    }
  }
  scan = await pollUntilGroupEmpty(entry, ops, graceMs, sleep)
  if (!scan.identityMismatch && scan.members.length > 0) {
    signalVerifiedGroup(entry, scan.members, 'SIGKILL', sendSignal, true)
    scan = await pollUntilGroupEmpty(entry, ops, confirmMs, sleep)
  }
  if (!scan.identityMismatch && scan.members.length > 0) {
    return {
      ok: false,
      status: 409,
      code: 'BG_COMMAND_CANCEL_UNCONFIRMED',
      error: `background command process group still has ${scan.members.length} live member(s)`,
    }
  }
  await unlinkSnapshotAndOwnedLogsAsync(registryDir, filePath, entry, ops, { forceUnlinkLogs: true })
  return { ok: true, cancelled: true }
}

export async function cancelSessionBgCommand(
  owner: SessionBgCommandOwnerFilter,
  entryId: string,
  registryDir?: string,
  ops: SessionBgCommandsOps = {},
): Promise<CancelSessionBgCommandResult> {
  const validOwner =
    typeof owner === 'string' ? owner.trim().length > 0 : owner.sessionKey.trim().length > 0
  if (!validOwner) {
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
    st = await lstat(filePath)
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
  if (!matchesOwner(entry, owner)) {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'background command not found' }
  }

  // B07: Even if `now >= maxLifetimeAt`, never unlink without proving the process group exited;
  // fall straight into verified SIGTERM -> SIGKILL -> confirm-empty termination.
  return await terminateVerifiedSnapshotEntry(dir, filePath, entry, ops)
}

/**
 * Reap ONLY session-scoped background command snapshots whose `lifecycleClass` belongs to `classes`
 * (e.g. `['ephemeral_turn']` during brain switches / cross-pool handoffs), provably preserving
 * `managed_job` and `daemon_service` processes and snapshots.
 *
 * B05 / W01 / A02: Scans ALL snapshots in `registryDir` without the 20-item UI truncation cap,
 * matches strictly by full `sessionKey` when `{ sessionKey }` is supplied (never guessing by tail),
 * and distinguishes missing registry (`ENOENT`) from real directory read errors (which rethrow).
 */
export async function reapSessionBgCommandsByClass(
  owner: SessionBgCommandOwnerFilter,
  classes: readonly JobLifecycleClass[],
  registryDir?: string,
  ops: SessionBgCommandsOps = {},
): Promise<ReapSessionBgCommandsResult> {
  const validOwner =
    typeof owner === 'string' ? owner.trim().length > 0 : owner.sessionKey.trim().length > 0
  if (!validOwner || classes.length === 0) {
    return { reapedIds: [], preservedIds: [], failedIds: [] }
  }
  const dir = registryDir ?? resolveSessionBgCommandsRegistryDir()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { reapedIds: [], preservedIds: [], failedIds: [] }
    }
    throw err
  }

  const classSet = new Set<JobLifecycleClass>(classes)
  const reapedIds: string[] = []
  const preservedIds: string[] = []
  const failedIds: string[] = []

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const stem = name.slice(0, -'.json'.length)
    if (!SESSION_BG_COMMAND_ID_RE.test(stem)) continue
    const filePath = join(dir, name)
    const entry = parseSnapshotFile(filePath, stem)
    if (!entry) continue
    if (!matchesOwner(entry, owner)) continue

    const effectiveClass = entry.lifecycleClass ?? 'ephemeral_turn'
    if (!classSet.has(effectiveClass)) {
      preservedIds.push(entry.id)
      continue
    }
    const res = await cancelSessionBgCommand(owner, entry.id, dir, ops)
    if (res.ok) {
      reapedIds.push(entry.id)
    } else {
      failedIds.push(entry.id)
    }
  }

  return { reapedIds, preservedIds, failedIds }
}

/**
 * B07: Host/Gateway-level sweeper enforcing deadlines for disconnected `managed_job` snapshots
 * (`now >= maxLifetimeAt`) and reaping orphaned `ephemeral_turn` snapshots whose owning MCP
 * process (`ownerPid`) has exited. Never touches `daemon_service` snapshots while alive.
 */
export async function sweepExpiredSessionBgCommands(
  registryDir?: string,
  ops: SessionBgCommandsOps = {},
): Promise<SweepExpiredSessionBgCommandsResult> {
  const dir = registryDir ?? resolveSessionBgCommandsRegistryDir()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { reapedIds: [], cleanedStaleIds: [], failedIds: [] }
  }

  const now = (ops.now ?? Date.now)()
  const isAlive = ops.isProcessAlive ?? defaultIsProcessAlive
  const reapedIds: string[] = []
  const cleanedStaleIds: string[] = []
  const failedIds: string[] = []

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const stem = name.slice(0, -'.json'.length)
    if (!SESSION_BG_COMMAND_ID_RE.test(stem)) continue
    const filePath = join(dir, name)
    const entry = parseSnapshotFile(filePath, stem)
    if (!entry) {
      unlinkSafe(filePath)
      cleanedStaleIds.push(stem)
      continue
    }

    const scan = scanVerifiedGroupMembers(entry, ops)
    if (scan.identityMismatch || scan.members.length === 0) {
      await unlinkSnapshotAndOwnedLogsAsync(dir, filePath, entry, ops)
      cleanedStaleIds.push(entry.id)
      continue
    }

    const effectiveClass = entry.lifecycleClass ?? 'ephemeral_turn'
    if (effectiveClass === 'daemon_service') {
      continue
    }

    const expired = now >= entry.maxLifetimeAt
    const orphanedEphemeral =
      effectiveClass === 'ephemeral_turn' &&
      Number.isInteger(entry.ownerPid) &&
      entry.ownerPid > 1 &&
      !isAlive(entry.ownerPid)

    if (!expired && !orphanedEphemeral) {
      continue
    }

    const res = await terminateVerifiedSnapshotEntry(dir, filePath, entry, ops)
    if (res.ok) {
      if (res.cancelled) reapedIds.push(entry.id)
      else cleanedStaleIds.push(entry.id)
    } else {
      failedIds.push(entry.id)
    }
  }

  return { reapedIds, cleanedStaleIds, failedIds }
}

interface BgSweepLogger {
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
}

export async function runPeriodicBgCommandSweep(logger: BgSweepLogger): Promise<void> {
  const bgSweep = await sweepExpiredSessionBgCommands().catch((err) => {
    logger.warn('expired bg command sweep failed', { error: String(err) })
    return null
  })
  if (bgSweep && (bgSweep.reapedIds.length > 0 || bgSweep.failedIds.length > 0)) {
    logger.info('expired bg command sweep', {
      reapedCount: bgSweep.reapedIds.length,
      cleanedStaleCount: bgSweep.cleanedStaleIds.length,
      failedCount: bgSweep.failedIds.length,
    })
  }
}

export async function reapEphemeralBgCommandsSafe(
  sessionKey: string,
  skip: unknown,
  logger: BgSweepLogger,
): Promise<void> {
  if (skip) return
  const reap = await reapSessionBgCommandsByClass({ sessionKey }, ['ephemeral_turn']).catch((err) => {
    logger.warn('session_ephemeral_bg_reap_failed', {
      sessionKey,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  })
  if (reap?.failedIds.length) {
    logger.warn('session_ephemeral_bg_reap_incomplete', { sessionKey, failedIds: reap.failedIds })
  }
}
