/**
 * Pure types, constants, command preview redaction, and `DeltaStreamBuffer` compatibility
 * wrapper for `ocBashJobManager` (zero `process.env`, zero sync I/O, zero empty catches).
 */
import type { ChildProcess } from 'node:child_process'
import { JOB_LIFECYCLE_CLASSES, type JobLifecycleClass } from '@openclaude/protocol'
import {
  BoundedDeltaStreamBuffer,
  EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS,
  EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS,
  EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS,
  EXEC_ENV_JOB_HEAD_BYTES,
  EXEC_ENV_JOB_MAX_OUTPUT_BYTES,
  EXEC_ENV_JOB_TAIL_BYTES,
} from '@openclaude/storage'

export const OC_BASH_MAX_OUTPUT_BYTES = EXEC_ENV_JOB_MAX_OUTPUT_BYTES
export const OC_BASH_HEAD_BYTES = EXEC_ENV_JOB_HEAD_BYTES
export const OC_BASH_TAIL_BYTES = EXEC_ENV_JOB_TAIL_BYTES
export const OC_BASH_MAX_ACTIVE_JOBS = 4
export const OC_BASH_IDLE_JOB_TTL_MS = 5 * 60_000
export const OC_BASH_MAX_JOB_LIFETIME_MS = EXEC_ENV_JOB_DEFAULT_MAX_LIFETIME_MS
export const OC_BASH_TOMBSTONE_MAX = 64
export const OC_BASH_SNAPSHOT_PREVIEW_MAX_CHARS = 240
export const KILL_GRACE_MS = EXEC_ENV_JOB_DEFAULT_KILL_GRACE_MS
export const CLOSE_DRAIN_SAFETY_MS = EXEC_ENV_JOB_DEFAULT_CLOSE_DRAIN_MS

const JOB_LIFECYCLE_CLASS_SET: ReadonlySet<string> = new Set<string>(JOB_LIFECYCLE_CLASSES)

export function isJobLifecycleClass(value: string): value is JobLifecycleClass {
  return JOB_LIFECYCLE_CLASS_SET.has(value)
}

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
  lifecycleClass?: JobLifecycleClass
  leaseId?: string
  stdoutLogPath?: string
  stderrLogPath?: string
}

export type OcBashAction = 'wait' | 'status' | 'kill'
export type JobTerminationReason = 'killed' | 'hard_timeout' | 'idle_timeout' | 'max_lifetime'
export type JobTombstoneReason =
  | 'collected'
  | 'killed'
  | 'idle_timeout'
  | 'max_lifetime'
  | 'env_migrated'

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
      lifecycleClass?: JobLifecycleClass
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

export interface OcBashJobManagerOptions {
  idleJobTtlMs?: number
  maxJobLifetimeMs?: number
  maxActiveJobs?: number
  maxBytes?: number
  killGraceMs?: number
  closeDrainSafetyMs?: number
  trackProcessGroup?: (pid: number) => void
  untrackProcessGroup?: (pid: number | undefined) => void
  registryDir?: string | null
  sessionKey?: string
  env?: NodeJS.ProcessEnv
  leaseId?: string
  envId?: string
  defaultLifecycleClass?: JobLifecycleClass
  maxLogFileBytes?: number
}

export function sanitizeOcBashCommandPreview(
  command: string,
  maxChars = OC_BASH_SNAPSHOT_PREVIEW_MAX_CHARS,
): string {
  let text = command.replace(/\s+/g, ' ').trim()
  text = text.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)([^@\s]+)(@)/g, '$1[REDACTED]$3')
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
  text = text.replace(
    /\b([A-Za-z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH)[A-Za-z0-9_-]*)(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|[^\s"'`;|&]+)/gi,
    '$1$2[REDACTED]',
  )
  text = text.replace(
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g,
    '[REDACTED]',
  )
  if (text.length <= maxChars) return text
  const cut = Math.max(0, maxChars - 3)
  return `${text.slice(0, cut)}...`
}

export function makeCommandPreview(command: string): string {
  const singleLine = command.replace(/\s+/g, ' ').trim()
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine
}

export function sanitizeEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

export class DeltaStreamBuffer {
  private readonly inner: BoundedDeltaStreamBuffer
  private cursor = 0

  constructor(maxBytes = OC_BASH_MAX_OUTPUT_BYTES) {
    this.inner = new BoundedDeltaStreamBuffer({ maxBytes })
  }

  push(chunk: Buffer): void {
    this.inner.push(chunk)
  }

  drain(isFinal: boolean): { text: string; truncated: boolean } {
    const res = this.inner.readFrom(this.cursor, isFinal)
    this.cursor = res.nextCursor
    return { text: res.text, truncated: res.truncated }
  }

  clear(): void {
    this.inner.clear()
    this.cursor = 0
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
    } catch (err) {
      void err
    }
  }
}
