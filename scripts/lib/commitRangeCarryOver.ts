/**
 * Architecture Steward Multi-Commit Range, Cross-Channel Veto & Host Carry-Over Verification (OCV5-912).
 * Enforces bounded range checks, symmetric cross-channel VETO/unverifiable precedence, and merged-PR provenance.
 */
import {
  DEFAULT_STEWARD_HMAC_KEY_ENV,
  type ReceiptLookupResult,
  SHA40_RE,
  type StewardReceiptVerificationResult,
  type StructuralRiskReport,
  type StructuralRiskTriggerCode,
  collectDiffSummaryFromGit,
  evaluateStructuralRisk,
  findStewardReceiptForCommit,
  readCommitMessage,
  resolveStewardHmacKeyState,
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
  gitDir?: string
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

export interface LocalHostVetoCheckResult {
  blocked: boolean
  vetoed: boolean
  unverifiable?: boolean
  vetoSha?: string
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
}

/**
 * Check whether an authoritative local host Steward receipt exists for `targetSha` and carries a
 * HARD VETO OR cannot be verified (F4: distinguishes truly absent vs authentic HARD VETO vs
 * unverifiable authoritative host receipt, resolving host HMAC independently when needed).
 */
export function checkLocalHostStewardVeto(
  opts: StewardHostReceiptConfig & { targetSha: string },
): LocalHostVetoCheckResult {
  const commitMessage = readCommitMessage(opts.root, opts.targetSha, opts.gitDir)
  const lookup = findStewardReceiptForCommit({
    root: opts.root,
    headSha: opts.targetSha,
    receiptDirs: opts.receiptDirs,
    commitMessage,
    requireRootOwner: opts.requireRootOwner,
    hmacKey: opts.hmacKey,
    allowUntrustedRepoReceipt: opts.allowUntrustedRepoReceipt,
    env: opts.env,
  })
  if (lookup.error) {
    return { blocked: true, vetoed: false, unverifiable: true, receiptLookup: lookup }
  }
  if (!lookup.found) return { blocked: false, vetoed: false }

  let effectiveHmacKey = opts.hmacKey
  let effectiveRequireHmac = opts.requireHmac
  if (!effectiveHmacKey && lookup.channel === 'host-file') {
    try {
      const hostKeyState = resolveStewardHmacKeyState({
        hmacKeyEnv: DEFAULT_STEWARD_HMAC_KEY_ENV,
        requireRootOwner: opts.requireRootOwner,
        allowHostDefault: true,
        root: opts.root,
        receiptDirs: opts.receiptDirs,
        env: opts.env,
      })
      effectiveHmacKey = hostKeyState.hmacKey
      effectiveRequireHmac = effectiveRequireHmac || hostKeyState.requireHmac
    } catch (err) {
      return {
        blocked: true,
        vetoed: false,
        unverifiable: true,
        receiptLookup: {
          ...lookup,
          error: `authoritative host receipt exists but host .hmac-key could not be loaded: ${(err as Error).message}`,
        },
      }
    }
  }
  const ver = verifyArchStewardReceipt(lookup.raw, {
    headSha: opts.targetSha,
    hmacKey: effectiveHmacKey,
    requireHmac: effectiveRequireHmac,
    rootFileIntegrity: Boolean(lookup.rootOwnerVerified),
  })
  const integrityFailed = ver.violations.some(
    (v) =>
      v.code === 'STEWARD-RECEIPT-SHA-MISMATCH' ||
      v.code === 'STEWARD-RECEIPT-DIGEST-MISMATCH' ||
      v.code === 'STEWARD-RECEIPT-SCHEMA-INVALID',
  )
  if (integrityFailed) {
    return {
      blocked: true,
      vetoed: false,
      unverifiable: true,
      receiptLookup: {
        ...lookup,
        error: `authoritative host receipt for ${opts.targetSha.slice(0, 12)} could not be verified under active key (fail-closed)`,
      },
      receiptVerification: ver,
    }
  }
  if (ver.violations.some((v) => v.code === 'STEWARD-HARD-VETO')) {
    return { blocked: true, vetoed: true, receiptLookup: lookup, receiptVerification: ver }
  }
  return { blocked: false, vetoed: false }
}

function findLocalHostVetoAcrossCandidates(
  ghStatus: GithubStewardStatusResult | undefined,
  opts: StewardHostReceiptConfig,
): LocalHostVetoCheckResult {
  const shas = new Set<string>([
    ...(ghStatus?.carriedOverFromSha ? [ghStatus.carriedOverFromSha] : []),
    ...(ghStatus?.equivalenceCandidates?.map((c) => c.prHeadSha) ?? []),
  ])
  let unverifiableHit: LocalHostVetoCheckResult | undefined
  for (const hSha of shas) {
    const res = checkLocalHostStewardVeto({ ...opts, targetSha: hSha })
    if (res.vetoed) return { ...res, vetoSha: hSha }
    if (res.blocked && !unverifiableHit) unverifiableHit = { ...res, vetoSha: hSha }
  }
  return unverifiableHit ?? { blocked: false, vetoed: false }
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
): StewardOnlineGateOutput & { githubStatus: GithubStewardStatusResult } {
  const searched = [...(local.receiptLookup?.searchedLocations ?? []), githubStatus.source]
  const out = (
    ok: boolean,
    receiptLookup?: ReceiptLookupResult,
    receiptVerification?: StewardReceiptVerificationResult,
  ) => ({
    mode: local.mode,
    headSha: local.headSha,
    baseSha: local.baseSha,
    risk: local.risk,
    ok,
    exitCode: (ok || local.mode === 'check-only' ? 0 : 1) as 0 | 1,
    receiptLookup,
    receiptVerification,
    githubStatus,
  })
  if (githubStatus.verdict === 'veto' || githubStatus.incomplete || githubStatus.invalid) {
    return out(
      false,
      {
        found: githubStatus.verdict === 'veto',
        channel: 'github-status',
        source: githubStatus.source,
        error: githubStatus.reason,
        searchedLocations: searched,
      },
      local.receiptVerification,
    )
  }
  if (local.passed) return out(true, local.receiptLookup, local.receiptVerification)
  if (githubStatus.valid) {
    return out(true, {
      found: true,
      channel: 'github-status',
      source: githubStatus.source,
      searchedLocations: searched,
    })
  }
  return out(
    false,
    {
      found: local.receiptLookup?.found ?? false,
      channel: local.receiptLookup?.channel,
      source: local.receiptLookup?.source ?? githubStatus.source,
      raw: local.receiptLookup?.raw,
      error: local.receiptLookup?.error
        ? `${local.receiptLookup.error}; github: ${githubStatus.reason}`
        : githubStatus.reason,
      searchedLocations: searched,
    },
    local.receiptVerification,
  )
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
  if (hostVeto.blocked) {
    return {
      ok: false,
      vetoed: hostVeto.vetoed,
      note: `commit ${commitSha.slice(0, 12)} carried-over host receipt (${hostVeto.vetoSha?.slice(0, 12)}) ${hostVeto.vetoed ? 'has HARD VETO' : 'is unverifiable (fail-closed)'}`,
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
  if (hostVeto.blocked) {
    return {
      ok: false,
      vetoed: hostVeto.vetoed,
      note: `commit ${commitSha.slice(0, 12)} carried-over host receipt (${hostVeto.vetoSha?.slice(0, 12)}) ${hostVeto.vetoed ? 'has HARD VETO' : 'is unverifiable (fail-closed)'}`,
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

function buildStewardOutput(
  opts: StewardOnlineGateInput,
  ok: boolean,
  receiptLookup?: ReceiptLookupResult,
  receiptVerification?: StewardReceiptVerificationResult,
  githubStatus?: GithubStewardStatusResult,
): StewardOnlineGateOutput {
  return {
    mode: opts.mode,
    headSha: opts.headSha,
    baseSha: opts.baseSha,
    risk: opts.risk,
    ok,
    exitCode: ok || opts.mode === 'check-only' ? 0 : 1,
    receiptLookup,
    receiptVerification,
    ...(githubStatus ? { githubStatus } : {}),
  }
}

async function checkStewardRangeNegativeVotes(
  commits: readonly string[],
  opts: StewardOnlineGateInput,
): Promise<StewardOnlineGateOutput | null> {
  for (const commitSha of commits) {
    if (commitSha !== opts.headSha) {
      const localVeto = checkLocalHostStewardVeto({ ...opts, targetSha: commitSha })
      if (localVeto.blocked) {
        return buildStewardOutput(
          opts,
          false,
          localVeto.receiptLookup,
          localVeto.receiptVerification,
        )
      }
    }
    if (!opts.github) continue
    const gh = await verifyGithubStewardStatus({
      ...opts.github,
      headSha: commitSha,
      allowMergedPrCarryOver: true,
    })
    if (gh.verdict === 'veto' || gh.incomplete || gh.invalid) {
      return buildStewardOutput(
        opts,
        false,
        {
          found: gh.verdict === 'veto',
          channel: 'github-status',
          source: gh.source,
          error: gh.reason,
          searchedLocations: [...(opts.receiptLookup?.searchedLocations ?? []), gh.source],
        },
        opts.receiptVerification,
        gh,
      )
    }
    const candVeto = findLocalHostVetoAcrossCandidates(gh, opts)
    if (candVeto.blocked) {
      return buildStewardOutput(
        opts,
        false,
        candVeto.receiptLookup,
        candVeto.receiptVerification,
        gh,
      )
    }
  }
  return null
}

/**
 * Resolve online GitHub status, multi-commit first-parent range decomposition, and local host
 * carry-over for Architecture Steward (B2/B3/B4/B5/F1/F2/F3/F4).
 */
export async function resolveStewardGateOnlineAsync(
  opts: StewardOnlineGateInput,
): Promise<StewardOnlineGateOutput> {
  if (opts.explicitReceiptPath) {
    if (!opts.passed) {
      return buildStewardOutput(opts, false, opts.receiptLookup, opts.receiptVerification)
    }
    const existingHostVeto = checkLocalHostStewardVeto({ ...opts, targetSha: opts.headSha })
    if (existingHostVeto.blocked) {
      return buildStewardOutput(
        opts,
        false,
        existingHostVeto.receiptLookup,
        existingHostVeto.receiptVerification,
      )
    }
  }
  const rangeInfo =
    opts.mode === 'enforce-commit'
      ? inspectFirstParentRange(opts.root, opts.baseSha, opts.headSha, opts.gitDir)
      : { kind: 'single' as const, commit: opts.headSha }

  if (rangeInfo.kind === 'invalid') {
    return buildStewardOutput(
      opts,
      false,
      {
        found: opts.receiptLookup?.found ?? false,
        channel: opts.receiptLookup?.channel,
        source: `range:${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
        error: `cannot verify range (${rangeInfo.reason})`,
        searchedLocations: opts.receiptLookup?.searchedLocations ?? [],
      },
      opts.receiptVerification,
    )
  }

  if ((rangeInfo.kind === 'oversized' || rangeInfo.kind === 'multi') && opts.passed) {
    const negHit = await checkStewardRangeNegativeVotes(rangeInfo.commits, opts)
    return negHit ?? buildStewardOutput(opts, true, opts.receiptLookup, opts.receiptVerification)
  }
  if (rangeInfo.kind === 'oversized') {
    return buildStewardOutput(
      opts,
      false,
      {
        found: opts.receiptLookup?.found ?? false,
        channel: opts.receiptLookup?.channel,
        source: `range:${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
        error: `${rangeInfo.reason}; require aggregate host Steward receipt bound to both baseSha and headSha`,
        searchedLocations: opts.receiptLookup?.searchedLocations ?? [],
      },
      opts.receiptVerification,
    )
  }

  if (rangeInfo.kind === 'multi') {
    const rangeRes = await verifyStewardCommitRangeFallback({ ...opts, commits: rangeInfo.commits })
    return buildStewardOutput(
      opts,
      rangeRes.ok,
      rangeRes.vetoLookup ?? {
        found: rangeRes.ok || rangeRes.vetoed,
        channel: opts.github ? 'github-status' : 'host-file',
        source: rangeRes.ok
          ? rangeRes.summary
          : `range:${opts.baseSha.slice(0, 12)}..${opts.headSha.slice(0, 12)}`,
        error: rangeRes.ok ? undefined : rangeRes.failureReason,
        searchedLocations: opts.receiptLookup?.searchedLocations ?? [],
      },
      rangeRes.vetoVerification ?? opts.receiptVerification,
      rangeRes.vetoGithubStatus,
    )
  }

  const allowSingleCarry = opts.mode === 'enforce-commit'
  if (opts.github) {
    const githubStatus = await verifyGithubStewardStatus({
      ...opts.github,
      headSha: opts.headSha,
      allowMergedPrCarryOver: allowSingleCarry,
    })
    const hostVeto = findLocalHostVetoAcrossCandidates(githubStatus, opts)
    if (hostVeto.blocked) {
      return buildStewardOutput(
        opts,
        false,
        hostVeto.receiptLookup,
        hostVeto.receiptVerification,
        githubStatus,
      )
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
        return buildStewardOutput(
          opts,
          hostCarry.ok,
          hostCarry.receiptLookup,
          hostCarry.receiptVerification,
          githubStatus,
        )
      }
    }
    return merged
  }

  return buildStewardOutput(opts, opts.passed, opts.receiptLookup, opts.receiptVerification)
}
