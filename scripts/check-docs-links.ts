/**
 * Fast (<2s) governance documentation link & npm script gate.
 *
 * Scans core governance docs for:
 *  1. Repo-relative file/directory references (in backticks, markdown links, and
 *     code blocks) under docs/, scripts/, packages/, arch/, .github/, deploy/,
 *     e2e/, apps/, .claude/ plus root governance files (AGENTS.md, CLAUDE.md,
 *     package.json, biome.json, changelog.json).
 *  2. `npm run <script>` invocations (including `--workspace` / `-w`), verified
 *     against package.json scripts.
 *
 * Skips placeholders/globs (`*`, `<...>`, `$`, etc.) and references explicitly
 * annotated as future P1/P2 planned items or `docs-link-ignore`.
 *
 * Usage:
 *   npx tsx scripts/check-docs-links.ts [--root <dir>] [--files <a,b>] [--json] [file...]
 *
 * Exit: 0 ok, 1 violations, 2 usage/runtime error.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_DOC_FILES = [
  'AGENTS.md',
  '.claude/CLAUDE.md',
  'docs/UI_DESIGN_SYSTEM.md',
  'docs/V5_SELFHOST_PLAYBOOK.md',
  'packages/web-react/AGENTS.md',
  'packages/commercial/AGENTS.md',
  'packages/gateway/AGENTS.md',
] as const

export type DocLinkRuleId = 'DOCS-MISSING-FILE' | 'DOCS-DEAD-PATH' | 'DOCS-INVALID-NPM-SCRIPT'

export interface DocLinkViolation {
  ruleId: DocLinkRuleId
  file: string
  line: number
  reference: string
  violation: string
  why: string
  howToFix: string
  reverify: string
}

export interface CheckDocsResult {
  checkedFiles: number
  checkedPaths: number
  checkedNpmScripts: number
  violations: DocLinkViolation[]
}

const REPO_PREFIX_PATTERN = '(?:docs|scripts|packages|arch|\\.github|deploy|e2e|apps|\\.claude)\\/'

const PATH_SEG_CHAR = `[^\\s\`'"()\\[\\]|,;：；，。！？》】{}]`
const REPO_PATH_RE = new RegExp(
  `(?:^|[\\s([{'":=])(${REPO_PREFIX_PATTERN}(?:\\{[^\\s{}\`'"()\\[\\]|;]+\\}|${PATH_SEG_CHAR})+)`,
  'g',
)

const ROOT_FILE_RE =
  /(?:^|[\s([{'":=])((?:AGENTS\.md|CLAUDE\.md|package\.json|biome\.json|changelog\.json)(?:#[^\s`'"()[\]|,;]+)?)(?=$|[\s)\]}'":,;：；，。！？》】])/g

const INLINE_CODE_RE = /`([^`\n]+)`/g
const MD_LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const PLANNED_MARKER_RE =
  /(?:P[12]\s*(?:计划|规划|planned)|未来(?:P[12])?(?:计划|规划)|\bplanned\b)/i
const LINE_IGNORE_RE = /<!--\s*docs-link-ignore\s*-->|\bdocs-link-ignore\b/i
const BLOCK_IGNORE_START_RE = /<!--\s*docs-link-ignore-start\s*-->/i
const BLOCK_IGNORE_END_RE = /<!--\s*docs-link-ignore-end\s*-->/i

const CLAUSE_SPLIT_RE = /[;；|。]/

export function formatGateError(v: DocLinkViolation): string {
  return [
    `[GATE-ERROR] ${v.ruleId} at ${v.file}:${v.line}`,
    `  Violation : ${v.violation}`,
    `  Why       : ${v.why}`,
    `  How to Fix: ${v.howToFix}`,
    `  Re-verify : ${v.reverify}`,
  ].join('\n')
}

export function isPlaceholderOrGlob(token: string): boolean {
  if (!token) return true
  if (/[*?$<>[\]…]|\.\.\./.test(token)) return true
  if (/(?:^|[-_/])(?:xxx|slug|ticket|YYYY|MM|DD)(?:$|[-_/.])/i.test(token)) return true
  return false
}

/**
 * Expands a single-level `{a,b,c}` brace list (e.g. `packages/{a,b}/AGENTS.md`).
 * Returns `null` if braces look like an unexpandable placeholder (e.g. `{id}` or nested).
 */
export function expandBracePath(rawPath: string): string[] | null {
  const openIdx = rawPath.indexOf('{')
  if (openIdx === -1) {
    if (rawPath.includes('}')) return null
    return [rawPath]
  }
  const closeIdx = rawPath.indexOf('}', openIdx + 1)
  if (closeIdx === -1) return null
  const inner = rawPath.slice(openIdx + 1, closeIdx)
  if (!inner.includes(',') || inner.includes('{') || inner.includes('}') || /\s/.test(inner)) {
    return null
  }
  const prefix = rawPath.slice(0, openIdx)
  const suffix = rawPath.slice(closeIdx + 1)
  if (suffix.includes('{') || suffix.includes('}')) return null
  const parts = inner
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length < 2) return null
  return parts.map((p) => `${prefix}${p}${suffix}`)
}

function stripLocationSuffix(raw: string): string {
  // Strip trailing punctuation often glued to prose paths, without touching extensions.
  let cleaned = raw.replace(/[.,;:!?)'"》】]+$/g, '')
  // Strip `#anchor` or `:line` / `:line-line`
  cleaned = cleaned.replace(/(?:#[^\s)]+|:\d+(?:-\d+)?)$/, '')
  return cleaned
}

function isPlannedNear(line: string, startIndex: number, endIndex: number): boolean {
  const before = line.slice(Math.max(0, startIndex - 32), startIndex)
  const lastBeforeBreak = findLastIndex(before, CLAUSE_SPLIT_RE)
  const leadingClause = lastBeforeBreak >= 0 ? before.slice(lastBeforeBreak + 1) : before
  if (PLANNED_MARKER_RE.test(leadingClause)) return true

  const after = line.slice(endIndex, Math.min(line.length, endIndex + 40))
  const firstAfterBreak = after.search(CLAUSE_SPLIT_RE)
  const trailingClause = firstAfterBreak >= 0 ? after.slice(0, firstAfterBreak) : after
  return PLANNED_MARKER_RE.test(trailingClause)
}

function findLastIndex(text: string, re: RegExp): number {
  let last = -1
  for (let i = 0; i < text.length; i++) {
    if (re.test(text[i])) last = i
  }
  return last
}

interface PackageScriptsIndex {
  rootScripts: Set<string>
  workspaceScripts: Map<string, Set<string>>
}

function readPackageJson(pkgPath: string): {
  name?: string
  scripts?: Record<string, string>
  workspaces?: string[]
} | null {
  if (!existsSync(pkgPath)) return null
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return null
  }
}

function loadScriptsIndex(rootDir: string): PackageScriptsIndex {
  const rootPkg = readPackageJson(path.join(rootDir, 'package.json'))
  const rootScripts = new Set<string>(Object.keys(rootPkg?.scripts ?? {}))
  const workspaceScripts = new Map<string, Set<string>>()

  const workspaces = Array.isArray(rootPkg?.workspaces) ? rootPkg.workspaces : []
  const registerWorkspace = (relDir: string) => {
    const normalized = relDir.replace(/\/+$/, '')
    const wsPkg = readPackageJson(path.join(rootDir, normalized, 'package.json'))
    if (!wsPkg) return
    const scripts = new Set<string>(Object.keys(wsPkg.scripts ?? {}))
    workspaceScripts.set(normalized, scripts)
    if (typeof wsPkg.name === 'string' && wsPkg.name) {
      workspaceScripts.set(wsPkg.name, scripts)
    }
  }

  for (const wsPattern of workspaces) {
    if (typeof wsPattern !== 'string') continue
    if (wsPattern.endsWith('/*')) {
      const parentRel = wsPattern.slice(0, -2)
      const parentAbs = path.join(rootDir, parentRel)
      if (!existsSync(parentAbs)) continue
      for (const entry of readdirSync(parentAbs)) {
        const childRel = path.posix.join(parentRel, entry)
        const childAbs = path.join(rootDir, childRel)
        try {
          if (statSync(childAbs).isDirectory()) registerWorkspace(childRel)
        } catch {
          // ignore unreadable entries
        }
      }
    } else {
      registerWorkspace(wsPattern)
    }
  }

  return { rootScripts, workspaceScripts }
}

interface ParsedNpmRun {
  script: string
  workspace: string | null
  raw: string
  offset: number
}

function extractNpmRunCommands(text: string): ParsedNpmRun[] {
  const results: ParsedNpmRun[] = []
  const segments = text.split(/(?:&&|\|\||[;|\n])/)
  let cursor = 0

  for (const segment of segments) {
    const segStart = text.indexOf(segment, cursor)
    cursor = segStart + segment.length

    const tokens = segment.trim().split(/\s+/).filter(Boolean)
    if (tokens.length < 3) continue

    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== 'npm') continue

      let workspace: string | null = null
      let j = i + 1
      let sawRun = false

      // Flags before `run`
      while (j < tokens.length) {
        const tok = tokens[j]
        if (tok === 'run' || tok === 'run-script') {
          sawRun = true
          j++
          break
        }
        if (tok === '--workspace' || tok === '-w') {
          workspace = tokens[j + 1] ?? null
          j += 2
          continue
        }
        if (tok.startsWith('--workspace=')) {
          workspace = tok.slice('--workspace='.length)
          j++
          continue
        }
        if (tok.startsWith('-w=')) {
          workspace = tok.slice('-w='.length)
          j++
          continue
        }
        if (tok.startsWith('-')) {
          j++
          continue
        }
        // Another npm subcommand (e.g. `npm install`, `npm test`)
        break
      }

      if (!sawRun) continue

      // Flags between `run` and `<script>`
      let script: string | null = null
      while (j < tokens.length) {
        const tok = tokens[j]
        if (tok === '--') break
        if (tok === '--workspace' || tok === '-w') {
          workspace = tokens[j + 1] ?? null
          j += 2
          continue
        }
        if (tok.startsWith('--workspace=')) {
          workspace = tok.slice('--workspace='.length)
          j++
          continue
        }
        if (tok.startsWith('-w=')) {
          workspace = tok.slice('-w='.length)
          j++
          continue
        }
        if (tok.startsWith('-')) {
          j++
          continue
        }
        script = tok.replace(/[.,;:!?)'"`]+$/g, '')
        j++
        break
      }

      if (!script) continue

      // Flags after `<script>` before `--`
      while (j < tokens.length) {
        const tok = tokens[j]
        if (tok === '--') break
        if (tok === '--workspace' || tok === '-w') {
          workspace = tokens[j + 1] ?? null
          j += 2
          continue
        }
        if (tok.startsWith('--workspace=')) {
          workspace = tok.slice('--workspace='.length)
          j++
          continue
        }
        if (tok.startsWith('-w=')) {
          workspace = tok.slice('-w='.length)
          j++
          continue
        }
        j++
      }

      const cleanWs = workspace ? workspace.replace(/^['"]|['"]$/g, '').replace(/\/+$/, '') : null
      results.push({
        script,
        workspace: cleanWs,
        raw: cleanWs ? `npm run ${script} --workspace ${cleanWs}` : `npm run ${script}`,
        offset: segStart,
      })
    }
  }

  return results
}

export function checkDocsLinks(options?: {
  rootDir?: string
  files?: readonly string[]
}): CheckDocsResult {
  const rootDir = path.resolve(options?.rootDir ?? process.cwd())
  const files = options?.files ? [...options.files] : [...DEFAULT_DOC_FILES]
  const scriptsIndex = loadScriptsIndex(rootDir)

  const violations: DocLinkViolation[] = []
  let checkedFiles = 0
  let checkedPaths = 0
  let checkedNpmScripts = 0

  const verifyRepoPath = (
    docFile: string,
    lineNo: number,
    rawToken: string,
    docDirRel: string,
    allowDocRelative: boolean,
  ) => {
    const cleaned = stripLocationSuffix(rawToken)
    if (!cleaned || isPlaceholderOrGlob(cleaned)) return

    const expanded = expandBracePath(cleaned)
    if (!expanded) return

    for (const candidate of expanded) {
      if (isPlaceholderOrGlob(candidate)) continue
      const normalized = candidate.replace(/\/+$/, '')
      if (!normalized) continue
      checkedPaths++

      const fromRoot = path.resolve(rootDir, normalized)
      const fromDoc = allowDocRelative ? path.resolve(rootDir, docDirRel, normalized) : null

      const exists = existsSync(fromRoot) || (fromDoc !== null && existsSync(fromDoc))
      if (!exists) {
        violations.push({
          ruleId: 'DOCS-DEAD-PATH',
          file: docFile,
          line: lineNo,
          reference: candidate,
          violation: `Referenced repo path does not exist: \`${candidate}\``,
          why: 'Governance docs are feedforward maps for Coding Agents; stale paths cause blind retries and misrouted edits.',
          howToFix: `Update \`${candidate}\` to a real repository file/directory, create the target, or annotate planned roadmap items with \`(P1 计划)\` / \`(P2 计划)\`.`,
          reverify: 'npm run check:docs-links',
        })
      }
    }
  }

  const verifyNpmRun = (docFile: string, lineNo: number, parsed: ParsedNpmRun) => {
    if (isPlaceholderOrGlob(parsed.script)) return
    if (parsed.workspace && isPlaceholderOrGlob(parsed.workspace)) return
    checkedNpmScripts++

    if (parsed.workspace) {
      let wsSet = scriptsIndex.workspaceScripts.get(parsed.workspace)
      if (!wsSet) {
        const directPkg = readPackageJson(path.join(rootDir, parsed.workspace, 'package.json'))
        if (directPkg?.scripts) {
          wsSet = new Set(Object.keys(directPkg.scripts))
        }
      }
      if (!wsSet || !wsSet.has(parsed.script)) {
        violations.push({
          ruleId: 'DOCS-INVALID-NPM-SCRIPT',
          file: docFile,
          line: lineNo,
          reference: parsed.raw,
          violation: `\`${parsed.raw}\` is not defined in workspace \`${parsed.workspace}\` package.json scripts`,
          why: 'Copy-pasteable verification commands in governance docs must match real package.json scripts.',
          howToFix: `Fix the script or workspace name in \`${docFile}\`, or register \`${parsed.script}\` in \`${parsed.workspace}/package.json\`.`,
          reverify: 'npm run check:docs-links',
        })
      }
      return
    }

    if (!scriptsIndex.rootScripts.has(parsed.script)) {
      violations.push({
        ruleId: 'DOCS-INVALID-NPM-SCRIPT',
        file: docFile,
        line: lineNo,
        reference: parsed.raw,
        violation: `\`${parsed.raw}\` is not defined in root package.json scripts`,
        why: 'Copy-pasteable verification commands in governance docs must match real package.json scripts.',
        howToFix: `Replace with a valid script in root \`package.json\` (or pass \`--workspace <pkg>\` for workspace scripts), or register \`${parsed.script}\` in \`package.json\`.`,
        reverify: 'npm run check:docs-links',
      })
    }
  }

  const scanCodeChunk = (
    docFile: string,
    docDirRel: string,
    line: string,
    lineNo: number,
    chunk: string,
    chunkOffset: number,
  ) => {
    const seenOnSpan = new Set<string>()

    // 1. Repo-prefixed paths
    REPO_PATH_RE.lastIndex = 0
    for (let m = REPO_PATH_RE.exec(chunk); m !== null; m = REPO_PATH_RE.exec(chunk)) {
      const rawToken = m[1]
      const absStart = chunkOffset + m.index
      const absEnd = absStart + m[0].length
      if (isPlannedNear(line, absStart, absEnd)) continue
      if (seenOnSpan.has(rawToken)) continue
      seenOnSpan.add(rawToken)
      verifyRepoPath(docFile, lineNo, rawToken, docDirRel, false)
    }

    // 2. Well-known root files (never preceded by `/`)
    ROOT_FILE_RE.lastIndex = 0
    for (let m = ROOT_FILE_RE.exec(chunk); m !== null; m = ROOT_FILE_RE.exec(chunk)) {
      const rawToken = m[1]
      const absStart = chunkOffset + m.index
      const absEnd = absStart + m[0].length
      if (isPlannedNear(line, absStart, absEnd)) continue
      if (seenOnSpan.has(rawToken)) continue
      seenOnSpan.add(rawToken)
      verifyRepoPath(docFile, lineNo, rawToken, docDirRel, false)
    }

    // 3. `npm run <script>` invocations
    for (const parsed of extractNpmRunCommands(chunk)) {
      const absStart = chunkOffset + parsed.offset
      const absEnd = absStart + parsed.raw.length
      if (isPlannedNear(line, absStart, absEnd)) continue
      verifyNpmRun(docFile, lineNo, parsed)
    }
  }

  for (const docFile of files) {
    const absDoc = path.resolve(rootDir, docFile)
    if (!existsSync(absDoc)) {
      violations.push({
        ruleId: 'DOCS-MISSING-FILE',
        file: docFile,
        line: 1,
        reference: docFile,
        violation: `Required governance document is missing: \`${docFile}\``,
        why: 'Every core governance guide in DEFAULT_DOC_FILES must exist in the repository.',
        howToFix: `Restore or create \`${docFile}\`, or update DEFAULT_DOC_FILES in \`scripts/check-docs-links.ts\` (requires CODEOWNERS approval).`,
        reverify: 'npm run check:docs-links',
      })
      continue
    }

    checkedFiles++
    const docDirRel = path.dirname(docFile)
    const content = readFileSync(absDoc, 'utf8')
    const lines = content.split(/\r?\n/)
    let inFence = false
    let inIgnoreBlock = false

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]
      const lineNo = idx + 1

      if (BLOCK_IGNORE_START_RE.test(line)) {
        inIgnoreBlock = true
        continue
      }
      if (BLOCK_IGNORE_END_RE.test(line)) {
        inIgnoreBlock = false
        continue
      }
      if (inIgnoreBlock) continue

      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence
        continue
      }

      if (LINE_IGNORE_RE.test(line)) continue

      if (inFence) {
        // Inside fenced code block: skip comment-only shell lines
        if (/^\s*#/.test(line)) continue
        scanCodeChunk(docFile, docDirRel, line, lineNo, line, 0)
        continue
      }

      // Outside fenced code blocks:
      // A. Inline backtick code spans
      INLINE_CODE_RE.lastIndex = 0
      for (let m = INLINE_CODE_RE.exec(line); m !== null; m = INLINE_CODE_RE.exec(line)) {
        const inner = m[1]
        scanCodeChunk(docFile, docDirRel, line, lineNo, inner, m.index + 1)
      }

      // B. Markdown links (strip inline code spans first so `[a](b)` in code isn't double-parsed)
      const withoutCode = line.replace(INLINE_CODE_RE, (full) => ' '.repeat(full.length))
      MD_LINK_RE.lastIndex = 0
      for (let m = MD_LINK_RE.exec(withoutCode); m !== null; m = MD_LINK_RE.exec(withoutCode)) {
        const target = m[1]
        if (
          !target ||
          target.startsWith('#') ||
          target.startsWith('/') ||
          /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)
        ) {
          continue
        }
        if (isPlannedNear(line, m.index, m.index + m[0].length)) continue
        verifyRepoPath(docFile, lineNo, target, docDirRel, true)
      }
    }
  }

  return {
    checkedFiles,
    checkedPaths,
    checkedNpmScripts,
    violations,
  }
}

function parseCliArgs(argv: string[]): {
  rootDir: string
  files?: string[]
  json: boolean
} {
  let rootDir = process.cwd()
  let files: string[] | undefined
  let json = false
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--root') {
      const next = argv[++i]
      if (!next) throw new Error('--root requires a directory path')
      rootDir = next
    } else if (arg === '--files') {
      const next = argv[++i]
      if (!next) throw new Error('--files requires a comma-separated file list')
      files = next
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (arg === '--json') {
      json = true
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    } else {
      positional.push(arg)
    }
  }

  if (positional.length > 0) {
    files = [...(files ?? []), ...positional]
  }
  return { rootDir, files, json }
}

function main(): void {
  const startedAt = Date.now()
  let args: ReturnType<typeof parseCliArgs>
  try {
    args = parseCliArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[check-docs-links] ${(err as Error).message}`)
    process.exit(2)
  }

  const result = checkDocsLinks({ rootDir: args.rootDir, files: args.files })
  const elapsedMs = Date.now() - startedAt

  if (args.json) {
    console.log(JSON.stringify({ ...result, elapsedMs }, null, 2))
  } else if (result.violations.length > 0) {
    for (const v of result.violations) {
      console.error(formatGateError(v))
      console.error('')
    }
    console.error(
      `[check-docs-links] FAILED: ${result.violations.length} violation(s) across ${result.checkedFiles} doc(s) (${result.checkedPaths} paths, ${result.checkedNpmScripts} npm scripts) in ${elapsedMs}ms`,
    )
  } else {
    console.log(
      `[check-docs-links] OK: checked ${result.checkedFiles} doc(s) (${result.checkedPaths} paths, ${result.checkedNpmScripts} npm scripts) in ${elapsedMs}ms`,
    )
  }

  process.exit(result.violations.length > 0 ? 1 : 0)
}

const isDirectMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectMain) {
  main()
}
