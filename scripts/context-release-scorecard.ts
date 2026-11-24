#!/usr/bin/env -S npx tsx
/**
 * context-release-scorecard.ts — T-Canary 线上发布前后对照卡（OCV5-885 P0-2）。
 *
 * 只读 SQL（强制 `default_transaction_read_only = on` + `BEGIN READ ONLY`），<3s，0 Token，
 * 隐私安全（不输出会话原文、连接串或任何密钥），内置反 Goodhart 统计门禁。
 *
 * 用法:
 *   npx tsx scripts/context-release-scorecard.ts
 *   npx tsx scripts/context-release-scorecard.ts --before-commit <sha> --after-commit <sha>
 *   npx tsx scripts/context-release-scorecard.ts --before-window <ISO..ISO> --after-window <ISO..ISO>
 *   npx tsx scripts/context-release-scorecard.ts --hours 24 --format json
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import {
  type PromptDecisionBucket,
  type QueryFn,
  analyzeAssistantProtocolBlocks,
  analyzeAssistantProtocolText,
  classifyPromptDecision,
  collectAndEvaluate,
  collectArmDataset,
  collectContextEvalTelemetry,
  extractFencedBlocks,
  extractReleaseSha,
  isInputPredictionBlock,
  resolveAutoCommits,
  summarizePromptDecisionRows,
  validateOptionsBlockJson,
} from './lib/contextScorecardSql.js'
import {
  type AntigravityDenoiseSummary,
  type AntigravityRelayRow,
  type ArmDataset,
  type ArmSummary,
  type CliOptions,
  type CompactionEvalSummary,
  type ComparisonSpec,
  type ContextEvalTelemetry,
  type ContinuousComparison,
  type ContinuousMetricStats,
  DEFAULT_BOOTSTRAP_DRAWS,
  DEFAULT_MIN_COMPLETED_TURNS,
  DEFAULT_MIN_DISTINCT_SESSIONS,
  DEFAULT_SESSION_WEIGHT_CAP,
  FLASH_LITE_UPSTREAM_MODEL,
  type GuardrailResult,
  type ModelStratumSummary,
  type OutputFormat,
  type PromptDecisionSummary,
  type ProtocolTurnRow,
  REWRITE_RESEND_TAG,
  type RateComparison,
  type RateMetricStats,
  type ResolvedArmFilter,
  type ScorecardReport,
  type SessionRateSample,
  type SessionValueSample,
  type TurnFactRow,
  type VerdictOptions,
  type VerdictState,
  aggregateSessionContinuous,
  aggregateSessionRate,
  buildResumedMainCacheSamples,
  compareContinuousMetric,
  compareRateMetric,
  computeCappedSessionWeights,
  computeWilsonInterval,
  detectFirstTurnIndex,
  evaluateScorecardVerdict,
  isAntigravityModel,
  normalTwoSidedPValue,
  summarizeAntigravityDenoised,
  turnPhaseOf,
  twoProportionZTest,
} from './lib/contextScorecardStats.js'

const { Client } = pg

export const EXIT = { ok: 0, reject: 1, pg: 2, usage: 4 } as const
export const DEFAULT_ENV_FILE = '/etc/openclaude/commercial-v5-selfhost.env'
export const DEFAULT_LOOKBACK_DAYS = 30

const COMMIT_PREFIX_RE = /^[0-9a-f]{4,40}$/i

// Explicit named re-exports (no export *) so callers/tests can import from scorecard entrypoint.
export {
  DEFAULT_BOOTSTRAP_DRAWS,
  DEFAULT_MIN_COMPLETED_TURNS,
  DEFAULT_MIN_DISTINCT_SESSIONS,
  DEFAULT_SESSION_WEIGHT_CAP,
  FLASH_LITE_UPSTREAM_MODEL,
  REWRITE_RESEND_TAG,
  aggregateSessionContinuous,
  aggregateSessionRate,
  analyzeAssistantProtocolBlocks,
  analyzeAssistantProtocolText,
  buildResumedMainCacheSamples,
  classifyPromptDecision,
  collectAndEvaluate,
  collectArmDataset,
  collectContextEvalTelemetry,
  compareContinuousMetric,
  compareRateMetric,
  computeCappedSessionWeights,
  computeWilsonInterval,
  detectFirstTurnIndex,
  evaluateScorecardVerdict,
  extractFencedBlocks,
  extractReleaseSha,
  isAntigravityModel,
  isInputPredictionBlock,
  normalTwoSidedPValue,
  resolveAutoCommits,
  summarizeAntigravityDenoised,
  summarizePromptDecisionRows,
  turnPhaseOf,
  twoProportionZTest,
  validateOptionsBlockJson,
}
export type {
  AntigravityDenoiseSummary,
  AntigravityRelayRow,
  ArmDataset,
  ArmSummary,
  CliOptions,
  CompactionEvalSummary,
  ComparisonSpec,
  ContextEvalTelemetry,
  ContinuousComparison,
  ContinuousMetricStats,
  GuardrailResult,
  ModelStratumSummary,
  OutputFormat,
  PromptDecisionBucket,
  PromptDecisionSummary,
  ProtocolTurnRow,
  QueryFn,
  RateComparison,
  RateMetricStats,
  ResolvedArmFilter,
  ScorecardReport,
  SessionRateSample,
  SessionValueSample,
  TurnFactRow,
  VerdictOptions,
  VerdictState,
}

// ---------------------------------------------------------------------------
// CLI Parsing & Secret-Safe Env Reading
// ---------------------------------------------------------------------------

function parseIsoWindow(raw: string, flagName: string): { start: string; end: string } {
  const parts = raw.split('..')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`${flagName} must be <ISO..ISO>, got ${JSON.stringify(raw)}`)
  }
  const startMs = Date.parse(parts[0])
  const endMs = Date.parse(parts[1])
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new Error(`${flagName} contains invalid ISO timestamp: ${JSON.stringify(raw)}`)
  }
  if (startMs >= endMs) {
    throw new Error(`${flagName} start must be strictly before end: ${JSON.stringify(raw)}`)
  }
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() }
}

function parseCommitPrefix(raw: string, flagName: string): string {
  const trimmed = raw.trim().toLowerCase()
  if (!COMMIT_PREFIX_RE.test(trimmed)) {
    throw new Error(`${flagName} must be 4..40 hex chars, got ${JSON.stringify(raw)}`)
  }
  return trimmed
}

function parsePositiveInt(raw: string, flagName: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flagName} must be an integer in ${min}..${max}, got ${JSON.stringify(raw)}`)
  }
  const n = Number(raw)
  if (n < min || n > max) {
    throw new Error(`${flagName} must be in ${min}..${max}, got ${n}`)
  }
  return n
}

export function parseArgs(argv: string[], now = new Date()): CliOptions {
  let beforeCommit: string | undefined
  let afterCommit: string | undefined
  let beforeWindow: { start: string; end: string } | undefined
  let afterWindow: { start: string; end: string } | undefined
  let hours: number | undefined
  let lookbackDays = DEFAULT_LOOKBACK_DAYS
  let format: OutputFormat = 'markdown'
  let envFile = DEFAULT_ENV_FILE
  let minCompletedTurns = DEFAULT_MIN_COMPLETED_TURNS
  let minDistinctSessions = DEFAULT_MIN_DISTINCT_SESSIONS
  let sessionWeightCap = DEFAULT_SESSION_WEIGHT_CAP
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} requires a value`)
      return v
    }
    switch (arg) {
      case '--before-commit':
        beforeCommit = parseCommitPrefix(next(), '--before-commit')
        break
      case '--after-commit':
        afterCommit = parseCommitPrefix(next(), '--after-commit')
        break
      case '--before-window':
        beforeWindow = parseIsoWindow(next(), '--before-window')
        break
      case '--after-window':
        afterWindow = parseIsoWindow(next(), '--after-window')
        break
      case '--hours': {
        const raw = next()
        const h = Number(raw)
        if (!Number.isFinite(h) || h <= 0 || h > 24 * 90) {
          throw new Error(`--hours must be in (0, 2160], got ${JSON.stringify(raw)}`)
        }
        hours = h
        break
      }
      case '--lookback-days':
        lookbackDays = parsePositiveInt(next(), '--lookback-days', 1, 365)
        break
      case '--format': {
        const f = next().toLowerCase()
        if (f !== 'markdown' && f !== 'json') {
          throw new Error(`--format must be markdown or json, got ${JSON.stringify(f)}`)
        }
        format = f
        break
      }
      case '--json':
        format = 'json'
        break
      case '--env-file':
        envFile = next()
        break
      case '--min-turns':
        minCompletedTurns = parsePositiveInt(next(), '--min-turns', 1, 100_000)
        break
      case '--min-sessions':
        minDistinctSessions = parsePositiveInt(next(), '--min-sessions', 1, 100_000)
        break
      case '--session-cap': {
        const raw = next()
        const cap = Number(raw)
        if (!Number.isFinite(cap) || cap <= 0 || cap > 1) {
          throw new Error(`--session-cap must be in (0, 1], got ${JSON.stringify(raw)}`)
        }
        sessionWeightCap = cap
        break
      }
      case '-h':
      case '--help':
        help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }

  const hasCommit = beforeCommit !== undefined || afterCommit !== undefined
  const hasWindow = beforeWindow !== undefined || afterWindow !== undefined
  const hasHours = hours !== undefined
  if (Number(hasCommit) + Number(hasWindow) + Number(hasHours) > 1) {
    throw new Error('Cannot combine --before-commit/--after-commit, --before-window/--after-window, and --hours')
  }

  let spec: ComparisonSpec
  if (hasCommit) {
    if (!beforeCommit || !afterCommit) {
      throw new Error('Both --before-commit and --after-commit must be provided together')
    }
    if (beforeCommit === afterCommit) {
      throw new Error('--before-commit and --after-commit must be distinct')
    }
    spec = { kind: 'commit', beforeCommit, afterCommit }
  } else if (hasWindow) {
    if (!beforeWindow || !afterWindow) {
      throw new Error('Both --before-window and --after-window must be provided together')
    }
    spec = {
      kind: 'window',
      beforeStart: beforeWindow.start,
      beforeEnd: beforeWindow.end,
      afterStart: afterWindow.start,
      afterEnd: afterWindow.end,
    }
  } else if (hasHours && hours !== undefined) {
    const ms = hours * 3600 * 1000
    const nowMs = now.getTime()
    spec = {
      kind: 'window',
      beforeStart: new Date(nowMs - 2 * ms).toISOString(),
      beforeEnd: new Date(nowMs - ms).toISOString(),
      afterStart: new Date(nowMs - ms).toISOString(),
      afterEnd: new Date(nowMs).toISOString(),
    }
  } else {
    spec = { kind: 'auto-commit', lookbackDays }
  }

  return { spec, format, envFile, minCompletedTurns, minDistinctSessions, sessionWeightCap, help }
}

export function readDatabaseUrl(
  envFile: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.DATABASE_URL?.trim()
  if (fromEnv) return fromEnv
  if (!envFile || !existsSync(envFile)) return undefined
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(?:export\s+)?DATABASE_URL=(.*)$/)
    if (!m) continue
    let v = m[1]!.trim()
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1)
    }
    return v || undefined
  }
  return undefined
}

export function redactSecrets(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://[REDACTED]')
}

// ---------------------------------------------------------------------------
// Markdown Renderer
// ---------------------------------------------------------------------------

const fmtPct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)
const fmtPp = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}pp`)
const fmtRelPct = (v: number | null): string => (v === null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)
const fmtCiPct = (ci: [number, number] | null): string =>
  ci ? `[${(ci[0] * 100).toFixed(1)}%, ${(ci[1] * 100).toFixed(1)}%]` : '—'
const fmtNum = (v: number | null, digits = 1): string => (v === null ? '—' : v.toFixed(digits))
const fmtCiNum = (ci: [number, number] | null): string =>
  ci ? `[${ci[0].toFixed(1)}, ${ci[1].toFixed(1)}]` : '—'

function mdTable(headers: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return '（无数据）\n'
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`]
  for (const row of rows) {
    lines.push(`| ${row.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)
  }
  return `${lines.join('\n')}\n`
}

export function renderMarkdownScorecard(report: ScorecardReport): string {
  const parts: string[] = []
  const verdictBadge =
    report.verdict === 'REJECT'
      ? 'REJECT (ROLLBACK_RECOMMENDED)'
      : report.verdict === 'INCONCLUSIVE'
        ? 'INCONCLUSIVE (样本未达门槛，禁止误判回滚)'
        : 'PASS'

  parts.push(`# Context Release Scorecard (T-Canary)\n\n`)
  parts.push(`- **裁决结论**: \`${verdictBadge}\`\n`)
  parts.push(`- **对照范围 (${report.comparisonKind})**: Before \`${report.before.label}\` vs After \`${report.after.label}\`\n`)
  parts.push(
    `- **样本门禁** (≥${report.thresholds.minCompletedTurns} completed turns 且 ≥${report.thresholds.minDistinctSessions} sessions，单会话权重封顶 ${(report.thresholds.sessionWeightCap * 100).toFixed(0)}%): ` +
      `Before **${report.before.completedTurns} turns / ${report.before.distinctSessions} sessions**，After **${report.after.completedTurns} turns / ${report.after.distinctSessions} sessions**\n`,
  )
  parts.push(
    `- **执行元数据**: 只读事务=${report.readOnlyVerified ? 'ON' : 'OFF'}，SQL 耗时=${report.queryDurationMs}ms，生成时间=${report.generatedAt}\n\n`,
  )

  if (!report.sampleGatePassed) {
    parts.push(`> **INCONCLUSIVE 原因**: ${report.inconclusiveReasons.join('；')}。以下仍展示全部实测数据供参考，但不触发回滚告警。\n\n`)
  } else if (report.breaches.length > 0) {
    parts.push(`> **ROLLBACK_RECOMMENDED 触发项 (${report.breaches.length})**:\n`)
    for (const b of report.breaches) {
      parts.push(`> - \`${b.scope}/${b.id}\` (${b.label}): ${b.detail}\n`)
    }
    parts.push('\n')
  }

  parts.push(`## 0. 核心护栏裁决总览（Session 25% 封顶加权 + 95% CI）\n\n`)
  parts.push(
    mdTable(
      ['护栏维度', 'Before (95% CI)', 'After (95% CI)', '变化', 'p-value', 'Bootstrap Δ 95% CI', '状态'],
      report.guardrails.map((g) => {
        const isCost = g.id.includes('cost')
        return [
          g.label,
          isCost ? `${fmtNum(g.beforeValue)} ${fmtCiNum(g.beforeCi95)}` : `${fmtPct(g.beforeValue)} ${fmtCiPct(g.beforeCi95)}`,
          isCost ? `${fmtNum(g.afterValue)} ${fmtCiNum(g.afterCi95)}` : `${fmtPct(g.afterValue)} ${fmtCiPct(g.afterCi95)}`,
          isCost ? fmtRelPct(g.relativeDelta) : fmtPp(g.delta),
          g.pValue === null ? '—' : g.pValue.toFixed(4),
          isCost ? fmtCiNum(g.bootstrapDeltaCi95) : fmtCiPct(g.bootstrapDeltaCi95),
          g.status === 'breach' ? (report.sampleGatePassed ? 'BREACH' : 'OBSERVE (under-sampled)') : g.status.toUpperCase(),
        ]
      }),
    ),
  )

  parts.push(`\n## 1. 主模型真实缓存命中占比 & 单轮均耗（按 mode / model / 首续轮）\n\n`)
  const renderStrata = (title: string, rows: ModelStratumSummary[]): void => {
    parts.push(`### ${title}\n\n`)
    parts.push(
      mdTable(
        ['mode', 'model', '阶段', '回合(完成)', '会话', 'Token 缓存命中', '加权缓存命中', '均耗 credits', '报错率'],
        rows.slice(0, 20).map((r) => [
          r.mode,
          r.model,
          r.turnPhase,
          `${r.turns} (${r.completedTurns})`,
          r.distinctSessions,
          fmtPct(r.cacheHitRate),
          fmtPct(r.weightedCacheHitRate),
          fmtNum(r.avgCostCredits),
          fmtPct(r.errorRate),
        ]),
      ),
    )
  }
  renderStrata(`Before (${report.before.label})`, report.before.modelStrata)
  parts.push('\n')
  renderStrata(`After (${report.after.label})`, report.after.modelStrata)

  parts.push(`\n## 2. Antigravity 主前缀缓存去噪（剔除 \`${FLASH_LITE_UPSTREAM_MODEL}\`）\n\n`)
  const renderAgy = (title: string, rows: AntigravityDenoiseSummary[]): void => {
    parts.push(`### ${title}\n\n`)
    parts.push(
      mdTable(
        ['route_model_id', '阶段', 'dispatches', '会话', '去噪主缓存', '加权主缓存', '未去噪原值', 'flash-lite 调用占比', 'flash-lite Token 占比'],
        rows.map((r) => [
          r.routeModelId,
          r.turnPhase,
          r.dispatches,
          r.distinctSessions,
          fmtPct(r.denoisedCacheHitRate),
          fmtPct(r.weightedDenoisedCacheHitRate),
          fmtPct(r.rawCacheHitRate),
          fmtPct(r.flashLiteCallShare),
          fmtPct(r.flashLitePromptShare),
        ]),
      ),
    )
  }
  renderAgy(`Before (${report.before.label})`, report.before.antigravityDenoised)
  parts.push('\n')
  renderAgy(`After (${report.after.label})`, report.after.antigravityDenoised)

  const rateRow = (label: string, cmp: RateComparison): Array<string | number> => [
    label,
    `${fmtPct(cmp.before.rawRate)} (${cmp.before.rawNumerator}/${cmp.before.rawDenominator})`,
    fmtPct(cmp.before.weightedRate),
    `${fmtPct(cmp.after.rawRate)} (${cmp.after.rawNumerator}/${cmp.after.rawDenominator})`,
    fmtPct(cmp.after.weightedRate),
    fmtPp(cmp.delta),
  ]

  parts.push(`\n## 3. 用户隐性纠偏率（「${REWRITE_RESEND_TAG}」）与稳定性\n\n`)
  parts.push(
    mdTable(
      ['指标', 'Before 原始', 'Before 加权', 'After 原始', 'After 加权', '加权变化'],
      [
        rateRow(`改写重发率 (${REWRITE_RESEND_TAG})`, report.metrics.rewriteResendRate),
        rateRow('崩溃率 (crashed)', report.metrics.crashedRate),
        rateRow('Usage Error 率 (status=error)', report.metrics.usageErrorRate),
      ],
    ),
  )

  parts.push(`\n## 4. 线上隐性协议活跃度哨兵（Webchat Assistant）\n\n`)
  parts.push(
    mdTable(
      ['协议指标', 'Before 原始', 'Before 加权', 'After 原始', 'After 加权', '加权变化'],
      [
        rateRow('富组件 ```ui 触发率（排除 next）', report.metrics.uiComponentTriggerRate),
        rateRow('输入预测 {"type":"next"} 触发率', report.metrics.inputPredictionTriggerRate),
        rateRow('```options 触发率', report.metrics.optionsTriggerRate),
        rateRow('```options JSON Schema 合规率', report.metrics.optionsSchemaValidRate),
      ],
    ),
  )

  parts.push(`\n## 5. 压缩与去重健康度（\`context_eval_events\`）\n\n`)
  if (
    report.before.contextEval.status === 'telemetry_pending_0353' ||
    report.after.contextEval.status === 'telemetry_pending_0353'
  ) {
    parts.push(`- 状态: \`telemetry_pending_0353\`（\`public.context_eval_events\` 尚未迁移，已优雅降级跳过）\n`)
  } else {
    const bc = report.before.contextEval.compaction!
    const ac = report.after.contextEval.compaction!
    const bd = report.before.contextEval.promptDecision!
    const ad = report.after.contextEval.promptDecision!
    parts.push(
      mdTable(
        ['指标', `Before (${report.before.label})`, `After (${report.after.label})`],
        [
          ['context_compacted 次数 (会话)', `${bc.eventCount} (${bc.distinctSessions})`, `${ac.eventCount} (${ac.distinctSessions})`],
          ['字节压缩比 (after/before)', fmtPct(bc.byteCompressionRatio), fmtPct(ac.byteCompressionRatio)],
          ['Token 压缩比 (after/before)', fmtPct(bc.tokenCompressionRatio), fmtPct(ac.tokenCompressionRatio)],
          ['压缩后 t+1/t+2 非完成率', `${fmtPct(bc.postCompactionNonCompletedRate)} (n=${bc.postCompactionTurns})`, `${fmtPct(ac.postCompactionNonCompletedRate)} (n=${ac.postCompactionTurns})`],
          ['压缩后 t+1/t+2 改写重发率', fmtPct(bc.postCompactionRewriteRate), fmtPct(ac.postCompactionRewriteRate)],
          ['续轮缓存/去重复用命中率（排除首轮）', `${fmtPct(bd.elideOrReuseRate)} (${bd.elideOrReuseCount}/${bd.eligibleCount}, 首轮排除=${bd.firstTurnExcludedCount})`, `${fmtPct(ad.elideOrReuseRate)} (${ad.elideOrReuseCount}/${ad.eligibleCount}, 首轮排除=${ad.firstTurnExcludedCount})`],
          [
            'Top changed_slots',
            bd.topChangedSlots.slice(0, 5).map((s) => `${s.slot}(${s.count})`).join(', ') || '—',
            ad.topChangedSlots.slice(0, 5).map((s) => `${s.slot}(${s.count})`).join(', ') || '—',
          ],
        ],
      ),
    )
  }

  if (report.modelGroupGuardrails.length > 0) {
    parts.push(`\n## 6. 主力模型分层护栏（独立达标分组）\n\n`)
    parts.push(
      mdTable(
        ['分组护栏', 'Before', 'After', '变化', 'p-value', '状态'],
        report.modelGroupGuardrails.map((g) => [
          g.label,
          g.id.includes('cost') ? fmtNum(g.beforeValue) : fmtPct(g.beforeValue),
          g.id.includes('cost') ? fmtNum(g.afterValue) : fmtPct(g.afterValue),
          g.id.includes('cost') ? fmtRelPct(g.relativeDelta) : fmtPp(g.delta),
          g.pValue === null ? '—' : g.pValue.toFixed(4),
          g.status.toUpperCase(),
        ]),
      ),
    )
  }

  return parts.join('')
}

// ---------------------------------------------------------------------------
// Main Runner
// ---------------------------------------------------------------------------

const USAGE = `用法: npx tsx scripts/context-release-scorecard.ts [选项]
  --before-commit <sha>        对照前版本 runtime_source_commit 前缀 (4..40 hex)
  --after-commit <sha>         对照后版本 runtime_source_commit 前缀 (4..40 hex)
  --before-window <ISO..ISO>   对照前时间窗 (如 2026-11-20T00:00:00Z..2026-11-22T00:00:00Z)
  --after-window <ISO..ISO>    对照后时间窗
  --hours <N>                  便捷时间窗对照：前 N 小时 vs 最近 N 小时
  --lookback-days <N>          自动选双版本时的回看天数（默认 ${DEFAULT_LOOKBACK_DAYS}）
  --format markdown|json       输出格式（默认 markdown）
  --json                       等同 --format json
  --env-file <path>            默认 ${DEFAULT_ENV_FILE}（仅当 DATABASE_URL 未设置）
  --min-turns <N>              最小完成轮次门槛（默认 ${DEFAULT_MIN_COMPLETED_TURNS}）
  --min-sessions <N>           最小独立会话门槛（默认 ${DEFAULT_MIN_DISTINCT_SESSIONS}）
`

export async function runScorecard(argv = process.argv.slice(2)): Promise<number> {
  let opts: CliOptions
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(String((err as Error).message))
    console.error(USAGE)
    return EXIT.usage
  }
  if (opts.help) {
    console.log(USAGE)
    return EXIT.ok
  }

  const databaseUrl = readDatabaseUrl(opts.envFile)
  if (!databaseUrl) {
    console.error('DATABASE_URL missing (set DATABASE_URL env or provide --env-file)')
    return EXIT.usage
  }

  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    application_name: 'context-release-scorecard-ro',
  })

  let report: ScorecardReport
  try {
    await client.connect()
    await client.query('SET default_transaction_read_only = on')
    await client.query("SET statement_timeout = '15s'")
    await client.query('BEGIN READ ONLY')
    const q: QueryFn = async (sql, params) => (await client.query(sql, params)).rows
    report = await collectAndEvaluate(q, opts)
    await client.query('COMMIT')
  } catch (err) {
    console.error(`scorecard pg failed: ${redactSecrets((err as Error).message)}`)
    return EXIT.pg
  } finally {
    await client.end().catch(() => {})
  }

  console.log(opts.format === 'json' ? JSON.stringify(report, null, 2) : renderMarkdownScorecard(report))
  return report.verdict === 'REJECT' ? EXIT.reject : EXIT.ok
}

function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isDirectRun() || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  runScorecard()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(redactSecrets(String(err instanceof Error ? err.message : err)))
      process.exit(EXIT.pg)
    })
}
