#!/usr/bin/env -S npx tsx
/**
 * v5-governance-cockpit-digest.ts — Weekly 4-Signal Executive Governance Cockpit Digest (OCV5-906).
 *
 * Single-pass read-only aggregator across all 4 executive governance gauges:
 *   1. Structure & Rework Barometer
 *   2. Delivery & Experience Stability
 *   3. Compute & Waste Guardrail
 *   4. Meta-Guardrail Integrity Audit
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  collectComputeAndWaste,
  collectDeliveryAndExperience,
  collectMetaGuardrailIntegrity,
  collectStructureAndRework,
  probePgReadOnly,
} from './lib/cockpitDigestCollectors.js'
import {
  type CockpitCliOptions,
  type ComputeAndWasteGauge,
  type DeliveryAndExperienceGauge,
  type GovernanceCockpitDigest,
  type MetaGuardrailIntegrityGauge,
  type StructureAndReworkGauge,
  type TrafficLight,
  badge,
  fmtNum,
  fmtPct,
  fmtSigned,
  worstLight,
} from './lib/cockpitDigestTypes.js'

export {
  collectComputeAndWaste,
  collectDeliveryAndExperience,
  collectMetaGuardrailIntegrity,
  collectStructureAndRework,
  worstLight,
  type CockpitCliOptions,
  type ComputeAndWasteGauge,
  type DeliveryAndExperienceGauge,
  type GovernanceCockpitDigest,
  type MetaGuardrailIntegrityGauge,
  type StructureAndReworkGauge,
  type TrafficLight,
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_ENV_FILE = '/etc/openclaude/commercial-v5-selfhost.env'
const DEFAULT_LEASE_DB = '/var/lib/openclaude-v5-selfhost/lease.db'
const DEFAULT_HARNESS_RESULTS = '/opt/openclaude/harness-gate/results'
const DEFAULT_GOVERNOR_ROOT = '/opt/openclaude/harness-gate'
const DEFAULT_SELFEVOLVE_DIR = '/opt/openclaude/var/selfevolve-report'
const DEFAULT_ARCH_TELEMETRY = '/var/lib/openclaude-v5-selfhost/arch-telemetry-snapshot.json'

export function parseCockpitArgs(
  argv: string[],
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): CockpitCliOptions {
  const defaultRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let explicitOffline = false
  let explicitRepo: string | null = null
  let explicitLeaseDb: string | null = null
  let explicitResults: string | null = null
  let explicitGovRoot: string | null = null
  let explicitSelfevolve: string | null = null
  let explicitArchJson: string | null = null
  let explicitCostJson: string | null = null
  let explicitStewardDir: string | null = null
  let outJson: string | null = null
  let outMd: string | null = null
  let date = now.toISOString().slice(0, 10)
  let envFile = DEFAULT_ENV_FILE
  let help = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = (): string => {
      const val = argv[++i]
      if (val === undefined) throw new Error(`${arg} requires a value`)
      return val
    }
    switch (arg) {
      case '--offline':
        explicitOffline = true
        break
      case '--date': {
        const d = next()
        if (!DATE_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
          throw new Error(`--date must be YYYY-MM-DD, got ${JSON.stringify(d)}`)
        }
        date = d
        break
      }
      case '--out-json':
        outJson = next()
        break
      case '--out-md':
        outMd = next()
        break
      case '--repo-root':
        explicitRepo = next()
        break
      case '--lease-db':
        explicitLeaseDb = next()
        break
      case '--harness-results-dir':
        explicitResults = next()
        break
      case '--governor-root':
        explicitGovRoot = next()
        break
      case '--selfevolve-report-dir':
        explicitSelfevolve = next()
        break
      case '--arch-telemetry-json':
        explicitArchJson = next()
        break
      case '--cost-report-json':
        explicitCostJson = next()
        break
      case '--steward-receipt-dir':
        explicitStewardDir = next()
        break
      case '--env-file':
        envFile = next()
        break
      case '-h':
      case '--help':
        help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }

  return {
    date,
    offline: explicitOffline,
    outJson,
    outMd,
    repoRoot: explicitOffline ? explicitRepo : (explicitRepo ?? defaultRepo),
    leaseDb: explicitOffline ? explicitLeaseDb : (explicitLeaseDb ?? env.OC_V5_LEASE_DB ?? DEFAULT_LEASE_DB),
    harnessResultsDir: explicitOffline ? explicitResults : (explicitResults ?? DEFAULT_HARNESS_RESULTS),
    governorRoot: explicitOffline
      ? explicitGovRoot
      : (explicitGovRoot ?? env.OC_GOVERNOR_ROOT ?? DEFAULT_GOVERNOR_ROOT),
    selfevolveReportDir: explicitOffline ? explicitSelfevolve : (explicitSelfevolve ?? DEFAULT_SELFEVOLVE_DIR),
    archTelemetryJson: explicitOffline
      ? explicitArchJson
      : (explicitArchJson ?? env.OC_V5_ARCH_TELEMETRY_JSON ?? DEFAULT_ARCH_TELEMETRY),
    costReportJson: explicitCostJson,
    stewardReceiptDir: explicitStewardDir,
    envFile,
    help,
  }
}

export function renderCockpitMarkdown(digest: GovernanceCockpitDigest): string {
  const { structureAndRework: g1, deliveryAndExperience: g2, computeAndWaste: g3, metaGuardrailIntegrity: g4 } =
    digest.gauges
  const lines: string[] = [
    `# V5 高管治理驾驶舱周报（${digest.asOfDate}）`,
    '',
    `> 总状态：**${badge(digest.overallStatus)}** | 模式：\`${g4.governorMode}\` | 离线模式：\`${digest.offline}\``,
    '',
    '| 仪表 | 红绿灯 | 核心读数摘要 |',
    '|---|---|---|',
    `| 1. 结构与返工晴雨表 | ${badge(g1.status)} | 2周返工率=${fmtPct(g1.rework14d.ratio)} (${fmtNum(g1.rework14d.fixBugCommits)}/${fmtNum(g1.rework14d.totalCommits)})，LOC净变=${fmtSigned(g1.prodLoc7d.netDelta)}，过期TTL=${fmtNum(g1.expiredDebtTtlCount)} |`,
    `| 2. 交付与体验稳定度 | ${badge(g2.status)} | 7d一次通过率=${fmtPct(g2.trainPassRate7d.rate)} (30d=${fmtPct(g2.trainPassRate30d.rate)})，周回滚=${fmtNum(g2.weeklyRollbacks)}，保留集=${g2.retentionLatest.summary} |`,
    `| 3. 算力与浪费护栏 | ${badge(g3.status)} | 周积分=${fmtNum(g3.weeklyConsumption.totalCredits)} (USD=${fmtNum(g3.weeklyConsumption.totalUsd)})，单日突刺=${fmtNum(g3.dailySpike.spikeRatio)}x，失败车占比=${fmtPct(g3.waste.failedTrainRatio)} |`,
    `| 4. 元护栏完整性审计 | ${badge(g4.status)} | A0拦截=${fmtNum(g4.a0Audit7d.interceptedAttempts)}，看护员签收=${fmtPct(g4.stewardSignoff7d.signoffRate)}，商业分支零越权=${String(g4.commercialBranchZeroTouch.confirmedZeroUnauthorized)} |`,
    '',
    '## 仪表 1 · 结构与返工晴雨表',
    `- 近 14 天 \`fix+bug\` 占比：${fmtPct(g1.rework14d.ratio)}（阈值：>35% AMBER / >40% RED）`,
    `- 近 7 天生产代码 LOC 增速：+${fmtNum(g1.prodLoc7d.added)} / -${fmtNum(g1.prodLoc7d.deleted)}（净变 ${fmtSigned(g1.prodLoc7d.netDelta)}）`,
    `- 架构违规基线：总计 ${fmtNum(g1.archViolations.total)}（7d净变 ${fmtSigned(g1.archViolations.netDelta7d)}），其中 R2=${fmtNum(g1.archViolations.r2Total)}（7d净变 ${fmtSigned(g1.archViolations.r2NetDelta7d)}）`,
    `- Top-10 上帝文件：总行数 ${fmtNum(g1.top10GodFiles.totalLines)}，7d净增减 ${fmtSigned(g1.top10GodFiles.netDelta7d)}（增长文件数 ${fmtNum(g1.top10GodFiles.grownCount)}）`,
    `- 过期债务 TTL 数：${fmtNum(g1.expiredDebtTtlCount)}`,
    '',
    '## 仪表 2 · 交付与体验稳定度',
    `- 发布列车一次通过率：近 7 天 ${fmtPct(g2.trainPassRate7d.rate)} (${fmtNum(g2.trainPassRate7d.committed)}/${fmtNum(g2.trainPassRate7d.terminalTotal)})，近 30 天 ${fmtPct(g2.trainPassRate30d.rate)}（对比 26.0% 基线 / >80.0% 目标）`,
    `- 周生产回滚数：${fmtNum(g2.weeklyRollbacks)}`,
    `- 宿主保留集最新状态：${g2.retentionLatest.summary}`,
    `- 隐性差评趋势：${g2.implicitNegativeTrend.summary}`,
    '',
    '## 仪表 3 · 算力与浪费护栏',
    `- 周总消耗（来源 \`${g3.weeklyConsumption.source}\`）：credits=${fmtNum(g3.weeklyConsumption.totalCredits)}，USD=${fmtNum(g3.weeklyConsumption.totalUsd)}`,
    `- 单日异常突刺：峰值=${fmtNum(g3.dailySpike.maxDailyValue)} (${g3.dailySpike.peakDate})，中位数=${fmtNum(g3.dailySpike.medianDailyValue)}，倍率=${fmtNum(g3.dailySpike.spikeRatio)}x`,
    `- 浪费占比：失败列车占比=${fmtPct(g3.waste.failedTrainRatio)}（时长占比=${fmtPct(g3.waste.failedDurationShare)}），重试/失败调用消耗占比=${fmtPct(g3.waste.retryWasteRatio)}`,
    '',
    '## 仪表 4 · 元护栏完整性审计',
    `- 本周拦截 A0 篡改/放宽与高危半径尝试：${fmtNum(g4.a0Audit7d.interceptedAttempts)} 次（合规签章放宽=${fmtNum(g4.a0Audit7d.approvedRelaxations)}，篡改失效签章=${fmtNum(g4.a0Audit7d.tamperedApprovals)}）`,
    `- 跨家族架构看护员签收率：${fmtPct(g4.stewardSignoff7d.signoffRate)}（有效跨家族签收 ${fmtNum(g4.stewardSignoff7d.validCrossFamilyApprovals)}/${fmtNum(g4.stewardSignoff7d.totalReceipts)}，否决/不合规 ${fmtNum(g4.stewardSignoff7d.vetoOrInvalid)}）`,
    `- 商业版 \`feat/v5-aurora-rewrite\` 零越权确认：${g4.commercialBranchZeroTouch.detail}`,
    '',
  ]
  const allNotes = [...g1.notes, ...g2.notes, ...g3.notes, ...g4.notes]
  if (allNotes.length > 0) {
    lines.push('## 异常与行动提示')
    for (const n of allNotes) lines.push(`- ${n}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

export async function buildGovernanceCockpitDigest(
  opts: CockpitCliOptions,
  now = new Date(),
): Promise<GovernanceCockpitDigest> {
  const pgData = await probePgReadOnly(opts)
  const structureAndRework = collectStructureAndRework(opts)
  const deliveryAndExperience = collectDeliveryAndExperience(opts, pgData.implicit)
  const computeAndWaste = collectComputeAndWaste(opts, pgData.compute)
  const metaGuardrailIntegrity = collectMetaGuardrailIntegrity(opts)
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    asOfDate: opts.date,
    offline: opts.offline,
    overallStatus: worstLight([
      structureAndRework.status,
      deliveryAndExperience.status,
      computeAndWaste.status,
      metaGuardrailIntegrity.status,
    ]),
    gauges: { structureAndRework, deliveryAndExperience, computeAndWaste, metaGuardrailIntegrity },
  }
}

function atomicWriteText(targetPath: string, content: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, targetPath)
}

const USAGE = `Usage: npx tsx scripts/v5-governance-cockpit-digest.ts [options]
  --date YYYY-MM-DD            Window end date (UTC, default today)
  --out-json PATH              Write structured JSON digest to PATH
  --out-md PATH                Write Markdown executive card to PATH
  --offline                    Airgapped/test mode (no implicit host/PG probes; missing sources -> N/A)
  --repo-root DIR              Override git repository root
  --lease-db PATH              Override SQLite lease.db path
  --harness-results-dir DIR    Override /opt/openclaude/harness-gate/results
  --governor-root DIR          Override /opt/openclaude/harness-gate
  --selfevolve-report-dir DIR  Override /opt/openclaude/var/selfevolve-report
  --arch-telemetry-json PATH   Optional runtime archTelemetry snapshot JSON
  --cost-report-json PATH      Optional weekly compute cost JSON
  --steward-receipt-dir DIR    Optional Steward receipt directory
`

export async function runCockpitCli(argv = process.argv.slice(2)): Promise<number> {
  let opts: CockpitCliOptions
  try {
    opts = parseCockpitArgs(argv)
  } catch (err) {
    console.error((err as Error).message)
    console.error(USAGE)
    return 4
  }
  if (opts.help) {
    console.log(USAGE)
    return 0
  }
  const digest = await buildGovernanceCockpitDigest(opts)
  const md = renderCockpitMarkdown(digest)
  if (opts.outJson) atomicWriteText(opts.outJson, `${JSON.stringify(digest, null, 2)}\n`)
  if (opts.outMd) atomicWriteText(opts.outMd, md)
  if (!opts.outJson && !opts.outMd) {
    console.log(md)
  } else {
    console.log(
      JSON.stringify({
        asOfDate: digest.asOfDate,
        overallStatus: digest.overallStatus,
        outJson: opts.outJson,
        outMd: opts.outMd,
      }),
    )
  }
  return 0
}

function isDirectEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return (
      path.resolve(entry) === fileURLToPath(import.meta.url) ||
      import.meta.url === pathToFileURL(entry).href
    )
  } catch {
    return false
  }
}

if (isDirectEntry()) {
  runCockpitCli()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
