/**
 * Shared types, constants, and path classifiers for the Architecture Steward Contract (OCV5-905).
 */
import type { ModelFamily } from './modelFamilyClassifier.js'

export const ARCH_STEWARD_RECEIPT_SCHEMA_VERSION = 'oc.v5.arch-steward-receipt/1' as const
export const ARCH_STEWARD_DRY_RUN_SCHEMA_VERSION = 'oc.v5.arch-steward-dry-run/1' as const
export const DEFAULT_MAX_NET_PROD_LOC = 400
export const DEFAULT_MIN_MULTI_MODULE_SPAN = 2
export const DEFAULT_MAX_FN_LINES = 100
export const DEFAULT_MAX_FN_CC_DIRECT = 20
export const DEFAULT_CLONE_WINDOW_LINES = 12
export const DEFAULT_STEWARD_RECEIPT_REL_DIR = '.github/steward-receipts'
export const DEFAULT_HOST_STEWARD_RECEIPT_DIR = '/opt/openclaude/harness-gate/steward-receipts'
export const STEWARD_RECEIPT_TRAILER_KEY = 'Steward-Receipt'
export const DEFAULT_STEWARD_HMAC_KEY_ENV = 'OC_STEWARD_HMAC_KEY'

export const SHA40_RE = /^[0-9a-f]{40}$/i

export const STRUCTURAL_RISK_TRIGGER_CODES = [
  'APPEND_MAGNET_GROWTH',
  'NET_PROD_LOC_OVER_400',
  'MULTI_MODULE_SPAN',
  'FUNCTION_COMPLEXITY_THRESHOLD',
  'GATE_COUPLING_TOUCHED',
  'CLONE_OR_T2_CORE_PATH',
] as const
export type StructuralRiskTriggerCode = (typeof STRUCTURAL_RISK_TRIGGER_CODES)[number]

export const STEWARD_DIMENSION_KEYS = [
  'godClassAppend',
  'wheelReinvention',
  'boundaryIntegrity',
  'complexityDrift',
] as const
export type StewardDimensionKey = (typeof STEWARD_DIMENSION_KEYS)[number]

export type DimensionAssessmentStatus = 'pass' | 'concern' | 'veto'
export type StewardVerdict = 'approve' | 'veto'

export interface DimensionAssessment {
  status: DimensionAssessmentStatus
  notes: string
}

export type StewardDimensions = Record<StewardDimensionKey, DimensionAssessment>

export interface StewardBlocker {
  dimension: StewardDimensionKey
  severity: 'P0' | 'P1'
  location: string
  reason: string
  remediation?: string
}

export interface StewardUsageEvidence {
  jobId?: string
  sessionKey?: string
  timestamp: string
  provider?: string
  inputTokens?: number
  outputTokens?: number
  command?: string
}

export interface ArchStewardReceipt {
  schemaVersion: typeof ARCH_STEWARD_RECEIPT_SCHEMA_VERSION
  headSha: string
  baseSha: string
  authorModel: string
  authorFamily: ModelFamily
  stewardModel: string
  stewardFamily: ModelFamily
  verdict: StewardVerdict
  triggers: StructuralRiskTriggerCode[]
  dimensions: StewardDimensions
  blockers: StewardBlocker[]
  usageEvidence: StewardUsageEvidence
  receiptDigest: string
  /** Non-production flag — MUST NEVER be true on a production receipt; verifier hard-rejects. */
  dryRun?: boolean
  /** Optional untrusted override fields — NEVER honored; veto/blockers always fail-closed. */
  override?: unknown
  leaderOverride?: unknown
  forceApprove?: unknown
}

export interface ChangedFileStat {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  added: number
  deleted: number
  oldPath?: string
}

export interface ChangedFunctionMetric {
  file: string
  name: string
  lines: number
  ccDirect: number
  startLine?: number
  endLine?: number
}

export interface CloneAlert {
  file: string
  line: number
  matchedFile: string
  matchedLine?: number
  lines: number
  hash?: string
}

export interface GateCouplingDelta {
  gate: string
  path: string
}

export interface DiffSummary {
  baseSha?: string
  headSha?: string
  files: ChangedFileStat[]
  changedFunctions?: ChangedFunctionMetric[]
  cloneAlerts?: CloneAlert[]
  newGateCouplings?: GateCouplingDelta[]
}

export interface AppendMagnetsFile {
  schemaVersion: number
  magnets: Array<{ path: string; [key: string]: unknown }>
}

export interface ModulesFileMinimal {
  schema: number
  modules: Record<string, { layer: string; match: string[]; [key: string]: unknown }>
}

export interface GateCouplingsFileMinimal {
  schema: number
  byGate: Record<string, string[]>
}

export interface EvaluateStructuralRiskOptions {
  root?: string
  appendMagnets?: ReadonlySet<string> | readonly string[]
  modulesDef?: ModulesFileMinimal | null
  gateCouplings?: GateCouplingsFileMinimal | null
  maxNetProdLoc?: number
  minModules?: number
  maxFnLines?: number
  maxFnCcDirect?: number
  t2CorePathPatterns?: readonly RegExp[]
}

export interface StructuralRiskHit {
  code: StructuralRiskTriggerCode
  summary: string
  evidence: string[]
}

export interface StructuralRiskReport {
  requiresSteward: boolean
  triggers: StructuralRiskTriggerCode[]
  hits: StructuralRiskHit[]
  stats: {
    changedFiles: number
    productionFiles: number
    netProdLines: number
    touchedModules: string[]
    appendMagnetsTouched: string[]
    complexFunctions: ChangedFunctionMetric[]
    gateCouplingHits: string[]
    cloneAlertCount: number
    t2CorePathsTouched: string[]
  }
}

export type StewardReceiptViolationCode =
  | 'STEWARD-RECEIPT-MISSING'
  | 'STEWARD-RECEIPT-SCHEMA-INVALID'
  | 'STEWARD-DRY-RUN-REJECTED'
  | 'STEWARD-PLACEHOLDER-EVIDENCE'
  | 'STEWARD-UNTRUSTED-RECEIPT-SOURCE'
  | 'STEWARD-RECEIPT-SHA-MISMATCH'
  | 'STEWARD-RECEIPT-BASE-SHA-MISMATCH'
  | 'STEWARD-FAMILY-CLAIM-MISMATCH'
  | 'CROSS-FAMILY-UNKNOWN-MODEL'
  | 'CROSS-FAMILY-WEAK-AUDIT-MODEL'
  | 'CROSS-FAMILY-SAME-FAMILY-AUDIT'
  | 'STEWARD-MISSING-TRIGGER-COVERAGE'
  | 'STEWARD-MISSING-USAGE-EVIDENCE'
  | 'STEWARD-RECEIPT-DIGEST-MISMATCH'
  | 'STEWARD-HARD-VETO'

export interface StewardReceiptViolation {
  code: StewardReceiptViolationCode
  message: string
}

export interface StewardReceiptVerificationResult {
  ok: boolean
  receipt?: ArchStewardReceipt
  violations: StewardReceiptViolation[]
  recommendedStewardModel?: string
}

export interface ReceiptLookupResult {
  found: boolean
  channel?: 'host-file' | 'explicit-file' | 'github-status' | 'commit-trailer'
  source?: string
  raw?: unknown
  error?: string
  searchedLocations: string[]
}

const TEST_OR_FIXTURE_RE =
  /(^|\/)(?:__tests__|__smoke__|test|tests|browser-tests|fixtures|generated)\/|\.(?:test|spec|node-test)\.(?:ts|tsx|mts|js|jsx|mjs|cjs)$|\.d\.ts$/

const PROD_CODE_EXT_RE = /\.(?:ts|tsx|mts|js|jsx|mjs|cjs|py|sh|go|sql)$/

export const DEFAULT_T2_CORE_PATH_PATTERNS: readonly RegExp[] = [
  /^packages\/gateway\/src\//,
  /^packages\/protocol\/src\//,
  /^packages\/storage\/src\//,
  /^packages\/commercial\/src\/billing\//,
  /^packages\/commercial\/src\/payment\//,
  /^packages\/commercial\/src\/db\/migrations\//,
  /^packages\/commercial\/src\/db\/rollbacks\//,
  /^packages\/commercial\/src\/db\/migrate\.ts$/,
  /^deploy\//,
  /^scripts\/deploy-[^/]+\.sh$/,
  /^scripts\/v5-selfhost-master-release-lib\.sh$/,
  /^scripts\/v5-lease-worker\.sh$/,
  /^scripts\/lib\/v5-selfhost-governance-gates\.sh$/,
]

/** Normalize git/OS paths to repo-relative POSIX form. */
export function normalizeRepoPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

/** True for non-test, non-generated production source/code paths. */
export function isProductionCodePath(rawPath: string): boolean {
  const rel = normalizeRepoPath(rawPath)
  if (!rel || TEST_OR_FIXTURE_RE.test(rel)) return false
  if (rel.startsWith('packages/commercial/agent-sandbox/')) return false
  if (rel.startsWith('docs/') || rel.startsWith('.github/steward-receipts/')) return false
  if (!PROD_CODE_EXT_RE.test(rel)) return false
  return rel.startsWith('packages/') || rel.startsWith('scripts/')
}

/** True when a path hits a T2 high-blast-radius core domain (non-test). */
export function isT2CorePath(
  rawPath: string,
  patterns: readonly RegExp[] = DEFAULT_T2_CORE_PATH_PATTERNS,
): boolean {
  const rel = normalizeRepoPath(rawPath)
  if (!rel || TEST_OR_FIXTURE_RE.test(rel)) return false
  return patterns.some((re) => re.test(rel))
}
