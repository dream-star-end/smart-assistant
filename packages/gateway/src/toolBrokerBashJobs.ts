/**
 * OCV5-915 P3-2 — Persistent BrokerBashJobManager (`rt-misc` rank 2).
 *
 * Extracted from `toolBrokerSessionStore.ts` to keep session/credential storage focused
 * and enforce Steward S1: active running capacity (`MAX_BASH_ACTIVE_JOBS = 16`) is strictly
 * separated from bounded completed-result retention (`MAX_FINISHED_JOBS = 64`,
 * `FINISHED_JOB_TTL_MS = 10m`) so unqueried finished jobs never exhaust running capacity
 * or leak memory. Zero syncIo / process.env / emptyCatch / typeEscape.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { JobLifecycleClass } from '@openclaude/protocol'
import { scrubToolBrokerEnv } from '@openclaude/protocol/exec-env'

export const MAX_BASH_ACTIVE_JOBS = 16
export const MAX_FINISHED_JOBS = 64
export const FINISHED_JOB_TTL_MS = 10 * 60_000
export const EPHEMERAL_IDLE_TTL_MS = 10 * 60_000
export const EPHEMERAL_MAX_LIFETIME_MS = 30 * 60_000
const MAX_BASH_OUTPUT_BYTES = 1024 * 1024
const KILL_GRACE_MS = 1500

export interface BrokerBashJobManagerOptions {
  readonly ephemeralIdleTtlMs?: number
  readonly ephemeralMaxLifetimeMs?: number
}

export interface BrokerBashResult {
  readonly kind:
    | 'finished'
    | 'running'
    | 'killed'
    | 'hard_timeout'
    | 'not_found'
    | 'busy'
    | 'spawn_error'
    | 'too_many_jobs'
  readonly jobId?: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly elapsedMs: number
  readonly cwd?: string
  readonly lifecycleClass?: JobLifecycleClass
  readonly truncated?: boolean
  readonly isError: boolean
  readonly text: string
}

interface ManagedBashJob {
  readonly jobId: string
  readonly sessionKey: string
  readonly turnId?: string
  readonly leaseId?: string
  readonly child: ChildProcess
  readonly cwd?: string
  readonly lifecycleClass: JobLifecycleClass
  readonly startedAtMs: number
  lastActivityAtMs: number
  readonly outChunks: Buffer[]
  readonly errChunks: Buffer[]
  outBytes: number
  errBytes: number
  truncated: boolean
  exited: boolean
  finishedAtMs: number | null
  exitCode: number | null
  signal: NodeJS.Signals | null
  waiting: boolean
  closeWaiters: Array<() => void>
  detachAbortCleanup?: () => void
}

export interface BrokerBashExecuteInput {
  readonly sessionKey: string
  readonly turnId?: string
  readonly leaseId?: string
  readonly command?: string
  readonly jobId?: string
  readonly action?: 'wait' | 'status' | 'kill'
  readonly cwd?: string
  readonly timeoutMs: number
  readonly killOnTimeout: boolean
  readonly lifecycleClass: JobLifecycleClass
  readonly env: Record<string, string>
  readonly signal: AbortSignal
  readonly onStdout?: (chunk: string) => void
  readonly onStderr?: (chunk: string) => void
}

function appendCappedBuf(
  chunk: Buffer,
  arr: Buffer[],
  cur: number,
): { count: number; truncated: boolean } {
  if (cur >= MAX_BASH_OUTPUT_BYTES) return { count: cur, truncated: true }
  const room = MAX_BASH_OUTPUT_BYTES - cur
  if (chunk.byteLength <= room) {
    arr.push(chunk)
    return { count: cur + chunk.byteLength, truncated: false }
  }
  arr.push(chunk.subarray(0, room))
  return { count: MAX_BASH_OUTPUT_BYTES, truncated: true }
}

export function killJobGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (child.pid && child.pid > 0) {
    try {
      process.kill(-child.pid, sig)
      return
    } catch (err) {
      void err
    }
  }
  try {
    child.kill(sig)
  } catch (err) {
    void err
  }
}

function formatSections(
  header: string,
  stdout: string,
  stderr: string,
  footer?: string,
): string {
  const out = stdout.replace(/\s+$/, '')
  const err = stderr.replace(/\s+$/, '')
  return `${header}${out ? `\n${out}` : ''}${err ? `\n--- stderr ---\n${err}` : ''}${footer ? `\n---\n${footer}` : ''}`
}

function waitJobEvent(
  job: ManagedBashJob,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<'exited' | 'timeout' | 'aborted'> {
  return new Promise<'exited' | 'timeout' | 'aborted'>((resolveWait) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (kind: 'exited' | 'timeout' | 'aborted') => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const idx = job.closeWaiters.indexOf(onClose)
      if (idx >= 0) job.closeWaiters.splice(idx, 1)
      resolveWait(kind)
    }
    const onClose = () => done('exited')
    const onAbort = () => done('aborted')
    if (job.exited) {
      done('exited')
      return
    }
    if (signal.aborted) {
      done('aborted')
      return
    }
    job.closeWaiters.push(onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => done('timeout'), timeoutMs)
    timer.unref()
  })
}

export class BrokerBashJobManager {
  private readonly jobs = new Map<string, ManagedBashJob>()
  private readonly ephemeralIdleTtlMs: number
  private readonly ephemeralMaxLifetimeMs: number
  private nextSeq = 0

  constructor(private readonly clock: () => number, opts?: BrokerBashJobManagerOptions) {
    this.ephemeralIdleTtlMs = Math.max(1, Math.floor(opts?.ephemeralIdleTtlMs ?? EPHEMERAL_IDLE_TTL_MS))
    this.ephemeralMaxLifetimeMs = Math.max(1, Math.floor(opts?.ephemeralMaxLifetimeMs ?? EPHEMERAL_MAX_LIFETIME_MS))
  }

  activeRunningCount(): number {
    this.reapExpiredEphemeralJobs()
    let count = 0
    for (const job of this.jobs.values()) {
      if (!job.exited) count += 1
    }
    return count
  }

  reapExpiredEphemeralJobs(nowMs = Math.floor(this.clock())): number {
    let reaped = 0
    for (const [id, job] of [...this.jobs]) {
      if (job.exited || job.lifecycleClass !== 'ephemeral_turn') continue
      const idleExpired = !job.waiting && nowMs - job.lastActivityAtMs >= this.ephemeralIdleTtlMs
      const lifetimeExpired = nowMs - job.startedAtMs >= this.ephemeralMaxLifetimeMs
      if (idleExpired || lifetimeExpired) {
        this.forceReapJob(id, job)
        reaped += 1
      }
    }
    return reaped
  }

  private forceReapJob(id: string, job: ManagedBashJob): void {
    job.detachAbortCleanup?.()
    job.detachAbortCleanup = undefined
    this.jobs.delete(id)
    if (!job.exited) killJobGroup(job.child, 'SIGKILL')
  }

  pruneFinishedJobs(nowMs = Math.floor(this.clock())): number {
    let pruned = 0
    const finished: ManagedBashJob[] = []
    for (const [id, job] of [...this.jobs]) {
      if (!job.exited) continue
      const finishedAt = job.finishedAtMs ?? job.startedAtMs
      if (nowMs - finishedAt >= FINISHED_JOB_TTL_MS) {
        this.jobs.delete(id)
        pruned += 1
      } else {
        finished.push(job)
      }
    }
    if (finished.length > MAX_FINISHED_JOBS) {
      finished.sort(
        (a, b) => (a.finishedAtMs ?? a.startedAtMs) - (b.finishedAtMs ?? b.startedAtMs),
      )
      const excess = finished.length - MAX_FINISHED_JOBS
      for (let i = 0; i < excess; i += 1) {
        this.jobs.delete(finished[i]!.jobId)
        pruned += 1
      }
    }
    return pruned
  }

  async execute(input: BrokerBashExecuteInput): Promise<BrokerBashResult> {
    if (input.jobId) {
      return this.continueJob({
        sessionKey: input.sessionKey,
        jobId: input.jobId,
        action: input.action ?? 'wait',
        timeoutMs: input.timeoutMs,
        killOnTimeout: input.killOnTimeout,
        signal: input.signal,
      })
    }
    return this.startAndWait({
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      leaseId: input.leaseId,
      command: input.command ?? '',
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      killOnTimeout: input.killOnTimeout,
      lifecycleClass: input.lifecycleClass,
      env: input.env,
      signal: input.signal,
      onStdout: input.onStdout,
      onStderr: input.onStderr,
    })
  }

  private async startAndWait(input: {
    readonly sessionKey: string
    readonly turnId?: string
    readonly leaseId?: string
    readonly command: string
    readonly cwd?: string
    readonly timeoutMs: number
    readonly killOnTimeout: boolean
    readonly lifecycleClass: JobLifecycleClass
    readonly env: Record<string, string>
    readonly signal: AbortSignal
    readonly onStdout?: (chunk: string) => void
    readonly onStderr?: (chunk: string) => void
  }): Promise<BrokerBashResult> {
    this.reapExpiredEphemeralJobs()
    this.pruneFinishedJobs()
    if (this.activeRunningCount() >= MAX_BASH_ACTIVE_JOBS) {
      return {
        kind: 'too_many_jobs',
        exitCode: null,
        signal: null,
        elapsedMs: 0,
        isError: true,
        text: `oc_bash: active job limit reached (${MAX_BASH_ACTIVE_JOBS})`,
      }
    }
    const startedAtMs = Math.floor(this.clock())
    const scrubbedEnv = scrubToolBrokerEnv(input.env)
    if (input.lifecycleClass !== 'ephemeral_turn') {
      delete scrubbedEnv.OPENCLAUDE_TURN_REAP_TAG
      scrubbedEnv.OPENCLAUDE_LIFECYCLE_CLASS = input.lifecycleClass
    }
    let child: ChildProcess
    try {
      child = spawn('/bin/bash', ['-lc', input.command], {
        cwd: input.cwd,
        env: scrubbedEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      return {
        kind: 'spawn_error',
        exitCode: null,
        signal: null,
        elapsedMs: 0,
        isError: true,
        text: `oc_bash: 启动失败: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    const job = this.registerSpawnedJob(child, input, startedAtMs)
    return this.waitForJob(job, input.timeoutMs, input.killOnTimeout, input.signal)
  }

  private registerSpawnedJob(
    child: ChildProcess,
    input: {
      readonly sessionKey: string
      readonly turnId?: string
      readonly leaseId?: string
      readonly cwd?: string
      readonly lifecycleClass: JobLifecycleClass
      readonly signal: AbortSignal
      readonly onStdout?: (chunk: string) => void
      readonly onStderr?: (chunk: string) => void
    },
    startedAtMs: number,
  ): ManagedBashJob {
    this.nextSeq += 1
    const jobId = `ocb_${this.nextSeq}_${randomBytes(3).toString('hex')}`
    const job: ManagedBashJob = {
      jobId,
      sessionKey: input.sessionKey,
      turnId: input.turnId,
      leaseId: input.leaseId,
      child,
      cwd: input.cwd,
      lifecycleClass: input.lifecycleClass,
      startedAtMs,
      lastActivityAtMs: startedAtMs,
      outChunks: [],
      errChunks: [],
      outBytes: 0,
      errBytes: 0,
      truncated: false,
      exited: false,
      finishedAtMs: null,
      exitCode: null,
      signal: null,
      waiting: false,
      closeWaiters: [],
    }
    this.jobs.set(jobId, job)
    if (job.lifecycleClass === 'ephemeral_turn') {
      const onSignalAbort = () => {
        if (!job.waiting && !job.exited) this.forceReapJob(jobId, job)
      }
      input.signal.addEventListener('abort', onSignalAbort, { once: true })
      job.detachAbortCleanup = () => input.signal.removeEventListener('abort', onSignalAbort)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      job.lastActivityAtMs = Math.floor(this.clock())
      const n = appendCappedBuf(chunk, job.outChunks, job.outBytes)
      job.outBytes = n.count
      if (n.truncated) job.truncated = true
      input.onStdout?.(chunk.toString('utf8'))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      job.lastActivityAtMs = Math.floor(this.clock())
      const n = appendCappedBuf(chunk, job.errChunks, job.errBytes)
      job.errBytes = n.count
      if (n.truncated) job.truncated = true
      input.onStderr?.(chunk.toString('utf8'))
    })
    const markClosed = (code: number | null, sig: NodeJS.Signals | null) => {
      if (job.exited) return
      job.exited = true
      job.exitCode = code
      job.signal = sig
      job.finishedAtMs = Math.floor(this.clock())
      job.detachAbortCleanup?.()
      job.detachAbortCleanup = undefined
      for (const wake of job.closeWaiters.splice(0, job.closeWaiters.length)) wake()
      this.pruneFinishedJobs(job.finishedAtMs)
    }
    child.on('error', () => markClosed(null, null))
    child.on('close', (code, sig) => markClosed(code, sig))
    return job
  }

  private async continueJob(input: {
    readonly sessionKey: string
    readonly jobId: string
    readonly action: 'wait' | 'status' | 'kill'
    readonly timeoutMs: number
    readonly killOnTimeout: boolean
    readonly signal: AbortSignal
  }): Promise<BrokerBashResult> {
    this.reapExpiredEphemeralJobs()
    this.pruneFinishedJobs()
    const job = this.jobs.get(input.jobId)
    if (!job || job.sessionKey !== input.sessionKey) {
      return {
        kind: 'not_found',
        jobId: input.jobId,
        exitCode: null,
        signal: null,
        elapsedMs: 0,
        isError: true,
        text: `oc_bash: 未找到任务 job_id=${input.jobId}`,
      }
    }
    job.lastActivityAtMs = Math.floor(this.clock())
    if (input.action === 'status') return this.snapshotJob(job)
    if (input.action === 'kill') return this.killJob(job)
    if (job.waiting) {
      return {
        kind: 'busy',
        jobId: job.jobId,
        exitCode: null,
        signal: null,
        elapsedMs: Math.max(0, Math.floor(this.clock()) - job.startedAtMs),
        isError: true,
        text: `oc_bash: 任务 job_id=${job.jobId} 正在等待中`,
      }
    }
    return this.waitForJob(job, input.timeoutMs, input.killOnTimeout, input.signal)
  }

  private async waitForJob(
    job: ManagedBashJob,
    timeoutMs: number,
    killOnTimeout: boolean,
    signal: AbortSignal,
  ): Promise<BrokerBashResult> {
    if (job.exited) return this.collectFinished(job)
    job.waiting = true
    try {
      const outcome = await waitJobEvent(job, timeoutMs, signal)
      if (outcome === 'exited' || job.exited) return this.collectFinished(job)
      if (outcome === 'aborted') {
        return job.lifecycleClass === 'ephemeral_turn'
          ? this.killJob(job)
          : this.snapshotJob(job)
      }
      if (killOnTimeout) {
        return await this.hardTimeoutJob(job, timeoutMs)
      }
      return this.snapshotJob(job)
    } finally {
      job.waiting = false
    }
  }

  private async hardTimeoutJob(job: ManagedBashJob, timeoutMs: number): Promise<BrokerBashResult> {
    await this.terminateProcessGroup(job)
    this.jobs.delete(job.jobId)
    const elapsedMs = Math.max(0, Math.floor(this.clock()) - job.startedAtMs)
    const bits = [
      `exit=${job.exitCode ?? 'none'}`,
      ...(job.signal ? [`signal=${job.signal}`] : []),
      `timed out after ${timeoutMs}ms`,
      ...(job.truncated ? ['truncated'] : []),
    ]
    return {
      kind: 'hard_timeout',
      jobId: job.jobId,
      exitCode: job.exitCode,
      signal: job.signal,
      elapsedMs,
      cwd: job.cwd,
      lifecycleClass: job.lifecycleClass,
      truncated: job.truncated,
      isError: true,
      text: formatSections(
        bits.join(' '),
        Buffer.concat(job.outChunks).toString('utf8'),
        Buffer.concat(job.errChunks).toString('utf8'),
      ),
    }
  }

  private snapshotJob(job: ManagedBashJob): BrokerBashResult {
    if (job.exited) return this.collectFinished(job)
    const elapsedMs = Math.max(0, Math.floor(this.clock()) - job.startedAtMs)
    const bits = [
      'status=running',
      `job_id=${job.jobId}`,
      `elapsed_ms=${elapsedMs}`,
      ...(job.lifecycleClass !== 'ephemeral_turn' ? [`lifecycle_class=${job.lifecycleClass}`] : []),
      ...(job.truncated ? ['truncated'] : []),
    ]
    const footer = `[oc_bash] 命令仍在运行（进度已保留，未强杀）。\n继续等待: oc_bash({"job_id":"${job.jobId}","timeout_ms":600000})\n查看状态: oc_bash({"job_id":"${job.jobId}","action":"status"})\n终止进程: oc_bash({"job_id":"${job.jobId}","action":"kill"})`
    return {
      kind: 'running',
      jobId: job.jobId,
      exitCode: null,
      signal: null,
      elapsedMs,
      cwd: job.cwd,
      lifecycleClass: job.lifecycleClass,
      truncated: job.truncated,
      isError: false,
      text: formatSections(
        bits.join(' '),
        Buffer.concat(job.outChunks).toString('utf8'),
        Buffer.concat(job.errChunks).toString('utf8'),
        footer,
      ),
    }
  }

  private collectFinished(job: ManagedBashJob): BrokerBashResult {
    this.jobs.delete(job.jobId)
    const elapsedMs = Math.max(0, Math.floor(this.clock()) - job.startedAtMs)
    const bits = [
      `exit=${job.exitCode ?? 'none'}`,
      ...(job.signal ? [`signal=${job.signal}`] : []),
      ...(job.truncated ? ['truncated'] : []),
    ]
    return {
      kind: 'finished',
      jobId: job.jobId,
      exitCode: job.exitCode,
      signal: job.signal,
      elapsedMs,
      cwd: job.cwd,
      lifecycleClass: job.lifecycleClass,
      truncated: job.truncated,
      isError: job.exitCode !== 0 || job.signal !== null,
      text: formatSections(
        bits.join(' '),
        Buffer.concat(job.outChunks).toString('utf8'),
        Buffer.concat(job.errChunks).toString('utf8'),
      ),
    }
  }

  private async killJob(job: ManagedBashJob): Promise<BrokerBashResult> {
    await this.terminateProcessGroup(job)
    this.jobs.delete(job.jobId)
    const elapsedMs = Math.max(0, Math.floor(this.clock()) - job.startedAtMs)
    const bits = [
      'status=killed',
      `job_id=${job.jobId}`,
      `exit=${job.exitCode ?? 'none'}`,
      ...(job.signal ? [`signal=${job.signal}`] : []),
      `elapsed_ms=${elapsedMs}`,
      ...(job.truncated ? ['truncated'] : []),
    ]
    return {
      kind: 'killed',
      jobId: job.jobId,
      exitCode: job.exitCode,
      signal: job.signal,
      elapsedMs,
      cwd: job.cwd,
      lifecycleClass: job.lifecycleClass,
      truncated: job.truncated,
      isError: false,
      text: formatSections(
        bits.join(' '),
        Buffer.concat(job.outChunks).toString('utf8'),
        Buffer.concat(job.errChunks).toString('utf8'),
      ),
    }
  }

  private async terminateProcessGroup(job: ManagedBashJob): Promise<void> {
    if (job.exited) return
    killJobGroup(job.child, 'SIGTERM')
    await new Promise<void>((resolveStop) => {
      let settled = false
      const done = () => {
        if (!settled) {
          settled = true
          clearTimeout(killTimer)
          clearTimeout(hardTimer)
          resolveStop()
        }
      }
      if (job.exited) {
        done()
        return
      }
      job.closeWaiters.push(done)
      const killTimer = setTimeout(() => {
        if (!job.exited) killJobGroup(job.child, 'SIGKILL')
      }, KILL_GRACE_MS)
      const hardTimer = setTimeout(done, KILL_GRACE_MS + 1000)
      killTimer.unref()
      hardTimer.unref()
    })
  }

  listActiveEphemeralTurnIds(sessionKey: string): string[] {
    const turnIds = new Set<string>()
    for (const job of this.jobs.values()) {
      if (!job.exited && job.sessionKey === sessionKey && job.lifecycleClass === 'ephemeral_turn' && job.turnId) {
        turnIds.add(job.turnId)
      }
    }
    return [...turnIds]
  }

  reapTurn(sessionKey: string, turnId: string): number {
    let reaped = 0
    for (const [id, job] of [...this.jobs]) {
      if (job.sessionKey !== sessionKey || job.turnId !== turnId) continue
      if (job.lifecycleClass !== 'ephemeral_turn') continue
      this.forceReapJob(id, job)
      reaped += 1
    }
    return reaped
  }

  reapLease(leaseId: string): number {
    let reaped = 0
    for (const [id, job] of [...this.jobs]) {
      if (job.leaseId !== leaseId || job.lifecycleClass !== 'ephemeral_turn') continue
      this.forceReapJob(id, job)
      reaped += 1
    }
    return reaped
  }

  reapSession(sessionKey: string, opts?: { readonly includeSurvivors?: boolean }): void {
    for (const [id, job] of [...this.jobs]) {
      if (job.sessionKey !== sessionKey) continue
      if (!opts?.includeSurvivors && job.lifecycleClass !== 'ephemeral_turn') continue
      this.forceReapJob(id, job)
    }
  }

  disposeAll(): void {
    for (const [id, job] of [...this.jobs]) {
      this.forceReapJob(id, job)
    }
  }
}
