/**
 * Multi-Commit First-Parent Range, Cross-Channel Veto & Local Host Carry-Over Verification (OCV5-912).
 *
 * Security invariants (B2 / B3 / B4 / B5):
 *   1. `inspectFirstParentRange` uses bounded `git rev-list --max-count` to distinguish single-commit
 *      (`N === 1`), coalesced multi-commit (`2 <= N <= 20`), and diverged/oversized ranges BEFORE any
 *      tip-only carry-over can shortcut earlier commits.
 *   2. Cross-channel VETO precedence is symmetric and order-independent:
 *      - Online `veto` or `incomplete` overrides local host approve.
 *      - Local host HARD VETO on `S` or carried-over `H` overrides GitHub approve (and low-risk pass).
 *      - Multiple carry-over candidates are all scanned for VETO before returning any approval.
 *   3. Multi-commit range decomposition checks EVERY commit `Ci` in `C1..CN`: low-risk commits must
 *      prove they landed on `expectedBaseRef` via a merged PR (`merge_commit_sha === Ci`) with zero
 *      vetoes and zero incomplete online checks.
 */
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
  type FirstParentRangeInfo,
  MAX_COALESCED_COMMITS,
  inspectFirstParentRange,
} from './gitRangeInspect.js'
import {
  type MergedPrEquivalenceCandidate,
  verifyCommitIsMergedPr,
} from './githubMergedPrEquivalence.js'
import {
  type FetchLike,
  type GithubStewardStatusResult,
  verifyGithubStewardStatus,
} from './githubTrustedApproval.js'

export { type FirstParentRangeInfo, MAX_COALESCED_COMMITS, inspectFirstParentRange }

export interface LocalStewardCarryOverResult {
  ok: boolean
  vetoed: boolean
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
}

export interface StewardHostReceiptConfig {
  root: string
  receiptDirs?: readonly string[]
  requireRootOwner: boolean
  hmacKey?: string
  requireHmac: boolean
  allowUntrustedRepoReceipt: boolean
  env?: Readonly<Record<string, string | undefined>>
}

export interface StewardGithubApiConfig {
  repo: string
  token: string
  trustedPublishers?: readonly string[]
  apiBaseUrl?: string
  expectedBaseRef?: string
  fetchImpl?: FetchLike
}

/**
 * Check whether a local host Steward receipt exists for `targetSha` and carries a HARD VETO
 * (used to enforce symmetric cross-channel VETO precedence even when GitHub approved `targetSha`).
 */
export function checkLocalHostStewardVeto(opts: StewardHostReceiptConfig & { targetSha: string }): {
  vetoed: boolean
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
} {
  const lookup = findStewardReceiptForCommit({
    root: opts.root,
    headSha: opts.targetSha,
    receiptDirs: opts.receiptDirs,
    requireRootOwner: opts.requireRootOwner,
    hmacKey: opts.hmacKey,
    allowUntrustedRepoReceipt: opts.allowUntrustedRepoReceipt,
    env: opts.env,
  })
  if (!lookup.found || lookup.error) return { vetoed: false }
  const ver = verifyArchStewardReceipt(lookup.raw, {
    headSha: opts.targetSha,
    hmacKey: opts.hmacKey,
    requireHmac: opts.requireHmac,
    rootFileIntegrity: Boolean(lookup.rootOwnerVerified),
  })
  if (ver.violations.some((v) => v.code === 'STEWARD-HARD-VETO')) {
    return { vetoed: true, receiptLookup: lookup, receiptVerification: ver }
  }
  return { vetoed: false }
}

function findLocalHostVetoAcrossCandidates(
  ghStatus: GithubStewardStatusResult | undefined,
  opts: StewardHostReceiptConfig,
): {
  vetoed: boolean
  vetoSha?: string
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
} {
  const shas = new Set<string>([
    ...(ghStatus?.carriedOverFromSha ? [ghStatus.carriedOverFromSha] : []),
    ...(ghStatus?.equivalenceCandidates?.map((c) => c.prHeadSha) ?? []),
  ])
  for (const hSha of shas) {
    const veto = checkLocalHostStewardVeto({ ...opts, targetSha: hSha })
    if (veto.vetoed) return { ...veto, vetoSha: hSha }
  }
  return { vetoed: false }
}

/**
 * Verify local host receipts across ALL verified merged-PR candidates (B3: scan ALL candidates
 * for HARD VETO before accepting any approval, order-independent).
 */
export function verifyLocalHostStewardCarryOver(
  opts: StewardHostReceiptConfig & {
    expectedBaseSha: string
    requiredTriggers: readonly StructuralRiskTriggerCode[]
    candidates: readonly MergedPrEquivalenceCandidate[]
  },
): LocalStewardCarryOverResult {
  let vetoHit: LocalStewardCarryOverResult | undefined
  let firstApprove: LocalStewardCarryOverResult | undefined

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
      vetoHit = vetoHit ?? {
        ok: false,
        vetoed: true,
        receiptLookup: carriedLookup,
        receiptVerification: ver,
      }
    } else if (ver.ok && !firstApprove) {
      firstApprove = {
        ok: true,
        vetoed: false,
        receiptLookup: carriedLookup,
        receiptVerification: ver,
      }
    }
  }
  if (vetoHit) return vetoHit
  if (firstApprove) return firstApprove
  return { ok: false, vetoed: false }
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

/** Merge local receipt check with GitHub `oc-v5/arch-steward` status (B3/B4 veto & incomplete precedence). */
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
  if (githubStatus.verdict === 'veto' || githubStatus.incomplete || githubStatus.invalid) {
    return {
      ...base,
      ok: false,
      exitCode: failExit,
      receiptLookup: {
        found: githubStatus.verdict === 'veto',
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

export interface StewardRangeVerificationOptions extends StewardHostReceiptConfig {
  baseSha: string
  headSha: string
  commits?: readonly string[]
  gitDir?: string
  github?: StewardGithubApiConfig
}

export interface StewardRangeVerificationResult {
  ok: boolean
  vetoed: boolean
  summary: string
  failureReason?: string
  vetoLookup?: ReceiptLookupResult
  vetoVerification?: StewardReceiptVerificationResult
  vetoGithubStatus?: GithubStewardStatusResult
}

function checkLocalStewardForCommit(
  commitSha: string,
  parentSha: string,
  triggers: readonly StructuralRiskTriggerCode[],
  opts: StewardRangeVerificationOptions,
): {
  passed: boolean
  vetoed: boolean
  lookup: ReceiptLookupResult
  ver?: StewardReceiptVerificationResult
} {
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
  return {
    passed: ver.ok,
    vetoed: ver.violations.some((v) => v.code === 'STEWARD-HARD-VETO'),
    lookup,
    ver,
  }
}

async function checkLowRiskCommitInRange(
  commitSha: string,
  localPassed: boolean,
  ghStatus: GithubStewardStatusResult | undefined,
  opts: StewardRangeVerificationOptions,
): Promise<{
  ok: boolean
  vetoed: boolean
  note: string
  vetoLookup?: ReceiptLookupResult
  vetoVerification?: StewardReceiptVerificationResult
}> {
  if (ghStatus?.incomplete || ghStatus?.invalid) {
    return {
      ok: false,
      vetoed: false,
      note: `commit ${commitSha.slice(0, 12)} online status incomplete/invalid: ${ghStatus.reason}`,
    }
  }
  const hostVeto = findLocalHostVetoAcrossCandidates(ghStatus, opts)
  if (hostVeto.vetoed) {
    return {
      ok: false,
      vetoed: true,
      note: `commit ${commitSha.slice(0, 12)} carried-over host receipt (${hostVeto.vetoSha?.slice(0, 12)}) has HARD VETO`,
      vetoLookup: hostVeto.receiptLookup,
      vetoVerification: hostVeto.receiptVerification,
    }
  }
  if (localPassed || ghStatus?.valid) {
    return { ok: true, vetoed: false, note: `${commitSha.slice(0, 12)}:low-risk+approved` }
  }
  if (!opts.github) {
    return {
      ok: false,
      vetoed: false,
      note: `commit ${commitSha.slice(0, 12)} is low-risk in multi-commit range without GitHub merged-PR provenance`,
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

async function verifyOneCommitInStewardRange(
  commitSha: string,
  parentSha: string,
  opts: StewardRangeVerificationOptions,
): Promise<{
  ok: boolean
  vetoed: boolean
  note: string
  vetoLookup?: ReceiptLookupResult
  vetoVerification?: StewardReceiptVerificationResult
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
      vetoVerification: local.ver,
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
  if (ghStatus?.incomplete || ghStatus?.invalid) {
    return {
      ok: false,
      vetoed: false,
      note: `commit ${commitSha.slice(0, 12)} online Steward check incomplete/invalid: ${ghStatus.reason}`,
      vetoGithubStatus: ghStatus,
    }
  }

  if (!risk.requiresSteward)
    return checkLowRiskCommitInRange(commitSha, local.passed, ghStatus, opts)

  // B3: Scan carried-over candidate host HARD VETOs unconditionally BEFORE accepting local.passed or ghStatus.valid!
  const hostVeto = findLocalHostVetoAcrossCandidates(ghStatus, opts)
  if (hostVeto.vetoed) {
    return {
      ok: false,
      vetoed: true,
      note: `commit ${commitSha.slice(0, 12)} carried-over host receipt (${hostVeto.vetoSha?.slice(0, 12)}) has HARD VETO`,
      vetoLookup: hostVeto.receiptLookup,
      vetoVerification: hostVeto.receiptVerification,
    }
  }
  if (local.passed)
    return { ok: true, vetoed: false, note: `${commitSha.slice(0, 12)}:host-approved` }
  if (ghStatus?.valid)
    return { ok: true, vetoed: false, note: `${commitSha.slice(0, 12)}:github-approved` }

  if (ghStatus?.equivalenceCandidates?.length) {
    const carried = verifyLocalHostStewardCarryOver({
      ...opts,
      expectedBaseSha: parentSha,
      requiredTriggers: risk.triggers,
      candidates: ghStatus.equivalenceCandidates,
    })
    if (carried.vetoed) {
      return {
        ok: false,
        vetoed: true,
        note: `commit ${commitSha.slice(0, 12)} carried-over host receipt has HARD VETO`,
        vetoLookup: carried.receiptLookup,
        vetoVerification: carried.receiptVerification,
      }
    }
    if (carried.ok)
      return { ok: true, vetoed: false, note: `${commitSha.slice(0, 12)}:host-carryover-approved` }
  }
  return {
    ok: false,
    vetoed: false,
    note: `commit ${commitSha.slice(0, 12)} triggered Steward (${risk.triggers.join(', ')}) with no valid approval${ghStatus?.reason ? ` (${ghStatus.reason})` : ''}`,
  }
}

/** Decompose a coalesced multi-PR release train (`baseSha..headSha`) commit-by-commit. */
export async function verifyStewardCommitRangeFallback(
  opts: StewardRangeVerificationOptions,
): Promise<StewardRangeVerificationResult> {
  const commits = opts.commits
    ? [...opts.commits]
    : (() => {
        const r = inspectFirstParentRange(opts.root, opts.baseSha, opts.headSha, opts.gitDir)
        return r.kind === 'multi' ? r.commits : null
      })()
  if (!commits || commits.length < 2) {
    return {
      ok: false,
      vetoed: false,
      summary: '',
      failureReason: 'not a valid multi-commit first-parent range',
    }
  }
  const notes: string[] = []
  let parent = opts.baseSha
  for (const commitSha of commits) {
    const step = await verifyOneCommitInStewardRange(commitSha, parent, opts)
    if (!step.ok) {
      return {
        ok: false,
        vetoed: step.vetoed,
        summary: notes.join(', '),
        failureReason: step.note,
        vetoLookup: step.vetoLookup,
        vetoVerification: step.vetoVerification,
        vetoGithubStatus: step.vetoGithubStatus,
      }
    }
    notes.push(step.note)
    parent = commitSha
  }
  return {
    ok: true,
    vetoed: false,
    summary: `multi-commit-range(${commits.length}): ${notes.join(', ')}`,
  }
}

export interface StewardOnlineGateInput extends MergedGithubStewardInput, StewardHostReceiptConfig {
  gitDir?: string
  explicitReceiptPath?: string
  github?: StewardGithubApiConfig
}

export interface StewardOnlineGateOutput {
  ok: boolean
  exitCode: 0 | 1
  mode: MergedGithubStewardInput['mode']
  headSha: string
  baseSha: string
  risk: StructuralRiskReport
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
  githubStatus?: GithubStewardStatusResult
}

async function checkStewardRangeNegativeVotes(
  commits: readonly string[],
  opts: StewardOnlineGateInput,
): Promise<StewardOnlineGateOutput | null> {
  const base = { mode: opts.mode, headSha: opts.headSha, baseSha: opts.baseSha, risk: opts.risk }
  const failExit: 0 | 1 = opts.mode === 'check-only' ? 0 : 1
  for (const commitSha of commits) {
    if (commitSha !== opts.headSha) {
      const localVeto = checkLocalHostStewardVeto({ ...opts, targetSha: commitSha })
      if (localVeto.vetoed) {
        return {
          ...base,
          ok: false,
          exitCode: failExit,
          receiptLookup: localVeto.receiptLookup,
          receiptVerification: localVeto.receiptVerification,
        }
      }
    }
    if (!opts.github) continue
    const gh = await verifyGithubStewardStatus({
      ...opts.github,
      headSha: commitSha,
      allowMergedPrCarryOver: true,
    })
    if (gh.verdict === 'veto' || gh.incomplete || gh.invalid) {
      return {
        ...base,
        ok: false,
        exitCode: failExit,
        receiptLookup: {
          found: gh.verdict === 'veto',
          channel: 'github-status',
          source: gh.source,
          error: gh.reason,
          searchedLocations: [...(opts.receiptLookup?.searchedLocations ?? []), gh.source],
        },
        receiptVerification: opts.receiptVerification,
        githubStatus: gh,
      }
    }
    const candVeto = findLocalHostVetoAcrossCandidates(gh, opts)
    if (candVeto.vetoed) {
      return {
        ...base,
        ok: false,
        exitCode: failExit,
        receiptLookup: candVeto.receiptLookup,
        receiptVerification: candVeto.receiptVerification,
        githubStatus: gh,
      }
    }
  }
  return null
}

/**
 * Resolve online GitHub status, multi-commit first-parent range decomposition, and local host
 * carry-over for Architecture Steward (B2/B3/B4/B5).
 */
export async function resolveStewardGateOnlineAsync(
  opts: StewardOnlineGateInput,
): Promise<StewardOnlineGateOutput> {
  const base = { mode: opts.mode, headSha: opts.headSha, baseSha: opts.baseSha, risk: opts.risk }
  const failExit: 0 | 1 = opts.mode === 'check-only' ? 0 : 1
  const rangeInfo =
    opts.mode === 'enforce-commit' && !opts.explicitReceiptPath
      ? inspectFirstParentRange(opts.root, opts.baseSha, opts.headSha, opts.gitDir)
      : { kind: 'single' as const, commit: opts.headSha }

  // B2/B3/B4: Multi-commit (`2..20`) OR un-decomposable (`>20` / non-linear) ranges NEVER allow
  // tip-only GitHub status (which lacks baseSha). Only an explicit aggregate host receipt bound
  // to BOTH baseSha & headSha (with zero negative/incomplete/invalid votes) or C1..CN decomposition passes!
  if (rangeInfo.kind === 'invalid') {
    if (!opts.passed) {
      return {
        ...base,
        ok: false,
        exitCode: failExit,
        receiptLookup: {
          found: opts.receiptLookup?.found ?? false,
          channel: opts.receiptLookup?.channel,
          source: `range:${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
          error: `cannot decompose range (${rangeInfo.reason}); require aggregate host Steward receipt bound to both baseSha and headSha`,
          searchedLocations: opts.receiptLookup?.searchedLocations ?? [],
        },
        receiptVerification: opts.receiptVerification,
      }
    }
    if (!opts.github) {
      return {
        ...base,
        ok: true,
        exitCode: 0,
        receiptLookup: opts.receiptLookup,
        receiptVerification: opts.receiptVerification,
      }
    }
    const ghDirect = await verifyGithubStewardStatus({
      ...opts.github,
      headSha: opts.headSha,
      allowMergedPrCarryOver: false,
    })
    return mergeGithubStewardOutcome(opts, ghDirect)
  }

  if (rangeInfo.kind === 'multi') {
    if (opts.passed) {
      const negHit = await checkStewardRangeNegativeVotes(rangeInfo.commits, opts)
      if (negHit) return negHit
      return {
        ...base,
        ok: true,
        exitCode: 0,
        receiptLookup: opts.receiptLookup,
        receiptVerification: opts.receiptVerification,
      }
    }
    const rangeRes = await verifyStewardCommitRangeFallback({ ...opts, commits: rangeInfo.commits })
    return {
      ...base,
      ok: rangeRes.ok,
      exitCode: rangeRes.ok ? 0 : failExit,
      receiptLookup: rangeRes.vetoLookup ?? {
        found: rangeRes.ok || rangeRes.vetoed,
        channel: opts.github ? 'github-status' : 'host-file',
        source: rangeRes.ok
          ? rangeRes.summary
          : `range:${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
        error: rangeRes.ok ? undefined : rangeRes.failureReason,
        searchedLocations: opts.receiptLookup?.searchedLocations ?? [],
      },
      receiptVerification: rangeRes.vetoVerification ?? opts.receiptVerification,
      githubStatus: rangeRes.vetoGithubStatus,
    }
  }

  const allowSingleCarry = opts.mode === 'enforce-commit'
  if (opts.github && !opts.explicitReceiptPath) {
    const githubStatus = await verifyGithubStewardStatus({
      ...opts.github,
      headSha: opts.headSha,
      allowMergedPrCarryOver: allowSingleCarry,
    })
    // B3: Check carried-over candidate host HARD VETO unconditionally BEFORE accepting local.passed or githubStatus.valid!
    const hostVeto = findLocalHostVetoAcrossCandidates(githubStatus, opts)
    if (hostVeto.vetoed) {
      return {
        ...base,
        ok: false,
        exitCode: failExit,
        receiptLookup: hostVeto.receiptLookup,
        receiptVerification: hostVeto.receiptVerification,
        githubStatus,
      }
    }
    const merged = mergeGithubStewardOutcome(opts, githubStatus)
    if (
      merged.ok ||
      githubStatus.verdict === 'veto' ||
      githubStatus.incomplete ||
      githubStatus.invalid
    ) {
      return merged
    }
    if (allowSingleCarry && githubStatus.equivalenceCandidates?.length) {
      const hostCarry = verifyLocalHostStewardCarryOver({
        ...opts,
        expectedBaseSha: opts.baseSha,
        requiredTriggers: opts.risk.triggers,
        candidates: githubStatus.equivalenceCandidates,
      })
      if (hostCarry.vetoed || hostCarry.ok) {
        return {
          ...base,
          ok: hostCarry.ok,
          exitCode: hostCarry.ok ? 0 : failExit,
          receiptLookup: hostCarry.receiptLookup,
          receiptVerification: hostCarry.receiptVerification,
          githubStatus,
        }
      }
    }
    return merged
  }

  return {
    ...base,
    ok: opts.passed,
    exitCode: opts.passed || opts.mode === 'check-only' ? 0 : 1,
    receiptLookup: opts.receiptLookup,
    receiptVerification: opts.receiptVerification,
  }
}
