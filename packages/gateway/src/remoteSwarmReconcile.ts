/**
 * Git worktree lifecycle & boot-time reconciliation for `RemoteSwarmRuntime` (P2-1 / P2-3).
 *
 * Responsibilities:
 *   1. Worktree isolation helpers (`createWorkerGitWorktree`, `removeWorkerGitWorktree`,
 *      dirty/unmerged-commit safety checks) shared by `RemoteSwarmRuntime` and boot reconcile.
 *   2. `reconcileRemoteSwarmOnBoot`: called on gateway startup to flip stale on-disk
 *      `RUNNING` members (left behind by a crash/restart) to `STOPPED`, and safely prune
 *      CLEAN orphan/archived `.oc-swarm-worktrees` directories. Worktrees with uncommitted
 *      changes OR unmerged commits are NEVER deleted.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { antigravityRoot } from './engine/antigravityPlatform.js'
import {
  type RemoteSwarmLocation,
  atomicWriteJson,
  ensurePrivateDir,
  readRosterStrict,
  withAsyncSwarmFileLock,
} from './remoteSwarmLocks.js'

const SWARM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SLOT_DIR_RE = /^s-[0-9a-f]{16}$/i

export function findGitRepoTopLevel(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim()
    return out || null
  } catch {
    return null
  }
}

export function isGitWorktreeDirty(wtPath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', wtPath, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim()
    return out.length > 0
  } catch {
    return true
  }
}

/**
 * Check whether a worktree's HEAD commit is unmerged into the main repository's HEAD (I6).
 * In `share` (detached HEAD) mode, a worker can commit changes leaving porcelain clean;
 * deleting the worktree without proving its commit is reachable from main HEAD orphans work.
 */
export function hasUnmergedGitWorktreeCommits(repoTop: string, wtPath: string): boolean {
  try {
    const wtHead = execFileSync('git', ['-C', wtPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim()
    if (!wtHead) return true
    execFileSync('git', ['-C', repoTop, 'merge-base', '--is-ancestor', wtHead, 'HEAD'], {
      stdio: 'ignore',
      timeout: 5_000,
    })
    return false
  } catch {
    return true
  }
}

/**
 * List canonical realpaths of all git worktrees registered in `repoTop` via
 * `git worktree list --porcelain` (B1). Fails closed (returns empty Set) on error.
 */
export function listRegisteredGitWorktrees(repoTop: string): Set<string> {
  const registered = new Set<string>()
  try {
    const out = execFileSync('git', ['-C', repoTop, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
    for (const line of out.split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const rawPath = line.slice('worktree '.length).trim()
      if (!rawPath) continue
      try {
        registered.add(realpathSync(rawPath))
      } catch {
        registered.add(resolve(rawPath))
      }
    }
  } catch {
    return new Set()
  }
  return registered
}

/**
 * Prove that `wtPath` is a real, registered linked git worktree of `repoTop` (B1):
 *   1. Not a symlink, is a directory, contains `.git`.
 *   2. Its canonical `realpath` is strictly in `git worktree list --porcelain` for `repoTop`
 *      and is NOT the main `repoTop` itself.
 *   3. `git -C <wtPath> rev-parse --show-toplevel` resolves strictly to `wtPath`'s own `realpath`
 *      (preventing an unregistered directory inside an ignored `.oc-swarm-worktrees/` from
 *      inheriting the parent repository's clean status).
 */
export function isRegisteredGitWorktree(
  repoTop: string,
  wtPath: string,
  registeredWorktrees?: ReadonlySet<string>,
): boolean {
  try {
    const st = lstatSync(wtPath)
    if (st.isSymbolicLink() || !st.isDirectory()) return false
    const realWt = realpathSync(wtPath)
    const realRepoTop = realpathSync(repoTop)
    if (realWt === realRepoTop) return false
    if (!existsSync(join(realWt, '.git'))) return false
    const registered = registeredWorktrees ?? listRegisteredGitWorktrees(repoTop)
    if (!registered.has(realWt)) return false
    const wtTop = findGitRepoTopLevel(realWt)
    if (!wtTop) return false
    return realpathSync(wtTop) === realWt
  } catch {
    return false
  }
}

export function isGitWorktreeUnsafeToDelete(
  repoTop: string,
  wtPath: string,
  registeredWorktrees?: ReadonlySet<string>,
): boolean {
  if (!isRegisteredGitWorktree(repoTop, wtPath, registeredWorktrees)) {
    return true
  }
  return isGitWorktreeDirty(wtPath) || hasUnmergedGitWorktreeCommits(repoTop, wtPath)
}

export function worktreePathForWorker(repoTop: string, swarmId: string, workerName: string): string {
  const wtBase = join(repoTop, '.oc-swarm-worktrees')
  const slug = `${swarmId.slice(0, 8)}-${workerName}`
  const wtPath = resolve(wtBase, slug)
  if (!wtPath.startsWith(`${resolve(wtBase)}/`)) {
    throw new Error(`SWARM_WORKTREE_CREATE_FAILED: invalid worktree path (${slug})`)
  }
  return wtPath
}

export function createWorkerGitWorktree(
  baseCwd: string,
  swarmId: string,
  workerName: string,
  mode: 'share' | 'branch',
): { mode: 'share' | 'branch'; path: string; branch?: string } {
  const repoTop = findGitRepoTopLevel(baseCwd)
  if (!repoTop) {
    throw new Error(`SWARM_WORKTREE_CREATE_FAILED: workspace is not a git repository (${baseCwd})`)
  }
  const wtBase = join(repoTop, '.oc-swarm-worktrees')
  ensurePrivateDir(wtBase)
  const slug = `${swarmId.slice(0, 8)}-${workerName}`
  const wtPath = worktreePathForWorker(repoTop, swarmId, workerName)
  try {
    if (existsSync(wtPath)) {
      if (isGitWorktreeUnsafeToDelete(repoTop, wtPath)) {
        throw new Error(`existing worktree has uncommitted or unmerged changes (${wtPath})`)
      }
      execFileSync('git', ['-C', repoTop, 'worktree', 'remove', '--force', wtPath], {
        stdio: 'ignore',
        timeout: 10_000,
      })
    }
    if (mode === 'branch') {
      const branchName = `swarm/${slug}-${Date.now().toString(36)}`
      execFileSync('git', ['-C', repoTop, 'worktree', 'add', '-b', branchName, wtPath, 'HEAD'], {
        stdio: 'ignore',
        timeout: 15_000,
      })
      return { mode: 'branch', path: wtPath, branch: branchName }
    }
    execFileSync('git', ['-C', repoTop, 'worktree', 'add', '--detach', wtPath, 'HEAD'], {
      stdio: 'ignore',
      timeout: 15_000,
    })
    return { mode: 'share', path: wtPath }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`SWARM_WORKTREE_CREATE_FAILED: ${detail}`)
  }
}

export function removeWorkerGitWorktree(
  baseCwd: string,
  wtPath: string | undefined,
  opts?: {
    forceDirty?: boolean
    branchName?: string
    registeredWorktrees?: ReadonlySet<string>
  },
): { removed: boolean; preservedDirtyPath?: string } {
  if (!wtPath) return { removed: false }
  const repoTop = findGitRepoTopLevel(baseCwd)
  const wtBase = repoTop ? resolve(repoTop, '.oc-swarm-worktrees') : null
  const resolvedWt = resolve(wtPath)
  if (!wtBase || !resolvedWt.startsWith(`${wtBase}/`)) {
    return { removed: false }
  }
  if (!existsSync(resolvedWt)) {
    if (opts?.branchName) {
      try {
        execFileSync('git', ['-C', repoTop!, 'branch', '-D', opts.branchName], {
          stdio: 'ignore',
          timeout: 5_000,
        })
      } catch {
        /* best-effort branch cleanup */
      }
    }
    return { removed: true }
  }
  // B1: Never remove symlinks or unregistered plain directories (no fs.rmSync fallback!).
  if (!isRegisteredGitWorktree(repoTop!, resolvedWt, opts?.registeredWorktrees)) {
    return { removed: false, preservedDirtyPath: resolvedWt }
  }
  if (!opts?.forceDirty && isGitWorktreeUnsafeToDelete(repoTop!, resolvedWt, opts?.registeredWorktrees)) {
    return { removed: false, preservedDirtyPath: resolvedWt }
  }
  try {
    execFileSync('git', ['-C', repoTop!, 'worktree', 'remove', '--force', resolvedWt], {
      stdio: 'ignore',
      timeout: 10_000,
    })
  } catch {
    // B1: Fail closed when git refuses worktree removal — never fallback to recursive fs.rmSync.
    return { removed: false, preservedDirtyPath: resolvedWt }
  }
  if (opts?.branchName) {
    try {
      execFileSync('git', ['-C', repoTop!, 'branch', '-D', opts.branchName], {
        stdio: 'ignore',
        timeout: 5_000,
      })
    } catch {
      /* best-effort branch cleanup */
    }
  }
  return { removed: true }
}

export interface ReconcileRemoteSwarmOptions {
  rootBase?: string
  /** Optional workspace/repo directories whose `.oc-swarm-worktrees` should also be scanned for clean orphans. */
  workspaceRoots?: readonly string[]
  /** Active swarmIds that must NOT be reconciled as dead or have worktrees pruned. */
  activeSwarmIds?: ReadonlySet<string>
  /** Optional predicate returning true when a persisted swarm belongs to an archived session. */
  isSessionArchived?: (info: {
    slot: string
    swarmId: string
    sessionKey?: string
    membersPath: string
  }) => boolean | Promise<boolean>
  log?: {
    info?: (msg: string, fields?: Record<string, unknown>) => void
    warn?: (msg: string, fields?: Record<string, unknown>) => void
  }
}

export interface ReconcileRemoteSwarmResult {
  reconciledSwarms: number
  reconciledMembers: number
  cleanedWorktrees: string[]
  preservedDirtyWorktrees: string[]
  corruptRosters: number
}

function lstatSafe(p: string) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

function inferRepoTopFromWorktreePath(wtPath: string): string | null {
  const resolved = resolve(wtPath)
  const parent = dirname(resolved)
  if (parent.endsWith('/.oc-swarm-worktrees')) {
    return findGitRepoTopLevel(dirname(parent))
  }
  return null
}

/**
 * Boot-time self-healing for on-disk Remote Swarm state:
 *   1. Transitions stale non-killed `RUNNING` members left on disk from prior crashes to `STOPPED`.
 *   2. Never overwrites corrupt/unreadable `members.json` (fail-closed, logs warning).
 *   3. Safely prunes CLEAN `.oc-swarm-worktrees` belonging to archived sessions, killed members,
 *      or orphaned worktree directories whose swarm no longer exists on disk. Dirty or unmerged
 *      worktrees are NEVER deleted.
 */
export async function reconcileRemoteSwarmOnBoot(
  opts: ReconcileRemoteSwarmOptions = {},
): Promise<ReconcileRemoteSwarmResult> {
  const rootBase = opts.rootBase ?? antigravityRoot()
  const remoteBase = join(rootBase, 'remote-swarm')
  const result: ReconcileRemoteSwarmResult = {
    reconciledSwarms: 0,
    reconciledMembers: 0,
    cleanedWorktrees: [],
    preservedDirtyWorktrees: [],
    corruptRosters: 0,
  }

  const candidateRepoTops = new Set<string>()
  for (const wsRoot of opts.workspaceRoots ?? []) {
    if (!wsRoot) continue
    const top = findGitRepoTopLevel(wsRoot)
    if (top) candidateRepoTops.add(top)
  }

  // Track swarm prefixes still alive/non-archived so orphan scan never touches active worktrees.
  const retainedSwarmPrefixes = new Set<string>()
  for (const activeId of opts.activeSwarmIds ?? []) {
    if (activeId.length >= 8) retainedSwarmPrefixes.add(activeId.slice(0, 8).toLowerCase())
  }
  const seenWorktrees = new Set<string>()

  const remoteStat = lstatSafe(remoteBase)
  if (remoteStat && !remoteStat.isSymbolicLink() && remoteStat.isDirectory()) {
    let slotEntries: string[] = []
    try {
      slotEntries = readdirSync(remoteBase)
    } catch {
      slotEntries = []
    }

    for (const slot of slotEntries) {
      if (!SLOT_DIR_RE.test(slot)) continue
      const slotDir = join(remoteBase, slot)
      const slotStat = lstatSafe(slotDir)
      if (!slotStat || slotStat.isSymbolicLink() || !slotStat.isDirectory()) continue
      const brainDir = join(slotDir, 'brain')
      const brainStat = lstatSafe(brainDir)
      if (!brainStat || brainStat.isSymbolicLink() || !brainStat.isDirectory()) continue

      let convEntries: string[] = []
      try {
        convEntries = readdirSync(brainDir)
      } catch {
        continue
      }

      for (const swarmId of convEntries) {
        if (!SWARM_UUID_RE.test(swarmId)) continue
        if (opts.activeSwarmIds?.has(swarmId)) continue
        const swarmDir = join(brainDir, swarmId, '.system_generated', 'swarm')
        const membersPath = join(swarmDir, 'members.json')
        const membersStat = lstatSafe(membersPath)
        if (!membersStat || membersStat.isSymbolicLink() || !membersStat.isFile()) continue

        const location: RemoteSwarmLocation = { brainDir, swarmId, swarmDir }
        let rosterSnapshot: ReturnType<typeof readRosterStrict> = null
        let flippedInThisSwarm = 0

        try {
          rosterSnapshot = await withAsyncSwarmFileLock(location, '.roster.lock', () => {
            const roster = readRosterStrict(location)
            if (!roster) return null
            let changed = false
            for (const member of Object.values(roster.members)) {
              if (!member.killed && String(member.phase).toUpperCase() === 'RUNNING') {
                member.phase = 'STOPPED'
                changed = true
                flippedInThisSwarm += 1
              }
            }
            if (roster.pending_adds && Object.keys(roster.pending_adds).length > 0) {
              delete roster.pending_adds
              changed = true
            }
            if (changed) {
              atomicWriteJson(membersPath, roster)
            }
            return roster
          })
        } catch (err) {
          result.corruptRosters += 1
          opts.log?.warn?.('remote swarm boot reconcile skipped unreadable roster', {
            swarmId,
            error: err instanceof Error ? err.message : String(err),
          })
          // Retain prefix conservatively so orphan scanner never deletes worktrees of an unreadable roster.
          retainedSwarmPrefixes.add(swarmId.slice(0, 8).toLowerCase())
          continue
        }

        if (!rosterSnapshot) continue
        if (flippedInThisSwarm > 0) {
          result.reconciledSwarms += 1
          result.reconciledMembers += flippedInThisSwarm
        }

        if (rosterSnapshot.workspace_cwd) {
          const top = findGitRepoTopLevel(rosterSnapshot.workspace_cwd)
          if (top) candidateRepoTops.add(top)
        }

        const archived = Boolean(
          await opts.isSessionArchived?.({
            slot,
            swarmId,
            sessionKey: rosterSnapshot.session_key,
            membersPath,
          }),
        )

        if (!archived) {
          retainedSwarmPrefixes.add(swarmId.slice(0, 8).toLowerCase())
        }

        for (const member of Object.values(rosterSnapshot.members)) {
          const wtPath = member.workspace?.path
          if (!wtPath || member.workspace?.mode === 'inherit') continue
          const repoTop =
            (rosterSnapshot.workspace_cwd ? findGitRepoTopLevel(rosterSnapshot.workspace_cwd) : null) ??
            inferRepoTopFromWorktreePath(wtPath)
          if (repoTop) candidateRepoTops.add(repoTop)

          if ((archived || member.killed) && repoTop) {
            const resolvedWt = resolve(wtPath)
            seenWorktrees.add(resolvedWt)
            if (!existsSync(resolvedWt)) continue
            const wtRes = removeWorkerGitWorktree(repoTop, resolvedWt, { forceDirty: false })
            if (wtRes.removed) {
              result.cleanedWorktrees.push(resolvedWt)
            } else if (wtRes.preservedDirtyPath) {
              result.preservedDirtyWorktrees.push(wtRes.preservedDirtyPath)
            }
          }
        }
      }
    }
  }

  // Scan discovered repo `.oc-swarm-worktrees` for true orphan directories whose swarm prefix is
  // neither active nor retained by a non-archived on-disk roster.
  // B1: Verify every candidate against `git worktree list --porcelain` and its own toplevel.
  for (const repoTop of candidateRepoTops) {
    const wtBase = join(repoTop, '.oc-swarm-worktrees')
    const baseStat = lstatSafe(wtBase)
    if (!baseStat || baseStat.isSymbolicLink() || !baseStat.isDirectory()) continue
    const registeredWorktrees = listRegisteredGitWorktrees(repoTop)
    let entries: string[] = []
    try {
      entries = readdirSync(wtBase)
    } catch {
      continue
    }
    let prunedAny = false
    for (const entry of entries) {
      const m = /^([0-9a-f]{8})-[a-z0-9][a-z0-9_-]*$/i.exec(entry)
      if (!m) continue
      const prefix = m[1]!.toLowerCase()
      if (retainedSwarmPrefixes.has(prefix)) continue
      const wtPath = resolve(wtBase, entry)
      if (seenWorktrees.has(wtPath)) continue
      seenWorktrees.add(wtPath)
      const wtRes = removeWorkerGitWorktree(repoTop, wtPath, {
        forceDirty: false,
        registeredWorktrees,
      })
      if (wtRes.removed) {
        result.cleanedWorktrees.push(wtPath)
        prunedAny = true
      } else if (wtRes.preservedDirtyPath) {
        result.preservedDirtyWorktrees.push(wtRes.preservedDirtyPath)
      }
    }
    if (prunedAny) {
      try {
        execFileSync('git', ['-C', repoTop, 'worktree', 'prune'], {
          stdio: 'ignore',
          timeout: 5_000,
        })
      } catch {
        /* best-effort git worktree metadata prune */
      }
    }
  }

  if (
    result.reconciledMembers > 0 ||
    result.cleanedWorktrees.length > 0 ||
    result.corruptRosters > 0
  ) {
    opts.log?.info?.('remote_swarm_boot_reconcile', {
      reconciledSwarms: result.reconciledSwarms,
      reconciledMembers: result.reconciledMembers,
      cleanedWorktrees: result.cleanedWorktrees.length,
      preservedDirtyWorktrees: result.preservedDirtyWorktrees.length,
      corruptRosters: result.corruptRosters,
    })
  }

  return result
}
