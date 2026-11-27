/**
 * Out-of-Commit GitHub Trusted Approval & Steward Status Verification (OCV5-903 / B2).
 *
 * Provides a single tamper-resistant, out-of-commit verification channel shared across
 * hosted GitHub Actions runners (PR / push) and the host release train:
 *   1. A0 Approval (`verifyGithubA0Approval`):
 *      - Channel A: GitHub Commit Status `oc-v5/a0-approval` bound to exact `headSha`,
 *        `state === "success"`, issued by a trusted owner/CODEOWNER (default `dream-star-end`),
 *        with description binding short SHA + reason (+ optional expiry / allowedPaths).
 *      - Channel B: GitHub PR CODEOWNER `APPROVED` review bound to exact `headSha`
 *        (`review.commit_id === headSha`, never a synthetic merge SHA) with no newer
 *        `CHANGES_REQUESTED` / `DISMISSED` superseding it.
 *   2. Architecture Steward (`verifyGithubStewardStatus`):
 *      - GitHub Commit Status `oc-v5/arch-steward` bound to exact `headSha`,
 *        `state === "success"`, issued by a trusted publisher, whose payload proves
 *        non-dry-run cross-family approval (`stewardFamily !== authorFamily`,
 *        `verdict=approve`, valid `digest=(sha256|hmac-sha256):<hex>`).
 */
import {
  type FetchLike,
  type GithubCommitPullEntry,
  type GithubPrReviewEntry,
  type GithubStatusEntry,
  type MergedPrEquivalenceCandidate,
  type MergedPrEquivalenceProof,
  extractA0StatusReason,
  githubGetPaginatedList,
  globToRegExpLocal,
  parseKvTokens,
  resolveMergedPrEquivalence,
  sortStatusesNewestFirst,
} from './githubMergedPrEquivalence.js'
import { MODEL_FAMILIES, type ModelFamily } from './modelFamilyClassifier.js'

export type {
  FetchLike,
  GithubCommitPullEntry,
  GithubPrReviewEntry,
  GithubStatusEntry,
  MergedPrEquivalenceCandidate,
  MergedPrEquivalenceProof,
}

export const DEFAULT_GITHUB_API_BASE = 'https://api.github.com'
export const DEFAULT_TRUSTED_APPROVERS = ['dream-star-end'] as const
export const A0_GITHUB_STATUS_CONTEXT = 'oc-v5/a0-approval'
export const STEWARD_GITHUB_STATUS_CONTEXT = 'oc-v5/arch-steward'

const SHA40_RE = /^[0-9a-f]{40}$/i
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const DIGEST_PREFIX_RE = /^(?:sha256|hmac-sha256):[0-9a-f]{12,64}$/i
const DRY_RUN_MARKER_RE = /\b(?:dry[-_]?run|example|mock|placeholder|stub|fake)\b/i
const VALID_MODEL_FAMILY_SET = new Set<string>(MODEL_FAMILIES)

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

export interface GithubA0ApprovalResult {
  valid: boolean
  revoked?: boolean
  channel?: 'github-status' | 'github-pr-review'
  source: string
  approvedBy?: string
  reason: string
  issuedAt?: string
  expiresAt?: string
  digestRef?: string
  carriedOverFromPr?: number
  carriedOverFromSha?: string
  equivalenceProof?: MergedPrEquivalenceProof
  equivalenceCandidates?: MergedPrEquivalenceCandidate[]
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

export interface GithubStewardStatusResult {
  valid: boolean
  source: string
  publishedBy?: string
  authorFamily?: ModelFamily
  stewardFamily?: ModelFamily
  verdict?: 'approve' | 'veto'
  receiptDigest?: string
  createdAt?: string
  reason: string
  carriedOverFromPr?: number
  carriedOverFromSha?: string
  equivalenceProof?: MergedPrEquivalenceProof
  equivalenceCandidates?: MergedPrEquivalenceCandidate[]
}

export function normalizeTrustedLogins(raw?: readonly string[] | string): Set<string> {
  if (typeof raw === 'string') {
    const items = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    return new Set(items.length > 0 ? items : DEFAULT_TRUSTED_APPROVERS)
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const items = raw.map((s) => s.trim().toLowerCase()).filter(Boolean)
    if (items.length > 0) return new Set(items)
  }
  return new Set(DEFAULT_TRUSTED_APPROVERS)
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

async function githubGetPaginated<T>(
  initialUrl: string,
  token: string,
  fetchImpl: FetchLike,
  maxPages = 10,
): Promise<{ ok: true; items: T[] } | { ok: false; reason: string }> {
  const res = await githubGetPaginatedList<T>(initialUrl, token, fetchImpl, maxPages)
  if (!res.ok) return res
  return { ok: true, items: res.items }
}

const REVOKED_MARKER_RE = /\brevok(?:e|ed|ing)\b/i

function findRevokedA0Status(
  matching: readonly GithubStatusEntry[],
  source: string,
): GithubA0ApprovalResult | null {
  for (const st of matching) {
    const desc = (st.description ?? '').trim()
    if (st.state === 'failure' || st.state === 'error' || REVOKED_MARKER_RE.test(desc)) {
      const creator = st.creator?.login?.trim() ?? 'unknown'
      return {
        valid: false,
        revoked: true,
        source,
        approvedBy: creator,
        reason: `trusted ${A0_GITHUB_STATUS_CONTEXT} revocation/failure status takes precedence (state=${JSON.stringify(st.state)}, by=@${creator})`,
      }
    }
  }
  return null
}

function findStewardVetoStatus(
  matching: readonly GithubStatusEntry[],
  source: string,
): GithubStewardStatusResult | null {
  for (const st of matching) {
    const desc = (st.description ?? '').trim()
    const kv = parseKvTokens(desc)
    const verdict = (kv.get('verdict') ?? '').toLowerCase()
    if (st.state === 'failure' || st.state === 'error' || verdict === 'veto') {
      const publishedBy = st.creator?.login?.trim() ?? 'unknown'
      return {
        valid: false,
        source,
        publishedBy,
        verdict: 'veto',
        reason: `trusted ${STEWARD_GITHUB_STATUS_CONTEXT} failure/veto status takes precedence over any approve status (state=${JSON.stringify(st.state)}, verdict=${JSON.stringify(verdict || 'veto')}, by=@${publishedBy})`,
      }
    }
  }
  return null
}

function rejectA0Status(
  source: string,
  approvedBy: string,
  reason: string,
): GithubA0ApprovalResult {
  return { valid: false, source, approvedBy, reason }
}

function evaluateA0CommitStatus(
  statuses: readonly GithubStatusEntry[],
  headSha: string,
  a0Paths: readonly string[],
  trustedApprovers: ReadonlySet<string>,
  nowMs: number,
  sourceBase: string,
): GithubA0ApprovalResult | null {
  const matching = sortStatusesNewestFirst(
    statuses.filter((s) => {
      const creator = s.creator?.login?.trim().toLowerCase()
      return (
        s.context === A0_GITHUB_STATUS_CONTEXT && Boolean(creator && trustedApprovers.has(creator))
      )
    }),
  )
  if (matching.length === 0) return null
  const source = `${sourceBase}:status:${A0_GITHUB_STATUS_CONTEXT}@${headSha.slice(0, 12)}`
  const revokedHit = findRevokedA0Status(matching, source)
  if (revokedHit) return revokedHit

  const latest = matching[0]!
  const creator = latest.creator?.login?.trim() ?? 'unknown'
  if (latest.state !== 'success') {
    return rejectA0Status(
      source,
      creator,
      `latest trusted ${A0_GITHUB_STATUS_CONTEXT} status has state=${JSON.stringify(latest.state)} (expected "success")`,
    )
  }
  const desc = (latest.description ?? '').trim()
  if (!desc)
    return rejectA0Status(
      source,
      creator,
      `${A0_GITHUB_STATUS_CONTEXT} status description is empty`,
    )
  if (DRY_RUN_MARKER_RE.test(desc)) {
    return rejectA0Status(
      source,
      creator,
      `${A0_GITHUB_STATUS_CONTEXT} status contains forbidden dry-run/example marker`,
    )
  }
  const kv = parseKvTokens(desc)
  const boundSha = (kv.get('sha') ?? '').toLowerCase()
  const shortSha12 = headSha.slice(0, 12).toLowerCase()
  const shaBound =
    (boundSha.length >= 8 &&
      /^[0-9a-f]+$/.test(boundSha) &&
      headSha.toLowerCase().startsWith(boundSha)) ||
    desc.toLowerCase().includes(shortSha12)
  if (!shaBound)
    return rejectA0Status(
      source,
      creator,
      `${A0_GITHUB_STATUS_CONTEXT} description does not bind headSha ${shortSha12}`,
    )

  const expStr = kv.get('exp') ?? kv.get('expires') ?? kv.get('expiresat')
  if (expStr) {
    const expMs = Date.parse(expStr)
    if (!Number.isFinite(expMs))
      return rejectA0Status(
        source,
        creator,
        `${A0_GITHUB_STATUS_CONTEXT} has invalid exp timestamp "${expStr}"`,
      )
    if (expMs <= nowMs)
      return rejectA0Status(source, creator, `${A0_GITHUB_STATUS_CONTEXT} expired at ${expStr}`)
  }

  const pathsRaw = kv.get('paths')?.trim() ?? ''
  if (!pathsRaw) {
    return rejectA0Status(
      source,
      creator,
      `${A0_GITHUB_STATUS_CONTEXT} missing required explicit paths= scope token (refusing to treat omitted paths as unrestricted)`,
    )
  }
  if (pathsRaw !== '*') {
    const globs = pathsRaw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    if (globs.length === 0)
      return rejectA0Status(source, creator, `${A0_GITHUB_STATUS_CONTEXT} has empty paths scope`)
    const uncovered = a0Paths.filter((p) => !globs.some((g) => globToRegExpLocal(g).test(p)))
    if (uncovered.length > 0) {
      return rejectA0Status(
        source,
        creator,
        `${A0_GITHUB_STATUS_CONTEXT} paths scope does not cover A0 changes: ${uncovered.join(', ')}`,
      )
    }
  }

  const reasonText = extractA0StatusReason(desc)
  if (reasonText.length < 8) {
    return rejectA0Status(
      source,
      creator,
      `${A0_GITHUB_STATUS_CONTEXT} description must include a reason of at least 8 characters`,
    )
  }
  return {
    valid: true,
    channel: 'github-status',
    source,
    approvedBy: creator,
    reason: reasonText,
    issuedAt: latest.created_at,
    expiresAt: expStr,
    digestRef: kv.get('digest'),
  }
}

function evaluatePrReviews(
  reviews: readonly GithubPrReviewEntry[],
  headSha: string,
  trustedApprovers: ReadonlySet<string>,
  source: string,
): GithubA0ApprovalResult {
  const normHead = headSha.toLowerCase()
  const latestByReviewer = new Map<string, GithubPrReviewEntry>()
  for (const rev of reviews) {
    const login = rev.user?.login?.trim().toLowerCase()
    if (!login || !trustedApprovers.has(login)) continue
    const state = (rev.state ?? '').toUpperCase()
    if (state === 'COMMENTED' || state === 'PENDING' || !state) continue
    latestByReviewer.set(login, rev)
  }

  if (latestByReviewer.size === 0) {
    return {
      valid: false,
      source,
      reason: `no trusted CODEOWNER review found on PR for ${normHead.slice(0, 12)}`,
    }
  }

  for (const [login, rev] of latestByReviewer) {
    if ((rev.state ?? '').toUpperCase() === 'CHANGES_REQUESTED') {
      return {
        valid: false,
        source,
        approvedBy: login,
        reason: `trusted CODEOWNER @${login} requested changes on PR`,
      }
    }
  }

  for (const [login, rev] of latestByReviewer) {
    const state = (rev.state ?? '').toUpperCase()
    const commitId = (rev.commit_id ?? '').trim().toLowerCase()
    if (state === 'APPROVED' && commitId === normHead) {
      return {
        valid: true,
        channel: 'github-pr-review',
        source,
        approvedBy: rev.user?.login?.trim() ?? login,
        reason: `PR APPROVED by CODEOWNER @${rev.user?.login?.trim() ?? login} on exact commit ${normHead.slice(0, 12)}`,
        issuedAt: rev.submitted_at,
      }
    }
  }

  const staleCommits = [...latestByReviewer.values()]
    .map((r) => `${r.user?.login ?? 'unknown'}:${r.state}@${(r.commit_id ?? 'none').slice(0, 12)}`)
    .join(', ')
  return {
    valid: false,
    source,
    reason: `no trusted CODEOWNER APPROVED review bound to exact headSha ${normHead.slice(0, 12)} (found: ${staleCommits})`,
  }
}

interface GithubCheckContext {
  repo: string
  token: string
  apiBase: string
  trusted: ReadonlySet<string>
  fetchImpl: FetchLike
}

async function checkA0StatusOnExactSha(
  ctx: GithubCheckContext,
  sha: string,
  a0Paths: readonly string[],
  nowMs: number,
  sourceBase: string,
): Promise<{ result?: GithubA0ApprovalResult; note?: string }> {
  const statusUrl = `${ctx.apiBase}/repos/${ctx.repo}/commits/${sha}/statuses?per_page=100`
  const statusResp = await githubGetPaginated<GithubStatusEntry>(
    statusUrl,
    ctx.token,
    ctx.fetchImpl,
    5,
  )
  if (!statusResp.ok) return { note: statusResp.reason }
  const statusEval = evaluateA0CommitStatus(
    statusResp.items,
    sha,
    a0Paths,
    ctx.trusted,
    nowMs,
    sourceBase,
  )
  if (statusEval?.valid || statusEval?.revoked) return { result: statusEval }
  return {
    note: statusEval
      ? statusEval.reason
      : `no trusted ${A0_GITHUB_STATUS_CONTEXT} status on ${sha.slice(0, 12)}`,
  }
}

async function checkA0PrReviewOnExactSha(
  ctx: GithubCheckContext,
  prNum: number,
  sha: string,
  sourceBase: string,
): Promise<{ result?: GithubA0ApprovalResult; note?: string }> {
  const revSource = `${sourceBase}:pr#${prNum}:review@${sha.slice(0, 12)}`
  const revUrl = `${ctx.apiBase}/repos/${ctx.repo}/pulls/${prNum}/reviews?per_page=100`
  const revResp = await githubGetPaginated<GithubPrReviewEntry>(
    revUrl,
    ctx.token,
    ctx.fetchImpl,
    10,
  )
  if (!revResp.ok) return { note: revResp.reason }
  const revEval = evaluatePrReviews(revResp.items, sha, ctx.trusted, revSource)
  if (revEval.valid) return { result: revEval }
  return { note: revEval.reason }
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
  if (eqRes.candidates.length === 0) {
    if (eqRes.notes.length > 0) failureNotes.push(`carry-over: ${eqRes.notes.join('; ')}`)
    return { candidates: [] }
  }
  for (const cand of eqRes.candidates) {
    const stCheck = await checkA0StatusOnExactSha(
      ctx,
      cand.prHeadSha,
      opts.a0Paths,
      nowMs,
      sourceBase,
    )
    if (stCheck.result?.revoked) return { result: stCheck.result, candidates: eqRes.candidates }
    if (stCheck.result?.valid) {
      return { result: attachA0CarryOver(stCheck.result, cand), candidates: eqRes.candidates }
    }
    if (stCheck.note) failureNotes.push(`PR#${cand.prNumber} status: ${stCheck.note}`)

    const revCheck = await checkA0PrReviewOnExactSha(ctx, cand.prNumber, cand.prHeadSha, sourceBase)
    if (revCheck.result?.valid) {
      return { result: attachA0CarryOver(revCheck.result, cand), candidates: eqRes.candidates }
    }
    if (revCheck.note) failureNotes.push(`PR#${cand.prNumber} review: ${revCheck.note}`)
  }
  return { candidates: eqRes.candidates }
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

  // Channel 1: Commit status `oc-v5/a0-approval` on exact `headSha` (revocation always takes precedence!)
  const directStatus = await checkA0StatusOnExactSha(ctx, headSha, opts.a0Paths, nowMs, sourceBase)
  if (directStatus.result) return directStatus.result
  if (directStatus.note) failureNotes.push(directStatus.note)

  // Channel 2: PR CODEOWNER APPROVED review bound to exact `headSha`
  const prNumbersToCheck: number[] = []
  if (typeof opts.prNumber === 'number' && Number.isInteger(opts.prNumber) && opts.prNumber > 0) {
    prNumbersToCheck.push(opts.prNumber)
  } else {
    const pullsUrl = `${ctx.apiBase}/repos/${ctx.repo}/commits/${headSha}/pulls?per_page=30`
    const pullsResp = await githubGetPaginated<GithubCommitPullEntry>(
      pullsUrl,
      ctx.token,
      ctx.fetchImpl,
      2,
    )
    if (pullsResp.ok) {
      for (const pr of pullsResp.items) {
        if (typeof pr.number === 'number' && pr.head?.sha?.trim().toLowerCase() === headSha) {
          prNumbersToCheck.push(pr.number)
        }
      }
    }
  }

  for (const prNum of prNumbersToCheck) {
    const revCheck = await checkA0PrReviewOnExactSha(ctx, prNum, headSha, sourceBase)
    if (revCheck.result) return revCheck.result
    if (revCheck.note) failureNotes.push(revCheck.note)
  }

  // Channel 3: Merged-PR squash/rebase carry-over (strictly disabled on open PR checks where prNumber is set)
  const allowCarryOver = opts.allowMergedPrCarryOver ?? opts.prNumber === undefined
  let equivalenceCandidates: MergedPrEquivalenceCandidate[] | undefined
  if (allowCarryOver) {
    const carry = await tryA0MergedPrCarryOver(ctx, opts, headSha, nowMs, sourceBase, failureNotes)
    if (carry.result) return carry.result
    if (carry.candidates.length > 0) equivalenceCandidates = carry.candidates
  }

  return {
    valid: false,
    source: `${sourceBase}@${headSha.slice(0, 12)}`,
    reason: failureNotes.join('; ') || `no trusted GitHub A0 approval for ${headSha.slice(0, 12)}`,
    ...(equivalenceCandidates ? { equivalenceCandidates } : {}),
  }
}

function parseApprovedStewardStatusEntry(
  latest: GithubStatusEntry,
  targetSha: string,
  source: string,
): GithubStewardStatusResult {
  const publishedBy = latest.creator?.login?.trim() ?? 'unknown'
  const desc = (latest.description ?? '').trim()
  if (latest.state !== 'success') {
    return {
      valid: false,
      source,
      publishedBy,
      verdict: 'veto',
      reason: `latest trusted ${STEWARD_GITHUB_STATUS_CONTEXT} status has state=${JSON.stringify(latest.state)} (expected "success")`,
    }
  }
  if (!desc) {
    return {
      valid: false,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} status description is empty`,
    }
  }
  if (DRY_RUN_MARKER_RE.test(desc)) {
    return {
      valid: false,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} status contains forbidden dry-run/example/mock marker`,
    }
  }
  const kv = parseKvTokens(desc)
  const verdict = (kv.get('verdict') ?? '').toLowerCase()
  const shaToken = (kv.get('sha') ?? '').toLowerCase()
  const authorFamily = (kv.get('author') ?? kv.get('authorfamily') ?? '').toLowerCase()
  const stewardFamily = (kv.get('steward') ?? kv.get('stewardfamily') ?? '').toLowerCase()
  const digest = kv.get('digest') ?? kv.get('receiptdigest') ?? ''

  if (verdict !== 'approve') {
    return {
      valid: false,
      source,
      publishedBy,
      verdict: verdict === 'veto' ? 'veto' : undefined,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} requires verdict=approve (got ${JSON.stringify(verdict || 'missing')})`,
    }
  }
  if (shaToken.length < 12 || !/^[0-9a-f]+$/.test(shaToken) || !targetSha.startsWith(shaToken)) {
    return {
      valid: false,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} sha=${JSON.stringify(shaToken)} does not bind headSha ${targetSha.slice(0, 12)}`,
    }
  }
  if (!VALID_MODEL_FAMILY_SET.has(authorFamily) || !VALID_MODEL_FAMILY_SET.has(stewardFamily)) {
    return {
      valid: false,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} requires known author/steward model families (got author=${JSON.stringify(authorFamily)}, steward=${JSON.stringify(stewardFamily)})`,
    }
  }
  if (authorFamily === stewardFamily) {
    return {
      valid: false,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} rejected same-family review (${authorFamily} === ${stewardFamily})`,
    }
  }
  if (!DIGEST_PREFIX_RE.test(digest)) {
    return {
      valid: false,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} missing valid receiptDigest token (expected sha256:<hex> or hmac-sha256:<hex>)`,
    }
  }
  return {
    valid: true,
    source,
    publishedBy,
    authorFamily: authorFamily as ModelFamily,
    stewardFamily: stewardFamily as ModelFamily,
    verdict: 'approve',
    receiptDigest: digest,
    createdAt: latest.created_at,
    reason: `trusted ${STEWARD_GITHUB_STATUS_CONTEXT} approved by @${publishedBy} (${authorFamily} -> ${stewardFamily}, digest=${digest})`,
  }
}

async function verifyGithubStewardStatusExactSha(
  ctx: GithubCheckContext,
  targetSha: string,
): Promise<{ result: GithubStewardStatusResult; statusMissing: boolean }> {
  const source = `github:${ctx.repo}:status:${STEWARD_GITHUB_STATUS_CONTEXT}@${targetSha.slice(0, 12)}`
  const statusUrl = `${ctx.apiBase}/repos/${ctx.repo}/commits/${targetSha}/statuses?per_page=100`
  const resp = await githubGetPaginated<GithubStatusEntry>(statusUrl, ctx.token, ctx.fetchImpl, 5)
  if (!resp.ok) {
    return { result: { valid: false, source, reason: resp.reason }, statusMissing: false }
  }
  const matching = sortStatusesNewestFirst(
    resp.items.filter((s) => {
      if (s.context !== STEWARD_GITHUB_STATUS_CONTEXT) return false
      const creator = s.creator?.login?.trim().toLowerCase()
      return Boolean(creator && ctx.trusted.has(creator))
    }),
  )
  if (matching.length === 0) {
    return {
      result: {
        valid: false,
        source,
        reason: `no trusted ${STEWARD_GITHUB_STATUS_CONTEXT} commit status found for ${targetSha.slice(0, 12)}`,
      },
      statusMissing: true,
    }
  }
  const vetoHit = findStewardVetoStatus(matching, source)
  if (vetoHit) return { result: vetoHit, statusMissing: false }
  return {
    result: parseApprovedStewardStatusEntry(matching[0]!, targetSha, source),
    statusMissing: false,
  }
}

/**
 * Verify out-of-commit Architecture Steward approval via GitHub Commit Status `oc-v5/arch-steward`.
 * When `headSha` itself has no trusted status (and no veto/malformed status) and
 * `allowMergedPrCarryOver !== false`, carries over from a cryptographically proven
 * equivalent merged PR head (`exact-tree` or single-parent `exact-squash-diff`).
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
  if (direct.result.valid || direct.result.verdict === 'veto' || !direct.statusMissing) {
    return direct.result
  }
  if (opts.allowMergedPrCarryOver === false) {
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
  const carryNotes: string[] = []
  for (const cand of eqRes.candidates) {
    const candCheck = await verifyGithubStewardStatusExactSha(ctx, cand.prHeadSha)
    if (candCheck.result.verdict === 'veto') return candCheck.result
    if (candCheck.result.valid) {
      const tag = `PR#${cand.prNumber}@${cand.prHeadSha.slice(0, 12)} via ${cand.equivalenceProof}`
      return {
        ...candCheck.result,
        source: `${candCheck.result.source} (carried-over from ${tag})`,
        reason: `${candCheck.result.reason} [carried-over from ${tag}]`,
        carriedOverFromPr: cand.prNumber,
        carriedOverFromSha: cand.prHeadSha,
        equivalenceProof: cand.equivalenceProof,
      }
    }
    carryNotes.push(`PR#${cand.prNumber}: ${candCheck.result.reason}`)
  }

  const extra = carryNotes.length > 0 ? carryNotes.join('; ') : eqRes.notes.join('; ')
  return {
    ...direct.result,
    reason: extra ? `${direct.result.reason} (${extra})` : direct.result.reason,
    ...(eqRes.candidates.length > 0 ? { equivalenceCandidates: eqRes.candidates } : {}),
  }
}
