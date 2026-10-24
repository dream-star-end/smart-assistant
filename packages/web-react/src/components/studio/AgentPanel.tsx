// OCV5-593 导演 agent panel (d04): what the agent is doing, the "需要你" candidates, activity,
// budget, and the instruction box (enabled when the orchestrator ships, A2-1).

import { Check, CircleAlert, Hand, ImageIcon, RefreshCw, Send, Sparkles, Zap } from 'lucide-react'

import { budgetPercent, formatCredits } from '../../lib/studio/format'
import { type ShotCardModel, eventText, eventTone } from '../../lib/studio/model'
import type { StudioProjectView } from '../../lib/studio/types'
import type { AuthSession } from '../../lib/types'
import { MediaThumb } from './MediaThumb'

const STATUS_LINE: Record<string, string> = {
  draft: '等你开拍',
  planning: '正在写分镜',
  running: '正在生成镜头',
  awaiting_user: '有镜头需要你看一下',
  composing: '正在合成成片',
  done: '成片已完成',
  failed: '项目失败，可以重试',
  paused: '已暂停',
  canceled: '已取消',
}

function timeOf(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export function AgentPanel(props: {
  auth: AuthSession
  view: StudioProjectView
  cards: ShotCardModel[]
  onOpenShot: (shotId: string) => void
}) {
  const { project, events, takes } = props.view
  const needs = props.cards.filter((c) => c.tone === 'needs')
  const pct = budgetPercent(project.spentCredits, project.reservedCredits, project.budgetCredits)
  return (
    <aside className="st-panel st-agent-panel" aria-label="导演 agent">
      <div className="st-row st-agent-head">
        <span className="st-agent-av" aria-hidden="true">
          <Sparkles size={17} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="st-h3">导演 agent</div>
          <div className="st-cap st-row" style={{ gap: 6 }}>
            <span
              className="st-dot"
              style={{ color: project.status === 'running' ? 'var(--success)' : 'var(--faint)' }}
            />
            {STATUS_LINE[project.status] ?? project.status}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        {project.autonomy === 'max' ? (
          <span className="st-chip st-chip-agent">
            <Zap />
            全自动
          </span>
        ) : null}
      </div>
      <div className="st-agent-body">
        {needs.map((c) => {
          const options = takes
            .filter(
              (t) =>
                t.ownerId === c.shot.id &&
                (t.ownerKind === 'shot_video' || t.ownerKind === 'shot_frame') &&
                t.status === 'succeeded' &&
                t.blobSha,
            )
            .sort((a, b) => b.version - a.version)
            .slice(0, 2)
          return (
            <div key={c.shot.id} className="st-needs">
              <div className="st-row" style={{ gap: 8 }}>
                <span className="st-chip st-chip-warn">
                  <Hand />
                  需要你
                </span>
                <b style={{ fontSize: 13 }}>
                  #{c.shot.ordinal + 1} {c.spec.title ?? ''}
                </b>
              </div>
              <div className="st-cap" style={{ marginTop: 6, color: 'var(--muted)' }}>
                {c.qaScore !== null
                  ? `自动重拍后质检仍未达标（${c.qaScore.toFixed(2)}）。挑一个版本，或者在画面上圈出问题。`
                  : 'agent 拿不准这个镜头，需要你看一眼。'}
              </div>
              {options.length ? (
                <div className="st-needs-opts">
                  {options.map((t) => (
                    <div key={t.id} className="st-needs-opt">
                      <MediaThumb
                        auth={props.auth}
                        take={t}
                        style={{ aspectRatio: '16 / 9', borderRadius: 0 }}
                      />
                      <span>v{t.version}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                className="st-btn st-btn-sm st-btn-primary"
                style={{ marginTop: 10 }}
                onClick={() => props.onOpenShot(c.shot.id)}
              >
                去审阅
              </button>
            </div>
          )
        })}
        <div>
          <div className="st-label" style={{ marginBottom: 10 }}>
            动态
          </div>
          {events.length === 0 ? (
            <div className="st-cap">还没有动态。</div>
          ) : (
            <ul className="st-events">
              {events.slice(0, 20).map((e) => {
                const tone = eventTone(e)
                return (
                  <li key={e.id} className="st-ev">
                    <span className={`st-ev-ic ${tone}`} aria-hidden="true">
                      {tone === 'ok' ? (
                        <Check />
                      ) : tone === 'retry' ? (
                        <RefreshCw />
                      ) : tone === 'bad' ? (
                        <CircleAlert />
                      ) : (
                        <ImageIcon />
                      )}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div>{eventText(e)}</div>
                      <div className="st-cap">{timeOf(e.ts)}</div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
      <div className="st-agent-foot">
        <div className="st-row st-cap" style={{ gap: 8 }}>
          <span>本项目已用</span>
          <b className="tnum" style={{ color: 'var(--fg)' }}>
            {formatCredits(project.spentCredits)}
          </b>
          <span className="st-agent-bar">
            <i style={{ width: `${pct}%` }} />
          </span>
          <span className="tnum">预算 {formatCredits(project.budgetCredits)}</span>
        </div>
        <div className="st-agent-input" title="导演 agent 上线后可以直接在这里说">
          <label htmlFor="st-agent-msg" className="sr-only">
            告诉导演哪里不对
          </label>
          <textarea
            id="st-agent-msg"
            rows={2}
            disabled
            placeholder="告诉导演哪里不对，比如“#5 改成黄昏”…（导演 agent 即将上线）"
          />
          <button type="button" className="st-send" disabled aria-label="发送">
            <Send size={14} />
          </button>
        </div>
      </div>
    </aside>
  )
}
