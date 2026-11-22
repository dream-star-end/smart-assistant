/**
 * Turn-scoped soft-yield job manager and bounded delta stream buffer for Antigravity `oc_bash` (OCV5-789).
 *
 * When a foreground command outlives `timeout_ms` (default 60s, max 600s), the process group stays
 * alive by default so progress is never lost. Callers resume with `job_id` (`wait` / `status` / `kill`)
 * until completion or explicit stop. Idle unpolled jobs, max-lifetime jobs, and MCP disconnect
 * immediately reap the entire detached process group and destroy stdio streams.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const OC_BASH_MAX_OUTPUT_BYTES = 200 * 1024
export const OC_BASH_HEAD_BYTES = 64 * 1024
export const OC_BASH_TAIL_BYTES = OC_BASH_MAX_OUTPUT_BYTES - OC_BASH_HEAD_BYTES
export const OC_BASH_MAX_ACTIVE_JOBS = 4
export const OC_BASH_IDLE_JOB_TTL_MS = 5 * 60_000
export const OC_BASH_MAX_JOB_LIFETIME_MS = 2 * 60 * 60_000
export const OC_BASH_TOMBSTONE_MAX = 64
export const OC_BASH_SNAPSHOT_PREVIEW_MAX_CHARS = 240
export const KILL_GRACE_MS = 400
export const CLOSE_DRAIN_SAFETY_MS = 2_000

export interface OcBashJobSnapshot {
  id: string
  jobId: string
  pid: number
  pgid: number
  ownerPid: number
  startTimeTicks: number | null
  sessionKey: string
  sessionId: string
  commandPreview: string
  cwd: string
  startedAt: number
  updatedAt: number
  maxLifetimeAt: number
}

export function resolveOcBashRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OC_BASH_REGISTRY_DIR?.trim()
  if (explicit) return explicit
  const base =
    env.OPENCLAUDE_STATE_DIR?.trim() ||
    env.OPENCLAUDE_RUNTIME_DIR?.trim() ||
    '/home/agent/.openclaude'
  return join(base, 'run', 'oc-bash-jobs')
}

export function resolveOcBashSessionIdentity(
  env: NodeJS.ProcessEnv = process.env,
  overrideSessionKey?: string,
): { sessionKey: string; sessionId: string } {
  const sessionKey = (
    overrideSessionKey ??
    env.OC_SESSION_KEY ??
    env.OPENCLAUDE_SESSION_KEY ??
    ''
  ).trim()
  if (!sessionKey) return { sessionKey: '', sessionId: '' }
  const lastColon = sessionKey.lastIndexOf(':')
  const sessionId = lastColon >= 0 ? sessionKey.slice(lastColon + 1) : sessionKey
  return { sessionKey, sessionId }
}

/**
 * Parse field 22 (`starttime`, clock ticks since boot) from Linux `/proc/${pid}/stat`.
 * Handles process `comm` names containing spaces or parentheses by splitting after the last `)`.
 */
export function readProcStartTimeTicks(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  if (process.platform !== 'linux') return null
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return parseProcStatStartTimeTicks(raw)
  } catch {
    return null
  }
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

/**
 * Returns true if any live non-zombie process still belongs to verified process group `pgid`
 * with `starttime >= minStartTicks` (prevents deleting the control snapshot when the shell
 * leader exits while detached sub-children in the same process group are still running).
 */
export function hasAliveVerifiedGroupMembers(pgid: number, minStartTicks: number | null): boolean {
  if (process.platform !== 'linux' || !Number.isInteger(pgid) || pgid <= 1 || minStartTicks === null) {
    return false
  }
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return false
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    try {
      const raw = readFileSync(`/proc/${name}/stat`, 'utf8')
      const rparen = raw.lastIndexOf(')')
      if (rparen < 0) continue
      const fields = raw.slice(rparen + 1).trim().split(/\s+/)
      const state = fields[0] ?? ''
      if (state === 'Z' || state === 'X' || state === 'x') continue
      const pgrp = Number(fields[2])
      if (pgrp !== pgid) continue
      const ticks = Number(fields[19])
      if (Number.isSafeInteger(ticks) && ticks >= minStartTicks) {
        return true
      }
    } catch {
      /* exited during scan */
    }
  }
  return false
}

/**
 * Single-line redacted command preview bounded to <= 240 chars for disk job snapshots.
 */
export function sanitizeOcBashCommandPreview(
  command: string,
  maxChars = OC_BASH_SNAPSHOT_PREVIEW_MAX_CHARS,
): string {
  let text = command.replace(/\s+/g, ' ').trim()
  // Redact URL credentials (scheme://user:pass@host)
  text = text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s]+)(@)/g, '$1[REDACTED]$3')
  // Redact Bearer / Basic authorization tokens
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
  // Redact common secret key assignments (ENV=val or --flag=val / --flag val)
  text = text.replace(
    /\b([A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH)[A-Za-z0-9_-]*)(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|[^\s"'`;|&]+)/gi,
    '$1$2[REDACTED]',
  )
  // Redact high-confidence provider secret prefixes
  text = text.replace(
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g,
    '[REDACTED]',
  )
  if (text.length <= maxChars) return text
  const cut = Math.max(0, maxChars - 3)
  return `${text.slice(0, cut)}...`
}

export type OcBashAction = 'wait' | 'status' | 'kill'
export type JobTerminationReason = 'killed' | 'hard_timeout' | 'idle_timeout' | 'max_lifetime'
export type JobTombstoneReason = 'collected' | 'killed' | 'idle_timeout' | 'max_lifetime'

export interface JobTombstone {
  jobId: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  reason: JobTombstoneReason
  elapsedMs: number
  commandPreview: string
}

export type OcBashCallOutcome =
  | {
      kind: 'finished'
      jobId: string
      exitCode: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      truncated: boolean
      elapsedMs: number
      spawnError?: string
    }
  | {
      kind: 'running'
      jobId: string
      elapsedMs: number
      stdout: string
      stderr: string
      truncated: boolean
    }
  | {
      kind: 'hard_timeout'
      timeoutMs: number
      exitCode: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      truncated: boolean
    }
  | {
      kind: 'killed'
      jobId: string
      exitCode: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      truncated: boolean
      elapsedMs: number
    }
  | {
      kind: 'terminated'
      jobId: string
      reason: 'idle_timeout' | 'max_lifetime'
      exitCode: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      truncated: boolean
      elapsedMs: number
    }
  | { kind: 'tombstone'; tombstone: JobTombstone }
  | { kind: 'not_found'; jobId: string }
  | { kind: 'busy'; jobId: string }
  | { kind: 'too_many_jobs'; maxActiveJobs: number; active: string[] }
  | { kind: 'spawn_error'; error: string }

/**
 * Count trailing bytes (1..3) belonging to an incomplete multi-byte UTF-8 sequence at the end of `buf`.
 */
export function trailingIncompleteUtf8Count(buf: Buffer): number {
  const len = buf.length
  if (len === 0) return 0
  let pos = len - 1
  const minPos = Math.max(0, len - 3)
  while (pos > minPos && (buf[pos]! & 0xc0) === 0x80) {
    pos -= 1
  }
  const lead = buf[pos]!
  if ((lead & 0x80) === 0) return 0
  if ((lead & 0xc0) === 0x80) return 0
  let expectedLen = 0
  if ((lead & 0xe0) === 0xc0) expectedLen = 2
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4
  else return 0
  const actualLen = len - pos
  return actualLen < expectedLen ? actualLen : 0
}

/**
 * Count leading orphaned UTF-8 continuation bytes (`10xxxxxx`) at the start of a sliced tail buffer.
 */
export function leadingContinuationUtf8Count(buf: Buffer): number {
  let i = 0
  const limit = Math.min(3, buf.length)
  while (i < limit && (buf[i]! & 0xc0) === 0x80) {
    i += 1
  }
  return i
}

/**
 * O(1) bounded per-segment stream buffer keeping `headCap` (32%) + rolling `tailCap` (68%) when truncated,
 * while holding incomplete multi-byte UTF-8 tails across `drain(false)` segments so characters never split.
 */
export class DeltaStreamBuffer {
  private readonly maxBytes: number
  private readonly headCap: number
  private readonly tailCap: number
  private unreadChunks: Buffer[] = []
  private unreadBytes = 0
  private totalBytes = 0
  private truncated = false
  private headBuf = Buffer.alloc(0)
  private tailBuf = Buffer.alloc(0)
  private carry = Buffer.alloc(0)

  constructor(maxBytes = OC_BASH_MAX_OUTPUT_BYTES) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes))
    this.headCap = Math.max(0, Math.floor(this.maxBytes * 0.32))
    this.tailCap = Math.max(0, this.maxBytes - this.headCap)
  }

  push(chunk: Buffer): void {
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, chunk]) : chunk
    if (this.carry.length > 0) this.carry = Buffer.alloc(0)
    if (data.length === 0) return

    this.totalBytes += data.length
    if (!this.truncated) {
      if (this.unreadBytes + data.length <= this.maxBytes) {
        this.unreadChunks.push(data)
        this.unreadBytes += data.length
        return
      }
      this.truncated = true
      this.unreadChunks.push(data)
      const combined = Buffer.concat(this.unreadChunks)
      this.unreadChunks = []
      this.unreadBytes = 0
      this.headBuf = Buffer.from(combined.subarray(0, this.headCap))
      this.tailBuf = this.tailCap > 0
        ? Buffer.from(combined.subarray(Math.max(this.headCap, combined.length - this.tailCap)))
        : Buffer.alloc(0)
      return
    }

    if (this.tailCap === 0) return
    if (data.length >= this.tailCap) {
      this.tailBuf = Buffer.from(data.subarray(data.length - this.tailCap))
    } else if (this.tailBuf.length + data.length <= this.tailCap) {
      this.tailBuf = Buffer.concat([this.tailBuf, data])
    } else {
      const keepFromOld = this.tailCap - data.length
      this.tailBuf = Buffer.concat([this.tailBuf.subarray(this.tailBuf.length - keepFromOld), data])
    }
  }

  drain(isFinal: boolean): { text: string; truncated: boolean } {
    if (this.totalBytes === 0) {
      if (isFinal && this.carry.length > 0) {
        const text = this.carry.toString('utf8')
        this.carry = Buffer.alloc(0)
        return { text, truncated: false }
      }
      return { text: '', truncated: false }
    }

    if (!this.truncated) {
      let buf = Buffer.concat(this.unreadChunks)
      this.unreadChunks = []
      this.unreadBytes = 0
      this.totalBytes = 0
      if (!isFinal) {
        const trail = trailingIncompleteUtf8Count(buf)
        if (trail > 0) {
          this.carry = Buffer.from(buf.subarray(buf.length - trail))
          buf = buf.subarray(0, buf.length - trail)
        }
      }
      return { text: buf.toString('utf8'), truncated: false }
    }

    const headCut = trailingIncompleteUtf8Count(this.headBuf)
    const headClean = headCut > 0 ? this.headBuf.subarray(0, this.headBuf.length - headCut) : this.headBuf

    const tailLeadSkip = leadingContinuationUtf8Count(this.tailBuf)
    let tailClean = tailLeadSkip > 0 ? this.tailBuf.subarray(tailLeadSkip) : this.tailBuf
    let tailTrail = 0
    if (!isFinal) {
      tailTrail = trailingIncompleteUtf8Count(tailClean)
      if (tailTrail > 0) {
        this.carry = Buffer.from(tailClean.subarray(tailClean.length - tailTrail))
        tailClean = tailClean.subarray(0, tailClean.length - tailTrail)
      }
    }

    const omitted = Math.max(0, this.totalBytes - headClean.length - tailClean.length - tailTrail)
    const headText = headClean.toString('utf8')
    const tailText = tailClean.toString('utf8')

    this.headBuf = Buffer.alloc(0)
    this.tailBuf = Buffer.alloc(0)
    this.unreadChunks = []
    this.unreadBytes = 0
    this.totalBytes = 0
    this.truncated = false

    return {
      text: `${headText}\n...[truncated ${omitted} bytes]...\n${tailText}`,
      truncated: true,
    }
  }

  clear(): void {
    this.unreadChunks = []
    this.unreadBytes = 0
    this.totalBytes = 0
    this.truncated = false
    this.headBuf = Buffer.alloc(0)
    this.tailBuf = Buffer.alloc(0)
    this.carry = Buffer.alloc(0)
  }
}

export function killChildProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid || pid <= 0) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

interface ManagedBashJob {
  id: string
  commandPreview: string
  snapshotPreview: string
  cwd: string
  startedAt: number
  maxLifetimeAt: number
  startTimeTicks: number | null
  snapshotPath: string | null
  child: ChildProcess
  stdout: DeltaStreamBuffer
  stderr: DeltaStreamBuffer
  closed: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  spawnError?: string
  yielded: boolean
  waiterInFlight: boolean
  killRequested: boolean
  terminationReason: JobTerminationReason | null
  killTimer: NodeJS.Timeout | null
  closeSafetyTimer: NodeJS.Timeout | null
  idleTimer: NodeJS.Timeout | null
  lifetimeTimer: NodeJS.Timeout | null
  closePromise: Promise<void>
  resolveClose: () => void
}

export interface OcBashJobManagerOptions {
  idleJobTtlMs?: number
  maxJobLifetimeMs?: number
  maxActiveJobs?: number
  maxBytes?: number
  killGraceMs?: number
  closeDrainSafetyMs?: number
  trackProcessGroup?: (pid: number) => void
  untrackProcessGroup?: (pid: number | undefined) => void
  /** Override disk snapshot registry directory; pass `null` to disable snapshots. */
  registryDir?: string | null
  /** Override session key stamped into snapshots (defaults to OC_SESSION_KEY / OPENCLAUDE_SESSION_KEY). */
  sessionKey?: string
  /** Environment source for registryDir / sessionKey resolution (defaults to process.env). */
  env?: NodeJS.ProcessEnv
}

function makeCommandPreview(command: string): string {
  const singleLine = command.replace(/\s+/g, ' ').trim()
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine
}

export class OcBashJobManager {
  private readonly idleJobTtlMs: number
  private readonly maxJobLifetimeMs: number
  private readonly maxActiveJobs: number
  private readonly maxBytes: number
  private readonly killGraceMs: number
  private readonly closeDrainSafetyMs: number
  private readonly trackProcessGroup?: (pid: number) => void
  private readonly untrackProcessGroup?: (pid: number | undefined) => void
  private readonly registryDir: string | null
  private readonly sessionKeyOverride?: string
  private readonly env: NodeJS.ProcessEnv

  private seq = 0
  private readonly jobs = new Map<string, ManagedBashJob>()
  private readonly tombstones = new Map<string, JobTombstone>()
  private readonly localProcessGroups = new Set<number>()
  private readonly activeSnapshotPaths = new Set<string>()
  private isShutdown = false

  constructor(opts: OcBashJobManagerOptions = {}) {
    this.idleJobTtlMs = opts.idleJobTtlMs ?? OC_BASH_IDLE_JOB_TTL_MS
    this.maxJobLifetimeMs = opts.maxJobLifetimeMs ?? OC_BASH_MAX_JOB_LIFETIME_MS
    this.maxActiveJobs = opts.maxActiveJobs ?? OC_BASH_MAX_ACTIVE_JOBS
    this.maxBytes = opts.maxBytes ?? OC_BASH_MAX_OUTPUT_BYTES
    this.killGraceMs = opts.killGraceMs ?? KILL_GRACE_MS
    this.closeDrainSafetyMs = opts.closeDrainSafetyMs ?? CLOSE_DRAIN_SAFETY_MS
    this.trackProcessGroup = opts.trackProcessGroup
    this.untrackProcessGroup = opts.untrackProcessGroup
    this.env = opts.env ?? process.env
    this.sessionKeyOverride = opts.sessionKey
    this.registryDir =
      opts.registryDir === undefined
        ? resolveOcBashRegistryDir(this.env)
        : opts.registryDir && opts.registryDir.trim()
          ? opts.registryDir.trim()
          : null
  }

  private writeJobSnapshot(job: ManagedBashJob): void {
    if (!this.registryDir || job.closed || this.isShutdown) return
    const pid = job.child.pid
    if (!pid || pid <= 1) return
    if (job.startTimeTicks === null) {
      job.startTimeTicks = readProcStartTimeTicks(pid)
    }
    const now = Date.now()
    const { sessionKey, sessionId } = resolveOcBashSessionIdentity(this.env, this.sessionKeyOverride)
    const id = `${process.pid}-${job.id}`
    const snapshot: OcBashJobSnapshot = {
      id,
      jobId: job.id,
      pid,
      pgid: pid,
      ownerPid: process.pid,
      startTimeTicks: job.startTimeTicks,
      sessionKey,
      sessionId,
      commandPreview: job.snapshotPreview,
      cwd: job.cwd,
      startedAt: job.startedAt,
      updatedAt: now,
      maxLifetimeAt: job.maxLifetimeAt,
    }
    const targetPath = join(this.registryDir, `${id}.json`)
    const tmpPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`
    try {
      mkdirSync(this.registryDir, { recursive: true })
      writeFileSync(tmpPath, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmpPath, targetPath)
      job.snapshotPath = targetPath
      this.activeSnapshotPaths.add(targetPath)
    } catch {
      // Fail-open: disk registry errors must never disrupt oc_bash execution.
      try {
        unlinkSync(tmpPath)
      } catch {
        /* ignore */
      }
    }
  }

  private removeJobSnapshot(job: ManagedBashJob): void {
    const filePath =
      job.snapshotPath ??
      (this.registryDir ? join(this.registryDir, `${process.pid}-${job.id}.json`) : null)
    job.snapshotPath = null
    if (!filePath) return
    this.activeSnapshotPaths.delete(filePath)
    try {
      unlinkSync(filePath)
    } catch {
      /* already removed or unwritable */
    }
  }

  /** Synchronously unlink all tracked snapshot files (safe for process exit/signal handlers). */
  cleanupSnapshotsSync(): void {
    for (const filePath of this.activeSnapshotPaths) {
      try {
        unlinkSync(filePath)
      } catch {
        /* ignore */
      }
    }
    this.activeSnapshotPaths.clear()
  }

  activeRunningCount(): number {
    let count = 0
    for (const job of this.jobs.values()) {
      if (!job.closed) count += 1
    }
    return count
  }

  listActiveJobsSummary(): string[] {
    const now = Date.now()
    const lines: string[] = []
    for (const job of this.jobs.values()) {
      if (job.closed) continue
      const elapsedSec = Math.max(0, Math.round((now - job.startedAt) / 1000))
      lines.push(`- ${job.id} (${elapsedSec}s): ${job.commandPreview}`)
    }
    return lines
  }

  private clearIdleTimer(job: ManagedBashJob): void {
    if (job.idleTimer) {
      clearTimeout(job.idleTimer)
      job.idleTimer = null
    }
  }

  private clearJobTimers(job: ManagedBashJob): void {
    this.clearIdleTimer(job)
    if (job.killTimer) {
      clearTimeout(job.killTimer)
      job.killTimer = null
    }
    if (job.closeSafetyTimer) {
      clearTimeout(job.closeSafetyTimer)
      job.closeSafetyTimer = null
    }
    if (job.lifetimeTimer) {
      clearTimeout(job.lifetimeTimer)
      job.lifetimeTimer = null
    }
  }

  private recordTombstone(job: ManagedBashJob, reason: JobTombstoneReason): void {
    this.clearJobTimers(job)
    this.removeJobSnapshot(job)
    job.stdout.clear()
    job.stderr.clear()
    this.jobs.delete(job.id)
    if (!job.yielded) return
    if (this.tombstones.has(job.id)) this.tombstones.delete(job.id)
    this.tombstones.set(job.id, {
      jobId: job.id,
      exitCode: job.exitCode,
      signal: job.signal,
      reason,
      elapsedMs: Date.now() - job.startedAt,
      commandPreview: job.commandPreview,
    })
    while (this.tombstones.size > OC_BASH_TOMBSTONE_MAX) {
      const oldestKey = this.tombstones.keys().next().value
      if (oldestKey === undefined) break
      this.tombstones.delete(oldestKey)
    }
  }

  private killJobGroup(job: ManagedBashJob): void {
    if (job.closed) return
    if (job.killRequested) return
    job.killRequested = true
    killChildProcessGroup(job.child, 'SIGTERM')
    job.killTimer = setTimeout(() => {
      job.killTimer = null
      if (job.closed) return
      killChildProcessGroup(job.child, 'SIGKILL')
      job.closeSafetyTimer = setTimeout(() => {
        job.closeSafetyTimer = null
        if (job.closed) return
        try {
          job.child.stdout?.destroy()
          job.child.stderr?.destroy()
        } catch {
          /* ignore */
        }
        this.finalizeClosedJob(job, job.exitCode, job.signal ?? 'SIGKILL')
      }, this.closeDrainSafetyMs)
      job.closeSafetyTimer.unref()
    }, this.killGraceMs)
    job.killTimer.unref()
  }

  private armIdleTimer(job: ManagedBashJob): void {
    this.clearIdleTimer(job)
    if (this.isShutdown) return
    job.idleTimer = setTimeout(() => {
      job.idleTimer = null
      if (job.waiterInFlight || this.isShutdown) return
      if (job.closed) {
        // Yielded job finished in background and was never collected before idle TTL elapsed.
        this.recordTombstone(job, 'collected')
        return
      }
      job.terminationReason ??= 'idle_timeout'
      this.killJobGroup(job)
    }, this.idleJobTtlMs)
    job.idleTimer.unref()
  }

  private finalizeClosedJob(
    job: ManagedBashJob,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (job.closed) return
    if (job.killRequested) {
      killChildProcessGroup(job.child, 'SIGKILL')
    }
    job.closed = true
    job.exitCode = exitCode
    job.signal = signal
    if (job.killTimer) {
      clearTimeout(job.killTimer)
      job.killTimer = null
    }
    if (job.closeSafetyTimer) {
      clearTimeout(job.closeSafetyTimer)
      job.closeSafetyTimer = null
    }
    if (job.lifetimeTimer) {
      clearTimeout(job.lifetimeTimer)
      job.lifetimeTimer = null
    }
    const pid = job.child.pid
    if (pid && pid > 0) {
      this.localProcessGroups.delete(pid)
      this.untrackProcessGroup?.(pid)
    }
    const groupStillRunning =
      !job.killRequested &&
      Boolean(pid && pid > 1) &&
      hasAliveVerifiedGroupMembers(pid!, job.startTimeTicks)
    if (!groupStillRunning) {
      this.removeJobSnapshot(job)
    } else if (job.snapshotPath) {
      // Leader exited while child processes in the same process group are still alive:
      // keep the disk snapshot so gateway list/cancel retains control until the group exits.
      this.activeSnapshotPaths.delete(job.snapshotPath)
    }
    job.resolveClose()

    if (!job.waiterInFlight && job.yielded) {
      if (job.terminationReason === 'idle_timeout' || job.terminationReason === 'max_lifetime') {
        this.recordTombstone(job, job.terminationReason)
      } else {
        // Keep output buffered for the next wait/status call, bounded by idleJobTtlMs.
        this.armIdleTimer(job)
      }
    }
  }

  private async waitCloseOrTimeout(job: ManagedBashJob, timeoutMs: number): Promise<void> {
    if (job.closed) return
    let timer: NodeJS.Timeout | null = null
    try {
      await Promise.race([
        job.closePromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
          timer.unref()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async startAndWait(spec: {
    command: string
    cwd?: string
    timeoutMs: number
    killOnTimeout?: boolean
  }): Promise<OcBashCallOutcome> {
    if (this.isShutdown) {
      return { kind: 'spawn_error', error: 'oc_bash 正在关闭，拒绝启动新命令' }
    }
    if (this.activeRunningCount() >= this.maxActiveJobs) {
      return {
        kind: 'too_many_jobs',
        maxActiveJobs: this.maxActiveJobs,
        active: this.listActiveJobsSummary(),
      }
    }

    let child: ChildProcess
    try {
      child = spawn('/bin/bash', ['-lc', spec.command], {
        cwd: spec.cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OC_BASH_TIMEOUT_MS: String(spec.timeoutMs),
        },
      })
    } catch (err) {
      return {
        kind: 'spawn_error',
        error: err instanceof Error ? err.message : String(err),
      }
    }

    const jobId = `ocb_${++this.seq}`
    let resolveClose!: () => void
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve
    })

    const startedAt = Date.now()
    const job: ManagedBashJob = {
      id: jobId,
      commandPreview: makeCommandPreview(spec.command),
      snapshotPreview: sanitizeOcBashCommandPreview(spec.command),
      cwd: spec.cwd ?? process.cwd(),
      startedAt,
      maxLifetimeAt: startedAt + this.maxJobLifetimeMs,
      startTimeTicks: null,
      snapshotPath: null,
      child,
      stdout: new DeltaStreamBuffer(this.maxBytes),
      stderr: new DeltaStreamBuffer(this.maxBytes),
      closed: false,
      exitCode: null,
      signal: null,
      yielded: false,
      waiterInFlight: true,
      killRequested: false,
      terminationReason: null,
      killTimer: null,
      closeSafetyTimer: null,
      idleTimer: null,
      lifetimeTimer: null,
      closePromise,
      resolveClose,
    }

    this.jobs.set(jobId, job)
    if (child.pid && child.pid > 0) {
      this.localProcessGroups.add(child.pid)
      this.trackProcessGroup?.(child.pid)
      this.writeJobSnapshot(job)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      job.stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      job.stderr.push(chunk)
    })
    child.on('error', (err) => {
      job.spawnError = err.message
      this.finalizeClosedJob(job, null, null)
    })
    child.on('close', (code, signal) => {
      this.finalizeClosedJob(job, code, signal)
    })

    job.lifetimeTimer = setTimeout(() => {
      job.lifetimeTimer = null
      if (job.closed || this.isShutdown) return
      job.terminationReason ??= 'max_lifetime'
      this.killJobGroup(job)
    }, this.maxJobLifetimeMs)
    job.lifetimeTimer.unref()

    await this.waitCloseOrTimeout(job, spec.timeoutMs)

    if (job.closed) {
      job.waiterInFlight = false
      this.clearJobTimers(job)
      this.jobs.delete(jobId)
      if (job.spawnError && job.terminationReason === null) {
        job.stdout.clear()
        job.stderr.clear()
        return { kind: 'spawn_error', error: job.spawnError }
      }
      const out = job.stdout.drain(true)
      const err = job.stderr.drain(true)
      const truncated = out.truncated || err.truncated
      if (job.terminationReason === 'max_lifetime') {
        return {
          kind: 'terminated',
          jobId,
          reason: 'max_lifetime',
          exitCode: job.exitCode,
          signal: job.signal,
          stdout: out.text,
          stderr: err.text,
          truncated,
          elapsedMs: Date.now() - job.startedAt,
        }
      }
      return {
        kind: 'finished',
        jobId,
        exitCode: job.exitCode,
        signal: job.signal,
        stdout: out.text,
        stderr: err.text,
        truncated,
        elapsedMs: Date.now() - job.startedAt,
      }
    }

    if (spec.killOnTimeout) {
      job.terminationReason = 'hard_timeout'
      this.killJobGroup(job)
      await job.closePromise
      job.waiterInFlight = false
      this.clearJobTimers(job)
      this.jobs.delete(jobId)
      const out = job.stdout.drain(true)
      const err = job.stderr.drain(true)
      return {
        kind: 'hard_timeout',
        timeoutMs: spec.timeoutMs,
        exitCode: job.exitCode,
        signal: job.signal,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      }
    }

    job.yielded = true
    job.waiterInFlight = false
    this.writeJobSnapshot(job)
    this.armIdleTimer(job)
    const out = job.stdout.drain(false)
    const err = job.stderr.drain(false)
    return {
      kind: 'running',
      jobId,
      elapsedMs: Date.now() - job.startedAt,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
    }
  }

  async continueJob(spec: {
    jobId: string
    action: OcBashAction
    timeoutMs: number
    killOnTimeout?: boolean
  }): Promise<OcBashCallOutcome> {
    const job = this.jobs.get(spec.jobId)
    if (!job) {
      const tombstone = this.tombstones.get(spec.jobId)
      if (tombstone) return { kind: 'tombstone', tombstone }
      return { kind: 'not_found', jobId: spec.jobId }
    }
    if (job.waiterInFlight) {
      return { kind: 'busy', jobId: spec.jobId }
    }

    // If a background idle/lifetime kill is already in progress, let it finish closing cleanly.
    if (
      !job.closed &&
      (job.terminationReason === 'idle_timeout' || job.terminationReason === 'max_lifetime')
    ) {
      this.clearIdleTimer(job)
      job.waiterInFlight = true
      await job.closePromise
      job.waiterInFlight = false
      const reason = job.terminationReason
      const out = job.stdout.drain(true)
      const err = job.stderr.drain(true)
      const truncated = out.truncated || err.truncated
      this.recordTombstone(job, reason)
      return {
        kind: 'terminated',
        jobId: job.id,
        reason,
        exitCode: job.exitCode,
        signal: job.signal,
        stdout: out.text,
        stderr: err.text,
        truncated,
        elapsedMs: Date.now() - job.startedAt,
      }
    }

    if (spec.action === 'kill') {
      this.clearIdleTimer(job)
      job.waiterInFlight = true
      if (!job.closed) {
        job.terminationReason ??= 'killed'
        this.killJobGroup(job)
        await job.closePromise
      }
      job.waiterInFlight = false
      const out = job.stdout.drain(true)
      const err = job.stderr.drain(true)
      const truncated = out.truncated || err.truncated
      this.recordTombstone(job, 'killed')
      return {
        kind: 'killed',
        jobId: job.id,
        exitCode: job.exitCode,
        signal: job.signal,
        stdout: out.text,
        stderr: err.text,
        truncated,
        elapsedMs: Date.now() - job.startedAt,
      }
    }

    if (spec.action === 'status') {
      if (job.closed) {
        return this.collectClosedJob(job)
      }
      this.writeJobSnapshot(job)
      this.armIdleTimer(job)
      const out = job.stdout.drain(false)
      const err = job.stderr.drain(false)
      return {
        kind: 'running',
        jobId: job.id,
        elapsedMs: Date.now() - job.startedAt,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      }
    }

    // action === 'wait'
    if (job.closed) {
      return this.collectClosedJob(job)
    }

    this.clearIdleTimer(job)
    job.waiterInFlight = true
    await this.waitCloseOrTimeout(job, spec.timeoutMs)

    if (job.closed) {
      job.waiterInFlight = false
      return this.collectClosedJob(job)
    }

    if (spec.killOnTimeout) {
      job.terminationReason = 'hard_timeout'
      this.killJobGroup(job)
      await job.closePromise
      job.waiterInFlight = false
      const out = job.stdout.drain(true)
      const err = job.stderr.drain(true)
      const truncated = out.truncated || err.truncated
      this.recordTombstone(job, 'killed')
      return {
        kind: 'hard_timeout',
        timeoutMs: spec.timeoutMs,
        exitCode: job.exitCode,
        signal: job.signal,
        stdout: out.text,
        stderr: err.text,
        truncated,
      }
    }

    job.waiterInFlight = false
    this.writeJobSnapshot(job)
    this.armIdleTimer(job)
    const out = job.stdout.drain(false)
    const err = job.stderr.drain(false)
    return {
      kind: 'running',
      jobId: job.id,
      elapsedMs: Date.now() - job.startedAt,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated || err.truncated,
    }
  }

  private collectClosedJob(job: ManagedBashJob): OcBashCallOutcome {
    this.clearJobTimers(job)
    const out = job.stdout.drain(true)
    const err = job.stderr.drain(true)
    const truncated = out.truncated || err.truncated
    const reason = job.terminationReason
    if (reason === 'idle_timeout' || reason === 'max_lifetime') {
      this.recordTombstone(job, reason)
      return {
        kind: 'terminated',
        jobId: job.id,
        reason,
        exitCode: job.exitCode,
        signal: job.signal,
        stdout: out.text,
        stderr: err.text,
        truncated,
        elapsedMs: Date.now() - job.startedAt,
      }
    }
    this.recordTombstone(job, 'collected')
    return {
      kind: 'finished',
      jobId: job.id,
      exitCode: job.exitCode,
      signal: job.signal,
      stdout: out.text,
      stderr: err.text,
      truncated,
      elapsedMs: Date.now() - job.startedAt,
    }
  }

  disposeAll(): void {
    this.shutdown()
  }

  shutdown(): void {
    this.isShutdown = true
    for (const pid of this.localProcessGroups) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
      this.untrackProcessGroup?.(pid)
    }
    this.localProcessGroups.clear()

    for (const job of this.jobs.values()) {
      this.clearJobTimers(job)
      this.removeJobSnapshot(job)
      if (!job.closed) {
        job.killRequested = true
        killChildProcessGroup(job.child, 'SIGKILL')
        job.closed = true
        job.signal ??= 'SIGKILL'
        job.resolveClose()
      }
      try {
        job.child.stdout?.destroy()
        job.child.stderr?.destroy()
        job.child.unref()
      } catch {
        /* ignore */
      }
      job.stdout.clear()
      job.stderr.clear()
    }
    this.jobs.clear()
    this.cleanupSnapshotsSync()
  }
}
