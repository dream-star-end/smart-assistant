/**
 * Weekly Incremental Mutation Testing Spot-Checker (OCV5-906).
 *
 * Selects recently modified T2 core files (last `--days 7` via git log, or explicit `--files`),
 * generates controlled TypeScript AST mutations (comparison boundaries, boolean literals,
 * logical operators `&&`/`||`, and conditional negations), and executes each mutant's target
 * unit tests in an isolated `/tmp` ESM loader hook so the git working tree is NEVER modified.
 *
 * Usage:
 *   npx tsx scripts/check-mutation-weekly.ts [--root <dir>] [--days <n>]
 *     [--files a.ts,b.ts] [--test-files t1.test.ts,t2.test.ts]
 *     [--min-score 0.60] [--max-mutants 20] [--timeout-ms 30000]
 *     [--dry-run] [--json] [--out <report.json>]
 *
 * Exit: 0 pass (or --dry-run / 0 testable mutants), 1 score < minScore, 2 usage/IO error.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const require = createRequire(import.meta.url)

export const DEFAULT_DAYS = 7
export const DEFAULT_MIN_SCORE = 0.6
export const DEFAULT_MAX_MUTANTS = 20
export const DEFAULT_TIMEOUT_MS = 30_000

/** High-blast-radius T2 core paths eligible for weekly mutation spot-checks. */
export const T2_CORE_FILE_RE =
  /^packages\/(?:commercial\/src\/(?:billing|auth|org|dispatch|db)\/.+|gateway\/src\/(?:turnDispatch|delegateCutover|delegateJobs|runtimeRecycleDrain|execEnv\/|masterTurnLease).*|storage\/src\/(?:sessionsDb|sessionFileIo|jsonl|authorityGeneration).*|kernel\/src\/.+)\.ts$/

export interface MutantCandidate {
  id: string
  file: string
  line: number
  column: number
  operator: string
  original: string
  mutated: string
  start: number
  end: number
}

export interface MutantRunResult {
  id: string
  file: string
  line: number
  operator: string
  original: string
  mutated: string
  testFiles: string[]
  status: 'killed' | 'survived' | 'timeout' | 'dry_run'
  durationMs: number
}

export interface WeeklyMutationReport {
  schema: 1
  dryRun: boolean
  days: number
  minScore: number
  filesSelected: string[]
  filesWithoutTests: string[]
  totalMutants: number
  killed: number
  survived: number
  timedOut: number
  mutationScore: number
  passed: boolean
  mutants: MutantRunResult[]
}

const BINARY_MUTATIONS = new Map<ts.SyntaxKind, { op: string; replacement: string }>([
  [ts.SyntaxKind.GreaterThanEqualsToken, { op: 'boundary_gte_to_gt', replacement: '>' }],
  [ts.SyntaxKind.GreaterThanToken, { op: 'boundary_gt_to_gte', replacement: '>=' }],
  [ts.SyntaxKind.LessThanEqualsToken, { op: 'boundary_lte_to_lt', replacement: '<' }],
  [ts.SyntaxKind.LessThanToken, { op: 'boundary_lt_to_lte', replacement: '<=' }],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, { op: 'equality_strict_invert', replacement: '!==' }],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, { op: 'inequality_strict_invert', replacement: '===' }],
  [ts.SyntaxKind.AmpersandAmpersandToken, { op: 'logical_and_to_or', replacement: '||' }],
  [ts.SyntaxKind.BarBarToken, { op: 'logical_or_to_and', replacement: '&&' }],
])

function isInsideTypeNode(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (
      ts.isTypeNode(cur) ||
      ts.isInterfaceDeclaration(cur) ||
      ts.isTypeAliasDeclaration(cur) ||
      ts.isImportDeclaration(cur) ||
      ts.isExportDeclaration(cur)
    ) {
      return true
    }
    cur = cur.parent
  }
  return false
}

/**
 * Generates deterministic AST-level mutants for comparison boundaries, logical operators,
 * boolean literals, and `if` conditions. Never mutates comments, strings, imports, or types.
 */
export function generateAstMutants(
  relFile: string,
  sourceText: string,
  maxPerFile = 12,
): MutantCandidate[] {
  const sf = ts.createSourceFile(relFile, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const raw: MutantCandidate[] = []

  const add = (
    node: ts.Node,
    operator: string,
    start: number,
    end: number,
    mutated: string,
  ) => {
    const pos = sf.getLineAndCharacterOfPosition(start)
    raw.push({
      id: `${relFile}:${pos.line + 1}:${pos.character + 1}:${operator}`,
      file: relFile,
      line: pos.line + 1,
      column: pos.character + 1,
      operator,
      original: sourceText.slice(start, end),
      mutated,
      start,
      end,
    })
  }

  const visit = (node: ts.Node) => {
    if (isInsideTypeNode(node)) return

    if (ts.isBinaryExpression(node)) {
      const mut = BINARY_MUTATIONS.get(node.operatorToken.kind)
      if (mut) {
        add(
          node.operatorToken,
          mut.op,
          node.operatorToken.getStart(sf),
          node.operatorToken.getEnd(),
          mut.replacement,
        )
      }
    } else if (ts.isIfStatement(node)) {
      const condStart = node.expression.getStart(sf)
      const condEnd = node.expression.getEnd()
      const origExpr = sourceText.slice(condStart, condEnd)
      if (origExpr.length > 0 && origExpr.length <= 120) {
        add(node.expression, 'if_cond_negate', condStart, condEnd, `!(${origExpr})`)
      }
    } else if (
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword
    ) {
      // Mutate boolean literals in returns, conditionals, and variable initializers.
      const p = node.parent
      if (
        p &&
        (ts.isReturnStatement(p) ||
          ts.isConditionalExpression(p) ||
          ts.isBinaryExpression(p) ||
          ts.isVariableDeclaration(p))
      ) {
        const isTrue = node.kind === ts.SyntaxKind.TrueKeyword
        add(
          node,
          isTrue ? 'bool_true_to_false' : 'bool_false_to_true',
          node.getStart(sf),
          node.getEnd(),
          isTrue ? 'false' : 'true',
        )
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)
  if (raw.length <= maxPerFile) return raw

  // Deterministic stride sampling to cover the full file evenly.
  const sampled: MutantCandidate[] = []
  const step = raw.length / maxPerFile
  for (let i = 0; i < maxPerFile; i += 1) {
    sampled.push(raw[Math.floor(i * step)]!)
  }
  return sampled
}

export function applyMutantToSource(sourceText: string, mutant: MutantCandidate): string {
  return sourceText.slice(0, mutant.start) + mutant.mutated + sourceText.slice(mutant.end)
}

export function isEligibleT2CoreFile(relPath: string): boolean {
  const norm = relPath.split(path.sep).join('/')
  if (!T2_CORE_FILE_RE.test(norm)) return false
  if (norm.includes('/__tests__/')) return false
  if (/\.(test|spec|integ\.test|d)\.ts$/.test(norm)) return false
  return true
}

export function findRecentT2CoreFiles(root: string, days = DEFAULT_DAYS): string[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'log', `--since=${days} days ago`, '--name-only', '--pretty=format:'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    )
    const unique = new Set<string>()
    for (const line of out.split('\n')) {
      const rel = line.trim()
      if (!rel) continue
      if (isEligibleT2CoreFile(rel) && existsSync(path.join(root, rel))) {
        unique.add(rel)
      }
    }
    return [...unique].sort()
  } catch {
    return []
  }
}

/** Discovers unit test files matching a production source file stem (excludes `.integ.test.ts`). */
export function discoverTargetUnitTests(root: string, relFile: string): string[] {
  const abs = path.join(root, relFile)
  const dir = path.dirname(abs)
  const stem = path.basename(relFile, '.ts')
  const candidates = new Set<string>()

  const siblingTest = path.join(dir, `${stem}.test.ts`)
  if (existsSync(siblingTest)) {
    candidates.add(path.relative(root, siblingTest).split(path.sep).join('/'))
  }

  // Search nearest `__tests__` directory and package `src/__tests__`.
  const searchDirs = [path.join(dir, '__tests__')]
  const pkgMatch = /^(packages\/(?:channels\/[^/]+|[^/]+)\/src)\//.exec(
    relFile.split(path.sep).join('/'),
  )
  if (pkgMatch) {
    searchDirs.push(path.join(root, pkgMatch[1]!, '__tests__'))
  }

  const lowerStem = stem.toLowerCase()
  for (const sdir of searchDirs) {
    if (!existsSync(sdir)) continue
    for (const entry of readdirSync(sdir)) {
      if (!entry.endsWith('.test.ts') || entry.endsWith('.integ.test.ts')) continue
      const entryLower = entry.toLowerCase()
      if (entryLower.includes(lowerStem)) {
        candidates.add(path.relative(root, path.join(sdir, entry)).split(path.sep).join('/'))
      }
    }
  }
  return [...candidates].sort()
}

function resolveTsxCommand(): { cmd: string; prefixArgs: string[] } {
  try {
    const pkgPath = require.resolve('tsx/package.json')
    const cliPath = path.join(path.dirname(pkgPath), 'dist', 'cli.mjs')
    if (existsSync(cliPath)) {
      return { cmd: process.execPath, prefixArgs: [cliPath] }
    }
  } catch {
    // Fallback to npx below
  }
  return { cmd: 'npx', prefixArgs: ['tsx'] }
}

function createIsolatedLoaderHarness(tmpDir: string): { runnerPath: string } {
  const loaderPath = path.join(tmpDir, 'mutation-loader.mjs')
  const runnerPath = path.join(tmpDir, 'mutation-runner.mjs')

  // ESM load hook for `"type": "module"` packages (intercepts exact target file URL).
  writeFileSync(
    loaderPath,
    [
      "import { readFileSync } from 'node:fs'",
      'const TARGET_URL = process.env.OC_MUTATION_TARGET_URL',
      'const COMPILED_PATH = process.env.OC_MUTATION_COMPILED_PATH',
      'export async function load(url, context, nextLoad) {',
      "  const clean = typeof url === 'string' ? url.split('?')[0] : ''",
      '  if (TARGET_URL && COMPILED_PATH && clean === TARGET_URL) {',
      "    return { format: 'module', source: readFileSync(COMPILED_PATH, 'utf8'), shortCircuit: true }",
      '  }',
      '  return nextLoad(url, context)',
      '}',
    ].join('\n'),
  )

  // Single-process test runner: installs both ESM `load` hook and CJS/tsx virtual
  // read overlay for ONLY the target file before importing test modules directly.
  // Never mutates any file in the working tree and avoids `NODE_OPTIONS` recursion.
  writeFileSync(
    runnerPath,
    [
      "import fs from 'node:fs'",
      "import path from 'node:path'",
      "import { register } from 'node:module'",
      "import { pathToFileURL } from 'node:url'",
      'const TARGET_ABS = process.env.OC_MUTATION_TARGET_ABS',
      'const MUTATED_TS_PATH = process.env.OC_MUTATION_TS_PATH',
      'if (TARGET_ABS && MUTATED_TS_PATH) {',
      '  const mutatedBuf = fs.readFileSync(MUTATED_TS_PATH)',
      '  const origReadFileSync = fs.readFileSync',
      '  const matchesTarget = (p) => {',
      "    if (typeof p === 'string') return path.resolve(p) === TARGET_ABS",
      '    if (p instanceof URL && p.protocol === "file:") return path.resolve(p.pathname) === TARGET_ABS',
      '    return false',
      '  }',
      '  fs.readFileSync = function patchedReadFileSync(filePath, options) {',
      '    if (matchesTarget(filePath)) {',
      "      if (typeof options === 'string') return mutatedBuf.toString(options)",
      "      if (options && typeof options === 'object' && options.encoding) return mutatedBuf.toString(options.encoding)",
      '      return Buffer.from(mutatedBuf)',
      '    }',
      '    return origReadFileSync.apply(this, arguments)',
      '  }',
      '  const origReadFile = fs.promises.readFile',
      '  fs.promises.readFile = async function patchedReadFile(filePath, options) {',
      '    if (matchesTarget(filePath)) {',
      "      if (typeof options === 'string') return mutatedBuf.toString(options)",
      "      if (options && typeof options === 'object' && options.encoding) return mutatedBuf.toString(options.encoding)",
      '      return Buffer.from(mutatedBuf)',
      '    }',
      '    return origReadFile.apply(this, arguments)',
      '  }',
      '}',
      "register(new URL('./mutation-loader.mjs', import.meta.url), import.meta.url)",
      'for (const tf of process.argv.slice(2)) {',
      '  await import(pathToFileURL(path.resolve(tf)).href)',
      '}',
    ].join('\n'),
  )

  return { runnerPath }
}

/**
 * Executes a single mutant in an isolated child process using an in-memory / `/tmp`
 * runner + ESM `load` hook. Never writes to the repository working tree.
 */
export function runMutantIsolated(opts: {
  root: string
  relFile: string
  sourceText: string
  mutant: MutantCandidate
  testFiles: readonly string[]
  timeoutMs: number
  tmpDir: string
  runnerPath: string
}): MutantRunResult {
  const startMs = Date.now()
  const mutatedSource = applyMutantToSource(opts.sourceText, opts.mutant)
  const transpiled = ts.transpileModule(mutatedSource, {
    fileName: opts.relFile,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      sourceMap: false,
    },
  })

  const tag = Buffer.from(opts.mutant.id).toString('hex').slice(0, 24)
  const mutatedTsPath = path.join(opts.tmpDir, `mutant-${tag}.ts`)
  const compiledPath = path.join(opts.tmpDir, `mutant-${tag}.mjs`)
  writeFileSync(mutatedTsPath, mutatedSource, 'utf8')
  writeFileSync(compiledPath, transpiled.outputText, 'utf8')

  const targetAbs = path.resolve(opts.root, opts.relFile)
  const targetUrl = pathToFileURL(targetAbs).href
  const tsxCmd = resolveTsxCommand()
  const proc = spawnSync(
    tsxCmd.cmd,
    [...tsxCmd.prefixArgs, opts.runnerPath, ...opts.testFiles],
    {
      cwd: opts.root,
      env: {
        ...process.env,
        OC_MUTATION_TARGET_ABS: targetAbs,
        OC_MUTATION_TS_PATH: mutatedTsPath,
        OC_MUTATION_TARGET_URL: targetUrl,
        OC_MUTATION_COMPILED_PATH: compiledPath,
        PBT_RUNS: process.env.PBT_RUNS ?? '50',
      },
      timeout: opts.timeoutMs,
      encoding: 'utf8',
    },
  )

  const durationMs = Date.now() - startMs
  if (proc.error && (proc.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return {
      id: opts.mutant.id,
      file: opts.relFile,
      line: opts.mutant.line,
      operator: opts.mutant.operator,
      original: opts.mutant.original,
      mutated: opts.mutant.mutated,
      testFiles: [...opts.testFiles],
      status: 'timeout',
      durationMs,
    }
  }

  return {
    id: opts.mutant.id,
    file: opts.relFile,
    line: opts.mutant.line,
    operator: opts.mutant.operator,
    original: opts.mutant.original,
    mutated: opts.mutant.mutated,
    testFiles: [...opts.testFiles],
    status: proc.status === 0 ? 'survived' : 'killed',
    durationMs,
  }
}

export function runWeeklyMutationCheck(opts: {
  root: string
  days?: number
  files?: readonly string[]
  testFilesOverride?: readonly string[]
  minScore?: number
  maxMutants?: number
  timeoutMs?: number
  dryRun?: boolean
}): WeeklyMutationReport {
  const days = opts.days ?? DEFAULT_DAYS
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE
  const maxMutants = opts.maxMutants ?? DEFAULT_MAX_MUTANTS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const dryRun = opts.dryRun ?? false

  const filesSelected =
    opts.files && opts.files.length > 0
      ? [...opts.files].map((f) => f.split(path.sep).join('/'))
      : findRecentT2CoreFiles(opts.root, days)

  const filesWithoutTests: string[] = []
  const workQueue: Array<{
    relFile: string
    sourceText: string
    mutant: MutantCandidate
    testFiles: string[]
  }> = []

  const perFileCap = Math.max(1, Math.ceil(maxMutants / Math.max(1, filesSelected.length)))
  for (const relFile of filesSelected) {
    const abs = path.join(opts.root, relFile)
    if (!existsSync(abs)) continue
    const testFiles =
      opts.testFilesOverride && opts.testFilesOverride.length > 0
        ? [...opts.testFilesOverride]
        : discoverTargetUnitTests(opts.root, relFile)
    if (testFiles.length === 0) {
      filesWithoutTests.push(relFile)
      continue
    }
    const sourceText = readFileSync(abs, 'utf8')
    const mutants = generateAstMutants(relFile, sourceText, perFileCap)
    for (const mutant of mutants) {
      if (workQueue.length >= maxMutants) break
      workQueue.push({ relFile, sourceText, mutant, testFiles })
    }
    if (workQueue.length >= maxMutants) break
  }

  const results: MutantRunResult[] = []
  if (dryRun) {
    for (const item of workQueue) {
      results.push({
        id: item.mutant.id,
        file: item.relFile,
        line: item.mutant.line,
        operator: item.mutant.operator,
        original: item.mutant.original,
        mutated: item.mutant.mutated,
        testFiles: item.testFiles,
        status: 'dry_run',
        durationMs: 0,
      })
    }
    return {
      schema: 1,
      dryRun: true,
      days,
      minScore,
      filesSelected,
      filesWithoutTests,
      totalMutants: results.length,
      killed: 0,
      survived: 0,
      timedOut: 0,
      mutationScore: 1,
      passed: true,
      mutants: results,
    }
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'oc-mutation-weekly-'))
  try {
    const { runnerPath } = createIsolatedLoaderHarness(tmpDir)
    for (const item of workQueue) {
      results.push(
        runMutantIsolated({
          root: opts.root,
          relFile: item.relFile,
          sourceText: item.sourceText,
          mutant: item.mutant,
          testFiles: item.testFiles,
          timeoutMs,
          tmpDir,
          runnerPath,
        }),
      )
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  const killed = results.filter((r) => r.status === 'killed' || r.status === 'timeout').length
  const survived = results.filter((r) => r.status === 'survived').length
  const timedOut = results.filter((r) => r.status === 'timeout').length
  const totalMutants = results.length
  const mutationScore = totalMutants === 0 ? 1 : killed / totalMutants
  const passed = totalMutants === 0 || mutationScore >= minScore

  return {
    schema: 1,
    dryRun: false,
    days,
    minScore,
    filesSelected,
    filesWithoutTests,
    totalMutants,
    killed,
    survived,
    timedOut,
    mutationScore,
    passed,
    mutants: results,
  }
}

export function main(argv: string[]): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let days = DEFAULT_DAYS
  let files: string[] | undefined
  let testFilesOverride: string[] | undefined
  let minScore = DEFAULT_MIN_SCORE
  let maxMutants = DEFAULT_MAX_MUTANTS
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let dryRun = false
  let jsonOut = false
  let outPath: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--root') root = path.resolve(argv[++i] ?? '')
    else if (arg === '--days') days = Number.parseInt(argv[++i] ?? '', 10)
    else if (arg === '--files') files = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--test-files')
      testFilesOverride = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (arg === '--min-score') minScore = Number.parseFloat(argv[++i] ?? '')
    else if (arg === '--max-mutants') maxMutants = Number.parseInt(argv[++i] ?? '', 10)
    else if (arg === '--timeout-ms') timeoutMs = Number.parseInt(argv[++i] ?? '', 10)
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--json') jsonOut = true
    else if (arg === '--out') outPath = argv[++i]
    else {
      console.error(`[mutation-weekly] unknown arg: ${arg}`)
      return 2
    }
  }

  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
    console.error(`[mutation-weekly] invalid --min-score: ${minScore}`)
    return 2
  }
  if (!Number.isInteger(maxMutants) || maxMutants <= 0) {
    console.error(`[mutation-weekly] invalid --max-mutants: ${maxMutants}`)
    return 2
  }

  const report = runWeeklyMutationCheck({
    root,
    days,
    files,
    testFilesOverride,
    minScore,
    maxMutants,
    timeoutMs,
    dryRun,
  })

  if (outPath) {
    writeFileSync(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }

  if (jsonOut) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(
      `[mutation-weekly] dryRun=${report.dryRun} files=${report.filesSelected.length} mutants=${report.totalMutants} killed=${report.killed} survived=${report.survived} score=${(report.mutationScore * 100).toFixed(1)}% min=${(report.minScore * 100).toFixed(1)}% passed=${report.passed}`,
    )
    for (const m of report.mutants) {
      if (m.status === 'survived') {
        console.error(
          `  [SURVIVED] ${m.file}:${m.line} (${m.operator}): "${m.original}" -> "${m.mutated}"`,
        )
      }
    }
  }

  return report.passed ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
