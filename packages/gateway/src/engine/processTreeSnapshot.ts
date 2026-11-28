/**
 * Linux `/proc` process-tree discovery, start-time-fenced PGID identity tracking,
 * and turn-tag orphan scanning for bounded CLI process-group teardown.
 *
 * Extracted as a cohesive `gateway-engines` module so `processGroupShutdown.ts`
 * stays well under the 800-line production module budget.
 */

import {
  isParsedProcAlive,
  parseProcStatFull,
  verifyProcGroupByStartTicks,
  type ParsedProcStat as VerifiedProcStat,
  type ProcGroupVerifyReader,
} from '@openclaude/protocol'
import {
  collectTrackedPgids,
  parseNumericProcEntry,
  parseProcStat,
  readLinuxProcFilesAsync,
  type ParsedProcStat,
} from './linuxProcDiscovery.js'

export {
  collectTrackedPgids,
  parseNumericProcEntry,
  parseProcStat,
  readLinuxProcFilesAsync,
  type ParsedProcStat,
}

export interface TrackedProcessGroupIdentity {
  readonly pgid: number
  readonly minStartTicks: number | null
  readonly memberStartTicks: ReadonlyArray<readonly [number, number]>
  readonly turnReapTag?: string
  readonly provenByTurnTag?: boolean
}

export interface ProcessTreeSnapshot {
  readonly rootPid: number
  readonly rootIdentity?: TrackedProcessGroupIdentity | null
  readonly rootAlive?: boolean
  readonly turnReapTag?: string
  /** Set when `/proc` enumeration or stat reads degraded on this pass; prevents premature drain release. */
  readonly scanIncomplete?: boolean
  /** Distinct escaped descendant PGIDs (excluding rootPid, PID <= 1, and gateway's own PGID). */
  readonly descendantPgids: readonly number[]
  /** Verified start-time and turn-ownership identities for `descendantPgids`. */
  readonly descendantGroups?: readonly TrackedProcessGroupIdentity[]
  /** Descendant PIDs (excluding rootPid, PID <= 1, gateway/parent PIDs, and detached oc-memory-mcp children). */
  readonly descendantPids: readonly number[]
}

export interface ProcessTreeOpts {
  platform?: NodeJS.Platform
  selfPid?: number
  selfPpid?: number
  selfPgid?: number
  /** Per-turn ownership tag (`OPENCLAUDE_TURN_REAP_TAG`) so orphaned escaped-PGID workers remain discoverable after rootPid exits. */
  turnReapTag?: string
  /** Previous snapshot so refreshes verify root identity BEFORE walking `rootPid` children (prevents recycled-root adoption). */
  prevSnapshot?: ProcessTreeSnapshot | null
  readProcDir?: () => string[]
  readProcStat?: (pid: number) => string | null
  readProcCmdline?: (pid: number) => string | null
  readProcEnviron?: (pid: number) => string | null
}

export interface LiveProcView {
  readonly stats: ReadonlyMap<number, VerifiedProcStat>
  readonly turnTaggedPids?: ReadonlySet<number>
  readonly unreadablePids?: ReadonlySet<number>
  readonly scanDegraded?: boolean
  readonly environChecked: boolean
}

export interface GroupVerifyContext {
  readonly reader: ProcGroupVerifyReader | null
  readonly expectedTag?: string
  readonly unreadablePids?: ReadonlySet<number>
  readonly scanDegraded?: boolean
  readonly checkPidTurnTag?: (pid: number) => boolean | null
}

export const TURN_REAP_TAG_ENV = 'OPENCLAUDE_TURN_REAP_TAG'
export const LIFECYCLE_CLASS_ENV = 'OPENCLAUDE_LIFECYCLE_CLASS'

function isOcMemoryMcpProcess(comm: string, cmdline: string | null): boolean {
  const commLower = comm.trim().toLowerCase()
  if (commLower === 'oc-memory-mcp' || commLower.startsWith('oc-memory-mcp')) return true
  if (!cmdline) return false
  const parts = cmdline.split('\0').filter(Boolean)
  for (let i = 0; i < Math.min(parts.length, 4); i += 1) {
    const part = parts[i]!.toLowerCase()
    if (/(?:^|[/\\])oc-memory-mcp(?:\.[cm]?js)?$/.test(part)) return true
  }
  return (
    parts.length === 1 &&
    /(?:^|[\s/\\])oc-memory-mcp(?:\.[cm]?js)?(?=$|\s)/.test(parts[0]!.toLowerCase())
  )
}

export function buildProcGraphFromEntries(
  entries: readonly string[],
  readStat: (pid: number) => string | null,
  explicitUnreadablePids?: ReadonlySet<number>,
): {
  statsByPid: Map<number, ParsedProcStat>
  childrenByPpid: Map<number, number[]>
  verifiedStatsByPid: Map<number, VerifiedProcStat>
  unreadablePids: Set<number>
} {
  const statsByPid = new Map<number, ParsedProcStat>()
  const childrenByPpid = new Map<number, number[]>()
  const verifiedStatsByPid = new Map<number, VerifiedProcStat>()
  const unreadablePids = new Set<number>(explicitUnreadablePids)
  for (const entry of entries) {
    const pid = parseNumericProcEntry(entry)
    if (pid === null) continue
    const raw = readStat(pid)
    const parsed = parseProcStat(pid, raw)
    const verified = raw ? parseProcStatFull(raw) : null
    if (!parsed || !verified) {
      if (!explicitUnreadablePids) unreadablePids.add(pid)
      continue
    }
    statsByPid.set(pid, parsed)
    verifiedStatsByPid.set(pid, verified)
    const siblings = childrenByPpid.get(parsed.ppid)
    if (siblings) siblings.push(pid)
    else childrenByPpid.set(parsed.ppid, [pid])
  }
  return { statsByPid, childrenByPpid, verifiedStatsByPid, unreadablePids }
}

function buildGroupIdentity(
  pgid: number,
  verifiedStatsByPid: ReadonlyMap<number, VerifiedProcStat>,
  turnReapTag: string | undefined,
  turnTaggedPids?: ReadonlySet<number>,
): TrackedProcessGroupIdentity {
  const leader = verifiedStatsByPid.get(pgid) ?? null
  let minStartTicks: number | null = null
  const leaderMatches = isParsedProcAlive(leader) && leader.pgrp === pgid
  if (leaderMatches) minStartTicks = leader.startTimeTicks
  const members: Array<readonly [number, number]> = []
  let provenByTurnTag = false
  for (const [pid, stat] of verifiedStatsByPid.entries()) {
    if (!isParsedProcAlive(stat) || stat.pgrp !== pgid) continue
    members.push([pid, stat.startTimeTicks])
    if (turnTaggedPids?.has(pid)) provenByTurnTag = true
    if (!leaderMatches && (minStartTicks === null || stat.startTimeTicks < minStartTicks)) {
      minStartTicks = stat.startTimeTicks
    }
  }
  return {
    pgid,
    minStartTicks,
    memberStartTicks: members,
    ...(turnReapTag ? { turnReapTag } : {}),
    ...(provenByTurnTag ? { provenByTurnTag: true } : {}),
  }
}

function verifySurvivorMembersWhenLeaderGone(
  identity: TrackedProcessGroupIdentity,
  ctx: GroupVerifyContext,
  reader: ProcGroupVerifyReader,
): boolean {
  const knownMembers = new Map<number, number>(identity.memberStartTicks)
  for (const pid of reader.listProcPids()) {
    if (pid === identity.pgid) continue
    const stat = reader.readProcStat(pid)
    if (!isParsedProcAlive(stat) || stat.pgrp !== identity.pgid || stat.startTimeTicks < identity.minStartTicks!) {
      continue
    }
    if (knownMembers.get(pid) === stat.startTimeTicks) return true
    if (ctx.expectedTag && ctx.checkPidTurnTag?.(pid) === true) return true
  }
  return false
}

export function isTrackedGroupVerifiedAlive(
  identity: TrackedProcessGroupIdentity | null | undefined,
  ctx: GroupVerifyContext,
): boolean {
  if (!identity || !ctx.reader || identity.minStartTicks === null) return false
  if (ctx.expectedTag && identity.turnReapTag && identity.turnReapTag !== ctx.expectedTag) {
    return false
  }
  if (!verifyProcGroupByStartTicks(identity.pgid, identity.minStartTicks, ctx.reader)) {
    return false
  }
  const leader = ctx.reader.readProcStat(identity.pgid)
  if (isParsedProcAlive(leader) && leader.pgrp === identity.pgid) {
    return leader.startTimeTicks === identity.minStartTicks
  }
  return verifySurvivorMembersWhenLeaderGone(identity, ctx, ctx.reader)
}

export function hasUnverifiedTrackedMember(
  identity: TrackedProcessGroupIdentity | null | undefined,
  ctx: GroupVerifyContext,
): boolean {
  if (!identity || identity.minStartTicks === null) return false
  if (!ctx.reader || ctx.scanDegraded) return true
  if (ctx.unreadablePids?.has(identity.pgid)) return true
  for (const [memberPid] of identity.memberStartTicks) {
    if (ctx.unreadablePids?.has(memberPid)) return true
  }
  return false
}

export function buildVerifyContextFromProcView(
  procView: LiveProcView | undefined,
  expectedTag: string | undefined,
): GroupVerifyContext {
  if (!procView) return { reader: null, expectedTag, scanDegraded: true }
  return {
    reader: {
      readProcStat: (pid) => procView.stats.get(pid) ?? null,
      listProcPids: () => [...procView.stats.keys()],
    },
    expectedTag,
    ...(procView.unreadablePids ? { unreadablePids: procView.unreadablePids } : {}),
    ...(procView.scanDegraded ? { scanDegraded: true } : {}),
    ...(procView.environChecked
      ? { checkPidTurnTag: (pid: number) => Boolean(procView.turnTaggedPids?.has(pid)) }
      : {}),
  }
}

export function createProcProtectionGuard(
  selfPid: number,
  selfPpid: number,
  selfPgid: number | undefined,
): {
  isProtectedPid: (pid: number) => boolean
  isProtectedPgid: (pgid: number) => boolean
} {
  return {
    isProtectedPid: (pid: number) => pid <= 1 || pid === selfPid || pid === selfPpid,
    isProtectedPgid: (pgid: number) =>
      pgid <= 1 || pgid === selfPid || pgid === selfPpid || (selfPgid !== undefined && pgid === selfPgid),
  }
}

function hasSurvivableLifecycleEnviron(rawEnviron: string | null): boolean {
  if (!rawEnviron) return false
  for (const entry of rawEnviron.split('\0')) {
    if (
      entry === `${LIFECYCLE_CLASS_ENV}=managed_job` ||
      entry === `${LIFECYCLE_CLASS_ENV}=daemon_service`
    ) {
      return true
    }
  }
  return false
}

export function matchesTurnReapEnviron(rawEnviron: string | null, turnReapTag: string | undefined): boolean {
  if (!rawEnviron || !turnReapTag) return false
  if (hasSurvivableLifecycleEnviron(rawEnviron)) return false
  const expected = `${TURN_REAP_TAG_ENV}=${turnReapTag}`
  return rawEnviron.split('\0').includes(expected)
}

function enqueueDescendantChildren(input: {
  curPid: number
  rootPid: number
  rootPgid: number
  curIsMemoryMcp: boolean
  children: readonly number[]
  statsByPid: ReadonlyMap<number, ParsedProcStat>
  readEnviron: (pid: number) => string | null
  visited: Set<number>
  descendantPids: number[]
  descendantPgidSet: Set<number>
  queue: number[]
  isProtectedPid: (pid: number) => boolean
  isProtectedPgid: (pgid: number) => boolean
}): void {
  for (const childPid of input.children) {
    const childStat = input.statsByPid.get(childPid)
    if (!childStat || input.visited.has(childPid) || input.isProtectedPid(childPid)) continue
    if (input.curIsMemoryMcp && childStat.pgid !== input.rootPgid) continue
    if (childStat.pgid !== input.rootPgid && hasSurvivableLifecycleEnviron(input.readEnviron(childPid))) {
      continue
    }
    input.visited.add(childPid)
    input.descendantPids.push(childPid)
    if (childStat.pgid !== input.rootPid && childStat.pgid !== input.rootPgid && !input.isProtectedPgid(childStat.pgid)) {
      input.descendantPgidSet.add(childStat.pgid)
    }
    input.queue.push(childPid)
  }
}

function seedTurnTaggedOrphanRoots(input: {
  rootPid: number
  rootPgid: number
  turnReapTag: string | undefined
  statsByPid: ReadonlyMap<number, ParsedProcStat>
  readCmdline: (pid: number) => string | null
  readEnviron: (pid: number) => string | null
  visited: Set<number>
  descendantPids: number[]
  descendantPgidSet: Set<number>
  queue: number[]
  isProtectedPid: (pid: number) => boolean
  isProtectedPgid: (pgid: number) => boolean
}): void {
  if (!input.turnReapTag) return
  for (const stat of input.statsByPid.values()) {
    if (input.visited.has(stat.pid) || input.isProtectedPid(stat.pid)) continue
    const parentStat = input.statsByPid.get(stat.ppid)
    if (
      parentStat &&
      stat.pgid !== input.rootPgid &&
      isOcMemoryMcpProcess(parentStat.comm, input.readCmdline(parentStat.pid))
    ) {
      continue
    }
    if (!matchesTurnReapEnviron(input.readEnviron(stat.pid), input.turnReapTag)) continue
    input.visited.add(stat.pid)
    input.descendantPids.push(stat.pid)
    if (stat.pgid !== input.rootPid && stat.pgid !== input.rootPgid && !input.isProtectedPgid(stat.pgid)) {
      input.descendantPgidSet.add(stat.pgid)
    }
    input.queue.push(stat.pid)
  }
}

function collectTurnTaggedPids(
  statsByPid: ReadonlyMap<number, ParsedProcStat>,
  readEnviron: (pid: number) => string | null,
  turnReapTag: string | undefined,
): Set<number> | undefined {
  if (!turnReapTag) return undefined
  const tagged = new Set<number>()
  for (const pid of statsByPid.keys()) {
    if (matchesTurnReapEnviron(readEnviron(pid), turnReapTag)) tagged.add(pid)
  }
  return tagged
}

export function buildLiveProcView(
  statsByPid: ReadonlyMap<number, ParsedProcStat>,
  verifiedStatsByPid: ReadonlyMap<number, VerifiedProcStat>,
  readEnviron: (pid: number) => string | null,
  turnReapTag: string | undefined,
  environAvailable: boolean,
  unreadablePids?: ReadonlySet<number>,
  scanDegraded?: boolean,
): LiveProcView {
  const turnTaggedPids = environAvailable ? collectTurnTaggedPids(statsByPid, readEnviron, turnReapTag) : undefined
  return {
    stats: verifiedStatsByPid,
    ...(turnTaggedPids ? { turnTaggedPids } : {}),
    ...(unreadablePids && unreadablePids.size > 0 ? { unreadablePids } : {}),
    ...(scanDegraded ? { scanDegraded: true } : {}),
    environChecked: Boolean(turnReapTag && environAvailable),
  }
}

function canWalkRootProcessGroup(
  rootPid: number,
  prevRootIdentity: TrackedProcessGroupIdentity | null | undefined,
  verifiedStatsByPid: ReadonlyMap<number, VerifiedProcStat>,
  verifyCtx: GroupVerifyContext,
  turnTaggedPids?: ReadonlySet<number>,
): { walkLeaderChildren: boolean; walkRootGroupMembers: boolean; rootIdentity: TrackedProcessGroupIdentity } {
  if (prevRootIdentity !== undefined) {
    const rootAlive = isTrackedGroupVerifiedAlive(prevRootIdentity, verifyCtx)
    const leader = verifiedStatsByPid.get(rootPid) ?? null
    const leaderIsOriginal =
      rootAlive &&
      isParsedProcAlive(leader) &&
      leader.pgrp === rootPid &&
      leader.startTimeTicks === prevRootIdentity?.minStartTicks
    const freshRoot = buildGroupIdentity(rootPid, verifiedStatsByPid, prevRootIdentity?.turnReapTag, turnTaggedPids)
    const mergedRoot =
      prevRootIdentity && rootAlive ? mergeGroupMemberTicks(prevRootIdentity, freshRoot) : (prevRootIdentity ?? freshRoot)
    return {
      walkLeaderChildren: leaderIsOriginal,
      walkRootGroupMembers: rootAlive,
      rootIdentity: mergedRoot,
    }
  }
  const freshRoot = buildGroupIdentity(rootPid, verifiedStatsByPid, verifyCtx.expectedTag, turnTaggedPids)
  if (verifyCtx.expectedTag && !freshRoot.provenByTurnTag) {
    return {
      walkLeaderChildren: false,
      walkRootGroupMembers: false,
      rootIdentity: {
        pgid: rootPid,
        minStartTicks: null,
        memberStartTicks: [],
        turnReapTag: verifyCtx.expectedTag,
      },
    }
  }
  const leader = verifiedStatsByPid.get(rootPid) ?? null
  return {
    walkLeaderChildren: isParsedProcAlive(leader) && leader.pgrp === rootPid,
    walkRootGroupMembers: isTrackedGroupVerifiedAlive(freshRoot, verifyCtx),
    rootIdentity: freshRoot,
  }
}

function finalizeWalkedSnapshot(input: {
  rootPid: number
  turnReapTag: string | undefined
  rootIdentity: TrackedProcessGroupIdentity
  prevSnapshot: ProcessTreeSnapshot | null | undefined
  verifiedStatsByPid: ReadonlyMap<number, VerifiedProcStat>
  procView: LiveProcView
  descendantPgidSet: ReadonlySet<number>
  descendantPids: number[]
}): ProcessTreeSnapshot {
  const verifyCtx = buildVerifyContextFromProcView(input.procView, input.turnReapTag)
  const rootVerifiedAlive = isTrackedGroupVerifiedAlive(input.rootIdentity, verifyCtx)
  const rootRetainedUnverified =
    !rootVerifiedAlive &&
    Boolean(input.prevSnapshot?.rootAlive && hasUnverifiedTrackedMember(input.rootIdentity, verifyCtx))
  const rootAlive = rootVerifiedAlive || rootRetainedUnverified
  const freshGroups = [...input.descendantPgidSet].map((pgid) =>
    buildGroupIdentity(pgid, input.verifiedStatsByPid, input.turnReapTag, input.procView.turnTaggedPids),
  )
  const descendantGroups = input.prevSnapshot
    ? mergeVerifiedDescendantGroups(input.prevSnapshot.descendantGroups ?? [], freshGroups, verifyCtx, rootVerifiedAlive)
    : freshGroups
  const mergedPids = input.prevSnapshot
    ? [...new Set<number>([...input.prevSnapshot.descendantPids, ...input.descendantPids])]
    : input.descendantPids
  const scanIncomplete = Boolean(
    input.procView.scanDegraded || (input.turnReapTag && (input.procView.unreadablePids?.size ?? 0) > 0),
  )
  return {
    rootPid: input.rootPid,
    rootIdentity: input.rootIdentity,
    rootAlive,
    ...(input.turnReapTag ? { turnReapTag: input.turnReapTag } : {}),
    ...(scanIncomplete ? { scanIncomplete: true } : {}),
    descendantPgids: descendantGroups.map((g) => g.pgid),
    descendantGroups,
    descendantPids: mergedPids,
  }
}

function seedVerifiedRootMembers(input: {
  rootPid: number
  walkLeaderChildren: boolean
  walkRootGroupMembers: boolean
  statsByPid: ReadonlyMap<number, ParsedProcStat>
  isProtectedPid: (pid: number) => boolean
  visited: Set<number>
  descendantPids: number[]
  queue: number[]
}): void {
  if (input.walkLeaderChildren) {
    input.visited.add(input.rootPid)
    input.queue.push(input.rootPid)
  }
  if (!input.walkRootGroupMembers) return
  for (const stat of input.statsByPid.values()) {
    if (stat.pgid === input.rootPid && !input.visited.has(stat.pid) && !input.isProtectedPid(stat.pid)) {
      input.visited.add(stat.pid)
      input.descendantPids.push(stat.pid)
      input.queue.push(stat.pid)
    }
  }
}

export interface WalkProcessGraphInput {
  rootPid: number
  turnReapTag?: string
  prevSnapshot?: ProcessTreeSnapshot | null
  statsByPid: ReadonlyMap<number, ParsedProcStat>
  childrenByPpid: ReadonlyMap<number, readonly number[]>
  verifiedStatsByPid: ReadonlyMap<number, VerifiedProcStat>
  unreadablePids?: ReadonlySet<number>
  scanDegraded?: boolean
  readCmdline: (pid: number) => string | null
  readEnviron: (pid: number) => string | null
  environAvailable: boolean
  selfPid: number
  selfPpid: number
  selfPgid: number | undefined
}

function drainDescendantQueue(
  input: WalkProcessGraphInput,
  queue: number[],
  visited: Set<number>,
  descendantPids: number[],
  descendantPgidSet: Set<number>,
  isProtectedPid: (pid: number) => boolean,
  isProtectedPgid: (pgid: number) => boolean,
): void {
  for (let head = 0; head < queue.length; head += 1) {
    const curPid = queue[head]!
    const curStat = input.statsByPid.get(curPid)
    const curIsMemoryMcp =
      curPid !== input.rootPid && curStat !== undefined && isOcMemoryMcpProcess(curStat.comm, input.readCmdline(curPid))
    enqueueDescendantChildren({
      curPid,
      rootPid: input.rootPid,
      rootPgid: input.rootPid,
      curIsMemoryMcp,
      children: input.childrenByPpid.get(curPid) ?? [],
      statsByPid: input.statsByPid,
      readEnviron: input.readEnviron,
      visited,
      descendantPids,
      descendantPgidSet,
      queue,
      isProtectedPid,
      isProtectedPgid,
    })
  }
}

export function walkDescendantProcessGraph(input: WalkProcessGraphInput): ProcessTreeSnapshot {
  const { rootPid, statsByPid, verifiedStatsByPid, readCmdline, readEnviron } = input
  const turnReapTag = input.turnReapTag ?? input.prevSnapshot?.turnReapTag
  const procView = buildLiveProcView(
    statsByPid,
    verifiedStatsByPid,
    readEnviron,
    turnReapTag,
    input.environAvailable,
    input.unreadablePids,
    input.scanDegraded,
  )
  const { isProtectedPid, isProtectedPgid } = createProcProtectionGuard(input.selfPid, input.selfPpid, input.selfPgid)
  const rootPgid = statsByPid.get(rootPid)?.pgid ?? rootPid
  if (isProtectedPid(rootPid) || isProtectedPgid(rootPid) || isProtectedPgid(rootPgid)) {
    return {
      rootPid,
      rootIdentity: null,
      rootAlive: false,
      ...(turnReapTag ? { turnReapTag } : {}),
      descendantPgids: [],
      descendantGroups: [],
      descendantPids: [],
    }
  }

  const verifyCtx = buildVerifyContextFromProcView(procView, turnReapTag)
  const rootCheck = canWalkRootProcessGroup(
    rootPid,
    input.prevSnapshot?.rootIdentity,
    verifiedStatsByPid,
    verifyCtx,
    procView.turnTaggedPids,
  )
  const visited = new Set<number>()
  const queue: number[] = []
  const descendantPids: number[] = []
  const descendantPgidSet = new Set<number>()

  seedVerifiedRootMembers({
    rootPid,
    walkLeaderChildren: rootCheck.walkLeaderChildren,
    walkRootGroupMembers: rootCheck.walkRootGroupMembers,
    statsByPid,
    isProtectedPid,
    visited,
    descendantPids,
    queue,
  })
  seedTurnTaggedOrphanRoots({
    rootPid,
    rootPgid: rootCheck.walkRootGroupMembers ? rootPgid : rootPid,
    turnReapTag,
    statsByPid,
    readCmdline,
    readEnviron,
    visited,
    descendantPids,
    descendantPgidSet,
    queue,
    isProtectedPid,
    isProtectedPgid,
  })
  drainDescendantQueue(input, queue, visited, descendantPids, descendantPgidSet, isProtectedPid, isProtectedPgid)
  return finalizeWalkedSnapshot({
    rootPid,
    turnReapTag,
    rootIdentity: rootCheck.rootIdentity,
    prevSnapshot: input.prevSnapshot,
    verifiedStatsByPid,
    procView,
    descendantPgidSet,
    descendantPids,
  })
}

export function snapshotDescendantProcessGroups(
  rootPid: number,
  opts?: ProcessTreeOpts,
): ProcessTreeSnapshot {
  const effectiveTag = opts?.turnReapTag ?? opts?.prevSnapshot?.turnReapTag
  const empty: ProcessTreeSnapshot = {
    rootPid,
    ...(effectiveTag ? { turnReapTag: effectiveTag } : {}),
    descendantPgids: [],
    descendantGroups: [],
    descendantPids: [],
  }
  if (!Number.isInteger(rootPid) || rootPid <= 1 || !opts?.readProcDir) return empty
  let rawEntries: string[]
  try {
    rawEntries = opts.readProcDir()
  } catch (err) {
    void err
    return { ...(opts.prevSnapshot ?? empty), scanIncomplete: true }
  }
  if (rawEntries.length === 0) return { ...(opts.prevSnapshot ?? empty), scanIncomplete: true }
  const readStat = opts.readProcStat ?? (() => null)
  const readCmdline = opts.readProcCmdline ?? (() => null)
  const readEnviron = opts.readProcEnviron ?? (() => null)
  const selfPid = opts.selfPid ?? process.pid
  const selfPpid = opts.selfPpid ?? process.ppid
  const { statsByPid, childrenByPpid, verifiedStatsByPid, unreadablePids } = buildProcGraphFromEntries(
    rawEntries,
    readStat,
  )
  const selfPgid = opts.selfPgid ?? statsByPid.get(selfPid)?.pgid ?? parseProcStat(selfPid, readStat(selfPid))?.pgid
  return walkDescendantProcessGraph({
    rootPid,
    turnReapTag: effectiveTag,
    prevSnapshot: opts.prevSnapshot,
    statsByPid,
    childrenByPpid,
    verifiedStatsByPid,
    unreadablePids,
    readCmdline,
    readEnviron,
    environAvailable: Boolean(opts.readProcEnviron),
    selfPid,
    selfPpid,
    selfPgid,
  })
}

export async function snapshotDescendantProcessGroupsAsync(
  rootPid: number,
  opts?: ProcessTreeOpts,
): Promise<ProcessTreeSnapshot> {
  if (opts?.readProcDir) return snapshotDescendantProcessGroups(rootPid, opts)
  const effectiveTag = opts?.turnReapTag ?? opts?.prevSnapshot?.turnReapTag
  const empty: ProcessTreeSnapshot = {
    rootPid,
    ...(effectiveTag ? { turnReapTag: effectiveTag } : {}),
    descendantPgids: [],
    descendantGroups: [],
    descendantPids: [],
  }
  const platform = opts?.platform ?? process.platform
  if (platform !== 'linux' || !Number.isInteger(rootPid) || rootPid <= 1) return empty

  const needEnviron = Boolean(effectiveTag)
  const trackedPgids = collectTrackedPgids(rootPid, opts?.prevSnapshot)
  const { entries, statTexts, cmdlineTexts, environTexts, unreadablePids, scanDegraded } =
    await readLinuxProcFilesAsync(needEnviron, trackedPgids)
  if (entries.length === 0 || scanDegraded) {
    return { ...(opts?.prevSnapshot ?? empty), scanIncomplete: true }
  }

  const selfPid = opts?.selfPid ?? process.pid
  const selfPpid = opts?.selfPpid ?? process.ppid
  const { statsByPid, childrenByPpid, verifiedStatsByPid } = buildProcGraphFromEntries(
    entries,
    (pid) => statTexts.get(pid) ?? null,
    unreadablePids,
  )
  const selfPgid = opts?.selfPgid ?? statsByPid.get(selfPid)?.pgid
  return walkDescendantProcessGraph({
    rootPid,
    turnReapTag: effectiveTag,
    prevSnapshot: opts?.prevSnapshot,
    statsByPid,
    childrenByPpid,
    verifiedStatsByPid,
    unreadablePids,
    scanDegraded,
    readCmdline: (pid) => cmdlineTexts.get(pid) ?? null,
    readEnviron: opts?.readProcEnviron ?? ((pid) => environTexts.get(pid) ?? null),
    environAvailable: needEnviron,
    selfPid,
    selfPpid,
    selfPgid,
  })
}

export function mergeGroupMemberTicks(
  prev: TrackedProcessGroupIdentity,
  fresh: TrackedProcessGroupIdentity | undefined,
): TrackedProcessGroupIdentity {
  if (!fresh || fresh.minStartTicks !== prev.minStartTicks) return prev
  const mergedMembers = new Map<number, number>(prev.memberStartTicks)
  for (const [pid, ticks] of fresh.memberStartTicks) {
    if (ticks >= (prev.minStartTicks ?? 0)) mergedMembers.set(pid, ticks)
  }
  const tag = prev.turnReapTag ?? fresh.turnReapTag
  const proven = Boolean(prev.provenByTurnTag || fresh.provenByTurnTag)
  return {
    pgid: prev.pgid,
    minStartTicks: prev.minStartTicks,
    memberStartTicks: [...mergedMembers.entries()],
    ...(tag ? { turnReapTag: tag } : {}),
    ...(proven ? { provenByTurnTag: true } : {}),
  }
}

function mergeVerifiedDescendantGroups(
  prevGroups: readonly TrackedProcessGroupIdentity[],
  freshGroups: readonly TrackedProcessGroupIdentity[],
  freshCtx: GroupVerifyContext,
  rootAlive: boolean,
): TrackedProcessGroupIdentity[] {
  const freshByPgid = new Map<number, TrackedProcessGroupIdentity>()
  for (const g of freshGroups) freshByPgid.set(g.pgid, g)

  const prevSeenPgids = new Set<number>()
  const merged = new Map<number, TrackedProcessGroupIdentity>()
  for (const prevGroup of prevGroups) {
    prevSeenPgids.add(prevGroup.pgid)
    if (isTrackedGroupVerifiedAlive(prevGroup, freshCtx)) {
      merged.set(prevGroup.pgid, mergeGroupMemberTicks(prevGroup, freshByPgid.get(prevGroup.pgid)))
    } else if (hasUnverifiedTrackedMember(prevGroup, freshCtx)) {
      merged.set(prevGroup.pgid, prevGroup)
    }
  }
  for (const freshGroup of freshGroups) {
    if (prevSeenPgids.has(freshGroup.pgid)) continue
    if (!rootAlive && !freshGroup.provenByTurnTag) continue
    if (isTrackedGroupVerifiedAlive(freshGroup, freshCtx)) {
      merged.set(freshGroup.pgid, freshGroup)
    }
  }
  return [...merged.values()]
}
