import * as Dialog from '@radix-ui/react-dialog'
import {
  ArrowUp,
  Brush,
  Eraser,
  LassoSelect,
  Loader2,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
  Square,
  Undo2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchImageBlobWithResign, type ResolveSignedSrc } from '../lib/chat/media'
import { downloadPercent } from '../lib/chat/download'
import { getCachedThumbnail } from '../lib/chat/imageBytes'
import { apiErrorMessage } from '../lib/api'
import { cn } from '../lib/utils'

export type ImageAnnotationSource = { url: string; name?: string }
export type ImageAnnotationExport = {
  clientJobId: string
  prompt: string
  source: File
  mask: File
  guide: File
  width: number
  height: number
}

type Tool = 'brush' | 'rect' | 'lasso' | 'erase'
type Point = { x: number; y: number }
type Drawing = { start: Point; last: Point; points: Point[]; snapshot: HTMLCanvasElement }

const DISPLAY_MAX_SIDE = 1600
const HISTORY_LIMIT = 16
const GATEWAY_EDITABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('图片快照创建失败'))),
      'image/png',
    )
  })
}

async function toFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new File([await toBlob(canvas)], name, { type: 'image/png' })
}

/** Safari can decode HEIC even though the server-side Image 2 pipeline only
 * accepts PNG/JPEG/WebP. Normalize any browser-decodable unsupported format
 * before the user starts drawing, so mobile users never finish an edit only
 * to be rejected after uploading three files. */
export async function normalizeImageSourceForGateway(
  blob: Blob,
  image: Pick<HTMLImageElement, 'naturalWidth' | 'naturalHeight'>,
): Promise<Blob> {
  if (GATEWAY_EDITABLE_TYPES.has(blob.type.toLowerCase())) return blob
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器无法转换此图片格式，请先转为 PNG、JPEG 或 WebP')
  ctx.drawImage(image as CanvasImageSource, 0, 0, canvas.width, canvas.height)
  try {
    return await toBlob(canvas)
  } catch {
    throw new Error('此图片格式无法用于圈选修改，请先转为 PNG、JPEG 或 WebP')
  } finally {
    // Release the full-resolution backing store immediately; keeping it until
    // GC is enough to crash memory-constrained iOS Safari on 12 MP photos.
    canvas.width = 1
    canvas.height = 1
  }
}

function canvasPoint(
  event: React.PointerEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement,
): Point {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  }
}

function hasSelection(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
  return false
}

export const BRUSH_MIN = 12
export const BRUSH_MAX = 180

/** 左侧竖直锥形笔刷滑杆(粗上细下)。**完整拖动交互**(需求 §3):pointerdown+move 连续跟手,
 * 鼠标/触摸同一路径(pointer 事件统一),拖动时右侧气泡显示当前粗细;命中区 44px 宽(w-11)。
 * 键盘 ↑/↓/←/→ 微调、Home/End 到端点(role=slider)。此前是原生竖向 <input type=range>
 * (writing-mode:vertical-lr),桌面拖点命中区极窄、拖动不跟手(用户反馈"只能点")—— 换成
 * 自绘可拖滑杆根治。纯 UI:只读写外部 value,拖动态气泡是本地视觉。 */
export function BrushSlider({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  // 顶部=最粗(frac=1),底部=最细(frac=0)。
  const frac = Math.min(1, Math.max(0, (value - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)))

  const setFromClientY = (clientY: number) => {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0) return
    const fromTop = (clientY - rect.top) / rect.height // 0 顶 → 1 底
    const f = Math.min(1, Math.max(0, 1 - fromTop)) // 1 顶(最粗)→ 0 底(最细)
    onChange(Math.round(BRUSH_MIN + f * (BRUSH_MAX - BRUSH_MIN)))
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    draggingRef.current = true
    setDragging(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {}
    setFromClientY(e.clientY)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    setFromClientY(e.clientY)
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next = value
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = value + 6
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = value - 6
    else if (e.key === 'Home') next = BRUSH_MAX
    else if (e.key === 'End') next = BRUSH_MIN
    else return
    e.preventDefault()
    onChange(Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, next)))
  }

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label="画笔粗细"
      aria-valuemin={BRUSH_MIN}
      aria-valuemax={BRUSH_MAX}
      aria-valuenow={value}
      tabIndex={0}
      title={`画笔粗细 ${value}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className="relative flex h-48 w-11 cursor-ns-resize touch-none select-none items-stretch justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-white/70"
    >
      {/* 锥形装饰轨道(粗上细下) */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-2 left-1/2 -translate-x-1/2 bg-white/25"
        style={{ width: '26px', clipPath: 'polygon(0 0, 100% 0, 66% 100%, 34% 100%)' }}
      />
      {/* 拖点圆头(跟手) */}
      <span
        aria-hidden
        className="pointer-events-none absolute left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-black/25 bg-white shadow-float"
        style={{ top: `${(1 - frac) * 100}%` }}
      />
      {/* 拖动态数值气泡 */}
      {dragging && (
        <span
          className="pointer-events-none absolute left-full ml-2 -translate-y-1/2 rounded-md bg-white px-2 py-0.5 text-xs font-semibold tabular-nums text-black shadow-float"
          style={{ top: `${(1 - frac) * 100}%` }}
        >
          {value}
        </span>
      )}
    </div>
  )
}

/** Native-canvas editor shared by desktop and mobile. One pointer draws;
 * two pointers pan/zoom. Undo history is compressed PNG blobs rather than
 * full ImageData frames, keeping large mobile images within a bounded memory
 * envelope. */
export function ImageAnnotationEditor({
  source,
  open,
  onOpenChange,
  onSubmit,
  resolveSrc,
  cacheIdentity,
}: {
  source: ImageAnnotationSource | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (value: ImageAnnotationExport) => Promise<void>
  /**
   * 点击时签名权威:取图 fetch 若被服务端裁决 403/410(签名过期),用它强制重签一次再试
   * (对齐仓内「手势时刻取媒体禁冻结挂载态 URL」铁律)。签名图(聊天缩略图 → 全屏查看器
   * 编辑)必传;本地 objectURL(composer 附件)无过期概念,省略。
   */
  resolveSrc?: ResolveSignedSrc
  /**
   * 字节缓存身份(signPath / `/api/media/<digest>`)。传入即让取原图**零请求复用**查看器/
   * 气泡已下载的字节(共享 LRU 命中),并用已缓存缩略图做加载期即时底图(禁纯白画布)。
   */
  cacheIdentity?: string | null
}) {
  const visibleRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const snapshotRef = useRef<HTMLCanvasElement | null>(null)
  const imageRef = useRef<CanvasImageSource | null>(null)
  const sourceBlobRef = useRef<Blob | null>(null)
  const originalSizeRef = useRef({ width: 0, height: 0 })
  const drawingRef = useRef<Drawing | null>(null)
  const pointersRef = useRef<Map<number, Point>>(new Map())
  const gestureRef = useRef<{
    distance: number
    center: Point
    scale: number
    x: number
    y: number
  } | null>(null)
  const historyRef = useRef<Blob[]>([])
  const redoRef = useRef<Blob[]>([])
  const generationRef = useRef(0)
  const [tool, setTool] = useState<Tool>('brush')
  const [brushSize, setBrushSize] = useState(48)
  const [prompt, setPrompt] = useState('')
  // 发送被点但条件不齐时的引导提示(boss 实测:圈完没写描述,按钮灰着但零解释)。
  const [submitHint, setSubmitHint] = useState<string | null>(null)
  // 「更多工具」下拉:受控开合(需求 §4)——选完工具/点外部/ESC 都要自动收起,原生 <details>
  // 做不到(选后不收、点外部不收),改受控状态。
  const [toolsOpen, setToolsOpen] = useState(false)
  // 误触保护(需求 §5):有未提交笔画/描述时关闭 → 先弹确认层,空白直接退。
  const [confirmClose, setConfirmClose] = useState(false)
  const [loading, setLoading] = useState(false)
  // 取原图进度百分比(null = 未知/无 Content-Length → 转圈而非数字)。
  const [loadPercent, setLoadPercent] = useState<number | null>(null)
  // 加载期即时底图:已缓存缩略图(气泡/查看器已下载)的 objectURL,加载完成前铺在画布上做
  // 模糊底图(禁纯白闪);未命中缓存 → null(退化为深色底 + 转圈)。
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 取图失败(过期/网络/容器冷启)专用态:与 submit 失败(error 底部提示)分开 —— loadError
  // 时画布尚未画上任何东西,必须用**满画布错误面板 + 重试**覆盖,永不留纯白画布(需求 §1)。
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [revision, setRevision] = useState(0)
  const [historyPending, setHistoryPending] = useState(false)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })

  const render = useCallback(() => {
    const canvas = visibleRef.current
    const mask = maskRef.current
    const image = imageRef.current
    if (!canvas || !mask || !image) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    // Tint only the mask on a separate layer. source-in on the already drawn
    // source image would tint the entire canvas.
    const overlay = overlayRef.current ?? document.createElement('canvas')
    overlayRef.current = overlay
    if (overlay.width !== canvas.width) overlay.width = canvas.width
    if (overlay.height !== canvas.height) overlay.height = canvas.height
    const overlayCtx = overlay.getContext('2d')
    if (!overlayCtx) return
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
    overlayCtx.globalCompositeOperation = 'source-over'
    overlayCtx.drawImage(mask, 0, 0)
    overlayCtx.globalCompositeOperation = 'source-in'
    // 半透明蓝覆盖(对齐参考图选区视觉)。仅改显示层 tint 颜色,不影响 submit() 从
    // mask canvas alpha 另建的二值 mask —— 选区/上传管线字节保真。
    overlayCtx.fillStyle = 'rgba(56,132,255,.42)'
    overlayCtx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(overlay, 0, 0)
  }, [])

  useEffect(() => {
    if (!open || !source) return
    let cancelled = false
    setLoading(true)
    setLoadPercent(null)
    setHistoryPending(false)
    setError(null)
    setLoadError(null)
    setPrompt('')
    setToolsOpen(false)
    setConfirmClose(false)
    setView({ scale: 1, x: 0, y: 0 })
    historyRef.current = []
    redoRef.current = []
    const generation = ++generationRef.current
    // 取字节收口到 fetchImageBlobWithResign:cacheIdentity 命中共享 LRU 即**零请求复用**查看器/
    // 气泡已下载的原图;miss 走流式 + onProgress 汇报百分比;403/410 强制重签一次再试(过期自愈)。
    void fetchImageBlobWithResign(source.url, resolveSrc, {
      cacheIdentity,
      onProgress: (loaded, total) => {
        if (!cancelled) setLoadPercent(downloadPercent(loaded, total))
      },
    })
      .then(async (blob) => {
        const url = URL.createObjectURL(blob)
        try {
          const image = new Image()
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve()
            image.onerror = () => reject(new Error('图片解码失败'))
            image.src = url
          })
          if (cancelled || generation !== generationRef.current) return
          if (image.naturalWidth * image.naturalHeight > 16_777_216) {
            throw new Error('图片超过 1670 万像素，请先缩小后再编辑')
          }
          const editableBlob = await normalizeImageSourceForGateway(blob, image)
          if (cancelled || generation !== generationRef.current) return
          sourceBlobRef.current = editableBlob
          originalSizeRef.current = { width: image.naturalWidth, height: image.naturalHeight }
          const ratio = Math.min(1, DISPLAY_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
          const width = Math.max(1, Math.round(image.naturalWidth * ratio))
          const height = Math.max(1, Math.round(image.naturalHeight * ratio))
          const displaySource = document.createElement('canvas')
          displaySource.width = width
          displaySource.height = height
          const displayCtx = displaySource.getContext('2d')
          if (!displayCtx) throw new Error('浏览器不支持图片编辑')
          displayCtx.drawImage(image, 0, 0, width, height)
          image.src = ''
          const canvas = visibleRef.current
          if (!canvas) return
          canvas.width = width
          canvas.height = height
          const mask = document.createElement('canvas')
          mask.width = width
          mask.height = height
          maskRef.current = mask
          const snapshot = document.createElement('canvas')
          snapshot.width = width
          snapshot.height = height
          snapshotRef.current = snapshot
          // Retain only this bounded display bitmap, not the 12–16 MP decoded
          // camera image. The original stays as compressed bytes for upload.
          imageRef.current = displaySource
          render()
          setRevision((v) => v + 1)
        } finally {
          URL.revokeObjectURL(url)
        }
      })
      .catch((err) => !cancelled && setLoadError(apiErrorMessage(err, '图片加载失败')))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
      generationRef.current++
      drawingRef.current = null
      pointersRef.current.clear()
      gestureRef.current = null
      maskRef.current = null
      overlayRef.current = null
      snapshotRef.current = null
      if (imageRef.current instanceof HTMLCanvasElement) {
        imageRef.current.width = 1
        imageRef.current.height = 1
      }
      imageRef.current = null
      sourceBlobRef.current = null
    }
  }, [open, source, render, resolveSrc, reloadKey, cacheIdentity])

  // 加载期即时底图:从共享 LRU 取已缓存缩略图字节(优先高清 1280 → 640)造 objectURL,
  // 铺在加载遮罩里做模糊底图(零请求、禁纯白闪)。未命中 → null。卸载/换图 revoke 防泄漏。
  useEffect(() => {
    if (!open) {
      setThumbUrl(null)
      return
    }
    const thumb = getCachedThumbnail(cacheIdentity)
    if (!thumb) {
      setThumbUrl(null)
      return
    }
    const url = URL.createObjectURL(thumb)
    setThumbUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [open, cacheIdentity])

  const restore = useCallback(
    async (blob: Blob) => {
      const mask = maskRef.current
      const ctx = mask?.getContext('2d')
      if (!mask || !ctx) return
      const bitmap = await createImageBitmap(blob)
      ctx.clearRect(0, 0, mask.width, mask.height)
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      render()
      setRevision((v) => v + 1)
    },
    [render],
  )

  const undo = async () => {
    if (historyPending) return
    const mask = maskRef.current
    const previous = historyRef.current.pop()
    if (!mask || !previous) return
    setHistoryPending(true)
    try {
      redoRef.current.push(await toBlob(mask))
      await restore(previous)
    } finally {
      setHistoryPending(false)
    }
  }

  const redo = async () => {
    if (historyPending) return
    const mask = maskRef.current
    const next = redoRef.current.pop()
    if (!mask || !next) return
    setHistoryPending(true)
    try {
      historyRef.current.push(await toBlob(mask))
      await restore(next)
    } finally {
      setHistoryPending(false)
    }
  }

  const clear = async () => {
    if (historyPending) return
    const mask = maskRef.current
    const ctx = mask?.getContext('2d')
    if (!mask || !ctx) return
    setHistoryPending(true)
    try {
      historyRef.current = [...historyRef.current.slice(-(HISTORY_LIMIT - 1)), await toBlob(mask)]
      redoRef.current = []
      ctx.clearRect(0, 0, mask.width, mask.height)
      render()
      setRevision((v) => v + 1)
    } finally {
      setHistoryPending(false)
    }
  }

  const zoomBy = (factor: number) => {
    setView((current) => ({ ...current, scale: Math.max(1, Math.min(4, current.scale * factor)) }))
  }

  const wheelZoom = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12)
  }

  const stroke = (a: Point, b: Point) => {
    const ctx = maskRef.current?.getContext('2d')
    if (!ctx) return
    ctx.save()
    ctx.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over'
    ctx.strokeStyle = '#fff'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = brushSize
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    ctx.restore()
  }

  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (historyPending) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const canvas = event.currentTarget
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    canvas.setPointerCapture(event.pointerId)
    if (pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()].slice(0, 2) as [Point, Point]
      const drawing = drawingRef.current
      if (drawing) {
        const ctx = maskRef.current?.getContext('2d')
        if (ctx) {
          ctx.clearRect(0, 0, drawing.snapshot.width, drawing.snapshot.height)
          ctx.drawImage(drawing.snapshot, 0, 0)
        }
        drawingRef.current = null
        render()
      }
      gestureRef.current = {
        distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        ...view,
      }
      return
    }
    const mask = maskRef.current
    const ctx = mask?.getContext('2d')
    const snapshot = snapshotRef.current
    if (!mask || !ctx || !snapshot) return
    const snapshotCtx = snapshot.getContext('2d')
    if (!snapshotCtx) return
    snapshotCtx.clearRect(0, 0, snapshot.width, snapshot.height)
    snapshotCtx.drawImage(mask, 0, 0)
    const p = canvasPoint(event, canvas)
    drawingRef.current = {
      start: p,
      last: p,
      points: [p],
      snapshot,
    }
    if (tool === 'brush' || tool === 'erase') stroke(p, { x: p.x + 0.01, y: p.y + 0.01 })
    render()
  }

  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (pointersRef.current.has(event.pointerId))
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (gestureRef.current && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()].slice(0, 2) as [Point, Point]
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const start = gestureRef.current
      setView({
        scale: Math.max(
          1,
          Math.min(4, start.scale * (Math.hypot(b.x - a.x, b.y - a.y) / start.distance)),
        ),
        x: start.x + center.x - start.center.x,
        y: start.y + center.y - start.center.y,
      })
      return
    }
    const drawing = drawingRef.current
    const ctx = maskRef.current?.getContext('2d')
    if (!drawing || !ctx) return
    const p = canvasPoint(event, event.currentTarget)
    if (tool === 'rect') {
      ctx.clearRect(0, 0, drawing.snapshot.width, drawing.snapshot.height)
      ctx.drawImage(drawing.snapshot, 0, 0)
      ctx.fillStyle = '#fff'
      ctx.fillRect(drawing.start.x, drawing.start.y, p.x - drawing.start.x, p.y - drawing.start.y)
    } else if (tool === 'lasso') {
      drawing.points.push(p)
      ctx.clearRect(0, 0, drawing.snapshot.width, drawing.snapshot.height)
      ctx.drawImage(drawing.snapshot, 0, 0)
      ctx.fillStyle = '#fff'
      ctx.beginPath()
      ctx.moveTo(drawing.points[0]!.x, drawing.points[0]!.y)
      for (const point of drawing.points.slice(1)) ctx.lineTo(point.x, point.y)
      ctx.closePath()
      ctx.fill()
    } else {
      stroke(drawing.last, p)
    }
    drawing.last = p
    render()
  }

  const pointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    pointersRef.current.delete(event.pointerId)
    if (pointersRef.current.size < 2) gestureRef.current = null
    const snapshot = drawingRef.current?.snapshot
    drawingRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {}
    if (snapshot) {
      const generation = generationRef.current
      setHistoryPending(true)
      void toBlob(snapshot)
        .then((blob) => {
          if (generation !== generationRef.current) return
          historyRef.current = [...historyRef.current.slice(-(HISTORY_LIMIT - 1)), blob]
          redoRef.current = []
          setRevision((v) => v + 1)
        })
        .finally(() => {
          if (generation === generationRef.current) setHistoryPending(false)
        })
    }
  }

  const selectionPresent = useMemo(() => {
    void revision
    return !!maskRef.current && hasSelection(maskRef.current)
  }, [revision])
  const canSubmit = selectionPresent && prompt.trim().length > 0 && !submitting && !historyPending

  // 脏状态 = 有圈选或有描述。关闭时据此决定「确认弹层 or 直接退」(需求 §5 误触保护)。
  const dirty = selectionPresent || prompt.trim().length > 0
  const requestClose = useCallback(() => {
    if (submitting) return
    if (dirty) setConfirmClose(true)
    else onOpenChange(false)
  }, [submitting, dirty, onOpenChange])

  // Radix onEscapeKeyDown 绑定挂载时闭包(不随 state 重渲刷新),直接读 state 会拿到陈旧的
  // dirty/toolsOpen(如挂载时 dirty=false,画了几笔后 ESC 仍会不弹确认直接退)。用 ref 存最新
  // 快照,ESC 处理读 ref.current(ref 跨渲染稳定)。同 ImageViewer 的做法。
  const escStateRef = useRef({ submitting, toolsOpen, confirmClose, dirty })
  escStateRef.current = { submitting, toolsOpen, confirmClose, dirty }

  // 桌面键盘(需求 §5):Ctrl/Cmd+Z 撤销、Shift+Z 或 Ctrl+Y 重做。输入框内放行给浏览器文本
  // 撤销,不劫持。ESC 由 Radix onEscapeKeyDown 统一处理(尊重弹层层级)。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return
      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        if (e.shiftKey) void redo()
        else void undo()
      } else if (k === 'y') {
        e.preventDefault()
        void redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // undo/redo 读 ref + setState,捕获首帧闭包即可(与本文件既有 effect 同风格)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const submit = async () => {
    const canvas = visibleRef.current
    const mask = maskRef.current
    const image = imageRef.current
    const sourceBlob = sourceBlobRef.current
    const original = originalSizeRef.current
    if (!canvas || !mask || !image || !sourceBlob || !canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const binaryMask = document.createElement('canvas')
      binaryMask.width = mask.width
      binaryMask.height = mask.height
      const bctx = binaryMask.getContext('2d')
      if (!bctx) throw new Error('浏览器不支持图片编辑')
      bctx.fillStyle = '#000'
      bctx.fillRect(0, 0, binaryMask.width, binaryMask.height)
      bctx.imageSmoothingEnabled = false
      bctx.drawImage(mask, 0, 0)
      const [sourceFile, maskFile, guideFile] = await Promise.all([
        Promise.resolve(new File([sourceBlob], source?.name || 'image-edit-source', {
          type: sourceBlob.type || 'image/png',
        })),
        toFile(binaryMask, 'image-edit-mask.png'),
        toFile(canvas, 'image-edit-guide.png'),
      ])
      await onSubmit({
        clientJobId: crypto.randomUUID().replaceAll('-', ''),
        prompt: prompt.trim(),
        source: sourceFile,
        mask: maskFile,
        guide: guideFile,
        width: original.width,
        height: original.height,
      })
      onOpenChange(false)
    } catch (err) {
      setError(apiErrorMessage(err, '提交失败，请重试'))
    } finally {
      setSubmitting(false)
    }
  }

  // 工具元数据(触发钮回显当前工具图标 + 菜单列表共用单一权威)。
  const TOOLS: { value: Tool; label: string; icon: React.ReactNode }[] = [
    { value: 'brush', label: '画笔', icon: <Brush size={18} /> },
    { value: 'rect', label: '矩形', icon: <Square size={18} /> },
    { value: 'lasso', label: '套索', icon: <LassoSelect size={18} /> },
    { value: 'erase', label: '橡皮', icon: <Eraser size={18} /> },
  ]
  const activeTool = TOOLS.find((t) => t.value === tool) ?? TOOLS[0]!

  const ToolButton = ({
    value,
    label,
    icon,
  }: { value: Tool; label: string; icon: React.ReactNode }) => (
    <button
      type="button"
      // 选完自动收起菜单(需求 §4)。
      onClick={() => {
        setTool(value)
        setToolsOpen(false)
      }}
      aria-pressed={tool === value}
      className={cn(
        'flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-medium',
        tool === value ? 'bg-white text-black' : 'text-white hover:bg-white/10',
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  )

  const RoundBtn = ({
    label,
    icon,
    onClick,
    disabled,
  }: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean }) => (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-11 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20 disabled:opacity-35"
    >
      {icon}
    </button>
  )

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-x-0 z-[70] bg-black/95 backdrop-blur-sm"
          style={{ top: 'var(--oc-visual-offset-top, 0px)', height: 'var(--oc-visual-height, 100dvh)' }}
        />
        <Dialog.Content
          aria-describedby="image-edit-help"
          className="fixed inset-x-0 top-[var(--oc-visual-offset-top,0px)] z-[71] flex h-[var(--oc-visual-height,100dvh)] min-h-0 select-none flex-col bg-black text-white outline-none"
          // ESC 逐层退出 + 误触保护(需求 §5):菜单 → 确认层 → 脏则弹确认 → 干净才退。
          // 全程接管,不放行 Radix 直接关(否则脏状态会被直接丢弃)。
          onEscapeKeyDown={(e) => {
            e.preventDefault()
            const s = escStateRef.current // 读 ref:非闭包 state(Radix 绑定挂载时闭包会陈旧)。
            if (s.submitting) return
            if (s.toolsOpen) setToolsOpen(false)
            else if (s.confirmClose) setConfirmClose(false)
            else if (s.dirty) setConfirmClose(true)
            else onOpenChange(false)
          }}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          {/* 顶栏:X | 已选中区域/圈选要修改的区域(居中) | 发送 */}
          <header className="relative flex min-h-14 shrink-0 items-center justify-between gap-3 px-3 pt-[env(safe-area-inset-top)]">
            <button
              type="button"
              aria-label="关闭图片编辑器"
              title="关闭 (Esc)"
              // 走 requestClose:脏状态先弹确认,空白直接退(需求 §5)。
              onClick={requestClose}
              className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
            >
              <X size={20} />
            </button>
            <div className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center pt-[env(safe-area-inset-top)]">
              <Dialog.Title className="text-sm font-semibold">
                {selectionPresent ? '已选中区域' : '圈选要修改的区域'}
              </Dialog.Title>
              <span className="text-[11px] text-white/60">Image 2 · 每张 50 积分</span>
            </div>
            <button
              type="button"
              aria-disabled={!canSubmit}
              onClick={() => {
                if (canSubmit) {
                  void submit()
                  return
                }
                if (submitting || historyPending) return
                // 缺什么提示什么,并把光标送到缺失处(disabled 会吞点击,故用 aria-disabled+守卫)。
                if (!selectionPresent) {
                  setSubmitHint('请先在图片上圈选要修改的区域')
                } else {
                  setSubmitHint('请先描述想要的修改')
                  document.getElementById('image-edit-prompt')?.focus()
                }
              }}
              className={cn(
                'flex min-h-10 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-black transition-opacity hover:opacity-90',
                !canSubmit && 'cursor-not-allowed opacity-40',
              )}
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> 提交…
                </>
              ) : (
                <>
                  发送 <ArrowUp size={16} />
                </>
              )}
            </button>
          </header>
          {/* 画布区:左侧竖直笔刷滑杆 + 居中画布 */}
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-3 py-2">
            {loading && (
              <div className="absolute inset-0 z-20 overflow-hidden">
                {/* 已缓存缩略图做模糊底图(零请求、禁纯白闪);未命中缓存则退化为纯深色底。 */}
                {thumbUrl && (
                  <img
                    src={thumbUrl}
                    alt=""
                    aria-hidden
                    className="absolute inset-0 h-full w-full object-contain opacity-30 blur-[1px]"
                  />
                )}
                {/* 顶部细进度条:有百分比时按比例增长(无 Content-Length → 只转圈)。 */}
                {loadPercent != null && (
                  <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-white/10">
                    <div
                      className="h-full bg-white/80 transition-[width] duration-200"
                      style={{ width: `${loadPercent}%` }}
                    />
                  </div>
                )}
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-white/80">
                  <Loader2 className="animate-spin" />
                  <span className="text-sm tabular-nums">
                    {loadPercent != null ? `${loadPercent}%` : '正在打开图片…'}
                  </span>
                </div>
              </div>
            )}
            {/* 取图失败 → 满画布错误面板(覆盖白底画布)+ 重试;永不留纯白画布(需求 §1)。 */}
            {loadError && !loading && (
              <div
                role="alert"
                className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 px-6 text-center"
              >
                <p className="max-w-xs text-sm text-white/85">{loadError}</p>
                <button
                  type="button"
                  onClick={() => {
                    setLoadError(null)
                    setReloadKey((k) => k + 1)
                  }}
                  className="flex min-h-10 items-center gap-1.5 rounded-full bg-white/10 px-4 text-sm font-medium text-white transition-colors hover:bg-white/20"
                >
                  <RotateCcw size={16} /> 重试
                </button>
              </div>
            )}
            <div className="absolute left-2 top-1/2 z-10 -translate-y-1/2">
              <BrushSlider value={brushSize} onChange={setBrushSize} />
            </div>
            <canvas
              ref={visibleRef}
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerUp}
              onPointerCancel={pointerUp}
              onWheel={wheelZoom}
              aria-busy={historyPending}
              className="max-h-full max-w-full origin-center rounded-lg bg-neutral-900 object-contain shadow-float [touch-action:none]"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            />
          </div>
          {/* 底栏:提示词输入条 + 居中撤销/重做 + 更多工具/缩放(次级) */}
          <div className="flex shrink-0 flex-col gap-2 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1">
            {error && (
              <p role="alert" className="mx-auto max-w-2xl rounded-lg bg-danger/25 px-3 py-1.5 text-center text-sm text-white">
                {error}
              </p>
            )}
            {submitHint && (
              <p role="status" className="mx-auto w-full max-w-2xl text-center text-[13px] text-amber-300">
                {submitHint}
              </p>
            )}
            <div className="mx-auto flex w-full max-w-2xl items-end gap-2 rounded-2xl bg-white/10 px-3 py-2 backdrop-blur">
              <textarea
                id="image-edit-prompt"
                aria-label="希望怎样修改"
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  setSubmitHint(null)
                }}
                // 桌面 Enter 提交、Shift+Enter 换行(需求 §5)。
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (canSubmit) void submit()
                  }
                }}
                rows={1}
                maxLength={1200}
                placeholder="描述想要的修改，例如：把杯子改成透明玻璃材质"
                className="max-h-28 min-h-[1.5rem] w-full resize-none bg-transparent text-base leading-relaxed text-white outline-none placeholder:text-white/40"
              />
            </div>
            <p id="image-edit-help" className="sr-only">
              只重绘圈选的区域；未圈选部分按原图像素保留。手机可双指缩放、移动画布。每张 50 积分。
            </p>
            <div className="mx-auto flex w-full max-w-2xl items-center justify-center gap-2">
              {/* 次级:矩形/套索/橡皮/清空收进「更多工具」——受控开合(需求 §4):选完/点外部/ESC
                  都自动收起(原生 <details> 做不到);触发钮回显当前工具图标,收起后仍看得出选了谁。 */}
              <div className="relative">
                <button
                  type="button"
                  aria-label={`更多工具，当前：${activeTool.label}`}
                  aria-expanded={toolsOpen}
                  title={`更多工具 · 当前：${activeTool.label}`}
                  onClick={() => setToolsOpen((v) => !v)}
                  className={cn(
                    'flex size-11 items-center justify-center rounded-full backdrop-blur transition-colors',
                    toolsOpen ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20',
                  )}
                >
                  {activeTool.icon}
                </button>
                {toolsOpen && (
                  <>
                    {/* 点外部关闭(需求 §4/§5 统一点外关) */}
                    <button
                      type="button"
                      aria-hidden
                      tabIndex={-1}
                      className="fixed inset-0 z-20 cursor-default"
                      onClick={() => setToolsOpen(false)}
                    />
                    <div className="absolute bottom-14 left-0 z-30 flex w-40 flex-col gap-1 rounded-2xl bg-neutral-900/95 p-2 text-white shadow-float backdrop-blur">
                      {TOOLS.map((t) => (
                        <ToolButton key={t.value} value={t.value} label={t.label} icon={t.icon} />
                      ))}
                      <button
                        type="button"
                        disabled={historyPending}
                        onClick={() => {
                          setToolsOpen(false)
                          void clear()
                        }}
                        className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-white hover:bg-white/10 disabled:opacity-35"
                      >
                        <RotateCcw size={17} /> 清空
                      </button>
                    </div>
                  </>
                )}
              </div>
              {/* 主级:撤销/重做居中 */}
              <RoundBtn
                label="撤销"
                icon={<Undo2 size={18} />}
                disabled={historyPending || historyRef.current.length === 0}
                onClick={() => void undo()}
              />
              <RoundBtn
                label="重做"
                icon={<Redo2 size={18} />}
                disabled={historyPending || redoRef.current.length === 0}
                onClick={() => void redo()}
              />
              {/* 次级:缩放 */}
              <RoundBtn label="缩小画布" icon={<Minus size={18} />} disabled={view.scale <= 1} onClick={() => zoomBy(1 / 1.2)} />
              <span className="min-w-11 text-center text-xs text-white/60">{Math.round(view.scale * 100)}%</span>
              <RoundBtn label="放大画布" icon={<Plus size={18} />} disabled={view.scale >= 4} onClick={() => zoomBy(1.2)} />
              {(view.scale > 1 || Math.abs(view.x) > 1 || Math.abs(view.y) > 1) && (
                <button
                  type="button"
                  onClick={() => setView({ scale: 1, x: 0, y: 0 })}
                  className="min-h-11 rounded-full px-3 text-sm text-white hover:bg-white/10"
                >
                  适应
                </button>
              )}
            </div>
          </div>

          {/* 误触保护确认层(需求 §5):有未提交圈选/描述时点 X 或按 ESC → 此层;空白则直接退。 */}
          {confirmClose && (
            <div
              role="alertdialog"
              aria-label="放弃编辑确认"
              className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm"
            >
              <div className="w-full max-w-xs rounded-2xl bg-neutral-900 p-5 text-center shadow-float">
                <p className="text-sm text-white">放弃当前编辑？已圈选的区域和描述都不会保存。</p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmClose(false)}
                    className="min-h-10 flex-1 rounded-full bg-white/10 text-sm font-medium text-white transition-colors hover:bg-white/20"
                  >
                    继续编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmClose(false)
                      onOpenChange(false)
                    }}
                    className="min-h-10 flex-1 rounded-full bg-danger text-sm font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    放弃
                  </button>
                </div>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
