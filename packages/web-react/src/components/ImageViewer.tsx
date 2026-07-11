/**
 * 全屏沉浸图片查看器(替代 ZoomableImage 的内联灯箱)。全屏黑底,顶栏 X/更多/下载/分享,
 * 底部 编辑/评论/调整大小/移除 四动作圆钮。四模式为查看器内 `mode` 状态,非四个独立 Dialog:
 *   view    → 默认浏览态
 *   edit    → 复用 ImageAnnotationEditor(笔刷圈选,核心逻辑不动)
 *   comment → ImageCommentMode(数字锚点,客户端合成 annotated 三件套)
 *   resize  → ImageResizeMode(五比例 outpaint)
 *
 * 与 App 的接线:submitImageEdit / onRemoveImage 经 ImageEditActionsContext 从 App 下传
 * (单一权威 = chat/imageEditActions.tsx,由 agent P 在 App 挂 Provider 注入语义)。签名逻辑
 * 不在此复制,由 ZoomableImage(media.tsx)下传 src/alt/signPath/get/peek —— 「点击时签名权威」
 * 铁律(下载/分享/进编辑前都用 get() 现签,禁冻结挂载态 URL)。
 */
import * as Dialog from '@radix-ui/react-dialog'
import { useContext, useEffect, useState } from 'react'
import {
  ArrowUpRight,
  Download,
  Link2,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Scaling,
  Share2,
  Trash2,
  X,
} from 'lucide-react'
import { nativeDownload, openInNewTab } from '../lib/chat/download'
import { ImageAnnotationEditor, type ImageAnnotationSource } from './ImageAnnotationEditor'
import { ImageEditActionsContext, type ImageEditSubmit } from './chat/imageEditActions'
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
export async function loadImageBytes(url: string): Promise<{
  blob: Blob
  image: HTMLImageElement
  naturalWidth: number
  naturalHeight: number
  revoke: () => void
}> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`读取图片失败 (${res.status})`)
  const blob = await res.blob()
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
 * §4 契约:{open,onOpenChange,src,alt,signPath,get,peek,submitImageEdit,onRemove}。
 * submitImageEdit/onRemove 允许经 props 直传,缺省则回落 ImageEditActionsContext
 * —— media.tsx 调用点在 :265-312 窗口内不便新增 hook,故经 context 从 App 供给。
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
  onRemove: onRemoveProp,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string
  alt: string
  signPath?: string | null
  get: (opts?: { forceResign?: boolean }) => Promise<string | null>
  peek: () => string | null
  submitImageEdit?: (value: ImageEditSubmit) => void | Promise<void>
  onRemove?: (signPath: string) => void
}) {
  const ctx = useContext(ImageEditActionsContext)
  const submitImageEdit = submitProp ?? ctx.submitImageEdit
  const onRemove = onRemoveProp ?? ctx.onRemoveImage
  // 移除仅对有容器路径(生成图/可签图)的图片开放;直链无 signPath 无从隐藏。
  const canRemove = !!onRemove && !!signPath

  const [mode, setMode] = useState<ViewerMode>('view')
  const [editSource, setEditSource] = useState<ImageAnnotationSource | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [removeConfirm, setRemoveConfirm] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // 关闭时复位:回浏览态,清 edit source / 浮层 —— 下次开图是干净初始态。
  useEffect(() => {
    if (!open) {
      setMode('view')
      setEditSource(null)
      setMoreOpen(false)
      setRemoveConfirm(false)
      setNotice(null)
    }
  }, [open])

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

  const enterEdit = async () => {
    // 进编辑前现签,避免编辑器 fetch 到过期 URL。
    const url = (await get()) ?? src
    setEditSource({ url, name: alt || '图片' })
    setMode('edit')
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
          >
            <Dialog.Title className="sr-only">{alt || '图片预览'}</Dialog.Title>

            {mode === 'comment' ? (
              <ImageCommentMode
                src={src}
                alt={alt}
                resolveSrc={get}
                canSubmit={!!submitImageEdit}
                onBack={() => setMode('view')}
                onSubmit={handleSubmit}
              />
            ) : mode === 'resize' ? (
              <ImageResizeMode
                src={src}
                alt={alt}
                resolveSrc={get}
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
                      className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
                    >
                      <X size={20} />
                    </button>
                  </Dialog.Close>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="下载"
                      onClick={() => void handleDownload()}
                      className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
                    >
                      <Download size={18} />
                    </button>
                    <button
                      type="button"
                      aria-label="分享"
                      onClick={() => void handleShare()}
                      className="flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition-colors hover:bg-white/20"
                    >
                      <Share2 size={18} />
                    </button>
                    <div className="relative">
                      <button
                        type="button"
                        aria-label="更多"
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

                {/* 图片居中 */}
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4">
                  <img
                    src={src}
                    alt={alt}
                    className="max-h-full max-w-full object-contain"
                    draggable={false}
                  />
                </div>

                {/* 底部动作条:编辑 / 评论 / 调整大小 / 移除 */}
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
                    disabled={!submitImageEdit}
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
                  <ActionButton
                    label="移除"
                    icon={<Trash2 size={20} />}
                    disabled={!canRemove}
                    reason="此图片不可移除"
                    onClick={() => setRemoveConfirm(true)}
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

            {/* 移除确认弹层 */}
            {removeConfirm && (
              <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 px-6">
                <div className="w-full max-w-xs rounded-2xl bg-neutral-900 p-5 text-center shadow-float">
                  <p className="text-sm font-semibold text-white">移除这张图片？</p>
                  <p className="mt-1.5 text-xs text-white/60">仅从当前对话隐藏，不影响已生成的记录。</p>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setRemoveConfirm(false)}
                      className="min-h-11 flex-1 rounded-xl bg-white/10 text-sm font-medium text-white hover:bg-white/20"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRemoveConfirm(false)
                        if (onRemove && signPath) onRemove(signPath)
                        onOpenChange(false)
                      }}
                      className="min-h-11 flex-1 rounded-xl bg-danger text-sm font-semibold text-white hover:opacity-90"
                    >
                      移除
                    </button>
                  </div>
                </div>
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
