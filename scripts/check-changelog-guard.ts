/**
 * V5 `changelog.json` Guard Gate (Governance Blueprint §4.2 ① / §4.2 ⑤).
 *
 * Prevents autonomous AI agents from modifying user-facing `changelog.json`
 * without explicit Boss approval:
 *   - Trusted CI workflow: passes `--approved-commit <40hex>` after verifying an
 *     exact `@dream-star-end` GitHub PR `APPROVED` review matching `HEAD` SHA
 *     (only permits committed changes when `HEAD === approvedCommit` and working tree is clean).
 *   - Local manual release flow: `BOSS_APPROVED_CHANGELOG=1`.
 *
 * Checks both committed range (`git diff --name-only <base>...HEAD` when `--base`
 * is provided) and uncommitted working-tree / staged changes.
 *
 * Usage:
 *   npx tsx scripts/check-changelog-guard.ts [--root <repo>] [--base <git-ref>]
 *                                            [--approved-commit <40hex>]
 *
 * Exit: 0 ok, 1 unauthorized changelog.json edit, 2 git/usage error (fail-closed).
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PROTECTED_CHANGELOG_PATH = 'changelog.json'
export const APPROVAL_ENV_VAR = 'BOSS_APPROVED_CHANGELOG'
const SHA40_RE = /^[0-9a-f]{40}$/i

export interface ChangelogGuardResult {
  changed: boolean
  approved: boolean
  approvedVia?: 'env' | 'approved-commit'
  headSha: string
  lastChangelogCommit?: string
  approvedCommit?: string
  sources: string[]
}

function runGit(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function splitLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function checkChangelogGuard(opts: {
  root: string
  base?: string
  approvedCommit?: string
  env?: Readonly<Record<string, string | undefined>>
}): ChangelogGuardResult {
  const env = opts.env ?? process.env
  const sources: string[] = []
  let hasDirtyEdit = false

  const headSha = runGit(opts.root, ['rev-parse', '--verify', 'HEAD']).trim()

  if (opts.approvedCommit !== undefined && opts.approvedCommit !== '') {
    if (!SHA40_RE.test(opts.approvedCommit)) {
      throw new Error(
        `invalid --approved-commit ${JSON.stringify(opts.approvedCommit)}: expected 40-char hex git commit SHA`,
      )
    }
  }

  let lastChangelogCommit: string | undefined
  if (opts.base) {
    // Verify ref exists (fail-closed on bad ref)
    runGit(opts.root, ['rev-parse', '--verify', `${opts.base}^{commit}`])
    const committed = splitLines(runGit(opts.root, ['diff', '--name-only', `${opts.base}...HEAD`]))
    if (committed.includes(PROTECTED_CHANGELOG_PATH)) {
      sources.push(`git diff ${opts.base}...HEAD`)
      const mergeBase = runGit(opts.root, ['merge-base', opts.base, 'HEAD']).trim()
      const last = runGit(opts.root, [
        'log',
        '-n',
        '1',
        '--format=%H',
        `${mergeBase}..HEAD`,
        '--',
        PROTECTED_CHANGELOG_PATH,
      ]).trim()
      if (SHA40_RE.test(last)) {
        lastChangelogCommit = last
      }
    }
  }

  // Always check unstaged and staged working-tree edits too
  const unstaged = splitLines(runGit(opts.root, ['diff', '--name-only']))
  if (unstaged.includes(PROTECTED_CHANGELOG_PATH)) {
    sources.push('working tree (unstaged)')
    hasDirtyEdit = true
  }
  const staged = splitLines(runGit(opts.root, ['diff', '--cached', '--name-only']))
  if (staged.includes(PROTECTED_CHANGELOG_PATH)) {
    sources.push('staging area (cached)')
    hasDirtyEdit = true
  }

  const changed = sources.length > 0
  const envApproved = env[APPROVAL_ENV_VAR] === '1'
  const authorizedTarget = (lastChangelogCommit ?? headSha).toLowerCase()
  const commitApproved =
    Boolean(opts.approvedCommit) &&
    !hasDirtyEdit &&
    (opts.approvedCommit!.toLowerCase() === headSha.toLowerCase() ||
      opts.approvedCommit!.toLowerCase() === authorizedTarget)

  const approved = envApproved || commitApproved
  const approvedVia = envApproved ? 'env' : commitApproved ? 'approved-commit' : undefined
  return {
    changed,
    approved,
    approvedVia,
    headSha,
    lastChangelogCommit,
    approvedCommit: opts.approvedCommit || undefined,
    sources,
  }
}

export function formatChangelogViolation(res: ChangelogGuardResult): string {
  const commitNote = res.approvedCommit
    ? ` (--approved-commit ${res.approvedCommit} did not authorize HEAD ${res.headSha} or dirty working tree)`
    : ''
  return [
    `[GATE-ERROR] CHANGELOG-GUARD at ${PROTECTED_CHANGELOG_PATH}:1`,
    `  Violation : ${PROTECTED_CHANGELOG_PATH} was modified (${res.sources.join(', ')}) without valid Boss approval${commitNote}.`,
    '  Why       : User-facing release announcements in changelog.json are strictly human-authored/Boss-approved (Class A CODEOWNERS). Agents must never auto-edit changelog.json.',
    `  How to Fix: Revert unintended edits to ${PROTECTED_CHANGELOG_PATH} (\`git checkout -- ${PROTECTED_CHANGELOG_PATH}\`), obtain @dream-star-end PR approval for exact HEAD SHA (\`--approved-commit <40hex>\`), or for local manual release set \`${APPROVAL_ENV_VAR}=1\`.`,
    '  Re-verify : npx tsx scripts/check-changelog-guard.ts',
  ].join('\n')
}

function main(argv: string[]): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let base: string | undefined
  let approvedCommit: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const val = argv[++i]
      if (!val) {
        console.error('[changelog-guard] --root requires a path')
        return 2
      }
      root = path.resolve(val)
    } else if (argv[i] === '--base') {
      const val = argv[++i]
      if (!val) {
        console.error('[changelog-guard] --base requires a git ref')
        return 2
      }
      base = val
    } else if (argv[i] === '--approved-commit') {
      const val = argv[++i]
      if (val === undefined) {
        console.error('[changelog-guard] --approved-commit requires a 40-char commit SHA')
        return 2
      }
      approvedCommit = val.trim()
    } else {
      console.error(`[changelog-guard] unknown arg: ${argv[i]}`)
      return 2
    }
  }

  try {
    const res = checkChangelogGuard({ root, base, approvedCommit })
    if (res.changed && !res.approved) {
      console.error(formatChangelogViolation(res))
      return 1
    }
    if (res.changed && res.approved) {
      const via =
        res.approvedVia === 'approved-commit'
          ? `--approved-commit=${res.headSha}`
          : `${APPROVAL_ENV_VAR}=1`
      console.log(
        `[changelog-guard] ${PROTECTED_CHANGELOG_PATH} changed (${res.sources.join(', ')}) — explicitly approved via ${via}`,
      )
      return 0
    }
    console.log(
      `[changelog-guard] ok: ${PROTECTED_CHANGELOG_PATH} untouched${base ? ` (base=${base})` : ''}`,
    )
    return 0
  } catch (err) {
    console.error(`[changelog-guard] FAIL-CLOSED: ${(err as Error).message.split('\n')[0]}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
