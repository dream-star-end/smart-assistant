import { describe, expect, it } from 'vitest'
import {
  BLOG_IMAGE_MAX_BYTES,
  BlogImageError,
  applyToolbar,
  blogImageShas,
  blogMineStage,
  blogReadMinutes,
  blogShortDate,
  blogStageChangeMessage,
  compressBlogImage,
  fitLongEdge,
  imageAltFromName,
  insertBlock,
  loadBlogDraft,
  saveBlogDraft,
} from './blogLib'

const SHA = 'a'.repeat(64)

describe('blogLib · 图片压缩', () => {
  function deps(width: number, height: number, outBytes: number) {
    const calls: Array<{ width: number; height: number; quality: number }> = []
    return {
      calls,
      deps: {
        decode: async () => ({ width, height, draw: () => {}, close: () => {} }),
        encode: async (w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void, quality: number) => {
          paint({} as CanvasRenderingContext2D)
          calls.push({ width: w, height: h, quality })
          return new Blob([new Uint8Array(outBytes)], { type: 'image/webp' })
        },
      },
    }
  }

  it('长边压到 2560、质量 0.85 转 webp；小图不放大', async () => {
    const big = deps(6000, 4000, 1_500_000)
    const out = await compressBlogImage(new Blob([new Uint8Array(12)], { type: 'image/png' }), big.deps)
    expect(out.type).toBe('image/webp')
    expect(big.calls).toEqual([{ width: 2560, height: 1707, quality: 0.85 }])
    expect(fitLongEdge(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('压完仍超过 10MB 拒绝；非图片拒绝', async () => {
    const huge = deps(3000, 3000, BLOG_IMAGE_MAX_BYTES + 1)
    await expect(compressBlogImage(new Blob([new Uint8Array(1)], { type: 'image/png' }), huge.deps)).rejects.toThrow(BlogImageError)
    await expect(compressBlogImage(new Blob(['x'], { type: 'application/pdf' }), huge.deps)).rejects.toThrow('只支持图片文件')
  })
})

describe('blogLib · Markdown 工具栏', () => {
  it('加粗包住选区，没选中时插入占位并选中', () => {
    expect(applyToolbar({ value: 'ab cd', selectionStart: 3, selectionEnd: 5 }, 'bold')).toEqual({
      value: 'ab **cd**',
      selectionStart: 5,
      selectionEnd: 7,
    })
    expect(applyToolbar({ value: '', selectionStart: 0, selectionEnd: 0 }, 'bold').value).toBe('**加粗文字**')
  })

  it('标题 / 列表 / 有序 / 引用按行加前缀', () => {
    const edit = { value: '一\n二', selectionStart: 0, selectionEnd: 3 }
    expect(applyToolbar(edit, 'heading').value).toBe('## 一\n## 二')
    expect(applyToolbar(edit, 'list').value).toBe('- 一\n- 二')
    expect(applyToolbar(edit, 'ordered').value).toBe('1. 一\n2. 二')
    expect(applyToolbar(edit, 'quote').value).toBe('> 一\n> 二')
  })

  it('图片独占一段插入，光标落在其后', () => {
    const next = insertBlock({ value: '前文后文', selectionStart: 2, selectionEnd: 2 }, '![图](tutorial-blob:x)')
    expect(next.value).toBe('前文\n\n![图](tutorial-blob:x)\n\n后文')
    expect(next.selectionStart).toBe('前文\n\n![图](tutorial-blob:x)'.length)
  })

  it('统计正文图片(去重)、文件名转说明', () => {
    expect(blogImageShas(`![a](tutorial-blob:${SHA}) ![b](tutorial-blob:${SHA})`)).toEqual([SHA])
    expect(imageAltFromName('IMG_2041[1].png')).toBe('IMG_2041 1')
  })
})

describe('blogLib · 草稿、状态、日期', () => {
  it('草稿存取往返；坏数据返回 null', () => {
    const key = 'oc:blog-draft:test'
    saveBlogDraft(key, { title: 't', summary: 's', category: 'coding', bodyMarkdown: 'b' }, 1000)
    expect(loadBlogDraft(key)).toEqual({ title: 't', summary: 's', category: 'coding', bodyMarkdown: 'b', savedAt: 1000 })
    window.localStorage.setItem(key, '{bad')
    expect(loadBlogDraft(key)).toBeNull()
  })

  it('投稿阶段：pending 按 needsHuman 分 AI / 人工；结果变化给提示', () => {
    expect(blogMineStage({ status: 'pending', needsHuman: false })).toBe('ai')
    expect(blogMineStage({ status: 'pending', needsHuman: true })).toBe('human')
    expect(blogMineStage({ status: 'pending' })).toBe('human')
    expect(blogMineStage({ status: 'approved' })).toBe('published')
    expect(blogStageChangeMessage('标题', 'ai', 'published')).toBe('「标题」已通过审核并发布')
    expect(blogStageChangeMessage('标题', 'ai', 'ai')).toBeNull()
  })

  it('阅读时长与短日期', () => {
    expect(blogReadMinutes('字'.repeat(401))).toBe(2)
    expect(blogShortDate('2026-10-21T10:00:00+08:00', new Date('2026-10-22T00:00:00+08:00'))).toBe('10月21日')
  })
})
