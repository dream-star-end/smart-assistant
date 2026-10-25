import { describe, expect, it } from 'vitest'
import {
  BLOG_IMAGE_MAX_BYTES,
  BlogImageError,
  applyToolbar,
  blogCanEdit,
  blogDraftKey,
  clearAllBlogLocalDrafts,
  blogEditChangeMessage,
  blogEditDraftKey,
  blogEditSeed,
  blogEditStage,
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

describe('blogLib · 修改已投稿', () => {
  const base = {
    id: '4',
    title: '线上标题',
    summary: '线上摘要',
    category: 'general' as const,
    bodyMarkdown: '线上正文',
    status: 'approved' as const,
    reviewNote: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    reviewedAt: null,
    publishedAt: '2026-10-20T10:00:00.000Z',
    kind: 'markdown' as const,
  }
  const edit = (status: 'pending' | 'rejected', needsHuman = false) => ({
    id: '9',
    status,
    needsHuman,
    reviewNote: status === 'rejected' ? '理由' : null,
    title: '修改后的标题',
    summary: '修改后的摘要',
    category: 'coding' as const,
    bodyMarkdown: '修改后的正文',
    createdAt: '2026-10-23T10:00:00.000Z',
    reviewedAt: null,
  })

  it('修改阶段：只看已发布帖；在审按 needsHuman 分 AI / 人工', () => {
    expect(blogEditStage({ status: 'approved', edit: null })).toBeNull()
    expect(blogEditStage({ status: 'approved', edit: edit('pending') })).toBe('ai')
    expect(blogEditStage({ status: 'approved', edit: edit('pending', true) })).toBe('human')
    expect(blogEditStage({ status: 'approved', edit: edit('rejected') })).toBe('rejected')
    expect(blogEditStage({ status: 'withdrawn', edit: edit('pending') })).toBeNull()
  })

  it('修改结果提示：通过（edit 消失）、未通过、转人工；没有变化不提示', () => {
    expect(blogEditChangeMessage('周报', 'ai', null)).toBe('「周报」的修改已通过，线上已换成新版本')
    expect(blogEditChangeMessage('周报', 'human', 'rejected')).toBe('「周报」的修改未通过，线上仍是原版')
    expect(blogEditChangeMessage('周报', 'ai', 'human')).toBe('「周报」的修改已转人工复核')
    expect(blogEditChangeMessage('周报', null, 'ai')).toBeNull()
    expect(blogEditChangeMessage('周报', 'rejected', null)).toBeNull()
  })

  it('能不能改；修改起点优先取在审 / 未通过的修改稿；修改草稿单独存', () => {
    expect(blogCanEdit({ status: 'approved', kind: 'markdown' })).toBe(true)
    expect(blogCanEdit({ status: 'rejected', kind: 'markdown' })).toBe(true)
    expect(blogCanEdit({ status: 'pending', kind: 'markdown' })).toBe(true)
    expect(blogCanEdit({ status: 'withdrawn', kind: 'markdown' })).toBe(false)
    expect(blogCanEdit({ status: 'takedown', kind: 'markdown' })).toBe(false)
    expect(blogCanEdit({ status: 'approved', kind: 'snapshot' })).toBe(false)
    expect(blogEditSeed(base)).toEqual({ title: '线上标题', summary: '线上摘要', category: 'general', bodyMarkdown: '线上正文' })
    expect(blogEditSeed({ ...base, edit: edit('rejected') })).toEqual({
      title: '修改后的标题',
      summary: '修改后的摘要',
      category: 'coding',
      bodyMarkdown: '修改后的正文',
    })
    expect(blogEditDraftKey('4')).toBe('oc:blog-edit:4')
    expect(blogEditDraftKey('4')).not.toBe(blogDraftKey('u1'))
  })
})

describe("clearAllBlogLocalDrafts", () => {
  it("clears legacy and scoped draft keys", () => {
    window.localStorage.setItem("oc:blog-draft", "legacy");
    window.localStorage.setItem("oc:blog-draft:u1", "a");
    window.localStorage.setItem("oc:blog-edit:9", "b");
    clearAllBlogLocalDrafts();
    expect(window.localStorage.getItem("oc:blog-draft")).toBeNull();
    expect(window.localStorage.getItem("oc:blog-draft:u1")).toBeNull();
    expect(window.localStorage.getItem("oc:blog-edit:9")).toBeNull();
  });
});
