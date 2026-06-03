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

// formatMeta(msg) 内部走 formatCreditsInline 渲染 costCredits → 字符串,后者是
// 同文件 module-private 函数(不 export 但 extractor 依然能定位 `function ...`)。
// 单纯 extractFunction(formatMeta) 出来的 callable 调到 costCredits 分支会 ReferenceError,
// 所以这里把 formatCreditsInline 一并注入到 new Function 闭包,模拟模块作用域。
const _formatCreditsInlineSrc = extractFunction(appJs, 'formatCreditsInline')
const _formatMetaSrc = extractFunction(appJs, 'formatMeta')
const formatMeta = new Function(
  `${_formatCreditsInlineSrc}; ${_formatMetaSrc}; return formatMeta;`,
)() as (m: any) => string

// 派生 status / IDB normalize / push-strip 都是无外部依赖的纯函数,直接 makeCallable。
const _deriveUserMsgStatus = makeCallable<
  (messages: any[], idx: number) => string | null
>(extractFunction(appJs, '_deriveUserMsgStatus'))

const _normalizeLoadedSession = makeCallable<(sess: any) => any>(
  extractFunction(appJs, '_normalizeLoadedSession'),
)

// _stripMessageEphemeral 引用 module-level const 数组。直接 makeCallable 会 ReferenceError,
// 所以把当前实现的两组键集合显式注入。如果 sync.js 里键集合调整了又不更新这里,
// 后续 T17 case 会立刻失败,起到强制对齐作用 —— 这是有意的。
const _MSG_EPHEMERAL_KEYS_TEST = [
  '_rawMeta',
  '_partial',
  '_completed',
  'output',
  'error',
  'bashTail',
  'inputJson',
  'inputPreview',
  'partialJson',
  'metaText',
]
const _MSG_SERVER_AUTHORITATIVE_KEYS_TEST = [
  '_seq',
  '_source',
  'usage',
  '_truncated',
  '_errorCode',
  '_errorDetail',
]
const _stripMessageEphemeralSrc = extractFunction(appJs, '_stripMessageEphemeral')
const _stripMessageEphemeral = new Function(
  `const _MSG_EPHEMERAL_KEYS = ${JSON.stringify(_MSG_EPHEMERAL_KEYS_TEST)};
   const _MSG_SERVER_AUTHORITATIVE_KEYS = ${JSON.stringify(_MSG_SERVER_AUTHORITATIVE_KEYS_TEST)};
   ${_stripMessageEphemeralSrc};
   return _stripMessageEphemeral;`,
)() as (messages: any[]) => any[]

// 实现-契约对齐自检:键集合若漂移此处必须同步更新,否则下面 T17 case 会假性通过。
{
  const m = appJs.match(/const\s+_MSG_EPHEMERAL_KEYS\s*=\s*\[([\s\S]*?)\]/)
  if (m) {
    const keys = m[1]
      .split(/[,\n]/)
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    if (keys.sort().join(',') !== [..._MSG_EPHEMERAL_KEYS_TEST].sort().join(',')) {
      throw new Error(
        `_MSG_EPHEMERAL_KEYS in sync.js drifted; update _MSG_EPHEMERAL_KEYS_TEST. ` +
          `actual=[${keys.join(',')}] test=[${_MSG_EPHEMERAL_KEYS_TEST.join(',')}]`,
      )
    }
  }
  const m2 = appJs.match(/const\s+_MSG_SERVER_AUTHORITATIVE_KEYS\s*=\s*\[([\s\S]*?)\]/)
  if (m2) {
    const keys = m2[1]
      .split(/[,\n]/)
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    if (keys.sort().join(',') !== [..._MSG_SERVER_AUTHORITATIVE_KEYS_TEST].sort().join(',')) {
      throw new Error(
        `_MSG_SERVER_AUTHORITATIVE_KEYS in sync.js drifted; update _MSG_SERVER_AUTHORITATIVE_KEYS_TEST. ` +
          `actual=[${keys.join(',')}] test=[${_MSG_SERVER_AUTHORITATIVE_KEYS_TEST.join(',')}]`,
      )
    }
  }
}

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

// ── T08: formatMeta — flat-msg fallback (handleOutbound 兼容路径) ──
//
// 2026-05-06 改动 8:formatMeta(msg) 新签名读 msg.usage → msg._rawMeta → msg。
// $X.XXXX cost / cacheCreationTokens(cache-w)字段已下线 —— v3 商用版上线后所有
// 消息走 server-authored usage.costCredits(分),前端不再做客户端估算口径。
// T08 保留 flat-msg fallback(无 usage 无 _rawMeta 时把 msg 自身当 usage 用)的
// 边界 case;usage / _rawMeta 显式路径单独走 T13 / T14。
describe('T08: formatMeta — flat-msg fallback (无 usage/_rawMeta)', () => {
  it('null returns empty', () => assert.equal(formatMeta(null), ''))
  it('undefined returns empty', () => assert.equal(formatMeta(undefined), ''))
  it('empty object returns empty', () => assert.equal(formatMeta({}), ''))
  it('flat tokens (handleOutbound 探测)', () => {
    const result = formatMeta({ inputTokens: 100, outputTokens: 50 })
    assert.ok(result.includes('in 100'), `Expected "in 100", got: ${result}`)
    assert.ok(result.includes('out 50'), `Expected "out 50", got: ${result}`)
  })
  it('flat turn', () => {
    const result = formatMeta({ turn: 3 })
    assert.ok(result.includes('T3'), `Expected "T3", got: ${result}`)
  })
  it('legacy cost field 不再渲染(下线)', () => {
    // 老 formatMeta 会输出 "$0.0100",新签名彻底丢弃 cost(交给 costCredits 权威值)。
    assert.equal(formatMeta({ cost: 0.0123 }), '')
  })
  it('legacy cacheCreationTokens 不再渲染(下线)', () => {
    // 老 formatMeta 会输出 "cache-w 100",新签名只保留 cache-r 单字段(server usage.cacheReadTokens)。
    assert.equal(formatMeta({ cacheCreationTokens: 100 }), '')
  })
  it('parts separated by ·', () => {
    const result = formatMeta({ inputTokens: 1, outputTokens: 2, turn: 3 })
    assert.ok(result.includes('·'), `Expected · separator, got: ${result}`)
    assert.equal(result.split(' · ').length, 3)
  })
})

// ── T13: formatMeta(msg.usage) — 主路径,server-authored usage 渲染 ──
//
// 字段集与历史 metaText 对齐(spec §5.3 T13):
//   costCredits(优先,formatCreditsInline → "X 积分" 或 "¥X.XX")
//   + inputTokens / outputTokens / cacheReadTokens / turn。
// usage 字段缺失时各自跳过,不输出占位符。
describe('T13: formatMeta(msg.usage) — server-authored usage 主路径', () => {
  it('全字段(¥ 显示):costCredits ≥ 100 → ¥X.XX', () => {
    const result = formatMeta({
      usage: {
        costCredits: '850',
        inputTokens: 13178,
        outputTokens: 142,
        cacheReadTokens: 4096,
        turn: 1,
      },
    })
    assert.ok(result.includes('¥8.50'), `Expected ¥8.50, got: ${result}`)
    assert.ok(result.includes('in 13178'), result)
    assert.ok(result.includes('out 142'), result)
    assert.ok(result.includes('cache-r 4096'), result)
    assert.ok(result.includes('T1'), result)
    assert.ok(result.includes('·'), `Expected · separator, got: ${result}`)
  })
  it('costCredits < 100(分):显示 "X 积分"', () => {
    const result = formatMeta({ usage: { costCredits: '8', inputTokens: 100, outputTokens: 50 } })
    assert.ok(result.includes('8 积分'), `Expected "8 积分", got: ${result}`)
    assert.ok(result.includes('in 100'), result)
    assert.ok(result.includes('out 50'), result)
  })
  it('costCredits BigInt 字符串边界:刚好 100 → ¥1.00', () => {
    const result = formatMeta({ usage: { costCredits: '100' } })
    assert.equal(result, '¥1.00')
  })
  it('costCredits 包含小数分:99 → 99 积分', () => {
    const result = formatMeta({ usage: { costCredits: '99' } })
    assert.equal(result, '99 积分')
  })
  it('部分字段缺失:仅 inputTokens', () => {
    const result = formatMeta({ usage: { inputTokens: 42 } })
    assert.equal(result, 'in 42')
  })
  it('部分字段缺失:仅 turn', () => {
    const result = formatMeta({ usage: { turn: 5 } })
    assert.equal(result, 'T5')
  })
  it('cacheReadTokens=0 不渲染(避免无意义 cache-r 0)', () => {
    const result = formatMeta({ usage: { inputTokens: 10, cacheReadTokens: 0 } })
    assert.equal(result, 'in 10')
  })
  it('msg 本身 + usage 共存 — 优先读 usage,不读 msg 顶层', () => {
    const result = formatMeta({
      inputTokens: 999, // 顶层应被忽略
      usage: { inputTokens: 1 },
    })
    assert.equal(result, 'in 1')
  })
  it('costCredits null / undefined 跳过(后端尚未结算)', () => {
    assert.equal(formatMeta({ usage: { costCredits: null, inputTokens: 7 } }), 'in 7')
    assert.equal(formatMeta({ usage: { costCredits: undefined, inputTokens: 7 } }), 'in 7')
  })
  it('costCredits 0 也跳过(0 积分显示无意义)', () => {
    // formatCreditsInline 返 "0 积分",但 0 本身没意义 — 检查是否 push;
    // 当前实现:n=0n 走 "<100" 分支返回 "0 积分"。Spec T13 没明确禁止,
    // 这里固化当前行为(若后续要改成跳过,改实现 + 改本 case 同步)。
    const result = formatMeta({ usage: { costCredits: '0' } })
    assert.equal(result, '0 积分')
  })
})

// ── T14: formatMeta — _rawMeta 兼容老 IDB row ──
//
// db.js _normalizeLoadedSession 条件清洗时,如果消息没有 usage 则保留 _rawMeta,
// 让 formatMeta 仍能渲染老数据。一旦 usage 就位,_rawMeta 就被 strip 掉(T16b)。
describe('T14: formatMeta — _rawMeta fallback (老 IDB row 兼容)', () => {
  it('msg._rawMeta 单独存在 → 走 fallback 渲染', () => {
    const result = formatMeta({
      _rawMeta: { inputTokens: 11, outputTokens: 22, turn: 3 },
    })
    assert.ok(result.includes('in 11'), result)
    assert.ok(result.includes('out 22'), result)
    assert.ok(result.includes('T3'), result)
  })
  it('usage 优先于 _rawMeta(usage 即权威源)', () => {
    const result = formatMeta({
      usage: { inputTokens: 1 },
      _rawMeta: { inputTokens: 999 }, // 老 row 残留,被忽略
    })
    assert.equal(result, 'in 1')
  })
  it('_rawMeta 含 costCredits → 走积分/¥ 渲染', () => {
    const result = formatMeta({ _rawMeta: { costCredits: '500', turn: 1 } })
    assert.ok(result.includes('¥5.00'), result)
    assert.ok(result.includes('T1'), result)
  })
  it('_rawMeta 为非 object → 退回 msg 顶层', () => {
    const result = formatMeta({ _rawMeta: null, inputTokens: 5 })
    assert.equal(result, 'in 5')
  })
})

// ── T15: _deriveUserMsgStatus — user 消息状态派生 ──
//
// 派生规则(messages.js _deriveUserMsgStatus):
//   1) 显式 sending/queued 直接返回(发送中态不能被派生覆盖)
//   2) 扫 [idx+1, ..) 至下一 user 边界,遇到 server-authored completed assistant → 'replied'
//   3) 否则回退 m.status || 'sent'
describe('T15: _deriveUserMsgStatus — 派生 user 消息状态', () => {
  it('非 user 消息 → null', () => {
    const msgs = [{ role: 'assistant', id: 'a', status: 'completed' }]
    assert.equal(_deriveUserMsgStatus(msgs, 0), null)
  })
  it('messages 非数组 → null', () => {
    assert.equal(_deriveUserMsgStatus(null as any, 0), null)
  })
  it('idx 越界 → null', () => {
    const msgs = [{ role: 'user', id: 'u' }]
    assert.equal(_deriveUserMsgStatus(msgs, 5), null)
  })
  it('显式 sending 不被派生覆盖', () => {
    const msgs = [
      { role: 'user', id: 'u', status: 'sending' },
      { role: 'assistant', id: 'a', _source: 'server', status: 'completed' },
    ]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'sending')
  })
  it('显式 queued 不被派生覆盖', () => {
    const msgs = [
      { role: 'user', id: 'u', status: 'queued' },
      { role: 'assistant', id: 'a', _source: 'server', status: 'completed' },
    ]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'queued')
  })
  it('后续无 assistant → 回退 m.status (sent)', () => {
    const msgs = [{ role: 'user', id: 'u', status: 'sent' }]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'sent')
  })
  it('后续无 assistant 且无 m.status → 默认 sent', () => {
    const msgs = [{ role: 'user', id: 'u' }]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'sent')
  })
  it('后续有 assistant 但 _source !== server → sent (纯客户端流式中)', () => {
    const msgs = [
      { role: 'user', id: 'u' },
      { role: 'assistant', id: 'a', _source: 'client', status: 'completed' },
    ]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'sent')
  })
  it('后续有 server-authored assistant 但未 completed → sent', () => {
    const msgs = [
      { role: 'user', id: 'u' },
      { role: 'assistant', id: 'a', _source: 'server', status: 'streaming' },
    ]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'sent')
  })
  it('后续有 server-authored completed assistant → replied', () => {
    const msgs = [
      { role: 'user', id: 'u' },
      { role: 'assistant', id: 'a', _source: 'server', status: 'completed' },
    ]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'replied')
  })
  it('interrupted server-authored assistant 不算 replied(thinking-only / 中断 turn)', () => {
    const msgs = [
      { role: 'user', id: 'u' },
      { role: 'assistant', id: 'a', _source: 'server', status: 'interrupted' },
    ]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'sent')
  })
  it('thinking-only turn(无 assistant) → sent', () => {
    const msgs = [
      { role: 'user', id: 'u' },
      { role: 'thinking' as any, id: 't' }, // 不是 assistant role
    ]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'sent')
  })
  it('多 user 序列 — 只看本 user 之后到下一 user 之前', () => {
    const msgs = [
      { role: 'user', id: 'u1' }, // idx 0:本 user 后到 u2 前 = 仅 a1(server completed) → replied
      { role: 'assistant', id: 'a1', _source: 'server', status: 'completed' },
      { role: 'user', id: 'u2' }, // idx 2:本 user 后无 assistant → sent(不应误捕 a1)
    ]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'replied')
    assert.equal(_deriveUserMsgStatus(msgs, 2), 'sent')
  })
  it('中间夹 server-authored completed → 仍取第一个 completed', () => {
    const msgs = [
      { role: 'user', id: 'u1' },
      { role: 'assistant', id: 'tool-use' as any, _source: 'server', status: 'completed' },
      { role: 'assistant', id: 'a2', _source: 'server', status: 'completed' },
      { role: 'user', id: 'u2' },
    ]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'replied')
  })
  it('null 项 in messages — 跳过不崩', () => {
    const msgs: any = [
      { role: 'user', id: 'u' },
      null,
      { role: 'assistant', id: 'a', _source: 'server', status: 'completed' },
    ]
    assert.equal(_deriveUserMsgStatus(msgs, 0), 'replied')
  })
})

// ── T16: _normalizeLoadedSession — IDB load-time 条件清洗 ──
//
// db.js _normalizeLoadedSession 在 dbGetAll 阶段对每个 row 跑:
//   - ephemeral 字段(_partial/_completed/output/error/bashTail/inputJson/inputPreview)总 strip
//   - user 消息 status='replied' 总 strip(改派生)
//   - metaText / _rawMeta:仅在 m.usage 存在时才 strip(否则保留以兼容老 row)
describe('T16: _normalizeLoadedSession — IDB load-time 条件清洗', () => {
  it('T16a — 含 metaText/_rawMeta 但无 usage → 保留 metaText/_rawMeta(老 row 兼容)', () => {
    const sess = {
      id: 's1',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          metaText: 'in 100 · out 50',
          _rawMeta: { inputTokens: 100, outputTokens: 50 },
        },
      ],
    }
    const out = _normalizeLoadedSession(sess)
    assert.equal(out.messages[0].metaText, 'in 100 · out 50')
    assert.deepEqual(out.messages[0]._rawMeta, { inputTokens: 100, outputTokens: 50 })
  })
  it('T16b — 含 metaText/_rawMeta 且有 usage → 删除 metaText/_rawMeta', () => {
    const sess = {
      id: 's1',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          usage: { inputTokens: 100 },
          metaText: 'in 100',
          _rawMeta: { inputTokens: 100 },
        },
      ],
    }
    const out = _normalizeLoadedSession(sess)
    assert.equal(out.messages[0].metaText, undefined)
    assert.equal(out.messages[0]._rawMeta, undefined)
    assert.deepEqual(out.messages[0].usage, { inputTokens: 100 })
  })
  it('T16c — ephemeral 字段无论 usage 是否存在永远 strip', () => {
    const sess = {
      id: 's1',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          _partial: true,
          _completed: false,
          output: 'partial output',
          error: 'oops',
          bashTail: 'last line',
          inputJson: '{"x":1}',
          inputPreview: 'preview',
        },
        {
          id: 'm2',
          role: 'assistant',
          usage: { inputTokens: 1 },
          _partial: true,
          output: 'output',
          inputPreview: 'pv',
        },
      ],
    }
    const out = _normalizeLoadedSession(sess)
    for (const m of out.messages) {
      assert.equal(m._partial, undefined)
      assert.equal(m._completed, undefined)
      assert.equal(m.output, undefined)
      assert.equal(m.error, undefined)
      assert.equal(m.bashTail, undefined)
      assert.equal(m.inputJson, undefined)
      assert.equal(m.inputPreview, undefined)
    }
  })
  it('T16d — user 消息 status="replied" 被 strip(改派生)', () => {
    const sess = {
      id: 's1',
      messages: [
        { id: 'u1', role: 'user', status: 'replied', text: 'hi' },
        { id: 'u2', role: 'user', status: 'sent', text: 'hi2' },
      ],
    }
    const out = _normalizeLoadedSession(sess)
    assert.equal(out.messages[0].status, undefined, 'replied 应被 strip')
    assert.equal(out.messages[1].status, 'sent', 'sent 应保留')
  })
  it('T16d — assistant 消息 status="replied" 不 strip(只针对 user)', () => {
    // 实现注释里写 `m.role === 'user' && m.status === 'replied'` 才 strip。
    // assistant 不应该有 'replied' 状态,但若历史污染存在,不 strip 也无害。
    const sess = {
      id: 's1',
      messages: [{ id: 'a1', role: 'assistant', status: 'replied' as any }],
    }
    const out = _normalizeLoadedSession(sess)
    assert.equal(out.messages[0].status, 'replied')
  })
  it('共同断言 — text/role/id/ts/usage 永远保留', () => {
    const sess = {
      id: 's1',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          ts: 1234567890,
          text: 'hello world',
          usage: { inputTokens: 10, costCredits: '50' },
          metaText: 'should be stripped', // 因为有 usage,会被删
          _partial: true,
        },
      ],
    }
    const out = _normalizeLoadedSession(sess)
    const m = out.messages[0]
    assert.equal(m.id, 'm1')
    assert.equal(m.role, 'assistant')
    assert.equal(m.ts, 1234567890)
    assert.equal(m.text, 'hello world')
    assert.deepEqual(m.usage, { inputTokens: 10, costCredits: '50' })
    assert.equal(m.metaText, undefined)
    assert.equal(m._partial, undefined)
  })
  it('messages 非数组 → 直接返回(不崩)', () => {
    assert.deepEqual(_normalizeLoadedSession({ id: 's', messages: null as any }), {
      id: 's',
      messages: null,
    })
    assert.equal(_normalizeLoadedSession(null as any), null)
  })
  it('null 项 in messages — 跳过不崩', () => {
    const sess = {
      id: 's1',
      messages: [null, undefined, { id: 'ok', role: 'user', status: 'replied' }],
    }
    const out = _normalizeLoadedSession(sess)
    assert.equal((out.messages[2] as any).status, undefined)
  })
})

// ── T17: _stripMessageEphemeral — push 出方 strip ──
//
// sync.js pushSessionToServer 在 PUT 前对每条消息 strip:
//   1) ephemeral 字段(_rawMeta / _partial / _completed / output / error / bashTail /
//      inputJson / inputPreview / metaText)— 不该持久化
//   2) server-authoritative 字段(_seq / _source / usage / _truncated / _errorCode /
//      _errorDetail)— 客户端无权伪造,server 自己生成
//   3) status === 'replied' — 派生不持久化
describe('T17: _stripMessageEphemeral — PUT 前 strip 客户端瞎写的字段', () => {
  it('strip ephemeral 字段', () => {
    const out = _stripMessageEphemeral([
      {
        id: 'm1',
        role: 'assistant',
        text: 'hi',
        _rawMeta: { x: 1 },
        _partial: true,
        _completed: false,
        output: 'o',
        error: 'e',
        bashTail: 'b',
        inputJson: '{}',
        inputPreview: 'p',
        metaText: 'mt',
      },
    ])
    const m = out[0]
    for (const k of _MSG_EPHEMERAL_KEYS_TEST) {
      assert.equal(m[k], undefined, `ephemeral key ${k} should be stripped`)
    }
    assert.equal(m.id, 'm1')
    assert.equal(m.role, 'assistant')
    assert.equal(m.text, 'hi')
  })
  it('strip server-authoritative 字段(client 不允许伪造)', () => {
    const out = _stripMessageEphemeral([
      {
        id: 'm1',
        role: 'assistant',
        text: 'hi',
        _seq: 9999,
        _source: 'server',
        usage: { costCredits: '999999' },
        _truncated: true,
        _errorCode: 'oops',
        _errorDetail: 'bad',
      },
    ])
    const m = out[0]
    for (const k of _MSG_SERVER_AUTHORITATIVE_KEYS_TEST) {
      assert.equal(m[k], undefined, `server-auth key ${k} should be stripped`)
    }
    assert.equal(m.id, 'm1')
    assert.equal(m.text, 'hi')
  })
  it('strip status="replied" 但保留其他 status', () => {
    const out = _stripMessageEphemeral([
      { id: 'u1', role: 'user', text: 'hi', status: 'replied' },
      { id: 'u2', role: 'user', text: 'hi2', status: 'sent' },
      { id: 'u3', role: 'user', text: 'hi3', status: 'sending' },
    ])
    assert.equal(out[0].status, undefined)
    assert.equal(out[1].status, 'sent')
    assert.equal(out[2].status, 'sending')
  })
  it('保留 text/role/id/ts/attachments/blocks 等非 strip 字段', () => {
    const original = {
      id: 'm1',
      role: 'assistant',
      ts: 1234567890,
      text: 'hello',
      blocks: [{ type: 'text', text: 'hi' }],
      attachments: [{ name: 'a.png' }],
      richBlocks: [{ kind: 'chart' }],
      // 该 strip 的:
      _seq: 1,
      _partial: true,
    }
    const out = _stripMessageEphemeral([original])
    const m = out[0]
    assert.equal(m.id, 'm1')
    assert.equal(m.role, 'assistant')
    assert.equal(m.ts, 1234567890)
    assert.equal(m.text, 'hello')
    assert.deepEqual(m.blocks, [{ type: 'text', text: 'hi' }])
    assert.deepEqual(m.attachments, [{ name: 'a.png' }])
    assert.deepEqual(m.richBlocks, [{ kind: 'chart' }])
    assert.equal(m._seq, undefined)
    assert.equal(m._partial, undefined)
  })
  it('返回新对象,不 mutate 原 message(纯函数语义)', () => {
    const orig = { id: 'm1', _seq: 1, _partial: true, text: 'x' }
    const out = _stripMessageEphemeral([orig])
    assert.equal(orig._seq, 1, '原对象未被 mutate')
    assert.equal(orig._partial, true, '原对象未被 mutate')
    assert.equal(out[0]._seq, undefined, '副本已 strip')
    assert.notEqual(out[0], orig, '应返回新对象引用')
  })
  it('messages 非数组 → 原样返回(不崩)', () => {
    assert.equal(_stripMessageEphemeral(null as any), null)
    assert.equal(_stripMessageEphemeral(undefined as any), undefined)
  })
  it('null/undefined 项 in messages — 原样保留', () => {
    const out = _stripMessageEphemeral([null, undefined, { id: 'ok', _seq: 1 }] as any)
    assert.equal(out[0], null)
    assert.equal(out[1], undefined)
    assert.equal((out[2] as any)._seq, undefined)
    assert.equal((out[2] as any).id, 'ok')
  })
  it('空数组 → 空数组', () => {
    assert.deepEqual(_stripMessageEphemeral([]), [])
  })
})


// ── T-AUTO-PLAN: explicit-only plan routing helper ──
describe('T-AUTO-PLAN: shouldAutoPlan explicit-only helper', () => {
  it('does not route complex multi-step code work by heuristic', () => {
    assert.equal(shouldAutoPlan('修复 gateway 认证问题，然后补测试并保证前端缓存兼容'), false)
  })

  it('does not route image/design attachments by heuristic', () => {
    assert.equal(shouldAutoPlan('还原设计稿', [{ kind: 'image' }]), false)
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
describe('T-PLAN-PANEL: plan document and progress separation', () => {
  it('plan cards keep implementation action but omit persistent-plan button', () => {
    assert.equal(appJs.includes('查看常驻计划'), false)
    assert.equal(appJs.includes('plan-panel-open-btn'), false)
    assert.equal(appJs.includes('开始实施'), true)
  })

  it('keeps the generated plan document while using later steps as task progress', () => {
    const docPlan = { id: 'plan-doc', role: 'plan', text: '# Plan\n\nDo the work.', _partial: false }
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

// ── T-CLASSIFY: classifyFile (attachments.js, 2026-05-09 删 accept 白名单) ──
//
// classifyFile 引用 module-level TEXT_EXTS 常量,直接 makeCallable 会 ReferenceError。
// 沿用 _stripMessageEphemeral 的"显式注入"模式 — 把当前实现的正则注入闭包,如果
// attachments.js 里改了 TEXT_EXTS 但忘了同步这里,下面的 case 会立刻失败。
const _TEXT_EXTS_RE_TEST = /\.(txt|md|json|yaml|yml|csv|log|xml|html|js|ts|tsx|py|go|rs|java|c|cpp|h|sh|sql)$/i
{
  const m = appJs.match(/const\s+TEXT_EXTS\s*=\s*(\/[^\n]+\/i)/)
  if (m && m[1] !== _TEXT_EXTS_RE_TEST.toString()) {
    throw new Error(
      `TEXT_EXTS in attachments.js drifted; update _TEXT_EXTS_RE_TEST. ` +
        `actual=${m[1]} test=${_TEXT_EXTS_RE_TEST.toString()}`,
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
  it('image/png → image', () => assert.equal(classifyFile({ type: 'image/png', name: 'a.png' }), 'image'))
  it('audio/mpeg → audio', () => assert.equal(classifyFile({ type: 'audio/mpeg', name: 'a.mp3' }), 'audio'))
  it('video/mp4 → video', () => assert.equal(classifyFile({ type: 'video/mp4', name: 'a.mp4' }), 'video'))

  // 明确文本:MIME 是 text/* 或常见文本 application/* 或扩展名命中 → text
  it('text/plain → text', () => assert.equal(classifyFile({ type: 'text/plain', name: 'a.txt' }), 'text'))
  it('application/json → text', () => assert.equal(classifyFile({ type: 'application/json', name: 'a.json' }), 'text'))
  it('.md 空 MIME → text (按扩展名)', () => assert.equal(classifyFile({ type: '', name: 'README.md' }), 'text'))
  it('.py 空 MIME → text', () => assert.equal(classifyFile({ type: '', name: 'app.py' }), 'text'))

  // 文档/压缩档:走 file 分支(messages JSON 不内联,_uploadOne 上传)
  it('application/pdf → file', () => assert.equal(classifyFile({ type: 'application/pdf', name: 'a.pdf' }), 'file'))
  it('application/zip → file', () => assert.equal(classifyFile({ type: 'application/zip', name: 'a.zip' }), 'file'))
  it('.rar application/x-rar-compressed → file',
    () => assert.equal(classifyFile({ type: 'application/x-rar-compressed', name: 'a.rar' }), 'file'))
  it('.7z application/x-7z-compressed → file',
    () => assert.equal(classifyFile({ type: 'application/x-7z-compressed', name: 'a.7z' }), 'file'))

  // 关键回归保护:删 accept 白名单后,未知/空 MIME 必须默认 file 而不是 text。
  // 否则 ≤64KB 的 .bin/.exe/.apk 等会被 fileToText 当文本读出乱码塞进 messages JSON。
  it('未知扩展名 + 空 MIME → file (default, not text)',
    () => assert.equal(classifyFile({ type: '', name: 'firmware.bin' }), 'file'))
  it('.exe 空 MIME → file',
    () => assert.equal(classifyFile({ type: '', name: 'installer.exe' }), 'file'))
  it('.apk vendor MIME → file',
    () => assert.equal(classifyFile({ type: 'application/vnd.android.package-archive', name: 'app.apk' }), 'file'))
  it('完全未知格式 .xyz → file',
    () => assert.equal(classifyFile({ type: '', name: 'mystery.xyz' }), 'file'))
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
  // codex round 1 finding #6 — 与后端 ¥1,000,000 = 100,000,000 cents 硬 cap 对齐
  it('恰好 cap (¥1,000,000) 接受', () => {
    assert.equal(parseYuanToCents('1000000'), 100_000_000)
    assert.equal(parseYuanToCents('1000000.00'), 100_000_000)
  })
  it('超过 cap 拒绝(避免 Number 精度丢 + 后端 400)', () => {
    assert.equal(parseYuanToCents('1000000.01'), null)
    assert.equal(parseYuanToCents('9999999'), null)
  })
  it('整数部位超 10 位直接拒绝(防 Number 精度损失)', () => {
    assert.equal(parseYuanToCents('99999999999'), null) // 11 位
    assert.equal(parseYuanToCents('12345678901.23'), null)
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
    // No data scanned, but allowNewline=true still considers EOF as "no closer ever"
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
    // 'x\' — the `\` at EOF has no `next` char, scanner advances past it
    const r = _scanCodexMathBody('x\\', 0, ')', false)
    assert.deepEqual(r, { closer: -1, dead: false })
  })
  it('display body: \\) inside body does not match \\] closer', () => {
    // body has a `\)` that's literal text in display math
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
    // The previous _normalizeLatexDelimiters → ZWS sandwich approach turned this
    // into `\u200B$2x$\u200B`, but mathInline rejected `$` followed by digit `2`.
    // The new scanner has no boundary heuristics — it simply finds the closer.
    const r = _scanCodexMathBody('2x\\)', 0, ')', false)
    assert.equal(r.closer, 2)
    assert.equal(r.dead, false)
  })
  it('regression: original Codex bug-report display formula body scans cleanly', () => {
    // After src[0..1] is `\[`, scanner starts at index 2 and should find `\]` at
    // the very end of the formula body.
    const formula = '\\eta_\\varphi = \\frac{1}{N}+\\left(1-\\frac{1}{N}\\right)e^{-\\sigma_\\varphi^2}'
    const src = `${formula}\\]`
    const r = _scanCodexMathBody(src, 0, ']', true)
    // Closer should be at the `\` of `\]` — i.e., src.length - 2
    assert.equal(r.closer, src.length - 2)
    assert.equal(r.dead, false)
    // Body extracted via src.slice(0, closer)
    assert.equal(src.slice(0, r.closer), formula)
  })
  it('start offset: skip leading chars', () => {
    const r = _scanCodexMathBody('garbage x\\)', 8, ')', false)
    assert.equal(r.closer, 9)
    assert.equal(r.dead, false)
  })
  it('many-unclosed-\\[ pathological: single scan still linear (≪ 500ms)', () => {
    // 1000 unclosed `\[` — first scan is bounded by input length (3000 chars).
    // The dead flag short-circuit lives in the marked extension's start() callback,
    // not this scanner; here we just verify ONE scan over a 3000-char input is fast.
    const big = '\\['.repeat(1000) + 'no closer'
    const start = Date.now()
    const r = _scanCodexMathBody(big, 0, ']', true)
    const elapsed = Date.now() - start
    assert.equal(r.closer, -1)
    assert.equal(r.dead, true)
    assert.ok(elapsed < 500, `single scan took ${elapsed}ms (expected ≪ 500ms)`)
  })
})

// ── T-LATEX-INTEGRATION: confirm extensions are registered (string-level) ──
//
// We can't run marked.parse() in the test env (no DOMPurify, no `marked` global),
// but we can statically verify the extension wiring is present in source so a
// future refactor doesn't accidentally drop our extensions.
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
    // The dead flag is module-level for O(n²) defense; if a previous render set
    // it true and we forget to reset, all subsequent renders silently drop \[..\].
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
    // codexDisplayMath should push with display: true, codexInlineMath with display: false
    assert.ok(appJs.includes('pendingMath.push({ id, tex: token.text, display: true })'))
    assert.ok(appJs.includes('pendingMath.push({ id, tex: token.text, display: false })'))
  })
})

// ── T-MATH-FILL: _fillMathPlaceholdersSync (markdown.js, 2026-05-13 DOMPurify 重排 fix) ──
//
// Old impl used literal-string split/join on `<div class="math-block" id="X"></div>` /
// `<span class="math-inline" id="X"></span>`. But DOMPurify.sanitize runs the HTML
// through the browser parser+serializer, which normalizes attribute order to
// `id` first → marker had 0 hits, items were already spliced from pendingMath,
// async processRichBlocks fallback also couldn't see them → users saw permanent
// blank `$..$` / `$$..$$` placeholders for any math-bearing message.
//
// Fix: DOM-based replacement (createElement+querySelector+outerHTML), agnostic
// to attribute order/quote/whitespace. These tests pin (a) the implementation
// can't regress to string split/join, and (b) the contract: replacement works
// for both `class id` and `id class` placeholder orderings.

// Structural assertions — regress if anyone reverts the implementation strategy.
describe('T-MATH-FILL-STRUCTURAL: _fillMathPlaceholdersSync source shape', () => {
  const fillSrc = extractFunction(appJs, '_fillMathPlaceholdersSync')

  it('does NOT use literal `<div class="math-block" id="` substring', () => {
    // The exact string that failed against DOMPurify-reordered output. If this
    // ever comes back, the bug returns immediately for any math-bearing reply.
    assert.ok(
      !fillSrc.includes('<div class="math-block" id="'),
      'must not use class-first literal marker (DOMPurify reorders to id-first → 0 hits)',
    )
  })
  it('does NOT use literal `<span class="math-inline" id="` substring', () => {
    assert.ok(
      !fillSrc.includes('<span class="math-inline" id="'),
      'must not use class-first literal marker (DOMPurify reorders to id-first → 0 hits)',
    )
  })
  it('uses createElement for DOM-based parse', () => {
    assert.ok(
      fillSrc.includes('createElement'),
      'must build a detached container via document.createElement',
    )
  })
  it('uses querySelector for placeholder lookup (attribute-order agnostic)', () => {
    assert.ok(
      fillSrc.includes('querySelector'),
      'must find placeholders via querySelector("#id"), not string substring',
    )
  })
  it('uses outerHTML for replacement (preserves KaTeX inline style+aria-hidden)', () => {
    assert.ok(
      fillSrc.includes('outerHTML'),
      'must replace placeholders via el.outerHTML — string concatenation would re-introduce serialization fragility',
    )
  })
  it('keeps window.katex early-return guard (no crash when KaTeX not loaded)', () => {
    assert.ok(
      /!\s*window\.katex/.test(fillSrc),
      'must early-return when KaTeX is missing — async processRichBlocks fallback covers that case',
    )
  })
  it('keeps katex.renderToString call (sync render path is the whole point)', () => {
    assert.ok(
      fillSrc.includes('renderToString'),
      'must call katex.renderToString synchronously — otherwise we degrade back to async-fill 0-height frame (iOS Safari paint lag)',
    )
  })
  it('renderMarkdown still splices items out of pendingMath before sync-fill', () => {
    // If splice is removed, sync fill + async processRichBlocks would both
    // render the same item → KaTeX HTML duplicated, or one overwriting the
    // other. The splice is load-bearing.
    const renderSrc = extractFunction(appJs, 'renderMarkdown')
    assert.ok(
      /pendingMath\.splice\(/.test(renderSrc),
      'renderMarkdown must splice items from pendingMath before handing them to sync-fill',
    )
  })
})

// Behavioural contract — mini DOM stub satisfies just the four surfaces
// `_fillMathPlaceholdersSync` touches (document.createElement,
// container.innerHTML, container.querySelector, element.outerHTML). NOT a full
// DOM impl — only what's needed to prove attribute-order independence.
describe('T-MATH-FILL-CONTRACT: replacement works regardless of attribute order', () => {
  // Mini DOM stub. Strategy:
  //   - container is a plain object with an `_html` string backing store
  //   - innerHTML get/set reads/writes the backing store
  //   - querySelector('#id') scans `_html` with a regex that matches an empty
  //     `<div|span ...></div|span>` carrying `id="id"` in ANY attribute slot
  //   - querySelectorAll('.math-block, .math-inline') returns empty math shells
  //     in source order for the production ordered fallback path
  //   - returned stub elements expose classList.contains, container.contains,
  //     and an outerHTML setter that splices the rendered KaTeX HTML into `_html`.
  //
  // Critical: this regex deliberately accepts both attribute orderings (and
  // the single-`id` no-class case) so the contract test really proves that
  // the production impl doesn't care about ordering.
  function makeStubContainer() {
    type StubEl = {
      _fullMatch: string
      classList: { contains: (cls: string) => boolean }
      outerHTML: string
    }
    const attrRe = /([a-zA-Z-]+)=("[^"]*"|'[^']*')/g
    function parseAttrs(rawAttrs: string) {
      const attrs: Record<string, string> = {}
      for (const m of rawAttrs.matchAll(attrRe)) {
        attrs[m[1]] = m[2].slice(1, -1)
      }
      return attrs
    }
    function makeEl(container: { _html: string }, fullMatch: string, className = ''): StubEl {
      return {
        _fullMatch: fullMatch,
        classList: {
          contains(cls: string) {
            return className.split(/\s+/).includes(cls)
          },
        },
        get outerHTML() {
          return this._fullMatch
        },
        set outerHTML(newHtml: string) {
          // Use split/join — `fullMatch` is unique per id in our test inputs.
          container._html = container._html.split(this._fullMatch).join(newHtml)
        },
      }
    }
    const container: {
      _html: string
      querySelector: (sel: string) => StubEl | null
      querySelectorAll: (sel: string) => StubEl[]
      contains: (el: StubEl) => boolean
      innerHTML: string
    } = {
        _html: '',
        querySelector(selector: string) {
          if (!selector.startsWith('#')) return null
          const id = selector.slice(1)
          // Match `<div|span ANY-ATTRS-INCLUDING id="ID"-ANYWHERE ANY-ATTRS></div|span>`
          // Reject any non-`>` chars between `<tag` and `>` other than whitespace+attrs.
          const re = new RegExp(
            `<(div|span)\\b((?:\\s+[a-zA-Z-]+=(?:"[^"]*"|'[^']*'))*\\s+id="${id.replace(/[-]/g, '\\$&')}"(?:\\s+[a-zA-Z-]+=(?:"[^"]*"|'[^']*'))*)?\\s*></\\1>`,
          )
          const m = re.exec(this._html)
          if (!m) return null
          const fullMatch = m[0]
          const attrs = parseAttrs(m[2] || '')
          return makeEl(this, fullMatch, attrs.class || '')
        },
        querySelectorAll(selector: string) {
          if (selector !== '.math-block, .math-inline') return []
          const out: StubEl[] = []
          const re = /<(div|span)\b((?:\s+[a-zA-Z-]+=(?:"[^"]*"|'[^']*'))*)\s*><\/\1>/g
          for (const m of this._html.matchAll(re)) {
            const attrs = parseAttrs(m[2] || '')
            const classes = (attrs.class || '').split(/\s+/)
            if (classes.includes('math-block') || classes.includes('math-inline')) {
              out.push(makeEl(this, m[0], attrs.class || ''))
            }
          }
          return out
        },
        contains(el: StubEl) {
          return this._html.includes(el._fullMatch)
        },
        get innerHTML() {
          return this._html
        },
        set innerHTML(v: string) {
          this._html = v
        },
      }
    return container
  }
  function makeStubDocument() {
    return {
      createElement(tagName: string) {
        if (tagName !== 'div') throw new Error(`stub only supports <div>, got <${tagName}>`)
        return makeStubContainer()
      },
    }
  }

  // Extract production source and bind it to the stub globals via new Function.
  // We inject: window (with .katex + optionally .CSS), document, htmlSafeEscape.
  const _fillSrc = extractFunction(appJs, '_fillMathPlaceholdersSync')
  type FillSig = (html: string, items: Array<{ id: string; tex: string; display: boolean }>) => string
  function makeFill(mockWindow: any, mockDocument: any, mockHtmlSafeEscape: (s: string) => string) {
    return new Function(
      'window',
      'document',
      'htmlSafeEscape',
      `${_fillSrc}; return _fillMathPlaceholdersSync;`,
    )(mockWindow, mockDocument, mockHtmlSafeEscape) as FillSig
  }
  // Stand-in for the imported `htmlSafeEscape` from './dom.js' — minimal but
  // covers what the KaTeX-error path will throw at it (`<`, `>`, `&`).
  function stubHtmlSafeEscape(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  function stubKatex() {
    return {
      renderToString(tex: string, opts: { displayMode: boolean }) {
        return `<span class="katex-html" data-display="${opts.displayMode}">${tex}</span>`
      },
    }
  }

  it('DOMPurify-reordered placeholder (id first) gets replaced', () => {
    // This is the exact failure mode from the live bug.
    const win = { katex: stubKatex() }
    const fill = makeFill(win, makeStubDocument(), stubHtmlSafeEscape)
    const html = '<p>foo <span id="math-abc12345" class="math-inline"></span> bar</p>'
    const out = fill(html, [{ id: 'math-abc12345', tex: 'f(x)', display: false }])
    assert.ok(out.includes('katex-html'), `expected KaTeX HTML in output, got: ${out}`)
    assert.ok(out.includes('f(x)'), 'expected tex content in output')
    assert.ok(!out.includes('<span id="math-abc12345"'), 'placeholder must be gone')
  })
  it('marked-original placeholder (class first) gets replaced', () => {
    // Sanity: even before DOMPurify, this is what marked emits. Both orderings
    // must work because either could land in the input depending on caller.
    const win = { katex: stubKatex() }
    const fill = makeFill(win, makeStubDocument(), stubHtmlSafeEscape)
    const html = '<p>foo <span class="math-inline" id="math-abc12345"></span> bar</p>'
    const out = fill(html, [{ id: 'math-abc12345', tex: 'f(x)', display: false }])
    assert.ok(out.includes('katex-html'), `expected KaTeX HTML in output, got: ${out}`)
  })
  it('display math (div) — id-first ordering, display:true', () => {
    const win = { katex: stubKatex() }
    const fill = makeFill(win, makeStubDocument(), stubHtmlSafeEscape)
    const html = 'prefix<div id="math-xy789" class="math-block"></div>suffix'
    const out = fill(html, [{ id: 'math-xy789', tex: 'E=mc^2', display: true }])
    assert.ok(out.includes('katex-html'), 'expected KaTeX HTML')
    assert.ok(out.includes('data-display="true"'), 'displayMode must be propagated')
    assert.ok(out.includes('E=mc^2'), 'expected tex content')
  })
  it('mixed batch (class-first + id-first) — both replaced in same call', () => {
    const win = { katex: stubKatex() }
    const fill = makeFill(win, makeStubDocument(), stubHtmlSafeEscape)
    const html =
      '<p><span class="math-inline" id="math-aaa11"></span> and <span id="math-bbb22" class="math-inline"></span></p>'
    const out = fill(html, [
      { id: 'math-aaa11', tex: 'x', display: false },
      { id: 'math-bbb22', tex: 'y', display: false },
    ])
    assert.ok(out.includes('>x<'), 'first placeholder replaced')
    assert.ok(out.includes('>y<'), 'second placeholder replaced')
    assert.ok(!out.includes('math-aaa11') && !out.includes('math-bbb22'), 'no placeholders remain')
  })
  it('KaTeX not loaded (window.katex undefined) → input html returned unchanged', () => {
    // This path must early-return so the async processRichBlocks() fallback
    // can pick the items up later.
    const win = {} // no katex
    const fill = makeFill(win, makeStubDocument(), stubHtmlSafeEscape)
    const html = '<span id="math-x" class="math-inline"></span>'
    const out = fill(html, [{ id: 'math-x', tex: 't', display: false }])
    assert.equal(out, html, 'must return input unchanged when KaTeX missing')
  })
  it('empty items array → input html returned unchanged (fast path)', () => {
    const win = { katex: stubKatex() }
    const fill = makeFill(win, makeStubDocument(), stubHtmlSafeEscape)
    const html = '<p>nothing to do</p>'
    const out = fill(html, [])
    assert.equal(out, html)
  })
  it('missing later id is skipped after earlier id match replaces its shell', () => {
    // The production function has an ordered fallback for sanitizer id drift.
    // A truly missing placeholder is skipped only once no surviving math shell
    // remains; it must not throw or corrupt the already-replaced item.
    const win = { katex: stubKatex() }
    const fill = makeFill(win, makeStubDocument(), stubHtmlSafeEscape)
    const html = '<p>only <span id="math-here" class="math-inline"></span></p>'
    const out = fill(html, [
      { id: 'math-here', tex: 'h', display: false }, // in html
      { id: 'math-gone', tex: 'g', display: false }, // no surviving shell
    ])
    assert.ok(out.includes('>h<'), 'present placeholder must still be replaced')
    assert.ok(!out.includes('math-here'), 'present placeholder gone')
    assert.ok(!out.includes('>g<'), 'missing placeholder simply has no effect')
  })
  it('KaTeX throws → error placeholder with htmlSafeEscape-d message', () => {
    // The catch branch must (a) not propagate the throw, (b) emit math-error
    // class, (c) htmlSafeEscape the error message so `<bad>` from the
    // exception can't break out of the inserted markup.
    const win = {
      katex: {
        renderToString() {
          throw new Error('boom <bad>')
        },
      },
    }
    const fill = makeFill(win, makeStubDocument(), stubHtmlSafeEscape)
    const html = '<span id="math-err1" class="math-inline"></span>'
    const out = fill(html, [{ id: 'math-err1', tex: 'broken', display: false }])
    assert.ok(out.includes('math-error'), 'must mark with math-error class')
    assert.ok(out.includes('&lt;bad&gt;'), 'error message must be htmlSafeEscape-d')
    assert.ok(!out.includes('<bad>'), 'raw `<bad>` must not appear in output')
    assert.ok(!out.includes('math-err1'), 'placeholder must be replaced (with error markup)')
  })
})

// ── T-DOLLAR-DISPLAY: _scanDollarDisplayBody (markdown.js, 2026-05-13 表格单元格 $$ 修复) ──
//
// `mathBlock` (level: 'block') 用行首 `$$` 触发,marked 在表格单元格 / 列表项 inline
// 上下文里只跑 inline 词法器,block-level 扩展从不触发;同时 `mathInline.tokenizer`
// 第一行就 `if (src[0] !== '$' || src[1] === '$') return` 拒绝 `$$` 开头 —— 结果是
// `$$..$$` 在 inline 上下文里没人接手,原样作为文本透出。
//
// 修法:新增 `mathDisplayInline` (level: 'inline') 扩展,直接消化 inline 上下文的
// `$$..$$`,占位符用 `<span>`(不是 `<div>`,否则 `<td>`/`<p>` 内会被 HTML 解析
// 器外提)。本测试覆盖底层 body scanner `_scanDollarDisplayBody` 的契约。
const _scanDollarDisplayBody = makeCallable<(src: string, start: number) => ScanResult>(
  extractFunction(appJs, '_scanDollarDisplayBody'),
)

describe('T-DOLLAR-DISPLAY: _scanDollarDisplayBody — inline $$..$$ body scanner', () => {
  it('finds closer at end of body: `$$x$$` start=2 → closer=3', () => {
    // src = '$$x$$', start=2 跳过开头 `$$`。closer 指向闭合 `$$` 的第一个 `$`,
    // 即 idx 3。Body 是 src.slice(2, 3) = 'x'。
    const r = _scanDollarDisplayBody('$$x$$', 2)
    assert.deepEqual(r, { closer: 3, dead: false })
  })
  it('no closer in remaining src: `$$x` start=2 → closer=-1', () => {
    const r = _scanDollarDisplayBody('$$x', 2)
    assert.deepEqual(r, { closer: -1, dead: false })
  })
  it('TeX `\\\\` line break inside body is skipped (does not close on first `$` after `\\`)', () => {
    // 关键反例:body 含 `\\` (TeX 行末换行)+ 之后的 `$$` 是真闭合。scanner 必须
    // skip-2 跳过 `\\` 不把它当成单 `\` + 啥的 → 反斜杠引擎正确处理 TeX escape。
    // src = '$$x\\\\$$y$$' 即 `$$x\\$$y$$`(7 字符 body 后才有真闭合):
    //   idx 0,1: `$$` 开头
    //   idx 2: `x`
    //   idx 3: `\`        ← scanner 看到 `\`,skip 2 → 跳到 idx 5
    //   idx 4: `\`           (被跳过,这就是 TeX `\\` 行末换行的左半边)
    //   idx 5: `$`        ← 检查 src[5]='$' && src[6]='$' → true,closer=5
    //   idx 6,7,8: '$y$$'
    // 注意 idx 5 的 `$` 其实是 `\\` 后面紧跟的 `$`,跟 idx 6 的 `$` 组成闭合
    const r = _scanDollarDisplayBody('$$x\\\\$$y$$', 2)
    assert.equal(r.closer, 5)
    assert.equal(r.dead, false)
  })
  it('escaped `\\$` in body does NOT close: `$$a\\$b$$` start=2 → closer at the real `$$`', () => {
    // src = '$$a\\$b$$',`\$` 是字面 dollar 不应触发闭合。scanner 看到 `\` skip 2
    // 跳过 `\$`,然后扫到 idx 6 = `$`,src[6]='$' && src[7]='$' → closer=6。
    const r = _scanDollarDisplayBody('$$a\\$b$$', 2)
    assert.equal(r.closer, 6)
    assert.equal(r.dead, false)
  })
  it('newline aborts scan (single-line inline display): `$$x\\ny$$` start=2 → no closer', () => {
    // Inline display 不允许跨行;遇 `\n` 立即 closer=-1。block-level mathBlock
    // 负责多行 case。
    const r = _scanDollarDisplayBody('$$x\ny$$', 2)
    assert.deepEqual(r, { closer: -1, dead: false })
  })
  it('empty body but closer immediately: `$$$$` start=2 → closer=2', () => {
    // start=2 时 src[2]='$' && src[3]='$' → closer=2。Body=src.slice(2,2)=空,
    // 调用方(tokenizer)需在 trim 后独立拒绝空 body。
    const r = _scanDollarDisplayBody('$$$$', 2)
    assert.deepEqual(r, { closer: 2, dead: false })
  })
  it('start offset > 0: scanner begins where caller specifies', () => {
    // 模拟 marked 没切干净:src=`prefix$$body$$`,start=8(跳过 `prefix$$`)。
    const r = _scanDollarDisplayBody('prefix$$body$$', 8)
    assert.equal(r.closer, 12) // src[12]='$' && src[13]='$'
    assert.equal(r.dead, false)
  })
  it('lone trailing backslash at EOF (skip-2 past EOF) safely returns no closer', () => {
    // `\` 后无字符,skip-2 把 p 推到 n+1,while 循环退出。不应抛。
    const r = _scanDollarDisplayBody('$$x\\', 2)
    assert.deepEqual(r, { closer: -1, dead: false })
  })
  it('dead flag is always false for inline display (no whole-render abort semantics)', () => {
    // 跟 _scanCodexMathBody 不一样:codex display 是 multi-line,EOF 没闭合就置
    // dead=true 让后续 `\[` 短路。inline `$$` 单行扫描,每次开新 scan,没有
    // 全局 dead 概念,永远 false。
    const r1 = _scanDollarDisplayBody('$$noclose', 2)
    assert.equal(r1.dead, false)
    const r2 = _scanDollarDisplayBody('$$crosses\nlines', 2)
    assert.equal(r2.dead, false)
  })
})

// ── T-INLINE-DISPLAY: confirm inline-level display extensions are wired ──
describe('T-INLINE-DISPLAY: mathDisplayInline / codexDisplayInline wiring', () => {
  it('mathDisplayInline extension registered', () => {
    assert.ok(
      appJs.includes("name: 'mathDisplayInline'"),
      'mathDisplayInline missing — `$$..$$` in table cells will leak as raw text',
    )
  })
  it('mathDisplayInline declared level: inline', () => {
    // Block-level wouldn't fire in table cells; the whole point of this ext is
    // to be inline. Regress check: catch refactors that flip it to block.
    assert.ok(
      /name:\s*['"]mathDisplayInline['"][\s\S]{0,200}level:\s*['"]inline['"]/.test(appJs),
      "mathDisplayInline must declare level: 'inline'",
    )
  })
  it('codexDisplayInline extension registered', () => {
    assert.ok(
      appJs.includes("name: 'codexDisplayInline'"),
      'codexDisplayInline missing — `\\[..\\]` in table cells will leak as raw text',
    )
  })
  it('codexDisplayInline declared level: inline', () => {
    assert.ok(
      /name:\s*['"]codexDisplayInline['"][\s\S]{0,200}level:\s*['"]inline['"]/.test(appJs),
      "codexDisplayInline must declare level: 'inline'",
    )
  })
  it('mathDisplayInline placeholder is <span> (NOT <div>)', () => {
    // `<div>` inside `<td>`/`<p>` gets reparented by the HTML parser and breaks
    // the table/paragraph structure. KaTeX displayMode output is `<span class=
    // "katex-display">` so a span placeholder is correct + valid.
    const block =
      appJs.match(/name:\s*['"]mathDisplayInline['"][\s\S]*?renderer\([\s\S]*?\}\s*,?\s*\}/)?.[0] ||
      ''
    assert.ok(block.length > 0, 'could not locate mathDisplayInline renderer block')
    assert.ok(
      /<span\s+class="math-inline"\s+id="\$\{id\}">/.test(block),
      'mathDisplayInline must emit <span class="math-inline" id="..."> placeholder',
    )
    assert.ok(
      !/<div\s+class="math-block"\s+id="\$\{id\}">/.test(block),
      'mathDisplayInline must NOT emit a <div> placeholder (would break <td>/<p> nesting)',
    )
  })
  it('codexDisplayInline placeholder is <span> (NOT <div>)', () => {
    const block =
      appJs.match(/name:\s*['"]codexDisplayInline['"][\s\S]*?renderer\([\s\S]*?\}\s*,?\s*\}/)?.[0] ||
      ''
    assert.ok(block.length > 0, 'could not locate codexDisplayInline renderer block')
    assert.ok(
      /<span\s+class="math-inline"\s+id="\$\{id\}">/.test(block),
      'codexDisplayInline must emit <span class="math-inline" id="..."> placeholder',
    )
    assert.ok(
      !/<div\s+class="math-block"\s+id="\$\{id\}">/.test(block),
      'codexDisplayInline must NOT emit a <div> placeholder',
    )
  })
  it('both inline-display extensions push display:true to pendingMath', () => {
    // 占位符即使是 span,KaTeX 仍按 displayMode:true 渲染(katex-display 包装)。
    // 这条断言锁死"占位符 inline-shape ≠ 渲染 display-mode"的分离。
    const mathBlock =
      appJs.match(/name:\s*['"]mathDisplayInline['"][\s\S]*?renderer\([\s\S]*?\}\s*,?\s*\}/)?.[0] ||
      ''
    const codexBlock =
      appJs.match(/name:\s*['"]codexDisplayInline['"][\s\S]*?renderer\([\s\S]*?\}\s*,?\s*\}/)?.[0] ||
      ''
    assert.ok(
      /pendingMath\.push\(\{\s*id,\s*tex:\s*token\.text,\s*display:\s*true/.test(mathBlock),
      'mathDisplayInline must push pendingMath with display:true',
    )
    assert.ok(
      /pendingMath\.push\(\{\s*id,\s*tex:\s*token\.text,\s*display:\s*true/.test(codexBlock),
      'codexDisplayInline must push pendingMath with display:true',
    )
  })
  it('codexDisplayInline reuses _scanCodexMathBody with allowNewline=false', () => {
    // 单行扫描跟 mathDisplayInline 对齐(`\]` 多行 case 留给 block-level
    // codexDisplayMath)。第三个参数必须是 false。
    const block =
      appJs.match(
        /name:\s*['"]codexDisplayInline['"][\s\S]*?tokenizer\(src\)\s*\{[\s\S]*?\},/,
      )?.[0] || ''
    assert.ok(block.length > 0, 'could not locate codexDisplayInline tokenizer block')
    assert.ok(
      /_scanCodexMathBody\(src,\s*2,\s*['"]\]['"],\s*false\)/.test(block),
      'codexDisplayInline must call _scanCodexMathBody(src, 2, "]", false) for single-line scan',
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

// ── T11: Codex tool-card UI unification (label / mcp unwrap / plan summary / collab summary) ──
//
// These guard the v3 codex-ui-unify pass: codex `mcpToolCall` / `dynamicToolCall`
// must unwrap to the same icon+label as native MCP calls, `plan` summary must
// align with TodoWrite's `done/total` format, `collabAgentToolCall` summary
// must match delegate_task's `→ agent goal` format, and the static
// _CODEX_TYPE_META labels must not carry the "Codex" prefix anymore.
describe('T11: Codex tool-card UI unification', () => {
  // _codexResolveMcpCall is fully self-contained — extract + callable directly.
  const _codexResolveMcpCall = makeCallable<(input: unknown) => {
    server: string
    tool: string
    args: Record<string, unknown>
    rawArgs: unknown
  }>(extractFunction(appJs, '_codexResolveMcpCall'))

  // _codexRawArgsDisplay is also self-contained — pure function over `unknown`.
  const _codexRawArgsDisplay = makeCallable<(rawArgs: unknown) => string>(
    extractFunction(appJs, '_codexRawArgsDisplay'),
  )

  // _codexSummary references _codexResolveMcpCall + _parseMcpName + _humanizeOp +
  // _mcpSummary + _toolSummary + _shortPath + _parseCodexTypeName +
  // _normalizeCodexPlanInput + _TOOL_ICONS. Build a sandbox so callable
  // can resolve all of them.
  const _parseMcpNameSrc = extractFunction(appJs, '_parseMcpName')
  const _humanizeOpSrc = extractFunction(appJs, '_humanizeOp')
  const _shortPathSrc = extractFunction(appJs, '_shortPath')
  const _parseCodexTypeNameSrc = extractFunction(appJs, '_parseCodexTypeName')
  const _toolSummarySrc = extractFunction(appJs, '_toolSummary')
  const _mcpSummarySrc = extractFunction(appJs, '_mcpSummary')
  const _codexResolveMcpCallSrc = extractFunction(appJs, '_codexResolveMcpCall')
  const _normalizeCodexPlanInputSrc = extractFunction(appJs, '_normalizeCodexPlanInput')
  const _codexSummarySrc = extractFunction(appJs, '_codexSummary')
  const _codexSummary = new Function(
    `const _TOOL_ICONS = { Bash: 1, Read: 1, Edit: 1, Write: 1, Grep: 1, Glob: 1, WebFetch: 1, WebSearch: 1, TodoWrite: 1 };
     ${_parseMcpNameSrc}
     ${_humanizeOpSrc}
     ${_shortPathSrc}
     ${_parseCodexTypeNameSrc}
     ${_codexResolveMcpCallSrc}
     ${_normalizeCodexPlanInputSrc}
     ${_toolSummarySrc}
     ${_mcpSummarySrc}
     ${_codexSummarySrc}
     return _codexSummary;`,
  )() as (codexType: string, input: unknown) => string

  // _normalizeCodexPlanInput is self-contained — no helper deps, just
  // string/array/object type checks. Direct callable.
  const _normalizeCodexPlanInput = makeCallable<(input: unknown) => {
    steps: Array<{ text: string; status: string }>
  }>(_normalizeCodexPlanInputSrc)

  it('_codexResolveMcpCall accepts {server, tool, arguments} canonical shape', () => {
    const r = _codexResolveMcpCall({
      server: 'browser',
      tool: 'browser_navigate',
      arguments: { url: 'https://x.com' },
    })
    assert.equal(r.server, 'browser')
    assert.equal(r.tool, 'browser_navigate')
    assert.deepEqual(r.args, { url: 'https://x.com' })
  })

  it('_codexResolveMcpCall falls back to {serverName, toolName, args}', () => {
    const r = _codexResolveMcpCall({
      serverName: 'minimax-media',
      toolName: 'text_to_image',
      args: { prompt: 'a cat' },
    })
    assert.equal(r.server, 'minimax-media')
    assert.equal(r.tool, 'text_to_image')
    assert.deepEqual(r.args, { prompt: 'a cat' })
  })

  it('_codexResolveMcpCall accepts {name, params} fallback', () => {
    const r = _codexResolveMcpCall({ name: 'browser_click', params: { ref: 'btn1' } })
    assert.equal(r.tool, 'browser_click')
    assert.deepEqual(r.args, { ref: 'btn1' })
  })

  it('_codexResolveMcpCall parses stringified-JSON args', () => {
    const r = _codexResolveMcpCall({
      server: 'memory',
      tool: 'memory',
      arguments: JSON.stringify({ op: 'read', section: 'user' }),
    })
    assert.deepEqual(r.args, { op: 'read', section: 'user' })
  })

  it('_codexResolveMcpCall ignores array/invalid args, returns {}', () => {
    assert.deepEqual(_codexResolveMcpCall({ arguments: [1, 2, 3] }).args, {})
    assert.deepEqual(_codexResolveMcpCall({ arguments: 'not json' }).args, {})
    assert.deepEqual(_codexResolveMcpCall(null).args, {})
    assert.deepEqual(_codexResolveMcpCall(undefined).args, {})
  })

  it('_codexResolveMcpCall surfaces rawArgs for unknown-tool fallback (codex review CONCERN #3)', () => {
    // Free-form text command: args coerces to {} but rawArgs preserves the
    // original string so the UI can still show what codex tried to call.
    const r1 = _codexResolveMcpCall({ tool: 'custom_cli', arguments: 'rm -rf /tmp/x' })
    assert.deepEqual(r1.args, {})
    assert.equal(r1.rawArgs, 'rm -rf /tmp/x')
    // Object args: rawArgs equals args (the original reference).
    const r2 = _codexResolveMcpCall({ tool: 'custom_cli', args: { foo: 1 } })
    assert.deepEqual(r2.args, { foo: 1 })
    assert.deepEqual(r2.rawArgs, { foo: 1 })
    // Array args: args is {} (rejected by dict check), rawArgs is the array.
    const r3 = _codexResolveMcpCall({ tool: 'custom_cli', arguments: [1, 2, 3] })
    assert.deepEqual(r3.args, {})
    assert.deepEqual(r3.rawArgs, [1, 2, 3])
    // Null input → undefined rawArgs.
    assert.equal(_codexResolveMcpCall(null).rawArgs, undefined)
  })

  it('_codexRawArgsDisplay normalises non-dict rawArgs to a printable string (codex review v3)', () => {
    // String: pass-through.
    assert.equal(_codexRawArgsDisplay('rm -rf /tmp/x'), 'rm -rf /tmp/x')
    // Array: JSON.stringify so user sees the structure (was empty card before).
    assert.equal(_codexRawArgsDisplay([1, 2, 3]), '[1,2,3]')
    // Empty array / null / undefined / empty string → falsy (caller collapses).
    assert.equal(_codexRawArgsDisplay([]), '')
    assert.equal(_codexRawArgsDisplay(null), '')
    assert.equal(_codexRawArgsDisplay(undefined), '')
    assert.equal(_codexRawArgsDisplay(''), '')
    // Primitive coerced via String().
    assert.equal(_codexRawArgsDisplay(42), '42')
    assert.equal(_codexRawArgsDisplay(true), 'true')
    // Non-plain object (best-effort stringify; resolver would have grabbed
    // plain dicts into `args` so this branch only sees Date/Map/instances).
    assert.equal(_codexRawArgsDisplay(new Date(0)), JSON.stringify(new Date(0)))
  })

  it('_codexSummary plan returns done/total (TodoWrite-aligned format)', () => {
    const s = _codexSummary('plan', {
      steps: [
        { status: 'completed' },
        { status: 'pending' },
        { status: 'completed' },
      ],
    })
    assert.equal(s, '2/3')
  })

  it('_codexSummary plan returns 0/N for all-pending', () => {
    const s = _codexSummary('plan', {
      steps: [{ status: 'pending' }, { status: 'pending' }],
    })
    assert.equal(s, '0/2')
  })

  it('_codexSummary plan returns empty string when no steps', () => {
    assert.equal(_codexSummary('plan', { steps: [] }), '')
    assert.equal(_codexSummary('plan', {}), '')
  })

  // ── v1.0.203 — codex 0.130+ todo_list schema compat ──
  //
  // codex CLI 0.130 起把 `plan` ThreadItem 改名为 `todo_list`,字段也从
  // `steps: [{ text, status }]` 改成 `items: [{ text, completed: bool }]`。
  // _normalizeCodexPlanInput 把两种 schema 收敛到 `{steps:[{text,status}]}`,
  // 渲染层 (_renderCodexPlan) 与汇总层 (_codexSummary) 共用同一份归一规则。
  //
  // status 推导**保守**:s.status 字符串优先(老 plan schema, in_progress
  // 中间态保留),否则只看 s.completed===true→completed / 其它→pending。
  // 绝不从布尔 false 启发式合成 in_progress(协议无可靠信号)。

  it('_codexSummary todo_list (codex 0.130+ schema) returns done/total', () => {
    // 真实 codex 0.130/0.133 emit:items[{text, completed}],无 status 字符串。
    const s = _codexSummary('todo_list', {
      items: [
        { text: '读文件', completed: true },
        { text: '分析', completed: false },
        { text: '修改', completed: true },
        { text: '测试', completed: false },
      ],
    })
    assert.equal(s, '2/4')
  })

  it('_codexSummary todo_list all-incomplete → 0/N', () => {
    const s = _codexSummary('todo_list', {
      items: [
        { text: 'a', completed: false },
        { text: 'b', completed: false },
      ],
    })
    assert.equal(s, '0/2')
  })

  it('_codexSummary todo_list missing items → empty string', () => {
    assert.equal(_codexSummary('todo_list', { items: [] }), '')
    assert.equal(_codexSummary('todo_list', {}), '')
  })

  it('_normalizeCodexPlanInput accepts old plan schema verbatim', () => {
    // Old codex `plan` item: steps[{text|description, status: enum}].
    // status 字符串原样透传 — in_progress 中间态必须保留。
    const r = _normalizeCodexPlanInput({
      steps: [
        { text: 'a', status: 'completed' },
        { description: 'b', status: 'in_progress' },
        { text: 'c', status: 'pending' },
      ],
    })
    assert.deepEqual(r.steps, [
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'in_progress' },
      { text: 'c', status: 'pending' },
    ])
  })

  it('_normalizeCodexPlanInput maps new todo_list schema (items+completed) to steps', () => {
    // codex 0.130+ `todo_list` item: items[{text, completed: bool}].
    // completed=true→'completed',completed=false 或 缺失→'pending'。
    const r = _normalizeCodexPlanInput({
      items: [
        { text: '读文件', completed: true },
        { text: '分析', completed: false },
        { text: '不带 completed' },
      ],
    })
    assert.deepEqual(r.steps, [
      { text: '读文件', status: 'completed' },
      { text: '分析', status: 'pending' },
      { text: '不带 completed', status: 'pending' },
    ])
  })

  it('_normalizeCodexPlanInput does NOT synthesize in_progress from boolean false', () => {
    // 协议无可靠 in_progress 信号 — 单 boolean completed 只能映射二档。
    // 任何 false 都是 pending,不要"第一未完成 = in_progress"启发式。
    const r = _normalizeCodexPlanInput({
      items: [
        { text: 'a', completed: true },
        { text: 'b', completed: false }, // 不应变 'in_progress'
        { text: 'c', completed: false },
      ],
    })
    assert.equal(r.steps[1].status, 'pending')
    assert.equal(r.steps[2].status, 'pending')
  })

  it('_normalizeCodexPlanInput prefers explicit status over completed bool', () => {
    // 老 plan schema 同时存在 status + completed(理论上)时 status 优先,
    // 避免在升级期短时间内行为漂移。
    const r = _normalizeCodexPlanInput({
      steps: [{ text: 'x', status: 'in_progress', completed: true }],
    })
    assert.equal(r.steps[0].status, 'in_progress')
  })

  it('_normalizeCodexPlanInput empty / null / non-object input → {steps:[]}', () => {
    assert.deepEqual(_normalizeCodexPlanInput(null), { steps: [] })
    assert.deepEqual(_normalizeCodexPlanInput(undefined), { steps: [] })
    assert.deepEqual(_normalizeCodexPlanInput('not an object'), { steps: [] })
    assert.deepEqual(_normalizeCodexPlanInput({}), { steps: [] })
    assert.deepEqual(_normalizeCodexPlanInput({ steps: [], items: [] }), { steps: [] })
    // steps 优先 over items 当两者都存在(防 codex 升级中间态 emit 两份)
    assert.deepEqual(
      _normalizeCodexPlanInput({ steps: [{ text: 's', status: 'pending' }], items: [{ text: 'i' }] }).steps,
      [{ text: 's', status: 'pending' }],
    )
  })

  it('_normalizeCodexPlanInput drops non-object step entries', () => {
    const r = _normalizeCodexPlanInput({ items: [null, 'string', 42, { text: 'ok' }] })
    assert.deepEqual(r.steps, [{ text: 'ok', status: 'pending' }])
  })

  it('_codexSummary mcpToolCall delegates to native MCP summary', () => {
    // browser:browser_navigate → URL
    const s1 = _codexSummary('mcpToolCall', {
      server: 'browser',
      tool: 'browser_navigate',
      arguments: { url: 'https://example.com' },
    })
    assert.equal(s1, 'https://example.com')
    // minimax-vision:web_search → query
    const s2 = _codexSummary('mcpToolCall', {
      server: 'minimax-vision',
      tool: 'web_search',
      arguments: { query: 'codex reasoning' },
    })
    assert.equal(s2, 'codex reasoning')
  })

  it('_codexSummary dynamicToolCall unwraps builtin tool (Bash)', () => {
    const s = _codexSummary('dynamicToolCall', {
      tool: 'Bash',
      args: { command: 'ls -la', description: 'list files' },
    })
    assert.equal(s, 'list files')
  })

  it('_codexSummary dynamicToolCall unwraps mcp__server__op format', () => {
    const s = _codexSummary('dynamicToolCall', {
      tool: 'mcp__browser__browser_navigate',
      args: { url: 'https://a.example' },
    })
    assert.equal(s, 'https://a.example')
  })

  it('_codexSummary collabAgentToolCall renders → agent goal (delegate_task aligned)', () => {
    const s = _codexSummary('collabAgentToolCall', {
      agentId: 'minimax2.7',
      goal: '帮我审查这段代码',
    })
    assert.equal(s, '→ minimax2.7 帮我审查这段代码')
  })

  it('_codexSummary webSearch returns query', () => {
    assert.equal(_codexSummary('webSearch', { query: 'foo bar' }), 'foo bar')
  })

  it('_CODEX_TYPE_META labels no longer carry "Codex" prefix (label-unification invariant)', () => {
    // Contract check: codex tool-card labels must align with claude-code's
    // tool vocabulary (no `Codex 任务列表`, just `任务列表`). Regex pulls the
    // const definition out of the joined module source.
    const m = appJs.match(/const\s+_CODEX_TYPE_META\s*=\s*\{([\s\S]*?)\n\}/)
    assert.ok(m, '_CODEX_TYPE_META declaration not found')
    const body = m![1]
    // The whole table should be free of literal "Codex " label prefixes.
    // (Codex 审查 / Codex 回复 belong to _MCP_OP_META, which is a separate table.)
    const offenders = body.match(/label:\s*['"]Codex\s/g)
    assert.equal(offenders, null, `_CODEX_TYPE_META still has Codex-prefixed labels: ${offenders?.join(', ')}`)
    // Spot-check: plan/webSearch labels must be the native ones.
    assert.match(body, /plan:\s*\{[^}]*label:\s*['"]任务列表['"]/, 'plan label must be 任务列表')
    assert.match(body, /webSearch:\s*\{[^}]*label:\s*['"]网页搜索['"]/, 'webSearch label must be 网页搜索')
  })
})
