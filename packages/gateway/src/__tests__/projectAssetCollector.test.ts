/**
 * 产出物路径扫描:只收 generated 绝对路径,拒绝 .. 与越界。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/projectAssetCollector.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { extractGeneratedOutputPaths, resolveUploadExcerptPath } = await import('../projectAssetCollector.js')

describe('extractGeneratedOutputPaths', () => {
  it('从助手正文抽出 generated 路径,最多 5 条且去重', () => {
    const text = [
      '完成了',
      '/home/agent/.openclaude/generated/a.pdf',
      '以及 `/home/agent/.openclaude/generated/b.docx`',
      '/home/agent/.openclaude/generated/a.pdf',
      '/home/agent/.openclaude/generated/c.png',
      '/home/agent/.openclaude/generated/d.txt',
      '/home/agent/.openclaude/generated/e.csv',
      '/home/agent/.openclaude/generated/f.json',
    ].join('\n')
    assert.deepEqual(extractGeneratedOutputPaths(text), [
      '/home/agent/.openclaude/generated/a.pdf',
      '/home/agent/.openclaude/generated/b.docx',
      '/home/agent/.openclaude/generated/c.png',
      '/home/agent/.openclaude/generated/d.txt',
      '/home/agent/.openclaude/generated/e.csv',
    ])
  })

  it('拒绝 .. 与非 generated 路径', () => {
    const text = [
      '/home/agent/.openclaude/generated/../uploads/x.pdf',
      '/home/agent/.openclaude/uploads/ab.pdf',
      '/root/.openclaude/generated/x.pdf',
      '/etc/passwd',
      '/home/agent/.openclaude/generated/ok.pdf.',
    ].join('\n')
    assert.deepEqual(extractGeneratedOutputPaths(text), [
      '/home/agent/.openclaude/generated/ok.pdf',
    ])
  })
})

describe('resolveUploadExcerptPath', () => {
  it('url 映射到 uploads 内容寻址路径', () => {
    const digest = 'a'.repeat(64)
    assert.equal(
      resolveUploadExcerptPath(`/api/media/${digest}.pdf`, null),
      `/home/agent/.openclaude/uploads/${digest}.pdf`,
    )
    assert.equal(resolveUploadExcerptPath('/api/media/nope.pdf', null), null)
  })
})
