/**
 * Incremental 12-Line Cross-File Clone Zero-Net-Growth Gate (OCV5-905).
 *
 * Zero-dependency TypeScript scanner sliding window (12 normalized logical lines,
 * comments/whitespace stripped, static imports skipped, string/number literals normalized,
 * 64-bit SMI dual-32 pre-hash + SHA-256 cluster verification) to detect cross-file duplicate
 * blocks across production `.ts`/`.tsx` files.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export const WINDOW_LINES = 12
export const MIN_WINDOW_TOKENS = 20
export const BASELINE_REL_PATH = 'arch/clones-baseline.json'

export interface LogicalLine {
  line: number
  norm: string
  tokenCount: number
  h1: number
  h2: number
}

export interface CloneOccurrence {
  file: string
  startLine: number
  endLine: number
}

export interface CloneCluster {
  hash: string
  files: number
  instances: number
  occurrences: CloneOccurrence[]
}

export interface CloneScanResult {
  scannedFiles: number
  windowLines: number
  totalClusters: number
  totalInstances: number
  clusters: Map<string, CloneCluster>
}

export interface BaselineClusterEntry {
  files: number
  instances: number
}

export interface ClonesBaseline {
  schemaVersion: 1
  windowLines: number
  summary: {
    scannedFiles: number
    totalClusters: number
    totalInstances: number
  }
  topHotspots: Array<{
    hash: string
    files: number
    instances: number
    locations: string[]
  }>
  clusters: Record<string, BaselineClusterEntry>
}

export interface CloneViolation {
  kind: 'new-clone-cluster' | 'clone-cluster-grown' | 'baseline-raised'
  hash: string
  files: number
  instances: number
  allowedFiles: number
  allowedInstances: number
  locations: string[]
  detail: string
}

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-types',
  'build',
  'coverage',
  '.git',
  '.vite',
  '.cache',
  'generated',
  '__tests__',
  '__smoke__',
  'test',
  'tests',
  'browser-tests',
  'fixtures',
  '__fixtures__',
  '__snapshots__',
  'vendor',
])

export function isProductionTsFile(relPosix: string): boolean {
  const norm = relPosix.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!/\.(ts|tsx)$/.test(norm) || /\.d\.ts$/.test(norm)) return false
  if (/\.(test|spec|integ\.test|node-test)\.(ts|tsx)$/.test(norm)) return false
  if (
    /(^|\/)(node_modules|dist|dist-types|build|coverage|generated|__tests__|__smoke__|test|tests|browser-tests|fixtures|__fixtures__|__snapshots__|vendor)\//.test(
      norm,
    )
  ) {
    return false
  }
  if (/^claude-code-best\//.test(norm) || /^packages\/[^/]+\/agent-sandbox\//.test(norm)) {
    return false
  }
  return !/(^|\/)agent-sandbox\/(platform-runtime|ccb-baseline|runtime|templates|skills)\//.test(
    norm,
  )
}

function walkProdDir(root: string, relDir: string, out: string[]): void {
  const abs = path.join(root, relDir)
  if (!existsSync(abs)) return
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue
    const nextRel = `${relDir}/${ent.name}`
    if (ent.isDirectory()) walkProdDir(root, nextRel, out)
    else if (ent.isFile() && isProductionTsFile(nextRel)) out.push(nextRel)
  }
}

export function discoverProductionFiles(root: string): string[] {
  const out: string[] = []
  const pkgRoot = path.join(root, 'packages')
  if (existsSync(pkgRoot)) {
    for (const pkg of readdirSync(pkgRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      if (pkg.name === 'channels') {
        const chRoot = path.join(pkgRoot, 'channels')
        if (existsSync(chRoot)) {
          for (const ch of readdirSync(chRoot, { withFileTypes: true })) {
            if (ch.isDirectory()) walkProdDir(root, `packages/channels/${ch.name}/src`, out)
          }
        }
      } else {
        walkProdDir(root, `packages/${pkg.name}/src`, out)
      }
    }
  } else if (existsSync(path.join(root, 'src'))) {
    walkProdDir(root, 'src', out)
  }
  return out.sort()
}

function normalizeToken(kind: ts.SyntaxKind, scanner: ts.Scanner): string {
  switch (kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return '$S'
    case ts.SyntaxKind.TemplateHead:
      return '$TH'
    case ts.SyntaxKind.TemplateMiddle:
      return '$TM'
    case ts.SyntaxKind.TemplateTail:
      return '$TT'
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
      return '$N'
    default:
      return scanner.getTokenText()
  }
}

function dualHash32(s: string): [number, number] {
  let h1 = 0x811c9dc5 | 0
  let h2 = 0x27d4eb2d | 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca6b)
  }
  return [h1 >>> 0, h2 >>> 0]
}

export function normalizeTsLogicalLines(file: string, sourceText: string): LogicalLine[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    sourceText,
  )
  const lineEnds: number[] = []
  for (let i = 0; i < sourceText.length; i++) {
    if (sourceText.charCodeAt(i) === 10) lineEnds.push(i)
  }
  lineEnds.push(sourceText.length)

  let curLineIdx = 0
  const lineTokens = new Map<number, string[]>()
  let inStaticImport = false
  let importBraceDepth = 0

  let kind = scanner.scan()
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    const pos = scanner.getTokenStart()
    while (curLineIdx < lineEnds.length - 1 && pos > lineEnds[curLineIdx]!) curLineIdx++
    const lineNum = curLineIdx + 1

    if (!inStaticImport && kind === ts.SyntaxKind.ImportKeyword) {
      let p = scanner.getTextPos()
      while (p < sourceText.length && (sourceText[p] === ' ' || sourceText[p] === '\t')) p++
      if (sourceText[p] !== '(' && sourceText[p] !== '.') {
        inStaticImport = true
        importBraceDepth = 0
      }
    }
    if (inStaticImport) {
      if (kind === ts.SyntaxKind.OpenBraceToken) importBraceDepth++
      else if (kind === ts.SyntaxKind.CloseBraceToken && importBraceDepth > 0) importBraceDepth--
      else if (
        importBraceDepth === 0 &&
        (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.SemicolonToken)
      ) {
        inStaticImport = false
      }
      kind = scanner.scan()
      continue
    }

    let arr = lineTokens.get(lineNum)
    if (!arr) {
      arr = []
      lineTokens.set(lineNum, arr)
    }
    arr.push(normalizeToken(kind, scanner))
    kind = scanner.scan()
  }

  const out: LogicalLine[] = []
  for (const [line, toks] of lineTokens) {
    const norm = toks.join(' ')
    const [h1, h2] = dualHash32(norm)
    out.push({ line, norm, tokenCount: toks.length, h1, h2 })
  }
  return out
}

/** Pure 32-bit V8 SMI combination packed into IEEE-754 safe 53-bit integer key (zero BigInt GC!). */
function windowFastKey(lines: LogicalLine[], start: number, windowLines: number): number {
  let a = 0x9e3779b9 | 0
  let b = 0xc2b2ae35 | 0
  for (let k = 0; k < windowLines; k++) {
    const ln = lines[start + k]!
    a = Math.imul(a ^ ln.h1, 0x01000193)
    b = Math.imul(b ^ ln.h2, 0x27d4eb2f)
  }
  return (a >>> 0) * 2097152 + (b >>> 11)
}

function sha256Window(lines: LogicalLine[], start: number, windowLines: number): string {
  const h = createHash('sha256')
  for (let k = 0; k < windowLines; k++) {
    if (k > 0) h.update('\n')
    h.update(lines[start + k]!.norm)
  }
  return h.digest('hex')
}

export function detectCrossFileClones(
  files: Array<{ file: string; text: string }>,
  windowLines = WINDOW_LINES,
  candidateFilterFiles?: Set<string>,
): CloneScanResult {
  const parsed: Array<{ file: string; lines: LogicalLine[] }> = []
  let filterFastKeys: Set<number> | null = null

  if (candidateFilterFiles) {
    filterFastKeys = new Set<number>()
    for (const item of files) {
      if (!candidateFilterFiles.has(item.file)) continue
      const lines = normalizeTsLogicalLines(item.file, item.text)
      parsed.push({ file: item.file, lines })
      if (lines.length < windowLines) continue
      let tokSum = 0
      for (let i = 0; i < lines.length; i++) {
        tokSum += lines[i]!.tokenCount
        if (i >= windowLines) tokSum -= lines[i - windowLines]!.tokenCount
        if (i >= windowLines - 1 && tokSum >= MIN_WINDOW_TOKENS) {
          filterFastKeys.add(windowFastKey(lines, i - windowLines + 1, windowLines))
        }
      }
    }
    if (filterFastKeys.size === 0) {
      return { scannedFiles: files.length, windowLines, totalClusters: 0, totalInstances: 0, clusters: new Map() }
    }
    for (const item of files) {
      if (!candidateFilterFiles.has(item.file)) {
        parsed.push({ file: item.file, lines: normalizeTsLogicalLines(item.file, item.text) })
      }
    }
  } else {
    for (const item of files) {
      parsed.push({ file: item.file, lines: normalizeTsLogicalLines(item.file, item.text) })
    }
  }

  const fastBuckets = new Map<number, Array<{ fileIdx: number; startIdx: number }>>()
  for (let fileIdx = 0; fileIdx < parsed.length; fileIdx++) {
    const { lines } = parsed[fileIdx]!
    if (lines.length < windowLines) continue
    let tokSum = 0
    for (let i = 0; i < lines.length; i++) {
      tokSum += lines[i]!.tokenCount
      if (i >= windowLines) tokSum -= lines[i - windowLines]!.tokenCount
      if (i < windowLines - 1 || tokSum < MIN_WINDOW_TOKENS) continue
      const startIdx = i - windowLines + 1
      const fk = windowFastKey(lines, startIdx, windowLines)
      if (filterFastKeys && !filterFastKeys.has(fk)) continue
      let bucket = fastBuckets.get(fk)
      if (!bucket) {
        bucket = []
        fastBuckets.set(fk, bucket)
      }
      bucket.push({ fileIdx, startIdx })
    }
  }

  const shaGroups = new Map<string, CloneOccurrence[]>()
  for (const refs of fastBuckets.values()) {
    if (refs.length < 2) continue
    const firstFile = refs[0]!.fileIdx
    let multiFile = false
    for (let i = 1; i < refs.length; i++) {
      if (refs[i]!.fileIdx !== firstFile) {
        multiFile = true
        break
      }
    }
    if (!multiFile) continue
    for (const ref of refs) {
      const p = parsed[ref.fileIdx]!
      const digest = sha256Window(p.lines, ref.startIdx, windowLines)
      let occs = shaGroups.get(digest)
      if (!occs) {
        occs = []
        shaGroups.set(digest, occs)
      }
      occs.push({
        file: p.file,
        startLine: p.lines[ref.startIdx]!.line,
        endLine: p.lines[ref.startIdx + windowLines - 1]!.line,
      })
    }
  }

  const clusters = new Map<string, CloneCluster>()
  let totalInstances = 0
  for (const [hash, occs] of [...shaGroups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const distinctFiles = new Set(occs.map((o) => o.file))
    if (distinctFiles.size < 2) continue
    if (candidateFilterFiles && ![...distinctFiles].some((f) => candidateFilterFiles.has(f))) continue
    occs.sort((a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.startLine - b.startLine))
    clusters.set(hash, { hash, files: distinctFiles.size, instances: occs.length, occurrences: occs })
    totalInstances += occs.length
  }

  return { scannedFiles: files.length, windowLines, totalClusters: clusters.size, totalInstances, clusters }
}

export function buildClonesBaseline(scan: CloneScanResult): ClonesBaseline {
  const clustersObj: Record<string, BaselineClusterEntry> = {}
  for (const [hash, c] of scan.clusters) clustersObj[hash] = { files: c.files, instances: c.instances }

  const seenFilePairs = new Set<string>()
  const topHotspots: ClonesBaseline['topHotspots'] = []
  const sortedByBreadth = [...scan.clusters.values()].sort(
    (a, b) => b.files - a.files || b.instances - a.instances || (a.hash < b.hash ? -1 : 1),
  )
  for (const c of sortedByBreadth) {
    const fileSetKey = [...new Set(c.occurrences.map((o) => o.file))].sort().join('|')
    if (seenFilePairs.has(fileSetKey)) continue
    seenFilePairs.add(fileSetKey)
    topHotspots.push({
      hash: c.hash,
      files: c.files,
      instances: c.instances,
      locations: c.occurrences.slice(0, 6).map((o) => `${o.file}:${o.startLine}-${o.endLine}`),
    })
    if (topHotspots.length >= 40) break
  }

  return {
    schemaVersion: 1,
    windowLines: scan.windowLines,
    summary: {
      scannedFiles: scan.scannedFiles,
      totalClusters: scan.totalClusters,
      totalInstances: scan.totalInstances,
    },
    topHotspots,
    clusters: clustersObj,
  }
}

export function parseClonesBaseline(raw: unknown): ClonesBaseline {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('clones baseline must be a JSON object')
  }
  const obj = raw as Partial<ClonesBaseline>
  if (
    obj.schemaVersion !== 1 ||
    !Number.isInteger(obj.windowLines) ||
    !obj.summary ||
    !Number.isInteger(obj.summary.totalClusters) ||
    !Number.isInteger(obj.summary.totalInstances) ||
    typeof obj.clusters !== 'object' ||
    obj.clusters === null
  ) {
    throw new Error('invalid clones baseline schema')
  }
  for (const [k, v] of Object.entries(obj.clusters)) {
    if (!v || !Number.isInteger(v.files) || !Number.isInteger(v.instances)) {
      throw new Error(`invalid cluster entry "${k}" in clones baseline`)
    }
  }
  return obj as ClonesBaseline
}

export function evaluateClonesRatchet(scan: CloneScanResult, baseline: ClonesBaseline): CloneViolation[] {
  const violations: CloneViolation[] = []
  for (const [hash, cluster] of scan.clusters) {
    const baseEntry = baseline.clusters[hash]
    const locs = cluster.occurrences.slice(0, 6).map((o) => `${o.file}:${o.startLine}-${o.endLine}`)
    if (!baseEntry) {
      violations.push({
        kind: 'new-clone-cluster',
        hash,
        files: cluster.files,
        instances: cluster.instances,
        allowedFiles: 0,
        allowedInstances: 0,
        locations: locs,
        detail: `new ${scan.windowLines}-line cross-file clone (${cluster.files} files, ${cluster.instances} instances): ${locs.join(' <-> ')}`,
      })
    } else if (cluster.files > baseEntry.files || cluster.instances > baseEntry.instances) {
      violations.push({
        kind: 'clone-cluster-grown',
        hash,
        files: cluster.files,
        instances: cluster.instances,
        allowedFiles: baseEntry.files,
        allowedInstances: baseEntry.instances,
        locations: locs,
        detail: `existing clone cluster ${hash.slice(0, 12)} grew (${baseEntry.files}/${baseEntry.instances} -> ${cluster.files}/${cluster.instances}): ${locs.join(' <-> ')}`,
      })
    }
  }
  return violations
}

export function compareClonesBaselines(base: ClonesBaseline, head: ClonesBaseline): CloneViolation[] {
  const violations: CloneViolation[] = []
  if (
    head.summary.totalClusters > base.summary.totalClusters ||
    head.summary.totalInstances > base.summary.totalInstances
  ) {
    violations.push({
      kind: 'baseline-raised',
      hash: '<summary>',
      files: head.summary.totalClusters,
      instances: head.summary.totalInstances,
      allowedFiles: base.summary.totalClusters,
      allowedInstances: base.summary.totalInstances,
      locations: [BASELINE_REL_PATH],
      detail: `${BASELINE_REL_PATH} totals increased (clusters ${base.summary.totalClusters} -> ${head.summary.totalClusters}, instances ${base.summary.totalInstances} -> ${head.summary.totalInstances})`,
    })
  }
  for (const [hash, hv] of Object.entries(head.clusters)) {
    const bv = base.clusters[hash]
    if (!bv || hv.files > bv.files || hv.instances > bv.instances) {
      violations.push({
        kind: 'baseline-raised',
        hash,
        files: hv.files,
        instances: hv.instances,
        allowedFiles: bv?.files ?? 0,
        allowedInstances: bv?.instances ?? 0,
        locations: [BASELINE_REL_PATH],
        detail: !bv
          ? `new clone hash ${hash.slice(0, 12)} added to ${BASELINE_REL_PATH}`
          : `clone hash ${hash.slice(0, 12)} count raised in ${BASELINE_REL_PATH}`,
      })
    }
  }
  return violations
}

function readGitFile(root: string, ref: string, relPath: string): string | null {
  const r = spawnSync('git', ['-C', root, 'show', `${ref}:${relPath}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) {
    if (/does not exist in|exists on disk, but not in/.test(r.stderr)) return null
    throw new Error(`git show ${ref}:${relPath} failed: ${r.stderr.trim().split('\n')[0]}`)
  }
  return r.stdout
}

function changedProdFilesSince(root: string, baseRef: string): Set<string> {
  const committed = execFileSync(
    'git',
    ['-C', root, 'diff', '-z', '--name-only', '--diff-filter=AMR', `${baseRef}...HEAD`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean)
  const unstaged = execFileSync(
    'git',
    ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
    .split('\0')
    .filter(Boolean)
    .map((e) => e.slice(3))

  const out = new Set<string>()
  for (const rel of [...committed, ...unstaged]) {
    if (isProductionTsFile(rel) && existsSync(path.join(root, rel))) out.add(rel)
  }
  return out
}

export function main(argv = process.argv.slice(2)): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let baselineRel = BASELINE_REL_PATH
  let writeBaseline = false
  let updateBaseline = false
  let enforce = false
  let changedOnly = false
  let baseRef = ''
  let jsonOut: string | boolean = false
  const rawFiles: string[] = []

  const argErr = (msg: string): number => {
    console.error(`[clones-ratchet] ${msg}`)
    return 2
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--root') {
      const v = argv[++i]
      if (!v) return argErr('--root requires a path')
      root = path.resolve(v)
    } else if (arg === '--baseline') {
      const v = argv[++i]
      if (!v) return argErr('--baseline requires a path')
      baselineRel = v
    } else if (arg === '--write-baseline') writeBaseline = true
    else if (arg === '--update-baseline') updateBaseline = true
    else if (arg === '--enforce') enforce = true
    else if (arg === '--changed-only') changedOnly = true
    else if (arg === '--base') {
      const v = argv[++i]
      if (!v) return argErr('--base requires a git ref')
      baseRef = v
    } else if (arg === '--files') {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) rawFiles.push(argv[++i]!)
    } else if (arg.startsWith('--files=')) rawFiles.push(arg.slice('--files='.length))
    else if (arg === '--json') {
      jsonOut = i + 1 < argv.length && !argv[i + 1]!.startsWith('--') ? argv[++i]! : true
    } else return argErr(`unknown argument: ${arg}`)
  }

  try {
    const baselineAbs = path.isAbsolute(baselineRel) ? baselineRel : path.join(root, baselineRel)
    const allRelFiles = discoverProductionFiles(root)
    const loadAllFiles = () =>
      allRelFiles.map((file) => ({ file, text: readFileSync(path.join(root, file), 'utf8') }))

    if (writeBaseline) {
      const scan = detectCrossFileClones(loadAllFiles(), WINDOW_LINES)
      const built = buildClonesBaseline(scan)
      mkdirSync(path.dirname(baselineAbs), { recursive: true })
      writeFileSync(baselineAbs, `${JSON.stringify(built, null, 2)}\n`)
      console.log(
        `[clones-ratchet] wrote ${baselineRel}: ${scan.scannedFiles} files scanned, ${scan.totalClusters} cross-file ${WINDOW_LINES}-line clone clusters (${scan.totalInstances} instances)`,
      )
      return 0
    }
    if (!existsSync(baselineAbs)) {
      console.error(`[clones-ratchet] FAIL-CLOSED: missing baseline ${baselineRel}`)
      return 2
    }
    const headBaseline = parseClonesBaseline(JSON.parse(readFileSync(baselineAbs, 'utf8')))

    if (updateBaseline) {
      const scan = detectCrossFileClones(loadAllFiles(), headBaseline.windowLines)
      const nextClusters: Record<string, BaselineClusterEntry> = {}
      let totalInstances = 0
      for (const [hash, was] of Object.entries(headBaseline.clusters)) {
        const cur = scan.clusters.get(hash)
        if (!cur) continue
        const entry = { files: Math.min(was.files, cur.files), instances: Math.min(was.instances, cur.instances) }
        nextClusters[hash] = entry
        totalInstances += entry.instances
      }
      const updated: ClonesBaseline = {
        ...buildClonesBaseline(scan),
        summary: { scannedFiles: scan.scannedFiles, totalClusters: Object.keys(nextClusters).length, totalInstances },
        clusters: nextClusters,
      }
      writeFileSync(baselineAbs, `${JSON.stringify(updated, null, 2)}\n`)
      console.log(
        `[clones-ratchet] updated ${baselineRel}: ${headBaseline.summary.totalClusters} -> ${updated.summary.totalClusters} clusters`,
      )
      return 0
    }

    const violations: CloneViolation[] = []
    if (baseRef) {
      execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${baseRef}^{commit}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const baseText = readGitFile(root, baseRef, baselineRel)
      if (baseText !== null) {
        violations.push(...compareClonesBaselines(parseClonesBaseline(JSON.parse(baseText)), headBaseline))
      }
    }

    let filterSet: Set<string> | undefined
    if (rawFiles.length > 0) {
      filterSet = new Set(
        rawFiles
          .flatMap((x) => x.split(','))
          .map((x) => path.relative(root, path.resolve(root, x.trim())).replace(/\\/g, '/'))
          .filter((rel) => isProductionTsFile(rel) && existsSync(path.join(root, rel))),
      )
    } else if (changedOnly) {
      if (!baseRef) {
        console.error('[clones-ratchet] --changed-only requires --base <git-ref> or --files <list>')
        return 2
      }
      filterSet = changedProdFilesSince(root, baseRef)
    }

    const scan =
      filterSet && filterSet.size === 0
        ? { scannedFiles: 0, windowLines: headBaseline.windowLines, totalClusters: 0, totalInstances: 0, clusters: new Map<string, CloneCluster>() }
        : detectCrossFileClones(loadAllFiles(), headBaseline.windowLines, filterSet)

    violations.push(...evaluateClonesRatchet(scan, headBaseline))

    const report = {
      mode: filterSet ? 'incremental' : 'full',
      scannedFiles: scan.scannedFiles,
      changedFiles: filterSet ? filterSet.size : undefined,
      activeClusters: scan.totalClusters,
      baselinedClusters: headBaseline.summary.totalClusters,
      violations,
    }
    if (typeof jsonOut === 'string') {
      mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true })
      writeFileSync(path.resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`)
    } else if (jsonOut === true) {
      console.log(JSON.stringify(report, null, 2))
      return enforce && violations.length > 0 ? 1 : 0
    }
    for (const v of violations.slice(0, 25)) {
      console.error(
        `[GATE-ERROR] CLONES-RATCHET (${v.kind})\n  Violation : ${v.detail}\n  How to Fix: Extract shared helper instead of copy-pasting >= ${headBaseline.windowLines} logical lines across files.`,
      )
    }
    console.log(
      `[clones-ratchet] mode=${report.mode} files=${scan.scannedFiles} clusters=${scan.totalClusters} baselined=${headBaseline.summary.totalClusters} violations=${violations.length}`,
    )
    return enforce && violations.length > 0 ? 1 : 0
  } catch (err) {
    console.error(`[clones-ratchet] FAIL-CLOSED: ${(err as Error).message}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
