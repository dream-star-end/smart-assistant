import * as assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
/**
 * Pure Function Unit Tests for OpenClaude Frontend.
 *
 * Extracts function source via regex and creates callables via new Function().
 * Works with both the pre-refactor app.js IIFE and the post-refactor modules/ directory.
 *
 * Run: npx tsx --test packages/web/__tests__/pureFunctions.test.ts
 */
import { describe, it } from 'node:test'

const PUBLIC = resolve(import.meta.dirname, '..', 'public')
const modulesDir = resolve(PUBLIC, 'modules')
const styleCss = readFileSync(resolve(PUBLIC, 'style.css'), 'utf-8')

// Load JS source: modules/ (post-refactor) or app.js (pre-refactor)
let appJs: string
if (existsSync(modulesDir)) {
  appJs = readdirSync(modulesDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(resolve(modulesDir, f), 'utf-8'))
    .join('\n')
} else {
  appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf-8')
}

// ── Function extractor ──

/**
 * Extract a named function body from IIFE source using line-based indentation matching.
 *
 * In our app.js, all top-level functions inside the IIFE are indented by exactly 2 spaces:
 *   function name(params) {
 *     body...
 *   }
 *
 * We find the function signature, determine its indentation level, then scan
 * forward for the closing `}` at the same indent level. This is far more reliable
 * than brace-depth counting (which breaks on regex literals containing quotes).
 */
function extractFunction(source: string, name: string): string {
  const lines = source.split('\n')
  // Find the line containing `function name(`
  const fnLineIdx = lines.findIndex((line) =>
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(line),
  )
  if (fnLineIdx === -1) throw new Error(`Function "${name}" not found in source`)

  // Determine the indentation of the function definition
  const fnLine = lines[fnLineIdx]
  const indentMatch = fnLine.match(/^(\s*)/)
  const fnIndent = indentMatch ? indentMatch[1] : ''

  // The closing brace should be a line that is EXACTLY `{indent}}` (possibly with trailing whitespace)
  const closingPattern = new RegExp(`^${fnIndent}\\}\\s*$`)

  // Scan forward from the next line
  let endLineIdx = fnLineIdx + 1
  for (; endLineIdx < lines.length; endLineIdx++) {
    if (closingPattern.test(lines[endLineIdx])) break
  }

  // Strip 'export' keyword so the source can be used with new Function()
  return lines
    .slice(fnLineIdx, endLineIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

/**
 * Create a callable from a function source string.
 * Wraps in: new Function('function name(...){...}; return name;')()
 */
function makeCallable<T extends (...args: any[]) => any>(fnSource: string): T {
  const nameMatch = fnSource.match(/function\s+(\w+)/)
  if (!nameMatch) throw new Error('Cannot determine function name from source')
  return new Function(`${fnSource}; return ${nameMatch[1]};`)() as T
}

// ── Extract and compile functions ──

const _basename = makeCallable<(p: string) => string>(extractFunction(appJs, '_basename'))

const formatSize = makeCallable<(n: number) => string>(extractFunction(appJs, 'formatSize'))

const shortTime = makeCallable<(ts: number) => string>(extractFunction(appJs, 'shortTime'))

const sessionGroup = makeCallable<(ts: number) => string>(extractFunction(appJs, 'sessionGroup'))

const _cronHuman = makeCallable<(cron: string) => string>(extractFunction(appJs, '_cronHuman'))

const localPathToUrl = makeCallable<(absPath: string) => string>(
  extractFunction(appJs, 'localPathToUrl'),
)

const formatMeta = makeCallable<(m: any) => string>(extractFunction(appJs, 'formatMeta'))

const buildToolUseLabel = makeCallable<(block: any) => string>(
  extractFunction(appJs, 'buildToolUseLabel'),
)

const shouldAutoPlan = new Function(
  `${extractFunction(appJs, '_hasAny')}
${extractFunction(appJs, 'shouldAutoPlan').replace(/^export\s+/, '')}; return shouldAutoPlan;`,
)() as (text?: string, attachments?: any[]) => boolean

const getLatestPlanAndTodos = new Function(
  `${extractFunction(appJs, '_normalizeStatus')}
${extractFunction(appJs, 'getLatestPlanAndTodos').replace(/^export\s+/, '')}; return getLatestPlanAndTodos;`,
)() as (sess: any) => { plan: any; todo: any }

const getLatestGoalFromMessages = new Function(
  `${extractFunction(appJs, '_num')}
${extractFunction(appJs, 'getLatestGoalFromMessages').replace(/^export\s+/, '')}; return getLatestGoalFromMessages;`,
)() as (messages?: any[]) => any

// Note: effectiveTheme() and isSending() depend on browser APIs (localStorage, state).
// htmlSafeEscape is a one-line arrow function — hard to extract with indent matching.
// All three will be directly importable after Phase 2 module extraction.

// For now, verify htmlSafeEscape exists in source and test a copy of its logic:
const htmlSafeEscape = (s: any) =>
  String(s).replace(
    /[&<>"']/g,
    (c: string) =>
      (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as any)[c],
  )

// ── T01: _basename ──
describe('T01: _basename — extract filename from path', () => {
  it('Unix path', () => assert.equal(_basename('/home/user/file.txt'), 'file.txt'))
  it('Windows path', () => assert.equal(_basename('C:\\Users\\test\\file.txt'), 'file.txt'))
  it('mixed separators', () => assert.equal(_basename('/home/user\\file.txt'), 'file.txt'))
  it('no separators', () => assert.equal(_basename('file.txt'), 'file.txt'))
  it('trailing slash', () => assert.equal(_basename('/home/user/'), ''))
  it('deep nested', () => assert.equal(_basename('/a/b/c/d/e.png'), 'e.png'))
})

// ── T02: formatSize ──
describe('T02: formatSize — human-readable file sizes', () => {
  it('bytes', () => assert.equal(formatSize(0), '0 B'))
  it('small bytes', () => assert.equal(formatSize(512), '512 B'))
  it('1023 bytes', () => assert.equal(formatSize(1023), '1023 B'))
  it('exactly 1 KB', () => assert.equal(formatSize(1024), '1.0 KB'))
  it('kilobytes', () => assert.equal(formatSize(15360), '15.0 KB'))
  it('exactly 1 MB', () => assert.equal(formatSize(1048576), '1.0 MB'))
  it('megabytes', () => assert.equal(formatSize(5242880), '5.0 MB'))
})

// ── T03: shortTime ──
describe('T03: shortTime — relative time formatting', () => {
  it('just now (< 60s)', () => assert.equal(shortTime(Date.now() - 5000), '刚刚'))
  it('minutes ago', () => assert.equal(shortTime(Date.now() - 180000), '3 分钟前'))
  it('hours ago', () => assert.equal(shortTime(Date.now() - 7200000), '2 小时前'))
  it('days ago', () => assert.equal(shortTime(Date.now() - 259200000), '3 天前'))
  it('weeks ago → date', () => {
    // 10 days ago → should be formatted as date
    const ts = Date.now() - 10 * 86400000
    const result = shortTime(ts)
    // Should be a date string like "2026/4/3"
    assert.ok(result.includes('/'), `Expected date format, got: ${result}`)
  })
})

// ── T04: sessionGroup ──
describe('T04: sessionGroup — date categorization', () => {
  it('returns 今天 for current time', () => {
    assert.equal(sessionGroup(Date.now()), '今天')
  })
  it('returns 今天 for earlier today', () => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    assert.equal(sessionGroup(todayStart.getTime() + 1000), '今天')
  })
  it('returns 昨天 for yesterday', () => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    assert.equal(sessionGroup(todayStart.getTime() - 1000), '昨天')
  })
  it('returns 本周 for 3 days ago', () => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    assert.equal(sessionGroup(todayStart.getTime() - 3 * 86400000), '本周')
  })
  it('returns 更早 for 60 days ago', () => {
    assert.equal(sessionGroup(Date.now() - 60 * 86400000), '更早')
  })
})

// ── T05: _cronHuman ──
describe('T05: _cronHuman — cron expression to Chinese text', () => {
  it('every day at 9:00', () => assert.equal(_cronHuman('0 9 * * *'), '每天 09:00'))
  it('every day at 14:30', () => assert.equal(_cronHuman('30 14 * * *'), '每天 14:30'))
  it('weekday (Monday)', () => {
    const result = _cronHuman('0 9 * * 1')
    assert.ok(result.includes('每周'), `Expected 每周, got: ${result}`)
    assert.ok(result.includes('一'), `Expected 一 (Monday), got: ${result}`)
  })
  it('every minute', () => assert.equal(_cronHuman('* * * * *'), '每天 每分钟'))
  it('every hour at minute 15', () => {
    const result = _cronHuman('15 * * * *')
    assert.ok(result.includes('每小时'), `Expected 每小时, got: ${result}`)
  })
  it('invalid/short cron', () => assert.equal(_cronHuman('bad'), 'bad'))
  it('specific date', () => {
    const result = _cronHuman('0 10 25 12 *')
    assert.ok(result.includes('12月25日'), `Expected 12月25日, got: ${result}`)
  })
})

// ── T06: localPathToUrl ──
describe('T06: localPathToUrl — path to API URL', () => {
  it('Unix path', () => {
    assert.equal(localPathToUrl('/home/user/img.png'), '/api/file?path=%2Fhome%2Fuser%2Fimg.png')
  })
  it('Windows path', () => {
    assert.equal(
      localPathToUrl('C:\\Users\\test\\doc.pdf'),
      '/api/file?path=C%3A%5CUsers%5Ctest%5Cdoc.pdf',
    )
  })
  it('path with spaces', () => {
    assert.equal(
      localPathToUrl('/home/user/my file.png'),
      '/api/file?path=%2Fhome%2Fuser%2Fmy%20file.png',
    )
  })
  it('path with special chars', () => {
    const result = localPathToUrl('/path/file (1).jpg')
    assert.ok(result.startsWith('/api/file?path='), 'Should start with /api/file?path=')
    // encodeURIComponent encodes space but NOT parentheses per RFC 3986
    assert.ok(result.includes('%20'), 'Should encode spaces')
  })
})

// ── T06b: embedMediaUrls — auto-detect & render ANY-directory ANY-type file paths ──
// Verifies the markdown.js path auto-detection: arbitrary file types in AI output
// become clickable cards (media inline, everything else a 📎 download card), and
// that the letter-led extension rule does not linkify prose / version suffixes.
const _extractConstLine = (source: string, name: string): string => {
  const m = source.match(new RegExp(`^\\s*(?:export\\s+)?const ${name}\\s*=.*$`, 'm'))
  if (!m) throw new Error(`const ${name} not found`)
  return m[0].replace(/^\s*export\s+/, '')
}
const embedMediaUrls = (() => {
  const bundle = [
    // Stub the only cross-module dep (dom.js arrow const) with an equivalent.
    `const htmlSafeEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])`,
    _extractConstLine(appJs, '_IMG_EXTS'),
    _extractConstLine(appJs, '_AUD_EXTS'),
    _extractConstLine(appJs, '_VID_EXTS'),
    _extractConstLine(appJs, '_PDF_EXTS'),
    extractFunction(appJs, '_basename'),
    extractFunction(appJs, '_safeMediaUrl'),
    extractFunction(appJs, '_imgHtml'),
    extractFunction(appJs, 'localPathToUrl'),
    extractFunction(appJs, '_renderLocalMedia'),
    extractFunction(appJs, 'embedMediaUrls'),
  ].join('\n')
  return new Function(`${bundle}; return embedMediaUrls;`)() as (html: string) => string
})()

describe('T06b: embedMediaUrls — arbitrary-directory/arbitrary-type detection', () => {
  it('renders a non-media file (.docx) anywhere as a download card', () => {
    const out = embedMediaUrls('<p>结果在 /root/projects/q2/report.docx 里</p>')
    assert.ok(out.includes('doc-card'), 'should produce a doc card')
    assert.ok(out.includes('download='), 'non-media card must force download')
    assert.ok(
      out.includes('/api/file?path=%2Froot%2Fprojects%2Fq2%2Freport.docx'),
      'href should point at the /api/file URL for the exact path',
    )
  })
  it('renders other non-media types (.zip/.csv/.py) as download cards', () => {
    for (const p of ['/tmp/data/out.zip', '/var/log/app.log', '/home/me/scripts/run.py']) {
      const out = embedMediaUrls(`<p>${p}</p>`)
      assert.ok(out.includes('doc-card') && out.includes('download='), `${p} → download card`)
    }
  })
  it('keeps chained extensions (.tar.gz) whole', () => {
    const out = embedMediaUrls('<p>/tmp/backup/archive.tar.gz</p>')
    assert.ok(
      out.includes('archive.tar.gz'),
      'the full chained-extension filename must survive, not just archive.tar',
    )
  })
  it('still renders images inline (not as a plain link)', () => {
    const out = embedMediaUrls('<p>/root/.openclaude/generated/pic.png</p>')
    assert.ok(out.includes('inline-img'), 'png should inline as <img>')
    assert.ok(!out.includes('doc-card'), 'png should not be a doc card')
  })
  it('still renders video inline and pdf as a doc card', () => {
    assert.ok(embedMediaUrls('<p>/a/b/clip.mp4</p>').includes('inline-video'))
    assert.ok(embedMediaUrls('<p>/a/b/manual.pdf</p>').includes('doc-card'))
  })
  it('does NOT linkify prose without an absolute path or a real extension', () => {
    assert.ok(!embedMediaUrls('<p>升级到 python3.11 之后</p>').includes('doc-card'))
    assert.ok(!embedMediaUrls('<p>see version 1.2.3 notes</p>').includes('doc-card'))
    assert.ok(!embedMediaUrls('<p>路径 /usr/bin/python3.11 是解释器</p>').includes('doc-card'))
  })
  it('does not double-process paths already inside an anchor/img tag', () => {
    const pre = '<img class="inline-img" src="/api/file?path=%2Fa%2Fb.png">'
    const out = embedMediaUrls(pre)
    // No nested doc-card / second img injected for the already-embedded src
    assert.ok(!out.includes('doc-card'))
  })
})

// ── T07: htmlSafeEscape ──
describe('T07: htmlSafeEscape — HTML entity encoding', () => {
  it('escapes &', () => assert.equal(htmlSafeEscape('a & b'), 'a &amp; b'))
  it('escapes <', () => assert.equal(htmlSafeEscape('<script>'), '&lt;script&gt;'))
  it('escapes "', () => assert.equal(htmlSafeEscape('"hello"'), '&quot;hello&quot;'))
  it("escapes '", () => assert.equal(htmlSafeEscape("it's"), 'it&#39;s'))
  it('passes through safe text', () => assert.equal(htmlSafeEscape('hello world'), 'hello world'))
  it('handles empty string', () => assert.equal(htmlSafeEscape(''), ''))
  it('coerces number to string', () => assert.equal(htmlSafeEscape(42 as any), '42'))
})

// ── T08: formatMeta ──
describe('T08: formatMeta — metadata formatting', () => {
  it('null/undefined returns empty', () => assert.equal(formatMeta(null), ''))
  it('empty object returns empty', () => assert.equal(formatMeta({}), ''))
  it('cost only', () => assert.equal(formatMeta({ cost: 0.0123 }), '$0.0123'))
  it('tokens only', () => {
    const result = formatMeta({ inputTokens: 100, outputTokens: 50 })
    assert.ok(result.includes('in 100'), `Expected "in 100", got: ${result}`)
    assert.ok(result.includes('out 50'), `Expected "out 50", got: ${result}`)
  })
  it('turn number', () => {
    const result = formatMeta({ turn: 3 })
    assert.ok(result.includes('T3'), `Expected "T3", got: ${result}`)
  })
  it('full metadata', () => {
    const result = formatMeta({
      cost: 0.01,
      inputTokens: 500,
      outputTokens: 200,
      turn: 2,
    })
    assert.ok(result.includes('$0.0100'), result)
    assert.ok(result.includes('in 500'), result)
    assert.ok(result.includes('out 200'), result)
    assert.ok(result.includes('T2'), result)
    // Parts separated by ·
    assert.ok(result.includes('·'), `Expected · separator, got: ${result}`)
  })
  it('cache tokens', () => {
    const result = formatMeta({ cacheReadTokens: 300, cacheCreationTokens: 100 })
    assert.ok(result.includes('cache-r 300'), result)
    assert.ok(result.includes('cache-w 100'), result)
  })
})

// ── T09: buildToolUseLabel ──
describe('T09: buildToolUseLabel — tool use display', () => {
  it('tool name only', () => {
    assert.equal(buildToolUseLabel({ toolName: 'Read' }), 'Read')
  })
  it('tool with preview', () => {
    const result = buildToolUseLabel({ toolName: 'Write', inputPreview: '/path/file.ts' })
    assert.ok(result.startsWith('Write'), result)
    assert.ok(result.includes('/path/file.ts'), result)
  })
  it('partial tool use', () => {
    const result = buildToolUseLabel({ toolName: 'Bash', inputPreview: 'npm run', partial: true })
    assert.ok(result.includes('…'), `Expected ellipsis for partial, got: ${result}`)
  })
  it('unknown tool', () => {
    assert.equal(buildToolUseLabel({}), 'unknown')
  })
})

// ── T-LATEX: _scanCodexMathBody (markdown.js, 2026-05-05 Codex \[...\] 渲染修复) ──
//
// Codex/ChatGPT 输出 LaTeX 公式默认用 \(...\) 和 \[...\] 分隔符,marked 把 `\[`/`\(`
// 当 ASCII 标点 escape 吞反斜杠 → 用户看到裸 `[`/`(`。修法:在 markdown.js 注册两个
// 专用 marked extension(`codexDisplayMath` block-level / `codexInlineMath` inline-
// level),直接消化 \[..\] / \(..\),不再走 $...$ 中转(老方案的 ZWS sentinel 还是
// 卡在 mathInline 拒绝 digit-prefix `\(2x\)` 的边界规则上)。
//
// 这里测试的是从 closure 里抽出的内部 scanner — 给定 src/start/closeChar 找到 `\X`
// 闭合并跳过 `\\X`(TeX 反斜杠 escape,含 `\\\\` 行末换行)。dead 标记仅 multi-line
// scan 才会置位,用来在主 marked 入口短路 1000 个未闭合 `\[` 的 O(n²) 退化场景。
//
// 完整渲染(extension → marked.parse → KaTeX placeholder)需要浏览器环境的 marked
// + DOMPurify,不能在纯函数测试里跑。这里只断言 scanner 的契约。
type ScanResult = { closer: number; dead: boolean }
const _scanCodexMathBody = makeCallable<
  (src: string, start: number, closeChar: string, allowNewline: boolean) => ScanResult
>(extractFunction(appJs, '_scanCodexMathBody'))

describe('T-LATEX: _scanCodexMathBody — Codex/KaTeX 分隔符 body scanner', () => {
  it('inline body: simple closer at index', () => {
    // 'x\)' — index 1 is the `\` of `\)` closer
    const r = _scanCodexMathBody('x\\)', 0, ')', false)
    assert.deepEqual(r, { closer: 1, dead: false })
  })
  it('display body: simple closer at index', () => {
    const r = _scanCodexMathBody('x\\]', 0, ']', true)
    assert.deepEqual(r, { closer: 1, dead: false })
  })
  it('inline body: TeX \\\\ escape skipped (does not close at the second \\)', () => {
    // 'a \\ b\)' — middle `\\` is TeX line break (skip 2), must not be confused
    // for closer. 8 chars total: a, space, \, \, space, b, \, ). Closer `\` at idx 6.
    const r = _scanCodexMathBody('a \\\\ b\\)', 0, ')', false)
    assert.equal(r.closer, 6)
    assert.equal(r.dead, false)
  })
  it('display body: TeX \\\\ escape skipped', () => {
    const r = _scanCodexMathBody('a \\\\ b\\]', 0, ']', true)
    assert.equal(r.closer, 6)
    assert.equal(r.dead, false)
  })
  it('inline body: hits newline → no closer, NOT dead', () => {
    const r = _scanCodexMathBody('x\nbar\\)', 0, ')', false)
    assert.deepEqual(r, { closer: -1, dead: false })
  })
  it('display body: newline allowed, closer found across lines', () => {
    const r = _scanCodexMathBody('x\nbar\\]', 0, ']', true)
    assert.equal(r.closer, 5)
    assert.equal(r.dead, false)
  })
  it('inline body: EOF without closer → no closer, NOT dead (line-bound budget)', () => {
    const r = _scanCodexMathBody('x bar', 0, ')', false)
    assert.deepEqual(r, { closer: -1, dead: false })
  })
  it('display body: EOF without closer → DEAD (no `\\]` in remaining doc)', () => {
    const r = _scanCodexMathBody('x bar', 0, ']', true)
    assert.deepEqual(r, { closer: -1, dead: true })
  })
  it('display body: empty input', () => {
    const r = _scanCodexMathBody('', 0, ']', true)
    assert.deepEqual(r, { closer: -1, dead: true })
  })
  it('inline body: empty input → no closer, NOT dead', () => {
    const r = _scanCodexMathBody('', 0, ')', false)
    assert.deepEqual(r, { closer: -1, dead: false })
  })
  it('inline body: closer at very start (\\) at idx 0)', () => {
    const r = _scanCodexMathBody('\\)', 0, ')', false)
    assert.deepEqual(r, { closer: 0, dead: false })
  })
  it('inline body: lone trailing backslash at EOF does not crash', () => {
    const r = _scanCodexMathBody('x\\', 0, ')', false)
    assert.deepEqual(r, { closer: -1, dead: false })
  })
  it('display body: \\) inside body does not match \\] closer', () => {
    const r = _scanCodexMathBody('a\\)b\\]', 0, ']', true)
    assert.equal(r.closer, 4)
    assert.equal(r.dead, false)
  })
  it('inline body: \\] inside body does not match \\) closer', () => {
    const r = _scanCodexMathBody('a\\]b\\)', 0, ')', false)
    assert.equal(r.closer, 4)
    assert.equal(r.dead, false)
  })
  it('digit-prefix body \\(2x\\): scanner finds closer (the bug that ZWS approach failed)', () => {
    const r = _scanCodexMathBody('2x\\)', 0, ')', false)
    assert.equal(r.closer, 2)
    assert.equal(r.dead, false)
  })
  it('regression: original Codex bug-report display formula body scans cleanly', () => {
    const formula =
      '\\eta_\\varphi = \\frac{1}{N}+\\left(1-\\frac{1}{N}\\right)e^{-\\sigma_\\varphi^2}'
    const src = `${formula}\\]`
    const r = _scanCodexMathBody(src, 0, ']', true)
    assert.equal(r.closer, src.length - 2)
    assert.equal(r.dead, false)
    assert.equal(src.slice(0, r.closer), formula)
  })
  it('start offset: skip leading chars', () => {
    const r = _scanCodexMathBody('garbage x\\)', 8, ')', false)
    assert.equal(r.closer, 9)
    assert.equal(r.dead, false)
  })
  it('many-unclosed-\\[ pathological: single scan still linear (≪ 500ms)', () => {
    const big = `${'\\['.repeat(1000)}no closer`
    const start = Date.now()
    const r = _scanCodexMathBody(big, 0, ']', true)
    const elapsed = Date.now() - start
    assert.equal(r.closer, -1)
    assert.equal(r.dead, true)
    assert.ok(elapsed < 500, `single scan took ${elapsed}ms (expected ≪ 500ms)`)
  })
})

// ── T-LATEX-INTEGRATION: confirm extensions are registered (string-level) ──
describe('T-LATEX-INTEGRATION: codexDisplayMath / codexInlineMath wiring', () => {
  it('codexDisplayMath extension registered', () => {
    assert.ok(
      appJs.includes("name: 'codexDisplayMath'"),
      'codexDisplayMath extension missing from markdown.js',
    )
  })
  it('codexInlineMath extension registered', () => {
    assert.ok(
      appJs.includes("name: 'codexInlineMath'"),
      'codexInlineMath extension missing from markdown.js',
    )
  })
  it('renderMarkdown resets _codexDisplayMathDead at entry', () => {
    assert.ok(
      /renderMarkdown[\s\S]*?_codexDisplayMathDead\s*=\s*false/.test(appJs),
      'renderMarkdown must reset _codexDisplayMathDead = false',
    )
  })
  it('renderStreamingMarkdown resets _codexDisplayMathDead at entry', () => {
    assert.ok(
      /renderStreamingMarkdown[\s\S]*?_codexDisplayMathDead\s*=\s*false/.test(appJs),
      'renderStreamingMarkdown must reset _codexDisplayMathDead = false',
    )
  })
  it('extensions push to pendingMath with display flag', () => {
    assert.ok(appJs.includes('pendingMath.push({ id, tex: token.text, display: true })'))
    assert.ok(appJs.includes('pendingMath.push({ id, tex: token.text, display: false })'))
  })
})

// ── T-AUTO-PLAN: automatic plan-first routing heuristic ──
describe('T-AUTO-PLAN: shouldAutoPlan heuristic', () => {
  it('routes complex multi-step code work to plan mode', () => {
    assert.equal(shouldAutoPlan('修复 gateway 认证问题，然后补测试并保证前端缓存兼容'), true)
  })
  it('keeps simple one-step requests in default mode', () => {
    assert.equal(shouldAutoPlan('把按钮文案改成保存'), false)
  })
  it('honors explicit short plan generation requests', () => {
    assert.equal(shouldAutoPlan('随便生成一个计划'), true)
  })
  it('keeps explicit implementation/resume prompts in default mode', () => {
    assert.equal(shouldAutoPlan('按上面的计划开始实施。'), false)
  })
})

// ── T-PLAN-PANEL: Codex plan / TodoWrite quick panel wiring ──
describe('T-PLAN-PANEL: plan markdown rendering and quick panel wiring', () => {
  it('plan cards render markdown instead of assigning raw textContent', () => {
    assert.ok(
      appJs.includes('function _renderPlanMarkdownInto'),
      'messages.js should define a dedicated plan markdown renderer',
    )
    assert.ok(
      /function _buildPlanCard[\s\S]*?_renderPlanMarkdownInto\(draft,\s*msg\.text[\s\S]*?_renderPlanMarkdownInto\(explanation,\s*msg\.explanation/.test(
        appJs,
      ),
      'plan document and explanation should go through markdown rendering',
    )
  })
  it('updateMessageEl handles role=plan so streaming plan updates refresh the card', () => {
    assert.ok(
      /else if \(msg\.role === 'plan'\)[\s\S]*?_buildPlanCard\(el, msg\)/.test(appJs),
      'updateMessageEl should include a plan branch that rebuilds the plan card',
    )
  })
  it('current-session plan panel extracts latest plan and TodoWrite messages', () => {
    assert.ok(
      appJs.includes('export function getLatestPlanAndTodos'),
      'planPanel.js should export getLatestPlanAndTodos',
    )
    assert.ok(
      /m\?\.role === 'plan'/.test(appJs) && /m\.toolName === 'TodoWrite'/.test(appJs),
      'plan panel should scan current session messages for plan and TodoWrite',
    )
  })
  it('keeps the generated plan document while using later steps as task progress', () => {
    const docPlan = {
      id: 'plan-doc',
      role: 'plan',
      text: '# Plan\n\nDo the work.',
      _partial: false,
    }
    const progressPlan = {
      id: 'plan-progress',
      role: 'plan',
      steps: [
        { step: 'inspect', status: 'completed' },
        { step: 'patch', status: 'inProgress' },
      ],
      _partial: true,
    }
    const { plan, todo } = getLatestPlanAndTodos({ messages: [docPlan, progressPlan] })
    assert.equal(plan.id, 'plan-doc')
    assert.equal(todo.msg.id, 'plan-progress')
    assert.deepEqual(
      todo.todos.map((t: any) => [t.content, t.status]),
      [
        ['inspect', 'completed'],
        ['patch', 'in_progress'],
      ],
    )
  })
  it('style includes right-side plan panel classes', () => {
    assert.ok(styleCss.includes('.plan-panel'), 'style.css should include plan panel styles')
    assert.ok(
      styleCss.includes('.plan-panel-btn') && styleCss.includes('.plan-panel-badge'),
      'style.css should style the plan panel trigger and badge',
    )
  })
})

// ── T-GOAL-MODE: simple Codex Goal toggle state derivation ──
describe('T-GOAL-MODE: simple goal toggle keeps transcript normal', () => {
  it('returns null when no goal message exists', () => {
    assert.equal(getLatestGoalFromMessages([{ role: 'user', text: 'hi' }]), null)
  })
  it('uses the latest hidden goal message and normalizes numeric fields', () => {
    const goal = getLatestGoalFromMessages([
      { role: 'goal', objective: 'old', status: 'active', tokenBudget: 100 },
      { role: 'assistant', text: 'ok' },
      {
        role: 'goal',
        text: 'new from text',
        status: 'paused',
        tokenBudget: 2000,
        tokensUsed: 120,
        timeUsedSeconds: 60,
      },
    ])
    assert.deepEqual(goal, {
      cleared: false,
      objective: 'new from text',
      status: 'paused',
      tokenBudget: 2000,
      tokensUsed: 120,
      timeUsedSeconds: 60,
      updatedAt: null,
    })
  })
  it('treats cleared goal messages as an empty current goal', () => {
    assert.deepEqual(getLatestGoalFromMessages([{ role: 'goal', cleared: true }]), {
      cleared: true,
      objective: '',
      status: 'cleared',
      tokenBudget: null,
      tokensUsed: null,
      timeUsedSeconds: null,
      updatedAt: null,
    })
  })
  it('renders only a one-shot composer switch, not a Goal editor/status surface', () => {
    assert.ok(
      appJs.includes('goalModeEnabled') && appJs.includes('goalModeSeeded'),
      'Goal toggle should use explicit enabled/seeded session state',
    )
    assert.ok(
      /export function getGoalModeForSubmit\(\)[\s\S]*?enabled && !seeded \? true : undefined/.test(
        appJs,
      ),
      'Goal mode submit flag should be one-shot and not overwrite every follow-up',
    )
    assert.ok(
      appJs.includes('if (goalMode === true) markGoalModeSeeded()'),
      'Sending the seed message should mark the active Goal as seeded',
    )
    assert.ok(
      appJs.includes('openclaude:goal-mode-state-changed') &&
        appJs.includes('scheduleSaveFromUserEdit(sess, true)'),
      'Goal toggle/seed state should be persisted immediately, not only after another message',
    )
    assert.ok(
      appJs.includes("sendGoalControl('clear', {}, { silent: true })"),
      'Turning the switch off should silently clear the persistent thread goal',
    )
    assert.ok(
      appJs.includes('const _suppressGoalStatusToastUntil = new Map()') &&
        appJs.includes('_suppressGoalStatusToastUntil.set(action'),
      'Silent goal controls should suppress status toasts for all actions, not just get',
    )
    assert.ok(
      !appJs.includes('goal-mode-objective') &&
        !appJs.includes('goal-mode-budget') &&
        !appJs.includes('goal-mode-refresh') &&
        !appJs.includes('goal-mode-panel'),
      'Goal mode should not render the old editor, budget, refresh, or status panel UI',
    )
    assert.ok(
      /function _isTranscriptMessage\(msg\) \{\s*return msg\?\.role !== 'goal'\s*\}/.test(appJs),
      'Goal status messages should stay hidden from the main transcript',
    )
    assert.ok(
      appJs.includes('const msgs = s.messages.filter(_isTranscriptMessage)'),
      'Full transcript renders should paginate only visible conversation messages',
    )
    assert.ok(
      !appJs.includes('function _buildGoalCard') && !appJs.includes('.goal-card-'),
      'Role=goal should no longer have in-chat card rendering code',
    )
  })
})

// ── T10: Function extractor sanity ──
describe('T10: Function extractor sanity checks', () => {
  it('can extract _basename source', () => {
    const src = extractFunction(appJs, '_basename')
    assert.ok(src.includes('lastIndexOf'), 'Should contain lastIndexOf')
  })
  it('can extract formatSize source', () => {
    const src = extractFunction(appJs, 'formatSize')
    assert.ok(src.includes('1024'), 'Should contain 1024')
  })
  it('htmlSafeEscape exists in app.js source', () => {
    assert.ok(appJs.includes('htmlSafeEscape'), 'htmlSafeEscape should exist in app.js')
    assert.ok(appJs.includes("'&amp;'"), 'app.js should contain &amp; entity')
  })
  it('throws for non-existent function', () => {
    assert.throws(() => extractFunction(appJs, 'nonExistentFunction9999'), /not found/)
  })
})

// ── T-CLASSIFY: classifyFile (attachments.js, 2026-07-02 删 accept 白名单,对齐 v3 7f437368) ──
//
// classifyFile 引用 module-level TEXT_EXTS 常量,直接 makeCallable 会 ReferenceError。
// 把当前实现的正则显式注入闭包 —— 如果 attachments.js 里改了 TEXT_EXTS 但忘了
// 同步这里,下面的 drift 检测会立刻失败。
const _TEXT_EXTS_RE_TEST =
  /\.(txt|md|json|yaml|yml|csv|log|xml|html|htm|js|ts|tsx|py|go|rs|java|c|cpp|h|sh|sql)$/i
{
  const m = appJs.match(/const\s+TEXT_EXTS\s*=\s*\n?\s*(\/[^\n]+\/i)/)
  if (m && m[1] !== _TEXT_EXTS_RE_TEST.toString()) {
    throw new Error(
      `TEXT_EXTS in attachments.js drifted; update _TEXT_EXTS_RE_TEST. actual=${m[1]} test=${_TEXT_EXTS_RE_TEST.toString()}`,
    )
  }
}
const _classifyFileSrc = extractFunction(appJs, 'classifyFile')
const classifyFile = new Function(
  `const TEXT_EXTS = ${_TEXT_EXTS_RE_TEST.toString()};
   ${_classifyFileSrc};
   return classifyFile;`,
)() as (file: { type?: string; name?: string }) => string

describe('T-CLASSIFY: classifyFile — 删 accept 白名单后默认应该是 file 而不是 text', () => {
  // 媒体类:MIME 命中 image/audio/video → 对应 kind
  it('image/png → image', () =>
    assert.equal(classifyFile({ type: 'image/png', name: 'a.png' }), 'image'))
  it('audio/mpeg → audio', () =>
    assert.equal(classifyFile({ type: 'audio/mpeg', name: 'a.mp3' }), 'audio'))
  it('video/mp4 → video', () =>
    assert.equal(classifyFile({ type: 'video/mp4', name: 'a.mp4' }), 'video'))

  // 明确文本:MIME 是 text/* 或常见文本 application/* 或扩展名命中 → text
  it('text/plain → text', () =>
    assert.equal(classifyFile({ type: 'text/plain', name: 'a.txt' }), 'text'))
  it('application/json → text', () =>
    assert.equal(classifyFile({ type: 'application/json', name: 'a.json' }), 'text'))
  it('.md 空 MIME → text (按扩展名)', () =>
    assert.equal(classifyFile({ type: '', name: 'README.md' }), 'text'))
  it('.py 空 MIME → text', () => assert.equal(classifyFile({ type: '', name: 'app.py' }), 'text'))

  // 文档/压缩档:走 file 分支(消息不内联,uploadAttachment 上传)
  it('application/pdf → file', () =>
    assert.equal(classifyFile({ type: 'application/pdf', name: 'a.pdf' }), 'file'))
  it('application/zip → file', () =>
    assert.equal(classifyFile({ type: 'application/zip', name: 'a.zip' }), 'file'))
  it('.rar application/x-rar-compressed → file', () =>
    assert.equal(classifyFile({ type: 'application/x-rar-compressed', name: 'a.rar' }), 'file'))
  it('.7z application/x-7z-compressed → file', () =>
    assert.equal(classifyFile({ type: 'application/x-7z-compressed', name: 'a.7z' }), 'file'))

  // 关键回归保护:删 accept 白名单后,未知/空 MIME 必须默认 file 而不是 text。
  // 否则 ≤5MB 的 .bin/.exe/.apk 等会被 fileToText 当文本读出乱码塞进消息。
  it('未知扩展名 + 空 MIME → file (default, not text)', () =>
    assert.equal(classifyFile({ type: '', name: 'firmware.bin' }), 'file'))
  it('.exe 空 MIME → file', () =>
    assert.equal(classifyFile({ type: '', name: 'installer.exe' }), 'file'))
  it('.apk vendor MIME → file', () =>
    assert.equal(
      classifyFile({ type: 'application/vnd.android.package-archive', name: 'app.apk' }),
      'file',
    ))
  it('完全未知格式 .xyz → file', () =>
    assert.equal(classifyFile({ type: '', name: 'mystery.xyz' }), 'file'))
})
