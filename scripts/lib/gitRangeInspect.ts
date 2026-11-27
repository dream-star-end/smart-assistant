/**
 * Bounded Git First-Parent Range Inspection (OCV5-912).
 *
 * Shared, zero-policy primitive used by both A0 (`a0RangeCarryOver.ts`) and Architecture
 * Steward (`commitRangeCarryOver.ts`) to separate:
 *   - `single` (N === 1): normal single-commit / merged-PR carry-over path.
 *   - `multi` (2 <= N <= 20): allows per-commit positive decomposition OR aggregate approval
 *     with full negative-vote scan across all N commits.
 *   - `oversized` (21 <= N <= 100): forbids per-commit positive decomposition (requires explicit
 *     aggregate approval bound to base..head) while still delivering all N commits for full
 *     intermediate negative-vote scanning (F2).
 *   - `invalid` (N > 100, non-ancestor/diverged, or unanchored): fails closed.
 */
import { spawnSync } from 'node:child_process'
import { SHA40_RE } from './archStewardContract.js'

export const MAX_COALESCED_COMMITS = 20
export const MAX_NEGATIVE_SCAN_COMMITS = 100

export type FirstParentRangeInfo =
  | { kind: 'single'; commit: string }
  | { kind: 'multi'; commits: string[] }
  | { kind: 'oversized'; commits: string[]; reason: string }
  | { kind: 'invalid'; reason: string; tooManyForNegativeScan?: boolean }

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
  maxNegativeScanCommits = MAX_NEGATIVE_SCAN_COMMITS,
): FirstParentRangeInfo {
  const normBase = baseSha.trim().toLowerCase()
  const normHead = headSha.trim().toLowerCase()
  if (!SHA40_RE.test(normBase) || !SHA40_RE.test(normHead) || normBase === normHead) {
    return { kind: 'invalid', reason: 'base/head not distinct 40-char SHAs' }
  }
  const anc = runGitChecked(root, ['merge-base', '--is-ancestor', normBase, normHead], gitDir)
  if (!anc.ok) return { kind: 'invalid', reason: 'base is not an ancestor of head' }

  const scanCap = Math.max(maxCommits, maxNegativeScanCommits)
  const listRes = runGitChecked(
    root,
    ['rev-list', '--first-parent', `--max-count=${scanCap + 1}`, `${normBase}..${normHead}`],
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
  if (commits.length > scanCap) {
    return {
      kind: 'invalid',
      tooManyForNegativeScan: true,
      reason: `first-parent range exceeds max ${scanCap}-commit negative-vote scan limit (incomplete coverage)`,
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
  if (commits.length <= maxCommits) return { kind: 'multi', commits }
  return {
    kind: 'oversized',
    commits,
    reason: `first-parent range (${commits.length} commits) exceeds max ${maxCommits}-commit decomposition limit (require aggregate approval)`,
  }
}
