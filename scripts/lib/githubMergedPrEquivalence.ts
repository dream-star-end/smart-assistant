/**
 * Fail-closed GitHub Merged-PR Equivalence Proof for Squash/Rebase Carry-Over (OCV5-912).
 *
 * Security invariants (B4 / B5 / B6):
 *   - Mandatory target branch binding (`expectedBaseRef`) and repo binding (`base.repo.full_name`
 *     when present) + exact `pr.merged_at != null && pr.merge_commit_sha === targetSha`.
 *   - Proof A (`exact-tree`): `commit(S).tree.sha === commit(H).tree.sha` (repo-wide byte identity).
 *   - Proof B (`exact-squash-diff`): Single-parent squash commit `S` with non-truncated file list
 *     (< 300 files and no `Link: rel="next"`), non-truncated PR file list, exact per-file metadata
 *     + patch equality, AND full Git tree-entry verification (`{mode, type, sha}`) comparing
 *     `(pre(S), post(S))` vs `(mergeBase(prBase, H), post(H))` for EVERY changed path and
 *     rename source — catching executable-bit flips, symlinks, submodules, 0-line binary diffs,
 *     and 3-way auto-merge drift. Fails closed on any missing tree, truncation, or API error.
 */
const SHA40_RE = /^[0-9a-f]{40}$/i
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const GITHUB_COMMIT_FILES_CAP = 300
const MAX_TREE_PROOF_FILES = 100

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
  merge_commit_sha?: string | null
  base?: { ref?: string; sha?: string; repo?: { full_name?: string } | null } | null
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

interface GithubGitTreeEntry {
  path?: string
  mode?: string
  type?: string
  sha?: string
}

interface GithubGitTreeResponse {
  sha?: string
  truncated?: boolean
  tree?: GithubGitTreeEntry[]
}

interface GithubCompareResponse {
  merge_base_commit?: { sha?: string; commit?: { tree?: { sha?: string } | null } | null } | null
}

export type MergedPrEquivalenceProof = 'exact-tree' | 'exact-squash-diff'

export interface MergedPrEquivalenceCandidate {
  prNumber: number
  prHeadSha: string
  prBaseRef: string
  prBaseSha?: string
  mergeCommitSha: string
  equivalenceProof: MergedPrEquivalenceProof
}

export interface MergedPrEquivalenceResult {
  candidates: MergedPrEquivalenceCandidate[]
  mergedPrNumbers: number[]
  incomplete: boolean
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
): Promise<{ ok: true; data: T; hasNextPage: boolean } | { ok: false; reason: string }> {
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
  return {
    ok: true,
    data: body as T,
    hasNextPage: parseNextLink(resp.headers?.get('link')) !== null,
  }
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
  if (c.patch === undefined && p.patch === undefined) {
    return c.status === 'added' || c.status === 'removed'
  }
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
  if (!isFilePatchEquivalent(c, p)) return `${cName}: patch missing or differs`
  return null
}

/**
 * Verify file-list & patch equality between a single-parent squash commit and its merged PR.
 * Rejects empty lists, >= 300 file truncation, blob/stat drift, and ANY modified/renamed file
 * lacking a matching patch (even 0-line binary/mode-only edits — B6).
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
      reason: `file count reached GitHub ${GITHUB_COMMIT_FILES_CAP}-file truncation ceiling (fail-closed)`,
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

interface TreeEntrySignature {
  mode: string
  type: string
  sha: string
}

async function resolvePathTreeEntry(
  rootTreeSha: string,
  relPath: string,
  treeCache: Map<string, Map<string, TreeEntrySignature>>,
  api: { repo: string; token: string; apiBase: string; fetchImpl: FetchLike },
): Promise<
  | { ok: true; entry: TreeEntrySignature | null }
  | { ok: false; reason: string; incomplete?: boolean }
> {
  const parts = relPath.split('/').filter(Boolean)
  if (parts.length === 0) return { ok: false, reason: `empty path ${JSON.stringify(relPath)}` }
  let curTreeSha = rootTreeSha
  for (let i = 0; i < parts.length; i++) {
    let dirMap = treeCache.get(curTreeSha)
    if (!dirMap) {
      const res = await githubGetJsonObject<GithubGitTreeResponse>(
        `${api.apiBase}/repos/${api.repo}/git/trees/${curTreeSha}`,
        api.token,
        api.fetchImpl,
      )
      if (!res.ok) {
        return {
          ok: false,
          incomplete: true,
          reason: `tree ${curTreeSha.slice(0, 12)}: ${res.reason}`,
        }
      }
      if (res.data.truncated === true || !Array.isArray(res.data.tree)) {
        return {
          ok: false,
          incomplete: true,
          reason: `tree ${curTreeSha.slice(0, 12)} truncated or invalid`,
        }
      }
      dirMap = new Map<string, TreeEntrySignature>()
      for (const ent of res.data.tree) {
        if (ent.path && ent.mode && ent.type && ent.sha && SHA40_RE.test(ent.sha)) {
          dirMap.set(ent.path, { mode: ent.mode, type: ent.type, sha: ent.sha.toLowerCase() })
        }
      }
      treeCache.set(curTreeSha, dirMap)
    }
    const found = dirMap.get(parts[i]!)
    if (!found) return { ok: true, entry: null }
    if (i === parts.length - 1) return { ok: true, entry: found }
    if (found.type !== 'tree') return { ok: true, entry: null }
    curTreeSha = found.sha
  }
  return { ok: true, entry: null }
}

function sameTreeEntry(a: TreeEntrySignature | null, b: TreeEntrySignature | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.mode === b.mode && a.type === b.type && a.sha === b.sha
}

async function verifyTreeEntriesEquivalent(opts: {
  api: { repo: string; token: string; apiBase: string; fetchImpl: FetchLike }
  files: readonly GithubDiffFileEntry[]
  sParentSha: string
  sPostTreeSha: string
  prBaseSha: string
  prHeadSha: string
  hPostTreeSha: string
}): Promise<{ ok: true } | { ok: false; reason: string; incomplete?: boolean }> {
  const paths = new Set<string>()
  for (const f of opts.files) {
    if (f.filename) paths.add(f.filename)
    if (f.previous_filename) paths.add(f.previous_filename)
  }
  if (paths.size === 0 || paths.size > MAX_TREE_PROOF_FILES) {
    return {
      ok: false,
      reason: `Proof B path count ${paths.size} outside [1..${MAX_TREE_PROOF_FILES}] (fail-closed)`,
    }
  }
  const sParentRes = await githubGetJsonObject<GithubCommitDetail>(
    `${opts.api.apiBase}/repos/${opts.api.repo}/commits/${opts.sParentSha}`,
    opts.api.token,
    opts.api.fetchImpl,
  )
  if (!sParentRes.ok) {
    return {
      ok: false,
      incomplete: true,
      reason: `target parent fetch failed: ${sParentRes.reason}`,
    }
  }
  const sPreTree = sParentRes.data.commit?.tree?.sha?.trim().toLowerCase() ?? ''
  if (!SHA40_RE.test(sPreTree)) return { ok: false, reason: 'missing target parent tree SHA' }

  const cmpRes = await githubGetJsonObject<GithubCompareResponse>(
    `${opts.api.apiBase}/repos/${opts.api.repo}/compare/${opts.prBaseSha}...${opts.prHeadSha}`,
    opts.api.token,
    opts.api.fetchImpl,
  )
  if (!cmpRes.ok) {
    return { ok: false, incomplete: true, reason: `PR merge-base compare failed: ${cmpRes.reason}` }
  }
  const hPreTree = cmpRes.data.merge_base_commit?.commit?.tree?.sha?.trim().toLowerCase() ?? ''
  if (!SHA40_RE.test(hPreTree)) return { ok: false, reason: 'missing PR merge-base tree SHA' }

  const cache = new Map<string, Map<string, TreeEntrySignature>>()
  for (const relPath of paths) {
    const [sPre, sPost, hPre, hPost] = await Promise.all([
      resolvePathTreeEntry(sPreTree, relPath, cache, opts.api),
      resolvePathTreeEntry(opts.sPostTreeSha, relPath, cache, opts.api),
      resolvePathTreeEntry(hPreTree, relPath, cache, opts.api),
      resolvePathTreeEntry(opts.hPostTreeSha, relPath, cache, opts.api),
    ])
    if (!sPre.ok) return sPre
    if (!sPost.ok) return sPost
    if (!hPre.ok) return hPre
    if (!hPost.ok) return hPost
    if (!sameTreeEntry(sPre.entry, hPre.entry)) {
      return { ok: false, reason: `${relPath}: pre-image tree entry (mode/type/oid) differs` }
    }
    if (!sameTreeEntry(sPost.entry, hPost.entry)) {
      return { ok: false, reason: `${relPath}: post-image tree entry (mode/type/oid) differs` }
    }
  }
  return { ok: true }
}

async function proveSingleMergedPrEquivalence(opts: {
  repo: string
  token: string
  apiBase: string
  fetchImpl: FetchLike
  prNumber: number
  prHeadSha: string
  prBaseRef: string
  prBaseSha?: string
  targetSha: string
  targetCommit: GithubCommitDetail
  targetCommitHasNextPage: boolean
}): Promise<{ candidate?: MergedPrEquivalenceCandidate; note: string; incomplete?: boolean }> {
  const headCommitRes = await githubGetJsonObject<GithubCommitDetail>(
    `${opts.apiBase}/repos/${opts.repo}/commits/${opts.prHeadSha}`,
    opts.token,
    opts.fetchImpl,
  )
  if (!headCommitRes.ok) {
    return {
      note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)}: ${headCommitRes.reason}`,
      incomplete: true,
    }
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
  if (parents.length !== 1 || !parents[0]?.sha || !SHA40_RE.test(parents[0].sha)) {
    return {
      note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} tree mismatch and target is not a single-parent squash`,
    }
  }
  if (
    opts.targetCommitHasNextPage ||
    commitFiles.length === 0 ||
    commitFiles.length >= GITHUB_COMMIT_FILES_CAP
  ) {
    return {
      note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} commit files missing or paginated/truncated (fail-closed)`,
    }
  }
  if (
    !opts.prBaseSha ||
    !SHA40_RE.test(opts.prBaseSha) ||
    !SHA40_RE.test(targetTree) ||
    !SHA40_RE.test(headTree)
  ) {
    return {
      note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} missing base/tree SHA required for Proof B tree-entry verification`,
    }
  }

  const prFilesRes = await githubGetPaginatedList<GithubDiffFileEntry>(
    `${opts.apiBase}/repos/${opts.repo}/pulls/${opts.prNumber}/files?per_page=100`,
    opts.token,
    opts.fetchImpl,
    3,
  )
  if (!prFilesRes.ok || prFilesRes.truncated) {
    return {
      note: `PR#${opts.prNumber} files fetch failed or truncated beyond 300 files (fail-closed)`,
      incomplete: !prFilesRes.ok,
    }
  }
  const eq = verifyFileDiffListsByteEquivalent(commitFiles, prFilesRes.items)
  if (!eq.equivalent) {
    return {
      note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} diff rejected: ${eq.reason}`,
    }
  }
  const treeEq = await verifyTreeEntriesEquivalent({
    api: { repo: opts.repo, token: opts.token, apiBase: opts.apiBase, fetchImpl: opts.fetchImpl },
    files: commitFiles,
    sParentSha: parents[0].sha.trim().toLowerCase(),
    sPostTreeSha: targetTree,
    prBaseSha: opts.prBaseSha,
    prHeadSha: opts.prHeadSha,
    hPostTreeSha: headTree,
  })
  if (!treeEq.ok) {
    return {
      note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} tree-entry proof rejected: ${treeEq.reason}`,
      ...(treeEq.incomplete ? { incomplete: true } : {}),
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
    note: `PR#${opts.prNumber}@${opts.prHeadSha.slice(0, 12)} matched via exact-squash-diff + tree-entry (${commitFiles.length} file(s))`,
  }
}

function matchesTrustedMergedPr(
  pr: GithubCommitPullEntry,
  targetSha: string,
  expectedBaseRef: string,
  expectedRepo: string,
): boolean {
  if (typeof pr.number !== 'number' || pr.number <= 0 || !pr.merged_at) return false
  if (pr.base?.ref?.trim() !== expectedBaseRef) return false
  const baseRepo = pr.base?.repo?.full_name?.trim().toLowerCase()
  if (baseRepo && baseRepo !== expectedRepo.toLowerCase()) return false
  return pr.merge_commit_sha?.trim().toLowerCase() === targetSha
}

/**
 * Resolve cryptographically proven merged-PR carry-over candidates for a landed commit.
 * Fails closed if `expectedBaseRef` is missing, API is unavailable, or PR list is truncated.
 */
export async function resolveMergedPrEquivalence(
  opts: MergedPrLookupOptions,
): Promise<MergedPrEquivalenceResult> {
  const targetSha = opts.targetSha.trim().toLowerCase()
  const expectedBase = opts.expectedBaseRef?.trim() ?? ''
  if (!REPO_SLUG_RE.test(opts.repo) || !SHA40_RE.test(targetSha) || !opts.token.trim()) {
    return {
      candidates: [],
      mergedPrNumbers: [],
      incomplete: false,
      notes: ['invalid GitHub lookup arguments'],
    }
  }
  if (!expectedBase) {
    return {
      candidates: [],
      mergedPrNumbers: [],
      incomplete: false,
      notes: ['expectedBaseRef is required to anchor merged-PR carry-over (fail-closed)'],
    }
  }
  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const apiBase = normalizeApiBase(opts.apiBaseUrl)

  const pullsRes = await githubGetPaginatedList<GithubCommitPullEntry>(
    `${apiBase}/repos/${opts.repo}/commits/${targetSha}/pulls?per_page=30`,
    opts.token,
    fetchImpl,
    2,
  )
  if (!pullsRes.ok) {
    return { candidates: [], mergedPrNumbers: [], incomplete: true, notes: [pullsRes.reason] }
  }
  if (pullsRes.truncated) {
    return {
      candidates: [],
      mergedPrNumbers: [],
      incomplete: true,
      notes: [`commits/${targetSha.slice(0, 12)}/pulls response truncated (fail-closed)`],
    }
  }

  const matchedMerged = pullsRes.items.filter((pr) =>
    matchesTrustedMergedPr(pr, targetSha, expectedBase, opts.repo),
  )
  const mergedPrNumbers = matchedMerged.map((pr) => pr.number!)
  const carryTargets = matchedMerged.filter((pr) => {
    const head = pr.head?.sha?.trim().toLowerCase() ?? ''
    return SHA40_RE.test(head) && head !== targetSha
  })
  if (carryTargets.length === 0) {
    return {
      candidates: [],
      mergedPrNumbers,
      incomplete: false,
      notes: [
        `no squash/rebase merged PR targeting ${expectedBase} with merge_commit_sha=${targetSha.slice(0, 12)}`,
      ],
    }
  }

  const targetCommitRes = await githubGetJsonObject<GithubCommitDetail>(
    `${apiBase}/repos/${opts.repo}/commits/${targetSha}`,
    opts.token,
    fetchImpl,
  )
  if (!targetCommitRes.ok) {
    return { candidates: [], mergedPrNumbers, incomplete: true, notes: [targetCommitRes.reason] }
  }

  const candidates: MergedPrEquivalenceCandidate[] = []
  const notes: string[] = []
  let incomplete = false
  for (const pr of carryTargets) {
    const prHeadSha = pr.head!.sha!.trim().toLowerCase()
    const res = await proveSingleMergedPrEquivalence({
      repo: opts.repo,
      token: opts.token,
      apiBase,
      fetchImpl,
      prNumber: pr.number!,
      prHeadSha,
      prBaseRef: expectedBase,
      prBaseSha: pr.base?.sha?.trim().toLowerCase() || undefined,
      targetSha,
      targetCommit: targetCommitRes.data,
      targetCommitHasNextPage: targetCommitRes.hasNextPage,
    })
    notes.push(res.note)
    if (res.incomplete) incomplete = true
    if (res.candidate) candidates.push(res.candidate)
  }
  return { candidates, mergedPrNumbers, incomplete, notes }
}

/**
 * Prove that a commit SHA actually landed on `expectedBaseRef` via a merged GitHub PR
 * (`merged_at != null`, `base.ref === expectedBaseRef`, and `merge_commit_sha === targetSha`).
 */
export async function verifyCommitIsMergedPr(
  opts: MergedPrLookupOptions,
): Promise<{ merged: boolean; incomplete?: boolean; prNumber?: number; reason: string }> {
  const targetSha = opts.targetSha.trim().toLowerCase()
  const expectedBase = opts.expectedBaseRef?.trim() ?? ''
  if (!REPO_SLUG_RE.test(opts.repo) || !SHA40_RE.test(targetSha) || !opts.token.trim()) {
    return { merged: false, reason: 'missing GitHub repo/token or invalid commit SHA' }
  }
  if (!expectedBase) {
    return {
      merged: false,
      reason: 'expectedBaseRef is required to verify merged-PR landing (fail-closed)',
    }
  }
  const fetchImpl: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const apiBase = normalizeApiBase(opts.apiBaseUrl)

  const pullsRes = await githubGetPaginatedList<GithubCommitPullEntry>(
    `${apiBase}/repos/${opts.repo}/commits/${targetSha}/pulls?per_page=30`,
    opts.token,
    fetchImpl,
    2,
  )
  if (!pullsRes.ok) {
    return { merged: false, incomplete: true, reason: pullsRes.reason }
  }
  if (pullsRes.truncated) {
    return {
      merged: false,
      incomplete: true,
      reason: `commits/${targetSha.slice(0, 12)}/pulls response truncated (fail-closed)`,
    }
  }
  for (const pr of pullsRes.items) {
    if (matchesTrustedMergedPr(pr, targetSha, expectedBase, opts.repo)) {
      return {
        merged: true,
        prNumber: pr.number,
        reason: `commit ${targetSha.slice(0, 12)} landed on ${expectedBase} via merged PR#${pr.number}`,
      }
    }
  }
  return {
    merged: false,
    reason: `commit ${targetSha.slice(0, 12)} has no merged PR landing on ${expectedBase} in ${opts.repo}`,
  }
}
