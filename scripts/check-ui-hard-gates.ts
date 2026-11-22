/**
 * Unified fast (<2s) UI static hard gates (OCV5-847 Module 2).
 *
 * Enforces 4 deterministic rules across packages/web-react/src:
 *   1. UI-SCROLL-SINGLE-WRITER  — No direct .scrollTop= / .scrollTo( / .scrollIntoView(
 *                                  in chat core scroll domain outside whitelisted single-writer primitives.
 *   2. UI-ZINDEX-LADDER         — No new bare z-[60..999] or z-index: 60..999 outside legacy baseline;
 *                                  use var(--z-*) 11-tier tokens in styles.css.
 *   3. UI-ZERO-LEARNING-COPY    — No internal jargon (checkpoint_reset / PROMPT_TOO_LONG /
 *                                  context_too_long / lease ls-) or manual /compact nagging banners
 *                                  in user-visible JSX text or UI strings under components/{chat,sidebar}.
 *   4. UI-REDUCED-MOTION        — Any CSS file declaring @keyframes must include prefers-reduced-motion
 *                                  handling (legacy standalone files frozen in baseline; 0 tolerance for new ones).
 *
 * Usage:
 *   npx tsx scripts/check-ui-hard-gates.ts
 *   npx tsx scripts/check-ui-hard-gates.ts --base origin/feat/v5-selfhost
 *   npx tsx scripts/check-ui-hard-gates.ts --write-baseline
 *
 * Exit codes: 0 = pass, 1 = gate violation, 2 = usage / IO error.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const RULE_IDS = [
  'UI-SCROLL-SINGLE-WRITER',
  'UI-ZINDEX-LADDER',
  'UI-ZERO-LEARNING-COPY',
  'UI-REDUCED-MOTION',
] as const

export type UiGateRuleId = (typeof RULE_IDS)[number]

export type UiStaticBaseline = Record<UiGateRuleId, Record<string, number>>

export type UiFinding = {
  ruleId: UiGateRuleId
  /** Relative path to packages/web-react/src with forward slashes. */
  file: string
  line: number
  snippet: string
  detail: string
  why: string
  howToFix: string
}

export type UiGateViolation = {
  ruleId: UiGateRuleId
  file: string
  actual: number
  allowed: number
  findings: UiFinding[]
}

export type UiBaselineRegression = {
  ruleId: UiGateRuleId
  file: string
  baseCount: number
  headCount: number
  kind: 'added-entry' | 'count-increased'
}

export const DEFAULT_SRC_DIR = 'packages/web-react/src'
export const DEFAULT_BASELINE_PATH = 'packages/web-react/ui-static-baseline.json'

const SCROLL_WHITELIST_BASENAMES = new Set([
  'stickToBottom.ts',
  'useChatScroll.ts',
  'wheelFence.ts',
  'archivePaging.ts',
])

const SCROLL_MUTATION_RE = /\.scrollTop\s*=(?!=)|\.scrollTo\s*\(|\.scrollIntoView\s*\(/g
const TAILWIND_Z_RE = /\bz-\[(\d+)\]/g
const CSS_Z_RE = /\bz-index\s*:\s*(\d+)\b/g
const KEYFRAMES_RE = /@keyframes\s+([\w-]+)/g
const REDUCED_MOTION_RE = /prefers-reduced-motion\b/

/**
 * Strip JS/TS/CSS comments while preserving newline count so line numbers remain exact.
 */
export function stripCommentsPreserveLines(code: string, isCss: boolean): string {
  // Replace block comments with equivalent number of newlines
  let out = code.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    '\n'.repeat((match.match(/\n/g) ?? []).length),
  )
  if (!isCss) {
    // Strip single-line // comments outside string literals (heuristic matching designTokens.test.ts)
    out = out.replace(/(^|[^:\\"'`])\/\/[^\n]*/gm, '$1')
  }
  return out
}

function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function lineTextAt(lines: string[], lineNo: number): string {
  return (lines[lineNo - 1] ?? '').trim().slice(0, 140)
}

function walkFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      walkFiles(full, out)
    } else {
      out.push(full)
    }
  }
  return out
}

function isTestFile(rel: string): boolean {
  return (
    rel.startsWith('test/') ||
    rel.includes('/__tests__/') ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)
  )
}

export function isInChatScrollCoreDomain(rel: string): boolean {
  if (isTestFile(rel) || !/\.[jt]sx?$/.test(rel)) return false
  const base = path.posix.basename(rel)
  if (SCROLL_WHITELIST_BASENAMES.has(base)) return false
  if (rel === 'App.tsx') return true
  if (base === 'MessageRenderer.tsx' || base === 'ProcessDisclosure.tsx') return true
  if (rel.startsWith('components/chat/')) return true
  if (/^hooks\/useChat[^/]*\.[jt]sx?$/.test(rel)) return true
  return false
}

export function isInZeroLearningCopyScope(rel: string): boolean {
  if (isTestFile(rel) || !rel.endsWith('.tsx')) return false
  if (!rel.startsWith('components/chat/') && !rel.startsWith('components/sidebar/')) return false
  if (/(^|\/)(manage|admin|settings)\//.test(rel)) return false
  return true
}

type ForbiddenCopyRule = {
  id: string
  re: RegExp
  label: string
  /** If true, a bare literal equal solely to the match may be an internal protocol discriminator. */
  allowBareProtocolToken: boolean
}

const ZERO_LEARNING_RULES: ForbiddenCopyRule[] = [
  {
    id: 'checkpoint_reset',
    re: /\bcheckpoint_reset\b/,
    label: '底层术语 checkpoint_reset',
    allowBareProtocolToken: true,
  },
  {
    id: 'PROMPT_TOO_LONG',
    re: /\bPROMPT_TOO_LONG\b/,
    label: '底层错误码 PROMPT_TOO_LONG',
    allowBareProtocolToken: true,
  },
  {
    id: 'context_too_long',
    re: /\bcontext_too_long\b/,
    label: '底层错误码 context_too_long',
    allowBareProtocolToken: true,
  },
  {
    id: 'lease_id',
    re: /\blease\s+ls-[a-zA-Z0-9_-]*/,
    label: '原始运维噪声 lease ls-*',
    allowBareProtocolToken: false,
  },
  {
    id: 'manual_compact_banner',
    re: /(?:请|建议|点击|输入|运行|执行|使用|手动)[^"'`\n<>]{0,20}\/compact|\/compact[^"'`\n<>]{0,20}(?:压缩|整理|释放|上下文)|(?:上下文|对话)[^"'`\n<>]{0,16}(?:80%|已满|即将达到上限|超限)[^"'`\n<>]{0,20}(?:手动|压缩|\/compact)|手动压缩(?:当前)?(?:会话|上下文|对话)/,
    label: '手动催促 /compact 压缩横幅文案',
    allowBareProtocolToken: false,
  },
]

const USER_VISIBLE_PROP_RE =
  /(?:title|label|desc|description|message|hint|placeholder|aria-label|text|body|subtitle|summary|banner|content|toast|heading|caption)\s*(?:=|:)\s*$/i
const INTERNAL_PROTOCOL_CTX_RE =
  /(?:===|!==|==|!=|\bcase\b|\b(?:code|type|kind|errorCode|reason|event|action|status)\s*:|\.(?:includes|has|get|indexOf)\s*\(|\[)\s*$/
const IMPORT_EXPORT_FROM_LINE_RE = /^\s*import\b|^\s*export\b[^\n]*\bfrom\s*["']/
const ZERO_LEARNING_PRECHECK_RE =
  /checkpoint_reset|PROMPT_TOO_LONG|context_too_long|lease\s+ls-|\/compact|手动压缩|80%|已满|超限|即将达到上限/i

/** Linear-time string/template literal extractor (zero regex backtracking). */
function extractStringLiterals(code: string): Array<{ start: number; value: string }> {
  const out: Array<{ start: number; value: string }> = []
  const len = code.length
  let i = 0
  while (i < len) {
    const ch = code.charCodeAt(i)
    if (ch === 34 || ch === 39 || ch === 96) {
      // ", ', or `
      const quote = ch
      const start = i
      i += 1
      let val = ''
      while (i < len) {
        const c = code.charCodeAt(i)
        if (c === 92) {
          // backslash escape
          if (i + 1 < len) {
            val += code[i + 1]
            i += 2
            continue
          }
          i += 1
          break
        }
        if (c === quote) {
          out.push({ start, value: val })
          i += 1
          break
        }
        // Single/double quotes cannot span unescaped newlines in JS/TS
        if (c === 10 && quote !== 96) {
          i += 1
          break
        }
        val += code[i]
        i += 1
      }
      continue
    }
    i += 1
  }
  return out
}

function scanZeroLearningCopy(
  rel: string,
  rawCode: string,
  cleanCode: string,
  lines: string[],
): UiFinding[] {
  if (!ZERO_LEARNING_PRECHECK_RE.test(cleanCode)) return []
  const findings: UiFinding[] = []
  const seenKeys = new Set<string>()

  const pushFinding = (lineNo: number, detail: string) => {
    const key = `${lineNo}:${detail}`
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    findings.push({
      ruleId: 'UI-ZERO-LEARNING-COPY',
      file: rel,
      line: lineNo,
      snippet: lineTextAt(lines, lineNo),
      detail,
      why: 'P3 零学习成本与无限续聊红线（OCV5-841）：禁止在用户可见聊天/侧栏文案泄漏内部错误码或催促用户手动 /compact 压缩',
      howToFix:
        '改为后台静默自动整理，用户可见文案仅使用安静自然人话（如「已自动整理较早对话，可继续无缝聊下去」），严禁暴露 checkpoint_reset / PROMPT_TOO_LONG / context_too_long / lease ls- 或手动压缩横幅',
    })
  }

  // 1. Scan JSX text segments between '>' and '<' (outside {...} expression blocks).
  const jsxTextRe = />([^<>{}]+)</g
  for (const m of cleanCode.matchAll(jsxTextRe)) {
    const text = m[1]
    if (!text || !text.trim() || !ZERO_LEARNING_PRECHECK_RE.test(text)) continue
    const lineNo = lineNumberAt(cleanCode, m.index ?? 0)
    if (IMPORT_EXPORT_FROM_LINE_RE.test(lines[lineNo - 1] ?? '')) continue
    for (const rule of ZERO_LEARNING_RULES) {
      if (rule.re.test(text)) {
        pushFinding(lineNo, `JSX 可见文本包含 ${rule.label}`)
      }
    }
    if (/(?:^|\s)\/compact(?:\s|$|[，。！？.,!?])/i.test(text)) {
      pushFinding(lineNo, 'JSX 可见文本包含手动 /compact 指令提示')
    }
  }

  // 2. Scan quoted string literals and template literals in O(n).
  for (const { start: startIdx, value: lit } of extractStringLiterals(cleanCode)) {
    if (!ZERO_LEARNING_PRECHECK_RE.test(lit)) continue
    const lineNo = lineNumberAt(cleanCode, startIdx)
    const fullLine = lines[lineNo - 1] ?? ''
    if (IMPORT_EXPORT_FROM_LINE_RE.test(fullLine)) continue

    // Context immediately before this literal on the same line (up to 60 chars)
    const lineStart = cleanCode.lastIndexOf('\n', startIdx) + 1
    const ctxBefore = cleanCode.slice(Math.max(lineStart, startIdx - 60), startIdx)
    const isUserProp = USER_VISIBLE_PROP_RE.test(ctxBefore)
    const isInternalCheck = !isUserProp && INTERNAL_PROTOCOL_CTX_RE.test(ctxBefore)

    for (const rule of ZERO_LEARNING_RULES) {
      const hit = rule.re.exec(lit)
      if (!hit) continue
      const isBareToken = lit.trim() === hit[0]
      if (rule.allowBareProtocolToken && isBareToken && isInternalCheck) {
        // Legitimate protocol enum discriminator (e.g. err.code === "PROMPT_TOO_LONG").
        continue
      }
      if (rule.allowBareProtocolToken && isBareToken && !isUserProp) {
        // Bare identifier-like string not attached to a user-visible prop and without human text:
        // still catch if rendered directly in JSX expression e.g. >{"PROMPT_TOO_LONG"}<
        const trimmedBefore = ctxBefore.trimEnd()
        const isDirectJsxExpr = trimmedBefore.endsWith('{') && />\s*\{$/.test(trimmedBefore)
        if (!isDirectJsxExpr) continue
      }
      pushFinding(lineNo, `用户可见字符串包含 ${rule.label}`)
    }
  }

  // Ensure rawCode parameter is used cleanly (for future extensions if needed)
  void rawCode
  return findings
}

export function createEmptyBaseline(): UiStaticBaseline {
  return {
    'UI-SCROLL-SINGLE-WRITER': {},
    'UI-ZINDEX-LADDER': {},
    'UI-ZERO-LEARNING-COPY': {},
    'UI-REDUCED-MOTION': {},
  }
}

export function scanUiHardGates(srcDir: string): {
  findings: UiFinding[]
  counts: UiStaticBaseline
} {
  const absSrc = path.resolve(srcDir)
  const findings: UiFinding[] = []
  const counts = createEmptyBaseline()

  const addCount = (ruleId: UiGateRuleId, file: string) => {
    counts[ruleId][file] = (counts[ruleId][file] ?? 0) + 1
  }

  const allFiles = walkFiles(absSrc).sort()

  for (const absFile of allFiles) {
    const rel = path.relative(absSrc, absFile).split(path.sep).join('/')
    const ext = path.extname(rel).toLowerCase()
    if (ext !== '.ts' && ext !== '.tsx' && ext !== '.css') continue
    if (isTestFile(rel)) continue

    const raw = readFileSync(absFile, 'utf8')
    const isCss = ext === '.css'
    const checkScroll = !isCss && isInChatScrollCoreDomain(rel) && raw.includes('.scroll')
    const checkZ = raw.includes('z-[') || raw.includes('z-index')
    const checkCopy =
      !isCss && isInZeroLearningCopyScope(rel) && ZERO_LEARNING_PRECHECK_RE.test(raw)
    const checkMotion = isCss && raw.includes('@keyframes')
    if (!checkScroll && !checkZ && !checkCopy && !checkMotion) continue

    const clean = stripCommentsPreserveLines(raw, isCss)
    const lines = raw.split('\n')

    // 1. UI-SCROLL-SINGLE-WRITER
    if (checkScroll) {
      for (const m of clean.matchAll(SCROLL_MUTATION_RE)) {
        const lineNo = lineNumberAt(clean, m.index ?? 0)
        findings.push({
          ruleId: 'UI-SCROLL-SINGLE-WRITER',
          file: rel,
          line: lineNo,
          snippet: lineTextAt(lines, lineNo),
          detail: `核心滚动域直接调用 ${m[0].trim()}`,
          why: 'P6 单 Writer 滚动不变量（OCV5-95）：多方竞写 scrollTop 会导致上滑阅读自动回弹',
          howToFix:
            '通过 followBottomRef.current = false → stick.correctTo(scroller, targetTop) 走单 Writer 写口（白名单：stickToBottom.ts / useChatScroll.ts / wheelFence.ts / archivePaging.ts）',
        })
        addCount('UI-SCROLL-SINGLE-WRITER', rel)
      }
    }

    // 2. UI-ZINDEX-LADDER
    if (checkZ) {
      for (const m of clean.matchAll(TAILWIND_Z_RE)) {
        const val = Number.parseInt(m[1], 10)
        if (val >= 60 && val <= 999) {
          const lineNo = lineNumberAt(clean, m.index ?? 0)
          findings.push({
            ruleId: 'UI-ZINDEX-LADDER',
            file: rel,
            line: lineNo,
            snippet: lineTextAt(lines, lineNo),
            detail: `检测到裸高层级 Tailwind 类 ${m[0]}`,
            why: '禁止裸 z-[60..999] 层级竞价导致 Portal 菜单被全屏查看器/弹窗遮挡（OCV5-847）',
            howToFix:
              '改用 styles.css 中 11 档集中 Token：z-[var(--z-modal)] / z-[var(--z-viewer)] / z-[var(--z-popover-portal)] / z-[var(--z-tooltip)] / z-[var(--z-toast)]',
          })
          addCount('UI-ZINDEX-LADDER', rel)
        }
      }
      for (const m of clean.matchAll(CSS_Z_RE)) {
        const val = Number.parseInt(m[1], 10)
        if (val >= 60 && val <= 999) {
          const lineNo = lineNumberAt(clean, m.index ?? 0)
          findings.push({
            ruleId: 'UI-ZINDEX-LADDER',
            file: rel,
            line: lineNo,
            snippet: lineTextAt(lines, lineNo),
            detail: `检测到裸高层级 CSS 声明 ${m[0]}`,
            why: '禁止裸 z-index: 60..999 层级竞价，统一由 styles.css :root 的 --z-* 阶梯管控（OCV5-847）',
            howToFix:
              '改用 z-index: var(--z-modal) / var(--z-viewer) / var(--z-popover-portal) / var(--z-tooltip) / var(--z-toast)',
          })
          addCount('UI-ZINDEX-LADDER', rel)
        }
      }
    }

    // 3. UI-ZERO-LEARNING-COPY
    if (checkCopy) {
      const copyFindings = scanZeroLearningCopy(rel, raw, clean, lines)
      for (const f of copyFindings) {
        findings.push(f)
        addCount('UI-ZERO-LEARNING-COPY', rel)
      }
    }

    // 4. UI-REDUCED-MOTION
    if (checkMotion) {
      const kfMatches = [...clean.matchAll(KEYFRAMES_RE)]
      if (kfMatches.length > 0 && !REDUCED_MOTION_RE.test(clean)) {
        for (const m of kfMatches) {
          const lineNo = lineNumberAt(clean, m.index ?? 0)
          findings.push({
            ruleId: 'UI-REDUCED-MOTION',
            file: rel,
            line: lineNo,
            snippet: lineTextAt(lines, lineNo),
            detail: `独立 CSS 文件包含 @keyframes ${m[1]} 但缺少 prefers-reduced-motion 降级规则`,
            why: 'Clarvy Atelier 动效纪律与无障碍要求：所有含 @keyframes 的样式文件必须自带 prefers-reduced-motion 兜底',
            howToFix:
              '在同一 CSS 文件中添加 @media (prefers-reduced-motion: reduce) { ... animation: none; } 或将动画规则包裹于 @media (prefers-reduced-motion: no-preference) { ... }',
          })
          addCount('UI-REDUCED-MOTION', rel)
        }
      }
    }
  }

  // Sort keys deterministically
  for (const ruleId of RULE_IDS) {
    const sortedEntries = Object.entries(counts[ruleId]).sort(([a], [b]) => a.localeCompare(b))
    counts[ruleId] = Object.fromEntries(sortedEntries)
  }

  return { findings, counts }
}

export function parseBaseline(raw: unknown, sourceLabel = DEFAULT_BASELINE_PATH): UiStaticBaseline {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${sourceLabel} must be a JSON object keyed by rule ID`)
  }
  const obj = raw as Record<string, unknown>
  const out = createEmptyBaseline()
  for (const ruleId of RULE_IDS) {
    const map = obj[ruleId]
    if (map === undefined) continue
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      throw new Error(`${sourceLabel}[${ruleId}] must be a { file: count } map`)
    }
    for (const [file, count] of Object.entries(map as Record<string, unknown>)) {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
        throw new Error(`${sourceLabel}[${ruleId}][${file}] must be a non-negative integer`)
      }
      out[ruleId][file] = count
    }
  }
  return out
}

export function evaluateUiHardGates(
  scan: { findings: UiFinding[]; counts: UiStaticBaseline },
  baseline: UiStaticBaseline,
): { ok: boolean; violations: UiGateViolation[] } {
  const violations: UiGateViolation[] = []
  for (const ruleId of RULE_IDS) {
    const currentMap = scan.counts[ruleId] ?? {}
    const allowedMap = baseline[ruleId] ?? {}
    for (const [file, actual] of Object.entries(currentMap)) {
      const allowed = allowedMap[file] ?? 0
      if (actual > allowed) {
        const fileFindings = scan.findings.filter((f) => f.ruleId === ruleId && f.file === file)
        violations.push({ ruleId, file, actual, allowed, findings: fileFindings })
      }
    }
  }
  return { ok: violations.length === 0, violations }
}

export function evaluateBaselineMonotonic(
  baseBaseline: UiStaticBaseline,
  headBaseline: UiStaticBaseline,
): UiBaselineRegression[] {
  const regressions: UiBaselineRegression[] = []
  for (const ruleId of RULE_IDS) {
    const baseMap = baseBaseline[ruleId] ?? {}
    const headMap = headBaseline[ruleId] ?? {}
    for (const [file, headCount] of Object.entries(headMap)) {
      if (!(file in baseMap)) {
        if (headCount > 0) {
          regressions.push({
            ruleId,
            file,
            baseCount: 0,
            headCount,
            kind: 'added-entry',
          })
        }
      } else if (headCount > baseMap[file]) {
        regressions.push({
          ruleId,
          file,
          baseCount: baseMap[file],
          headCount,
          kind: 'count-increased',
        })
      }
    }
  }
  return regressions
}

export function formatGateErrors(
  violations: UiGateViolation[],
  regressions: UiBaselineRegression[] = [],
  srcPrefix = DEFAULT_SRC_DIR,
): string {
  const blocks: string[] = []

  for (const v of violations) {
    const sample = v.findings[0]
    const loc = sample ? `${srcPrefix}/${v.file}:${sample.line}` : `${srcPrefix}/${v.file}`
    const lineList = v.findings
      .slice(0, 5)
      .map((f) => `L${f.line}: ${f.snippet}`)
      .join(' | ')
    blocks.push(
      [
        `[GATE-ERROR] ${v.ruleId} at ${loc}`,
        `  Violation : 命中 ${v.actual} 处 > 基线允许 ${v.allowed} 处（${sample?.detail ?? '超出存量基线'}）`,
        lineList ? `  Samples   : ${lineList}` : '',
        `  Why       : ${sample?.why ?? 'UI 静态硬门禁禁止新增违规（OCV5-847）'}`,
        `  How to Fix: ${sample?.howToFix ?? '按规范修复违规，严禁抬升 ui-static-baseline.json'}`,
        '  Re-verify : npx tsx scripts/check-ui-hard-gates.ts',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }

  for (const r of regressions) {
    blocks.push(
      [
        `[GATE-ERROR] UI-STATIC-BASELINE-MONOTONIC at ${DEFAULT_BASELINE_PATH}`,
        `  Violation : ${r.ruleId} -> ${r.file} 基线由 ${r.baseCount} 上涨至 ${r.headCount} (${r.kind})`,
        '  Why       : B 类存量基线只降不升，严禁通过改大基线绕过 UI 硬门禁',
        `  How to Fix: 修复新增违规代码并恢复 ui-static-baseline.json 中该文件计数 <= ${r.baseCount}`,
        '  Re-verify : npx tsx scripts/check-ui-hard-gates.ts --base origin/feat/v5-selfhost',
      ].join('\n'),
    )
  }

  return blocks.join('\n\n')
}

function readGitFileOrNull(ref: string, repoRelPath: string, cwd: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${repoRelPath}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return null
  }
}

function parseArgs(argv: string[]): {
  writeBaseline: boolean
  baseRef: string | null
  srcDir: string
  baselinePath: string
  json: boolean
} {
  let writeBaseline = false
  let baseRef: string | null = null
  let srcDir = DEFAULT_SRC_DIR
  let baselinePath = DEFAULT_BASELINE_PATH
  let json = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--write-baseline') {
      writeBaseline = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--base') {
      baseRef = argv[++i] ?? null
      if (!baseRef) throw new Error('--base requires a git ref argument')
    } else if (arg.startsWith('--base=')) {
      baseRef = arg.slice('--base='.length)
    } else if (arg === '--src') {
      srcDir = argv[++i] ?? ''
      if (!srcDir) throw new Error('--src requires a directory argument')
    } else if (arg.startsWith('--src=')) {
      srcDir = arg.slice('--src='.length)
    } else if (arg === '--baseline') {
      baselinePath = argv[++i] ?? ''
      if (!baselinePath) throw new Error('--baseline requires a file path argument')
    } else if (arg.startsWith('--baseline=')) {
      baselinePath = arg.slice('--baseline='.length)
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: npx tsx scripts/check-ui-hard-gates.ts [--write-baseline] [--base <ref>] [--src <dir>] [--baseline <file>] [--json]',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { writeBaseline, baseRef, srcDir, baselinePath, json }
}

function main(): void {
  let opts: ReturnType<typeof parseArgs>
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[GATE-ERROR] UI-HARD-GATES-USAGE: ${(err as Error).message}`)
    process.exit(2)
  }

  const startedAt = Date.now()
  const cwd = process.cwd()
  const absSrc = path.resolve(cwd, opts.srcDir)
  const absBaseline = path.resolve(cwd, opts.baselinePath)

  if (!existsSync(absSrc)) {
    console.error(`[GATE-ERROR] UI-HARD-GATES-IO: source dir not found: ${absSrc}`)
    process.exit(2)
  }

  const scan = scanUiHardGates(absSrc)

  if (opts.writeBaseline) {
    writeFileSync(absBaseline, `${JSON.stringify(scan.counts, null, 2)}\n`, 'utf8')
    const totals = RULE_IDS.map(
      (r) => `${r}=${Object.values(scan.counts[r]).reduce((a, b) => a + b, 0)}`,
    ).join(', ')
    console.log(
      `check-ui-hard-gates: wrote ${opts.baselinePath} (${totals}) in ${Date.now() - startedAt}ms`,
    )
    process.exit(0)
  }

  if (!existsSync(absBaseline)) {
    console.error(
      `[GATE-ERROR] UI-STATIC-BASELINE-MISSING at ${opts.baselinePath}\n  Violation : 缺少 UI 静态硬门禁基线文件\n  Why       : 必须存在基线文件才能区分存量与新增违规\n  How to Fix: 运行 npx tsx scripts/check-ui-hard-gates.ts --write-baseline 生成初始基线\n  Re-verify : npx tsx scripts/check-ui-hard-gates.ts`,
    )
    process.exit(2)
  }

  const headBaseline = parseBaseline(
    JSON.parse(readFileSync(absBaseline, 'utf8')),
    opts.baselinePath,
  )
  const evalResult = evaluateUiHardGates(scan, headBaseline)

  let regressions: UiBaselineRegression[] = []
  if (opts.baseRef) {
    const repoRelBaseline = path.relative(cwd, absBaseline).split(path.sep).join('/')
    const baseText = readGitFileOrNull(opts.baseRef, repoRelBaseline, cwd)
    if (baseText !== null) {
      const baseBaseline = parseBaseline(JSON.parse(baseText), `${opts.baseRef}:${repoRelBaseline}`)
      regressions = evaluateBaselineMonotonic(baseBaseline, headBaseline)
    }
  }

  const ok = evalResult.ok && regressions.length === 0
  const elapsedMs = Date.now() - startedAt

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          elapsedMs,
          counts: scan.counts,
          violations: evalResult.violations,
          baselineRegressions: regressions,
        },
        null,
        2,
      ),
    )
    process.exit(ok ? 0 : 1)
  }

  if (!ok) {
    console.error(formatGateErrors(evalResult.violations, regressions, opts.srcDir))
    process.exit(1)
  }

  const summary = RULE_IDS.map(
    (r) => `${r}=${Object.values(scan.counts[r]).reduce((a, b) => a + b, 0)}`,
  ).join(', ')
  console.log(`check-ui-hard-gates: PASS (${summary}) in ${elapsedMs}ms`)
  process.exit(0)
}

const isDirectRun =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  main()
}
