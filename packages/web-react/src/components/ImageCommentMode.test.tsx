/**
 * 评论模式(ImageCommentMode)行为契约:
 *  - 空态提示「点按图片添加评论」;顶部「N 条评论」。
 *  - 点图 → 输入条(占位「描述编辑」)→ 确认 → 落编号锚点,计数 +1。
 *  - 点已有锚点 → 可改文案/删除。
 *  - 0 条禁用发送;≥1 条且 canSubmit → 提交合成 annotated 三件套(mode:'annotated')。
 *  - 渲染失败(图片加载失败)/解析失败(取图字节失败)各有回退。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ImageCommentMode } from './ImageCommentMode'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const baseProps = {
  src: 'https://signed.test/x.png',
  alt: '合影',
  resolveSrc: vi.fn(async () => 'https://signed.test/x.png'),
  onBack: vi.fn(),
}

function stubImagePipeline() {
  const blob = new Blob(['png'], { type: 'image/png' })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob }) as unknown as Response))
  URL.createObjectURL = vi.fn(() => 'blob:mock')
  URL.revokeObjectURL = vi.fn()
  class MockImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 900
    naturalHeight = 900
    _src = ''
    set src(v: string) {
      this._src = v
      setTimeout(() => this.onload?.(), 0)
    }
    get src() {
      return this._src
    }
  }
  vi.stubGlobal('Image', MockImage)
  const ctx = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
  } as unknown as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
    cb(new Blob(['out'], { type: 'image/png' }))
  })
}

/** 落一个带文案的锚点(点图 → 输入 → 确认)。 */
function addComment(text: string) {
  fireEvent.click(screen.getByRole('button', { name: '点按图片添加评论' }))
  fireEvent.change(screen.getByLabelText('描述编辑'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: '确认' }))
}

describe('ImageCommentMode', () => {
  test('空态:0 条评论 + 点按图片提示', () => {
    render(<ImageCommentMode {...baseProps} canSubmit onSubmit={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '0 条评论' })).toBeInTheDocument()
    expect(screen.getByText('点按图片添加评论')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })

  test('点图 → 输入 → 确认:落编号锚点,计数递增', () => {
    render(<ImageCommentMode {...baseProps} canSubmit onSubmit={vi.fn()} />)
    // 点图打开输入条(占位「描述编辑」)。
    fireEvent.click(screen.getByRole('button', { name: '点按图片添加评论' }))
    expect(screen.getByPlaceholderText('描述编辑')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('描述编辑'), { target: { value: '把天空改蓝' } })
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(screen.getByRole('heading', { name: '1 条评论' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '评论 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
  })

  test('点已有锚点 → 可编辑并删除,计数归零', () => {
    render(<ImageCommentMode {...baseProps} canSubmit onSubmit={vi.fn()} />)
    addComment('第一处')
    fireEvent.click(screen.getByRole('button', { name: '评论 1' }))
    // 编辑态回填原文案。
    expect((screen.getByLabelText('描述编辑') as HTMLInputElement).value).toBe('第一处')
    fireEvent.click(screen.getByRole('button', { name: '删除该评论' }))
    expect(screen.getByRole('heading', { name: '0 条评论' })).toBeInTheDocument()
  })

  test('发送 → 合成 annotated 三件套(mode/source/mask/guide/prompt)', async () => {
    stubImagePipeline()
    const onSubmit = vi.fn(async () => {})
    render(<ImageCommentMode {...baseProps} canSubmit onSubmit={onSubmit} />)
    addComment('去掉背景路人')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const value = onSubmit.mock.calls[0][0]
    expect(value.mode).toBe('comment')
    expect(value.source).toBeInstanceOf(File)
    expect(value.mask).toBeInstanceOf(File)
    expect(value.guide).toBeInstanceOf(File)
    expect(value.prompt).toContain('1. 去掉背景路人')
    expect(value.width).toBe(900)
    expect(value.clientJobId).toMatch(/^[0-9a-f]{32}$/)
  })

  test('渲染失败:图片 onError → 加载失败回退', () => {
    render(<ImageCommentMode {...baseProps} canSubmit onSubmit={vi.fn()} />)
    fireEvent.error(screen.getByAltText('合影'))
    expect(screen.getByText('图片加载失败')).toBeInTheDocument()
  })

  test('解析失败:取图字节失败 → 错误提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 410 }) as unknown as Response))
    const onSubmit = vi.fn(async () => {})
    render(<ImageCommentMode {...baseProps} canSubmit onSubmit={onSubmit} />)
    addComment('测试')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/读取图片失败/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
