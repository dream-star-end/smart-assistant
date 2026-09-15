import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChunkErrorBoundary, isChunkLoadError } from './ChunkErrorBoundary'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Boom({ message }: { message: string }): never {
  throw new Error(message)
}

describe('ChunkErrorBoundary(懒块失效兜底屏,shell 审计 S-09 / S-18)', () => {
  it('stale chunk → 「已发布新版本」alertdialog,唯一出口是走 Button 原语的「刷新」并自动聚焦', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ChunkErrorBoundary>
        <Boom message="Failed to fetch dynamically imported module: /assets/ManageCenter-8f21c0.js" />
      </ChunkErrorBoundary>,
    )
    const dialog = screen.getByRole('alertdialog', { name: '已发布新版本' })
    expect(dialog).toBeInTheDocument()
    const refresh = screen.getByRole('button', { name: '刷新' })
    // 原语的触控靶兜底与焦点环都在类名里
    expect(refresh.className).toContain('[@media(hover:none)]:min-h-11')
    expect(refresh.className).toContain('focus-visible:ring-2')
    expect(document.activeElement).toBe(refresh)
    // 任意字号已收敛到语义档位
    expect(dialog.innerHTML).not.toMatch(/text-\[13px\]/)
  })

  it('通用渲染错误 → 「此页面加载出错」,点刷新触发 location.reload', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload },
    })
    try {
      render(
        <ChunkErrorBoundary>
          <Boom message="Cannot read properties of undefined (reading 'map')" />
        </ChunkErrorBoundary>,
      )
      expect(screen.getByRole('alertdialog', { name: '此页面加载出错' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '刷新' }))
      expect(reload).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })

  it('正常渲染子树(没抛错时不介入)', () => {
    render(
      <ChunkErrorBoundary>
        <div>正文</div>
      </ChunkErrorBoundary>,
    )
    expect(screen.getByText('正文')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('isChunkLoadError 识别各打包器/浏览器的动态导入失败文案', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: x.js'))).toBe(
      true,
    )
    expect(isChunkLoadError(new Error('Loading chunk 12 failed'))).toBe(true)
    const named = new Error('Loading chunk 42 failed')
    named.name = 'ChunkLoadError'
    expect(isChunkLoadError(named)).toBe(true)
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
  })

  it('isChunkLoadError 不把普通运行时错误 / 非 Error 值误判为 chunk 失败', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})
