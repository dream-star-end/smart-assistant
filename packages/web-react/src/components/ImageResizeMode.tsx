/**
 * 调整大小模式:底部弹出五比例菜单(带示意图标)。选择即合成 [源图 + guide] 并进主对话
 * (需求 B),帧标 mode:'resize' + targetAspect —— P 侧映射为 gateway outpaint 分支重构图。
 * 计费同 50 积分/张(仍走既有 reserve/settle,不新开口径)。
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '../lib/utils'
import { normalizeImageSourceForGateway } from './ImageAnnotationEditor'
import {
  canvasToPngFile,
  drawDisplayCanvas,
  type ImageAspectRatio,
  type ImageEditSubmit,
  loadImageBytes,
  newImageJobId,
} from './ImageViewer'

type RatioOption = {
  value: ImageAspectRatio
  label: string
  w: number
  h: number
  prompt: string
}

// 顺序对齐参考图 IMG_4043:宽屏 / 横向 / 竖屏 / 纵向 / 方形。
const RATIOS: RatioOption[] = [
  { value: '16:9', label: '宽屏', w: 16, h: 9, prompt: '把这张图调整为 16:9 宽屏构图，向外扩展补全画面' },
  { value: '4:3', label: '横向', w: 4, h: 3, prompt: '把这张图调整为 4:3 横向构图，向外扩展补全画面' },
  { value: '9:16', label: '竖屏', w: 9, h: 16, prompt: '把这张图调整为 9:16 竖屏构图，向外扩展补全画面' },
  { value: '3:4', label: '纵向', w: 3, h: 4, prompt: '把这张图调整为 3:4 纵向构图，向外扩展补全画面' },
  { value: '1:1', label: '方形', w: 1, h: 1, prompt: '把这张图调整为 1:1 方形构图，向外扩展补全画面' },
]

/** 比例示意图标:按 w:h 画一个描边小方框(高固定,宽随比例)。 */
function RatioGlyph({ w, h }: { w: number; h: number }) {
  const base = 22
  const width = w >= h ? base : Math.round((base * w) / h)
  const height = w >= h ? Math.round((base * h) / w) : base
  return (
    <span
      aria-hidden
      className="flex items-center justify-center"
      style={{ width: `${base}px`, height: `${base}px` }}
    >
      <span className="rounded-[3px] border-[1.5px] border-current" style={{ width: `${width}px`, height: `${height}px` }} />
    </span>
  )
}

export function ImageResizeMode({
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
  const [busy, setBusy] = useState<ImageAspectRatio | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)

  const choose = async (ratio: RatioOption) => {
    if (!canSubmit || busy) return
    setBusy(ratio.value)
    setError(null)
    let revoke: (() => void) | null = null
    try {
      const url = (await resolveSrc()) ?? src
      const loaded = await loadImageBytes(url)
      revoke = loaded.revoke
      const { blob, image, naturalWidth, naturalHeight } = loaded
      const { canvas } = drawDisplayCanvas(image, naturalWidth, naturalHeight)
      const guide = await canvasToPngFile(canvas, 'image-resize-guide.png')
      const sourceBlob = await normalizeImageSourceForGateway(blob, image)
      const source = new File([sourceBlob], alt?.trim() || 'image-resize-source', {
        type: sourceBlob.type || 'image/png',
      })
      await onSubmit({
        mode: 'resize',
        clientJobId: newImageJobId(),
        prompt: ratio.prompt,
        source,
        guide,
        width: naturalWidth,
        height: naturalHeight,
        targetAspect: ratio.value,
      })
    } catch (err) {
      setError((err as Error).message || '提交失败，请重试')
    } finally {
      revoke?.()
      setBusy(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏:X | 调整大小 | 占位 */}
      <header className="relative z-20 flex min-h-14 shrink-0 items-center justify-between gap-3 px-3 pt-[env(safe-area-inset-top)]">
        <button
          type="button"
          aria-label="返回预览"
          onClick={onBack}
          className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
        >
          <X size={20} />
        </button>
        <h2 className="text-sm font-semibold text-white">调整大小</h2>
        <span className="size-10" aria-hidden />
      </header>

      {/* 图片 */}
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
          <img
            src={src}
            alt={alt}
            onError={() => setLoadError(true)}
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
          />
        )}
      </div>

      {/* 底部弹出:五比例菜单 */}
      <div className="shrink-0 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
        {error && (
          <p role="alert" className="mx-auto mb-2 max-w-2xl rounded-lg bg-danger/25 px-3 py-1.5 text-center text-sm text-white">
            {error}
          </p>
        )}
        {!canSubmit && (
          <p className="mb-2 text-center text-xs text-white/60">当前模型不支持调整大小</p>
        )}
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-1 rounded-2xl bg-neutral-900/90 p-1.5 backdrop-blur">
          {RATIOS.map((r) => (
            <button
              key={r.value}
              type="button"
              disabled={!canSubmit || busy != null}
              onClick={() => void choose(r)}
              className={cn(
                'flex min-h-12 items-center gap-3 rounded-xl px-3 text-left text-white transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40',
                busy === r.value && 'bg-white/10',
              )}
            >
              <RatioGlyph w={r.w} h={r.h} />
              <span className="flex-1 text-sm font-medium">
                {r.label} <span className="text-white/50">{r.value}</span>
              </span>
              {busy === r.value && <span className="text-xs text-white/60">提交…</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
