/**
 * OCV5-890 / OCV5-908 Layer 3 — Types and pure result/buffer helpers for `ExecEnvJobRegistry`.
 */
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type {
  ExecEnvStopProof,
  JobLifecycleClass,
  JobOutcome,
  JobOutputDelta,
  JobStartResult,
  StartJobSpec,
} from '@openclaude/protocol'
import {
  BoundedDeltaStreamBuffer,
  getDefaultSyncProcOps,
  readProcStartTimeTicksAsync,
  sendVerifiedGroupSignal,
  sendVerifiedGroupSignalAsync,
  type ExecEnvJobTerminationCause,
  type VerifyProcessGroupOps,
} from './execEnvProcInspect.js'
import {
  closeHandleQuiet,
  destroySinkParentPipes,
  scheduleUnlinkRotatingLogPair,
  unlinkRotatingLogPairAsync,
  type LogStreamReaderState,
  type SurvivableSinkSetup,
} from './execEnvSurvivableSink.js'

export interface ExecEnvJobStartedEvent {
  jobId: string
  leaseId: string
  sessionKey?: string
  lifecycleClass: JobLifecycleClass
  pid: number | undefined
  pgid: number | undefined
  startTimeTicks: number | null
  startedAtMs: number
  stdoutLogPath?: string
  stderrLogPath?: string
}

export interface ExecEnvJobClosedEvent {
  jobId: string
  leaseId: string
  sessionKey?: string
  lifecycleClass: JobLifecycleClass
  pid: number | undefined
  pgid: number | undefined
  startTimeTicks: number | null
  state: 'exited' | 'killed' | 'timed_out' | 'failed'
  terminationCause: ExecEnvJobTerminationCause
  exitCode: number | null
  signal: string | null
  killRequested: boolean
  spawnError?: string
  stdoutLogPath?: string
  stderrLogPath?: string
}

export interface ExecEnvStartJobSpec extends StartJobSpec {
  sessionKey?: string
  yieldAfterMs?: number
  killOnTimeout?: boolean
  maxLifetimeMs?: number
  survivableStdioDir?: string | null
}

export interface ExecEnvJobStartResult extends JobStartResult {
  status: 'running' | 'exited' | 'killed' | 'timed_out' | 'failed'
  pgid?: number
  startTimeTicks?: number | null
  stdout: string
  stderr: string
  nextCursor: number
  nextStdoutCursor: number
  nextStderrCursor: number
  truncated: boolean
  exitCode: number | null
  signal: string | null
  durationMs: number
  finishedAt: string | null
  spawnError?: string
  terminationCause?: ExecEnvJobTerminationCause
  stdoutLogPath?: string
  stderrLogPath?: string
}

export type ExecEnvWaitJobAction = 'wait' | 'status' | 'kill'

export interface WaitJobOptions {
  leaseId: string
  action?: ExecEnvWaitJobAction
  timeoutMs?: number
  fromCursor?: number
  stdoutCursor?: number
  stderrCursor?: number
}

export interface ExecEnvWaitJobResult {
  jobId: string
  leaseId: string
  lifecycleClass: JobLifecycleClass
  status: 'running' | 'exited' | 'killed' | 'timed_out' | 'failed' | 'terminated_env_migrated'
  exitCode: number | null
  signal: string | null
  durationMs: number
  finishedAt: string | null
  stdout: string
  stderr: string
  nextCursor: number
  nextStdoutCursor: number
  nextStderrCursor: number
  truncated: boolean
  tombstoneReason?: string
  message?: string
  spawnError?: string
  terminationCause?: ExecEnvJobTerminationCause
}

export interface ExecEnvReapStopProof extends ExecEnvStopProof {
  reapedPgidCount: number
  reapedJobIds: readonly string[]
  survivingJobIds: readonly string[]
  verifiedAtMs: number
}

export interface ExecEnvMigrationTombstoneResult {
  leaseId: string
  reason: string
  tombstonedJobIds: readonly string[]
  reapedPgidCount: number
  verifiedAtMs: number
}

export interface ExecEnvShutdownResult {
  reapedJobIds: readonly string[]
  preservedJobIds: readonly string[]
}

export interface ExecEnvJobRegistryOptions {
  maxOutputBytes?: number
  headOutputBytes?: number
  killGraceMs?: number
  closeDrainSafetyMs?: number
  maxJobLifetimeMs?: number
  maxTombstones?: number
  defaultCwd?: string
  defaultEnv?: Readonly<Record<string, string>>
  envId?: string
  clock?: () => number
  survivableStdioDir?: string | null
  maxLogFileBytes?: number
  readStartTimeTicks?: (pid: number) => Promise<number | null>
  verifyProcessGroupOps?: VerifyProcessGroupOps
  onJobStarted?: (event: ExecEnvJobStartedEvent) => void
  onJobClosed?: (event: ExecEnvJobClosedEvent) => void
}

export interface EnvMigratedTombstone {
  jobId: string
  leaseId: string
  sessionKey?: string
  lifecycleClass: JobLifecycleClass
  label?: string
  reason: string
  startedAtMs: number
  migratedAtMs: number
  finishedAt: string
}

export interface DeltaRingEntry {
  delta: JobOutputDelta
  byteLength: number
}

export interface InternalManagedJob {
  jobId: string
  leaseId: string
  sessionKey?: string
  lifecycleClass: JobLifecycleClass
  label?: string
  command: readonly string[]
  cwd: string
  startedAtMs: number
  startedAt: string
  child: ChildProcess
  pgid: number | undefined
  startTimeTicks: number | null
  ticksReady: Promise<void>
  stdout: BoundedDeltaStreamBuffer
  stderr: BoundedDeltaStreamBuffer
  combined: BoundedDeltaStreamBuffer
  stdoutDecoder: StringDecoder
  stderrDecoder: StringDecoder
  deltaRing: DeltaRingEntry[]
  deltaRingBytes: number
  deltaSeq: number
  deltaWaiters: Set<() => void>
  stdoutLogPath?: string
  stderrLogPath?: string
  stdoutReader: LogStreamReaderState
  stderrReader: LogStreamReaderState
  pumpInFlight: Promise<void>
  survivableSinkAttached: boolean
  sinkProcess?: ChildProcess
  sinkClosePromise?: Promise<void>
  logPumpTimer: NodeJS.Timeout | null
  startedNotified: boolean
  state: 'running' | 'exited' | 'killed' | 'timed_out' | 'failed'
  closed: boolean
  exitCode: number | null
  signal: string | null
  finishedAtMs: number | null
  finishedAt: string | null
  spawnError?: string
  killRequested: boolean
  forcedState: 'killed' | 'timed_out' | null
  terminationCause: ExecEnvJobTerminationCause | null
  killTimer: NodeJS.Timeout | null
  closeSafetyTimer: NodeJS.Timeout | null
  lifetimeTimer: NodeJS.Timeout | null
  closePromise: Promise<void>
  resolveClose: () => void
}

export function clearJobBuffers(job: InternalManagedJob): void {
  closeHandleQuiet(job.stdoutReader.handle)
  closeHandleQuiet(job.stderrReader.handle)
  job.stdoutReader.handle = null
  job.stderrReader.handle = null
  job.stdout.clear()
  job.stderr.clear()
  job.combined.clear()
  job.deltaRing.length = 0
  job.deltaRingBytes = 0
}

export function unrefPreservedChild(job: InternalManagedJob): void {
  try {
    job.child.removeAllListeners('close')
    job.child.removeAllListeners('error')
    job.sinkProcess?.removeAllListeners('close')
    job.sinkProcess?.removeAllListeners('error')
    job.child.unref()
    job.sinkProcess?.unref()
  } catch (err) {
    void err
  }
}

export function destroyChildStreamsAndUnref(job: InternalManagedJob): void {
  try {
    job.child.stdout?.destroy()
    job.child.stderr?.destroy()
    job.child.unref()
    job.sinkProcess?.unref()
  } catch (err) {
    void err
  }
}

export function formatMigratedTombstone(
  tombstone: EnvMigratedTombstone,
  opts?: WaitJobOptions,
): JobOutcome | ExecEnvWaitJobResult {
  const durationMs = Math.max(0, tombstone.migratedAtMs - tombstone.startedAtMs)
  if (!opts) {
    return {
      jobId: tombstone.jobId,
      status: 'killed',
      exitCode: null,
      signal: 'SIGKILL',
      durationMs,
      finishedAt: tombstone.finishedAt,
    }
  }
  return {
    jobId: tombstone.jobId,
    leaseId: tombstone.leaseId,
    lifecycleClass: tombstone.lifecycleClass,
    status: 'terminated_env_migrated',
    exitCode: null,
    signal: null,
    durationMs,
    finishedAt: tombstone.finishedAt,
    stdout: '',
    stderr: '',
    nextCursor: opts.fromCursor ?? 0,
    nextStdoutCursor: opts.stdoutCursor ?? opts.fromCursor ?? 0,
    nextStderrCursor: opts.stderrCursor ?? 0,
    truncated: false,
    tombstoneReason: tombstone.reason,
    message: `Job ${tombstone.jobId} was terminated during execution environment migration: ${tombstone.reason}`,
  }
}

export function buildJobStartResult(job: InternalManagedJob, nowMs: number): ExecEnvJobStartResult {
  const outRead = job.stdout.readFrom(0, job.closed)
  const errRead = job.stderr.readFrom(0, job.closed)
  const combinedRead = job.combined.readFrom(0, job.closed)
  return {
    jobId: job.jobId,
    leaseId: job.leaseId,
    lifecycleClass: job.lifecycleClass,
    pid: job.child.pid,
    pgid: job.pgid,
    startTimeTicks: job.startTimeTicks,
    startedAt: job.startedAt,
    status: job.state,
    stdout: outRead.text,
    stderr: errRead.text,
    nextCursor: combinedRead.nextCursor,
    nextStdoutCursor: outRead.nextCursor,
    nextStderrCursor: errRead.nextCursor,
    truncated: outRead.truncated || errRead.truncated,
    exitCode: job.exitCode,
    signal: job.signal,
    durationMs: Math.max(0, (job.finishedAtMs ?? nowMs) - job.startedAtMs),
    finishedAt: job.finishedAt,
    ...(job.spawnError !== undefined ? { spawnError: job.spawnError } : {}),
    ...(job.terminationCause !== null ? { terminationCause: job.terminationCause } : {}),
    ...(job.stdoutLogPath ? { stdoutLogPath: job.stdoutLogPath } : {}),
    ...(job.stderrLogPath ? { stderrLogPath: job.stderrLogPath } : {}),
  }
}

export function buildJobWaitResult(
  job: InternalManagedJob,
  opts: WaitJobOptions,
  nowMs: number,
): ExecEnvWaitJobResult {
  const outRead = job.stdout.readFrom(opts.stdoutCursor ?? opts.fromCursor ?? 0, job.closed)
  const errRead = job.stderr.readFrom(opts.stderrCursor ?? 0, job.closed)
  const combinedRead = job.combined.readFrom(opts.fromCursor ?? 0, job.closed)
  return {
    jobId: job.jobId,
    leaseId: job.leaseId,
    lifecycleClass: job.lifecycleClass,
    status: job.state,
    exitCode: job.exitCode,
    signal: job.signal,
    durationMs: Math.max(0, (job.finishedAtMs ?? nowMs) - job.startedAtMs),
    finishedAt: job.finishedAt,
    stdout: outRead.text,
    stderr: errRead.text,
    nextCursor: combinedRead.nextCursor,
    nextStdoutCursor: outRead.nextCursor,
    nextStderrCursor: errRead.nextCursor,
    truncated: outRead.truncated || errRead.truncated,
    ...(job.spawnError !== undefined ? { spawnError: job.spawnError } : {}),
    ...(job.terminationCause !== null ? { terminationCause: job.terminationCause } : {}),
  }
}

export function assignJobTerminalState(job: InternalManagedJob): void {
  if (job.forcedState === 'timed_out') {
    job.state = 'timed_out'
    job.terminationCause ??= 'max_lifetime'
  } else if (job.forcedState === 'killed' || job.killRequested) {
    job.state = 'killed'
    job.terminationCause ??= 'killed'
  } else if (job.spawnError) {
    job.state = 'failed'
    job.terminationCause ??= 'spawn_error'
  } else {
    job.state = 'exited'
    job.terminationCause ??= 'exited'
  }
}

export function computeReapProofDigest(payload: {
  leaseId: string
  envId: string
  reason: string
  classes: string[]
  reapedJobIds: string[]
  survivingJobIds: string[]
  verifiedAtMs: number
}): string {
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

export function createManagedJobRecord(opts: {
  jobId: string
  spec: ExecEnvStartJobSpec
  cwd: string
  child: ChildProcess
  sink: SurvivableSinkSetup | null
  startedAtMs: number
  maxOutputBytes: number
  headOutputBytes: number
  readStartTimeTicks?: (pid: number) => Promise<number | null>
}): InternalManagedJob {
  let resolveClose!: () => void
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve
  })
  const pgid = opts.child.pid && opts.child.pid > 0 ? opts.child.pid : undefined
  const bufOpts = { maxBytes: opts.maxOutputBytes, headBytes: opts.headOutputBytes }
  const job: InternalManagedJob = {
    jobId: opts.jobId,
    leaseId: opts.spec.leaseId,
    sessionKey: opts.spec.sessionKey,
    lifecycleClass: opts.spec.lifecycleClass,
    label: opts.spec.label,
    command: Object.freeze([...opts.spec.command]),
    cwd: opts.cwd,
    startedAtMs: opts.startedAtMs,
    startedAt: new Date(opts.startedAtMs).toISOString(),
    child: opts.child,
    pgid,
    startTimeTicks: null,
    ticksReady: Promise.resolve(),
    stdout: new BoundedDeltaStreamBuffer(bufOpts),
    stderr: new BoundedDeltaStreamBuffer(bufOpts),
    combined: new BoundedDeltaStreamBuffer(bufOpts),
    stdoutDecoder: new StringDecoder('utf8'),
    stderrDecoder: new StringDecoder('utf8'),
    deltaRing: [],
    deltaRingBytes: 0,
    deltaSeq: 0,
    deltaWaiters: new Set(),
    ...(opts.sink ? { stdoutLogPath: opts.sink.stdoutLogPath, stderrLogPath: opts.sink.stderrLogPath } : {}),
    stdoutReader: opts.sink?.stdoutReader ?? { handle: null, ino: null, offset: 0 },
    stderrReader: opts.sink?.stderrReader ?? { handle: null, ino: null, offset: 0 },
    pumpInFlight: Promise.resolve(),
    survivableSinkAttached: opts.sink !== null,
    ...(opts.sink ? { sinkProcess: opts.sink.sinkProcess, sinkClosePromise: opts.sink.sinkClosePromise } : {}),
    logPumpTimer: null,
    startedNotified: false,
    state: 'running',
    closed: false,
    exitCode: null,
    signal: null,
    finishedAtMs: null,
    finishedAt: null,
    killRequested: false,
    forcedState: null,
    terminationCause: null,
    killTimer: null,
    closeSafetyTimer: null,
    lifetimeTimer: null,
    closePromise,
    resolveClose,
  }
  if (pgid) {
    const readTicks = opts.readStartTimeTicks ?? readProcStartTimeTicksAsync
    job.ticksReady = readTicks(pgid)
      .then((ticks) => {
        job.startTimeTicks = ticks
      })
      .catch((err) => {
        void err
      })
  }
  return job
}

export function clearInternalJobTimers(job: InternalManagedJob): void {
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
  if (job.logPumpTimer) {
    clearInterval(job.logPumpTimer)
    job.logPumpTimer = null
  }
}

export interface PendingStartSlot {
  readonly jobId: string
  readonly leaseId: string
  readonly lifecycleClass: JobLifecycleClass
  cancelled: boolean
  cancelReason?: string
  sink: SurvivableSinkSetup | null
  child: ChildProcess | null
  job: InternalManagedJob | null
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
}

export function createPendingStartSlot(
  jobId: string,
  spec: Pick<ExecEnvStartJobSpec, 'leaseId' | 'lifecycleClass'>,
): PendingStartSlot {
  let resolveSettled!: () => void
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
  return {
    jobId,
    leaseId: spec.leaseId,
    lifecycleClass: spec.lifecycleClass,
    cancelled: false,
    sink: null,
    child: null,
    job: null,
    settled,
    resolveSettled,
  }
}

export function cancelPendingStarts(
  pendingStarts: ReadonlyMap<string, PendingStartSlot>,
  filter?: (slot: PendingStartSlot) => boolean,
  reason?: string,
): Promise<void>[] {
  const waiting: Promise<void>[] = []
  for (const slot of pendingStarts.values()) {
    if (!filter || filter(slot)) {
      slot.cancelled = true
      if (reason !== undefined) slot.cancelReason = reason
      waiting.push(slot.settled)
    }
  }
  return waiting
}

function forceKillUnreapedChild(child: ChildProcess): boolean {
  // Only safe to signal directly without /proc ticks while the child has not yet been reaped
  // by this parent process (OS cannot recycle the PID before waitpid completes).
  if (child.exitCode !== null || child.signalCode !== null) return false
  let signaled = false
  const pgid = child.pid && child.pid > 0 ? child.pid : undefined
  if (pgid) {
    try {
      process.kill(-pgid, 'SIGKILL')
      signaled = true
    } catch (err) {
      void err
    }
  }
  try {
    if (child.kill('SIGKILL')) signaled = true
  } catch (err) {
    void err
  }
  return signaled
}

function destroyRawChildStreams(child: ChildProcess): void {
  try {
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
  } catch (err) {
    void err
  }
}

/**
 * Synchronous best-effort teardown for an in-flight `PendingStartSlot` during `shutdownSync()`.
 * Guarantees that even if the parent process immediately terminates (e.g. re-raised SIGTERM in
 * MCP stdio shutdown) before pending Promises resume, any already-spawned detached child process
 * group and log sink are killed immediately without lying in `reapedJobIds`.
 */
export function stopManagedJobGroupSync(
  job: InternalManagedJob,
  verifyOps?: VerifyProcessGroupOps,
): boolean {
  const effectiveOps = verifyOps ?? getDefaultSyncProcOps() ?? undefined
  if (effectiveOps && job.startTimeTicks !== null) {
    return sendVerifiedGroupSignal(job.pgid, job.child, job.startTimeTicks, 'SIGKILL', effectiveOps)
  }
  // When no sync /proc reader is bound (or ticks not yet populated), ONLY direct un-reaped children
  // spawned by this registry may be signaled directly (kernel cannot recycle PID before waitpid).
  return forceKillUnreapedChild(job.child)
}

export function cleanupPendingStartSync(
  slot: PendingStartSlot,
  verifyOps?: VerifyProcessGroupOps,
): boolean {
  let signaled = false
  if (slot.job) {
    const job = slot.job
    clearInternalJobTimers(job)
    job.forcedState ??= 'killed'
    job.terminationCause ??= 'killed'
    job.killRequested = true
    signaled = stopManagedJobGroupSync(job, verifyOps)
    destroyChildStreamsAndUnref(job)
    clearJobBuffers(job)
  } else if (slot.child) {
    signaled = forceKillUnreapedChild(slot.child)
    destroyRawChildStreams(slot.child)
  }
  if (slot.sink) {
    closeHandleQuiet(slot.sink.stdoutReader.handle)
    closeHandleQuiet(slot.sink.stderrReader.handle)
    destroySinkParentPipes(slot.sink.sinkProcess)
    try {
      slot.sink.sinkProcess.kill('SIGKILL')
    } catch (err) {
      void err
    }
    scheduleUnlinkRotatingLogPair(slot.sink.stdoutLogPath)
    scheduleUnlinkRotatingLogPair(slot.sink.stderrLogPath)
  }
  return signaled
}

export async function cleanupAbortedStartAsync(opts: {
  sink: SurvivableSinkSetup | null
  child?: ChildProcess | null
  job?: InternalManagedJob | null
}): Promise<void> {
  if (opts.job) {
    const job = opts.job
    clearInternalJobTimers(job)
    // Always terminate the verified process group regardless of logical `job.closed` state,
    // so an exited shell leader with live descendants or a prior logical close never leaks processes.
    job.forcedState ??= 'killed'
    job.terminationCause ??= 'killed'
    job.killRequested = true
    if (job.startTimeTicks !== null) {
      await sendVerifiedGroupSignalAsync(job.pgid, job.child, job.startTimeTicks, 'SIGKILL')
    } else {
      forceKillUnreapedChild(job.child)
    }
    if (!job.closed) {
      job.closed = true
      job.resolveClose()
    }
    destroyChildStreamsAndUnref(job)
    clearJobBuffers(job)
  } else if (opts.child) {
    forceKillUnreapedChild(opts.child)
    destroyRawChildStreams(opts.child)
  }
  if (opts.sink) {
    closeHandleQuiet(opts.sink.stdoutReader.handle)
    closeHandleQuiet(opts.sink.stderrReader.handle)
    destroySinkParentPipes(opts.sink.sinkProcess)
    try {
      opts.sink.sinkProcess.kill('SIGKILL')
    } catch (err) {
      void err
    }
    await unlinkRotatingLogPairAsync(opts.sink.stdoutLogPath)
    await unlinkRotatingLogPairAsync(opts.sink.stderrLogPath)
  }
}

export function buildJobStartedEvent(job: InternalManagedJob): ExecEnvJobStartedEvent {
  return {
    jobId: job.jobId,
    leaseId: job.leaseId,
    sessionKey: job.sessionKey,
    lifecycleClass: job.lifecycleClass,
    pid: job.child.pid,
    pgid: job.pgid,
    startTimeTicks: job.startTimeTicks,
    startedAtMs: job.startedAtMs,
    ...(job.stdoutLogPath ? { stdoutLogPath: job.stdoutLogPath } : {}),
    ...(job.stderrLogPath ? { stderrLogPath: job.stderrLogPath } : {}),
  }
}

export function buildJobClosedEvent(job: InternalManagedJob): ExecEnvJobClosedEvent {
  return {
    jobId: job.jobId,
    leaseId: job.leaseId,
    sessionKey: job.sessionKey,
    lifecycleClass: job.lifecycleClass,
    pid: job.child.pid,
    pgid: job.pgid,
    startTimeTicks: job.startTimeTicks,
    state: job.state as 'exited' | 'killed' | 'timed_out' | 'failed',
    terminationCause: job.terminationCause ?? 'exited',
    exitCode: job.exitCode,
    signal: job.signal,
    killRequested: job.killRequested,
    ...(job.spawnError !== undefined ? { spawnError: job.spawnError } : {}),
    ...(job.stdoutLogPath ? { stdoutLogPath: job.stdoutLogPath } : {}),
    ...(job.stderrLogPath ? { stderrLogPath: job.stderrLogPath } : {}),
  }
}

export function buildManagedJobSummary(job: InternalManagedJob): {
  jobId: string
  leaseId: string
  lifecycleClass: JobLifecycleClass
  state: InternalManagedJob['state']
  label?: string
  startedAt: string
  finishedAt: string | null
} {
  return {
    jobId: job.jobId,
    leaseId: job.leaseId,
    lifecycleClass: job.lifecycleClass,
    state: job.state,
    ...(job.label === undefined ? {} : { label: job.label }),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  }
}
