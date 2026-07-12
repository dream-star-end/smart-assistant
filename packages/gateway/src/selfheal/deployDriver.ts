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
 * Honest boundary (registered, not removable): the deploy itself necessarily
 * runs candidate code (that is what deploying means); it is controlled by
 * verification + ancestry + the human release gate, not by this driver.
 */

import { join } from 'node:path'
import type { BrokerResponse, DeployDriver } from './broker.js'
import type { CommandRunner } from './brokerActions.js'
import { defaultCommandRunner } from './verifier.js'

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
}

export function createDeployDriver(opts: DeployDriverOpts): DeployDriver {
  const run = opts.run ?? defaultCommandRunner
  const script = opts.deployScript ?? 'scripts/deploy-v5.sh'
  const args = opts.deployArgs ?? ['--with-dist']
  return async (sha, ctx): Promise<BrokerResponse> => {
    const repo = opts.canonicalRepo
    const who = ctx.repairId ?? 'unknown-repair'

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
    ctx.log.info('deploy driver cutover complete', { sha })
    opts.notify?.(`[selfheal] repair ${who} 自动上线完成。sha=${sha}`)
    return { ok: true, status: 'deployed', detail: { sha } }
  }
}
