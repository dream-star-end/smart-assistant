/**
 * Turn-scoped & lifecycle-governed job manager for Antigravity `oc_bash` (OCV5-789 / OCV5-908 P2-1).
 *
 * Powered by Layer 3 `ExecEnvJobRegistry` + `BoundedDeltaStreamBuffer` (`@openclaude/storage`):
 * - `ephemeral_turn` (default): turn-scoped command subject to `idleJobTtlMs` & `maxJobLifetimeMs`,
 *   reaped on turn handoff (`reapTurnJobs`) and graceful MCP disconnect (`shutdown({ preserveSurvivors: true })`).
 * - `managed_job`: survives brain switches and graceful MCP disconnects with MCP-independent
 *   file-backed stdio sinks (zero SIGPIPE/EPIPE); bounded by `maxJobLifetimeMs` (enforced by
 *   Gateway sweeper after disconnect) and bounded closed-result retention (W03).
 * - `daemon_service`: long-lived dev/preview service surviving brain switches & graceful MCP
 *   disconnects with MCP-independent stdio sinks and no max-lifetime expiration.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JobLifecycleClass, ManagedJobSummary } from '@openclaude/protocol'
import {
  ExecEnvJobRegistry,
  hasAliveVerifiedProcessGroup,
  leadingContinuationUtf8Count,
  parseProcStatFull,
  parseProcStatStartTimeTicks,
  registerDefaultSyncProcOps,
  sendVerifiedGroupSignal,
  trailingIncompleteUtf8Count,
  type ExecEnvJobClosedEvent,
  type ExecEnvJobStartResult,
  type ExecEnvJobStartedEvent,
  type ExecEnvMigrationTombstoneResult,
  type ExecEnvReapStopProof,
  type ExecEnvShutdownResult,
  type ParsedProcStat,
  type VerifyProcessGroupOps,
} from '@openclaude/storage'
import {
  CLOSE_DRAIN_SAFETY_MS,
  DeltaStreamBuffer,
  KILL_GRACE_MS,
  OC_BASH_HEAD_BYTES,
  OC_BASH_IDLE_JOB_TTL_MS,
  OC_BASH_MAX_ACTIVE_JOBS,
  OC_BASH_MAX_JOB_LIFETIME_MS,
  OC_BASH_MAX_OUTPUT_BYTES,
  OC_BASH_SNAPSHOT_PREVIEW_MAX_CHARS,
  OC_BASH_TAIL_BYTES,
  OC_BASH_TOMBSTONE_MAX,
  isJobLifecycleClass,
  killChildProcessGroup,
  makeCommandPreview,
  sanitizeEnvRecord,
  sanitizeOcBashCommandPreview,
  type JobTerminationReason,
  type JobTombstone,
  type JobTombstoneReason,
  type OcBashAction,
  type OcBashCallOutcome,
  type OcBashJobManagerOptions,
  type OcBashJobSnapshot,
} from './ocBashTypes.js'

export {
  CLOSE_DRAIN_SAFETY_MS,
  DeltaStreamBuffer,
  KILL_GRACE_MS,
  OC_BASH_HEAD_BYTES,
  OC_BASH_IDLE_JOB_TTL_MS,
  OC_BASH_MAX_ACTIVE_JOBS,
  OC_BASH_MAX_JOB_LIFETIME_MS,
  OC_BASH_MAX_OUTPUT_BYTES,
  OC_BASH_SNAPSHOT_PREVIEW_MAX_CHARS,
  OC_BASH_TAIL_BYTES,
  OC_BASH_TOMBSTONE_MAX,
  isJobLifecycleClass,
  killChildProcessGroup,
  leadingContinuationUtf8Count,
  parseProcStatStartTimeTicks,
  sanitizeOcBashCommandPreview,
  trailingIncompleteUtf8Count,
}
export type {
  JobTerminationReason,
  JobTombstone,
  JobTombstoneReason,
  OcBashAction,
  OcBashCallOutcome,
  OcBashJobManagerOptions,
  OcBashJobSnapshot,
}

const DAEMON_SNAPSHOT_HORIZON_MS = 365 * 24 * 60 * 60_000

function readLocalLinuxProcStat(pid: number): ParsedProcStat | null {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null
  try {
    return parseProcStatFull(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

function listLocalLinuxProcPids(): number[] {
  if (process.platform !== 'linux') return []
  try {
    const pids: number[] = []
    for (const name of readdirSync('/proc')) {
      if (!/^[1-9][0-9]*$/.test(name)) continue
      const pid = Number(name)
      if (Number.isSafeInteger(pid) && pid > 1) pids.push(pid)
    }
    return pids
  } catch {
    return []
  }
}

const LOCAL_PROC_OPS: VerifyProcessGroupOps = {
  readProcStat: readLocalLinuxProcStat,
  listProcPids: listLocalLinuxProcPids,
}
registerDefaultSyncProcOps(LOCAL_PROC_OPS)
export function readProcStartTimeTicks(pid: number): number | null {
  return readLocalLinuxProcStat(pid)?.startTimeTicks ?? null
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
 * Returns true if any live non-zombie process still belongs to verified process group `pgid`
 * with `starttime >= minStartTicks` (fails closed when `minStartTicks === null` or PID reused).
 */
export function hasAliveVerifiedGroupMembers(pgid: number, minStartTicks: number | null): boolean {
  if (process.platform !== 'linux' || !Number.isInteger(pgid) || pgid <= 1 || minStartTicks === null) {
    return false
  }
  try {
    process.kill(-pgid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') return false
  }
  return hasAliveVerifiedProcessGroup(pgid, minStartTicks, LOCAL_PROC_OPS)
}

interface ManagedBashJobMeta {
  id: string
  lifecycleClass: JobLifecycleClass
  commandPreview: string
  snapshotPreview: string
  cwd: string
  startedAt: number
  maxLifetimeAt: number
  pid: number | undefined
  pgid: number | undefined
  startTimeTicks: number | null
  snapshotPath: string | null
  stdoutLogPath?: string
  stderrLogPath?: string
  stdoutCursor: number
  stderrCursor: number
  closed: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  spawnError?: string
  yielded: boolean
  waiterInFlight: boolean
  terminationReason: JobTerminationReason | null
  idleTimer: NodeJS.Timeout | null
}

interface LingeringProcessGroup {
  readonly jobId: string
  readonly pgid: number
  readonly startTimeTicks: number | null
  readonly lifecycleClass: JobLifecycleClass
  readonly startedAt: number
  readonly commandPreview: string
  readonly snapshotPath: string | null
  readonly stdoutLogPath?: string
  readonly stderrLogPath?: string
}

function unlinkSafe(filePath: string | null | undefined): void {
  if (!filePath) return
  try {
    unlinkSync(filePath)
  } catch (err) {
    void err
  }
}

function unlinkRotatingLogPair(basePath: string | null | undefined): void {
  if (!basePath) return
  unlinkSafe(basePath)
  unlinkSafe(`${basePath}.1`)
}

export class OcBashJobManager {
  private readonly idleJobTtlMs: number
  private readonly maxJobLifetimeMs: number
  private readonly maxActiveJobs: number
  private readonly trackProcessGroup?: (pid: number) => void
  private readonly untrackProcessGroup?: (pid: number | undefined) => void
  private readonly registryDir: string | null
  private readonly sessionKeyOverride?: string
  private readonly env: NodeJS.ProcessEnv
  readonly leaseId: string
  private readonly defaultLifecycleClass: JobLifecycleClass
  readonly registry: ExecEnvJobRegistry

  private seq = 0
  private readonly jobs = new Map<string, ManagedBashJobMeta>()
  private readonly tombstones = new Map<string, JobTombstone>()
  /** B07: Tracks lingering sub-children in the same pgrp after the shell leader exits. */
  private readonly lingeringGroups = new Map<string, LingeringProcessGroup>()
  private readonly trackedSnapshotClass = new Map<string, JobLifecycleClass>()
  private isShutdown = false

  constructor(opts: OcBashJobManagerOptions = {}) {
    this.idleJobTtlMs = opts.idleJobTtlMs ?? OC_BASH_IDLE_JOB_TTL_MS
    this.maxJobLifetimeMs = opts.maxJobLifetimeMs ?? OC_BASH_MAX_JOB_LIFETIME_MS
    this.maxActiveJobs = opts.maxActiveJobs ?? OC_BASH_MAX_ACTIVE_JOBS
    this.trackProcessGroup = opts.trackProcessGroup
    this.untrackProcessGroup = opts.untrackProcessGroup
    this.env = opts.env ?? process.env
    this.sessionKeyOverride = opts.sessionKey
    this.leaseId = opts.leaseId?.trim() || `oc_bash_lease_${process.pid}`
    this.defaultLifecycleClass = opts.defaultLifecycleClass ?? 'ephemeral_turn'
    this.registryDir =
      opts.registryDir === undefined
        ? resolveOcBashRegistryDir(this.env)
        : opts.registryDir?.trim() || null

    this.registry = new ExecEnvJobRegistry({
      maxOutputBytes: opts.maxBytes ?? OC_BASH_MAX_OUTPUT_BYTES,
      killGraceMs: opts.killGraceMs ?? KILL_GRACE_MS,
      closeDrainSafetyMs: opts.closeDrainSafetyMs ?? CLOSE_DRAIN_SAFETY_MS,
      maxJobLifetimeMs: this.maxJobLifetimeMs,
      maxTombstones: OC_BASH_TOMBSTONE_MAX,
      defaultEnv: sanitizeEnvRecord(this.env),
      envId: opts.envId ?? `oc-bash-${process.pid}`,
      // F04: Pass explicit `null` when registryDir is disabled so managed_job/daemon_service
      // fail closed instead of falling back to an MCP-dependent pipe.
      survivableStdioDir: this.registryDir ? join(this.registryDir, 'logs') : null,
      verifyProcessGroupOps: LOCAL_PROC_OPS,
      ...(opts.maxLogFileBytes !== undefined ? { maxLogFileBytes: opts.maxLogFileBytes } : {}),
      onJobStarted: (ev) => this.handleRegistryJobStarted(ev),
      onJobClosed: (ev) => this.handleRegistryJobClosed(ev),
    })
  }

  private handleRegistryJobStarted(ev: ExecEnvJobStartedEvent): void {
    const meta = this.jobs.get(ev.jobId)
    if (!meta) return
    meta.pid = ev.pid
    meta.pgid = ev.pgid
    meta.startTimeTicks = ev.startTimeTicks
    if (ev.stdoutLogPath) meta.stdoutLogPath = ev.stdoutLogPath
    if (ev.stderrLogPath) meta.stderrLogPath = ev.stderrLogPath
    if (ev.pgid && ev.pgid > 0) {
      if (meta.lifecycleClass === 'ephemeral_turn') {
        this.trackProcessGroup?.(ev.pgid)
      }
      this.writeJobSnapshot(meta)
    }
  }

  private handleRegistryJobClosed(ev: ExecEnvJobClosedEvent): void {
    const meta = this.jobs.get(ev.jobId)
    if (!meta) return
    meta.closed = true
    meta.exitCode = ev.exitCode
    meta.signal = ev.signal as NodeJS.Signals | null
    if (ev.spawnError !== undefined) meta.spawnError = ev.spawnError
    if (ev.terminationCause === 'max_lifetime') {
      meta.terminationReason ??= 'max_lifetime'
    }

    const groupStillRunning =
      !ev.killRequested &&
      Boolean(ev.pgid && ev.pgid > 1) &&
      hasAliveVerifiedGroupMembers(ev.pgid!, ev.startTimeTicks)

    if (!groupStillRunning) {
      if (meta.pgid && meta.pgid > 0) {
        this.untrackProcessGroup?.(meta.pgid)
      }
      this.removeJobSnapshot(meta)
    } else if (ev.pgid && ev.pgid > 1) {
      // B07: Shell leader exited while verified descendants in the same process group are still alive.
      // Retain ownership in `lingeringGroups` so turn reap / disconnect / disposeAll reaps ephemeral
      // descendants cleanly while Gateway retains snapshot visibility.
      this.lingeringGroups.set(meta.id, {
        jobId: meta.id,
        pgid: ev.pgid,
        startTimeTicks: ev.startTimeTicks,
        lifecycleClass: meta.lifecycleClass,
        startedAt: meta.startedAt,
        commandPreview: meta.commandPreview,
        snapshotPath: meta.snapshotPath,
        stdoutLogPath: meta.stdoutLogPath,
        stderrLogPath: meta.stderrLogPath,
      })
      if (meta.lifecycleClass !== 'ephemeral_turn' && meta.snapshotPath) {
        this.trackedSnapshotClass.delete(meta.snapshotPath)
      }
    }

    if (!meta.waiterInFlight && meta.yielded) {
      if (meta.terminationReason === 'idle_timeout' || meta.terminationReason === 'max_lifetime') {
        this.recordTombstone(meta, meta.terminationReason)
      } else {
        // W03: Running managed/daemon jobs are exempt from idle kill, but once a yielded job has
        // naturally EXITED, bound unread result retention by `idleJobTtlMs` so closed buffers do not leak.
        this.armIdleTimer(meta, /* forClosedResult */ true)
      }
    }
  }

  private writeJobSnapshot(meta: ManagedBashJobMeta): void {
    if (!this.registryDir || meta.closed || this.isShutdown) return
    const pid = meta.pid
    if (!pid || pid <= 1) return
    if (meta.startTimeTicks === null) {
      meta.startTimeTicks = readProcStartTimeTicks(pid)
    }
    const now = Date.now()
    const { sessionKey, sessionId } = resolveOcBashSessionIdentity(this.env, this.sessionKeyOverride)
    const id = `${process.pid}-${meta.id}`
    const snapshot: OcBashJobSnapshot = {
      id,
      jobId: meta.id,
      pid,
      pgid: pid,
      ownerPid: process.pid,
      startTimeTicks: meta.startTimeTicks,
      sessionKey,
      sessionId,
      commandPreview: meta.snapshotPreview,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
      updatedAt: now,
      maxLifetimeAt: meta.maxLifetimeAt,
      lifecycleClass: meta.lifecycleClass,
      leaseId: this.leaseId,
      ...(meta.stdoutLogPath ? { stdoutLogPath: meta.stdoutLogPath } : {}),
      ...(meta.stderrLogPath ? { stderrLogPath: meta.stderrLogPath } : {}),
    }
    const targetPath = join(this.registryDir, `${id}.json`)
    const tmpPath = `${targetPath}.${randomBytes(6).toString('hex')}.tmp`
    try {
      mkdirSync(this.registryDir, { recursive: true })
      writeFileSync(tmpPath, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmpPath, targetPath)
      meta.snapshotPath = targetPath
      this.trackedSnapshotClass.set(targetPath, meta.lifecycleClass)
    } catch {
      unlinkSafe(tmpPath)
    }
  }

  private removeJobSnapshot(meta: ManagedBashJobMeta): void {
    const filePath =
      meta.snapshotPath ??
      (this.registryDir ? join(this.registryDir, `${process.pid}-${meta.id}.json`) : null)
    meta.snapshotPath = null
    if (!filePath) return
    this.trackedSnapshotClass.delete(filePath)
    unlinkSafe(filePath)
  }

  cleanupSnapshotsSync(opts?: { preserveSurvivors?: boolean }): void {
    const preserve = opts?.preserveSurvivors === true
    // A03: Never unlink snapshots belonging to still-live lingering groups whose stop is unconfirmed.
    const protectedSnapshots = new Set<string>()
    for (const group of this.lingeringGroups.values()) {
      if (group.snapshotPath) protectedSnapshots.add(group.snapshotPath)
    }
    for (const [filePath, lifecycleClass] of [...this.trackedSnapshotClass.entries()]) {
      if (preserve && lifecycleClass !== 'ephemeral_turn') continue
      if (protectedSnapshots.has(filePath)) continue
      unlinkSafe(filePath)
      this.trackedSnapshotClass.delete(filePath)
    }
  }

  /**
   * F06: Prune lingering process groups that have naturally exited (cleaning up their snapshot
   * and canonical rotating log files) while retaining slot reservation for groups still alive.
   */
  private refreshLingeringGroups(): void {
    for (const [jobId, group] of [...this.lingeringGroups.entries()]) {
      if (!hasAliveVerifiedGroupMembers(group.pgid, group.startTimeTicks)) {
        this.untrackProcessGroup?.(group.pgid)
        unlinkSafe(group.snapshotPath)
        unlinkRotatingLogPair(group.stdoutLogPath)
        unlinkRotatingLogPair(group.stderrLogPath)
        if (group.snapshotPath) this.trackedSnapshotClass.delete(group.snapshotPath)
        this.lingeringGroups.delete(jobId)
      }
    }
  }

  activeRunningCount(): number {
    this.refreshLingeringGroups()
    let count = 0
    for (const job of this.jobs.values()) {
      if (!job.closed) count += 1
    }
    // F06: Count verified live lingering process groups against the concurrency cap.
    for (const group of this.lingeringGroups.values()) {
      const meta = this.jobs.get(group.jobId)
      if (!meta || meta.closed) count += 1
    }
    return count
  }

  listActiveJobsSummary(): string[] {
    this.refreshLingeringGroups()
    const now = Date.now()
    const lines: string[] = []
    for (const job of this.jobs.values()) {
      if (job.closed) continue
      const elapsedSec = Math.max(0, Math.round((now - job.startedAt) / 1000))
      const classSuffix = job.lifecycleClass === 'ephemeral_turn' ? '' : ` [${job.lifecycleClass}]`
      lines.push(`- ${job.id} (${elapsedSec}s)${classSuffix}: ${job.commandPreview}`)
    }
    for (const group of this.lingeringGroups.values()) {
      const meta = this.jobs.get(group.jobId)
      if (meta && !meta.closed) continue
      const elapsedSec = Math.max(0, Math.round((now - group.startedAt) / 1000))
      const classSuffix = group.lifecycleClass === 'ephemeral_turn' ? '' : ` [${group.lifecycleClass}]`
      lines.push(`- ${group.jobId} (${elapsedSec}s)${classSuffix} [lingering]: ${group.commandPreview}`)
    }
    return lines
  }

  async listManagedJobs(): Promise<readonly ManagedJobSummary[]> {
    return await this.registry.listJobs(this.leaseId)
  }

  private reapLingeringGroupsSync(preserveSurvivors: boolean): string[] {
    const reaped: string[] = []
    for (const [jobId, group] of [...this.lingeringGroups.entries()]) {
      if (preserveSurvivors && group.lifecycleClass !== 'ephemeral_turn') {
        continue
      }
      const wasAlive = hasAliveVerifiedGroupMembers(group.pgid, group.startTimeTicks)
      const signaled = wasAlive
        ? sendVerifiedGroupSignal(group.pgid, null, group.startTimeTicks, 'SIGKILL', LOCAL_PROC_OPS)
        : false
      // A03: Separate "stop requested" from "stop confirmed". Only count as reaped and delete the
      // last recovery snapshot & rotating logs once verified group membership is confirmed empty.
      const stillAlive = hasAliveVerifiedGroupMembers(group.pgid, group.startTimeTicks)
      if (!stillAlive) {
        if (wasAlive && signaled) {
          reaped.push(jobId)
        }
        this.untrackProcessGroup?.(group.pgid)
        unlinkSafe(group.snapshotPath)
        unlinkRotatingLogPair(group.stdoutLogPath)
        unlinkRotatingLogPair(group.stderrLogPath)
        if (group.snapshotPath) this.trackedSnapshotClass.delete(group.snapshotPath)
        this.lingeringGroups.delete(jobId)
      }
    }
    return reaped
  }

  /**
   * Reap only `ephemeral_turn` jobs (and lingering ephemeral groups), provably preserving
   * `managed_job` and `daemon_service` jobs and their disk snapshots.
   */
  async reapTurnJobs(): Promise<ExecEnvReapStopProof> {
    const proof = await this.registry.reapByClass(this.leaseId, ['ephemeral_turn'])
    for (const jobId of proof.reapedJobIds) {
      const meta = this.jobs.get(jobId)
      if (meta) {
        this.recordTombstone(meta, 'killed')
      } else {
        this.registry.pruneJob(jobId)
      }
    }
    const lingeringReaped = this.reapLingeringGroupsSync(/* preserveSurvivors */ true)
    if (lingeringReaped.length === 0) return proof
    return {
      ...proof,
      activeJobsTerminated: proof.activeJobsTerminated + lingeringReaped.length,
      reapedJobIds: [...proof.reapedJobIds, ...lingeringReaped],
    }
  }

  async markEnvMigrated(reason: string): Promise<ExecEnvMigrationTombstoneResult> {
    const res = await this.registry.markEnvMigratedTombstones(this.leaseId, reason)
    for (const jobId of res.tombstonedJobIds) {
      const meta = this.jobs.get(jobId)
      if (meta) {
        this.clearIdleTimer(meta)
        this.removeJobSnapshot(meta)
        if (meta.pgid) {
          this.untrackProcessGroup?.(meta.pgid)
        }
        this.jobs.delete(jobId)
      }
    }
    this.reapLingeringGroupsSync(/* preserveSurvivors */ false)
    return res
  }

  private clearIdleTimer(meta: ManagedBashJobMeta): void {
    if (meta.idleTimer) {
      clearTimeout(meta.idleTimer)
      meta.idleTimer = null
    }
  }

  private armIdleTimer(meta: ManagedBashJobMeta, forClosedResult = false): void {
    this.clearIdleTimer(meta)
    if (this.isShutdown) return
    if (!forClosedResult && meta.lifecycleClass !== 'ephemeral_turn') return
    meta.idleTimer = setTimeout(() => {
      meta.idleTimer = null
      if (meta.waiterInFlight || this.isShutdown) return
      if (meta.closed) {
        this.recordTombstone(meta, 'collected')
        return
      }
      if (meta.lifecycleClass !== 'ephemeral_turn') return
      meta.terminationReason ??= 'idle_timeout'
      void this.registry.killJob(meta.id, 'SIGTERM').catch(() => {})
    }, this.idleJobTtlMs)
    meta.idleTimer.unref()
  }

  private recordTombstone(meta: ManagedBashJobMeta, reason: JobTombstoneReason): void {
    this.clearIdleTimer(meta)
    const hasLingering = this.lingeringGroups.has(meta.id)
    if (!hasLingering) {
      this.removeJobSnapshot(meta)
    }
    this.jobs.delete(meta.id)
    // F06: Preserve canonical rotating logs while lingering descendants in the same process group are alive.
    this.registry.pruneJob(meta.id, { preserveLogs: hasLingering })
    if (!meta.yielded) return
    if (this.tombstones.has(meta.id)) this.tombstones.delete(meta.id)
    this.tombstones.set(meta.id, {
      jobId: meta.id,
      exitCode: meta.exitCode,
      signal: meta.signal,
      reason,
      elapsedMs: Date.now() - meta.startedAt,
      commandPreview: meta.commandPreview,
    })
    while (this.tombstones.size > OC_BASH_TOMBSTONE_MAX) {
      const oldestKey = this.tombstones.keys().next().value
      if (oldestKey === undefined) break
      this.tombstones.delete(oldestKey)
    }
  }

  async startAndWait(spec: {
    command: string
    cwd?: string
    timeoutMs: number
    killOnTimeout?: boolean
    lifecycleClass?: JobLifecycleClass
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

    const jobId = `ocb_${++this.seq}`
    const lifecycleClass: JobLifecycleClass = spec.lifecycleClass ?? this.defaultLifecycleClass
    const startedAt = Date.now()
    const { sessionKey } = resolveOcBashSessionIdentity(this.env, this.sessionKeyOverride)
    const meta: ManagedBashJobMeta = {
      id: jobId,
      lifecycleClass,
      commandPreview: makeCommandPreview(spec.command),
      snapshotPreview: sanitizeOcBashCommandPreview(spec.command),
      cwd: spec.cwd ?? process.cwd(),
      startedAt,
      maxLifetimeAt:
        lifecycleClass === 'daemon_service'
          ? startedAt + DAEMON_SNAPSHOT_HORIZON_MS
          : startedAt + this.maxJobLifetimeMs,
      pid: undefined,
      pgid: undefined,
      startTimeTicks: null,
      snapshotPath: null,
      stdoutCursor: 0,
      stderrCursor: 0,
      closed: false,
      exitCode: null,
      signal: null,
      yielded: false,
      waiterInFlight: true,
      terminationReason: null,
      idleTimer: null,
    }
    this.jobs.set(jobId, meta)

    let res: ExecEnvJobStartResult
    try {
      res = await this.registry.startJob({
        jobId,
        leaseId: this.leaseId,
        sessionKey: sessionKey || undefined,
        lifecycleClass,
        label: meta.commandPreview,
        command: ['/bin/bash', '-lc', spec.command],
        cwd: spec.cwd,
        env: {
          ...sanitizeEnvRecord(this.env),
          OC_BASH_TIMEOUT_MS: String(spec.timeoutMs),
        },
        yieldAfterMs: spec.timeoutMs,
        killOnTimeout: spec.killOnTimeout,
        maxLifetimeMs: lifecycleClass === 'daemon_service' ? undefined : this.maxJobLifetimeMs,
      })
    } catch (err) {
      this.clearIdleTimer(meta)
      this.removeJobSnapshot(meta)
      this.jobs.delete(jobId)
      return {
        kind: 'spawn_error',
        error: err instanceof Error ? err.message : String(err),
      }
    }

    if (res.status !== 'running') {
      return this.formatFinishedStartOutcome(meta, res, spec.timeoutMs)
    }

    meta.yielded = true
    meta.waiterInFlight = false
    meta.stdoutCursor = res.nextStdoutCursor
    meta.stderrCursor = res.nextStderrCursor
    this.writeJobSnapshot(meta)
    this.armIdleTimer(meta)
    return {
      kind: 'running',
      jobId,
      elapsedMs: res.durationMs,
      stdout: res.stdout,
      stderr: res.stderr,
      truncated: res.truncated,
      lifecycleClass: meta.lifecycleClass,
    }
  }

  private formatFinishedStartOutcome(
    meta: ManagedBashJobMeta,
    res: ExecEnvJobStartResult,
    timeoutMs: number,
  ): OcBashCallOutcome {
    meta.waiterInFlight = false
    this.clearIdleTimer(meta)
    this.jobs.delete(meta.id)
    // F06: Preserve canonical rotating logs while lingering descendants in the same process group are alive.
    this.registry.pruneJob(meta.id, { preserveLogs: this.lingeringGroups.has(meta.id) })
    if (res.status === 'failed' && res.spawnError && meta.terminationReason === null) {
      return { kind: 'spawn_error', error: res.spawnError }
    }
    if (res.terminationCause === 'yield_timeout') {
      return {
        kind: 'hard_timeout',
        timeoutMs,
        exitCode: res.exitCode,
        signal: res.signal as NodeJS.Signals | null,
        stdout: res.stdout,
        stderr: res.stderr,
        truncated: res.truncated,
      }
    }
    if (res.terminationCause === 'max_lifetime' || meta.terminationReason === 'max_lifetime') {
      return {
        kind: 'terminated',
        jobId: meta.id,
        reason: 'max_lifetime',
        exitCode: res.exitCode,
        signal: res.signal as NodeJS.Signals | null,
        stdout: res.stdout,
        stderr: res.stderr,
        truncated: res.truncated,
        elapsedMs: res.durationMs,
      }
    }
    return {
      kind: 'finished',
      jobId: meta.id,
      exitCode: res.exitCode,
      signal: res.signal as NodeJS.Signals | null,
      stdout: res.stdout,
      stderr: res.stderr,
      truncated: res.truncated,
      elapsedMs: res.durationMs,
    }
  }

  async continueJob(spec: {
    jobId: string
    action: OcBashAction
    timeoutMs: number
    killOnTimeout?: boolean
  }): Promise<OcBashCallOutcome> {
    const meta = this.jobs.get(spec.jobId)
    if (!meta) return await this.resolveMissingJobOutcome(spec.jobId)
    if (meta.waiterInFlight) return { kind: 'busy', jobId: spec.jobId }

    // W02: Serialize ALL cursor-consuming / terminal-collecting operations under `waiterInFlight`.
    this.clearIdleTimer(meta)
    meta.waiterInFlight = true
    try {
      return await this.runContinueAction(meta, spec)
    } finally {
      meta.waiterInFlight = false
    }
  }

  private async resolveMissingJobOutcome(jobId: string): Promise<OcBashCallOutcome> {
    if (this.registry.hasMigratedTombstone(jobId)) {
      const migrated = await this.registry.waitJob(jobId, { leaseId: this.leaseId, action: 'status' })
      return {
        kind: 'tombstone',
        tombstone: {
          jobId,
          exitCode: null,
          signal: null,
          reason: 'env_migrated',
          elapsedMs: migrated.durationMs,
          commandPreview: migrated.tombstoneReason ?? 'env_migrated',
        },
      }
    }
    const tombstone = this.tombstones.get(jobId)
    return tombstone ? { kind: 'tombstone', tombstone } : { kind: 'not_found', jobId }
  }

  private async runContinueAction(
    meta: ManagedBashJobMeta,
    spec: { jobId: string; action: OcBashAction; timeoutMs: number; killOnTimeout?: boolean },
  ): Promise<OcBashCallOutcome> {
    if (
      !meta.closed &&
      (meta.terminationReason === 'idle_timeout' || meta.terminationReason === 'max_lifetime')
    ) {
      const reason = meta.terminationReason
      const res = await this.registry.waitJob(spec.jobId, {
        leaseId: this.leaseId,
        action: 'wait',
        stdoutCursor: meta.stdoutCursor,
        stderrCursor: meta.stderrCursor,
      })
      this.recordTombstone(meta, reason)
      return {
        kind: 'terminated',
        jobId: meta.id,
        reason,
        exitCode: res.exitCode,
        signal: res.signal as NodeJS.Signals | null,
        stdout: res.stdout,
        stderr: res.stderr,
        truncated: res.truncated,
        elapsedMs: res.durationMs,
      }
    }

    if (spec.action === 'kill') {
      meta.terminationReason ??= 'killed'
      const res = await this.registry.waitJob(spec.jobId, {
        leaseId: this.leaseId,
        action: 'kill',
        stdoutCursor: meta.stdoutCursor,
        stderrCursor: meta.stderrCursor,
      })
      this.recordTombstone(meta, 'killed')
      return {
        kind: 'killed',
        jobId: meta.id,
        exitCode: res.exitCode,
        signal: res.signal as NodeJS.Signals | null,
        stdout: res.stdout,
        stderr: res.stderr,
        truncated: res.truncated,
        elapsedMs: res.durationMs,
      }
    }

    if (meta.closed) return await this.collectClosedJob(meta)

    const startStdoutCursor = meta.stdoutCursor
    const startStderrCursor = meta.stderrCursor
    const res = await this.registry.waitJob(spec.jobId, {
      leaseId: this.leaseId,
      action: spec.action,
      ...(spec.action === 'wait' ? { timeoutMs: spec.timeoutMs } : {}),
      stdoutCursor: startStdoutCursor,
      stderrCursor: startStderrCursor,
    })
    if (res.status === 'terminated_env_migrated') {
      return this.toEnvMigratedOutcome(meta, res.durationMs, res.tombstoneReason)
    }
    if (res.status !== 'running') return this.finalizeCollectedResult(meta, res)
    if (spec.action === 'wait' && spec.killOnTimeout) {
      meta.terminationReason = 'hard_timeout'
      const killed = await this.registry.waitJob(spec.jobId, {
        leaseId: this.leaseId,
        action: 'kill',
        stdoutCursor: startStdoutCursor,
        stderrCursor: startStderrCursor,
      })
      this.recordTombstone(meta, 'killed')
      return {
        kind: 'hard_timeout',
        timeoutMs: spec.timeoutMs,
        exitCode: killed.exitCode,
        signal: killed.signal as NodeJS.Signals | null,
        stdout: killed.stdout,
        stderr: killed.stderr,
        truncated: killed.truncated,
      }
    }

    meta.stdoutCursor = res.nextStdoutCursor
    meta.stderrCursor = res.nextStderrCursor
    this.writeJobSnapshot(meta)
    this.armIdleTimer(meta)
    return {
      kind: 'running',
      jobId: meta.id,
      elapsedMs: res.durationMs,
      stdout: res.stdout,
      stderr: res.stderr,
      truncated: res.truncated,
      lifecycleClass: meta.lifecycleClass,
    }
  }

  private toEnvMigratedOutcome(
    meta: ManagedBashJobMeta,
    durationMs: number,
    reason?: string,
  ): OcBashCallOutcome {
    this.clearIdleTimer(meta)
    this.removeJobSnapshot(meta)
    this.jobs.delete(meta.id)
    return {
      kind: 'tombstone',
      tombstone: {
        jobId: meta.id,
        exitCode: null,
        signal: null,
        reason: 'env_migrated',
        elapsedMs: durationMs,
        commandPreview: reason ?? meta.commandPreview,
      },
    }
  }

  private async collectClosedJob(meta: ManagedBashJobMeta): Promise<OcBashCallOutcome> {
    const res = await this.registry.waitJob(meta.id, {
      leaseId: this.leaseId,
      action: 'status',
      stdoutCursor: meta.stdoutCursor,
      stderrCursor: meta.stderrCursor,
    })
    return this.finalizeCollectedResult(meta, res)
  }

  private finalizeCollectedResult(
    meta: ManagedBashJobMeta,
    res: {
      exitCode: number | null
      signal: string | null
      stdout: string
      stderr: string
      truncated: boolean
      durationMs: number
      terminationCause?: string
    },
  ): OcBashCallOutcome {
    this.clearIdleTimer(meta)
    const reason =
      meta.terminationReason ??
      (res.terminationCause === 'max_lifetime' ? 'max_lifetime' : null)
    if (reason === 'idle_timeout' || reason === 'max_lifetime') {
      this.recordTombstone(meta, reason)
      return {
        kind: 'terminated',
        jobId: meta.id,
        reason,
        exitCode: res.exitCode,
        signal: res.signal as NodeJS.Signals | null,
        stdout: res.stdout,
        stderr: res.stderr,
        truncated: res.truncated,
        elapsedMs: res.durationMs,
      }
    }
    this.recordTombstone(meta, 'collected')
    return {
      kind: 'finished',
      jobId: meta.id,
      exitCode: res.exitCode,
      signal: res.signal as NodeJS.Signals | null,
      stdout: res.stdout,
      stderr: res.stderr,
      truncated: res.truncated,
      elapsedMs: res.durationMs,
    }
  }

  disposeAll(): void {
    this.shutdown({ preserveSurvivors: false })
  }

  /**
   * Shutdown this job manager using verified process-group signals (W04).
   * - `preserveSurvivors: false` (default, e.g. `disposeAll` / test teardown): reaps every
   *   active job and lingering group and removes all snapshots.
   * - `preserveSurvivors: true` (MCP stdin disconnect / graceful brain switch): reaps only
   *   `ephemeral_turn` jobs & lingering ephemeral groups while leaving `managed_job` and
   *   `daemon_service` process groups (with intact file-backed stdio) and snapshots alive.
   */
  shutdown(opts?: { preserveSurvivors?: boolean }): ExecEnvShutdownResult {
    const preserve = opts?.preserveSurvivors === true
    this.isShutdown = true

    const result = this.registry.shutdownSync(
      preserve ? { preserveClasses: ['managed_job', 'daemon_service'] } : undefined,
    )
    const lingeringReaped = this.reapLingeringGroupsSync(preserve)

    for (const meta of this.jobs.values()) {
      this.clearIdleTimer(meta)
      if (meta.pgid && (!preserve || meta.lifecycleClass === 'ephemeral_turn')) {
        this.untrackProcessGroup?.(meta.pgid)
      }
      if (!preserve || meta.lifecycleClass === 'ephemeral_turn') {
        if (!this.lingeringGroups.has(meta.id)) {
          this.removeJobSnapshot(meta)
        }
      }
    }
    this.jobs.clear()
    this.cleanupSnapshotsSync({ preserveSurvivors: preserve })
    return {
      reapedJobIds: [...result.reapedJobIds, ...lingeringReaped],
      preservedJobIds: result.preservedJobIds,
    }
  }
}
