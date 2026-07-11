/**
 * 全屏查看器(ImageViewer)行为契约:
 *  - 全屏开合;顶栏 关闭/下载/分享/更多;底部 编辑/评论/调整大小 三动作(「移除」已下线)。
 *  - 下载/分享经点击时签名(get)—— 手势重签不回归。
 *  - 无 submitImageEdit → 三动作优雅降级(禁用)。
 *  - 进入 评论/调整大小/编辑 子模式;initialMode='edit' → 开图直达编辑器。
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
  onOpenChange?: (o: boolean) => void
  signPath?: string | null
  get?: (opts?: { forceResign?: boolean }) => Promise<string | null>
  peek?: () => string | null
  initialMode?: 'view' | 'edit'
}

function Harness({ submitImageEdit, onOpenChange, signPath = '/home/a.png', get, peek, initialMode }: HarnessProps) {
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
      initialMode={initialMode}
    />
  )
}

describe('ImageViewer 全屏查看器', () => {
  test('打开显示大图 + 三动作条,关闭收起(「移除」已下线)', () => {
    const onOpenChange = vi.fn()
    render(<Harness submitImageEdit={vi.fn()} onOpenChange={onOpenChange} />)
    expect(screen.getByAltText('海报')).toBeInTheDocument()
    for (const label of ['编辑', '评论', '调整大小']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    // 「移除」已删除,不再出现。
    expect(screen.queryByRole('button', { name: '移除' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument()
  })

  test('无 submitImageEdit → 三动作优雅降级为禁用', () => {
    render(<Harness />)
    for (const label of ['编辑', '评论', '调整大小']) {
      expect(screen.getByRole('button', { name: label })).toBeDisabled()
    }
  })

  test("initialMode='edit' → 开图直达圈选编辑器", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    render(<Harness submitImageEdit={vi.fn()} initialMode="edit" />)
    // 不必点底部「编辑」,查看器一开即自动进入编辑器。
    expect(await screen.findByRole('button', { name: '关闭图片编辑器' })).toBeInTheDocument()
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

  test('点编辑 → 打开圈选编辑器(复用 ImageAnnotationEditor)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    render(<Harness submitImageEdit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(await screen.findByRole('button', { name: '关闭图片编辑器' }))
      .toBeInTheDocument()
  })

  test('ESC 逐层退出:评论模式按 ESC → 回到查看器(不直接关闭)(需求 §5)', () => {
    const onOpenChange = vi.fn()
    render(<Harness submitImageEdit={vi.fn()} onOpenChange={onOpenChange} />)
    // 进入评论子模式
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    expect(screen.getByRole('heading', { name: '0 条评论' })).toBeInTheDocument()
    // ESC → 先退回 view(三动作条重现),不关整个查看器
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('heading', { name: '0 条评论' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  test('三模式(编辑/评论/调整大小)均可从查看器底部动作条直达(需求 §2)', () => {
    render(<Harness submitImageEdit={vi.fn()} />)
    // 底部三动作齐全且可用
    for (const label of ['编辑', '评论', '调整大小']) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled()
    }
  })
})
