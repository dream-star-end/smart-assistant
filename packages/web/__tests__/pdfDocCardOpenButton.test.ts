/**
 * Regression test for PDF doc-card "open in new tab" fallback button.
 *
 * 背景: 华为/Quark/UC 等国产浏览器对 `<a download>` 触发的隐式下载弹"此网站不支持
 * 下载",d1193355375@gmail.com 因此报障 (2026-05-22)。修复给 PDF doc-card 加 sibling
 * `<button class="doc-card-open">`,点击走"用户主动顶层导航"接收 signed URL,
 * 绕开 `<a download>` 触发的浏览器拦截策略。
 *
 * **不承诺** PDF viewer 内联预览:服务端响应仍是 `Content-Disposition: attachment`,
 * 我们只是改了客户端的导航触发方式,落盘体验在每个浏览器仍是各自的下载策略。
 *
 * 这个测试锁住两个 invariant,防回归把 fallback 路径意外拆掉:
 *
 *   1. markdown.js `_renderLocalMedia` 对 PDF 路径必须输出 `<span class="doc-card-wrap">`
 *      wrapper + `<button class="doc-card-open">` sibling,且 button 带正确的
 *      `data-sign-target="open-href"` + `data-pending-sign-path` + aria-label。
 *      非 PDF doc-card(如 .tar.gz、.zip)不能被波及,继续走纯 `<a class="doc-card">`。
 *
 *   2. main.js `_applySignedUrl` 的 switch 显式包含 `case 'open-href'`,写入
 *      `el.dataset.openHref`。回归到 `el.src = url` 默认分支 = button 拿不到签名,
 *      未签名时点击会同步预开 about:blank 但拿到的 URL 永远是 null。
 *
 * 测试策略: 静态读源 + 正则断言,跟同目录 markdownEmbedRegex.test.ts 一致。
 * 不引 jsdom/happy-dom —— dom.js 顶层用 document 在 node 直接 fail,代价不值。
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const PUBLIC = resolve(import.meta.dirname, '..', 'public')
const MARKDOWN_JS = readFileSync(resolve(PUBLIC, 'modules', 'markdown.js'), 'utf-8')
const MAIN_JS = readFileSync(resolve(PUBLIC, 'modules', 'main.js'), 'utf-8')

describe('markdown.js PDF doc-card — open-in-new-tab fallback button', () => {
  it('PDF 分支输出 .doc-card-wrap + .doc-card + .doc-card-open 三件套', () => {
    // 锁定 `if (_PDF_EXTS.test(filePath)) { ... return `<span class="doc-card-wrap">...`}` 块
    const m = MARKDOWN_JS.match(
      /if\s*\(\s*_PDF_EXTS\.test\(filePath\)\s*\)\s*\{[\s\S]*?return\s+`([^`]*)`/,
    )
    assert.ok(m, 'PDF return template 未找到 —— 渲染入口被改名/重构')
    const tpl = m[1]
    assert.ok(tpl.includes('class="doc-card-wrap"'), 'PDF 分支必须有 .doc-card-wrap span')
    assert.ok(tpl.includes('class="doc-card"'), 'PDF 分支必须保留主 .doc-card anchor')
    assert.ok(
      tpl.includes('class="doc-card-open"'),
      'PDF 分支必须含 sibling .doc-card-open button',
    )
  })

  it('open button 带 data-sign-target="open-href" + data-pending-sign-path', () => {
    const m = MARKDOWN_JS.match(
      /if\s*\(\s*_PDF_EXTS\.test\(filePath\)\s*\)\s*\{[\s\S]*?return\s+`([^`]*)`/,
    )
    assert.ok(m)
    const tpl = m[1]
    // open button 的 sign-target 必须是 'open-href'(不是 href / src):
    // resolver 会按这个 dispatch 写 el.dataset.openHref。回到默认 'src' 分支 →
    // resolver 会把 url 写到 button.src(button 没 src 属性,等于丢失)。
    assert.ok(
      /<button[^>]*class="doc-card-open"[^>]*data-sign-target="open-href"/.test(tpl) ||
        /<button[^>]*data-sign-target="open-href"[^>]*class="doc-card-open"/.test(tpl),
      'doc-card-open 必须带 data-sign-target="open-href"',
    )
    assert.ok(
      /<button[^>]*class="doc-card-open"[^>]*data-pending-sign-path=/.test(tpl) ||
        /<button[^>]*data-pending-sign-path=[^>]*class="doc-card-open"/.test(tpl),
      'doc-card-open 必须带 data-pending-sign-path 让 resolver 扫到',
    )
  })

  it('open button 有 type="button" + aria-label + title(a11y / UX 基线)', () => {
    const m = MARKDOWN_JS.match(
      /if\s*\(\s*_PDF_EXTS\.test\(filePath\)\s*\)\s*\{[\s\S]*?return\s+`([^`]*)`/,
    )
    assert.ok(m)
    const tpl = m[1]
    assert.ok(
      /<button[^>]*type="button"/.test(tpl),
      'open button 必须 type="button" 防误判 submit',
    )
    assert.ok(/aria-label="在新标签页打开/.test(tpl), 'open button 必须有 aria-label')
    assert.ok(/title="在新标签页打开"/.test(tpl), 'open button 必须有 title tooltip')
  })

  it('非 PDF doc-card(generic 分支)不受改动波及,保留纯 anchor 形态', () => {
    // 锁定 fallback generic doc-card 渲染(`if` block 后的 return)
    // 这里只检查 generic return template 不含 .doc-card-wrap / .doc-card-open
    // 防止回归把 wrapper 推广到 zip/tar 等下载体验本就该是 attachment 的文件
    const idx = MARKDOWN_JS.indexOf('_PDF_EXTS.test(filePath)')
    assert.ok(idx > 0, 'PDF 分支位置变了,测试需要随之更新')
    // 在 PDF 块之后取下一段 return 模板(generic doc-card)
    const tail = MARKDOWN_JS.slice(idx)
    const m = tail.match(/\}\s*\n\s*const\s+hrefAttr\s*=[\s\S]*?return\s+`([^`]*)`/)
    assert.ok(m, 'generic doc-card return 模板未找到')
    const generic = m[1]
    assert.ok(
      !generic.includes('doc-card-wrap'),
      'generic doc-card 不应被推广到 wrapper —— 范围扩张',
    )
    assert.ok(
      !generic.includes('doc-card-open'),
      'generic doc-card 不应带 open button —— 范围扩张',
    )
    assert.ok(generic.includes('class="doc-card"'), 'generic 分支必须保留 .doc-card anchor')
  })
})

describe('main.js _applySignedUrl — open-href dispatch', () => {
  it('switch 显式包含 case "open-href" 写入 dataset.openHref', () => {
    // 锁定 _applySignedUrl 函数体内 'open-href' 分支
    // 防止有人后来改回 `el[el.dataset.signTarget === 'href' ? 'href' : 'src'] = url`
    // 这种字符串猜测模式 —— button 没有 src 属性,等于丢签名
    const fn = MAIN_JS.match(/function\s+_applySignedUrl\s*\([\s\S]*?\n\}/)
    assert.ok(fn, '_applySignedUrl 函数未找到')
    const body = fn[0]
    assert.ok(/case\s+['"]open-href['"]/.test(body), 'switch 必须显式 case "open-href"')
    assert.ok(/el\.dataset\.openHref\s*=\s*url/.test(body), '"open-href" 分支必须写 dataset.openHref')
    assert.ok(/case\s+['"]href['"]/.test(body), '兼容保留 case "href" → el.href = url')
    assert.ok(
      /default:\s*\n\s*el\.src\s*=\s*url/.test(body),
      'default 分支必须保留 el.src = url 给 img/audio/video',
    )
  })

  it('doc-card-open click handler 已注册(防整段被误删)', () => {
    assert.ok(
      MAIN_JS.includes(".doc-card-open"),
      'main.js 必须有 .doc-card-open click handler —— 整段被删 = 兜底失效',
    )
    // 关键:必须**同步**预开 about:blank,await 之后再 open 会丢 user activation
    // 被 popup blocker 拦。锁这个模式防被人重构成 await 之后再 open。
    const handler = MAIN_JS.match(/\.doc-card-open[\s\S]{0,2500}?\}\s*\)/)
    assert.ok(handler, 'doc-card-open click handler 体未找到')
    const body = handler[0]
    assert.ok(
      body.includes(`window.open('about:blank'`),
      "未签名分支必须同步预开 about:blank 占住 user activation",
    )
    // **不能**给 about:blank 那次 open 带 noopener/noreferrer:HTML 标准 noreferrer
    // 隐含 noopener,window.open 会返回 null,拿不到 popup.location.replace 句柄
    assert.ok(
      !/window\.open\('about:blank',\s*'_blank',\s*['"]noopener/.test(body),
      "about:blank 预开**禁止**带 noopener/noreferrer(返回 null 拿不到句柄)",
    )
  })
})
