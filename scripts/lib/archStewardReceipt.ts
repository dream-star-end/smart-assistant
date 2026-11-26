/**
 * Architecture Steward Receipt Signing, Verification, Discovery & Formatters (OCV5-905).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  ARCH_STEWARD_RECEIPT_SCHEMA_VERSION,
  type ArchStewardReceipt,
  DEFAULT_HOST_STEWARD_RECEIPT_DIR,
  DEFAULT_STEWARD_HMAC_KEY_ENV,
  DEFAULT_STEWARD_RECEIPT_REL_DIR,
  type ReceiptLookupResult,
  SHA40_RE,
  STEWARD_DIMENSION_KEYS,
  STEWARD_RECEIPT_TRAILER_KEY,
  STRUCTURAL_RISK_TRIGGER_CODES,
  type StewardReceiptVerificationResult,
  type StewardReceiptViolation,
  type StructuralRiskReport,
  type StructuralRiskTriggerCode,
} from './archStewardTypes.js'
import {
  recommendAuditModelFor,
  resolveModelFamily,
  verifyCrossFamilyAudit,
} from './modelFamilyClassifier.js'

const DIGEST_RE = /^(sha256|hmac-sha256):([0-9a-f]{64})$/

function canonicalSortValue(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(canonicalSortValue)
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] !== undefined) sorted[key] = canonicalSortValue(obj[key])
    }
    return sorted
  }
  return val
}

/** Deterministic canonical JSON serialization of all receipt fields except `receiptDigest`. */
export function canonicalizeReceiptPayload(receipt: Record<string, unknown>): string {
  const clone: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(receipt)) {
    if (k === 'receiptDigest') continue
    clone[k] = v
  }
  return JSON.stringify(canonicalSortValue(clone))
}

/**
 * Compute tamper-evident binding digest for an `ArchStewardReceipt`.
 * Uses `hmac-sha256:<64hex>` when `hmacKey` is provided, otherwise `sha256:<64hex>`.
 */
export function computeArchStewardReceiptDigest(
  receipt: Omit<ArchStewardReceipt, 'receiptDigest'> | Record<string, unknown>,
  hmacKey?: string,
): string {
  const canonical = canonicalizeReceiptPayload(receipt as Record<string, unknown>)
  const domainPayload = `${ARCH_STEWARD_RECEIPT_SCHEMA_VERSION}\n${canonical}`
  if (hmacKey && hmacKey.length > 0) {
    const mac = createHmac('sha256', hmacKey).update(domainPayload).digest('hex')
    return `hmac-sha256:${mac}`
  }
  const hash = createHash('sha256').update(domainPayload).digest('hex')
  return `sha256:${hash}`
}

/** Attach computed `receiptDigest` to an unsigned receipt object. */
export function signArchStewardReceipt(
  unsigned: Omit<ArchStewardReceipt, 'receiptDigest'>,
  hmacKey?: string,
): ArchStewardReceipt {
  return { ...unsigned, receiptDigest: computeArchStewardReceiptDigest(unsigned, hmacKey) }
}

function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

function isValidIsoTimestamp(s: unknown): boolean {
  return typeof s === 'string' && s.trim().length > 0 && Number.isFinite(Date.parse(s))
}

export interface VerifyArchStewardReceiptOptions {
  headSha: string
  baseSha?: string
  requiredTriggers?: readonly StructuralRiskTriggerCode[]
  hmacKey?: string
}

function verifyShaAndModels(
  obj: Record<string, unknown>,
  expected: VerifyArchStewardReceiptOptions,
  violations: StewardReceiptViolation[],
): string | undefined {
  const headSha = typeof obj.headSha === 'string' ? obj.headSha.trim().toLowerCase() : ''
  const baseSha = typeof obj.baseSha === 'string' ? obj.baseSha.trim().toLowerCase() : ''
  const expectedHead = expected.headSha.trim().toLowerCase()
  const expectedBase = expected.baseSha?.trim().toLowerCase()

  if (!SHA40_RE.test(headSha)) {
    violations.push({
      code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
      message: `receipt.headSha must be a 40-char hex git SHA (got ${JSON.stringify(obj.headSha)})`,
    })
  } else if (headSha !== expectedHead) {
    violations.push({
      code: 'STEWARD-RECEIPT-SHA-MISMATCH',
      message: `stale/mismatched receipt headSha=${headSha} does not match target headSha=${expectedHead} (reusing old SHA receipts is forbidden)`,
    })
  }

  if (!SHA40_RE.test(baseSha)) {
    violations.push({
      code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
      message: `receipt.baseSha must be a 40-char hex git SHA (got ${JSON.stringify(obj.baseSha)})`,
    })
  } else if (expectedBase && baseSha !== expectedBase) {
    violations.push({
      code: 'STEWARD-RECEIPT-BASE-SHA-MISMATCH',
      message: `receipt baseSha=${baseSha} does not match expected baseSha=${expectedBase}`,
    })
  }

  const authorModel = typeof obj.authorModel === 'string' ? obj.authorModel.trim() : ''
  const stewardModel = typeof obj.stewardModel === 'string' ? obj.stewardModel.trim() : ''
  const claimedAuthorFamily = typeof obj.authorFamily === 'string' ? obj.authorFamily.trim() : ''
  const claimedStewardFamily = typeof obj.stewardFamily === 'string' ? obj.stewardFamily.trim() : ''

  if (!authorModel || !stewardModel) {
    violations.push({
      code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
      message: 'receipt requires non-empty `authorModel` and `stewardModel`',
    })
    return undefined
  }

  const cross = verifyCrossFamilyAudit(authorModel, stewardModel)
  for (const v of cross.violations) violations.push({ code: v.code, message: v.message })
  const resolvedAuthor = resolveModelFamily(authorModel)
  const resolvedSteward = resolveModelFamily(stewardModel)
  if (resolvedAuthor && claimedAuthorFamily !== resolvedAuthor) {
    violations.push({
      code: 'STEWARD-FAMILY-CLAIM-MISMATCH',
      message: `claimed authorFamily=${JSON.stringify(claimedAuthorFamily)} does not match resolved family ${JSON.stringify(resolvedAuthor)} for ${JSON.stringify(authorModel)}`,
    })
  }
  if (resolvedSteward && claimedStewardFamily !== resolvedSteward) {
    violations.push({
      code: 'STEWARD-FAMILY-CLAIM-MISMATCH',
      message: `claimed stewardFamily=${JSON.stringify(claimedStewardFamily)} does not match resolved family ${JSON.stringify(resolvedSteward)} for ${JSON.stringify(stewardModel)}`,
    })
  }
  return cross.recommendedAuditModel
}

function verifyDimensionsAndVeto(
  obj: Record<string, unknown>,
  violations: StewardReceiptViolation[],
): void {
  const validDimStatus = new Set<string>(['pass', 'concern', 'veto'])
  const vetoDimensions: string[] = []
  if (!obj.dimensions || typeof obj.dimensions !== 'object' || Array.isArray(obj.dimensions)) {
    violations.push({
      code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
      message: `receipt.dimensions must be an object containing all 4 keys (${STEWARD_DIMENSION_KEYS.join(', ')})`,
    })
  } else {
    const dims = obj.dimensions as Record<string, unknown>
    for (const key of STEWARD_DIMENSION_KEYS) {
      const entry = dims[key]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        violations.push({
          code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
          message: `receipt.dimensions.${key} is missing or not an object`,
        })
        continue
      }
      const d = entry as Record<string, unknown>
      if (typeof d.status !== 'string' || !validDimStatus.has(d.status)) {
        violations.push({
          code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
          message: `receipt.dimensions.${key}.status must be 'pass' | 'concern' | 'veto'`,
        })
      } else if (d.status === 'veto') {
        vetoDimensions.push(key)
      }
      if (typeof d.notes !== 'string' || !d.notes.trim()) {
        violations.push({
          code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
          message: `receipt.dimensions.${key}.notes must be a non-empty string`,
        })
      }
    }
  }

  const verdict = obj.verdict
  const blockers = Array.isArray(obj.blockers) ? obj.blockers : null
  if (blockers === null) {
    violations.push({
      code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
      message: 'receipt.blockers must be an array',
    })
  }

  const overrideAttempted =
    obj.override !== undefined ||
    obj.leaderOverride !== undefined ||
    obj.forceApprove !== undefined ||
    obj.waiver !== undefined ||
    obj.captainOverride !== undefined

  if (verdict !== 'approve' && verdict !== 'veto') {
    violations.push({
      code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
      message: `receipt.verdict must be 'approve' or 'veto' (got ${JSON.stringify(verdict)})`,
    })
  } else if (verdict === 'veto' || (blockers && blockers.length > 0) || vetoDimensions.length > 0) {
    const reasons: string[] = []
    if (verdict === 'veto') reasons.push("verdict='veto'")
    if (blockers && blockers.length > 0) reasons.push(`blockers=${blockers.length}`)
    if (vetoDimensions.length > 0) reasons.push(`vetoDimensions=[${vetoDimensions.join(', ')}]`)
    const overrideNote = overrideAttempted
      ? ' (override/waiver fields in receipt are IGNORED — developer lead cannot unilaterally override an Architecture Steward veto)'
      : ' (non-overridable: fix blockers in a NEW commit and obtain a fresh cross-family approve receipt)'
    violations.push({
      code: 'STEWARD-HARD-VETO',
      message: `Architecture Steward hard veto triggered (${reasons.join(', ')})${overrideNote}`,
    })
  }
}

function verifyEvidenceAndDigest(
  obj: Record<string, unknown>,
  hmacKey: string | undefined,
  violations: StewardReceiptViolation[],
): void {
  if (!obj.usageEvidence || typeof obj.usageEvidence !== 'object' || Array.isArray(obj.usageEvidence)) {
    violations.push({
      code: 'STEWARD-MISSING-USAGE-EVIDENCE',
      message: 'receipt.usageEvidence is required',
    })
  } else {
    const ue = obj.usageEvidence as Record<string, unknown>
    const hasJobOrSession =
      (typeof ue.jobId === 'string' && ue.jobId.trim().length > 0) ||
      (typeof ue.sessionKey === 'string' && ue.sessionKey.trim().length > 0)
    if (!hasJobOrSession) {
      violations.push({
        code: 'STEWARD-MISSING-USAGE-EVIDENCE',
        message: 'receipt.usageEvidence must include non-empty `jobId` or `sessionKey`',
      })
    }
    if (!isValidIsoTimestamp(ue.timestamp)) {
      violations.push({
        code: 'STEWARD-MISSING-USAGE-EVIDENCE',
        message: 'receipt.usageEvidence.timestamp must be a valid ISO-8601 timestamp',
      })
    }
  }

  const receiptDigest = typeof obj.receiptDigest === 'string' ? obj.receiptDigest.trim() : ''
  const digestMatch = DIGEST_RE.exec(receiptDigest)
  if (!digestMatch) {
    violations.push({
      code: 'STEWARD-RECEIPT-DIGEST-MISMATCH',
      message: `receipt.receiptDigest must match 'sha256:<64hex>' or 'hmac-sha256:<64hex>' (got ${JSON.stringify(obj.receiptDigest)})`,
    })
    return
  }
  const algo = digestMatch[1]!
  if (hmacKey && algo !== 'hmac-sha256') {
    violations.push({
      code: 'STEWARD-RECEIPT-DIGEST-MISMATCH',
      message: 'HMAC key is configured; plain sha256 digest downgrade is rejected (hmac-sha256 required)',
    })
  } else if (!hmacKey && algo === 'hmac-sha256') {
    violations.push({
      code: 'STEWARD-RECEIPT-DIGEST-MISMATCH',
      message: `receipt uses hmac-sha256 digest but verifier has no HMAC key configured (${DEFAULT_STEWARD_HMAC_KEY_ENV})`,
    })
  } else {
    const expectedDigest = computeArchStewardReceiptDigest(obj, hmacKey)
    if (!safeEqualStrings(receiptDigest, expectedDigest)) {
      violations.push({
        code: 'STEWARD-RECEIPT-DIGEST-MISMATCH',
        message: 'receiptDigest mismatch — receipt content was tampered with or forged',
      })
    }
  }
}

/**
 * Strictly verify an `ArchStewardReceipt` (fail-closed across SHA binding, cross-family,
 * trigger coverage, 4 dimensions, non-overridable hard veto, usage evidence, and digest).
 */
export function verifyArchStewardReceipt(
  raw: unknown,
  expected: VerifyArchStewardReceiptOptions,
): StewardReceiptVerificationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      violations: [
        { code: 'STEWARD-RECEIPT-SCHEMA-INVALID', message: 'receipt must be a JSON object' },
      ],
    }
  }

  const obj = raw as Record<string, unknown>
  const violations: StewardReceiptViolation[] = []

  if (obj.schemaVersion !== ARCH_STEWARD_RECEIPT_SCHEMA_VERSION) {
    violations.push({
      code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
      message: `invalid schemaVersion=${JSON.stringify(obj.schemaVersion)}; expected ${JSON.stringify(ARCH_STEWARD_RECEIPT_SCHEMA_VERSION)}`,
    })
  }

  const recommendedStewardModel = verifyShaAndModels(obj, expected, violations)

  const validTriggerSet = new Set<string>(STRUCTURAL_RISK_TRIGGER_CODES)
  const triggers = Array.isArray(obj.triggers)
    ? obj.triggers.filter(
        (t): t is StructuralRiskTriggerCode => typeof t === 'string' && validTriggerSet.has(t),
      )
    : []
  if (!Array.isArray(obj.triggers) || triggers.length !== obj.triggers.length || triggers.length === 0) {
    violations.push({
      code: 'STEWARD-RECEIPT-SCHEMA-INVALID',
      message: 'receipt.triggers must be a non-empty array of valid StructuralRiskTriggerCode values',
    })
  } else if (expected.requiredTriggers && expected.requiredTriggers.length > 0) {
    const covered = new Set(triggers)
    const missing = expected.requiredTriggers.filter((t) => !covered.has(t))
    if (missing.length > 0) {
      violations.push({
        code: 'STEWARD-MISSING-TRIGGER-COVERAGE',
        message: `receipt does not cover all triggered structural risks; missing: ${missing.join(', ')}`,
      })
    }
  }

  verifyDimensionsAndVeto(obj, violations)
  verifyEvidenceAndDigest(obj, expected.hmacKey, violations)

  return {
    ok: violations.length === 0,
    receipt: violations.length === 0 ? (obj as unknown as ArchStewardReceipt) : undefined,
    violations,
    recommendedStewardModel: recommendedStewardModel ?? recommendAuditModelFor(null),
  }
}

// ── Receipt Discovery (dir / default paths / commit trailer) ───────────────────

export function extractStewardReceiptTrailer(commitMessage: string): string | null {
  const re = new RegExp(`^${STEWARD_RECEIPT_TRAILER_KEY}:\\s*(.+)$`, 'gim')
  let match: RegExpExecArray | null = null
  let last: string | null = null
  while ((match = re.exec(commitMessage)) !== null) {
    const val = match[1]?.trim()
    if (val) last = val
  }
  return last
}

export function findStewardReceiptForCommit(opts: {
  root: string
  headSha: string
  explicitReceiptPath?: string
  receiptDirs?: readonly string[]
  commitMessage?: string
  env?: Readonly<Record<string, string | undefined>>
}): ReceiptLookupResult {
  const env = opts.env ?? process.env
  const sha = opts.headSha.trim().toLowerCase()
  const searchedLocations: string[] = []

  const tryReadJsonFile = (filePath: string, label: string): ReceiptLookupResult | null => {
    searchedLocations.push(label)
    if (!existsSync(filePath)) return null
    try {
      const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
      return { found: true, source: filePath, raw, searchedLocations }
    } catch (err) {
      return {
        found: true,
        source: filePath,
        error: `failed to parse receipt JSON at ${filePath}: ${(err as Error).message.split('\n')[0]}`,
        searchedLocations,
      }
    }
  }

  if (opts.explicitReceiptPath) {
    const abs = path.resolve(opts.root, opts.explicitReceiptPath)
    const res = tryReadJsonFile(abs, abs)
    return res ?? { found: false, error: `explicit receipt file not found: ${abs}`, searchedLocations }
  }

  for (const dir of opts.receiptDirs ?? []) {
    const candidate = path.join(path.resolve(opts.root, dir), `${sha}.json`)
    const res = tryReadJsonFile(candidate, candidate)
    if (res) return res
  }

  const envDir = env.OC_STEWARD_RECEIPT_DIR?.trim()
  if (envDir) {
    const candidate = path.join(path.resolve(envDir), `${sha}.json`)
    const res = tryReadJsonFile(candidate, candidate)
    if (res) return res
  }

  const repoCandidate = path.join(opts.root, DEFAULT_STEWARD_RECEIPT_REL_DIR, `${sha}.json`)
  const repoRes = tryReadJsonFile(repoCandidate, repoCandidate)
  if (repoRes) return repoRes

  const hostCandidate = path.join(DEFAULT_HOST_STEWARD_RECEIPT_DIR, `${sha}.json`)
  const hostRes = tryReadJsonFile(hostCandidate, hostCandidate)
  if (hostRes) return hostRes

  if (opts.commitMessage) {
    const trailer = extractStewardReceiptTrailer(opts.commitMessage)
    if (trailer) {
      if (trailer.startsWith('base64:')) {
        searchedLocations.push(`commit-trailer:${STEWARD_RECEIPT_TRAILER_KEY}:base64`)
        try {
          const decoded = Buffer.from(trailer.slice('base64:'.length).trim(), 'base64').toString('utf8')
          return {
            found: true,
            source: `commit-trailer:${STEWARD_RECEIPT_TRAILER_KEY}`,
            raw: JSON.parse(decoded) as unknown,
            searchedLocations,
          }
        } catch (err) {
          return {
            found: true,
            source: `commit-trailer:${STEWARD_RECEIPT_TRAILER_KEY}`,
            error: `invalid base64 JSON in ${STEWARD_RECEIPT_TRAILER_KEY} trailer: ${(err as Error).message.split('\n')[0]}`,
            searchedLocations,
          }
        }
      }
      const trailerPath = path.isAbsolute(trailer) ? trailer : path.resolve(opts.root, trailer)
      const trailerRes = tryReadJsonFile(trailerPath, `trailer:${trailerPath}`)
      return (
        trailerRes ?? {
          found: false,
          error: `${STEWARD_RECEIPT_TRAILER_KEY} trailer points to missing file: ${trailerPath}`,
          searchedLocations,
        }
      )
    }
  }

  return { found: false, searchedLocations }
}

// ── Human-readable formatters ──────────────────────────────────────────────────

export function formatStructuralRiskReport(report: StructuralRiskReport): string {
  if (!report.requiresSteward) {
    return `[arch-steward] LOW-RISK FAST PASS: 0/6 structural risk triggers fired (changedFiles=${report.stats.changedFiles}, prodFiles=${report.stats.productionFiles}, netProdLines=${report.stats.netProdLines}, modules=${report.stats.touchedModules.length}).`
  }
  const lines = [
    `[arch-steward] STRUCTURAL RISK TRIGGERED (${report.hits.length} rule(s)): ${report.triggers.join(', ')}`,
  ]
  for (const h of report.hits) {
    lines.push(`  - [${h.code}] ${h.summary}`)
    for (const ev of h.evidence.slice(0, 6)) lines.push(`      • ${ev}`)
    if (h.evidence.length > 6) lines.push(`      • ... and ${h.evidence.length - 6} more`)
  }
  return lines.join('\n')
}

export function formatStewardGateFailure(
  report: StructuralRiskReport,
  headSha: string,
  baseSha: string,
  verification?: StewardReceiptVerificationResult,
  lookup?: ReceiptLookupResult,
): string {
  const lines: string[] = [formatStructuralRiskReport(report)]
  if (lookup && !lookup.found) {
    lines.push(
      `[GATE-ERROR] STEWARD-RECEIPT-MISSING: commit ${headSha.slice(0, 12)} triggered Architecture Steward review (${report.triggers.join(', ')}), but no receipt was found.`,
    )
    if (lookup.error) lines.push(`  Detail  : ${lookup.error}`)
    lines.push(`  Searched: ${lookup.searchedLocations.join(' | ')}`)
  } else if (lookup?.error) {
    lines.push(`[GATE-ERROR] STEWARD-RECEIPT-SCHEMA-INVALID: ${lookup.error}`)
  }
  if (verification) {
    for (const v of verification.violations) lines.push(`[GATE-ERROR] ${v.code}: ${v.message}`)
  }
  lines.push(`  How to Fix: Run cross-family Architecture Steward review for exact commit ${headSha}:`)
  lines.push(
    `    scripts/arch-steward-review.sh --base ${baseSha.slice(0, 12)} --head ${headSha} --author-model <your-model>`,
  )
  lines.push(
    '  Policy    : Steward VETO is non-overridable by the dev lead; resolve blockers in a new commit and obtain a fresh cross-family approve receipt.',
  )
  return lines.join('\n')
}
