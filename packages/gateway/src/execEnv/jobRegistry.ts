/**
 * OCV5-890 Layer 3 — Execution Environment persistent JobRegistry (`ProcessJobSeam`).
 *
 * Lives in Layer 3 (Execution Environment) across brain switches and inference lane recycles:
 * - `ephemeral_turn`: reaped when a turn/lane finishes.
 * - `managed_job`: survives brain switches and lane recycles; new brains can resume `waitJob`.
 * - `daemon_service`: long-lived dev/preview services surviving brain switches and lane recycles.
 *
 * Architecture invariants:
 * - R3-env: zero `process.env` reads; caller injects `defaultEnv` / `spec.env`.
 * - R3-crypto / R3-net / R3-special-case: zero violations.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import type {
  ExecEnvStopProof,
  JobLifecycleClass,
  JobOutcome,
  JobOutputDelta,
  JobStartResult,
  ManagedJobSummary,
  ProcessJobSeam,
  StartJobSpec,
} from '@openclaude/protocol'

export const EXEC_ENV_JOB_MAX_OUTPUT_BYTES = 200 * 1024
export const EXEC_ENV_JOB_HEAD_BYTES = 64 * 1024
export const EXEC_ENV_JOB_TAIL_BYTES = EXEC_ENV_JOB_MAX_OUTPUT_BYTES - EXEC_ENV_JOB_HEAD_BYTES
export const EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS = 400
export const EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS = 2_000
export const EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS = 2 * 60 * 60_000
export const EXEC_ENV_JOB_DEFAULT_TOMBSTONE_MAX = 256
const DEFAULT_SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export type ExecEnvJobErrorCode =
  | 'EXEC_JOB_COMMAND_EMPTY'
  | 'EXEC_JOB_REGISTRY_DISPOSED'
  | 'EXEC_JOB_NOT_FOUND'
  | 'EXEC_JOB_LEASE_MISMATCH'
  | 'EXEC_JOB_DUPLICATE_ID'

export class ExecEnvJobError extends Error {
  readonly code: ExecEnvJobErrorCode

  constructor(code: ExecEnvJobErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ExecEnvJobError'
    this.code = code
  }
}

/**
 * Count trailing bytes (1..3) belonging to an incomplete UTF-8 sequence at the end of `buf`.
 */
export function trailingIncompleteUtf8Count(buf: Uint8Array): number {
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
export function leadingContinuationUtf8Count(buf: Uint8Array): number {
  let i = 0
  const limit = Math.min(3, buf.length)
  while (i < limit && (buf[i]! & 0xc0) === 0x80) {
    i += 1
  }
  return i
}

/**
 * Parse field 22 (`starttime`, clock ticks since boot) from Linux `/proc/<pid>/stat`.
 * Splits after the last `)` so process `comm` names containing spaces or parentheses parse cleanly.
 */
export function parseProcStatStartTimeTicks(statLine: string): number | null {
  const rparen = statLine.lastIndexOf(')')
  if (rparen < 0) return null
  const rest = statLine.slice(rparen + 1).trim()
  if (!rest) return null
  const fields = rest.split(/\s+/)
  const rawTicks = fields[19]
  if (!rawTicks || !/^\d+$/.test(rawTicks)) return null
  const ticks = Number(rawTicks)
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null
}

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

/**
 * Verifies whether any live non-zombie process still belongs to process group `pgid`
 * with `starttime >= minStartTicks` (guards against PID/PGID reuse on Linux).
 */
export function hasAliveVerifiedProcessGroup(pgid: number, minStartTicks: number | null): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  try {
    process.kill(-pgid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') {
      return false
    }
  }
  if (process.platform !== 'linux' || minStartTicks === null) {
    return true
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
      /* process exited during scan */
    }
  }
  return false
}

export interface BoundedDeltaStreamBufferOptions {
  readonly maxBytes?: number
  readonly headBytes?: number
}

export interface BoundedDeltaReadResult {
  readonly text: string
  readonly nextCursor: number
  readonly truncated: boolean
  readonly omittedBytes: number
  readonly totalBytes: number
}

/**
 * Bounded head + rolling-tail stream buffer (default 200 KiB = 64 KiB head + 136 KiB tail)
 * supporting incremental byte-cursor reads via `readFrom(cursor)`.
 *
 * Retained memory never exceeds `maxBytes`. Callers polling with `nextCursor` receive exact
 * incremental deltas even while the total stream grows past `maxBytes`, as long as their cursor
 * stays within the rolling tail window.
 */
export class BoundedDeltaStreamBuffer {
  readonly maxBytes: number
  readonly headCap: number
  readonly tailCap: number

  private totalBytes = 0
  private truncated = false
  private inlineBuf: Buffer = Buffer.alloc(0)
  private headBuf: Buffer = Buffer.alloc(0)
  private tailBuf: Buffer = Buffer.alloc(0)

  constructor(opts: BoundedDeltaStreamBufferOptions = {}) {
    const maxBytes = Math.max(0, Math.floor(opts.maxBytes ?? EXEC_ENV_JOB_MAX_OUTPUT_BYTES))
    const defaultHead =
      opts.maxBytes === undefined
        ? EXEC_ENV_JOB_HEAD_BYTES
        : Math.floor(maxBytes * (EXEC_ENV_JOB_HEAD_BYTES / EXEC_ENV_JOB_MAX_OUTPUT_BYTES))
    const headCap = Math.max(0, Math.min(maxBytes, Math.floor(opts.headBytes ?? defaultHead)))
    this.maxBytes = maxBytes
    this.headCap = headCap
    this.tailCap = Math.max(0, maxBytes - headCap)
  }

  get byteLength(): number {
    return this.totalBytes
  }

  get isTruncated(): boolean {
    return this.truncated
  }

  push(chunk: Uint8Array | string): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    if (data.length === 0) return

    this.totalBytes += data.length
    if (this.maxBytes === 0) {
      this.truncated = true
      return
    }

    if (!this.truncated) {
      if (this.inlineBuf.length + data.length <= this.maxBytes) {
        this.inlineBuf = this.inlineBuf.length === 0 ? data : Buffer.concat([this.inlineBuf, data])
        return
      }
      const combined = this.inlineBuf.length === 0 ? data : Buffer.concat([this.inlineBuf, data])
      this.inlineBuf = Buffer.alloc(0)
      this.truncated = true
      this.headBuf = Buffer.from(combined.subarray(0, this.headCap))
      this.tailBuf =
        this.tailCap > 0
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

  readFrom(cursor = 0, isFinal = false): BoundedDeltaReadResult {
    const safeCursor = Math.max(0, Math.min(Math.floor(cursor), this.totalBytes))
    if (safeCursor >= this.totalBytes) {
      return {
        text: '',
        nextCursor: this.totalBytes,
        truncated: false,
        omittedBytes: 0,
        totalBytes: this.totalBytes,
      }
    }

    if (!this.truncated) {
      let slice = this.inlineBuf.subarray(safeCursor)
      let heldBack = 0
      if (!isFinal) {
        heldBack = trailingIncompleteUtf8Count(slice)
        if (heldBack > 0) {
          slice = slice.subarray(0, slice.length - heldBack)
        }
      }
      return {
        text: slice.toString('utf8'),
        nextCursor: this.totalBytes - heldBack,
        truncated: false,
        omittedBytes: 0,
        totalBytes: this.totalBytes,
      }
    }

    const tailStartOffset = this.totalBytes - this.tailBuf.length

    if (safeCursor >= tailStartOffset) {
      const relStart = safeCursor - tailStartOffset
      let slice = this.tailBuf.subarray(relStart)
      if (relStart === 0) {
        const leadSkip = leadingContinuationUtf8Count(slice)
        if (leadSkip > 0) slice = slice.subarray(leadSkip)
      }
      let heldBack = 0
      if (!isFinal) {
        heldBack = trailingIncompleteUtf8Count(slice)
        if (heldBack > 0) {
          slice = slice.subarray(0, slice.length - heldBack)
        }
      }
      return {
        text: slice.toString('utf8'),
        nextCursor: this.totalBytes - heldBack,
        truncated: false,
        omittedBytes: 0,
        totalBytes: this.totalBytes,
      }
    }

    const tailLeadSkip = leadingContinuationUtf8Count(this.tailBuf)
    let tailClean = tailLeadSkip > 0 ? this.tailBuf.subarray(tailLeadSkip) : this.tailBuf
    let heldBack = 0
    if (!isFinal) {
      heldBack = trailingIncompleteUtf8Count(tailClean)
      if (heldBack > 0) {
        tailClean = tailClean.subarray(0, tailClean.length - heldBack)
      }
    }
    const tailText = tailClean.toString('utf8')

    if (safeCursor < this.headBuf.length) {
      let headSlice = this.headBuf.subarray(safeCursor)
      const headTrail = trailingIncompleteUtf8Count(headSlice)
      if (headTrail > 0) headSlice = headSlice.subarray(0, headSlice.length - headTrail)
      const omittedBytes = Math.max(0, tailStartOffset - (safeCursor + headSlice.length))
      return {
        text: `${headSlice.toString('utf8')}\n...[truncated ${omittedBytes} bytes]...\n${tailText}`,
        nextCursor: this.totalBytes - heldBack,
        truncated: true,
        omittedBytes,
        totalBytes: this.totalBytes,
      }
    }

    const omittedBytes = Math.max(0, tailStartOffset - safeCursor)
    return {
      text: `\n...[truncated ${omittedBytes} bytes]...\n${tailText}`,
      nextCursor: this.totalBytes - heldBack,
      truncated: true,
      omittedBytes,
      totalBytes: this.totalBytes,
    }
  }

  clear(): void {
    this.totalBytes = 0
    this.truncated = false
    this.inlineBuf = Buffer.alloc(0)
    this.headBuf = Buffer.alloc(0)
    this.tailBuf = Buffer.alloc(0)
  }
}

export interface ExecEnvStartJobSpec extends StartJobSpec {
  readonly sessionKey?: string
  /**
   * Soft-yield window: wait up to `yieldAfterMs` before returning `status: 'running'`
   * while leaving the detached process group alive.
   */
  readonly yieldAfterMs?: number
  /** If true and `yieldAfterMs` elapses while still running, terminate the process group. */
  readonly killOnTimeout?: boolean
  readonly maxLifetimeMs?: number
}

export interface ExecEnvJobStartResult extends JobStartResult {
  readonly status: 'running' | 'exited' | 'killed' | 'timed_out' | 'failed'
  readonly pgid?: number
  readonly startTimeTicks?: number | null
  readonly stdout: string
  readonly stderr: string
  readonly nextCursor: number
  readonly nextStdoutCursor: number
  readonly nextStderrCursor: number
  readonly truncated: boolean
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  readonly finishedAt: string | null
}

export type ExecEnvWaitJobAction = 'wait' | 'status' | 'kill'

export interface WaitJobOptions {
  readonly leaseId: string
  readonly action?: ExecEnvWaitJobAction
  readonly timeoutMs?: number
  readonly fromCursor?: number
  readonly stdoutCursor?: number
  readonly stderrCursor?: number
}

export interface ExecEnvWaitJobResult {
  readonly jobId: string
  readonly leaseId: string
  readonly lifecycleClass: JobLifecycleClass
  readonly status:
    | 'running'
    | 'exited'
    | 'killed'
    | 'timed_out'
    | 'failed'
    | 'terminated_env_migrated'
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  readonly finishedAt: string | null
  readonly stdout: string
  readonly stderr: string
  readonly nextCursor: number
  readonly nextStdoutCursor: number
  readonly nextStderrCursor: number
  readonly truncated: boolean
  readonly tombstoneReason?: string
  readonly message?: string
}

export interface ExecEnvReapStopProof extends ExecEnvStopProof {
  readonly reapedPgidCount: number
  readonly reapedJobIds: readonly string[]
  readonly survivingJobIds: readonly string[]
  readonly verifiedAtMs: number
}

export interface ExecEnvMigrationTombstoneResult {
  readonly leaseId: string
  readonly reason: string
  readonly tombstonedJobIds: readonly string[]
  readonly reapedPgidCount: number
  readonly verifiedAtMs: number
}

export interface ExecEnvJobRegistryOptions {
  readonly maxOutputBytes?: number
  readonly headOutputBytes?: number
  readonly killGraceMs?: number
  readonly closeDrainSafetyMs?: number
  readonly maxJobLifetimeMs?: number
  readonly maxTombstones?: number
  readonly defaultCwd?: string
  readonly defaultEnv?: Readonly<Record<string, string>>
  readonly envId?: string
  readonly clock?: () => number
}

interface EnvMigratedTombstone {
  readonly jobId: string
  readonly leaseId: string
  readonly sessionKey?: string
  readonly lifecycleClass: JobLifecycleClass
  readonly label?: string
  readonly reason: string
  readonly startedAtMs: number
  readonly migratedAtMs: number
  readonly finishedAt: string
}

interface InternalManagedJob {
  readonly jobId: string
  readonly leaseId: string
  readonly sessionKey?: string
  readonly lifecycleClass: JobLifecycleClass
  readonly label?: string
  readonly command: readonly string[]
  readonly cwd: string
  readonly startedAtMs: number
  readonly startedAt: string
  readonly child: ChildProcess
  readonly pgid: number | undefined
  startTimeTicks: number | null
  readonly stdout: BoundedDeltaStreamBuffer
  readonly stderr: BoundedDeltaStreamBuffer
  readonly combined: BoundedDeltaStreamBuffer
  readonly deltaRing: JobOutputDelta[]
  deltaRingBytes: number
  deltaSeq: number
  readonly deltaWaiters: Set<() => void>
  state: 'running' | 'exited' | 'killed' | 'timed_out' | 'failed'
  closed: boolean
  exitCode: number | null
  signal: string | null
  finishedAtMs: number | null
  finishedAt: string | null
  spawnError?: string
  killRequested: boolean
  forcedState: 'killed' | 'timed_out' | null
  killTimer: NodeJS.Timeout | null
  closeSafetyTimer: NodeJS.Timeout | null
  lifetimeTimer: NodeJS.Timeout | null
  readonly closePromise: Promise<void>
  readonly resolveClose: () => void
}

function sendVerifiedGroupSignal(
  pgid: number | undefined,
  child: ChildProcess,
  startTimeTicks: number | null,
  signal: NodeJS.Signals,
): boolean {
  if (pgid && pgid > 1) {
    if (
      process.platform === 'linux' &&
      startTimeTicks !== null &&
      !hasAliveVerifiedProcessGroup(pgid, startTimeTicks)
    ) {
      return false
    }
    try {
      process.kill(-pgid, signal)
      return true
    } catch {
      /* fallback below */
    }
  }
  try {
    return child.kill(signal)
  } catch {
    return false
  }
}

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

  private readonly jobs = new Map<string, InternalManagedJob>()
  private readonly migratedTombstones = new Map<string, EnvMigratedTombstone>()
  private disposed = false

  constructor(opts: ExecEnvJobRegistryOptions = {}) {
    this.maxOutputBytes = opts.maxOutputBytes ?? EXEC_ENV_JOB_MAX_OUTPUT_BYTES
    this.headOutputBytes = opts.headOutputBytes ?? EXEC_ENV_JOB_HEAD_BYTES
    this.killGraceMs = opts.killGraceMs ?? EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS
    this.closeDrainSafetyMs = opts.closeDrainSafetyMs ?? EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS
    this.maxJobLifetimeMs = opts.maxJobLifetimeMs ?? EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS
    this.maxTombstones = opts.maxTombstones ?? EXEC_ENV_JOB_DEFAULT_TOMBSTONE_MAX
    this.defaultCwd = opts.defaultCwd ?? process.cwd()
    this.defaultEnv = opts.defaultEnv ?? { PATH: DEFAULT_SAFE_PATH }
    this.envId = opts.envId ?? 'exec-env-local'
    this.clock = opts.clock ?? (() => Date.now())
  }

  async startJob(spec: ExecEnvStartJobSpec): Promise<ExecEnvJobStartResult> {
    if (this.disposed) {
      throw new ExecEnvJobError('EXEC_JOB_REGISTRY_DISPOSED', 'ExecEnvJobRegistry has been disposed')
    }
    if (!Array.isArray(spec.command) || spec.command.length === 0 || !spec.command[0]) {
      throw new ExecEnvJobError('EXEC_JOB_COMMAND_EMPTY', 'StartJobSpec.command must be non-empty')
    }

    const jobId = spec.jobId ?? `job_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    if (this.jobs.has(jobId)) {
      throw new ExecEnvJobError('EXEC_JOB_DUPLICATE_ID', `Job ${jobId} already exists`)
    }

    const [cmd, ...args] = spec.command
    const cwd = spec.cwd ?? this.defaultCwd
    const spawnEnv: Record<string, string> = {
      ...this.defaultEnv,
      ...(spec.env ?? {}),
    }

    const startedAtMs = this.clock()
    const startedAt = new Date(startedAtMs).toISOString()

    let resolveClose!: () => void
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve
    })

    const child = spawn(cmd!, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv,
    })

    const pgid = child.pid && child.pid > 0 ? child.pid : undefined
    const startTimeTicks = pgid ? readProcStartTimeTicks(pgid) : null

    const job: InternalManagedJob = {
      jobId,
      leaseId: spec.leaseId,
      sessionKey: spec.sessionKey,
      lifecycleClass: spec.lifecycleClass,
      label: spec.label,
      command: Object.freeze([...spec.command]),
      cwd,
      startedAtMs,
      startedAt,
      child,
      pgid,
      startTimeTicks,
      stdout: new BoundedDeltaStreamBuffer({
        maxBytes: this.maxOutputBytes,
        headBytes: this.headOutputBytes,
      }),
      stderr: new BoundedDeltaStreamBuffer({
        maxBytes: this.maxOutputBytes,
        headBytes: this.headOutputBytes,
      }),
      combined: new BoundedDeltaStreamBuffer({
        maxBytes: this.maxOutputBytes,
        headBytes: this.headOutputBytes,
      }),
      deltaRing: [],
      deltaRingBytes: 0,
      deltaSeq: 0,
      deltaWaiters: new Set(),
      state: 'running',
      closed: false,
      exitCode: null,
      signal: null,
      finishedAtMs: null,
      finishedAt: null,
      killRequested: false,
      forcedState: null,
      killTimer: null,
      closeSafetyTimer: null,
      lifetimeTimer: null,
      closePromise,
      resolveClose,
    }

    this.jobs.set(jobId, job)
    this.attachChildListeners(job)

    const effectiveLifetimeMs =
      spec.maxLifetimeMs ??
      (spec.lifecycleClass === 'daemon_service' ? undefined : (spec.timeoutMs ?? this.maxJobLifetimeMs))
    if (effectiveLifetimeMs !== undefined && effectiveLifetimeMs > 0) {
      job.lifetimeTimer = setTimeout(() => {
        job.lifetimeTimer = null
        if (job.closed || this.disposed) return
        job.forcedState ??= 'timed_out'
        this.terminateJobGroup(job, 'SIGTERM')
      }, effectiveLifetimeMs)
      job.lifetimeTimer.unref()
    }

    if (spec.yieldAfterMs !== undefined && spec.yieldAfterMs >= 0) {
      await this.waitCloseOrTimeout(job, spec.yieldAfterMs)
      if (!job.closed && spec.killOnTimeout) {
        job.forcedState = 'timed_out'
        this.terminateJobGroup(job, 'SIGTERM')
        await job.closePromise
      }
    }

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
      durationMs: Math.max(0, (job.finishedAtMs ?? this.clock()) - job.startedAtMs),
      finishedAt: job.finishedAt,
    }
  }

  async *streamOutput(jobId: string, sinceSeq = 0): AsyncIterable<JobOutputDelta> {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new ExecEnvJobError('EXEC_JOB_NOT_FOUND', `Job ${jobId} not found`)
    }
    let lastSeq = Math.max(0, Math.floor(sinceSeq))

    while (true) {
      let emitted = false
      for (const delta of job.deltaRing) {
        if (delta.seq > lastSeq) {
          lastSeq = delta.seq
          emitted = true
          yield delta
        }
      }
      if (job.closed) {
        for (const delta of job.deltaRing) {
          if (delta.seq > lastSeq) {
            lastSeq = delta.seq
            yield delta
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
        throw new ExecEnvJobError(
          'EXEC_JOB_LEASE_MISMATCH',
          `Job ${jobId} does not belong to lease ${opts.leaseId}`,
        )
      }
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
        message: `Job ${jobId} was terminated during execution environment migration: ${tombstone.reason}`,
      }
    }

    const job = this.jobs.get(jobId)
    if (!job) {
      throw new ExecEnvJobError('EXEC_JOB_NOT_FOUND', `Job ${jobId} not found`)
    }

    if (!opts) {
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

    if (job.leaseId !== opts.leaseId) {
      throw new ExecEnvJobError(
        'EXEC_JOB_LEASE_MISMATCH',
        `Job ${jobId} does not belong to lease ${opts.leaseId}`,
      )
    }

    const action: ExecEnvWaitJobAction = opts.action ?? 'wait'

    if (action === 'kill') {
      if (!job.closed) {
        job.forcedState ??= 'killed'
        this.terminateJobGroup(job, 'SIGTERM')
        await job.closePromise
      }
    } else if (action === 'wait' && !job.closed) {
      if (opts.timeoutMs !== undefined && opts.timeoutMs >= 0) {
        await this.waitCloseOrTimeout(job, opts.timeoutMs)
      } else {
        await job.closePromise
      }
    }

    // Re-check if migrated while awaiting close
    const migratedNow = this.migratedTombstones.get(jobId)
    if (migratedNow) {
      return {
        jobId: migratedNow.jobId,
        leaseId: migratedNow.leaseId,
        lifecycleClass: migratedNow.lifecycleClass,
        status: 'terminated_env_migrated',
        exitCode: null,
        signal: null,
        durationMs: Math.max(0, migratedNow.migratedAtMs - migratedNow.startedAtMs),
        finishedAt: migratedNow.finishedAt,
        stdout: '',
        stderr: '',
        nextCursor: opts.fromCursor ?? 0,
        nextStdoutCursor: opts.stdoutCursor ?? opts.fromCursor ?? 0,
        nextStderrCursor: opts.stderrCursor ?? 0,
        truncated: false,
        tombstoneReason: migratedNow.reason,
        message: `Job ${jobId} was terminated during execution environment migration: ${migratedNow.reason}`,
      }
    }

    const outCursor = opts.stdoutCursor ?? opts.fromCursor ?? 0
    const errCursor = opts.stderrCursor ?? 0
    const combinedCursor = opts.fromCursor ?? 0
    const outRead = job.stdout.readFrom(outCursor, job.closed)
    const errRead = job.stderr.readFrom(errCursor, job.closed)
    const combinedRead = job.combined.readFrom(combinedCursor, job.closed)

    return {
      jobId: job.jobId,
      leaseId: job.leaseId,
      lifecycleClass: job.lifecycleClass,
      status: job.state,
      exitCode: job.exitCode,
      signal: job.signal,
      durationMs: Math.max(0, (job.finishedAtMs ?? this.clock()) - job.startedAtMs),
      finishedAt: job.finishedAt,
      stdout: outRead.text,
      stderr: errRead.text,
      nextCursor: combinedRead.nextCursor,
      nextStdoutCursor: outRead.nextCursor,
      nextStderrCursor: errRead.nextCursor,
      truncated: outRead.truncated || errRead.truncated,
    }
  }

  async killJob(jobId: string, signal: NodeJS.Signals | string = 'SIGTERM'): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (!job || job.closed) return false
    job.forcedState ??= 'killed'
    this.terminateJobGroup(job, signal as NodeJS.Signals)
    await job.closePromise
    return true
  }

  listJobs(leaseId: string): Promise<readonly ManagedJobSummary[]>
  listJobs(filter: {
    readonly leaseId: string
    readonly sessionKey?: string
  }): Promise<readonly ManagedJobSummary[]>
  async listJobs(
    leaseIdOrFilter: string | { readonly leaseId: string; readonly sessionKey?: string },
  ): Promise<readonly ManagedJobSummary[]> {
    const leaseId = typeof leaseIdOrFilter === 'string' ? leaseIdOrFilter : leaseIdOrFilter.leaseId
    const sessionKey = typeof leaseIdOrFilter === 'string' ? undefined : leaseIdOrFilter.sessionKey
    const results: ManagedJobSummary[] = []
    for (const job of this.jobs.values()) {
      if (job.leaseId !== leaseId) continue
      if (sessionKey !== undefined && job.sessionKey !== sessionKey) continue
      results.push({
        jobId: job.jobId,
        leaseId: job.leaseId,
        lifecycleClass: job.lifecycleClass,
        state: job.state,
        ...(job.label === undefined ? {} : { label: job.label }),
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      })
    }
    return results
  }

  /**
   * Reaps ONLY active process groups belonging to `leaseId` whose `lifecycleClass` is in `classes`.
   * Never touches `managed_job` or `daemon_service` when `classes` is `['ephemeral_turn']`.
   */
  async reapByClass(
    leaseId: string,
    classes: readonly JobLifecycleClass[],
    opts?: {
      readonly reason?: ExecEnvStopProof['reason']
      readonly envId?: string
    },
  ): Promise<ExecEnvReapStopProof> {
    const classSet = new Set<JobLifecycleClass>(classes)
    const toReap: InternalManagedJob[] = []
    const survivingJobIds: string[] = []

    for (const job of this.jobs.values()) {
      if (job.leaseId !== leaseId) continue
      if (classSet.has(job.lifecycleClass)) {
        if (!job.closed) {
          toReap.push(job)
        }
      } else if (!job.closed) {
        survivingJobIds.push(job.jobId)
      }
    }

    const reapedPgids = new Set<number>()
    const reapedJobIds: string[] = []
    for (const job of toReap) {
      job.forcedState ??= 'killed'
      if (job.pgid) reapedPgids.add(job.pgid)
      reapedJobIds.push(job.jobId)
      this.terminateJobGroup(job, 'SIGTERM')
    }
    await Promise.all(toReap.map((job) => job.closePromise))

    const verifiedAtMs = this.clock()
    const stoppedAt = new Date(verifiedAtMs).toISOString()
    const envId = opts?.envId ?? this.envId
    const reason = opts?.reason ?? 'completed'
    const proofDigest = createHash('sha256')
      .update(
        JSON.stringify({
          leaseId,
          envId,
          reason,
          classes: [...classSet].sort(),
          reapedJobIds: [...reapedJobIds].sort(),
          survivingJobIds: [...survivingJobIds].sort(),
          verifiedAtMs,
        }),
        'utf8',
      )
      .digest('hex')

    return {
      leaseId,
      envId,
      reason,
      activeJobsTerminated: reapedJobIds.length,
      stoppedAt,
      proofDigest,
      reapedPgidCount: reapedPgids.size,
      reapedJobIds,
      survivingJobIds,
      verifiedAtMs,
    }
  }

  /**
   * Drains all active process groups for `leaseId` during container rebuild/migration and records
   * `terminated_env_migrated` tombstones so subsequent `waitJob` calls fail fast with structured status.
   */
  async markEnvMigratedTombstones(
    leaseId: string,
    reason: string,
  ): Promise<ExecEnvMigrationTombstoneResult> {
    const targetJobs: InternalManagedJob[] = []
    for (const job of this.jobs.values()) {
      if (job.leaseId === leaseId) {
        targetJobs.push(job)
      }
    }

    const reapedPgids = new Set<number>()
    const toWait: Promise<void>[] = []
    for (const job of targetJobs) {
      if (!job.closed) {
        job.forcedState = 'killed'
        if (job.pgid) reapedPgids.add(job.pgid)
        this.terminateJobGroup(job, 'SIGTERM')
        toWait.push(job.closePromise)
      }
    }
    await Promise.all(toWait)

    const verifiedAtMs = this.clock()
    const finishedAt = new Date(verifiedAtMs).toISOString()
    const tombstonedJobIds: string[] = []

    for (const job of targetJobs) {
      this.clearJobTimers(job)
      job.stdout.clear()
      job.stderr.clear()
      job.combined.clear()
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

    return {
      leaseId,
      reason,
      tombstonedJobIds,
      reapedPgidCount: reapedPgids.size,
      verifiedAtMs,
    }
  }

  async disposeAll(): Promise<void> {
    this.disposed = true
    const pending: Promise<void>[] = []
    for (const job of this.jobs.values()) {
      this.clearJobTimers(job)
      if (!job.closed) {
        job.forcedState ??= 'killed'
        job.killRequested = true
        sendVerifiedGroupSignal(job.pgid, job.child, job.startTimeTicks, 'SIGKILL')
        try {
          job.child.stdout?.destroy()
          job.child.stderr?.destroy()
          job.child.unref()
        } catch {
          /* ignore */
        }
        this.finalizeClosedJob(job, job.exitCode, (job.signal as NodeJS.Signals | null) ?? 'SIGKILL')
        pending.push(job.closePromise)
      }
      job.stdout.clear()
      job.stderr.clear()
      job.combined.clear()
    }
    await Promise.all(pending)
    this.jobs.clear()
  }

  private attachChildListeners(job: InternalManagedJob): void {
    const pushDelta = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (chunk.length === 0) return
      if (stream === 'stdout') job.stdout.push(chunk)
      else job.stderr.push(chunk)
      job.combined.push(chunk)

      const text = chunk.toString('utf8')
      const delta: JobOutputDelta = {
        jobId: job.jobId,
        stream,
        chunk: text,
        seq: ++job.deltaSeq,
        ts: new Date(this.clock()).toISOString(),
      }
      job.deltaRing.push(delta)
      job.deltaRingBytes += chunk.length
      while (job.deltaRingBytes > this.maxOutputBytes && job.deltaRing.length > 1) {
        const dropped = job.deltaRing.shift()!
        job.deltaRingBytes = Math.max(0, job.deltaRingBytes - Buffer.byteLength(dropped.chunk, 'utf8'))
      }
      this.wakeDeltaWaiters(job)
    }

    job.child.stdout?.on('data', (chunk: Buffer) => pushDelta('stdout', chunk))
    job.child.stderr?.on('data', (chunk: Buffer) => pushDelta('stderr', chunk))
    job.child.on('error', (err) => {
      job.spawnError = err.message
      this.finalizeClosedJob(job, null, null)
    })
    job.child.on('close', (code, signal) => {
      this.finalizeClosedJob(job, code, signal)
    })
  }

  private wakeDeltaWaiters(job: InternalManagedJob): void {
    for (const wakeup of job.deltaWaiters) {
      wakeup()
    }
  }

  private clearJobTimers(job: InternalManagedJob): void {
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

  private terminateJobGroup(job: InternalManagedJob, initialSignal: NodeJS.Signals): void {
    if (job.closed) return
    if (job.killRequested) return
    job.killRequested = true
    sendVerifiedGroupSignal(job.pgid, job.child, job.startTimeTicks, initialSignal)

    job.killTimer = setTimeout(() => {
      job.killTimer = null
      if (job.closed) return
      sendVerifiedGroupSignal(job.pgid, job.child, job.startTimeTicks, 'SIGKILL')
      job.closeSafetyTimer = setTimeout(() => {
        job.closeSafetyTimer = null
        if (job.closed) return
        try {
          job.child.stdout?.destroy()
          job.child.stderr?.destroy()
        } catch {
          /* ignore */
        }
        this.finalizeClosedJob(job, job.exitCode, (job.signal as NodeJS.Signals | null) ?? 'SIGKILL')
      }, this.closeDrainSafetyMs)
      job.closeSafetyTimer.unref()
    }, this.killGraceMs)
    job.killTimer.unref()
  }

  private finalizeClosedJob(
    job: InternalManagedJob,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (job.closed) return
    if (job.killRequested) {
      sendVerifiedGroupSignal(job.pgid, job.child, job.startTimeTicks, 'SIGKILL')
    }
    job.closed = true
    job.exitCode = exitCode
    job.signal = signal
    job.finishedAtMs = this.clock()
    job.finishedAt = new Date(job.finishedAtMs).toISOString()

    if (job.forcedState === 'timed_out') {
      job.state = 'timed_out'
    } else if (job.forcedState === 'killed' || job.killRequested) {
      job.state = 'killed'
    } else if (job.spawnError) {
      job.state = 'failed'
    } else {
      job.state = 'exited'
    }

    this.clearJobTimers(job)
    this.wakeDeltaWaiters(job)
    job.resolveClose()
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
