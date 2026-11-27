/**
 * Fail-closed GitHub Merged-PR Equivalence Proof for Squash/Rebase Carry-Over (OCV5-912).
 *
 * When a GitHub Ruleset merges an approved PR #N (head=H) via squash or rebase, GitHub mints
 * a new commit SHA S (`pr.merge_commit_sha === S`, `S !== H`). Out-of-commit approvals
 * (`oc-v5/arch-steward`, `oc-v5/a0-approval`, CODEOWNER PR reviews, and host root receipts)
 * bound to H must carry over to S ONLY when we cryptographically prove that S introduces zero
 * unreviewed bytes beyond PR #N:
 *
 *   - Proof A (`exact-tree`): `commit(S).tree.sha === commit(H).tree.sha` (100% repo-wide byte
 *     identity; covers clean squash/rebase when base branch did not move).
 *   - Proof B (`exact-squash-diff`): When base moved by unrelated PRs (`strict_required_status_checks_policy=false`),
 *     `S` is a single-parent commit (`parents.length === 1`), neither `commit(S).files` nor
 *     `pulls/#N/files` is empty or truncated (< 300 files), and every file's `{filename, status,
 *     previous_filename, blob sha, additions, deletions, changes, patch}` matches byte-for-byte
 *     (fail-closed on any 3-way auto-merge blob drift, missing patch on modified files, or extra file).
 */
const SHA40_RE = /^[0-9a-f]{40}$/i
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const GITHUB_COMMIT_FILES_CAP = 300

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

export function globToRegExpLocal(glob: string): RegExp {
  const escaped = glob
    .replace(/[+?^${}()|[\]\\\.]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.+/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`)
}

export function sortStatusesNewestFirst(
  statuses: readonly GithubStatusEntry[],
): GithubStatusEntry[] {
  return [...statuses].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : Number.NaN
    const tb = b.created_at ? Date.parse(b.created_at) : Number.NaN
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta
    return (b.id ?? 0) - (a.id ?? 0)
  })
}

export function parseKvTokens(description: string): Map<string, string> {
  const map = new Map<string, string>()
  const re = /\b([a-zA-Z][a-zA-Z0-9_-]*)=([^\s|;]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(description)) !== null) {
    map.set(m[1]!.toLowerCase(), m[2]!)
  }
  return map
}

export function extractA0StatusReason(description: string): string {
  const pipeIdx = description.indexOf('|')
  if (pipeIdx >= 0) return description.slice(pipeIdx + 1).trim()
  return description
    .replace(/\b[a-zA-Z][a-zA-Z0-9_-]*=[^\s|;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface GithubCommitPullEntry {
  number?: number
  state?: string
  merged_at?: string | null
  merge_commit_sha?: string | null
  base?: { ref?: string; sha?: string } | null
  head?: { sha?: string } | null
}

export interface GithubDiffFileEntry {
  filename?: string
  status?: string
  previous_filename?: string
  sha?: string | null
  additions?: number
  deletions?: number
  changes?: number
  patch?: string
}

export interface GithubCommitDetail {
  sha?: string
  commit?: { tree?: { sha?: string } | null } | null
  parents?: Array<{ sha?: string }>
  files?: GithubDiffFileEntry[]
}

export type MergedPrEquivalenceProof = 'exact-tree' | 'exact-squash-diff'

export interface MergedPrEquivalenceCandidate {
  prNumber: number
  prHeadSha: string
  prBaseRef?: string
  prBaseSha?: string
  mergeCommitSha: string
  equivalenceProof: MergedPrEquivalenceProof
}

export interface MergedPrEquivalenceResult {
  candidates: MergedPrEquivalenceCandidate[]
  mergedPrNumbers: number[]
  notes: string[]
}

export interface MergedPrLookupOptions {
  repo: string
  token: string
  targetSha: string
  expectedBaseRef?: string
  apiBaseUrl?: string
  fetchImpl?: FetchLike
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'openclaude-v5-governance-gate',
  }
}

function parseNextLink(linkHeader: string | null | undefined): string | null {
  if (!linkHeader) return null
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim())
    if (m?.[1]) return m[1]
  }
  return null
}

function normalizeApiBase(apiBaseUrl?: string): string {
  const raw = (apiBaseUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').trim()
  return raw.replace(/\/+$/, '') || 'https://api.github.com'
}

export async function githubGetJsonObject<T>(
  url: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
  let resp: Awaited<ReturnType<FetchLike>>
  try {
    resp = await fetchImpl(url, { headers: githubHeaders(token) })
  } catch (err) {
    return { ok: false, reason: `GitHub API request error: ${(err as Error).message}` }
  }
  if (!resp.ok) {
    return { ok: false, reason: `GitHub API HTTP ${resp.status} for ${url}` }
  }
  const body = await resp.json()
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: `GitHub API returned non-object payload for ${url}` }
  }
  return { ok: true, data: body as T }
}

export async function githubGetPaginatedList<T>(
  initialUrl: string,
  token: string,
  fetchImpl: FetchLike,
  maxPages = 5,
): Promise<{ ok: true; items: T[]; truncated: boolean } | { ok: false; reason: string }> {
  const items: T[] = []
  let nextUrl: string | null = initialUrl
  for (let page = 0; page < maxPages && nextUrl; page++) {
    let resp: Awaited<ReturnType<FetchLike>>
    try {
      resp = await fetchImpl(nextUrl, { headers: githubHeaders(token) })
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
  return { ok: true, items, truncated: nextUrl !== null }
}

function compareDiffEntry(a: GithubDiffFileEntry, b: GithubDiffFileEntry): number {
  const fa = a.filename ?? ''
  const fb = b.filename ?? ''
  if (fa !== fb) return fa < fb ? -1 : 1
  const sa = a.status ?? ''
  const sb = b.status ?? ''
  if (sa !== sb) return sa < sb ? -1 : 1
  const pa = a.previous_filename ?? ''
  const pb = b.previous_filename ?? ''
  return pa < pb ? -1 : pa > pb ? 1 : 0
}

function areFileStatsEqual(c: GithubDiffFileEntry, p: GithubDiffFileEntry): boolean {
  return (
    typeof c.additions === 'number' &&
    typeof c.deletions === 'number' &&
    typeof c.changes === 'number' &&
    c.additions === p.additions &&
    c.deletions === p.deletions &&
    c.changes === p.changes
  )
}

function isFilePatchEquivalent(c: GithubDiffFileEntry, p: GithubDiffFileEntry): boolean {
  const needsPatch = c.status !== 'added' && c.status !== 'removed' && (c.changes ?? 0) > 0
  if (c.patch === undefined && p.patch === undefined && !needsPatch) return true
  return typeof c.patch === 'string' && typeof p.patch === 'string' && c.patch === p.patch
}

function diffSingleFileMismatch(c: GithubDiffFileEntry, p: GithubDiffFileEntry): string | null {
  const cName = typeof c.filename === 'string' ? c.filename : ''
  const pName = typeof p.filename === 'string' ? p.filename : ''
  if (!cName || cName !== pName) return `filename mismatch (${cName} vs ${pName})`
  if (!c.status || c.status !== p.status) {
    return `${cName}: status mismatch (${c.status} vs ${p.status})`
  }
  if ((c.previous_filename ?? '') !== (p.previous_filename ?? '')) {
    return `${cName}: previous_filename mismatch`
  }
  const cSha = typeof c.sha === 'string' ? c.sha.trim().toLowerCase() : ''
  const pSha = typeof p.sha === 'string' ? p.sha.trim().toLowerCase() : ''
  if (!SHA40_RE.test(cSha) || cSha !== pSha) {
    return `${cName}: blob sha mismatch (${cSha || 'missing'} vs ${pSha || 'missing'})`
  }
  if (!areFileStatsEqual(c, p)) return `${cName}: line count stats mismatch`
  if (!isFilePatchEquivalent(c, p)) return `${cName}: patch content missing or differs`
  return null
}

/**
 * Verify byte-level diff equivalence between a single-parent squash commit's file list
 * and its merged PR's file list. Fails closed on truncation (>= 300 files), missing patches
 * on modified files, blob SHA drift (e.g. 3-way auto-merge), or any added/omitted file.
 */
export function verifyFileDiffListsByteEquivalent(
  commitFiles: readonly GithubDiffFileEntry[],
  prFiles: readonly GithubDiffFileEntry[],
): { equivalent: true } | { equivalent: false; reason: string } {
  if (commitFiles.length === 0 || prFiles.length === 0) {
    return { equivalent: false, reason: 'empty file list cannot prove squash diff equivalence' }
  }
  if (commitFiles.length >= GITHUB_COMMIT_FILES_CAP || prFiles.length >= GITHUB_COMMIT_FILES_CAP) {
    return {
      equivalent: false,
      reason: `file count reached GitHub ${GITHUB_COMMIT_FILES_CAP}-file truncation ceiling (fail-closed; require exact-tree or fresh review)`,
    }
  }
  if (commitFiles.length !== prFiles.length) {
    return {
      equivalent: false,
      reason: `changed file count mismatch (commit=${commitFiles.length}, pr=${prFiles.length})`,
    }
  }
  const sortedCommit = [...commitFiles].sort(compareDiffEntry)
  const sortedPr = [...prFiles].sort(compareDiffEntry)
  for (let i = 0; i < sortedCommit.length; i++) {
    const mismatch = diffSingleFileMismatch(sortedCommit[i]!, sortedPr[i]!)
    if (mismatch) return { equivalent: false, reason: mismatch }
  }
  return { equivalent: true }
}

async function proveSingleMergedPrEquivalence(opts: {
  repo: string
  token: string
  apiBase: string
  fetchImpl: FetchLike
  prNumber: number
  prHeadSha: string
  prBaseRef?: string
  prBaseSha?: string
  targetSha: string
  targetCommit: GithubCommitDetail
}): Promise<{ candidate?: MergedPrEquivalenceCandidate; note: string }> {
  const headCommitRes = await githubGetJsonObject<GithubCommitDetail>(
    `${opts.apiBase}/repos/${opts.repo}/commits/${opts.prHeadSha}`,
    opts.token,
    opts.fetchImpl,
  )
  if (!headCommitRes.ok) {
    return { note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)}: ${headCommitRes.reason}` }
  }
  const targetTree = opts.targetCommit.commit?.tree?.sha?.trim().toLowerCase() ?? ''
  const headTree = headCommitRes.data.commit?.tree?.sha?.trim().toLowerCase() ?? ''
  if (SHA40_RE.test(targetTree) && SHA40_RE.test(headTree) && targetTree === headTree) {
    return {
      candidate: {
        prNumber: opts.prNumber,
        prHeadSha: opts.prHeadSha,
        prBaseRef: opts.prBaseRef,
        prBaseSha: opts.prBaseSha,
        mergeCommitSha: opts.targetSha,
        equivalenceProof: 'exact-tree',
      },
      note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} matched via exact-tree (${targetTree.slice(0, 12)})`,
    }
  }

  const parents = opts.targetCommit.parents ?? []
  const commitFiles = opts.targetCommit.files ?? []
  if (parents.length !== 1) {
    return {
      note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} tree mismatch and target has ${parents.length} parent(s) (not single-parent squash)`,
    }
  }
  if (commitFiles.length === 0 || commitFiles.length >= GITHUB_COMMIT_FILES_CAP) {
    return {
      note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} tree mismatch and commit file list unavailable or truncated (count=${commitFiles.length})`,
    }
  }
  const prFilesRes = await githubGetPaginatedList<GithubDiffFileEntry>(
    `${opts.apiBase}/repos/${opts.repo}/pulls/${opts.prNumber}/files?per_page=100`,
    opts.token,
    opts.fetchImpl,
    3,
  )
  if (!prFilesRes.ok) {
    return { note: `PR#${opts.prNumber} files fetch failed: ${prFilesRes.reason}` }
  }
  if (prFilesRes.truncated) {
    return { note: `PR#${opts.prNumber} files list truncated beyond 300 files (fail-closed)` }
  }
  const eq = verifyFileDiffListsByteEquivalent(commitFiles, prFilesRes.items)
  if (!eq.equivalent) {
    return {
      note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} diff equivalence rejected: ${eq.reason}`,
    }
  }
  return {
    candidate: {
      prNumber: opts.prNumber,
      prHeadSha: opts.prHeadSha,
      prBaseRef: opts.prBaseRef,
      prBaseSha: opts.prBaseSha,
      mergeCommitSha: opts.targetSha,
      equivalenceProof: 'exact-squash-diff',
    },
    note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} matched via exact-squash-diff (${commitFiles.length} file(s))`,
  }
}

/**
 * Resolve cryptographically proven merged-PR carry-over candidates for a merge/squash commit.
 */
export async function resolveMergedPrEquivalence(
  opts: MergedPrLookupOptions,
): Promise<MergedPrEquivalenceResult> {
  const targetSha = opts.targetSha.trim().toLowerCase()
  if (!REPO_SLUG_RE.test(opts.repo) || !SHA40_RE.test(targetSha) || !opts.token.trim()) {
    return { candidates: [], mergedPrNumbers: [], notes: ['invalid GitHub lookup arguments'] }
  }
  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const apiBase = normalizeApiBase(opts.apiBaseUrl)
  const expectedBase = opts.expectedBaseRef?.trim()

  const pullsRes = await githubGetPaginatedList<GithubCommitPullEntry>(
    `${apiBase}/repos/${opts.repo}/commits/${targetSha}/pulls?per_page=30`,
    opts.token,
    fetchImpl,
    2,
  )
  if (!pullsRes.ok) {
    return { candidates: [], mergedPrNumbers: [], notes: [pullsRes.reason] }
  }

  const matchedMerged = pullsRes.items.filter((pr) => {
    if (typeof pr.number !== 'number' || pr.number <= 0) return false
    if (!pr.merged_at) return false
    if (expectedBase && pr.base?.ref?.trim() !== expectedBase) return false
    const mergeSha = pr.merge_commit_sha?.trim().toLowerCase()
    return mergeSha === targetSha
  })
  const mergedPrNumbers = matchedMerged.map((pr) => pr.number!)
  const carryTargets = matchedMerged.filter((pr) => {
    const head = pr.head?.sha?.trim().toLowerCase() ?? ''
    return SHA40_RE.test(head) && head !== targetSha
  })
  if (carryTargets.length === 0) {
    return {
      candidates: [],
      mergedPrNumbers,
      notes: [`no squash/rebase merged PR found with merge_commit_sha=${targetSha.slice(0, 12)}`],
    }
  }

  const targetCommitRes = await githubGetJsonObject<GithubCommitDetail>(
    `${apiBase}/repos/${opts.repo}/commits/${targetSha}`,
    opts.token,
    fetchImpl,
  )
  if (!targetCommitRes.ok) {
    return { candidates: [], mergedPrNumbers, notes: [targetCommitRes.reason] }
  }

  const candidates: MergedPrEquivalenceCandidate[] = []
  const notes: string[] = []
  for (const pr of carryTargets) {
    const prHeadSha = pr.head!.sha!.trim().toLowerCase()
    const res = await proveSingleMergedPrEquivalence({
      repo: opts.repo,
      token: opts.token,
      apiBase,
      fetchImpl,
      prNumber: pr.number!,
      prHeadSha,
      prBaseRef: pr.base?.ref?.trim() || undefined,
      prBaseSha: pr.base?.sha?.trim().toLowerCase() || undefined,
      targetSha,
      targetCommit: targetCommitRes.data,
    })
    notes.push(res.note)
    if (res.candidate) candidates.push(res.candidate)
  }
  return { candidates, mergedPrNumbers, notes }
}

/**
 * Prove that a commit SHA landed via a merged GitHub PR (`merged_at != null` and either
 * `merge_commit_sha === targetSha` or `head.sha === targetSha`). Used by multi-PR release train
 * range checks so unreviewed direct pushes cannot split changes below Steward thresholds.
 */
export async function verifyCommitIsMergedPr(
  opts: MergedPrLookupOptions,
): Promise<{ merged: boolean; prNumber?: number; reason: string }> {
  const targetSha = opts.targetSha.trim().toLowerCase()
  if (!REPO_SLUG_RE.test(opts.repo) || !SHA40_RE.test(targetSha) || !opts.token.trim()) {
    return { merged: false, reason: 'missing GitHub repo/token or invalid commit SHA' }
  }
  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const apiBase = normalizeApiBase(opts.apiBaseUrl)
  const expectedBase = opts.expectedBaseRef?.trim()

  const pullsRes = await githubGetPaginatedList<GithubCommitPullEntry>(
    `${apiBase}/repos/${opts.repo}/commits/${targetSha}/pulls?per_page=30`,
    opts.token,
    fetchImpl,
    2,
  )
  if (!pullsRes.ok) {
    return { merged: false, reason: pullsRes.reason }
  }
  for (const pr of pullsRes.items) {
    if (typeof pr.number !== 'number' || !pr.merged_at) continue
    if (expectedBase && pr.base?.ref?.trim() !== expectedBase) continue
    const mergeSha = pr.merge_commit_sha?.trim().toLowerCase()
    const headSha = pr.head?.sha?.trim().toLowerCase()
    if (mergeSha === targetSha || headSha === targetSha) {
      return {
        merged: true,
        prNumber: pr.number,
        reason: `commit ${targetSha.slice(0, 12)} landed via merged PR#${pr.number}`,
      }
    }
  }
  return {
    merged: false,
    reason: `commit ${targetSha.slice(0, 12)} has no merged PR record on ${opts.repo}`,
  }
}
