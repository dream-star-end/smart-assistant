/**
 * Bounded Git First-Parent Range Inspection (OCV5-912).
 *
 * Shared, zero-policy primitive used by both A0 (`a0RangeCarryOver.ts`) and Architecture
 * Steward (`commitRangeCarryOver.ts`) to distinguish single-commit (`N === 1`), coalesced
 * multi-commit (`2 <= N <= 20`), and diverged/oversized (`> 20` / non-ancestor) ranges
 * BEFORE any tip-only approval or carry-over decision.
 */
import { spawnSync } from 'node:child_process'
import { SHA40_RE } from './archStewardContract.js'

export const MAX_COALESCED_COMMITS = 20

export type FirstParentRangeInfo =
  | { kind: 'single'; commit: string }
  | { kind: 'multi'; commits: string[] }
  | { kind: 'invalid'; reason: string }

function runGitChecked(
  root: string,
  args: string[],
  gitDir?: string,
): { ok: boolean; stdout: string } {
  const env = { ...process.env }
  if (gitDir) env.GIT_DIR = gitDir
  const gitArgs = gitDir ? ['--git-dir', gitDir, ...args] : ['-C', root, ...args]
  const res = spawnSync('git', gitArgs, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env,
  })
  return { ok: res.status === 0, stdout: (res.stdout ?? '').trim() }
}

/**
 * Bounded inspection of the contiguous first-parent chain `baseSha..headSha` (`--max-count`).
 */
export function inspectFirstParentRange(
  root: string,
  baseSha: string,
  headSha: string,
  gitDir?: string,
  maxCommits = MAX_COALESCED_COMMITS,
): FirstParentRangeInfo {
  const normBase = baseSha.trim().toLowerCase()
  const normHead = headSha.trim().toLowerCase()
  if (!SHA40_RE.test(normBase) || !SHA40_RE.test(normHead) || normBase === normHead) {
    return { kind: 'invalid', reason: 'base/head not distinct 40-char SHAs' }
  }
  const anc = runGitChecked(root, ['merge-base', '--is-ancestor', normBase, normHead], gitDir)
  if (!anc.ok) return { kind: 'invalid', reason: 'base is not an ancestor of head' }

  const listRes = runGitChecked(
    root,
    ['rev-list', '--first-parent', `--max-count=${maxCommits + 1}`, `${normBase}..${normHead}`],
    gitDir,
  )
  if (!listRes.ok || !listRes.stdout) {
    return { kind: 'invalid', reason: 'failed to enumerate first-parent range' }
  }
  const commits = listRes.stdout
    .split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => SHA40_RE.test(s))
    .reverse()
  if (commits.length === 0) return { kind: 'invalid', reason: 'empty commit range' }
  if (commits.length > maxCommits) {
    return {
      kind: 'invalid',
      reason: `first-parent range exceeds max ${maxCommits} commits (require aggregate approval)`,
    }
  }
  if (commits[commits.length - 1] !== normHead) {
    return { kind: 'invalid', reason: 'first-parent chain does not terminate at headSha' }
  }
  const firstParent = runGitChecked(root, ['rev-parse', '--verify', `${commits[0]}^1`], gitDir)
  if (!firstParent.ok || firstParent.stdout.toLowerCase() !== normBase) {
    return { kind: 'invalid', reason: 'first-parent chain does not anchor cleanly at baseSha' }
  }
  if (commits.length === 1) return { kind: 'single', commit: commits[0]! }
  return { kind: 'multi', commits }
}
