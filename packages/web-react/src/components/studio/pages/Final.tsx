// OCV5-593 FE-3 成片 (d08 / m05): the composed film on a cinema stage, its shots / voice / music
// strip, the final QA, export (download of the composed file) and the project cost breakdown.

import { Check, CircleAlert, Clapperboard, Download, MapPin } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useBlobUrl } from '../../../hooks/useBlobUrl'
import { formatCredits } from '../../../lib/studio/format'
import { shotCard } from '../../../lib/studio/model'
import type { StudioProjectView, StudioTake } from '../../../lib/studio/types'
import type { AuthSession } from '../../../lib/types'
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
}) {
  const { auth, view } = props
  const finals = view.takes
    .filter((t) => t.ownerKind === 'final' && t.status === 'succeeded' && t.blobSha)
    .sort((a, b) => b.version - a.version)
  const final = finals[0] ?? null
  const url = useBlobUrl(auth, final?.blobSha)
  const cards = useMemo(
    () => [...view.shots].sort((a, b) => a.ordinal - b.ordinal).map((s) => shotCard(view, s)),
    [view],
  )
  const costs = useMemo(() => costBreakdown(view.takes), [view.takes])
  const [res, setRes] = useState<'1080p' | '720p' | 'vertical'>('1080p')
  const [subs, setSubs] = useState<'burn' | 'srt' | 'none'>('burn')
  const qa = (final?.qa ?? null) as Record<string, unknown> | null
  const totalSec = cards.reduce((s, c) => s + c.seconds, 0)

  return (
    <div className="st-final">
      <section className="st-final-main st-stage">
        <div className="st-row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <b className="st-review-title">成片{final ? ` v${final.version}` : ''}</b>
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
          {final && url ? (
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
              {(
                [
                  ['1080p', '1080p'],
                  ['720p', '720p'],
                  ['vertical', '竖屏 9:16'],
                ] as const
              ).map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={res === v}
                  onClick={() => setRes(v)}
                  disabled={!final}
                >
                  {l}
                </button>
              ))}
            </fieldset>
            <fieldset className="st-seg st-seg-full" aria-label="字幕" style={{ marginTop: 8 }}>
              {(
                [
                  ['burn', '字幕烧录'],
                  ['srt', '.srt'],
                  ['none', '无字幕'],
                ] as const
              ).map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={subs === v}
                  onClick={() => setSubs(v)}
                  disabled={!final}
                >
                  {l}
                </button>
              ))}
            </fieldset>
            {final && url ? (
              <a
                className="st-btn st-btn-primary st-btn-lg st-final-dl"
                href={url}
                download={`${view.project.title || 'studio'}-v${final.version}.mp4`}
              >
                <Download />
                下载 mp4
              </a>
            ) : (
              <button
                type="button"
                className="st-btn st-btn-primary st-btn-lg st-final-dl"
                disabled
              >
                <Download />
                下载 mp4
              </button>
            )}
            {/* User 2026-10-23 22:13: re-composing for another export format is free. */}
            <div className="st-cap" style={{ marginTop: 6 }} data-testid="export-free-note">
              切换规格（分辨率、竖屏、字幕方式）会重新合成一次，免费，不收任何费用。
            </div>
            <div className="st-cap" style={{ marginTop: 4 }} data-testid="export-format-note">
              {res !== '1080p' || subs !== 'burn'
                ? '换成这个规格需要重新合成一次（免费）；重新合成在导演 agent 上线后开放，现在下载的是已合成的版本。'
                : '下载已合成的版本。'}
            </div>
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
