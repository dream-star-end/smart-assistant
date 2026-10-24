// OCV5-593 FE-3 配乐 (d07): music only reserves its slot and interface for now (user decision
// 2026-10-23 09:44 — no vendor bound). Without a ready music provider the page shows "未配置";
// once one is configured, candidates (music takes) appear with their waveforms.

import { Check, Music2, Play, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { useMemo } from 'react'

import { useBlobUrl } from '../../../hooks/useBlobUrl'
import { kindView } from '../../../hooks/useStudioProviders'
import { qaScoreOf, shotCard, timeline } from '../../../lib/studio/model'
import type { ProvidersView, StudioProjectView, StudioTake } from '../../../lib/studio/types'
import type { AuthSession } from '../../../lib/types'
import { AgentPanel } from '../AgentPanel'
import { Timeline } from '../Timeline'
import { UnconfiguredCard } from '../UnconfiguredCard'
import { Waveform } from '../Waveform'

function Candidate(props: { auth: AuthSession; take: StudioTake; chosen: boolean; label: string }) {
  const url = useBlobUrl(props.auth, props.take.blobSha)
  const score = qaScoreOf(props.take)
  return (
    <div
      className={`st-stage st-music-cand${props.chosen ? ' chosen' : ''}`}
      data-testid="music-candidate"
    >
      <div className="st-row" style={{ gap: 12 }}>
        <span className={`st-music-play${props.chosen ? ' on' : ''}`} aria-hidden="true">
          <Play size={14} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <b style={{ color: '#f5f4ed' }}>{props.label}</b>
          <div className="st-cap" style={{ color: 'var(--st-stage-muted)' }}>
            {props.take.provider} · {props.take.model}
          </div>
        </div>
        {props.chosen ? (
          <span className="st-chip st-chip-dark st-chip-agent">
            <Check />
            agent 已选
          </span>
        ) : null}
      </div>
      <div
        style={{
          color: props.chosen ? 'var(--st-agent)' : 'var(--st-stage-muted)',
          margin: '14px 0 10px',
        }}
      >
        <Waveform sha={props.take.blobSha} url={url} bars={96} height={44} label={props.label} />
      </div>
      {url ? (
        // biome-ignore lint/a11y/useMediaCaption: instrumental music, no speech to caption
        <audio className="st-music-audio" src={url} controls preload="none" />
      ) : null}
      {score !== null ? (
        <span className="st-chip st-chip-dark">情绪贴合 {score.toFixed(2)}</span>
      ) : null}
    </div>
  )
}

export function MusicPage(props: {
  auth: AuthSession
  view: StudioProjectView
  providers: ProvidersView
  onOpenShot: (shotId: string) => void
}) {
  const { auth, view } = props
  const music = kindView(props.providers, 'music')
  const cards = useMemo(
    () => [...view.shots].sort((a, b) => a.ordinal - b.ordinal).map((s) => shotCard(view, s)),
    [view],
  )
  const tl = useMemo(() => timeline(view), [view])
  const shown = useMemo(() => new Map(cards.map((c) => [c.shot.id, c.shown])), [cards])
  const candidates = view.takes
    .filter((t) => t.ownerKind === 'music' && t.status === 'succeeded' && t.blobSha)
    .sort((a, b) => b.version - a.version)
  const chosen = tl.music

  return (
    <div className="st-board">
      <div className="st-board-main">
        <div className="st-board-scroll">
          <div className="st-row st-board-head">
            <h2 className="st-title" style={{ fontSize: 18 }}>
              配乐
            </h2>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="st-btn st-btn-sm"
              disabled
              title={music.state === 'ready' ? '导演 agent 上线后可用' : '音乐生成未配置'}
            >
              <SlidersHorizontal />
              改方向
            </button>
            <button
              type="button"
              className="st-btn st-btn-sm"
              disabled
              title={music.state === 'ready' ? '导演 agent 上线后可用' : '音乐生成未配置'}
            >
              <RefreshCw />
              再来一版
            </button>
          </div>
          {music.state !== 'ready' ? (
            <div className="st-music-off">
              <UnconfiguredCard kind="music" offline={music.state === 'offline'} />
              <div className="st-cap">
                配乐功能已经预留：选好音乐供应商并配置 key 后，导演 agent
                会按分镜的情绪走向生成两个候选、对齐高潮镜头并自动混音，这一页也会自动开放。
              </div>
            </div>
          ) : candidates.length === 0 ? (
            <div className="st-stage st-brief-empty">
              <div className="st-row" style={{ gap: 8, color: 'var(--st-stage-fg)' }}>
                <Music2 size={16} />
                <b>还没有配乐候选</b>
              </div>
              <div className="st-cap" style={{ color: 'var(--st-stage-muted)', maxWidth: 440 }}>
                镜头和配音就绪后，导演 agent 会生成两个时长与成片一致的候选，并说明选它的理由。
              </div>
            </div>
          ) : (
            <div
              className="st-music-cands"
              // One candidate plays at a time (code r1 P1): starting one pauses the others.
              onPlay={(e) => {
                const playing = e.target
                for (const a of e.currentTarget.querySelectorAll('audio'))
                  if (a !== playing) a.pause()
              }}
            >
              {candidates.slice(0, 4).map((t, i) => (
                <Candidate
                  key={t.id}
                  auth={auth}
                  take={t}
                  chosen={chosen?.id === t.id}
                  label={`${String.fromCharCode(65 + i)} · v${t.version}`}
                />
              ))}
            </div>
          )}
        </div>
        <Timeline
          auth={auth}
          model={tl}
          shown={shown}
          musicState={music.state}
          selectedShotId={null}
          onSelect={props.onOpenShot}
        />
      </div>
      <AgentPanel auth={auth} view={view} cards={cards} onOpenShot={props.onOpenShot} />
    </div>
  )
}
