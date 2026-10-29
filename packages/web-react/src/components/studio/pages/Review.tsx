// OCV5-593 FE-2b 审阅批注 (d05 / m03): one shot's take on the stage with point / box annotations,
// time ranges dragged on the filmstrip, version strip, QA report and history. Annotations are drafts
// in this tab until "交给 agent" (FE-7b) sends them; then the server's annotation shows what the
// agent understood, with 确认执行 / 不采用 / 再发一次. "采用" adopts the take on the stage as it is
// (POST /takes/:id/select): a video settles the shot, a frame re-shoots the video from it.

import {
  ArrowLeft,
  Check,
  Columns2,
  MapPin,
  MousePointer2,
  Pause,
  Play,
  Send,
  SkipBack,
  SkipForward,
  SquareDashed,
  Trash2,
} from 'lucide-react'
import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useBlobUrl } from '../../../hooks/useBlobUrl'
import { useVideoFrames } from '../../../hooks/useVideoFrames'
import {
  ANNOTATION_TEXT_MAX,
  type AnnotationDraft,
  SENT_LABEL,
  annotationLabel,
  boxFromDrag,
  draftToBody,
  loadDrafts,
  newDraftId,
  rangeFromDrag,
  saveDrafts,
  sentDetail,
  sentState,
} from '../../../lib/studio/annotations'
import { StudioApiError, studioApi, studioErrorText } from '../../../lib/studio/api'
import { formatCredits, formatTimecode } from '../../../lib/studio/format'
import { qaScoreOf, shotCard, takesOf } from '../../../lib/studio/model'
import { MODERATION_TEXT, qaView, recommendedTakes } from '../../../lib/studio/qa'
import type { StudioProjectView, StudioTake } from '../../../lib/studio/types'
import type { AuthSession } from '../../../lib/types'
import { useToast } from '../../ui'
import { MediaThumb, isVideoTake } from '../MediaThumb'

type Tool = 'view' | 'point' | 'box'
type Tab = 'notes' | 'qa' | 'history'

const FRAME_COUNT = 12
const STEP = 1 / 24
const QA_ROWS: Array<[string, string]> = [
  ['character', '角色一致'],
  ['scene', '场景一致'],
  ['action', '动作符合分镜'],
  ['artifacts', '肢体 / 文字瑕疵'],
]

function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const ASPECT_RATIO: Record<string, string> = { '16:9': '16 / 9', '9:16': '9 / 16', '1:1': '1 / 1' }
/** Projects the server refuses to change (selectTake answers STUDIO_BAD_TRANSITION). */
const CLOSED_PROJECT = new Set(['done', 'canceled', 'failed'])

export function ReviewPage(props: {
  auth: AuthSession
  view: StudioProjectView
  shotId?: string
  onBack: () => void
  /** Refresh the project after sending / applying (useStudioProject.refresh). */
  onReload?: () => void
}) {
  const { auth, view } = props
  const shots = useMemo(() => [...view.shots].sort((a, b) => a.ordinal - b.ordinal), [view.shots])
  const shot =
    shots.find((s) => s.id === props.shotId) ??
    shots.find((s) => s.status === 'needs_user') ??
    shots[0]
  if (!shot) {
    return (
      <div className="st-state-center">
        <div className="st-h3">还没有可以审阅的镜头</div>
        <button type="button" className="st-btn st-btn-sm" onClick={props.onBack}>
          回到镜头
        </button>
      </div>
    )
  }
  return (
    <ShotReview
      key={shot.id}
      auth={auth}
      view={view}
      shotId={shot.id}
      onBack={props.onBack}
      {...(props.onReload ? { onReload: props.onReload } : {})}
    />
  )
}

function ShotReview(props: {
  auth: AuthSession
  view: StudioProjectView
  shotId: string
  onBack: () => void
  onReload?: () => void
}) {
  const { auth, view } = props
  const shot = view.shots.find((s) => s.id === props.shotId)!
  const card = shotCard(view, shot)
  const versions = useMemo(
    () =>
      takesOf(view, shot.id, ['shot_video', 'shot_frame']).filter(
        (t) => t.status === 'succeeded' && t.blobSha,
      ),
    [view, shot.id],
  )
  const [takeId, setTakeId] = useState<string | null>(card.shown?.id ?? versions[0]?.id ?? null)
  const take = versions.find((t) => t.id === takeId) ?? card.shown ?? versions[0] ?? null
  const compareWith = versions.find((t) => t.id !== take?.id) ?? null
  const [tool, setTool] = useState<Tool>('view')
  const [compare, setCompare] = useState(false)
  const [tab, setTab] = useState<Tab>('notes')
  const [drafts, setDrafts] = useState<AnnotationDraft[]>(() => loadDrafts(view.project.id))
  const [selected, setSelected] = useState<string | null>(null)
  const persist = useCallback(
    (next: AnnotationDraft[]) => {
      setDrafts(next)
      saveDrafts(view.project.id, next)
    },
    [view.project.id],
  )
  const mine = drafts.filter((d) => d.takeId === take?.id)
  // FE-7b: what was handed to the agent on this version, newest first.
  const localIds = new Set(drafts.flatMap((d) => (d.serverId ? [d.serverId] : [])))
  const sent = (view.annotations ?? []).filter((a) => a.takeId === take?.id && !localIds.has(a.id))
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  /** Change the stored drafts from the latest state (never a snapshot taken before an await). */
  const updateDrafts = useCallback(
    (fn: (cur: AnnotationDraft[]) => AnnotationDraft[]) =>
      setDrafts((cur) => {
        const next = fn(cur)
        saveDrafts(view.project.id, next)
        return next
      }),
    [view.project.id],
  )
  /**
   * Create each draft on the server (once — its server id is kept on the draft, FE-7b r1) and send
   * it; a sent draft leaves this tab. "Already sent" (a lost response) counts as sent.
   */
  const handOver = async (ids: string[]) => {
    if (busy) return
    const ready = drafts.filter((d) => ids.includes(d.id) && d.text.trim())
    if (!ready.length) {
      toast('先写一句话说明哪里要改', 'error')
      return
    }
    setBusy(true)
    let sentCount = 0
    try {
      for (const d of ready) {
        let serverId = d.serverId
        let alreadySent = false
        if (serverId) {
          // Created earlier, maybe edited since (FE-7b r2): the server copy takes what it says now.
          const { takeId: _take, ...fields } = draftToBody(d)
          try {
            await studioApi.updateAnnotation(auth, serverId, fields)
          } catch (err) {
            if (!(err instanceof StudioApiError && err.code === 'ANNOTATION_NOT_DRAFT')) throw err
            alreadySent = true
          }
        } else {
          serverId = (await studioApi.createAnnotation(auth, view.project.id, draftToBody(d))).id
          const sid = serverId
          updateDrafts((cur) => cur.map((x) => (x.id === d.id ? { ...x, serverId: sid } : x)))
        }
        try {
          if (!alreadySent) await studioApi.annotationAction(auth, serverId, 'send')
        } catch (err) {
          if (!(err instanceof StudioApiError && err.code === 'ANNOTATION_NOT_DRAFT')) throw err
        }
        updateDrafts((cur) => cur.filter((x) => x.id !== d.id))
        setSelected((sel) => (sel === d.id ? null : sel))
        sentCount += 1
      }
      toast(sentCount > 1 ? `${sentCount} 条批注已交给 agent` : '批注已交给 agent', 'success')
    } catch (err) {
      toast(studioErrorText(err), 'error')
    } finally {
      setBusy(false)
      props.onReload?.()
    }
  }
  const act = async (id: string, action: 'apply' | 'reject' | 'send') => {
    if (busy) return
    setBusy(true)
    try {
      await studioApi.annotationAction(auth, id, action)
      toast(
        action === 'apply'
          ? '开始按批注修改'
          : action === 'reject'
            ? '这条批注不采用了'
            : '已重新交给 agent',
        'success',
      )
    } catch (err) {
      toast(studioErrorText(err), 'error')
    } finally {
      setBusy(false)
      props.onReload?.()
    }
  }

  // media + playback
  const url = useBlobUrl(auth, take?.blobSha)
  const video = isVideoTake(take)

  // Adopt the take on the stage. The version strip only previews; this is the one that commits.
  const adopted = !!take && video && shot.status === 'ready' && shot.activeTakeId === take.id
  const shotBusy = shot.status === 'generating' || shot.status === 'qa'
  const closed = CLOSED_PROJECT.has(view.project.status)
  const canAdopt = !!take && !adopted && !shotBusy && !closed
  const adoptLabel = !take
    ? '采用这个版本'
    : adopted
      ? `已采用 v${take.version}`
      : video
        ? `采用 v${take.version} 并继续`
        : `用 v${take.version} 这一帧重拍视频`
  const adoptHint = closed
    ? '项目已经结束，不能再换版本。'
    : shotBusy
      ? '这一镜还在生成，生成完再选版本。'
      : adopted
        ? '这一镜用的就是这个版本。'
        : video
          ? '采用后这一镜就定了，导演会接着做后面的步骤。'
          : '会按这一帧重新生成视频，视频按正常价格扣积分。'
  const adopt = async () => {
    if (busy || !take || !canAdopt) return
    setBusy(true)
    try {
      await studioApi.selectTake(auth, take.id)
      toast(video ? `已采用 v${take.version}` : `开始用 v${take.version} 这一帧重拍视频`, 'success')
    } catch (err) {
      toast(studioErrorText(err), 'error')
    } finally {
      setBusy(false)
      props.onReload?.()
    }
  }
  const hasNotes = mine.some((d) => d.text.trim())
  const videoRef = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const { frames, duration } = useVideoFrames(video ? url : null, FRAME_COUNT)
  const dur = duration || card.seconds

  const seekTo = useCallback(
    (t: number) => {
      const v = videoRef.current
      const clamped = Math.max(0, Math.min(dur, t))
      if (v) v.currentTime = clamped
      setTime(clamped)
    },
    [dur],
  )
  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable))
        return
      if (e.key === ',') seekTo(time - STEP)
      else if (e.key === '.') seekTo(time + STEP)
      else if (e.key === ' ' && video) {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [seekTo, time, togglePlay, video])

  // drawing on the media box
  const boxRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{
    a: { x: number; y: number }
    b: { x: number; y: number }
  } | null>(null)
  const rel = (e: PointerEvent) => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  const add = (d: Omit<AnnotationDraft, 'id' | 'takeId' | 'createdAt' | 'text'>) => {
    if (!take) return
    const draft: AnnotationDraft = {
      ...d,
      id: newDraftId(),
      takeId: take.id,
      text: '',
      createdAt: Date.now(),
    }
    persist([...drafts, draft])
    setSelected(draft.id)
    setTab('notes')
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (tool === 'view' || !take || compare) return
    // Stop the browser's native image drag / text selection from taking over the pointer stream
    // (code r1 P1); pointercancel below clears a drag the browser still interrupts.
    e.preventDefault()
    const p = rel(e)
    if (tool === 'point') {
      add({ kind: 'point', x: p.x, y: p.y, tStart: video ? time : 0 })
      return
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ a: p, b: p })
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (drag) setDrag({ a: drag.a, b: rel(e) })
  }
  const onUp = () => {
    if (!drag) return
    const box = boxFromDrag(drag.a, drag.b)
    setDrag(null)
    if (box) add({ kind: 'box', ...box, tStart: video ? time : 0 })
  }

  // time range on the filmstrip
  const stripRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState<{ a: number; b: number } | null>(null)
  const stripTime = (e: PointerEvent) => {
    const r = stripRef.current!.getBoundingClientRect()
    return ((e.clientX - r.left) / r.width) * dur
  }

  const selectedDraft = mine.find((d) => d.id === selected) ?? null
  const update = (id: string, text: string) =>
    persist(
      drafts.map((d) => (d.id === id ? { ...d, text: text.slice(0, ANNOTATION_TEXT_MAX) } : d)),
    )
  const remove = (id: string) => {
    persist(drafts.filter((d) => d.id !== id))
    if (selected === id) setSelected(null)
  }
  const qa = (take?.qa ?? null) as Record<string, unknown> | null
  const score = qaScoreOf(take)
  // FE-7a: the QA outcome in words, and the versions QA offered when it handed the shot over.
  const qv = qaView(qa)
  const recommended = recommendedTakes(view, shot.id)
  const ratio = ASPECT_RATIO[view.project.aspect] ?? '16 / 9'

  return (
    <div className="st-review">
      <section className="st-review-main st-stage">
        <div className="st-row st-review-head">
          <button type="button" className="st-btn st-btn-sm st-glass" onClick={props.onBack}>
            <ArrowLeft />
            镜头
          </button>
          <b className="st-review-title">
            #{shot.ordinal + 1} {card.spec.title ?? ''}
          </b>
          {take ? (
            <span className="st-chip st-chip-dark st-hide-sm">
              {take.provider} · {card.seconds}s
              {take.costCredits !== '0' ? ` · ${formatCredits(take.costCredits)} 积分` : ''}
            </span>
          ) : null}
          {score !== null ? (
            <span
              className={`st-chip st-chip-dark ${card.tone === 'needs' ? 'st-chip-warn' : 'st-chip-ok'}`}
            >
              QA {score.toFixed(2)}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <div className="st-glassbar" role="toolbar" aria-label="批注工具">
            {(
              [
                ['view', '查看', <MousePointer2 key="v" />],
                ['point', '点', <MapPin key="p" />],
                ['box', '框选', <SquareDashed key="b" />],
              ] as const
            ).map(([t, label, icon]) => (
              <button
                key={t}
                type="button"
                className={`st-glass-t${tool === t && !compare ? ' on' : ''}`}
                aria-pressed={tool === t && !compare}
                onClick={() => {
                  setCompare(false)
                  setTool(t)
                }}
              >
                {icon}
                <span className="st-hide-sm">{label}</span>
              </button>
            ))}
            <span className="st-glass-sep st-hide-sm" />
            <button
              type="button"
              className={`st-glass-t st-hide-sm${compare ? ' on' : ''}`}
              aria-pressed={compare}
              disabled={!compareWith}
              onClick={() => setCompare((c) => !c)}
            >
              <Columns2 />
              {compareWith ? `对比 v${compareWith.version}` : '对比'}
            </button>
          </div>
        </div>

        <div className="st-review-stage">
          {compare && compareWith ? (
            <div className="st-compare">
              {[take, compareWith].map((t) =>
                t ? (
                  <figure key={t.id} className="st-compare-cell">
                    <MediaThumb
                      auth={auth}
                      take={t}
                      style={{ aspectRatio: ratio, borderRadius: 14 }}
                    />
                    <figcaption className="st-cap">
                      v{t.version}
                      {qaScoreOf(t) !== null ? ` · QA ${qaScoreOf(t)!.toFixed(2)}` : ''}
                    </figcaption>
                  </figure>
                ) : null,
              )}
            </div>
          ) : (
            <div
              ref={boxRef}
              className={`st-review-media tool-${tool}`}
              style={{ aspectRatio: ratio }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag(null)}
              onDragStart={(e) => e.preventDefault()}
              data-testid="review-media"
            >
              {url && video ? (
                <video
                  ref={videoRef}
                  className="st-media-fill"
                  src={url}
                  playsInline
                  preload="auto"
                  onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                  // A remounted video (after compare, or another version) starts at 0: put it back at
                  // the time the UI shows, so new annotations land on the frame that is on screen
                  // (code r1 P1).
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget
                    const t = Math.min(time, Number.isFinite(v.duration) ? v.duration : time)
                    v.currentTime = t
                    setTime(t)
                  }}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                >
                  {/* Generated shots carry no speech; voice and subtitles live on their own tracks. */}
                  <track kind="captions" />
                </video>
              ) : url ? (
                <img
                  className="st-media-fill"
                  src={url}
                  draggable={false}
                  alt={`镜头 #${shot.ordinal + 1} v${take?.version ?? ''}`}
                />
              ) : (
                <div className="st-media-fill st-placeholder" />
              )}
              {mine.map((d, i) =>
                d.kind === 'box' ? (
                  <button
                    key={d.id}
                    type="button"
                    className={`st-annot-box${selected === d.id ? ' sel' : ''}`}
                    style={{
                      left: `${d.x! * 100}%`,
                      top: `${d.y! * 100}%`,
                      width: `${d.w! * 100}%`,
                      height: `${d.h! * 100}%`,
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => setSelected(d.id)}
                    aria-label={`批注 ${i + 1}：${annotationLabel(d)}`}
                  >
                    <span className="st-pin amber">{i + 1}</span>
                  </button>
                ) : d.kind === 'point' ? (
                  <button
                    key={d.id}
                    type="button"
                    className={`st-pin${selected === d.id ? ' sel' : ''}`}
                    style={{ left: `${d.x! * 100}%`, top: `${d.y! * 100}%` }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => setSelected(d.id)}
                    aria-label={`批注 ${i + 1}：${annotationLabel(d)}`}
                  >
                    {i + 1}
                  </button>
                ) : null,
              )}
              {drag
                ? (() => {
                    const b = boxFromDrag(drag.a, drag.b)
                    return b ? (
                      <span
                        className="st-annot-box drawing"
                        style={{
                          left: `${b.x * 100}%`,
                          top: `${b.y * 100}%`,
                          width: `${b.w * 100}%`,
                          height: `${b.h * 100}%`,
                        }}
                      />
                    ) : null
                  })()
                : null}
              {selectedDraft ? (
                <AnnotationBubble
                  draft={selectedDraft}
                  index={mine.indexOf(selectedDraft)}
                  onText={(t) => update(selectedDraft.id, t)}
                  onDelete={() => remove(selectedDraft.id)}
                  onClose={() => setSelected(null)}
                  onSend={() => void handOver([selectedDraft.id])}
                  busy={busy}
                />
              ) : null}
            </div>
          )}
        </div>

        {video ? (
          <div className="st-review-strip">
            <div
              ref={stripRef}
              className="st-filmstrip"
              aria-label="时间轴：拖动选出一段时间即可批注"
              onPointerCancel={() => setRange(null)}
              onPointerDown={(e) => {
                e.preventDefault()
                e.currentTarget.setPointerCapture(e.pointerId)
                const t = stripTime(e)
                setRange({ a: t, b: t })
              }}
              onPointerMove={(e) => range && setRange({ a: range.a, b: stripTime(e) })}
              onPointerUp={() => {
                if (!range) return
                const r = rangeFromDrag(range.a, range.b, dur)
                if (r) add({ kind: 'range', ...r })
                else seekTo(range.a)
                setRange(null)
              }}
            >
              {(frames ?? Array.from({ length: FRAME_COUNT }, () => null)).map((f, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: frame i is a fixed slot of the strip
                  key={i}
                  className="st-film-frame"
                  style={f ? { backgroundImage: `url(${f})` } : undefined}
                />
              ))}
              {mine
                .filter((d) => d.kind === 'range')
                .map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={`st-film-range${selected === d.id ? ' sel' : ''}`}
                    style={{
                      left: `${(d.tStart / dur) * 100}%`,
                      width: `${(((d.tEnd ?? d.tStart) - d.tStart) / dur) * 100}%`,
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => setSelected(d.id)}
                    aria-label={`批注 ${mine.indexOf(d) + 1}：${annotationLabel(d)}`}
                  />
                ))}
              {range
                ? (() => {
                    const r = rangeFromDrag(range.a, range.b, dur)
                    return r ? (
                      <span
                        className="st-film-range drawing"
                        style={{
                          left: `${(r.tStart / dur) * 100}%`,
                          width: `${((r.tEnd - r.tStart) / dur) * 100}%`,
                        }}
                      />
                    ) : null
                  })()
                : null}
              <span
                className="st-film-head"
                style={{ left: `${(time / dur) * 100}%` }}
                aria-hidden="true"
              />
            </div>
            <div className="st-row st-review-controls">
              <button
                type="button"
                className="st-iconbtn st-on-stage"
                onClick={togglePlay}
                aria-label={playing ? '暂停' : '播放'}
                disabled={!url}
              >
                {playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <span className="st-tc">
                {formatTimecode(time)}{' '}
                <span style={{ color: 'var(--st-stage-faint)' }}>/ {formatTimecode(dur)}</span>
              </span>
              <button
                type="button"
                className="st-iconbtn st-on-stage st-hide-sm"
                onClick={() => seekTo(time - STEP)}
                aria-label="上一帧"
              >
                <SkipBack size={15} />
              </button>
              <button
                type="button"
                className="st-iconbtn st-on-stage st-hide-sm"
                onClick={() => seekTo(time + STEP)}
                aria-label="下一帧"
              >
                <SkipForward size={15} />
              </button>
              <span className="st-cap st-hide-sm" style={{ color: 'var(--st-stage-faint)' }}>
                逐帧 , / . · 在时间轴上拖动即可批注一段
              </span>
              <span style={{ flex: 1 }} />
              <VersionStrip
                auth={auth}
                versions={versions}
                current={take}
                onPick={(t) => setTakeId(t.id)}
              />
            </div>
          </div>
        ) : (
          <div className="st-row st-review-controls" style={{ justifyContent: 'flex-end' }}>
            <VersionStrip
              auth={auth}
              versions={versions}
              current={take}
              onPick={(t) => setTakeId(t.id)}
            />
          </div>
        )}
      </section>

      <aside className="st-panel st-review-side" aria-label="批注与质检">
        <div className="st-tabs" role="tablist">
          {(
            [
              ['notes', `批注 ${mine.length}`],
              ['qa', 'QA 报告'],
              ['history', '历史'],
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="st-review-side-body">
          {tab === 'notes' ? (
            mine.length === 0 && sent.length === 0 ? (
              <div className="st-cap">
                用「点」或「框选」在画面上标出问题，或在时间轴上拖出一段，再写一句话说明哪里不对。
              </div>
            ) : (
              mine
                .map((d, i) => (
                  <div key={d.id} className={`st-card st-note${selected === d.id ? ' sel' : ''}`}>
                    <button
                      type="button"
                      className="st-row st-note-head"
                      onClick={() => setSelected(d.id)}
                    >
                      <span className={`st-note-n ${d.kind === 'point' ? 'pin' : 'amber'}`}>
                        {i + 1}
                      </span>
                      <b>{annotationLabel(d)}</b>
                      <span style={{ flex: 1 }} />
                      <span className="st-chip">草稿</span>
                    </button>
                    <div className="st-note-text">{d.text || '（还没写说明）'}</div>
                  </div>
                ))
                .concat(
                  sent.map((a) => {
                    const st = sentState(a)
                    return (
                      <div key={a.id} className="st-card st-note" data-testid="sent-note">
                        <div className="st-row st-note-head">
                          <b className="st-note-sent">{a.text}</b>
                          <span style={{ flex: 1 }} />
                          <span
                            className={`st-chip ${st === 'applied' ? 'st-chip-ok' : st === 'failed' || st === 'not_understood' ? 'st-chip-warn' : ''}`}
                          >
                            {SENT_LABEL[st]}
                          </span>
                        </div>
                        {sentDetail(a) ? (
                          <div className="st-understood">{sentDetail(a)}</div>
                        ) : null}
                        {st === 'understood' || st === 'failed' ? (
                          <div className="st-row" style={{ gap: 8, marginTop: 8 }}>
                            <button
                              type="button"
                              className="st-btn st-btn-sm st-btn-primary"
                              disabled={busy}
                              onClick={() => void act(a.id, 'apply')}
                            >
                              {st === 'failed' ? '再试一次' : '确认执行'}
                            </button>
                            <button
                              type="button"
                              className="st-btn st-btn-sm"
                              disabled={busy}
                              onClick={() => void act(a.id, 'reject')}
                            >
                              不采用
                            </button>
                          </div>
                        ) : st === 'not_understood' || st === 'unsent' ? (
                          <div className="st-row" style={{ gap: 8, marginTop: 8 }}>
                            <button
                              type="button"
                              className="st-btn st-btn-sm"
                              disabled={busy}
                              onClick={() => void act(a.id, 'send')}
                            >
                              再发一次
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )
                  }),
                )
            )
          ) : tab === 'qa' ? (
            <div className="st-card st-qa">
              <div className="st-row">
                <b>视觉 QA{take ? ` · v${take.version}` : ''}</b>
                <span style={{ flex: 1 }} />
                {score !== null ? (
                  <span
                    className={`st-chip ${card.tone === 'needs' ? 'st-chip-warn' : 'st-chip-ok'}`}
                  >
                    {score.toFixed(2)}
                  </span>
                ) : null}
              </div>
              {qa ? (
                <>
                  <div className="st-qa-grid">
                    {QA_ROWS.map(([k, label]) => {
                      const v = num(qa[k])
                      return v === null ? null : (
                        <div key={k} className="st-qa-row">
                          <span>{label}</span>
                          <span className="st-meter">
                            <i
                              className={v < 0.75 ? 'warn' : ''}
                              style={{ width: `${Math.round(v * 100)}%` }}
                            />
                          </span>
                          <b className="tnum">{v.toFixed(2)}</b>
                        </div>
                      )
                    })}
                  </div>
                  {qv.moderation ? (
                    <div className="st-qa-row" data-testid="qa-moderation">
                      <span>内容审核</span>
                      <span style={{ flex: 1 }} />
                      <span
                        className={`st-chip ${qv.moderation === 'pass' ? 'st-chip-ok' : 'st-chip-warn'}`}
                      >
                        {MODERATION_TEXT[qv.moderation]}
                      </span>
                    </div>
                  ) : null}
                  {typeof qa.summary === 'string' ? (
                    <div className="st-cap" style={{ marginTop: 10 }}>
                      {qa.summary}
                    </div>
                  ) : null}
                  {qv.issues.length ? (
                    <ul className="st-qa-issues" data-testid="qa-issues">
                      {qv.issues.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  ) : null}
                  {qv.outcomeText ? (
                    <div
                      className={`st-cap st-qa-outcome st-qa-${qv.outcome}`}
                      data-testid="qa-outcome"
                      style={{ marginTop: 8 }}
                    >
                      {qv.outcomeText}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="st-cap" style={{ marginTop: 8 }}>
                  这个版本还没有质检结果。
                </div>
              )}
            </div>
          ) : (
            <ul className="st-history">
              {takesOf(view, shot.id, ['shot_video', 'shot_frame']).map((t) => (
                <li key={t.id} className="st-row">
                  <b>v{t.version}</b>
                  <span className="st-cap">{t.ownerKind === 'shot_frame' ? '首帧' : '视频'}</span>
                  {recommended.has(t.id) ? (
                    <span className="st-chip st-chip-ok" data-testid="qa-recommended">
                      推荐
                    </span>
                  ) : null}
                  <span className="st-cap">{t.provider}</span>
                  <span style={{ flex: 1 }} />
                  <span
                    className={`st-chip ${t.status === 'succeeded' ? 'st-chip-ok' : t.status === 'failed' ? 'st-chip-bad' : ''}`}
                  >
                    {t.status === 'succeeded'
                      ? '完成'
                      : t.status === 'failed'
                        ? '失败'
                        : t.status === 'running'
                          ? '生成中'
                          : t.status === 'queued'
                            ? '排队'
                            : '已取消'}
                  </span>
                  <span className="st-cap tnum">{formatCredits(t.costCredits)} 积分</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="st-review-foot">
          {take ? (
            <>
              <button
                type="button"
                className={`st-btn${hasNotes ? '' : ' st-btn-primary'}`}
                style={{ width: '100%' }}
                disabled={busy || !canAdopt}
                onClick={() => void adopt()}
                data-testid="adopt-take"
              >
                <Check />
                {adoptLabel}
              </button>
              <div className="st-cap" style={{ textAlign: 'center', margin: '6px 0 10px' }}>
                {adoptHint}
              </div>
            </>
          ) : null}
          <button
            type="button"
            className={`st-btn${hasNotes || !take ? ' st-btn-primary' : ''}`}
            style={{ width: '100%' }}
            disabled={busy || !hasNotes}
            onClick={() => void handOver(mine.map((d) => d.id))}
            data-testid="hand-over"
          >
            <Send />
            {busy ? '正在交给 agent…' : `交给 agent${mine.length ? `（${mine.length} 条）` : ''}`}
          </button>
          <div className="st-cap" style={{ textAlign: 'center', marginTop: 6 }}>
            agent 会先说明它打算怎么改；全自动项目里有把握的修改会直接执行，其余等你确认。
          </div>
        </div>
      </aside>
    </div>
  )
}

export function AnnotationBubble(props: {
  draft: AnnotationDraft
  index: number
  onText: (t: string) => void
  onDelete: () => void
  onClose: () => void
  onSend?: () => void
  busy?: boolean
}) {
  const d = props.draft
  const ref = useRef<HTMLTextAreaElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once per newly selected draft
  useEffect(() => {
    ref.current?.focus()
  }, [d.id])
  const x = d.kind === 'range' ? 0.5 : (d.x ?? 0.5) + (d.w ?? 0)
  const left = x > 0.6 ? undefined : `calc(${x * 100}% + 18px)`
  const right = x > 0.6 ? `calc(${(1 - (d.x ?? 0.5)) * 100}% + 18px)` : undefined
  return (
    <dialog
      open
      className="st-bubble"
      style={{ left, right, top: `clamp(12px, ${(d.y ?? 0.1) * 100}%, calc(100% - 220px))` }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label={`批注 ${props.index + 1}`}
    >
      <div className="st-row" style={{ gap: 8 }}>
        <span className={`st-note-n ${d.kind === 'point' ? 'pin' : 'amber'}`}>
          {props.index + 1}
        </span>
        <b style={{ fontSize: 13 }}>{annotationLabel(d)}</b>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="st-iconbtn"
          style={{ width: 26, height: 26 }}
          onClick={props.onDelete}
          aria-label="删除批注"
        >
          <Trash2 size={14} />
        </button>
      </div>
      <label htmlFor={`st-note-${d.id}`} className="sr-only">
        批注说明
      </label>
      <textarea
        id={`st-note-${d.id}`}
        ref={ref}
        className="st-textarea"
        rows={3}
        maxLength={ANNOTATION_TEXT_MAX}
        placeholder="这里哪里不对？比如“尾巴要和设定一样，蓬松的红色，尾尖白色”"
        value={d.text}
        onChange={(e) => props.onText(e.target.value)}
      />
      <div className="st-understood">
        交给 agent 后，它会先在批注栏说明打算怎么改，再按项目设置直接执行或等你确认。
      </div>
      <div className="st-row" style={{ marginTop: 10, gap: 8 }}>
        <button
          type="button"
          className="st-btn st-btn-sm st-btn-primary"
          disabled={!props.onSend || props.busy || !d.text.trim()}
          onClick={props.onSend}
        >
          <Send />
          交给 agent
        </button>
        <button type="button" className="st-btn st-btn-sm" onClick={props.onClose}>
          先存草稿
        </button>
      </div>
    </dialog>
  )
}

function VersionStrip(props: {
  auth: AuthSession
  versions: StudioTake[]
  current: StudioTake | null
  onPick: (t: StudioTake) => void
}) {
  if (props.versions.length <= 1) return null
  return (
    <fieldset className="st-versions" aria-label="版本">
      {[...props.versions].reverse().map((t) => {
        const s = qaScoreOf(t)
        return (
          <button
            key={t.id}
            type="button"
            className={`st-version${props.current?.id === t.id ? ' on' : ''}`}
            aria-pressed={props.current?.id === t.id}
            onClick={() => props.onPick(t)}
          >
            <MediaThumb
              auth={props.auth}
              take={t}
              style={{ aspectRatio: '16 / 9', borderRadius: 0 }}
            />
            <span className="st-row">
              <b>v{t.version}</b>
              <span style={{ flex: 1 }} />
              {s !== null ? (
                <span className={`tnum ${s < 0.75 ? 'warn' : ''}`}>{s.toFixed(2)}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </fieldset>
  )
}
