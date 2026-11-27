/**
 * Multi-Commit A0 Release-Train Range Verification (OCV5-912).
 *
 * Security invariants (B2 / B3 / B4 / B5):
 *   - On multi-commit first-parent ranges (`2 <= N <= 20`), scans EVERY commit `C1..CN`:
 *       * Commits touching A0 paths require valid, non-revoked, non-incomplete, non-invalid A0 approval.
 *       * Non-A0 commits (including a non-A0 release tip `headSha`) are STILL checked online for
 *         explicit A0 revocation / `CHANGES_REQUESTED` / `incomplete` / `invalid` statuses (B3).
 *       * Negative/incomplete/invalid votes are aggregated across the ENTIRE range before any
 *         approval or fallback decision (never short-circuited by an earlier unapproved commit).
 *   - For un-decomposable (`> 20` commits / non-linear) OR partially unapproved ranges (with zero
 *     negative/incomplete/invalid votes), a tip-only single-commit approval NEVER authorizes the
 *     range (online OR offline): ONLY an explicit aggregate approval whose signed `reason` binds
 *     `range=<base12>..<head12>` (and has no online revocation/incomplete/invalid) may pass (B2).
 *   - Preserves actual earliest `expiresAt` across constituent approvals instead of extending TTL.
 */
import {
  type ApprovalVerification,
  computeA0ReceiptDigest,
  verifyA0ApprovalUnified,
} from './a0ApprovalReceipt.js'
import { type FirstParentRangeInfo, inspectFirstParentRange } from './gitRangeInspect.js'
import { type FetchLike, verifyGithubA0Approval } from './githubTrustedApproval.js'

export interface A0RangeGithubConfig {
  repo?: string
  token?: string
  prNumber?: number
  trustedApprovers?: readonly string[]
  apiBaseUrl?: string
  allowMergedPrCarryOver?: boolean
  expectedBaseRef?: string
  fetchImpl?: FetchLike
}

export interface A0CommitRangeOptions {
  root: string
  baseSha: string
  headSha: string
  commits: readonly string[]
  aggregateA0Paths: readonly string[]
  classifyCommitA0Paths: (parentSha: string, commitSha: string) => string[]
  approvalDir: string
  requireRootOwner: boolean
  hmacKeyFile?: string
  hmacKey?: string
  nowMs?: number
  github?: A0RangeGithubConfig
}

export function hasExplicitA0RangeBinding(
  reason: string,
  baseSha: string,
  headSha: string,
): boolean {
  const token = `range=${baseSha.slice(0, 12).toLowerCase()}..${headSha.slice(0, 12).toLowerCase()}`
  return reason.toLowerCase().includes(token)
}

async function checkNonA0CommitOnlineNegativeVote(
  commitSha: string,
  opts: A0CommitRangeOptions,
): Promise<ApprovalVerification | null> {
  const ghRepo = opts.github?.repo?.trim()
  const ghToken = opts.github?.token?.trim()
  if (!ghRepo || !ghToken) return null
  const ghRes = await verifyGithubA0Approval({
    repo: ghRepo,
    token: ghToken,
    headSha: commitSha,
    a0Paths: opts.aggregateA0Paths,
    trustedApprovers: opts.github?.trustedApprovers,
    apiBaseUrl: opts.github?.apiBaseUrl,
    allowMergedPrCarryOver: true,
    expectedBaseRef: opts.github?.expectedBaseRef,
    nowMs: opts.nowMs,
    fetchImpl: opts.github?.fetchImpl,
  })
  if (ghRes.revoked || ghRes.denied || ghRes.incomplete || ghRes.invalid) {
    return {
      valid: false,
      receiptPath: ghRes.source,
      reason: `commit ${commitSha.slice(0, 12)} blocked by online A0 negative/invalid/incomplete status: ${ghRes.reason}`,
      ...(ghRes.revoked || ghRes.denied ? { revoked: true } : {}),
      ...(ghRes.incomplete ? { incomplete: true } : {}),
      ...(ghRes.invalid ? { invalid: true } : {}),
    }
  }
  return null
}

export async function verifyA0CommitRangeFallback(
  opts: A0CommitRangeOptions,
): Promise<ApprovalVerification> {
  const approvedPaths = new Set<string>()
  const approvedTrail: string[] = []
  let primarySource: 'host-file' | 'github-status' | 'github-pr-review' = 'host-file'
  let primaryApprover: string | undefined
  let earliestExpiresMs = Number.POSITIVE_INFINITY
  let revokedHit: ApprovalVerification | undefined
  let incompleteHit: ApprovalVerification | undefined
  let invalidHit: ApprovalVerification | undefined
  let firstUnapproved: ApprovalVerification | undefined
  let parent = opts.baseSha

  for (const commitSha of opts.commits) {
    const commitA0Paths = opts.classifyCommitA0Paths(parent, commitSha)
    parent = commitSha
    if (commitA0Paths.length === 0) {
      const neg = await checkNonA0CommitOnlineNegativeVote(commitSha, opts)
      if (neg && !neg.valid) {
        if (neg.revoked) revokedHit = revokedHit ?? neg
        else if (neg.incomplete) incompleteHit = incompleteHit ?? neg
        else if (neg.invalid) invalidHit = invalidHit ?? neg
      }
      continue
    }

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
      const fail: ApprovalVerification = {
        valid: false,
        receiptPath: res.receiptPath,
        reason: `commit ${commitSha.slice(0, 12)} unapproved A0 change (${commitA0Paths.join(', ')}): ${res.reason}`,
        ...(res.revoked ? { revoked: true } : {}),
        ...(res.incomplete ? { incomplete: true } : {}),
        ...(res.invalid ? { invalid: true } : {}),
      }
      if (res.revoked) revokedHit = revokedHit ?? fail
      else if (res.incomplete) incompleteHit = incompleteHit ?? fail
      else if (res.invalid) invalidHit = invalidHit ?? fail
      else firstUnapproved = firstUnapproved ?? fail
      continue
    }
    for (const p of commitA0Paths) approvedPaths.add(p)
    primarySource = res.source
    primaryApprover = primaryApprover ?? res.receipt.approvedBy
    const expMs = Date.parse(res.receipt.expiresAt)
    if (Number.isFinite(expMs) && expMs < earliestExpiresMs) earliestExpiresMs = expMs
    approvedTrail.push(`${commitSha.slice(0, 12)}[${res.source}]`)
  }

  if (revokedHit) return revokedHit
  if (incompleteHit) return incompleteHit
  if (invalidHit) return invalidHit
  if (firstUnapproved) return firstUnapproved

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
  const expiresAt = Number.isFinite(earliestExpiresMs)
    ? new Date(earliestExpiresMs).toISOString()
    : new Date(nowMs + 24 * 3600_000).toISOString()
  const reason = `All A0 commits in range approved (${approvedTrail.join(', ')})`
  return {
    valid: true,
    receiptPath: `multi-commit-range(${opts.commits.length}): ${approvedTrail.join(', ')}`,
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

async function verifyExplicitAggregateRangeA0Approval(
  opts: Omit<A0CommitRangeOptions, 'commits' | 'classifyCommitA0Paths'>,
  fallbackFailure: Extract<ApprovalVerification, { valid: false }>,
): Promise<ApprovalVerification> {
  const direct = await verifyA0ApprovalUnified({
    approvalDir: opts.approvalDir,
    targetSha: opts.headSha,
    a0Paths: opts.aggregateA0Paths,
    requireRootOwner: opts.requireRootOwner,
    hmacKeyFile: opts.hmacKeyFile,
    hmacKey: opts.hmacKey,
    nowMs: opts.nowMs,
    github: opts.github ? { ...opts.github, allowMergedPrCarryOver: false } : undefined,
  })
  if (!direct.valid) {
    return direct.revoked || direct.incomplete || direct.invalid ? direct : fallbackFailure
  }
  if (hasExplicitA0RangeBinding(direct.receipt.reason, opts.baseSha, opts.headSha)) {
    return direct
  }
  return {
    valid: false,
    receiptPath: fallbackFailure.receiptPath,
    reason: `${fallbackFailure.reason} (tip approval on ${opts.headSha.slice(0, 12)} lacks required aggregate binding range=${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)})`,
  }
}

/**
 * Resolve A0 approval for a non-PR base..head range:
 *   - `single`: standard direct + merged-PR carry-over verification.
 *   - `multi` (`2..20`): full commit-by-commit decomposition (with negative-vote scan across ALL
 *     commits including non-A0 tip), falling back ONLY to an explicit `range=<base12>..<head12>`
 *     aggregate approval if zero negative/incomplete/invalid votes exist.
 *   - `invalid` (`>20` or non-linear): fails closed unless an explicit `range=<base12>..<head12>`
 *     aggregate approval exists on `headSha` (plain tip-only approval NEVER passes!).
 */
export async function resolveA0ApprovalForBaseRange(
  opts: Omit<A0CommitRangeOptions, 'commits'> & { rangeInfo?: FirstParentRangeInfo },
): Promise<ApprovalVerification> {
  const rangeInfo = opts.rangeInfo ?? inspectFirstParentRange(opts.root, opts.baseSha, opts.headSha)
  if (rangeInfo.kind === 'single') {
    return verifyA0ApprovalUnified({
      approvalDir: opts.approvalDir,
      targetSha: opts.headSha,
      a0Paths: opts.aggregateA0Paths,
      requireRootOwner: opts.requireRootOwner,
      hmacKeyFile: opts.hmacKeyFile,
      hmacKey: opts.hmacKey,
      nowMs: opts.nowMs,
      github: opts.github,
    })
  }
  if (rangeInfo.kind === 'multi') {
    const rangeRes = await verifyA0CommitRangeFallback({ ...opts, commits: rangeInfo.commits })
    if (rangeRes.valid || rangeRes.revoked || rangeRes.incomplete || rangeRes.invalid) {
      return rangeRes
    }
    return verifyExplicitAggregateRangeA0Approval(opts, rangeRes)
  }
  const invalidFail: ApprovalVerification = {
    valid: false,
    receiptPath: `range:${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
    reason: `cannot decompose A0 range (${rangeInfo.reason}); require aggregate approval binding range=${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
  }
  return verifyExplicitAggregateRangeA0Approval(opts, invalidFail)
}
