/**
 * contextScorecardStats.ts — Anti-Goodhart statistical primitives and verdict engine
 * for T-Canary context release scorecards (OCV5-885).
 */

export const DEFAULT_MIN_COMPLETED_TURNS = 50
export const DEFAULT_MIN_DISTINCT_SESSIONS = 10
export const DEFAULT_SESSION_WEIGHT_CAP = 0.25
export const DEFAULT_BOOTSTRAP_DRAWS = 1000
export const FLASH_LITE_UPSTREAM_MODEL = 'gemini-3.5-flash-lite'
export const REWRITE_RESEND_TAG = '改写重发'

const Z_95 = 1.959963984540054

export type OutputFormat = 'markdown' | 'json'

export type ComparisonSpec =
  | { kind: 'auto-commit'; lookbackDays: number }
  | { kind: 'commit'; beforeCommit: string; afterCommit: string }
  | {
      kind: 'window'
      beforeStart: string
      beforeEnd: string
      afterStart: string
      afterEnd: string
    }

export interface CliOptions {
  spec: ComparisonSpec
  format: OutputFormat
  envFile: string
  minCompletedTurns: number
  minDistinctSessions: number
  sessionWeightCap: number
  help: boolean
}

export interface ResolvedArmFilter {
  kind: 'commit' | 'window'
  label: string
  commitPrefix?: string
  fullCommit?: string
  windowStart?: string
  windowEnd?: string
}

export interface TurnFactRow {
  dispatchId: string
  sessionId: string
  sessionKey: string
  mode: string
  model: string
  turnIndex: number | null
  outcome: string
  tapeStatus: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costCredits: number
  hasUsageRecord: boolean
  hasUsageError: boolean
  isRewriteResend: boolean
  explicitUp: number
  explicitDown: number
  isWebchat: boolean
}

export interface AntigravityRelayRow {
  dispatchId: string
  sessionId: string
  routeModelId: string
  turnIndex: number | null
  mainCalls: number
  mainPromptTokens: number
  mainCachedTokens: number
  flashLiteCalls: number
  flashLitePromptTokens: number
  flashLiteCachedTokens: number
}

export interface ProtocolTurnRow {
  dispatchId: string
  sessionId: string
  hasRichUi: boolean
  hasInputPrediction: boolean
  optionsBlockCount: number
  optionsValidCount: number
}

export interface CompactionEvalSummary {
  eventCount: number
  distinctSessions: number
  beforeBytesTotal: number
  afterBytesTotal: number
  byteCompressionRatio: number | null
  beforeTokensTotal: number
  afterTokensTotal: number
  tokenCompressionRatio: number | null
  droppedEntriesTotal: number
  postCompactionTurns: number
  postCompactionNonCompletedRate: number | null
  postCompactionRewriteRate: number | null
  byScopeStrategy: Array<{ scope: string; strategy: string; count: number }>
}

export interface PromptDecisionSummary {
  eventCount: number
  eligibleCount: number
  firstTurnExcludedCount: number
  elideOrReuseCount: number
  nonReuseCount: number
  elideOrReuseRate: number | null
  byDecision: Array<{ decision: string; count: number }>
  topChangedSlots: Array<{ slot: string; count: number; share: number }>
}

export interface ContextEvalTelemetry {
  status: 'available' | 'telemetry_pending_0353'
  tableExists: boolean
  compaction: CompactionEvalSummary | null
  promptDecision: PromptDecisionSummary | null
}

export interface ArmDataset {
  filter: ResolvedArmFilter
  turns: TurnFactRow[]
  relayRows: AntigravityRelayRow[]
  protocolTurns: ProtocolTurnRow[]
  contextEval: ContextEvalTelemetry
}

export interface SessionRateSample {
  sessionId: string
  numerator: number
  denominator: number
}

export interface SessionValueSample {
  sessionId: string
  sum: number
  count: number
}

export interface RateMetricStats {
  rawNumerator: number
  rawDenominator: number
  rawRate: number | null
  weightedRate: number | null
  sessionCount: number
  effectiveSampleSize: number
  maxRawSessionShare: number
  maxCappedSessionWeight: number
  wilsonCi95: [number, number] | null
  bootstrapCi95: [number, number] | null
}

export interface ContinuousMetricStats {
  rawSum: number
  turnCount: number
  rawMean: number | null
  weightedMean: number | null
  weightedVariance: number
  sessionCount: number
  maxRawSessionShare: number
  maxCappedSessionWeight: number
  bootstrapCi95: [number, number] | null
}

export interface RateComparison {
  before: RateMetricStats
  after: RateMetricStats
  delta: number | null
  relativeDelta: number | null
  wilsonNonOverlapping: boolean
  zTestPValue: number | null
  bootstrapDeltaCi95: [number, number] | null
  significant: boolean
}

export interface ContinuousComparison {
  before: ContinuousMetricStats
  after: ContinuousMetricStats
  delta: number | null
  relativeDelta: number | null
  bootstrapNonOverlapping: boolean
  welchPValue: number | null
  bootstrapDeltaCi95: [number, number] | null
  significant: boolean
}

export interface GuardrailResult {
  id: string
  scope: string
  label: string
  direction: 'higher_is_better' | 'lower_is_better'
  beforeValue: number | null
  afterValue: number | null
  delta: number | null
  relativeDelta: number | null
  beforeCi95: [number, number] | null
  afterCi95: [number, number] | null
  pValue: number | null
  bootstrapDeltaCi95: [number, number] | null
  thresholdBreached: boolean
  statisticallySignificant: boolean
  status: 'pass' | 'breach' | 'skipped_no_data'
  detail: string
}

export interface ModelStratumSummary {
  mode: string
  model: string
  turnPhase: 'first' | 'resumed' | 'unknown'
  turns: number
  completedTurns: number
  distinctSessions: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  cacheHitRate: number | null
  weightedCacheHitRate: number | null
  avgCostCredits: number | null
  weightedAvgCostCredits: number | null
  errorRate: number | null
}

export interface AntigravityDenoiseSummary {
  routeModelId: string
  turnPhase: 'first' | 'resumed' | 'unknown'
  dispatches: number
  distinctSessions: number
  mainCalls: number
  mainPromptTokens: number
  mainCachedTokens: number
  denoisedCacheHitRate: number | null
  weightedDenoisedCacheHitRate: number | null
  rawCacheHitRate: number | null
  flashLiteCalls: number
  flashLiteCallShare: number | null
  flashLitePromptShare: number | null
}

export interface ArmSummary {
  label: string
  commitPrefix?: string
  fullCommit?: string
  windowStart?: string
  windowEnd?: string
  totalDispatches: number
  completedTurns: number
  distinctSessions: number
  webchatCompletedTurns: number
  crashedDispatches: number
  usageErrorDispatches: number
  rewriteResendCount: number
  explicitUp: number
  explicitDown: number
  modelStrata: ModelStratumSummary[]
  antigravityDenoised: AntigravityDenoiseSummary[]
  contextEval: ContextEvalTelemetry
}

export type VerdictState = 'PASS' | 'INCONCLUSIVE' | 'REJECT'

export interface VerdictOptions {
  minCompletedTurns?: number
  minDistinctSessions?: number
  sessionWeightCap?: number
  bootstrapDraws?: number
  seed?: number
  firstTurnIndex?: 0 | 1
}

export interface ScorecardReport {
  generatedAt: string
  comparisonKind: 'auto-commit' | 'commit' | 'window'
  queryDurationMs: number
  readOnlyVerified: boolean
  verdict: VerdictState
  rollbackRecommended: boolean
  sampleGatePassed: boolean
  inconclusiveReasons: string[]
  thresholds: {
    minCompletedTurns: number
    minDistinctSessions: number
    sessionWeightCap: number
  }
  before: ArmSummary
  after: ArmSummary
  metrics: {
    resumedMainCacheHitRate: RateComparison
    avgCostCreditsPerTurn: ContinuousComparison
    rewriteResendRate: RateComparison
    errorRate: RateComparison
    crashedRate: RateComparison
    usageErrorRate: RateComparison
    uiComponentTriggerRate: RateComparison
    inputPredictionTriggerRate: RateComparison
    optionsTriggerRate: RateComparison
    optionsSchemaValidRate: RateComparison
  }
  guardrails: GuardrailResult[]
  breaches: GuardrailResult[]
  modelGroupGuardrails: GuardrailResult[]
}

// ---------------------------------------------------------------------------
// Statistical Primitives
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function erfc(x: number): number {
  const absX = Math.abs(x)
  const t = 1 / (1 + 0.5 * absX)
  const tau =
    t *
    Math.exp(
      -absX * absX -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    )
  return x >= 0 ? tau : 2 - tau
}

export function normalTwoSidedPValue(z: number): number {
  if (!Number.isFinite(z)) return 0
  return Math.min(1, Math.max(0, erfc(Math.abs(z) / Math.SQRT2)))
}

/**
 * Iterative water-filling session weight cap: guarantees every session weight <= cap
 * (when k * cap > 1) and sum(w_s) === 1.
 */
export function computeCappedSessionWeights(
  sessions: Array<{ sessionId: string; n: number }>,
  cap = DEFAULT_SESSION_WEIGHT_CAP,
): Map<string, number> {
  const valid = sessions.filter((s) => s.n > 0)
  const weights = new Map<string, number>()
  const k = valid.length
  if (k === 0) return weights
  const ns = new Float64Array(k)
  const out = new Float64Array(k)
  const flags = new Uint8Array(k)
  for (let i = 0; i < k; i++) ns[i] = valid[i]!.n
  fillCappedWeightsInPlace(ns, k, cap, out, flags)
  for (let i = 0; i < k; i++) weights.set(valid[i]!.sessionId, out[i]!)
  return weights
}

function fillCappedWeightsInPlace(
  ns: Float64Array,
  k: number,
  cap: number,
  outWeights: Float64Array,
  activeFlags: Uint8Array,
): void {
  if (k === 0) return
  if (cap >= 1) {
    let total = 0
    for (let i = 0; i < k; i++) total += ns[i]!
    for (let i = 0; i < k; i++) outWeights[i] = total > 0 ? ns[i]! / total : 0
    return
  }
  if (k * cap <= 1 + 1e-12) {
    const u = 1 / k
    for (let i = 0; i < k; i++) outWeights[i] = u
    return
  }
  for (let i = 0; i < k; i++) activeFlags[i] = 1
  let remainingBudget = 1
  for (;;) {
    let activeTotal = 0
    for (let i = 0; i < k; i++) {
      if (activeFlags[i]) activeTotal += ns[i]!
    }
    if (activeTotal <= 0) break
    let cappedAny = false
    for (let i = 0; i < k; i++) {
      if (!activeFlags[i]) continue
      const candidate = (remainingBudget * ns[i]!) / activeTotal
      if (candidate > cap + 1e-12) {
        outWeights[i] = cap
        activeFlags[i] = 0
        remainingBudget -= cap
        cappedAny = true
      }
    }
    if (!cappedAny) {
      for (let i = 0; i < k; i++) {
        if (activeFlags[i]) outWeights[i] = (remainingBudget * ns[i]!) / activeTotal
      }
      break
    }
  }
}

export function computeWilsonInterval(p: number, nEff: number, z = Z_95): [number, number] {
  if (nEff <= 0 || !Number.isFinite(p)) return [0, 1]
  const clampedP = Math.min(1, Math.max(0, p))
  const z2 = z * z
  const denom = 1 + z2 / nEff
  const center = (clampedP + z2 / (2 * nEff)) / denom
  const half = (z * Math.sqrt((clampedP * (1 - clampedP) + z2 / (4 * nEff)) / nEff)) / denom
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

export function twoProportionZTest(
  p1: number,
  n1: number,
  p2: number,
  n2: number,
): { z: number; pValue: number } {
  if (n1 <= 0 || n2 <= 0) return { z: 0, pValue: 1 }
  const c1 = Math.min(1, Math.max(0, p1))
  const c2 = Math.min(1, Math.max(0, p2))
  const pooled = (c1 * n1 + c2 * n2) / (n1 + n2)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  if (se <= 1e-12) {
    return Math.abs(c2 - c1) <= 1e-12
      ? { z: 0, pValue: 1 }
      : { z: Math.sign(c2 - c1) * 10, pValue: 0 }
  }
  const z = (c2 - c1) / se
  return { z, pValue: normalTwoSidedPValue(z) }
}

function bootstrapWeightedMeans(
  means: Float64Array,
  counts: Float64Array,
  cap: number,
  drawsCount: number,
  seed: number,
): Float64Array {
  const k = means.length
  const draws = new Float64Array(drawsCount)
  if (k === 0) return draws
  const rng = mulberry32(seed)
  const sMeans = new Float64Array(k)
  const sCounts = new Float64Array(k)
  const weights = new Float64Array(k)
  const flags = new Uint8Array(k)
  for (let d = 0; d < drawsCount; d++) {
    for (let i = 0; i < k; i++) {
      const idx = Math.floor(rng() * k)
      sMeans[i] = means[idx]!
      sCounts[i] = counts[idx]!
    }
    fillCappedWeightsInPlace(sCounts, k, cap, weights, flags)
    let wm = 0
    for (let i = 0; i < k; i++) wm += weights[i]! * sMeans[i]!
    draws[d] = wm
  }
  return draws
}

function percentileTyped(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  const frac = pos - lo
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac
}

function intervalsDisjoint(a: [number, number] | null, b: [number, number] | null): boolean {
  if (!a || !b) return false
  return a[1] < b[0] || b[1] < a[0]
}

export function aggregateSessionRate(
  sessions: SessionRateSample[],
  cap = DEFAULT_SESSION_WEIGHT_CAP,
  bootstrapDraws = DEFAULT_BOOTSTRAP_DRAWS,
  seed = 42,
): RateMetricStats {
  const valid = sessions.filter((s) => s.denominator > 0)
  const k = valid.length
  let rawNumerator = 0
  let rawDenominator = 0
  for (const s of valid) {
    rawNumerator += s.numerator
    rawDenominator += s.denominator
  }
  if (k === 0 || rawDenominator <= 0) {
    return {
      rawNumerator: 0,
      rawDenominator: 0,
      rawRate: null,
      weightedRate: null,
      sessionCount: 0,
      effectiveSampleSize: 0,
      maxRawSessionShare: 0,
      maxCappedSessionWeight: 0,
      wilsonCi95: null,
      bootstrapCi95: null,
    }
  }
  const means = new Float64Array(k)
  const counts = new Float64Array(k)
  const weights = new Float64Array(k)
  const flags = new Uint8Array(k)
  for (let i = 0; i < k; i++) {
    means[i] = valid[i]!.numerator / valid[i]!.denominator
    counts[i] = valid[i]!.denominator
  }
  fillCappedWeightsInPlace(counts, k, cap, weights, flags)
  let weightedRate = 0
  let sumW2OverN = 0
  let maxRawShare = 0
  let maxCappedWeight = 0
  for (let i = 0; i < k; i++) {
    const w = weights[i]!
    const n = counts[i]!
    weightedRate += w * means[i]!
    sumW2OverN += (w * w) / n
    const rawShare = n / rawDenominator
    if (rawShare > maxRawShare) maxRawShare = rawShare
    if (w > maxCappedWeight) maxCappedWeight = w
  }
  const nEff = sumW2OverN > 0 ? Math.min(rawDenominator, 1 / sumW2OverN) : 0
  const draws = bootstrapWeightedMeans(means, counts, cap, bootstrapDraws, seed)
  draws.sort()
  return {
    rawNumerator,
    rawDenominator,
    rawRate: rawNumerator / rawDenominator,
    weightedRate,
    sessionCount: k,
    effectiveSampleSize: nEff,
    maxRawSessionShare: maxRawShare,
    maxCappedSessionWeight: maxCappedWeight,
    wilsonCi95: computeWilsonInterval(weightedRate, nEff),
    bootstrapCi95: [percentileTyped(draws, 0.025), percentileTyped(draws, 0.975)],
  }
}

export function aggregateSessionContinuous(
  sessions: SessionValueSample[],
  cap = DEFAULT_SESSION_WEIGHT_CAP,
  bootstrapDraws = DEFAULT_BOOTSTRAP_DRAWS,
  seed = 137,
): ContinuousMetricStats {
  const valid = sessions.filter((s) => s.count > 0)
  const k = valid.length
  let rawSum = 0
  let turnCount = 0
  for (const s of valid) {
    rawSum += s.sum
    turnCount += s.count
  }
  if (k === 0 || turnCount <= 0) {
    return {
      rawSum: 0,
      turnCount: 0,
      rawMean: null,
      weightedMean: null,
      weightedVariance: 0,
      sessionCount: 0,
      maxRawSessionShare: 0,
      maxCappedSessionWeight: 0,
      bootstrapCi95: null,
    }
  }
  const means = new Float64Array(k)
  const counts = new Float64Array(k)
  const weights = new Float64Array(k)
  const flags = new Uint8Array(k)
  for (let i = 0; i < k; i++) {
    means[i] = valid[i]!.sum / valid[i]!.count
    counts[i] = valid[i]!.count
  }
  fillCappedWeightsInPlace(counts, k, cap, weights, flags)
  let weightedMean = 0
  let maxRawShare = 0
  let maxCappedWeight = 0
  for (let i = 0; i < k; i++) {
    const w = weights[i]!
    weightedMean += w * means[i]!
    const rawShare = counts[i]! / turnCount
    if (rawShare > maxRawShare) maxRawShare = rawShare
    if (w > maxCappedWeight) maxCappedWeight = w
  }
  let weightedVariance = 0
  for (let i = 0; i < k; i++) {
    const diff = means[i]! - weightedMean
    weightedVariance += weights[i]! * diff * diff
  }
  const draws = bootstrapWeightedMeans(means, counts, cap, bootstrapDraws, seed)
  draws.sort()
  return {
    rawSum,
    turnCount,
    rawMean: rawSum / turnCount,
    weightedMean,
    weightedVariance,
    sessionCount: k,
    maxRawSessionShare: maxRawShare,
    maxCappedSessionWeight: maxCappedWeight,
    bootstrapCi95: [percentileTyped(draws, 0.025), percentileTyped(draws, 0.975)],
  }
}

function computeBootstrapDeltaCi95(
  bMeans: Float64Array,
  bCounts: Float64Array,
  aMeans: Float64Array,
  aCounts: Float64Array,
  cap: number,
  drawsCount: number,
  seed: number,
): [number, number] {
  const bDraws = bootstrapWeightedMeans(bMeans, bCounts, cap, drawsCount, seed)
  const aDraws = bootstrapWeightedMeans(aMeans, aCounts, cap, drawsCount, seed + 2)
  const deltaDraws = new Float64Array(drawsCount)
  for (let d = 0; d < drawsCount; d++) deltaDraws[d] = aDraws[d]! - bDraws[d]!
  deltaDraws.sort()
  return [percentileTyped(deltaDraws, 0.025), percentileTyped(deltaDraws, 0.975)]
}

export function compareRateMetric(
  beforeSessions: SessionRateSample[],
  afterSessions: SessionRateSample[],
  opts: { cap?: number; bootstrapDraws?: number; seed?: number } = {},
): RateComparison {
  const cap = opts.cap ?? DEFAULT_SESSION_WEIGHT_CAP
  const drawsCount = opts.bootstrapDraws ?? DEFAULT_BOOTSTRAP_DRAWS
  const seed = opts.seed ?? 42
  const validBefore = beforeSessions.filter((s) => s.denominator > 0)
  const validAfter = afterSessions.filter((s) => s.denominator > 0)
  const before = aggregateSessionRate(validBefore, cap, drawsCount, seed)
  const after = aggregateSessionRate(validAfter, cap, drawsCount, seed + 1)

  if (before.weightedRate === null || after.weightedRate === null) {
    return {
      before,
      after,
      delta: null,
      relativeDelta: null,
      wilsonNonOverlapping: false,
      zTestPValue: null,
      bootstrapDeltaCi95: null,
      significant: false,
    }
  }
  const delta = after.weightedRate - before.weightedRate
  const relativeDelta =
    before.weightedRate > 0 ? delta / before.weightedRate : delta === 0 ? 0 : null
  const wilsonNonOverlapping = intervalsDisjoint(before.wilsonCi95, after.wilsonCi95)
  const { pValue: zTestPValue } = twoProportionZTest(
    before.weightedRate,
    before.effectiveSampleSize,
    after.weightedRate,
    after.effectiveSampleSize,
  )
  const bootstrapDeltaCi95 = computeBootstrapDeltaCi95(
    Float64Array.from(validBefore, (s) => s.numerator / s.denominator),
    Float64Array.from(validBefore, (s) => s.denominator),
    Float64Array.from(validAfter, (s) => s.numerator / s.denominator),
    Float64Array.from(validAfter, (s) => s.denominator),
    cap,
    drawsCount,
    seed + 99,
  )
  const bootstrapExcludesZero = bootstrapDeltaCi95[0] > 1e-12 || bootstrapDeltaCi95[1] < -1e-12
  return {
    before,
    after,
    delta,
    relativeDelta,
    wilsonNonOverlapping,
    zTestPValue,
    bootstrapDeltaCi95,
    significant: (wilsonNonOverlapping || zTestPValue < 0.05) && bootstrapExcludesZero,
  }
}

export function compareContinuousMetric(
  beforeSessions: SessionValueSample[],
  afterSessions: SessionValueSample[],
  opts: { cap?: number; bootstrapDraws?: number; seed?: number } = {},
): ContinuousComparison {
  const cap = opts.cap ?? DEFAULT_SESSION_WEIGHT_CAP
  const drawsCount = opts.bootstrapDraws ?? DEFAULT_BOOTSTRAP_DRAWS
  const seed = opts.seed ?? 137
  const validBefore = beforeSessions.filter((s) => s.count > 0)
  const validAfter = afterSessions.filter((s) => s.count > 0)
  const before = aggregateSessionContinuous(validBefore, cap, drawsCount, seed)
  const after = aggregateSessionContinuous(validAfter, cap, drawsCount, seed + 1)

  if (before.weightedMean === null || after.weightedMean === null) {
    return {
      before,
      after,
      delta: null,
      relativeDelta: null,
      bootstrapNonOverlapping: false,
      welchPValue: null,
      bootstrapDeltaCi95: null,
      significant: false,
    }
  }
  const delta = after.weightedMean - before.weightedMean
  const relativeDelta =
    before.weightedMean > 0 ? delta / before.weightedMean : delta === 0 ? 0 : null
  const bootstrapNonOverlapping = intervalsDisjoint(before.bootstrapCi95, after.bootstrapCi95)
  const se = Math.sqrt(
    before.weightedVariance / Math.max(1, before.sessionCount) +
      after.weightedVariance / Math.max(1, after.sessionCount),
  )
  const welchPValue =
    se <= 1e-12 ? (Math.abs(delta) <= 1e-12 ? 1 : 0) : normalTwoSidedPValue(delta / se)
  const bootstrapDeltaCi95 = computeBootstrapDeltaCi95(
    Float64Array.from(validBefore, (s) => s.sum / s.count),
    Float64Array.from(validBefore, (s) => s.count),
    Float64Array.from(validAfter, (s) => s.sum / s.count),
    Float64Array.from(validAfter, (s) => s.count),
    cap,
    drawsCount,
    seed + 199,
  )
  const bootstrapExcludesZero = bootstrapDeltaCi95[0] > 1e-12 || bootstrapDeltaCi95[1] < -1e-12
  return {
    before,
    after,
    delta,
    relativeDelta,
    bootstrapNonOverlapping,
    welchPValue,
    bootstrapDeltaCi95,
    significant: (bootstrapNonOverlapping || welchPValue < 0.05) && bootstrapExcludesZero,
  }
}

// ---------------------------------------------------------------------------
// Metric Extraction & Verdict Engine
// ---------------------------------------------------------------------------

export function isAntigravityModel(model: string): boolean {
  return model.toLowerCase().startsWith('antigravity-')
}

export function detectFirstTurnIndex(
  turns: Array<{ turnIndex: number | null }>,
  relayRows: Array<{ turnIndex: number | null }> = [],
): 0 | 1 {
  for (const t of turns) if (t.turnIndex === 0) return 0
  for (const r of relayRows) if (r.turnIndex === 0) return 0
  return 1
}

export function turnPhaseOf(
  turnIndex: number | null,
  firstTurnIndex: 0 | 1 = 0,
): 'first' | 'resumed' | 'unknown' {
  if (turnIndex === null || turnIndex === undefined) return 'unknown'
  return turnIndex <= firstTurnIndex ? 'first' : 'resumed'
}

function isCompletedTurn(t: TurnFactRow): boolean {
  return t.outcome === 'completed' || (t.outcome === 'unknown' && t.tapeStatus === 'completed')
}

function isCrashedTurn(t: TurnFactRow): boolean {
  return t.outcome === 'crashed' || t.tapeStatus === 'crashed'
}

function isErrorTurn(t: TurnFactRow): boolean {
  return isCrashedTurn(t) || t.hasUsageError || t.outcome === 'executed_error'
}

function groupSessionRates(
  items: Array<{ sessionId: string; num: number; den: number }>,
): SessionRateSample[] {
  const map = new Map<string, { num: number; den: number }>()
  for (const it of items) {
    if (it.den <= 0) continue
    const cur = map.get(it.sessionId) ?? { num: 0, den: 0 }
    cur.num += it.num
    cur.den += it.den
    map.set(it.sessionId, cur)
  }
  return Array.from(map.entries(), ([sessionId, v]) => ({
    sessionId,
    numerator: v.num,
    denominator: v.den,
  }))
}

function groupSessionValues(
  items: Array<{ sessionId: string; value: number }>,
): SessionValueSample[] {
  const map = new Map<string, { sum: number; count: number }>()
  for (const it of items) {
    const cur = map.get(it.sessionId) ?? { sum: 0, count: 0 }
    cur.sum += it.value
    cur.count += 1
    map.set(it.sessionId, cur)
  }
  return Array.from(map.entries(), ([sessionId, v]) => ({
    sessionId,
    sum: v.sum,
    count: v.count,
  }))
}

export function buildResumedMainCacheSamples(
  turns: TurnFactRow[],
  relayRows: AntigravityRelayRow[],
  filterModel?: (model: string) => boolean,
  firstTurnIndex: 0 | 1 = 0,
): SessionRateSample[] {
  const relayByDispatch = new Map<string, { cached: number; prompt: number; sessionId: string }>()
  for (const r of relayRows) {
    if (filterModel && !filterModel(r.routeModelId)) continue
    const cur = relayByDispatch.get(r.dispatchId) ?? { cached: 0, prompt: 0, sessionId: r.sessionId }
    cur.cached += r.mainCachedTokens
    cur.prompt += r.mainPromptTokens
    relayByDispatch.set(r.dispatchId, cur)
  }
  const perTurn: Array<{ sessionId: string; num: number; den: number }> = []
  const seenRelay = new Set<string>()
  for (const t of turns) {
    if (turnPhaseOf(t.turnIndex, firstTurnIndex) !== 'resumed') continue
    if (filterModel && !filterModel(t.model)) continue
    if (isAntigravityModel(t.model)) {
      const relay = relayByDispatch.get(t.dispatchId)
      if (relay && relay.prompt > 0) {
        seenRelay.add(t.dispatchId)
        perTurn.push({ sessionId: t.sessionId, num: relay.cached / relay.prompt, den: 1 })
        continue
      }
    }
    const totalIn = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens
    if (totalIn > 0) {
      perTurn.push({ sessionId: t.sessionId, num: t.cacheReadTokens / totalIn, den: 1 })
    }
  }
  for (const r of relayRows) {
    if (seenRelay.has(r.dispatchId)) continue
    if (turnPhaseOf(r.turnIndex, firstTurnIndex) !== 'resumed') continue
    if (filterModel && !filterModel(r.routeModelId)) continue
    if (r.mainPromptTokens > 0) {
      perTurn.push({ sessionId: r.sessionId, num: r.mainCachedTokens / r.mainPromptTokens, den: 1 })
    }
  }
  return groupSessionRates(perTurn)
}

function summarizeModelStrata(
  turns: TurnFactRow[],
  cap: number,
  draws: number,
  firstTurnIndex: 0 | 1,
): ModelStratumSummary[] {
  const groups = new Map<string, TurnFactRow[]>()
  for (const t of turns) {
    const key = `${t.mode}\0${t.model}\0${turnPhaseOf(t.turnIndex, firstTurnIndex)}`
    const arr = groups.get(key)
    if (arr) arr.push(t)
    else groups.set(key, [t])
  }
  const out: ModelStratumSummary[] = []
  for (const [key, list] of groups.entries()) {
    const [mode, model, turnPhase] = key.split('\0') as [string, string, 'first' | 'resumed' | 'unknown']
    const sessions = new Set(list.map((t) => t.sessionId))
    let completedTurns = 0
    let inputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let outputTokens = 0
    let costCredits = 0
    let usageTurns = 0
    let errorTurns = 0
    const cacheSamples: Array<{ sessionId: string; num: number; den: number }> = []
    const costSamples: Array<{ sessionId: string; value: number }> = []
    for (const t of list) {
      if (isCompletedTurn(t)) completedTurns++
      if (isErrorTurn(t)) errorTurns++
      inputTokens += t.inputTokens
      cacheReadTokens += t.cacheReadTokens
      cacheWriteTokens += t.cacheWriteTokens
      outputTokens += t.outputTokens
      if (t.hasUsageRecord) {
        usageTurns++
        costCredits += t.costCredits
        costSamples.push({ sessionId: t.sessionId, value: t.costCredits })
      }
      const totalIn = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens
      if (totalIn > 0) cacheSamples.push({ sessionId: t.sessionId, num: t.cacheReadTokens / totalIn, den: 1 })
    }
    const totalInAll = inputTokens + cacheReadTokens + cacheWriteTokens
    const cacheAgg = aggregateSessionRate(groupSessionRates(cacheSamples), cap, Math.min(200, draws))
    const costAgg = aggregateSessionContinuous(groupSessionValues(costSamples), cap, Math.min(200, draws))
    out.push({
      mode,
      model,
      turnPhase,
      turns: list.length,
      completedTurns,
      distinctSessions: sessions.size,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      cacheHitRate: totalInAll > 0 ? cacheReadTokens / totalInAll : null,
      weightedCacheHitRate: cacheAgg.weightedRate,
      avgCostCredits: usageTurns > 0 ? costCredits / usageTurns : null,
      weightedAvgCostCredits: costAgg.weightedMean,
      errorRate: list.length > 0 ? errorTurns / list.length : null,
    })
  }
  return out.sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model))
}

export function summarizeAntigravityDenoised(
  relayRows: AntigravityRelayRow[],
  cap = DEFAULT_SESSION_WEIGHT_CAP,
  draws = 200,
  firstTurnIndex: 0 | 1 = detectFirstTurnIndex([], relayRows),
): AntigravityDenoiseSummary[] {
  const groups = new Map<string, AntigravityRelayRow[]>()
  for (const r of relayRows) {
    const key = `${r.routeModelId}\0${turnPhaseOf(r.turnIndex, firstTurnIndex)}`
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }
  const out: AntigravityDenoiseSummary[] = []
  for (const [key, list] of groups.entries()) {
    const [routeModelId, turnPhase] = key.split('\0') as [string, 'first' | 'resumed' | 'unknown']
    const sessions = new Set(list.map((r) => r.sessionId))
    const dispatches = new Set(list.map((r) => r.dispatchId))
    let mainCalls = 0
    let mainPromptTokens = 0
    let mainCachedTokens = 0
    let flashLiteCalls = 0
    let flashLitePromptTokens = 0
    let flashLiteCachedTokens = 0
    const samples: Array<{ sessionId: string; num: number; den: number }> = []
    for (const r of list) {
      mainCalls += r.mainCalls
      mainPromptTokens += r.mainPromptTokens
      mainCachedTokens += r.mainCachedTokens
      flashLiteCalls += r.flashLiteCalls
      flashLitePromptTokens += r.flashLitePromptTokens
      flashLiteCachedTokens += r.flashLiteCachedTokens
      if (r.mainPromptTokens > 0) {
        samples.push({ sessionId: r.sessionId, num: r.mainCachedTokens / r.mainPromptTokens, den: 1 })
      }
    }
    const totalCalls = mainCalls + flashLiteCalls
    const totalPrompt = mainPromptTokens + flashLitePromptTokens
    const totalCached = mainCachedTokens + flashLiteCachedTokens
    const weighted = aggregateSessionRate(groupSessionRates(samples), cap, draws)
    out.push({
      routeModelId,
      turnPhase,
      dispatches: dispatches.size,
      distinctSessions: sessions.size,
      mainCalls,
      mainPromptTokens,
      mainCachedTokens,
      denoisedCacheHitRate: mainPromptTokens > 0 ? mainCachedTokens / mainPromptTokens : null,
      weightedDenoisedCacheHitRate: weighted.weightedRate,
      rawCacheHitRate: totalPrompt > 0 ? totalCached / totalPrompt : null,
      flashLiteCalls,
      flashLiteCallShare: totalCalls > 0 ? flashLiteCalls / totalCalls : null,
      flashLitePromptShare: totalPrompt > 0 ? flashLitePromptTokens / totalPrompt : null,
    })
  }
  return out.sort((a, b) => b.mainPromptTokens - a.mainPromptTokens)
}

function summarizeArm(arm: ArmDataset, cap: number, draws: number, firstTurnIndex: 0 | 1): ArmSummary {
  const sessions = new Set<string>()
  let completedTurns = 0
  let webchatCompletedTurns = 0
  let crashedDispatches = 0
  let usageErrorDispatches = 0
  let rewriteResendCount = 0
  let explicitUp = 0
  let explicitDown = 0
  for (const t of arm.turns) {
    sessions.add(t.sessionId)
    if (isCompletedTurn(t)) {
      completedTurns++
      if (t.isWebchat) webchatCompletedTurns++
      if (t.isRewriteResend) rewriteResendCount++
    }
    if (isCrashedTurn(t)) crashedDispatches++
    if (t.hasUsageError) usageErrorDispatches++
    explicitUp += t.explicitUp
    explicitDown += t.explicitDown
  }
  return {
    label: arm.filter.label,
    commitPrefix: arm.filter.commitPrefix,
    fullCommit: arm.filter.fullCommit,
    windowStart: arm.filter.windowStart,
    windowEnd: arm.filter.windowEnd,
    totalDispatches: arm.turns.length,
    completedTurns,
    distinctSessions: sessions.size,
    webchatCompletedTurns,
    crashedDispatches,
    usageErrorDispatches,
    rewriteResendCount,
    explicitUp,
    explicitDown,
    modelStrata: summarizeModelStrata(arm.turns, cap, draws, firstTurnIndex),
    antigravityDenoised: summarizeAntigravityDenoised(arm.relayRows, cap, Math.min(200, draws), firstTurnIndex),
    contextEval: arm.contextEval,
  }
}

function buildGuardrail(
  base: {
    id: string
    scope: string
    label: string
    direction: 'higher_is_better' | 'lower_is_better'
    beforeValue: number | null
    afterValue: number | null
    delta: number | null
    relativeDelta: number | null
    beforeCi95: [number, number] | null
    afterCi95: [number, number] | null
    pValue: number | null
    bootstrapDeltaCi95: [number, number] | null
  },
  thresholdBreached: boolean,
  statisticallySignificant: boolean,
  status: 'pass' | 'breach' | 'skipped_no_data',
  detail: string,
): GuardrailResult {
  return { ...base, thresholdBreached, statisticallySignificant, status, detail }
}

function evaluateRateDropGuardrail(args: {
  id: string
  scope: string
  label: string
  comp: RateComparison
  minAbsDrop?: number
  minRelDrop?: number
  minSamplesPerArm?: number
}): GuardrailResult {
  const { id, scope, label, comp, minAbsDrop = 0, minRelDrop = 0, minSamplesPerArm = 1 } = args
  const b = comp.before.weightedRate
  const a = comp.after.weightedRate
  const base = {
    id,
    scope,
    label,
    direction: 'higher_is_better' as const,
    beforeValue: b,
    afterValue: a,
    delta: comp.delta,
    relativeDelta: comp.relativeDelta,
    beforeCi95: comp.before.wilsonCi95,
    afterCi95: comp.after.wilsonCi95,
    pValue: comp.zTestPValue,
    bootstrapDeltaCi95: comp.bootstrapDeltaCi95,
  }
  if (
    b === null ||
    a === null ||
    comp.before.rawDenominator < minSamplesPerArm ||
    comp.after.rawDenominator < minSamplesPerArm
  ) {
    return buildGuardrail(base, false, false, 'skipped_no_data', 'insufficient data for this metric')
  }
  const absDrop = b - a
  const relDrop = b > 0 ? absDrop / b : 0
  const thresholdBreached =
    minRelDrop === 0
      ? absDrop > minAbsDrop + 1e-12
      : relDrop > minRelDrop + 1e-12 && absDrop >= minAbsDrop - 1e-12
  const breach = thresholdBreached && comp.significant
  const detail = breach
    ? `dropped ${(absDrop * 100).toFixed(1)}pp (rel ${(relDrop * 100).toFixed(1)}%), p=${comp.zTestPValue?.toFixed(4)}`
    : thresholdBreached
      ? `crossed threshold (-${(absDrop * 100).toFixed(1)}pp) but NOT statistically significant (p=${comp.zTestPValue?.toFixed(3)})`
      : 'within tolerance'
  return buildGuardrail(base, thresholdBreached, comp.significant, breach ? 'breach' : 'pass', detail)
}

function evaluateRateRiseGuardrail(args: {
  id: string
  scope: string
  label: string
  comp: RateComparison
  minAbsRise: number
  minMultiple: number
}): GuardrailResult {
  const { id, scope, label, comp, minAbsRise, minMultiple } = args
  const b = comp.before.weightedRate
  const a = comp.after.weightedRate
  const base = {
    id,
    scope,
    label,
    direction: 'lower_is_better' as const,
    beforeValue: b,
    afterValue: a,
    delta: comp.delta,
    relativeDelta: comp.relativeDelta,
    beforeCi95: comp.before.wilsonCi95,
    afterCi95: comp.after.wilsonCi95,
    pValue: comp.zTestPValue,
    bootstrapDeltaCi95: comp.bootstrapDeltaCi95,
  }
  if (b === null || a === null) {
    return buildGuardrail(base, false, false, 'skipped_no_data', 'insufficient data for this metric')
  }
  const absRise = a - b
  const multiple = b > 0 ? a / b : a > 0 ? Number.POSITIVE_INFINITY : 1
  const thresholdBreached = absRise > minAbsRise + 1e-12 && multiple >= minMultiple - 1e-12
  const breach = thresholdBreached && comp.significant
  const detail = breach
    ? `rose +${(absRise * 100).toFixed(1)}pp (${Number.isFinite(multiple) ? `${multiple.toFixed(2)}x` : '∞'}), p=${comp.zTestPValue?.toFixed(4)}`
    : thresholdBreached
      ? `crossed threshold (+${(absRise * 100).toFixed(1)}pp) but NOT statistically significant (p=${comp.zTestPValue?.toFixed(3)})`
      : 'within tolerance'
  return buildGuardrail(base, thresholdBreached, comp.significant, breach ? 'breach' : 'pass', detail)
}

function evaluateCostRiseGuardrail(args: {
  id: string
  scope: string
  label: string
  comp: ContinuousComparison
  maxRelRise: number
}): GuardrailResult {
  const { id, scope, label, comp, maxRelRise } = args
  const b = comp.before.weightedMean
  const a = comp.after.weightedMean
  const base = {
    id,
    scope,
    label,
    direction: 'lower_is_better' as const,
    beforeValue: b,
    afterValue: a,
    delta: comp.delta,
    relativeDelta: comp.relativeDelta,
    beforeCi95: comp.before.bootstrapCi95,
    afterCi95: comp.after.bootstrapCi95,
    pValue: comp.welchPValue,
    bootstrapDeltaCi95: comp.bootstrapDeltaCi95,
  }
  if (b === null || a === null || b <= 0) {
    return buildGuardrail(base, false, false, 'skipped_no_data', 'insufficient cost data')
  }
  const relRise = (a - b) / b
  const thresholdBreached = relRise > maxRelRise + 1e-12
  const breach = thresholdBreached && comp.significant
  const detail = breach
    ? `cost rose +${(relRise * 100).toFixed(1)}% (> +${(maxRelRise * 100).toFixed(0)}%), p=${comp.welchPValue?.toFixed(4)}`
    : thresholdBreached
      ? `cost rose +${(relRise * 100).toFixed(1)}% but NOT statistically significant (p=${comp.welchPValue?.toFixed(3)})`
      : 'within tolerance'
  return buildGuardrail(base, thresholdBreached, comp.significant, breach ? 'breach' : 'pass', detail)
}

export function evaluateScorecardVerdict(
  beforeArm: ArmDataset,
  afterArm: ArmDataset,
  options: VerdictOptions & {
    comparisonKind?: 'auto-commit' | 'commit' | 'window'
    queryDurationMs?: number
    readOnlyVerified?: boolean
    now?: Date
  } = {},
): ScorecardReport {
  const minCompletedTurns = options.minCompletedTurns ?? DEFAULT_MIN_COMPLETED_TURNS
  const minDistinctSessions = options.minDistinctSessions ?? DEFAULT_MIN_DISTINCT_SESSIONS
  const cap = options.sessionWeightCap ?? DEFAULT_SESSION_WEIGHT_CAP
  const draws = options.bootstrapDraws ?? DEFAULT_BOOTSTRAP_DRAWS
  const seed = options.seed ?? 42
  const firstTurnIndex: 0 | 1 =
    options.firstTurnIndex ??
    detectFirstTurnIndex(
      [...beforeArm.turns, ...afterArm.turns],
      [...beforeArm.relayRows, ...afterArm.relayRows],
    )

  const beforeSummary = summarizeArm(beforeArm, cap, draws, firstTurnIndex)
  const afterSummary = summarizeArm(afterArm, cap, draws, firstTurnIndex)
  const cmpOpts = { cap, bootstrapDraws: draws, seed }

  const cmpBool = <T extends { sessionId: string }>(
    bList: T[],
    aList: T[],
    pred: (item: T) => boolean,
  ): RateComparison =>
    compareRateMetric(
      groupSessionRates(bList.map((x) => ({ sessionId: x.sessionId, num: pred(x) ? 1 : 0, den: 1 }))),
      groupSessionRates(aList.map((x) => ({ sessionId: x.sessionId, num: pred(x) ? 1 : 0, den: 1 }))),
      cmpOpts,
    )

  const resumedMainCacheHitRate = compareRateMetric(
    buildResumedMainCacheSamples(beforeArm.turns, beforeArm.relayRows, undefined, firstTurnIndex),
    buildResumedMainCacheSamples(afterArm.turns, afterArm.relayRows, undefined, firstTurnIndex),
    cmpOpts,
  )
  const avgCostCreditsPerTurn = compareContinuousMetric(
    groupSessionValues(
      beforeArm.turns.filter((t) => t.hasUsageRecord).map((t) => ({ sessionId: t.sessionId, value: t.costCredits })),
    ),
    groupSessionValues(
      afterArm.turns.filter((t) => t.hasUsageRecord).map((t) => ({ sessionId: t.sessionId, value: t.costCredits })),
    ),
    cmpOpts,
  )
  const rewriteResendRate = cmpBool(
    beforeArm.turns.filter(isCompletedTurn),
    afterArm.turns.filter(isCompletedTurn),
    (t) => t.isRewriteResend,
  )
  const errorRate = cmpBool(beforeArm.turns, afterArm.turns, isErrorTurn)
  const crashedRate = cmpBool(beforeArm.turns, afterArm.turns, isCrashedTurn)
  const usageErrorRate = cmpBool(beforeArm.turns, afterArm.turns, (t) => t.hasUsageError)
  const uiComponentTriggerRate = cmpBool(beforeArm.protocolTurns, afterArm.protocolTurns, (p) => p.hasRichUi)
  const inputPredictionTriggerRate = cmpBool(beforeArm.protocolTurns, afterArm.protocolTurns, (p) => p.hasInputPrediction)
  const optionsTriggerRate = cmpBool(beforeArm.protocolTurns, afterArm.protocolTurns, (p) => p.optionsBlockCount > 0)
  const optionsSchemaValidRate = compareRateMetric(
    groupSessionRates(
      beforeArm.protocolTurns
        .filter((p) => p.optionsBlockCount > 0)
        .map((p) => ({ sessionId: p.sessionId, num: p.optionsValidCount, den: p.optionsBlockCount })),
    ),
    groupSessionRates(
      afterArm.protocolTurns
        .filter((p) => p.optionsBlockCount > 0)
        .map((p) => ({ sessionId: p.sessionId, num: p.optionsValidCount, den: p.optionsBlockCount })),
    ),
    cmpOpts,
  )

  const guardrails: GuardrailResult[] = [
    evaluateRateDropGuardrail({ id: 'resumed_main_cache_hit_rate', scope: 'global', label: '续轮主缓存命中率 (跌 >8pp)', comp: resumedMainCacheHitRate, minAbsDrop: 0.08 }),
    evaluateCostRiseGuardrail({ id: 'avg_cost_credits_per_turn', scope: 'global', label: '单轮均耗 credits (升 >20%)', comp: avgCostCreditsPerTurn, maxRelRise: 0.2 }),
    evaluateRateDropGuardrail({ id: 'ui_component_trigger_rate', scope: 'global', label: '富组件 ```ui 触发率 (相对跌 >40% 且绝对 ≥5pp)', comp: uiComponentTriggerRate, minRelDrop: 0.4, minAbsDrop: 0.05 }),
    evaluateRateDropGuardrail({ id: 'input_prediction_trigger_rate', scope: 'global', label: '输入预测 {"type":"next"} 触发率 (相对跌 >40% 且绝对 ≥5pp)', comp: inputPredictionTriggerRate, minRelDrop: 0.4, minAbsDrop: 0.05 }),
    evaluateRateDropGuardrail({ id: 'options_schema_valid_rate', scope: 'global', label: '```options JSON Schema 合规率 (相对跌 >40% 且绝对 ≥5pp)', comp: optionsSchemaValidRate, minRelDrop: 0.4, minAbsDrop: 0.05, minSamplesPerArm: 5 }),
    evaluateRateRiseGuardrail({ id: 'rewrite_resend_rate', scope: 'global', label: '改写重发率 (升 >5pp 且 ≥1.5x)', comp: rewriteResendRate, minAbsRise: 0.05, minMultiple: 1.5 }),
    evaluateRateRiseGuardrail({ id: 'error_rate', scope: 'global', label: '综合报错/崩溃率 (升 >5pp 且 ≥1.5x)', comp: errorRate, minAbsRise: 0.05, minMultiple: 1.5 }),
  ]

  const modelGroupGuardrails: GuardrailResult[] = []
  const groupKeys = new Set(beforeArm.turns.map((t) => `${t.mode}\0${t.model}`))
  for (const key of groupKeys) {
    const [mode, model] = key.split('\0') as [string, string]
    const bTurns = beforeArm.turns.filter((t) => t.mode === mode && t.model === model)
    const aTurns = afterArm.turns.filter((t) => t.mode === mode && t.model === model)
    if (
      bTurns.filter(isCompletedTurn).length < minCompletedTurns ||
      aTurns.filter(isCompletedTurn).length < minCompletedTurns ||
      new Set(bTurns.map((t) => t.sessionId)).size < minDistinctSessions ||
      new Set(aTurns.map((t) => t.sessionId)).size < minDistinctSessions
    ) {
      continue
    }
    const scope = `${mode}/${model}`
    modelGroupGuardrails.push(
      evaluateRateDropGuardrail({
        id: 'model_resumed_cache_hit_rate',
        scope,
        label: `[${scope}] 续轮主缓存命中率 (跌 >8pp)`,
        comp: compareRateMetric(
          buildResumedMainCacheSamples(bTurns, beforeArm.relayRows, (m) => m === model, firstTurnIndex),
          buildResumedMainCacheSamples(aTurns, afterArm.relayRows, (m) => m === model, firstTurnIndex),
          cmpOpts,
        ),
        minAbsDrop: 0.08,
      }),
      evaluateCostRiseGuardrail({
        id: 'model_avg_cost_credits',
        scope,
        label: `[${scope}] 单轮均耗 credits (升 >20%)`,
        comp: compareContinuousMetric(
          groupSessionValues(bTurns.filter((t) => t.hasUsageRecord).map((t) => ({ sessionId: t.sessionId, value: t.costCredits }))),
          groupSessionValues(aTurns.filter((t) => t.hasUsageRecord).map((t) => ({ sessionId: t.sessionId, value: t.costCredits }))),
          cmpOpts,
        ),
        maxRelRise: 0.2,
      }),
    )
  }

  const inconclusiveReasons: string[] = []
  if (beforeSummary.completedTurns < minCompletedTurns) inconclusiveReasons.push(`before completedTurns=${beforeSummary.completedTurns} < ${minCompletedTurns}`)
  if (beforeSummary.distinctSessions < minDistinctSessions) inconclusiveReasons.push(`before distinctSessions=${beforeSummary.distinctSessions} < ${minDistinctSessions}`)
  if (afterSummary.completedTurns < minCompletedTurns) inconclusiveReasons.push(`after completedTurns=${afterSummary.completedTurns} < ${minCompletedTurns}`)
  if (afterSummary.distinctSessions < minDistinctSessions) inconclusiveReasons.push(`after distinctSessions=${afterSummary.distinctSessions} < ${minDistinctSessions}`)

  const sampleGatePassed = inconclusiveReasons.length === 0
  const allBreaches = [...guardrails, ...modelGroupGuardrails].filter((g) => g.status === 'breach')
  const verdict: VerdictState = !sampleGatePassed ? 'INCONCLUSIVE' : allBreaches.length > 0 ? 'REJECT' : 'PASS'

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    comparisonKind: options.comparisonKind ?? 'commit',
    queryDurationMs: options.queryDurationMs ?? 0,
    readOnlyVerified: options.readOnlyVerified ?? true,
    verdict,
    rollbackRecommended: verdict === 'REJECT',
    sampleGatePassed,
    inconclusiveReasons,
    thresholds: { minCompletedTurns, minDistinctSessions, sessionWeightCap: cap },
    before: beforeSummary,
    after: afterSummary,
    metrics: {
      resumedMainCacheHitRate,
      avgCostCreditsPerTurn,
      rewriteResendRate,
      errorRate,
      crashedRate,
      usageErrorRate,
      uiComponentTriggerRate,
      inputPredictionTriggerRate,
      optionsTriggerRate,
      optionsSchemaValidRate,
    },
    guardrails,
    breaches: sampleGatePassed ? allBreaches : [],
    modelGroupGuardrails,
  }
}
