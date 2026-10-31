// OCV5-593 镜头看板 (d04 / m02): shot cards, the multi-track timeline and the director panel.

import { LayoutGrid, List, Plus, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'

import { kindView } from '../../../hooks/useStudioProviders'
import { formatCredits } from '../../../lib/studio/format'
import { type ShotCardModel, shotCard, timeline } from '../../../lib/studio/model'
import type { ProvidersView, StudioProjectView, StudioTake } from '../../../lib/studio/types'
import type { AuthSession } from '../../../lib/types'
import { AgentPanel } from '../AgentPanel'
import { MediaThumb } from '../MediaThumb'
import { ShotCard } from '../ShotCard'
import { Timeline } from '../Timeline'

function counts(cards: ShotCardModel[]) {
  const n = (tone: ShotCardModel['tone']) => cards.filter((c) => c.tone === tone).length
  return [
    [n('ok'), '通过', 'st-chip-ok'],
    [n('gen'), '生成中', 'st-chip-agent'],
    [n('needs'), '需要你', 'st-chip-warn'],
    [n('queued') + n('planned'), '排队', ''],
  ] as const
}

export function BoardPage(props: {
  auth: AuthSession
  view: StudioProjectView
  providers: ProvidersView
  onOpenShot: (shotId: string) => void
  onOpenBrief: () => void
  onReload?: () => void
}) {
  const { auth, view } = props
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const shots = useMemo(() => [...view.shots].sort((a, b) => a.ordinal - b.ordinal), [view.shots])
  const cards = useMemo(() => shots.map((s) => shotCard(view, s)), [view, shots])
  const tl = useMemo(() => timeline(view), [view])
  const shown = useMemo(
    () => new Map<string, StudioTake | null>(cards.map((c) => [c.shot.id, c.shown])),
    [cards],
  )
  const musicState = kindView(props.providers, 'music').state
  const needs = cards.filter((c) => c.tone === 'needs').length

  return (
    <div className="st-board">
      <div className="st-board-main">
        <div className="st-board-scroll">
          <div className="st-board-mobile-status">
            <span
              className="st-agent-av"
              aria-hidden="true"
              style={{ width: 28, height: 28, borderRadius: 9 }}
            >
              <Sparkles size={14} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }} className="st-cap">
              {needs
                ? `${needs} 个镜头需要你`
                : view.project.status === 'running'
                  ? '正在生成镜头'
                  : '导演 agent'}
            </span>
            <span className="st-cap tnum">
              {formatCredits(view.project.spentCredits)} /{' '}
              {formatCredits(view.project.budgetCredits)}
            </span>
          </div>
          <div className="st-row st-board-head">
            <h2 className="st-title" style={{ fontSize: 18 }}>
              镜头
            </h2>
            {counts(cards)
              .filter(([n]) => n > 0)
              .map(([n, label, tone]) => (
                <span key={label} className={`st-chip ${tone}`}>
                  {n} {label}
                </span>
              ))}
            <span style={{ flex: 1 }} />
            <fieldset className="st-seg st-hide-sm" aria-label="布局">
              <button
                type="button"
                aria-pressed={layout === 'grid'}
                onClick={() => setLayout('grid')}
              >
                <LayoutGrid size={14} />
                网格
              </button>
              <button
                type="button"
                aria-pressed={layout === 'list'}
                onClick={() => setLayout('list')}
              >
                <List size={14} />
                列表
              </button>
            </fieldset>
          </div>
          {cards.length === 0 ? (
            <div className="st-stage st-brief-empty">
              <div className="st-h3" style={{ color: 'var(--st-stage-fg)' }}>
                还没有镜头
              </div>
              <div className="st-cap" style={{ color: 'var(--st-stage-muted)', maxWidth: 440 }}>
                开拍后导演 agent 会写分镜并逐个生成镜头，进度会实时出现在这里。
              </div>
              <div>
                <button type="button" className="st-btn st-btn-sm" onClick={props.onOpenBrief}>
                  去需求页
                </button>
              </div>
            </div>
          ) : layout === 'grid' ? (
            <div className="st-shot-board">
              {cards.map((c) => (
                <ShotCard
                  key={c.shot.id}
                  auth={auth}
                  model={c}
                  onOpen={() => props.onOpenShot(c.shot.id)}
                />
              ))}
              <div className="st-card st-add-shot" aria-hidden="true">
                <Plus size={18} />
                <span className="st-cap st-hide-sm">加镜头，或让 agent 补一个（即将开放）</span>
              </div>
            </div>
          ) : (
            <ul className="st-shot-list">
              {cards.map((c) => (
                <li key={c.shot.id}>
                  <button
                    type="button"
                    className="st-shot-row"
                    onClick={() => props.onOpenShot(c.shot.id)}
                  >
                    <MediaThumb
                      auth={auth}
                      take={c.shown}
                      style={{ width: 96, aspectRatio: '16 / 9', borderRadius: 8, flex: 'none' }}
                    />
                    <span className="st-h3" style={{ fontSize: 13.5, flex: 'none', width: 140 }}>
                      #{c.shot.ordinal + 1} {c.spec.title ?? ''}
                    </span>
                    <span
                      className="st-cap"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {[c.spec.framing, c.spec.action].filter(Boolean).join(' · ')}
                    </span>
                    <span className="st-chip">{c.chip}</span>
                    <span className="st-cap tnum">{c.seconds}s</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Timeline
          auth={auth}
          model={tl}
          shown={shown}
          musicState={musicState}
          selectedShotId={cards.find((c) => c.tone === 'needs')?.shot.id ?? null}
          onSelect={props.onOpenShot}
        />
      </div>
      <AgentPanel
        auth={auth}
        view={view}
        cards={cards}
        onOpenShot={props.onOpenShot}
        {...(props.onReload ? { onReload: props.onReload } : {})}
      />
    </div>
  )
}
