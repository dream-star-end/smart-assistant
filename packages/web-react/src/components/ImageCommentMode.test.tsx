/**
 * 评论模式(ImageCommentMode)行为契约(ChatGPT 同款「模型驱动精确修改」):
 *  - 空态提示「点按图片添加评论」;顶部「N 条评论」。
 *  - 点图 → 输入条(占位「描述编辑」)→ 确认 → 落编号锚点,计数 +1。
 *  - 点已有锚点 → 可改文案/删除。
 *  - 0 条禁用发送;≥1 条且 canSubmit → 提交**普通对话消息**({ text, reuseUrl | sourceFile }):
 *      · src 为持久 /api/media/... → onSubmit 收到 reuseUrl===src(不上传);
 *      · src 为签名 URL/data/blob → 取字节交 App 上传(onSubmit 收到 sourceFile File)。
 *    text = 前导 + 每锚点「n. (x: NN%, y: NN%) 文案」(左上原点百分比整数)。
 *  - 渲染失败(图片加载失败)/取字节失败各有回退。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { ImageCommentSubmit } from './chat/imageEditActions'
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

const LEAD = '请按下列标注修改这张图片，编号对应以下坐标（图片左上角为原点，百分比）：'

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

  test('发送(持久 /api/media 源):复用 reuseUrl,不上传,携百分比坐标文本', async () => {
    // /api/media/... 是持久服务端 URL → 直接复用,fetch 不应被调用。
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const onSubmit = vi.fn(async (_v: ImageCommentSubmit) => {})
    render(<ImageCommentMode {...baseProps} src="/api/media/abc.png" canSubmit onSubmit={onSubmit} />)
    addComment('把裙子改成蓝色')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const value = onSubmit.mock.calls[0][0]
    expect(value.reuseUrl).toBe('/api/media/abc.png')
    expect(value.sourceFile).toBeUndefined()
    expect(value.text.startsWith(LEAD)).toBe(true)
    expect(value.text).toContain('1. (x: 50%, y: 50%) 把裙子改成蓝色')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('发送(签名 URL 源):取字节上传,onSubmit 收到 sourceFile File', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    // 完整 Response 桩:共享流式取字节路径会读 res.headers 的 content-length(缺 headers 抛
    // TypeError),故补恒返 null 的 headers。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, blob: async () => blob }) as unknown as Response),
    )
    const onSubmit = vi.fn(async (_v: ImageCommentSubmit) => {})
    render(<ImageCommentMode {...baseProps} canSubmit onSubmit={onSubmit} />)
    addComment('去掉背景路人')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const value = onSubmit.mock.calls[0][0]
    expect(value.sourceFile).toBeInstanceOf(File)
    expect(value.reuseUrl).toBeUndefined()
    expect(value.text.startsWith(LEAD)).toBe(true)
    expect(value.text).toContain('1. (x: 50%, y: 50%) 去掉背景路人')
  })

  test('渲染失败:图片 onError → 加载失败回退', () => {
    render(<ImageCommentMode {...baseProps} canSubmit onSubmit={vi.fn()} />)
    fireEvent.error(screen.getByAltText('合影'))
    expect(screen.getByText('图片加载失败')).toBeInTheDocument()
  })

  test('取字节失败:签名 URL 410(重签后仍失败)→ 错误提示,onSubmit 未调用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 410 }) as unknown as Response))
    const onSubmit = vi.fn(async () => {})
    render(<ImageCommentMode {...baseProps} canSubmit onSubmit={onSubmit} />)
    addComment('测试')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/读取图片失败/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
