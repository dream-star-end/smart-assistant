/**
 * Function Complexity Ratchet Gate (OCV5-905).
 *
 * Scans production `.ts`/`.tsx` files via TypeScript Compiler API and computes per
 * named function / method / arrow function:
 *   1. `lines`      <= 100 (inclusive 1-based line span)
 *   2. `ccDirect`   <= 20  (direct cyclomatic complexity excluding nested closures)
 *   3. `maxNesting` <= 5   (direct control-flow nesting depth; flat `else if` = same depth)
 *
 * Pre-existing functions exceeding `(100, 20, 5)` are frozen in `arch/complexity-baseline.json`.
 * `--enforce` blocks any new function > `(100, 20, 5)` and any dimension increase on a baselined
 * function. Supports `<2s` incremental fast mode via `--files <list>` and `--base <ref>`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { checkGatewayCoverage, discoverPackagesProdFiles } from './lib/prodFileDiscovery.js'

export const BASELINE_REL_PATH = 'arch/complexity-baseline.json'

export interface ComplexityLimits {
  lines: number
  ccDirect: number
  maxNesting: number
}

export const DEFAULT_LIMITS: Readonly<ComplexityLimits> = {
  lines: 100,
  ccDirect: 20,
  maxNesting: 5,
}

export interface FunctionDims {
  lines: number
  ccDirect: number
  maxNesting: number
}

export interface FunctionMetric extends FunctionDims {
  file: string
  fnName: string
  key: string
  startLine: number
  endLine: number
}

export interface ComplexityBaseline {
  schemaVersion: 1
  limits: ComplexityLimits
  summary: {
    exceedingFunctions: number
    overLines: number
    overCcDirect: number
    overMaxNesting: number
  }
  functions: Record<string, FunctionDims>
}

export interface ComplexityViolation {
  kind: 'new-over-limit' | 'baseline-dimension-grown' | 'baseline-file-raised'
  key: string
  file: string
  fnName: string
  actual: FunctionDims
  allowed: FunctionDims
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

export function discoverProductionFiles(root: string): string[] {
  return discoverPackagesProdFiles({
    root,
    skipDirs: SKIP_DIRS,
    includeFile: isProductionTsFile,
    fallbackRootSrc: true,
  })
}

export function checkDiscoveryCoverage(root: string, discoveredFiles: readonly string[]): string | null {
  return checkGatewayCoverage(root, discoveredFiles)
}

function isNestedFnBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function isDecisionOp(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  )
}

function computeDirectCcAndNesting(body: ts.Node): { ccDirect: number; maxNesting: number } {
  let ccDirect = 1
  let maxNesting = 0

  const visit = (node: ts.Node, depth: number): void => {
    if (depth > maxNesting) maxNesting = depth
    if (ts.isIfStatement(node)) {
      ccDirect++
      visit(node.expression, depth)
      const nd = depth + 1
      if (nd > maxNesting) maxNesting = nd
      visit(node.thenStatement, nd)
      if (node.elseStatement) {
        visit(node.elseStatement, ts.isIfStatement(node.elseStatement) ? depth : nd)
      }
      return
    }
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      ccDirect++
      const nd = depth + 1
      if (nd > maxNesting) maxNesting = nd
      ts.forEachChild(node, (c) => {
        if (!isNestedFnBoundary(c)) visit(c, c === node.statement ? nd : depth)
      })
      return
    }
    if (ts.isSwitchStatement(node)) {
      visit(node.expression, depth)
      const nd = depth + 1
      if (nd > maxNesting) maxNesting = nd
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          ccDirect++
          visit(clause.expression, nd)
        }
        for (const stmt of clause.statements) {
          if (!isNestedFnBoundary(stmt)) visit(stmt, nd)
        }
      }
      return
    }
    if (ts.isTryStatement(node)) {
      const nd = depth + 1
      if (nd > maxNesting) maxNesting = nd
      visit(node.tryBlock, nd)
      if (node.catchClause) {
        ccDirect++
        visit(node.catchClause.block, nd)
      }
      if (node.finallyBlock) visit(node.finallyBlock, nd)
      return
    }
    if (ts.isConditionalExpression(node)) ccDirect++
    else if (ts.isBinaryExpression(node) && isDecisionOp(node.operatorToken.kind)) ccDirect++

    ts.forEachChild(node, (c) => {
      if (!isNestedFnBoundary(c)) visit(c, depth)
    })
  }

  visit(body, 0)
  return { ccDirect, maxNesting }
}

function buildLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function lineAtOffset(starts: number[], pos: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (starts[mid]! <= pos) lo = mid + 1
    else hi = mid - 1
  }
  return lo
}

function skipLeadingTriviaFast(text: string, pos: number, end: number): number {
  let i = pos
  while (i < end) {
    const ch = text.charCodeAt(i)
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
      i++
      continue
    }
    if (ch === 47 && i + 1 < end) {
      const next = text.charCodeAt(i + 1)
      if (next === 47) {
        i += 2
        while (i < end && text.charCodeAt(i) !== 10) i++
        continue
      }
      if (next === 42) {
        i += 2
        while (i + 1 < end && !(text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47)) i++
        i += 2
        continue
      }
    }
    break
  }
  return i
}

function propNameOf(name: ts.PropertyName | undefined, text: string): string | null {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return text.slice(skipLeadingTriviaFast(text, name.pos, name.end), name.end).replace(/\s+/g, '')
}

function unwrapFnInit(
  expr: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | null {
  if (!expr) return null
  let cur: ts.Expression = expr
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression
  }
  if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) return cur
  if (ts.isCallExpression(cur) && cur.arguments.length > 0) {
    const first = cur.arguments[0]!
    if (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) return first
  }
  return null
}

export function analyzeSourceComplexity(file: string, sourceText: string): FunctionMetric[] {
  const normFile = file.replace(/\\/g, '/')
  // `setParentNodes = false` halves AST allocation & GC overhead
  const sf = ts.createSourceFile(
    normFile,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    normFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const lineStarts = buildLineStarts(sourceText)
  const metrics: FunctionMetric[] = []
  const seenCounts = new Map<string, number>()

  const recordMetric = (rawFnName: string, spanNode: ts.Node, bodyNode: ts.Node): void => {
    const count = (seenCounts.get(rawFnName) ?? 0) + 1
    seenCounts.set(rawFnName, count)
    const fnName = count === 1 ? rawFnName : `${rawFnName}#${count}`
    const startOffset = skipLeadingTriviaFast(sourceText, spanNode.pos, spanNode.end)
    const startLine = lineAtOffset(lineStarts, startOffset)
    const endLine = lineAtOffset(lineStarts, Math.max(startOffset, spanNode.end - 1))
    const { ccDirect, maxNesting } = computeDirectCcAndNesting(bodyNode)
    metrics.push({
      file: normFile,
      fnName,
      key: `${normFile}::${fnName}`,
      startLine,
      endLine,
      lines: endLine - startLine + 1,
      ccDirect,
      maxNesting,
    })
  }

  const qualify = (scope: string[], name: string): string =>
    scope.length > 0 ? `${scope.join('.')}.${name}` : name

  const walk = (node: ts.Node, scope: string[]): void => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const nextScope = [...scope, node.name?.text ?? 'AnonymousClass']
      for (const m of node.members) walk(m, nextScope)
      return
    }
    if (ts.isFunctionDeclaration(node)) {
      if (node.body) {
        const isDef =
          ts.canHaveModifiers(node) &&
          !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
        const name = node.name?.text ?? (isDef ? 'default' : null)
        if (name) {
          recordMetric(qualify(scope, name), node, node.body)
          ts.forEachChild(node.body, (c) => walk(c, [...scope, name]))
        }
      }
      return
    }
    if (ts.isMethodDeclaration(node) && node.body) {
      const mName = propNameOf(node.name, sourceText) ?? 'method'
      recordMetric(qualify(scope, mName), node, node.body)
      ts.forEachChild(node.body, (c) => walk(c, [...scope, mName]))
      return
    }
    if (ts.isConstructorDeclaration(node) && node.body) {
      recordMetric(qualify(scope, 'constructor'), node, node.body)
      ts.forEachChild(node.body, (c) => walk(c, [...scope, 'constructor']))
      return
    }
    if ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body) {
      const pre = ts.isGetAccessorDeclaration(node) ? 'get_' : 'set_'
      const pName = `${pre}${propNameOf(node.name, sourceText) ?? 'accessor'}`
      recordMetric(qualify(scope, pName), node, node.body)
      ts.forEachChild(node.body, (c) => walk(c, [...scope, pName]))
      return
    }
    if (ts.isPropertyDeclaration(node) && node.initializer) {
      const fn = unwrapFnInit(node.initializer)
      if (fn) {
        const pName = propNameOf(node.name, sourceText) ?? 'propertyFn'
        recordMetric(qualify(scope, pName), node, fn.body)
        ts.forEachChild(fn.body, (c) => walk(c, [...scope, pName]))
        return
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const fn = unwrapFnInit(node.initializer)
      if (fn) {
        const vName = node.name.text
        recordMetric(qualify(scope, vName), node, fn.body)
        ts.forEachChild(fn.body, (c) => walk(c, [...scope, vName]))
        return
      }
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      const fn = unwrapFnInit(node.expression)
      if (fn) {
        recordMetric(qualify(scope, 'default'), node, fn.body)
        ts.forEachChild(fn.body, (c) => walk(c, [...scope, 'default']))
        return
      }
    }
    ts.forEachChild(node, (child) => walk(child, scope))
  }

  walk(sf, [])
  return metrics
}

export function scanComplexity(root: string, files?: string[]): FunctionMetric[] {
  const targets = files ?? discoverProductionFiles(root)
  const out: FunctionMetric[] = []
  for (const rel of targets) {
    const abs = path.join(root, rel)
    if (existsSync(abs)) out.push(...analyzeSourceComplexity(rel, readFileSync(abs, 'utf8')))
  }
  return out
}

export function exceedsLimits(m: FunctionDims, limits: ComplexityLimits = DEFAULT_LIMITS): boolean {
  return m.lines > limits.lines || m.ccDirect > limits.ccDirect || m.maxNesting > limits.maxNesting
}

export function buildComplexityBaseline(
  metrics: FunctionMetric[],
  limits: ComplexityLimits = DEFAULT_LIMITS,
): ComplexityBaseline {
  const exceeding = metrics
    .filter((m) => exceedsLimits(m, limits))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const functions: Record<string, FunctionDims> = {}
  let overLines = 0
  let overCcDirect = 0
  let overMaxNesting = 0
  for (const m of exceeding) {
    if (m.lines > limits.lines) overLines++
    if (m.ccDirect > limits.ccDirect) overCcDirect++
    if (m.maxNesting > limits.maxNesting) overMaxNesting++
    functions[m.key] = { lines: m.lines, ccDirect: m.ccDirect, maxNesting: m.maxNesting }
  }
  return {
    schemaVersion: 1,
    limits: { ...limits },
    summary: { exceedingFunctions: exceeding.length, overLines, overCcDirect, overMaxNesting },
    functions,
  }
}

export function parseComplexityBaseline(raw: unknown): ComplexityBaseline {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('complexity baseline must be a JSON object')
  }
  const obj = raw as Partial<ComplexityBaseline>
  if (obj.schemaVersion !== 1 || !obj.limits || typeof obj.functions !== 'object' || !obj.functions) {
    throw new Error('complexity baseline requires schemaVersion=1, limits, and functions map')
  }
  const { lines, ccDirect, maxNesting } = obj.limits
  if (!Number.isInteger(lines) || !Number.isInteger(ccDirect) || !Number.isInteger(maxNesting)) {
    throw new Error('complexity baseline limits must be integers')
  }
  for (const [k, v] of Object.entries(obj.functions)) {
    if (!v || !Number.isInteger(v.lines) || !Number.isInteger(v.ccDirect) || !Number.isInteger(v.maxNesting)) {
      throw new Error(`invalid function entry "${k}" in complexity baseline`)
    }
  }
  return obj as ComplexityBaseline
}

function remapKey(key: string, renames: Map<string, string>): { key: string; file: string; fnName: string } {
  const sep = key.indexOf('::')
  const file = sep >= 0 ? key.slice(0, sep) : key
  const fnName = sep >= 0 ? key.slice(sep + 2) : ''
  const mapped = renames.get(file) ?? file
  return { key: `${mapped}::${fnName}`, file: mapped, fnName }
}

export function evaluateComplexityRatchet(
  metrics: FunctionMetric[],
  baseline: ComplexityBaseline,
  renames = new Map<string, string>(),
): ComplexityViolation[] {
  const limits = baseline.limits
  const effectiveBaseline = new Map<string, FunctionDims>()
  for (const [k, dims] of Object.entries(baseline.functions)) {
    effectiveBaseline.set(remapKey(k, renames).key, dims)
  }

  const violations: ComplexityViolation[] = []
  for (const m of metrics) {
    const baseEntry = effectiveBaseline.get(m.key)
    if (baseEntry) {
      const grew: string[] = []
      if (m.lines > baseEntry.lines) grew.push(`lines ${baseEntry.lines} -> ${m.lines}`)
      if (m.ccDirect > baseEntry.ccDirect) grew.push(`ccDirect ${baseEntry.ccDirect} -> ${m.ccDirect}`)
      if (m.maxNesting > baseEntry.maxNesting) grew.push(`maxNesting ${baseEntry.maxNesting} -> ${m.maxNesting}`)
      if (grew.length > 0) {
        violations.push({
          kind: 'baseline-dimension-grown',
          key: m.key,
          file: m.file,
          fnName: m.fnName,
          actual: { lines: m.lines, ccDirect: m.ccDirect, maxNesting: m.maxNesting },
          allowed: baseEntry,
          detail: `${m.key} (L${m.startLine}-${m.endLine}) grew past frozen baseline: ${grew.join(', ')}`,
        })
      }
    } else if (exceedsLimits(m, limits)) {
      const over: string[] = []
      if (m.lines > limits.lines) over.push(`lines=${m.lines} > ${limits.lines}`)
      if (m.ccDirect > limits.ccDirect) over.push(`ccDirect=${m.ccDirect} > ${limits.ccDirect}`)
      if (m.maxNesting > limits.maxNesting) over.push(`maxNesting=${m.maxNesting} > ${limits.maxNesting}`)
      violations.push({
        kind: 'new-over-limit',
        key: m.key,
        file: m.file,
        fnName: m.fnName,
        actual: { lines: m.lines, ccDirect: m.ccDirect, maxNesting: m.maxNesting },
        allowed: limits,
        detail: `${m.key} (L${m.startLine}-${m.endLine}) exceeds complexity hard cap: ${over.join(', ')}`,
      })
    }
  }
  return violations
}

export function compareComplexityBaselines(
  base: ComplexityBaseline,
  head: ComplexityBaseline,
  renames = new Map<string, string>(),
): ComplexityViolation[] {
  const violations: ComplexityViolation[] = []
  if (
    head.limits.lines > base.limits.lines ||
    head.limits.ccDirect > base.limits.ccDirect ||
    head.limits.maxNesting > base.limits.maxNesting
  ) {
    violations.push({
      kind: 'baseline-file-raised',
      key: '<limits>',
      file: BASELINE_REL_PATH,
      fnName: '<limits>',
      actual: head.limits,
      allowed: base.limits,
      detail: `${BASELINE_REL_PATH} loosened hard limits`,
    })
  }
  const movedBase = new Map<string, FunctionDims>()
  for (const [k, v] of Object.entries(base.functions)) movedBase.set(remapKey(k, renames).key, v)

  for (const [key, hv] of Object.entries(head.functions)) {
    const bv = movedBase.get(key)
    const { file, fnName } = remapKey(key, new Map())
    if (!bv) {
      violations.push({
        kind: 'baseline-file-raised',
        key,
        file,
        fnName,
        actual: hv,
        allowed: head.limits,
        detail: `new entry "${key}" added to ${BASELINE_REL_PATH}; baselines may only shrink`,
      })
    } else if (hv.lines > bv.lines || hv.ccDirect > bv.ccDirect || hv.maxNesting > bv.maxNesting) {
      violations.push({
        kind: 'baseline-file-raised',
        key,
        file,
        fnName,
        actual: hv,
        allowed: bv,
        detail: `baseline entry "${key}" raised in ${BASELINE_REL_PATH} (${bv.lines}/${bv.ccDirect}/${bv.maxNesting} -> ${hv.lines}/${hv.ccDirect}/${hv.maxNesting})`,
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

function gitRenamesSince(root: string, base: string): Map<string, string> {
  const out = new Map<string, string>()
  const txt = execFileSync(
    'git',
    ['-C', root, 'diff', '-M', '--name-status', '--diff-filter=R', `${base}...HEAD`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  for (const line of txt.split('\n')) {
    const [st, from, to] = line.split('\t')
    if (st?.startsWith('R') && from && to) out.set(from, to)
  }
  return out
}

function normalizeCliFileList(root: string, rawList: string[]): string[] {
  const out = new Set<string>()
  for (const item of rawList) {
    for (const part of item.split(',')) {
      const trimmed = part.trim()
      if (!trimmed) continue
      const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed)
      const rel = path.relative(root, abs).replace(/\\/g, '/')
      if (!rel.startsWith('..') && isProductionTsFile(rel) && existsSync(abs)) out.add(rel)
    }
  }
  return [...out].sort()
}

export function main(argv = process.argv.slice(2)): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let baselineRel = BASELINE_REL_PATH
  let writeBaseline = false
  let updateBaseline = false
  let enforce = false
  let baseRef = ''
  let jsonOut: string | boolean = false
  const rawFiles: string[] = []
  let sawFilesFlag = false

  const argErr = (msg: string): number => {
    console.error(`[complexity-ratchet] ${msg}`)
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
    else if (arg === '--base') {
      const v = argv[++i]
      if (!v) return argErr('--base requires a git ref')
      baseRef = v
    } else if (arg === '--files') {
      sawFilesFlag = true
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) rawFiles.push(argv[++i]!)
    } else if (arg.startsWith('--files=')) {
      sawFilesFlag = true
      rawFiles.push(arg.slice('--files='.length))
    } else if (arg === '--json') {
      jsonOut = i + 1 < argv.length && !argv[i + 1]!.startsWith('--') ? argv[++i]! : true
    } else return argErr(`unknown argument: ${arg}`)
  }

  try {
    const baselineAbs = path.isAbsolute(baselineRel) ? baselineRel : path.join(root, baselineRel)
    if (writeBaseline) {
      const metrics = scanComplexity(root)
      const built = buildComplexityBaseline(metrics, DEFAULT_LIMITS)
      mkdirSync(path.dirname(baselineAbs), { recursive: true })
      writeFileSync(baselineAbs, `${JSON.stringify(built, null, 2)}\n`)
      console.log(
        `[complexity-ratchet] wrote ${baselineRel}: ${metrics.length} functions scanned, ${built.summary.exceedingFunctions} frozen (lines>${DEFAULT_LIMITS.lines}: ${built.summary.overLines}, cc>${DEFAULT_LIMITS.ccDirect}: ${built.summary.overCcDirect}, nesting>${DEFAULT_LIMITS.maxNesting}: ${built.summary.overMaxNesting})`,
      )
      return 0
    }
    if (!existsSync(baselineAbs)) {
      console.error(`[complexity-ratchet] FAIL-CLOSED: missing baseline ${baselineRel}`)
      return 2
    }
    const headBaseline = parseComplexityBaseline(JSON.parse(readFileSync(baselineAbs, 'utf8')))

    if (updateBaseline) {
      const currentMap = new Map(scanComplexity(root).map((m) => [m.key, m]))
      const shrunkMetrics: FunctionMetric[] = []
      for (const [key, was] of Object.entries(headBaseline.functions)) {
        const now = currentMap.get(key)
        if (!now) continue
        const d: FunctionDims = {
          lines: Math.min(was.lines, now.lines),
          ccDirect: Math.min(was.ccDirect, now.ccDirect),
          maxNesting: Math.min(was.maxNesting, now.maxNesting),
        }
        if (exceedsLimits(d, headBaseline.limits)) {
          shrunkMetrics.push({ ...d, key, file: now.file, fnName: now.fnName, startLine: now.startLine, endLine: now.endLine })
        }
      }
      const updated = buildComplexityBaseline(shrunkMetrics, headBaseline.limits)
      writeFileSync(baselineAbs, `${JSON.stringify(updated, null, 2)}\n`)
      console.log(
        `[complexity-ratchet] updated ${baselineRel}: ${Object.keys(headBaseline.functions).length} -> ${updated.summary.exceedingFunctions} functions`,
      )
      return 0
    }

    let renames = new Map<string, string>()
    const violations: ComplexityViolation[] = []
    if (baseRef) {
      execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${baseRef}^{commit}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      renames = gitRenamesSince(root, baseRef)
      const baseText = readGitFile(root, baseRef, baselineRel)
      if (baseText !== null) {
        violations.push(
          ...compareComplexityBaselines(parseComplexityBaseline(JSON.parse(baseText)), headBaseline, renames),
        )
      }
    }

    const allFiles = sawFilesFlag ? normalizeCliFileList(root, rawFiles) : discoverProductionFiles(root)
    if (enforce && !sawFilesFlag) {
      const coverageErr = checkDiscoveryCoverage(root, allFiles)
      if (coverageErr) {
        console.error(`[GATE-ERROR] COMPLEXITY-RATCHET (coverage-zero): ${coverageErr}`)
        return 1
      }
    }
    const metrics = scanComplexity(root, allFiles)
    violations.push(...evaluateComplexityRatchet(metrics, headBaseline, renames))

    const report = {
      mode: sawFilesFlag ? 'incremental' : 'full',
      scannedFiles: allFiles.length,
      scannedFunctions: metrics.length,
      baselinedFunctions: Object.keys(headBaseline.functions).length,
      violations,
    }
    if (typeof jsonOut === 'string') {
      mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true })
      writeFileSync(path.resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`)
    } else if (jsonOut === true) {
      console.log(JSON.stringify(report, null, 2))
      return enforce && violations.length > 0 ? 1 : 0
    }
    for (const v of violations) {
      console.error(
        `[GATE-ERROR] COMPLEXITY-RATCHET (${v.kind}) at ${v.file}\n  Violation : ${v.detail}\n  How to Fix: Split into focused helpers <= (${headBaseline.limits.lines} lines, CC ${headBaseline.limits.ccDirect}, nesting ${headBaseline.limits.maxNesting}) without raising ${baselineRel}.`,
      )
    }
    console.log(
      `[complexity-ratchet] mode=${report.mode} files=${report.scannedFiles} functions=${report.scannedFunctions} baselined=${report.baselinedFunctions} violations=${violations.length}`,
    )
    return enforce && violations.length > 0 ? 1 : 0
  } catch (err) {
    console.error(`[complexity-ratchet] FAIL-CLOSED: ${(err as Error).message}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
