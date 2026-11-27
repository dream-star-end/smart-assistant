/**
 * Local Antigravity native swarm concurrency gate, durable billing builder,
 * process-group reaper, and killed native worktree hygiene (OCV5-887).
 *
 * Extracted into its own `gateway-engines` module so `antigravityAdapter.ts`
 * stays comfortably below the 2,000-line yellow-zone ratchet limit.
 */
import { execFileSync, type ChildProcess } from 'node:child_process'
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { EngineBillingEvent, EngineExternalBillingEvent } from './engineEvents.js'
import { engineSessionId } from './engineSessionId.js'
import {
  detachChildStdio,
  killProcessTree,
  mergeProcessTreeSnapshots,
  snapshotDescendantProcessGroupsAsync,
  type KillProcessTreeOpts,
  type ProcessTreeSnapshot,
} from '../processGroupShutdown.js'
import type { AntigravityRouteRenewResult } from '../delegateAntigravityRoute.js'

/**
 * Default max concurrent local native Antigravity CLI swarm processes per user container.
 * `0` means uncapped (no FIFO queueing by default). Operators on memory-constrained hosts
 * can still opt into an explicit cap via `OC_MAX_CONCURRENT_LOCAL_SWARMS=<N>` (`N >= 1`).
 */
export const DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS = 0

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SWARM_BRANCH_RE = /^swarm\/[A-Za-z0-9._/-]{1,120}$/
const MAX_ROSTER_BYTES = 512 * 1024

interface SwarmSlotWaiter {
  cancelled: boolean
  readonly limit: number
  grant: (release: () => void) => void
  abort: () => void
}

let activeLocalSwarms = 0
let limitOverrideForTests: number | null = null
const waitQueue: SwarmSlotWaiter[] = []

export function parseLocalSwarmConcurrencyCap(raw: string | undefined): number {
  const clean = (raw ?? '').trim().toLowerCase()
  if (!clean || clean === '0' || clean === 'unlimited' || clean === 'inf' || clean === 'infinity') {
    return Number.POSITIVE_INFINITY
  }
  const parsed = Number.parseInt(clean, 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : Number.POSITIVE_INFINITY
}

function effectiveSwarmLimit(overrideLimit?: number): number {
  if (limitOverrideForTests !== null) {
    return Number.isFinite(limitOverrideForTests) && limitOverrideForTests >= 1
      ? Math.floor(limitOverrideForTests)
      : Number.POSITIVE_INFINITY
  }
  if (overrideLimit !== undefined) {
    return Number.isFinite(overrideLimit) && overrideLimit >= 1
      ? Math.floor(overrideLimit)
      : Number.POSITIVE_INFINITY
  }
  return DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS >= 1
    ? DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS
    : Number.POSITIVE_INFINITY
}

export function setLocalSwarmConcurrencyLimitForTests(limit: number | null): void {
  limitOverrideForTests = limit
  drainWaitQueue()
}

export function getLocalSwarmConcurrencyStateForTests(): {
  active: number
  queued: number
  limit: number
} {
  return {
    active: activeLocalSwarms,
    queued: waitQueue.filter((w) => !w.cancelled).length,
    limit: effectiveSwarmLimit(),
  }
}

function makeSlotRelease(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    activeLocalSwarms = Math.max(0, activeLocalSwarms - 1)
    drainWaitQueue()
  }
}

function drainWaitQueue(): void {
  while (waitQueue.length > 0) {
    const next = waitQueue[0]!
    if (next.cancelled) {
      waitQueue.shift()
      continue
    }
    const effectiveCap = limitOverrideForTests !== null ? effectiveSwarmLimit() : next.limit
    if (activeLocalSwarms >= effectiveCap) break
    waitQueue.shift()
    activeLocalSwarms += 1
    next.grant(makeSlotRelease())
  }
}

export interface LocalSwarmSlotAcquisition {
  readonly waited: boolean
  readonly promise: Promise<() => void>
  readonly cancel: () => void
}

function sleepShort(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })
}

export async function probeRouteLease(
  onRenewRoute: () => Promise<boolean | AntigravityRouteRenewResult>,
): Promise<AntigravityRouteRenewResult> {
  try {
    const res = await onRenewRoute()
    if (res === true || res === 'ok') return 'ok'
    if (res === 'unconfigured') return 'unconfigured'
    if (res === false || res === 'revoked') return 'revoked'
    return 'transient_error'
  } catch {
    return 'transient_error'
  }
}

export async function awaitLocalAntigravitySwarmSlotIfActive(opts: {
  compactionMode: string | undefined
  keepaliveMs: number
  renewRouteIntervalMs?: number
  transientRetryDelayMs?: number
  maxConcurrent?: number
  onStatus: (detail: string) => void
  onHeartbeat: () => void
  onRenewRoute?: () => Promise<boolean | AntigravityRouteRenewResult>
  onRenewWarn?: (outcome: 'transient_error') => void
  setRelease: (fn: (() => void) | null) => void
  now?: () => number
}): Promise<{ waited: boolean }> {
  if (opts.compactionMode !== 'on_full' && opts.compactionMode !== 'on_resumed') {
    return { waited: false }
  }
  const nowFn = opts.now ?? Date.now
  const slot = acquireLocalAntigravitySwarmSlot({
    maxConcurrent: opts.maxConcurrent,
    onWaitStart: (active, limit, pos) => {
      opts.onStatus(`等待蜂群容器内存槽位（运行中 ${active}/${limit}，排队 #${pos}）…`)
    },
  })
  opts.setRelease(slot.cancel)
  const renewEveryMs = Math.max(50, opts.renewRouteIntervalMs ?? 60_000)
  const tickMs = Math.max(20, Math.min(opts.keepaliveMs, renewEveryMs))
  let lastRenewAt = nowFn()
  let renewBusy = false
  const hb = slot.waited
    ? setInterval(() => {
        opts.onHeartbeat()
        if (opts.onRenewRoute && !renewBusy && nowFn() - lastRenewAt >= renewEveryMs) {
          lastRenewAt = nowFn()
          renewBusy = true
          void probeRouteLease(opts.onRenewRoute).finally(() => {
            renewBusy = false
          })
        }
      }, tickMs)
    : null
  hb?.unref()
  let release: (() => void) | null = null
  try {
    release = await slot.promise
    opts.setRelease(release)
  } finally {
    if (hb) clearInterval(hb)
  }
  // B8 + P2-03: If we waited in FIFO queue, verify/renew the minted relay route BEFORE spawning CLI.
  // Fail closed ONLY on explicit revocation (`revoked` / `false`); on transient master/network failures
  // (e.g. brief 503 during restart), retry once with short backoff, warn, and allow healthy swarm launch.
  if (slot.waited && opts.onRenewRoute) {
    let outcome = await probeRouteLease(opts.onRenewRoute)
    if (outcome === 'transient_error') {
      const retryDelayMs = Math.max(0, opts.transientRetryDelayMs ?? 250)
      if (retryDelayMs > 0) await sleepShort(retryDelayMs)
      outcome = await probeRouteLease(opts.onRenewRoute)
      if (outcome === 'transient_error') {
        opts.onRenewWarn?.('transient_error')
      }
    }
    if (outcome === 'revoked') {
      release()
      opts.setRelease(null)
      throw new Error('ANTIGRAVITY_ROUTE_EXPIRED_IN_QUEUE: relay route expired while waiting for swarm slot')
    }
  }
  return { waited: slot.waited }
}

export function acquireLocalAntigravitySwarmSlot(opts?: {
  maxConcurrent?: number
  onWaitStart?: (active: number, limit: number, position: number) => void
}): LocalSwarmSlotAcquisition {
  const limit = effectiveSwarmLimit(opts?.maxConcurrent)
  if (activeLocalSwarms < limit) {
    activeLocalSwarms += 1
    const release = makeSlotRelease()
    return {
      waited: false,
      promise: Promise.resolve(release),
      cancel: () => release(),
    }
  }

  let settled = false
  let grantedRelease: (() => void) | null = null
  let waiterRef!: SwarmSlotWaiter
  const promise = new Promise<() => void>((resolveSlot, rejectSlot) => {
    waiterRef = {
      cancelled: false,
      limit,
      grant: (release) => {
        if (waiterRef.cancelled) {
          release()
          return
        }
        settled = true
        grantedRelease = release
        resolveSlot(release)
      },
      abort: () => {
        if (settled) return
        settled = true
        rejectSlot(new Error('ANTIGRAVITY_SWARM_SLOT_CANCELLED'))
      },
    }
    waitQueue.push(waiterRef)
    const position = waitQueue.filter((w) => !w.cancelled).length
    opts?.onWaitStart?.(activeLocalSwarms, limit, position)
  })

  return {
    waited: true,
    promise,
    cancel: () => {
      if (grantedRelease) {
        const rel = grantedRelease
        grantedRelease = null
        rel()
        return
      }
      if (!waiterRef.cancelled) {
        waiterRef.cancelled = true
        const idx = waitQueue.indexOf(waiterRef)
        if (idx >= 0) waitQueue.splice(idx, 1)
        waiterRef.abort()
      }
    },
  }
}

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
  if (isProcessGroupAlive(pid, killFn, platform)) return true
  if (!snapshot) return false
  for (const pgid of snapshot.descendantPgids) {
    if (isProcessGroupAlive(pgid, killFn, platform)) return true
  }
  return false
}

/**
 * Reap a lingering CLI process group AND any escaped descendant process groups
 * on active swarm turns where background worker subprocesses keep stdio/sockets
 * open, escape into their own PGID, or outlive a leader exit.
 * Captures descendant PGIDs BEFORE sending SIGTERM -> SIGKILL so reparenting
 * to PID 1 never loses them, while preserving detached `oc-memory-mcp` children.
 */
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
  const fresh = await snapshotDescendantProcessGroupsAsync(pid, treeOpts)
  return mergeProcessTreeSnapshots(prev, fresh)
}

export async function reapLingeringCliProcessGroup(
  proc: ChildProcess | null,
  isClosed: () => boolean,
  opts?: {
    naturalExitGraceMs?: number
    termGraceMs?: number
    killGraceMs?: number
    pollIntervalMs?: number
    snapshot?: ProcessTreeSnapshot | null
    treeOpts?: KillProcessTreeOpts
    onTimeout?: () => void
  },
): Promise<void> {
  if (!proc) return
  const pid = proc.pid
  const killFn = opts?.treeOpts?.kill ?? process.kill.bind(process)
  const platform = opts?.treeOpts?.platform ?? process.platform

  let snapshot: ProcessTreeSnapshot | null = opts?.snapshot ?? null
  if (!isClosed() || hasAnyTrackedProcessGroupAlive(pid, snapshot, killFn, platform)) {
    snapshot = await refreshSnapshotIfPidValid(pid, snapshot, opts?.treeOpts)
  }

  const isReaped = (): boolean =>
    isClosed() && !hasAnyTrackedProcessGroupAlive(pid, snapshot, killFn, platform)
  if (isReaped()) return

  const naturalExitGraceMs = Math.max(0, opts?.naturalExitGraceMs ?? 150)
  const termGraceMs = Math.max(20, opts?.termGraceMs ?? 800)
  const killGraceMs = Math.max(20, opts?.killGraceMs ?? 400)
  const pollIntervalMs = Math.max(10, opts?.pollIntervalMs ?? 25)

  if (naturalExitGraceMs > 0 && (await waitUntilProcessTreeReaped(proc, isClosed, isReaped, naturalExitGraceMs, pollIntervalMs))) {
    return
  }
  snapshot = await refreshSnapshotIfPidValid(pid, snapshot, opts?.treeOpts)
  killProcessTree(proc, 'SIGTERM', { ...opts?.treeOpts, snapshot })
  if (await waitUntilProcessTreeReaped(proc, isClosed, isReaped, termGraceMs, pollIntervalMs)) return
  snapshot = await refreshSnapshotIfPidValid(pid, snapshot, opts?.treeOpts)
  killProcessTree(proc, 'SIGKILL', { ...opts?.treeOpts, snapshot })
  if (await waitUntilProcessTreeReaped(proc, isClosed, isReaped, killGraceMs, pollIntervalMs)) return
  if (!isClosed()) detachChildStdio(proc)
  opts?.onTimeout?.()
}

/**
 * Release a local swarm FIFO slot only after the CLI process group (and any
 * captured escaped descendant PGIDs) is confirmed reaped.
 */
export function releaseSwarmSlotAfterBoundedReap(
  proc: ChildProcess | null,
  isClosed: () => boolean,
  release: (() => void) | null,
  opts?: {
    naturalExitGraceMs?: number
    termGraceMs?: number
    killGraceMs?: number
    snapshot?: ProcessTreeSnapshot | null
    treeOpts?: KillProcessTreeOpts
  },
): void {
  if (!release) return
  if (
    !proc ||
    (isClosed() &&
      !opts?.treeOpts?.turnReapTag &&
      !hasAnyTrackedProcessGroupAlive(proc.pid, opts?.snapshot))
  ) {
    release()
    return
  }
  void reapLingeringCliProcessGroup(proc, isClosed, {
    naturalExitGraceMs: opts?.naturalExitGraceMs ?? 0,
    termGraceMs: opts?.termGraceMs ?? 800,
    killGraceMs: opts?.killGraceMs ?? 400,
    snapshot: opts?.snapshot,
    treeOpts: opts?.treeOpts,
  }).finally(() => {
    release()
  })
}

export function buildAntigravityDurableBillingEvent(args: {
  requestId: string
  sessionKey: string
  turnKey?: string
  parentTurnKey?: string
  parentSessionId?: string
  delegateAgentId?: string
  status: EngineExternalBillingEvent['status']
  terminalCode?: EngineExternalBillingEvent['terminalCode']
  interrupted: boolean
  budgetStop: boolean
  durationMs: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
  }
}): EngineBillingEvent {
  const durableStatus: 'success' | 'error' = args.status === 'success' ? 'success' : 'error'
  const durableTerminalCode: EngineBillingEvent['terminalCode'] =
    durableStatus === 'error' && !args.budgetStop
      ? args.terminalCode === 'USER_CANCELLED' || args.interrupted
        ? 'USER_CANCELLED'
        : args.terminalCode === 'AUTH_UNAVAILABLE'
          ? 'AUTH_UNAVAILABLE'
          : args.terminalCode === 'QUOTA_UNAVAILABLE'
            ? 'QUOTA_UNAVAILABLE'
            : 'CODEX_ERROR'
      : undefined
  return {
    requestId: args.requestId,
    engine: 'antigravity',
    ...(args.turnKey && /^[0-9a-f]{64}$/.test(args.turnKey) ? { turnKey: args.turnKey } : {}),
    ...(args.parentTurnKey ? { parentTurnKey: args.parentTurnKey } : {}),
    ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
    ...(args.delegateAgentId ? { delegateAgentId: args.delegateAgentId } : {}),
    engineSessionId: engineSessionId(args.sessionKey),
    status: durableStatus,
    ...(durableTerminalCode ? { terminalCode: durableTerminalCode } : {}),
    durationMs: Math.max(0, Math.floor(args.durationMs)),
    usage: {
      input_tokens: Math.max(0, Math.floor(args.usage.inputTokens)),
      output_tokens: Math.max(0, Math.floor(args.usage.outputTokens)),
      cache_read_input_tokens: Math.max(0, Math.floor(args.usage.cacheReadTokens)),
      cache_creation_input_tokens: Math.max(0, Math.floor(args.usage.cacheCreationTokens)),
    },
  }
}

function readSafeNativeSwarmRoster(
  brainDir: string,
  conversationId: string,
): Record<string, unknown> | null {
  if (!CONVERSATION_ID_RE.test(conversationId)) return null
  const segments = [conversationId, '.system_generated', 'swarm', 'members.json']
  let fd: number | null = null
  try {
    const rootStat = lstatSync(brainDir)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null
    let cur = brainDir
    for (let i = 0; i < segments.length - 1; i += 1) {
      cur = join(cur, segments[i]!)
      const st = lstatSync(cur)
      if (st.isSymbolicLink() || !st.isDirectory()) return null
    }
    const fullPath = join(cur, segments[segments.length - 1]!)
    const leafStat = lstatSync(fullPath)
    if (leafStat.isSymbolicLink() || !leafStat.isFile()) return null
    const flags =
      fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0)
    fd = openSync(fullPath, flags)
    const fst = fstatSync(fd)
    if (!fst.isFile() || fst.dev !== leafStat.dev || fst.ino !== leafStat.ino) return null
    if (fst.size <= 0 || fst.size > MAX_ROSTER_BYTES) return null
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

function isSafeSwarmBranchName(branch: string | null): branch is string {
  return Boolean(branch && SWARM_BRANCH_RE.test(branch) && !branch.includes('..') && !branch.includes('//'))
}

function resolveGitRepoTopLevel(dir: string | null | undefined): string | null {
  if (!dir) return null
  try {
    const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
    }).trim()
    return top ? realpathSync(top) : null
  } catch {
    return null
  }
}

/**
 * Best-effort, strictly fail-closed cleanup of registered clean git worktrees left
 * behind by `killed === true` native CLI `share`/`branch` members when a turn ends.
 *
 * B7 ownership invariants enforced BEFORE any `git worktree remove`:
 *   1. When `expectedWorkspaceCwd` is supplied, the worktree's parent repository MUST
 *      match `resolveGitRepoTopLevel(expectedWorkspaceCwd)` (cannot touch unrelated repos).
 *   2. The worktree MUST prove swarm ownership via either a `swarm/*` checked-out branch
 *      OR containment inside `<repoTop>/.oc-swarm-worktrees/` or `<brainDir>/`.
 *      Plain developer worktrees (e.g. `../wt-feature` on `feat/*`) are never removed.
 *   3. Worktree must be clean (`git status --porcelain === ''`) and both worktree HEAD
 *      and branch tip must be merged into `repoTop` `HEAD` (`git branch -d`, never `-D`).
 */
export function cleanupKilledNativeSwarmWorktrees(
  brainDir: string,
  conversationId: string | null | undefined,
  expectedWorkspaceCwd?: string | null,
): string[] {
  if (!conversationId) return []
  const roster = readSafeNativeSwarmRoster(brainDir, conversationId)
  const members = roster?.members
  if (!members || typeof members !== 'object' || Array.isArray(members)) return []

  const expectedRepoTop =
    expectedWorkspaceCwd !== undefined ? resolveGitRepoTopLevel(expectedWorkspaceCwd) : undefined
  if (expectedWorkspaceCwd !== undefined && !expectedRepoTop) return []

  let realBrainDir: string | null = null
  try {
    realBrainDir = realpathSync(brainDir)
  } catch {
    realBrainDir = null
  }

  const convLower = conversationId.toLowerCase()
  const convPrefix = convLower.slice(0, 8)
  const cleaned: string[] = []
  for (const [memberName, raw] of Object.entries(members as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const rec = raw as Record<string, unknown>
    if (rec.killed !== true) continue
    const wsMode = typeof rec.workspace_mode === 'string' ? rec.workspace_mode.trim().toLowerCase() : ''
    const wsRawPath = typeof rec.workspace === 'string' ? rec.workspace.trim() : ''
    if ((wsMode !== 'share' && wsMode !== 'branch') || !wsRawPath.startsWith('/')) continue
    const resolvedWt = resolve(wsRawPath)
    if (!existsSync(resolvedWt)) continue
    try {
      const wtStat = lstatSync(resolvedWt)
      if (wtStat.isSymbolicLink() || !wtStat.isDirectory()) continue
      const realWt = realpathSync(resolvedWt)
      const commonGitDir = execFileSync('git', ['-C', realWt, 'rev-parse', '--git-common-dir'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3_000,
      }).trim()
      if (!commonGitDir) continue
      const absCommonGit = realpathSync(resolve(realWt, commonGitDir))
      const repoTop = dirname(absCommonGit)
      if (!repoTop || repoTop === realWt) continue
      if (expectedRepoTop && repoTop !== expectedRepoTop) continue

      const porcelain = execFileSync('git', ['-C', repoTop, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 4_000,
      })
      const blocks = porcelain.split(/\n\n+/)
      let registeredNonMain = false
      let checkedOutBranch: string | null = null
      for (let i = 1; i < blocks.length; i += 1) {
        const lines = blocks[i]!.split('\n')
        const wtLine = lines.find((l) => l.startsWith('worktree '))
        if (!wtLine) continue
        const entryReal = existsSync(wtLine.slice('worktree '.length).trim())
          ? realpathSync(wtLine.slice('worktree '.length).trim())
          : resolve(wtLine.slice('worktree '.length).trim())
        if (entryReal !== realWt) continue
        registeredNonMain = true
        const brLine = lines.find((l) => l.startsWith('branch refs/heads/'))
        if (brLine) checkedOutBranch = brLine.slice('branch refs/heads/'.length).trim()
        break
      }
      if (!registeredNonMain) continue

      // B7 + P1-11: Require strict current-conversation ownership (NEVER match sibling
      // conversations under `realBrainDir`, and never remove detached HEAD worktrees
      // outside this conversation's own brain subdir).
      const convBrainDir = realBrainDir !== null ? join(realBrainDir, conversationId) : null
      const underSessionBrain = convBrainDir !== null && realWt.startsWith(`${convBrainDir}${sep}`)
      const memberLower = memberName.trim().toLowerCase()
      const brainSegments = underSessionBrain
        ? realWt.slice(convBrainDir!.length + 1).toLowerCase().split(sep).filter(Boolean)
        : []
      const brainPathMatchesMember =
        memberLower.length > 0 && brainSegments.some((seg) => seg === memberLower)
      const stripConvPrefix = (s: string): string | null => {
        if (s.startsWith(`${convLower}/`) || s.startsWith(`${convLower}-`)) return s.slice(convLower.length + 1)
        if (s.startsWith(`${convPrefix}/`) || s.startsWith(`${convPrefix}-`)) return s.slice(convPrefix.length + 1)
        return null
      }
      const swarmWorktreeDir = join(repoTop, '.oc-swarm-worktrees')
      const relFromSwarmDir = realWt.startsWith(`${swarmWorktreeDir}${sep}`)
        ? realWt.slice(swarmWorktreeDir.length + 1).toLowerCase()
        : null
      const dirTail = relFromSwarmDir ? stripConvPrefix(relFromSwarmDir) : null
      const underConvSwarmDir =
        dirTail !== null &&
        memberLower.length > 0 &&
        (dirTail === memberLower || dirTail.startsWith(`${memberLower}${sep}`))
      const branchLower = checkedOutBranch?.toLowerCase() ?? ''
      const hasSwarmBranchOwnership = isSafeSwarmBranchName(checkedOutBranch)
      const branchTail = hasSwarmBranchOwnership ? stripConvPrefix(branchLower.slice('swarm/'.length)) : null
      const branchMatchesThisMember =
        branchTail !== null &&
        memberLower.length > 0 &&
        (branchTail === memberLower || branchTail.startsWith(`${memberLower}/`))
      if (checkedOutBranch === null) {
        if (!underSessionBrain || !brainPathMatchesMember) continue
      } else {
        if (!hasSwarmBranchOwnership) continue
        if ((!underSessionBrain || !brainPathMatchesMember) && !branchMatchesThisMember) continue
        if (relFromSwarmDir !== null && !underSessionBrain && !underConvSwarmDir) continue
      }

      const dirty = execFileSync('git', ['-C', realWt, 'status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 4_000,
      }).trim()
      if (dirty.length > 0) continue

      const wtHead = execFileSync('git', ['-C', realWt, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3_000,
      }).trim()
      if (!wtHead) continue
      execFileSync('git', ['-C', repoTop, 'merge-base', '--is-ancestor', wtHead, 'HEAD'], {
        stdio: 'ignore',
        timeout: 3_000,
      })
      if (hasSwarmBranchOwnership && checkedOutBranch !== null) {
        execFileSync(
          'git',
          ['-C', repoTop, 'merge-base', '--is-ancestor', `refs/heads/${checkedOutBranch}`, 'HEAD'],
          { stdio: 'ignore', timeout: 3_000 },
        )
      }

      execFileSync('git', ['-C', repoTop, 'worktree', 'remove', realWt], {
        stdio: 'ignore',
        timeout: 8_000,
      })
      cleaned.push(resolvedWt)

      if (hasSwarmBranchOwnership && checkedOutBranch !== null) {
        try {
          execFileSync('git', ['-C', repoTop, 'branch', '-d', checkedOutBranch], {
            stdio: 'ignore',
            timeout: 3_000,
          })
        } catch {
          /* branch still referenced or unmerged: keep safely */
        }
      }
    } catch {
      /* fail closed: preserve worktree on any git error or unmerged commit */
    }
  }
  return cleaned
}
