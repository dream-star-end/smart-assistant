// OCV5-593 FE-5 免版权曲库 (d10 / m06): search the curated catalog by words, moods, styles, length,
// BPM ("跟随镜头节奏" suggests a band from the cut) and vocals; only commercially usable tracks
// exist in the catalog, so "只看可商用" is a fixed fact, not a switch.

import { Activity, Check, Lock, Search, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { studioApi } from '../../../lib/studio/api'
import {
  MUSIC_GENRES,
  MUSIC_MOODS,
  type MusicQuery,
  type MusicTrack,
} from '../../../lib/studio/music'
import type { AuthSession } from '../../../lib/types'
import { TrackRow } from './TrackRow'
import type { Preview } from './usePreview'

const SEARCH_DEBOUNCE_MS = 300

function Tag(props: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`st-chip st-tag${props.on ? ' st-chip-acc' : ''}`}
      aria-pressed={props.on}
      onClick={props.onToggle}
    >
      {props.on ? <Check /> : null}
      {props.label}
    </button>
  )
}

function Range(props: {
  label: string
  min: number
  max: number
  step: number
  value: [number, number]
  format: (v: number) => string
  onChange: (v: [number, number]) => void
}) {
  const [lo, hi] = props.value
  const id = props.label
  return (
    <div className="st-range">
      <div className="st-row">
        <span className="st-cap st-range-label">{props.label}</span>
        <span style={{ flex: 1 }} />
        <span className="st-cap tnum">
          {props.format(lo)} – {props.format(hi)}
        </span>
      </div>
      <div className="st-range-pair">
        <input
          type="range"
          aria-label={`${id}下限`}
          min={props.min}
          max={props.max}
          step={props.step}
          value={lo}
          onChange={(e) => props.onChange([Math.min(Number(e.target.value), hi), hi])}
        />
        <input
          type="range"
          aria-label={`${id}上限`}
          min={props.min}
          max={props.max}
          step={props.step}
          value={hi}
          onChange={(e) => props.onChange([lo, Math.max(Number(e.target.value), lo)])}
        />
      </div>
    </div>
  )
}

export function LibrarySearch(props: {
  auth: AuthSession
  providerId: string
  tempo: { min: number; max: number; avgSec: number } | null
  inUseSha: string | null
  busy: boolean
  preview: Preview
  onUse: (track: MusicTrack) => void
  onFocus: (track: MusicTrack) => void
  onError: (err: unknown) => void
}) {
  const [text, setText] = useState('')
  const [vocals, setVocals] = useState<'no' | 'yes' | 'any'>('no')
  const [moods, setMoods] = useState<string[]>([])
  const [genres, setGenres] = useState<string[]>([])
  const [dur, setDur] = useState<[number, number]>([0, 300])
  const [bpm, setBpm] = useState<[number, number]>([40, 200])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [tracks, setTracks] = useState<MusicTrack[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)

  const query = useMemo<MusicQuery>(
    () => ({
      ...(text.trim() ? { text: text.trim() } : {}),
      ...(moods.length ? { moods } : {}),
      ...(genres.length ? { genres } : {}),
      ...(dur[0] > 0 ? { minSec: dur[0] } : {}),
      ...(dur[1] < 300 ? { maxSec: dur[1] } : {}),
      ...(bpm[0] > 40 ? { bpmMin: bpm[0] } : {}),
      ...(bpm[1] < 200 ? { bpmMax: bpm[1] } : {}),
      ...(vocals === 'any' ? {} : { vocals: vocals === 'yes' }),
    }),
    [text, moods, genres, dur, bpm, vocals],
  )

  const onError = useRef(props.onError)
  onError.current = props.onError
  useEffect(() => {
    const mine = ++seq.current
    const timer = window.setTimeout(() => {
      setLoading(true)
      studioApi
        .musicSearch(props.auth, props.providerId, query)
        .then((r) => {
          if (seq.current !== mine) return
          setTracks(r.tracks)
          setNext(r.next)
        })
        .catch((err) => {
          if (seq.current === mine) onError.current(err)
        })
        .finally(() => {
          if (seq.current === mine) setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [props.auth, props.providerId, query])

  const more = () => {
    if (!next) return
    const mine = seq.current
    studioApi
      .musicSearch(props.auth, props.providerId, { ...query, cursor: next })
      .then((r) => {
        if (seq.current !== mine) return
        setTracks((cur) => [...cur, ...r.tracks])
        setNext(r.next)
      })
      .catch(props.onError)
  }
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  const followTempo = props.tempo && bpm[0] === props.tempo.min && bpm[1] === props.tempo.max

  return (
    <div className="st-lib">
      <div className="st-card st-lib-filters">
        <div className="st-lib-top">
          <label className="st-search">
            <Search aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索曲库"
              placeholder="曲名、作者或情绪，例如：雪 清晨 钢琴"
              value={text}
              maxLength={100}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <fieldset className="st-seg" aria-label="人声">
            {(
              [
                ['no', '纯音乐'],
                ['yes', '含人声'],
                ['any', '都可以'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={vocals === v ? 'on' : ''}
                aria-pressed={vocals === v}
                onClick={() => setVocals(v)}
              >
                {label}
              </button>
            ))}
          </fieldset>
          <span
            className="st-chip st-chip-ok st-lib-commercial"
            title="曲库只收可商用的曲目（CC0 / CC BY），每首都逐一核验过授权"
          >
            <Lock />
            只看可商用
          </span>
          <button
            type="button"
            className="st-btn st-btn-sm st-show-sm"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <SlidersHorizontal />
            筛选
          </button>
        </div>
        <div className={`st-lib-more${filtersOpen ? ' open' : ''}`}>
          <div>
            <div className="st-cap st-range-label">情绪</div>
            <div className="st-tags">
              {MUSIC_MOODS.map((m) => (
                <Tag
                  key={m}
                  label={m}
                  on={moods.includes(m)}
                  onToggle={() => setMoods((c) => toggle(c, m))}
                />
              ))}
            </div>
          </div>
          <div>
            <div className="st-cap st-range-label">风格</div>
            <div className="st-tags">
              {MUSIC_GENRES.map((g) => (
                <Tag
                  key={g}
                  label={g}
                  on={genres.includes(g)}
                  onToggle={() => setGenres((c) => toggle(c, g))}
                />
              ))}
            </div>
          </div>
          <div className="st-lib-ranges">
            <Range
              label="时长"
              min={0}
              max={300}
              step={5}
              value={dur}
              format={(v) => `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`}
              onChange={setDur}
            />
            <Range
              label="BPM"
              min={40}
              max={200}
              step={2}
              value={bpm}
              format={(v) => String(v)}
              onChange={setBpm}
            />
            {props.tempo ? (
              <button
                type="button"
                className={`st-chip st-chip-agent st-tempo${followTempo ? ' on' : ''}`}
                aria-pressed={Boolean(followTempo)}
                onClick={() =>
                  setBpm(followTempo ? [40, 200] : [props.tempo!.min, props.tempo!.max])
                }
              >
                <Activity />
                跟随镜头节奏：平均镜头 {props.tempo.avgSec} 秒 → {props.tempo.min}–{props.tempo.max}{' '}
                BPM
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <div className="st-row st-lib-count">
        <b>
          {loading && tracks.length === 0
            ? '正在搜索…'
            : `${tracks.length}${next ? '+' : ''} 首符合`}
        </b>
        <span className="st-cap">BPM 未知的曲目不会出现在 BPM 区间筛选里</span>
      </div>
      <div className="st-col st-lib-list" aria-busy={loading}>
        {tracks.length === 0 && !loading ? (
          <div className="st-card st-lib-empty st-cap">没有符合的曲目，放宽一点筛选条件试试。</div>
        ) : null}
        {tracks.map((t) => (
          <TrackRow
            key={t.id}
            track={t}
            playing={props.preview.playing === t.previewSha}
            loading={props.preview.loading === t.previewSha}
            inUse={props.inUseSha === t.previewSha}
            busy={props.busy}
            onPlay={() => props.preview.toggle(t.previewSha)}
            onUse={() => props.onUse(t)}
            onFocus={() => props.onFocus(t)}
          />
        ))}
        {next ? (
          <button type="button" className="st-btn st-lib-next" onClick={more}>
            再看 20 首
          </button>
        ) : null}
      </div>
    </div>
  )
}
