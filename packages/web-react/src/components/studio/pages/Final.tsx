// OCV5-593 FE-3 成片 (d08 / m05): the composed film on a cinema stage, its shots / voice / music
// strip, the final QA, export (FE-6: each format's film, a free re-compose for a new one, the .srt),
// the CC BY credits (d14) and the project cost breakdown.

import { Check, CircleAlert, Clapperboard, Download, MapPin, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { useBlobUrl } from '../../../hooks/useBlobUrl'
import { STUDIO_POLL_MS } from '../../../hooks/useStudioProject'
import { studioApi, studioErrorText } from '../../../lib/studio/api'
import {
  RESOLUTIONS,
  SUBTITLE_MODES,
  composingFilm,
  creditsText,
  failedFilm,
  filmFor,
  finalFilms,
  variantKey,
  variantOf,
} from '../../../lib/studio/final'
import type { ReusedFilm } from '../../../lib/studio/final'
import { formatCredits } from '../../../lib/studio/format'
import { shotCard } from '../../../lib/studio/model'
import type {
  ExportResolution,
  ExportSubtitles,
  StudioProjectView,
  StudioTake,
} from '../../../lib/studio/types'
import type { AuthSession } from '../../../lib/types'
import { useToast } from '../../ui'
import { MediaThumb } from '../MediaThumb'

const KIND_LABEL: Record<StudioTake['ownerKind'], string> = {
  bible: '设定图',
  shot_frame: '首帧',
  shot_video: '视频',
  line: '配音',
  music: '音乐',
  final: '合成',
}

/** Credits per take kind (and provider), in the order the pipeline spends them. */
export function costBreakdown(
  takes: StudioTake[],
): Array<{ label: string; count: number; credits: number }> {
  const order: StudioTake['ownerKind'][] = [
    'bible',
    'shot_frame',
    'shot_video',
    'line',
    'music',
    'final',
  ]
  const rows = new Map<string, { label: string; count: number; credits: number; rank: number }>()
  for (const t of takes) {
    const credits = Number(t.costCredits) || 0
    if (t.status === 'queued' || t.status === 'running') continue
    const label = `${KIND_LABEL[t.ownerKind]}${t.provider ? ` · ${t.provider}` : ''}`
    const row = rows.get(label) ?? { label, count: 0, credits: 0, rank: order.indexOf(t.ownerKind) }
    row.count += 1
    row.credits += credits
    rows.set(label, row)
  }
  return [...rows.values()]
    .filter((r) => r.credits > 0)
    .sort((a, b) => a.rank - b.rank || b.credits - a.credits)
    .map(({ label, count, credits }) => ({ label, count, credits }))
}

/** [field, label, format, passes] — each item is judged on its own (code r1 P1: never a blanket tick). */
export const QA_ITEMS: Array<[string, string, (v: unknown) => string, (v: unknown) => boolean]> = [
  ['character', '角色一致', (v) => Number(v).toFixed(2), (v) => Number(v) >= 0.75],
  [
    'subtitleSyncMs',
    '字幕与配音对齐',
    (v) => `±${Number(v)} ms`,
    (v) => Math.abs(Number(v)) <= 120,
  ],
  [
    'loudnessLufs',
    '响度',
    (v) => `${Number(v).toFixed(1)} LUFS`,
    (v) => Number(v) >= -18 && Number(v) <= -14,
  ],
  [
    'glitches',
    '黑帧 / 卡顿 / 爆音',
    (v) => (Number(v) === 0 ? '无' : `${Number(v)} 处`),
    (v) => Number(v) === 0,
  ],
  [
    'moderation',
    '内容审核',
    (v) => (v === 'pass' || v === true ? '通过' : v === 'review' ? '待人工复核' : '未通过'),
    (v) => v === 'pass' || v === true,
  ],
]

export function FinalPage(props: {
  auth: AuthSession
  view: StudioProjectView
  onOpenBoard: () => void
  /** A reload that does not overlap one in flight (useStudioProject.refresh). */
  onReload?: () => void
}) {
  const { auth, view } = props
  const films = useMemo(() => finalFilms(view), [view])
  const latest = films[0] ?? null
  const cards = useMemo(
    () => [...view.shots].sort((a, b) => a.ordinal - b.ordinal).map((s) => shotCard(view, s)),
    [view],
  )
  const costs = useMemo(() => costBreakdown(view.takes), [view.takes])
  // The picker starts on the newest film's own format (FE-6).
  const [res, setRes] = useState<ExportResolution>(() => variantOf(latest).resolution)
  const [subs, setSubs] = useState<ExportSubtitles>(() => variantOf(latest).subtitles)
  const key = variantKey({ resolution: res, subtitles: subs })
  /** Format → film the server said is current for it (an export answered `reused`). */
  const [reused, setReused] = useState<Record<string, ReusedFilm>>({})
  /** Format → newest final take version (any status) when its re-compose was asked for. */
  const [asked, setAsked] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const done = view.project.status === 'done'
  // The director's own compose failed (INC-20261027-STUDIO-COMPOSE-FAILED-NO-RETRY): nothing retries
  // it by itself, so the page offers it (approve hands the film back to the director, free).
  const composeFailed =
    view.project.status === 'awaiting_user' &&
    view.project.settings?.awaitingReason === 'compose_failed'
  const [retrying, setRetrying] = useState(false)
  const retryCompose = async () => {
    setRetrying(true)
    try {
      await studioApi.approve(auth, view.project.id)
      toast('已让导演 agent 重新合成成片，免费', 'success')
      props.onReload?.()
    } catch (err) {
      toast(studioErrorText(err), 'error')
    } finally {
      setRetrying(false)
    }
  }
  // Once the film goes back to the director (e.g. new music), earlier answers are stale.
  useEffect(() => {
    if (!done) {
      setReused({})
      setAsked({})
    }
  }, [done])

  const film = filmFor(films, key, reused[key], asked[key])
  const composing = composingFilm(view, key)
  // A re-compose that failed (the project stays done) ends the wait and can be asked again (r1 P1).
  const failed = composing ? null : failedFilm(view, key, asked[key])
  const waiting = !film && (composing !== null || (asked[key] !== undefined && !failed))
  // A done project with nothing in flight is not polled; while a re-compose is only queued (its
  // take not created yet) keep the view fresh here, in case no push arrives (r1 P1).
  const { onReload } = props
  useEffect(() => {
    if (!waiting || composing || !onReload) return
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'visible') onReload()
    }, STUDIO_POLL_MS)
    return () => window.clearInterval(tick)
  }, [waiting, composing, onReload])
  const shown = film ?? latest
  const url = useBlobUrl(auth, shown?.blobSha)
  const srtUrl = useBlobUrl(auth, film && subs === 'srt' ? film.final?.srtSha : null)
  const qa = (shown?.qa ?? null) as Record<string, unknown> | null
  const totalSec = cards.reduce((s, c) => s + c.seconds, 0)
  const credits = shown?.final?.credits ?? []
  const creditsUrl = useMemo(() => {
    if (!credits.length || typeof URL.createObjectURL !== 'function') return null
    return URL.createObjectURL(
      new Blob([creditsText(view.project.title, credits)], { type: 'text/plain;charset=utf-8' }),
    )
  }, [credits, view.project.title])
  useEffect(
    () => () => {
      if (creditsUrl) URL.revokeObjectURL(creditsUrl)
    },
    [creditsUrl],
  )
  const base = `${view.project.title || 'studio'}-v${film?.version ?? 0}-${key}`

  const exportFormat = async () => {
    if (busy) return
    setBusy(true)
    // After every attempt so far, failed ones included (code r2 P1): only a newer attempt can
    // end this wait, never the failure of an earlier one.
    const at = view.takes
      .filter((t) => t.ownerKind === 'final')
      .reduce((m, t) => Math.max(m, t.version), 0)
    try {
      const out = await studioApi.requestExport(auth, view.project.id, {
        resolution: res,
        subtitles: subs,
      })
      if ('reused' in out)
        setReused((m) => ({ ...m, [key]: { takeId: out.takeId, latestId: latest?.id ?? null } }))
      else {
        setAsked((m) => ({ ...m, [key]: at }))
        toast('正在按这个规格重新合成，免费', 'success')
      }
      props.onReload?.()
    } catch (err) {
      toast(studioErrorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="st-final">
      <section className="st-final-main st-stage">
        {composeFailed ? (
          <div
            role="alert"
            className="st-row"
            style={{ gap: 10, flexWrap: 'wrap', marginBottom: 10 }}
            data-testid="compose-failed"
          >
            <span className="st-chip st-chip-dark">
              <CircleAlert />
              成片没有合成成功，没有扣费
            </span>
            <button
              type="button"
              className="st-btn st-btn-sm st-glass"
              disabled={retrying}
              onClick={() => void retryCompose()}
            >
              <RefreshCw size={14} />
              {retrying ? '正在交给导演…' : '重新合成'}
            </button>
          </div>
        ) : null}
        <div className="st-row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <b className="st-review-title">成片{shown ? ` v${shown.version}` : ''}</b>
          <span className="st-chip st-chip-dark tnum">
            {view.project.aspect} · {view.project.fps}fps · {totalSec.toFixed(1)}s
          </span>
          {qa && qa.passed === true ? (
            <span className="st-chip st-chip-dark st-chip-ok">
              <Check />
              QA 全部通过
            </span>
          ) : null}
        </div>
        <div className="st-final-stage">
          {shown && url ? (
            <video
              className="st-final-video"
              src={url}
              controls
              playsInline
              preload="metadata"
              aria-label="成片"
            >
              <track kind="captions" />
            </video>
          ) : (
            <div className="st-final-empty">
              <Clapperboard size={28} />
              <div className="st-h3" style={{ color: 'var(--st-stage-fg)' }}>
                还没有成片
              </div>
              <div
                className="st-cap"
                style={{ color: 'var(--st-stage-muted)', maxWidth: 420, textAlign: 'center' }}
              >
                所有镜头通过、配音和配乐就绪后，导演 agent
                会在合成沙箱里剪成成片，并做一次成片质检。
              </div>
              <button
                type="button"
                className="st-btn st-btn-sm st-glass"
                onClick={props.onOpenBoard}
              >
                看镜头进度
              </button>
            </div>
          )}
        </div>
        {cards.length ? (
          <div className="st-final-strip" aria-label="镜头">
            {cards.map((c) => (
              <MediaThumb
                key={c.shot.id}
                auth={auth}
                take={c.shown}
                style={{ flex: c.seconds, height: 46, borderRadius: 0 }}
              >
                <span className="st-vclip-nm">#{c.shot.ordinal + 1}</span>
              </MediaThumb>
            ))}
          </div>
        ) : null}
        <div
          className="st-row st-cap st-hide-sm"
          style={{ color: 'var(--st-stage-faint)', gap: 6 }}
        >
          <MapPin size={12} />
          成片批注会在导演 agent 上线后开放（例如“片名晚 1 秒出”）
        </div>
      </section>

      <aside className="st-panel st-final-side" aria-label="成片信息">
        <div className="st-final-side-body">
          <div>
            <div className="st-label" style={{ marginBottom: 8 }}>
              成片 QA
            </div>
            {qa ? (
              <ul className="st-final-qa">
                {QA_ITEMS.filter(([k]) => qa[k] !== undefined).map(([k, label, fmt, passes]) => (
                  <li key={k} className={`st-row${passes(qa[k]) ? '' : ' st-qa-fail'}`}>
                    <span
                      className={`st-chip ${passes(qa[k]) ? 'st-chip-ok' : 'st-chip-warn'} st-qa-tick`}
                      role="img"
                      aria-label={passes(qa[k]) ? '通过' : '未达标'}
                    >
                      {passes(qa[k]) ? <Check /> : <CircleAlert />}
                    </span>
                    <span style={{ flex: 1 }}>{label}</span>
                    <b className="tnum">{fmt(qa[k])}</b>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="st-cap">成片合成后显示。</div>
            )}
          </div>
          <div>
            <div className="st-label" style={{ marginBottom: 8 }}>
              导出
            </div>
            <fieldset className="st-seg st-seg-full" aria-label="分辨率">
              {RESOLUTIONS.map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={res === v}
                  onClick={() => setRes(v)}
                  disabled={!latest}
                >
                  {l}
                </button>
              ))}
            </fieldset>
            <fieldset className="st-seg st-seg-full" aria-label="字幕" style={{ marginTop: 8 }}>
              {SUBTITLE_MODES.map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={subs === v}
                  onClick={() => setSubs(v)}
                  disabled={!latest}
                >
                  {l}
                </button>
              ))}
            </fieldset>
            {film && url && shown === film ? (
              <a
                className="st-btn st-btn-primary st-btn-lg st-final-dl"
                href={url}
                download={`${base}.mp4`}
                data-testid="final-download"
              >
                <Download />
                下载 mp4
              </a>
            ) : latest && done && !film && !waiting ? (
              <button
                type="button"
                className="st-btn st-btn-primary st-btn-lg st-final-dl"
                onClick={() => void exportFormat()}
                disabled={busy}
                data-testid="final-export"
              >
                <RefreshCw />
                {busy ? '正在提交…' : '按这个规格合成（免费）'}
              </button>
            ) : (
              <button
                type="button"
                className="st-btn st-btn-primary st-btn-lg st-final-dl"
                disabled
              >
                {waiting ? <RefreshCw className="st-spin" /> : <Download />}
                {waiting ? '正在按这个规格合成…' : '下载 mp4'}
              </button>
            )}
            {film && subs === 'srt' && film.final?.srtSha ? (
              srtUrl ? (
                <a
                  className="st-btn st-btn-lg st-final-dl"
                  style={{ marginTop: 6 }}
                  href={srtUrl}
                  download={`${base}.srt`}
                  data-testid="final-srt"
                >
                  <Download />
                  下载 .srt 字幕
                </a>
              ) : null
            ) : null}
            {/* User 2026-10-23 22:13: re-composing for another export format is free. */}
            <div className="st-cap" style={{ marginTop: 6 }} data-testid="export-free-note">
              切换规格（分辨率、竖屏、字幕方式）会重新合成一次，免费，不收任何费用。
            </div>
            <div className="st-cap" style={{ marginTop: 4 }} data-testid="export-format-note">
              {film
                ? '下载已合成的版本。'
                : failed && done
                  ? '上次按这个规格合成没有成功，可以再试一次（免费）。'
                  : waiting
                    ? '正在按这个规格重新合成（免费），好了会自动出现在这里。'
                    : !latest
                      ? '成片合成后可导出。'
                      : done
                        ? '这个规格还没合成过：点上方按钮免费重新合成一次。'
                        : '成片完成后可按其他规格重新合成（免费）。'}
            </div>
          </div>
          <div data-testid="final-credits">
            <div className="st-label" style={{ marginBottom: 8 }}>
              署名
            </div>
            {!shown ? (
              <div className="st-cap">成片合成后显示。</div>
            ) : credits.length === 0 ? (
              <div className="st-cap">这支片没有需要署名的素材。</div>
            ) : (
              <>
                <ul className="st-final-credits">
                  {credits.map((c) => (
                    <li key={`${c.kind}:${c.title}:${c.attributionText}`}>
                      <div className="st-row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <b>音乐 · {c.title || '（无标题）'}</b>
                        {c.license ? <span className="st-chip">{c.license}</span> : null}
                        <span className="st-chip st-chip-warn">必须署名</span>
                      </div>
                      <div className="st-cap" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
                        {c.attributionText}
                      </div>
                    </li>
                  ))}
                </ul>
                {creditsUrl ? (
                  <a
                    className="st-btn st-btn-sm"
                    style={{ marginTop: 8 }}
                    href={creditsUrl}
                    download={`${view.project.title || 'studio'}-credits.txt`}
                    data-testid="final-credits-txt"
                  >
                    <Download />
                    下载 credits.txt
                  </a>
                ) : null}
                <div className="st-cap" style={{ marginTop: 6 }}>
                  发布这支片时，请把以上署名原样附上（CC BY
                  协议要求）。写进片尾字幕会在后续版本支持。
                </div>
              </>
            )}
          </div>
          <div>
            <div className="st-label" style={{ marginBottom: 8 }}>
              本项目费用
            </div>
            {costs.length === 0 ? (
              <div className="st-cap">还没有产生费用。</div>
            ) : (
              <>
                <div className="st-cost-bar" aria-hidden="true">
                  {costs.map((r, i) => (
                    <i key={r.label} style={{ flex: r.credits, opacity: 1 - i * 0.12 }} />
                  ))}
                </div>
                <dl className="st-cost">
                  {costs.map((r) => (
                    <div key={r.label} className="st-row">
                      <dt>
                        {r.label} × {r.count}
                      </dt>
                      <dd className="tnum">{formatCredits(r.credits)}</dd>
                    </div>
                  ))}
                  <div className="st-row st-cost-total">
                    <dt>合计</dt>
                    <dd className="tnum">
                      {formatCredits(view.project.spentCredits)} /{' '}
                      {formatCredits(view.project.budgetCredits)}
                    </dd>
                  </div>
                </dl>
              </>
            )}
            {/* User 2026-10-23 21:42: compose is the director agent's job and is billed only by
                what the agent uses; there is no fixed per-compose fee to show here. */}
            <div className="st-cap st-cost-note" data-testid="compose-fee-note">
              成片合成由导演 agent 完成，按 agent 实际用量计费，不另收固定费用。
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}
