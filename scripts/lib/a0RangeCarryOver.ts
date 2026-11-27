/**
 * Multi-Commit A0 Release-Train Range Verification (OCV5-912).
 *
 * Security invariants (B2 / B3 / B4 / B5 / F2 / W1 / W2):
 *   - `single` (`N === 1`): direct + merged-PR carry-over (including F3 negative-vote scan on H).
 *   - `multi` (`2 <= N <= 20`): scans EVERY commit `C1..CN`:
 *       * A0-touching commits require valid, non-revoked, non-incomplete, non-invalid A0 approval.
 *       * Non-A0 commits (including a non-A0 release tip `headSha`) are checked online with empty
 *         path set (`[]`, avoiding narrow-path false rejections — W2) for revocation/denial/incomplete/invalid.
 *       * Aggregates all negative/incomplete/invalid votes before any approval or aggregate fallback.
 *   - `oversized` (`21 <= N <= 100`): forbids per-commit positive decomposition; requires explicit
 *     aggregate approval binding exact token `range=<base12>..<head12>` (W1: strict token boundary,
 *     rejects duplicate/conflicting `range=` tokens) AND scans ALL N commits online for any
 *     revocation/denial/incomplete/invalid (F2).
 *   - `invalid` (`> 100` commits or non-ancestor/diverged): fails closed (F2: returns `incomplete: true`
 *     when online negative-vote scan limit is exceeded; rejects diverged ranges both online & offline).
 */
import {
  type ApprovalVerification,
  computeA0ReceiptDigest,
  verifyA0ApprovalReceipt,
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

const RANGE_TOKEN_RE = /(?:^|[\s|;])range=([^\s|;]*)(?=$|[\s|;])/gi

/** W1: Strict standalone token check — counts ALL `range=` tokens (including empty) and requires exact match. */
export function hasExplicitA0RangeBinding(
  reason: string,
  baseSha: string,
  headSha: string,
): boolean {
  const expected = `${baseSha.slice(0, 12).toLowerCase()}..${headSha.slice(0, 12).toLowerCase()}`
  const found: string[] = []
  let m: RegExpExecArray | null
  RANGE_TOKEN_RE.lastIndex = 0
  while ((m = RANGE_TOKEN_RE.exec(reason)) !== null) {
    found.push(m[1]!.toLowerCase())
  }
  return found.length === 1 && found[0] === expected
}

async function checkCommitOnlineNegativeVote(
  commitSha: string,
  commitA0Paths: readonly string[],
  opts: Omit<A0CommitRangeOptions, 'commits' | 'classifyCommitA0Paths'>,
): Promise<Extract<ApprovalVerification, { valid: false }> | null> {
  const ghRepo = opts.github?.repo?.trim()
  const ghToken = opts.github?.token?.trim()
  if (!ghRepo || !ghToken) return null
  // F2/W2: Pass each commit's actual A0 paths (`[]` for truly non-A0 commits, real paths for A0 commits)
  // so scope-invalid statuses on A0 commits are caught identically across 2..20 and 21..100 ranges.
  const ghRes = await verifyGithubA0Approval({
    repo: ghRepo,
    token: ghToken,
    headSha: commitSha,
    a0Paths: commitA0Paths,
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

async function scanCommitsForOnlineA0NegativeVotes(
  commits: readonly string[],
  opts: Omit<A0CommitRangeOptions, 'commits'>,
): Promise<Extract<ApprovalVerification, { valid: false }> | null> {
  let revokedHit: Extract<ApprovalVerification, { valid: false }> | undefined
  let incompleteHit: Extract<ApprovalVerification, { valid: false }> | undefined
  let invalidHit: Extract<ApprovalVerification, { valid: false }> | undefined
  let parent = opts.baseSha
  for (const commitSha of commits) {
    const commitA0Paths = opts.classifyCommitA0Paths(parent, commitSha)
    parent = commitSha
    const neg = await checkCommitOnlineNegativeVote(commitSha, commitA0Paths, opts)
    if (!neg) continue
    if (neg.revoked) revokedHit = revokedHit ?? neg
    else if (neg.incomplete) incompleteHit = incompleteHit ?? neg
    else if (neg.invalid) invalidHit = invalidHit ?? neg
  }
  return revokedHit ?? incompleteHit ?? invalidHit ?? null
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
      const neg = await checkCommitOnlineNegativeVote(commitSha, [], opts)
      if (neg) {
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
  // W2: All commits (including headSha with its actual per-commit A0 paths) have already been
  // scanned online for revocation/denial/incomplete/invalid before reaching aggregate fallback.
  // Check the aggregate host receipt directly first so a valid narrow-scope status on a non-A0
  // tip cannot falsely invalidate a valid host aggregate receipt covering aggregateA0Paths.
  const hostRes = verifyA0ApprovalReceipt({
    approvalDir: opts.approvalDir,
    targetSha: opts.headSha,
    a0Paths: opts.aggregateA0Paths,
    requireRootOwner: opts.requireRootOwner,
    hmacKeyFile: opts.hmacKeyFile,
    hmacKey: opts.hmacKey,
    nowMs: opts.nowMs,
  })
  if (
    hostRes.valid &&
    hasExplicitA0RangeBinding(hostRes.receipt.reason, opts.baseSha, opts.headSha)
  ) {
    return hostRes
  }
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
    reason: `${fallbackFailure.reason} (tip approval on ${opts.headSha.slice(0, 12)} lacks standalone aggregate binding range=${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)})`,
  }
}

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
  if (rangeInfo.kind === 'oversized') {
    // F2: Even on 21..100 commits with an explicit aggregate approval, scan ALL commits online
    // for any revocation / CHANGES_REQUESTED / incomplete / invalid before allowing pass!
    const negHit = await scanCommitsForOnlineA0NegativeVotes(rangeInfo.commits, opts)
    if (negHit) return negHit
    const overFail: Extract<ApprovalVerification, { valid: false }> = {
      valid: false,
      receiptPath: `range:${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
      reason: `${rangeInfo.reason}; require aggregate approval binding range=${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
    }
    return verifyExplicitAggregateRangeA0Approval(opts, overFail)
  }
  return {
    valid: false,
    receiptPath: `range:${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
    reason: `cannot verify A0 range (${rangeInfo.reason})`,
    ...(rangeInfo.tooManyForNegativeScan ? { incomplete: true } : {}),
  }
}
