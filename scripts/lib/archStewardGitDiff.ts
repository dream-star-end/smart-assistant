/**
 * Git diff collection, TS AST function complexity analysis (`CC_direct`),
 * 12-logical-line clone detection, and repo arch config loaders for Architecture Steward.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type * as tsTypes from 'typescript'

import { isGate, rawNames } from '../check-gate-couplings.js'
import {
  type AppendMagnetsFile,
  type ChangedFileStat,
  type ChangedFunctionMetric,
  type CloneAlert,
  DEFAULT_CLONE_WINDOW_LINES,
  type DiffSummary,
  type GateCouplingDelta,
  type GateCouplingsFileMinimal,
  type ModulesFileMinimal,
  SHA40_RE,
  isProductionCodePath,
  normalizeRepoPath,
} from './archStewardTypes.js'

const require = createRequire(import.meta.url)
let _ts: typeof tsTypes | null = null
function getTs(): typeof tsTypes {
  if (!_ts) _ts = require('typescript') as typeof tsTypes
  return _ts
}

// ── Arch config loaders & module resolver ──────────────────────────────────────

function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') {
      re += '[^/]*'
    } else if ('\\^$+?.()|{}[]'.includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

function globSpecificity(glob: string): number {
  const star = glob.indexOf('*')
  const prefix = star < 0 ? glob.length + 10_000 : star
  return prefix * 1000 + glob.replace(/\*/g, '').length
}

export function buildModuleResolver(
  def: ModulesFileMinimal | null | undefined,
): (file: string) => string | null {
  if (!def || typeof def.modules !== 'object') {
    return () => null
  }
  const rules: Array<{ id: string; re: RegExp; score: number }> = []
  for (const [id, m] of Object.entries(def.modules)) {
    if (!m || !Array.isArray(m.match)) continue
    for (const g of m.match) {
      rules.push({ id, re: globToRegExp(g), score: globSpecificity(g) })
    }
  }
  return (rawFile: string): string | null => {
    const file = normalizeRepoPath(rawFile)
    let best: { id: string; score: number } | null = null
    for (const r of rules) {
      if (!r.re.test(file)) continue
      if (!best || r.score > best.score) best = { id: r.id, score: r.score }
    }
    return best?.id ?? null
  }
}

export function loadAppendMagnets(root: string): Set<string> {
  const p = path.join(root, 'arch/append-magnets.json')
  if (!existsSync(p)) return new Set()
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as AppendMagnetsFile
  const out = new Set<string>()
  for (const entry of parsed.magnets ?? []) {
    if (entry && typeof entry.path === 'string' && entry.path.trim()) {
      out.add(normalizeRepoPath(entry.path))
    }
  }
  return out
}

export function loadModulesDef(root: string): ModulesFileMinimal | null {
  const p = path.join(root, 'arch/modules.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as ModulesFileMinimal
}

export function loadGateCouplings(root: string): GateCouplingsFileMinimal | null {
  const p = path.join(root, 'arch/gate-couplings.json')
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8')) as GateCouplingsFileMinimal
}

// ── AST function complexity measurement (lines + CC_direct) ────────────────────

function isFunctionLikeNode(
  ts: typeof tsTypes,
  node: tsTypes.Node,
): node is tsTypes.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

function resolveFunctionName(
  ts: typeof tsTypes,
  node: tsTypes.FunctionLikeDeclaration,
  sf: tsTypes.SourceFile,
): string {
  if ('name' in node && node.name) return node.name.getText(sf)
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isPropertyAssignment(parent) && parent.name) return parent.name.getText(sf)
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return parent.left.getText(sf)
  }
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return `<anonymous>@L${line + 1}`
}

/**
 * Compute direct cyclomatic complexity (`CC_direct`) of a function body WITHOUT descending
 * into nested functions/closures. Starts at 1.
 */
export function computeDirectCyclomaticComplexity(body: tsTypes.Node): number {
  const ts = getTs()
  let cc = 1
  const visit = (node: tsTypes.Node): void => {
    if (node !== body && isFunctionLikeNode(ts, node)) return
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        cc += 1
        break
      case ts.SyntaxKind.BinaryExpression: {
        const op = (node as tsTypes.BinaryExpression).operatorToken.kind
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        ) {
          cc += 1
        }
        break
      }
      default:
        break
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(body, visit)
  return cc
}

export interface LineRange {
  start: number
  end: number
}

function rangesOverlap(startLine: number, endLine: number, ranges: readonly LineRange[]): boolean {
  for (const r of ranges) {
    if (startLine <= r.end && endLine >= r.start) return true
  }
  return false
}

export function analyzeChangedFunctionsInSource(
  filePath: string,
  sourceText: string,
  changedRanges?: readonly LineRange[],
): ChangedFunctionMetric[] {
  const ts = getTs()
  const normPath = normalizeRepoPath(filePath)
  const scriptKind = normPath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : normPath.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : ts.ScriptKind.TS
  const sf = ts.createSourceFile(normPath, sourceText, ts.ScriptTarget.Latest, true, scriptKind)
  const out: ChangedFunctionMetric[] = []

  const visit = (node: tsTypes.Node): void => {
    if (isFunctionLikeNode(ts, node) && node.body) {
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1
      if (!changedRanges || rangesOverlap(startLine, endLine, changedRanges)) {
        out.push({
          file: normPath,
          name: resolveFunctionName(ts, node, sf),
          lines: endLine - startLine + 1,
          ccDirect: computeDirectCyclomaticComplexity(node.body),
          startLine,
          endLine,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

// ── 12-logical-line clone detector ─────────────────────────────────────────────

interface LogicalLine {
  origLine: number
  norm: string
}

function extractLogicalLines(sourceText: string): LogicalLine[] {
  const out: LogicalLine[] = []
  let inBlockComment = false
  const rawLines = sourceText.split('\n')

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx]!
    let cleaned = ''
    let i = 0
    while (i < line.length) {
      if (inBlockComment) {
        const close = line.indexOf('*/', i)
        if (close === -1) break
        inBlockComment = false
        i = close + 2
        continue
      }
      if (line[i] === '/' && line[i + 1] === '*') {
        inBlockComment = true
        i += 2
        continue
      }
      if (line[i] === '/' && line[i + 1] === '/') break
      cleaned += line[i]
      i += 1
    }

    const trimmed = cleaned.trim()
    if (!trimmed) continue
    if (/^(?:import|export\s+type)\s/.test(trimmed)) continue
    if (/^[{}()[\],;]+$/.test(trimmed)) continue

    const norm = trimmed
      .replace(/'(?:\\.|[^'\\])*'/g, '<STR>')
      .replace(/"(?:\\.|[^"\\])*"/g, '<STR>')
      .replace(/`(?:\\.|[^`\\])*`/g, '<STR>')
      .replace(/\b\d+(?:\.\d+)?\b/g, '<NUM>')
      .replace(/\s+/g, ' ')

    if (norm.length < 4) continue
    out.push({ origLine: idx + 1, norm })
  }
  return out
}

export function detect12LineClones(
  fileSources: ReadonlyMap<string, string>,
  opts?: { windowLines?: number; baselineHashes?: ReadonlySet<string> },
): CloneAlert[] {
  const windowLines = opts?.windowLines ?? DEFAULT_CLONE_WINDOW_LINES
  const baseline = opts?.baselineHashes
  const seen = new Map<string, { file: string; line: number; logicalIdx: number }>()
  const alerts: CloneAlert[] = []
  const reportedHashes = new Set<string>()

  const entries = [...fileSources.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [rawFile, content] of entries) {
    const file = normalizeRepoPath(rawFile)
    const logical = extractLogicalLines(content)
    if (logical.length < windowLines) continue
    for (let i = 0; i <= logical.length - windowLines; i++) {
      const slice = logical.slice(i, i + windowLines)
      const hash = createHash('sha256')
        .update(slice.map((l) => l.norm).join('\n'))
        .digest('hex')
        .slice(0, 24)
      if (baseline?.has(hash)) continue

      const prev = seen.get(hash)
      if (!prev) {
        seen.set(hash, { file, line: slice[0]!.origLine, logicalIdx: i })
        continue
      }
      if (prev.file === file && i - prev.logicalIdx < windowLines) continue
      if (!reportedHashes.has(hash)) {
        reportedHashes.add(hash)
        alerts.push({
          file,
          line: slice[0]!.origLine,
          matchedFile: prev.file,
          matchedLine: prev.line,
          lines: windowLines,
          hash,
        })
      }
    }
  }
  return alerts
}

// ── Git diff collector ─────────────────────────────────────────────────────────

export function runGit(root: string, args: string[], gitDir?: string): string {
  const env = { ...process.env }
  if (gitDir) env.GIT_DIR = gitDir
  const gitArgs = gitDir ? ['--git-dir', gitDir, ...args] : ['-C', root, ...args]
  return execFileSync('git', gitArgs, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
}

export function resolveGitSha(root: string, ref: string, gitDir?: string): string {
  const out = runGit(root, ['rev-parse', '--verify', `${ref}^{commit}`], gitDir).trim()
  if (!SHA40_RE.test(out)) {
    throw new Error(`git ref ${JSON.stringify(ref)} did not resolve to a 40-char commit SHA`)
  }
  return out.toLowerCase()
}

export function resolveDefaultBaseRef(
  root: string,
  headSha: string,
  opts?: { gitDir?: string; env?: Readonly<Record<string, string | undefined>> },
): string {
  const env = opts?.env ?? process.env
  const tryCandidate = (cand: string | undefined): string | null => {
    if (!cand || !cand.trim()) return null
    try {
      const sha = resolveGitSha(root, cand.trim(), opts?.gitDir)
      if (sha === headSha) return null
      const mb = runGit(root, ['merge-base', sha, headSha], opts?.gitDir).trim().toLowerCase()
      if (SHA40_RE.test(mb) && mb !== headSha) return mb
    } catch {
      return null
    }
    return null
  }

  const fromGovEnv = tryCandidate(env.OC_V5_GOVERNANCE_BASE_REF)
  if (fromGovEnv) return fromGovEnv
  if (env.GITHUB_BASE_REF) {
    const fromGh =
      tryCandidate(`origin/${env.GITHUB_BASE_REF}`) ?? tryCandidate(env.GITHUB_BASE_REF)
    if (fromGh) return fromGh
  }
  const fromOrigin = tryCandidate('origin/feat/v5-selfhost')
  if (fromOrigin) return fromOrigin
  const fromParent = tryCandidate(`${headSha}^`)
  if (fromParent) return fromParent

  throw new Error(
    `cannot resolve non-self base commit for head ${headSha.slice(0, 12)} (pass --base <ref>)`,
  )
}

export function readCommitMessage(root: string, headSha: string, gitDir?: string): string {
  try {
    return runGit(root, ['show', '-s', '--format=%B', headSha], gitDir)
  } catch {
    return ''
  }
}

function parseHunkChangedRanges(unifiedZeroDiff: string): Map<string, LineRange[]> {
  const map = new Map<string, LineRange[]>()
  let currentFile: string | null = null
  for (const line of unifiedZeroDiff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = normalizeRepoPath(line.slice(6))
      if (!map.has(currentFile)) map.set(currentFile, [])
      continue
    }
    if (line.startsWith('+++ /dev/null')) {
      currentFile = null
      continue
    }
    if (!currentFile || !line.startsWith('@@ ')) continue
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!m) continue
    const start = Number(m[1])
    const count = m[2] === undefined ? 1 : Number(m[2])
    if (count > 0) map.get(currentFile)!.push({ start, end: start + count - 1 })
  }
  return map
}

function readBlobAtCommit(root: string, sha: string, relPath: string, gitDir?: string): string | null {
  try {
    return runGit(root, ['show', `${sha}:${relPath}`], gitDir)
  } catch {
    const abs = path.join(root, relPath)
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null
  }
}

function parseNameStatusAndNumstat(
  root: string,
  rangeSpec: string,
  gitDir?: string,
): ChangedFileStat[] {
  const statusRaw = runGit(root, ['diff', '-M', '-z', '--name-status', rangeSpec], gitDir)
  const tokens = statusRaw.split('\0')
  const statusMap = new Map<string, { status: ChangedFileStat['status']; oldPath?: string }>()
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i++]
    if (!code) break
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = normalizeRepoPath(tokens[i++] ?? '')
      const to = normalizeRepoPath(tokens[i++] ?? '')
      if (to) statusMap.set(to, { status: 'renamed', oldPath: from })
    } else {
      const file = normalizeRepoPath(tokens[i++] ?? '')
      if (!file) continue
      const status: ChangedFileStat['status'] =
        code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified'
      statusMap.set(file, { status })
    }
  }

  const numstatRaw = runGit(root, ['diff', '-M', '--numstat', rangeSpec], gitDir)
  const numstatMap = new Map<string, { added: number; deleted: number }>()
  for (const line of numstatRaw.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const added = parts[0] === '-' ? 0 : Number(parts[0]) || 0
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]) || 0
    let filePath = parts[2]!
    if (parts.length >= 4) {
      filePath = parts[3]!
    } else if (filePath.includes(' => ')) {
      filePath = filePath.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/^.* => /, '')
    }
    numstatMap.set(normalizeRepoPath(filePath), { added, deleted })
  }

  const files: ChangedFileStat[] = []
  for (const [filePath, info] of statusMap.entries()) {
    const counts = numstatMap.get(filePath) ?? { added: 0, deleted: 0 }
    files.push({
      path: filePath,
      status: info.status,
      added: counts.added,
      deleted: counts.deleted,
      ...(info.oldPath ? { oldPath: info.oldPath } : {}),
    })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function loadOptionalCloneBaseline(root: string): Set<string> | undefined {
  const cloneBaselinePath = path.join(root, 'arch/clones-baseline.json')
  if (!existsSync(cloneBaselinePath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(cloneBaselinePath, 'utf8')) as {
      hashes?: string[]
      clusters?: Record<string, unknown>
    }
    if (Array.isArray(parsed.hashes)) return new Set(parsed.hashes)
    if (parsed.clusters && typeof parsed.clusters === 'object') {
      return new Set(Object.keys(parsed.clusters))
    }
  } catch {
    return undefined
  }
  return undefined
}

function detectNewGateCouplings(
  root: string,
  headSha: string,
  files: readonly ChangedFileStat[],
  gitDir?: string,
): GateCouplingDelta[] {
  const out: GateCouplingDelta[] = []
  const existingByGate = loadGateCouplings(root)?.byGate ?? {}
  for (const f of files) {
    if (f.status === 'deleted' || !isGate(f.path)) continue
    const content = readBlobAtCommit(root, headSha, f.path, gitDir)
    if (content === null) continue
    const existingSet = new Set((existingByGate[f.path] ?? []).map(normalizeRepoPath))
    for (const named of rawNames(f.path, content)) {
      const norm = normalizeRepoPath(named)
      if (!existingSet.has(norm) && existsSync(path.join(root, norm))) {
        out.push({ gate: f.path, path: norm })
      }
    }
  }
  return out
}

export function collectDiffSummaryFromGit(opts: {
  root: string
  baseRef: string
  headRef: string
  gitDir?: string
}): DiffSummary {
  const headSha = resolveGitSha(opts.root, opts.headRef, opts.gitDir)
  const baseTargetSha = resolveGitSha(opts.root, opts.baseRef, opts.gitDir)
  let baseSha = baseTargetSha
  try {
    const mb = runGit(opts.root, ['merge-base', baseTargetSha, headSha], opts.gitDir).trim().toLowerCase()
    if (SHA40_RE.test(mb)) baseSha = mb
  } catch {
    // Disjoint histories or direct ref comparison fallback
  }

  const rangeSpec = `${baseSha}..${headSha}`
  const files = parseNameStatusAndNumstat(opts.root, rangeSpec, opts.gitDir)

  const tsProdFiles = files.filter(
    (f) => f.status !== 'deleted' && isProductionCodePath(f.path) && /\.(?:ts|tsx|mts)$/.test(f.path),
  )
  const changedFunctions: ChangedFunctionMetric[] = []
  const fileSources = new Map<string, string>()

  if (tsProdFiles.length > 0) {
    const diffU0 = runGit(
      opts.root,
      ['diff', '-U0', '--no-color', rangeSpec, '--', ...tsProdFiles.map((f) => f.path)],
      opts.gitDir,
    )
    const hunkRanges = parseHunkChangedRanges(diffU0)
    for (const f of tsProdFiles) {
      const content = readBlobAtCommit(opts.root, headSha, f.path, opts.gitDir)
      if (content === null) continue
      fileSources.set(f.path, content)
      const ranges = hunkRanges.get(f.path)
      if (ranges && ranges.length > 0) {
        changedFunctions.push(...analyzeChangedFunctionsInSource(f.path, content, ranges))
      }
    }
  }

  const cloneAlerts = detect12LineClones(fileSources, {
    baselineHashes: loadOptionalCloneBaseline(opts.root),
  })
  const newGateCouplings = detectNewGateCouplings(opts.root, headSha, files, opts.gitDir)

  return { baseSha, headSha, files, changedFunctions, cloneAlerts, newGateCouplings }
}
