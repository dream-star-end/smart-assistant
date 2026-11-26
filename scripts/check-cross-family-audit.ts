/**
 * Cross-Family T2 Audit & Architecture Steward Enforcement Gate (OCV5-905).
 *
 * Dual-mode gate with 100% backward compatibility:
 *
 * 1. Legacy direct model / receipt check (existing callers & `context-replay-eval.ts`):
 *      npx tsx scripts/check-cross-family-audit.ts --dev-model <slug> --audit-model <slug>
 *      npx tsx scripts/check-cross-family-audit.ts --receipt <path/to/receipt.json>
 *
 * 2. Deterministic Architecture Steward CI / Release-Train Hard Gate:
 *      npx tsx scripts/check-cross-family-audit.ts --enforce-commit [--base <ref>] [--head <ref>] [--receipt-dir <dir>] [--root <dir>] [--json]
 *      npx tsx scripts/check-cross-family-audit.ts --enforce-pr     [--base <ref>] [--head <ref>] [--receipt-dir <dir>] [--root <dir>] [--json]
 *      npx tsx scripts/check-cross-family-audit.ts --check-only     [--base <ref>] [--head <ref>] [--receipt-dir <dir>] [--root <dir>] [--json]
 *
 *    Execution flow:
 *      a) Runs `evaluateStructuralRisk` against `git diff <base>...<head>`:
 *         - If 0/6 structural risk triggers fire (ordinary low-risk T0/T1 edits), exits 0 immediately
 *           with zero LLM/steward overhead.
 *         - If >= 1 trigger fires, locates and strictly verifies an `ArchStewardReceipt` bound to
 *           the exact 40-char `headSha` (anti-tamper digest, no old-SHA reuse, no same-family
 *           self-review, no weak steward model, non-overridable hard veto).
 *
 * 3. Steward helper utilities (consumed by `scripts/arch-steward-review.sh`):
 *      npx tsx scripts/check-cross-family-audit.ts --recommend-model <authorSlug>
 *      npx tsx scripts/check-cross-family-audit.ts --sign-receipt <in.json> [--out <out.json>]
 *
 * CLI safety:
 *   - `--receipt <json>` and `--dev-model`/`--audit-model` remain strictly mutually exclusive (exit 2).
 *   - Mixing `--dev-model`/`--audit-model` with `--enforce-commit`/`--enforce-pr`/`--check-only` fails closed (exit 2).
 *
 * Exit: 0 ok, 1 policy violation / missing or invalid steward receipt / hard veto, 2 CLI/git/IO error.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
  type ArchStewardReceipt,
  DEFAULT_STEWARD_HMAC_KEY_ENV,
  type ReceiptLookupResult,
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
  signArchStewardReceipt,
  verifyArchStewardReceipt,
} from './lib/archStewardContract.js'
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
  ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
  collectDiffSummaryFromGit,
  evaluateStructuralRisk,
  findStewardReceiptForCommit,
  formatStewardGateFailure,
  formatStructuralRiskReport,
  signArchStewardReceipt,
  verifyArchStewardReceipt,
}
export type { ArchStewardReceipt, ReceiptLookupResult, StewardReceiptVerificationResult, StructuralRiskReport }

export interface StewardGateRunOptions {
  root: string
  mode: 'enforce-commit' | 'enforce-pr' | 'check-only'
  baseRef?: string
  headRef?: string
  receiptDirs?: readonly string[]
  explicitReceiptPath?: string
  gitDir?: string
  hmacKey?: string
  env?: Readonly<Record<string, string | undefined>>
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
}

export function runStewardGate(opts: StewardGateRunOptions): StewardGateRunResult {
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
    return {
      ok: true,
      exitCode: 0,
      mode: opts.mode,
      headSha,
      baseSha,
      risk,
    }
  }

  const commitMessage = readCommitMessage(opts.root, headSha, gitDir)
  const receiptLookup = findStewardReceiptForCommit({
    root: opts.root,
    headSha,
    explicitReceiptPath: opts.explicitReceiptPath,
    receiptDirs: opts.receiptDirs,
    commitMessage,
    env,
  })

  let receiptVerification: StewardReceiptVerificationResult | undefined
  if (receiptLookup.found && !receiptLookup.error) {
    receiptVerification = verifyArchStewardReceipt(receiptLookup.raw, {
      headSha,
      baseSha,
      requiredTriggers: risk.triggers,
      hmacKey: opts.hmacKey,
    })
  }

  const passed = Boolean(receiptLookup.found && !receiptLookup.error && receiptVerification?.ok)
  const exitCode: 0 | 1 = passed || opts.mode === 'check-only' ? 0 : 1

  return {
    ok: passed,
    exitCode,
    mode: opts.mode,
    headSha,
    baseSha,
    risk,
    receiptLookup,
    receiptVerification,
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
      '      [--hmac-key-env <ENV_VAR>] [--json]',
      '',
      '  Steward review helpers:',
      '    npx tsx scripts/check-cross-family-audit.ts --recommend-model <authorSlug>',
      '    npx tsx scripts/check-cross-family-audit.ts --sign-receipt <in.json> [--out <out.json>] [--hmac-key-env <ENV_VAR>]',
    ].join('\n'),
  )
}

function main(argv: string[]): number {
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

  // Helper mode: sign an ArchStewardReceipt JSON atomically
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
      const hmacKey = process.env[hmacKeyEnv]?.trim() || undefined
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
      const hmacKey = process.env[hmacKeyEnv]?.trim() || undefined
      const result = runStewardGate({
        root,
        mode: gateMode,
        baseRef,
        headRef,
        receiptDirs,
        explicitReceiptPath: receiptPath,
        hmacKey,
      })

      if (jsonOut) {
        console.log(JSON.stringify(result, null, 2))
        return result.exitCode
      }

      if (!result.risk.requiresSteward) {
        console.log(formatStructuralRiskReport(result.risk))
        return 0
      }

      if (result.ok && result.receiptVerification?.receipt) {
        const rec = result.receiptVerification.receipt
        console.log(formatStructuralRiskReport(result.risk))
        console.log(
          `[arch-steward] ok (${gateMode}): head=${result.headSha.slice(0, 12)} approved by ${rec.stewardModel} (${rec.stewardFamily}) vs author ${rec.authorModel} (${rec.authorFamily}) [source=${result.receiptLookup?.source}]`,
        )
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
  process.exit(main(process.argv.slice(2)))
}
