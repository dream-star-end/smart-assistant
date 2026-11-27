/**
 * Cross-Family T2 Audit & Architecture Steward Enforcement Gate (OCV5-905 / OCV5-903 B2 & B3).
 *
 * Dual-mode gate with 100% backward compatibility:
 *
 * 1. Legacy direct model / receipt check (existing callers & `context-replay-eval.ts`):
 *      npx tsx scripts/check-cross-family-audit.ts --dev-model <slug> --audit-model <slug>
 *      npx tsx scripts/check-cross-family-audit.ts --receipt <path/to/receipt.json>
 *
 * 2. Deterministic Architecture Steward CI / Release-Train Hard Gate:
 *      npx tsx scripts/check-cross-family-audit.ts (--enforce-commit | --enforce-pr | --check-only)
 *        [--base <ref>] [--head <ref>] [--root <dir>] [--receipt-dir <dir>] [--receipt <file.json>]
 *        [--hmac-key-env <ENV_VAR>] [--hmac-key-file <path>] [--require-root-owner]
 *        [--unsafe-test-skip-owner] [--github-repo <owner/repo>] [--github-token-env <ENV>]
 *        [--trusted-publishers <csv>] [--github-api-url <url>] [--json]
 *
 *    Trust boundaries:
 *      - Production rejects dry-run/example/mock receipts, symlinks, group/world-writable files,
 *        non-root host receipts, and unsigned in-repo `.github/steward-receipts/` files.
 *      - Out-of-commit authorization channels (shared by hosted CI runners and host release train):
 *          1. Root-only host receipt at `/opt/openclaude/harness-gate/steward-receipts/<headSha>.json`
 *          2. Trusted GitHub Commit Status `oc-v5/arch-steward` (`state === "success"`,
 *             `verdict=approve`, cross-family `stewardFamily !== authorFamily`, valid `receiptDigest`).
 *
 * 3. Steward helper utilities (consumed by `scripts/arch-steward-review.sh`):
 *      npx tsx scripts/check-cross-family-audit.ts --recommend-model <authorSlug>
 *      npx tsx scripts/check-cross-family-audit.ts --sign-receipt <in.json> [--out <out.json>]
 *
 * Exit: 0 ok, 1 policy violation / missing or invalid steward receipt / hard veto, 2 CLI/git/IO error.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  ARCH_STEWARD_DRY_RUN_SCHEMA_VERSION,
  ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
  type ArchStewardReceipt,
  DEFAULT_STEWARD_HMAC_KEY_ENV,
  type ReceiptLookupResult,
  type StewardHmacKeyState,
  type StewardReceiptVerificationResult,
  type StructuralRiskReport,
  collectDiffSummaryFromGit,
  evaluateStructuralRisk,
  findStewardReceiptForCommit,
  formatStewardGateFailure,
  formatStructuralRiskReport,
  readCommitMessage,
  resolveDefaultBaseRef,
  resolveGitSha,
  resolveStewardHmacKeyState,
  signArchStewardReceipt,
  verifyArchStewardReceipt,
} from './lib/archStewardContract.js'
import {
  mergeGithubStewardOutcome,
  resolvePostMergeStewardFallback,
} from './lib/commitRangeCarryOver.js'
import {
  type FetchLike,
  type GithubStewardStatusResult,
  resolveGithubToken,
  verifyGithubStewardStatus,
} from './lib/githubTrustedApproval.js'
import {
  type CrossFamilyAuditResult,
  type CrossFamilyViolationCode,
  MODEL_FAMILIES,
  type ModelFamily,
  extractModelsFromReceipt,
  formatCrossFamilyError,
  isWeakAuditModel,
  normalizeModelSlug,
  recommendAuditModelFor,
  resolveModelFamily,
  verifyCrossFamilyAudit,
} from './lib/modelFamilyClassifier.js'

// Preserve 100% of original public exports for all callers (`context-replay-eval.ts`, tests, etc.)
export {
  MODEL_FAMILIES,
  normalizeModelSlug,
  resolveModelFamily,
  isWeakAuditModel,
  recommendAuditModelFor,
  verifyCrossFamilyAudit,
  extractModelsFromReceipt,
  formatCrossFamilyError,
}
export type { ModelFamily, CrossFamilyViolationCode, CrossFamilyAuditResult }

// Re-export Architecture Steward contract APIs for downstream consumers
export {
  ARCH_STEWARD_DRY_RUN_SCHEMA_VERSION,
  ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
  collectDiffSummaryFromGit,
  evaluateStructuralRisk,
  findStewardReceiptForCommit,
  formatStewardGateFailure,
  formatStructuralRiskReport,
  resolveStewardHmacKeyState,
  signArchStewardReceipt,
  verifyArchStewardReceipt,
}
export type {
  ArchStewardReceipt,
  ReceiptLookupResult,
  StewardHmacKeyState,
  StewardReceiptVerificationResult,
  StructuralRiskReport,
}

export interface StewardGateRunOptions {
  root: string
  mode: 'enforce-commit' | 'enforce-pr' | 'check-only'
  baseRef?: string
  headRef?: string
  receiptDirs?: readonly string[]
  explicitReceiptPath?: string
  gitDir?: string
  hmacKey?: string
  requireHmac?: boolean
  requireRootOwner?: boolean
  allowUntrustedRepoReceipt?: boolean
  env?: Readonly<Record<string, string | undefined>>
  github?: {
    repo?: string
    token?: string
    trustedPublishers?: readonly string[]
    apiBaseUrl?: string
    expectedBaseRef?: string
    fetchImpl?: FetchLike
  }
}

export interface StewardGateRunResult {
  ok: boolean
  exitCode: 0 | 1
  mode: StewardGateRunOptions['mode']
  headSha: string
  baseSha: string
  risk: StructuralRiskReport
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
  githubStatus?: GithubStewardStatusResult
}

function runLocalStewardCheck(opts: StewardGateRunOptions): {
  headSha: string
  baseSha: string
  risk: StructuralRiskReport
  receiptLookup?: ReceiptLookupResult
  receiptVerification?: StewardReceiptVerificationResult
  passed: boolean
  hasHardVeto: boolean
} {
  const env = opts.env ?? process.env
  const gitDir = opts.gitDir ?? (env.GIT_DIR?.trim() || undefined)
  const headSha = resolveGitSha(opts.root, opts.headRef ?? 'HEAD', gitDir)
  const baseRef = opts.baseRef ?? resolveDefaultBaseRef(opts.root, headSha, { gitDir, env })

  const diffSummary = collectDiffSummaryFromGit({
    root: opts.root,
    baseRef,
    headRef: headSha,
    gitDir,
  })
  const baseSha = diffSummary.baseSha ?? resolveGitSha(opts.root, baseRef, gitDir)
  const risk = evaluateStructuralRisk(diffSummary, { root: opts.root })

  if (!risk.requiresSteward) {
    return { headSha, baseSha, risk, passed: true, hasHardVeto: false }
  }

  const commitMessage = readCommitMessage(opts.root, headSha, gitDir)
  const receiptLookup = findStewardReceiptForCommit({
    root: opts.root,
    headSha,
    explicitReceiptPath: opts.explicitReceiptPath,
    receiptDirs: opts.receiptDirs,
    commitMessage,
    requireRootOwner: opts.requireRootOwner ?? true,
    hmacKey: opts.hmacKey,
    allowUntrustedRepoReceipt: opts.allowUntrustedRepoReceipt ?? false,
    env,
  })

  let receiptVerification: StewardReceiptVerificationResult | undefined
  if (receiptLookup.found && !receiptLookup.error) {
    const requireHmac = opts.requireHmac ?? env.OC_STEWARD_REQUIRE_HMAC === '1'
    receiptVerification = verifyArchStewardReceipt(receiptLookup.raw, {
      headSha,
      baseSha,
      requiredTriggers: risk.triggers,
      hmacKey: opts.hmacKey,
      requireHmac,
      rootFileIntegrity: Boolean(receiptLookup.rootOwnerVerified),
    })
  }

  const passed = Boolean(receiptLookup.found && !receiptLookup.error && receiptVerification?.ok)
  const hasHardVeto = Boolean(
    receiptVerification?.violations.some((v) => v.code === 'STEWARD-HARD-VETO'),
  )
  return { headSha, baseSha, risk, receiptLookup, receiptVerification, passed, hasHardVeto }
}

/** Synchronous Architecture Steward check (host/explicit receipt verification). */
export function runStewardGate(opts: StewardGateRunOptions): StewardGateRunResult {
  const local = runLocalStewardCheck(opts)
  if (!local.risk.requiresSteward) {
    return {
      ok: true,
      exitCode: 0,
      mode: opts.mode,
      headSha: local.headSha,
      baseSha: local.baseSha,
      risk: local.risk,
    }
  }
  const exitCode: 0 | 1 = local.passed || opts.mode === 'check-only' ? 0 : 1
  return {
    ok: local.passed,
    exitCode,
    mode: opts.mode,
    headSha: local.headSha,
    baseSha: local.baseSha,
    risk: local.risk,
    receiptLookup: local.receiptLookup,
    receiptVerification: local.receiptVerification,
  }
}

/**
 * Asynchronous Architecture Steward check supporting host root-only receipts,
 * out-of-commit GitHub Commit Status `oc-v5/arch-steward`, squash/rebase merged-PR
 * carry-over (enforce-commit only), and coalesced multi-PR release-train decomposition.
 */
export async function runStewardGateAsync(
  opts: StewardGateRunOptions,
): Promise<StewardGateRunResult> {
  const local = runLocalStewardCheck(opts)
  const base = { mode: opts.mode, headSha: local.headSha, baseSha: local.baseSha, risk: local.risk }
  const failExit: 0 | 1 = opts.mode === 'check-only' ? 0 : 1
  if (!local.risk.requiresSteward) return { ...base, ok: true, exitCode: 0 }
  if (local.hasHardVeto) {
    return {
      ...base,
      ok: false,
      exitCode: failExit,
      receiptLookup: local.receiptLookup,
      receiptVerification: local.receiptVerification,
    }
  }

  const ghRepo = opts.github?.repo?.trim()
  const ghToken = opts.github?.token?.trim()
  const env = opts.env ?? process.env
  const requireHmac = opts.requireHmac ?? env.OC_STEWARD_REQUIRE_HMAC === '1'
  const allowCarryOver = opts.mode === 'enforce-commit'
  const ghCfg =
    ghRepo && ghToken
      ? {
          repo: ghRepo,
          token: ghToken,
          trustedPublishers: opts.github?.trustedPublishers,
          apiBaseUrl: opts.github?.apiBaseUrl,
          expectedBaseRef: opts.github?.expectedBaseRef,
          fetchImpl: opts.github?.fetchImpl,
        }
      : undefined
  let githubStatus: GithubStewardStatusResult | undefined

  if (ghCfg && !opts.explicitReceiptPath) {
    githubStatus = await verifyGithubStewardStatus({
      ...ghCfg,
      headSha: local.headSha,
      allowMergedPrCarryOver: allowCarryOver,
    })
    const merged = mergeGithubStewardOutcome({ mode: opts.mode, ...local }, githubStatus)
    if (merged.ok || githubStatus.verdict === 'veto') return merged
  } else if (local.passed) {
    return {
      ...base,
      ok: true,
      exitCode: 0,
      receiptLookup: local.receiptLookup,
      receiptVerification: local.receiptVerification,
    }
  }

  if (allowCarryOver && !opts.explicitReceiptPath) {
    const fb = await resolvePostMergeStewardFallback({
      root: opts.root,
      baseSha: local.baseSha,
      headSha: local.headSha,
      gitDir: opts.gitDir ?? (env.GIT_DIR?.trim() || undefined),
      requiredTriggers: local.risk.triggers,
      receiptDirs: opts.receiptDirs,
      requireRootOwner: opts.requireRootOwner ?? true,
      hmacKey: opts.hmacKey,
      requireHmac,
      allowUntrustedRepoReceipt: opts.allowUntrustedRepoReceipt ?? false,
      env,
      localSearchedLocations: local.receiptLookup?.searchedLocations,
      githubStatus,
      github: ghCfg,
    })
    if (fb) {
      return {
        ...base,
        ok: fb.ok,
        exitCode: fb.ok ? 0 : failExit,
        receiptLookup: fb.receiptLookup ?? local.receiptLookup,
        receiptVerification: fb.receiptVerification,
        githubStatus: fb.githubStatus ?? githubStatus,
      }
    }
  }

  return githubStatus
    ? mergeGithubStewardOutcome({ mode: opts.mode, ...local }, githubStatus)
    : {
        ...base,
        ok: false,
        exitCode: failExit,
        receiptLookup: local.receiptLookup,
        receiptVerification: local.receiptVerification,
      }
}

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  Legacy cross-family model check:',
      '    npx tsx scripts/check-cross-family-audit.ts --dev-model <slug> --audit-model <slug>',
      '    npx tsx scripts/check-cross-family-audit.ts --receipt <file.json>',
      '',
      '  Architecture Steward CI / Release-Train Gate:',
      '    npx tsx scripts/check-cross-family-audit.ts (--enforce-commit | --enforce-pr | --check-only)',
      '      [--base <ref>] [--head <ref>] [--root <dir>] [--receipt-dir <dir>] [--receipt <file.json>]',
      '      [--hmac-key-env <ENV_VAR>] [--hmac-key-file <path>] [--require-root-owner] [--unsafe-test-skip-owner]',
      '      [--github-repo <owner/repo>] [--github-token-env <ENV>] [--trusted-publishers <csv>] [--github-api-url <url>] [--json]',
      '',
      '  Steward review helpers:',
      '    npx tsx scripts/check-cross-family-audit.ts --recommend-model <authorSlug>',
      '    npx tsx scripts/check-cross-family-audit.ts --sign-receipt <in.json> [--out <out.json>] [--hmac-key-env <ENV_VAR>]',
    ].join('\n'),
  )
}

async function main(argv: string[]): Promise<number> {
  let devModel: string | undefined
  let auditModel: string | undefined
  let receiptPath: string | undefined
  let gateMode: 'enforce-commit' | 'enforce-pr' | 'check-only' | undefined
  let baseRef: string | undefined
  let headRef: string | undefined
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const receiptDirs: string[] = []
  let jsonOut = false
  let hmacKeyEnv = DEFAULT_STEWARD_HMAC_KEY_ENV
  let hmacKeyFile: string | undefined
  let requireRootOwner = true
  let allowUntrustedRepoReceipt = false
  let githubRepo = process.env.GITHUB_REPOSITORY?.trim() || process.env.GH_REPO?.trim() || undefined
  let githubTokenEnv: string | undefined
  let trustedPublishersRaw = process.env.OC_TRUSTED_APPROVERS?.trim() || ''
  let githubApiUrl = process.env.GITHUB_API_URL?.trim() || undefined
  let recommendAuthorSlug: string | undefined
  let signReceiptPath: string | undefined
  let outPath: string | undefined
  let stewardPreflight = false
  let authorModelArg: string | undefined
  let stewardModelArg: string | undefined

  const takeValue = (flag: string, idx: number): string | null => {
    const val = argv[idx]
    if (!val) {
      console.error(`[cross-family-audit] ${flag} requires a value`)
      return null
    }
    return val
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--dev-model') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      devModel = v
    } else if (arg === '--audit-model') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      auditModel = v
    } else if (arg === '--receipt') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      receiptPath = v
    } else if (arg === '--enforce-commit') {
      if (gateMode && gateMode !== 'enforce-commit') {
        console.error(`[cross-family-audit] conflicting modes: --${gateMode} and --enforce-commit`)
        return 2
      }
      gateMode = 'enforce-commit'
    } else if (arg === '--enforce-pr') {
      if (gateMode && gateMode !== 'enforce-pr') {
        console.error(`[cross-family-audit] conflicting modes: --${gateMode} and --enforce-pr`)
        return 2
      }
      gateMode = 'enforce-pr'
    } else if (arg === '--check-only') {
      if (gateMode && gateMode !== 'check-only') {
        console.error(`[cross-family-audit] conflicting modes: --${gateMode} and --check-only`)
        return 2
      }
      gateMode = 'check-only'
    } else if (arg === '--steward-preflight') {
      stewardPreflight = true
    } else if (arg === '--author-model') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      authorModelArg = v
    } else if (arg === '--steward-model') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      stewardModelArg = v
    } else if (arg === '--base') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      baseRef = v
    } else if (arg === '--head') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      headRef = v
    } else if (arg === '--root') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      root = path.resolve(v)
    } else if (arg === '--receipt-dir') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      receiptDirs.push(v)
    } else if (arg === '--hmac-key-env') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      hmacKeyEnv = v
    } else if (arg === '--hmac-key-file') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      hmacKeyFile = v
    } else if (arg === '--require-root-owner') {
      requireRootOwner = true
    } else if (arg === '--unsafe-test-skip-owner') {
      requireRootOwner = false
    } else if (arg === '--unsafe-test-allow-repo-receipt') {
      allowUntrustedRepoReceipt = true
    } else if (arg === '--github-repo') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      githubRepo = v
    } else if (arg === '--github-token-env') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      githubTokenEnv = v
    } else if (arg === '--trusted-publishers') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      trustedPublishersRaw = v
    } else if (arg === '--github-api-url') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      githubApiUrl = v
    } else if (arg === '--json') {
      jsonOut = true
    } else if (arg === '--recommend-model') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      recommendAuthorSlug = v
    } else if (arg === '--sign-receipt') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      signReceiptPath = v
    } else if (arg === '--out') {
      const v = takeValue(arg, ++i)
      if (!v) return 2
      outPath = v
    } else if (arg === '-h' || arg === '--help') {
      printUsage()
      return 0
    } else {
      console.error(`[cross-family-audit] unknown arg: ${arg}`)
      return 2
    }
  }

  const resolveHmacKeyState = (allowHostDefault = false): StewardHmacKeyState =>
    resolveStewardHmacKeyState({
      hmacKeyEnv,
      hmacKeyFile,
      requireRootOwner,
      allowHostDefault,
      root,
      explicitReceiptPath: receiptPath,
      receiptDirs,
    })

  // Helper mode: single-process preflight for `scripts/arch-steward-review.sh`
  if (stewardPreflight) {
    if (!authorModelArg) {
      console.error('[cross-family-audit] --steward-preflight requires --author-model <slug>')
      return 2
    }
    const authorFamily = resolveModelFamily(authorModelArg)
    if (!authorFamily) {
      console.error(
        `[GATE-ERROR] CROSS-FAMILY-UNKNOWN-MODEL: unrecognized author model ${JSON.stringify(authorModelArg)}`,
      )
      return 1
    }
    const effectiveSteward = stewardModelArg?.trim() || recommendAuditModelFor(authorFamily)
    const cross = verifyCrossFamilyAudit(authorModelArg, effectiveSteward)
    if (!cross.ok) {
      console.error(formatCrossFamilyError(cross))
      return 1
    }
    try {
      const gate = runStewardGate({
        root,
        mode: 'check-only',
        baseRef,
        headRef,
        requireRootOwner: false,
      })
      console.log(
        JSON.stringify({
          authorModel: cross.devModel,
          authorFamily: cross.devFamily,
          stewardModel: cross.auditModel,
          stewardFamily: cross.auditFamily,
          headSha: gate.headSha,
          baseSha: gate.baseSha,
          risk: gate.risk,
        }),
      )
      return 0
    } catch (err) {
      console.error(`[cross-family-audit] FAIL-CLOSED: ${(err as Error).message.split('\n')[0]}`)
      return 2
    }
  }

  // Helper mode: recommend cross-family steward model for an author slug
  if (recommendAuthorSlug !== undefined) {
    const authorFamily = resolveModelFamily(recommendAuthorSlug)
    if (!authorFamily) {
      console.error(
        `[GATE-ERROR] CROSS-FAMILY-UNKNOWN-MODEL: unrecognized author model ${JSON.stringify(recommendAuthorSlug)}`,
      )
      return 1
    }
    const recommendedStewardModel = recommendAuditModelFor(authorFamily)
    const stewardFamily = resolveModelFamily(recommendedStewardModel)
    const payload = {
      authorModel: recommendAuthorSlug.trim(),
      authorFamily,
      recommendedStewardModel,
      stewardFamily,
    }
    console.log(jsonOut ? JSON.stringify(payload, null, 2) : JSON.stringify(payload))
    return 0
  }

  // Helper mode: sign an ArchStewardReceipt JSON atomically (refuses dry-run receipts!)
  if (signReceiptPath !== undefined) {
    try {
      const absIn = path.resolve(signReceiptPath)
      if (!existsSync(absIn)) {
        console.error(`[cross-family-audit] FAIL-CLOSED: input receipt not found: ${absIn}`)
        return 2
      }
      const parsed = JSON.parse(readFileSync(absIn, 'utf8')) as Omit<
        ArchStewardReceipt,
        'receiptDigest'
      >
      const { hmacKey } = resolveHmacKeyState(false)
      const signed = signArchStewardReceipt(parsed, hmacKey)
      const rendered = `${JSON.stringify(signed, null, 2)}\n`
      if (outPath) {
        const absOut = path.resolve(outPath)
        mkdirSync(path.dirname(absOut), { recursive: true })
        const tmpOut = `${absOut}.tmp.${process.pid}`
        writeFileSync(tmpOut, rendered, 'utf8')
        renameSync(tmpOut, absOut)
      } else {
        process.stdout.write(rendered)
      }
      return 0
    } catch (err) {
      console.error(`[cross-family-audit] FAIL-CLOSED: ${(err as Error).message.split('\n')[0]}`)
      return 2
    }
  }

  // Strict mutual exclusion: CLI model flags must never combine with --receipt or steward gate modes
  if (receiptPath !== undefined && (devModel !== undefined || auditModel !== undefined)) {
    console.error(
      '[cross-family-audit] FAIL-CLOSED: --receipt is mutually exclusive with --dev-model and --audit-model',
    )
    return 2
  }
  if (gateMode !== undefined && (devModel !== undefined || auditModel !== undefined)) {
    console.error(
      `[cross-family-audit] FAIL-CLOSED: --${gateMode} is mutually exclusive with --dev-model and --audit-model`,
    )
    return 2
  }

  // Mode 2: Deterministic Architecture Steward commit/PR hard gate
  if (gateMode !== undefined) {
    try {
      const hmacState = resolveHmacKeyState(true)
      const githubToken = resolveGithubToken(githubTokenEnv)
      const trustedPublishers = trustedPublishersRaw
        ? trustedPublishersRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
      const expectedBaseRef =
        process.env.GITHUB_REF_TYPE === 'branch' && process.env.GITHUB_REF_NAME?.trim()
          ? process.env.GITHUB_REF_NAME.trim()
          : process.env.OC_V5_EXPECTED_BASE_BRANCH?.trim() || undefined
      const result = await runStewardGateAsync({
        root,
        mode: gateMode,
        baseRef,
        headRef,
        receiptDirs,
        explicitReceiptPath: receiptPath,
        hmacKey: hmacState.hmacKey,
        requireHmac: hmacState.requireHmac || process.env.OC_STEWARD_REQUIRE_HMAC === '1',
        requireRootOwner,
        allowUntrustedRepoReceipt,
        github:
          githubRepo && githubToken
            ? {
                repo: githubRepo,
                token: githubToken,
                trustedPublishers,
                apiBaseUrl: githubApiUrl,
                expectedBaseRef,
              }
            : undefined,
      })

      if (jsonOut) {
        console.log(JSON.stringify(result, null, 2))
        return result.exitCode
      }

      if (!result.risk.requiresSteward) {
        console.log(formatStructuralRiskReport(result.risk))
        return 0
      }

      if (result.ok) {
        console.log(formatStructuralRiskReport(result.risk))
        if (result.receiptVerification?.receipt) {
          const rec = result.receiptVerification.receipt
          console.log(
            `[arch-steward] ok (${gateMode}): head=${result.headSha.slice(0, 12)} approved by ${rec.stewardModel} (${rec.stewardFamily}) vs author ${rec.authorModel} (${rec.authorFamily}) [source=${result.receiptLookup?.source}]`,
          )
        } else if (result.githubStatus?.valid) {
          const gh = result.githubStatus
          console.log(
            `[arch-steward] ok (${gateMode}): head=${result.headSha.slice(0, 12)} approved via GitHub status (${gh.authorFamily} -> ${gh.stewardFamily}, digest=${gh.receiptDigest}, publisher=@${gh.publishedBy}) [source=${gh.source}]`,
          )
        } else if (result.receiptLookup?.found) {
          console.log(
            `[arch-steward] ok (${gateMode}): head=${result.headSha.slice(0, 12)} approved via ${result.receiptLookup.source}`,
          )
        }
        return 0
      }

      const failureMsg = formatStewardGateFailure(
        result.risk,
        result.headSha,
        result.baseSha,
        result.receiptVerification,
        result.receiptLookup,
      )
      if (gateMode === 'check-only') {
        console.log(failureMsg)
        console.log('[arch-steward] check-only mode: reporting findings without blocking (exit 0)')
        return 0
      }
      console.error(failureMsg)
      return 1
    } catch (err) {
      console.error(`[cross-family-audit] FAIL-CLOSED: ${(err as Error).message.split('\n')[0]}`)
      return 2
    }
  }

  // Mode 1: Legacy direct model-pair or receipt model check (100% preserved)
  try {
    if (receiptPath) {
      const abs = path.resolve(receiptPath)
      if (!existsSync(abs)) {
        console.error(`[cross-family-audit] FAIL-CLOSED: receipt file not found: ${abs}`)
        return 2
      }
      const parsed: unknown = JSON.parse(readFileSync(abs, 'utf8'))
      const extracted = extractModelsFromReceipt(parsed)
      devModel = extracted.devModel
      auditModel = extracted.auditModel
    }

    if (!devModel || !auditModel) {
      console.error(
        '[cross-family-audit] provide both --dev-model and --audit-model, --receipt <json>, or --enforce-commit/--enforce-pr/--check-only',
      )
      return 2
    }

    const res = verifyCrossFamilyAudit(devModel, auditModel)
    if (!res.ok) {
      console.error(formatCrossFamilyError(res))
      return 1
    }

    console.log(
      `[cross-family-audit] ok: dev=${res.devModel} (${res.devFamily}) -> audit=${res.auditModel} (${res.auditFamily})`,
    )
    return 0
  } catch (err) {
    console.error(`[cross-family-audit] FAIL-CLOSED: ${(err as Error).message.split('\n')[0]}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[cross-family-audit] FAIL-CLOSED: ${(err as Error).message.split('\n')[0]}`)
      process.exit(2)
    })
}
