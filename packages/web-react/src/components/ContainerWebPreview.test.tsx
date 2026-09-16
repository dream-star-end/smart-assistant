import '@testing-library/jest-dom/vitest'
import type { ContainerPreviewClientMessage } from '@openclaude/protocol/containerPreview'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createMemoryAuthSession } from '../lib/authSession'
import type { AuthSession } from '../lib/types'

type Target = {
  selector: string
  tag: string
  text: string
  role?: string
  ariaLabel?: string
  bounds: { x: number; y: number; width: number; height: number }
}

const previewMock = vi.hoisted(() => ({
  phase: 'ready',
  transport: 'legacy' as 'legacy' | 'direct',
  directUrl: null as string | null,
  error: null as null | { message: string; retryable: boolean },
  ready: {
    url: 'http://localhost:3000/',
    title: 'Demo app',
  } as null | { url: string; title: string },
  selection: null as null | { sequence: number; target: Target | null },
  resolved: null as null | { sequence: number; selector: string; target: Target | null },
  navigation: {
    sequence: 1,
    url: 'http://localhost:3000/',
    title: 'Demo app',
    pageRevision: 1,
  } as null | {
    sequence: number
    url: string
    title: string
    pageRevision: number
  },
  send: vi.fn<(message: ContainerPreviewClientMessage) => boolean>(() => true),
  useLegacyFallback: vi.fn(),
  calls: [] as Array<{
    enabled: boolean
    url: string
    viewport: { isMobile: boolean; width: number; height: number }
    reconnectKey: number
  }>,
}))

vi.mock('../hooks/useContainerPreview', () => ({
  useContainerPreview: (input: {
    enabled: boolean
    url: string
    viewport: { isMobile: boolean; width: number; height: number }
    reconnectKey: number
  }) => {
    previewMock.calls.push(input)
    return {
      phase: previewMock.phase,
      transport: previewMock.transport,
      directUrl: previewMock.directUrl,
      error: previewMock.error,
      ready: previewMock.ready ? { ...previewMock.ready, viewport: input.viewport } : null,
      selection: previewMock.selection,
      resolved: previewMock.resolved,
      navigation: previewMock.navigation,
      send: previewMock.send,
      useLegacyFallback: previewMock.useLegacyFallback,
    }
  },
}))

import { ContainerWebPreview } from './ContainerWebPreview'

const auth: AuthSession = createMemoryAuthSession(() => {}, 'token')

const heroTarget: Target = {
  selector: '#hero-cta',
  tag: 'button',
  text: '开始使用',
  role: 'button',
  bounds: { x: 100, y: 120, width: 180, height: 44 },
}

const cardTarget: Target = {
  selector: '.feature-card:first-child',
  tag: 'article',
  text: '智能总结',
  bounds: { x: 80, y: 240, width: 300, height: 160 },
}

function PreviewHarness({
  open = true,
  sourceUrl = 'http://localhost:3000/',
  onClose = () => {},
  onUseComments = () => {},
}: {
  open?: boolean
  sourceUrl?: string
  onClose?: () => void
  onUseComments?: (prompt: string) => void
}) {
  return (
    <ContainerWebPreview
      open={open}
      sourceUrl={sourceUrl}
      auth={auth}
      onClose={onClose}
      onUseComments={onUseComments}
    />
  )
}

function setCanvasRect(canvas: HTMLElement, width = 1280, height = 800) {
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      width,
      height,
      toJSON: () => {},
    }),
  })
}

function setClientViewport(width: number, height: number) {
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: width },
    innerHeight: { configurable: true, value: height },
    visualViewport: {
      configurable: true,
      value: {
        width,
        height,
        offsetTop: 0,
        offsetLeft: 0,
        addEventListener() {},
        removeEventListener() {},
      },
    },
    matchMedia: {
      configurable: true,
      value: (query: string) => ({
        matches: query === '(max-width: 767px)' && width <= 767,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true,
      }),
    },
  })
}

afterEach(() => {
  vi.useRealTimers()
  cleanup()
})

beforeEach(() => {
  setClientViewport(1280, 800)
  previewMock.phase = 'ready'
  previewMock.transport = 'legacy'
  previewMock.directUrl = null
  previewMock.error = null
  previewMock.ready = { url: 'http://localhost:3000/', title: 'Demo app' }
  previewMock.selection = null
  previewMock.resolved = null
  previewMock.navigation = {
    sequence: 1,
    url: 'http://localhost:3000/',
    title: 'Demo app',
    pageRevision: 1,
  }
  previewMock.send.mockClear()
  previewMock.useLegacyFallback.mockClear()
  previewMock.calls.length = 0
})

describe('ContainerWebPreview immersive UI', () => {
  test('automatically uses a mobile viewport and fills the visible screen on mobile access', () => {
    setClientViewport(390, 844)
    render(<PreviewHarness />)

    expect(previewMock.calls.at(-1)).toMatchObject({
      enabled: true,
      url: 'http://localhost:3000/',
      viewport: { isMobile: true, width: 390, height: 844 },
    })
    expect(screen.getByRole('button', { name: '移动预览' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('dialog')).toHaveClass('left-0', 'translate-x-0', 'translate-y-0')
    expect(screen.getByTestId('container-preview-viewport')).toHaveAttribute(
      'data-fullscreen',
      'true',
    )
    expect(screen.getByTestId('container-preview-viewport')).toHaveStyle({
      width: '100%',
      height: '100%',
    })
  })

  test('automatically uses a desktop viewport and fills the visible screen on PC access', () => {
    setClientViewport(1440, 900)
    render(<PreviewHarness />)

    expect(previewMock.calls.at(-1)).toMatchObject({
      enabled: true,
      viewport: { isMobile: false, width: 1440, height: 900 },
    })
    expect(screen.getByRole('button', { name: '桌面预览' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('container-preview-viewport')).toHaveAttribute(
      'data-fullscreen',
      'true',
    )
  })

  test('auto-hides fullscreen controls without consuming page input and restores them on demand', () => {
    vi.useFakeTimers()
    setClientViewport(390, 844)
    render(<PreviewHarness />)

    const canvas = screen.getByLabelText('可交互网页画面')
    setCanvasRect(canvas, 390, 844)
    canvas.focus()
    act(() => vi.advanceTimersByTime(3_001))

    expect(screen.queryByRole('button', { name: '关闭网页预览' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '评论' })).not.toBeInTheDocument()
    const reveal = screen.getByRole('button', { name: '显示预览控制' })
    expect(reveal).toHaveClass('preview-icon-button')

    previewMock.send.mockClear()
    fireEvent.pointerDown(canvas, {
      pointerId: 11,
      pointerType: 'touch',
      clientX: 170,
      clientY: 420,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 11,
      pointerType: 'touch',
      clientX: 170,
      clientY: 420,
    })
    expect(previewMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'preview.pointer', action: 'click', x: 170, y: 420 }),
    )
    expect(screen.queryByRole('button', { name: '关闭网页预览' })).not.toBeInTheDocument()

    fireEvent.click(reveal)
    act(() => vi.advanceTimersByTime(16))
    const close = screen.getByRole('button', { name: '关闭网页预览' })
    expect(close).toHaveFocus()
    expect(screen.getByRole('button', { name: '评论' })).toBeEnabled()

    act(() => vi.advanceTimersByTime(3_001))
    expect(close).toBeInTheDocument()

    canvas.focus()
    act(() => vi.advanceTimersByTime(16))
    act(() => vi.advanceTimersByTime(3_001))
    expect(screen.queryByRole('button', { name: '关闭网页预览' })).not.toBeInTheDocument()
  })

  test('keeps controls visible outside the idle fullscreen state and resets on reopen', () => {
    vi.useFakeTimers()
    setClientViewport(390, 844)
    previewMock.phase = 'loading'
    previewMock.ready = null
    const view = render(<PreviewHarness />)
    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.getByRole('button', { name: '关闭网页预览' })).toBeInTheDocument()

    previewMock.phase = 'ready'
    previewMock.ready = { url: 'http://localhost:3000/', title: 'Demo app' }
    view.rerender(<PreviewHarness />)
    fireEvent.click(screen.getByRole('button', { name: '桌面预览' }))
    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.getByRole('button', { name: '关闭网页预览' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '移动预览' }))
    const canvas = screen.getByLabelText('可交互网页画面')
    canvas.focus()
    act(() => vi.advanceTimersByTime(3_001))
    expect(screen.getByRole('button', { name: '显示预览控制' })).toBeInTheDocument()

    view.rerender(<PreviewHarness open={false} />)
    act(() => vi.runOnlyPendingTimers())
    view.rerender(<PreviewHarness />)
    expect(screen.getByRole('button', { name: '关闭网页预览' })).toBeInTheDocument()
  })

  test('keeps the opposite-device simulator framed and resets atomically for a new URL', async () => {
    setClientViewport(390, 844)
    const view = render(<PreviewHarness />)

    fireEvent.click(screen.getByRole('button', { name: '桌面预览' }))
    expect(previewMock.calls.at(-1)?.viewport).toMatchObject({
      isMobile: false,
      width: 1280,
      height: 800,
    })
    expect(screen.getByTestId('container-preview-viewport')).toHaveAttribute(
      'data-fullscreen',
      'false',
    )

    view.rerender(<PreviewHarness sourceUrl="http://localhost:4173/" />)
    expect(
      previewMock.calls.some(
        (call) => call.url === 'http://localhost:4173/' && call.enabled === false,
      ),
    ).toBe(true)
    await waitFor(() => {
      expect(previewMock.calls.at(-1)).toMatchObject({
        enabled: true,
        url: 'http://localhost:4173/',
        viewport: { isMobile: true, width: 390, height: 844 },
      })
    })
  })

  test('renders the isolated native iframe and exposes an explicit compatibility fallback', () => {
    previewMock.transport = 'direct'
    previewMock.directUrl =
      'https://alpha-preview.trycloudflare.com/__oc_preview_bootstrap?ticket=secret'
    const OriginalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    try {
      render(<PreviewHarness />)
      const frame = screen.getByTitle('容器内网页原生预览')
      expect(frame).toHaveAttribute('src', previewMock.directUrl)
      expect(frame).toHaveAttribute(
        'sandbox',
        'allow-scripts allow-forms allow-same-origin allow-modals allow-popups',
      )
      expect(screen.queryByLabelText('可交互网页画面')).not.toBeInTheDocument()
      expect(screen.getByText('原生清晰预览')).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: '切换兼容预览' }))
      expect(previewMock.useLegacyFallback).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  })

  test('scales the direct iframe on both axes when the fullscreen surface exceeds protocol bounds', async () => {
    setClientViewport(2560, 1080)
    previewMock.transport = 'legacy'
    previewMock.directUrl = null
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 2560,
      bottom: 1080,
      x: 0,
      y: 0,
      width: 2560,
      height: 1080,
      toJSON: () => {},
    })
    const OriginalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback([], this as unknown as ResizeObserver)
      }
      disconnect() {}
      unobserve() {}
    }
    try {
      const view = render(<PreviewHarness />)
      expect(previewMock.calls.at(-1)?.viewport).toMatchObject({
        isMobile: false,
        width: 1920,
        height: 1080,
      })
      previewMock.transport = 'direct'
      previewMock.directUrl =
        'https://alpha-preview.trycloudflare.com/__oc_preview_bootstrap?ticket=secret'
      view.rerender(<PreviewHarness />)
      await waitFor(() => {
        expect(screen.getByTitle('容器内网页原生预览')).toHaveStyle({
          transform: 'scale(1.3333333333333333, 1)',
        })
      })
    } finally {
      rect.mockRestore()
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  })

  test('starts with compact remote controls and switches to the real mobile viewport', () => {
    render(<PreviewHarness />)

    expect(screen.getByRole('button', { name: '操作' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '评论' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '输入' })).toBeEnabled()
    expect(screen.queryByText('网页修改评论')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '移动预览' }))
    expect(previewMock.calls.at(-1)?.viewport).toMatchObject({
      isMobile: true,
      width: 390,
      height: 844,
    })
    expect(screen.getByRole('button', { name: '移动预览' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('turns an explicitly selected DOM element into a confirmed chat draft only', () => {
    const onUseComments = vi.fn()
    const onClose = vi.fn()
    const view = render(<PreviewHarness onUseComments={onUseComments} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    previewMock.selection = { sequence: 1, target: heroTarget }
    view.rerender(<PreviewHarness onUseComments={onUseComments} onClose={onClose} />)

    const input = screen.getByRole('textbox', { name: '描述网页修改' })
    fireEvent.change(input, { target: { value: '改成主品牌色，移动端占满一行' } })
    expect(onUseComments).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }))
    expect(screen.getByRole('button', { name: '1 条评论' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: /加入输入框/ }))
    expect(onUseComments).toHaveBeenCalledTimes(1)
    expect(onUseComments.mock.calls[0][0]).toContain('CSS 选择器："#hero-cta"')
    expect(onUseComments.mock.calls[0][0]).toContain('改成主品牌色')
    expect(onUseComments.mock.calls[0][0]).not.toContain('截图')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('Escape closes one surface at a time and preserves an unfinished comment', async () => {
    const onClose = vi.fn()
    const view = render(<PreviewHarness onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    previewMock.selection = { sequence: 1, target: heroTarget }
    view.rerender(<PreviewHarness onClose={onClose} />)
    fireEvent.change(screen.getByRole('textbox', { name: '描述网页修改' }), {
      target: { value: '保留这条草稿' },
    })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: '描述网页修改' })).not.toBeInTheDocument()
    expect(screen.getByText('有一条未保存的评论')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: '操作' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    expect(screen.getByRole('textbox', { name: '描述网页修改' })).toHaveValue('保留这条草稿')
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.keyDown(document, { key: 'Escape' })
    // M-07：还有未保存草稿时，最后一层 Esc 不再直接关掉预览，而是先问一句。
    expect(onClose).not.toHaveBeenCalled()
    const confirm = await screen.findByRole('dialog', { name: '关闭网页预览？' })
    expect(confirm).toHaveTextContent('未保存的评论草稿不会保留')
    fireEvent.click(within(confirm).getByRole('button', { name: '仍然关闭' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  test('manages confirmed comments in a non-resident drawer with edit and delete', () => {
    const view = render(<PreviewHarness />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    previewMock.selection = { sequence: 1, target: heroTarget }
    view.rerender(<PreviewHarness />)
    fireEvent.change(screen.getByRole('textbox', { name: '描述网页修改' }), {
      target: { value: '旧评论' },
    })
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }))

    fireEvent.click(screen.getByRole('button', { name: '1 条评论' }))
    const drawer = screen.getByRole('dialog', { name: '网页评论列表' })
    expect(drawer).toContainElement(document.activeElement as HTMLElement)
    fireEvent.click(within(drawer).getByRole('button', { name: /#hero-cta/ }))
    const editor = screen.getByRole('textbox', { name: '描述网页修改' })
    expect(editor).toHaveValue('旧评论')
    fireEvent.change(editor, { target: { value: '更新后的评论' } })
    fireEvent.click(screen.getByRole('button', { name: '保存评论' }))

    fireEvent.click(screen.getByRole('button', { name: '1 条评论' }))
    const reopened = screen.getByRole('dialog', { name: '网页评论列表' })
    expect(within(reopened).getByText('更新后的评论')).toBeInTheDocument()
    fireEvent.click(within(reopened).getByRole('button', { name: '删除评论 1' }))
    expect(within(reopened).getByText(/还没有评论/)).toBeInTheDocument()
    fireEvent.click(within(reopened).getByRole('button', { name: '关闭评论列表' }))
    expect(screen.getByRole('button', { name: /加入输入框/ })).toBeDisabled()
  })

  test('keeps desktop navigation, pointer, wheel, keyboard and explicit text controls wired', () => {
    render(<PreviewHarness />)
    fireEvent.click(screen.getByRole('button', { name: '后退' }))
    fireEvent.click(screen.getByRole('button', { name: '前进' }))
    fireEvent.click(screen.getAllByRole('button', { name: '刷新网页' })[0])

    const canvas = screen.getByLabelText('可交互网页画面')
    setCanvasRect(canvas)
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 320,
      clientY: 200,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 320,
      clientY: 200,
    })
    fireEvent.wheel(canvas, { deltaX: 2, deltaY: 40 })
    fireEvent.keyDown(canvas, { key: 'k', ctrlKey: true })

    expect(previewMock.send).toHaveBeenCalledWith({ type: 'preview.navigate', action: 'back' })
    expect(previewMock.send).toHaveBeenCalledWith({ type: 'preview.navigate', action: 'forward' })
    expect(previewMock.send).toHaveBeenCalledWith({ type: 'preview.navigate', action: 'reload' })
    expect(previewMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'preview.pointer', action: 'down', x: 320, y: 200 }),
    )
    expect(previewMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'preview.pointer', action: 'up', x: 320, y: 200 }),
    )
    expect(previewMock.send).toHaveBeenCalledWith({
      type: 'preview.wheel',
      deltaX: 2,
      deltaY: 40,
    })
    expect(previewMock.send).toHaveBeenCalledWith({ type: 'preview.key', key: 'Control+k' })

    fireEvent.click(screen.getByRole('button', { name: '输入' }))
    const textInput = screen.getByRole('textbox', { name: '输入网页文字' })
    fireEvent.change(textInput, { target: { value: '你好，网页' } })
    fireEvent.compositionStart(textInput)
    fireEvent.submit(textInput.closest('form')!)
    expect(previewMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'preview.text' }),
    )
    fireEvent.compositionEnd(textInput)
    fireEvent.click(screen.getByRole('button', { name: '确认输入网页文字' }))
    expect(previewMock.send).toHaveBeenCalledWith({ type: 'preview.text', text: '你好，网页' })
  })

  test('maps mobile taps to click, drags to scroll, and comment taps to DOM selection', () => {
    render(<PreviewHarness />)
    fireEvent.click(screen.getByRole('button', { name: '移动预览' }))
    let canvas = screen.getByLabelText('可交互网页画面')
    setCanvasRect(canvas, 390, 844)

    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 180,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 1,
      pointerType: 'touch',
      clientX: 120,
      clientY: 180,
    })
    expect(previewMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'preview.pointer', action: 'click', x: 120, y: 180 }),
    )

    fireEvent.pointerDown(canvas, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 120,
      clientY: 220,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 2,
      pointerType: 'touch',
      clientX: 120,
      clientY: 170,
    })
    const dragMessage = previewMock.send.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === 'preview.wheel' && message.deltaY > 90)
    if (!dragMessage || dragMessage.type !== 'preview.wheel') {
      throw new Error('expected a touch drag wheel message')
    }
    expect(dragMessage).toEqual(expect.objectContaining({ type: 'preview.wheel' }))
    expect(dragMessage.deltaY).toBeCloseTo(100)

    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    canvas = screen.getByLabelText('网页画面，点按选择评论元素')
    setCanvasRect(canvas, 390, 844)
    fireEvent.pointerDown(canvas, {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 200,
      clientY: 300,
    })
    fireEvent.pointerUp(canvas, {
      pointerId: 3,
      pointerType: 'touch',
      clientX: 200,
      clientY: 300,
    })
    const selectMessage = previewMock.send.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === 'preview.select')
    if (!selectMessage || selectMessage.type !== 'preview.select') {
      throw new Error('expected a comment-mode select message')
    }
    expect(selectMessage.x).toBeCloseTo(200)
    expect(selectMessage.y).toBeCloseTo(300)
  })

  test('re-resolves confirmed and unfinished selectors after navigation without reviving deleted comments', () => {
    const view = render(<PreviewHarness />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    previewMock.selection = { sequence: 1, target: heroTarget }
    view.rerender(<PreviewHarness />)
    fireEvent.change(screen.getByRole('textbox', { name: '描述网页修改' }), {
      target: { value: '保留按钮' },
    })
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }))

    previewMock.selection = { sequence: 2, target: cardTarget }
    view.rerender(<PreviewHarness />)
    fireEvent.change(screen.getByRole('textbox', { name: '描述网页修改' }), {
      target: { value: '未保存的卡片草稿' },
    })
    previewMock.send.mockClear()
    previewMock.navigation = {
      sequence: 2,
      url: 'http://localhost:3000/features',
      title: 'Features',
      pageRevision: 2,
    }
    view.rerender(<PreviewHarness />)

    expect(previewMock.send).toHaveBeenCalledWith({
      type: 'preview.resolve',
      selector: '#hero-cta',
    })
    expect(previewMock.send).toHaveBeenCalledWith({
      type: 'preview.resolve',
      selector: '.feature-card:first-child',
    })

    fireEvent.click(screen.getByRole('button', { name: '收起评论编辑器' }))
    fireEvent.click(screen.getByRole('button', { name: '1 条评论' }))
    fireEvent.click(screen.getByRole('button', { name: '删除评论 1' }))
    previewMock.resolved = { sequence: 3, selector: '#hero-cta', target: heroTarget }
    view.rerender(<PreviewHarness />)
    expect(screen.getByText(/还没有评论/)).toBeInTheDocument()
  })

  test('disables protocol actions while loading and presents retryable errors without raw trace chrome', () => {
    previewMock.phase = 'loading'
    previewMock.ready = null
    previewMock.navigation = null
    const view = render(<PreviewHarness />)
    expect(screen.getByRole('button', { name: '评论' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '后退' })).toBeDisabled()
    // M-20：加载期只保留画布中央那一句，状态胶囊不再同屏重复。
    expect(screen.getByText('正在加载网页')).toBeInTheDocument()
    expect(document.querySelector('.preview-status-pill')).toBeNull()

    previewMock.phase = 'closed'
    previewMock.error = {
      message: 'Protocol error: socket 1006 at internal stack line 42',
      retryable: true,
    }
    view.rerender(<PreviewHarness />)
    expect(screen.getByRole('alert')).toHaveTextContent('无法连接网页预览')
    expect(screen.getByText('诊断详情')).toBeInTheDocument()
    const before = previewMock.calls.at(-1)?.reconnectKey ?? 0
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    expect(previewMock.calls.at(-1)?.reconnectKey).toBe(before + 1)
  })

  test('shows the status pill only once the page is ready', () => {
    render(<PreviewHarness />)
    const pill = document.querySelector('.preview-status-pill')
    expect(pill).not.toBeNull()
    expect(pill).toHaveTextContent('实时预览')
  })
})

/** 危险操作先弹确认层：在指定标题的对话框里点某个按钮。 */
async function confirmIn(dialogName: string, action: string | RegExp) {
  const dialog = await screen.findByRole('dialog', { name: dialogName })
  fireEvent.click(within(dialog).getByRole('button', { name: action }))
}

/** 模拟远端回了一次元素选中，然后把评论写好并确认。`rerender` 每次都要造新元素，否则 React 会跳过重渲。 */
function addComment(rerender: () => void, target: Target, text: string) {
  previewMock.selection = { sequence: (previewMock.selection?.sequence ?? 0) + 1, target }
  rerender()
  fireEvent.change(screen.getByRole('textbox', { name: '描述网页修改' }), {
    target: { value: text },
  })
  fireEvent.click(screen.getByRole('button', { name: '添加评论' }))
}

/** 与组件里 VIEWPORT_REFIT_DEBOUNCE_MS 一致：视口变化防抖 300ms 后才重新适配。 */
const VIEWPORT_REFIT_WAIT = 300

describe('ContainerWebPreview audit fixes', () => {
  test('M-07: Escape on the focused canvas goes to the remote page instead of closing the preview', () => {
    const onClose = vi.fn()
    render(<PreviewHarness onClose={onClose} />)
    const canvas = screen.getByLabelText('可交互网页画面')
    canvas.focus()
    expect(canvas).toHaveFocus()

    fireEvent.keyDown(canvas, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '关闭网页预览？' })).not.toBeInTheDocument()
    expect(previewMock.send).toHaveBeenCalledWith({ type: 'preview.key', key: 'Escape' })

    // 焦点不在画面上（在关闭钮上）时 Esc 才是「关闭预览」；没有评论就直接关。
    screen.getByRole('button', { name: '关闭网页预览' }).focus()
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('M-07: closing with confirmed comments asks first and keeps them on "继续评论"', async () => {
    const onClose = vi.fn()
    const view = render(<PreviewHarness onClose={onClose} />)
    const rerender = () => view.rerender(<PreviewHarness onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    addComment(rerender, heroTarget, '按钮改成品牌色')
    addComment(rerender, cardTarget, '卡片加阴影')
    expect(screen.getByRole('button', { name: '2 条评论' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '返回操作网页' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭网页预览' }))
    const dialog = await screen.findByRole('dialog', { name: '关闭网页预览？' })
    expect(dialog).toHaveTextContent('已写的 2 条评论不会保留')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: '继续评论' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '关闭网页预览？' })).not.toBeInTheDocument(),
    )
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    expect(screen.getByRole('button', { name: '2 条评论' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '返回操作网页' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭网页预览' }))
    await confirmIn('关闭网页预览？', '仍然关闭')
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  test('M-08: Tab is left to the browser so keyboard users can leave the canvas', () => {
    render(<PreviewHarness />)
    const canvas = screen.getByLabelText('可交互网页画面')
    canvas.focus()
    previewMock.send.mockClear()

    expect(fireEvent.keyDown(canvas, { key: 'Tab' })).toBe(true)
    expect(fireEvent.keyDown(canvas, { key: 'Tab', shiftKey: true })).toBe(true)
    expect(previewMock.send).not.toHaveBeenCalled()
    expect(canvas).toHaveAccessibleDescription(/按 Tab 离开画面/)

    // 其余快捷键仍然转发（且拦掉浏览器默认行为）。
    expect(fireEvent.keyDown(canvas, { key: 'ArrowDown' })).toBe(false)
    expect(previewMock.send).toHaveBeenCalledWith({ type: 'preview.key', key: 'ArrowDown' })
  })

  test('M-09: touch drags scroll incrementally while moving and never turn into a click', () => {
    let clock = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100))
    try {
      render(<PreviewHarness />)
      fireEvent.click(screen.getByRole('button', { name: '移动预览' }))
      const canvas = screen.getByLabelText('可交互网页画面')
      setCanvasRect(canvas, 390, 844)
      previewMock.send.mockClear()

      const touch = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', y: number) =>
        fireEvent[type](canvas, { pointerId: 7, pointerType: 'touch', clientX: 120, clientY: y })
      touch('pointerDown', 220)
      touch('pointerMove', 216) // 4px：还在点按容差内，不滚
      expect(previewMock.send).not.toHaveBeenCalled()
      touch('pointerMove', 200)
      touch('pointerMove', 180)
      touch('pointerUp', 160)

      const messages = previewMock.send.mock.calls.map(([message]) => message)
      const wheels = messages.filter((message) => message.type === 'preview.wheel')
      expect(wheels.length).toBeGreaterThanOrEqual(3)
      expect(messages.some((message) => message.type === 'preview.pointer')).toBe(false)
      const total = wheels.reduce(
        (sum, message) => sum + (message.type === 'preview.wheel' ? message.deltaY : 0),
        0,
      )
      expect(total).toBeCloseTo((220 - 160) * 2)
      expect(
        wheels.every((message) => message.type === 'preview.wheel' && message.deltaX === 0),
      ).toBe(true)

      // 抬手前没有滑动过：还是一次点按。
      previewMock.send.mockClear()
      touch('pointerDown', 300)
      touch('pointerUp', 300)
      expect(previewMock.send).toHaveBeenCalledTimes(1)
      expect(previewMock.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'preview.pointer', action: 'click', x: 120, y: 300 }),
      )

      // 评论模式下滑动也是滚动，不会误触发元素识别。
      fireEvent.click(screen.getByRole('button', { name: '评论' }))
      const commentCanvas = screen.getByLabelText('网页画面，点按选择评论元素')
      setCanvasRect(commentCanvas, 390, 844)
      previewMock.send.mockClear()
      fireEvent.pointerDown(commentCanvas, {
        pointerId: 8,
        pointerType: 'touch',
        clientX: 100,
        clientY: 400,
      })
      fireEvent.pointerMove(commentCanvas, {
        pointerId: 8,
        pointerType: 'touch',
        clientX: 100,
        clientY: 340,
      })
      fireEvent.pointerUp(commentCanvas, {
        pointerId: 8,
        pointerType: 'touch',
        clientX: 100,
        clientY: 320,
      })
      const commentMessages = previewMock.send.mock.calls.map(([message]) => message)
      expect(commentMessages.some((message) => message.type === 'preview.select')).toBe(false)
      expect(commentMessages.filter((message) => message.type === 'preview.wheel')).toHaveLength(2)
    } finally {
      now.mockRestore()
    }
  })

  test('M-10: the canvas letterboxes instead of stretching and maps pointer coordinates to the visible frame', () => {
    render(<PreviewHarness />)
    const canvas = screen.getByLabelText('可交互网页画面')
    expect(canvas).toHaveClass('object-contain')
    expect(canvas).not.toHaveClass('object-fill')

    // 远端 1280×800 画在 800×800 的元素里：等比缩到 800×500，上下各留 150px 黑边。
    setCanvasRect(canvas, 800, 800)
    previewMock.send.mockClear()
    fireEvent.pointerDown(canvas, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 400,
      clientY: 400,
    })
    expect(previewMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'preview.pointer', action: 'down', x: 640, y: 400 }),
    )
    fireEvent.pointerUp(canvas, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: 0,
      clientY: 100, // 黑边里：夹到画面顶边
    })
    expect(previewMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'preview.pointer', action: 'up', x: 0, y: 0 }),
    )
  })

  test('M-10: large client viewport changes refit the remote viewport, small ones do not', () => {
    vi.useFakeTimers()
    setClientViewport(1280, 800)
    render(<PreviewHarness />)
    expect(previewMock.calls.at(-1)?.viewport).toMatchObject({ width: 1280, height: 800 })
    const callsBefore = previewMock.calls.length

    // 高度变了 12.5%（< 15%）：不重连，交给 object-contain 的黑边吸收。
    setClientViewport(1280, 900)
    fireEvent(window, new Event('resize'))
    act(() => vi.advanceTimersByTime(VIEWPORT_REFIT_WAIT))
    expect(previewMock.calls.length).toBe(callsBefore)

    // 宽度变了 25%：防抖后重新量一次，viewport 跟着变。
    setClientViewport(1600, 900)
    fireEvent(window, new Event('resize'))
    fireEvent(window, new Event('resize'))
    act(() => vi.advanceTimersByTime(VIEWPORT_REFIT_WAIT - 100))
    expect(previewMock.calls.at(-1)?.viewport).toMatchObject({ width: 1280, height: 800 })
    act(() => vi.advanceTimersByTime(100))
    expect(previewMock.calls.at(-1)?.viewport).toMatchObject({
      isMobile: false,
      width: 1600,
      height: 900,
    })

    // 翻到移动端断点（旋转 / 收窄）：设备档一起切换。
    setClientViewport(390, 844)
    fireEvent(window, new Event('orientationchange'))
    act(() => vi.advanceTimersByTime(VIEWPORT_REFIT_WAIT))
    expect(previewMock.calls.at(-1)?.viewport).toMatchObject({
      isMobile: true,
      width: 390,
      height: 844,
    })
    expect(screen.getByRole('button', { name: '移动预览' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('M-10: a manually chosen simulator device does not follow client viewport changes', () => {
    vi.useFakeTimers()
    setClientViewport(1280, 800)
    render(<PreviewHarness />)
    fireEvent.click(screen.getByRole('button', { name: '移动预览' }))
    expect(previewMock.calls.at(-1)?.viewport).toMatchObject({ isMobile: true, width: 390 })
    const callsBefore = previewMock.calls.length

    setClientViewport(1920, 1080)
    fireEvent(window, new Event('resize'))
    act(() => vi.advanceTimersByTime(VIEWPORT_REFIT_WAIT))
    expect(previewMock.calls.length).toBe(callsBefore)
    expect(previewMock.calls.at(-1)?.viewport).toMatchObject({ isMobile: true, width: 390 })
  })

  test('M-19: a clean disconnect is worded differently from a connection failure', () => {
    previewMock.phase = 'closed'
    previewMock.ready = null
    previewMock.error = null
    const view = render(<PreviewHarness />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('连接已断开')
    expect(alert).toHaveTextContent('重新连接即可继续')
    expect(alert).not.toHaveTextContent('无法连接网页预览')
    expect(screen.getByRole('button', { name: '重新连接' })).toBeInTheDocument()
    const summary = screen.getByText('诊断详情')
    expect(summary).toHaveClass('text-meta')
    expect(summary).toHaveStyle({ minHeight: '44px' })

    previewMock.error = { message: 'ticket rejected', retryable: false }
    view.rerender(<PreviewHarness />)
    expect(screen.getByRole('alert')).toHaveTextContent('无法连接网页预览')
    expect(screen.queryByRole('button', { name: '重新连接' })).not.toBeInTheDocument()
  })

  test('M-20: the narrow-screen submit label says 加入, not 完成', () => {
    render(<PreviewHarness />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    const submit = screen.getByRole('button', { name: /加入输入框/ })
    expect(submit).toHaveTextContent('加入')
    expect(submit).not.toHaveTextContent('完成')
  })

  test('M-21: ⌘/Ctrl+Enter saves the comment draft; plain Enter does not', () => {
    const view = render(<PreviewHarness />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    previewMock.selection = { sequence: 1, target: heroTarget }
    view.rerender(<PreviewHarness />)
    const input = screen.getByRole('textbox', { name: '描述网页修改' })

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true }) // 空草稿：不保存
    expect(screen.getByRole('button', { name: '0 条评论' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '描述网页修改' })).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '改成品牌色' } })
    fireEvent.keyDown(input, { key: 'Enter' }) // 普通 Enter 仍是换行，不保存
    expect(screen.getByRole('button', { name: '0 条评论' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '描述网页修改' })).toHaveValue('改成品牌色')

    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(screen.getByRole('button', { name: '1 条评论' })).toBeEnabled()
    expect(screen.queryByRole('textbox', { name: '描述网页修改' })).not.toBeInTheDocument()

    previewMock.selection = { sequence: 2, target: cardTarget }
    view.rerender(<PreviewHarness />)
    const second = screen.getByRole('textbox', { name: '描述网页修改' })
    fireEvent.change(second, { target: { value: '卡片加阴影' } })
    fireEvent.keyDown(second, { key: 'Enter', metaKey: true })
    expect(screen.getByRole('button', { name: '2 条评论' })).toBeEnabled()
  })

  test('M-21: repeating the same live announcement still changes the live region text', () => {
    render(<PreviewHarness />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    const canvas = screen.getByLabelText('网页画面，点按选择评论元素')
    setCanvasRect(canvas)
    const live = document.querySelector('output.sr-only')
    if (!live) throw new Error('expected the sr-only live region')

    const tap = (id: number) => {
      fireEvent.pointerDown(canvas, {
        pointerId: id,
        pointerType: 'mouse',
        clientX: 200,
        clientY: 300,
      })
      fireEvent.pointerUp(canvas, {
        pointerId: id,
        pointerType: 'mouse',
        clientX: 200,
        clientY: 300,
      })
    }
    tap(1)
    const first = live.textContent
    expect(first).toContain('正在识别网页元素')
    tap(2)
    const second = live.textContent
    expect(second).toContain('正在识别网页元素')
    expect(second).not.toBe(first)
  })

  test('M-22: moving the mouse brings the auto-hidden controls back; touch moves do not', () => {
    vi.useFakeTimers()
    setClientViewport(390, 844)
    render(<PreviewHarness />)
    const canvas = screen.getByLabelText('可交互网页画面')
    canvas.focus()
    act(() => vi.advanceTimersByTime(3_001))
    expect(screen.queryByRole('button', { name: '关闭网页预览' })).not.toBeInTheDocument()

    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10 })
    expect(screen.queryByRole('button', { name: '关闭网页预览' })).not.toBeInTheDocument()

    fireEvent.pointerMove(canvas, { pointerId: 2, pointerType: 'mouse', clientX: 10, clientY: 10 })
    expect(screen.getByRole('button', { name: '关闭网页预览' })).toBeInTheDocument()

    // 鼠标停下来后照旧 3s 收起。
    act(() => vi.advanceTimersByTime(3_001))
    expect(screen.queryByRole('button', { name: '关闭网页预览' })).not.toBeInTheDocument()
  })
})
