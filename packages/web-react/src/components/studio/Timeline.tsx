// OCV5-593 multi-track timeline (always on the stage): picture, voice, music, subtitles. Lanes are
// laid out from the shot durations; audio blocks show their real waveform.

import { Music } from 'lucide-react'

import { useBlobUrl } from '../../hooks/useBlobUrl'
import { type TimelineModel, rulerTicks } from '../../lib/studio/model'
import type { StudioTake } from '../../lib/studio/types'
import type { AuthSession } from '../../lib/types'
import { MediaThumb } from './MediaThumb'
import { Waveform } from './Waveform'

function pct(v: number, total: number): string {
  return `${total > 0 ? (v / total) * 100 : 0}%`
}

function AudioBlock(props: {
  auth: AuthSession
  take: StudioTake | null
  left: string
  width: string
  color: string
  label?: string
}) {
  const url = useBlobUrl(props.auth, props.take?.blobSha)
  return (
    <div
      className="st-aclip"
      style={{
        left: props.left,
        width: props.width,
        color: props.color,
        background: `color-mix(in srgb, ${props.color} 16%, transparent)`,
      }}
      title={props.label}
    >
      {props.take ? (
        <Waveform sha={props.take.blobSha} url={url} bars={40} height={18} label={props.label} />
      ) : (
        <span className="st-aclip-empty" />
      )}
    </div>
  )
}

export function Timeline(props: {
  auth: AuthSession
  model: TimelineModel
  shown: Map<string, StudioTake | null>
  musicState: 'ready' | 'offline' | 'unconfigured'
  selectedShotId: string | null
  onSelect: (shotId: string) => void
}) {
  const { model } = props
  const total = model.total
  if (model.clips.length === 0) {
    return (
      <div className="st-timeline st-stage">
        <div className="st-cap" style={{ color: 'var(--st-stage-muted)', padding: '6px 0' }}>
          时间线会在分镜写好后出现。
        </div>
      </div>
    )
  }
  return (
    <div className="st-timeline st-stage" aria-label="时间线">
      <div className="st-row" style={{ marginBottom: 8 }}>
        <span className="st-tc">{total.toFixed(1)}s</span>
        <span style={{ flex: 1 }} />
        <span className="st-cap" style={{ color: 'var(--st-stage-faint)' }}>
          点击画面轨上的镜头即可打开审阅
        </span>
      </div>
      <div className="st-ruler" aria-hidden="true">
        {rulerTicks(total).map((s) => (
          <span key={s} style={{ left: pct(s, total) }}>
            {s}s
          </span>
        ))}
      </div>
      <div className="st-trk">
        <span className="st-trk-lab">
          <i style={{ background: '#f5f4ed' }} />
          画面
        </span>
        <div className="st-lane">
          {model.clips.map((c) => (
            <button
              key={c.shot.id}
              type="button"
              className={`st-vclip${props.selectedShotId === c.shot.id ? ' sel' : ''}`}
              style={{
                left: pct(c.start, total),
                width: `calc(${pct(c.end - c.start, total)} - 3px)`,
              }}
              onClick={() => props.onSelect(c.shot.id)}
              aria-label={`镜头 #${c.shot.ordinal + 1}`}
            >
              <MediaThumb
                auth={props.auth}
                take={props.shown.get(c.shot.id) ?? null}
                style={{ position: 'absolute', inset: 0, borderRadius: 7 }}
              />
              <span className="st-vclip-nm">#{c.shot.ordinal + 1}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="st-trk">
        <span className="st-trk-lab">
          <i style={{ background: 'var(--st-trk-voice)' }} />
          旁白
        </span>
        <div className="st-lane short">
          {model.lines.map((l) => (
            <AudioBlock
              key={l.line.id}
              auth={props.auth}
              take={l.take}
              left={pct(l.start, total)}
              width={pct(Math.max(0.3, l.end - l.start), total)}
              color={l.fits ? 'var(--st-trk-voice)' : 'var(--st-amber)'}
              label={l.fits ? l.line.text : `${l.line.text}（超出镜头时长，需改短或拆镜头）`}
            />
          ))}
        </div>
      </div>
      <div className="st-trk">
        <span className="st-trk-lab">
          <i style={{ background: 'var(--st-trk-music)' }} />
          音乐
        </span>
        <div className="st-lane short">
          {model.music ? (
            <AudioBlock
              auth={props.auth}
              take={model.music}
              left="0%"
              width="100%"
              color="var(--st-trk-music)"
              label="配乐"
            />
          ) : (
            <div className="st-ph-slot" data-testid="timeline-music-slot">
              <Music size={12} />
              {props.musicState === 'unconfigured'
                ? '音乐生成未配置'
                : props.musicState === 'ready'
                  ? '还没选配乐'
                  : '配乐待生成'}
            </div>
          )}
        </div>
      </div>
      <div className="st-trk">
        <span className="st-trk-lab">
          <i style={{ background: 'var(--st-trk-sub)' }} />
          字幕
        </span>
        <div className="st-lane short">
          {model.lines.map((l) => (
            <span
              key={l.line.id}
              className="st-subclip"
              style={{
                left: pct(l.start, total),
                width: pct(Math.max(0.3, l.end - l.start), total),
              }}
              title={l.line.text}
            >
              {l.line.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
