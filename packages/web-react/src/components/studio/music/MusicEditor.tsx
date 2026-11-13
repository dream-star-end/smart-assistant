// OCV5-593 FE-5 剪辑 (d11): cut the soundtrack into the film — which part of the track (drag the
// window over the waveform, or use the two sliders), where it sits in the film (whole film or
// aligned to a span of shots), loop with a crossfade, and the mix (music level, ducking under
// narration, fade in / out). Saved as the project's music edit (PUT /projects/:id/music/edit); the
// compose step reads it. The same rules as the server are checked before saving.

import { Play, RotateCcw, Save } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react'

import { useBlobUrl } from '../../../hooks/useBlobUrl'
import { studioApi, studioErrorText } from '../../../lib/studio/api'
import type { TimelineModel } from '../../../lib/studio/model'
import {
  EDIT_DEFAULTS,
  type MusicEdit,
  type MusicTrack,
  compactEdit,
  editProblem,
  mmss,
} from '../../../lib/studio/music'
import type { StudioTake } from '../../../lib/studio/types'
import type { AuthSession } from '../../../lib/types'
import { useToast } from '../../ui'
import { Waveform } from '../Waveform'
import { LicenseBadge } from './TrackRow'
import type { Preview } from './usePreview'

function Slider(props: {
  id: string
  label: string
  min: number
  max: number
  step: number
  value: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <>
      <label className="st-cap st-mix-label" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      <span className="st-cap tnum st-mix-val">{props.format(props.value)}</span>
    </>
  )
}

const round1 = (v: number) => Math.round(v * 10) / 10

/** The audio's own length (seconds) from its metadata; null until known or when unreadable. */
function useAudioDuration(url: string | null): number | null {
  const [sec, setSec] = useState<number | null>(null)
  useEffect(() => {
    setSec(null)
    if (!url) return
    const a = new Audio()
    a.preload = 'metadata'
    const done = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) setSec(a.duration)
    }
    a.addEventListener('loadedmetadata', done)
    a.src = url
    return () => {
      a.removeEventListener('loadedmetadata', done)
      a.removeAttribute('src')
      a.load?.()
    }
  }, [url])
  return sec
}

export function MusicEditor(props: {
  auth: AuthSession
  projectId: string
  take: StudioTake
  track: MusicTrack | null
  stored: MusicEdit
  tl: TimelineModel
  preview: Preview
  onSaved: () => Promise<void> | void
  onChange: () => void
}) {
  const toast = useToast()
  const url = useBlobUrl(props.auth, props.take.blobSha)
  const film = Math.max(1, props.tl.total)
  // Uploaded tracks may carry no length (code r1 P1): read it from the audio itself.
  const measured = useAudioDuration(url)
  const trackSec = props.track?.durationMs ? props.track.durationMs / 1000 : measured
  const [edit, setEdit] = useState<MusicEdit>(props.stored)
  const [saving, setSaving] = useState(false)
  // Reset the draft only when the saved edit itself changed (code r1 P1): every poll returns a new
  // object, and unsaved changes must survive it.
  const storedKey = JSON.stringify(compactEdit(props.stored))
  // biome-ignore lint/correctness/useExhaustiveDependencies: storedKey stands for props.stored
  useEffect(() => setEdit(props.stored), [storedKey])

  const inSec = edit.inSec ?? 0
  const lengthKnown = trackSec !== null
  const outSec = edit.outSec ?? trackSec ?? film
  const trackLen = Math.max(trackSec ?? outSec, outSec, 1)
  const problem = editProblem(edit, film)
  const dirty = JSON.stringify(compactEdit(edit)) !== JSON.stringify(compactEdit(props.stored))
  const set = (patch: MusicEdit) => setEdit((e) => ({ ...e, ...patch }))
  const placement = edit.startSec === undefined && edit.endSec === undefined ? 'film' : 'shots'
  const clips = props.tl.clips
  const fromShot = Math.max(
    0,
    clips.findIndex((c) => Math.abs(c.start - (edit.startSec ?? 0)) < 0.05),
  )
  const toShotRaw = clips.findIndex((c) => Math.abs(c.end - (edit.endSec ?? film)) < 0.05)
  const toShot = toShotRaw < 0 ? clips.length - 1 : toShotRaw

  // Drag the selection window or its two edges over the waveform.
  const lane = useRef<HTMLDivElement>(null)
  const drag = useRef<{
    kind: 'in' | 'out' | 'move'
    x0: number
    in0: number
    out0: number
  } | null>(null)
  const secAt = (dx: number) => {
    const w = lane.current?.getBoundingClientRect().width || 1
    return (dx / w) * trackLen
  }
  const onDown = (kind: 'in' | 'out' | 'move') => (e: ReactPointerEvent) => {
    e.preventDefault()
    // A handle sits inside the window: without this the window's 'move' would replace it.
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { kind, x0: e.clientX, in0: inSec, out0: outSec }
  }
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    const ds = secAt(e.clientX - d.x0)
    if (d.kind === 'in') set({ inSec: round1(Math.min(Math.max(0, d.in0 + ds), d.out0 - 1)) })
    else if (d.kind === 'out')
      set({ outSec: round1(Math.max(Math.min(trackLen, d.out0 + ds), d.in0 + 1)) })
    else {
      const len = d.out0 - d.in0
      const start = Math.min(Math.max(0, d.in0 + ds), trackLen - len)
      set({ inSec: round1(start), outSec: round1(start + len) })
    }
  }
  const onUp = () => {
    drag.current = null
  }

  const save = async (next: MusicEdit) => {
    const body = compactEdit(next)
    const why = editProblem(body, film)
    if (why) {
      toast(why, 'error')
      return
    }
    setSaving(true)
    try {
      const saved = await studioApi.setMusicEdit(props.auth, props.projectId, body)
      // The draft becomes what was saved (code r2 P1): "恢复默认" over an already-default saved edit
      // leaves the stored key unchanged, so the reset must come from here, not from the next poll.
      setEdit(saved ?? body)
      toast('剪辑已保存，合成时按这个来', 'success')
      await props.onSaved()
    } catch (err) {
      toast(studioErrorText(err), 'error')
    } finally {
      setSaving(false)
    }
  }
  const left = (inSec / trackLen) * 100
  const width = ((outSec - inSec) / trackLen) * 100
  const title = props.track?.title ?? `配乐 v${props.take.version}`
  const playing = props.preview.playing === props.take.blobSha

  const shotOptions = useMemo(
    () => clips.map((c, i) => ({ i, label: `#${i + 1} · ${mmss(c.start)}–${mmss(c.end)}` })),
    [clips],
  )

  return (
    <div className="st-music-edit">
      <section className="st-stage st-edit-stage" aria-label="截取片段">
        <div className="st-row" style={{ gap: 10 }}>
          <button
            type="button"
            className={`st-track-play${playing ? ' on' : ''}`}
            aria-label={playing ? `暂停 ${title}` : `试听 ${title}`}
            aria-pressed={playing}
            onClick={() => props.take.blobSha && props.preview.toggle(props.take.blobSha)}
          >
            <Play />
          </button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <b style={{ color: 'var(--st-stage-fg)' }}>
              {title}
              {props.track?.artist ? ` · ${props.track.artist}` : ''}
            </b>
            <div className="st-cap tnum" style={{ color: 'var(--st-stage-muted)' }}>
              {trackSec ? `原曲 ${mmss(trackSec)} · ` : ''}用 {mmss(inSec)} – {mmss(outSec)}（
              {round1(outSec - inSec)}s）
              {props.track?.bpm ? ` · ${Math.round(props.track.bpm)} BPM` : ''}
            </div>
          </div>
          {props.track ? <LicenseBadge license={props.track.license} /> : null}
          <button type="button" className="st-btn st-btn-sm st-btn-glass" onClick={props.onChange}>
            换一首
          </button>
        </div>
        {lengthKnown ? (
          <>
            <div
              className="st-trim"
              ref={lane}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              <div className="st-trim-wave" aria-hidden="true">
                <Waveform sha={props.take.blobSha} url={url} bars={180} height={80} label={title} />
              </div>
              <div
                className="st-trim-window"
                style={{ left: `${left}%`, width: `${width}%` }}
                onPointerDown={onDown('move')}
                data-testid="trim-window"
              >
                <span
                  className="st-trim-handle in"
                  onPointerDown={onDown('in')}
                  aria-hidden="true"
                />
                <span
                  className="st-trim-handle out"
                  onPointerDown={onDown('out')}
                  aria-hidden="true"
                />
              </div>
            </div>
            <div className="st-trim-sliders">
              <Slider
                id="st-me-in"
                label="入点"
                min={0}
                max={trackLen}
                step={0.1}
                value={inSec}
                format={mmss}
                onChange={(v) => set({ inSec: round1(Math.min(v, outSec - 1)) })}
              />
              <Slider
                id="st-me-out"
                label="出点"
                min={0}
                max={trackLen}
                step={0.1}
                value={outSec}
                format={mmss}
                onChange={(v) => set({ outSec: round1(Math.max(v, inSec + 1)) })}
              />
            </div>
          </>
        ) : (
          <div className="st-cap" style={{ color: 'var(--st-stage-muted)' }}>
            正在读取曲子时长…
          </div>
        )}
      </section>

      <div className="st-edit-grid">
        <section className="st-card st-edit-card" aria-label="对齐与长度">
          <div className="st-h3">对齐与长度</div>
          <div className="st-row st-edit-line">
            <span className="st-cap st-mix-label">放在成片里</span>
            <fieldset className="st-seg" aria-label="放置方式">
              <button
                type="button"
                className={placement === 'film' ? 'on' : ''}
                aria-pressed={placement === 'film'}
                onClick={() => set({ startSec: undefined, endSec: undefined })}
              >
                全片
              </button>
              <button
                type="button"
                className={placement === 'shots' ? 'on' : ''}
                aria-pressed={placement === 'shots'}
                disabled={clips.length === 0}
                onClick={() =>
                  set({ startSec: clips[0]?.start ?? 0, endSec: clips.at(-1)?.end ?? film })
                }
              >
                对齐到镜头
              </button>
            </fieldset>
          </div>
          {placement === 'shots' && clips.length ? (
            <div className="st-row st-edit-line">
              <label className="st-cap" htmlFor="st-me-from">
                从
              </label>
              <select
                id="st-me-from"
                className="st-input"
                value={fromShot}
                onChange={(e) => {
                  const i = Number(e.target.value)
                  set({
                    startSec: clips[i]!.start,
                    endSec: Math.max(edit.endSec ?? film, clips[i]!.end),
                  })
                }}
              >
                {shotOptions.map((o) => (
                  <option key={o.i} value={o.i}>
                    {o.label}
                  </option>
                ))}
              </select>
              <label className="st-cap" htmlFor="st-me-to">
                到
              </label>
              <select
                id="st-me-to"
                className="st-input"
                value={toShot}
                onChange={(e) => {
                  const i = Number(e.target.value)
                  set({
                    endSec: clips[i]!.end,
                    startSec: Math.min(edit.startSec ?? 0, clips[i]!.start),
                  })
                }}
              >
                {shotOptions.map((o) => (
                  <option key={o.i} value={o.i}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="st-cap tnum">
            在成片里从 {mmss(edit.startSec ?? 0)} 到 {mmss(edit.endSec ?? film)}（成片 {mmss(film)}
            ）
          </div>
          <label className="st-row st-edit-line" htmlFor="st-me-loop">
            <input
              id="st-me-loop"
              type="checkbox"
              checked={Boolean(edit.loop)}
              disabled={!lengthKnown}
              onChange={(e) =>
                set(
                  e.target.checked
                    ? { loop: { crossfadeSec: 2 }, outSec: round1(outSec) }
                    : { loop: undefined },
                )
              }
            />
            <span>不够长时循环（重复处交叉淡化）</span>
          </label>
          {edit.loop ? (
            <div className="st-mix">
              <Slider
                id="st-me-xf"
                label="交叉淡化"
                min={0}
                max={5}
                step={0.5}
                value={edit.loop.crossfadeSec ?? 0}
                format={(v) => `${v} s`}
                onChange={(v) => set({ loop: { crossfadeSec: v } })}
              />
            </div>
          ) : null}
        </section>

        <section className="st-card st-edit-card" aria-label="混音">
          <div className="st-h3">混音</div>
          <div className="st-mix">
            <Slider
              id="st-me-gain"
              label="音乐音量"
              min={-40}
              max={6}
              step={1}
              value={edit.gainDb ?? EDIT_DEFAULTS.gainDb}
              format={(v) => `${v} dB`}
              onChange={(v) => set({ gainDb: v })}
            />
            <Slider
              id="st-me-duck"
              label="旁白时压低"
              min={0}
              max={30}
              step={1}
              value={edit.duckDb ?? EDIT_DEFAULTS.duckDb}
              format={(v) => `−${v} dB`}
              onChange={(v) => set({ duckDb: v })}
            />
            <Slider
              id="st-me-fi"
              label="淡入"
              min={0}
              max={10}
              step={0.5}
              value={edit.fadeInSec ?? EDIT_DEFAULTS.fadeInSec}
              format={(v) => `${v} s`}
              onChange={(v) => set({ fadeInSec: v })}
            />
            <Slider
              id="st-me-fo"
              label="淡出"
              min={0}
              max={10}
              step={0.5}
              value={edit.fadeOutSec ?? EDIT_DEFAULTS.fadeOutSec}
              format={(v) => `${v} s`}
              onChange={(v) => set({ fadeOutSec: v })}
            />
          </div>
          <div className="st-cap">整体响度在合成时统一对齐到 −16 LUFS。</div>
        </section>
      </div>

      <div className="st-row st-edit-actions">
        {problem ? <output className="st-chip st-chip-bad">{problem}</output> : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="st-btn st-btn-sm"
          disabled={saving}
          onClick={() => save({})}
        >
          <RotateCcw />
          恢复默认
        </button>
        <button
          type="button"
          className="st-btn st-btn-primary st-btn-sm"
          disabled={saving || !dirty || Boolean(problem)}
          onClick={() => save(edit)}
        >
          <Save />
          {saving ? '保存中…' : '保存剪辑'}
        </button>
      </div>
    </div>
  )
}
