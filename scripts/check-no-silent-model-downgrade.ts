/**
 * First Red-Line Gate: Forbid Silent Model Downgrade to Weak/Lightweight Models
 * (OCV5-817 `/btw` & OCV5-825 Cron lessons; Governance Blueprint §4.2 ①).
 *
 * Scans `packages/gateway/src` and `packages/commercial/src` (TypeScript AST) for
 * weak/lightweight model slugs (`deepseek-v4-flash`, `*haiku*`, `*-mini`, `*-flash-lite`,
 * `glm-*-flash`, etc.) used in execution / fallback / downgrade / default-substitution
 * branches (including `/btw`, `quickAsk`, `cron`, `ai_review`, `turn`, `session`, `delegate`).
 *
 * Legitimate isolated system chores (titles, summaries, moderation, voice polish, compaction,
 * model catalog/pricing/alias tables) or lines explicitly marked with
 * `// oc-model-chore: <reason>` (outside strict red-line paths) are permitted.
 *
 * Usage:
 *   npx tsx scripts/check-no-silent-model-downgrade.ts [--root <repo>]
 *
 * Exit: 0 ok, 1 violation(s) found, 2 usage/parse error.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export interface DowngradeViolation {
  file: string
  line: number
  slug: string
  reason: string
  snippet: string
}

/**
 * Matches concrete weak/lightweight LLM model slugs while avoiding false positives
 * on non-model words (`better-sqlite3`, `MiniMax-M3`, `satellite`, `literature`, `gemini-2.5-pro`).
 */
export const WEAK_MODEL_SLUG_RE =
  /^(?:(?:box|box-api|cursor|antigravity|anthropic|openai|google|deepseek|zhipu|qwen)[/-])?(?:deepseek-[a-z0-9._-]*flash(?:-[a-z0-9._-]+)?|deepseek-lite|claude-(?:\d+(?:[.-]\d+)?-)?haiku(?:-[a-z0-9._-]+)?|haiku(?:-[0-9._-]+)?|glm-[a-z0-9._-]*flash(?:-[a-z0-9._-]+)?|gemini-[a-z0-9._-]*flash(?:-lite)?(?:-[a-z0-9._-]+)?|gpt-(?:4o|4\.1|5|5\.\d+)-(?:mini|nano)(?:-[a-z0-9._-]+)?|o[134]-mini(?:-[a-z0-9._-]+)?|gpt-3\.5-turbo(?:-[a-z0-9._-]+)?|qwen[a-z0-9._-]*turbo(?:-[a-z0-9._-]+)?)$/i

const SCAN_ROOTS = ['packages/gateway/src', 'packages/commercial/src'] as const
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-types',
  'build',
  'generated',
  '__tests__',
  '__smoke__',
])

/**
 * Strict red-line files where weak-model fallback/defaults are ALWAYS forbidden
 * and CANNOT be exempted with `// oc-model-chore:` comments:
 * main chat submission/turn runner/bridge, gateway engine adapters & turn routers,
 * Cron, /btw (quickAsk), and action-policy ai_review paths.
 */
const STRICT_RED_LINE_FILE_RE =
  /(?:^|\/)(?:cron[^/]*|[^/]*(?:btw|quick[-_]?ask)[^/]*|actionPolicyEngine|sessionSubmit|sessionTurnRunner|sessionManager|userChatBridge)\.ts$|^packages\/gateway\/src\/(?:engine\/.*\.ts|turn[^/]*\.ts|[^/]*ai[-_]?review[^/]*\.ts)$/i

/**
 * Business execution domain files where any non-whitelisted weak model literal used as
 * a runtime value (assignment, return, fallback, property value) is forbidden.
 */
const EXECUTION_DOMAIN_FILE_RE =
  /(?:^|\/)(?:cron[^/]*|[^/]*(?:btw|quick[-_]?ask)[^/]*|actionPolicyEngine|session(?:Submit|Manager|TurnRunner)|inboundDispatch|turn[^/]*|delegate(?:Runtime|Policy|Jobs)|advisor[^/]*|localExecution|userChatBridge|router)\.ts$|^packages\/gateway\/src\/engine\/.*\.ts$/i

/**
 * Whitelisted pure catalog, pricing, upstream alias mapping, and isolated system-chore files.
 * These are explicitly NOT main-brain / btw / cron / ai_review execution paths.
 */
const WHITELISTED_PATH_PATTERNS: readonly RegExp[] = [
  // Catalog, pricing, upstream ID mapping & verification tables
  /(?:^|\/)(?:modelCatalog|pricing|openCodeGoCatalog|modelResolution|antigravityPool|boxNativeContextOwner|verificationBudget|verificationSponsorship|seedPlatformAgents|platformDefaults)\.ts$/i,
  // Dedicated isolated system-chore modules (titles, summaries, moderation, voice polish, compaction, auto-dream, skill-train, secondary utility)
  /(?:^|\/)[^/]*(?:title|summary)[^/]*\.ts$/i,
  /(?:^|\/)(?:autoDreamModels|boxSwitchCompaction|voiceTranscribe|tutorialModeration|knowledgePlanetAutomationScheduler|skillTrain|subprocessSpawnConfig)\.ts$/i,
  /^packages\/commercial\/src\/marketplace\/aiReview\.ts$/,
]

/**
 * Grandfathered legacy platform-default / exact upstream alias sites already present at
 * baseline `35c963ab7`. Only these exact symbol/line contexts are grandfathered; any NEW
 * weak-model fallback added anywhere else in these files (including with `// oc-model-chore:`)
 * is immediately blocked.
 */
const GRANDFATHERED_LEGACY_SITES: Readonly<Record<string, readonly RegExp[]>> = {
  'packages/gateway/src/sessionSubmit.ts': [
    /session\.model\s*=\s*desiredModel\s*\?\?\s*this\.config\.defaults\.model\s*\?\?\s*['"]deepseek-v4-flash['"]/,
  ],
  'packages/gateway/src/engine/cursorBoxCcExec.ts': [
    /'box-claude-haiku-[45]-5':\s*'claude-haiku-[45]-5'/,
    /model\s*===\s*'cursor-haiku-4\.5'\s*\|\|\s*model\.startsWith\('cursor-haiku-'\)\)\s*return\s*'claude-haiku-4-5'/,
  ],
  'packages/gateway/src/localExecution.ts': [
    /\bEXECUTION_MODEL_FALLBACK_ROUTE\b/,
    /\bSYNTHETIC_TURN_NON_CODEX_MODEL_DEFAULT\b/,
  ],
  'packages/gateway/src/delegatePolicy.ts': [/\bDELEGATE_GROK_FALLBACK_MODEL\b/],
}

/** Semantic keywords indicating model selection, fallback, downgrade, or red-line domain. */
const FALLBACK_CONTEXT_RE =
  /(?:fallback|downgrade|degrade|default_?model|backup_?model|model|btw|quick_?ask|cron|ai_?review|review_?model)/i

/** Explicit inline escape hatch for legitimate isolated chores (blocked in strict red-line files). */
const CHORE_MARKER_RE = /\/\/\s*oc-model-chore:\s*\S.{3,}/

function isProductionTs(rel: string): boolean {
  return (
    rel.endsWith('.ts') &&
    !rel.endsWith('.d.ts') &&
    !rel.endsWith('.test.ts') &&
    !rel.endsWith('.spec.ts') &&
    !/(^|\/)(__tests__|__smoke__|test|tests|generated)\//.test(rel)
  )
}

function collectFiles(root: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    const abs = path.join(root, rel)
    if (!existsSync(abs)) return
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue
      const next = `${rel}/${ent.name}`
      if (ent.isDirectory()) walk(next)
      else if (ent.isFile() && isProductionTs(next)) out.push(next)
    }
  }
  for (const dir of SCAN_ROOTS) walk(dir)
  return out.sort()
}

function hasChoreMarker(lines: readonly string[], line1Based: number): boolean {
  const cur = lines[line1Based - 1] ?? ''
  const prev = lines[line1Based - 2] ?? ''
  return CHORE_MARKER_RE.test(cur) || CHORE_MARKER_RE.test(prev)
}

function enclosingStatementOrEntryText(node: ts.Node, sf: ts.SourceFile): string {
  let cur: ts.Node | undefined = node
  while (cur) {
    if (ts.isReturnStatement(cur)) {
      // Preserve single-statement `if (...) return '...'` without widening to sibling statements
      if (cur.parent && ts.isIfStatement(cur.parent)) {
        return cur.parent.getText(sf)
      }
      return cur.getText(sf)
    }
    if (
      ts.isPropertyAssignment(cur) ||
      ts.isVariableDeclaration(cur) ||
      ts.isExpressionStatement(cur)
    ) {
      return cur.getText(sf)
    }
    cur = cur.parent
  }
  return node.getText(sf)
}

function isGrandfathered(rel: string, node: ts.Node, sf: ts.SourceFile): boolean {
  const patterns = GRANDFATHERED_LEGACY_SITES[rel]
  if (!patterns) return false
  const nodeText = enclosingStatementOrEntryText(node, sf)
  return patterns.some((re) => re.test(nodeText))
}

function isComparisonOrCheckContext(node: ts.Node): boolean {
  const p = node.parent
  if (!p) return false
  // `model === 'deepseek-v4-flash'`, `model !== '...'`
  if (
    ts.isBinaryExpression(p) &&
    (p.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      p.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      p.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
      p.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
  ) {
    return true
  }
  // `case 'deepseek-v4-flash':`
  if (ts.isCaseClause(p)) return true
  // Property key in a map/record (`{ 'box-claude-haiku-4-5': ... }`)
  if (ts.isPropertyAssignment(p) && p.name === node) return true
  // Import/export specifier or type literal
  if (
    ts.isImportDeclaration(p) ||
    ts.isExportDeclaration(p) ||
    ts.isLiteralTypeNode(p) ||
    ts.isTypeReferenceNode(p)
  ) {
    return true
  }
  // Membership / predicate calls: `.has('...')`, `.includes('...')`, `.startsWith('...')`, `.endsWith('...')`
  if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression)) {
    const fn = p.expression.name.text
    if (fn === 'has' || fn === 'includes' || fn === 'startsWith' || fn === 'endsWith' || fn === 'test') {
      return true
    }
  }
  return false
}

function enclosingContextName(node: ts.Node): string {
  const names: string[] = []
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      names.push(cur.name.text)
    } else if (ts.isPropertyAssignment(cur)) {
      if (ts.isIdentifier(cur.name) || ts.isStringLiteral(cur.name)) names.push(cur.name.text)
    } else if (ts.isParameter(cur) && ts.isIdentifier(cur.name)) {
      names.push(cur.name.text)
    } else if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      names.push(cur.left.getText())
    } else if (ts.isFunctionDeclaration(cur) && cur.name) {
      names.push(cur.name.text)
    } else if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) {
      names.push(cur.name.text)
    }
    cur = cur.parent
  }
  return names.join(' ')
}

function classifySuspiciousUsage(
  node: ts.StringLiteralLike,
  isExecutionFile: boolean,
): string | null {
  if (isComparisonOrCheckContext(node)) return null
  // Check parent chain for fallback / default / downgrade expressions
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isTypeNode(cur)) return null
    if (
      ts.isBinaryExpression(cur) &&
      (cur.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        cur.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      cur.right === node
    ) {
      return 'implicit fallback (`??` / `||`) to weak model'
    }
    if (ts.isConditionalExpression(cur) && (cur.whenTrue === node || cur.whenFalse === node)) {
      const ctx = enclosingContextName(node)
      if (isExecutionFile || FALLBACK_CONTEXT_RE.test(ctx)) {
        return 'conditional fallback/branch to weak model'
      }
    }
    if (ts.isParameter(cur) && cur.initializer === node) {
      const ctx = enclosingContextName(node)
      if (isExecutionFile || FALLBACK_CONTEXT_RE.test(ctx)) {
        return 'default parameter pinned to weak model'
      }
    }
    if (
      ts.isBinaryExpression(cur) &&
      cur.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      cur.right === node
    ) {
      const ctx = enclosingContextName(node)
      if (isExecutionFile || FALLBACK_CONTEXT_RE.test(ctx)) {
        return 'assignment of weak model in model/fallback context'
      }
    }
    if (ts.isVariableDeclaration(cur) && cur.initializer === node) {
      const ctx = enclosingContextName(node)
      if (isExecutionFile || FALLBACK_CONTEXT_RE.test(ctx)) {
        return 'variable/constant initialized to weak model in execution/fallback context'
      }
    }
    if (ts.isPropertyAssignment(cur) && cur.initializer === node) {
      const ctx = enclosingContextName(node)
      if (isExecutionFile || FALLBACK_CONTEXT_RE.test(ctx)) {
        return 'object property defaulted to weak model'
      }
    }
    if (ts.isReturnStatement(cur) && cur.expression === node) {
      const ctx = enclosingContextName(node)
      if (isExecutionFile || FALLBACK_CONTEXT_RE.test(ctx)) {
        return 'function returns weak model in execution/fallback context'
      }
    }
    if (ts.isArrayLiteralExpression(cur)) {
      const ctx = enclosingContextName(node)
      if (isExecutionFile && FALLBACK_CONTEXT_RE.test(ctx)) {
        return 'weak model listed in execution fallback route'
      }
    }
    // Only walk immediate expression wrappers (parentheses / `as` / satisfies / array)
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isArrayLiteralExpression(cur)
    ) {
      cur = cur.parent
      continue
    }
    break
  }
  return null
}

/** Fast pre-filter: skip AST parsing for files that cannot contain any weak-model slug. */
const QUICK_PREFILTER_RE =
  /(?:deepseek-[a-z0-9._-]*flash|deepseek-lite|haiku|glm-[a-z0-9._-]*flash|gemini-[a-z0-9._-]*flash|gpt-(?:4o|4\.1|5|5\.\d+)-(?:mini|nano)|o[134]-mini|gpt-3\.5-turbo|qwen[a-z0-9._-]*turbo)/i

export function scanFileForSilentDowngrades(rel: string, text: string): DowngradeViolation[] {
  const normalized = rel.replace(/\\/g, '/')
  const isStrictRedLine = STRICT_RED_LINE_FILE_RE.test(normalized)
  if (!isStrictRedLine && WHITELISTED_PATH_PATTERNS.some((re) => re.test(normalized))) {
    return []
  }
  if (!QUICK_PREFILTER_RE.test(text)) {
    return []
  }

  const sf = ts.createSourceFile(normalized, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const lines = text.split('\n')
  const isExecutionFile = isStrictRedLine || EXECUTION_DOMAIN_FILE_RE.test(normalized)
  const violations: DowngradeViolation[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const raw = node.text.trim()
      if (raw && WEAK_MODEL_SLUG_RE.test(raw)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        if (!isStrictRedLine && hasChoreMarker(lines, line)) return
        if (isGrandfathered(normalized, node, sf)) return

        const reason = classifySuspiciousUsage(node, isExecutionFile)
        if (reason) {
          violations.push({
            file: normalized,
            line,
            slug: raw,
            reason,
            snippet: (lines[line - 1] ?? '').trim(),
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return violations
}

export function checkNoSilentModelDowngrade(root: string): {
  filesScanned: number
  violations: DowngradeViolation[]
} {
  const files = collectFiles(root)
  const violations: DowngradeViolation[] = []
  for (const rel of files) {
    const text = readFileSync(path.join(root, rel), 'utf8')
    violations.push(...scanFileForSilentDowngrades(rel, text))
  }
  return { filesScanned: files.length, violations }
}

export function formatViolation(v: DowngradeViolation): string {
  return [
    `[GATE-ERROR] NO-SILENT-MODEL-DOWNGRADE at ${v.file}:${v.line}`,
    `  Violation : ${v.reason} (${JSON.stringify(v.slug)}) -> ${v.snippet}`,
    '  Why       : First Red Line (OCV5-817 / OCV5-825): main turns, /btw, Cron, and ai_review must NEVER silently downgrade to a weak/lightweight model.',
    '  How to Fix: Inherit the user/session explicit strong model or fail explicitly with a structured error. If this is strictly an isolated non-decision system chore (e.g. title/summary), move it to a chore module or annotate with `// oc-model-chore: <reason>`.',
    '  Re-verify : npx tsx scripts/check-no-silent-model-downgrade.ts',
  ].join('\n')
}

function main(argv: string[]): number {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const val = argv[++i]
      if (!val) {
        console.error('[no-silent-model-downgrade] --root requires a path')
        return 2
      }
      root = path.resolve(val)
    } else {
      console.error(`[no-silent-model-downgrade] unknown arg: ${argv[i]}`)
      return 2
    }
  }
  const t0 = Date.now()
  const { filesScanned, violations } = checkNoSilentModelDowngrade(root)
  const ms = Date.now() - t0
  for (const v of violations) console.error(formatViolation(v))
  console.log(
    `[no-silent-model-downgrade] scanned ${filesScanned} files in ${ms}ms: ${violations.length} violation(s)`,
  )
  return violations.length > 0 ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)))
}
