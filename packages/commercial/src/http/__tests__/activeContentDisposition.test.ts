/**
 * active-content Content-Disposition 契约(批D D5)。
 *
 * "活跃内容"(html/svg/xml/js —— 浏览器 inline 渲染时可执行脚本)必须在**每一条**下载/
 * 文件服务链路都被判为 attachment,绝不 inline,否则是存储型 XSS 面。此前该判定在三处并行
 * 定义(gateway server.ts 的 ACTIVE_CONTENT_TYPES + shouldServeInline、commercial
 * containerFileProxy.ts 的 ACTIVE_TYPES + isSafeInlineType 内 svg 特判),任一处漏改即漂移。
 *
 * 本测试在提取单一权威(@openclaude/protocol 的 ACTIVE_CONTENT_TYPES/isActiveContentType/
 * shouldServeInline)之后,断言两侧对**同一 MIME 列表**的 Content-Disposition 判定:
 *   - 对活跃内容:两侧逐字相等(都 attachment);
 *   - 对非活跃类型:锁定各自既有行为(PDF 两侧有意不同),防未来"重构"悄悄改判定。
 *
 * 跑法:npx tsx --test packages/commercial/src/http/__tests__/activeContentDisposition.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_CONTENT_TYPES,
  isActiveContentType,
  shouldServeInline,
} from '@openclaude/protocol'
import { isSafeInlineType } from '../containerFileProxy.js'

type Disposition = 'inline' | 'attachment'

/** gateway 静态/文件服务侧的 Content-Disposition 判定(server.ts 用 shouldServeInline)。 */
function gatewayDisposition(mime: string): Disposition {
  return shouldServeInline(mime) ? 'inline' : 'attachment'
}

/**
 * commercial 容器文件代理侧的判定,逐字镜像 containerFileProxy.ts 的落地逻辑:
 *   `isSafeInlineType(typeBase) && !ACTIVE_CONTENT_TYPES.has(typeBase) ? 'inline' : 'attachment'`
 * (typeBase = 剥 charset 后的小写基类型)。
 */
function commercialDisposition(mime: string): Disposition {
  const base = mime.split(';')[0].trim().toLowerCase()
  return isSafeInlineType(base) && !ACTIVE_CONTENT_TYPES.has(base) ? 'inline' : 'attachment'
}

test('活跃内容:两侧 Content-Disposition 判定逐字相等且均为 attachment', () => {
  assert.ok(ACTIVE_CONTENT_TYPES.size >= 7, '活跃内容集合数量异常(单一权威解析失败?)')
  for (const mime of ACTIVE_CONTENT_TYPES) {
    assert.equal(isActiveContentType(mime), true, `${mime} 应判为活跃内容`)
    const g = gatewayDisposition(mime)
    const c = commercialDisposition(mime)
    assert.equal(g, 'attachment', `gateway 侧 ${mime} 必须 attachment`)
    assert.equal(c, 'attachment', `commercial 侧 ${mime} 必须 attachment`)
    assert.equal(g, c, `两侧对 ${mime} 判定必须逐字相等`)
  }
})

test('活跃内容带 charset 后缀仍被两侧判为 attachment(剥 charset 同源)', () => {
  for (const base of ACTIVE_CONTENT_TYPES) {
    const withCharset = `${base}; charset=utf-8`
    assert.equal(isActiveContentType(withCharset), true, `${withCharset} 应判为活跃内容`)
    assert.equal(gatewayDisposition(withCharset), 'attachment', withCharset)
    assert.equal(commercialDisposition(withCharset), 'attachment', withCharset)
  }
})

test('常规内联媒体:两侧一致 inline', () => {
  for (const mime of ['image/png', 'image/jpeg', 'audio/mpeg', 'video/mp4']) {
    assert.equal(isActiveContentType(mime), false, `${mime} 不应判为活跃内容`)
    assert.equal(gatewayDisposition(mime), 'inline', mime)
    assert.equal(commercialDisposition(mime), 'inline', mime)
  }
})

test('PDF:两侧行为有意不同,锁定既有语义防"重构"悄悄改判定', () => {
  // gateway 侧不 inline PDF(shouldServeInline 只放 image/audio/video);容器代理侧 inline
  // PDF(isSafeInlineType 显式放 application/pdf)。这是各自链路的既有设计,不是活跃内容
  // 契约的范畴 —— 但显式钉住,任何一侧改动都会红。
  assert.equal(gatewayDisposition('application/pdf'), 'attachment')
  assert.equal(commercialDisposition('application/pdf'), 'inline')
  assert.equal(isActiveContentType('application/pdf'), false)
})

test('未知/八位字节流:两侧一致 attachment', () => {
  for (const mime of ['application/octet-stream', 'application/zip', 'text/plain']) {
    assert.equal(gatewayDisposition(mime), 'attachment', mime)
    assert.equal(commercialDisposition(mime), 'attachment', mime)
  }
})
