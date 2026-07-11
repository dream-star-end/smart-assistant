/**
 * 调整大小模式(ImageResizeMode)行为契约:
 *  - 底部弹出五比例菜单(16:9/4:3/9:16/3:4/1:1)。
 *  - !canSubmit → 选项禁用 + 提示。
 *  - 选择某比例 → 合成 [源图 + guide] 并 onSubmit(mode:'resize' + targetAspect)。
 *  - 渲染失败(图片加载失败)/解析失败(取图字节失败)各有回退。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { ImageResizeMode } from './ImageResizeMode'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const baseProps = {
  src: 'https://signed.test/x.png',
  alt: '风景',
  resolveSrc: vi.fn(async () => 'https://signed.test/x.png'),
  onBack: vi.fn(),
}

/** 桩住 fetch → Image 解码 → canvas 合成管线,让 onSubmit 能真实收到三件套。 */
function stubImagePipeline() {
  const blob = new Blob(['png'], { type: 'image/png' })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob }) as unknown as Response))
  URL.createObjectURL = vi.fn(() => 'blob:mock')
  URL.revokeObjectURL = vi.fn()
  class MockImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 1024
    naturalHeight = 768
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
  } as unknown as CanvasRenderingContext2D
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb: BlobCallback) {
    cb(new Blob(['out'], { type: 'image/png' }))
  })
}

describe('ImageResizeMode', () => {
  test('底部展示五比例菜单', () => {
    render(<ImageResizeMode {...baseProps} canSubmit onSubmit={vi.fn()} />)
    for (const ratio of ['16:9', '4:3', '9:16', '3:4', '1:1']) {
      expect(screen.getByRole('button', { name: new RegExp(ratio.replace(':', '\\:')) })).toBeInTheDocument()
    }
    expect(screen.getByRole('heading', { name: '调整大小' })).toBeInTheDocument()
  })

  test('!canSubmit → 比例选项禁用 + 提示', () => {
    render(<ImageResizeMode {...baseProps} canSubmit={false} onSubmit={vi.fn()} />)
    expect(screen.getByText('当前模型不支持调整大小')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /16:9/ })).toBeDisabled()
  })

  test('选择 16:9 → onSubmit 带 mode:resize 与 targetAspect + 三件资源', async () => {
    stubImagePipeline()
    const onSubmit = vi.fn(async () => {})
    render(<ImageResizeMode {...baseProps} canSubmit onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: /16:9/ }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    const value = onSubmit.mock.calls[0][0]
    expect(value.mode).toBe('resize')
    expect(value.targetAspect).toBe('16:9')
    expect(value.source).toBeInstanceOf(File)
    expect(value.guide).toBeInstanceOf(File)
    expect(value.width).toBe(1024)
    expect(value.height).toBe(768)
    expect(value.clientJobId).toMatch(/^[0-9a-f]{32}$/)
  })

  test('渲染失败:图片 onError → 加载失败回退 + 重试', () => {
    render(<ImageResizeMode {...baseProps} canSubmit onSubmit={vi.fn()} />)
    fireEvent.error(screen.getByAltText('风景'))
    expect(screen.getByText('图片加载失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  test('解析失败:取图字节失败 → 错误提示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 410 }) as unknown as Response))
    const onSubmit = vi.fn(async () => {})
    render(<ImageResizeMode {...baseProps} canSubmit onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole('button', { name: /1:1/ }))
    expect(await screen.findByText(/读取图片失败/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
