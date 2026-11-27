/**
 * Pure, stateless GitHub Commit Status & PR Review Parsers for A0 and Architecture Steward Gates.
 *
 * Extracted from `githubTrustedApproval.ts` so parsing/validation rules remain zero-network,
 * single-responsibility, and A0-protected.
 */
import {
  type GithubPrReviewEntry,
  type GithubStatusEntry,
  type MergedPrEquivalenceCandidate,
  type MergedPrEquivalenceProof,
  extractA0StatusReason,
  parseKvTokens,
  sortStatusesNewestFirst,
} from './githubMergedPrEquivalence.js'
import { globToRegExp } from './globMatch.js'
import { MODEL_FAMILIES, type ModelFamily } from './modelFamilyClassifier.js'

export const DEFAULT_TRUSTED_APPROVERS = ['dream-star-end'] as const
export const A0_GITHUB_STATUS_CONTEXT = 'oc-v5/a0-approval'
export const STEWARD_GITHUB_STATUS_CONTEXT = 'oc-v5/arch-steward'

const DIGEST_PREFIX_RE = /^(?:sha256|hmac-sha256):[0-9a-f]{12,64}$/i
const DRY_RUN_MARKER_RE = /\b(?:dry[-_]?run|example|mock|placeholder|stub|fake)\b/i
const REVOKED_MARKER_RE = /\brevok(?:e|ed|ing)\b/i
const VALID_MODEL_FAMILY_SET = new Set<string>(MODEL_FAMILIES)

export interface GithubA0ApprovalResult {
  valid: boolean
  revoked?: boolean
  denied?: boolean
  incomplete?: boolean
  invalid?: boolean
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

export interface GithubStewardStatusResult {
  valid: boolean
  incomplete?: boolean
  invalid?: boolean
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

export function findRevokedA0Status(
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

export function findStewardVetoStatus(
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
  return { valid: false, invalid: true, source, approvedBy, reason }
}

export function evaluateA0CommitStatus(
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
  if (!desc) {
    return rejectA0Status(
      source,
      creator,
      `${A0_GITHUB_STATUS_CONTEXT} status description is empty`,
    )
  }
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
  if (!shaBound) {
    return rejectA0Status(
      source,
      creator,
      `${A0_GITHUB_STATUS_CONTEXT} description does not bind headSha ${shortSha12}`,
    )
  }

  const expStr = kv.get('exp') ?? kv.get('expires') ?? kv.get('expiresat')
  if (expStr) {
    const expMs = Date.parse(expStr)
    if (!Number.isFinite(expMs)) {
      return rejectA0Status(
        source,
        creator,
        `${A0_GITHUB_STATUS_CONTEXT} has invalid exp timestamp "${expStr}"`,
      )
    }
    if (expMs <= nowMs) {
      return rejectA0Status(source, creator, `${A0_GITHUB_STATUS_CONTEXT} expired at ${expStr}`)
    }
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
    if (globs.length === 0) {
      return rejectA0Status(source, creator, `${A0_GITHUB_STATUS_CONTEXT} has empty paths scope`)
    }
    const uncovered = a0Paths.filter((p) => !globs.some((g) => globToRegExp(g).test(p)))
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

export function evaluatePrReviews(
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
        denied: true,
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

export function parseApprovedStewardStatusEntry(
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
      invalid: true,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} status description is empty`,
    }
  }
  if (DRY_RUN_MARKER_RE.test(desc)) {
    return {
      valid: false,
      invalid: true,
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
      invalid: verdict !== 'veto',
      source,
      publishedBy,
      verdict: verdict === 'veto' ? 'veto' : undefined,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} requires verdict=approve (got ${JSON.stringify(verdict || 'missing')})`,
    }
  }
  if (shaToken.length < 12 || !/^[0-9a-f]+$/.test(shaToken) || !targetSha.startsWith(shaToken)) {
    return {
      valid: false,
      invalid: true,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} sha=${JSON.stringify(shaToken)} does not bind headSha ${targetSha.slice(0, 12)}`,
    }
  }
  if (!VALID_MODEL_FAMILY_SET.has(authorFamily) || !VALID_MODEL_FAMILY_SET.has(stewardFamily)) {
    return {
      valid: false,
      invalid: true,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} requires known author/steward model families (got author=${JSON.stringify(authorFamily)}, steward=${JSON.stringify(stewardFamily)})`,
    }
  }
  if (authorFamily === stewardFamily) {
    return {
      valid: false,
      invalid: true,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} rejected same-family review (${authorFamily} === ${stewardFamily})`,
    }
  }
  if (!DIGEST_PREFIX_RE.test(digest)) {
    return {
      valid: false,
      invalid: true,
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
