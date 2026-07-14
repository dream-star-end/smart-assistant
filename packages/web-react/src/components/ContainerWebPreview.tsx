import {
  CONTAINER_PREVIEW_DESKTOP_VIEWPORT,
  CONTAINER_PREVIEW_MOBILE_VIEWPORT,
  type ContainerPreviewClientMessage,
  type ContainerPreviewElementTarget,
  type ContainerPreviewViewport,
} from '@openclaude/protocol/containerPreview'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Hand,
  Keyboard,
  Loader2,
  MessageSquarePlus,
  Monitor,
  MousePointer2,
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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { type ContainerPreviewFrame, useContainerPreview } from '../hooks/useContainerPreview'
import { apiErrorMessage } from '../lib/api'
import { type ContainerWebAnnotation, buildContainerWebReviewPrompt } from '../lib/containerPreview'
import type { AuthSession } from '../lib/types'
import { cn } from '../lib/utils'
import { Modal } from './ui'

type ToolMode = 'interact' | 'select'

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
  connecting: '正在连接容器',
  probing: '正在检查网页',
  launching: '正在启动独立浏览器',
  loading: '正在加载网页',
  ready: '实时预览',
  closed: '连接已断开',
}
const MAX_ANNOTATIONS = 20

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
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const [mode, setMode] = useState<ToolMode>('interact')
  const [reconnectKey, setReconnectKey] = useState(0)
  const [annotations, setAnnotations] = useState<ContainerWebAnnotation[]>([])
  const [draftTarget, setDraftTarget] = useState<ContainerPreviewElementTarget | null>(null)
  const [draftComment, setDraftComment] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [selectionHint, setSelectionHint] = useState<string | null>(null)
  const [textInputOpen, setTextInputOpen] = useState(false)
  const [textInput, setTextInput] = useState('')
  const [frameStats, setFrameStats] = useState<FrameStats | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pendingFrameRef = useRef<PendingFrame | null>(null)
  const decodingRef = useRef(false)
  const frameTimesRef = useRef<number[]>([])
  const lastStatsAtRef = useRef(0)
  const lastInteractionAtRef = useRef<number | null>(null)
  const pointerStartRef = useRef<{ id: number; x: number; y: number; type: string } | null>(null)
  const lastPointerMoveAtRef = useRef(0)
  const annotationsRef = useRef(annotations)
  const sourceUrlRef = useRef(sourceUrl)

  const viewport = useMemo<ContainerPreviewViewport>(
    () => ({
      ...(device === 'mobile'
        ? CONTAINER_PREVIEW_MOBILE_VIEWPORT
        : CONTAINER_PREVIEW_DESKTOP_VIEWPORT),
    }),
    [device],
  )

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
          // A newer packet completed while this JPEG decoded. Skip the stale
          // paint rather than building a client-side latency queue.
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
        // Keep the last successfully painted frame if a corrupt JPEG slips
        // through; the next valid latest-only packet can recover the view.
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
    enabled: open,
    reconnectKey,
    onFrame: drawFrame,
  })

  annotationsRef.current = annotations

  useEffect(() => {
    if (sourceUrlRef.current === sourceUrl) return
    sourceUrlRef.current = sourceUrl
    setDevice('desktop')
    setMode('interact')
    setAnnotations([])
    setDraftTarget(null)
    setDraftComment('')
    setEditingId(null)
    setSelectionHint(null)
    setFrameStats(null)
    setReconnectKey((value) => value + 1)
  }, [sourceUrl])

  useEffect(() => {
    const event = session.selection
    if (!event) return
    if (!event.target) {
      setSelectionHint('这里没有可标注的网页元素，请换个位置再点一次')
      return
    }
    if (annotationsRef.current.length >= MAX_ANNOTATIONS) {
      setSelectionHint(`最多添加 ${MAX_ANNOTATIONS} 条评论，请先编辑或删除已有评论`)
      return
    }
    setSelectionHint(null)
    setDraftTarget(event.target)
    setDraftComment('')
    setEditingId(null)
  }, [session.selection])

  useEffect(() => {
    const event = session.resolved
    if (!event) return
    setAnnotations((current) =>
      current.map((annotation) => {
        if (annotation.target.selector !== event.selector) return annotation
        return event.target
          ? { ...annotation, target: event.target, missing: false }
          : { ...annotation, missing: true }
      }),
    )
  }, [session.resolved])

  useEffect(() => {
    if (!session.navigation) return
    for (const annotation of annotationsRef.current) {
      session.send({ type: 'preview.resolve', selector: annotation.target.selector })
    }
  }, [session.navigation, session.send])

  const sendControl = useCallback(
    (message: ContainerPreviewClientMessage): boolean => {
      const sent = session.send(message)
      if (sent && message.type !== 'preview.resolve' && message.type !== 'preview.select') {
        lastInteractionAtRef.current = performance.now()
      }
      return sent
    },
    [session.send],
  )

  const reconnect = (nextDevice = device) => {
    setDevice(nextDevice)
    setFrameStats(null)
    frameTimesRef.current = []
    pendingFrameRef.current = null
    setReconnectKey((value) => value + 1)
  }

  const pointFromPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
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

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.focus()
    event.currentTarget.setPointerCapture(event.pointerId)
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

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (mode !== 'interact' || event.pointerType === 'touch') return
    const now = performance.now()
    if (now - lastPointerMoveAtRef.current < 50) return
    lastPointerMoveAtRef.current = now
    session.send({ type: 'preview.pointer', action: 'move', ...pointFromPointer(event) })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = pointFromPointer(event)
    const start = pointerStartRef.current
    pointerStartRef.current = null
    if (mode === 'select') {
      session.send({ type: 'preview.select', ...point })
      setSelectionHint('正在识别元素…')
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

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    sendControl({ type: 'preview.wheel', deltaX: event.deltaX, deltaY: event.deltaY })
  }

  const saveDraft = () => {
    const comment = draftComment.trim()
    if (!draftTarget || !comment) return
    if (!editingId && annotations.length >= MAX_ANNOTATIONS) return
    const pageUrl = session.navigation?.url ?? session.ready?.url ?? sourceUrl
    const pageTitle = session.navigation?.title ?? session.ready?.title ?? ''
    if (editingId) {
      setAnnotations((current) =>
        current.map((annotation) =>
          annotation.id === editingId
            ? { ...annotation, target: draftTarget, comment, pageUrl, pageTitle, missing: false }
            : annotation,
        ),
      )
    } else {
      setAnnotations((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          target: draftTarget,
          comment,
          pageUrl,
          pageTitle,
        },
      ])
    }
    setDraftTarget(null)
    setDraftComment('')
    setEditingId(null)
  }

  const editAnnotation = (annotation: ContainerWebAnnotation) => {
    setDraftTarget(annotation.target)
    setDraftComment(annotation.comment)
    setEditingId(annotation.id)
    setMode('select')
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

  const ready = session.phase === 'ready'
  const visibleTargets = [
    ...annotations.map((annotation, index) => ({
      key: annotation.id,
      target: annotation.target,
      label: index + 1,
      active: annotation.id === editingId,
      missing: annotation.missing,
    })),
    ...(draftTarget && !editingId
      ? [
          {
            key: 'draft',
            target: draftTarget,
            label: annotations.length + 1,
            active: true,
            missing: false,
          },
        ]
      : []),
  ]

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && onClose()}
      srTitle="容器网页预览与元素评论"
      hideClose
      className="h-[100dvh] max-h-[100dvh] w-screen max-w-none rounded-none border-0 bg-[#111318] sm:h-[calc(100dvh-24px)] sm:max-h-[calc(100dvh-24px)] sm:w-[calc(100vw-24px)] sm:rounded-2xl sm:border sm:border-white/10"
      bodyClassName="overflow-hidden p-0"
    >
      <div className="flex h-full min-h-0 flex-col bg-[#111318] text-white">
        <header className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2 py-2 pt-[max(8px,env(safe-area-inset-top))] sm:px-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭网页预览"
            className="preview-icon-button"
          >
            <X size={18} />
          </button>
          <div className="hidden items-center gap-1 sm:flex">
            <button
              type="button"
              disabled={!ready}
              onClick={() => sendControl({ type: 'preview.navigate', action: 'back' })}
              aria-label="后退"
              className="preview-icon-button"
            >
              <ArrowLeft size={17} />
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => sendControl({ type: 'preview.navigate', action: 'forward' })}
              aria-label="前进"
              className="preview-icon-button"
            >
              <ArrowRight size={17} />
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => sendControl({ type: 'preview.navigate', action: 'reload' })}
              aria-label="刷新"
              className="preview-icon-button"
            >
              <RotateCw size={16} />
            </button>
          </div>
          <div className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/25 px-3 py-2">
            <div className="truncate text-[12px] font-medium text-white/90">
              {session.navigation?.title || session.ready?.title || '容器内网页'}
            </div>
            <div className="truncate text-[10px] text-white/45">
              {session.navigation?.url || sourceUrl}
            </div>
          </div>
          <div className="flex shrink-0 rounded-lg bg-white/5 p-0.5" aria-label="预览设备">
            <DeviceButton
              active={device === 'desktop'}
              label="桌面"
              onClick={() => device !== 'desktop' && reconnect('desktop')}
            >
              <Monitor size={15} />
            </DeviceButton>
            <DeviceButton
              active={device === 'mobile'}
              label="移动"
              onClick={() => device !== 'mobile' && reconnect('mobile')}
            >
              <Smartphone size={15} />
            </DeviceButton>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-white/10 px-2 py-2 sm:px-3">
              <ModeButton
                active={mode === 'interact'}
                onClick={() => setMode('interact')}
                icon={<Hand size={15} />}
                label="操作网页"
              />
              <ModeButton
                active={mode === 'select'}
                onClick={() => setMode('select')}
                icon={<MousePointer2 size={15} />}
                label="选元素评论"
              />
              <button
                type="button"
                disabled={!ready}
                onClick={() => setTextInputOpen((value) => !value)}
                className="preview-tool-button"
              >
                <Keyboard size={15} /> 输入文字
              </button>
              <div className="ml-auto flex shrink-0 items-center gap-2 text-[10px] tabular-nums text-white/50">
                <span
                  className={cn('size-1.5 rounded-full', ready ? 'bg-emerald-400' : 'bg-amber-400')}
                />
                <span>{PHASE_LABEL[session.phase] ?? session.phase}</span>
                {frameStats && (
                  <span className="hidden lg:inline">
                    {frameStats.width}×{frameStats.height} · {frameStats.fps} fps ·{' '}
                    {frameStats.highQuality ? '高清' : '实时'}
                    {frameStats.responseMs !== null ? ` · 响应≈${frameStats.responseMs} ms` : ''}
                  </span>
                )}
              </div>
            </div>

            {textInputOpen && (
              <form
                className="flex shrink-0 gap-2 border-b border-white/10 bg-black/15 p-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  const text = textInput
                  if (!text) return
                  sendControl({ type: 'preview.text', text })
                  setTextInput('')
                }}
              >
                <input
                  value={textInput}
                  onChange={(event) => setTextInput(event.target.value.slice(0, 2_000))}
                  placeholder="向网页当前焦点输入文字（支持中文）"
                  className="min-h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white outline-none placeholder:text-white/35 focus:border-blue-400/70"
                />
                <button
                  type="submit"
                  disabled={!ready || !textInput}
                  className="rounded-lg bg-blue-500 px-4 text-sm font-medium disabled:opacity-40"
                >
                  输入
                </button>
              </form>
            )}

            <div className="relative flex min-h-[260px] flex-1 items-center justify-center overflow-hidden bg-[#090a0d] p-2 sm:p-4">
              <div
                className={cn(
                  'relative max-h-full max-w-full overflow-hidden rounded-md bg-white shadow-2xl',
                  device === 'mobile' && 'rounded-[18px] ring-4 ring-white/10',
                )}
                style={{
                  aspectRatio: `${viewport.width} / ${viewport.height}`,
                  width: '100%',
                  maxWidth: device === 'mobile' ? '430px' : undefined,
                }}
              >
                <canvas
                  ref={canvasRef}
                  tabIndex={0}
                  aria-label={mode === 'select' ? '网页画面，点按选择元素' : '可交互网页画面'}
                  className={cn(
                    'block size-full touch-none select-none object-fill outline-none',
                    mode === 'select' ? 'cursor-crosshair' : 'cursor-default',
                  )}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => {
                    pointerStartRef.current = null
                  }}
                  onWheel={onWheel}
                  onKeyDown={(event) => {
                    if (!ready || mode !== 'interact' || event.nativeEvent.isComposing) return
                    const key = keyboardShortcut(event)
                    if (!key) return
                    event.preventDefault()
                    sendControl({ type: 'preview.key', key })
                  }}
                />
                {visibleTargets.map(({ key, target, label, active, missing }) => (
                  <div
                    key={key}
                    style={targetOverlayStyle(target, viewport)}
                    className={cn(
                      'pointer-events-none absolute z-10 border-2 bg-blue-500/10 text-left',
                      active ? 'border-blue-300' : 'border-blue-500',
                      missing && 'border-dashed border-amber-400',
                    )}
                  >
                    {annotations.some((item) => item.id === key) ? (
                      <button
                        type="button"
                        aria-label={`编辑网页评论 ${label}`}
                        onClick={() => {
                          const annotation = annotations.find((item) => item.id === key)
                          if (annotation) editAnnotation(annotation)
                        }}
                        className="pointer-events-auto absolute -left-3 -top-3 flex size-6 items-center justify-center rounded-full border-2 border-white bg-blue-500 text-[11px] font-bold text-white shadow-lg"
                      >
                        {label}
                      </button>
                    ) : (
                      <span className="absolute -left-3 -top-3 flex size-6 items-center justify-center rounded-full border-2 border-white bg-blue-500 text-[11px] font-bold text-white shadow-lg">
                        {label}
                      </span>
                    )}
                  </div>
                ))}

                {!frameStats && !session.error && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#15171c] text-center text-white/65">
                    <Loader2 className="animate-spin" size={24} />
                    <span className="text-xs">{PHASE_LABEL[session.phase] ?? '正在准备预览'}</span>
                  </div>
                )}
                {(session.error || (session.phase === 'closed' && !session.error)) && (
                  <div
                    role="alert"
                    className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#15171c]/95 px-6 text-center"
                  >
                    <p className="max-w-sm text-sm text-white/80">
                      {session.error?.message ?? '网页预览连接已断开'}
                    </p>
                    <button
                      type="button"
                      onClick={() => reconnect()}
                      className="flex min-h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-black"
                    >
                      <RefreshCw size={15} />
                      重试
                    </button>
                  </div>
                )}
              </div>
              {selectionHint && (
                <output className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur">
                  {selectionHint}
                </output>
              )}
            </div>
          </section>

          <aside
            className={cn(
              'flex h-[28dvh] min-h-[210px] shrink-0 flex-col border-t border-white/10 bg-[#15171c] md:h-full md:min-h-0 md:w-[340px] md:border-l md:border-t-0',
              draftTarget && 'h-[42dvh] min-h-[290px] md:h-full md:min-h-0',
            )}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">修改评论</h2>
                <p className="mt-0.5 text-[11px] text-white/45">
                  选择页面元素，说明希望 AI 怎样修改
                </p>
              </div>
              <span className="rounded-full bg-white/8 px-2 py-1 text-[11px] text-white/65">
                {annotations.length}/{MAX_ANNOTATIONS} 条
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {draftTarget ? (
                <div className="rounded-xl border border-blue-400/30 bg-blue-400/5 p-3">
                  <ElementSummary target={draftTarget} />
                  <textarea
                    value={draftComment}
                    maxLength={2_000}
                    onChange={(event) => setDraftComment(event.target.value)}
                    placeholder="例如：按钮改成品牌蓝色，文案改为“立即开始”，移动端占满一行。"
                    className="mt-3 min-h-24 w-full resize-none rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-blue-400/70"
                  />
                  <div className="mt-2 flex justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setDraftTarget(null)
                        setDraftComment('')
                        setEditingId(null)
                      }}
                      className="min-h-9 rounded-lg px-3 text-xs text-white/55 hover:bg-white/5"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      disabled={!draftComment.trim()}
                      onClick={saveDraft}
                      className="flex min-h-9 items-center gap-1.5 rounded-lg bg-blue-500 px-3 text-xs font-semibold text-white disabled:opacity-40"
                    >
                      <Check size={14} />
                      {editingId ? '保存' : '添加评论'}
                    </button>
                  </div>
                </div>
              ) : annotations.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setMode('select')}
                  className="flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 px-6 text-center text-white/45 hover:border-blue-400/50 hover:text-white/70"
                >
                  <MessageSquarePlus size={22} />
                  <span className="text-xs">切换“选元素评论”，然后点网页上的任意元素</span>
                </button>
              ) : null}

              <div className="mt-3 space-y-2">
                {annotations.map((annotation, index) => (
                  <div
                    key={annotation.id}
                    className="group flex w-full gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2 text-left hover:border-blue-400/40"
                  >
                    <button
                      type="button"
                      onClick={() => editAnnotation(annotation)}
                      className="flex min-w-0 flex-1 gap-2 p-1 text-left"
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-blue-500 text-[11px] font-bold">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11px] font-medium text-blue-200">
                          {annotation.target.selector}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-white/75">
                          {annotation.comment}
                        </span>
                        {annotation.missing && (
                          <span className="mt-1 block text-[10px] text-amber-300">
                            刷新后未重新匹配
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`删除评论 ${index + 1}`}
                      onClick={() => {
                        setAnnotations((current) =>
                          current.filter((item) => item.id !== annotation.id),
                        )
                      }}
                      className="flex size-7 shrink-0 items-center justify-center rounded-md text-white/30 hover:bg-red-500/10 hover:text-red-300"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="shrink-0 border-t border-white/10 p-3 pb-[max(12px,env(safe-area-inset-bottom))]">
              <button
                type="button"
                disabled={annotations.length === 0}
                onClick={submitReview}
                className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Send size={15} /> 添加到对话输入框
              </button>
              <p className="mt-2 text-center text-[10px] text-white/35">
                加入对话时不附截图；仅写入地址、所选元素元数据和你的评论
              </p>
            </div>
          </aside>
        </div>
      </div>
    </Modal>
  )
}

function DeviceButton({
  active,
  label,
  onClick,
  children,
}: { active: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={`${label}预览`}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs',
        active ? 'bg-white text-black' : 'text-white/55 hover:text-white',
      )}
    >
      <span>{children}</span>
      <span className="hidden lg:inline">{label}</span>
    </button>
  )
}

function ModeButton({
  active,
  onClick,
  icon,
  label,
}: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'preview-tool-button',
        active && 'border-blue-400/50 bg-blue-500/20 text-blue-100',
      )}
    >
      <span>{icon}</span>
      {label}
    </button>
  )
}

function ElementSummary({ target }: { target: ContainerPreviewElementTarget }) {
  const label = target.ariaLabel || target.text
  return (
    <div className="min-w-0">
      <div className="truncate text-xs font-semibold text-blue-200">{target.selector}</div>
      <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-white/45">
        <span className="rounded bg-white/5 px-1.5 py-0.5">&lt;{target.tag}&gt;</span>
        {target.role && (
          <span className="rounded bg-white/5 px-1.5 py-0.5">role={target.role}</span>
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
