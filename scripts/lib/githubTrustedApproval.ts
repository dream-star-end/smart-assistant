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
import { MODEL_FAMILIES, type ModelFamily } from './modelFamilyClassifier.js'

export const DEFAULT_GITHUB_API_BASE = 'https://api.github.com'
export const DEFAULT_TRUSTED_APPROVERS = ['dream-star-end'] as const
export const A0_GITHUB_STATUS_CONTEXT = 'oc-v5/a0-approval'
export const STEWARD_GITHUB_STATUS_CONTEXT = 'oc-v5/arch-steward'

const SHA40_RE = /^[0-9a-f]{40}$/i
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const DIGEST_PREFIX_RE = /^(?:sha256|hmac-sha256):[0-9a-f]{12,64}$/i
const DRY_RUN_MARKER_RE = /\b(?:dry[-_]?run|example|mock|placeholder|stub|fake)\b/i
const VALID_MODEL_FAMILY_SET = new Set<string>(MODEL_FAMILIES)

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  headers?: { get(name: string): string | null }
  json(): Promise<unknown>
  text?(): Promise<string>
}>

export interface GithubStatusEntry {
  id?: number
  context?: string
  state?: string
  description?: string | null
  target_url?: string | null
  created_at?: string
  updated_at?: string
  creator?: { login?: string } | null
}

export interface GithubPrReviewEntry {
  id?: number
  state?: string
  commit_id?: string | null
  submitted_at?: string
  body?: string | null
  user?: { login?: string } | null
}

export interface GithubCommitPullEntry {
  number?: number
  state?: string
  merged_at?: string | null
  base?: { ref?: string } | null
  head?: { sha?: string } | null
}

export interface GithubA0ApprovalOptions {
  repo: string
  token: string
  headSha: string
  a0Paths: readonly string[]
  prNumber?: number
  trustedApprovers?: readonly string[]
  apiBaseUrl?: string
  nowMs?: number
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
}

export interface GithubStewardStatusOptions {
  repo: string
  token: string
  headSha: string
  trustedPublishers?: readonly string[]
  apiBaseUrl?: string
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
}

function globToRegExpLocal(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.+/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if ('+?^${}()|[]\\.'.includes(ch)) {
      re += `\\${ch}`
    } else {
      re += ch
    }
  }
  return new RegExp(`^${re}$`)
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

export function resolveGithubApiBase(apiBaseUrl?: string, env: NodeJS.ProcessEnv = process.env): string {
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

function parseNextLink(linkHeader: string | null | undefined): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim())
    if (m?.[1]) return m[1]
  }
  return null
}

async function githubGetPaginated<T>(
  initialUrl: string,
  token: string,
  fetchImpl: FetchLike,
  maxPages = 10,
): Promise<{ ok: true; items: T[] } | { ok: false; reason: string }> {
  const items: T[] = []
  let nextUrl: string | null = initialUrl
  for (let page = 0; page < maxPages && nextUrl; page++) {
    let resp: Awaited<ReturnType<FetchLike>>
    try {
      resp = await fetchImpl(nextUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'openclaude-v5-governance-gate',
        },
      })
    } catch (err) {
      return { ok: false, reason: `GitHub API request error: ${(err as Error).message}` }
    }
    if (!resp.ok) {
      return { ok: false, reason: `GitHub API HTTP ${resp.status} for ${nextUrl}` }
    }
    const body = await resp.json()
    if (!Array.isArray(body)) {
      return { ok: false, reason: `GitHub API returned non-array payload for ${nextUrl}` }
    }
    items.push(...(body as T[]))
    nextUrl = parseNextLink(resp.headers?.get('link'))
  }
  return { ok: true, items }
}

function sortStatusesNewestFirst(statuses: readonly GithubStatusEntry[]): GithubStatusEntry[] {
  return [...statuses].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : Number.NaN
    const tb = b.created_at ? Date.parse(b.created_at) : Number.NaN
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta
    return (b.id ?? 0) - (a.id ?? 0)
  })
}

function parseKvTokens(description: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /\b([a-zA-Z][a-zA-Z0-9_-]*)=([^\s|;]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(description)) !== null) {
    map.set(m[1]!.toLowerCase(), m[2]!)
  }
  return map
}

function extractA0StatusReason(description: string): string {
  const pipeIdx = description.indexOf('|')
  if (pipeIdx >= 0) {
    return description.slice(pipeIdx + 1).trim()
  }
  const stripped = description
    .replace(/\b[a-zA-Z][a-zA-Z0-9_-]*=[^\s|;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped
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
      if (s.context !== A0_GITHUB_STATUS_CONTEXT) return false
      const creator = s.creator?.login?.trim().toLowerCase()
      return Boolean(creator && trustedApprovers.has(creator))
    }),
  )
  if (matching.length === 0) return null

  const source = `${sourceBase}:status:${A0_GITHUB_STATUS_CONTEXT}@${headSha.slice(0, 12)}`
  const revokedHit = findRevokedA0Status(matching, source)
  if (revokedHit) return revokedHit

  const latest = matching[0]!
  const creator = latest.creator?.login?.trim() ?? 'unknown'
  if (latest.state !== 'success') {
    return {
      valid: false,
      source,
      approvedBy: creator,
      reason: `latest trusted ${A0_GITHUB_STATUS_CONTEXT} status has state=${JSON.stringify(latest.state)} (expected "success")`,
    }
  }

  const desc = (latest.description ?? '').trim()
  if (!desc) {
    return {
      valid: false,
      source,
      approvedBy: creator,
      reason: `${A0_GITHUB_STATUS_CONTEXT} status description is empty`,
    }
  }
  if (DRY_RUN_MARKER_RE.test(desc)) {
    return {
      valid: false,
      source,
      approvedBy: creator,
      reason: `${A0_GITHUB_STATUS_CONTEXT} status contains forbidden dry-run/example marker`,
    }
  }

  const kv = parseKvTokens(desc)
  const boundSha = (kv.get('sha') ?? '').toLowerCase()
  const shortSha12 = headSha.slice(0, 12).toLowerCase()
  const shaBound =
    (boundSha.length >= 8 && /^[0-9a-f]+$/.test(boundSha) && headSha.toLowerCase().startsWith(boundSha)) ||
    desc.toLowerCase().includes(shortSha12)
  if (!shaBound) {
    return {
      valid: false,
      source,
      approvedBy: creator,
      reason: `${A0_GITHUB_STATUS_CONTEXT} description does not bind headSha ${shortSha12}`,
    }
  }

  const expStr = kv.get('exp') ?? kv.get('expires') ?? kv.get('expiresat')
  if (expStr) {
    const expMs = Date.parse(expStr)
    if (!Number.isFinite(expMs)) {
      return {
        valid: false,
        source,
        approvedBy: creator,
        reason: `${A0_GITHUB_STATUS_CONTEXT} has invalid exp timestamp "${expStr}"`,
      }
    }
    if (expMs <= nowMs) {
      return {
        valid: false,
        source,
        approvedBy: creator,
        reason: `${A0_GITHUB_STATUS_CONTEXT} expired at ${expStr}`,
      }
    }
  }

  const pathsRaw = kv.get('paths')?.trim() ?? ''
  if (!pathsRaw) {
    return {
      valid: false,
      source,
      approvedBy: creator,
      reason: `${A0_GITHUB_STATUS_CONTEXT} missing required explicit paths= scope token (refusing to treat omitted paths as unrestricted)`,
    }
  }
  if (pathsRaw !== '*') {
    const globs = pathsRaw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
    if (globs.length === 0) {
      return {
        valid: false,
        source,
        approvedBy: creator,
        reason: `${A0_GITHUB_STATUS_CONTEXT} has empty paths scope`,
      }
    }
    const uncovered = a0Paths.filter((p) => !globs.some((g) => globToRegExpLocal(g).test(p)))
    if (uncovered.length > 0) {
      return {
        valid: false,
        source,
        approvedBy: creator,
        reason: `${A0_GITHUB_STATUS_CONTEXT} paths scope does not cover A0 changes: ${uncovered.join(', ')}`,
      }
    }
  }

  const reasonText = extractA0StatusReason(desc)
  if (reasonText.length < 8) {
    return {
      valid: false,
      source,
      approvedBy: creator,
      reason: `${A0_GITHUB_STATUS_CONTEXT} description must include a reason of at least 8 characters`,
    }
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

/**
 * Verify out-of-commit A0 approval via GitHub Commit Status `oc-v5/a0-approval`
 * OR CODEOWNER PR `APPROVED` review bound to exact `headSha`.
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

  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const apiBase = resolveGithubApiBase(opts.apiBaseUrl)
  const trusted = normalizeTrustedLogins(opts.trustedApprovers)
  const nowMs = opts.nowMs ?? Date.now()
  const failureNotes: string[] = []

  // Channel 1: Commit status `oc-v5/a0-approval` on exact `headSha`
  const statusUrl = `${apiBase}/repos/${opts.repo}/commits/${headSha}/statuses?per_page=100`
  const statusResp = await githubGetPaginated<GithubStatusEntry>(statusUrl, opts.token, fetchImpl, 5)
  if (!statusResp.ok) {
    failureNotes.push(statusResp.reason)
  } else {
    const statusEval = evaluateA0CommitStatus(
      statusResp.items,
      headSha,
      opts.a0Paths,
      trusted,
      nowMs,
      sourceBase,
    )
    if (statusEval?.valid) return statusEval
    if (statusEval?.revoked) return statusEval
    if (statusEval) failureNotes.push(statusEval.reason)
    else failureNotes.push(`no trusted ${A0_GITHUB_STATUS_CONTEXT} status on ${headSha.slice(0, 12)}`)
  }

  // Channel 2: PR CODEOWNER APPROVED review bound to exact `headSha`
  const prNumbersToCheck: number[] = []
  if (typeof opts.prNumber === 'number' && Number.isInteger(opts.prNumber) && opts.prNumber > 0) {
    prNumbersToCheck.push(opts.prNumber)
  } else {
    // For push events (e.g. fast-forward merged PRs), only accept PRs whose head.sha === headSha
    const pullsUrl = `${apiBase}/repos/${opts.repo}/commits/${headSha}/pulls?per_page=30`
    const pullsResp = await githubGetPaginated<GithubCommitPullEntry>(pullsUrl, opts.token, fetchImpl, 2)
    if (pullsResp.ok) {
      for (const pr of pullsResp.items) {
        if (
          typeof pr.number === 'number' &&
          pr.head?.sha?.trim().toLowerCase() === headSha
        ) {
          prNumbersToCheck.push(pr.number)
        }
      }
    }
  }

  for (const prNum of prNumbersToCheck) {
    const revSource = `${sourceBase}:pr#${prNum}:review@${headSha.slice(0, 12)}`
    const revUrl = `${apiBase}/repos/${opts.repo}/pulls/${prNum}/reviews?per_page=100`
    const revResp = await githubGetPaginated<GithubPrReviewEntry>(revUrl, opts.token, fetchImpl, 10)
    if (!revResp.ok) {
      failureNotes.push(revResp.reason)
      continue
    }
    const revEval = evaluatePrReviews(revResp.items, headSha, trusted, revSource)
    if (revEval.valid) return revEval
    failureNotes.push(revEval.reason)
  }

  return {
    valid: false,
    source: `${sourceBase}@${headSha.slice(0, 12)}`,
    reason: failureNotes.join('; ') || `no trusted GitHub A0 approval for ${headSha.slice(0, 12)}`,
  }
}

/**
 * Verify out-of-commit Architecture Steward approval via GitHub Commit Status `oc-v5/arch-steward`.
 *
 * Expected description format (<= 140 chars):
 *   verdict=approve sha=<12+hex> author=<authorFamily> steward=<stewardFamily> digest=<sha256|hmac-sha256>:<12+hex>
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

  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const apiBase = resolveGithubApiBase(opts.apiBaseUrl)
  const trusted = normalizeTrustedLogins(opts.trustedPublishers)

  const statusUrl = `${apiBase}/repos/${opts.repo}/commits/${headSha}/statuses?per_page=100`
  const resp = await githubGetPaginated<GithubStatusEntry>(statusUrl, opts.token, fetchImpl, 5)
  if (!resp.ok) {
    return { valid: false, source, reason: resp.reason }
  }

  const matching = sortStatusesNewestFirst(
    resp.items.filter((s) => {
      if (s.context !== STEWARD_GITHUB_STATUS_CONTEXT) return false
      const creator = s.creator?.login?.trim().toLowerCase()
      return Boolean(creator && trusted.has(creator))
    }),
  )
  if (matching.length === 0) {
    return {
      valid: false,
      source,
      reason: `no trusted ${STEWARD_GITHUB_STATUS_CONTEXT} commit status found for ${headSha.slice(0, 12)}`,
    }
  }

  const vetoHit = findStewardVetoStatus(matching, source)
  if (vetoHit) return vetoHit

  const latest = matching[0]!
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
    return { valid: false, source, publishedBy, reason: `${STEWARD_GITHUB_STATUS_CONTEXT} status description is empty` }
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
  if (shaToken.length < 12 || !/^[0-9a-f]+$/.test(shaToken) || !headSha.startsWith(shaToken)) {
    return {
      valid: false,
      source,
      publishedBy,
      reason: `${STEWARD_GITHUB_STATUS_CONTEXT} sha=${JSON.stringify(shaToken)} does not bind headSha ${headSha.slice(0, 12)}`,
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
