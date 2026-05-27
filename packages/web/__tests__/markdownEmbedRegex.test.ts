/**
 * Regression test for markdown.js path-detection regexes that drive
 * `_renderLocalMedia` doc-card rendering.
 *
 * 历史 bug: `_PUB_PREFIX` 用非贪婪 `+?\.[A-Za-z0-9]{1,10}`,匹配多 dot 文件名时
 * 停在第一个扩展名(`research_v7.2_20260515.tar.gz` 被截到 `research_v7.2`),
 * doc-card href 指向不存在的路径,容器 404,用户看起来"点了没反应"。
 *
 * 修复: 改贪婪 `+`,依赖 `\.\w{1,10}` 的回溯让最右扩展名收尾。
 *
 * 测试策略: 静态读取 markdown.js,正则提取出 `_PUB_PREFIX` 和 step 1 媒体路径
 * 正则的字符串字面量,在 node 环境单独构造 RegExp 跑断言。避免引入 jsdom /
 * happy-dom 之类的 DOM polyfill 依赖。
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const MARKDOWN_JS = resolve(import.meta.dirname, '..', 'public', 'modules', 'markdown.js')
const source = readFileSync(MARKDOWN_JS, 'utf-8')

// ── 提取 _PUB_PREFIX 字符串字面量 ──
// 源码是 JS 字符串字面量 `'...'`,readFileSync 拿到的是字面量未 eval 的 raw 文本
// (`\\` 还是两个字符)。这里手动做最小 unescape:`\\` → `\`,`\'` → `'`。
function extractPubPrefix(): string {
  const m = source.match(/const\s+_PUB_PREFIX\s*=\s*'((?:[^'\\]|\\.)*)'/)
  if (!m) throw new Error('_PUB_PREFIX literal not found in markdown.js')
  return m[1].replace(/\\(.)/g, '$1')
}

// ── 提取 step 1 媒体路径正则模板里关键片段 ──
// 模板字符串包了一堆 escape; 我们只需要验证 `+?` 没出现在 `_MEDIA_EXTS` 路径分支
function extractMediaBarePathPattern(): string {
  // 锁定 step 1 那条 RegExp: `((?:^|[\\s>])((?:(?:/|[A-Za-z]:[\\\\\\\\])[^\\s<"\'\`>]+\\.(?:${_MEDIA_EXTS}))))`
  const m = source.match(
    /new RegExp\(\s*`\(\(\?:\^\|\[\\\\s>\]\)\(\(\?:\(\?:\/\|\[A-Za-z\]:\[\\\\\\\\\\\\\\\\\]\)\[\^\\\\s<"\\'\\`>\]([+?]+)\\\\\.\(\?:\$\{_MEDIA_EXTS\}\)\)\)\)`/,
  )
  if (!m) throw new Error('step 1 media bare-path regex template not found in markdown.js')
  return m[1]
}

function extractMediaExts(): string {
  const m = source.match(/const\s+_MEDIA_EXTS\s*=\s*\n\s*'([^']+)'/)
  if (!m) throw new Error('_MEDIA_EXTS literal not found in markdown.js')
  return m[1]
}

function makeStep1BarePathRe(): RegExp {
  const mediaExts = extractMediaExts()
  return new RegExp(
    '((?:^|[\\s>])((?:(?:/|[A-Za-z]:[\\\\\\\\])[^\\s<"\\\'`>]+\\.(?:' +
      mediaExts +
      '))))',
    'gi',
  )
}

describe('markdown.js _PUB_PREFIX — multi-dot filename regression', () => {
  const pubPrefix = extractPubPrefix()
  const re = new RegExp(pubPrefix, 'g')

  it('vanity check: `_PUB_PREFIX` 必须用贪婪 `+`,不能回 `+?`', () => {
    // 防止有人误把贪婪改回非贪婪触发回归
    assert.ok(
      !pubPrefix.includes('+?\\.[A-Za-z0-9]'),
      `_PUB_PREFIX 不能含 +?,当前: ${pubPrefix}`,
    )
  })

  it('完整匹配 .tar.gz 文件名(主要回归 case)', () => {
    const p = '/home/agent/.openclaude/research/research_v7.2_20260515.tar.gz'
    assert.deepEqual(p.match(re), [p])
  })

  it('完整匹配 /root 路径下的 .tar.gz', () => {
    const p = '/root/.openclaude/foo/report.tar.gz'
    assert.deepEqual(p.match(re), [p])
  })

  it('完整匹配 .v2.txt 多 dot', () => {
    const p = '/home/agent/.openclaude/x/notes.v2.txt'
    assert.deepEqual(p.match(re), [p])
  })

  it('完整匹配 .json.bak 多 dot', () => {
    const p = '/home/agent/.openclaude/foo/data.json.bak'
    assert.deepEqual(p.match(re), [p])
  })

  it('单 dot 文件名不回归', () => {
    const p = '/home/agent/.openclaude/dir/main.pdf'
    assert.deepEqual(p.match(re), [p])
  })

  it('末尾右括号正确停止(贪婪回溯)', () => {
    const text = '/home/agent/.openclaude/x/report.tar.gz)'
    assert.deepEqual(text.match(re), ['/home/agent/.openclaude/x/report.tar.gz'])
  })

  it('末尾中文标点正确停止', () => {
    const text = '/home/agent/.openclaude/x/report.tar.gz。'
    assert.deepEqual(text.match(re), ['/home/agent/.openclaude/x/report.tar.gz'])
  })

  it('白名单外路径不匹配', () => {
    assert.equal('/etc/passwd'.match(re), null)
    assert.equal('/opt/somefile.txt'.match(re), null)
  })
})

describe('markdown.js step 1 媒体路径正则 — 贪婪一致性', () => {
  it('vanity check: step 1 媒体路径正则不能用 `+?`', () => {
    const op = extractMediaBarePathPattern()
    assert.equal(op, '+', `step 1 media bare-path 量词应为 '+',实际: ${op}`)
  })

  it('完整匹配 docx/xlsx/pptx,不截成 doc/xls/ppt', () => {
    const re = makeStep1BarePathRe()
    const paths = [
      '/home/agent/.openclaude/generated/增益保持率公式说明_小节内容.docx',
      '/home/agent/.openclaude/generated/table.xlsx',
      '/home/agent/.openclaude/generated/slides.pptx',
    ]
    for (const p of paths) {
      re.lastIndex = 0
      const m = re.exec(p)
      assert.equal(m?.[2], p)
    }
  })

  it('完整匹配 .tar.gz,不截成 .tar', () => {
    const re = makeStep1BarePathRe()
    const p = '/home/agent/.openclaude/generated/research_v7.2_20260515.tar.gz'
    const m = re.exec(p)
    assert.equal(m?.[2], p)
  })
})
