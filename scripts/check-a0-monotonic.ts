/**
 * A0 / A1 Monotonic Separation Referee (OCV5-904 / OCV5-903 B2, B3, B7).
 *
 * Mechanically classifies repository diffs into:
 *   - A1 (auto-pass): adding new gate scripts, tightening thresholds/limits/slack,
 *     splitting `arch/modules.json` modules without adding `allow` edges or authorities,
 *     monotonically reducing baselines, or updating declarative `deploy/v5/runtime-image-pin.json`.
 *   - A0 (hard-block, exit 1): deleting, renaming, or modifying existing gate scripts, loosening
 *     any threshold/limit/slack/budget, adding or renewing `file-size-ratchet-exceptions.json`,
 *     adding `allow` edges or authorities in `arch/modules.json`, raising any baseline,
 *     deleting/renaming declarative pins or baselines, or modifying A0 meta-layer paths,
 *     UNLESS authorized by an out-of-commit trusted approval bound to the exact `headSha`:
 *       1. Host root-only A0 approval receipt at
 *          `/opt/openclaude/harness-gate/control/a0-approvals/<head_sha>.json`
 *          (enforcing uid===0, non-symlink, non-group/world-writable, canonical digest + optional HMAC); OR
 *       2. Out-of-commit GitHub trusted approval (`--github-repo` / `GITHUB_REPOSITORY` + `GITHUB_TOKEN`):
 *          - Commit Status `oc-v5/a0-approval` (`state === "success"`, trusted owner/CODEOWNER, exact SHA); OR
 *          - PR CODEOWNER `APPROVED` review bound to exact `prHeadSha` (`commit_id === headSha`).
 *
 * Usage:
 *   npx tsx scripts/check-a0-monotonic.ts [--root <repo>] [--base <git-ref>] [--head <git-ref>]
 *     [--staged] [--json] [--approval-dir <dir>] [--hmac-key-file <path>]
 *     [--require-root-owner] [--unsafe-test-skip-owner]
 *     [--github-repo <owner/repo>] [--github-token-env <ENV>] [--pr-number <n>]
 *     [--trusted-approvers <csv>] [--github-api-url <url>]
 *
 * Exit: 0 pass (no A0 block or valid approval), 1 A0 hard-blocked, 2 usage/git/policy error.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  type A0Category,
  type A0Finding,
  type A0Policy,
  type ApprovalVerification,
  type DiffEntry,
  type DiffStatus,
  POLICY_PATH,
  evaluateFileSizeBaselineChange,
  evaluateFileSizeExceptionsChange,
  evaluateModulesJsonChange,
  evaluateRuntimeImagePinChange,
  evaluateShrinkOnlyJsonChange,
  matchesAnyGlob,
  parseNameStatusZ,
  parsePolicy,
  validateBootstrapNonWeakening,
  verifyA0ApprovalReceipt,
  verifyA0ApprovalUnified,
} from './lib/a0MonotonicRules.js'
import { resolveA0ApprovalForMultiCommitRange } from './lib/a0RangeCarryOver.js'
import { inspectFirstParentRange } from './lib/commitRangeCarryOver.js'
import { type FetchLike, resolveGithubToken } from './lib/githubTrustedApproval.js'

export {
  type A0Category,
  type A0Policy,
  type DiffEntry,
  type DiffStatus,
  POLICY_PATH,
  parseNameStatusZ,
  parsePolicy,
  validateBootstrapNonWeakening,
}

export const DEFAULT_HOST_APPROVAL_DIR = '/opt/openclaude/harness-gate/control/a0-approvals'

export interface CheckA0Result {
  ok: boolean
  bootstrap?: boolean
  bootstrapErrors?: string[]
  mode: 'base' | 'staged'
  targetSha: string
  changedFiles: number
  a1Passes: A0Finding[]
  a0Blocks: A0Finding[]
  approval?: ApprovalVerification
}

export interface CheckA0Options {
  root: string
  base?: string
  head?: string
  staged?: boolean
  prNumber?: number
  approvalDir?: string
  hmacKeyFile?: string
  hmacKey?: string
  requireRootOwner?: boolean
  nowMs?: number
  github?: {
    repo?: string
    token?: string
    prNumber?: number
    trustedApprovers?: readonly string[]
    apiBaseUrl?: string
    allowMergedPrCarryOver?: boolean
    expectedBaseRef?: string
    fetchImpl?: FetchLike
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
}

function gitFileAt(root: string, ref: string, rel: string): string | null {
  const r = spawnSync('git', ['-C', root, 'show', `${ref}:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (r.status !== 0) return null
  return r.stdout
}

function gitStagedFile(root: string, rel: string): string | null {
  const r = spawnSync('git', ['-C', root, 'show', `:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (r.status !== 0) return null
  return r.stdout
}

function findA0PathCategory(filePath: string, policy: A0Policy): A0Category | null {
  for (const cat of policy.a0Categories) {
    if (cat.paths && matchesAnyGlob(filePath, cat.paths)) return cat
  }
  return null
}

function findGateGlobs(policy: A0Policy): string[] {
  const globs = new Set<string>(policy.a1MonotonicSurfaces.newGateGlobs)
  for (const cat of policy.a0Categories) {
    for (const g of cat.gateGlobs ?? []) globs.add(g)
  }
  return [...globs]
}

function classifySinglePath(
  status: Exclude<DiffStatus, 'R'>,
  p: string,
  policy: A0Policy,
  gateGlobs: readonly string[],
  readBase: (p: string) => string | null,
  readHead: (p: string) => string | null,
): A0Finding[] {
  const s = policy.a1MonotonicSurfaces

  // 1. Direct A0 protected categories (always A0 regardless of add/modify/delete)
  const a0Cat = findA0PathCategory(p, policy)
  if (a0Cat) {
    return [
      {
        path: p,
        tier: 'A0',
        category: a0Cat.id,
        rule: status === 'D' ? 'A0-PROTECTED-DELETED' : 'A0-PROTECTED-MODIFIED',
        detail: `${a0Cat.id}: ${status === 'D' ? 'deleted' : 'modified'} protected A0 path "${p}"`,
      },
    ]
  }

  // 2. Gate scripts (`scripts/check-*.ts`, `scripts/check-*.sh`, `lint-*.ts`):
  //    Brand-new gate (status A) -> A1 auto-pass; modifying/deleting existing gate -> A0 hard-block!
  if (matchesAnyGlob(p, gateGlobs)) {
    if (status === 'A') {
      return [
        {
          path: p,
          tier: 'A1',
          rule: 'A1-NEW-GATE-ADDED',
          detail: `added new gate script "${p}"`,
        },
      ]
    }
    return [
      {
        path: p,
        tier: 'A0',
        category: 'existing-gate-deletion-or-modification',
        rule: status === 'D' ? 'A0-GATE-DELETED' : 'A0-GATE-MODIFIED',
        detail: `${status === 'D' ? 'deleted' : 'modified'} existing gate script "${p}"`,
      },
    ]
  }

  // 3. Declarative runtime image pin -> schema + supply-chain validated A1 auto-pass
  if (s.declarativePins.includes(p)) {
    return evaluateRuntimeImagePinChange(p, status === 'D' ? null : readHead(p))
  }

  // 4. Architecture module map (`arch/modules.json`) -> semantic split/allow/authority check
  if (p === s.moduleMap) {
    return evaluateModulesJsonChange(
      p,
      status === 'A' ? null : readBase(p),
      status === 'D' ? null : readHead(p),
    )
  }

  // 5. File-size baseline & exceptions
  if (p === s.fileSizeBaseline) {
    return evaluateFileSizeBaselineChange(
      p,
      status === 'A' ? null : readBase(p),
      status === 'D' ? null : readHead(p),
    )
  }
  if (p === s.fileSizeExceptions) {
    return evaluateFileSizeExceptionsChange(
      p,
      status === 'A' ? null : readBase(p),
      status === 'D' ? null : readHead(p),
    )
  }

  // 6. Exemptions & budgets & monotonic baselines
  if (p === s.designTokensExempt) {
    return evaluateShrinkOnlyJsonChange(
      p,
      status === 'A' ? null : readBase(p),
      status === 'D' ? null : readHead(p),
      { allowDelete: true, mode: 'exemptList' },
    )
  }
  if (p === s.budgets) {
    return evaluateShrinkOnlyJsonChange(
      p,
      status === 'A' ? null : readBase(p),
      status === 'D' ? null : readHead(p),
      { mode: 'budgets' },
    )
  }
  if (p === s.contextEvalBaseline) {
    return evaluateShrinkOnlyJsonChange(
      p,
      status === 'A' ? null : readBase(p),
      status === 'D' ? null : readHead(p),
      { mode: 'contextEval' },
    )
  }
  if (p === s.featureFlagsRegistry) {
    return evaluateShrinkOnlyJsonChange(
      p,
      status === 'A' ? null : readBase(p),
      status === 'D' ? null : readHead(p),
      { mode: 'featureFlags' },
    )
  }
  if (
    p === s.aiSmellsBaseline ||
    p === s.violationsBaseline ||
    s.countRatchetBaselines.includes(p) ||
    s.shrinkOnlyBaselines.includes(p)
  ) {
    return evaluateShrinkOnlyJsonChange(
      p,
      status === 'A' ? null : readBase(p),
      status === 'D' ? null : readHead(p),
      { mode: 'counts' },
    )
  }

  // Non-governance application code: passes neutrally
  return []
}

export function classifyDiffEntry(
  entry: DiffEntry,
  policy: A0Policy,
  readBase: (p: string) => string | null,
  readHead: (p: string) => string | null,
): A0Finding[] {
  const gateGlobs = findGateGlobs(policy)

  // For ANY rename (R), classify BOTH sides:
  //   - `oldPath` as a rename of A0/gate OR deletion of any surface (including A1 pins & baselines!)
  //   - `newPath` as an addition at the destination path.
  if (entry.status === 'R' && entry.oldPath) {
    const findings: A0Finding[] = []
    const oldA0 = findA0PathCategory(entry.oldPath, policy)
    if (oldA0) {
      findings.push({
        path: entry.oldPath,
        tier: 'A0',
        category: oldA0.id,
        rule: 'A0-PROTECTED-RENAMED',
        detail: `A0 protected path "${entry.oldPath}" renamed to "${entry.path}" (${oldA0.id})`,
      })
    } else if (matchesAnyGlob(entry.oldPath, gateGlobs)) {
      findings.push({
        path: entry.oldPath,
        tier: 'A0',
        category: 'existing-gate-deletion-or-modification',
        rule: 'A0-GATE-RENAMED',
        detail: `existing gate "${entry.oldPath}" renamed to "${entry.path}"`,
      })
    } else {
      findings.push(
        ...classifySinglePath('D', entry.oldPath, policy, gateGlobs, readBase, () => null),
      )
    }
    findings.push(...classifySinglePath('A', entry.path, policy, gateGlobs, () => null, readHead))
    return findings
  }

  const singleStatus: Exclude<DiffStatus, 'R'> = entry.status === 'R' ? 'M' : entry.status
  return classifySinglePath(singleStatus, entry.path, policy, gateGlobs, readBase, readHead)
}

interface PreparedDiff {
  mode: 'base' | 'staged'
  policy: A0Policy
  basePolicyText: string | null
  targetSha: string
  changedFiles: number
  a1Passes: A0Finding[]
  a0Blocks: A0Finding[]
}

function prepareA0Diff(opts: CheckA0Options): PreparedDiff {
  const mode: 'base' | 'staged' = opts.staged ? 'staged' : 'base'
  const headRef = opts.head || 'HEAD'

  // Always prefer base's policy when present so a candidate cannot weaken arch/a0-protected-paths.json
  // to hide its own A0 changes. Fall back to head/working tree only on initial introduction.
  const baseRefForPolicy = opts.staged ? 'HEAD' : opts.base
  const basePolicyText = baseRefForPolicy
    ? gitFileAt(opts.root, baseRefForPolicy, POLICY_PATH)
    : null
  const localPolicyAbs = path.join(opts.root, POLICY_PATH)
  const policyText =
    basePolicyText ??
    (opts.staged
      ? gitStagedFile(opts.root, POLICY_PATH)
      : gitFileAt(opts.root, headRef, POLICY_PATH)) ??
    (existsSync(localPolicyAbs) ? readFileSync(localPolicyAbs, 'utf8') : null)
  if (!policyText) {
    throw new Error(`missing ${POLICY_PATH}`)
  }
  const policy = parsePolicy(JSON.parse(policyText))

  let diffEntries: DiffEntry[]
  let targetSha: string
  let readBase: (p: string) => string | null
  let readHead: (p: string) => string | null

  if (mode === 'staged') {
    const raw = git(opts.root, ['diff', '--cached', '--name-status', '-z', '-M'])
    diffEntries = parseNameStatusZ(raw)
    // Use staged tree SHA (never HEAD SHA) so a staged tamper cannot reuse HEAD's A0 receipt
    targetSha = git(opts.root, ['write-tree']).trim()
    readBase = (p) => gitFileAt(opts.root, 'HEAD', p)
    readHead = (p) => gitStagedFile(opts.root, p)
  } else {
    const baseRef = opts.base
    if (!baseRef) {
      throw new Error('base ref required when --staged is not set')
    }
    git(opts.root, ['rev-parse', '--verify', `${baseRef}^{commit}`])
    targetSha = git(opts.root, ['rev-parse', '--verify', `${headRef}^{commit}`]).trim()
    const raw = git(opts.root, ['diff', '--name-status', '-z', '-M', `${baseRef}...${headRef}`])
    diffEntries = parseNameStatusZ(raw)
    readBase = (p) => gitFileAt(opts.root, baseRef, p)
    readHead = (p) => gitFileAt(opts.root, headRef, p)
  }

  const a1Passes: A0Finding[] = []
  const a0Blocks: A0Finding[] = []
  for (const entry of diffEntries) {
    const findings = classifyDiffEntry(entry, policy, readBase, readHead)
    for (const f of findings) {
      if (f.tier === 'A0') a0Blocks.push(f)
      else a1Passes.push(f)
    }
  }

  return {
    mode,
    policy,
    basePolicyText,
    targetSha,
    changedFiles: diffEntries.length,
    a1Passes,
    a0Blocks,
  }
}

function resolveApprovalConfig(
  policy: A0Policy,
  opts: CheckA0Options,
): {
  approvalDir: string
  requireRootOwner: boolean
} {
  const envDir = process.env[policy.approvalDefaults?.envApprovalDir ?? 'OC_A0_APPROVAL_DIR']
  const hostDir = policy.approvalDefaults?.hostApprovalDir ?? DEFAULT_HOST_APPROVAL_DIR
  const approvalDir = opts.approvalDir ?? (envDir?.trim() ? envDir.trim() : hostDir)
  // Production ALWAYS enforces root ownership (even when --approval-dir / env var is overridden!).
  // Skipping root owner requires explicit `requireRootOwner: false` (CLI: --unsafe-test-skip-owner).
  const requireRootOwner = opts.requireRootOwner ?? true
  return { approvalDir, requireRootOwner }
}

/** Synchronous A0 evaluation (local/host approval receipt verification). */
export function runCheckA0Monotonic(opts: CheckA0Options): CheckA0Result {
  const prep = prepareA0Diff(opts)
  if (prep.a0Blocks.length === 0) {
    return {
      ok: true,
      mode: prep.mode,
      targetSha: prep.targetSha,
      changedFiles: prep.changedFiles,
      a1Passes: prep.a1Passes,
      a0Blocks: prep.a0Blocks,
    }
  }

  // Initial policy rollout self-check when base lacks arch/a0-protected-paths.json:
  // Still requires valid out-of-commit A0 approval (no unapproved bootstrap escape hatch!),
  // AND fails closed if the initial policy/diff attempts any weakening.
  let bootstrap: boolean | undefined
  if (prep.mode === 'base' && prep.basePolicyText === null) {
    const bootstrapErrors = validateBootstrapNonWeakening(prep.policy, prep.a0Blocks)
    if (bootstrapErrors.length > 0) {
      return {
        ok: false,
        bootstrap: false,
        bootstrapErrors,
        mode: prep.mode,
        targetSha: prep.targetSha,
        changedFiles: prep.changedFiles,
        a1Passes: prep.a1Passes,
        a0Blocks: prep.a0Blocks,
      }
    }
    bootstrap = true
  }

  const { approvalDir, requireRootOwner } = resolveApprovalConfig(prep.policy, opts)
  const approval = verifyA0ApprovalReceipt({
    approvalDir,
    targetSha: prep.targetSha,
    a0Paths: [...new Set(prep.a0Blocks.map((b) => b.path))],
    requireRootOwner,
    hmacKeyFile: opts.hmacKeyFile,
    hmacKey: opts.hmacKey,
    nowMs: opts.nowMs,
  })

  return {
    ok: approval.valid,
    ...(bootstrap !== undefined ? { bootstrap } : {}),
    mode: prep.mode,
    targetSha: prep.targetSha,
    changedFiles: prep.changedFiles,
    a1Passes: prep.a1Passes,
    a0Blocks: prep.a0Blocks,
    approval,
  }
}

function classifyCommitRangeA0Paths(
  root: string,
  policy: A0Policy,
  parentSha: string,
  commitSha: string,
): string[] {
  const raw = git(root, ['diff', '--name-status', '-z', '-M', `${parentSha}...${commitSha}`])
  const entries = parseNameStatusZ(raw)
  const paths = new Set<string>()
  for (const e of entries) {
    const fs = classifyDiffEntry(
      e,
      policy,
      (p) => gitFileAt(root, parentSha, p),
      (p) => gitFileAt(root, commitSha, p),
    )
    for (const f of fs) {
      if (f.tier === 'A0') paths.add(f.path)
    }
  }
  return [...paths]
}

/** Asynchronous A0 evaluation supporting host root-only receipts, GitHub approvals & multi-commit ranges. */
export async function runCheckA0MonotonicAsync(opts: CheckA0Options): Promise<CheckA0Result> {
  const prep = prepareA0Diff(opts)
  if (prep.a0Blocks.length === 0) {
    return {
      ok: true,
      mode: prep.mode,
      targetSha: prep.targetSha,
      changedFiles: prep.changedFiles,
      a1Passes: prep.a1Passes,
      a0Blocks: prep.a0Blocks,
    }
  }

  let bootstrap: boolean | undefined
  if (prep.mode === 'base' && prep.basePolicyText === null) {
    const bootstrapErrors = validateBootstrapNonWeakening(prep.policy, prep.a0Blocks)
    if (bootstrapErrors.length > 0) {
      return {
        ok: false,
        bootstrap: false,
        bootstrapErrors,
        mode: prep.mode,
        targetSha: prep.targetSha,
        changedFiles: prep.changedFiles,
        a1Passes: prep.a1Passes,
        a0Blocks: prep.a0Blocks,
      }
    }
    bootstrap = true
  }

  const { approvalDir, requireRootOwner } = resolveApprovalConfig(prep.policy, opts)
  const a0Paths = [...new Set(prep.a0Blocks.map((b) => b.path))]
  const effectivePrNum = opts.prNumber ?? opts.github?.prNumber
  const isOpenPr = effectivePrNum !== undefined
  const ghOpts =
    prep.mode === 'staged' || !opts.github
      ? undefined
      : { ...opts.github, prNumber: effectivePrNum }

  let approval: ApprovalVerification
  if (prep.mode === 'base' && !isOpenPr && opts.base) {
    const baseSha = git(opts.root, ['rev-parse', '--verify', `${opts.base}^{commit}`]).trim()
    const rangeInfo = inspectFirstParentRange(opts.root, baseSha, prep.targetSha)
    if (rangeInfo.kind === 'multi') {
      approval = await resolveA0ApprovalForMultiCommitRange({
        root: opts.root,
        baseSha,
        headSha: prep.targetSha,
        commits: rangeInfo.commits,
        aggregateA0Paths: a0Paths,
        classifyCommitA0Paths: (pSha, cSha) =>
          classifyCommitRangeA0Paths(opts.root, prep.policy, pSha, cSha),
        approvalDir,
        requireRootOwner,
        hmacKeyFile: opts.hmacKeyFile,
        hmacKey: opts.hmacKey,
        nowMs: opts.nowMs,
        github: ghOpts,
      })
    } else {
      approval = await verifyA0ApprovalUnified({
        approvalDir,
        targetSha: prep.targetSha,
        a0Paths,
        requireRootOwner,
        hmacKeyFile: opts.hmacKeyFile,
        hmacKey: opts.hmacKey,
        nowMs: opts.nowMs,
        github: ghOpts
          ? {
              ...ghOpts,
              allowMergedPrCarryOver:
                rangeInfo.kind === 'single' ? ghOpts.allowMergedPrCarryOver : false,
            }
          : undefined,
      })
    }
  } else {
    approval = await verifyA0ApprovalUnified({
      approvalDir,
      targetSha: prep.targetSha,
      a0Paths,
      requireRootOwner,
      hmacKeyFile: opts.hmacKeyFile,
      hmacKey: opts.hmacKey,
      nowMs: opts.nowMs,
      github: ghOpts ? { ...ghOpts, allowMergedPrCarryOver: false } : undefined,
    })
  }

  return {
    ok: approval.valid,
    ...(bootstrap !== undefined ? { bootstrap } : {}),
    mode: prep.mode,
    targetSha: prep.targetSha,
    changedFiles: prep.changedFiles,
    a1Passes: prep.a1Passes,
    a0Blocks: prep.a0Blocks,
    approval,
  }
}

async function main(argv: string[]): Promise<number> {
  let root = ''
  let base = ''
  let head = 'HEAD'
  let staged = false
  let asJson = false
  let approvalDir: string | undefined
  let hmacKeyFile: string | undefined
  let requireRootOwner = true
  let githubRepo = process.env.GITHUB_REPOSITORY?.trim() || process.env.GH_REPO?.trim() || undefined
  let githubTokenEnv: string | undefined
  let prNumberRaw = process.env.PR_NUMBER?.trim() || process.env.GITHUB_PR_NUMBER?.trim() || ''
  let trustedApproversRaw = process.env.OC_TRUSTED_APPROVERS?.trim() || ''
  let githubApiUrl = process.env.GITHUB_API_URL?.trim() || undefined
  let expectedBaseBranchArg: string | undefined

  const takeValue = (flag: string, idx: number): string | null => {
    const v = argv[idx]
    if (!v) {
      console.error(`[check-a0-monotonic] ${flag} requires a value`)
      return null
    }
    return v
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--root') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      root = v
    } else if (arg === '--base') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      base = v
    } else if (arg === '--head') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      head = v
    } else if (arg === '--staged') staged = true
    else if (arg === '--json') asJson = true
    else if (arg === '--approval-dir') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      approvalDir = v
    } else if (arg === '--hmac-key-file') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      hmacKeyFile = v
    } else if (arg === '--require-root-owner') requireRootOwner = true
    else if (arg === '--unsafe-test-skip-owner') requireRootOwner = false
    else if (arg === '--github-repo') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      githubRepo = v
    } else if (arg === '--github-token-env') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      githubTokenEnv = v
    } else if (arg === '--pr-number') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      prNumberRaw = v
    } else if (arg === '--trusted-approvers') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      trustedApproversRaw = v
    } else if (arg === '--github-api-url') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      githubApiUrl = v
    } else if (arg === '--expected-base-branch') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      expectedBaseBranchArg = v
    } else {
      console.error(`unknown arg: ${arg}`)
      return 2
    }
  }

  let repoRoot: string
  try {
    repoRoot = root
      ? path.resolve(root)
      : git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  } catch (err) {
    console.error(`[check-a0-monotonic] git root error: ${(err as Error).message}`)
    return 2
  }

  if (!staged && !base) {
    const r = spawnSync(
      'git',
      ['-C', repoRoot, 'rev-parse', '--verify', 'origin/feat/v5-selfhost^{commit}'],
      {
        encoding: 'utf8',
      },
    )
    if (r.status === 0) base = 'origin/feat/v5-selfhost'
    else base = 'HEAD'
  }

  let prNumber: number | undefined
  if (prNumberRaw) {
    const n = Number.parseInt(prNumberRaw, 10)
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`[check-a0-monotonic] invalid --pr-number: ${prNumberRaw}`)
      return 2
    }
    prNumber = n
  }

  const githubToken = resolveGithubToken(githubTokenEnv)
  const trustedApprovers = trustedApproversRaw
    ? trustedApproversRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined

  const expectedBaseRef =
    expectedBaseBranchArg?.trim() ||
    (process.env.GITHUB_REF_TYPE === 'branch' && process.env.GITHUB_REF_NAME?.trim()
      ? process.env.GITHUB_REF_NAME.trim()
      : process.env.OC_V5_EXPECTED_BASE_BRANCH?.trim() || undefined)

  let result: CheckA0Result
  try {
    result = await runCheckA0MonotonicAsync({
      root: repoRoot,
      base: staged ? undefined : base,
      head,
      staged,
      prNumber,
      approvalDir,
      hmacKeyFile,
      requireRootOwner,
      github:
        githubRepo && githubToken
          ? {
              repo: githubRepo,
              token: githubToken,
              prNumber,
              trustedApprovers,
              apiBaseUrl: githubApiUrl,
              expectedBaseRef,
            }
          : undefined,
    })
  } catch (err) {
    console.error(`[check-a0-monotonic] error: ${(err as Error).message}`)
    return 2
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  }

  for (const pass of result.a1Passes) {
    console.log(`[A1-PASS] ${pass.rule} ${pass.path}: ${pass.detail}`)
  }

  if (result.bootstrapErrors && result.bootstrapErrors.length > 0) {
    for (const err of result.bootstrapErrors) {
      console.error(`[GATE-ERROR] A0-BOOTSTRAP-WEAKENED: ${err}`)
    }
  }

  if (result.a0Blocks.length > 0 && result.ok && result.approval?.valid) {
    const bootTag = result.bootstrap ? ' (initial policy self-check verified)' : ''
    console.log(
      `[A0-APPROVED] ${result.a0Blocks.length} A0 change(s)${bootTag} authorized via ${result.approval.source} (${result.approval.receiptPath}, sha=${result.approval.receipt.sha.slice(0, 12)})`,
    )
    return 0
  }

  for (const blk of result.a0Blocks) {
    console.log(`::error file=${blk.path}::[A0-BLOCK] ${blk.rule}: ${blk.detail}`)
    console.error(
      [
        `[GATE-ERROR] A0-MONOTONIC (${blk.rule}) at ${blk.path}`,
        `  Violation : ${blk.detail}`,
        '  Why       : A0 meta-layer guardrails and baseline ceilings cannot be loosened or tampered with autonomously.',
        `  How to Fix: Keep changes strictly A1 (monotonic tighten-only), or obtain an out-of-commit A0 approval bound to exact ${result.targetSha}: host \`oc-governor approve-a0 --sha ${result.targetSha} --reason "..." [--publish-github-status]\` or CODEOWNER PR APPROVED review.`,
        `  Approval  : ${result.approval ? `${result.approval.receiptPath} (${result.approval.valid ? result.approval.receipt.reason : result.approval.reason})` : 'none'}`,
      ].join('\n'),
    )
  }

  console.log(
    `a0-monotonic (${result.mode}, sha=${result.targetSha.slice(0, 12)}): ${result.changedFiles} changed, ${result.a1Passes.length} A1 auto-pass, ${result.a0Blocks.length} A0 blocked -> ${result.ok ? 'PASS' : 'BLOCK'}`,
  )
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[check-a0-monotonic] fatal: ${(err as Error).message}`)
      process.exit(2)
    })
}
