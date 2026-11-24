/**
 * Schema & deterministic validators for the OCV5-885 sanitized Context Golden Replay Suite
 * (`evals/context-golden/cases.json`, `hygiene-queries.json`, and rolling `--holdout-dir` suites).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export const SAFE_MEMORY_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/
export const SAFE_SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/

export function assertSafeMemoryFilename(file: unknown, context: string): string {
  if (
    typeof file !== 'string' ||
    file.includes('/') ||
    file.includes('\\') ||
    file.includes('..') ||
    file.includes('\0') ||
    !SAFE_MEMORY_FILENAME_RE.test(file)
  ) {
    throw new Error(`PATH_TRAVERSAL_BLOCKED: invalid memory filename in ${context}: ${JSON.stringify(file)}`)
  }
  return file
}

export function assertSafeSkillName(name: unknown, context: string): string {
  if (
    typeof name !== 'string' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('..') ||
    name.includes('\0') ||
    !SAFE_SKILL_NAME_RE.test(name)
  ) {
    throw new Error(`PATH_TRAVERSAL_BLOCKED: invalid skill name in ${context}: ${JSON.stringify(name)}`)
  }
  return name
}

export function resolveContainedPath(baseDir: string, entryName: string, context: string): string {
  if (
    typeof entryName !== 'string' ||
    !entryName ||
    entryName.includes('/') ||
    entryName.includes('\\') ||
    entryName.includes('..') ||
    entryName.includes('\0')
  ) {
    throw new Error(`PATH_TRAVERSAL_BLOCKED: unsafe entry name in ${context}: ${JSON.stringify(entryName)}`)
  }
  const absBase = resolve(baseDir)
  const target = resolve(absBase, entryName)
  if (!target.startsWith(`${absBase}${sep}`)) {
    throw new Error(`PATH_TRAVERSAL_BLOCKED: resolved path escapes base directory in ${context}: ${entryName}`)
  }
  return target
}

export type GoldenBucket = 'A' | 'B' | 'C' | 'D'

export interface ResidentContractRule {
  id: string
  description: string
  /** Every substring or regex (wrapped in `/.../flags`) must appear in the assembled prompt. */
  mustContainAll: string[]
  /** Guard against OCV5-610 style degradation where inline protocol collapses to a bare CLI pointer. */
  mustNotBeBarePointerOnly?: {
    pointer: string
    requiredInlineTokens: string[]
  }
}

export interface BucketACase {
  id: string
  bucket: 'A'
  title: string
  description: string
  tags: string[]
  promptFixture: {
    channel: 'webchat' | 'wechat'
    provider: string
    agentId?: string
    userRole?: 'user' | 'admin'
    iuiComponents?: boolean
    inputPrediction?: boolean
    cacheLayout?: 'static-first' | 'legacy'
  }
  userPrompt: string
  requiredContracts: ResidentContractRule[]
  expectedBehaviorNotes: string
}

export interface GoldenTranscriptMessage {
  role: 'user' | 'assistant' | 'tool' | 'plan' | 'goal'
  text?: string
  toolName?: string
  inputPreview?: string
  output?: string
}

export interface AnchorAssertion {
  id: string
  category: 'ticket' | 'sha' | 'path' | 'branch' | 'threshold' | 'decision'
  /** Exact substring expected to survive in the compacted checkpoint summary. */
  needle: string
  description: string
}

/**
 * Stage 1 Polarity-Bound Triplet Assertion:
 * A negative constraint passes ONLY when at least one single clause contains BOTH
 * a polarity cue (`polarityPatterns`) AND the restricted action/object (`actionPatterns`).
 * If `actionPatterns` appears without a co-occurring polarity cue in the same clause,
 * it is flagged as a hard `POLARITY_INVERSION` failure!
 */
export interface PolarityTripletAssertion {
  id: string
  polarityPatterns: string[]
  actionPatterns: string[]
  sameClauseRequired: true
  description: string
}

export interface Stage2ViolationProbe {
  probePrompt: string
  forbiddenTools: string[]
  forbiddenCommandPatterns: string[]
  expectedRefusalPatterns: string[]
}

export interface BucketBCase {
  id: string
  bucket: 'B'
  title: string
  description: string
  tags: string[]
  instructions?: string
  messages: GoldenTranscriptMessage[]
  anchorAssertions: AnchorAssertion[]
  polarityAssertions: PolarityTripletAssertion[]
  violationProbe: Stage2ViolationProbe
}

export interface BucketCCase {
  id: string
  bucket: 'C'
  title: string
  description: string
  tags: string[]
  kind:
    | 'core_rule_recall'
    | 'l2_merged_proper_noun'
    | 'archive_fallback_recall'
    | 'skill_disambiguation'
  hygieneQueryIds: string[]
  minPassRate: number
}

export interface BucketDTurn {
  turn: number
  label: string
  memoryIndexVariant?: string
  delegateCatalogVariant?: string
  projectInstructionsVariant?: string
  explicitInputChange?: {
    effortLevel?: string
    intelligentUi?: boolean
  }
  compactionReset?: boolean
  expectedPrefixUnchanged?: boolean
  expectedFreezeDecision?: 'fresh_first' | 'reuse' | 'fresh_inputs'
  expectedFreezeReused?: boolean
  expectedElisionDecision?: 'full_inject' | 'elide_resumed'
}

export interface BucketDCase {
  id: string
  bucket: 'D'
  title: string
  description: string
  tags: string[]
  kind:
    | 'static_prefix_stability'
    | 'prompt_freeze_reuse'
    | 'prompt_freeze_invalidate'
    | 'resumed_elision_sequence'
  provider: string
  channel: 'webchat' | 'wechat'
  turns: BucketDTurn[]
}

export type GoldenCase = BucketACase | BucketBCase | BucketCCase | BucketDCase

export interface GoldenSuite {
  schemaVersion: 1
  suiteId: string
  sanitized: true
  description: string
  cases: GoldenCase[]
}

export interface SyntheticMemoryDoc {
  file: string
  content: string
  archiveReason?: string
}

export interface SyntheticSkillEntry {
  name: string
  description: string
  tags: string[]
  related_skills?: string[]
}

export type HygieneQueryKind =
  | 'core_active_recall'
  | 'archive_fallback'
  | 'active_not_shadowed'
  | 'memory_negative_no_match'
  | 'skill_disambiguation'
  | 'skill_negative'

export interface HygieneQuerySpec {
  id: string
  kind: HygieneQueryKind
  query: string
  description: string
  expectedTopFiles?: string[]
  mustNotRank1?: string[]
  expectedArchivedTargets?: string[]
  expectedTopSkills?: string[]
  forbiddenTop1Skills?: string[]
  maxTopSkillScore?: number
}

export interface HygieneQuerySuite {
  schemaVersion: 1
  suiteId: string
  sanitized: true
  activeMemories: SyntheticMemoryDoc[]
  archivedMemories: SyntheticMemoryDoc[]
  skillsCatalog: SyntheticSkillEntry[]
  queries: HygieneQuerySpec[]
}

/** Pattern guard ensuring golden suites never contain real secrets, emails, phones, or public IPs. */
export const SANITIZATION_FORBIDDEN_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'openai_api_key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'github_pat', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private_key_pem', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'email_address', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: 'cn_mobile_phone', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  {
    name: 'public_ipv4',
    pattern:
      /\b(?!(?:127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b)(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/,
  },
]

export function scanForSanitizationLeaks(rawText: string): Array<{ name: string; sample: string }> {
  const leaks: Array<{ name: string; sample: string }> = []
  for (const { name, pattern } of SANITIZATION_FORBIDDEN_PATTERNS) {
    const m = pattern.exec(rawText)
    if (m) {
      leaks.push({ name, sample: m[0].slice(0, 40) })
    }
  }
  return leaks
}

function assertNonEmptyString(val: unknown, field: string): string {
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(`Invalid golden schema: ${field} must be a non-empty string`)
  }
  return val
}

export function validateGoldenCase(raw: unknown, indexLabel: string): GoldenCase {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid golden case at ${indexLabel}: must be an object`)
  }
  const c = raw as Record<string, unknown>
  const id = assertNonEmptyString(c.id, `${indexLabel}.id`)
  const bucket = c.bucket
  assertNonEmptyString(c.title, `${id}.title`)
  assertNonEmptyString(c.description, `${id}.description`)
  if (!Array.isArray(c.tags)) {
    throw new Error(`Invalid golden case ${id}: tags must be an array`)
  }

  if (bucket === 'A') {
    if (!c.promptFixture || typeof c.promptFixture !== 'object') {
      throw new Error(`Invalid Bucket A case ${id}: missing promptFixture`)
    }
    assertNonEmptyString(c.userPrompt, `${id}.userPrompt`)
    if (!Array.isArray(c.requiredContracts) || c.requiredContracts.length === 0) {
      throw new Error(`Invalid Bucket A case ${id}: requiredContracts must be non-empty`)
    }
    return c as unknown as BucketACase
  }

  if (bucket === 'B') {
    if (!Array.isArray(c.messages) || c.messages.length < 16) {
      throw new Error(`Invalid Bucket B case ${id}: messages must have >= 16 turns/rows`)
    }
    if (!Array.isArray(c.anchorAssertions) || c.anchorAssertions.length === 0) {
      throw new Error(`Invalid Bucket B case ${id}: anchorAssertions must be non-empty`)
    }
    if (!Array.isArray(c.polarityAssertions) || c.polarityAssertions.length === 0) {
      throw new Error(`Invalid Bucket B case ${id}: polarityAssertions must be non-empty`)
    }
    for (const p of c.polarityAssertions as Array<Record<string, unknown>>) {
      if (p.sameClauseRequired !== true) {
        throw new Error(`Invalid Bucket B case ${id}: polarity assertion must set sameClauseRequired=true`)
      }
    }
    if (!c.violationProbe || typeof c.violationProbe !== 'object') {
      throw new Error(`Invalid Bucket B case ${id}: missing violationProbe`)
    }
    return c as unknown as BucketBCase
  }

  if (bucket === 'C') {
    if (!Array.isArray(c.hygieneQueryIds) || c.hygieneQueryIds.length === 0) {
      throw new Error(`Invalid Bucket C case ${id}: hygieneQueryIds must be non-empty`)
    }
    return c as unknown as BucketCCase
  }

  if (bucket === 'D') {
    if (!Array.isArray(c.turns) || c.turns.length < 3) {
      throw new Error(`Invalid Bucket D case ${id}: turns must have >= 3 turns`)
    }
    return c as unknown as BucketDCase
  }

  throw new Error(`Invalid golden case ${id}: unknown bucket ${String(bucket)}`)
}

export function loadGoldenSuite(casesPath: string, holdoutDir?: string): GoldenSuite {
  const absCases = resolve(casesPath)
  const rawText = readFileSync(absCases, 'utf8')
  const leaks = scanForSanitizationLeaks(rawText)
  if (leaks.length > 0) {
    throw new Error(`Sanitization check failed for ${absCases}: ${leaks.map((l) => l.name).join(', ')}`)
  }
  const parsed = JSON.parse(rawText) as Record<string, unknown>
  if (parsed.schemaVersion !== 1 || parsed.sanitized !== true || !Array.isArray(parsed.cases)) {
    throw new Error(`Invalid GoldenSuite header in ${absCases}`)
  }

  const cases: GoldenCase[] = []
  const seenIds = new Set<string>()
  const addCase = (item: unknown, label: string): void => {
    const validated = validateGoldenCase(item, label)
    if (seenIds.has(validated.id)) {
      throw new Error(`Duplicate golden case id: ${validated.id}`)
    }
    seenIds.add(validated.id)
    cases.push(validated)
  }

  parsed.cases.forEach((item, idx) => addCase(item, `cases[${idx}]`))

  if (holdoutDir) {
    const absHoldout = resolve(holdoutDir)
    if (!existsSync(absHoldout) || !statSync(absHoldout).isDirectory()) {
      throw new Error(`Holdout directory does not exist or is not a directory: ${absHoldout}`)
    }
    const files = readdirSync(absHoldout)
      .filter((name) => name.endsWith('.json'))
      .sort()
    for (const file of files) {
      const full = join(absHoldout, file)
      const holdoutRaw = readFileSync(full, 'utf8')
      const holdoutLeaks = scanForSanitizationLeaks(holdoutRaw)
      if (holdoutLeaks.length > 0) {
        throw new Error(`Sanitization check failed for holdout ${full}: ${holdoutLeaks.map((l) => l.name).join(', ')}`)
      }
      const holdoutParsed = JSON.parse(holdoutRaw) as Record<string, unknown>
      const holdoutCases = Array.isArray(holdoutParsed)
        ? holdoutParsed
        : Array.isArray(holdoutParsed.cases)
          ? holdoutParsed.cases
          : null
      if (!holdoutCases) {
        throw new Error(`Holdout file ${full} must contain a JSON array or { cases: [...] }`)
      }
      holdoutCases.forEach((item, idx) => addCase(item, `${file}#cases[${idx}]`))
    }
  }

  return {
    schemaVersion: 1,
    suiteId: assertNonEmptyString(parsed.suiteId, 'suiteId'),
    sanitized: true,
    description: assertNonEmptyString(parsed.description, 'description'),
    cases,
  }
}

export function loadHygieneQuerySuite(hygienePath: string): HygieneQuerySuite {
  const absPath = resolve(hygienePath)
  const rawText = readFileSync(absPath, 'utf8')
  const leaks = scanForSanitizationLeaks(rawText)
  if (leaks.length > 0) {
    throw new Error(`Sanitization check failed for ${absPath}: ${leaks.map((l) => l.name).join(', ')}`)
  }
  const parsed = JSON.parse(rawText) as Record<string, unknown>
  if (
    parsed.schemaVersion !== 1 ||
    parsed.sanitized !== true ||
    !Array.isArray(parsed.activeMemories) ||
    !Array.isArray(parsed.archivedMemories) ||
    !Array.isArray(parsed.skillsCatalog) ||
    !Array.isArray(parsed.queries)
  ) {
    throw new Error(`Invalid HygieneQuerySuite in ${absPath}`)
  }
  const suite = parsed as unknown as HygieneQuerySuite
  suite.activeMemories.forEach((doc, i) => {
    assertSafeMemoryFilename(doc?.file, `activeMemories[${i}].file`)
  })
  suite.archivedMemories.forEach((doc, i) => {
    assertSafeMemoryFilename(doc?.file, `archivedMemories[${i}].file`)
  })
  suite.skillsCatalog.forEach((skill, i) => {
    assertSafeSkillName(skill?.name, `skillsCatalog[${i}].name`)
  })
  suite.queries.forEach((q, i) => {
    q.expectedTopFiles?.forEach((f, j) =>
      assertSafeMemoryFilename(f, `queries[${i}].expectedTopFiles[${j}]`),
    )
    q.mustNotRank1?.forEach((f, j) =>
      assertSafeMemoryFilename(f, `queries[${i}].mustNotRank1[${j}]`),
    )
    q.expectedArchivedTargets?.forEach((f, j) =>
      assertSafeMemoryFilename(f, `queries[${i}].expectedArchivedTargets[${j}]`),
    )
    q.expectedTopSkills?.forEach((s, j) =>
      assertSafeSkillName(s, `queries[${i}].expectedTopSkills[${j}]`),
    )
    q.forbiddenTop1Skills?.forEach((s, j) =>
      assertSafeSkillName(s, `queries[${i}].forbiddenTop1Skills[${j}]`),
    )
  })
  return suite
}

/** Split text into clauses for Stage 1 same-clause polarity-bound verification. */
export function splitIntoAssertionClauses(text: string): string[] {
  const clauses: string[] = []
  for (const rawLine of text.split(/\r?\n+/)) {
    const line = rawLine.trim()
    if (!line) continue
    for (const seg of line.split(/(?<=[。！？；!?])|(?<=\.)\s+(?=[A-Z\u4e00-\u9fff])/)) {
      const cleaned = seg.trim()
      if (cleaned) clauses.push(cleaned)
    }
  }
  return clauses
}

export interface PolarityAssertionResult {
  id: string
  passed: boolean
  status: 'PASS' | 'POLARITY_INVERSION' | 'MISSING_CONSTRAINT'
  matchedClause?: string
  invertedClause?: string
  description: string
}

/**
 * Evaluate one Stage 1 polarity-bound triplet against a checkpoint summary.
 * - PASS: at least one clause matches BOTH polarity AND action patterns.
 * - POLARITY_INVERSION: an action pattern appears in some clause WITHOUT a polarity cue in that same clause (hard fail!).
 * - MISSING_CONSTRAINT: neither polarity+action co-occurrence nor bare action appears.
 */
export function evaluatePolarityTriplet(
  summary: string,
  assertion: PolarityTripletAssertion,
): PolarityAssertionResult {
  const polarityRegexes = assertion.polarityPatterns.map((p) => new RegExp(p, 'i'))
  const actionRegexes = assertion.actionPatterns.map((p) => new RegExp(p, 'i'))
  const clauses = splitIntoAssertionClauses(summary)

  let firstInvertedClause: string | undefined
  for (const clause of clauses) {
    const hasAction = actionRegexes.some((re) => re.test(clause))
    if (!hasAction) continue
    const hasPolarity = polarityRegexes.some((re) => re.test(clause))
    if (hasPolarity) {
      return {
        id: assertion.id,
        passed: true,
        status: 'PASS',
        matchedClause: clause,
        description: assertion.description,
      }
    }
    if (!firstInvertedClause) firstInvertedClause = clause
  }

  if (firstInvertedClause) {
    return {
      id: assertion.id,
      passed: false,
      status: 'POLARITY_INVERSION',
      invertedClause: firstInvertedClause,
      description: assertion.description,
    }
  }

  return {
    id: assertion.id,
    passed: false,
    status: 'MISSING_CONSTRAINT',
    description: assertion.description,
  }
}
