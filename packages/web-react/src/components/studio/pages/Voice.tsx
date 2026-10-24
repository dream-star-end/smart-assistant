// OCV5-593 FE-3 配音 (d06 / m04): the locked voices, every line with its real waveform, duration
// against its shot, preview playback, the timeline and the director panel. Voice design / clone are
// shown but not wired: no real calls for them yet (user decision 2026-10-23 09:44).

import { Captions, Check, Lock, Mic, Pause, Play, RefreshCw, Upload, Wand2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { useBlobUrl } from '../../../hooks/useBlobUrl'
import { kindView } from '../../../hooks/useStudioProviders'
import { type ShotCardModel, shotCard, takesOf, timeline } from '../../../lib/studio/model'
import type {
  ProvidersView,
  StudioLine,
  StudioProjectView,
  StudioTake,
} from '../../../lib/studio/types'
import type { AuthSession } from '../../../lib/types'
import { AgentPanel } from '../AgentPanel'
import { MediaThumb } from '../MediaThumb'
import { Timeline } from '../Timeline'
import { UnconfiguredCard } from '../UnconfiguredCard'
import { Waveform } from '../Waveform'

export function lineTake(view: StudioProjectView, line: StudioLine): StudioTake | null {
  const own = takesOf(view, line.id, ['line']).filter((t) => t.status === 'succeeded' && t.blobSha)
  return (
    (line.activeTakeId ? own.find((t) => t.id === line.activeTakeId) : undefined) ?? own[0] ?? null
  )
}

function LineRow(props: {
  auth: AuthSession
  line: StudioLine
  take: StudioTake | null
  shot: ShotCardModel | null
  voiceName: string
  playing: boolean
  onPlay: (audio: HTMLAudioElement | null) => void
}) {
  const { line, take, shot } = props
  const url = useBlobUrl(props.auth, take?.blobSha)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [seconds, setSeconds] = useState<number | null>(null)
  const shotSec = shot?.seconds ?? null
  const over = seconds !== null && shotSec !== null && seconds > shotSec
  const fit = seconds !== null && shotSec ? Math.min(100, (seconds / shotSec) * 100) : 0
  const auto = typeof line.status === 'string' && line.status === 'auto_extended'
  return (
    <li
      className={`st-card st-line${props.playing ? ' playing' : ''}${auto ? ' auto' : ''}`}
      data-testid="studio-line"
    >
      <MediaThumb
        auth={props.auth}
        take={shot?.shown ?? null}
        className="st-line-thumb"
        style={{ borderRadius: 8 }}
      >
        {shot ? <span className="st-line-n">#{shot.shot.ordinal + 1}</span> : null}
      </MediaThumb>
      <div className="st-line-text">
        <div className="st-line-say">{line.text}</div>
        <div className="st-cap">
          {props.voiceName}
          {line.emotion ? ` · ${line.emotion}` : ''}
          {line.speed ? ` · 语速 ${line.speed}` : ''}
        </div>
        {auto && shotSec ? (
          <div className="st-line-auto">
            <Check size={12} />
            台词比画面长，已自动把镜头延长到 {shotSec}s
          </div>
        ) : null}
      </div>
      <div className="st-line-wave" style={{ color: 'var(--st-trk-voice)' }}>
        {take ? (
          <Waveform sha={take.blobSha} url={url} bars={56} height={30} label={line.text} />
        ) : (
          <span className="st-cap">待配音</span>
        )}
      </div>
      <div className="st-line-fit">
        <div className="st-row st-cap" style={{ justifyContent: 'space-between' }}>
          <b className="tnum" style={{ color: 'var(--fg)' }}>
            {seconds !== null ? `${seconds.toFixed(1)}s` : '—'}
          </b>
          {shotSec ? <span>镜头 {shotSec}s</span> : null}
        </div>
        <span className="st-fit-bar">
          <i className={over ? 'over' : ''} style={{ width: `${fit}%` }} />
        </span>
      </div>
      <button
        type="button"
        className={`st-play${props.playing ? ' on' : ''}`}
        disabled={!url}
        aria-label={props.playing ? `暂停：${line.text}` : `试听：${line.text}`}
        onClick={() => props.onPlay(audioRef.current)}
      >
        {props.playing ? <Pause size={13} /> : <Play size={13} />}
      </button>
      {url ? (
        // biome-ignore lint/a11y/useMediaCaption: the line text is shown right next to the player
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration
            if (Number.isFinite(d)) setSeconds(d)
          }}
        />
      ) : null}
    </li>
  )
}

export function VoicePage(props: {
  auth: AuthSession
  view: StudioProjectView
  providers: ProvidersView
  onOpenShot: (shotId: string) => void
}) {
  const { auth, view } = props
  const voice = kindView(props.providers, 'voice')
  const cards = useMemo(
    () => [...view.shots].sort((a, b) => a.ordinal - b.ordinal).map((s) => shotCard(view, s)),
    [view],
  )
  const byShot = useMemo(() => new Map(cards.map((c) => [c.shot.id, c])), [cards])
  const lines = useMemo(() => [...view.lines].sort((a, b) => a.ordinal - b.ordinal), [view.lines])
  const voices = view.assets.filter((a) => a.kind === 'voice')
  const narrator = voices.find((a) => a.locked) ?? voices[0] ?? null
  const narratorTake = narrator?.blobSha ? ({ blobSha: narrator.blobSha } as StudioTake) : null
  const narratorUrl = useBlobUrl(auth, narratorTake?.blobSha)
  const tl = useMemo(() => timeline(view), [view])
  const shown = useMemo(() => new Map(cards.map((c) => [c.shot.id, c.shown])), [cards])
  const voiced = lines.filter((l) => lineTake(view, l)).length
  const [playing, setPlaying] = useState<string | null>(null)
  const current = useRef<HTMLAudioElement | null>(null)
  const readyProvider = voice.providers.find((p) => p.state === 'ready')

  const play = (id: string, el: HTMLAudioElement | null) => {
    if (!el) return
    if (playing === id) {
      el.pause()
      setPlaying(null)
      return
    }
    current.current?.pause()
    current.current = el
    el.currentTime = 0
    el.onended = () => setPlaying(null)
    void el
      .play()
      .then(() => setPlaying(id))
      .catch(() => setPlaying(null))
  }

  return (
    <div className="st-board">
      <aside className="st-voice-lib" aria-label="音色">
        <div className="st-label">音色 · 锁定后每句都用它</div>
        {narrator ? (
          <div className="st-stage st-voice-card">
            <div className="st-row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <span className="st-voice-ic" aria-hidden="true">
                <Mic size={18} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650, color: '#f5f4ed' }}>{narrator.name}</div>
                <div className="st-cap" style={{ color: 'var(--st-stage-muted)' }}>
                  {narrator.descriptor ?? (narrator.voiceId ? `音色 ${narrator.voiceId}` : '')}
                </div>
              </div>
            </div>
            {narratorUrl ? (
              <div style={{ color: 'var(--st-trk-voice)', marginTop: 12 }}>
                <Waveform
                  sha={narrator.blobSha}
                  url={narratorUrl}
                  bars={48}
                  height={26}
                  label={`${narrator.name} 试听`}
                />
              </div>
            ) : null}
            {narrator.locked ? (
              <span className="st-chip st-chip-dark st-chip-ok" style={{ marginTop: 10 }}>
                <Lock />
                已锁定
              </span>
            ) : null}
          </div>
        ) : (
          <div className="st-card st-image-empty">
            <div className="st-h3" style={{ fontSize: 13.5 }}>
              还没有选定音色
            </div>
            <div className="st-cap">开拍后导演 agent 会从系统音色里挑一个并锁定。</div>
          </div>
        )}
        {voices
          .filter((v) => v.id !== narrator?.id)
          .map((v) => (
            <div key={v.id} className="st-card st-voice-alt">
              <b>{v.name}</b>
              {v.descriptor ? <div className="st-cap">{v.descriptor}</div> : null}
            </div>
          ))}
        <div className="st-row" style={{ gap: 8 }}>
          <button
            type="button"
            className="st-btn st-btn-sm"
            style={{ flex: 1 }}
            disabled
            title="暂未开放"
          >
            <Wand2 />
            一句话设计
          </button>
          <button
            type="button"
            className="st-btn st-btn-sm"
            style={{ flex: 1 }}
            disabled
            title="暂未开放"
          >
            <Upload />
            上传克隆
          </button>
        </div>
        <div className="st-cap">
          设计音色和克隆音色暂未开放。开放后，克隆需要确认“本人声音或已获授权”，样本只在你自己的项目里可用。
        </div>
        <div style={{ flex: 1 }} />
        <div className="st-card st-voice-sub">
          <div className="st-row" style={{ gap: 6 }}>
            <Captions size={14} />
            <b>字幕</b>
          </div>
          <div className="st-cap">跟随配音实际时长自动对齐</div>
        </div>
      </aside>

      <div className="st-board-main">
        <div className="st-board-scroll">
          <div className="st-row st-board-head">
            <h2 className="st-title" style={{ fontSize: 18 }}>
              台词与配音
            </h2>
            {lines.length ? (
              <span className="st-chip st-chip-ok">
                {voiced} / {lines.length} 已配
              </span>
            ) : null}
            <span style={{ flex: 1 }} />
            {readyProvider ? (
              <span className="st-cap st-hide-sm">{readyProvider.label} · 按字计费</span>
            ) : null}
            <button
              type="button"
              className="st-btn st-btn-sm"
              disabled
              title="导演 agent 上线后可用"
            >
              <RefreshCw />
              全部重配
            </button>
          </div>
          {voice.state !== 'ready' ? (
            <div style={{ marginBottom: 14 }}>
              <UnconfiguredCard kind="voice" offline={voice.state === 'offline'} />
            </div>
          ) : null}
          {lines.length === 0 ? (
            <div className="st-stage st-brief-empty">
              <div className="st-h3" style={{ color: 'var(--st-stage-fg)' }}>
                还没有台词
              </div>
              <div className="st-cap" style={{ color: 'var(--st-stage-muted)', maxWidth: 440 }}>
                导演 agent
                写好分镜后会同时写出旁白和台词，用锁定的音色逐句配音，台词比画面长时自动延长镜头。
              </div>
            </div>
          ) : (
            <ul className="st-lines">
              {lines.map((l) => (
                <LineRow
                  key={l.id}
                  auth={auth}
                  line={l}
                  take={lineTake(view, l)}
                  shot={l.shotId ? (byShot.get(l.shotId) ?? null) : null}
                  voiceName={narrator?.name ?? '旁白'}
                  playing={playing === l.id}
                  onPlay={(el) => play(l.id, el)}
                />
              ))}
            </ul>
          )}
        </div>
        <Timeline
          auth={auth}
          model={tl}
          shown={shown}
          musicState={kindView(props.providers, 'music').state}
          selectedShotId={null}
          onSelect={props.onOpenShot}
        />
      </div>
      <AgentPanel auth={auth} view={view} cards={cards} onOpenShot={props.onOpenShot} />
    </div>
  )
}
