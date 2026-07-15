import '@testing-library/jest-dom/vitest'
import type { ContainerPreviewClientMessage } from '@openclaude/protocol/containerPreview'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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
    viewport: { isMobile: boolean; width: number; height: number }
    reconnectKey: number
  }>,
}))

vi.mock('../hooks/useContainerPreview', () => ({
  useContainerPreview: (input: {
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
  onClose = () => {},
  onUseComments = () => {},
}: {
  onClose?: () => void
  onUseComments?: (prompt: string) => void
}) {
  return (
    <ContainerWebPreview
      open
      sourceUrl="http://localhost:3000/"
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

afterEach(cleanup)

beforeEach(() => {
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

  test('Escape closes one surface at a time and preserves an unfinished comment', () => {
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
    expect(onClose).toHaveBeenCalledTimes(1)
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
    expect(screen.getAllByText('正在加载网页')).toHaveLength(2)

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
})
