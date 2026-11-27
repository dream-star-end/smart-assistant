/**
 * Baseline loaders, git churn collectors, and workspace dependency/wheel scanners
 * for `scripts/gardening/arch-health-snapshot.ts` (OCV5-905).
 */

import { execFile } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { asRecord, isRecord } from '../../packages/kernel/src/index.js'

const execFileAsync = promisify(execFile)

export interface BaselineStatusSummary {
  available: boolean
  path: string
  totalCount: number
  fileCount: number
}

export interface AllBaselineSummaries {
  violations: BaselineStatusSummary
  fileSize: BaselineStatusSummary
  aiSmells: BaselineStatusSummary
  complexity: BaselineStatusSummary
  clones: BaselineStatusSummary
  fileCycles: BaselineStatusSummary
}

export interface GitChurnSnapshot {
  window14dCommits: number
  window14dReworkCommits: number
  reworkRate14d: number
  touches14dByFile: Record<string, number>
  rework14dByFile: Record<string, number>
  touches60dByFile: Record<string, number>
}

export interface ParsedBaselines {
  summaries: AllBaselineSummaries
  violationsByFile: Map<string, number>
  r2ExportStarByFile: Map<string, number>
  r3EnvByFile: Map<string, number>
  r2CouplingByFile: Map<string, number>
  sizeBaselineFiles: Map<string, number>
  aiSmellsByFile: Map<string, number>
  complexityByFile: Map<string, number>
  clonesByFile: Map<string, number>
  cycleFilesFromBaseline: Set<string>
  ttlUrgencyByRule: Record<string, number>
  expiredExceptionFiles: Set<string>
}

export interface WorkspaceScan {
  fileLoc: Map<string, number>
  packageLoc: Record<string, number>
  fileGraph: Map<string, Set<string>>
  inboundCount: Map<string, number>
  wheelSitesByFile: Map<string, string[]>
  totalLoc: number
  wheelDuplicateSites: number
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-types',
  'build',
  '.git',
  'coverage',
  '.vite',
  '.cache',
  '__tests__',
  '__smoke__',
])

const WHEEL_FN_NAMES = [
  'sha256Hex',
  'asRecord',
  'isRecord',
  'errMsg',
  'sleep',
  'atomicWriteJson',
  'readBoundedJson',
  'sendJson',
] as const

const WHEEL_DEF_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = WHEEL_FN_NAMES.map(
  (name) => ({
    name,
    re: new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b|(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\s*=`,
      'g',
    ),
  }),
)

export function isProdTsFile(rel: string): boolean {
  return (
    /\.(ts|tsx)$/.test(rel) &&
    !/\.d\.ts$/.test(rel) &&
    !/\.(test|spec)\.(ts|tsx)$/.test(rel) &&
    !/(^|\/)(__tests__|__smoke__|browser-tests)\//.test(rel)
  )
}

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath)
    return true
  } catch (err: unknown) {
    void err
    return false
  }
}

export async function readJsonSafe(absPath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(absPath, 'utf8')) as unknown
  } catch (err: unknown) {
    void err
    return null
  }
}

export async function collectProdFiles(root: string, relDir: string, out: string[]): Promise<void> {
  const abs = path.join(root, relDir)
  if (!(await pathExists(abs))) return
  const entries = await readdir(abs, { withFileTypes: true })
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue
    const rel = relDir ? `${relDir}/${ent.name}` : ent.name
    if (ent.isDirectory()) await collectProdFiles(root, rel, out)
    else if (ent.isFile() && isProdTsFile(rel)) out.push(rel)
  }
}

function countLines(text: string): number {
  if (!text.length) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** Blank comments while preserving string literals so import/wheel regexes ignore comments. */
export function stripCodeComments(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]!
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' '
        i++
      }
    } else if (c === '/' && d === '*') {
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c
      out += c
      i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') {
          out += src[i]! + (src[i + 1] ?? '')
          i += 2
          continue
        }
        if (q !== '`' && src[i] === '\n') break
        out += src[i]!
        i++
      }
      if (i < n) out += src[i++]!
    } else {
      out += c
      i++
    }
  }
  return out
}

function scanRelativeValueImports(strippedCode: string): string[] {
  const specs: string[] = []
  const staticRe =
    /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([\w$*\s{},]*?)\s*from\s*(['"])(\.[^'"\n]+)\4/g
  for (const m of strippedCode.matchAll(staticRe)) {
    if (m[1] === 'export' && !/^[{*]/.test((m[3] ?? '').trim())) continue
    if (!m[2]) specs.push(m[5]!)
  }
  const sideRe = /(?:^|[;\n}])\s*import\s+(['"])(\.[^'"\n]+)\1/g
  for (const m of strippedCode.matchAll(sideRe)) specs.push(m[2]!)
  return specs
}

function resolveInSet(fromFile: string, spec: string, knownFiles: ReadonlySet<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec))
  const noJs = base.replace(/\.(?:m|c)?js$/, '')
  for (const cand of [
    base,
    `${noJs}.ts`,
    `${noJs}.tsx`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (knownFiles.has(cand)) return cand
  }
  return null
}

/** Iterative Tarjan strongly-connected components (aligned with `scripts/arch-measure/lib.mjs`). */
export function tarjanScc(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const comps: string[][] = []

  for (const start of graph.keys()) {
    if (idx.has(start)) continue
    const work: Array<{ node: string; succ: string[]; pos: number }> = [
      { node: start, succ: [...(graph.get(start) ?? [])], pos: 0 },
    ]
    idx.set(start, index)
    low.set(start, index)
    index++
    stack.push(start)
    onStack.add(start)

    while (work.length > 0) {
      const frame = work[work.length - 1]!
      if (frame.pos < frame.succ.length) {
        const w = frame.succ[frame.pos++]!
        if (!graph.has(w)) continue
        if (!idx.has(w)) {
          idx.set(w, index)
          low.set(w, index)
          index++
          stack.push(w)
          onStack.add(w)
          work.push({ node: w, succ: [...(graph.get(w) ?? [])], pos: 0 })
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, idx.get(w)!))
        }
      } else {
        work.pop()
        if (work.length > 0) {
          const parent = work[work.length - 1]!.node
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!))
        }
        if (low.get(frame.node) === idx.get(frame.node)) {
          const comp: string[] = []
          let popped = ''
          do {
            popped = stack.pop()!
            onStack.delete(popped)
            comp.push(popped)
          } while (popped !== frame.node)
          if (comp.length > 1) comps.push(comp.sort())
        }
      }
    }
  }
  return comps
}

function addMapCount(map: Map<string, number>, key: string, delta: number): void {
  if (key && delta > 0) map.set(key, (map.get(key) ?? 0) + delta)
}

function extractPerFileCounts(raw: unknown): Map<string, number> {
  const out = new Map<string, number>()
  const obj = asRecord(raw)
  if (!obj) return out
  const container =
    asRecord(obj.entries) ??
    asRecord(obj.files) ??
    asRecord(obj.byFile) ??
    asRecord(obj.functions) ??
    obj
  for (const [key, val] of Object.entries(container)) {
    if (key === 'schema' || key === 'schemaVersion' || key === 'note' || key === 'generatedAt') {
      continue
    }
    const fileKey = key.includes('::') ? key.split('::')[0]! : key.split('|')[0]!
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      addMapCount(out, fileKey, val)
    } else if (isRecord(val)) {
      const sum = Object.values(val).filter((v) => typeof v === 'number' && v > 0).length
      addMapCount(out, fileKey, Math.max(1, sum))
    } else if (Array.isArray(val) && val.length > 0) {
      addMapCount(out, fileKey, val.length)
    }
  }
  return out
}

function parseClonesBaseline(clonesRaw: unknown): { byFile: Map<string, number>; total: number } {
  const byFile = new Map<string, number>()
  if (!isRecord(clonesRaw)) return { byFile, total: 0 }
  if (Array.isArray(clonesRaw.clusters)) {
    for (const cl of clonesRaw.clusters) {
      const rec = asRecord(cl)
      const locs = Array.isArray(rec?.locations)
        ? rec.locations
        : Array.isArray(rec?.files)
          ? rec.files
          : []
      for (const loc of locs) {
        const f = typeof loc === 'string' ? loc : (asRecord(loc)?.file as string | undefined)
        if (typeof f === 'string') addMapCount(byFile, f, 1)
      }
    }
    return { byFile, total: clonesRaw.clusters.length }
  }
  let total = 0
  for (const [f, c] of extractPerFileCounts(clonesRaw)) {
    addMapCount(byFile, f, c)
    total += c
  }
  if (typeof clonesRaw.count === 'number') total = clonesRaw.count
  return { byFile, total }
}

function parseCyclesBaseline(cyclesRaw: unknown): { files: Set<string>; count: number } {
  const files = new Set<string>()
  if (!isRecord(cyclesRaw)) return { files, count: 0 }
  const arr = Array.isArray(cyclesRaw.cycles)
    ? cyclesRaw.cycles
    : Object.keys(asRecord(cyclesRaw.entries) ?? {})
  for (const item of arr) {
    if (typeof item === 'string') {
      for (const f of item.split(/\s*(?:->|→|\+|\|)\s*/)) {
        if (isProdTsFile(f)) files.add(f)
      }
    } else if (Array.isArray(item)) {
      for (const f of item) if (typeof f === 'string') files.add(f)
    } else if (isRecord(item) && Array.isArray(item.files)) {
      for (const f of item.files) if (typeof f === 'string') files.add(f)
    }
  }
  return { files, count: arr.length }
}

async function loadCoreBaselines(root: string) {
  const violationsByFile = new Map<string, number>()
  const r2ExportStarByFile = new Map<string, number>()
  const r3EnvByFile = new Map<string, number>()
  const r2CouplingByFile = new Map<string, number>()
  const violRel = 'arch/violations-baseline.json'
  const violEntries = asRecord(asRecord(await readJsonSafe(path.join(root, violRel)))?.entries)
  let violTotal = 0
  if (violEntries) {
    for (const [k, v] of Object.entries(violEntries)) {
      if (typeof v !== 'number' || v <= 0) continue
      const [rule, file] = k.split('|')
      if (!rule || !file) continue
      violTotal += v
      addMapCount(violationsByFile, file, v)
      if (rule === 'R2-export-star') addMapCount(r2ExportStarByFile, file, v)
      else if (rule === 'R3-env') addMapCount(r3EnvByFile, file, v)
      else if (rule.startsWith('R2-')) addMapCount(r2CouplingByFile, file, v)
    }
  }

  const sizeRel = (await pathExists(path.join(root, '.github/file-size-baseline.json')))
    ? '.github/file-size-baseline.json'
    : 'arch/file-size-baseline.json'
  const sizeJson = asRecord(await readJsonSafe(path.join(root, sizeRel)))
  const sizeBaselineFiles = new Map<string, number>()
  if (sizeJson) {
    for (const bucket of ['files', 'yellowZoneFiles', 'orangeZoneFiles']) {
      for (const [f, loc] of Object.entries(asRecord(sizeJson[bucket]) ?? {})) {
        if (typeof loc === 'number' && loc > 0 && isProdTsFile(f)) sizeBaselineFiles.set(f, loc)
      }
    }
  }
  return {
    violAvailable: violEntries !== null,
    violRel,
    violTotal,
    violationsByFile,
    r2ExportStarByFile,
    r3EnvByFile,
    r2CouplingByFile,
    sizeAvailable: sizeJson !== null,
    sizeRel,
    sizeBaselineFiles,
  }
}

export async function loadAllBaselines(root: string, now: Date): Promise<ParsedBaselines> {
  const core = await loadCoreBaselines(root)
  const [smellsRaw, compRaw, clonesRaw, cyclesRaw, ttlRaw, excRaw] = await Promise.all([
    readJsonSafe(path.join(root, 'arch/ai-smells-baseline.json')),
    readJsonSafe(path.join(root, 'arch/complexity-baseline.json')),
    readJsonSafe(path.join(root, 'arch/clones-baseline.json')),
    readJsonSafe(path.join(root, 'arch/file-cycles-baseline.json')),
    readJsonSafe(path.join(root, 'arch/debt-ttl-policy.json')),
    readJsonSafe(path.join(root, '.github/file-size-ratchet-exceptions.json')),
  ])

  const aiSmellsByFile = smellsRaw ? extractPerFileCounts(smellsRaw) : new Map<string, number>()
  const complexityByFile = compRaw ? extractPerFileCounts(compRaw) : new Map<string, number>()
  const parsedClones = parseClonesBaseline(clonesRaw)
  const parsedCycles = parseCyclesBaseline(cyclesRaw)

  const ttlUrgencyByRule: Record<string, number> = {
    'r2-export-star': 1.35,
    'wheel-consolidation': 1.25,
    'r3-env': 1.2,
    'dead-code': 1.15,
    'strangler-extract': 1.3,
  }
  for (const [k, v] of Object.entries(asRecord(asRecord(ttlRaw)?.urgencyWeights) ?? {})) {
    if (typeof v === 'number' && v > 0) ttlUrgencyByRule[k] = v
  }

  const expiredExceptionFiles = new Set<string>()
  const exceptions = asRecord(excRaw)?.exceptions
  if (Array.isArray(exceptions)) {
    for (const ex of exceptions) {
      const rec = asRecord(ex)
      const exp = typeof rec?.expiresAt === 'string' ? Date.parse(rec.expiresAt) : Number.NaN
      if (typeof rec?.file === 'string' && Number.isFinite(exp) && exp <= now.getTime()) {
        expiredExceptionFiles.add(rec.file)
      }
    }
  }
  const sumValues = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0)

  return {
    summaries: {
      violations: {
        available: core.violAvailable,
        path: core.violRel,
        totalCount: core.violTotal,
        fileCount: core.violationsByFile.size,
      },
      fileSize: {
        available: core.sizeAvailable,
        path: core.sizeRel,
        totalCount: core.sizeBaselineFiles.size,
        fileCount: core.sizeBaselineFiles.size,
      },
      aiSmells: {
        available: smellsRaw !== null,
        path: 'arch/ai-smells-baseline.json',
        totalCount: sumValues(aiSmellsByFile),
        fileCount: aiSmellsByFile.size,
      },
      complexity: {
        available: compRaw !== null,
        path: 'arch/complexity-baseline.json',
        totalCount: sumValues(complexityByFile),
        fileCount: complexityByFile.size,
      },
      clones: {
        available: clonesRaw !== null,
        path: 'arch/clones-baseline.json',
        totalCount: parsedClones.total,
        fileCount: parsedClones.byFile.size,
      },
      fileCycles: {
        available: cyclesRaw !== null,
        path: 'arch/file-cycles-baseline.json',
        totalCount: parsedCycles.count,
        fileCount: parsedCycles.files.size,
      },
    },
    violationsByFile: core.violationsByFile,
    r2ExportStarByFile: core.r2ExportStarByFile,
    r3EnvByFile: core.r3EnvByFile,
    r2CouplingByFile: core.r2CouplingByFile,
    sizeBaselineFiles: core.sizeBaselineFiles,
    aiSmellsByFile,
    complexityByFile,
    clonesByFile: parsedClones.byFile,
    cycleFilesFromBaseline: parsedCycles.files,
    ttlUrgencyByRule,
    expiredExceptionFiles,
  }
}

const REWORK_SUBJECT_RE = /^(?:fix|bug|revert)(?:\([^)]+\))?!?:|\b(?:hotfix|rollback)\b/i

export async function collectGitStats(root: string, now: Date): Promise<GitChurnSnapshot> {
  const since14d = new Date(now.getTime() - 14 * 24 * 3600 * 1000).toISOString()
  const since60d = new Date(now.getTime() - 60 * 24 * 3600 * 1000).toISOString()
  const touches14dByFile: Record<string, number> = {}
  const rework14dByFile: Record<string, number> = {}
  const touches60dByFile: Record<string, number> = {}
  let window14dCommits = 0
  let window14dReworkCommits = 0

  try {
    const { stdout: out14 } = await execFileAsync(
      'git',
      ['log', `--since=${since14d}`, '--no-merges', '--pretty=format:__COMMIT__%s', '--name-only'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    )
    let currentIsRework = false
    for (const rawLine of out14.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('__COMMIT__')) {
        window14dCommits++
        currentIsRework = REWORK_SUBJECT_RE.test(line.slice('__COMMIT__'.length))
        if (currentIsRework) window14dReworkCommits++
      } else if (isProdTsFile(line)) {
        touches14dByFile[line] = (touches14dByFile[line] ?? 0) + 1
        if (currentIsRework) rework14dByFile[line] = (rework14dByFile[line] ?? 0) + 1
      }
    }

    const { stdout: out60 } = await execFileAsync(
      'git',
      ['log', `--since=${since60d}`, '--no-merges', '--pretty=format:', '--name-only'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    )
    for (const rawLine of out60.split('\n')) {
      const line = rawLine.trim()
      if (line && isProdTsFile(line)) touches60dByFile[line] = (touches60dByFile[line] ?? 0) + 1
    }
  } catch (gitErr: unknown) {
    void gitErr
  }

  const reworkRate14d =
    window14dCommits > 0 ? Number((window14dReworkCommits / window14dCommits).toFixed(4)) : 0
  return {
    window14dCommits,
    window14dReworkCommits,
    reworkRate14d,
    touches14dByFile,
    rework14dByFile,
    touches60dByFile,
  }
}

export async function scanWorkspaceFiles(root: string, prodFiles: string[]): Promise<WorkspaceScan> {
  const knownFiles = new Set(prodFiles)
  const fileLoc = new Map<string, number>()
  const packageLoc: Record<string, number> = {}
  const fileGraph = new Map<string, Set<string>>()
  const inboundCount = new Map<string, number>()
  const wheelSitesByFile = new Map<string, string[]>()
  let totalLoc = 0
  let wheelDuplicateSites = 0

  for (const f of prodFiles) {
    const src = await readFile(path.join(root, f), 'utf8')
    const loc = countLines(src)
    fileLoc.set(f, loc)
    totalLoc += loc

    const parts = f.split('/')
    const pkgKey =
      parts[1] === 'channels' ? `channels/${parts[2] ?? 'unknown'}` : (parts[1] ?? 'other')
    packageLoc[pkgKey] = (packageLoc[pkgKey] ?? 0) + loc

    const stripped = stripCodeComments(src)
    const outSet = new Set<string>()
    for (const spec of scanRelativeValueImports(stripped)) {
      const target = resolveInSet(f, spec, knownFiles)
      if (target && target !== f) {
        outSet.add(target)
        inboundCount.set(target, (inboundCount.get(target) ?? 0) + 1)
      }
    }
    fileGraph.set(f, outSet)

    if (!f.startsWith('packages/kernel/src/')) {
      const wheels: string[] = []
      for (const pat of WHEEL_DEF_PATTERNS) {
        if (pat.re.test(stripped)) wheels.push(pat.name)
        pat.re.lastIndex = 0
      }
      if (wheels.length > 0) {
        wheelSitesByFile.set(f, wheels)
        wheelDuplicateSites += wheels.length
      }
    }
  }
  return {
    fileLoc,
    packageLoc,
    fileGraph,
    inboundCount,
    wheelSitesByFile,
    totalLoc,
    wheelDuplicateSites,
  }
}

export function parseDeadCodeJson(deadCodeRaw: unknown): Map<string, number> {
  const deadExportsByFile = new Map<string, number>()
  if (!isRecord(deadCodeRaw)) return deadExportsByFile
  const symbols = Array.isArray(deadCodeRaw.unusedExports)
    ? deadCodeRaw.unusedExports
    : Array.isArray(deadCodeRaw.items)
      ? deadCodeRaw.items
      : []
  for (const sym of symbols) {
    const f = asRecord(sym)?.file
    if (typeof f === 'string') addMapCount(deadExportsByFile, f, 1)
  }
  if (Array.isArray(deadCodeRaw.orphanFiles)) {
    for (const f of deadCodeRaw.orphanFiles) {
      if (typeof f === 'string') addMapCount(deadExportsByFile, f, 2)
    }
  }
  return deadExportsByFile
}
