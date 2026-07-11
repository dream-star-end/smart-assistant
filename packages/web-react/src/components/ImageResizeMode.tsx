/**
 * 调整大小模式:底部弹出五比例菜单(带示意图标)。选择即合成 [源图 + guide] 并进主对话
 * (需求 B),帧标 mode:'resize' + targetAspect —— P 侧映射为 gateway outpaint 分支重构图。
 * 计费同 50 积分/张(仍走既有 reserve/settle,不新开口径)。
 */
import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { apiErrorMessage } from '../lib/api'
import { downloadPercent } from '../lib/chat/download'
import { getCachedThumbnail } from '../lib/chat/imageBytes'
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
  cacheIdentity,
  canSubmit,
  onBack,
  onSubmit,
}: {
  src: string
  alt: string
  resolveSrc: (opts?: { forceResign?: boolean }) => Promise<string | null>
  /**
   * 字节缓存身份(signPath)。传入即让合成取原图字节**零请求复用**查看器/气泡已下载的原图
   * (共享 LRU 命中),并在展示图就绪前先铺已缓存缩略图做模糊底图(禁纯白闪)。
   */
  cacheIdentity?: string | null
  canSubmit: boolean
  onBack: () => void
  onSubmit: (value: ImageEditSubmit) => Promise<void>
}) {
  const [busy, setBusy] = useState<ImageAspectRatio | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState(false)
  // 合成取原图进度百分比(null = 命中缓存/无 Content-Length → 显示「提交…」而非数字)。
  const [loadPercent, setLoadPercent] = useState<number | null>(null)
  // 展示图是否已解码就绪:就绪前用缩略底图/骨架占位(禁纯白闪)。
  const [imgReady, setImgReady] = useState(false)
  // 加载期即时底图:已缓存缩略图(气泡/查看器已下载)的 objectURL。未命中 → null。
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  // 展示态 src:重试时重签后更新它,让 <img> 真正换新 URL 重载(见 ImageCommentMode 同款说明)。
  const [displaySrc, setDisplaySrc] = useState(src)
  useEffect(() => setDisplaySrc(src), [src])
  // 换图(含重试重签)→ 重置就绪态,重新走占位底图。
  useEffect(() => setImgReady(false), [displaySrc])
  // 从共享 LRU 取已缓存缩略图字节造 objectURL 做底图;卸载/换身份 revoke 防泄漏。
  useEffect(() => {
    const thumb = getCachedThumbnail(cacheIdentity)
    if (!thumb) {
      setThumbUrl(null)
      return
    }
    const url = URL.createObjectURL(thumb)
    setThumbUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [cacheIdentity])

  const choose = async (ratio: RatioOption) => {
    if (!canSubmit || busy) return
    setBusy(ratio.value)
    setError(null)
    setLoadPercent(null)
    let revoke: (() => void) | null = null
    try {
      const url = (await resolveSrc()) ?? src
      // 取原图字节收口到 loadImageBytes:cacheIdentity 命中共享 LRU 即**零请求复用**查看器/
      // 气泡已下载的原图;miss 走流式 + onProgress 汇报百分比;403/410 强制重签自愈。
      const loaded = await loadImageBytes(url, resolveSrc, {
        cacheIdentity,
        onProgress: (l, t) => setLoadPercent(downloadPercent(l, t)),
      })
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
      setError(apiErrorMessage(err, '提交失败，请重试'))
    } finally {
      revoke?.()
      setBusy(null)
      setLoadPercent(null)
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
                void resolveSrc({ forceResign: true }).then((u) => u && setDisplaySrc(u))
              }}
              className="min-h-10 rounded-full bg-white/10 px-4 text-sm text-white hover:bg-white/20"
            >
              重试
            </button>
          </div>
        ) : (
          <div className="relative inline-flex max-h-full max-w-full items-center justify-center">
            {/* 主图就绪前:已缓存缩略图做模糊底图(占位给容器尺寸);未命中 → 深色骨架。禁纯白闪。
                shimmer 尊重 reduced-motion(oc-img-skeleton CSS 已处理)。 */}
            {!imgReady &&
              (thumbUrl ? (
                <img
                  src={thumbUrl}
                  alt=""
                  aria-hidden
                  draggable={false}
                  className="max-h-full max-w-full select-none object-contain opacity-40 blur-[1px]"
                />
              ) : (
                <div className="oc-img-skeleton h-64 w-64 max-w-full rounded-lg" aria-hidden />
              ))}
            {/* 主图:就绪前覆盖在底图上且透明(避免半载闪),onLoad 后转 static 显形定尺寸。 */}
            <img
              src={displaySrc}
              alt={alt}
              onLoad={() => setImgReady(true)}
              onError={() => setLoadError(true)}
              draggable={false}
              className={cn(
                'max-h-full max-w-full select-none object-contain',
                imgReady ? 'opacity-100' : 'absolute inset-0 h-full w-full opacity-0',
              )}
            />
          </div>
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
              {busy === r.value && (
                <span className="text-xs tabular-nums text-white/60">
                  {loadPercent != null ? `${loadPercent}%` : '提交…'}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
