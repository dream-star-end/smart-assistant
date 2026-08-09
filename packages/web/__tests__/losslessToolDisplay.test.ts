import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const source = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'messages.js'),
  'utf8',
)

describe('lossless tool display', () => {
  it('renders complete stored command, file, search, and generic outputs', () => {
    assert.match(source, /cmdText = typeof input\.command === 'string' \? input\.command : ''/)
    assert.doesNotMatch(source, /msg\.output\.slice\(0, 2000\)/)
    assert.doesNotMatch(source, /input\.content\.slice\(0, 500\)/)
    assert.match(source, /pre\.textContent = text/)
  })

  it('uses friendly codex item cards and keeps raw results behind an exact disclosure', () => {
    assert.match(source, /webSearch: \{ icon: _ICON_GLOBE, label: '网页搜索' \}/)
    assert.match(source, /summary\.textContent = `完整工具结果/)
    assert.match(source, /pre\.textContent = text/)
  })

  it('materializes large exact payloads lazily without discarding bytes', () => {
    assert.match(source, /const _INLINE_TOOL_BYTES = 64 \* 1024/)
    assert.match(source, /if \(details\.open\) pre\.textContent = value/)
    assert.match(source, /_appendLazyDisclosure\(body, '完整工具内容', value/)
  })

  it('requires an explicit click to expand the in-memory DOM window', () => {
    assert.match(source, /显示更早的已加载/)
    assert.doesNotMatch(source, /new IntersectionObserver/)
  })
})
