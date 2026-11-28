/**
 * Out-of-Commit GitHub Trusted Approval & Steward Status Verification (OCV5-903 / OCV5-912).
 *
 * Provides a single tamper-resistant, out-of-commit verification channel shared across
 * hosted GitHub Actions runners (PR / push) and the host release train:
 *   1. A0 Approval (`verifyGithubA0Approval`):
 *      - Channel A: GitHub Commit Status `oc-v5/a0-approval` bound to exact `headSha`.
 *      - Channel B: GitHub PR CODEOWNER `APPROVED` review bound to exact `headSha`
 *        (`review.commit_id === headSha`, with `CHANGES_REQUESTED` overriding approvals).
 *      - Channel C (post-merge only, disabled on open PRs): cryptographically proven merged-PR
 *        carry-over (`exact-tree` or `exact-squash-diff` + tree-entry equality) with full
 *        negative/incomplete aggregation across ALL candidates.
 *   2. Architecture Steward (`verifyGithubStewardStatus`):
 *      - GitHub Commit Status `oc-v5/arch-steward` bound to exact `headSha`, plus fail-closed
 *        post-merge carry-over with order-independent VETO & truncation precedence.
 */
import {
  A0_GITHUB_STATUS_CONTEXT,
  DEFAULT_TRUSTED_APPROVERS,
  type GithubA0ApprovalResult,
  type GithubStewardStatusResult,
  STEWARD_GITHUB_STATUS_CONTEXT,
  evaluateA0CommitStatus,
  evaluatePrReviews,
  findStewardVetoStatus,
  normalizeTrustedLogins,
  parseApprovedStewardStatusEntry,
} from './githubApprovalParsers.js'
import {
  type FetchLike,
  type GithubCommitPullEntry,
  type GithubPrReviewEntry,
  type GithubStatusEntry,
  type MergedPrEquivalenceCandidate,
  type MergedPrEquivalenceProof,
  githubGetPaginatedList,
  resolveMergedPrEquivalence,
  sortStatusesNewestFirst,
} from './githubMergedPrEquivalence.js'

export {
  A0_GITHUB_STATUS_CONTEXT,
  DEFAULT_TRUSTED_APPROVERS,
  STEWARD_GITHUB_STATUS_CONTEXT,
  normalizeTrustedLogins,
}
export type {
  FetchLike,
  GithubA0ApprovalResult,
  GithubCommitPullEntry,
  GithubPrReviewEntry,
  GithubStatusEntry,
  GithubStewardStatusResult,
  MergedPrEquivalenceCandidate,
  MergedPrEquivalenceProof,
}

export const DEFAULT_GITHUB_API_BASE = 'https://api.github.com'

const SHA40_RE = /^[0-9a-f]{40}$/i
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export interface GithubA0ApprovalOptions {
  repo: string
  token: string
  headSha: string
  a0Paths: readonly string[]
  prNumber?: number
  trustedApprovers?: readonly string[]
  apiBaseUrl?: string
  nowMs?: number
  allowMergedPrCarryOver?: boolean
  expectedBaseRef?: string
  fetchImpl?: FetchLike
}

export interface GithubStewardStatusOptions {
  repo: string
  token: string
  headSha: string
  trustedPublishers?: readonly string[]
  apiBaseUrl?: string
  allowMergedPrCarryOver?: boolean
  expectedBaseRef?: string
  fetchImpl?: FetchLike
}

export function resolveGithubApiBase(
  apiBaseUrl?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = (apiBaseUrl ?? env.GITHUB_API_URL ?? DEFAULT_GITHUB_API_BASE).trim()
  return raw.replace(/\/+$/, '') || DEFAULT_GITHUB_API_BASE
}

export function resolveGithubToken(
  tokenEnvName?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (tokenEnvName) {
    const v = env[tokenEnvName]?.trim()
    if (v) return v
  }
  return env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined
}

interface GithubCheckContext {
  repo: string
  token: string
  apiBase: string
  trusted: ReadonlySet<string>
  fetchImpl: FetchLike
}

type A0ProbeState = 'approved' | 'revoked' | 'denied' | 'invalid' | 'incomplete' | 'absent'

async function checkA0StatusOnExactSha(
  ctx: GithubCheckContext,
  sha: string,
  a0Paths: readonly string[],
  nowMs: number,
  sourceBase: string,
): Promise<{ state: A0ProbeState; result?: GithubA0ApprovalResult; note?: string }> {
  const source = `${sourceBase}:status:${A0_GITHUB_STATUS_CONTEXT}@${sha.slice(0, 12)}`
  const statusUrl = `${ctx.apiBase}/repos/${ctx.repo}/commits/${sha}/statuses?per_page=100`
  const statusResp = await githubGetPaginatedList<GithubStatusEntry>(
    statusUrl,
    ctx.token,
    ctx.fetchImpl,
    5,
  )
  if (!statusResp.ok) {
    return {
      state: 'incomplete',
      result: { valid: false, incomplete: true, source, reason: statusResp.reason },
      note: statusResp.reason,
    }
  }
  if (statusResp.truncated) {
    const reason = `truncated ${A0_GITHUB_STATUS_CONTEXT} statuses history on ${sha.slice(0, 12)} (fail-closed)`
    return {
      state: 'incomplete',
      result: { valid: false, incomplete: true, source, reason },
      note: reason,
    }
  }
  const statusEval = evaluateA0CommitStatus(
    statusResp.items,
    sha,
    a0Paths,
    ctx.trusted,
    nowMs,
    sourceBase,
  )
  if (!statusEval) {
    return {
      state: 'absent',
      note: `no trusted ${A0_GITHUB_STATUS_CONTEXT} status on ${sha.slice(0, 12)}`,
    }
  }
  if (statusEval.revoked) return { state: 'revoked', result: statusEval, note: statusEval.reason }
  if (statusEval.valid) return { state: 'approved', result: statusEval }
  return { state: 'invalid', result: { ...statusEval, invalid: true }, note: statusEval.reason }
}

async function checkA0PrReviewOnExactSha(
  ctx: GithubCheckContext,
  prNum: number,
  sha: string,
  sourceBase: string,
): Promise<{ state: A0ProbeState; result?: GithubA0ApprovalResult; note?: string }> {
  const revSource = `${sourceBase}:pr#${prNum}:review@${sha.slice(0, 12)}`
  const revUrl = `${ctx.apiBase}/repos/${ctx.repo}/pulls/${prNum}/reviews?per_page=100`
  const revResp = await githubGetPaginatedList<GithubPrReviewEntry>(
    revUrl,
    ctx.token,
    ctx.fetchImpl,
    10,
  )
  if (!revResp.ok) {
    return {
      state: 'incomplete',
      result: { valid: false, incomplete: true, source: revSource, reason: revResp.reason },
      note: revResp.reason,
    }
  }
  if (revResp.truncated) {
    const reason = `truncated PR#${prNum} reviews history on ${sha.slice(0, 12)} (fail-closed)`
    return {
      state: 'incomplete',
      result: { valid: false, incomplete: true, source: revSource, reason },
      note: reason,
    }
  }
  const revEval = evaluatePrReviews(revResp.items, sha, ctx.trusted, revSource)
  if (revEval.denied) return { state: 'denied', result: revEval, note: revEval.reason }
  if (revEval.valid) return { state: 'approved', result: revEval }
  return { state: 'absent', note: revEval.reason }
}

function attachA0CarryOver(
  res: GithubA0ApprovalResult,
  cand: MergedPrEquivalenceCandidate,
): GithubA0ApprovalResult {
  const tag = `PR#${cand.prNumber}@${cand.prHeadSha.slice(0, 12)} via ${cand.equivalenceProof}`
  return {
    ...res,
    source: `${res.source} (carried-over from ${tag})`,
    reason: `${res.reason} [carried-over from ${tag}]`,
    carriedOverFromPr: cand.prNumber,
    carriedOverFromSha: cand.prHeadSha,
    equivalenceProof: cand.equivalenceProof,
  }
}

async function tryA0MergedPrCarryOver(
  ctx: GithubCheckContext,
  opts: GithubA0ApprovalOptions,
  headSha: string,
  nowMs: number,
  sourceBase: string,
  failureNotes: string[],
): Promise<{ result?: GithubA0ApprovalResult; candidates: MergedPrEquivalenceCandidate[] }> {
  const eqRes = await resolveMergedPrEquivalence({
    repo: ctx.repo,
    token: ctx.token,
    targetSha: headSha,
    expectedBaseRef: opts.expectedBaseRef,
    apiBaseUrl: ctx.apiBase,
    fetchImpl: ctx.fetchImpl,
  })
  if (eqRes.incomplete) {
    return {
      result: {
        valid: false,
        incomplete: true,
        source: `${sourceBase}@${headSha.slice(0, 12)}`,
        reason: `incomplete merged-PR equivalence lookup: ${eqRes.notes.join('; ')}`,
      },
      candidates: [],
    }
  }
  if (eqRes.candidates.length === 0) {
    if (eqRes.notes.length > 0) failureNotes.push(`carry-over: ${eqRes.notes.join('; ')}`)
    return { candidates: [] }
  }
  // B3/B4: Aggregate ALL negative/incomplete/invalid votes across ALL candidates BEFORE picking any approve!
  let negativeHit: GithubA0ApprovalResult | undefined
  let incompleteHit: GithubA0ApprovalResult | undefined
  let invalidHit: GithubA0ApprovalResult | undefined
  let firstApproved: GithubA0ApprovalResult | undefined
  const cleanAbsentCandidates: MergedPrEquivalenceCandidate[] = []

  for (const cand of eqRes.candidates) {
    const stCheck = await checkA0StatusOnExactSha(
      ctx,
      cand.prHeadSha,
      opts.a0Paths,
      nowMs,
      sourceBase,
    )
    const revCheck = await checkA0PrReviewOnExactSha(ctx, cand.prNumber, cand.prHeadSha, sourceBase)
    if (stCheck.state === 'revoked') negativeHit = negativeHit ?? stCheck.result
    if (revCheck.state === 'denied') negativeHit = negativeHit ?? revCheck.result
    if (stCheck.state === 'incomplete') incompleteHit = incompleteHit ?? stCheck.result
    if (revCheck.state === 'incomplete') incompleteHit = incompleteHit ?? revCheck.result
    if (stCheck.state === 'invalid') invalidHit = invalidHit ?? stCheck.result
    if (stCheck.note) failureNotes.push(`PR#${cand.prNumber} status: ${stCheck.note}`)
    if (revCheck.note) failureNotes.push(`PR#${cand.prNumber} review: ${revCheck.note}`)

    const candBlocked =
      stCheck.state === 'revoked' ||
      stCheck.state === 'incomplete' ||
      stCheck.state === 'invalid' ||
      revCheck.state === 'denied' ||
      revCheck.state === 'incomplete'
    if (!candBlocked && !firstApproved) {
      if (stCheck.state === 'approved' && stCheck.result) {
        firstApproved = attachA0CarryOver(stCheck.result, cand)
      } else if (stCheck.state === 'absent' && revCheck.state === 'approved' && revCheck.result) {
        firstApproved = attachA0CarryOver(revCheck.result, cand)
      }
    }
    if (stCheck.state === 'absent' && revCheck.state === 'absent') {
      cleanAbsentCandidates.push(cand)
    }
  }
  if (negativeHit) return { result: negativeHit, candidates: [] }
  if (incompleteHit) return { result: incompleteHit, candidates: [] }
  if (invalidHit) return { result: invalidHit, candidates: [] }
  if (firstApproved) return { result: firstApproved, candidates: [] }
  return { candidates: cleanAbsentCandidates }
}

/**
 * Verify out-of-commit A0 approval via GitHub Commit Status `oc-v5/a0-approval`
 * OR CODEOWNER PR `APPROVED` review bound to exact `headSha` (or cryptographically
 * equivalent squash/rebase merged PR head on post-merge push/train verification).
 */
export async function verifyGithubA0Approval(
  opts: GithubA0ApprovalOptions,
): Promise<GithubA0ApprovalResult> {
  const headSha = opts.headSha.trim().toLowerCase()
  const sourceBase = `github:${opts.repo}`
  if (!REPO_SLUG_RE.test(opts.repo)) {
    return { valid: false, source: sourceBase, reason: `invalid github repo slug "${opts.repo}"` }
  }
  if (!SHA40_RE.test(headSha)) {
    return { valid: false, source: sourceBase, reason: `invalid headSha "${opts.headSha}"` }
  }
  if (!opts.token.trim()) {
    return { valid: false, source: sourceBase, reason: 'missing GitHub API token' }
  }

  const ctx: GithubCheckContext = {
    repo: opts.repo,
    token: opts.token,
    apiBase: resolveGithubApiBase(opts.apiBaseUrl),
    trusted: normalizeTrustedLogins(opts.trustedApprovers),
    fetchImpl: opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
  }
  const nowMs = opts.nowMs ?? Date.now()
  const failureNotes: string[] = []

  // Channel 1: Commit status `oc-v5/a0-approval` on exact `headSha` (revocation/incomplete win immediately!)
  const directStatus = await checkA0StatusOnExactSha(ctx, headSha, opts.a0Paths, nowMs, sourceBase)
  if (directStatus.state === 'revoked' || directStatus.state === 'incomplete') {
    return directStatus.result!
  }
  const directStatusInvalid = directStatus.state === 'invalid'
  if (directStatus.note) failureNotes.push(directStatus.note)

  // Channel 2: PR CODEOWNER reviews bound to exact `headSha` (always evaluated so CHANGES_REQUESTED overrides!)
  const prNumbersToCheck: number[] = []
  if (typeof opts.prNumber === 'number' && Number.isInteger(opts.prNumber) && opts.prNumber > 0) {
    prNumbersToCheck.push(opts.prNumber)
  } else {
    const pullsUrl = `${ctx.apiBase}/repos/${ctx.repo}/commits/${headSha}/pulls?per_page=30`
    const pullsResp = await githubGetPaginatedList<GithubCommitPullEntry>(
      pullsUrl,
      ctx.token,
      ctx.fetchImpl,
      2,
    )
    if (!pullsResp.ok || pullsResp.truncated) {
      return {
        valid: false,
        incomplete: true,
        source: `${sourceBase}@${headSha.slice(0, 12)}`,
        reason: !pullsResp.ok
          ? pullsResp.reason
          : `truncated commits/${headSha.slice(0, 12)}/pulls response (fail-closed)`,
      }
    }
    for (const pr of pullsResp.items) {
      if (typeof pr.number === 'number' && pr.head?.sha?.trim().toLowerCase() === headSha) {
        prNumbersToCheck.push(pr.number)
      }
    }
  }

  let prDenied: GithubA0ApprovalResult | undefined
  let prIncomplete: GithubA0ApprovalResult | undefined
  let prApproved: GithubA0ApprovalResult | undefined
  for (const prNum of prNumbersToCheck) {
    const revCheck = await checkA0PrReviewOnExactSha(ctx, prNum, headSha, sourceBase)
    if (revCheck.state === 'denied') prDenied = prDenied ?? revCheck.result
    else if (revCheck.state === 'incomplete') prIncomplete = prIncomplete ?? revCheck.result
    else if (revCheck.state === 'approved' && !directStatusInvalid)
      prApproved = prApproved ?? revCheck.result
    if (revCheck.note) failureNotes.push(revCheck.note)
  }
  if (prDenied) return prDenied
  if (prIncomplete) return prIncomplete

  const directApprove =
    directStatus.state === 'approved' && directStatus.result ? directStatus.result : prApproved

  // Channel 3: Merged-PR carry-over & negative-vote discovery (F3: even when S has a direct
  // approve in post-merge mode with expectedBaseRef, still scan equivalent PR head(s) H for
  // revocation/denial/incomplete/invalid before accepting!)
  const allowCarryOver =
    opts.prNumber === undefined && opts.allowMergedPrCarryOver !== false && !directStatusInvalid
  if (directApprove) {
    if (allowCarryOver && opts.expectedBaseRef?.trim()) {
      const carryNeg = await tryA0MergedPrCarryOver(
        ctx,
        opts,
        headSha,
        nowMs,
        sourceBase,
        failureNotes,
      )
      if (
        carryNeg.result &&
        (carryNeg.result.revoked ||
          carryNeg.result.denied ||
          carryNeg.result.incomplete ||
          carryNeg.result.invalid)
      ) {
        return carryNeg.result
      }
    }
    return directApprove
  }

  let equivalenceCandidates: MergedPrEquivalenceCandidate[] | undefined
  if (allowCarryOver) {
    const carry = await tryA0MergedPrCarryOver(ctx, opts, headSha, nowMs, sourceBase, failureNotes)
    if (carry.result) return carry.result
    if (carry.candidates.length > 0) equivalenceCandidates = carry.candidates
  }

  return {
    valid: false,
    ...(directStatusInvalid ? { invalid: true } : {}),
    source: `${sourceBase}@${headSha.slice(0, 12)}`,
    reason: failureNotes.join('; ') || `no trusted GitHub A0 approval for ${headSha.slice(0, 12)}`,
    ...(equivalenceCandidates ? { equivalenceCandidates } : {}),
  }
}

type StewardProbeState = 'approved' | 'veto' | 'invalid' | 'incomplete' | 'absent'

async function verifyGithubStewardStatusExactSha(
  ctx: GithubCheckContext,
  targetSha: string,
): Promise<{ state: StewardProbeState; result: GithubStewardStatusResult }> {
  const source = `github:${ctx.repo}:status:${STEWARD_GITHUB_STATUS_CONTEXT}@${targetSha.slice(0, 12)}`
  const statusUrl = `${ctx.apiBase}/repos/${ctx.repo}/commits/${targetSha}/statuses?per_page=100`
  const resp = await githubGetPaginatedList<GithubStatusEntry>(
    statusUrl,
    ctx.token,
    ctx.fetchImpl,
    5,
  )
  if (!resp.ok) {
    return {
      state: 'incomplete',
      result: { valid: false, incomplete: true, source, reason: resp.reason },
    }
  }
  if (resp.truncated) {
    return {
      state: 'incomplete',
      result: {
        valid: false,
        incomplete: true,
        source,
        reason: `truncated ${STEWARD_GITHUB_STATUS_CONTEXT} statuses history on ${targetSha.slice(0, 12)} (fail-closed)`,
      },
    }
  }
  const matching = sortStatusesNewestFirst(
    resp.items.filter((s) => {
      const creator = s.creator?.login?.trim().toLowerCase()
      return (
        s.context === STEWARD_GITHUB_STATUS_CONTEXT && Boolean(creator && ctx.trusted.has(creator))
      )
    }),
  )
  if (matching.length === 0) {
    return {
      state: 'absent',
      result: {
        valid: false,
        source,
        reason: `no trusted ${STEWARD_GITHUB_STATUS_CONTEXT} commit status found for ${targetSha.slice(0, 12)}`,
      },
    }
  }
  const vetoHit = findStewardVetoStatus(matching, source)
  if (vetoHit) return { state: 'veto', result: vetoHit }
  const parsed = parseApprovedStewardStatusEntry(matching[0]!, targetSha, source)
  const state: StewardProbeState = parsed.valid
    ? 'approved'
    : parsed.verdict === 'veto'
      ? 'veto'
      : 'invalid'
  return { state, result: parsed }
}

/**
 * Verify out-of-commit Architecture Steward approval via GitHub Commit Status `oc-v5/arch-steward`.
 * B3/B4/B5: Never carries over on veto/invalid/incomplete target status, evaluates ALL merged-PR
 * candidates before accepting any approve (veto & incomplete always win), and attaches ALL
 * evaluated candidates so callers can verify local host VETO symmetry across every candidate.
 */
export async function verifyGithubStewardStatus(
  opts: GithubStewardStatusOptions,
): Promise<GithubStewardStatusResult> {
  const headSha = opts.headSha.trim().toLowerCase()
  const source = `github:${opts.repo}:status:${STEWARD_GITHUB_STATUS_CONTEXT}@${headSha.slice(0, 12)}`
  if (!REPO_SLUG_RE.test(opts.repo)) {
    return { valid: false, source, reason: `invalid github repo slug "${opts.repo}"` }
  }
  if (!SHA40_RE.test(headSha)) {
    return { valid: false, source, reason: `invalid headSha "${opts.headSha}"` }
  }
  if (!opts.token.trim()) {
    return { valid: false, source, reason: 'missing GitHub API token' }
  }

  const ctx: GithubCheckContext = {
    repo: opts.repo,
    token: opts.token,
    apiBase: resolveGithubApiBase(opts.apiBaseUrl),
    trusted: normalizeTrustedLogins(opts.trustedPublishers),
    fetchImpl: opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike),
  }

  const direct = await verifyGithubStewardStatusExactSha(ctx, headSha)
  if (
    direct.state === 'veto' ||
    direct.state === 'incomplete' ||
    direct.state === 'invalid' ||
    opts.allowMergedPrCarryOver === false
  ) {
    return direct.result
  }
  // F3: When S has a direct approve in post-merge mode AND expectedBaseRef is bound, STILL discover
  // equivalent merged-PR head(s) H to enforce negative-vote supremacy (GitHub & host HARD VETO).
  if (direct.state === 'approved' && !opts.expectedBaseRef?.trim()) {
    return direct.result
  }

  const eqRes = await resolveMergedPrEquivalence({
    repo: ctx.repo,
    token: ctx.token,
    targetSha: headSha,
    expectedBaseRef: opts.expectedBaseRef,
    apiBaseUrl: ctx.apiBase,
    fetchImpl: ctx.fetchImpl,
  })
  if (eqRes.incomplete) {
    return {
      valid: false,
      incomplete: true,
      source,
      reason: `incomplete merged-PR equivalence lookup: ${eqRes.notes.join('; ')}`,
    }
  }

  let vetoHit: GithubStewardStatusResult | undefined
  let incompleteHit: GithubStewardStatusResult | undefined
  let invalidHit: GithubStewardStatusResult | undefined
  let firstApproved: GithubStewardStatusResult | undefined
  const cleanAbsentCandidates: MergedPrEquivalenceCandidate[] = []
  const carryNotes: string[] = []

  for (const cand of eqRes.candidates) {
    const candCheck = await verifyGithubStewardStatusExactSha(ctx, cand.prHeadSha)
    if (candCheck.state === 'veto') vetoHit = vetoHit ?? candCheck.result
    else if (candCheck.state === 'incomplete') incompleteHit = incompleteHit ?? candCheck.result
    else if (candCheck.state === 'invalid') invalidHit = invalidHit ?? candCheck.result
    else if (candCheck.state === 'approved' && !firstApproved && direct.state === 'absent') {
      const tag = `PR#${cand.prNumber}@${cand.prHeadSha.slice(0, 12)} via ${cand.equivalenceProof}`
      firstApproved = {
        ...candCheck.result,
        source: `${candCheck.result.source} (carried-over from ${tag})`,
        reason: `${candCheck.result.reason} [carried-over from ${tag}]`,
        carriedOverFromPr: cand.prNumber,
        carriedOverFromSha: cand.prHeadSha,
        equivalenceProof: cand.equivalenceProof,
        equivalenceCandidates: eqRes.candidates,
      }
    } else if (candCheck.state === 'absent') {
      cleanAbsentCandidates.push(cand)
    }
    if (!candCheck.result.valid) carryNotes.push(`PR#${cand.prNumber}: ${candCheck.result.reason}`)
  }

  if (vetoHit) return vetoHit
  if (incompleteHit) return incompleteHit
  if (invalidHit) return invalidHit
  if (direct.state === 'approved') {
    return {
      ...direct.result,
      ...(eqRes.candidates.length > 0 ? { equivalenceCandidates: eqRes.candidates } : {}),
    }
  }
  if (firstApproved) return firstApproved

  const extra = carryNotes.length > 0 ? carryNotes.join('; ') : eqRes.notes.join('; ')
  return {
    ...direct.result,
    reason: extra ? `${direct.result.reason} (${extra})` : direct.result.reason,
    ...(cleanAbsentCandidates.length > 0 ? { equivalenceCandidates: cleanAbsentCandidates } : {}),
  }
}
