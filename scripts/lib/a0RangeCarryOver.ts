/**
 * Multi-Commit A0 Release-Train Range Verification (OCV5-912).
 *
 * Separated cleanly from Steward range verification (`commitRangeCarryOver.ts`) so A0 and
 * Steward range orchestration remain single-responsibility and independently A0-protected.
 *
 * Security invariants (B2 / B3 / B4 / B5):
 *   - On multi-commit first-parent ranges (`N >= 2`), ALWAYS decomposes commit-by-commit FIRST.
 *   - Every commit touching A0 paths under the pinned base policy must have its own valid,
 *     non-revoked, non-incomplete A0 approval; union of approved paths must cover 100% of the
 *     aggregate A0 diff.
 *   - Only allows a direct aggregate tip approval (`allowMergedPrCarryOver: false`) when tip is
 *     NOT a merged PR whose approval only scoped the final sub-interval.
 *   - Preserves actual earliest `expiresAt` across constituent approvals instead of extending TTL.
 */
import {
  type ApprovalVerification,
  computeA0ReceiptDigest,
  verifyA0ApprovalUnified,
} from './a0ApprovalReceipt.js'
import { verifyCommitIsMergedPr } from './githubMergedPrEquivalence.js'
import type { FetchLike } from './githubTrustedApproval.js'

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

export async function verifyA0CommitRangeFallback(
  opts: A0CommitRangeOptions,
): Promise<ApprovalVerification> {
  const approvedPaths = new Set<string>()
  const approvedTrail: string[] = []
  let primarySource: 'host-file' | 'github-status' | 'github-pr-review' = 'host-file'
  let primaryApprover: string | undefined
  let earliestExpiresMs = Number.POSITIVE_INFINITY
  let parent = opts.baseSha

  for (const commitSha of opts.commits) {
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
        ...(res.incomplete ? { incomplete: true } : {}),
      }
    }
    for (const p of commitA0Paths) approvedPaths.add(p)
    primarySource = res.source
    primaryApprover = primaryApprover ?? res.receipt.approvedBy
    const expMs = Date.parse(res.receipt.expiresAt)
    if (Number.isFinite(expMs) && expMs < earliestExpiresMs) earliestExpiresMs = expMs
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

export async function resolveA0ApprovalForMultiCommitRange(
  opts: A0CommitRangeOptions,
): Promise<ApprovalVerification> {
  const rangeRes = await verifyA0CommitRangeFallback(opts)
  if (rangeRes.valid || rangeRes.revoked || rangeRes.incomplete) return rangeRes

  // B2: Only accept an explicit direct aggregate approval on tip (NO carry-over!) when tip is NOT
  // itself a merged PR whose approval only covered the final sub-interval!
  const ghRepo = opts.github?.repo?.trim()
  const ghToken = opts.github?.token?.trim()
  const expectedBase = opts.github?.expectedBaseRef?.trim()
  if (ghRepo && ghToken && expectedBase) {
    const tipPr = await verifyCommitIsMergedPr({
      repo: ghRepo,
      token: ghToken,
      targetSha: opts.headSha,
      expectedBaseRef: expectedBase,
      apiBaseUrl: opts.github?.apiBaseUrl,
      fetchImpl: opts.github?.fetchImpl,
    })
    if (tipPr.incomplete || tipPr.merged) return rangeRes
  }
  const directTip = await verifyA0ApprovalUnified({
    approvalDir: opts.approvalDir,
    targetSha: opts.headSha,
    a0Paths: opts.aggregateA0Paths,
    requireRootOwner: opts.requireRootOwner,
    hmacKeyFile: opts.hmacKeyFile,
    hmacKey: opts.hmacKey,
    nowMs: opts.nowMs,
    github: opts.github ? { ...opts.github, allowMergedPrCarryOver: false } : undefined,
  })
  return directTip.valid || directTip.revoked || directTip.incomplete ? directTip : rangeRes
}
