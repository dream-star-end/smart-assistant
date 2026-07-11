/**
 * 全屏沉浸图片查看器(替代 ZoomableImage 的内联灯箱)。全屏黑底,顶栏 X/更多/下载/分享,
 * 底部 编辑/评论/调整大小 三动作圆钮(「移除」按 boss 判定下线)。三模式为查看器内 `mode`
 * 状态,非三个独立 Dialog:
 *   view    → 默认浏览态(加载中亮深色 shimmer 骨架,禁纯白/白闪)
 *   edit    → 复用 ImageAnnotationEditor(笔刷圈选,核心逻辑不动)
 *   comment → ImageCommentMode(数字锚点,提交为普通模型 turn:原图 media + 百分比坐标文本)
 *   resize  → ImageResizeMode(五比例 outpaint)
 *
 * 与 App 的接线:submitImageEdit 经 ImageEditActionsContext 从 App 下传(单一权威 =
 * chat/imageEditActions.tsx,其存在即"可否编辑"的唯一判定)。签名逻辑不在此复制,由
 * ZoomableImage(media.tsx)下传 src/alt/signPath/get/peek —— 「点击时签名权威」铁律
 * (下载/分享/进编辑前都用 get() 现签,禁冻结挂载态 URL;编辑器取图再有 403/410 重签兜底)。
 */
import * as Dialog from '@radix-ui/react-dialog'
import { useContext, useEffect, useRef, useState } from 'react'
import {
  ArrowUpRight,
  Download,
  Link2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Scaling,
  Share2,
  X,
} from 'lucide-react'
import { nativeDownload, openInNewTab } from '../lib/chat/download'
import { fetchImageBlobWithResign, type ResolveSignedSrc } from '../lib/chat/media'
import { useProgressiveImage } from '../lib/chat/useProgressiveImage'
import { cn } from '../lib/utils'
import { ImageAnnotationEditor, type ImageAnnotationSource } from './ImageAnnotationEditor'
import { ImageEditActionsContext, type ImageCommentSubmit, type ImageEditSubmit } from './chat/imageEditActions'
import { ImageCommentMode } from './ImageCommentMode'
import { ImageResizeMode } from './ImageResizeMode'

// ImageEditSubmit 单一权威在 chat/imageEditActions.tsx(P/V 共用);此处再导出给 comment/resize 复用。
export type { ImageEditSubmit } from './chat/imageEditActions'

/** 调整大小的五枚举(comment/resize 内部用;提交时以 string 落 targetAspect,与 P 契约对齐)。 */
export type ImageAspectRatio = '16:9' | '4:3' | '9:16' | '3:4' | '1:1'

// ── 共享图片合成基建(comment/resize 复用,与 ImageAnnotationEditor 同口径的降采样上限)。 ──
export const IMAGE_DISPLAY_MAX_SIDE = 1600
const MAX_PIXELS = 16_777_216 // 4096²,与编辑器一致

/**
 * 取签名 URL 的图片字节并解码。返回原始 blob(source 上传用)+ 已解码 image + 自然尺寸 +
 * revoke(调用方用完 image 后释放 objectURL —— 释放前 image 必须已 drawImage/normalize 完毕)。
 */
export async function loadImageBytes(
  url: string,
  resolveSrc?: ResolveSignedSrc,
  opts?: { cacheIdentity?: string | null; onProgress?: (loaded: number, total: number | null) => void },
): Promise<{
  blob: Blob
  image: HTMLImageElement
  naturalWidth: number
  naturalHeight: number
  revoke: () => void
}> {
  // 取字节收口到共享 helper:字节缓存命中零请求复用(查看器已载原图 → 评论/调整大小直接用);
  // 403/410(签名过期)强制重签一次;miss 流式 + onProgress 汇报百分比。
  const blob = await fetchImageBlobWithResign(url, resolveSrc, {
    cacheIdentity: opts?.cacheIdentity ?? null,
    onProgress: opts?.onProgress,
  })
  const objUrl = URL.createObjectURL(blob)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('图片解码失败'))
      image.src = objUrl
    })
  } catch (err) {
    URL.revokeObjectURL(objUrl)
    throw err
  }
  const naturalWidth = image.naturalWidth
  const naturalHeight = image.naturalHeight
  if (naturalWidth * naturalHeight > MAX_PIXELS) {
    URL.revokeObjectURL(objUrl)
    throw new Error('图片超过 1670 万像素，请先缩小后再处理')
  }
  return { blob, image, naturalWidth, naturalHeight, revoke: () => URL.revokeObjectURL(objUrl) }
}

/** 把解码后的 image 画到 DISPLAY_MAX_SIDE 内的展示画布(guide/mask 的基准尺寸)。 */
export function drawDisplayCanvas(
  image: CanvasImageSource,
  naturalWidth: number,
  naturalHeight: number,
): { canvas: HTMLCanvasElement; width: number; height: number } {
  const ratio = Math.min(1, IMAGE_DISPLAY_MAX_SIDE / Math.max(naturalWidth, naturalHeight))
  const width = Math.max(1, Math.round(naturalWidth * ratio))
  const height = Math.max(1, Math.round(naturalHeight * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('浏览器不支持图片处理')
  ctx.drawImage(image, 0, 0, width, height)
  return { canvas, width, height }
}

/** canvas → PNG File(guide/mask 上传件)。 */
export function canvasToPngFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(new File([blob], name, { type: 'image/png' })) : reject(new Error('图片快照创建失败'))),
      'image/png',
    )
  })
}

/** 与编辑器同款:clientJobId = 32 位无连字符 hex(帧校验 ^[0-9a-f]{32}$)。 */
export function newImageJobId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

function deriveDownloadName(alt: string, signPath?: string | null): string {
  const fromPath = signPath ? signPath.split('/').pop() ?? '' : ''
  if (fromPath && fromPath.includes('.')) return fromPath
  const base = (alt || '图片').trim() || '图片'
  return `${base}.png`
}

type ViewerMode = 'view' | 'edit' | 'comment' | 'resize'

/** 底部动作条单项:圆钮 + 中文标签(黑底毛玻璃)。 */
function ActionButton({
  label,
  icon,
  onClick,
  disabled,
  reason,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  reason?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? reason : label}
      aria-label={label}
      className="group/action flex min-w-16 flex-col items-center gap-1.5 outline-none disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors group-hover/action:bg-white/20">
        {icon}
      </span>
      <span className="text-xs font-medium text-white/90">{label}</span>
    </button>
  )
}

/**
 * §4 契约:{open,onOpenChange,src,alt,signPath,get,peek,submitImageEdit,initialMode}。
 * submitImageEdit 允许经 prop 直传,缺省回落 ImageEditActionsContext(App 供给)。
 * initialMode='edit' → 开图即直接进圈选编辑器(聊天缩略图左下角「编辑」浮钮的直达入口)。
 */
export function ImageViewer({
  open,
  onOpenChange,
  src,
  alt,
  signPath,
  get,
  peek,
  submitImageEdit: submitProp,
  initialMode = 'view',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string
  alt: string
  signPath?: string | null
  get: (opts?: { forceResign?: boolean }) => Promise<string | null>
  peek: () => string | null
  submitImageEdit?: (value: ImageEditSubmit) => void | Promise<void>
  /** 开图即进入的模式;'edit' = 直达圈选编辑器(左下角「编辑」浮钮用)。默认 'view'。 */
  initialMode?: ViewerMode
}) {
  const ctx = useContext(ImageEditActionsContext)
  const submitImageEdit = submitProp ?? ctx.submitImageEdit
  // 评论 = 普通模型 turn(原图 media + 百分比坐标文本),不走 submitImageEdit 帧链路。
  // 与 submitImageEdit 同门控(image2/GPT),存在即评论动作可用。
  const submitImageComment = ctx.submitImageComment

  const [mode, setMode] = useState<ViewerMode>('view')
  const [editSource, setEditSource] = useState<ImageAnnotationSource | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // 原图渐进加载(单一 hook 收口):点开先复用气泡已载缩略字节做即时预览(零请求、非灰屏),
  // 后台流式拉原图带百分比,到达后无缝换。lazy=false(查看器打开即可见)。signPath 作字节缓存身份。
  const { objectUrl: viewerUrl, percent: viewerPercent, status: viewerStatus } = useProgressiveImage({
    src: open ? src : null,
    width: null,
    cacheIdentity: signPath ?? null,
    resolveSrc: get,
    lazy: false,
  })
  // Radix DismissableLayer 的 onEscapeKeyDown 会绑定挂载时那一版闭包(不随 mode/moreOpen
  // 重渲刷新),直接读 state 会拿到陈旧值 → ESC 误把子模式当 view 直接关掉整个查看器。用
  // ref 存最新值,闭包读 ref.current 永远最新(ref 对象跨渲染稳定)。
  const modeRef = useRef(mode)
  modeRef.current = mode
  const moreOpenRef = useRef(moreOpen)
  moreOpenRef.current = moreOpen
  // initialMode='edit' 时开图直达编辑:每次开图只触发一次(ref 守卫),避免编辑器关闭回
  // view 后又被重新拉回 edit。
  const autoEditRef = useRef(false)

  const enterEdit = async () => {
    // 进编辑前现签,避免编辑器 fetch 到过期 URL(编辑器内再有 403/410 重签兜底)。
    const url = (await get()) ?? src
    setEditSource({ url, name: alt || '图片' })
    setMode('edit')
  }

  // 关闭时复位:回浏览态,清 edit source / 浮层 —— 下次开图是干净初始态。
  useEffect(() => {
    if (!open) {
      setMode('view')
      setEditSource(null)
      setMoreOpen(false)
      setNotice(null)
      autoEditRef.current = false
      return
    }
    // 开图直达编辑(需求 §3):enterEdit 内部现签,不依赖 freshSrc 是否已回填。
    if (initialMode === 'edit' && !autoEditRef.current && submitImageEdit) {
      autoEditRef.current = true
      void enterEdit()
    }
    // enterEdit 故意不入 deps:它每渲染重建但捕获当帧 get/src,ref 守卫保证每次开图只跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialMode])

  const flash = (text: string) => {
    setNotice(text)
    window.setTimeout(() => setNotice((cur) => (cur === text ? null : cur)), 1800)
  }

  // 提交任一模式 → 进主对话(需求 B)→ 关整个查看器。
  const handleSubmit = async (value: ImageEditSubmit) => {
    if (!submitImageEdit) return
    await submitImageEdit(value)
    setMode('view')
    onOpenChange(false)
  }

  // 评论提交(普通模型 turn):走 submitImageComment,同样成功后回 view + 关查看器。
  const handleCommentSubmit = async (value: ImageCommentSubmit) => {
    if (!submitImageComment) return
    await submitImageComment(value)
    setMode('view')
    onOpenChange(false)
  }

  const handleDownload = async () => {
    const url = (await get()) ?? src
    nativeDownload(url, deriveDownloadName(alt, signPath))
  }

  const absolute = (url: string) => {
    try {
      return new URL(url, typeof location !== 'undefined' ? location.href : 'https://openclaude').href
    } catch {
      return url
    }
  }

  const handleShare = async () => {
    const url = (await get()) ?? src
    const link = absolute(url)
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav?.share) {
      try {
        await nav.share({ title: alt || '图片', url: link })
        return
      } catch {
        // 用户取消或不支持 → 落复制链接降级
      }
    }
    if (nav?.clipboard?.writeText) {
      try {
        await nav.clipboard.writeText(link)
        flash('已复制链接')
        return
      } catch {
        /* fall through */
      }
    }
    openInNewTab(url)
  }

  const openInTab = async () => {
    setMoreOpen(false)
    // 慢路径:点击时强制重签,仍在手势激活窗口内程序化开新标签(对齐 media.tsx 铁律)。
    const cached = peek()
    if (cached) {
      openInNewTab(cached)
      return
    }
    const url = await get({ forceResign: true })
    if (url) openInNewTab(url)
  }

  const copyLink = async () => {
    setMoreOpen(false)
    const url = (await get()) ?? src
    if (navigator?.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(absolute(url))
        flash('已复制链接')
        return
      } catch {
        /* fall through */
      }
    }
    openInNewTab(url)
  }

  const editDisabledReason = submitImageEdit ? undefined : '当前模型不支持图片编辑'

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) setMode('view')
          onOpenChange(next)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black data-[state=open]:animate-fade" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-[61] flex select-none flex-col bg-black text-white outline-none"
            onOpenAutoFocus={(e) => e.preventDefault()}
            // ESC 逐层退出(需求 §5):更多菜单 → 子模式(评论/调整大小)→ 查看器。edit 模式由
            // 上层编辑器 Dialog 自己捕获 ESC(topmost layer),这里不会触发。
            onEscapeKeyDown={(e) => {
              // 读 ref(非闭包 state):Radix 绑定的是挂载时闭包,state 会陈旧。
              if (moreOpenRef.current) {
                e.preventDefault()
                setMoreOpen(false)
              } else if (modeRef.current === 'comment' || modeRef.current === 'resize') {
                e.preventDefault()
                setMode('view')
              }
              // view 模式:放行 Radix 关闭整个查看器。
            }}
          >
            <Dialog.Title className="sr-only">{alt || '图片预览'}</Dialog.Title>

            {mode === 'comment' ? (
              <ImageCommentMode
                src={src}
                alt={alt}
                resolveSrc={get}
                cacheIdentity={signPath ?? null}
                canSubmit={!!submitImageComment}
                onBack={() => setMode('view')}
                onSubmit={handleCommentSubmit}
              />
            ) : mode === 'resize' ? (
              <ImageResizeMode
                src={src}
                alt={alt}
                resolveSrc={get}
                cacheIdentity={signPath ?? null}
                canSubmit={!!submitImageEdit}
                onBack={() => setMode('view')}
                onSubmit={handleSubmit}
              />
            ) : (
              <>
                {/* 顶栏:左 X 圆钮,右 下载/分享/更多 */}
                <header className="relative z-20 flex min-h-14 shrink-0 items-center justify-between gap-2 px-3 pt-[env(safe-area-inset-top)]">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      aria-label="关闭预览"
                      title="关闭 (Esc)"
                      className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
                    >
                      <X size={20} />
                    </button>
                  </Dialog.Close>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="下载"
                      title="下载"
                      onClick={() => void handleDownload()}
                      className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
                    >
                      <Download size={18} />
                    </button>
                    <button
                      type="button"
                      aria-label="分享"
                      title="分享"
                      onClick={() => void handleShare()}
                      className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
                    >
                      <Share2 size={18} />
                    </button>
                    <div className="relative">
                      <button
                        type="button"
                        aria-label="更多"
                        title="更多"
                        aria-expanded={moreOpen}
                        onClick={() => setMoreOpen((v) => !v)}
                        className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
                      >
                        <MoreHorizontal size={18} />
                      </button>
                      {moreOpen && (
                        <>
                          <button
                            type="button"
                            aria-hidden
                            tabIndex={-1}
                            className="fixed inset-0 z-10 cursor-default"
                            onClick={() => setMoreOpen(false)}
                          />
                          <div className="absolute right-0 top-12 z-20 flex w-44 flex-col rounded-2xl bg-neutral-900/95 p-1.5 text-sm shadow-float backdrop-blur">
                            <button
                              type="button"
                              onClick={() => void openInTab()}
                              className="flex items-center gap-2 rounded-xl px-3 py-2 text-left text-white hover:bg-white/10"
                            >
                              <ArrowUpRight size={16} /> 新标签打开原图
                            </button>
                            <button
                              type="button"
                              onClick={() => void copyLink()}
                              className="flex items-center gap-2 rounded-xl px-3 py-2 text-left text-white hover:bg-white/10"
                            >
                              <Link2 size={16} /> 复制链接
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </header>

                {/* 图片居中:先复用气泡缩略字节做即时预览(零请求、非灰屏),原图流式到达无缝换;
                    加载期顶部细进度条 + 百分比(禁纯白/白闪)。无预览时亮深色 shimmer 骨架。 */}
                <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4">
                  {viewerUrl ? (
                    <img
                      src={viewerUrl}
                      alt={alt}
                      decoding="async"
                      className="max-h-full max-w-full object-contain opacity-100 transition-opacity duration-200"
                      draggable={false}
                    />
                  ) : (
                    <span aria-hidden className="oc-img-skeleton absolute inset-6 rounded-xl" />
                  )}
                  {viewerStatus === 'loading' && (
                    <div
                      role="status"
                      aria-live="polite"
                      className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-xs font-medium tabular-nums text-white/90 backdrop-blur"
                    >
                      {viewerPercent != null ? `加载原图 ${viewerPercent}%` : '加载原图…'}
                    </div>
                  )}
                </div>

                {/* 底部动作条:编辑 / 评论 / 调整大小(「移除」已按 boss 判定下线)。 */}
                <div className="flex shrink-0 items-start justify-center gap-3 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:gap-6">
                  <ActionButton
                    label="编辑"
                    icon={<Pencil size={20} />}
                    disabled={!submitImageEdit}
                    reason={editDisabledReason}
                    onClick={() => void enterEdit()}
                  />
                  <ActionButton
                    label="评论"
                    icon={<MessageCircle size={20} />}
                    disabled={!submitImageComment}
                    reason={editDisabledReason}
                    onClick={() => setMode('comment')}
                  />
                  <ActionButton
                    label="调整大小"
                    icon={<Scaling size={20} />}
                    disabled={!submitImageEdit}
                    reason={editDisabledReason}
                    onClick={() => setMode('resize')}
                  />
                </div>
              </>
            )}

            {/* 复制/分享轻提示 */}
            {notice && (
              <div
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute left-1/2 top-16 z-40 -translate-x-1/2 rounded-full bg-white/15 px-3 py-1.5 text-xs font-medium text-white backdrop-blur"
              >
                {notice}
              </div>
            )}

          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* 编辑模式:复用 ImageAnnotationEditor(独立 Dialog,叠在查看器之上)。
          onSubmit 把 ImageAnnotationExport 映射为 ImageEditSubmit(annotated)再进主对话。 */}
      <ImageAnnotationEditor
        source={editSource}
        open={open && mode === 'edit'}
        resolveSrc={get}
        cacheIdentity={signPath ?? null}
        onOpenChange={(o) => {
          if (!o) setMode('view')
        }}
        onSubmit={async (exp) => {
          // ImageAnnotationExport 无 mode 字段 → 标 'edit' 落 P 的 annotated 分支(mode 可选)。
          await handleSubmit({ mode: 'edit', ...exp })
        }}
      />
    </>
  )
}
