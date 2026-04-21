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

// ── T-MED: parseYuanToCents (admin.js, 2026-04-21 安全审计 单位语义统一) ──
//
// admin /api/admin/users/:id/credits 后端 delta 是「分」整数;UI 输入 ¥
// 后由本函数转 cents,避免误把 "加 ¥1" 输成 1 分。
const parseYuanToCents = makeCallable<(input: string) => number | null>(
  extractFunction(appJs, 'parseYuanToCents'),
)
describe('T-MED: parseYuanToCents — ¥ → cents 转换 (单位语义统一)', () => {
  it('整数 ¥', () => assert.equal(parseYuanToCents('1'), 100))
  it('整数 + ¥ 前缀', () => assert.equal(parseYuanToCents('¥10'), 1000))
  it('整数 + + 前缀', () => assert.equal(parseYuanToCents('+5'), 500))
  it('两位小数', () => assert.equal(parseYuanToCents('1.50'), 150))
  it('一位小数补零', () => assert.equal(parseYuanToCents('1.5'), 150))
  it('负数', () => assert.equal(parseYuanToCents('-0.25'), -25))
  it('负数 + ¥', () => assert.equal(parseYuanToCents('-¥0.5'), null), /* ¥ 必须在符号前 */)
  it('两端空白', () => assert.equal(parseYuanToCents('  ¥1.00  '), 100))
  it('大额', () => assert.equal(parseYuanToCents('99999.99'), 9999999))
  it('零值拒绝(零变动无意义)', () => {
    assert.equal(parseYuanToCents('0'), null)
    assert.equal(parseYuanToCents('0.00'), null)
    assert.equal(parseYuanToCents('-0'), null)
  })
  it('空串拒绝', () => assert.equal(parseYuanToCents(''), null))
  it('空白拒绝', () => assert.equal(parseYuanToCents('   '), null))
  it('非数字拒绝', () => assert.equal(parseYuanToCents('abc'), null))
  it('超过 2 位小数拒绝(避免分以下精度)', () => {
    assert.equal(parseYuanToCents('1.234'), null)
    assert.equal(parseYuanToCents('0.001'), null)
  })
  it('科学记数法拒绝', () => {
    assert.equal(parseYuanToCents('1e3'), null)
    assert.equal(parseYuanToCents('1.5e2'), null)
  })
  it('多个小数点拒绝', () => {
    assert.equal(parseYuanToCents('1.2.3'), null)
  })
  it('单位安全:¥1 一定是 100 分,不是 1 分', () => {
    // 这条最重要:历史 admin UX 直接收 cents,boss 经常误打 "加 ¥1" → 输 1 →
    // 实际只加 1 分。新版必须保证 ¥1 → 100 cents。
    assert.equal(parseYuanToCents('1'), 100)
    assert.equal(parseYuanToCents('1.00'), 100)
  })
  it('非字符串输入拒绝', () => {
    assert.equal(parseYuanToCents(null as unknown as string), null)
    assert.equal(parseYuanToCents(undefined as unknown as string), null)
    assert.equal(parseYuanToCents(123 as unknown as string), null)
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
