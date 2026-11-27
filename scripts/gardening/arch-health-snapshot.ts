#!/usr/bin/env node
/**
 * Weekly Architecture Health Snapshot (OCV5-905 · Gardening Loop Pillar 3).
 *
 * Integrates `scripts/arch-measure/` capabilities, repository governance baseline JSONs (graceful
 * fallback when optional baselines are absent), and 14d/60d git touch & rework statistics to emit
 * `arch-health.json` with hotspot `magnetScore = touches_60d * log2(loc) * debtWeight` and the
 * Top-20 `prioritizedDebtQueue` (`magnetScore * ttlUrgency`).
 *
 * Usage:
 *   npx tsx scripts/gardening/arch-health-snapshot.ts [--root <repo>] [--out <arch-health.json>]
 *     [--dead-code-json <dead-code.json>] [--now <iso>] [--top <20>]
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicWriteJson, errMsg } from '../../packages/kernel/src/index.js'
import {
  type AllBaselineSummaries,
  type BaselineStatusSummary,
  type GitChurnSnapshot,
  type ParsedBaselines,
  type WorkspaceScan,
  collectGitStats,
  collectProdFiles,
  isProdTsFile,
  loadAllBaselines,
  parseDeadCodeJson,
  readJsonSafe,
  scanWorkspaceFiles,
  stripCodeComments,
  tarjanScc,
} from './archHealthCollectors.js'

export { isProdTsFile, stripCodeComments, tarjanScc }
export type { BaselineStatusSummary, GitChurnSnapshot }

export type DebtCategory =
  | 'wheel-consolidation'
  | 'dead-code'
  | 'r2-export-star'
  | 'r3-env'
  | 'strangler-extract'

export interface HotspotEntry {
  file: string
  loc: number
  touches60d: number
  touches14d: number
  reworkTouches14d: number
  debtWeight: number
  magnetScore: number
  signals: {
    violations: number
    r2ExportStar: number
    r3Env: number
    aiSmells: number
    complexFunctions: number
    clones: number
    inFileCycle: boolean
    wheelDuplicates: string[]
    deadExports: number
    inSizeBaseline: boolean
  }
}

export interface PrioritizedDebtItem {
  rank: number
  itemKey: string
  category: DebtCategory
  file: string
  loc: number
  touches60d: number
  touches14d: number
  debtWeight: number
  magnetScore: number
  ttlUrgency: number
  priorityScore: number
  targetBaseline: string
  autonomyTier: 'L3-auto' | 'T2-human-merge'
  details: string
  suggestedAction: string
}

export interface ArchHealthSnapshot {
  schemaVersion: 1
  generatedAt: string
  root: string
  totals: {
    productionFiles: number
    productionLoc: number
    packageLoc: Record<string, number>
    fileValueCycles: number
    wheelDuplicateSites: number
  }
  git14d: {
    totalCommits: number
    reworkCommits: number
    reworkRate: number
    status: 'GREEN' | 'AMBER' | 'RED'
  }
  baselines: AllBaselineSummaries
  top10GodFiles: Array<{ file: string; loc: number }>
  hotspots: HotspotEntry[]
  prioritizedDebtQueue: PrioritizedDebtItem[]
}

export interface SnapshotOptions {
  root: string
  now?: Date
  topN?: number
  deadCodeJsonPath?: string
  gitStatsOverride?: GitChurnSnapshot
}

/** Exact hotspot formula from OCV5-905 spec: `touches_60d * log2(loc) * debtWeight`. */
export function computeMagnetScore(touches60d: number, loc: number, debtWeight: number): number {
  const safeTouches = Math.max(0, touches60d)
  const safeLoc = Math.max(2, loc)
  const safeWeight = Math.max(0, debtWeight)
  return Number((safeTouches * Math.log2(safeLoc) * safeWeight).toFixed(3))
}

function isKernelImportEligible(file: string): boolean {
  return (
    (file.startsWith('packages/gateway/src/') || file.startsWith('packages/commercial/src/')) &&
    !file.startsWith('packages/commercial/src/types/') &&
    !file.startsWith('packages/commercial/src/flavor/')
  )
}

function isEntrypointLike(file: string): boolean {
  return (
    /(?:^|\/)(?:index|main|server|cli|router|routes|migrations|types|schema)\.(?:ts|tsx)$/.test(
      file,
    ) || /\/(?:migrations|cli|bin)\//.test(file)
  )
}

export function rankDebtCandidates(
  candidates: PrioritizedDebtItem[],
  topN: number,
): PrioritizedDebtItem[] {
  const sorted = [...candidates].sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore
    const fallbackA = a.debtWeight * Math.log2(Math.max(2, a.loc)) * a.ttlUrgency
    const fallbackB = b.debtWeight * Math.log2(Math.max(2, b.loc)) * b.ttlUrgency
    if (fallbackB !== fallbackA) return fallbackB - fallbackA
    return a.itemKey.localeCompare(b.itemKey)
  })
  return sorted.slice(0, topN).map((item, idx) => ({ ...item, rank: idx + 1 }))
}

function appendFileDebtCandidates(ctx: {
  file: string
  loc: number
  touches60d: number
  touches14d: number
  reworkTouches14d: number
  r2ExportStar: number
  r3Env: number
  r2Coupling: number
  complexFunctions: number
  inFileCycle: boolean
  inSizeBaseline: boolean
  wheelDuplicates: string[]
  deadExports: number
  isGod10: boolean
  baselines: ParsedBaselines
  out: PrioritizedDebtItem[]
}): void {
  const expiredBoost = ctx.baselines.expiredExceptionFiles.has(ctx.file) ? 1.5 : 1.0
  const pushItem = (
    category: DebtCategory,
    catWeight: number,
    targetBaseline: string,
    details: string,
    suggestedAction: string,
  ) => {
    const magnetScore = computeMagnetScore(ctx.touches60d, ctx.loc, catWeight)
    const ttlUrgency = Number(
      ((ctx.baselines.ttlUrgencyByRule[category] ?? 1.0) * expiredBoost).toFixed(3),
    )
    ctx.out.push({
      rank: 0,
      itemKey: `${category}:${ctx.file}`,
      category,
      file: ctx.file,
      loc: ctx.loc,
      touches60d: ctx.touches60d,
      touches14d: ctx.touches14d,
      debtWeight: Number(catWeight.toFixed(3)),
      magnetScore,
      ttlUrgency,
      priorityScore: Number((magnetScore * ttlUrgency).toFixed(3)),
      targetBaseline,
      autonomyTier: ctx.isGod10 ? 'T2-human-merge' : 'L3-auto',
      details,
      suggestedAction,
    })
  }

  if (
    ctx.wheelDuplicates.length > 0 &&
    isKernelImportEligible(ctx.file) &&
    !ctx.isGod10 &&
    ctx.loc <= 1500
  ) {
    pushItem(
      'wheel-consolidation',
      ctx.wheelDuplicates.length * 2.5 + ctx.reworkTouches14d,
      ctx.baselines.summaries.clones.available
        ? 'arch/clones-baseline.json'
        : '.github/file-size-baseline.json',
      `Duplicate utility definitions: ${ctx.wheelDuplicates.join(', ')}`,
      `Replace local ${ctx.wheelDuplicates.join('/')} in ${ctx.file} with @openclaude/kernel imports (<=5 files, zero behavior change).`,
    )
  }
  if (ctx.deadExports > 0 && !ctx.isGod10) {
    pushItem(
      'dead-code',
      ctx.deadExports * 2.2,
      'arch/violations-baseline.json',
      `${ctx.deadExports} unreferenced symbol/orphan module signal(s)`,
      `Remove unreferenced exports or dead module ${ctx.file} after verifying zero dynamic callers.`,
    )
  }
  if (ctx.r2ExportStar > 0) {
    pushItem(
      'r2-export-star',
      ctx.r2ExportStar * 2.8,
      'arch/violations-baseline.json',
      `${ctx.r2ExportStar} R2-export-star barrel wildcard re-export(s)`,
      `Replace export * in ${ctx.file} with explicit named exports and decrement arch/violations-baseline.json.`,
    )
  }
  if (ctx.r3Env > 0 && !ctx.isGod10) {
    pushItem(
      'r3-env',
      ctx.r3Env * 2.0 + ctx.reworkTouches14d,
      'arch/violations-baseline.json',
      `${ctx.r3Env} direct process.env read(s) outside platform-config`,
      `Inject typed config into ${ctx.file} instead of reading process.env directly and shrink R3-env baseline.`,
    )
  }
  const needsStrangler =
    ctx.inSizeBaseline || ctx.r2Coupling >= 3 || ctx.complexFunctions >= 2 || ctx.inFileCycle
  if (needsStrangler && !ctx.isGod10) {
    pushItem(
      'strangler-extract',
      ctx.r2Coupling * 1.6 +
        ctx.complexFunctions * 1.8 +
        (ctx.inSizeBaseline ? 3.0 : 0) +
        (ctx.inFileCycle ? 3.0 : 0),
      ctx.inSizeBaseline ? '.github/file-size-baseline.json' : 'arch/violations-baseline.json',
      `loc=${ctx.loc}, r2Coupling=${ctx.r2Coupling}, complexFns=${ctx.complexFunctions}, cycle=${ctx.inFileCycle}`,
      `Extract a pure leaf seam (<=300 net LOC, <=5 files) from ${ctx.file} and monotonically lower its baseline count.`,
    )
  }
}

function evaluateFileHotspot(
  file: string,
  scan: WorkspaceScan,
  baselines: ParsedBaselines,
  gitStats: GitChurnSnapshot,
  deadExportsByFile: ReadonlyMap<string, number>,
  inCycleSet: ReadonlySet<string>,
  top10GodSet: ReadonlySet<string>,
  hotspots: HotspotEntry[],
  candidates: PrioritizedDebtItem[],
): void {
  const loc = scan.fileLoc.get(file) ?? 0
  const touches60d = gitStats.touches60dByFile[file] ?? 0
  const touches14d = gitStats.touches14dByFile[file] ?? 0
  const reworkTouches14d = gitStats.rework14dByFile[file] ?? 0
  const violations = baselines.violationsByFile.get(file) ?? 0
  const r2ExportStar = baselines.r2ExportStarByFile.get(file) ?? 0
  const r3Env = baselines.r3EnvByFile.get(file) ?? 0
  const r2Coupling = baselines.r2CouplingByFile.get(file) ?? 0
  const aiSmells = baselines.aiSmellsByFile.get(file) ?? 0
  const complexFunctions = baselines.complexityByFile.get(file) ?? 0
  const clones = baselines.clonesByFile.get(file) ?? 0
  const inFileCycle = inCycleSet.has(file)
  const wheelDuplicates = scan.wheelSitesByFile.get(file) ?? []
  const explicitDead = deadExportsByFile.get(file) ?? 0
  const isOrphan =
    explicitDead === 0 &&
    (scan.inboundCount.get(file) ?? 0) === 0 &&
    !isEntrypointLike(file) &&
    touches60d === 0 &&
    loc > 20 &&
    loc <= 400
  const deadExports = explicitDead + (isOrphan ? 1 : 0)
  const inSizeBaseline = baselines.sizeBaselineFiles.has(file)

  const debtWeight = Number(
    (
      violations * 1.5 +
      r2ExportStar * 2.0 +
      r3Env * 1.4 +
      aiSmells * 0.8 +
      complexFunctions * 1.8 +
      clones * 1.5 +
      (inFileCycle ? 3.0 : 0) +
      wheelDuplicates.length * 1.6 +
      deadExports * 1.5 +
      (inSizeBaseline ? 2.5 : 0) +
      reworkTouches14d * 1.2
    ).toFixed(3),
  )
  if (debtWeight <= 0) return

  hotspots.push({
    file,
    loc,
    touches60d,
    touches14d,
    reworkTouches14d,
    debtWeight,
    magnetScore: computeMagnetScore(touches60d, loc, debtWeight),
    signals: {
      violations,
      r2ExportStar,
      r3Env,
      aiSmells,
      complexFunctions,
      clones,
      inFileCycle,
      wheelDuplicates,
      deadExports,
      inSizeBaseline,
    },
  })

  appendFileDebtCandidates({
    file,
    loc,
    touches60d,
    touches14d,
    reworkTouches14d,
    r2ExportStar,
    r3Env,
    r2Coupling,
    complexFunctions,
    inFileCycle,
    inSizeBaseline,
    wheelDuplicates,
    deadExports,
    isGod10: top10GodSet.has(file),
    baselines,
    out: candidates,
  })
}

export async function generateArchHealthSnapshot(
  options: SnapshotOptions,
): Promise<ArchHealthSnapshot> {
  const root = path.resolve(options.root)
  const now = options.now ?? new Date()
  const topN = options.topN ?? 20

  const prodFiles: string[] = []
  await collectProdFiles(root, 'packages', prodFiles)
  prodFiles.sort()

  const [baselines, gitStats, deadCodeRaw, scan] = await Promise.all([
    loadAllBaselines(root, now),
    options.gitStatsOverride
      ? Promise.resolve(options.gitStatsOverride)
      : collectGitStats(root, now),
    options.deadCodeJsonPath ? readJsonSafe(path.resolve(options.deadCodeJsonPath)) : null,
    scanWorkspaceFiles(root, prodFiles),
  ])

  const deadExportsByFile = parseDeadCodeJson(deadCodeRaw)
  const liveCycles = tarjanScc(scan.fileGraph)
  const inCycleSet = new Set<string>(baselines.cycleFilesFromBaseline)
  for (const comp of liveCycles) for (const member of comp) inCycleSet.add(member)

  const top10GodFiles = [...scan.fileLoc.entries()]
    .filter(([, loc]) => loc >= 2000)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([file, loc]) => ({ file, loc }))
  const top10GodSet = new Set(top10GodFiles.map((x) => x.file))

  const hotspots: HotspotEntry[] = []
  const candidates: PrioritizedDebtItem[] = []
  for (const f of prodFiles) {
    evaluateFileHotspot(
      f,
      scan,
      baselines,
      gitStats,
      deadExportsByFile,
      inCycleSet,
      top10GodSet,
      hotspots,
      candidates,
    )
  }

  hotspots.sort((a, b) => b.magnetScore - a.magnetScore || b.debtWeight - a.debtWeight)
  const reworkStatus: 'GREEN' | 'AMBER' | 'RED' =
    gitStats.reworkRate14d > 0.4 ? 'RED' : gitStats.reworkRate14d > 0.35 ? 'AMBER' : 'GREEN'

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    root,
    totals: {
      productionFiles: prodFiles.length,
      productionLoc: scan.totalLoc,
      packageLoc: scan.packageLoc,
      fileValueCycles: liveCycles.length,
      wheelDuplicateSites: scan.wheelDuplicateSites,
    },
    git14d: {
      totalCommits: gitStats.window14dCommits,
      reworkCommits: gitStats.window14dReworkCommits,
      reworkRate: gitStats.reworkRate14d,
      status: reworkStatus,
    },
    baselines: baselines.summaries,
    top10GodFiles,
    hotspots: hotspots.slice(0, 50),
    prioritizedDebtQueue: rankDebtCandidates(candidates, topN),
  }
}

function readFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  return idx >= 0 ? argv[idx + 1] : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const root = path.resolve(readFlag(argv, '--root') ?? defaultRoot)
  const outPath = readFlag(argv, '--out')
  const deadCodeJsonPath = readFlag(argv, '--dead-code-json')
  const nowArg = readFlag(argv, '--now')
  const topArg = readFlag(argv, '--top')

  const now = nowArg ? new Date(nowArg) : new Date()
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid --now timestamp: ${nowArg}`)
  const topN = topArg ? Math.max(1, Number.parseInt(topArg, 10)) : 20

  const snapshot = await generateArchHealthSnapshot({ root, now, topN, deadCodeJsonPath })
  if (outPath) {
    const absOut = path.resolve(outPath)
    await atomicWriteJson(absOut, snapshot)
    console.log(
      `[arch-health] wrote ${absOut}: prodLoc=${snapshot.totals.productionLoc} rework14d=${(snapshot.git14d.reworkRate * 100).toFixed(1)}% (${snapshot.git14d.status}) queue=${snapshot.prioritizedDebtQueue.length}`,
    )
  } else {
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`[arch-health] fatal: ${errMsg(err)}`)
    process.exit(2)
  })
}
