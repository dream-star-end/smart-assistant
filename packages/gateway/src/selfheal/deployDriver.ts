/**
 * Trusted deploy driver for Tier2 cutover (block C / design §C1).
 *
 * Three layers, all executed with ROOT-HELD tooling against the TRUSTED
 * canonical checkout (never a script from the candidate clone):
 *
 *   ① Toolchain-immutability guard (hard gate BEFORE any merge): the candidate
 *      diff (`git diff --name-only <canonical_head>..<sha>`) must not touch the
 *      deploy toolchain denylist — `scripts/**`, `deploy/**`, `.github/**`, the
 *      whole root `package.json` (no scripts-section parsing; whole file), and
 *      ANY `*.sh` anywhere. A touch forces `pending_release` with a toolchain
 *      annotation and is NEVER auto-deployed; the one-click release path also
 *      refuses it (only a human offline standard deploy can ship it).
 *   ② ff-only merge of the validated sha into canonical. Because the denylist
 *      covers the deploy script and all of its control dependencies, the merged
 *      script is byte-identical to the pre-merge trusted version — so it is
 *      safe to run it from the merged tree.
 *   ③ Execute canonical `scripts/deploy-v5.sh --with-dist` (child process,
 *      cwd=canonical, 30min timeout via the default runner). Failure reports
 *      `deploy_failed` and notifies.
 *
 * merge↔deploy race hardening (HIGH1): the whole ①→③ sequence runs under a
 * DEDICATED cutover flock (/var/lock/oc-selfheal-cutover.lock) so two
 * concurrent cutovers/releases can never interleave a merge between another
 * driver's merge and deploy. Because non-selfheal writers (a human `git merge`,
 * other tooling) don't take this lock, the driver additionally asserts
 * `git rev-parse HEAD === sha` right after the merge (an ff-only merge of an
 * already-ancestor sha is a silent no-op when canonical moved past it — we must
 * NOT deploy someone else's commits under this repair's name) and again after
 * the deploy script exits 0 (if HEAD advanced mid-deploy, the deployed tree may
 * be ahead of the released sha — reported for manual verification).
 *
 * Honest boundary (registered, not removable): the deploy itself necessarily
 * runs candidate code (that is what deploying means); it is controlled by
 * verification + ancestry + the human release gate, not by this driver.
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { BrokerResponse, DeployDriver } from './broker.js'
import type { CommandRunner } from './brokerActions.js'
import { defaultCommandRunner } from './verifier.js'

export const DEFAULT_CUTOVER_LOCK_PATH = '/var/lock/oc-selfheal-cutover.lock'
const DEFAULT_LOCK_TIMEOUT_SEC = 60

/** Releases a held cutover lock. Must be idempotent-safe to call once. */
export type ReleaseLock = () => Promise<void> | void
/** Acquires an exclusive lock on `lockPath`, waiting up to `timeoutSec`.
 *  Resolves to the release function; rejects on timeout/failure. */
export type LockAcquirer = (lockPath: string, timeoutSec: number) => Promise<ReleaseLock>

/**
 * Default cross-process lock: flock(1) held by a companion child process for
 * the whole cutover. The child takes the flock (waiting up to `timeoutSec`),
 * prints a marker, then sleeps; killing it closes the fd and releases the lock.
 * Real kernel flock semantics — a crashed gateway releases automatically.
 */
export const defaultFlockAcquire: LockAcquirer = (lockPath, timeoutSec) =>
  new Promise<ReleaseLock>((resolve, reject) => {
    const child = spawn(
      'flock',
      [
        '-w',
        String(timeoutSec),
        lockPath,
        '-c',
        'echo __oc_cutover_locked__; exec sleep 2147483647',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let settled = false
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += String(chunk)
      if (!settled && out.includes('__oc_cutover_locked__')) {
        settled = true
        resolve(
          () =>
            new Promise<void>((r) => {
              child.once('exit', () => r())
              child.kill('SIGTERM')
            }),
        )
      }
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      reject(err)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      reject(
        new Error(
          `cutover flock ${lockPath} not acquired within ${timeoutSec}s (exit ${code}) — another cutover in flight?`,
        ),
      )
    })
  })

/** Deploy-toolchain denylist matcher. Returns the touched files (empty = clean). */
export function touchesDeployToolchain(files: string[]): string[] {
  return files.filter((f) => {
    if (f === 'package.json') return true // whole root package.json — no parsing
    if (f.startsWith('scripts/')) return true
    if (f.startsWith('deploy/')) return true
    if (f.startsWith('.github/')) return true
    if (f.endsWith('.sh')) return true // any path
    return false
  })
}

/**
 * List the candidate's toolchain touches, or null when git itself failed
 * (callers must treat null as fail-closed). Requires the sha's objects to be
 * present in the canonical repo (the ancestry check imports them beforehand).
 */
export async function listToolchainTouches(
  run: CommandRunner,
  canonicalRepo: string,
  sha: string,
): Promise<string[] | null> {
  const head = await run('git', ['-C', canonicalRepo, 'rev-parse', 'HEAD'])
  if (head.code !== 0) return null
  const headSha = head.stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(headSha)) return null
  const diff = await run('git', ['-C', canonicalRepo, 'diff', '--name-only', `${headSha}..${sha}`])
  if (diff.code !== 0) return null
  const files = diff.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  return touchesDeployToolchain(files)
}

export interface DeployDriverOpts {
  canonicalRepo: string
  canonicalBranch: string
  /** Injectable runner — unit tests use a mock and NEVER run a real deploy. */
  run?: CommandRunner
  /** Out-of-band notification (WeCom): toolchain hold / failure / success. */
  notify?: (text: string) => void
  /** Relative deploy script inside canonical. Default scripts/deploy-v5.sh. */
  deployScript?: string
  deployArgs?: string[]
  /** Injectable cutover lock (HIGH1) — unit tests use a fake and NEVER touch
   *  the real /var/lock. Defaults to a real flock(1). */
  acquireLock?: LockAcquirer
  cutoverLockPath?: string
  lockTimeoutSec?: number
}

export function createDeployDriver(opts: DeployDriverOpts): DeployDriver {
  const run = opts.run ?? defaultCommandRunner
  const script = opts.deployScript ?? 'scripts/deploy-v5.sh'
  const args = opts.deployArgs ?? ['--with-dist']
  const acquireLock = opts.acquireLock ?? defaultFlockAcquire
  const lockPath = opts.cutoverLockPath ?? DEFAULT_CUTOVER_LOCK_PATH
  const lockTimeoutSec = opts.lockTimeoutSec ?? DEFAULT_LOCK_TIMEOUT_SEC
  return async (sha, ctx): Promise<BrokerResponse> => {
    const repo = opts.canonicalRepo
    const who = ctx.repairId ?? 'unknown-repair'

    // ⓪ dedicated cutover flock (HIGH1): diff→merge→deploy→final-verify are one
    //   critical section; a concurrent cutover/release waits or times out here.
    let releaseLock: ReleaseLock
    try {
      releaseLock = await acquireLock(lockPath, lockTimeoutSec)
    } catch (err) {
      const reason = String((err as Error).message).slice(0, 300)
      ctx.log.error('deploy driver could not take the cutover lock — refusing', { sha, reason })
      opts.notify?.(`[selfheal] repair ${who} 上线失败:未能取得 cutover 锁(${reason})。sha=${sha}`)
      return {
        ok: false,
        status: 'deploy_failed',
        detail: { sha, step: 'lock', reason: `cutover lock not acquired: ${reason}` },
      }
    }
    try {
      return await runLocked()
    } finally {
      try {
        await releaseLock()
      } catch (err) {
        ctx.log.warn('cutover lock release failed', { sha }, err as Error)
      }
    }

    async function runLocked(): Promise<BrokerResponse> {
      // ① toolchain-immutability guard (fail closed on git errors).
      const touched = await listToolchainTouches(run, repo, sha)
      if (touched === null) {
        ctx.log.error('deploy driver could not compute candidate diff — refusing', { sha })
        return {
          ok: false,
          status: 'deploy_failed',
          detail: { sha, step: 'diff', reason: 'could not compute candidate diff' },
        }
      }
      if (touched.length > 0) {
        ctx.log.warn('candidate touches deploy toolchain — forced pending, never auto-deployed', {
          sha,
          files: touched.slice(0, 20),
        })
        opts.notify?.(
          `[selfheal] repair ${who} 的候选改动了部署工具链(${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ` 等${touched.length}个` : ''}),已强制挂起:自动部署与一键放行均不可用,须人工线下审后走标准 deploy。sha=${sha}`,
        )
        return {
          ok: false,
          status: 'pending_release',
          detail: {
            sha,
            toolchain: true,
            files: touched.slice(0, 20),
            reason:
              'touches deploy toolchain (scripts/**, deploy/**, .github/**, package.json, *.sh) — manual offline deploy only',
          },
        }
      }

      // ② ff-only merge into canonical.
      const merge = await run('git', ['-C', repo, 'merge', '--ff-only', sha])
      if (merge.code !== 0) {
        ctx.log.error('deploy driver ff-merge failed', { sha, code: merge.code })
        opts.notify?.(
          `[selfheal] repair ${who} 自动上线失败(ff-merge,code ${merge.code})。sha=${sha}`,
        )
        return {
          ok: false,
          status: 'deploy_failed',
          detail: { sha, step: 'ff-merge', code: merge.code, tail: merge.stderr.slice(-500) },
        }
      }

      // ②b HEAD must BE the released sha now (HIGH1). An ff-only "merge" of a
      //    sha canonical already moved PAST is a silent no-op — deploying then
      //    would ship unreviewed later commits under this repair's name. Abort.
      const headAfterMerge = await run('git', ['-C', repo, 'rev-parse', 'HEAD'])
      const mergedHead = headAfterMerge.stdout.trim()
      if (headAfterMerge.code !== 0 || mergedHead !== sha) {
        ctx.log.error('deploy driver post-merge HEAD mismatch — refusing to deploy', {
          sha,
          head: mergedHead,
        })
        opts.notify?.(
          `[selfheal] repair ${who} 上线中止:merge 后 canonical HEAD(${mergedHead.slice(0, 12)})≠目标 sha,canonical 已被推进,需重新走验证+放行。sha=${sha}`,
        )
        return {
          ok: false,
          status: 'deploy_failed',
          detail: {
            sha,
            step: 'head-assert',
            head: mergedHead,
            reason: 'canonical moved past target sha — re-release required',
          },
        }
      }

      // ③ run the (now-merged, byte-identical) canonical deploy script.
      const dep = await run('bash', [join(repo, script), ...args], { cwd: repo })
      if (dep.code !== 0) {
        ctx.log.error('deploy driver deploy script failed', { sha, code: dep.code })
        opts.notify?.(
          `[selfheal] repair ${who} 自动上线失败(deploy 脚本 code ${dep.code})。sha=${sha}`,
        )
        return {
          ok: false,
          status: 'deploy_failed',
          detail: {
            sha,
            step: 'deploy',
            code: dep.code,
            tail: (dep.stderr || dep.stdout).slice(-800),
          },
        }
      }

      // ③b HEAD must STILL be the released sha (HIGH1): the cutover flock keeps
      //    other selfheal drivers out, but a non-selfheal writer could advance
      //    canonical mid-deploy — the deployed tree may then be AHEAD of the
      //    released sha. Report for manual verification, never claim 'deployed'.
      const headAfterDeployRes = await run('git', ['-C', repo, 'rev-parse', 'HEAD'])
      const headAfterDeploy = headAfterDeployRes.stdout.trim()
      if (headAfterDeployRes.code !== 0 || headAfterDeploy !== sha) {
        ctx.log.error('deploy driver post-deploy HEAD mismatch — manual verification required', {
          sha,
          headAfterDeploy,
        })
        opts.notify?.(
          `[selfheal] repair ${who} 部署完成但 canonical 在部署期间被并发推进(HEAD=${headAfterDeploy.slice(0, 12)}≠sha):已部署的树可能超前于放行的 sha,须人工核对。sha=${sha}`,
        )
        return {
          ok: false,
          status: 'deploy_failed',
          detail: {
            sha,
            headAfterDeploy,
            step: 'post-deploy-assert',
            reason:
              'canonical advanced during deploy — deployed tree may be ahead of the released sha; manual verification required',
          },
        }
      }

      ctx.log.info('deploy driver cutover complete', { sha })
      opts.notify?.(`[selfheal] repair ${who} 自动上线完成。sha=${sha}`)
      return { ok: true, status: 'deployed', detail: { sha, headAfterDeploy } }
    }
  }
}
