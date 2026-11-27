/**
 * Deterministic High-Risk SAST & Secret Leak Gate (OCV5-905).
 *
 * Combines:
 *   1. Credential / Secret Leak Detection (`SEC-SECRET-*`, gitleaks-aligned):
 *      AWS Access/Secret Keys, GCP API Keys, GitHub PATs, OpenAI/Anthropic Keys,
 *      PEM Private Keys, and hardcoded JWT signing secrets (supports inline `gitleaks:allow`
 *      and `sast-ignore: secret`).
 *   2. High-Risk Security & Hot-Path Anti-Patterns (`SEC-SAST-*`, TS Compiler AST):
 *      - `SEC-SAST-SQL-INTERPOLATION`: raw `${...}` template interpolation in SQL `.query`/`.exec`
 *      - `SEC-SAST-SHELL-INJECTION`: dynamic `${...}` / `+` in `child_process` `exec`/`execSync`
 *      - `SEC-SAST-UNBOUNDED-LOOP-AWAIT`: unbounded `await fetch` or SQL `.query` inside `for`/`while`
 *
 * Pre-existing SAST debt is frozen in `arch/security-sast-baseline.json` (shrink-only).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { checkGatewayCoverage, discoverPackagesProdFiles } from './lib/prodFileDiscovery.js'

export const BASELINE_REL_PATH = 'arch/security-sast-baseline.json'

export type SecurityCategory = 'secret' | 'sast'

export interface SastFinding {
  ruleId: string
  category: SecurityCategory
  file: string
  line: number
  snippet: string
  detail: string
}

export interface SecurityBaseline {
  schemaVersion: 1
  summary: {
    totalEntries: number
    totalCount: number
    byRule: Record<string, number>
  }
  entries: Record<string, number>
}

export interface SecurityViolation {
  kind: 'secret-leak' | 'new-or-grown-sast' | 'baseline-raised'
  ruleId: string
  file: string
  line?: number
  actualCount: number
  allowedCount: number
  detail: string
}

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-types', 'build', 'coverage', '.git', '.vite', '.cache',
  'generated', '__tests__', '__smoke__', 'test', 'tests', 'browser-tests',
  'fixtures', '__fixtures__', '__snapshots__', 'vendor',
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

function redactSecret(val: string): string {
  return val.length <= 10 ? '***REDACTED***' : `${val.slice(0, 6)}...${val.slice(-3)}`
}

function hasInlineSecretAllow(lines: string[], lineIdx: number): boolean {
  const check = (s: string | undefined) =>
    !!s &&
    /(?:gitleaks:allow|sast-ignore:\s*secret|security-sast-allow|pragma:\s*allowlist\s+secret)/i.test(
      s,
    )
  return check(lines[lineIdx]) || (lineIdx > 0 && check(lines[lineIdx - 1]))
}

function hasInlineSastWaiver(lines: string[], lineIdx: number, ruleId: string): boolean {
  const from = Math.max(0, lineIdx - 2)
  for (let i = lineIdx; i >= from; i--) {
    const m = /sast-ignore:\s*([A-Za-z0-9_-]+)\s*(?:--|—|:)\s*(.+)$/.exec(lines[i] ?? '')
    if (m && (m[1] === ruleId || m[1] === 'all') && m[2]!.trim().length >= 4) return true
  }
  return false
}

function isPlaceholderToken(token: string): boolean {
  if (/^(?:AKIAIOSFODNN7EXAMPLE|wJalrXUtnFEMI\/K7MDENG\/bPxRfiCYEXAMPLEKEY)$/.test(token)) {
    return true
  }
  if (
    /(?:example|placeholder|dummy|fake|mock|sample|redacted|your[_-]|xxxx|00000000|12345678)/i.test(
      token,
    )
  ) {
    return true
  }
  const core = token.replace(
    /^(?:sk-ant-api03-|sk-ant-|sk-proj-|sk-|gh[pousr]_|github_pat_|AKIA|ASIA|AIza)/,
    '',
  )
  return core.length > 0 && new Set(core).size <= 3
}

const SECRET_PATTERNS: ReadonlyArray<{ ruleId: string; re: RegExp; label: string }> = [
  { ruleId: 'SEC-SECRET-AWS-ACCESS-KEY', re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, label: 'Hardcoded AWS Access Key ID' },
  { ruleId: 'SEC-SECRET-AWS-SECRET-KEY', re: /(?:aws_secret_access_key|awsSecretAccessKey)\s*[:=]\s*['"]([A-Za-z0-9/+=]{40})['"]/gi, label: 'Hardcoded AWS Secret Access Key' },
  { ruleId: 'SEC-SECRET-GCP-API-KEY', re: /\b(AIza[0-9A-Za-z\-_]{35})\b/g, label: 'Hardcoded GCP API Key' },
  { ruleId: 'SEC-SECRET-GITHUB-PAT', re: /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})\b/g, label: 'Hardcoded GitHub Personal Access Token' },
  { ruleId: 'SEC-SECRET-ANTHROPIC-KEY', re: /\b(sk-ant-(?:api03-|admin01-)?[A-Za-z0-9_-]{28,255})\b/g, label: 'Hardcoded Anthropic API Key' },
  { ruleId: 'SEC-SECRET-OPENAI-KEY', re: /\b(sk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,255})\b/g, label: 'Hardcoded OpenAI API Key' },
  { ruleId: 'SEC-SECRET-JWT-TOKEN', re: /\b(eyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,})\b/g, label: 'Hardcoded signed JWT bearer token' },
]

export function scanSecretsInText(file: string, text: string): SastFinding[] {
  const normFile = file.replace(/\\/g, '/')
  const lines = text.split(/\r?\n/)
  const findings: SastFinding[] = []

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!
    if (!line || hasInlineSecretAllow(lines, idx)) continue

    if (line.includes('PRIVATE KEY-----') && /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/.test(line)) {
      const nextLine = (lines[idx + 1] ?? '').trim()
      const hasPemBody =
        /[A-Za-z0-9+/=]{28,}/.test(nextLine) ||
        line.includes('\\nMII') ||
        line.includes('\\nb3BlbnNzaC')
      if (hasPemBody) {
        findings.push({
          ruleId: 'SEC-SECRET-PRIVATE-KEY-PEM',
          category: 'secret',
          file: normFile,
          line: idx + 1,
          snippet: '-----BEGIN * PRIVATE KEY----- [REDACTED]',
          detail: 'Embedded PEM private key material detected',
        })
      }
    }

    for (const pat of SECRET_PATTERNS) {
      pat.re.lastIndex = 0
      let m = pat.re.exec(line)
      while (m !== null) {
        const secretVal = m[1] ?? m[0]
        if (!isPlaceholderToken(secretVal)) {
          findings.push({
            ruleId: pat.ruleId,
            category: 'secret',
            file: normFile,
            line: idx + 1,
            snippet: redactSecret(secretVal),
            detail: `${pat.label} (${redactSecret(secretVal)})`,
          })
        }
        m = pat.re.exec(line)
      }
    }

    if (/jwt|token|hmac/i.test(line)) {
      const jwtAssign =
        /\b(?:jwt[_-]?secret|jwt[_-]?signing[_-]?key|token[_-]?secret)\b\s*(?::\s*string\s*)?[:=]\s*(['"`])([^'"`\n]{10,})\1/i.exec(
          line,
        )
      if (jwtAssign) {
        const val = jwtAssign[2]!.trim()
        if (!/^[A-Z][A-Z0-9_]+$/.test(val) && !val.includes('${') && !isPlaceholderToken(val)) {
          findings.push({
            ruleId: 'SEC-SECRET-JWT-SECRET',
            category: 'secret',
            file: normFile,
            line: idx + 1,
            snippet: `jwtSecret=${redactSecret(val)}`,
            detail: 'Hardcoded JWT signing secret literal; read from environment/config instead',
          })
        }
      }
    }
  }
  return findings
}

function isSqlText(s: string): boolean {
  if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/i.test(s)) {
    return true
  }
  if (/\bUPDATE\s+[A-Za-z0-9_."]+\s+SET\b/i.test(s)) return true
  return /\bSELECT\b/i.test(s) && /\bFROM\b/i.test(s)
}

const SQL_METHODS = new Set(['query', 'exec', 'execute', 'unsafe'])
const DB_RECEIVER_RE = /(?:pool|db|client|tx|conn|pg|sqlite|store|backend)$/i
const CHILD_PROCESS_MODS = new Set(['child_process', 'node:child_process'])
const SANITIZER_CALL_RE = /^(?:shellEscape|shellQuote|escapeShellArg|quoteShellArg|Number|parseInt)$/
const AST_FAST_PRECHECK_RE = /\b(?:query|exec|execute|unsafe|execSync|child_process|fetch)\b/

function isSmallConstantBoundForLoop(node: ts.ForStatement): boolean {
  const cond = node.condition
  if (!cond || !ts.isBinaryExpression(cond)) return false
  const op = cond.operatorToken.kind
  if (op !== ts.SyntaxKind.LessThanToken && op !== ts.SyntaxKind.LessThanEqualsToken) return false
  return ts.isNumericLiteral(cond.right) && Number(cond.right.text) <= 10
}

function isNestedFn(node: ts.Node): boolean {
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

function exprIsSafeShellPiece(expr: ts.Expression): boolean {
  if (
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    ts.isNumericLiteral(expr)
  ) {
    return true
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ''
    return SANITIZER_CALL_RE.test(name)
  }
  return false
}

function extractSqlDynamicText(expr: ts.Expression): { dynamic: boolean; staticSql: string } {
  if (ts.isTemplateExpression(expr)) {
    const staticSql =
      expr.head.text + expr.templateSpans.map((s) => ` $EXPR ${s.literal.text}`).join('')
    return { dynamic: expr.templateSpans.length > 0, staticSql }
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = extractSqlDynamicText(expr.left)
    const right = extractSqlDynamicText(expr.right)
    const ls = ts.isStringLiteral(expr.left) || ts.isNoSubstitutionTemplateLiteral(expr.left)
    const rs = ts.isStringLiteral(expr.right) || ts.isNoSubstitutionTemplateLiteral(expr.right)
    return {
      dynamic: left.dynamic || right.dynamic || !ls || !rs,
      staticSql: `${ls ? expr.left.text : left.staticSql} ${rs ? expr.right.text : right.staticSql}`,
    }
  }
  return { dynamic: false, staticSql: '' }
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

export function scanAstSecurityAntipatterns(file: string, text: string): SastFinding[] {
  if (!AST_FAST_PRECHECK_RE.test(text)) return []
  const normFile = file.replace(/\\/g, '/')
  const lines = text.split(/\r?\n/)
  const lineStarts = buildLineStarts(text)
  const sf = ts.createSourceFile(
    normFile,
    text,
    ts.ScriptTarget.Latest,
    false,
    normFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const cpExecIds = new Set<string>()
  const cpNsIds = new Set<string>()
  const regexIds = new Set<string>()
  const collectRegexBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer
      if (
        ts.isRegularExpressionLiteral(init) ||
        (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'RegExp')
      ) {
        regexIds.add(node.name.text)
      }
    }
    ts.forEachChild(node, collectRegexBindings)
  }
  collectRegexBindings(sf)

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (!CHILD_PROCESS_MODS.has(stmt.moduleSpecifier.text)) continue
      const c = stmt.importClause
      if (c?.name) cpNsIds.add(c.name.text)
      if (c?.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) cpNsIds.add(c.namedBindings.name.text)
        else if (ts.isNamedImports(c.namedBindings)) {
          for (const el of c.namedBindings.elements) {
            const orig = (el.propertyName ?? el.name).text
            if (orig === 'exec' || orig === 'execSync') cpExecIds.add(el.name.text)
          }
        }
      }
    }
  }

  const findings: SastFinding[] = []
  const lineOf = (n: ts.Node) => lineAtOffset(lineStarts, Math.min(text.length, n.pos + 1))

  const isShellExecCall = (call: ts.CallExpression): boolean => {
    const callee = call.expression
    if (ts.isIdentifier(callee)) return callee.text === 'execSync' || cpExecIds.has(callee.text)
    if (ts.isPropertyAccessExpression(callee)) {
      if (callee.name.text === 'execSync') return true
      return (
        callee.name.text === 'exec' &&
        ts.isIdentifier(callee.expression) &&
        cpNsIds.has(callee.expression.text)
      )
    }
    return false
  }

  const isNetOrSqlCall = (expr: ts.Expression): 'fetch' | 'sql' | null => {
    let target = expr
    if (
      ts.isCallExpression(target) &&
      ts.isPropertyAccessExpression(target.expression) &&
      (target.expression.name.text === 'json' || target.expression.name.text === 'text')
    ) {
      target = target.expression.expression
    }
    if (!ts.isCallExpression(target)) return null
    const callee = target.expression
    if (ts.isIdentifier(callee) && callee.text === 'fetch') return 'fetch'
    if (ts.isPropertyAccessExpression(callee)) {
      const mName = callee.name.text
      if (
        mName === 'fetch' &&
        ts.isIdentifier(callee.expression) &&
        ['globalThis', 'window', 'undici'].includes(callee.expression.text)
      ) {
        return 'fetch'
      }
      if (SQL_METHODS.has(mName)) {
        const recvSlice = text.slice(callee.expression.pos, callee.expression.end).trim()
        if (DB_RECEIVER_RE.test(recvSlice)) return 'sql'
        const a0 = target.arguments[0]
        if (a0 && isSqlText(text.slice(a0.pos, Math.min(a0.end, a0.pos + 600)))) return 'sql'
      }
    }
    return null
  }

  const visit = (node: ts.Node, inUnboundedLoop: boolean): void => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const arg0 = node.arguments[0]!
      const ln = lineOf(node)

      if (ts.isPropertyAccessExpression(node.expression) && SQL_METHODS.has(node.expression.name.text)) {
        const mName = node.expression.name.text
        const recv = node.expression.expression
        const isRegExpExec =
          mName === 'exec' &&
          (ts.isRegularExpressionLiteral(recv) ||
            (ts.isNewExpression(recv) && ts.isIdentifier(recv.expression) && recv.expression.text === 'RegExp') ||
            (ts.isIdentifier(recv) && (regexIds.has(recv.text) || /^(?:re|rx|regex|regexp|pat|pattern)/i.test(recv.text))))
        const { dynamic, staticSql } = extractSqlDynamicText(arg0)
        if (!isRegExpExec && dynamic && isSqlText(staticSql) && !hasInlineSastWaiver(lines, ln - 1, 'SEC-SAST-SQL-INTERPOLATION')) {
          findings.push({
            ruleId: 'SEC-SAST-SQL-INTERPOLATION',
            category: 'sast',
            file: normFile,
            line: ln,
            snippet: (lines[ln - 1] ?? '').trim().slice(0, 120),
            detail: `Interpolated SQL string passed to .${node.expression.name.text}(); use parameterized placeholders ($1, ?)`,
          })
        }
      }

      if (isShellExecCall(node) && !hasInlineSastWaiver(lines, ln - 1, 'SEC-SAST-SHELL-INJECTION')) {
        let unsafeShell = false
        if (ts.isTemplateExpression(arg0)) {
          unsafeShell = arg0.templateSpans.some((s) => !exprIsSafeShellPiece(s.expression))
        } else if (ts.isBinaryExpression(arg0) && arg0.operatorToken.kind === ts.SyntaxKind.PlusToken) {
          unsafeShell = !(exprIsSafeShellPiece(arg0.left) && exprIsSafeShellPiece(arg0.right))
        }
        if (unsafeShell) {
          findings.push({
            ruleId: 'SEC-SAST-SHELL-INJECTION',
            category: 'sast',
            file: normFile,
            line: ln,
            snippet: (lines[ln - 1] ?? '').trim().slice(0, 120),
            detail: 'Dynamic string interpolated into shell exec/execSync; use execFile/execFileSync with argument array',
          })
        }
      }
    }

    if (inUnboundedLoop && ts.isAwaitExpression(node)) {
      const awaitKind = isNetOrSqlCall(node.expression)
      const ln = lineOf(node)
      if (awaitKind && !hasInlineSastWaiver(lines, ln - 1, 'SEC-SAST-UNBOUNDED-LOOP-AWAIT')) {
        findings.push({
          ruleId: 'SEC-SAST-UNBOUNDED-LOOP-AWAIT',
          category: 'sast',
          file: normFile,
          line: ln,
          snippet: (lines[ln - 1] ?? '').trim().slice(0, 120),
          detail: `Unbounded loop awaits ${awaitKind === 'fetch' ? 'network fetch()' : 'SQL query'} sequentially (N+1 / stall risk)`,
        })
      }
    }

    const entersLoop =
      (ts.isForStatement(node) && !isSmallConstantBoundForLoop(node)) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)

    ts.forEachChild(node, (child) => {
      if (isNestedFn(child)) visit(child, false)
      else if (entersLoop) visit(child, inUnboundedLoop || (ts.isIterationStatement(node, false) && child === node.statement))
      else visit(child, inUnboundedLoop)
    })
  }

  visit(sf, false)
  return findings
}

export function scanFileSecurity(file: string, text: string): SastFinding[] {
  return [...scanSecretsInText(file, text), ...scanAstSecurityAntipatterns(file, text)]
}

export function buildSecurityBaseline(findings: SastFinding[]): SecurityBaseline {
  const entries: Record<string, number> = {}
  const byRule: Record<string, number> = {}
  let totalCount = 0
  for (const f of findings) {
    if (f.category === 'secret') continue
    const key = `${f.file}|${f.ruleId}`
    entries[key] = (entries[key] ?? 0) + 1
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1
    totalCount++
  }
  const sortedEntries = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)),
  )
  return {
    schemaVersion: 1,
    summary: {
      totalEntries: Object.keys(sortedEntries).length,
      totalCount,
      byRule: Object.fromEntries(Object.entries(byRule).sort(([a], [b]) => (a < b ? -1 : 1))),
    },
    entries: sortedEntries,
  }
}

export function parseSecurityBaseline(raw: unknown): SecurityBaseline {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('security-sast baseline must be a JSON object')
  }
  const obj = raw as Partial<SecurityBaseline>
  if (obj.schemaVersion !== 1 || typeof obj.entries !== 'object' || obj.entries === null) {
    throw new Error('security-sast baseline requires schemaVersion=1 and entries map')
  }
  for (const [k, v] of Object.entries(obj.entries)) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`invalid count for "${k}" in baseline`)
  }
  return obj as SecurityBaseline
}

export function evaluateSecurityBaseline(
  findings: SastFinding[],
  baseline: SecurityBaseline,
  renames = new Map<string, string>(),
): SecurityViolation[] {
  const violations: SecurityViolation[] = []
  const currentCounts = new Map<string, { count: number; sample: SastFinding }>()

  for (const f of findings) {
    if (f.category === 'secret') {
      violations.push({
        kind: 'secret-leak',
        ruleId: f.ruleId,
        file: f.file,
        line: f.line,
        actualCount: 1,
        allowedCount: 0,
        detail: `${f.file}:${f.line} [${f.ruleId}] ${f.detail}`,
      })
      continue
    }
    const key = `${f.file}|${f.ruleId}`
    const prev = currentCounts.get(key)
    if (!prev) currentCounts.set(key, { count: 1, sample: f })
    else prev.count++
  }

  const movedBaseline = new Map<string, number>()
  for (const [key, count] of Object.entries(baseline.entries)) {
    const [file, ruleId] = key.split('|')
    const mapped = `${renames.get(file!) ?? file}|${ruleId}`
    movedBaseline.set(mapped, (movedBaseline.get(mapped) ?? 0) + count)
  }

  for (const [key, info] of currentCounts) {
    const allowed = movedBaseline.get(key) ?? 0
    if (info.count > allowed) {
      violations.push({
        kind: 'new-or-grown-sast',
        ruleId: info.sample.ruleId,
        file: info.sample.file,
        line: info.sample.line,
        actualCount: info.count,
        allowedCount: allowed,
        detail: `${info.sample.file}:${info.sample.line} [${info.sample.ruleId}] count ${info.count} > baseline ${allowed}: ${info.sample.detail}`,
      })
    }
  }
  return violations
}

export function compareSecurityBaselines(
  base: SecurityBaseline,
  head: SecurityBaseline,
  renames = new Map<string, string>(),
): SecurityViolation[] {
  const violations: SecurityViolation[] = []
  const movedBase = new Map<string, number>()
  for (const [key, count] of Object.entries(base.entries)) {
    const [file, ruleId] = key.split('|')
    const mapped = `${renames.get(file!) ?? file}|${ruleId}`
    movedBase.set(mapped, (movedBase.get(mapped) ?? 0) + count)
  }
  for (const [key, headVal] of Object.entries(head.entries)) {
    const baseVal = movedBase.get(key)
    const [file, ruleId] = key.split('|')
    if (baseVal === undefined ? headVal > 0 : headVal > baseVal) {
      violations.push({
        kind: 'baseline-raised',
        ruleId: ruleId ?? 'UNKNOWN',
        file: file ?? BASELINE_REL_PATH,
        actualCount: headVal,
        allowedCount: baseVal ?? 0,
        detail:
          baseVal === undefined
            ? `new entry "${key}" (${headVal}) added to ${BASELINE_REL_PATH}`
            : `baseline count for "${key}" raised (${baseVal} -> ${headVal})`,
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

export function main(argv = process.argv.slice(2)): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let baselineRel = BASELINE_REL_PATH
  let writeBaseline = false
  let updateBaseline = false
  let enforce = false
  let baseRef = ''
  let jsonOut: string | boolean = false

  const argErr = (msg: string): number => {
    console.error(`[security-sast] ${msg}`)
    return 2
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--root') {
      if (!argv[i + 1]) return argErr('--root requires a path')
      root = path.resolve(argv[++i]!)
    } else if (arg === '--baseline') {
      if (!argv[i + 1]) return argErr('--baseline requires a path')
      baselineRel = argv[++i]!
    } else if (arg === '--write-baseline') writeBaseline = true
    else if (arg === '--update-baseline') updateBaseline = true
    else if (arg === '--enforce') enforce = true
    else if (arg === '--base') {
      if (!argv[i + 1]) return argErr('--base requires a git ref')
      baseRef = argv[++i]!
    } else if (arg === '--json') {
      jsonOut = i + 1 < argv.length && !argv[i + 1]!.startsWith('--') ? argv[++i]! : true
    } else return argErr(`unknown argument: ${arg}`)
  }

  try {
    const baselineAbs = path.isAbsolute(baselineRel) ? baselineRel : path.join(root, baselineRel)
    const prodFiles = discoverProductionFiles(root)
    if (enforce) {
      const coverageErr = checkDiscoveryCoverage(root, prodFiles)
      if (coverageErr) {
        console.error(`[GATE-ERROR] SECURITY-SAST (coverage-zero): ${coverageErr}`)
        return 1
      }
    }
    const findings: SastFinding[] = []
    for (const rel of prodFiles) {
      findings.push(...scanFileSecurity(rel, readFileSync(path.join(root, rel), 'utf8')))
    }
    const secretFindings = findings.filter((f) => f.category === 'secret')

    if (writeBaseline) {
      if (secretFindings.length > 0) {
        console.error(
          `[security-sast] REFUSING --write-baseline: ${secretFindings.length} secret leak(s) detected:`,
        )
        for (const s of secretFindings) console.error(`  ${s.file}:${s.line} [${s.ruleId}] ${s.detail}`)
        return 1
      }
      const built = buildSecurityBaseline(findings)
      mkdirSync(path.dirname(baselineAbs), { recursive: true })
      writeFileSync(baselineAbs, `${JSON.stringify(built, null, 2)}\n`)
      console.log(
        `[security-sast] wrote ${baselineRel}: ${prodFiles.length} files scanned, ${built.summary.totalCount} SAST findings frozen across ${built.summary.totalEntries} file-rule pairs (0 secrets)`,
      )
      return 0
    }
    if (!existsSync(baselineAbs)) {
      console.error(`[security-sast] FAIL-CLOSED: missing baseline ${baselineRel}`)
      return 2
    }
    const headBaseline = parseSecurityBaseline(JSON.parse(readFileSync(baselineAbs, 'utf8')))

    if (updateBaseline) {
      const currentBuilt = buildSecurityBaseline(findings)
      const shrunk: Record<string, number> = {}
      const byRule: Record<string, number> = {}
      let totalCount = 0
      for (const [k, was] of Object.entries(headBaseline.entries)) {
        const next = Math.min(was, currentBuilt.entries[k] ?? 0)
        if (next > 0) {
          shrunk[k] = next
          const r = k.split('|')[1] ?? 'UNKNOWN'
          byRule[r] = (byRule[r] ?? 0) + next
          totalCount += next
        }
      }
      const updated: SecurityBaseline = {
        schemaVersion: 1,
        summary: { totalEntries: Object.keys(shrunk).length, totalCount, byRule },
        entries: shrunk,
      }
      writeFileSync(baselineAbs, `${JSON.stringify(updated, null, 2)}\n`)
      console.log(`[security-sast] updated ${baselineRel}: ${headBaseline.summary.totalCount} -> ${totalCount}`)
      return 0
    }

    let renames = new Map<string, string>()
    const violations: SecurityViolation[] = []
    if (baseRef) {
      execFileSync('git', ['-C', root, 'rev-parse', '--verify', `${baseRef}^{commit}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      renames = gitRenamesSince(root, baseRef)
      const baseText = readGitFile(root, baseRef, baselineRel)
      if (baseText !== null) {
        violations.push(
          ...compareSecurityBaselines(parseSecurityBaseline(JSON.parse(baseText)), headBaseline, renames),
        )
      }
    }

    violations.push(...evaluateSecurityBaseline(findings, headBaseline, renames))
    const report = {
      scannedFiles: prodFiles.length,
      secretCount: secretFindings.length,
      sastFindingCount: findings.length - secretFindings.length,
      baselinedCount: headBaseline.summary.totalCount,
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
        `[GATE-ERROR] SECURITY-SAST (${v.kind}) [${v.ruleId}] at ${v.file}${v.line ? `:${v.line}` : ''}\n  Violation : ${v.detail}`,
      )
    }
    console.log(
      `[security-sast] files=${prodFiles.length} secrets=${secretFindings.length} sastFindings=${report.sastFindingCount} baselined=${headBaseline.summary.totalCount} violations=${violations.length}`,
    )
    return enforce && violations.length > 0 ? 1 : 0
  } catch (err) {
    console.error(`[security-sast] FAIL-CLOSED: ${(err as Error).message}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
