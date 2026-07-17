/**
 * 全屏查看器(ImageViewer)行为契约:
 *  - 全屏开合;顶栏 关闭/下载/分享/更多;底部 编辑/评论/调整大小 三动作(「移除」已下线)。
 *  - 下载/分享经点击时签名(get)—— 手势重签不回归。
 *  - 无 submitImageEdit → 三动作优雅降级(禁用)。
 *  - 进入 评论/调整大小/编辑 子模式;initialMode='edit' → 开图直达编辑器。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { byteCacheKey, imageByteCache } from '../lib/chat/imageBytes'
import { type ImageEditSubmit, ImageViewer } from './ImageViewer'
import { type ImageCommentSubmit, ImageEditActionsContext } from './chat/imageEditActions'

let objectUrlSeq = 0
beforeEach(() => {
  imageByteCache.clear()
  objectUrlSeq = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    const size = blob instanceof Blob ? blob.size : 0
    return `blob:size-${size}-${++objectUrlSeq}`
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const SIGNED = 'https://signed.test/x.png'

type HarnessProps = {
  submitImageEdit?: (v: ImageEditSubmit) => Promise<void>
  // 评论门控 = ImageEditActionsContext.submitImageComment(无 prop),经下面 Provider 注入。
  submitImageComment?: (v: ImageCommentSubmit) => Promise<void>
  onOpenChange?: (o: boolean) => void
  signPath?: string | null
  get?: (opts?: { forceResign?: boolean }) => Promise<string | null>
  peek?: () => string | null
  initialMode?: 'view' | 'edit'
  src?: string
  alt?: string
  cacheIdentity?: string | null
  readOnly?: boolean
  referrerPolicy?: React.HTMLAttributeReferrerPolicy
}

function Harness({
  submitImageEdit,
  submitImageComment,
  onOpenChange,
  signPath = '/home/a.png',
  get,
  peek,
  initialMode,
  src = SIGNED,
  alt = '海报',
  cacheIdentity,
  readOnly,
  referrerPolicy,
}: HarnessProps) {
  const [open, setOpen] = useState(true)
  return (
    <ImageEditActionsContext.Provider value={{ submitImageComment }}>
      <ImageViewer
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          onOpenChange?.(o)
        }}
        src={src}
        alt={alt}
        signPath={signPath}
        cacheIdentity={cacheIdentity === undefined ? (signPath ?? null) : cacheIdentity}
        get={get ?? (async () => SIGNED)}
        peek={peek ?? (() => SIGNED)}
        submitImageEdit={submitImageEdit}
        initialMode={initialMode}
        readOnly={readOnly}
        referrerPolicy={referrerPolicy}
      />
    </ImageEditActionsContext.Provider>
  )
}

function streamResponse(text: string, status = 200): Response {
  const bytes = new TextEncoder().encode(text)
  return new Response(bytes, {
    status,
    headers: {
      'content-length': String(bytes.length),
      'content-type': status >= 200 && status < 300 ? 'image/png' : 'text/plain',
    },
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function captureAnchorClicks(): string[] {
  const hrefs: string[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    hrefs.push(this.href)
  })
  return hrefs
}

describe('ImageViewer 全屏查看器', () => {
  test('打开显示大图 + 三动作条,关闭收起(「移除」已下线)', () => {
    const onOpenChange = vi.fn()
    render(<Harness submitImageEdit={vi.fn()} onOpenChange={onOpenChange} />)
    expect(screen.getByAltText('海报')).toBeInTheDocument()
    for (const label of ['编辑', '评论', '调整大小']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    for (const label of ['关闭预览', '下载', '分享', '更多']) {
      expect(screen.getByRole('button', { name: label })).toHaveClass('[@media(hover:none)]:size-11')
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

  test('只读外链查看器保留 no-referrer 且不暴露写交互', () => {
    render(
      <Harness
        src="https://cdn.test/inbox.png"
        signPath={null}
        cacheIdentity={null}
        readOnly
        referrerPolicy="no-referrer"
      />,
    )
    expect(screen.getByAltText('海报')).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument()
    for (const label of ['编辑', '评论', '调整大小', '分享', '更多']) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
    }
  })

  test("initialMode='edit' → 开图直达圈选编辑器", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response),
    )
    render(<Harness submitImageEdit={vi.fn()} initialMode="edit" />)
    // 不必点底部「编辑」,查看器一开即自动进入编辑器。
    expect(await screen.findByRole('button', { name: '关闭图片编辑器' })).toBeInTheDocument()
  })

  test('点评论 → 进入评论模式(0 条评论 + 空态提示)', () => {
    render(<Harness submitImageEdit={vi.fn()} submitImageComment={vi.fn()} />)
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
    const hrefs = captureAnchorClicks()
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
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      hrefs.push(this.href)
    })
    render(<Harness submitImageEdit={vi.fn()} peek={() => SIGNED} />)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('button', { name: /新标签打开原图/ }))
    await waitFor(() => expect(hrefs.some((h) => h.includes('signed.test/x.png'))).toBe(true))
  })

  test('点编辑 → 打开圈选编辑器(复用 ImageAnnotationEditor)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response),
    )
    render(<Harness submitImageEdit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(await screen.findByRole('button', { name: '关闭图片编辑器' })).toBeInTheDocument()
  })

  test('ESC 逐层退出:评论模式按 ESC → 回到查看器(不直接关闭)(需求 §5)', () => {
    const onOpenChange = vi.fn()
    render(
      <Harness
        submitImageEdit={vi.fn()}
        submitImageComment={vi.fn()}
        onOpenChange={onOpenChange}
      />,
    )
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
    render(<Harness submitImageEdit={vi.fn()} submitImageComment={vi.fn()} />)
    // 底部三动作齐全且可用
    for (const label of ['编辑', '评论', '调整大小']) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled()
    }
  })

  test('首帧/加载中点下载并重复点击 → 复用唯一原图 fetch,完成后只保存一次', async () => {
    const src = '/api/media-signed?t=long'
    const gate = deferred<Response>()
    const fetchMock = vi.fn(() => gate.promise)
    vi.stubGlobal('fetch', fetchMock)
    const hrefs = captureAnchorClicks()

    render(<Harness src={src} signPath="/home/agent/long.png" get={async () => src} />)
    // 紧跟首帧点击,不等下载状态 effect 稳定；idle/loading 都不得另开 native 请求。
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    expect(hrefs).toHaveLength(0)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      gate.resolve(streamResponse('12345678'))
    })
    await waitFor(() => expect(hrefs).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hrefs[0]).toContain('blob:size-8-')
  })

  test('原图 Blob 已加载 → 下载零新增 fetch', async () => {
    const src = '/api/media-signed?t=cached'
    const path = '/home/agent/cached.png'
    imageByteCache.set(byteCacheKey(path, null), new Blob(['cached-bytes']))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const hrefs = captureAnchorClicks()

    render(<Harness src={src} signPath={path} get={async () => src} />)
    await waitFor(() =>
      expect(screen.getByAltText('海报').getAttribute('src')).toContain('blob:size-12-'),
    )
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    await waitFor(() => expect(hrefs).toHaveLength(1))
    expect(hrefs[0]).toContain('blob:size-12-')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('A Blob 残留窗口切到 B 后点下载 → 只保存 B,不把 A 命名成 B', async () => {
    const srcA = '/api/media-signed?t=a'
    const srcB = '/api/media-signed?t=b'
    const pathA = '/home/agent/a.png'
    const pathB = '/home/agent/b.png'
    imageByteCache.set(byteCacheKey(pathA, null), new Blob(['aaa']))
    const gateB = deferred<Response>()
    const fetchMock = vi.fn(() => gateB.promise)
    vi.stubGlobal('fetch', fetchMock)
    const hrefs = captureAnchorClicks()

    const view = render(<Harness src={srcA} signPath={pathA} get={async () => srcA} />)
    await waitFor(() =>
      expect(screen.getByAltText('海报').getAttribute('src')).toContain('blob:size-3-'),
    )
    view.rerender(<Harness src={srcB} signPath={pathB} get={async () => srcB} alt="B图" />)
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(hrefs).toHaveLength(0)

    await act(async () => {
      gateB.resolve(streamResponse('bbbbbbb'))
    })
    await waitFor(() => expect(hrefs).toHaveLength(1))
    expect(hrefs[0]).toContain('blob:size-7-')
    expect(hrefs[0]).not.toContain('blob:size-3-')
  })

  test('A pending 后切 B,A 迟到 → 不触发任何下载', async () => {
    const srcA = '/api/media-signed?t=a-late'
    const srcB = '/api/media-signed?t=b-wait'
    const gateA = deferred<Response>()
    const gateB = deferred<Response>()
    const fetchMock = vi.fn((url: string) =>
      url.includes('a-late') ? gateA.promise : gateB.promise,
    )
    vi.stubGlobal('fetch', fetchMock)
    const hrefs = captureAnchorClicks()

    const view = render(
      <Harness src={srcA} signPath="/home/agent/a-late.png" get={async () => srcA} />,
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    view.rerender(<Harness src={srcB} signPath="/home/agent/b-wait.png" get={async () => srcB} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      gateA.resolve(streamResponse('old-a'))
      await Promise.resolve()
    })
    expect(hrefs).toHaveLength(0)
  })

  test('pending 后关闭 Viewer,原图迟到 → 不保存', async () => {
    const src = '/api/media-signed?t=close'
    const gate = deferred<Response>()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => gate.promise),
    )
    const hrefs = captureAnchorClicks()

    render(<Harness src={src} signPath="/home/agent/close.png" get={async () => src} />)
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }))
    await act(async () => {
      gate.resolve(streamResponse('too-late'))
      await Promise.resolve()
    })
    expect(hrefs).toHaveLength(0)
  })

  test('原图 fetch 失败 → get 一次拿新签名 URL 后走 native fallback', async () => {
    const stale = '/api/media-signed?t=stale-error'
    const fresh = '/api/media-signed?t=fresh-fallback'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamResponse('broken', 500)),
    )
    const get = vi.fn(async () => fresh)
    const hrefs = captureAnchorClicks()

    render(<Harness src={stale} signPath="/home/agent/error.png" get={get} />)
    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    await waitFor(() => expect(hrefs).toHaveLength(1))
    expect(get).toHaveBeenCalledTimes(1)
    expect(hrefs[0]).toContain('t=fresh-fallback')
    expect(hrefs[0]).not.toContain('t=stale-error')
  })
})
