/**
 * 4 AI Code Smells Zero-Net-Increase Ratchet (OCV5-904).
 *
 * Uses the TypeScript Compiler AST & Scanner (zero regex-on-raw-text false positives
 * inside string literals) to scan production `.ts` / `.tsx` files across `packages/`
 * (excluding tests, `.d.ts`, `generated`, `fixtures`, and `agent-sandbox` skill templates):
 *   1. `emptyCatch`   : `catch` clause whose body has 0 executable statements (empty or comment-only)
 *   2. `typeEscape`   : `as any` (or `<any>`) and double-cast `as unknown as T`
 *   3. `syncIo`       : synchronous `fs` / `child_process` calls (`readFileSync`, `writeFileSync`,
 *                       `existsSync`, `statSync`, `readdirSync`, `mkdirSync`, `unlinkSync`,
 *                       `renameSync`, `appendFileSync`, `copyFileSync`, `rmSync`, `execSync`,
 *                       `execFileSync`, `spawnSync`, etc.)
 *   4. `lintSuppress` : actual JS/TS comments containing `eslint-disable` or `biome-ignore`
 *
 * Monotonic invariant (`arch/ai-smells-baseline.json`):
 *   - Per file × category count may NEVER exceed baseline (new/unlisted file baseline = 0).
 *   - Category totals and overall total may NEVER exceed baseline.
 *   - With `--base <ref>`, verifies baseline itself was not raised compared to `<ref>`.
 *
 * Usage:
 *   npx tsx scripts/check-ai-smells-ratchet.ts [--enforce] [--write-baseline] [--json]
 *                                              [--root <repo>] [--base <ref>] [--files <a,b>]
 *
 * Exit: 0 ok, 1 violations (in --enforce mode), 2 usage/missing-baseline error.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

export const BASELINE_PATH = 'arch/ai-smells-baseline.json'
export const SMELL_CATEGORIES = ['emptyCatch', 'typeEscape', 'syncIo', 'lintSuppress'] as const
export type SmellCategory = (typeof SMELL_CATEGORIES)[number]

export type SmellCounts = Record<SmellCategory, number>

export interface SmellHit {
  category: SmellCategory
  file: string
  line: number
  detail: string
}

export interface AiSmellsBaseline {
  schemaVersion: 1
  generatedAt: string
  note?: string
  categories: readonly SmellCategory[]
  totals: SmellCounts & { all: number }
  files: Record<string, SmellCounts>
}

export interface SmellViolation {
  kind: 'file-increased' | 'new-file-smell' | 'total-increased' | 'baseline-raised'
  file: string
  category: SmellCategory | 'all'
  actual: number
  allowed: number
  hits?: SmellHit[]
}

export const SYNC_IO_NAMES = new Set([
  'readFileSync',
  'writeFileSync',
  'existsSync',
  'statSync',
  'lstatSync',
  'fstatSync',
  'readdirSync',
  'mkdirSync',
  'rmdirSync',
  'unlinkSync',
  'renameSync',
  'appendFileSync',
  'copyFileSync',
  'cpSync',
  'rmSync',
  'chmodSync',
  'chownSync',
  'symlinkSync',
  'readlinkSync',
  'realpathSync',
  'accessSync',
  'openSync',
  'closeSync',
  'readSync',
  'writeSync',
  'truncateSync',
  'utimesSync',
  'mkdtempSync',
  'execSync',
  'execFileSync',
  'spawnSync',
])

const LINT_SUPPRESS_RE = /\b(?:eslint-disable(?:-(?:next-line|line))?|biome-ignore)\b/g

const EXCLUDE_PATTERNS = [
  /(^|\/)(node_modules|dist|dist-types|build|vendor|generated|__fixtures__|fixtures|__snapshots__|__tests__|__smoke__)\//,
  /\.d\.[cm]?ts$/,
  /\.(test|spec|integ\.test|node-test)\.[cm]?tsx?$/,
  /^claude-code-best\//,
  /^packages\/commercial\/agent-sandbox\//,
  /^packages\/web-react\/browser-tests\//,
  /(^|\/)agent-sandbox\/.*\/skills\//,
]

export function isAiSmellsProductionFile(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/')
  if (!/^packages\/(?:channels\/[^/]+|[^/]+)\/src\/.+\.(?:ts|tsx|mts|cts)$/.test(norm)) {
    return false
  }
  return !EXCLUDE_PATTERNS.some((re) => re.test(norm))
}

export function emptyCounts(): SmellCounts {
  return { emptyCatch: 0, typeEscape: 0, syncIo: 0, lintSuppress: 0 }
}

function unwrapParens(expr: ts.Expression): ts.Expression {
  let cur = expr
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression
  return cur
}

/**
 * AST + TS Scanner analysis of a single TS/TSX file.
 * Zero false positives inside string literals or template strings.
 */
export function scanSourceForAiSmells(filePath: string, sourceText: string): {
  counts: SmellCounts
  hits: SmellHit[]
} {
  const isTsx = /\.tsx$/i.test(filePath)
  const scriptKind = isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind)
  const counts = emptyCounts()
  const hits: SmellHit[] = []

  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1

  const record = (category: SmellCategory, pos: number, detail: string) => {
    counts[category]++
    hits.push({ category, file: filePath, line: lineOf(pos), detail })
  }

  // Track inner `as unknown` nodes that are already part of an outer `as unknown as T` double-cast
  const consumedInnerAs = new Set<ts.Node>()

  const visit = (node: ts.Node): void => {
    // 1. Empty catch blocks (0 executable statements; comments do not count as statements)
    if (ts.isCatchClause(node)) {
      if (node.block.statements.length === 0) {
        record('emptyCatch', node.getStart(sf), 'empty catch block (silently swallows error)')
      }
    }

    // 2. Type escapes: `as any`, `as unknown as T`, and `<any>expr`
    if (ts.isAsExpression(node) && !consumedInnerAs.has(node)) {
      const inner = unwrapParens(node.expression)
      if (ts.isAsExpression(inner) && inner.type.kind === ts.SyntaxKind.UnknownKeyword) {
        consumedInnerAs.add(inner)
        record('typeEscape', node.getStart(sf), 'double type cast (as unknown as ...)')
      } else if (node.type.kind === ts.SyntaxKind.AnyKeyword) {
        record('typeEscape', node.getStart(sf), 'explicit `as any` type escape')
      }
    } else if (ts.isTypeAssertionExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword) {
        record('typeEscape', node.getStart(sf), 'explicit `<any>` type escape')
      }
    }

    // 3. Synchronous fs / child_process I/O calls
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      let name: string | null = null
      if (ts.isIdentifier(callee)) {
        name = callee.text
      } else if (ts.isPropertyAccessExpression(callee)) {
        name = callee.name.text
      }
      if (name && SYNC_IO_NAMES.has(name)) {
        record('syncIo', node.getStart(sf), `synchronous I/O call ${name}()`)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)

  // 4. Lint/check suppression comments (strictly real JS/TS comments via TS scanner, never strings)
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    isTsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    sourceText,
  )
  let token = scanner.scan()
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const commentText = scanner.getTokenText()
      const tokenPos = scanner.getTokenPos()
      LINT_SUPPRESS_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = LINT_SUPPRESS_RE.exec(commentText)) !== null) {
        record('lintSuppress', tokenPos + m.index, `lint suppression comment (${m[0]})`)
      }
    }
    token = scanner.scan()
  }

  return { counts, hits }
}

export function collectProductionFiles(root: string): string[] {
  const pkgRoot = path.join(root, 'packages')
  if (!existsSync(pkgRoot)) return []
  const out: string[] = []

  const walk = (relDir: string) => {
    const absDir = path.join(root, relDir)
    if (!existsSync(absDir)) return
    for (const ent of readdirSync(absDir, { withFileTypes: true })) {
      if (
        ent.name === 'node_modules' ||
        ent.name === 'dist' ||
        ent.name === 'dist-types' ||
        ent.name === 'build' ||
        ent.name === 'generated' ||
        ent.name === '__tests__' ||
        ent.name === '__smoke__'
      ) {
        continue
      }
      const nextRel = `${relDir}/${ent.name}`
      if (ent.isDirectory()) {
        walk(nextRel)
      } else if (ent.isFile() && isAiSmellsProductionFile(nextRel)) {
        out.push(nextRel)
      }
    }
  }

  for (const pkg of readdirSync(pkgRoot).sort()) {
    if (pkg === 'channels') {
      const chRoot = path.join(pkgRoot, 'channels')
      if (existsSync(chRoot)) {
        for (const ch of readdirSync(chRoot).sort()) walk(`packages/channels/${ch}/src`)
      }
    } else {
      walk(`packages/${pkg}/src`)
    }
  }
  return out.sort()
}

export function sumCounts(filesMap: Record<string, SmellCounts>): SmellCounts & { all: number } {
  const totals = { emptyCatch: 0, typeEscape: 0, syncIo: 0, lintSuppress: 0, all: 0 }
  for (const c of Object.values(filesMap)) {
    for (const cat of SMELL_CATEGORIES) {
      totals[cat] += c[cat]
      totals.all += c[cat]
    }
  }
  return totals
}

export function scanRepository(
  root: string,
  explicitFiles?: readonly string[],
): {
  scannedFiles: number
  files: Record<string, SmellCounts>
  totals: SmellCounts & { all: number }
  hitsByFile: Map<string, SmellHit[]>
} {
  const relFiles = explicitFiles
    ? [...new Set(explicitFiles.map((f) => f.replace(/\\/g, '/')))]
        .filter((f) => isAiSmellsProductionFile(f) && existsSync(path.join(root, f)))
        .sort()
    : collectProductionFiles(root)

  const files: Record<string, SmellCounts> = {}
  const hitsByFile = new Map<string, SmellHit[]>()
  for (const rel of relFiles) {
    const text = readFileSync(path.join(root, rel), 'utf8')
    const { counts, hits } = scanSourceForAiSmells(rel, text)
    const nonZero = SMELL_CATEGORIES.some((cat) => counts[cat] > 0)
    if (nonZero) {
      files[rel] = counts
      hitsByFile.set(rel, hits)
    }
  }
  return {
    scannedFiles: relFiles.length,
    files,
    totals: sumCounts(files),
    hitsByFile,
  }
}

export function parseBaseline(raw: unknown): AiSmellsBaseline {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${BASELINE_PATH} must be a JSON object`)
  }
  const obj = raw as Partial<AiSmellsBaseline>
  if (obj.schemaVersion !== 1 || !obj.files || typeof obj.files !== 'object' || !obj.totals) {
    throw new Error(`${BASELINE_PATH} must have schemaVersion=1, totals, and files`)
  }
  for (const [file, counts] of Object.entries(obj.files)) {
    if (!counts || typeof counts !== 'object') {
      throw new Error(`${BASELINE_PATH}: invalid counts for ${file}`)
    }
    for (const cat of SMELL_CATEGORIES) {
      const v = (counts as Record<string, unknown>)[cat]
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new Error(`${BASELINE_PATH}: ${file}.${cat} must be a non-negative integer`)
      }
    }
  }
  return obj as AiSmellsBaseline
}

export function compareAgainstBaseline(
  actualFiles: Record<string, SmellCounts>,
  baseline: AiSmellsBaseline,
  hitsByFile?: Map<string, SmellHit[]>,
  opts?: { checkTotals?: boolean },
): SmellViolation[] {
  const violations: SmellViolation[] = []
  const actualTotals = sumCounts(actualFiles)

  for (const [file, actual] of Object.entries(actualFiles)) {
    const base = baseline.files[file]
    for (const cat of SMELL_CATEGORIES) {
      const allowed = base ? base[cat] : 0
      if (actual[cat] > allowed) {
        violations.push({
          kind: base ? 'file-increased' : 'new-file-smell',
          file,
          category: cat,
          actual: actual[cat],
          allowed,
          hits: hitsByFile?.get(file)?.filter((h) => h.category === cat),
        })
      }
    }
  }

  if (opts?.checkTotals !== false) {
    for (const cat of SMELL_CATEGORIES) {
      if (actualTotals[cat] > baseline.totals[cat]) {
        violations.push({
          kind: 'total-increased',
          file: BASELINE_PATH,
          category: cat,
          actual: actualTotals[cat],
          allowed: baseline.totals[cat],
        })
      }
    }
    if (actualTotals.all > baseline.totals.all) {
      violations.push({
        kind: 'total-increased',
        file: BASELINE_PATH,
        category: 'all',
        actual: actualTotals.all,
        allowed: baseline.totals.all,
      })
    }
  }
  return violations
}

export function compareBaselineMonotonic(
  base: AiSmellsBaseline,
  head: AiSmellsBaseline,
): SmellViolation[] {
  const violations: SmellViolation[] = []
  for (const [file, headCounts] of Object.entries(head.files)) {
    const baseCounts = base.files[file]
    for (const cat of SMELL_CATEGORIES) {
      const allowed = baseCounts ? baseCounts[cat] : 0
      if (headCounts[cat] > allowed) {
        violations.push({
          kind: 'baseline-raised',
          file,
          category: cat,
          actual: headCounts[cat],
          allowed,
        })
      }
    }
  }
  for (const cat of SMELL_CATEGORIES) {
    if (head.totals[cat] > base.totals[cat]) {
      violations.push({
        kind: 'baseline-raised',
        file: BASELINE_PATH,
        category: cat,
        actual: head.totals[cat],
        allowed: base.totals[cat],
      })
    }
  }
  return violations
}

function readGitFileAt(root: string, ref: string, rel: string): string | null {
  const r = spawnSync('git', ['-C', root, 'show', `${ref}:${rel}`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  if (r.status !== 0) return null
  return r.stdout
}

function main(argv: string[]): number {
  let root = ''
  let enforce = false
  let writeBaseline = false
  let asJson = false
  let base = ''
  let explicitFiles: string[] | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--root') root = argv[++i] ?? ''
    else if (arg === '--enforce') enforce = true
    else if (arg === '--write-baseline') writeBaseline = true
    else if (arg === '--json') asJson = true
    else if (arg === '--base') base = argv[++i] ?? ''
    else if (arg === '--files') {
      const raw = argv[++i] ?? ''
      explicitFiles = raw.split(',').map((s) => s.trim()).filter(Boolean)
    } else {
      console.error(`unknown arg: ${arg}`)
      return 2
    }
  }

  let repoRoot: string
  try {
    repoRoot = root
      ? path.resolve(root)
      : execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  } catch (err) {
    console.error(`[check-ai-smells-ratchet] git root error: ${(err as Error).message}`)
    return 2
  }

  const scan = scanRepository(repoRoot, explicitFiles)
  const baselineAbs = path.join(repoRoot, BASELINE_PATH)

  if (writeBaseline) {
    if (explicitFiles) {
      console.error('--write-baseline cannot be combined with --files')
      return 2
    }
    const nextBaseline: AiSmellsBaseline = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString().slice(0, 10),
      note: 'Zero-net-increase ratchet for 4 AI code smells (emptyCatch, typeEscape, syncIo, lintSuppress). Monotonic shrink-only per file and in total (OCV5-904).',
      categories: SMELL_CATEGORIES,
      totals: scan.totals,
      files: scan.files,
    }
    mkdirSync(path.dirname(baselineAbs), { recursive: true })
    writeFileSync(baselineAbs, `${JSON.stringify(nextBaseline, null, 2)}\n`)
    if (asJson) {
      console.log(JSON.stringify({ wrote: BASELINE_PATH, scannedFiles: scan.scannedFiles, totals: scan.totals, filesWithSmells: Object.keys(scan.files).length }, null, 2))
    } else {
      console.log(
        `ai-smells baseline written to ${BASELINE_PATH}: ${scan.scannedFiles} files scanned, ${Object.keys(scan.files).length} files with smells, totals=${JSON.stringify(scan.totals)}`,
      )
    }
    return 0
  }

  if (!existsSync(baselineAbs)) {
    console.error(`[check-ai-smells-ratchet] missing baseline: ${BASELINE_PATH}`)
    return 2
  }

  let headBaseline: AiSmellsBaseline
  try {
    headBaseline = parseBaseline(JSON.parse(readFileSync(baselineAbs, 'utf8')))
  } catch (err) {
    console.error(`[check-ai-smells-ratchet] invalid baseline: ${(err as Error).message}`)
    return 2
  }

  const violations: SmellViolation[] = compareAgainstBaseline(
    scan.files,
    headBaseline,
    scan.hitsByFile,
    { checkTotals: !explicitFiles },
  )

  if (base) {
    const baseText = readGitFileAt(repoRoot, base, BASELINE_PATH)
    if (baseText !== null) {
      try {
        const baseBaseline = parseBaseline(JSON.parse(baseText))
        violations.push(...compareBaselineMonotonic(baseBaseline, headBaseline))
      } catch (err) {
        console.error(`[check-ai-smells-ratchet] invalid base baseline at ${base}: ${(err as Error).message}`)
        return 2
      }
    }
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: violations.length === 0,
          enforce,
          scannedFiles: scan.scannedFiles,
          totals: scan.totals,
          baselineTotals: headBaseline.totals,
          violations,
        },
        null,
        2,
      ),
    )
    return enforce && violations.length > 0 ? 1 : 0
  }

  for (const v of violations) {
    const locs = (v.hits ?? []).slice(0, 5).map((h) => `${h.file}:${h.line} (${h.detail})`).join('; ')
    console.log(`::error file=${v.file}::AI smell ${v.category} increased: ${v.actual} > ${v.allowed} (${v.kind})`)
    console.error(
      [
        `[GATE-ERROR] AI-SMELLS-RATCHET (${v.kind}) at ${v.file}`,
        `  Violation : ${v.category} count is ${v.actual}; baseline cap is ${v.allowed}`,
        ...(locs ? [`  Locations : ${locs}`] : []),
        `  How to Fix: Remove the newly introduced ${v.category} smell (handle errors explicitly, use proper narrowing instead of \`as any\`/\`as unknown as\`, use async fs/process APIs, fix root lint issue instead of suppressing).`,
        '  Re-verify : npx tsx scripts/check-ai-smells-ratchet.ts --enforce',
      ].join('\n'),
    )
  }

  console.log(
    `ai-smells ratchet: ${scan.scannedFiles} production TS/TSX files scanned, totals=${JSON.stringify(scan.totals)} (baseline all=${headBaseline.totals.all}), ${violations.length} violations`,
  )
  return enforce && violations.length > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
