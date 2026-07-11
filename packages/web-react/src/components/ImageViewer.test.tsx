/**
 * 全屏查看器(ImageViewer)行为契约:
 *  - 全屏开合;顶栏 关闭/下载/分享/更多;底部 编辑/评论/调整大小/移除 四动作。
 *  - 下载/分享经点击时签名(get)—— 手势重签不回归。
 *  - 无 submitImageEdit/onRemove → 对应动作优雅降级(禁用)。
 *  - 进入 评论/调整大小/编辑 子模式。
 *  - 移除 → 确认弹层 → onRemove(signPath) + 关闭查看器。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ImageViewer, type ImageEditSubmit } from './ImageViewer'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const SIGNED = 'https://signed.test/x.png'

type HarnessProps = {
  submitImageEdit?: (v: ImageEditSubmit) => Promise<void>
  onRemove?: (p: string) => void
  onOpenChange?: (o: boolean) => void
  signPath?: string | null
  get?: (opts?: { forceResign?: boolean }) => Promise<string | null>
  peek?: () => string | null
}

function Harness({ submitImageEdit, onRemove, onOpenChange, signPath = '/home/a.png', get, peek }: HarnessProps) {
  const [open, setOpen] = useState(true)
  return (
    <ImageViewer
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        onOpenChange?.(o)
      }}
      src={SIGNED}
      alt="海报"
      signPath={signPath}
      get={get ?? (async () => SIGNED)}
      peek={peek ?? (() => SIGNED)}
      submitImageEdit={submitImageEdit}
      onRemove={onRemove}
    />
  )
}

describe('ImageViewer 全屏查看器', () => {
  test('打开显示大图 + 四动作条,关闭收起', () => {
    const onOpenChange = vi.fn()
    render(<Harness submitImageEdit={vi.fn()} onRemove={vi.fn()} onOpenChange={onOpenChange} />)
    expect(screen.getByAltText('海报')).toBeInTheDocument()
    for (const label of ['编辑', '评论', '调整大小', '移除']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument()
  })

  test('无 submit/remove → 四动作优雅降级为禁用', () => {
    render(<Harness />)
    for (const label of ['编辑', '评论', '调整大小', '移除']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled()
    }
  })

  test('点评论 → 进入评论模式(0 条评论 + 空态提示)', () => {
    render(<Harness submitImageEdit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    expect(screen.getByRole('heading', { name: '0 条评论' })).toBeInTheDocument()
    expect(screen.getByText('点按图片添加评论')).toBeInTheDocument()
  })

  test('点调整大小 → 进入调整大小模式(五比例)', () => {
    render(<Harness submitImageEdit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '调整大小' }))
    expect(screen.getByRole('heading', { name: '调整大小' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /16:9/ })).toBeInTheDocument()
  })

  test('下载 → 点击时经 get 现签,交原生下载', async () => {
    const hrefs: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.href)
    })
    const get = vi.fn(async () => SIGNED)
    render(<Harness submitImageEdit={vi.fn()} get={get} />)
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    await waitFor(() => expect(hrefs.length).toBeGreaterThan(0))
    expect(get).toHaveBeenCalled()
    expect(hrefs.some((h) => h.includes('signed.test/x.png'))).toBe(true)
  })

  test('分享 → 无 navigator.share 时复制链接降级', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(<Harness submitImageEdit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '分享' }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(await screen.findByText('已复制链接')).toBeInTheDocument()
  })

  test('更多菜单 → 新标签打开原图(手势内开新标签)', async () => {
    const hrefs: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.href)
    })
    render(<Harness submitImageEdit={vi.fn()} peek={() => SIGNED} />)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('button', { name: /新标签打开原图/ }))
    await waitFor(() => expect(hrefs.some((h) => h.includes('signed.test/x.png'))).toBe(true))
  })

  test('移除 → 确认弹层 → onRemove(signPath) + 关闭查看器', () => {
    const onRemove = vi.fn()
    const onOpenChange = vi.fn()
    render(<Harness onRemove={onRemove} onOpenChange={onOpenChange} signPath="/home/a.png" />)
    fireEvent.click(screen.getByRole('button', { name: '移除' }))
    expect(screen.getByText('移除这张图片？')).toBeInTheDocument()
    // 确认弹层的「移除」是后渲染的那个(动作条「移除」仍在 DOM 中,取最后一个)。
    const removeButtons = screen.getAllByRole('button', { name: '移除' })
    fireEvent.click(removeButtons[removeButtons.length - 1])
    expect(onRemove).toHaveBeenCalledWith('/home/a.png')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('点编辑 → 打开圈选编辑器(复用 ImageAnnotationEditor)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    render(<Harness submitImageEdit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(await screen.findByRole('button', { name: '关闭图片编辑器' })).toBeInTheDocument()
  })
})
