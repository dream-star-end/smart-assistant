// OCV5-593 FE-5 one track in a music list (d10 / m06): play / pause, a waveform, length and BPM,
// the licence badge, moods, and "用在这支片". BPM and moods that are guesses say so.

import { Check, Loader2, Pause, Play, Quote, ShieldCheck } from 'lucide-react'

import { type MusicTrack, licenseLabel, mmss } from '../../../lib/studio/music'
import { Waveform } from '../Waveform'

export function LicenseBadge(props: { license: MusicTrack['license'] | undefined }) {
  const free = props.license === 'CC0-1.0' || props.license === 'USER-STATEMENT'
  return (
    <span className={`st-chip ${free ? 'st-chip-ok' : 'st-chip-acc'}`}>
      {free ? <ShieldCheck /> : <Quote />}
      {licenseLabel(props.license)}
    </span>
  )
}

export function TrackRow(props: {
  track: MusicTrack
  playing: boolean
  loading: boolean
  inUse: boolean
  busy: boolean
  onPlay: () => void
  onUse: () => void
  onFocus?: () => void
}) {
  const t = props.track
  const guessed = t.metadata.moods === 'guessed'
  return (
    <div
      className={`st-card st-track${props.inUse ? ' in-use' : ''}`}
      data-testid="music-track"
      onMouseEnter={props.onFocus}
      onFocus={props.onFocus}
    >
      <button
        type="button"
        className={`st-track-play${props.playing ? ' on' : ''}`}
        aria-label={props.playing ? `暂停 ${t.title}` : `试听 ${t.title}`}
        aria-pressed={props.playing}
        onClick={props.onPlay}
      >
        {props.loading ? <Loader2 className="st-spin" /> : props.playing ? <Pause /> : <Play />}
      </button>
      <div className="st-track-name">
        <b>{t.title}</b>
        <span className="st-cap">
          {t.artist ? `${t.artist} · ` : ''}
          {t.origin === 'user-upload' ? '我的音乐' : `精选 · ${originLabel(t.origin)}`}
        </span>
      </div>
      <div className={`st-track-wave${props.playing ? ' on' : ''}`} aria-hidden="true">
        {/* Real peaks need the audio; the list shows the sha's quiet placeholder until played. */}
        <Waveform sha={t.previewSha} url={null} bars={72} height={28} label={t.title} />
      </div>
      <div className="st-track-meta st-cap">
        <b className="tnum">{mmss(t.durationMs === null ? null : t.durationMs / 1000)}</b>
        <span className="tnum">{t.bpm === null ? 'BPM 未知' : `${Math.round(t.bpm)} BPM`}</span>
      </div>
      <div className="st-track-tags">
        <LicenseBadge license={t.license} />
        {t.moods.slice(0, 3).map((m) => (
          <span key={m} className="st-chip">
            {m}
          </span>
        ))}
        {guessed ? (
          <span
            className="st-chip st-chip-warn"
            title="这批曲目没有试听过，情绪是按曲名和配器推测的"
          >
            情绪为推测
          </span>
        ) : null}
      </div>
      {props.inUse ? (
        <span className="st-chip st-chip-agent st-track-use">
          <Check />
          已用在这支片
        </span>
      ) : (
        <button
          type="button"
          className="st-btn st-btn-sm st-track-use"
          disabled={props.busy}
          onClick={props.onUse}
        >
          用在这支片
        </button>
      )}
    </div>
  )
}

export function originLabel(origin: string): string {
  switch (origin) {
    case 'incompetech':
      return 'Incompetech'
    case 'openverse':
      return 'Openverse'
    case 'pixabay':
      return 'Pixabay'
    default:
      return origin
  }
}
