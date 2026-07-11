/**
 * 评论模式:在图片上落数字锚点(蓝底白字圆点),点图新增、点锚点改文案/删除,提交时
 * **客户端合成** annotated 三件套 —— 零后端新语义:
 *   ① mask   = 每锚点白色实心圆合并到黑底二值 mask(复用编辑器二值 mask 管线)
 *   ② guide  = 原图 + 编号圆标 overlay(进主对话用户气泡的可见缩略图)
 *   ③ prompt = 编号指令文本
 * 走现有 imageEdit(annotated)帧 → 计费不动(50 积分/张)。
 */
import { useState } from 'react'
import { ArrowUp, Check, Trash2, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { normalizeImageSourceForGateway } from './ImageAnnotationEditor'
import {
  canvasToPngFile,
  drawDisplayCanvas,
  type ImageEditSubmit,
  loadImageBytes,
  newImageJobId,
} from './ImageViewer'

type Anchor = { id: string; x: number; y: number; text: string }

function buildCommentPrompt(anchors: Anchor[]): string {
  const lines = anchors.map((a, i) => `${i + 1}. ${a.text.trim()}`).join('\n')
  return `请按下列标注修改这张图片，编号对应图中相应位置的圆形标记：\n${lines}`
}

/** 在 guide 画布上叠编号蓝圆标(与屏上锚点同款视觉)。 */
function drawMarkers(ctx: CanvasRenderingContext2D, anchors: Anchor[], width: number, height: number) {
  const r = Math.max(14, Math.round(Math.min(width, height) * 0.038))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${Math.round(r * 1.1)}px sans-serif`
  anchors.forEach((a, i) => {
    const cx = a.x * width
    const cy = a.y * height
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(56,132,255,0.96)'
    ctx.fill()
    ctx.lineWidth = Math.max(2, r * 0.14)
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.fillText(String(i + 1), cx, cy)
  })
}

export function ImageCommentMode({
  src,
  alt,
  resolveSrc,
  canSubmit,
  onBack,
  onSubmit,
}: {
  src: string
  alt: string
  resolveSrc: (opts?: { forceResign?: boolean }) => Promise<string | null>
  canSubmit: boolean
  onBack: () => void
  onSubmit: (value: ImageEditSubmit) => Promise<void>
}) {
  const [anchors, setAnchors] = useState<Anchor[]>([])
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [inputText, setInputText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

  const editing = draft != null || editingId != null

  const addAt = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (busy) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5
    const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
    setEditingId(null)
    setInputText('')
    setDraft({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) })
  }

  const openAnchor = (a: Anchor) => {
    setDraft(null)
    setEditingId(a.id)
    setInputText(a.text)
  }

  const confirmInput = () => {
    const text = inputText.trim()
    if (draft) {
      if (!text) {
        setDraft(null)
        return
      }
      setAnchors((cur) => [...cur, { id: newImageJobId(), x: draft.x, y: draft.y, text }])
      setDraft(null)
      setInputText('')
      return
    }
    if (editingId) {
      setAnchors((cur) =>
        text ? cur.map((a) => (a.id === editingId ? { ...a, text } : a)) : cur.filter((a) => a.id !== editingId),
      )
      setEditingId(null)
      setInputText('')
    }
  }

  const cancelInput = () => {
    setDraft(null)
    setEditingId(null)
    setInputText('')
  }

  const removeEditing = () => {
    if (!editingId) return
    setAnchors((cur) => cur.filter((a) => a.id !== editingId))
    setEditingId(null)
    setInputText('')
  }

  const send = async () => {
    if (!canSubmit || anchors.length === 0 || busy) return
    setBusy(true)
    setError(null)
    let revoke: (() => void) | null = null
    try {
      const url = (await resolveSrc()) ?? src
      const loaded = await loadImageBytes(url)
      revoke = loaded.revoke
      const { blob, image, naturalWidth, naturalHeight } = loaded
      const { canvas: guideCanvas, width, height } = drawDisplayCanvas(image, naturalWidth, naturalHeight)
      const gctx = guideCanvas.getContext('2d')
      if (!gctx) throw new Error('浏览器不支持图片处理')
      drawMarkers(gctx, anchors, width, height)
      const guide = await canvasToPngFile(guideCanvas, 'image-comment-guide.png')

      const maskCanvas = document.createElement('canvas')
      maskCanvas.width = width
      maskCanvas.height = height
      const mctx = maskCanvas.getContext('2d')
      if (!mctx) throw new Error('浏览器不支持图片处理')
      mctx.fillStyle = '#000000'
      mctx.fillRect(0, 0, width, height)
      mctx.fillStyle = '#ffffff'
      const radius = Math.max(20, Math.round(Math.min(width, height) * 0.07))
      for (const a of anchors) {
        mctx.beginPath()
        mctx.arc(a.x * width, a.y * height, radius, 0, Math.PI * 2)
        mctx.fill()
      }
      const mask = await canvasToPngFile(maskCanvas, 'image-comment-mask.png')

      const sourceBlob = await normalizeImageSourceForGateway(blob, image)
      const source = new File([sourceBlob], alt?.trim() || 'image-comment-source', {
        type: sourceBlob.type || 'image/png',
      })

      await onSubmit({
        mode: 'comment',
        clientJobId: newImageJobId(),
        prompt: buildCommentPrompt(anchors),
        source,
        mask,
        guide,
        width: naturalWidth,
        height: naturalHeight,
      })
    } catch (err) {
      setError((err as Error).message || '提交失败，请重试')
    } finally {
      revoke?.()
      setBusy(false)
    }
  }

  const count = anchors.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏:X | N 条评论 | 发送 */}
      <header className="relative z-20 flex min-h-14 shrink-0 items-center justify-between gap-3 px-3 pt-[env(safe-area-inset-top)]">
        <button
          type="button"
          aria-label="返回预览"
          onClick={onBack}
          className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
        >
          <X size={20} />
        </button>
        <h2 className="text-sm font-semibold text-white">{count} 条评论</h2>
        <button
          type="button"
          disabled={!canSubmit || count === 0 || busy}
          onClick={() => void send()}
          className="flex min-h-10 items-center gap-1.5 rounded-full bg-white px-4 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <span className="animate-pulse">提交…</span> : (
            <>
              发送 <ArrowUp size={16} />
            </>
          )}
        </button>
      </header>

      {/* 图片 + 锚点 */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4">
        {loadError ? (
          <div role="alert" className="flex flex-col items-center gap-3 text-center text-white/80">
            <p className="text-sm">图片加载失败</p>
            <button
              type="button"
              onClick={() => {
                setLoadError(false)
                void resolveSrc({ forceResign: true })
              }}
              className="min-h-10 rounded-full bg-white/10 px-4 text-sm text-white hover:bg-white/20"
            >
              重试
            </button>
          </div>
        ) : (
          <div className="relative inline-block max-h-full max-w-full">
            <img
              src={src}
              alt={alt}
              onError={() => setLoadError(true)}
              draggable={false}
              className="max-h-full max-w-full select-none object-contain"
            />
            {/* 落点层:点空白处新增锚点 */}
            <button
              type="button"
              aria-label="点按图片添加评论"
              onClick={addAt}
              className="absolute inset-0 z-0 cursor-crosshair"
            />
            {/* 已落锚点 */}
            {anchors.map((a, i) => (
              <button
                key={a.id}
                type="button"
                aria-label={`评论 ${i + 1}`}
                onClick={() => openAnchor(a)}
                style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}
                className={cn(
                  'absolute z-10 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white text-xs font-bold text-white shadow-float',
                  editingId === a.id ? 'bg-accent' : 'bg-[rgba(56,132,255,0.96)]',
                )}
              >
                {i + 1}
              </button>
            ))}
            {/* 草稿锚点(未确认) */}
            {draft && (
              <span
                aria-hidden
                style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}
                className="absolute z-10 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-[rgba(56,132,255,0.7)] text-xs font-bold text-white"
              >
                {count + 1}
              </span>
            )}
          </div>
        )}
      </div>

      {/* 底部:输入条 或 空态提示 */}
      <div className="shrink-0 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
        {error && (
          <p role="alert" className="mx-auto mb-2 max-w-2xl rounded-lg bg-danger/25 px-3 py-1.5 text-center text-sm text-white">
            {error}
          </p>
        )}
        {editing ? (
          <div className="mx-auto flex w-full max-w-2xl items-center gap-2 rounded-2xl bg-white/10 px-3 py-2 backdrop-blur">
            {editingId && (
              <button
                type="button"
                aria-label="删除该评论"
                onClick={removeEditing}
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-white/70 hover:bg-white/10 hover:text-danger"
              >
                <Trash2 size={16} />
              </button>
            )}
            <input
              type="text"
              autoFocus
              aria-label="描述编辑"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  confirmInput()
                } else if (e.key === 'Escape') {
                  cancelInput()
                }
              }}
              placeholder="描述编辑"
              maxLength={400}
              className="min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-white/40"
            />
            <button
              type="button"
              aria-label="确认"
              onClick={confirmInput}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition-opacity hover:opacity-90"
            >
              <Check size={16} />
            </button>
          </div>
        ) : (
          <p className="py-2 text-center text-sm text-white/60">
            {count === 0 ? '点按图片添加评论' : '点按图片继续添加，或点锚点修改'}
          </p>
        )}
      </div>
    </div>
  )
}
