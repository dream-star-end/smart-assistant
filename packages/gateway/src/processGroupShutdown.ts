/** Bounded process-group termination shared by the CCB supervisor and the
 * one-shot CLI engine adapters.
 *
 * Every engine spawn site uses `detached: true`, so the direct child owns a
 * process group and only a group signal reaches its tool descendants. None of
 * these waits may be unbounded: a descendant that escapes the group keeps the
 * turn's stdout open, and a caller blocked on the close barrier would never
 * write a terminal state. */

import { spawnSync as spawnSyncDefault } from 'node:child_process'
import type { Readable } from 'node:stream'
import { parseProcStatFull } from '@openclaude/protocol'
import {
  buildLiveProcView,
  buildProcGraphFromEntries,
  buildVerifyContextFromProcView,
  collectTrackedPgids,
  createProcProtectionGuard,
  hasUnverifiedTrackedMember,
  isTrackedGroupVerifiedAlive,
  LIFECYCLE_CLASS_ENV,
  matchesTurnReapEnviron,
  mergeGroupMemberTicks,
  parseNumericProcEntry,
  parseProcStat,
  readLinuxProcFilesAsync,
  snapshotDescendantProcessGroups,
  snapshotDescendantProcessGroupsAsync,
  TURN_REAP_TAG_ENV,
  walkDescendantProcessGraph,
  type GroupVerifyContext,
  type ProcessTreeOpts,
  type ProcessTreeSnapshot,
  type TrackedProcessGroupIdentity,
} from './engine/processTreeSnapshot.js'

export {
  LIFECYCLE_CLASS_ENV,
  parseProcStat,
  snapshotDescendantProcessGroups,
  snapshotDescendantProcessGroupsAsync,
  TURN_REAP_TAG_ENV,
  type ProcessTreeOpts,
  type ProcessTreeSnapshot,
  type TrackedProcessGroupIdentity,
}

function mergeSnapshotRootState(
  a: ProcessTreeSnapshot,
  b: ProcessTreeSnapshot,
): { rootIdentity: TrackedProcessGroupIdentity | null; rootAlive: boolean } {
  const aRoot = a.rootIdentity ?? null
  const bRoot = b.rootIdentity ?? null
  if (aRoot?.minStartTicks == null) {
    return { rootIdentity: bRoot ?? aRoot, rootAlive: Boolean(b.rootAlive) }
  }
  const sameRoot = bRoot?.minStartTicks != null && aRoot.minStartTicks === bRoot.minStartTicks
  return {
    rootIdentity: sameRoot ? mergeGroupMemberTicks(aRoot, bRoot ?? undefined) : aRoot,
    rootAlive: Boolean(sameRoot && b.rootAlive),
  }
}

function mergeSnapshotDescendantGroupsStatic(
  prevGroups: readonly TrackedProcessGroupIdentity[],
  freshGroups: readonly TrackedProcessGroupIdentity[],
  rootAlive: boolean,
): TrackedProcessGroupIdentity[] {
  const freshByPgid = new Map<number, TrackedProcessGroupIdentity>()
  for (const g of freshGroups) freshByPgid.set(g.pgid, g)
  const merged = new Map<number, TrackedProcessGroupIdentity>()
  const prevSeen = new Set<number>()
  for (const prevGroup of prevGroups) {
    prevSeen.add(prevGroup.pgid)
    const matchingFresh = freshByPgid.get(prevGroup.pgid)
    if (matchingFresh && matchingFresh.minStartTicks === prevGroup.minStartTicks) {
      merged.set(prevGroup.pgid, mergeGroupMemberTicks(prevGroup, matchingFresh))
    }
  }
  for (const freshGroup of freshGroups) {
    if (!prevSeen.has(freshGroup.pgid) && (rootAlive || freshGroup.provenByTurnTag)) {
      merged.set(freshGroup.pgid, freshGroup)
    }
  }
  return [...merged.values()]
}

export function mergeProcessTreeSnapshots(
  a: ProcessTreeSnapshot | null | undefined,
  b: ProcessTreeSnapshot | null | undefined,
): ProcessTreeSnapshot | null {
  if (!a || !b) return b ?? a ?? null
  const rootPid = b.rootPid > 0 ? b.rootPid : a.rootPid
  const turnReapTag = b.turnReapTag ?? a.turnReapTag
  const { rootIdentity, rootAlive } = mergeSnapshotRootState(a, b)
  const descendantGroups = mergeSnapshotDescendantGroupsStatic(
    a.descendantGroups ?? [],
    b.descendantGroups ?? [],
    rootAlive,
  )
  return {
    rootPid,
    rootIdentity,
    rootAlive,
    ...(turnReapTag ? { turnReapTag } : {}),
    ...(b.scanIncomplete ? { scanIncomplete: true } : {}),
    descendantPgids: descendantGroups.map((g) => g.pgid),
    descendantGroups,
    descendantPids: [...new Set<number>([...a.descendantPids, ...b.descendantPids])],
  }
}

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

export type KillProcessTreeOpts = KillProcessGroupOpts &
  ProcessTreeOpts & {
    /** Pre-captured descendant snapshot taken BEFORE sending SIGTERM. */
    snapshot?: ProcessTreeSnapshot | null
  }

function buildSyncVerifyContextForKill(
  opts: KillProcessTreeOpts | undefined,
  snapshot: ProcessTreeSnapshot,
): GroupVerifyContext {
  const expectedTag = opts?.turnReapTag ?? snapshot.turnReapTag
  if (!opts?.readProcStat) return { reader: null, expectedTag, scanDegraded: true }
  const readStatFn = opts.readProcStat
  const readDirFn = opts.readProcDir
  const readEnvFn = opts.readProcEnviron
  let dirReadFailed = !readDirFn
  let rawEntries: string[] = []
  if (readDirFn) {
    try {
      rawEntries = readDirFn()
      if (rawEntries.length === 0) dirReadFailed = true
    } catch (err) {
      void err
      dirReadFailed = true
    }
  }
  const dirPids = rawEntries.map(parseNumericProcEntry).filter((x): x is number => x !== null)
  const unreadablePids = new Set<number>()
  for (const pid of dirPids) {
    const raw = readStatFn(pid)
    if (!raw || !parseProcStatFull(raw)) unreadablePids.add(pid)
  }
  return {
    reader: {
      readProcStat: (pid) => {
        const raw = readStatFn(pid)
        return raw ? parseProcStatFull(raw) : null
      },
      listProcPids: () => dirPids,
    },
    expectedTag,
    ...(unreadablePids.size > 0 ? { unreadablePids } : {}),
    ...(dirReadFailed ? { scanDegraded: true } : {}),
    ...(readEnvFn && expectedTag
      ? { checkPidTurnTag: (pid: number) => matchesTurnReapEnviron(readEnvFn(pid), expectedTag) }
      : {}),
  }
}

function resolveKillSelfPgid(
  platform: NodeJS.Platform,
  selfPid: number,
  opts: KillProcessTreeOpts | undefined,
): number | undefined {
  if (opts?.selfPgid !== undefined) return opts.selfPgid
  if (platform === 'linux' && opts?.readProcStat) {
    return parseProcStat(selfPid, opts.readProcStat(selfPid))?.pgid
  }
  return undefined
}

function resolveKillSnapshot(pid: number | undefined, opts: KillProcessTreeOpts | undefined): ProcessTreeSnapshot {
  if (opts?.snapshot) return opts.snapshot
  if (typeof pid === 'number' && pid > 1) return snapshotDescendantProcessGroups(pid, opts)
  return { rootPid: pid ?? 0, descendantPgids: [], descendantGroups: [], descendantPids: [] }
}

function signalVerifiedDescendantGroups(input: {
  groups: readonly TrackedProcessGroupIdentity[]
  rootPid: number | undefined
  platform: NodeJS.Platform
  verifyCtx: GroupVerifyContext
  isProtectedPgid: (pgid: number) => boolean
  groupKill: (pid: number, signal?: NodeJS.Signals | number) => boolean
  signal: NodeJS.Signals
}): TrackedProcessGroupIdentity[] {
  if (input.platform === 'win32') return []
  const surviving: TrackedProcessGroupIdentity[] = []
  for (const group of input.groups) {
    if (group.pgid === input.rootPid || input.isProtectedPgid(group.pgid)) continue
    const verifiedAlive = input.platform !== 'linux' || isTrackedGroupVerifiedAlive(group, input.verifyCtx)
    if (!verifiedAlive) {
      if (input.platform === 'linux' && hasUnverifiedTrackedMember(group, input.verifyCtx)) {
        surviving.push(group)
      }
      continue
    }
    surviving.push(group)
    try {
      input.groupKill(-group.pgid, input.signal)
    } catch (err) {
      void err
    }
  }
  return surviving
}

function executeVerifiedKillWithContext(input: {
  proc: SignalTarget
  signal: NodeJS.Signals
  opts: KillProcessTreeOpts | undefined
  snapshot: ProcessTreeSnapshot
  platform: NodeJS.Platform
  selfPid: number
  selfPpid: number
  selfPgid: number | undefined
  verifyCtx: GroupVerifyContext
  requireVerifiedRoot: boolean
}): ProcessTreeSnapshot {
  const pid = input.proc.pid
  const groupKill = input.opts?.kill ?? process.kill.bind(process)
  const { isProtectedPgid } = createProcProtectionGuard(input.selfPid, input.selfPpid, input.selfPgid)
  const rootVerifiedForSignal =
    !input.requireVerifiedRoot || isTrackedGroupVerifiedAlive(input.snapshot.rootIdentity, input.verifyCtx)
  const rootRetainedUnverified =
    !rootVerifiedForSignal &&
    input.platform === 'linux' &&
    Boolean(input.snapshot.rootAlive && hasUnverifiedTrackedMember(input.snapshot.rootIdentity, input.verifyCtx))

  if ((typeof pid !== 'number' || !isProtectedPgid(pid)) && rootVerifiedForSignal) {
    killProcessGroup(input.proc, input.signal, input.opts)
  }

  const survivingGroups = signalVerifiedDescendantGroups({
    groups: input.snapshot.descendantGroups ?? [],
    rootPid: pid,
    platform: input.platform,
    verifyCtx: input.verifyCtx,
    isProtectedPgid,
    groupKill,
    signal: input.signal,
  })
  const { scanIncomplete: _prevInc, ...snapBase } = input.snapshot
  const nextIncomplete =
    input.platform === 'linux' &&
    Boolean(
      input.verifyCtx.scanDegraded ||
        (input.verifyCtx.expectedTag && (input.verifyCtx.unreadablePids?.size ?? 0) > 0),
    )
  return {
    ...snapBase,
    rootAlive: input.requireVerifiedRoot
      ? rootVerifiedForSignal || rootRetainedUnverified
      : input.snapshot.rootAlive,
    ...(nextIncomplete ? { scanIncomplete: true } : {}),
    descendantGroups: survivingGroups,
    descendantPgids: survivingGroups.map((g) => g.pgid),
  }
}

export function killProcessTree(
  proc: SignalTarget,
  signal: NodeJS.Signals,
  opts?: KillProcessTreeOpts,
): ProcessTreeSnapshot {
  const pid = proc.pid
  const platform = opts?.platform ?? process.platform
  const selfPid = opts?.selfPid ?? process.pid
  const selfPpid = opts?.selfPpid ?? process.ppid
  const selfPgid = resolveKillSelfPgid(platform, selfPid, opts)
  const snapshot = resolveKillSnapshot(pid, opts)
  const verifyCtx = platform === 'linux' ? buildSyncVerifyContextForKill(opts, snapshot) : { reader: null }
  const requireVerifiedRoot = platform === 'linux' && Boolean(opts?.snapshot || opts?.readProcStat)
  return executeVerifiedKillWithContext({
    proc,
    signal,
    opts,
    snapshot,
    platform,
    selfPid,
    selfPpid,
    selfPgid,
    verifyCtx,
    requireVerifiedRoot,
  })
}

/**
 * Async Linux-safe process-tree signal sender that ALWAYS re-reads live `/proc`
 * identity right before sending `SIGTERM` / `SIGKILL`, never trusting stale views.
 */
export async function killProcessTreeAsync(
  proc: SignalTarget,
  signal: NodeJS.Signals,
  opts?: KillProcessTreeOpts,
): Promise<ProcessTreeSnapshot> {
  const platform = opts?.platform ?? process.platform
  if (opts?.readProcStat || platform !== 'linux') {
    const refreshed =
      typeof proc.pid === 'number' && proc.pid > 1 && opts?.readProcDir
        ? snapshotDescendantProcessGroups(proc.pid, { ...opts, prevSnapshot: opts.snapshot })
        : opts?.snapshot
    return killProcessTree(proc, signal, { ...opts, snapshot: refreshed })
  }
  const pid = proc.pid
  const expectedTag = opts?.turnReapTag ?? opts?.snapshot?.turnReapTag
  const needEnviron = Boolean(expectedTag)
  const trackedPgids = collectTrackedPgids(pid, opts?.snapshot)
  const { entries, statTexts, cmdlineTexts, environTexts, unreadablePids, scanDegraded } =
    await readLinuxProcFilesAsync(needEnviron, trackedPgids)
  const selfPid = opts?.selfPid ?? process.pid
  const selfPpid = opts?.selfPpid ?? process.ppid
  const { statsByPid, childrenByPpid, verifiedStatsByPid } = buildProcGraphFromEntries(
    entries,
    (p) => statTexts.get(p) ?? null,
    unreadablePids,
  )
  const selfPgid = opts?.selfPgid ?? statsByPid.get(selfPid)?.pgid
  const baseSnapshot =
    typeof pid === 'number' && pid > 1 && entries.length > 0 && !scanDegraded
      ? walkDescendantProcessGraph({
          rootPid: pid,
          turnReapTag: expectedTag,
          prevSnapshot: opts?.snapshot,
          statsByPid,
          childrenByPpid,
          verifiedStatsByPid,
          unreadablePids,
          scanDegraded,
          readCmdline: (p) => cmdlineTexts.get(p) ?? null,
          readEnviron: (p) => environTexts.get(p) ?? null,
          environAvailable: needEnviron,
          selfPid,
          selfPpid,
          selfPgid,
        })
      : (opts?.snapshot ?? {
          rootPid: pid ?? 0,
          ...(expectedTag ? { turnReapTag: expectedTag } : {}),
          descendantPgids: [],
          descendantGroups: [],
          descendantPids: [],
        })
  const liveProcView = buildLiveProcView(
    statsByPid,
    verifiedStatsByPid,
    (p) => environTexts.get(p) ?? null,
    expectedTag,
    needEnviron,
    unreadablePids,
    scanDegraded || entries.length === 0,
  )
  const verifyCtx = buildVerifyContextFromProcView(liveProcView, expectedTag)
  return executeVerifiedKillWithContext({
    proc,
    signal,
    opts,
    snapshot: baseSnapshot,
    platform,
    selfPid,
    selfPpid,
    selfPgid,
    verifyCtx,
    requireVerifiedRoot: true,
  })
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
