/**
 * Bounded CLI process-tree reaper and deferred FIFO swarm-slot drain guard.
 *
 * Separates turn drain completion (bounded timeout so user turns never hang)
 * from swarm concurrency slot release (held in background until residual
 * turn-tagged processes actually exit).
 */

import type { ChildProcess } from 'node:child_process'
import {
  detachChildStdio,
  killProcessTreeAsync,
  snapshotDescendantProcessGroupsAsync,
  type KillProcessTreeOpts,
  type ProcessTreeSnapshot,
} from '../processGroupShutdown.js'

export function isProcessGroupAlive(
  pid: number | undefined,
  killFn: (pid: number, signal?: NodeJS.Signals | number) => boolean = process.kill.bind(process),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (typeof pid !== 'number' || pid <= 1 || platform === 'win32') return false
  try {
    killFn(-pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'EPERM'
  }
}

export function hasAnyTrackedProcessGroupAlive(
  pid: number | undefined,
  snapshot: ProcessTreeSnapshot | null | undefined,
  killFn: (pid: number, signal?: NodeJS.Signals | number) => boolean = process.kill.bind(process),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (snapshot?.rootAlive !== false && isProcessGroupAlive(pid, killFn, platform)) return true
  if (!snapshot) return false
  for (const pgid of snapshot.descendantPgids) {
    if (isProcessGroupAlive(pgid, killFn, platform)) return true
  }
  return false
}

function waitUntilProcessTreeReaped(
  proc: ChildProcess,
  isClosed: () => boolean,
  isReaped: () => boolean,
  ms: number,
  pollIntervalMs: number,
): Promise<boolean> {
  if (isReaped()) return Promise.resolve(true)
  if (ms <= 0) return Promise.resolve(false)
  return new Promise<boolean>((resolveWait) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poller)
      proc.removeListener('close', check)
      resolveWait(ok)
    }
    const check = () => {
      if (isReaped()) finish(true)
    }
    const timer = setTimeout(() => finish(isReaped()), ms)
    const poller = setInterval(check, Math.min(pollIntervalMs, ms))
    poller.unref()
    if (!isClosed()) proc.once('close', check)
  })
}

async function refreshSnapshotIfPidValid(
  pid: number | undefined,
  prev: ProcessTreeSnapshot | null,
  treeOpts: KillProcessTreeOpts | undefined,
): Promise<ProcessTreeSnapshot | null> {
  if (typeof pid !== 'number' || pid <= 1) return prev
  return snapshotDescendantProcessGroupsAsync(pid, { ...treeOpts, prevSnapshot: prev })
}

function isSnapshotFullyDrained(isReaped: () => boolean, snapshot: ProcessTreeSnapshot | null): boolean {
  if (snapshot?.scanIncomplete) return false
  return isReaped() && (snapshot?.descendantPgids.length ?? 0) === 0
}

async function runSingleReapSignalPass(input: {
  proc: ChildProcess
  pid: number | undefined
  snapshot: ProcessTreeSnapshot | null
  isClosed: () => boolean
  isReaped: () => boolean
  treeOpts: KillProcessTreeOpts | undefined
  termGraceMs: number
  killGraceMs: number
  pollIntervalMs: number
}): Promise<{ snapshot: ProcessTreeSnapshot | null; reaped: boolean; retryNewOrphans: boolean }> {
  let snapshot: ProcessTreeSnapshot | null = await killProcessTreeAsync(input.proc, 'SIGTERM', {
    ...input.treeOpts,
    snapshot: input.snapshot,
  })
  if (await waitUntilProcessTreeReaped(input.proc, input.isClosed, input.isReaped, input.termGraceMs, input.pollIntervalMs)) {
    snapshot = await refreshSnapshotIfPidValid(input.pid, snapshot, input.treeOpts)
    const done = isSnapshotFullyDrained(input.isReaped, snapshot)
    return { snapshot, reaped: done, retryNewOrphans: !done }
  }
  snapshot = await killProcessTreeAsync(input.proc, 'SIGKILL', { ...input.treeOpts, snapshot })
  if (await waitUntilProcessTreeReaped(input.proc, input.isClosed, input.isReaped, input.killGraceMs, input.pollIntervalMs)) {
    snapshot = await refreshSnapshotIfPidValid(input.pid, snapshot, input.treeOpts)
    const done = isSnapshotFullyDrained(input.isReaped, snapshot)
    return { snapshot, reaped: done, retryNewOrphans: !done }
  }
  return { snapshot, reaped: false, retryNewOrphans: false }
}

export interface ReapCliOptions {
  naturalExitGraceMs?: number
  termGraceMs?: number
  killGraceMs?: number
  pollIntervalMs?: number
  snapshot?: ProcessTreeSnapshot | null
  treeOpts?: KillProcessTreeOpts
  onTimeout?: () => void
}

function resolveReapTimings(opts: ReapCliOptions | undefined): {
  naturalExitGraceMs: number
  termGraceMs: number
  killGraceMs: number
  pollIntervalMs: number
} {
  return {
    naturalExitGraceMs: Math.max(0, opts?.naturalExitGraceMs ?? 150),
    termGraceMs: Math.max(20, opts?.termGraceMs ?? 800),
    killGraceMs: Math.max(20, opts?.killGraceMs ?? 400),
    pollIntervalMs: Math.max(10, opts?.pollIntervalMs ?? 25),
  }
}

async function reapLingeringCliProcessGroupDetailed(
  proc: ChildProcess | null,
  isClosed: () => boolean,
  opts?: ReapCliOptions,
): Promise<{ reaped: boolean; snapshot: ProcessTreeSnapshot | null }> {
  if (!proc) return { reaped: true, snapshot: opts?.snapshot ?? null }
  const pid = proc.pid
  const treeOpts = opts?.treeOpts
  const killFn = treeOpts?.kill ?? process.kill.bind(process)
  const platform = treeOpts?.platform ?? process.platform

  let snapshot: ProcessTreeSnapshot | null = opts?.snapshot ?? null
  const isReaped = (): boolean =>
    isClosed() && !hasAnyTrackedProcessGroupAlive(pid, snapshot, killFn, platform)

  if (!treeOpts?.turnReapTag && isReaped()) return { reaped: true, snapshot }
  snapshot = await refreshSnapshotIfPidValid(pid, snapshot, treeOpts)
  if (isSnapshotFullyDrained(isReaped, snapshot)) return { reaped: true, snapshot }

  const timings = resolveReapTimings(opts)
  if (
    timings.naturalExitGraceMs > 0 &&
    (await waitUntilProcessTreeReaped(proc, isClosed, isReaped, timings.naturalExitGraceMs, timings.pollIntervalMs))
  ) {
    snapshot = await refreshSnapshotIfPidValid(pid, snapshot, treeOpts)
    if (isSnapshotFullyDrained(isReaped, snapshot)) return { reaped: true, snapshot }
  }

  for (let pass = 0; pass < 3; pass += 1) {
    const step = await runSingleReapSignalPass({
      proc,
      pid,
      snapshot,
      isClosed,
      isReaped,
      treeOpts,
      ...timings,
    })
    snapshot = step.snapshot
    if (step.reaped) return { reaped: true, snapshot }
    if (!step.retryNewOrphans) break
  }

  snapshot = await refreshSnapshotIfPidValid(pid, snapshot, treeOpts)
  if (isSnapshotFullyDrained(isReaped, snapshot)) return { reaped: true, snapshot }
  if (!isClosed()) detachChildStdio(proc)
  opts?.onTimeout?.()
  return { reaped: false, snapshot }
}

export async function reapLingeringCliProcessGroup(
  proc: ChildProcess | null,
  isClosed: () => boolean,
  opts?: ReapCliOptions,
): Promise<boolean> {
  const res = await reapLingeringCliProcessGroupDetailed(proc, isClosed, opts)
  return res.reaped
}

function scheduleDeferredSwarmSlotRelease(input: {
  proc: ChildProcess
  isClosed: () => boolean
  release: () => void
  initialSnapshot: ProcessTreeSnapshot | null
  treeOpts: KillProcessTreeOpts | undefined
  retryIntervalMs: number
  passivePollIntervalMs: number
  maxKillAttempts: number
}): void {
  const pid = input.proc.pid
  const killFn = input.treeOpts?.kill ?? process.kill.bind(process)
  const platform = input.treeOpts?.platform ?? process.platform
  let snapshot = input.initialSnapshot
  const isReaped = (): boolean =>
    input.isClosed() && !hasAnyTrackedProcessGroupAlive(pid, snapshot, killFn, platform)

  let attempts = 0
  let busy = false
  let done = false

  const scheduleNext = (delayMs: number) => {
    if (done) return
    const timer = setTimeout(tick, delayMs)
    timer.unref()
  }

  const tick = () => {
    if (done || busy) return
    busy = true
    attempts += 1
    void (async () => {
      try {
        if (attempts <= input.maxKillAttempts) {
          snapshot = await killProcessTreeAsync(input.proc, 'SIGKILL', { ...input.treeOpts, snapshot })
        }
        snapshot = await refreshSnapshotIfPidValid(pid, snapshot, input.treeOpts)
        if (isSnapshotFullyDrained(isReaped, snapshot)) {
          done = true
          input.release()
          return
        }
        const nextDelay = attempts < input.maxKillAttempts ? input.retryIntervalMs : input.passivePollIntervalMs
        scheduleNext(nextDelay)
      } finally {
        busy = false
      }
    })()
  }

  scheduleNext(input.retryIntervalMs)
}

/**
 * Release a local swarm FIFO slot ONLY after the CLI process group (and any
 * captured or turn-tagged escaped descendant PGIDs) is confirmed reaped.
 * If the bounded reap times out (`false`), the caller's wait completes promptly
 * while bounded SIGKILL retries + passive drain checks hold the concurrency slot
 * until the residual processes actually exit.
 */
export async function releaseSwarmSlotAfterBoundedReap(
  proc: ChildProcess | null,
  isClosed: () => boolean,
  release: (() => void) | null,
  opts?: {
    naturalExitGraceMs?: number
    termGraceMs?: number
    killGraceMs?: number
    backgroundRetryIntervalMs?: number
    passivePollIntervalMs?: number
    maxBackgroundAttempts?: number
    snapshot?: ProcessTreeSnapshot | null
    treeOpts?: KillProcessTreeOpts
    onTimeout?: () => void
  },
): Promise<boolean> {
  if (!release) return true
  if (
    !proc ||
    (isClosed() &&
      !opts?.treeOpts?.turnReapTag &&
      !hasAnyTrackedProcessGroupAlive(proc.pid, opts?.snapshot))
  ) {
    release()
    return true
  }
  const { reaped, snapshot } = await reapLingeringCliProcessGroupDetailed(proc, isClosed, {
    naturalExitGraceMs: opts?.naturalExitGraceMs ?? 0,
    termGraceMs: opts?.termGraceMs ?? 800,
    killGraceMs: opts?.killGraceMs ?? 400,
    snapshot: opts?.snapshot,
    treeOpts: opts?.treeOpts,
    onTimeout: opts?.onTimeout,
  })
  if (reaped) {
    release()
    return true
  }
  const retryIntervalMs = Math.max(15, opts?.backgroundRetryIntervalMs ?? 250)
  scheduleDeferredSwarmSlotRelease({
    proc,
    isClosed,
    release,
    initialSnapshot: snapshot,
    treeOpts: opts?.treeOpts,
    retryIntervalMs,
    passivePollIntervalMs: Math.max(retryIntervalMs, opts?.passivePollIntervalMs ?? 1_000),
    maxKillAttempts: Math.max(1, opts?.maxBackgroundAttempts ?? 240),
  })
  return false
}
