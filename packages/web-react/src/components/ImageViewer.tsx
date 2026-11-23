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
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { nativeDownload, openInNewTab, saveBlob } from '../lib/chat/download'
import { PRODUCT_CAPABILITIES, type ProductFeatureId } from '../lib/productCapabilities'
import { byteCacheKey, isMediaSignedUrl } from '../lib/chat/imageBytes'
import { type ResolveSignedSrc, fetchImageBlobWithResign } from '../lib/chat/media'
import { useProgressiveImage } from '../lib/chat/useProgressiveImage'
import { cn } from '../lib/utils'
import { ImageAnnotationEditor, type ImageAnnotationSource } from './ImageAnnotationEditor'
import { ImageCommentMode } from './ImageCommentMode'
import { ImageResizeMode } from './ImageResizeMode'
import {
  type ImageCommentSubmit,
  ImageEditActionsContext,
  type ImageEditSubmit,
} from './chat/imageEditActions'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui'

/**
 * 分享 / 复制拿到的是短时效签名 URL(仓内铁律:签名 URL 禁当持久引用),产品目前没有可分享的
 * 持久地址(需后端出分享令牌,审计 M-25)。前端能做的只有把话说清:它是临时链接、会过期。
 */
const TEMP_LINK_COPIED_NOTICE = '已复制临时链接，链接稍后会失效'

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

/**
 * 底部动作条单项:圆钮 + 中文标签(黑底毛玻璃)。
 * 不可用时走 aria-disabled 而非原生 disabled(审计 M-13):原生 disabled 会吞掉点击,`title`
 * 在触屏又不显示 → 用户点「编辑」毫无反馈。现在点下去由 onDisabledClick 给一句原因(轻提示),
 * 与圈选编辑器「发送」钮的做法一致(ImageAnnotationEditor.tsx aria-disabled + 引导提示)。
 */
function ActionButton({
  label,
  icon,
  onClick,
  disabled,
  reason,
  onDisabledClick,
  featureId,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  disabled?: boolean
  reason?: string
  onDisabledClick?: (reason: string) => void
  featureId?: ProductFeatureId
}) {
  return (
    <button
      type="button"
      data-product-feature={featureId}
      onClick={() => {
        if (disabled) {
          if (reason) onDisabledClick?.(reason)
          return
        }
        onClick()
      }}
      aria-disabled={disabled || undefined}
      title={disabled ? reason : label}
      aria-label={label}
      className={cn(
        'oc-spring-press group/action flex min-w-16 flex-col items-center gap-1.5 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-not-allowed opacity-40',
      )}
    >
      <span
        className={cn(
          'flex size-12 items-center justify-center rounded-full bg-white/10 text-fg backdrop-blur transition-colors',
          !disabled && 'group-hover/action:bg-white/20',
        )}
      >
        {icon}
      </span>
      <span className="text-xs font-medium text-fg/90">{label}</span>
    </button>
  )
}

/**
 * §4 契约:{open,onOpenChange,src,alt,signPath,cacheIdentity,get,peek,submitImageEdit,initialMode}。
 * submitImageEdit 允许经 prop 直传,缺省回落 ImageEditActionsContext(App 供给)。
 * initialMode='edit' → 开图即直接进圈选编辑器(聊天缩略图左下角「编辑」浮钮的直达入口)。
 */
export function ImageViewer({
  open,
  onOpenChange,
  src,
  alt,
  signPath,
  cacheIdentity,
  get,
  peek,
  submitImageEdit: submitProp,
  initialMode = 'view',
  readOnly = false,
  referrerPolicy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  src: string
  alt: string
  signPath?: string | null
  /** authKey+signPath 的租户隔离字节缓存身份；签名媒体必须由 MediaSignProvider 下传。 */
  cacheIdentity: string | null
  get: (opts?: { forceResign?: boolean }) => Promise<string | null>
  peek: () => string | null
  submitImageEdit?: (value: ImageEditSubmit) => void | Promise<void>
  /** 开图即进入的模式;'edit' = 直达圈选编辑器(左下角「编辑」浮钮用)。默认 'view'。 */
  initialMode?: ViewerMode
  /** 只读媒体(站内信/后台预览)：不从聊天上下文继承编辑、评论、分享动作。 */
  readOnly?: boolean
  /** 外链只读图片沿用缩略态的 referrer policy。 */
  referrerPolicy?: React.HTMLAttributeReferrerPolicy
}) {
  const ctx = useContext(ImageEditActionsContext)
  const submitImageEdit = readOnly ? undefined : submitProp ?? ctx.submitImageEdit
  // 评论 = 普通模型 turn(原图 media + 百分比坐标文本),不走 submitImageEdit 帧链路。
  // 与 submitImageEdit 同门控(image2/GPT),存在即评论动作可用。
  const submitImageComment = readOnly ? undefined : ctx.submitImageComment

  const [mode, setMode] = useState<ViewerMode>('view')
  const [editSource, setEditSource] = useState<ImageAnnotationSource | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)
  // 下载 pending 必须绑定逻辑图片身份,不能是裸 boolean。否则 A 原图迟到可能被保存成 B。
  const [pendingDownloadKey, setPendingDownloadKey] = useState<string | null>(null)
  const [nativeFallbackKey, setNativeFallbackKey] = useState<string | null>(null)
  // 原图渐进加载(单一 hook 收口):点开先复用气泡已载缩略字节做即时预览(零请求、非灰屏),
  // 后台流式拉原图带百分比,到达后无缝换。lazy=false(查看器打开即可见)。signPath 作字节缓存身份。
  const {
    objectUrl: viewerUrl,
    blob: viewerBlob,
    blobKey: viewerBlobKey,
    percent: viewerPercent,
    status: viewerStatus,
  } = useProgressiveImage({
    src: open ? src : null,
    width: null,
    cacheIdentity,
    resolveSrc: get,
    lazy: false,
  })
  // 只复用同源签名媒体的原图 Blob。direct URL 没有稳定租户内 identity,维持原生下载。
  const currentOriginalKey = isMediaSignedUrl(src) ? byteCacheKey(cacheIdentity, null) : null
  const downloadName = deriveDownloadName(alt, signPath)
  // Radix DismissableLayer 的 onEscapeKeyDown 会绑定挂载时那一版闭包(不随 mode/moreOpen
  // 重渲刷新),直接读 state 会拿到陈旧值 → ESC 误把子模式当 view 直接关掉整个查看器。用
  // ref 存最新值,闭包读 ref.current 永远最新(ref 对象跨渲染稳定)。
  const modeRef = useRef(mode)
  modeRef.current = mode
  const moreOpenRef = useRef(moreOpen)
  moreOpenRef.current = moreOpen
  // 子模式(评论 / 调整大小)的 Esc 委托口:Radix 在 document 捕获阶段派发 Esc,永远先于子模式
  // 输入框自己的 onKeyDown。查看器先问子模式「这次 Esc 你要不要」(取消草稿 / 弹确认 / 提交中吞掉),
  // 子模式返回 false 才退回浏览态 —— 否则用户想取消一条草稿,整个评论模式连同全部锚点被掐掉
  // (审计 M-02)。同一时刻只挂一个子模式,共用一个 ref。
  const subModeEscapeRef = useRef<(() => boolean) | null>(null)
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
      setZoom({ scale: 1, x: 0, y: 0 })
      setDragging(false)
      dragRef.current = null
      setPendingDownloadKey(null)
      setNativeFallbackKey(null)
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

  // 切图或退出浏览态时重置缩放与平移。
  useEffect(() => {
    setZoom({ scale: 1, x: 0, y: 0 })
    setDragging(false)
    dragRef.current = null
  }, [src, mode])

  const resetZoom = useCallback(() => {
    setZoom({ scale: 1, x: 0, y: 0 })
    setDragging(false)
    dragRef.current = null
  }, [])

  const toggleDoubleClickZoom = useCallback((e: React.MouseEvent<HTMLElement>) => {
    setZoom((cur) => {
      if (cur.scale > 1.05) return { scale: 1, x: 0, y: 0 }
      const rect = e.currentTarget.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0 && (e.clientX !== 0 || e.clientY !== 0)) {
        const dx = Math.max(-rect.width * 0.5, Math.min(rect.width * 0.5, rect.left + rect.width / 2 - e.clientX))
        const dy = Math.max(-rect.height * 0.5, Math.min(rect.height * 0.5, rect.top + rect.height / 2 - e.clientY))
        return { scale: 2, x: dx, y: dy }
      }
      return { scale: 2, x: 0, y: 0 }
    })
  }, [])

  const handleStageWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
    setZoom((cur) => {
      const nextScale = Math.max(1, Math.min(4, cur.scale * factor))
      if (nextScale <= 1.02) return { scale: 1, x: 0, y: 0 }
      const ratio = nextScale / cur.scale
      return { scale: nextScale, x: cur.x * ratio, y: cur.y * ratio }
    })
  }, [])

  const handleStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (zoom.scale <= 1.02) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: zoom.x,
        originY: zoom.y,
      }
      setDragging(true)
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {}
    },
    [zoom.scale, zoom.x, zoom.y],
  )

  const handleStagePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    setZoom((cur) => ({ ...cur, x: drag.originX + dx, y: drag.originY + dy }))
  }, [])

  const handleStagePointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
  }, [])

  // 提示定时器只留一个:新提示作废旧的,卸载时清掉。漏清的定时器会在组件(测试里是整个
  // jsdom)拆除后回写 state(OCV5-373)。
  const noticeTimerRef = useRef<number | null>(null)
  const flash = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      setNotice((cur) => (cur === text ? null : cur))
    }, 1800)
  }, [])
  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    },
    [],
  )

  // pending 只消费同一 generation 的原图 Blob。首帧 idle / loading 都复用 Viewer 已启动的
  // fetch；关闭、换图、旧请求迟到一律因 key/open 不匹配被清掉,不产生下载。
  useEffect(() => {
    if (!pendingDownloadKey) return
    if (!open || !currentOriginalKey || pendingDownloadKey !== currentOriginalKey) {
      setPendingDownloadKey(null)
      return
    }
    if (viewerBlob && viewerBlobKey === currentOriginalKey) {
      setPendingDownloadKey(null)
      saveBlob(viewerBlob, downloadName)
      flash('已开始下载')
      return
    }
    if (viewerStatus === 'error') {
      // 先同步退出 pending,再由独立 fallback effect 现签；同 key 重复点击不会重入。
      setPendingDownloadKey(null)
      setNativeFallbackKey(currentOriginalKey)
    }
  }, [
    pendingDownloadKey,
    open,
    currentOriginalKey,
    viewerBlob,
    viewerBlobKey,
    viewerStatus,
    downloadName,
    flash,
  ])

  // 原图流式失败时保留原生下载逃生门。effect cleanup 在关闭/换图时取消落地；不回退到
  // 挂载态 src(它可能已过期),只用点击后 get() 解析出的当前签名 URL。
  useEffect(() => {
    if (!nativeFallbackKey) return
    if (!open || nativeFallbackKey !== currentOriginalKey) {
      setNativeFallbackKey(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const url = await get()
        if (!cancelled && url) nativeDownload(url, downloadName)
      } catch {
        // provider 正常会把签名失败收敛成 null；自定义 resolver 抛错时也不能留下未处理 rejection。
      } finally {
        if (!cancelled) {
          setNativeFallbackKey((cur) => (cur === nativeFallbackKey ? null : cur))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [nativeFallbackKey, open, currentOriginalKey, get, downloadName])

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
    if (open && currentOriginalKey) {
      if (viewerBlob && viewerBlobKey === currentOriginalKey) {
        saveBlob(viewerBlob, downloadName)
        flash('已开始下载')
        return
      }
      if (viewerStatus !== 'error') {
        // 包含 Viewer 首帧 effect 尚未把 idle 推到 loading 的窗口；只登记一次,不另开网络。
        setPendingDownloadKey(currentOriginalKey)
        flash('正在准备下载…')
        return
      }
      setNativeFallbackKey(currentOriginalKey)
      return
    }
    const url = (await get()) ?? src
    nativeDownload(url, downloadName)
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
        flash(TEMP_LINK_COPIED_NOTICE)
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
        flash(TEMP_LINK_COPIED_NOTICE)
        return
      } catch {
        /* fall through */
      }
    }
    openInNewTab(url)
  }

  const editDisabledReason = submitImageEdit ? undefined : '当前模型不支持图片编辑'
  const commentDisabledReason = submitImageComment ? undefined : '当前模型不支持图片评论'
  const resizeDisabledReason = submitImageEdit ? undefined : '当前模型不支持调整大小'

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
          <Dialog.Overlay className="dark fixed inset-0 z-[var(--z-viewer)] bg-bg/95 backdrop-blur-sm data-[state=open]:animate-fade" />
          <Dialog.Content
            aria-describedby={undefined}
            className="dark fixed inset-0 z-[var(--z-viewer)] flex select-none flex-col bg-bg text-fg outline-none"
            onOpenAutoFocus={(e) => e.preventDefault()}
            // ESC 逐层退出(需求 §5):更多菜单 → 子模式(评论/调整大小)→ 查看器。edit 模式由
            // 上层编辑器 Dialog 自己捕获 ESC(topmost layer),这里不会触发。
            onEscapeKeyDown={(e) => {
              // 读 ref(非闭包 state):Radix 绑定的是挂载时闭包,state 会陈旧。
              // 「更多」已是 Radix 菜单(M-14),开着时它自己是最高层、Esc 到不了这里;这条守卫只兜
              // 「两份 DismissableLayer 上下文并存」的极端情况,防止 Esc 把菜单和查看器一起关掉。
              if (moreOpenRef.current) {
                e.preventDefault()
                setMoreOpen(false)
              } else if (modeRef.current === 'comment' || modeRef.current === 'resize') {
                e.preventDefault()
                // 先委托子模式(取消草稿 / 弹「放弃评论」确认 / 提交中吞掉);子模式没接才退回浏览态。
                if (subModeEscapeRef.current?.()) return
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
                cacheIdentity={cacheIdentity}
                canSubmit={!!submitImageComment}
                onBack={() => setMode('view')}
                onSubmit={handleCommentSubmit}
                escapeHandlerRef={subModeEscapeRef}
              />
            ) : mode === 'resize' ? (
              <ImageResizeMode
                src={src}
                alt={alt}
                resolveSrc={get}
                cacheIdentity={cacheIdentity}
                canSubmit={!!submitImageEdit}
                onBack={() => setMode('view')}
                onSubmit={handleSubmit}
                escapeHandlerRef={subModeEscapeRef}
              />
            ) : (
              <>
                {/* 顶栏:左 X 圆钮,右 下载/分享/更多 */}
                <header className="relative z-20 flex min-h-14 shrink-0 items-center justify-between gap-2 px-3 pt-[env(safe-area-inset-top)]">
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      data-product-feature={PRODUCT_CAPABILITIES.artifacts.id}
                      aria-label="关闭预览"
                      title="关闭 (Esc)"
                      className="oc-spring-press flex size-10 items-center justify-center rounded-full bg-white/10 text-fg outline-none backdrop-blur transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-11"
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
                      className="oc-spring-press flex size-10 items-center justify-center rounded-full bg-white/10 text-fg outline-none backdrop-blur transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-11"
                    >
                      <Download size={18} />
                    </button>
                    {!readOnly && (
                      <button
                        type="button"
                        aria-label="分享"
                        title="分享"
                        onClick={() => void handleShare()}
                        className="oc-spring-press flex size-10 items-center justify-center rounded-full bg-white/10 text-fg outline-none backdrop-blur transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-11"
                      >
                        <Share2 size={18} />
                      </button>
                    )}
                    {/* 「更多」走 DropdownMenu 原语(审计 M-14):拿到 menu/menuitem 语义、方向键、
                        打开即聚焦首项、关闭焦点回触发钮;暗房暖炭底样式用 dark + elevated 盖掉原语默认色。
                        层级自然继承原语的 z-[var(--z-popover-portal)]（80 > --z-viewer 70）。 */}
                    {!readOnly && (
                      <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label="更多"
                            title="更多"
                            className="oc-spring-press flex size-10 items-center justify-center rounded-full bg-white/10 text-fg outline-none backdrop-blur transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-11"
                          >
                            <MoreHorizontal size={18} />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          sideOffset={8}
                          className="dark w-44 min-w-0 rounded-2xl border-white/10 bg-elevated/95 p-1.5 text-fg shadow-float backdrop-blur"
                        >
                          <DropdownMenuItem
                            onSelect={() => void openInTab()}
                            className="gap-2 rounded-xl px-3 py-2 text-fg data-[highlighted]:bg-white/10 [@media(hover:none)]:min-h-11"
                          >
                            <ArrowUpRight size={16} /> 新标签打开原图
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => void copyLink()}
                            className="gap-2 rounded-xl px-3 py-2 text-fg data-[highlighted]:bg-white/10 [@media(hover:none)]:min-h-11"
                          >
                            <Link2 size={16} /> 复制临时链接
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </header>

                {/* 图片居中:先复用气泡缩略字节做即时预览(零请求、非灰屏),原图流式到达无缝换;
                    支持双击 2× 缩放、滚轮缩放与放大态拖拽平移;无预览时亮深色 shimmer 骨架。 */}
                <div
                  data-testid="image-viewer-stage"
                  onWheel={viewerUrl ? handleStageWheel : undefined}
                  onPointerDown={viewerUrl ? handleStagePointerDown : undefined}
                  onPointerMove={viewerUrl ? handleStagePointerMove : undefined}
                  onPointerUp={viewerUrl ? handleStagePointerEnd : undefined}
                  onPointerCancel={viewerUrl ? handleStagePointerEnd : undefined}
                  className={cn(
                    'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4',
                    zoom.scale > 1.02
                      ? cn('touch-none', dragging ? 'cursor-grabbing' : 'cursor-grab')
                      : viewerUrl && 'cursor-zoom-in',
                  )}
                >
                  {viewerUrl ? (
                    <img
                      src={viewerUrl}
                      alt={alt}
                      decoding="async"
                      referrerPolicy={referrerPolicy}
                      onDoubleClick={toggleDoubleClickZoom}
                      style={{
                        transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
                      }}
                      className={cn(
                        'max-h-full max-w-full origin-center object-contain opacity-100',
                        !dragging && 'transition-transform duration-150 ease-out',
                      )}
                      draggable={false}
                    />
                  ) : (
                    <span aria-hidden className="oc-img-skeleton absolute inset-6 rounded-xl" />
                  )}
                  {viewerStatus === 'loading' && (
                    <div
                      role="status"
                      aria-live="polite"
                      className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-white/10 bg-elevated/85 px-3 py-1 text-xs font-medium tabular-nums text-fg/90 backdrop-blur"
                    >
                      {viewerPercent != null ? `加载原图 ${viewerPercent}%` : '加载原图…'}
                    </div>
                  )}
                  {viewerUrl && (
                    <button
                      type="button"
                      data-testid="image-viewer-zoom-pill"
                      aria-label={zoom.scale > 1.02 ? '还原图片缩放' : '缩放比例 100%，点击放大'}
                      title={zoom.scale > 1.02 ? '点击还原 100%（也可双击图片）' : '双击图片或滚轮可缩放'}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (zoom.scale > 1.02) resetZoom()
                        else setZoom({ scale: 2, x: 0, y: 0 })
                      }}
                      className={cn(
                        'oc-spring-press absolute bottom-3 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 py-1 text-caption font-medium tabular-nums outline-none backdrop-blur transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-10',
                        zoom.scale > 1.02
                          ? 'border-accent/45 bg-elevated/90 text-fg hover:bg-elevated'
                          : 'border-white/10 bg-surface/75 text-muted hover:border-white/20 hover:text-fg',
                      )}
                    >
                      <span>{Math.round(zoom.scale * 100)}%</span>
                      {zoom.scale > 1.02 && (
                        <>
                          <span aria-hidden className="text-white/25">
                            ·
                          </span>
                          <span className="text-accent">还原</span>
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* 底部动作条:编辑 / 评论 / 调整大小(「移除」已按 boss 判定下线)。 */}
                {!readOnly && <div className="flex shrink-0 items-start justify-center gap-3 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:gap-6">
                  <ActionButton
                    label="编辑"
                    featureId={PRODUCT_CAPABILITIES.images.id}
                    icon={<Pencil size={20} />}
                    disabled={!submitImageEdit}
                    reason={editDisabledReason}
                    onDisabledClick={flash}
                    onClick={() => void enterEdit()}
                  />
                  <ActionButton
                    label="评论"
                    icon={<MessageCircle size={20} />}
                    disabled={!submitImageComment}
                    reason={commentDisabledReason}
                    onDisabledClick={flash}
                    onClick={() => setMode('comment')}
                  />
                  <ActionButton
                    label="调整大小"
                    icon={<Scaling size={20} />}
                    disabled={!submitImageEdit}
                    reason={resizeDisabledReason}
                    onDisabledClick={flash}
                    onClick={() => setMode('resize')}
                  />
                </div>}
              </>
            )}

            {/* 复制/分享轻提示 */}
            {notice && (
              <div
                role="status"
                aria-live="polite"
                className="pointer-events-none absolute left-1/2 top-16 z-40 -translate-x-1/2 rounded-full border border-white/15 bg-elevated/90 px-3 py-1.5 text-xs font-medium text-fg shadow-pop backdrop-blur"
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
        cacheIdentity={cacheIdentity}
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
