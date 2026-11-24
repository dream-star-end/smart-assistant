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
import { killProcessGroup } from '../processGroupShutdown.js'

/**
 * Default max concurrent local native Antigravity CLI swarm processes per user container.
 * A single 4 GB user container running 4 concurrent `agy` swarms (0.43–1.00 GB RSS each)
 * triggered cgroup OOM SIGKILL in production; capping active local swarm processes at 2
 * keeps peak swarm RSS <= ~2.0 GB while queueing excess swarm turns FIFO with live status.
 */
export const DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS = 2

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SWARM_BRANCH_RE = /^swarm\/[A-Za-z0-9._/-]{1,120}$/
const MAX_ROSTER_BYTES = 512 * 1024

interface SwarmSlotWaiter {
  cancelled: boolean
  grant: (release: () => void) => void
  abort: () => void
}

let activeLocalSwarms = 0
let limitOverrideForTests: number | null = null
const waitQueue: SwarmSlotWaiter[] = []

function effectiveSwarmLimit(): number {
  if (limitOverrideForTests !== null && limitOverrideForTests >= 1) {
    return Math.floor(limitOverrideForTests)
  }
  return DEFAULT_MAX_CONCURRENT_LOCAL_SWARMS
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
  const limit = effectiveSwarmLimit()
  while (activeLocalSwarms < limit && waitQueue.length > 0) {
    const next = waitQueue.shift()!
    if (next.cancelled) continue
    activeLocalSwarms += 1
    next.grant(makeSlotRelease())
  }
}

export interface LocalSwarmSlotAcquisition {
  readonly waited: boolean
  readonly promise: Promise<() => void>
  readonly cancel: () => void
}

export async function awaitLocalAntigravitySwarmSlotIfActive(opts: {
  compactionMode: string | undefined
  keepaliveMs: number
  renewRouteIntervalMs?: number
  onStatus: (detail: string) => void
  onHeartbeat: () => void
  onRenewRoute?: () => Promise<boolean>
  setRelease: (fn: (() => void) | null) => void
  now?: () => number
}): Promise<{ waited: boolean }> {
  if (opts.compactionMode !== 'on_full' && opts.compactionMode !== 'on_resumed') {
    return { waited: false }
  }
  const nowFn = opts.now ?? Date.now
  const slot = acquireLocalAntigravitySwarmSlot({
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
          void opts.onRenewRoute().catch(() => false).finally(() => {
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
  // B8: If we waited in FIFO queue, verify/renew the minted relay route BEFORE spawning CLI
  // so a route that expired during a long queue wait fails closed instead of launching a broken CLI.
  if (slot.waited && opts.onRenewRoute) {
    const alive = await opts.onRenewRoute().catch(() => false)
    if (!alive) {
      release()
      opts.setRelease(null)
      throw new Error('ANTIGRAVITY_ROUTE_EXPIRED_IN_QUEUE: relay route expired while waiting for swarm slot')
    }
  }
  return { waited: slot.waited }
}

export function acquireLocalAntigravitySwarmSlot(opts?: {
  onWaitStart?: (active: number, limit: number, position: number) => void
}): LocalSwarmSlotAcquisition {
  const limit = effectiveSwarmLimit()
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

/**
 * Reap a lingering CLI process group on active swarm turns where background
 * worker subprocesses keep stdio/sockets open past coordinator result emission.
 * Gives the coordinator `naturalExitGraceMs` to exit cleanly with code 0 first
 * before sending SIGTERM -> SIGKILL.
 */
export async function reapLingeringCliProcessGroup(
  proc: ChildProcess | null,
  isClosed: () => boolean,
  opts?: { naturalExitGraceMs?: number; termGraceMs?: number; killGraceMs?: number },
): Promise<void> {
  if (!proc || isClosed()) return
  const naturalExitGraceMs = Math.max(0, opts?.naturalExitGraceMs ?? 150)
  const termGraceMs = Math.max(20, opts?.termGraceMs ?? 800)
  const killGraceMs = Math.max(20, opts?.killGraceMs ?? 400)

  const waitClose = (ms: number): Promise<boolean> => {
    if (isClosed()) return Promise.resolve(true)
    if (ms <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolveWait) => {
      const onClose = () => {
        clearTimeout(timer)
        resolveWait(true)
      }
      const timer = setTimeout(() => {
        proc.removeListener('close', onClose)
        resolveWait(isClosed())
      }, ms)
      timer.unref()
      proc.once('close', onClose)
    })
  }

  if (naturalExitGraceMs > 0 && (await waitClose(naturalExitGraceMs))) return
  killProcessGroup(proc, 'SIGTERM')
  if (await waitClose(termGraceMs)) return
  killProcessGroup(proc, 'SIGKILL')
  await waitClose(killGraceMs)
}

export function buildAntigravityDurableBillingEvent(args: {
  requestId: string
  sessionKey: string
  turnKey?: string
  parentTurnKey?: string
  parentSessionId?: string
  delegateAgentId?: string
  status: EngineExternalBillingEvent['status']
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
  return {
    requestId: args.requestId,
    engine: 'antigravity',
    ...(args.turnKey && /^[0-9a-f]{64}$/.test(args.turnKey) ? { turnKey: args.turnKey } : {}),
    ...(args.parentTurnKey ? { parentTurnKey: args.parentTurnKey } : {}),
    ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
    ...(args.delegateAgentId ? { delegateAgentId: args.delegateAgentId } : {}),
    engineSessionId: engineSessionId(args.sessionKey),
    status: durableStatus,
    ...(durableStatus === 'error' && !args.budgetStop
      ? { terminalCode: args.interrupted ? ('USER_CANCELLED' as const) : ('CODEX_ERROR' as const) }
      : {}),
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

      // B7: Require current conversation + member ownership (not merely generic `swarm/*`),
      // so a path reused by another active swarm in the same repo can NEVER be removed!
      const memberLower = memberName.trim().toLowerCase()
      const swarmWorktreeDir = join(repoTop, '.oc-swarm-worktrees')
      const underSessionBrain = realBrainDir !== null && realWt.startsWith(`${realBrainDir}${sep}`)
      const underConvSwarmDir =
        realWt.startsWith(`${swarmWorktreeDir}${sep}${convPrefix}-`) ||
        realWt.startsWith(`${swarmWorktreeDir}${sep}${convLower}-`)
      const branchLower = checkedOutBranch?.toLowerCase() ?? ''
      const hasSwarmBranchOwnership = isSafeSwarmBranchName(checkedOutBranch)
      const branchMatchesThisMember =
        hasSwarmBranchOwnership &&
        (branchLower.includes(convPrefix) || branchLower.includes(convLower)) &&
        (!memberLower ||
          branchLower.endsWith(`/${memberLower}`) ||
          branchLower.includes(`/${memberLower}-`) ||
          branchLower.includes(`-${memberLower}`))
      if (!underSessionBrain && !underConvSwarmDir && !branchMatchesThisMember) continue
      if (checkedOutBranch !== null && !hasSwarmBranchOwnership) continue
      if (hasSwarmBranchOwnership && !underSessionBrain && !branchMatchesThisMember) continue

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
