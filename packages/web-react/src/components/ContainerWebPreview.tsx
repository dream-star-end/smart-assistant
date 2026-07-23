import {
  CONTAINER_PREVIEW_DESKTOP_VIEWPORT,
  CONTAINER_PREVIEW_MOBILE_VIEWPORT,
  type ContainerPreviewClientMessage,
  type ContainerPreviewElementTarget,
  type ContainerPreviewViewport,
  normalizeContainerPreviewViewport,
} from '@openclaude/protocol/containerPreview'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Globe2,
  Hand,
  Keyboard,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  Monitor,
  MoreHorizontal,
  RefreshCw,
  RotateCw,
  Send,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  type ContainerPreviewFrame,
  type ContainerPreviewTransport,
  useContainerPreview,
} from '../hooks/useContainerPreview'
import { apiErrorMessage } from '../lib/api'
import { type ContainerWebAnnotation, buildContainerWebReviewPrompt } from '../lib/containerPreview'
import { PRODUCT_CAPABILITIES } from '../lib/productCapabilities'
import type { AuthSession } from '../lib/types'
import { cn } from '../lib/utils'
import { Modal } from './ui'

type ToolMode = 'interact' | 'comment'
type PreviewSurface = 'none' | 'textComposer' | 'commentsDrawer' | 'draftEditor'
type PreviewDevice = 'desktop' | 'mobile'

type AccessProfile = {
  sourceUrl: string
  device: PreviewDevice
  viewport: ContainerPreviewViewport
}

type CommentDraft = {
  target: ContainerPreviewElementTarget
  comment: string
  editingId: string | null
  targetMissing: boolean
}

type FrameStats = {
  width: number
  height: number
  fps: number
  highQuality: boolean
  responseMs: number | null
}

type PendingFrame = ContainerPreviewFrame

const PHASE_LABEL: Record<string, string> = {
  idle: '等待连接',
  ticket: '正在授权',
  connecting: '正在连接运行环境',
  probing: '正在检查网页',
  launching: '正在启动独立浏览器',
  loading: '正在加载网页',
  ready: '实时预览',
  closed: '连接已断开',
}
const MAX_ANNOTATIONS = 20
const CONTROLS_AUTO_HIDE_MS = 3_000

function readAccessProfile(sourceUrl: string): AccessProfile {
  if (typeof window === 'undefined') {
    return {
      sourceUrl,
      device: 'desktop',
      viewport: CONTAINER_PREVIEW_DESKTOP_VIEWPORT,
    }
  }
  const mobile =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 767px)').matches
      : window.innerWidth <= 767
  const visualViewport = window.visualViewport
  return {
    sourceUrl,
    device: mobile ? 'mobile' : 'desktop',
    viewport: normalizeContainerPreviewViewport({
      width: visualViewport?.width ?? window.innerWidth,
      height: visualViewport?.height ?? window.innerHeight,
      deviceScaleFactor: mobile ? window.devicePixelRatio : 1,
      isMobile: mobile,
    }),
  }
}

export function ContainerWebPreview({
  open,
  sourceUrl,
  auth,
  onClose,
  onUseComments,
}: {
  open: boolean
  sourceUrl: string
  auth: AuthSession | null
  onClose: () => void
  onUseComments: (prompt: string) => void
}) {
  const [accessProfile, setAccessProfile] = useState<AccessProfile>(() =>
    readAccessProfile(sourceUrl),
  )
  const [device, setDevice] = useState<PreviewDevice>(accessProfile.device)
  const [mode, setMode] = useState<ToolMode>('interact')
  const [surface, setSurface] = useState<PreviewSurface>('none')
  const [reconnectKey, setReconnectKey] = useState(0)
  const [annotations, setAnnotations] = useState<ContainerWebAnnotation[]>([])
  const [draft, setDraft] = useState<CommentDraft | null>(null)
  const [selectionHint, setSelectionHint] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [textInput, setTextInput] = useState('')
  const [frameStats, setFrameStats] = useState<FrameStats | null>(null)
  const [controlsVisible, setControlsVisible] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const topControlsRef = useRef<HTMLElement>(null)
  const bottomControlsRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [directScale, setDirectScale] = useState({ x: 1, y: 1 })
  const textInputRef = useRef<HTMLInputElement>(null)
  const commentActionRef = useRef<HTMLButtonElement>(null)
  const commentCountRef = useRef<HTMLButtonElement>(null)
  const drawerCloseRef = useRef<HTMLButtonElement>(null)
  const pinRefs = useRef(new Map<string, HTMLButtonElement>())
  const drawerItemRefs = useRef(new Map<string, HTMLButtonElement>())
  const pendingFrameRef = useRef<PendingFrame | null>(null)
  const decodingRef = useRef(false)
  const frameTimesRef = useRef<number[]>([])
  const lastStatsAtRef = useRef(0)
  const lastInteractionAtRef = useRef<number | null>(null)
  const pointerStartRef = useRef<{ id: number; x: number; y: number; type: string } | null>(null)
  const lastPointerMoveAtRef = useRef(0)
  const textComposingRef = useRef(false)
  const annotationsRef = useRef(annotations)
  const draftRef = useRef(draft)
  const modeRef = useRef(mode)
  const surfaceRef = useRef(surface)

  annotationsRef.current = annotations
  draftRef.current = draft
  modeRef.current = mode
  surfaceRef.current = surface

  const viewport = useMemo<ContainerPreviewViewport>(
    () =>
      device === accessProfile.device
        ? accessProfile.viewport
        : device === 'mobile'
          ? CONTAINER_PREVIEW_MOBILE_VIEWPORT
          : CONTAINER_PREVIEW_DESKTOP_VIEWPORT,
    [accessProfile, device],
  )
  const fillsClientViewport =
    accessProfile.sourceUrl === sourceUrl && device === accessProfile.device

  const drawFrame = useCallback((frame: ContainerPreviewFrame) => {
    pendingFrameRef.current = frame
    if (decodingRef.current) return
    decodingRef.current = true
    void (async () => {
      try {
        while (pendingFrameRef.current) {
          const next = pendingFrameRef.current
          pendingFrameRef.current = null
          const bytes = next.jpeg.slice()
          const blob = new Blob([bytes], { type: 'image/jpeg' })
          const drawable = await decodeJpeg(blob)
          if (pendingFrameRef.current) {
            closeDrawable(drawable)
            continue
          }
          const canvas = canvasRef.current
          const context = canvas?.getContext('2d', { alpha: false })
          if (!canvas || !context) {
            closeDrawable(drawable)
            continue
          }
          canvas.width = next.header.pixelWidth
          canvas.height = next.header.pixelHeight
          context.drawImage(drawable, 0, 0, canvas.width, canvas.height)
          closeDrawable(drawable)

          const now = performance.now()
          const times = frameTimesRef.current.filter((value) => now - value <= 1_000)
          times.push(now)
          frameTimesRef.current = times
          const interactionAt = lastInteractionAtRef.current
          const responseMs =
            interactionAt === null ? null : Math.max(0, Math.round(now - interactionAt))
          if (interactionAt !== null) lastInteractionAtRef.current = null
          if (
            now - lastStatsAtRef.current >= 200 ||
            next.header.highQuality ||
            interactionAt !== null
          ) {
            lastStatsAtRef.current = now
            setFrameStats((current) => ({
              width: next.header.pixelWidth,
              height: next.header.pixelHeight,
              fps: times.length,
              highQuality: next.header.highQuality,
              responseMs: responseMs ?? current?.responseMs ?? null,
            }))
          }
        }
      } catch {
        // Keep the last successfully painted frame. The latest-only stream can recover.
      } finally {
        decodingRef.current = false
        if (pendingFrameRef.current) drawFrame(pendingFrameRef.current)
      }
    })()
  }, [])

  const session = useContainerPreview({
    auth,
    url: sourceUrl,
    viewport,
    enabled: open && accessProfile.sourceUrl === sourceUrl,
    reconnectKey,
    iframeRef,
    onFrame: drawFrame,
  })
  const ready = session.phase === 'ready'
  const controlsAutoHideEligible =
    open && fillsClientViewport && ready && mode === 'interact' && surface === 'none'

  const clearControlsTimer = useCallback(() => {
    if (!controlsTimerRef.current) return
    clearTimeout(controlsTimerRef.current)
    controlsTimerRef.current = null
  }, [])

  const controlsContainFocus = useCallback(() => {
    const active = document.activeElement
    return (
      active instanceof HTMLElement &&
      (topControlsRef.current?.contains(active) || bottomControlsRef.current?.contains(active))
    )
  }, [])

  const scheduleControlsHide = useCallback(() => {
    clearControlsTimer()
    if (!controlsAutoHideEligible) return
    controlsTimerRef.current = setTimeout(() => {
      controlsTimerRef.current = null
      if (controlsContainFocus()) return
      setControlsVisible(false)
    }, CONTROLS_AUTO_HIDE_MS)
  }, [clearControlsTimer, controlsAutoHideEligible, controlsContainFocus])

  const keepControlsVisible = useCallback(() => {
    setControlsVisible(true)
    scheduleControlsHide()
  }, [scheduleControlsHide])

  const revealControls = useCallback(() => {
    keepControlsVisible()
    requestAnimationFrame(() => closeButtonRef.current?.focus())
  }, [keepControlsVisible])

  const handleControlsFocus = useCallback(() => {
    clearControlsTimer()
  }, [clearControlsTimer])

  const handleControlsBlur = useCallback(() => {
    requestAnimationFrame(() => {
      if (!controlsContainFocus()) scheduleControlsHide()
    })
  }, [controlsContainFocus, scheduleControlsHide])

  useEffect(() => {
    clearControlsTimer()
    if (!controlsAutoHideEligible) {
      setControlsVisible(true)
      return
    }
    if (controlsVisible) scheduleControlsHide()
    return clearControlsTimer
  }, [clearControlsTimer, controlsAutoHideEligible, controlsVisible, scheduleControlsHide])

  useEffect(() => {
    if (session.transport !== 'direct') {
      setDirectScale({ x: 1, y: 1 })
      return
    }
    const node = viewportRef.current
    if (!node) return
    const update = () => {
      const { width, height } = node.getBoundingClientRect()
      if (width <= 0 || height <= 0) return
      const next = { x: width / viewport.width, y: height / viewport.height }
      setDirectScale((current) => (current.x === next.x && current.y === next.y ? current : next))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [session.transport, viewport.height, viewport.width])

  useEffect(() => {
    if (accessProfile.sourceUrl === sourceUrl) return
    clearControlsTimer()
    setControlsVisible(true)
    const nextProfile = readAccessProfile(sourceUrl)
    setAccessProfile(nextProfile)
    setDevice(nextProfile.device)
    setMode('interact')
    setSurface('none')
    setAnnotations([])
    setDraft(null)
    setSelectionHint(null)
    setAnnouncement('')
    setTextInput('')
    setFrameStats(null)
    setReconnectKey((value) => value + 1)
  }, [accessProfile.sourceUrl, clearControlsTimer, sourceUrl])

  useEffect(() => {
    const event = session.selection
    if (!event) return
    if (modeRef.current !== 'comment' || surfaceRef.current === 'commentsDrawer') return
    if (!event.target) {
      const message = '这里没有可评论的网页元素，请换个位置再点一次'
      setSelectionHint(message)
      setAnnouncement(message)
      return
    }
    const currentDraft = draftRef.current
    if (!currentDraft && annotationsRef.current.length >= MAX_ANNOTATIONS) {
      const message = `已达到 ${MAX_ANNOTATIONS} 条评论上限，请先编辑或删除已有评论`
      setSelectionHint(message)
      setAnnouncement(message)
      return
    }
    setSelectionHint(null)
    setDraft(
      currentDraft
        ? { ...currentDraft, target: event.target, targetMissing: false }
        : {
            target: event.target,
            comment: '',
            editingId: null,
            targetMissing: false,
          },
    )
    setSurface('draftEditor')
    setAnnouncement(currentDraft ? '已重新选择评论元素' : '已选择元素，请描述希望怎样修改')
  }, [session.selection])

  useEffect(() => {
    const event = session.resolved
    if (!event) return
    const stillRegistered =
      annotationsRef.current.some((annotation) => annotation.target.selector === event.selector) ||
      draftRef.current?.target.selector === event.selector
    if (!stillRegistered) return
    setAnnotations((current) =>
      current.map((annotation) => {
        if (annotation.target.selector !== event.selector) return annotation
        return event.target
          ? { ...annotation, target: event.target, missing: false }
          : { ...annotation, missing: true }
      }),
    )
    setDraft((current) => {
      if (!current || current.target.selector !== event.selector) return current
      return event.target
        ? { ...current, target: event.target, targetMissing: false }
        : { ...current, targetMissing: true }
    })
  }, [session.resolved])

  useEffect(() => {
    if (!session.navigation) return
    const selectors = new Set(
      annotationsRef.current.map((annotation) => annotation.target.selector),
    )
    if (draftRef.current) selectors.add(draftRef.current.target.selector)
    for (const selector of selectors) {
      session.send({ type: 'preview.resolve', selector })
    }
  }, [session.navigation, session.send])

  useEffect(() => {
    if (surface !== 'textComposer') return
    const frame = requestAnimationFrame(() => textInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [surface])

  const sendControl = useCallback(
    (message: ContainerPreviewClientMessage): boolean => {
      if (session.phase !== 'ready') return false
      const sent = session.send(message)
      if (sent && message.type !== 'preview.resolve' && message.type !== 'preview.select') {
        lastInteractionAtRef.current = performance.now()
      }
      return sent
    },
    [session.phase, session.send],
  )

  const reconnect = (nextDevice = device) => {
    keepControlsVisible()
    setDevice(nextDevice)
    setFrameStats(null)
    frameTimesRef.current = []
    pendingFrameRef.current = null
    setSelectionHint(null)
    setReconnectKey((value) => value + 1)
    setAnnouncement('正在重新连接网页预览')
  }

  const pointFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(
        0,
        Math.min(viewport.width, ((event.clientX - rect.left) / rect.width) * viewport.width),
      ),
      y: Math.max(
        0,
        Math.min(viewport.height, ((event.clientY - rect.top) / rect.height) * viewport.height),
      ),
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!ready) return
    event.currentTarget.focus()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {}
    const point = pointFromPointer(event)
    pointerStartRef.current = { id: event.pointerId, ...point, type: event.pointerType }
    if (mode === 'interact' && event.pointerType !== 'touch') {
      sendControl({
        type: 'preview.pointer',
        action: 'down',
        ...point,
        button: pointerButton(event.button),
      })
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!ready || mode !== 'interact' || event.pointerType === 'touch') return
    const now = performance.now()
    if (now - lastPointerMoveAtRef.current < 50) return
    lastPointerMoveAtRef.current = now
    session.send({ type: 'preview.pointer', action: 'move', ...pointFromPointer(event) })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!ready) return
    const point = pointFromPointer(event)
    const start = pointerStartRef.current
    pointerStartRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {}
    if (mode === 'comment') {
      if (event.pointerType === 'touch' && start) {
        const dx = point.x - start.x
        const dy = point.y - start.y
        if (Math.hypot(dx, dy) > 8) {
          sendControl({ type: 'preview.wheel', deltaX: -dx * 2, deltaY: -dy * 2 })
          return
        }
      }
      session.send({ type: 'preview.select', ...point })
      const message = '正在识别网页元素…'
      setSelectionHint(message)
      setAnnouncement(message)
      return
    }
    if (event.pointerType === 'touch' && start) {
      const dx = point.x - start.x
      const dy = point.y - start.y
      if (Math.hypot(dx, dy) > 8) {
        sendControl({ type: 'preview.wheel', deltaX: -dx * 2, deltaY: -dy * 2 })
      } else {
        sendControl({ type: 'preview.pointer', action: 'click', ...point, button: 'left' })
      }
      return
    }
    sendControl({
      type: 'preview.pointer',
      action: 'up',
      ...point,
      button: pointerButton(event.button),
    })
  }

  const onWheel = (event: ReactWheelEvent<HTMLElement>) => {
    if (!ready) return
    event.preventDefault()
    sendControl({ type: 'preview.wheel', deltaX: event.deltaX, deltaY: event.deltaY })
  }

  const focusSoon = (target: () => HTMLElement | null | undefined) => {
    requestAnimationFrame(() => target()?.focus())
  }

  const previewFocusTarget = () =>
    session.transport === 'direct' ? iframeRef.current : canvasRef.current

  const focusDraftOrigin = (value = draftRef.current) => {
    if (value?.editingId) {
      focusSoon(() => pinRefs.current.get(value.editingId!))
      return
    }
    focusSoon(previewFocusTarget)
  }

  const enterCommentMode = () => {
    if (!ready) return
    const currentDraft = draftRef.current
    setMode('comment')
    setSurface(currentDraft ? 'draftEditor' : 'none')
    setAnnouncement(currentDraft ? '已恢复未保存的元素评论' : '评论模式：点按页面元素添加修改意见')
    if (!currentDraft) focusSoon(previewFocusTarget)
  }

  const leaveCommentMode = () => {
    setSurface('none')
    setMode('interact')
    setSelectionHint(null)
    setAnnouncement('已返回网页操作模式')
    focusSoon(() => commentActionRef.current)
  }

  const editAnnotation = (annotation: ContainerWebAnnotation) => {
    const currentDraft = draftRef.current
    if (currentDraft) {
      if (currentDraft.editingId === annotation.id) {
        setSurface('draftEditor')
        return
      }
      setSurface('draftEditor')
      setAnnouncement('请先保存或取消当前未完成的评论')
      return
    }
    setMode('comment')
    setDraft({
      target: annotation.target,
      comment: annotation.comment,
      editingId: annotation.id,
      targetMissing: Boolean(annotation.missing),
    })
    setSurface('draftEditor')
  }

  const cancelDraft = () => {
    const previous = draftRef.current
    setDraft(null)
    setSurface('none')
    setAnnouncement(previous?.editingId ? '已取消修改，原评论保持不变' : '已取消未保存的评论')
    focusDraftOrigin(previous)
  }

  const hideDraftEditor = () => {
    setSurface('none')
    setAnnouncement('评论草稿已保留')
    focusDraftOrigin()
  }

  const saveDraft = () => {
    const current = draftRef.current
    const comment = current?.comment.trim() ?? ''
    if (!current || !comment || current.targetMissing) return
    const pageUrl = session.navigation?.url ?? session.ready?.url ?? sourceUrl
    const pageTitle = session.navigation?.title ?? session.ready?.title ?? ''
    const savedId = current.editingId ?? crypto.randomUUID()
    if (current.editingId) {
      setAnnotations((items) =>
        items.map((annotation) =>
          annotation.id === current.editingId
            ? {
                ...annotation,
                target: current.target,
                comment,
                pageUrl,
                pageTitle,
                missing: false,
              }
            : annotation,
        ),
      )
    } else {
      setAnnotations((items) => [
        ...items,
        {
          id: savedId,
          target: current.target,
          comment,
          pageUrl,
          pageTitle,
        },
      ])
    }
    setDraft(null)
    setSurface('none')
    setAnnouncement(current.editingId ? '评论已保存' : '评论已添加')
    focusSoon(() => pinRefs.current.get(savedId) ?? previewFocusTarget())
  }

  const deleteAnnotation = (id: string, index: number, focus: 'drawer' | 'canvas' = 'canvas') => {
    const remaining = annotationsRef.current.filter((annotation) => annotation.id !== id)
    setAnnotations(remaining)
    if (draftRef.current?.editingId === id) {
      setDraft(null)
      setSurface(focus === 'drawer' ? 'commentsDrawer' : 'none')
    }
    setAnnouncement(`已删除评论 ${index + 1}`)
    focusSoon(() => {
      if (focus === 'drawer') {
        const neighbor = remaining[index] ?? remaining[index - 1]
        return neighbor ? drawerItemRefs.current.get(neighbor.id) : drawerCloseRef.current
      }
      const neighbor = remaining[index] ?? remaining[index - 1]
      return neighbor ? pinRefs.current.get(neighbor.id) : previewFocusTarget()
    })
  }

  const submitReview = () => {
    if (annotations.length === 0) return
    onUseComments(
      buildContainerWebReviewPrompt({
        sourceUrl,
        currentUrl: session.navigation?.url ?? session.ready?.url ?? sourceUrl,
        title: session.navigation?.title ?? session.ready?.title ?? '',
        viewport,
        annotations,
      }),
    )
    onClose()
  }

  const closeCommentsDrawer = () => {
    setSurface('none')
    focusSoon(() => commentCountRef.current)
  }

  const visibleTargets = useMemo(() => {
    if (mode !== 'comment') return []
    const items: Array<{
      key: string
      target: ContainerPreviewElementTarget
      label: number
      active: boolean
      missing: boolean
      annotation: ContainerWebAnnotation | null
    }> = annotations.map((annotation, index) => {
      const activeDraft = draft?.editingId === annotation.id ? draft : null
      return {
        key: annotation.id,
        target: activeDraft?.target ?? annotation.target,
        label: index + 1,
        active: Boolean(activeDraft),
        missing: activeDraft ? activeDraft.targetMissing : Boolean(annotation.missing),
        annotation,
      }
    })
    if (draft && !draft.editingId) {
      items.push({
        key: 'draft',
        target: draft.target,
        label: annotations.length + 1,
        active: true,
        missing: draft.targetMissing,
        annotation: null,
      })
    }
    return items
  }, [annotations, draft, mode])

  const aspect = viewport.width / viewport.height
  const previewWidth = `min(${device === 'mobile' ? '430px' : '1280px'}, 100%, calc((100dvh - 168px) * ${aspect}))`
  const displayTitle = session.navigation?.title || session.ready?.title || '容器内网页'
  const displayUrl = session.navigation?.url || sourceUrl
  const hasError = Boolean(session.error || (session.phase === 'closed' && !session.error))

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onClose()}
      onEscapeKeyDown={(event) => {
        const activeSurface = surfaceRef.current
        if (activeSurface !== 'none') {
          event.preventDefault()
          if (activeSurface === 'commentsDrawer') closeCommentsDrawer()
          else if (activeSurface === 'draftEditor') hideDraftEditor()
          else {
            setSurface('none')
            focusSoon(previewFocusTarget)
          }
          return
        }
        if (modeRef.current === 'comment') {
          event.preventDefault()
          leaveCommentMode()
        }
      }}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        requestAnimationFrame(() => previewFocusTarget()?.focus())
      }}
      srTitle="容器网页预览与元素评论"
      hideClose
      className="left-0 top-[var(--oc-visual-offset-top,0px)] h-[var(--oc-visual-height,100dvh)] max-h-[var(--oc-visual-height,100dvh)] w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-[#0c0c11]"
      bodyClassName="overflow-hidden p-0"
    >
      <div
        className="preview-shell relative flex h-full min-h-0 flex-col overflow-hidden"
        data-product-feature={PRODUCT_CAPABILITIES.containerPreview.id}
        data-controls-visible={controlsVisible}
      >
        <div className="preview-ambient pointer-events-none absolute inset-0" />

        {mode === 'interact' && controlsVisible && (
          <header
            ref={topControlsRef}
            className="preview-floating-header preview-controls-enter"
            onPointerDownCapture={keepControlsVisible}
            onKeyDownCapture={keepControlsVisible}
            onFocusCapture={handleControlsFocus}
            onBlurCapture={handleControlsBlur}
          >
            <div className="preview-header-row mx-auto flex w-full max-w-[1600px] items-center gap-2 px-2 sm:px-4">
              <button
                ref={closeButtonRef}
                type="button"
                onClick={onClose}
                aria-label="关闭网页预览"
                title="关闭 (Esc)"
                className="preview-icon-button"
              >
                <X size={19} />
              </button>
              <div className="hidden items-center gap-1 sm:flex">
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => sendControl({ type: 'preview.navigate', action: 'back' })}
                  aria-label="后退"
                  className="preview-icon-button"
                >
                  <ArrowLeft size={18} />
                </button>
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => sendControl({ type: 'preview.navigate', action: 'forward' })}
                  aria-label="前进"
                  className="preview-icon-button"
                >
                  <ArrowRight size={18} />
                </button>
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => sendControl({ type: 'preview.navigate', action: 'reload' })}
                  aria-label="刷新网页"
                  className="preview-icon-button"
                >
                  <RotateCw size={17} />
                </button>
              </div>
              <div
                className="preview-address-pill min-w-0 flex-1"
                title={`${displayTitle}\n${displayUrl}`}
              >
                <Globe2
                  className="preview-accent-text hidden shrink-0 min-[430px]:block"
                  size={16}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-semibold text-white/90">
                    {displayTitle}
                  </span>
                  <span className="block truncate text-[10px] text-white/45">{displayUrl}</span>
                </span>
              </div>
              <button
                type="button"
                disabled={!ready}
                onClick={() => sendControl({ type: 'preview.navigate', action: 'reload' })}
                aria-label="刷新网页"
                className="preview-icon-button preview-mobile-reload"
              >
                <RotateCw size={17} />
              </button>
              <div className="preview-device-switch" aria-label="预览设备">
                <DeviceButton
                  active={device === 'desktop'}
                  label="桌面"
                  onClick={() => device !== 'desktop' && reconnect('desktop')}
                >
                  <Monitor size={17} />
                </DeviceButton>
                <DeviceButton
                  active={device === 'mobile'}
                  label="移动"
                  onClick={() => device !== 'mobile' && reconnect('mobile')}
                >
                  <Smartphone size={17} />
                </DeviceButton>
              </div>
              {session.transport === 'direct' && (
                <button
                  type="button"
                  onClick={() => {
                    keepControlsVisible()
                    session.useLegacyFallback()
                  }}
                  aria-label="切换兼容预览"
                  title="兼容模式（远程浏览器）"
                  className="preview-icon-button"
                >
                  <RefreshCw size={16} />
                </button>
              )}
            </div>
          </header>
        )}

        {mode === 'comment' && (
          <header className="preview-floating-header">
            <div className="preview-header-row mx-auto grid w-full max-w-[1100px] grid-cols-[auto_1fr_auto] items-center gap-2 px-2 sm:px-4">
              <button
                type="button"
                onClick={leaveCommentMode}
                aria-label="返回操作网页"
                className="preview-icon-button"
              >
                <ArrowLeft size={19} />
              </button>
              <button
                ref={commentCountRef}
                type="button"
                onClick={() => setSurface('commentsDrawer')}
                aria-haspopup="dialog"
                aria-expanded={surface === 'commentsDrawer'}
                className="preview-comment-count"
              >
                <ListChecks size={16} />
                <span>{annotations.length} 条评论</span>
              </button>
              <button
                type="button"
                disabled={annotations.length === 0}
                onClick={submitReview}
                title="只加入输入框，不会自动发送或附截图"
                className="preview-primary-button"
              >
                <span className="hidden min-[430px]:inline">加入输入框</span>
                <span className="min-[430px]:hidden">完成</span>
                <Send size={15} />
              </button>
            </div>
          </header>
        )}

        {mode === 'interact' && surface === 'none' && !controlsVisible && (
          <div className="preview-controls-reveal">
            <button
              type="button"
              aria-label="显示预览控制"
              aria-expanded="false"
              onClick={revealControls}
              className="preview-icon-button"
            >
              <MoreHorizontal size={20} />
            </button>
          </div>
        )}

        <main
          className={cn(
            'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2 pb-[calc(88px+env(safe-area-inset-bottom))] pt-[calc(76px+env(safe-area-inset-top))] sm:px-6 sm:pb-24 sm:pt-20',
            fillsClientViewport && 'absolute inset-0 p-0 sm:p-0',
          )}
        >
          {!hasError && (!ready || controlsVisible) && (
            <PreviewStatus
              phase={session.phase}
              ready={ready}
              frameStats={frameStats}
              transport={session.transport}
            />
          )}
          <div
            ref={viewportRef}
            data-testid="container-preview-viewport"
            data-fullscreen={fillsClientViewport}
            className={cn(
              'preview-viewport relative max-h-full max-w-full overflow-hidden',
              !fillsClientViewport && (device === 'mobile' ? 'rounded-[28px]' : 'rounded-xl'),
              fillsClientViewport && 'size-full max-h-none max-w-none rounded-none border-0',
              mode === 'comment' && ready && 'preview-viewport-selecting',
              hasError && 'preview-viewport-error',
            )}
            style={
              fillsClientViewport
                ? { width: '100%', height: '100%' }
                : { aspectRatio: `${viewport.width} / ${viewport.height}`, width: previewWidth }
            }
          >
            {session.transport === 'direct' && session.directUrl ? (
              <>
                <iframe
                  ref={iframeRef}
                  src={session.directUrl}
                  title="容器内网页原生预览"
                  sandbox="allow-scripts allow-forms allow-same-origin allow-modals allow-popups"
                  referrerPolicy="no-referrer"
                  className={cn(
                    'absolute left-0 top-0 border-0 bg-white outline-none',
                    mode === 'comment' && 'pointer-events-none',
                  )}
                  style={{
                    width: `${viewport.width}px`,
                    height: `${viewport.height}px`,
                    transform: `scale(${directScale.x}, ${directScale.y})`,
                    transformOrigin: 'top left',
                  }}
                  onError={session.useLegacyFallback}
                />
                {mode === 'comment' && ready && (
                  <div
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: the overlay is the keyboard focus surface for coordinate-based DOM selection
                    tabIndex={0}
                    role="application"
                    aria-label="网页画面，点按选择评论元素"
                    className="absolute inset-0 z-[5] touch-none cursor-crosshair outline-none"
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={() => {
                      pointerStartRef.current = null
                    }}
                    onContextMenu={(event) => event.preventDefault()}
                    onWheel={onWheel}
                  />
                )}
              </>
            ) : (
              <canvas
                ref={canvasRef}
                tabIndex={ready ? 0 : -1}
                aria-label={mode === 'comment' ? '网页画面，点按选择评论元素' : '可交互网页画面'}
                aria-disabled={!ready}
                className={cn(
                  'block size-full touch-none select-none object-fill outline-none',
                  mode === 'comment' && ready ? 'cursor-crosshair' : 'cursor-default',
                )}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                  pointerStartRef.current = null
                }}
                onContextMenu={(event) => event.preventDefault()}
                onWheel={onWheel}
                onKeyDown={(event) => {
                  if (!ready || mode !== 'interact' || event.nativeEvent.isComposing) return
                  const key = keyboardShortcut(event)
                  if (!key) return
                  event.preventDefault()
                  sendControl({ type: 'preview.key', key })
                }}
              />
            )}

            {visibleTargets.map(({ key, target, label, active, missing, annotation }) => (
              <div
                key={key}
                style={targetOverlayStyle(target, viewport)}
                className={cn(
                  'preview-target-box pointer-events-none absolute z-10',
                  active && 'preview-target-box-active',
                  missing && 'preview-target-box-missing',
                )}
              >
                <button
                  ref={(node) => {
                    if (node) pinRefs.current.set(key, node)
                    else pinRefs.current.delete(key)
                  }}
                  type="button"
                  aria-label={
                    annotation
                      ? `编辑网页评论 ${label}：${annotation.comment.slice(0, 80)}${missing ? '，元素未重新匹配' : ''}`
                      : '继续编辑未保存的网页评论'
                  }
                  onClick={() => {
                    if (annotation) editAnnotation(annotation)
                    else setSurface('draftEditor')
                  }}
                  className="preview-anchor-hit pointer-events-auto"
                >
                  <span
                    className={cn('preview-anchor-dot', missing && 'preview-anchor-dot-missing')}
                  >
                    {label}
                  </span>
                </button>
              </div>
            ))}

            {!ready && !hasError && (
              <output
                aria-live="polite"
                className="preview-loading-state absolute inset-0 flex flex-col items-center justify-center text-center"
              >
                <span className="preview-state-icon">
                  <Loader2 className="animate-spin" size={21} />
                </span>
                <span className="preview-state-title">
                  {PHASE_LABEL[session.phase] ?? '正在准备预览'}
                </span>
                <span className="preview-state-copy">
                  {session.transport === 'direct'
                    ? '正在建立原生网页通道，失败会自动切换兼容模式'
                    : '首次启动独立浏览器可能需要几秒'}
                </span>
              </output>
            )}

            {hasError && (
              <PreviewError
                detail={session.error?.message ?? '网页预览连接已断开'}
                retryable={session.error?.retryable ?? true}
                onRetry={() =>
                  session.transport === 'direct' ? session.useLegacyFallback() : reconnect()
                }
              />
            )}
          </div>

          {selectionHint && (
            <output
              aria-live="polite"
              className="preview-toast pointer-events-none absolute bottom-[calc(92px+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2"
            >
              {selectionHint}
            </output>
          )}
        </main>

        {mode === 'interact' && surface === 'none' && controlsVisible && (
          <div
            ref={bottomControlsRef}
            className="preview-bottom-layer preview-controls-enter"
            onPointerDownCapture={keepControlsVisible}
            onKeyDownCapture={keepControlsVisible}
            onFocusCapture={handleControlsFocus}
            onBlurCapture={handleControlsBlur}
          >
            <div className="preview-action-dock" aria-label="网页预览工具">
              <PreviewActionButton
                active
                label="操作"
                icon={<Hand size={20} />}
                onClick={() => focusSoon(previewFocusTarget)}
              />
              <PreviewActionButton
                buttonRef={commentActionRef}
                disabled={!ready}
                label="评论"
                icon={<MessageSquarePlus size={20} />}
                onClick={enterCommentMode}
              />
              <PreviewActionButton
                disabled={!ready}
                label="输入"
                icon={<Keyboard size={20} />}
                onClick={() => setSurface('textComposer')}
              />
            </div>
          </div>
        )}

        {mode === 'interact' && surface === 'textComposer' && (
          <form
            className="preview-bottom-layer"
            onSubmit={(event) => {
              event.preventDefault()
              if (textComposingRef.current || !textInput) return
              if (!sendControl({ type: 'preview.text', text: textInput })) return
              setTextInput('')
              setSurface('none')
              setAnnouncement('文字已输入到网页当前焦点')
              focusSoon(previewFocusTarget)
            }}
          >
            <div className="preview-composer">
              <button
                type="button"
                aria-label="关闭文字输入"
                onClick={() => {
                  setSurface('none')
                  focusSoon(previewFocusTarget)
                }}
                className="preview-icon-button"
              >
                <X size={18} />
              </button>
              <input
                ref={textInputRef}
                value={textInput}
                onChange={(event) => setTextInput(event.target.value.slice(0, 2_000))}
                onCompositionStart={() => {
                  textComposingRef.current = true
                }}
                onCompositionEnd={() => {
                  textComposingRef.current = false
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.nativeEvent.isComposing || textComposingRef.current)
                  ) {
                    event.preventDefault()
                  }
                }}
                aria-label="输入网页文字"
                placeholder="输入到网页当前焦点…"
                className="min-w-0 flex-1 bg-transparent px-1 text-base text-white outline-none placeholder:text-white/35"
              />
              <button
                type="submit"
                disabled={!ready || !textInput}
                aria-label="确认输入网页文字"
                className="preview-composer-submit"
              >
                <Send size={17} />
              </button>
            </div>
          </form>
        )}

        {mode === 'comment' && surface === 'draftEditor' && draft && (
          <CommentEditor
            key={`${draft.editingId ?? 'new'}:${draft.target.selector}`}
            draft={draft}
            annotationIndex={
              draft.editingId
                ? annotations.findIndex((annotation) => annotation.id === draft.editingId)
                : annotations.length
            }
            onChange={(comment) =>
              setDraft((current) => (current ? { ...current, comment } : null))
            }
            onHide={hideDraftEditor}
            onCancel={cancelDraft}
            onSave={saveDraft}
            onDelete={
              draft.editingId
                ? () => {
                    const index = annotations.findIndex(
                      (annotation) => annotation.id === draft.editingId,
                    )
                    if (index >= 0) deleteAnnotation(draft.editingId!, index)
                  }
                : undefined
            }
          />
        )}

        {mode === 'comment' && surface === 'none' && (
          <div className="preview-bottom-layer pointer-events-none">
            <div className="preview-comment-hint pointer-events-auto">
              {draft ? (
                <>
                  <span>有一条未保存的评论</span>
                  <button type="button" onClick={() => setSurface('draftEditor')}>
                    继续编辑
                  </button>
                </>
              ) : (
                <>
                  <MessageSquarePlus size={16} />
                  <span>点按元素添加评论，滑动或滚轮可浏览页面</span>
                </>
              )}
              <span className="hidden border-l border-white/10 pl-3 text-white/35 sm:inline">
                只预填修改要求，不会自动发送或附截图
              </span>
            </div>
          </div>
        )}

        {mode === 'comment' && surface === 'commentsDrawer' && (
          <Modal
            open
            onOpenChange={(next) => !next && closeCommentsDrawer()}
            srTitle="网页评论列表"
            hideClose
            className="preview-comments-modal"
            bodyClassName="overflow-hidden p-0"
          >
            <CommentsDrawer
              annotations={annotations}
              closeButtonRef={drawerCloseRef}
              setItemRef={(id, node) => {
                if (node) drawerItemRefs.current.set(id, node)
                else drawerItemRefs.current.delete(id)
              }}
              onClose={closeCommentsDrawer}
              onEdit={(annotation) => {
                editAnnotation(annotation)
              }}
              onDelete={(id, index) => deleteAnnotation(id, index, 'drawer')}
            />
          </Modal>
        )}

        <output aria-live="polite" className="sr-only">
          {announcement}
        </output>
      </div>
    </Modal>
  )
}

function PreviewStatus({
  phase,
  ready,
  frameStats,
  transport,
}: {
  phase: string
  ready: boolean
  frameStats: FrameStats | null
  transport: ContainerPreviewTransport
}) {
  return (
    <output className="preview-status-pill" aria-live="polite">
      <span className={cn('size-1.5 rounded-full', ready ? 'bg-emerald-400' : 'bg-amber-300')} />
      <span>{PHASE_LABEL[phase] ?? phase}</span>
      {ready && transport === 'direct' && (
        <span className="hidden border-l border-white/10 pl-2 text-emerald-200/65 sm:inline">
          原生清晰预览
        </span>
      )}
      {frameStats && (
        <span className="hidden border-l border-white/10 pl-2 text-white/40 lg:inline">
          {frameStats.width}×{frameStats.height} · {frameStats.fps} fps ·{' '}
          {frameStats.highQuality ? '高清' : '实时'}
          {frameStats.responseMs !== null ? ` · ${frameStats.responseMs} ms` : ''}
        </span>
      )}
    </output>
  )
}

function PreviewError({
  detail,
  retryable,
  onRetry,
}: {
  detail: string
  retryable: boolean
  onRetry: () => void
}) {
  return (
    <div role="alert" className="preview-error-state absolute inset-0">
      <div className="preview-error-content">
        <span className="preview-error-icon">
          <CircleAlert size={21} />
        </span>
        <h2 className="preview-error-title">无法连接网页预览</h2>
        <p className="preview-error-copy">
          运行环境可能仍在启动，或网页服务暂时不可用。请确认网页已运行后重试。
        </p>
        {retryable && (
          <button type="button" onClick={onRetry} className="preview-primary-button mx-auto mt-3.5">
            <RefreshCw size={16} />
            重新连接
          </button>
        )}
        <details className="preview-error-details group">
          <summary>诊断详情</summary>
          <p className="preview-error-detail-body">{detail}</p>
        </details>
      </div>
    </div>
  )
}

function PreviewActionButton({
  buttonRef,
  active = false,
  disabled = false,
  label,
  icon,
  onClick,
}: {
  buttonRef?: RefObject<HTMLButtonElement | null>
  active?: boolean
  disabled?: boolean
  label: string
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      aria-pressed={label === '操作' || label === '评论' ? active : undefined}
      onClick={onClick}
      className={cn('preview-action-button', active && 'preview-action-button-active')}
    >
      <span className="preview-action-icon">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

function DeviceButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={`${label}预览`}
      aria-pressed={active}
      onClick={onClick}
      className={cn('preview-device-button', active && 'preview-device-button-active')}
    >
      {children}
      <span className="hidden lg:inline">{label}</span>
    </button>
  )
}

function CommentEditor({
  draft,
  annotationIndex,
  onChange,
  onHide,
  onCancel,
  onSave,
  onDelete,
}: {
  draft: CommentDraft
  annotationIndex: number
  onChange: (value: string) => void
  onHide: () => void
  onCancel: () => void
  onSave: () => void
  onDelete?: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const frame = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className="preview-bottom-layer">
      <section className="preview-comment-editor" aria-label="编辑网页评论">
        <div className="flex min-w-0 items-start gap-3">
          <span className="preview-anchor-dot static mt-0.5 shrink-0 translate-x-0 translate-y-0">
            {annotationIndex + 1}
          </span>
          <div className="min-w-0 flex-1">
            <ElementSummary target={draft.target} />
            {draft.targetMissing && (
              <p className="mt-2 text-xs leading-5 text-amber-200">
                页面变化后未找到这个元素，请在画面中重新选择后再保存。
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label="收起评论编辑器"
            title="收起并保留草稿 (Esc)"
            onClick={onHide}
            className="preview-icon-button -mr-1 -mt-1"
          >
            <X size={17} />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={draft.comment}
          maxLength={2_000}
          onChange={(event) => onChange(event.target.value)}
          aria-label="描述网页修改"
          placeholder="例如：按钮改成品牌色，文案改为“立即开始”，移动端占满一行。"
          className="mt-3 min-h-20 w-full resize-none bg-transparent text-sm leading-6 text-white outline-none placeholder:text-white/30"
        />
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/10 pt-2">
          <div className="flex items-center gap-1">
            {onDelete && (
              <button
                type="button"
                aria-label="删除该评论"
                onClick={onDelete}
                className="preview-secondary-button preview-destructive-button"
              >
                <Trash2 size={15} />
                删除
              </button>
            )}
            <button type="button" onClick={onCancel} className="preview-secondary-button">
              {draft.editingId ? '取消修改' : '取消草稿'}
            </button>
          </div>
          <button
            type="button"
            disabled={!draft.comment.trim() || draft.targetMissing}
            onClick={onSave}
            aria-label={draft.editingId ? '保存评论' : '添加评论'}
            className="preview-primary-button"
          >
            <Check size={15} />
            {draft.editingId ? '保存' : '添加评论'}
          </button>
        </div>
      </section>
    </div>
  )
}

function CommentsDrawer({
  annotations,
  closeButtonRef,
  setItemRef,
  onClose,
  onEdit,
  onDelete,
}: {
  annotations: ContainerWebAnnotation[]
  closeButtonRef: RefObject<HTMLButtonElement | null>
  setItemRef: (id: string, node: HTMLButtonElement | null) => void
  onClose: () => void
  onEdit: (annotation: ContainerWebAnnotation) => void
  onDelete: (id: string, index: number) => void
}) {
  return (
    <section className="preview-comments-drawer">
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">网页修改评论</h2>
          <p className="mt-0.5 text-xs text-white/40">
            {annotations.length}/{MAX_ANNOTATIONS} 条
          </p>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="关闭评论列表"
          onClick={onClose}
          className="preview-icon-button"
        >
          <X size={18} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {annotations.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-6 text-center text-white/45">
            <MessageSquarePlus size={24} />
            <p className="text-sm leading-6">还没有评论，关闭列表后点按网页元素即可添加。</p>
          </div>
        ) : (
          <div className="space-y-2">
            {annotations.map((annotation, index) => (
              <div
                key={annotation.id}
                className="flex items-start gap-1 rounded-2xl border border-white/10 bg-white/[0.035] p-2"
              >
                <button
                  ref={(node) => setItemRef(annotation.id, node)}
                  type="button"
                  onClick={() => onEdit(annotation)}
                  className="preview-comment-item flex min-h-11 min-w-0 flex-1 items-start gap-3 rounded-xl p-2 text-left hover:bg-white/[0.05]"
                >
                  <span
                    className={cn(
                      'preview-anchor-dot static shrink-0 translate-x-0 translate-y-0',
                      annotation.missing && 'preview-anchor-dot-missing',
                    )}
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="preview-accent-text block truncate text-xs font-medium">
                      {annotation.target.selector}
                    </span>
                    <span className="mt-1 line-clamp-3 block text-sm leading-5 text-white/70">
                      {annotation.comment}
                    </span>
                    {annotation.missing && (
                      <span className="mt-1 block text-xs text-amber-200">
                        页面变化后未重新匹配
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`删除评论 ${index + 1}`}
                  onClick={() => onDelete(annotation.id, index)}
                  className="preview-icon-button preview-delete-button"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="border-t border-white/10 px-4 py-3 text-xs leading-5 text-white/35">
        点击评论可重新编辑。加入输入框时不会附截图，也不会自动发送。
      </p>
    </section>
  )
}

function ElementSummary({ target }: { target: ContainerPreviewElementTarget }) {
  const label = target.ariaLabel || target.text
  return (
    <div className="min-w-0">
      <div className="preview-accent-text truncate text-xs font-semibold">{target.selector}</div>
      <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-white/45">
        <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5">&lt;{target.tag}&gt;</span>
        {target.role && (
          <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5">role={target.role}</span>
        )}
        {label && <span className="line-clamp-1">{label}</span>}
      </div>
    </div>
  )
}

function targetOverlayStyle(
  target: ContainerPreviewElementTarget,
  viewport: ContainerPreviewViewport,
) {
  const left = Math.max(0, Math.min(100, (target.bounds.x / viewport.width) * 100))
  const top = Math.max(0, Math.min(100, (target.bounds.y / viewport.height) * 100))
  const width = Math.max(1.5, Math.min(100 - left, (target.bounds.width / viewport.width) * 100))
  const height = Math.max(1.5, Math.min(100 - top, (target.bounds.height / viewport.height) * 100))
  return { left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }
}

function pointerButton(button: number): 'left' | 'middle' | 'right' {
  return button === 1 ? 'middle' : button === 2 ? 'right' : 'left'
}

function keyboardShortcut(event: ReactKeyboardEvent<HTMLCanvasElement>): string | null {
  if (event.key.length > 32 || event.key === 'Dead' || event.key === 'Process') return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.metaKey) parts.push('Meta')
  if (event.shiftKey && event.key.length > 1) parts.push('Shift')
  parts.push(event.key === ' ' ? 'Space' : event.key)
  return parts.join('+')
}

async function decodeJpeg(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob)
  const objectUrl = URL.createObjectURL(blob)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('JPEG decode failed'))
      image.src = objectUrl
    })
  } catch (err) {
    throw new Error(apiErrorMessage(err, 'JPEG decode failed'))
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function closeDrawable(drawable: ImageBitmap | HTMLImageElement): void {
  if ('close' in drawable && typeof drawable.close === 'function') drawable.close()
}
