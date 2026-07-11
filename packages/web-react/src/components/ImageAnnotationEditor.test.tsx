import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import {
  BRUSH_MAX,
  BRUSH_MIN,
  BrushSlider,
  ImageAnnotationEditor,
  normalizeImageSourceForGateway,
} from './ImageAnnotationEditor'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// jsdom 未实现 pointer capture,先补 no-op(否则 canvas/slider 的 setPointerCapture 抛错)。
function ensurePointerCapture() {
  for (const m of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture'] as const) {
    if (!(m in Element.prototype)) {
      Object.defineProperty(Element.prototype, m, { value: () => {}, configurable: true, writable: true })
    }
  }
}

describe('ImageAnnotationEditor source normalization', () => {
  test('browser-decodable HEIC is converted to PNG before upload', async () => {
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['normalized'], { type: 'image/png' }))
    })

    const source = new Blob(['heic'], { type: 'image/heic' })
    const result = await normalizeImageSourceForGateway(source, {
      naturalWidth: 3024,
      naturalHeight: 4032,
    })

    expect(result.type).toBe('image/png')
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 3024, 4032)
  })

  test('PNG/JPEG/WebP sources keep their original bytes', async () => {
    const source = new Blob(['jpeg'], { type: 'image/jpeg' })
    await expect(normalizeImageSourceForGateway(source, {
      naturalWidth: 10,
      naturalHeight: 10,
    })).resolves.toBe(source)
  })
})

// ── 需求 §3:笔刷滑杆完整拖动交互(pointerdown+move 连续跟手 + 数值气泡 + 键盘微调)。 ──
describe('BrushSlider 拖动(需求 §3)', () => {
  function Harness() {
    const [v, setV] = useState(48)
    return (
      <div>
        <BrushSlider value={v} onChange={setV} />
        <span data-testid="val">{v}</span>
      </div>
    )
  }

  test('pointerdown+move 连续调节,拖点跟手(鼠标),拖动时显示数值气泡', () => {
    ensurePointerCapture()
    // 轨道:top=100,height=200 → 顶部(y=100)=最粗,底部(y=300)=最细。
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 100, left: 0, height: 200, width: 44, right: 44, bottom: 300, x: 0, y: 100,
      toJSON() {},
    } as DOMRect)

    render(<Harness />)
    const slider = screen.getByRole('slider', { name: '画笔粗细' })

    // 顶端 = 最粗
    fireEvent.pointerDown(slider, { clientY: 100, pointerType: 'mouse', button: 0, pointerId: 1 })
    expect(screen.getByTestId('val').textContent).toBe(String(BRUSH_MAX))

    // 拖到中点 ≈ 中值,气泡显示当前值(跟手)
    fireEvent.pointerMove(slider, { clientY: 200, pointerId: 1 })
    const mid = Math.round(BRUSH_MIN + 0.5 * (BRUSH_MAX - BRUSH_MIN))
    expect(screen.getByTestId('val').textContent).toBe(String(mid))
    expect(within(slider).getByText(String(mid))).toBeInTheDocument()

    // 拖到底端 = 最细
    fireEvent.pointerMove(slider, { clientY: 320, pointerId: 1 })
    expect(screen.getByTestId('val').textContent).toBe(String(BRUSH_MIN))

    // 松手后气泡消失
    fireEvent.pointerUp(slider, { pointerId: 1 })
    expect(within(slider).queryByText(String(BRUSH_MIN))).not.toBeInTheDocument()
  })

  test('键盘 ↑/↓ 微调(role=slider 可聚焦操作)', () => {
    render(<Harness />)
    const slider = screen.getByRole('slider', { name: '画笔粗细' })
    fireEvent.keyDown(slider, { key: 'ArrowUp' })
    expect(Number(screen.getByTestId('val').textContent)).toBe(54)
    fireEvent.keyDown(slider, { key: 'ArrowDown' })
    expect(Number(screen.getByTestId('val').textContent)).toBe(48)
  })
})

// ── 编辑器交互(工具收起 §4 / 误触保护 §5 / 桌面鼠标画笔 §1 / Enter 提交 §5)。 ──
function EditorHarness({
  onOpenChange = () => {},
  onSubmit = async () => {},
}: {
  onOpenChange?: (o: boolean) => void
  onSubmit?: (v: unknown) => Promise<void>
}) {
  return (
    <ImageAnnotationEditor
      source={{ url: 'https://signed.test/a.png', name: '海报' }}
      open
      onOpenChange={onOpenChange}
      onSubmit={onSubmit as never}
    />
  )
}

describe('工具选择器自动收起(需求 §4)', () => {
  test('展开选画笔/矩形后菜单自动收起,触发钮回显所选工具', async () => {
    // 取图失败也不影响底栏工具条渲染(工具条在画布区之外)。
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    render(<EditorHarness />)

    const trigger = await screen.findByRole('button', { name: /更多工具/ })
    expect(trigger).toHaveAttribute('aria-label', expect.stringContaining('当前：画笔'))

    fireEvent.click(trigger)
    const rect = screen.getByRole('button', { name: '矩形' })
    expect(rect).toBeInTheDocument()

    // 选矩形 → 菜单收起 + 触发钮回显矩形
    fireEvent.click(rect)
    expect(screen.queryByRole('button', { name: '矩形' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /当前：矩形/ })).toBeInTheDocument()
  })

  test('点击外部区域收起工具菜单', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    render(<EditorHarness />)
    fireEvent.click(await screen.findByRole('button', { name: /更多工具/ }))
    expect(screen.getByRole('button', { name: '套索' })).toBeInTheDocument()
    // 点外部遮罩(aria-hidden 关闭钮)
    const backdrop = document.querySelector('.fixed.inset-0.z-20') as HTMLElement
    fireEvent.click(backdrop)
    expect(screen.queryByRole('button', { name: '套索' })).not.toBeInTheDocument()
  })
})

describe('误触保护确认层(需求 §5)', () => {
  test('有描述时点 X → 弹确认;放弃 → onOpenChange(false)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    const onOpenChange = vi.fn()
    render(<EditorHarness onOpenChange={onOpenChange} />)

    const ta = await screen.findByLabelText('希望怎样修改')
    fireEvent.change(ta, { target: { value: '把背景换成蓝色' } })

    fireEvent.click(screen.getByRole('button', { name: '关闭图片编辑器' }))
    expect(screen.getByRole('alertdialog', { name: '放弃编辑确认' })).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  test('空白(无笔画无描述)点 X → 直接退,不弹确认', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response))
    const onOpenChange = vi.fn()
    render(<EditorHarness onOpenChange={onOpenChange} />)
    fireEvent.click(await screen.findByRole('button', { name: '关闭图片编辑器' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

// 完整取图 + 画布就绪的测试台:mock 2d ctx / Image / createObjectURL。
function stubCanvasPipeline(opts: { selection?: boolean } = {}) {
  const alpha = opts.selection ? 255 : 0
  const ctx = {
    clearRect: vi.fn(), drawImage: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(),
    beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    arc: vi.fn(), fill: vi.fn(), save: vi.fn(), restore: vi.fn(), closePath: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, alpha]) })),
    globalCompositeOperation: '', strokeStyle: '', fillStyle: '',
    lineWidth: 0, lineCap: '', lineJoin: '', imageSmoothingEnabled: false,
    font: '', textAlign: '', textBaseline: '',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) =>
    cb(new Blob(['png'], { type: 'image/png' })),
  )
  ensurePointerCapture()
  if (!URL.createObjectURL) (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => ''
  if (!URL.revokeObjectURL) (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const blob = new Blob(['x'], { type: 'image/png' })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob }) as unknown as Response),
  )
  class FakeImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    naturalWidth = 800
    naturalHeight = 600
    _src = ''
    set src(v: string) {
      this._src = v
      if (v) queueMicrotask(() => this.onload?.())
    }
    get src() {
      return this._src
    }
  }
  vi.stubGlobal('Image', FakeImage)
  return ctx
}

describe('桌面鼠标画笔路径(需求 §1)', () => {
  test('mousedown/mousemove 用画笔在 mask 上落笔(鼠标路径可用)', async () => {
    const ctx = stubCanvasPipeline()
    render(<EditorHarness />)
    // 图片加载完成 → render() 把图画到画布(drawImage 被调过)
    await waitFor(() => expect(ctx.drawImage).toHaveBeenCalled())
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    expect(canvas).toBeTruthy()

    fireEvent.pointerDown(canvas, { pointerType: 'mouse', button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(canvas, { pointerType: 'mouse', pointerId: 1, clientX: 40, clientY: 60 })
    fireEvent.pointerUp(canvas, { pointerType: 'mouse', pointerId: 1 })

    // 画笔调用 stroke → 证明鼠标路径确实在 mask 上落笔(非仅移动端 touch 假设)。
    expect(ctx.stroke).toHaveBeenCalled()
  })

  test('画完 + 填描述 → 桌面 Enter 提交(Shift+Enter 不提交)', async () => {
    stubCanvasPipeline({ selection: true })
    const onSubmit = vi.fn(async () => {})
    render(<EditorHarness onSubmit={onSubmit} />)
    const canvas = await waitFor(() => {
      const c = document.querySelector('canvas')
      if (!c) throw new Error('canvas 未就绪')
      return c as HTMLCanvasElement
    })
    const ta = screen.getByLabelText('希望怎样修改')
    fireEvent.change(ta, { target: { value: '把杯子改成玻璃材质' } })
    // 落一笔(mask 有选区,getImageData alpha>0 → selectionPresent)
    fireEvent.pointerDown(canvas, { pointerType: 'mouse', button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(canvas, { pointerType: 'mouse', pointerId: 1 })

    // 等历史序列化结算(historyPending→false)→「发送」可用(canSubmit)。
    const send = screen.getByRole('button', { name: /发送/ })
    await waitFor(() => expect(send).toBeEnabled())

    // Shift+Enter 不提交
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    // Enter 提交
    fireEvent.keyDown(ta, { key: 'Enter' })
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
  })
})
