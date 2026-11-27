/**
 * OCV5-890 / OCV5-908 Layer 3 — Execution Environment persistent JobRegistry (`ProcessJobSeam`).
 *
 * Shared L2 implementation in `@openclaude/storage` used by both `@openclaude/gateway` and
 * `@openclaude/mcp-memory` (`oc_bash`), surviving brain switches and inference lane recycles.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex, Writable } from 'node:stream'
import type {
  ExecEnvStopProof,
  JobLifecycleClass,
  JobOutcome,
  JobOutputDelta,
  ManagedJobSummary,
  ProcessJobSeam,
} from '@openclaude/protocol'
import {
  assignJobTerminalState,
  buildJobClosedEvent,
  buildJobStartResult,
  buildJobStartedEvent,
  buildJobWaitResult,
  buildManagedJobSummary,
  cancelPendingStarts,
  cleanupAbortedStartAsync,
  cleanupPendingStartSync,
  clearInternalJobTimers,
  clearJobBuffers,
  computeReapProofDigest,
  createManagedJobRecord,
  createPendingStartSlot,
  destroyChildStreamsAndUnref,
  formatMigratedTombstone,
  stopManagedJobGroupSync,
  unrefPreservedChild,
  type DeltaRingEntry,
  type EnvMigratedTombstone,
  type ExecEnvJobClosedEvent,
  type ExecEnvJobRegistryOptions,
  type ExecEnvJobStartResult,
  type ExecEnvJobStartedEvent,
  type ExecEnvMigrationTombstoneResult,
  type ExecEnvReapStopProof,
  type ExecEnvShutdownResult,
  type ExecEnvStartJobSpec,
  type ExecEnvWaitJobAction,
  type ExecEnvWaitJobResult,
  type InternalManagedJob,
  type PendingStartSlot,
  type WaitJobOptions,
} from './execEnvJobHelpers.js'
import {
  EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS,
  EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS,
  EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS,
  EXEC_ENV_JOB_DEFAULT_TOMBSTONE_MAX,
  EXEC_ENV_JOB_HEAD_BYTES,
  EXEC_ENV_JOB_MAX_OUTPUT_BYTES,
  ExecEnvJobError,
  clipUtf8Tail,
  sendVerifiedGroupSignalAsync,
  type VerifyProcessGroupOps,
} from './execEnvProcInspect.js'
import {
  EXEC_ENV_JOB_DEFAULT_MAX_LOG_FILE_BYTES,
  EXEC_ENV_JOB_MIN_LOG_FILE_BYTES,
  SINK_FLUSH_WAIT_MS,
  destroySinkParentPipes,
  pumpLogReaderAsync,
  scheduleUnlinkRotatingLogPair,
  setupSurvivableLogSink,
  unlinkRotatingLogPairAsync,
  type SurvivableSinkSetup,
} from './execEnvSurvivableSink.js'

export { BoundedDeltaStreamBuffer, ExecEnvJobError, EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS, EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS, EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS, EXEC_ENV_JOB_DEFAULT_TOMBSTONE_MAX, EXEC_ENV_JOB_HEAD_BYTES, EXEC_ENV_JOB_MAX_OUTPUT_BYTES, EXEC_ENV_JOB_TAIL_BYTES, hasAliveVerifiedProcessGroup, hasAliveVerifiedProcessGroupAsync, leadingContinuationUtf8Count, parseProcStatFull, parseProcStatStartTimeTicks, readProcStartTimeTicksAsync, registerDefaultSyncProcOps, sendVerifiedGroupSignal, sendVerifiedGroupSignalAsync, trailingIncompleteUtf8Count } from './execEnvProcInspect.js'
export { EXEC_ENV_JOB_DEFAULT_MAX_LOG_FILE_BYTES }
export type { BoundedDeltaReadResult, BoundedDeltaStreamBufferOptions, ExecEnvJobErrorCode, ExecEnvJobTerminationCause, ParsedProcStat, VerifyProcessGroupOps } from './execEnvProcInspect.js'
export type { ExecEnvJobClosedEvent, ExecEnvJobRegistryOptions, ExecEnvJobStartResult, ExecEnvJobStartedEvent, ExecEnvMigrationTombstoneResult, ExecEnvReapStopProof, ExecEnvShutdownResult, ExecEnvStartJobSpec, ExecEnvWaitJobAction, ExecEnvWaitJobResult, WaitJobOptions }

const MAX_DELTA_RING_ENTRIES = 1024
const LOG_PUMP_INTERVAL_MS = 40
const DEFAULT_SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export class ExecEnvJobRegistry implements ProcessJobSeam {
  private readonly maxOutputBytes: number
  private readonly headOutputBytes: number
  private readonly killGraceMs: number
  private readonly closeDrainSafetyMs: number
  private readonly maxJobLifetimeMs: number
  private readonly maxTombstones: number
  private readonly defaultCwd: string
  private readonly defaultEnv: Readonly<Record<string, string>>
  private readonly envId: string
  private readonly clock: () => number
  private readonly survivableStdioDir: string | null
  private readonly maxLogFileBytes: number
  private readonly readStartTimeTicks?: (pid: number) => Promise<number | null>
  private readonly verifyProcessGroupOps?: VerifyProcessGroupOps
  private readonly onJobStarted?: (event: ExecEnvJobStartedEvent) => void
  private readonly onJobClosed?: (event: ExecEnvJobClosedEvent) => void

  private readonly jobs = new Map<string, InternalManagedJob>()
  private readonly pendingStarts = new Map<string, PendingStartSlot>()
  private readonly migratedTombstones = new Map<string, EnvMigratedTombstone>()
  private disposed = false

  constructor(opts: ExecEnvJobRegistryOptions = {}) {
    this.maxOutputBytes = opts.maxOutputBytes ?? EXEC_ENV_JOB_MAX_OUTPUT_BYTES
    this.headOutputBytes =
      opts.headOutputBytes ?? Math.min(EXEC_ENV_JOB_HEAD_BYTES, Math.floor(this.maxOutputBytes / 3))
    this.killGraceMs = opts.killGraceMs ?? EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS
    this.closeDrainSafetyMs = opts.closeDrainSafetyMs ?? EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS
    this.maxJobLifetimeMs = opts.maxJobLifetimeMs ?? EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS
    this.maxTombstones = opts.maxTombstones ?? EXEC_ENV_JOB_DEFAULT_TOMBSTONE_MAX
    this.defaultCwd = opts.defaultCwd ?? process.cwd()
    this.defaultEnv = opts.defaultEnv ?? { PATH: DEFAULT_SAFE_PATH }
    this.envId = opts.envId ?? 'exec-env-local'
    this.clock = opts.clock ?? (() => Date.now())
    this.survivableStdioDir =
      opts.survivableStdioDir === undefined ? join(tmpdir(), 'oc-exec-env-logs') : opts.survivableStdioDir
    this.maxLogFileBytes = Math.max(
      EXEC_ENV_JOB_MIN_LOG_FILE_BYTES,
      Math.floor(opts.maxLogFileBytes ?? EXEC_ENV_JOB_DEFAULT_MAX_LOG_FILE_BYTES),
    )
    this.readStartTimeTicks = opts.readStartTimeTicks
    this.verifyProcessGroupOps = opts.verifyProcessGroupOps
    this.onJobStarted = opts.onJobStarted
    this.onJobClosed = opts.onJobClosed
  }

  getDeltaRingStats(jobId: string): { entries: number; bytes: number } | null {
    const job = this.jobs.get(jobId)
    return job ? { entries: job.deltaRing.length, bytes: job.deltaRingBytes } : null
  }

  async startJob(spec: ExecEnvStartJobSpec): Promise<ExecEnvJobStartResult> {
    this.assertCanStart(spec)
    const jobId = spec.jobId ?? `job_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    if (this.jobs.has(jobId) || this.pendingStarts.has(jobId)) {
      throw new ExecEnvJobError('EXEC_JOB_DUPLICATE_ID', `Job ${jobId} already exists`)
    }
    const slot = createPendingStartSlot(jobId, spec)
    this.pendingStarts.set(jobId, slot)
    let job: InternalManagedJob
    try {
      job = await this.launchPendingJob(jobId, spec, slot)
    } finally {
      this.pendingStarts.delete(jobId)
      slot.resolveSettled()
    }
    await this.awaitInitialYield(job, spec)
    await this.pumpLogFiles(job)
    return buildJobStartResult(job, this.clock())
  }

  private async launchPendingJob(
    jobId: string,
    spec: ExecEnvStartJobSpec,
    slot: PendingStartSlot,
  ): Promise<InternalManagedJob> {
    const sink = await this.maybeSetupSink(jobId, spec)
    slot.sink = sink
    if (this.disposed || slot.cancelled) {
      await cleanupAbortedStartAsync({ sink })
      throw new ExecEnvJobError('EXEC_JOB_REGISTRY_DISPOSED', slot.cancelReason ?? 'Job start cancelled')
    }
    const cwd = spec.cwd ?? this.defaultCwd
    const child = await this.spawnChildForJob(spec, cwd, sink)
    slot.child = child
    if (this.disposed || slot.cancelled) {
      await cleanupAbortedStartAsync({ sink, child })
      throw new ExecEnvJobError('EXEC_JOB_REGISTRY_DISPOSED', slot.cancelReason ?? 'Job start cancelled')
    }
    // Attach listeners synchronously BEFORE any await so fast-exiting children never miss `close`,
    // while keeping `job` on `slot` so `shutdownSync` can kill spawned resources immediately even if
    // the parent process exits before `ticksReady` resolves.
    const job = createManagedJobRecord({
      jobId,
      spec,
      cwd,
      child,
      sink,
      startedAtMs: this.clock(),
      maxOutputBytes: this.maxOutputBytes,
      headOutputBytes: this.headOutputBytes,
      readStartTimeTicks: this.readStartTimeTicks,
    })
    slot.job = job
    this.attachChildListeners(job)
    await job.ticksReady
    if (this.disposed || slot.cancelled) {
      await cleanupAbortedStartAsync({ sink, job })
      throw new ExecEnvJobError('EXEC_JOB_REGISTRY_DISPOSED', slot.cancelReason ?? 'Job start cancelled')
    }
    this.jobs.set(jobId, job)
    this.observeAndArmJob(job, spec)
    return job
  }

  private assertCanStart(spec: ExecEnvStartJobSpec): void {
    if (this.disposed) {
      throw new ExecEnvJobError('EXEC_JOB_REGISTRY_DISPOSED', 'ExecEnvJobRegistry has been disposed')
    }
    if (!Array.isArray(spec.command) || spec.command.length === 0 || !spec.command[0]) {
      throw new ExecEnvJobError('EXEC_JOB_COMMAND_EMPTY', 'StartJobSpec.command must be non-empty')
    }
  }

  private async maybeSetupSink(
    jobId: string,
    spec: ExecEnvStartJobSpec,
  ): Promise<SurvivableSinkSetup | null> {
    if (spec.lifecycleClass === 'ephemeral_turn') return null
    const stdioDir =
      spec.survivableStdioDir !== undefined ? spec.survivableStdioDir : this.survivableStdioDir
    return await setupSurvivableLogSink({
      jobId,
      lifecycleClass: spec.lifecycleClass,
      stdioDir,
      maxLogFileBytes: this.maxLogFileBytes,
    })
  }

  private async spawnChildForJob(
    spec: ExecEnvStartJobSpec,
    cwd: string,
    sink: SurvivableSinkSetup | null,
  ): Promise<ChildProcess> {
    const [cmd, ...args] = spec.command
    const spawnEnv: Record<string, string> = { ...this.defaultEnv, ...(spec.env ?? {}) }
    const childStdio: ['ignore', 'pipe' | Writable, 'pipe' | Duplex] = sink
      ? ['ignore', sink.sinkProcess.stdio[0] as Writable, sink.sinkProcess.stdio[3] as Duplex]
      : ['ignore', 'pipe', 'pipe']
    try {
      const child = spawn(cmd!, args, { cwd, detached: true, stdio: childStdio, env: spawnEnv })
      destroySinkParentPipes(sink?.sinkProcess)
      return child
    } catch (err) {
      if (sink) await cleanupAbortedStartAsync({ sink })
      throw err
    }
  }

  private observeAndArmJob(job: InternalManagedJob, spec: ExecEnvStartJobSpec): void {
    if (job.survivableSinkAttached && !job.closed) {
      job.logPumpTimer = setInterval(() => {
        void this.pumpLogFiles(job)
      }, LOG_PUMP_INTERVAL_MS)
      job.logPumpTimer.unref()
    }
    try {
      job.startedNotified = true
      this.onJobStarted?.(buildJobStartedEvent(job))
    } catch (err) {
      void err
    }
    const effectiveLifetimeMs =
      spec.maxLifetimeMs ??
      (spec.lifecycleClass === 'daemon_service' ? undefined : (spec.timeoutMs ?? this.maxJobLifetimeMs))
    if (!job.closed && effectiveLifetimeMs !== undefined && effectiveLifetimeMs > 0) {
      job.lifetimeTimer = setTimeout(() => {
        job.lifetimeTimer = null
        if (job.closed || this.disposed) return
        job.forcedState ??= 'timed_out'
        job.terminationCause ??= 'max_lifetime'
        this.terminateJobGroup(job, 'SIGTERM')
      }, effectiveLifetimeMs)
      job.lifetimeTimer.unref()
    }
  }

  private async awaitInitialYield(job: InternalManagedJob, spec: ExecEnvStartJobSpec): Promise<void> {
    if (spec.yieldAfterMs === undefined || spec.yieldAfterMs < 0) return
    await this.waitCloseOrTimeout(job, spec.yieldAfterMs)
    if (!job.closed && spec.killOnTimeout) {
      job.forcedState = 'timed_out'
      job.terminationCause = 'yield_timeout'
      this.terminateJobGroup(job, 'SIGTERM')
      await job.closePromise
    }
  }

  async *streamOutput(jobId: string, sinceSeq = 0): AsyncIterable<JobOutputDelta> {
    const job = this.jobs.get(jobId)
    if (!job) throw new ExecEnvJobError('EXEC_JOB_NOT_FOUND', `Job ${jobId} not found`)
    let lastSeq = Math.max(0, Math.floor(sinceSeq))
    while (true) {
      await this.pumpLogFiles(job)
      let emitted = false
      for (const entry of job.deltaRing) {
        if (entry.delta.seq > lastSeq) {
          lastSeq = entry.delta.seq
          emitted = true
          yield entry.delta
        }
      }
      if (job.closed) {
        await this.pumpLogFiles(job)
        for (const entry of job.deltaRing) {
          if (entry.delta.seq > lastSeq) {
            lastSeq = entry.delta.seq
            yield entry.delta
          }
        }
        return
      }
      if (!emitted) {
        await new Promise<void>((resolve) => {
          const wakeup = () => {
            job.deltaWaiters.delete(wakeup)
            resolve()
          }
          job.deltaWaiters.add(wakeup)
        })
      }
    }
  }

  waitJob(jobId: string): Promise<JobOutcome>
  waitJob(jobId: string, opts: WaitJobOptions): Promise<ExecEnvWaitJobResult>
  async waitJob(jobId: string, opts?: WaitJobOptions): Promise<JobOutcome | ExecEnvWaitJobResult> {
    const tombstone = this.migratedTombstones.get(jobId)
    if (tombstone) {
      if (opts && tombstone.leaseId !== opts.leaseId) {
        throw new ExecEnvJobError('EXEC_JOB_LEASE_MISMATCH', `Job ${jobId} does not belong to lease ${opts.leaseId}`)
      }
      return formatMigratedTombstone(tombstone, opts)
    }
    const job = this.jobs.get(jobId)
    if (!job) throw new ExecEnvJobError('EXEC_JOB_NOT_FOUND', `Job ${jobId} not found`)
    if (!opts) return await this.waitJobSimpleOutcome(job)
    if (job.leaseId !== opts.leaseId) {
      throw new ExecEnvJobError('EXEC_JOB_LEASE_MISMATCH', `Job ${jobId} does not belong to lease ${opts.leaseId}`)
    }
    await this.runWaitAction(job, opts)
    const migratedNow = this.migratedTombstones.get(jobId)
    if (migratedNow) return formatMigratedTombstone(migratedNow, opts) as ExecEnvWaitJobResult
    await this.pumpLogFiles(job)
    return buildJobWaitResult(job, opts, this.clock())
  }

  private async waitJobSimpleOutcome(job: InternalManagedJob): Promise<JobOutcome> {
    await job.closePromise
    return {
      jobId: job.jobId,
      status: job.state === 'running' ? 'failed' : job.state,
      exitCode: job.exitCode,
      signal: job.signal,
      durationMs: Math.max(0, (job.finishedAtMs ?? this.clock()) - job.startedAtMs),
      finishedAt: job.finishedAt ?? new Date(this.clock()).toISOString(),
    }
  }

  private async runWaitAction(job: InternalManagedJob, opts: WaitJobOptions): Promise<void> {
    const action: ExecEnvWaitJobAction = opts.action ?? 'wait'
    if (action === 'kill') {
      if (!job.closed) {
        job.forcedState ??= 'killed'
        job.terminationCause ??= 'killed'
        this.terminateJobGroup(job, 'SIGTERM')
        await job.closePromise
      }
      return
    }
    if (action === 'wait' && !job.closed) {
      if (opts.timeoutMs !== undefined && opts.timeoutMs >= 0) {
        await this.waitCloseOrTimeout(job, opts.timeoutMs)
      } else {
        await job.closePromise
      }
    }
  }

  async killJob(jobId: string, signal: NodeJS.Signals | string = 'SIGTERM'): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (!job || job.closed) return false
    job.forcedState ??= 'killed'
    job.terminationCause ??= 'killed'
    this.terminateJobGroup(job, signal as NodeJS.Signals)
    await job.closePromise
    return true
  }

  pruneJob(jobId: string, opts?: { preserveLogs?: boolean }): boolean {
    const job = this.jobs.get(jobId)
    if (!job || !job.closed) return false
    this.clearJobTimers(job)
    clearJobBuffers(job)
    if (!opts?.preserveLogs) {
      scheduleUnlinkRotatingLogPair(job.stdoutLogPath)
      scheduleUnlinkRotatingLogPair(job.stderrLogPath)
    }
    this.jobs.delete(jobId)
    return true
  }

  hasMigratedTombstone(jobId: string): boolean {
    return this.migratedTombstones.has(jobId)
  }

  listJobs(leaseId: string): Promise<readonly ManagedJobSummary[]>
  listJobs(filter: { leaseId: string; sessionKey?: string }): Promise<readonly ManagedJobSummary[]>
  async listJobs(
    leaseIdOrFilter: string | { leaseId: string; sessionKey?: string },
  ): Promise<readonly ManagedJobSummary[]> {
    const leaseId = typeof leaseIdOrFilter === 'string' ? leaseIdOrFilter : leaseIdOrFilter.leaseId
    const sessionKey = typeof leaseIdOrFilter === 'string' ? undefined : leaseIdOrFilter.sessionKey
    const results: ManagedJobSummary[] = []
    for (const job of this.jobs.values()) {
      if (job.leaseId !== leaseId) continue
      if (sessionKey !== undefined && job.sessionKey !== sessionKey) continue
      results.push(buildManagedJobSummary(job))
    }
    return results
  }

  async reapByClass(
    leaseId: string,
    classes: readonly JobLifecycleClass[],
    opts?: { reason?: ExecEnvStopProof['reason']; envId?: string },
  ): Promise<ExecEnvReapStopProof> {
    const classSet = new Set<JobLifecycleClass>(classes)
    const cancelledStarts = cancelPendingStarts(
      this.pendingStarts,
      (s) => s.leaseId === leaseId && classSet.has(s.lifecycleClass),
    )
    const toReap: InternalManagedJob[] = []
    const survivingJobIds: string[] = []
    for (const job of this.jobs.values()) {
      if (job.leaseId !== leaseId || job.closed) continue
      if (classSet.has(job.lifecycleClass)) toReap.push(job)
      else survivingJobIds.push(job.jobId)
    }
    const reapedPgids = new Set<number>()
    const reapedJobIds: string[] = []
    for (const job of toReap) {
      job.forcedState ??= 'killed'
      job.terminationCause ??= 'killed'
      if (job.pgid) reapedPgids.add(job.pgid)
      reapedJobIds.push(job.jobId)
      this.terminateJobGroup(job, 'SIGTERM')
    }
    await Promise.all([...toReap.map((job) => job.closePromise), ...cancelledStarts])
    const verifiedAtMs = this.clock()
    const envId = opts?.envId ?? this.envId
    const reason = opts?.reason ?? 'completed'
    const proofDigest = computeReapProofDigest({
      leaseId,
      envId,
      reason,
      classes: [...classSet].sort(),
      reapedJobIds: [...reapedJobIds].sort(),
      survivingJobIds: [...survivingJobIds].sort(),
      verifiedAtMs,
    })
    return {
      leaseId,
      envId,
      reason,
      activeJobsTerminated: reapedJobIds.length,
      stoppedAt: new Date(verifiedAtMs).toISOString(),
      proofDigest,
      reapedPgidCount: reapedPgids.size,
      reapedJobIds,
      survivingJobIds,
      verifiedAtMs,
    }
  }

  async detachSurvivorsForHandoff(
    leaseId: string,
    opts?: { preserveClasses?: readonly JobLifecycleClass[] },
  ): Promise<ExecEnvShutdownResult> {
    const cancelledStarts = cancelPendingStarts(this.pendingStarts, (s) => s.leaseId === leaseId)
    const preserveSet = new Set<JobLifecycleClass>(
      opts?.preserveClasses ?? ['managed_job', 'daemon_service'],
    )
    const reapClasses = (['ephemeral_turn', 'managed_job', 'daemon_service'] as const).filter(
      (c) => !preserveSet.has(c),
    )
    const proof = await this.reapByClass(leaseId, reapClasses)
    await Promise.all(cancelledStarts)
    const preservedJobIds: string[] = []
    for (const job of [...this.jobs.values()]) {
      if (job.leaseId !== leaseId) continue
      if (preserveSet.has(job.lifecycleClass)) {
        this.clearJobTimers(job)
        if (!job.closed && job.survivableSinkAttached) {
          preservedJobIds.push(job.jobId)
          unrefPreservedChild(job)
        } else {
          await unlinkRotatingLogPairAsync(job.stdoutLogPath)
          await unlinkRotatingLogPairAsync(job.stderrLogPath)
        }
        clearJobBuffers(job)
        this.jobs.delete(job.jobId)
      } else if (job.closed) {
        this.pruneJob(job.jobId)
      }
    }
    return { reapedJobIds: proof.reapedJobIds, preservedJobIds }
  }

  async markEnvMigratedTombstones(
    leaseId: string,
    reason: string,
  ): Promise<ExecEnvMigrationTombstoneResult> {
    const cancelledStarts = cancelPendingStarts(this.pendingStarts, (s) => s.leaseId === leaseId, reason)
    const targetJobs = [...this.jobs.values()].filter((j) => j.leaseId === leaseId)
    const reapedPgids = new Set<number>()
    const toWait: Promise<void>[] = []
    for (const job of targetJobs) {
      if (!job.closed) {
        job.forcedState = 'killed'
        job.terminationCause = 'killed'
        if (job.pgid) reapedPgids.add(job.pgid)
        this.terminateJobGroup(job, 'SIGTERM')
        toWait.push(job.closePromise)
      }
    }
    await Promise.all([...toWait, ...cancelledStarts])
    const verifiedAtMs = this.clock()
    const finishedAt = new Date(verifiedAtMs).toISOString()
    const tombstonedJobIds: string[] = []
    for (const job of targetJobs) {
      this.clearJobTimers(job)
      clearJobBuffers(job)
      await unlinkRotatingLogPairAsync(job.stdoutLogPath)
      await unlinkRotatingLogPairAsync(job.stderrLogPath)
      this.jobs.delete(job.jobId)
      tombstonedJobIds.push(job.jobId)
      this.recordMigratedTombstone({
        jobId: job.jobId,
        leaseId: job.leaseId,
        sessionKey: job.sessionKey,
        lifecycleClass: job.lifecycleClass,
        label: job.label,
        reason,
        startedAtMs: job.startedAtMs,
        migratedAtMs: verifiedAtMs,
        finishedAt,
      })
    }
    return { leaseId, reason, tombstonedJobIds, reapedPgidCount: reapedPgids.size, verifiedAtMs }
  }

  shutdownSync(opts?: { preserveClasses?: readonly JobLifecycleClass[] }): ExecEnvShutdownResult {
    this.disposed = true
    cancelPendingStarts(this.pendingStarts)
    const preserveSet = new Set<JobLifecycleClass>(opts?.preserveClasses ?? [])
    const reapedJobIds: string[] = []
    const preservedJobIds: string[] = []
    for (const slot of this.pendingStarts.values()) {
      if (cleanupPendingStartSync(slot, this.verifyProcessGroupOps)) reapedJobIds.push(slot.jobId)
    }
    for (const job of this.jobs.values()) {
      this.clearJobTimers(job)
      if (!job.closed) {
        if (preserveSet.has(job.lifecycleClass) && job.survivableSinkAttached) {
          preservedJobIds.push(job.jobId)
          unrefPreservedChild(job)
        } else if (this.forceCloseOnShutdownSync(job)) {
          reapedJobIds.push(job.jobId)
        }
      } else {
        scheduleUnlinkRotatingLogPair(job.stdoutLogPath)
        scheduleUnlinkRotatingLogPair(job.stderrLogPath)
      }
      clearJobBuffers(job)
    }
    this.jobs.clear()
    return { reapedJobIds, preservedJobIds }
  }

  private forceCloseOnShutdownSync(job: InternalManagedJob): boolean {
    job.forcedState ??= 'killed'
    job.terminationCause ??= 'killed'
    job.killRequested = true
    const signaled = stopManagedJobGroupSync(job, this.verifyProcessGroupOps)
    const alreadyDead = job.child.exitCode !== null || job.child.signalCode !== null
    if (!signaled && !alreadyDead) return false
    destroyChildStreamsAndUnref(job)
    this.finalizeClosedJobSync(job, job.exitCode, (job.signal as NodeJS.Signals | null) ?? 'SIGKILL')
    scheduleUnlinkRotatingLogPair(job.stdoutLogPath)
    scheduleUnlinkRotatingLogPair(job.stderrLogPath)
    return true
  }

  async disposeAll(): Promise<void> {
    this.disposed = true
    const cancelledStarts = cancelPendingStarts(this.pendingStarts)
    const pending: Promise<void>[] = []
    for (const job of this.jobs.values()) {
      this.clearJobTimers(job)
      if (!job.closed) {
        job.forcedState ??= 'killed'
        job.terminationCause ??= 'killed'
        job.killRequested = true
        await sendVerifiedGroupSignalAsync(job.pgid, job.child, job.startTimeTicks, 'SIGKILL')
        destroyChildStreamsAndUnref(job)
        this.finalizeClosedJobSync(job, job.exitCode, (job.signal as NodeJS.Signals | null) ?? 'SIGKILL')
        pending.push(job.closePromise)
      }
      clearJobBuffers(job)
      await unlinkRotatingLogPairAsync(job.stdoutLogPath)
      await unlinkRotatingLogPairAsync(job.stderrLogPath)
    }
    await Promise.all([...pending, ...cancelledStarts])
    this.jobs.clear()
  }

  private pumpLogFiles(job: InternalManagedJob): Promise<void> {
    if (!job.survivableSinkAttached) return Promise.resolve()
    const run = job.pumpInFlight.then(async () => {
      await pumpLogReaderAsync(job.stdoutReader, (chunk) => this.pushRawChunk(job, 'stdout', chunk))
      await pumpLogReaderAsync(job.stderrReader, (chunk) => this.pushRawChunk(job, 'stderr', chunk))
    })
    job.pumpInFlight = run.catch((err) => {
      void err
    })
    return job.pumpInFlight
  }

  private pushDeltaText(job: InternalManagedJob, stream: 'stdout' | 'stderr', text: string): void {
    if (!text || this.maxOutputBytes <= 0) return
    const clipped = clipUtf8Tail(text, this.maxOutputBytes)
    if (clipped.byteLength === 0) return
    const entry: DeltaRingEntry = {
      delta: {
        jobId: job.jobId,
        stream,
        chunk: clipped.text,
        seq: ++job.deltaSeq,
        ts: new Date(this.clock()).toISOString(),
      },
      byteLength: clipped.byteLength,
    }
    job.deltaRing.push(entry)
    job.deltaRingBytes += entry.byteLength
    while (
      (job.deltaRingBytes > this.maxOutputBytes || job.deltaRing.length > MAX_DELTA_RING_ENTRIES) &&
      job.deltaRing.length > 1
    ) {
      const dropped = job.deltaRing.shift()!
      job.deltaRingBytes = Math.max(0, job.deltaRingBytes - dropped.byteLength)
    }
    this.wakeDeltaWaiters(job)
  }

  private pushRawChunk(job: InternalManagedJob, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (chunk.length === 0) return
    if (stream === 'stdout') job.stdout.push(chunk)
    else job.stderr.push(chunk)
    job.combined.push(chunk)
    const decoder = stream === 'stdout' ? job.stdoutDecoder : job.stderrDecoder
    const decoded = decoder.write(chunk)
    if (decoded.length > 0) this.pushDeltaText(job, stream, decoded)
  }

  private attachChildListeners(job: InternalManagedJob): void {
    job.child.stdout?.on('data', (chunk: Buffer) => this.pushRawChunk(job, 'stdout', chunk))
    job.child.stderr?.on('data', (chunk: Buffer) => this.pushRawChunk(job, 'stderr', chunk))
    job.child.on('error', (err) => {
      job.spawnError = err.message
      job.terminationCause ??= 'spawn_error'
      void this.finalizeClosedJobAsync(job, null, null)
    })
    job.child.on('close', (code, signal) => {
      void this.finalizeClosedJobAsync(job, code, signal)
    })
  }

  private wakeDeltaWaiters(job: InternalManagedJob): void {
    for (const wakeup of job.deltaWaiters) wakeup()
  }

  private clearJobTimers(job: InternalManagedJob): void {
    clearInternalJobTimers(job)
  }

  private terminateJobGroup(job: InternalManagedJob, initialSignal: NodeJS.Signals): void {
    if (job.closed || job.killRequested) return
    job.killRequested = true
    void sendVerifiedGroupSignalAsync(job.pgid, job.child, job.startTimeTicks, initialSignal)
    job.killTimer = setTimeout(() => {
      job.killTimer = null
      if (job.closed) return
      void sendVerifiedGroupSignalAsync(job.pgid, job.child, job.startTimeTicks, 'SIGKILL')
      job.closeSafetyTimer = setTimeout(() => {
        job.closeSafetyTimer = null
        if (job.closed) return
        destroyChildStreamsAndUnref(job)
        this.finalizeClosedJobSync(job, job.exitCode, (job.signal as NodeJS.Signals | null) ?? 'SIGKILL')
      }, this.closeDrainSafetyMs)
      job.closeSafetyTimer.unref()
    }, this.killGraceMs)
    job.killTimer.unref()
  }

  private async finalizeClosedJobAsync(
    job: InternalManagedJob,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (job.closed) return
    await job.ticksReady
    if (job.killRequested) {
      await sendVerifiedGroupSignalAsync(job.pgid, job.child, job.startTimeTicks, 'SIGKILL')
    }
    if (job.sinkClosePromise && !job.closed) {
      let timer: NodeJS.Timeout | null = null
      await Promise.race([
        job.sinkClosePromise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SINK_FLUSH_WAIT_MS)
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer)
      })
    }
    await this.pumpLogFiles(job)
    this.finalizeClosedJobSync(job, exitCode, signal)
  }

  private finalizeClosedJobSync(
    job: InternalManagedJob,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (job.closed) return
    const tailOut = job.stdoutDecoder.end()
    if (tailOut) this.pushDeltaText(job, 'stdout', tailOut)
    const tailErr = job.stderrDecoder.end()
    if (tailErr) this.pushDeltaText(job, 'stderr', tailErr)
    job.closed = true
    job.exitCode = exitCode
    job.signal = signal
    job.finishedAtMs = this.clock()
    job.finishedAt = new Date(job.finishedAtMs).toISOString()
    assignJobTerminalState(job)
    this.clearJobTimers(job)
    this.wakeDeltaWaiters(job)
    job.resolveClose()
    this.emitClosedEvent(job)
  }

  private emitClosedEvent(job: InternalManagedJob): void {
    if (!job.startedNotified) return
    try {
      this.onJobClosed?.(buildJobClosedEvent(job))
    } catch (err) {
      void err
    }
  }

  private async waitCloseOrTimeout(job: InternalManagedJob, timeoutMs: number): Promise<void> {
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

  private recordMigratedTombstone(tombstone: EnvMigratedTombstone): void {
    if (this.migratedTombstones.has(tombstone.jobId)) {
      this.migratedTombstones.delete(tombstone.jobId)
    }
    this.migratedTombstones.set(tombstone.jobId, tombstone)
    while (this.migratedTombstones.size > this.maxTombstones) {
      const oldest = this.migratedTombstones.keys().next().value
      if (oldest === undefined) break
      this.migratedTombstones.delete(oldest)
    }
  }
}
