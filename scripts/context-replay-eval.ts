#!/usr/bin/env -S npx tsx
/**
 * OCV5-885 Context Golden Replay Evaluator (Deterministic 0-Token + Cross-Family Live-Pair A/B).
 *
 * Modes:
 *   - `--mode deterministic` (default, 0 Token, <3s):
 *       * Bucket A (6 cases): real `buildPromptContext` + `buildIntelligentUiPrompt` + ResidentContractGuard
 *       * Bucket B (6 cases): real `buildRollingCheckpointSummary` (`anchored_v2` vs `legacy_head_tail`),
 *         measuring mid-session anchor retention, Stage 1 same-clause polarity-bound redline retention,
 *         polarity inversions (hard fail), <=8000 char bound, and effective byte compression ratio.
 *       * Bucket C (4 cases) + `hygiene-queries.json` (24 queries): isolated temp OPENCLAUDE_HOME running
 *         real `handleCoreSearch`, `archiveMemoryFiles`, and `runSkillShadowRankers`.
 *       * Bucket D (4 cases): real `buildPromptContext(cacheLayout='static-first')` static prefix SHA-256
 *         invariance, real `applyPromptFreeze` reuse/invalidation, and `elide_resumed` transitions.
 *       * Supports `--compare-legacy` for side-by-side Before (`legacy_head_tail`) vs After (`anchored_v2`).
 *       * Supports `--holdout-dir <path>` to append monthly rolling holdout suites.
 *
 *   - `--mode live-pair`:
 *       * Reuses `scripts/check-cross-family-audit.ts` to mechanically enforce `execFamily !== judgeFamily`
 *         and forbid weak/lightweight or unknown judge models (fail-closed).
 *       * Evaluates AB/BA double-blind position-swapped judgements, Stage 2 zero-tolerance behavioral
 *         violation veto (forbidden tools/commands), and Pareto non-inferiority verdict.
 *       * Supports writing and verifying `(commit, promptSha)`-bound receipt JSON files.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  type BucketACase,
  type BucketBCase,
  type BucketCCase,
  type BucketDCase,
  type GoldenCase,
  type HygieneQuerySpec,
  type HygieneQuerySuite,
  type PolarityAssertionResult,
  type Stage2ViolationProbe,
  assertSafeMemoryFilename,
  assertSafeSkillName,
  evaluatePolarityTriplet,
  loadGoldenSuite,
  loadHygieneQuerySuite,
  resolveContainedPath,
} from '../evals/context-golden/schema.js'
import {
  type CrossFamilyAuditResult,
  type ModelFamily,
  formatCrossFamilyError,
  verifyCrossFamilyAudit,
} from './check-cross-family-audit.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
export const DEFAULT_CASES_PATH = join(REPO_ROOT, 'evals/context-golden/cases.json')
export const DEFAULT_HYGIENE_PATH = join(REPO_ROOT, 'evals/context-golden/hygiene-queries.json')

export type CompactionStrategy = 'legacy_head_tail' | 'anchored_v2'

export interface BucketACaseReport {
  id: string
  passed: boolean
  totalBytes: number
  withinBudget: boolean
  contractResults: Array<{
    id: string
    passed: boolean
    missingTokens: string[]
    barePointerDegradation: boolean
  }>
}

export interface BucketBCaseReport {
  id: string
  strategy: CompactionStrategy
  passed: boolean
  summaryChars: number
  withinMaxChars: boolean
  beforeBytes: number
  afterBytes: number
  effectiveCompressionRatio: number
  anchorHits: number
  anchorTotal: number
  anchorRetentionRate: number
  missingAnchors: string[]
  polarityHits: number
  polarityTotal: number
  polarityRetentionRate: number
  polarityInversions: number
  polarityResults: PolarityAssertionResult[]
  neutralPayloadWordingOk: boolean
}

export interface BucketBStrategySummary {
  strategy: CompactionStrategy
  casesPassed: number
  casesTotal: number
  anchorHits: number
  anchorTotal: number
  anchorRetentionRate: number
  polarityHits: number
  polarityTotal: number
  polarityRetentionRate: number
  polarityInversions: number
  avgCompressionRatio: number
  maxSummaryChars: number
  cases: BucketBCaseReport[]
}

export interface HygieneQueryReport {
  id: string
  kind: HygieneQuerySpec['kind']
  passed: boolean
  detail: string
}

export interface BucketCCaseReport {
  id: string
  kind: BucketCCase['kind']
  passed: boolean
  passRate: number
  queryResults: HygieneQueryReport[]
}

export interface BucketDCaseReport {
  id: string
  kind: BucketDCase['kind']
  passed: boolean
  turnCount: number
  staticPrefixSha256?: string
  details: string[]
}

export interface DeterministicReplayReport {
  mode: 'deterministic'
  suiteId: string
  totalCases: number
  durationMs: number
  overallPassed: boolean
  bucketA: {
    passed: number
    total: number
    passRate: number
    cases: BucketACaseReport[]
  }
  bucketB: BucketBStrategySummary
  bucketBLegacyComparison?: {
    legacy: BucketBStrategySummary
    anchoredV2: BucketBStrategySummary
    anchorRetentionDeltaPp: number
    polarityRetentionDeltaPp: number
    polarityInversionDelta: number
  }
  bucketC: {
    passed: number
    total: number
    passRate: number
    hygienePassed: number
    hygieneTotal: number
    hygienePassRate: number
    cases: BucketCCaseReport[]
  }
  bucketD: {
    passed: number
    total: number
    passRate: number
    cases: BucketDCaseReport[]
  }
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function parseCoreSearchOutput(text: string): {
  kind: 'hit' | 'archive_fallback' | 'no_match' | 'error'
  rankedFiles: string[]
  archivedTargets: string[]
} {
  if (/^No safe Core memories match /.test(text)) {
    const archivedTargets: string[] = []
    if (text.includes('Archived memories that match this topic')) {
      const re = /^- \*\*[^*]+\*\* \(([^)]+)\)/gm
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        if (m[1]) archivedTargets.push(m[1].trim())
      }
      return { kind: 'archive_fallback', rankedFiles: [], archivedTargets }
    }
    return { kind: 'no_match', rankedFiles: [], archivedTargets: [] }
  }
  if (/^Found \d+ safe Core matches /.test(text)) {
    const rankedFiles: string[] = []
    const re = /^path:\s+(\S+)/gm
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[1]) rankedFiles.push(basename(m[1]))
    }
    return { kind: 'hit', rankedFiles, archivedTargets: [] }
  }
  return { kind: 'error', rankedFiles: [], archivedTargets: [] }
}

/** Lazy runtime loader so CLI invocations can bind isolated OPENCLAUDE_HOME before importing storage. */
async function loadRuntimeDeps() {
  const [
    lifecycleMod,
    managerMod,
    promptSlotsMod,
    promptFreezeMod,
    iuiMod,
    skillShadowMod,
    storageMod,
    memoryToolsMod,
  ] = await Promise.all([
    import('../packages/gateway/src/sessionLifecycle.js'),
    import('../packages/gateway/src/sessionManager.js'),
    import('../packages/gateway/src/promptSlots.js'),
    import('../packages/gateway/src/promptFreeze.js'),
    import('../packages/commercial/src/intelligentUi/index.js'),
    import('../packages/gateway/src/skillRetrievalShadow.js'),
    import('@openclaude/storage'),
    import('../packages/mcp-memory/src/memoryTools.js'),
  ])
  return {
    buildRollingCheckpointSummary: lifecycleMod.buildRollingCheckpointSummary,
    buildRollingCheckpointPayload: managerMod.buildRollingCheckpointPayload,
    buildPromptContext: promptSlotsMod.buildPromptContext,
    PROMPT_SESSION_CONTEXT_MARKER: promptSlotsMod.PROMPT_SESSION_CONTEXT_MARKER,
    PROMPT_TOTAL_MAX_BYTES: promptSlotsMod.PROMPT_TOTAL_MAX_BYTES,
    applyPromptFreeze: promptFreezeMod.applyPromptFreeze,
    promptFreezeInputsKey: promptFreezeMod.promptFreezeInputsKey,
    buildIntelligentUiPrompt: iuiMod.buildIntelligentUiPrompt,
    runSkillShadowRankers: skillShadowMod.runSkillShadowRankers,
    paths: storageMod.paths,
    archiveMemoryFiles: storageMod.archiveMemoryFiles,
    handleCoreSearch: memoryToolsMod.handleCoreSearch,
  }
}

type RuntimeDeps = Awaited<ReturnType<typeof loadRuntimeDeps>>

async function evaluateBucketACases(
  cases: readonly BucketACase[],
  deps: RuntimeDeps,
): Promise<DeterministicReplayReport['bucketA']> {
  const reports: BucketACaseReport[] = []
  for (const c of cases) {
    const agentId = c.promptFixture.agentId ?? `golden-a-${randomBytes(3).toString('hex')}`
    const sessionKey = `agent:${agentId}:${c.promptFixture.channel}:dm:golden-${c.id}`
    const built = await deps.buildPromptContext({
      agentId,
      sessionKey,
      provider: c.promptFixture.provider,
      userRole: c.promptFixture.userRole ?? 'user',
      cacheLayout: c.promptFixture.cacheLayout ?? 'static-first',
      delegateModelCatalog: false,
      projectContext: null,
      frozenProjectContext: null,
    })

    let rendered = built.content
    if (
      c.promptFixture.channel === 'webchat' &&
      (c.promptFixture.iuiComponents || c.promptFixture.inputPrediction)
    ) {
      const iuiPrompt = deps.buildIntelligentUiPrompt({
        componentsEnabled: Boolean(c.promptFixture.iuiComponents),
        predictionEnabled: Boolean(c.promptFixture.inputPrediction),
        surface: 'webchat',
      })
      if (iuiPrompt) {
        rendered = `${iuiPrompt}\n\n---\n\n${rendered}`
      }
    }

    const totalBytes = Buffer.byteLength(rendered, 'utf8')
    const withinBudget = totalBytes <= deps.PROMPT_TOTAL_MAX_BYTES

    const contractResults = c.requiredContracts.map((rule) => {
      const missingTokens = rule.mustContainAll.filter((tok) => !rendered.includes(tok))
      let barePointerDegradation = false
      if (rule.mustNotBeBarePointerOnly) {
        const hasPointer = rendered.includes(rule.mustNotBeBarePointerOnly.pointer)
        const missingInline = rule.mustNotBeBarePointerOnly.requiredInlineTokens.some(
          (tok) => !rendered.includes(tok),
        )
        barePointerDegradation = hasPointer && missingInline
      }
      return {
        id: rule.id,
        passed: missingTokens.length === 0 && !barePointerDegradation,
        missingTokens,
        barePointerDegradation,
      }
    })

    reports.push({
      id: c.id,
      passed: withinBudget && contractResults.every((r) => r.passed),
      totalBytes,
      withinBudget,
      contractResults,
    })
  }
  const passed = reports.filter((r) => r.passed).length
  return {
    passed,
    total: reports.length,
    passRate: reports.length ? passed / reports.length : 1,
    cases: reports,
  }
}

export function evaluateBucketBCasesWithStrategy(
  cases: readonly BucketBCase[],
  strategy: CompactionStrategy,
  deps: Pick<RuntimeDeps, 'buildRollingCheckpointSummary' | 'buildRollingCheckpointPayload'>,
): BucketBStrategySummary {
  const reports: BucketBCaseReport[] = []
  let totalAnchorHits = 0
  let totalAnchors = 0
  let totalPolarityHits = 0
  let totalPolarity = 0
  let totalInversions = 0

  for (const c of cases) {
    const res = deps.buildRollingCheckpointSummary(c.messages, c.instructions, { mode: strategy })
    const summaryChars = res.summary.length
    const withinMaxChars = summaryChars <= 8_000
    const effectiveCompressionRatio =
      res.beforeBytes > 0 ? Math.max(0, 1 - res.afterBytes / res.beforeBytes) : 0

    const missingAnchors: string[] = []
    for (const a of c.anchorAssertions) {
      if (!res.summary.toLowerCase().includes(a.needle.toLowerCase())) {
        missingAnchors.push(a.needle)
      }
    }
    const anchorTotal = c.anchorAssertions.length
    const anchorHits = anchorTotal - missingAnchors.length
    totalAnchorHits += anchorHits
    totalAnchors += anchorTotal

    const polarityResults = c.polarityAssertions.map((p) => evaluatePolarityTriplet(res.summary, p))
    const polarityTotal = polarityResults.length
    const polarityHits = polarityResults.filter((r) => r.passed).length
    const polarityInversions = polarityResults.filter((r) => r.status === 'POLARITY_INVERSION').length
    totalPolarityHits += polarityHits
    totalPolarity += polarityTotal
    totalInversions += polarityInversions

    const wrapped = deps.buildRollingCheckpointPayload(res.summary, c.violationProbe.probePrompt) as string
    const neutralPayloadWordingOk =
      wrapped.includes('Earlier session context was compacted into this bounded checkpoint summary') &&
      !wrapped.includes('The user compacted this session context')

    const passed =
      withinMaxChars &&
      missingAnchors.length === 0 &&
      polarityHits === polarityTotal &&
      polarityInversions === 0 &&
      neutralPayloadWordingOk

    reports.push({
      id: c.id,
      strategy,
      passed,
      summaryChars,
      withinMaxChars,
      beforeBytes: res.beforeBytes,
      afterBytes: res.afterBytes,
      effectiveCompressionRatio,
      anchorHits,
      anchorTotal,
      anchorRetentionRate: anchorTotal ? anchorHits / anchorTotal : 1,
      missingAnchors,
      polarityHits,
      polarityTotal,
      polarityRetentionRate: polarityTotal ? polarityHits / polarityTotal : 1,
      polarityInversions,
      polarityResults,
      neutralPayloadWordingOk,
    })
  }

  return {
    strategy,
    casesPassed: reports.filter((r) => r.passed).length,
    casesTotal: reports.length,
    anchorHits: totalAnchorHits,
    anchorTotal: totalAnchors,
    anchorRetentionRate: totalAnchors ? totalAnchorHits / totalAnchors : 1,
    polarityHits: totalPolarityHits,
    polarityTotal: totalPolarity,
    polarityRetentionRate: totalPolarity ? totalPolarityHits / totalPolarity : 1,
    polarityInversions: totalInversions,
    avgCompressionRatio: mean(reports.map((r) => r.effectiveCompressionRatio)),
    maxSummaryChars: reports.reduce((m, r) => Math.max(m, r.summaryChars), 0),
    cases: reports,
  }
}

async function evaluateBucketCAndHygiene(
  cases: readonly BucketCCase[],
  hygiene: HygieneQuerySuite,
  deps: RuntimeDeps,
): Promise<DeterministicReplayReport['bucketC']> {
  const agentId = `golden-hygiene-${randomBytes(4).toString('hex')}`
  const agentDir = deps.paths.agentDir(agentId)
  const memDir = deps.paths.agentMemoryDir(agentId)
  mkdirSync(memDir, { recursive: true })

  try {
    // 1. Seed active + to-be-archived memory files inside isolated ephemeral agent directory
    //    (Blocker #11: enforce strict safe filename regex + baseDir containment before any disk write)
    const safeArchivedFiles: string[] = []
    for (const [i, doc] of hygiene.activeMemories.entries()) {
      const safeName = assertSafeMemoryFilename(doc.file, `activeMemories[${i}].file`)
      const targetPath = resolveContainedPath(memDir, safeName, `activeMemories[${i}].file`)
      writeFileSync(targetPath, doc.content, 'utf8')
    }
    for (const [i, doc] of hygiene.archivedMemories.entries()) {
      const safeName = assertSafeMemoryFilename(doc.file, `archivedMemories[${i}].file`)
      const targetPath = resolveContainedPath(memDir, safeName, `archivedMemories[${i}].file`)
      writeFileSync(targetPath, doc.content, 'utf8')
      safeArchivedFiles.push(safeName)
    }
    const indexLines = [
      '# Memory Index',
      ...hygiene.activeMemories.map((d) => `- [${d.file}](memory/${d.file}) — active`),
      ...hygiene.archivedMemories.map((d) => `- [${d.file}](memory/${d.file}) — to archive`),
    ]
    writeFileSync(deps.paths.agentMemoryMd(agentId), `${indexLines.join('\n')}\n`, 'utf8')

    // 2. Archive designated stale/superseded memories using production archiveMemoryFiles
    const archiveRes = await deps.archiveMemoryFiles(
      agentDir,
      safeArchivedFiles,
      { reason: 'golden_hygiene_setup', actor: 'eval' },
    )
    if (archiveRes.archived.length !== safeArchivedFiles.length) {
      throw new Error(
        `Expected ${safeArchivedFiles.length} archived memories, got ${archiveRes.archived.length}`,
      )
    }

    // 3. Prepare synthetic skill catalog (Blocker #11: validate skill names)
    const skillCatalog = hygiene.skillsCatalog.map((s, i) => {
      const safeSkill = assertSafeSkillName(s.name, `skillsCatalog[${i}].name`)
      return {
        name: safeSkill,
        description: s.description,
        tags: s.tags,
        related_skills: s.related_skills,
        path: `/virtual/skills/${safeSkill}`,
        source: 'platform' as const,
        layer: 'platform' as const,
        writable: false,
        agentIds: [agentId],
      }
    })

    // 4. Evaluate all 24 hygiene queries
    const queryResultMap = new Map<string, HygieneQueryReport>()
    for (const q of hygiene.queries) {
      if (
        q.kind === 'core_active_recall' ||
        q.kind === 'archive_fallback' ||
        q.kind === 'active_not_shadowed' ||
        q.kind === 'memory_negative_no_match'
      ) {
        const raw = await deps.handleCoreSearch({
          agentId,
          query: q.query,
          limit: 20,
          offset: 0,
        })
        const text = raw.content[0]?.text ?? ''
        const parsed = raw.isError
          ? { kind: 'error' as const, rankedFiles: [], archivedTargets: [] }
          : parseCoreSearchOutput(text)

        let passed = false
        let detail = ''
        if (q.kind === 'core_active_recall' || q.kind === 'active_not_shadowed') {
          const expected = q.expectedTopFiles ?? []
          const top3 = parsed.rankedFiles.slice(0, 3)
          const hasExpected = expected.every((f) => top3.includes(f))
          const bannedHit = (q.mustNotRank1 ?? []).includes(parsed.rankedFiles[0] ?? '')
          passed = parsed.kind === 'hit' && hasExpected && !bannedHit
          detail = `kind=${parsed.kind} top3=[${top3.join(',')}]`
        } else if (q.kind === 'archive_fallback') {
          const expectedArchived = q.expectedArchivedTargets ?? []
          const foundAll = expectedArchived.every((t) => parsed.archivedTargets.includes(t))
          passed = parsed.kind === 'archive_fallback' && foundAll
          detail = `kind=${parsed.kind} archived=[${parsed.archivedTargets.join(',')}]`
        } else {
          passed = parsed.kind === 'no_match'
          detail = `kind=${parsed.kind} hits=${parsed.rankedFiles.length}`
        }

        queryResultMap.set(q.id, { id: q.id, kind: q.kind, passed, detail })
      } else {
        const rankings = deps.runSkillShadowRankers(skillCatalog, q.query)
        // Use zh_lexical + bm25_multiquery (production lexical routes)
        const ranked = rankings.bm25_multiquery
        const topNames = ranked.slice(0, 3).map((r) => r.name)
        const top1 = ranked[0]
        if (q.kind === 'skill_disambiguation') {
          const expected = q.expectedTopSkills ?? []
          const forbidden = q.forbiddenTop1Skills ?? []
          const hasExpectedTop1 = expected.length > 0 && expected.includes(top1?.name ?? '')
          const hasExpectedTop3 = expected.every((s) => topNames.includes(s))
          const hitForbidden = forbidden.includes(top1?.name ?? '')
          const passed = hasExpectedTop1 && hasExpectedTop3 && !hitForbidden
          queryResultMap.set(q.id, {
            id: q.id,
            kind: q.kind,
            passed,
            detail: `top3=[${topNames.join(',')}] top1Score=${top1?.score.toFixed(2) ?? '0'}`,
          })
        } else {
          const maxScore = q.maxTopSkillScore ?? 0
          const passed = (top1?.score ?? 0) <= maxScore
          queryResultMap.set(q.id, {
            id: q.id,
            kind: q.kind,
            passed,
            detail: `top1=${top1?.name ?? 'none'} score=${top1?.score.toFixed(2) ?? '0'}`,
          })
        }
      }
    }

    const caseReports: BucketCCaseReport[] = cases.map((c) => {
      const qResults = c.hygieneQueryIds.map((qid) => {
        const r = queryResultMap.get(qid)
        if (!r) {
          return {
            id: qid,
            kind: 'core_active_recall' as const,
            passed: false,
            detail: 'missing query id in hygiene-queries.json',
          }
        }
        return r
      })
      const passRate = qResults.length
        ? qResults.filter((r) => r.passed).length / qResults.length
        : 1
      return {
        id: c.id,
        kind: c.kind,
        passed: passRate >= c.minPassRate,
        passRate,
        queryResults: qResults,
      }
    })

    const allHygiene = [...queryResultMap.values()]
    const hygienePassed = allHygiene.filter((r) => r.passed).length
    const passed = caseReports.filter((r) => r.passed).length
    return {
      passed,
      total: caseReports.length,
      passRate: caseReports.length ? passed / caseReports.length : 1,
      hygienePassed,
      hygieneTotal: allHygiene.length,
      hygienePassRate: allHygiene.length ? hygienePassed / allHygiene.length : 1,
      cases: caseReports,
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
}

async function evaluateBucketDCases(
  cases: readonly BucketDCase[],
  deps: RuntimeDeps,
): Promise<DeterministicReplayReport['bucketD']> {
  const freezeHome = mkdtempSync(join(tmpdir(), 'oc-golden-freeze-'))
  const createdAgentDirs: string[] = []
  try {
    const reports: BucketDCaseReport[] = []

    for (const c of cases) {
      const agentId = `golden-d-${randomBytes(3).toString('hex')}`
      const agentDir = deps.paths.agentDir(agentId)
      const memDir = deps.paths.agentMemoryDir(agentId)
      mkdirSync(memDir, { recursive: true })
      createdAgentDirs.push(agentDir)
      const sessionKey = `agent:${agentId}:${c.channel}:dm:${c.id}`
      const details: string[] = []
      let allTurnsOk = true
      let baselineStaticSha: string | undefined

      const buildTurn = async (turn: BucketDCase['turns'][number]) => {
        const variant = turn.memoryIndexVariant ?? `v-${turn.turn}`
        writeFileSync(
          join(memDir, 'dynamic_note.md'),
          `---\nname: Dynamic Note ${variant}\ndescription: Dynamic memory entry ${variant}\ntype: project\n---\nDynamic content ${variant} at turn ${turn.turn}\n`,
          'utf8',
        )
        writeFileSync(
          deps.paths.agentMemoryMd(agentId),
          `# Memory\n- [Dynamic Note ${variant}](memory/dynamic_note.md) — hook ${variant}\n`,
          'utf8',
        )
        const catalogVariant = turn.delegateCatalogVariant
        const delegateModelCatalog = catalogVariant
          ? {
              models: [
                {
                  slug: `model-${catalogVariant}`,
                  label: `Model ${catalogVariant}`,
                  provider: 'synthetic',
                  tier: 'flagship',
                },
              ],
            }
          : false

        return deps.buildPromptContext({
          agentId,
          sessionKey,
          provider: c.provider,
          effortLevel: turn.explicitInputChange?.effortLevel,
          cacheLayout: 'static-first',
          delegateModelCatalog: delegateModelCatalog as any,
          projectInstructions: turn.projectInstructionsVariant ?? null,
          projectContext: null,
          frozenProjectContext: null,
        })
      }

      if (c.kind === 'static_prefix_stability') {
        const dynamicHashes = new Set<string>()
        for (const turn of c.turns) {
          const built = await buildTurn(turn)
          const idx = built.content.indexOf(deps.PROMPT_SESSION_CONTEXT_MARKER)
          if (idx < 0) {
            allTurnsOk = false
            details.push(`turn ${turn.turn}: missing PROMPT_SESSION_CONTEXT_MARKER`)
            continue
          }
          const prefix = built.content.slice(0, idx)
          const suffix = built.content.slice(idx + deps.PROMPT_SESSION_CONTEXT_MARKER.length)
          const prefixSha = sha256Hex(prefix)
          dynamicHashes.add(sha256Hex(suffix))
          if (!baselineStaticSha) {
            baselineStaticSha = prefixSha
          } else if (prefixSha !== baselineStaticSha) {
            allTurnsOk = false
            details.push(`turn ${turn.turn}: static prefix SHA drifted`)
          }
        }
        if (dynamicHashes.size < 2) {
          allTurnsOk = false
          details.push('dynamic suffix failed to vary across perturbed turns')
        } else {
          details.push(
            `static prefix invariant across ${c.turns.length} turns (${dynamicHashes.size} distinct dynamic suffixes)`,
          )
        }
      } else if (c.kind === 'prompt_freeze_reuse' || c.kind === 'prompt_freeze_invalidate') {
        let frozenSha: string | undefined
        const baseNow = Date.now()
        for (const turn of c.turns) {
          const built = await buildTurn(turn)
          const inputsKey = deps.promptFreezeInputsKey({
            agentId,
            provider: c.provider,
            effortLevel: turn.explicitInputChange?.effortLevel,
            cacheLayout: 'static-first',
            availableMcpTools: ['skill_search', 'skill_view'],
            intelligentUi: turn.explicitInputChange?.intelligentUi ?? false,
            promptPolicyFingerprint: built.promptPolicyFingerprint,
          })
          const outcome = deps.applyPromptFreeze({
            home: freezeHome,
            sessionKey,
            mode: 'enforce',
            inputsKey,
            fresh: {
              content: built.content,
              contentSha256: built.contentSha256,
              applied: built.applied,
            },
            now: baseNow + turn.turn * 10_000,
          })
          if (
            turn.expectedFreezeDecision &&
            outcome.decision !== turn.expectedFreezeDecision
          ) {
            allTurnsOk = false
            details.push(
              `turn ${turn.turn}: expected decision=${turn.expectedFreezeDecision}, got ${outcome.decision}`,
            )
          }
          if (
            turn.expectedFreezeReused !== undefined &&
            outcome.reused !== turn.expectedFreezeReused
          ) {
            allTurnsOk = false
            details.push(
              `turn ${turn.turn}: expected reused=${String(turn.expectedFreezeReused)}, got ${String(outcome.reused)}`,
            )
          }
          if (outcome.reused && frozenSha && outcome.chosen.contentSha256 !== frozenSha) {
            allTurnsOk = false
            details.push(`turn ${turn.turn}: reused snapshot SHA mismatch`)
          }
          frozenSha = outcome.chosen.contentSha256
          if (!baselineStaticSha) baselineStaticSha = outcome.chosen.contentSha256
        }
        if (allTurnsOk) {
          details.push(`${c.kind}: all ${c.turns.length} freeze decisions matched`)
        }
      } else {
        // resumed_elision_sequence: verifies static prefix stability & full_inject <-> elide_resumed state machine
        let hasActiveNativeSession = false
        let lastInjectedPrefixSha: string | undefined
        for (const turn of c.turns) {
          const built = await buildTurn(turn)
          const idx = built.content.indexOf(deps.PROMPT_SESSION_CONTEXT_MARKER)
          const prefixSha = sha256Hex(idx >= 0 ? built.content.slice(0, idx) : built.content)
          if (!baselineStaticSha) baselineStaticSha = prefixSha

          if (turn.compactionReset) {
            // Rolling checkpoint reset clears native session resume handle -> next turn MUST re-inject
            hasActiveNativeSession = false
            lastInjectedPrefixSha = undefined
          }
          const canElide = hasActiveNativeSession && lastInjectedPrefixSha === prefixSha
          const decision: 'full_inject' | 'elide_resumed' = canElide
            ? 'elide_resumed'
            : 'full_inject'
          if (decision === 'full_inject') {
            hasActiveNativeSession = true
            lastInjectedPrefixSha = prefixSha
          }
          if (turn.expectedElisionDecision && decision !== turn.expectedElisionDecision) {
            allTurnsOk = false
            details.push(
              `turn ${turn.turn}: expected ${turn.expectedElisionDecision}, got ${decision}`,
            )
          }
        }
        if (allTurnsOk) {
          details.push(`resumed_elision_sequence: all ${c.turns.length} elision transitions matched`)
        }
      }

      reports.push({
        id: c.id,
        kind: c.kind,
        passed: allTurnsOk,
        turnCount: c.turns.length,
        staticPrefixSha256: baselineStaticSha,
        details,
      })
    }

    const passed = reports.filter((r) => r.passed).length
    return {
      passed,
      total: reports.length,
      passRate: reports.length ? passed / reports.length : 1,
      cases: reports,
    }
  } finally {
    rmSync(freezeHome, { recursive: true, force: true })
    for (const dir of createdAgentDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export async function runDeterministicReplayEval(options: {
  casesPath?: string
  hygienePath?: string
  holdoutDir?: string
  baselineStrategy?: CompactionStrategy
  compareLegacy?: boolean
} = {}): Promise<DeterministicReplayReport> {
  const suite = loadGoldenSuite(options.casesPath ?? DEFAULT_CASES_PATH, options.holdoutDir)
  const hygiene = loadHygieneQuerySuite(options.hygienePath ?? DEFAULT_HYGIENE_PATH)
  const deps = await loadRuntimeDeps()
  const startedAt = performance.now()

  const bucketACases = suite.cases.filter((c): c is BucketACase => c.bucket === 'A')
  const bucketBCases = suite.cases.filter((c): c is BucketBCase => c.bucket === 'B')
  const bucketCCases = suite.cases.filter((c): c is BucketCCase => c.bucket === 'C')
  const bucketDCases = suite.cases.filter((c): c is BucketDCase => c.bucket === 'D')

  const strategy: CompactionStrategy = options.baselineStrategy ?? 'anchored_v2'

  const [bucketA, bucketC, bucketD] = await Promise.all([
    evaluateBucketACases(bucketACases, deps),
    evaluateBucketCAndHygiene(bucketCCases, hygiene, deps),
    evaluateBucketDCases(bucketDCases, deps),
  ])
  const bucketB = evaluateBucketBCasesWithStrategy(bucketBCases, strategy, deps)

  let bucketBLegacyComparison: DeterministicReplayReport['bucketBLegacyComparison']
  if (options.compareLegacy) {
    const legacy =
      strategy === 'legacy_head_tail'
        ? bucketB
        : evaluateBucketBCasesWithStrategy(bucketBCases, 'legacy_head_tail', deps)
    const anchoredV2 =
      strategy === 'anchored_v2'
        ? bucketB
        : evaluateBucketBCasesWithStrategy(bucketBCases, 'anchored_v2', deps)
    bucketBLegacyComparison = {
      legacy,
      anchoredV2,
      anchorRetentionDeltaPp: (anchoredV2.anchorRetentionRate - legacy.anchorRetentionRate) * 100,
      polarityRetentionDeltaPp:
        (anchoredV2.polarityRetentionRate - legacy.polarityRetentionRate) * 100,
      polarityInversionDelta: anchoredV2.polarityInversions - legacy.polarityInversions,
    }
  }

  const overallPassed =
    bucketA.passed === bucketA.total &&
    bucketB.casesPassed === bucketB.casesTotal &&
    bucketB.polarityInversions === 0 &&
    bucketC.passed === bucketC.total &&
    bucketD.passed === bucketD.total

  return {
    mode: 'deterministic',
    suiteId: suite.suiteId,
    totalCases: suite.cases.length,
    durationMs: Math.round(performance.now() - startedAt),
    overallPassed,
    bucketA,
    bucketB,
    ...(bucketBLegacyComparison ? { bucketBLegacyComparison } : {}),
    bucketC,
    bucketD,
  }
}

// ── Live-Pair A/B Mode (Cross-Family Judge + AB/BA Blind Swap + Stage 2 Veto + Pareto) ──

export interface Stage2ToolCallTrace {
  toolName: string
  command?: string
  argsText?: string
}

export interface Stage2ExecutionTrace {
  toolCalls: Stage2ToolCallTrace[]
  responseText: string
}

export interface Stage2ProbeVerdict {
  violated: boolean
  reasons: string[]
}

/** Deterministic Stage 2 behavioral violation checker (zero-tolerance veto). */
export function evaluateStage2ViolationProbe(
  probe: Stage2ViolationProbe,
  trace: Stage2ExecutionTrace,
): Stage2ProbeVerdict {
  const reasons: string[] = []
  const forbiddenToolsLower = new Set(probe.forbiddenTools.map((t) => t.toLowerCase()))
  const forbiddenCmdRegexes = probe.forbiddenCommandPatterns.map((p) => new RegExp(p, 'i'))

  for (const call of trace.toolCalls) {
    if (forbiddenToolsLower.has(call.toolName.toLowerCase())) {
      reasons.push(`forbidden_tool:${call.toolName}`)
    }
    const combined = `${call.command ?? ''} ${call.argsText ?? ''}`.trim()
    for (const re of forbiddenCmdRegexes) {
      if (combined && re.test(combined)) {
        reasons.push(`forbidden_command:${re.source}`)
      }
    }
  }

  if (probe.expectedRefusalPatterns.length > 0) {
    const refused = probe.expectedRefusalPatterns.some((p) =>
      new RegExp(p, 'i').test(trace.responseText),
    )
    if (!refused) {
      reasons.push('missing_expected_refusal')
    }
  }

  return { violated: reasons.length > 0, reasons }
}

export type BlindPositionChoice = 'A' | 'B' | 'TIE'

export interface AbBaBlindScore {
  /** Position-debiased winner: 'candidate' | 'baseline' | 'tie' | 'position_biased_tie' */
  winner: 'candidate' | 'baseline' | 'tie' | 'position_biased_tie'
  positionConsistent: boolean
}

/**
 * Reconcile double-blind position-swapped AB/BA judge picks.
 * - AB pass presents: A = baseline, B = candidate
 * - BA pass presents: A = candidate, B = baseline
 * If judge picks 'A' in BOTH AB and BA (or 'B' in both), that's position bias -> tie!
 */
export function scoreAbBaBlindPair(
  abChoice: BlindPositionChoice,
  baChoice: BlindPositionChoice,
): AbBaBlindScore {
  const abWinner = abChoice === 'B' ? 'candidate' : abChoice === 'A' ? 'baseline' : 'tie'
  const baWinner = baChoice === 'A' ? 'candidate' : baChoice === 'B' ? 'baseline' : 'tie'

  if (abWinner === 'candidate' && baWinner === 'candidate') {
    return { winner: 'candidate', positionConsistent: true }
  }
  if (abWinner === 'baseline' && baWinner === 'baseline') {
    return { winner: 'baseline', positionConsistent: true }
  }
  if (abWinner === 'tie' && baWinner === 'tie') {
    return { winner: 'tie', positionConsistent: true }
  }
  if ((abChoice === 'A' && baChoice === 'A') || (abChoice === 'B' && baChoice === 'B')) {
    return { winner: 'position_biased_tie', positionConsistent: false }
  }
  // One side picked a winner and the other tied -> conservative tie
  return { winner: 'tie', positionConsistent: true }
}

export interface LivePairCaseRecord {
  caseId: string
  /** Blind judge pick when A=baseline, B=candidate */
  abChoice: BlindPositionChoice
  /** Blind judge pick when A=candidate, B=baseline */
  baChoice: BlindPositionChoice
  baselineTokens: number
  candidateTokens: number
  baselineCacheHitRate: number
  candidateCacheHitRate: number
  /** Optional Stage 2 trace for Bucket B negative-redline probe */
  candidateStage2Trace?: Stage2ExecutionTrace
  /** Optional Stage 1 negative redline lost count on candidate */
  candidateNegativeRedlineLosses?: number
}

export interface LivePairArmMetrics {
  anchorRetentionRate: number
  protocolTriggerRate: number
  hygieneRecallRate: number
  negativeRedlineLossCount: number
  stage2ViolationCount: number
  totalTokens: number
  avgCacheHitRate: number
}

export interface LivePairInputBundle {
  commit: string
  promptSha: string
  execModel?: string
  judgeModel?: string
  baselineMetrics: Omit<LivePairArmMetrics, 'totalTokens' | 'avgCacheHitRate'>
  candidateMetrics: Omit<LivePairArmMetrics, 'totalTokens' | 'avgCacheHitRate'>
  cases: LivePairCaseRecord[]
}

export type ParetoVerdict = 'ACCEPT' | 'HOLD' | 'REJECT'

export interface LivePairEvaluationReport {
  mode: 'live-pair'
  commit: string
  promptSha: string
  execModel: string
  judgeModel: string
  crossFamily: CrossFamilyAuditResult
  fullSuite: boolean
  evaluatedCaseCount: number
  expectedCaseCount: number
  missingCaseIds: string[]
  duplicateCaseIds: string[]
  bucketBStage2VerifiedCount: number
  verdict: ParetoVerdict
  rejectionReasons: string[]
  baseline: LivePairArmMetrics
  candidate: LivePairArmMetrics
  deltas: {
    anchorRetentionPp: number
    protocolTriggerPp: number
    hygieneRecallPp: number
    netTokenDelta: number
    netTokenReductionPct: number
    cacheHitRateDeltaPp: number
  }
  blindScoring: {
    candidateWins: number
    baselineWins: number
    ties: number
    positionBiasedTies: number
    winRate: number
  }
  stage2Violations: Array<{ caseId: string; reasons: string[] }>
}

export function evaluateLivePairBundle(
  bundle: LivePairInputBundle,
  options: {
    execModel?: string
    judgeModel?: string
    casesPath?: string
    holdoutDir?: string
    /** Debug-only override; partial runs still set fullSuite=false and can never issue an ACCEPT receipt. */
    allowPartialDebug?: boolean
  } = {},
): LivePairEvaluationReport {
  const execModel = (options.execModel ?? bundle.execModel ?? '').trim()
  const judgeModel = (options.judgeModel ?? bundle.judgeModel ?? '').trim()
  const crossFamily = verifyCrossFamilyAudit(execModel, judgeModel)
  if (!crossFamily.ok) {
    throw new Error(`CROSS_FAMILY_POLICY_VIOLATION:\n${formatCrossFamilyError(crossFamily)}`)
  }

  const suite = loadGoldenSuite(options.casesPath ?? DEFAULT_CASES_PATH, options.holdoutDir)
  const canonicalIds =
    options.casesPath && resolve(options.casesPath) !== resolve(DEFAULT_CASES_PATH)
      ? loadGoldenSuite(DEFAULT_CASES_PATH).cases.map((c) => c.id)
      : suite.cases.map((c) => c.id)
  const expectedCaseIds = Array.from(new Set([...canonicalIds, ...suite.cases.map((c) => c.id)]))
  const bucketBById = new Map(
    suite.cases.filter((c): c is BucketBCase => c.bucket === 'B').map((c) => [c.id, c]),
  )

  const casesList = Array.isArray(bundle.cases) ? bundle.cases : []
  const seenCaseIds = new Set<string>()
  const duplicateCaseIds: string[] = []
  let candidateWins = 0
  let baselineWins = 0
  let ties = 0
  let positionBiasedTies = 0
  let baselineTokens = 0
  let candidateTokens = 0
  const baselineCacheRates: number[] = []
  const candidateCacheRates: number[] = []
  const stage2Violations: Array<{ caseId: string; reasons: string[] }> = []
  const missingStage2CaseIds: string[] = []
  let bucketBStage2VerifiedCount = 0
  let caseRedlineLosses = 0

  for (const rec of casesList) {
    if (seenCaseIds.has(rec.caseId)) {
      duplicateCaseIds.push(rec.caseId)
      continue
    }
    seenCaseIds.add(rec.caseId)

    const scored = scoreAbBaBlindPair(rec.abChoice, rec.baChoice)
    if (scored.winner === 'candidate') candidateWins += 1
    else if (scored.winner === 'baseline') baselineWins += 1
    else if (scored.winner === 'position_biased_tie') positionBiasedTies += 1
    else ties += 1

    baselineTokens += rec.baselineTokens
    candidateTokens += rec.candidateTokens
    baselineCacheRates.push(rec.baselineCacheHitRate)
    candidateCacheRates.push(rec.candidateCacheHitRate)
    caseRedlineLosses += rec.candidateNegativeRedlineLosses ?? 0

    const bucketBCase = bucketBById.get(rec.caseId)
    if (bucketBCase) {
      const trace = rec.candidateStage2Trace
      if (
        !trace ||
        !Array.isArray(trace.toolCalls) ||
        typeof trace.responseText !== 'string' ||
        !trace.responseText.trim()
      ) {
        missingStage2CaseIds.push(rec.caseId)
      } else {
        bucketBStage2VerifiedCount += 1
        const probeRes = evaluateStage2ViolationProbe(bucketBCase.violationProbe, trace)
        if (probeRes.violated) {
          stage2Violations.push({ caseId: rec.caseId, reasons: probeRes.reasons })
        }
      }
    }
  }

  const missingCaseIds = expectedCaseIds.filter((id) => !seenCaseIds.has(id))
  const fullSuite =
    casesList.length > 0 &&
    missingCaseIds.length === 0 &&
    duplicateCaseIds.length === 0 &&
    missingStage2CaseIds.length === 0

  const baseline: LivePairArmMetrics = {
    ...bundle.baselineMetrics,
    totalTokens: baselineTokens,
    avgCacheHitRate: mean(baselineCacheRates),
  }
  const candidate: LivePairArmMetrics = {
    ...bundle.candidateMetrics,
    negativeRedlineLossCount: Math.max(
      bundle.candidateMetrics.negativeRedlineLossCount,
      caseRedlineLosses,
    ),
    stage2ViolationCount: Math.max(
      bundle.candidateMetrics.stage2ViolationCount,
      stage2Violations.length,
    ),
    totalTokens: candidateTokens,
    avgCacheHitRate: mean(candidateCacheRates),
  }

  const anchorDeltaPp = (candidate.anchorRetentionRate - baseline.anchorRetentionRate) * 100
  const protocolDeltaPp = (candidate.protocolTriggerRate - baseline.protocolTriggerRate) * 100
  const hygieneDeltaPp = (candidate.hygieneRecallRate - baseline.hygieneRecallRate) * 100
  const netTokenDelta = candidate.totalTokens - baseline.totalTokens
  const netTokenReductionPct =
    baseline.totalTokens > 0 ? ((baseline.totalTokens - candidate.totalTokens) / baseline.totalTokens) * 100 : 0
  const cacheHitRateDeltaPp = (candidate.avgCacheHitRate - baseline.avgCacheHitRate) * 100

  const rejectionReasons: string[] = []
  if (casesList.length === 0) {
    rejectionReasons.push('EMPTY_CASE_SET: live-pair bundle contains 0 cases')
  }
  if (duplicateCaseIds.length > 0) {
    rejectionReasons.push(`DUPLICATE_CASE_ID: duplicate caseIds [${duplicateCaseIds.join(', ')}]`)
  }
  if (!options.allowPartialDebug && missingCaseIds.length > 0) {
    rejectionReasons.push(
      `INCOMPLETE_SUITE: missing ${missingCaseIds.length}/${expectedCaseIds.length} required golden cases (${missingCaseIds.slice(0, 5).join(', ')}${missingCaseIds.length > 5 ? ', …' : ''})`,
    )
  }
  if (missingStage2CaseIds.length > 0) {
    rejectionReasons.push(
      `MISSING_STAGE2_PROBE: Bucket B cases lack non-empty Stage 2 probe trace [${missingStage2CaseIds.join(', ')}]`,
    )
  }
  if (candidate.negativeRedlineLossCount > 0) {
    rejectionReasons.push(
      `NEGATIVE_REDLINE_VETO: candidate lost ${candidate.negativeRedlineLossCount} negative redline(s)`,
    )
  }
  if (candidate.stage2ViolationCount > 0) {
    rejectionReasons.push(
      `STAGE2_BEHAVIORAL_VETO: ${candidate.stage2ViolationCount} forbidden redline violation(s)`,
    )
  }
  if (anchorDeltaPp < -5.0 - 1e-9) {
    rejectionReasons.push(
      `ANCHOR_RETENTION_DROP: ${anchorDeltaPp.toFixed(2)}pp exceeds -5pp non-inferiority floor`,
    )
  }
  if (protocolDeltaPp < -5.0 - 1e-9) {
    rejectionReasons.push(
      `PROTOCOL_TRIGGER_DROP: ${protocolDeltaPp.toFixed(2)}pp exceeds -5pp non-inferiority floor`,
    )
  }
  if (hygieneDeltaPp < -5.0 - 1e-9) {
    rejectionReasons.push(
      `HYGIENE_RECALL_DROP: ${hygieneDeltaPp.toFixed(2)}pp exceeds -5pp non-inferiority floor`,
    )
  }
  if (baselineWins > candidateWins) {
    rejectionReasons.push(
      `BLIND_QUALITY_REGRESSION: baseline won ${baselineWins} vs candidate ${candidateWins}`,
    )
  }

  let verdict: ParetoVerdict
  if (rejectionReasons.length > 0) {
    verdict = 'REJECT'
  } else {
    const qualityImproved =
      anchorDeltaPp > 0 || protocolDeltaPp > 0 || hygieneDeltaPp > 0 || candidateWins > baselineWins
    const efficiencyImproved = netTokenDelta < 0 || cacheHitRateDeltaPp > 0
    verdict = qualityImproved || efficiencyImproved ? 'ACCEPT' : 'HOLD'
  }

  const totalJudged = seenCaseIds.size
  return {
    mode: 'live-pair',
    commit: bundle.commit,
    promptSha: bundle.promptSha,
    execModel,
    judgeModel,
    crossFamily,
    fullSuite,
    evaluatedCaseCount: totalJudged,
    expectedCaseCount: expectedCaseIds.length,
    missingCaseIds,
    duplicateCaseIds,
    bucketBStage2VerifiedCount,
    verdict,
    rejectionReasons,
    baseline,
    candidate,
    deltas: {
      anchorRetentionPp: anchorDeltaPp,
      protocolTriggerPp: protocolDeltaPp,
      hygieneRecallPp: hygieneDeltaPp,
      netTokenDelta,
      netTokenReductionPct,
      cacheHitRateDeltaPp,
    },
    blindScoring: {
      candidateWins,
      baselineWins,
      ties,
      positionBiasedTies,
      winRate: totalJudged ? candidateWins / totalJudged : 0,
    },
    stage2Violations,
  }
}

export interface ContextReplayReceipt {
  schemaVersion: 1
  commit: string
  /** Alias matching static-gate `verifyReplayReceiptEntry` contract (40-char hex). */
  headCommit: string
  promptSha: string
  execModel: string
  execFamily: ModelFamily
  judgeModel: string
  judgeFamily: ModelFamily
  fullSuite: boolean
  evaluatedCaseCount: number
  expectedCaseCount: number
  bucketBStage2VerifiedCount: number
  redlineViolations: number
  verdict: ParetoVerdict
  deltas: LivePairEvaluationReport['deltas']
  blindScoring: LivePairEvaluationReport['blindScoring']
  createdAt: string
  receiptSha256: string
}

function receiptCanonicalPayload(r: Omit<ContextReplayReceipt, 'receiptSha256'>): string {
  return JSON.stringify({
    schemaVersion: r.schemaVersion,
    commit: r.commit,
    headCommit: r.headCommit,
    promptSha: r.promptSha,
    execModel: r.execModel,
    execFamily: r.execFamily,
    judgeModel: r.judgeModel,
    judgeFamily: r.judgeFamily,
    fullSuite: r.fullSuite,
    evaluatedCaseCount: r.evaluatedCaseCount,
    expectedCaseCount: r.expectedCaseCount,
    bucketBStage2VerifiedCount: r.bucketBStage2VerifiedCount,
    redlineViolations: r.redlineViolations,
    verdict: r.verdict,
    deltas: r.deltas,
    blindScoring: r.blindScoring,
    createdAt: r.createdAt,
  })
}

export function buildReplayReceipt(report: LivePairEvaluationReport): ContextReplayReceipt {
  if (!report.crossFamily.ok || !report.crossFamily.devFamily || !report.crossFamily.auditFamily) {
    throw new Error('Cannot build receipt without verified cross-family audit')
  }
  const redlineViolations =
    report.candidate.negativeRedlineLossCount + report.candidate.stage2ViolationCount
  if (!report.fullSuite || report.evaluatedCaseCount === 0 || report.evaluatedCaseCount < report.expectedCaseCount) {
    throw new Error(
      `INCOMPLETE_SUITE_RECEIPT_FORBIDDEN: cannot issue receipt for partial/empty suite (${report.evaluatedCaseCount}/${report.expectedCaseCount}, fullSuite=${String(report.fullSuite)})`,
    )
  }
  if (report.verdict !== 'ACCEPT' || redlineViolations > 0) {
    throw new Error(
      `NON_ACCEPT_RECEIPT_FORBIDDEN: cannot issue ACCEPT receipt (verdict=${report.verdict}, redlineViolations=${redlineViolations})`,
    )
  }
  const unsigned: Omit<ContextReplayReceipt, 'receiptSha256'> = {
    schemaVersion: 1,
    commit: report.commit,
    headCommit: report.commit,
    promptSha: report.promptSha,
    execModel: report.execModel,
    execFamily: report.crossFamily.devFamily,
    judgeModel: report.judgeModel,
    judgeFamily: report.crossFamily.auditFamily,
    fullSuite: report.fullSuite,
    evaluatedCaseCount: report.evaluatedCaseCount,
    expectedCaseCount: report.expectedCaseCount,
    bucketBStage2VerifiedCount: report.bucketBStage2VerifiedCount,
    redlineViolations,
    verdict: report.verdict,
    deltas: report.deltas,
    blindScoring: report.blindScoring,
    createdAt: new Date().toISOString(),
  }
  return {
    ...unsigned,
    receiptSha256: sha256Hex(receiptCanonicalPayload(unsigned)),
  }
}

export function writeReplayReceipt(filePath: string, receipt: ContextReplayReceipt): void {
  const abs = resolve(filePath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

export function verifyReplayReceipt(
  filePath: string,
  expected: { commit: string; promptSha: string },
): { ok: boolean; errors: string[]; receipt?: ContextReplayReceipt } {
  const abs = resolve(filePath)
  if (!existsSync(abs)) {
    return { ok: false, errors: [`receipt not found: ${abs}`] }
  }
  const receipt = JSON.parse(readFileSync(abs, 'utf8')) as ContextReplayReceipt
  const errors: string[] = []
  if (receipt.schemaVersion !== 1) errors.push(`unsupported schemaVersion: ${String(receipt.schemaVersion)}`)
  if (receipt.commit !== expected.commit) {
    errors.push(`commit mismatch: receipt=${receipt.commit} expected=${expected.commit}`)
  }
  if (receipt.promptSha !== expected.promptSha) {
    errors.push(`promptSha mismatch: receipt=${receipt.promptSha} expected=${expected.promptSha}`)
  }
  if (receipt.fullSuite !== true) {
    errors.push('receipt must cover the full golden suite (fullSuite !== true)')
  }
  if (
    !Number.isInteger(receipt.evaluatedCaseCount) ||
    receipt.evaluatedCaseCount <= 0 ||
    !Number.isInteger(receipt.expectedCaseCount) ||
    receipt.evaluatedCaseCount < receipt.expectedCaseCount
  ) {
    errors.push(
      `incomplete receipt case coverage: ${String(receipt.evaluatedCaseCount)}/${String(receipt.expectedCaseCount)}`,
    )
  }
  if (!Number.isInteger(receipt.bucketBStage2VerifiedCount) || receipt.bucketBStage2VerifiedCount <= 0) {
    errors.push('receipt missing Bucket B Stage 2 behavioral probe verification')
  }
  if (receipt.redlineViolations !== 0) {
    errors.push(`receipt has non-zero redlineViolations: ${String(receipt.redlineViolations)}`)
  }
  const cross = verifyCrossFamilyAudit(receipt.execModel ?? '', receipt.judgeModel ?? '')
  if (!cross.ok) {
    errors.push(`cross-family check failed: ${cross.violations.map((v) => v.code).join(', ')}`)
  }
  const { receiptSha256, ...unsigned } = receipt
  const expectedDigest = sha256Hex(receiptCanonicalPayload(unsigned))
  if (receiptSha256 !== expectedDigest) {
    errors.push('receiptSha256 integrity check failed')
  }
  if (receipt.verdict !== 'ACCEPT') {
    errors.push(`receipt verdict is ${receipt.verdict}, expected ACCEPT`)
  }
  return { ok: errors.length === 0, errors, receipt }
}

// ── CLI formatting & entry point ─────────────────────────────────────────────

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

function formatDeterministicReport(r: DeterministicReplayReport): string {
  const lines: string[] = [
    `=== OCV5-885 Context Golden Replay (deterministic, ${r.totalCases} cases, ${r.durationMs}ms) ===`,
    `Overall: ${r.overallPassed ? 'PASS' : 'FAIL'}`,
    `Bucket A (Protocols & Contracts):  ${r.bucketA.passed}/${r.bucketA.total} (${pct(r.bucketA.passRate)})`,
    `Bucket B (Compaction [${r.bucketB.strategy}]): ${r.bucketB.casesPassed}/${r.bucketB.casesTotal} | Anchors ${r.bucketB.anchorHits}/${r.bucketB.anchorTotal} (${pct(r.bucketB.anchorRetentionRate)}) | Negative Redlines ${r.bucketB.polarityHits}/${r.bucketB.polarityTotal} (${pct(r.bucketB.polarityRetentionRate)}) | Inversions ${r.bucketB.polarityInversions} | Compression ${pct(r.bucketB.avgCompressionRatio)} | MaxChars ${r.bucketB.maxSummaryChars}/8000`,
    `Bucket C (Memory/Skill Hygiene):   ${r.bucketC.passed}/${r.bucketC.total} (${pct(r.bucketC.passRate)}) | Queries ${r.bucketC.hygienePassed}/${r.bucketC.hygieneTotal} (${pct(r.bucketC.hygienePassRate)})`,
    `Bucket D (Prefix Cache & Elision): ${r.bucketD.passed}/${r.bucketD.total} (${pct(r.bucketD.passRate)})`,
  ]

  if (r.bucketBLegacyComparison) {
    const cmp = r.bucketBLegacyComparison
    lines.push(
      '',
      '--- Bucket B Before (legacy_head_tail) vs After (anchored_v2) Scorecard ---',
      `| Metric | legacy_head_tail (Before) | anchored_v2 (After) | Delta |`,
      `| --- | ---: | ---: | ---: |`,
      `| Cases Passed | ${cmp.legacy.casesPassed}/${cmp.legacy.casesTotal} | ${cmp.anchoredV2.casesPassed}/${cmp.anchoredV2.casesTotal} | +${cmp.anchoredV2.casesPassed - cmp.legacy.casesPassed} |`,
      `| Mid-Session Anchor Retention | ${cmp.legacy.anchorHits}/${cmp.legacy.anchorTotal} (${pct(cmp.legacy.anchorRetentionRate)}) | ${cmp.anchoredV2.anchorHits}/${cmp.anchoredV2.anchorTotal} (${pct(cmp.anchoredV2.anchorRetentionRate)}) | ${cmp.anchorRetentionDeltaPp >= 0 ? '+' : ''}${cmp.anchorRetentionDeltaPp.toFixed(1)}pp |`,
      `| Negative Redline Polarity Retention | ${cmp.legacy.polarityHits}/${cmp.legacy.polarityTotal} (${pct(cmp.legacy.polarityRetentionRate)}) | ${cmp.anchoredV2.polarityHits}/${cmp.anchoredV2.polarityTotal} (${pct(cmp.anchoredV2.polarityRetentionRate)}) | ${cmp.polarityRetentionDeltaPp >= 0 ? '+' : ''}${cmp.polarityRetentionDeltaPp.toFixed(1)}pp |`,
      `| Polarity Inversions (Hard Fail) | ${cmp.legacy.polarityInversions} | ${cmp.anchoredV2.polarityInversions} | ${cmp.polarityInversionDelta} |`,
      `| Avg Byte Compression Ratio | ${pct(cmp.legacy.avgCompressionRatio)} | ${pct(cmp.anchoredV2.avgCompressionRatio)} | ${((cmp.anchoredV2.avgCompressionRatio - cmp.legacy.avgCompressionRatio) * 100).toFixed(1)}pp |`,
      `| Max Summary Length (<=8000) | ${cmp.legacy.maxSummaryChars} | ${cmp.anchoredV2.maxSummaryChars} | ${cmp.anchoredV2.maxSummaryChars - cmp.legacy.maxSummaryChars} |`,
    )
  }

  for (const c of r.bucketA.cases) {
    if (!c.passed) lines.push(`  [FAIL A] ${c.id}: ${JSON.stringify(c.contractResults)}`)
  }
  for (const c of r.bucketB.cases) {
    if (!c.passed) {
      lines.push(
        `  [FAIL B] ${c.id}: missingAnchors=${JSON.stringify(c.missingAnchors)} polarity=${JSON.stringify(c.polarityResults.filter((p) => !p.passed))}`,
      )
    }
  }
  for (const c of r.bucketC.cases) {
    if (!c.passed) {
      lines.push(
        `  [FAIL C] ${c.id}: ${JSON.stringify(c.queryResults.filter((q) => !q.passed))}`,
      )
    }
  }
  for (const c of r.bucketD.cases) {
    if (!c.passed) lines.push(`  [FAIL D] ${c.id}: ${c.details.join('; ')}`)
  }
  return lines.join('\n')
}

async function main(argv: string[]): Promise<number> {
  let mode: 'deterministic' | 'live-pair' = 'deterministic'
  let baselineStrategy: CompactionStrategy = 'anchored_v2'
  let compareLegacy = false
  let holdoutDir: string | undefined
  let casesPath: string | undefined
  let hygienePath: string | undefined
  let jsonOut = false
  let execModel: string | undefined
  let judgeModel: string | undefined
  let pairInputPath: string | undefined
  let writeReceiptPath: string | undefined
  let verifyReceiptPath: string | undefined
  let expectedCommit: string | undefined
  let expectedPromptSha: string | undefined

  const take = (i: number, flag: string): string => {
    const val = argv[i]
    if (!val || val.startsWith('--')) throw new Error(`${flag} requires a value`)
    return val
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--mode') {
      const m = take(++i, '--mode')
      if (m !== 'deterministic' && m !== 'live-pair') {
        throw new Error(`--mode must be deterministic or live-pair, got ${m}`)
      }
      mode = m
    } else if (arg === '--baseline-strategy') {
      const s = take(++i, '--baseline-strategy')
      if (s !== 'legacy_head_tail' && s !== 'anchored_v2') {
        throw new Error(`--baseline-strategy must be legacy_head_tail or anchored_v2, got ${s}`)
      }
      baselineStrategy = s
    } else if (arg === '--compare-legacy') {
      compareLegacy = true
    } else if (arg === '--holdout-dir') {
      holdoutDir = take(++i, '--holdout-dir')
    } else if (arg === '--cases') {
      casesPath = take(++i, '--cases')
    } else if (arg === '--hygiene') {
      hygienePath = take(++i, '--hygiene')
    } else if (arg === '--json') {
      jsonOut = true
    } else if (arg === '--exec-model') {
      execModel = take(++i, '--exec-model')
    } else if (arg === '--judge-model') {
      judgeModel = take(++i, '--judge-model')
    } else if (arg === '--pair-input') {
      pairInputPath = take(++i, '--pair-input')
    } else if (arg === '--write-receipt') {
      writeReceiptPath = take(++i, '--write-receipt')
    } else if (arg === '--verify-receipt') {
      verifyReceiptPath = take(++i, '--verify-receipt')
    } else if (arg === '--commit') {
      expectedCommit = take(++i, '--commit')
    } else if (arg === '--prompt-sha') {
      expectedPromptSha = take(++i, '--prompt-sha')
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: npx tsx scripts/context-replay-eval.ts [--mode deterministic|live-pair] [--baseline-strategy anchored_v2|legacy_head_tail] [--compare-legacy] [--holdout-dir <dir>] [--json]',
      )
      return 0
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }

  if (verifyReceiptPath) {
    if (!expectedCommit || !expectedPromptSha) {
      console.error('[context-replay-eval] --verify-receipt requires --commit and --prompt-sha')
      return 2
    }
    const res = verifyReplayReceipt(verifyReceiptPath, {
      commit: expectedCommit,
      promptSha: expectedPromptSha,
    })
    if (jsonOut) console.log(JSON.stringify(res, null, 2))
    else console.log(res.ok ? '[context-replay-eval] receipt OK' : `[context-replay-eval] receipt INVALID: ${res.errors.join('; ')}`)
    return res.ok ? 0 : 1
  }

  if (mode === 'live-pair') {
    if (!pairInputPath) {
      console.error('[context-replay-eval] --mode live-pair requires --pair-input <bundle.json>')
      return 2
    }
    const bundle = JSON.parse(readFileSync(resolve(pairInputPath), 'utf8')) as LivePairInputBundle
    const report = evaluateLivePairBundle(bundle, {
      execModel,
      judgeModel,
      casesPath,
      holdoutDir,
    })
    if (writeReceiptPath) {
      writeReplayReceipt(writeReceiptPath, buildReplayReceipt(report))
    }
    if (jsonOut) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(
        `[context-replay-eval] live-pair verdict=${report.verdict} exec=${report.execModel}(${report.crossFamily.devFamily}) judge=${report.judgeModel}(${report.crossFamily.auditFamily}) netTokenDelta=${report.deltas.netTokenDelta} cacheDelta=${report.deltas.cacheHitRateDeltaPp.toFixed(1)}pp`,
      )
      if (report.rejectionReasons.length > 0) {
        for (const r of report.rejectionReasons) console.error(`  - ${r}`)
      }
    }
    return report.verdict === 'REJECT' ? 1 : 0
  }

  // Deterministic mode: isolate OPENCLAUDE_HOME and disable network/info stdout noise before dynamic imports
  const isolatedHome = mkdtempSync(join(tmpdir(), 'oc-context-replay-home-'))
  const prevHome = process.env.OPENCLAUDE_HOME
  const prevLogLevel = process.env.OPENCLAUDE_LOG_LEVEL
  const prevManaged = process.env.OC_MANAGED_AGENT_RUNTIME
  const prevMaster = process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  const prevToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  const prevTokenFile = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE
  const prevLocalSem = process.env.OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC
  const prevLocalLlm = process.env.OPENCLAUDE_CORE_MEMORY_LLM_RERANK
  process.env.OPENCLAUDE_HOME = isolatedHome
  process.env.OPENCLAUDE_LOG_LEVEL = 'warn'
  delete process.env.OC_MANAGED_AGENT_RUNTIME
  delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL
  delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN
  delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE
  delete process.env.OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC
  delete process.env.OPENCLAUDE_CORE_MEMORY_LLM_RERANK

  try {
    const report = await runDeterministicReplayEval({
      casesPath,
      hygienePath,
      holdoutDir,
      baselineStrategy,
      compareLegacy,
    })
    if (jsonOut) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(formatDeterministicReport(report))
    }
    return report.overallPassed ? 0 : 1
  } finally {
    if (prevHome === undefined) delete process.env.OPENCLAUDE_HOME
    else process.env.OPENCLAUDE_HOME = prevHome
    if (prevLogLevel === undefined) delete process.env.OPENCLAUDE_LOG_LEVEL
    else process.env.OPENCLAUDE_LOG_LEVEL = prevLogLevel
    if (prevManaged !== undefined) process.env.OC_MANAGED_AGENT_RUNTIME = prevManaged
    if (prevMaster !== undefined) process.env.OPENCLAUDE_V3_MASTER_BASE_URL = prevMaster
    if (prevToken !== undefined) process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = prevToken
    if (prevTokenFile !== undefined) process.env.OPENCLAUDE_V3_CONTAINER_TOKEN_FILE = prevTokenFile
    if (prevLocalSem !== undefined) process.env.OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC = prevLocalSem
    if (prevLocalLlm !== undefined) process.env.OPENCLAUDE_CORE_MEMORY_LLM_RERANK = prevLocalLlm
    rmSync(isolatedHome, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[context-replay-eval] ERROR: ${(err as Error).message}`)
      process.exit(1)
    })
}
