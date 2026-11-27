/**
 * Multi-Commit First-Parent Range & Local Host Carry-Over Verification (OCV5-912).
 *
 * Supports two post-merge release-train / push scenarios without weakening any security invariant:
 *   1. Host root-only receipt carry-over for cryptographically proven squash/rebase merged PRs
 *      (when the host holds `/opt/openclaude/harness-gate/steward-receipts/<prHeadSha>.json`).
 *   2. Coalesced multi-PR release trains (`baseSha..headSha` with `2 <= N <= 20` first-parent
 *      commits): decomposes the contiguous chain `C1..CN` and verifies EVERY commit against its
 *      direct parent, blocking unreviewed direct commits, any veto/revocation, or any uncovered
 *      A0 / Steward change.
 */
import { spawnSync } from 'node:child_process'

import {
  type ApprovalVerification,
  computeA0ReceiptDigest,
  verifyA0ApprovalUnified,
} from './a0ApprovalReceipt.js'
import {
  type ReceiptLookupResult,
  SHA40_RE,
  type StewardReceiptVerificationResult,
  type StructuralRiskReport,
  type StructuralRiskTriggerCode,
  collectDiffSummaryFromGit,
  evaluateStructuralRisk,
  findStewardReceiptForCommit,
  readCommitMessage,
  verifyArchStewardReceipt,
} from './archStewardContract.js'
import {
  type MergedPrEquivalenceCandidate,
  verifyCommitIsMergedPr,
} from './githubMergedPrEquivalence.js'
import {
  type FetchLike,
  type GithubStewardStatusResult,
  verifyGithubStewardStatus,
} from './githubTrustedApproval.js'

export const MAX_COALESCED_COMMITS = 20

export interface CommitRangeListResult {
  ok: boolean
  commits: string[]
  reason?: string
}

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
 * List the contiguous first-parent commit chain `baseSha..headSha` when `baseSha` is a strict
 * ancestor of `headSha` and contains between 2 and `maxCommits` commits. Fails closed otherwise.
 */
export function listFirstParentCommitsInRange(
  root: string,
  baseSha: string,
  headSha: string,
  gitDir?: string,
  maxCommits = MAX_COALESCED_COMMITS,
): CommitRangeListResult {
  const normBase = baseSha.trim().toLowerCase()
  const normHead = headSha.trim().toLowerCase()
  if (!SHA40_RE.test(normBase) || !SHA40_RE.test(normHead) || normBase === normHead) {
    return { ok: false, commits: [], reason: 'base/head not distinct 40-char SHAs' }
  }
  const anc = runGitChecked(root, ['merge-base', '--is-ancestor', normBase, normHead], gitDir)
  if (!anc.ok) {
    return { ok: false, commits: [], reason: 'base is not an ancestor of head' }
  }
  const listRes = runGitChecked(
    root,
    ['rev-list', '--first-parent', '--reverse', `${normBase}..${normHead}`],
    gitDir,
  )
  if (!listRes.ok || !listRes.stdout) {
    return { ok: false, commits: [], reason: 'failed to enumerate first-parent range' }
  }
  const commits = listRes.stdout
    .split('\n')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => SHA40_RE.test(s))
  if (commits.length < 2) {
    return { ok: false, commits, reason: 'single-commit range does not require decomposition' }
  }
  if (commits.length > maxCommits) {
    return {
      ok: false,
      commits: [],
      reason: `first-parent range has ${commits.length} commits (exceeds max ${maxCommits}; require aggregate approval)`,
    }
  }
  if (commits[commits.length - 1] !== normHead) {
    return { ok: false, commits: [], reason: 'first-parent chain does not terminate at headSha' }
  }
  const firstParent = runGitChecked(root, ['rev-parse', '--verify', `${commits[0]}^1`], gitDir)
  if (!firstParent.ok || firstParent.stdout.toLowerCase() !== normBase) {
    return {
      ok: false,
      commits: [],
      reason: 'first-parent chain does not anchor cleanly at baseSha',
    }
  }
  return { ok: true, commits }
}

export interface LocalStewardCarryOverResult {
  ok: boolean
  vetoed: boolean
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
}

/**
 * Attempt to satisfy Steward approval via host root-only receipt for a verified merged-PR head.
 * Any Steward HARD VETO on a candidate immediately fails closed.
 */
export function verifyLocalHostStewardCarryOver(opts: {
  root: string
  expectedBaseSha: string
  requiredTriggers: readonly StructuralRiskTriggerCode[]
  candidates: readonly MergedPrEquivalenceCandidate[]
  receiptDirs?: readonly string[]
  requireRootOwner: boolean
  hmacKey?: string
  requireHmac: boolean
  allowUntrustedRepoReceipt: boolean
  env?: Readonly<Record<string, string | undefined>>
}): LocalStewardCarryOverResult {
  for (const cand of opts.candidates) {
    const lookup = findStewardReceiptForCommit({
      root: opts.root,
      headSha: cand.prHeadSha,
      receiptDirs: opts.receiptDirs,
      requireRootOwner: opts.requireRootOwner,
      hmacKey: opts.hmacKey,
      allowUntrustedRepoReceipt: opts.allowUntrustedRepoReceipt,
      env: opts.env,
    })
    if (!lookup.found || lookup.error) continue
    let ver = verifyArchStewardReceipt(lookup.raw, {
      headSha: cand.prHeadSha,
      baseSha: opts.expectedBaseSha,
      requiredTriggers: opts.requiredTriggers,
      hmacKey: opts.hmacKey,
      requireHmac: opts.requireHmac,
      rootFileIntegrity: Boolean(lookup.rootOwnerVerified),
    })
    const onlyBaseMismatch =
      !ver.ok &&
      ver.violations.length === 1 &&
      ver.violations[0]?.code === 'STEWARD-RECEIPT-BASE-SHA-MISMATCH'
    if (onlyBaseMismatch && cand.prBaseSha && SHA40_RE.test(cand.prBaseSha)) {
      ver = verifyArchStewardReceipt(lookup.raw, {
        headSha: cand.prHeadSha,
        baseSha: cand.prBaseSha,
        requiredTriggers: opts.requiredTriggers,
        hmacKey: opts.hmacKey,
        requireHmac: opts.requireHmac,
        rootFileIntegrity: Boolean(lookup.rootOwnerVerified),
      })
    }
    const tag = `PR#${cand.prNumber}@${cand.prHeadSha.slice(0, 12)} via ${cand.equivalenceProof}`
    const carriedLookup: ReceiptLookupResult = {
      ...lookup,
      source: `${lookup.source ?? cand.prHeadSha} (carried-over from ${tag})`,
    }
    if (ver.violations.some((v) => v.code === 'STEWARD-HARD-VETO')) {
      return { ok: false, vetoed: true, receiptLookup: carriedLookup, receiptVerification: ver }
    }
    if (ver.ok) {
      return { ok: true, vetoed: false, receiptLookup: carriedLookup, receiptVerification: ver }
    }
  }
  return { ok: false, vetoed: false }
}

export interface StewardRangeVerificationOptions {
  root: string
  baseSha: string
  headSha: string
  gitDir?: string
  receiptDirs?: readonly string[]
  requireRootOwner: boolean
  hmacKey?: string
  requireHmac: boolean
  allowUntrustedRepoReceipt: boolean
  env?: Readonly<Record<string, string | undefined>>
  github?: {
    repo: string
    token: string
    trustedPublishers?: readonly string[]
    apiBaseUrl?: string
    expectedBaseRef?: string
    fetchImpl?: FetchLike
  }
}

export interface StewardRangeVerificationResult {
  ok: boolean
  vetoed: boolean
  summary: string
  failureReason?: string
  vetoLookup?: ReceiptLookupResult
  vetoGithubStatus?: GithubStewardStatusResult
}

async function checkLowRiskCommitProvenance(
  commitSha: string,
  localPassed: boolean,
  ghStatus: GithubStewardStatusResult | undefined,
  opts: StewardRangeVerificationOptions,
): Promise<{ ok: boolean; vetoed: boolean; note: string }> {
  if (localPassed || ghStatus?.valid) {
    return { ok: true, vetoed: false, note: `${commitSha.slice(0, 12)}:low-risk+approved` }
  }
  if (!opts.github) {
    return {
      ok: false,
      vetoed: false,
      note: `commit ${commitSha.slice(0, 12)} is low-risk in multi-commit range without GitHub merged-PR provenance (fail-closed)`,
    }
  }
  const mergedPr = await verifyCommitIsMergedPr({
    repo: opts.github.repo,
    token: opts.github.token,
    targetSha: commitSha,
    expectedBaseRef: opts.github.expectedBaseRef,
    apiBaseUrl: opts.github.apiBaseUrl,
    fetchImpl: opts.github.fetchImpl,
  })
  if (!mergedPr.merged) {
    return {
      ok: false,
      vetoed: false,
      note: `commit ${commitSha.slice(0, 12)} cannot use multi-commit low-risk pass: ${mergedPr.reason}`,
    }
  }
  return {
    ok: true,
    vetoed: false,
    note: `${commitSha.slice(0, 12)}:low-risk(PR#${mergedPr.prNumber})`,
  }
}

function checkLocalStewardForCommit(
  commitSha: string,
  parentSha: string,
  triggers: readonly StructuralRiskTriggerCode[],
  opts: StewardRangeVerificationOptions,
): { passed: boolean; vetoed: boolean; lookup: ReceiptLookupResult } {
  const commitMsg = readCommitMessage(opts.root, commitSha, opts.gitDir)
  const lookup = findStewardReceiptForCommit({
    root: opts.root,
    headSha: commitSha,
    receiptDirs: opts.receiptDirs,
    commitMessage: commitMsg,
    requireRootOwner: opts.requireRootOwner,
    hmacKey: opts.hmacKey,
    allowUntrustedRepoReceipt: opts.allowUntrustedRepoReceipt,
    env: opts.env,
  })
  if (!lookup.found || lookup.error) return { passed: false, vetoed: false, lookup }
  const ver = verifyArchStewardReceipt(lookup.raw, {
    headSha: commitSha,
    baseSha: parentSha,
    requiredTriggers: triggers,
    hmacKey: opts.hmacKey,
    requireHmac: opts.requireHmac,
    rootFileIntegrity: Boolean(lookup.rootOwnerVerified),
  })
  const vetoed = ver.violations.some((v) => v.code === 'STEWARD-HARD-VETO')
  return { passed: ver.ok, vetoed, lookup }
}

async function verifyOneCommitInStewardRange(
  commitSha: string,
  parentSha: string,
  opts: StewardRangeVerificationOptions,
): Promise<{
  ok: boolean
  vetoed: boolean
  note: string
  vetoLookup?: ReceiptLookupResult
  vetoGithubStatus?: GithubStewardStatusResult
}> {
  const diff = collectDiffSummaryFromGit({
    root: opts.root,
    baseRef: parentSha,
    headRef: commitSha,
    gitDir: opts.gitDir,
  })
  const risk: StructuralRiskReport = evaluateStructuralRisk(diff, { root: opts.root })
  const local = checkLocalStewardForCommit(commitSha, parentSha, risk.triggers, opts)
  if (local.vetoed) {
    return {
      ok: false,
      vetoed: true,
      note: `commit ${commitSha.slice(0, 12)} has local Steward HARD VETO`,
      vetoLookup: local.lookup,
    }
  }

  const ghStatus = opts.github
    ? await verifyGithubStewardStatus({
        repo: opts.github.repo,
        token: opts.github.token,
        headSha: commitSha,
        trustedPublishers: opts.github.trustedPublishers,
        apiBaseUrl: opts.github.apiBaseUrl,
        allowMergedPrCarryOver: true,
        expectedBaseRef: opts.github.expectedBaseRef,
        fetchImpl: opts.github.fetchImpl,
      })
    : undefined
  if (ghStatus?.verdict === 'veto') {
    return {
      ok: false,
      vetoed: true,
      note: `commit ${commitSha.slice(0, 12)} has GitHub Steward VETO`,
      vetoGithubStatus: ghStatus,
    }
  }

  if (!risk.requiresSteward) {
    return checkLowRiskCommitProvenance(commitSha, local.passed, ghStatus, opts)
  }
  if (local.passed)
    return { ok: true, vetoed: false, note: `${commitSha.slice(0, 12)}:host-approved` }
  if (ghStatus?.valid)
    return { ok: true, vetoed: false, note: `${commitSha.slice(0, 12)}:github-approved` }

  if (ghStatus?.equivalenceCandidates && ghStatus.equivalenceCandidates.length > 0) {
    const carried = verifyLocalHostStewardCarryOver({
      root: opts.root,
      expectedBaseSha: parentSha,
      requiredTriggers: risk.triggers,
      candidates: ghStatus.equivalenceCandidates,
      receiptDirs: opts.receiptDirs,
      requireRootOwner: opts.requireRootOwner,
      hmacKey: opts.hmacKey,
      requireHmac: opts.requireHmac,
      allowUntrustedRepoReceipt: opts.allowUntrustedRepoReceipt,
      env: opts.env,
    })
    if (carried.vetoed) {
      return {
        ok: false,
        vetoed: true,
        note: `commit ${commitSha.slice(0, 12)} carried-over host receipt has HARD VETO`,
        vetoLookup: carried.receiptLookup,
      }
    }
    if (carried.ok)
      return { ok: true, vetoed: false, note: `${commitSha.slice(0, 12)}:host-carryover-approved` }
  }
  return {
    ok: false,
    vetoed: false,
    note: `commit ${commitSha.slice(0, 12)} triggered Steward (${risk.triggers.join(', ')}) with no valid approval`,
  }
}

/**
 * Decompose a coalesced multi-PR release train (`baseSha..headSha`) commit-by-commit.
 * Fails closed unless EVERY commit is verified (no veto, no unmerged split-commit bypass,
 * and every high-risk commit has valid cross-family Steward approval).
 */
export async function verifyStewardCommitRangeFallback(
  opts: StewardRangeVerificationOptions,
): Promise<StewardRangeVerificationResult> {
  const range = listFirstParentCommitsInRange(opts.root, opts.baseSha, opts.headSha, opts.gitDir)
  if (!range.ok) {
    return { ok: false, vetoed: false, summary: '', failureReason: range.reason }
  }
  const notes: string[] = []
  let parent = opts.baseSha
  for (const commitSha of range.commits) {
    const step = await verifyOneCommitInStewardRange(commitSha, parent, opts)
    if (!step.ok) {
      return {
        ok: false,
        vetoed: step.vetoed,
        summary: notes.join(', '),
        failureReason: step.note,
        vetoLookup: step.vetoLookup,
        vetoGithubStatus: step.vetoGithubStatus,
      }
    }
    notes.push(step.note)
    parent = commitSha
  }
  return {
    ok: true,
    vetoed: false,
    summary: `multi-commit-range(${range.commits.length}): ${notes.join(', ')}`,
  }
}

export interface MergedGithubStewardInput {
  mode: 'enforce-commit' | 'enforce-pr' | 'check-only'
  headSha: string
  baseSha: string
  risk: StructuralRiskReport
  passed: boolean
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
}

/** Merge local receipt check with GitHub `oc-v5/arch-steward` status (B3 cross-channel veto precedence). */
export function mergeGithubStewardOutcome(
  local: MergedGithubStewardInput,
  githubStatus: GithubStewardStatusResult,
): {
  ok: boolean
  exitCode: 0 | 1
  mode: MergedGithubStewardInput['mode']
  headSha: string
  baseSha: string
  risk: StructuralRiskReport
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
  githubStatus: GithubStewardStatusResult
} {
  const searched = [...(local.receiptLookup?.searchedLocations ?? []), githubStatus.source]
  const failExit: 0 | 1 = local.mode === 'check-only' ? 0 : 1
  const base = {
    mode: local.mode,
    headSha: local.headSha,
    baseSha: local.baseSha,
    risk: local.risk,
  }
  if (githubStatus.verdict === 'veto') {
    return {
      ...base,
      ok: false,
      exitCode: failExit,
      receiptLookup: {
        found: true,
        channel: 'github-status',
        source: githubStatus.source,
        error: githubStatus.reason,
        searchedLocations: searched,
      },
      receiptVerification: local.receiptVerification,
      githubStatus,
    }
  }
  if (local.passed) {
    return {
      ...base,
      ok: true,
      exitCode: 0,
      receiptLookup: local.receiptLookup,
      receiptVerification: local.receiptVerification,
      githubStatus,
    }
  }
  if (githubStatus.valid) {
    return {
      ...base,
      ok: true,
      exitCode: 0,
      receiptLookup: {
        found: true,
        channel: 'github-status',
        source: githubStatus.source,
        searchedLocations: searched,
      },
      githubStatus,
    }
  }
  return {
    ...base,
    ok: false,
    exitCode: failExit,
    receiptLookup: {
      found: local.receiptLookup?.found ?? false,
      channel: local.receiptLookup?.channel,
      source: local.receiptLookup?.source ?? githubStatus.source,
      raw: local.receiptLookup?.raw,
      error: local.receiptLookup?.error
        ? `${local.receiptLookup.error}; github: ${githubStatus.reason}`
        : githubStatus.reason,
      searchedLocations: searched,
    },
    receiptVerification: local.receiptVerification,
    githubStatus,
  }
}

export interface PostMergeStewardFallbackResult {
  ok: boolean
  vetoed: boolean
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
  githubStatus?: GithubStewardStatusResult
}

/**
 * Post-merge (`--enforce-commit`) Steward fallback: tries carried-over host root receipts
 * for verified merged-PR heads, then coalesced multi-PR commit-range decomposition.
 */
export async function resolvePostMergeStewardFallback(opts: {
  root: string
  baseSha: string
  headSha: string
  gitDir?: string
  requiredTriggers: readonly StructuralRiskTriggerCode[]
  receiptDirs?: readonly string[]
  requireRootOwner: boolean
  hmacKey?: string
  requireHmac: boolean
  allowUntrustedRepoReceipt: boolean
  env?: Readonly<Record<string, string | undefined>>
  localSearchedLocations?: readonly string[]
  githubStatus?: GithubStewardStatusResult
  github?: StewardRangeVerificationOptions['github']
}): Promise<PostMergeStewardFallbackResult | null> {
  if (opts.githubStatus?.equivalenceCandidates?.length) {
    const hostCarry = verifyLocalHostStewardCarryOver({
      root: opts.root,
      expectedBaseSha: opts.baseSha,
      requiredTriggers: opts.requiredTriggers,
      candidates: opts.githubStatus.equivalenceCandidates,
      receiptDirs: opts.receiptDirs,
      requireRootOwner: opts.requireRootOwner,
      hmacKey: opts.hmacKey,
      requireHmac: opts.requireHmac,
      allowUntrustedRepoReceipt: opts.allowUntrustedRepoReceipt,
      env: opts.env,
    })
    if (hostCarry.vetoed || hostCarry.ok) {
      return {
        ok: hostCarry.ok,
        vetoed: hostCarry.vetoed,
        receiptLookup: hostCarry.receiptLookup,
        receiptVerification: hostCarry.receiptVerification,
        githubStatus: opts.githubStatus,
      }
    }
  }
  const rangeRes = await verifyStewardCommitRangeFallback({
    root: opts.root,
    baseSha: opts.baseSha,
    headSha: opts.headSha,
    gitDir: opts.gitDir,
    receiptDirs: opts.receiptDirs,
    requireRootOwner: opts.requireRootOwner,
    hmacKey: opts.hmacKey,
    requireHmac: opts.requireHmac,
    allowUntrustedRepoReceipt: opts.allowUntrustedRepoReceipt,
    env: opts.env,
    github: opts.github,
  })
  if (rangeRes.ok) {
    return {
      ok: true,
      vetoed: false,
      receiptLookup: {
        found: true,
        channel: opts.github ? 'github-status' : 'host-file',
        source: rangeRes.summary,
        searchedLocations: [...(opts.localSearchedLocations ?? [])],
      },
      githubStatus: opts.githubStatus,
    }
  }
  if (rangeRes.vetoed) {
    return {
      ok: false,
      vetoed: true,
      receiptLookup: rangeRes.vetoLookup,
      githubStatus: rangeRes.vetoGithubStatus ?? opts.githubStatus,
    }
  }
  return null
}

/**
 * Decompose a multi-commit A0 range (`baseSha..headSha`) commit-by-commit under the pinned
 * `baseSha` A0 policy. Every commit introducing A0 changes must carry its own valid A0 approval
 * (direct or merged-PR carry-over), and the union of approved paths must cover 100% of the
 * aggregate A0 diff.
 */
export async function verifyA0CommitRangeFallback(opts: {
  root: string
  baseSha: string
  headSha: string
  aggregateA0Paths: readonly string[]
  classifyCommitA0Paths: (parentSha: string, commitSha: string) => string[]
  approvalDir: string
  requireRootOwner: boolean
  hmacKeyFile?: string
  hmacKey?: string
  nowMs?: number
  github?: {
    repo?: string
    token?: string
    trustedApprovers?: readonly string[]
    apiBaseUrl?: string
    expectedBaseRef?: string
    fetchImpl?: FetchLike
  }
}): Promise<ApprovalVerification | null> {
  const range = listFirstParentCommitsInRange(opts.root, opts.baseSha, opts.headSha)
  if (!range.ok) return null

  const approvedPaths = new Set<string>()
  const approvedTrail: string[] = []
  let primarySource: 'host-file' | 'github-status' | 'github-pr-review' = 'host-file'
  let primaryApprover: string | undefined
  let parent = opts.baseSha

  for (const commitSha of range.commits) {
    const commitA0Paths = opts.classifyCommitA0Paths(parent, commitSha)
    parent = commitSha
    if (commitA0Paths.length === 0) continue

    const res = await verifyA0ApprovalUnified({
      approvalDir: opts.approvalDir,
      targetSha: commitSha,
      a0Paths: commitA0Paths,
      requireRootOwner: opts.requireRootOwner,
      hmacKeyFile: opts.hmacKeyFile,
      hmacKey: opts.hmacKey,
      nowMs: opts.nowMs,
      github: opts.github ? { ...opts.github, allowMergedPrCarryOver: true } : undefined,
    })
    if (!res.valid) {
      return {
        valid: false,
        receiptPath: res.receiptPath,
        reason: `commit ${commitSha.slice(0, 12)} unapproved A0 change (${commitA0Paths.join(', ')}): ${res.reason}`,
        ...(res.revoked ? { revoked: true } : {}),
      }
    }
    for (const p of commitA0Paths) approvedPaths.add(p)
    primarySource = res.source
    primaryApprover = primaryApprover ?? res.receipt.approvedBy
    approvedTrail.push(`${commitSha.slice(0, 12)}[${res.source}]`)
  }

  const uncovered = opts.aggregateA0Paths.filter((p) => !approvedPaths.has(p))
  if (uncovered.length > 0) {
    return {
      valid: false,
      receiptPath: `range:${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
      reason: `multi-commit range did not cover aggregate A0 paths: ${uncovered.join(', ')}`,
    }
  }

  const nowMs = opts.nowMs ?? Date.now()
  const issuedAt = new Date(nowMs).toISOString()
  const expiresAt = new Date(nowMs + 24 * 3600_000).toISOString()
  const reason = `All A0 commits in range approved (${approvedTrail.join(', ')})`
  return {
    valid: true,
    receiptPath: `multi-commit-range(${range.commits.length}): ${approvedTrail.join(', ')}`,
    source: primarySource,
    receipt: {
      schemaVersion: 1,
      sha: opts.headSha,
      reason,
      approvedBy: primaryApprover,
      issuedAt,
      expiresAt,
      sha256: computeA0ReceiptDigest({ sha: opts.headSha, issuedAt, expiresAt, reason }),
      source: primarySource,
    },
  }
}
