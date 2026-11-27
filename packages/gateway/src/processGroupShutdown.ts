/** Bounded process-group termination shared by the CCB supervisor and the
 * one-shot CLI engine adapters.
 *
 * Every engine spawn site uses `detached: true`, so the direct child owns a
 * process group and only a group signal reaches its tool descendants. None of
 * these waits may be unbounded: a descendant that escapes the group keeps the
 * turn's stdout open, and a caller blocked on the close barrier would never
 * write a terminal state. */

import { spawnSync as spawnSyncDefault } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import type { Readable } from 'node:stream'

type SignalTarget = {
  pid?: number | undefined
  kill(signal: NodeJS.Signals): boolean
}

export type KillProcessGroupOpts = {
  platform?: NodeJS.Platform
  kill?: (pid: number, signal?: NodeJS.Signals | number) => boolean
  spawnSync?: (
    command: string,
    args?: readonly string[],
    options?: { windowsHide?: boolean; stdio?: 'ignore' },
  ) => unknown
}

export interface ProcessTreeSnapshot {
  readonly rootPid: number
  /** Distinct escaped descendant PGIDs (excluding rootPid, PID <= 1, and gateway's own PGID). */
  readonly descendantPgids: readonly number[]
  /** Descendant PIDs (excluding rootPid, PID <= 1, gateway/parent PIDs, and detached oc-memory-mcp children). */
  readonly descendantPids: readonly number[]
}

export interface ProcessTreeOpts {
  platform?: NodeJS.Platform
  selfPid?: number
  selfPpid?: number
  selfPgid?: number
  readProcDir?: () => string[]
  readProcStat?: (pid: number) => string | null
  readProcCmdline?: (pid: number) => string | null
}

export type KillProcessTreeOpts = KillProcessGroupOpts &
  ProcessTreeOpts & {
    /** Pre-captured descendant snapshot taken BEFORE sending SIGTERM. */
    snapshot?: ProcessTreeSnapshot | null
  }

interface ParsedProcStat {
  readonly pid: number
  readonly comm: string
  readonly ppid: number
  readonly pgid: number
}

function defaultReadProcDir(): string[] {
  try {
    return readdirSync('/proc')
  } catch {
    return []
  }
}

function defaultReadProcStat(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
}

function defaultReadProcCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return null
  }
}

/**
 * Parse Linux `/proc/<pid>/stat`, safely handling comm names that contain spaces
 * or `)` by locating the LAST `)` before splitting state/ppid/pgrp.
 */
export function parseProcStat(pid: number, raw: string | null | undefined): ParsedProcStat | null {
  if (!raw) return null
  const lparen = raw.indexOf('(')
  const rparen = raw.lastIndexOf(')')
  if (lparen < 0 || rparen <= lparen) return null
  const comm = raw.slice(lparen + 1, rparen)
  const rest = raw.slice(rparen + 1).trim().split(/\s+/)
  if (rest.length < 3) return null
  const ppid = Number.parseInt(rest[1]!, 10)
  const pgid = Number.parseInt(rest[2]!, 10)
  if (!Number.isFinite(ppid) || ppid < 0 || !Number.isFinite(pgid) || pgid <= 0) return null
  return { pid, comm, ppid, pgid }
}

function isOcMemoryMcpProcess(comm: string, cmdline: string | null): boolean {
  const commLower = comm.trim().toLowerCase()
  if (commLower === 'oc-memory-mcp' || commLower.startsWith('oc-memory-mcp')) return true
  if (!cmdline) return false
  const parts = cmdline.split('\0').filter(Boolean)
  for (let i = 0; i < Math.min(parts.length, 4); i += 1) {
    const part = parts[i]!.toLowerCase()
    if (/(?:^|[/\\])oc-memory-mcp(?:\.[cm]?js)?$/.test(part)) return true
  }
  if (
    parts.length === 1 &&
    /(?:^|[\s/\\])oc-memory-mcp(?:\.[cm]?js)?(?=$|\s)/.test(parts[0]!.toLowerCase())
  ) {
    return true
  }
  return false
}

/**
 * Snapshot all descendant PIDs & escaped descendant PGIDs of `rootPid` on Linux
 * BEFORE signaling `rootPid` (so reparenting to PID 1 never loses escaped groups).
 *
 * CRITICAL PROTECTION:
 * - Never includes PID <= 1, gateway's own PID/PPID, or gateway's own PGID.
 * - Includes `oc-memory-mcp` itself (so its shutdown hook cleans up `ephemeral_turn`
 *   jobs), but NEVER descends into detached children of `oc-memory-mcp` whose PGID
 *   differs from `rootPid`'s PGID so `managed_job` / `daemon_service` jobs survive.
 */
export function snapshotDescendantProcessGroups(
  rootPid: number,
  opts?: ProcessTreeOpts,
): ProcessTreeSnapshot {
  const empty: ProcessTreeSnapshot = { rootPid, descendantPgids: [], descendantPids: [] }
  const platform = opts?.platform ?? process.platform
  if (platform !== 'linux' && !opts?.readProcDir) return empty
  if (!Number.isInteger(rootPid) || rootPid <= 1) return empty

  const selfPid = opts?.selfPid ?? process.pid
  const selfPpid = opts?.selfPpid ?? process.ppid
  const readProcDir = opts?.readProcDir ?? defaultReadProcDir
  const readProcStat = opts?.readProcStat ?? defaultReadProcStat
  const readProcCmdline = opts?.readProcCmdline ?? defaultReadProcCmdline

  const statsByPid = new Map<number, ParsedProcStat>()
  const childrenByPpid = new Map<number, number[]>()

  for (const entry of readProcDir()) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number.parseInt(entry, 10)
    if (!Number.isSafeInteger(pid) || pid <= 1) continue
    const parsed = parseProcStat(pid, readProcStat(pid))
    if (!parsed) continue
    statsByPid.set(pid, parsed)
    const siblings = childrenByPpid.get(parsed.ppid)
    if (siblings) siblings.push(pid)
    else childrenByPpid.set(parsed.ppid, [pid])
  }

  const selfPgid =
    opts?.selfPgid ??
    statsByPid.get(selfPid)?.pgid ??
    parseProcStat(selfPid, readProcStat(selfPid))?.pgid

  const isProtectedPid = (pid: number): boolean =>
    pid <= 1 || pid === selfPid || pid === selfPpid
  const isProtectedPgid = (pgid: number): boolean =>
    pgid <= 1 ||
    pgid === selfPid ||
    pgid === selfPpid ||
    (selfPgid !== undefined && pgid === selfPgid)

  if (isProtectedPid(rootPid) || isProtectedPgid(rootPid)) return empty

  const rootPgid = statsByPid.get(rootPid)?.pgid ?? rootPid
  if (isProtectedPgid(rootPgid)) return empty

  const visited = new Set<number>([rootPid])
  const queue: number[] = [rootPid]
  const descendantPids: number[] = []
  const descendantPgidSet = new Set<number>()

  // Seed any live members still in `rootPid`'s process group even if `rootPid`
  // already exited and its direct children were reparented to PID 1.
  for (const stat of statsByPid.values()) {
    if (stat.pgid !== rootPid || visited.has(stat.pid) || isProtectedPid(stat.pid)) continue
    visited.add(stat.pid)
    descendantPids.push(stat.pid)
    queue.push(stat.pid)
  }

  for (let head = 0; head < queue.length; head += 1) {
    const curPid = queue[head]!
    const curStat = statsByPid.get(curPid)
    const curIsMemoryMcp =
      curPid !== rootPid &&
      curStat !== undefined &&
      isOcMemoryMcpProcess(curStat.comm, readProcCmdline(curPid))

    const children = childrenByPpid.get(curPid)
    if (!children) continue
    for (const childPid of children) {
      if (visited.has(childPid) || isProtectedPid(childPid)) continue
      const childStat = statsByPid.get(childPid)
      if (!childStat) continue
      if (curIsMemoryMcp && childStat.pgid !== rootPgid) {
        // Detached child of oc-memory-mcp (e.g. managed_job / daemon_service): preserve it.
        continue
      }
      visited.add(childPid)
      descendantPids.push(childPid)
      if (childStat.pgid !== rootPid && childStat.pgid !== rootPgid && !isProtectedPgid(childStat.pgid)) {
        descendantPgidSet.add(childStat.pgid)
      }
      queue.push(childPid)
    }
  }

  return {
    rootPid,
    descendantPgids: [...descendantPgidSet],
    descendantPids,
  }
}

export function mergeProcessTreeSnapshots(
  a: ProcessTreeSnapshot | null | undefined,
  b: ProcessTreeSnapshot | null | undefined,
): ProcessTreeSnapshot | null {
  if (!a && !b) return null
  if (!a) return b!
  if (!b) return a
  const rootPid = b.rootPid > 0 ? b.rootPid : a.rootPid
  const pgids = new Set<number>([...a.descendantPgids, ...b.descendantPgids])
  const pids = new Set<number>([...a.descendantPids, ...b.descendantPids])
  return {
    rootPid,
    descendantPgids: [...pgids],
    descendantPids: [...pids],
  }
}

export function killProcessTree(
  proc: SignalTarget,
  signal: NodeJS.Signals,
  opts?: KillProcessTreeOpts,
): ProcessTreeSnapshot {
  const pid = proc.pid
  const platform = opts?.platform ?? process.platform
  const groupKill = opts?.kill ?? process.kill.bind(process)
  const selfPid = opts?.selfPid ?? process.pid
  const selfPpid = opts?.selfPpid ?? process.ppid
  const selfPgid =
    opts?.selfPgid ??
    (platform === 'linux' && typeof selfPid === 'number'
      ? parseProcStat(selfPid, (opts?.readProcStat ?? defaultReadProcStat)(selfPid))?.pgid
      : undefined)

  const snapshot =
    opts?.snapshot ??
    (typeof pid === 'number' && pid > 1
      ? snapshotDescendantProcessGroups(pid, opts)
      : { rootPid: pid ?? 0, descendantPgids: [], descendantPids: [] })

  const isProtectedTarget = (id: number): boolean =>
    id <= 1 ||
    id === selfPid ||
    id === selfPpid ||
    (selfPgid !== undefined && id === selfPgid)

  if (typeof pid !== 'number' || !isProtectedTarget(pid)) {
    killProcessGroup(proc, signal, opts)
  }

  if (platform !== 'win32') {
    for (const pgid of snapshot.descendantPgids) {
      if (pgid === pid || isProtectedTarget(pgid)) continue
      try {
        groupKill(-pgid, signal)
      } catch {
        /* process group already exited or inaccessible */
      }
    }
  }

  return snapshot
}

export function shutdownTimeoutMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

export function waitForCloseWithin(
  closePromise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (closed: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(closed)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    closePromise.then(() => finish(true))
  })
}

export function killProcessGroup(
  proc: SignalTarget,
  signal: NodeJS.Signals,
  opts?: KillProcessGroupOpts,
): void {
  const platform = opts?.platform ?? process.platform
  const groupKill = opts?.kill ?? process.kill.bind(process)
  const pid = proc.pid

  if (platform === 'win32') {
    if (typeof pid === 'number' && pid > 0) {
      const spawnSync = opts?.spawnSync ?? spawnSyncDefault
      try {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
        })
      } catch {
        /* Job Object would be better; P2 uses taskkill /T. Fall back below. */
      }
    }
    try {
      proc.kill(signal)
    } catch {
      /* ignore */
    }
    return
  }

  try {
    if (typeof pid === 'number' && pid > 0) {
      groupKill(-pid, signal)
      return
    }
  } catch {
    // Fall back to the direct child if the detached process group is already
    // gone or unavailable on this platform.
  }
  try {
    proc.kill(signal)
  } catch {
    /* ignore */
  }
}

/** Drop our read ends of a child's stdio.
 *
 * A descendant that outlived a process-group SIGKILL still owns the write
 * ends, so 'close' never fires and the fds stay pinned for as long as the
 * gateway runs. Releasing our side both frees them and is usually what finally
 * lets 'close' fire. */
export function detachChildStdio(proc: {
  stdout?: Readable | null
  stderr?: Readable | null
}): void {
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue
    try {
      stream.removeAllListeners('data')
      // An unhandled 'error' from the teardown itself would take the gateway
      // down, and nothing above this point listens on the streams.
      stream.on('error', () => {})
      stream.destroy()
    } catch {
      /* already torn down */
    }
  }
}
