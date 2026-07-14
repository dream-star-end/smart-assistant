import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { AuthSession } from '../lib/types'

const previewMock = vi.hoisted(() => ({
  selection: null as null | {
    sequence: number
    target: {
      selector: string
      tag: string
      text: string
      bounds: { x: number; y: number; width: number; height: number }
    }
  },
  send: vi.fn(() => true),
  calls: [] as Array<{ viewport: { isMobile: boolean; width: number; height: number } }>,
}))

vi.mock('../hooks/useContainerPreview', () => ({
  useContainerPreview: (input: {
    viewport: { isMobile: boolean; width: number; height: number }
  }) => {
    previewMock.calls.push(input)
    return {
      phase: 'ready',
      error: null,
      ready: {
        url: 'http://localhost:3000/',
        title: 'Demo app',
        viewport: input.viewport,
      },
      selection: previewMock.selection,
      resolved: null,
      navigation: {
        sequence: 1,
        url: 'http://localhost:3000/',
        title: 'Demo app',
        pageRevision: 1,
      },
      send: previewMock.send,
    }
  },
}))

import { ContainerWebPreview } from './ContainerWebPreview'

const auth: AuthSession = {
  getToken: () => 'token',
  setToken: () => {},
  onExpired: () => {},
}

afterEach(cleanup)

beforeEach(() => {
  previewMock.selection = null
  previewMock.send.mockClear()
  previewMock.calls.length = 0
})

describe('ContainerWebPreview', () => {
  test('switches to a true mobile viewport and preserves touch-sized controls', () => {
    render(
      <ContainerWebPreview
        open
        sourceUrl="http://localhost:3000/"
        auth={auth}
        onClose={() => {}}
        onUseComments={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '移动预览' }))
    const last = previewMock.calls.at(-1)?.viewport
    expect(last).toMatchObject({ isMobile: true, width: 390, height: 844 })
    expect(screen.getByRole('button', { name: '添加到对话输入框' })).toBeDisabled()
  })

  test('turns a selected DOM element and comment into an editable chat prompt', () => {
    const onUseComments = vi.fn()
    const view = render(
      <ContainerWebPreview
        open
        sourceUrl="http://localhost:3000/"
        auth={auth}
        onClose={() => {}}
        onUseComments={onUseComments}
      />,
    )
    previewMock.selection = {
      sequence: 1,
      target: {
        selector: '#hero-cta',
        tag: 'button',
        text: '开始使用',
        bounds: { x: 100, y: 120, width: 180, height: 44 },
      },
    }
    view.rerender(
      <ContainerWebPreview
        open
        sourceUrl="http://localhost:3000/"
        auth={auth}
        onClose={() => {}}
        onUseComments={onUseComments}
      />,
    )

    const input = screen.getByPlaceholderText(/按钮改成品牌蓝色/)
    fireEvent.change(input, { target: { value: '改成主品牌色，移动端占满一行' } })
    fireEvent.click(screen.getByRole('button', { name: '添加评论' }))
    fireEvent.click(screen.getByRole('button', { name: '添加到对话输入框' }))

    expect(onUseComments).toHaveBeenCalledTimes(1)
    expect(onUseComments.mock.calls[0][0]).toContain('CSS 选择器："#hero-cta"')
    expect(onUseComments.mock.calls[0][0]).toContain('改成主品牌色')
  })
})
