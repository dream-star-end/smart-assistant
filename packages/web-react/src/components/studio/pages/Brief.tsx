// OCV5-593 方案页 (d02): the brief, the shot plan (empty until the director agent writes it),
// budget / format / autonomy, the locked bible, and the per-kind model plan from /providers.

import {
  CircleAlert,
  Film,
  Image as ImageIcon,
  Link2,
  Loader2,
  Mic,
  Music,
  Pause,
  Play,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import { kindView } from '../../../hooks/useStudioProviders'
import {
  type ProjectDraft,
  StudioApiError,
  studioApi,
  studioErrorText,
} from '../../../lib/studio/api'
import { formatCredits } from '../../../lib/studio/format'
import type {
  MediaKind,
  ProvidersView,
  StudioAspect,
  StudioEvent,
  StudioProject,
  StudioProjectView,
} from '../../../lib/studio/types'
import type { AuthSession } from '../../../lib/types'
import { useConfirm, useToast } from '../../ui'

const ASPECTS: StudioAspect[] = ['16:9', '9:16', '1:1']
const DURATIONS = [15, 30, 60]

const PLAN_ROWS: Array<{ kind: MediaKind; label: string; icon: ReactNode }> = [
  { kind: 'image', label: '设定 / 关键首帧', icon: <ImageIcon size={14} /> },
  { kind: 'video', label: '镜头视频', icon: <Film size={14} /> },
  { kind: 'voice', label: '配音', icon: <Mic size={14} /> },
  { kind: 'music', label: '音乐', icon: <Music size={14} /> },
]

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** The newest event of one of these types (events are not guaranteed to arrive sorted). */
function latestEvent(events: StudioEvent[], types: string[]): StudioEvent | null {
  let best: StudioEvent | null = null
  for (const e of events) {
    if (!types.includes(e.type)) continue
    if (!best || Date.parse(e.ts) > Date.parse(best.ts)) best = e
  }
  return best
}

function elapsedText(sec: number): string {
  return sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`
}

/**
 * While the director writes the storyboard. The planner answers in one piece (no partial shots
 * yet), so this says what is under way and for how long instead of an empty "还没写".
 */
export function PlanningStage(props: { project: StudioProject; events: StudioEvent[] }) {
  const started = latestEvent(props.events, ['project.started'])
  const since = Date.parse(started?.ts ?? props.project.updatedAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const sec = Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 1000)) : null
  const slots = Math.min(8, Math.max(3, Math.round(props.project.targetSec / 5)))
  return (
    <div className="st-stage st-brief-empty" data-testid="studio-planning">
      <div className="st-row" style={{ gap: 8 }}>
        <Loader2 size={16} className="st-spin" aria-hidden="true" />
        <div className="st-h3" style={{ color: 'var(--st-stage-fg)' }}>
          导演 agent 正在写分镜
        </div>
        <span style={{ flex: 1 }} />
        {sec !== null ? (
          <span className="st-chip st-chip-dark tnum" data-testid="studio-planning-elapsed">
            已用 {elapsedText(sec)}
          </span>
        ) : null}
      </div>
      <ol className="st-plan-steps">
        <li className="done">已开拍</li>
        <li className="on">审核需求，拆成镜头：景别、动作、台词、时长</li>
        <li>定好角色和场景的统一设定，算出预估积分</li>
      </ol>
      {sec !== null && sec >= 90 ? (
        <div className="st-cap" style={{ color: 'var(--st-stage-muted)' }}>
          比平时久一些，导演还在写，不用刷新页面。
        </div>
      ) : null}
      <div className="st-shot-grid" aria-hidden="true" style={{ marginTop: 8 }}>
        {Array.from({ length: slots }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders, never reordered
          <div key={i} className="st-sk" style={{ aspectRatio: '16 / 9', borderRadius: 12 }} />
        ))}
      </div>
    </div>
  )
}

export function ModelPlanRow(props: {
  providers: ProvidersView
  kind: MediaKind
  label: string
  icon: ReactNode
}) {
  const view = kindView(props.providers, props.kind)
  const ready = view.providers.find((p) => p.state === 'ready')
  const offline = view.providers.find((p) => p.state === 'offline')
  const pick = ready ?? offline
  const model = pick?.models.find((m) => m.isDefault) ?? pick?.models[0]
  return (
    <div className="st-row" style={{ gap: 10 }} data-testid={`plan-${props.kind}`}>
      <span
        className="st-iconbtn"
        style={{ width: 28, height: 28, borderRadius: 9, background: 'var(--hover)' }}
        aria-hidden="true"
      >
        {props.icon}
      </span>
      <span style={{ flex: 1 }}>{props.label}</span>
      {ready ? (
        <span className="st-cap">
          {ready.label}
          {model && model.label !== ready.label ? ` · ${model.label}` : ''}
        </span>
      ) : offline ? (
        <span className="st-chip st-chip-warn">{offline.label} 暂时不可用</span>
      ) : (
        <span className="st-chip">未配置</span>
      )}
    </div>
  )
}

export function BriefPage(props: {
  auth: AuthSession
  view: StudioProjectView
  providers: ProvidersView
  onProject: (p: StudioProject) => void
  onReload: () => Promise<void> | void
  onDeleted: () => void
  onEdit?: () => void
}) {
  const { auth, view, providers, onProject } = props
  const { project, shots, assets } = view
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()
  const draft = project.status === 'draft'
  const [editing, setEditing] = useState(false)
  const [briefText, setBriefText] = useState(project.brief)
  const [budget, setBudget] = useState(project.budgetCredits)
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [approving, setApproving] = useState(false)

  useEffect(() => {
    if (!editing) setBriefText(project.brief)
  }, [project.brief, editing])
  useEffect(() => setBudget(project.budgetCredits), [project.budgetCredits])

  const save = async (patch: ProjectDraft): Promise<boolean> => {
    setSaving(true)
    try {
      onProject(await studioApi.updateProject(auth, project.id, project.rev, patch))
      return true
    } catch (err) {
      toast(studioErrorText(err), 'error')
      if (err instanceof StudioApiError && err.code === 'STUDIO_REV_CONFLICT')
        await props.onReload()
      return false
    } finally {
      setSaving(false)
    }
  }

  const transition = async (action: 'pause' | 'resume' | 'cancel') => {
    try {
      onProject(await studioApi.transition(auth, project.id, action))
    } catch (err) {
      toast(studioErrorText(err), 'error')
    }
  }

  const startFilming = async () => {
    if (!draft || !project.brief.trim() || starting) return
    setStarting(true)
    try {
      await studioApi.start(auth, project.id)
      await props.onReload()
    } catch (err) {
      toast(studioErrorText(err), 'error')
    } finally {
      setStarting(false)
    }
  }

  const approvePlan = async () => {
    if (approving) return
    setApproving(true)
    try {
      await studioApi.approve(auth, project.id)
      await props.onReload()
    } catch (err) {
      toast(studioErrorText(err), 'error')
    } finally {
      setApproving(false)
    }
  }

  const awaitingReason =
    typeof project.settings.awaitingReason === 'string' ? project.settings.awaitingReason : null
  // Set by the director when the storyboard is written (plan.ready); absent before that.
  const estimate =
    typeof project.settings.estimateCredits === 'string' ? project.settings.estimateCredits : null
  const canApprove =
    project.status === 'awaiting_user' &&
    (awaitingReason === 'approve_plan' || awaitingReason === 'budget')
  // Why a started project is a draft again (plan.failed / brief moderation), shown where the plan
  // would be rather than only in the activity list. A later start clears it.
  const lastPlanEvent = latestEvent(view.events, [
    'project.started',
    'plan.failed',
    'brief.moderation',
  ])
  const planStop =
    lastPlanEvent && lastPlanEvent.type !== 'project.started'
      ? str(lastPlanEvent.payload?.message) || '分镜方案没写好，可以改一下需求再开拍。'
      : null

  const remove = async () => {
    const ok = await confirm({
      title: '删除这个项目？',
      body: '项目里的镜头、配音和成片都会一起删除，无法恢复。已经扣除的积分不会退回。',
      confirmText: '删除',
      danger: true,
    })
    if (ok !== true) return
    try {
      await studioApi.deleteProject(auth, project.id)
      props.onDeleted()
    } catch (err) {
      toast(studioErrorText(err), 'error')
    }
  }

  const bible = assets.filter(
    (a) => a.kind === 'character' || a.kind === 'scene' || a.kind === 'style',
  )
  const totalSec = shots.reduce((s, sh) => s + (Number(sh.spec.durationSec) || 0), 0)
  const budgetValid = /^\d{1,9}$/.test(budget) && budget !== project.budgetCredits

  return (
    <div className="st-brief" onChangeCapture={props.onEdit}>
      {confirmEl}
      <section className="st-brief-main">
        <div className="st-row" style={{ gap: 12, alignItems: 'flex-start' }}>
          <span className="st-brief-me" aria-hidden="true">
            我
          </span>
          {editing ? (
            <div className="st-card" style={{ flex: 1, padding: 12, borderRadius: 18 }}>
              <label htmlFor="st-brief-edit" className="sr-only">
                影片需求
              </label>
              <textarea
                id="st-brief-edit"
                className="st-textarea"
                value={briefText}
                maxLength={4000}
                rows={3}
                onChange={(e) => setBriefText(e.target.value)}
              />
              <div className="st-row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                <button
                  type="button"
                  className="st-btn st-btn-sm st-btn-ghost"
                  onClick={() => setEditing(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="st-btn st-btn-sm st-btn-primary"
                  disabled={saving || !briefText.trim()}
                  onClick={async () => {
                    if (await save({ brief: briefText.trim() })) setEditing(false)
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="st-card st-brief-bubble"
              disabled={!draft}
              title={draft ? '点击修改需求' : '已开拍，需求不能再改'}
              onClick={() => setEditing(true)}
            >
              {project.brief || '还没有写需求'}
            </button>
          )}
        </div>

        <div className="st-row" style={{ margin: '24px 0 14px', gap: 12, flexWrap: 'wrap' }}>
          <span className="st-agent-av" aria-hidden="true">
            <Sparkles size={17} />
          </span>
          <div>
            <h2 className="st-h3">分镜方案</h2>
            <div className="st-cap">
              {shots.length
                ? `${shots.length} 个镜头 · ${Math.round(totalSec)} 秒 · 每个镜头都会原样带上统一设定`
                : '导演 agent 开拍后会先写出分镜'}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <span className={`st-chip ${project.autonomy === 'max' ? 'st-chip-agent' : ''}`}>
            <Zap />
            {project.autonomy === 'max' ? '最高自动化 · 方案自动通过' : '逐步确认 · 方案需要你点头'}
          </span>
        </div>

        {shots.length ? (
          <div className="st-shot-grid">
            {shots.map((s) => (
              <div key={s.id} className="st-card" style={{ padding: 8, borderRadius: 18 }}>
                <div
                  className="st-stage st-placeholder"
                  style={{
                    aspectRatio: '16 / 9',
                    borderRadius: 12,
                    display: 'flex',
                    alignItems: 'flex-end',
                  }}
                >
                  <div className="st-row" style={{ padding: '8px 10px', width: '100%' }}>
                    <span className="st-chip st-chip-dark" style={{ fontWeight: 700 }}>
                      #{s.ordinal + 1}
                    </span>
                    {str(s.spec.framing) ? (
                      <span className="st-chip st-chip-dark">{str(s.spec.framing)}</span>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    {Number(s.spec.durationSec) ? (
                      <span className="st-chip st-chip-dark tnum">
                        {Number(s.spec.durationSec)}s
                      </span>
                    ) : null}
                  </div>
                </div>
                <div style={{ padding: '9px 6px 4px' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, lineHeight: '19px' }}>
                    {str(s.spec.action) || str(s.spec.title)}
                  </div>
                  {str(s.spec.source) ? (
                    <div className="st-cap st-row" style={{ marginTop: 4, gap: 5 }}>
                      <Link2 size={12} />
                      {str(s.spec.source)}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : project.status === 'planning' ? (
          <PlanningStage project={project} events={view.events} />
        ) : (
          <div className="st-stage st-brief-empty">
            {draft && planStop ? (
              <div className="st-row st-plan-stop" role="alert" data-testid="studio-plan-stopped">
                <CircleAlert size={15} />
                {planStop}
              </div>
            ) : null}
            <div className="st-h3" style={{ color: 'var(--st-stage-fg)' }}>
              分镜还没写
            </div>
            <div className="st-cap" style={{ color: 'var(--st-stage-muted)', maxWidth: 440 }}>
              开拍后，导演 agent
              会把需求拆成镜头（景别、动作、台词、时长），并定好角色和场景的统一设定。最高自动化下方案会自动通过，只有拿不准时才来问你。
            </div>
          </div>
        )}
      </section>

      <aside className="st-panel st-brief-side">
        <div>
          <div className="st-label">预算</div>
          <div className="st-row" style={{ marginTop: 10, gap: 22, alignItems: 'flex-end' }}>
            <div>
              <div className="st-display tnum" style={{ fontSize: 28 }}>
                {formatCredits(project.budgetCredits)}
              </div>
              <div className="st-cap">积分上限</div>
            </div>
            <div>
              <div className="st-display tnum" style={{ fontSize: 28 }}>
                {formatCredits(project.spentCredits)}
              </div>
              <div className="st-cap">
                已花费
                {Number(project.reservedCredits) > 0
                  ? ` · 预留 ${formatCredits(project.reservedCredits)}`
                  : ''}
              </div>
            </div>
          </div>
          <form
            className="st-row"
            style={{ marginTop: 12, gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault()
              if (budgetValid) void save({ budgetCredits: Number(budget) })
            }}
          >
            <label htmlFor="st-budget" className="st-cap" style={{ flex: 'none' }}>
              调整上限
            </label>
            <input
              id="st-budget"
              className="st-input tnum"
              inputMode="numeric"
              value={budget}
              onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ''))}
            />
            <button type="submit" className="st-btn st-btn-sm" disabled={!budgetValid || saving}>
              保存
            </button>
          </form>
        </div>

        <div className="st-divider" />
        <div>
          <div className="st-label">规格</div>
          <div className="st-spec">
            <span className="st-cap">画幅</span>
            <fieldset className="st-seg" aria-label="画幅">
              {ASPECTS.map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={project.aspect === a}
                  disabled={!draft || saving}
                  onClick={() => void save({ aspect: a })}
                >
                  {a}
                </button>
              ))}
            </fieldset>
            <span className="st-cap">时长</span>
            <fieldset className="st-seg" aria-label="时长">
              {(DURATIONS.includes(project.targetSec)
                ? DURATIONS
                : [...DURATIONS, project.targetSec]
              ).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={project.targetSec === d}
                  disabled={!draft || saving}
                  onClick={() => void save({ targetSec: d })}
                >
                  {d} 秒
                </button>
              ))}
            </fieldset>
            <span className="st-cap">自动化</span>
            <fieldset className="st-seg" aria-label="自动化程度">
              {(
                [
                  ['max', '最高'],
                  ['confirm', '逐步确认'],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={project.autonomy === v}
                  disabled={saving}
                  onClick={() => void save({ autonomy: v })}
                >
                  {label}
                </button>
              ))}
            </fieldset>
          </div>
          {!draft ? (
            <div className="st-cap" style={{ marginTop: 8 }}>
              已开拍，画幅和时长不能再改。
            </div>
          ) : null}
        </div>

        <div className="st-divider" />
        <div>
          <div className="st-label">统一设定</div>
          {bible.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
              {bible.map((a) => (
                <div key={a.id}>
                  <div style={{ fontWeight: 620 }}>
                    {a.name}
                    {a.locked ? (
                      <span className="st-chip st-chip-ok" style={{ marginLeft: 6 }}>
                        已锁定
                      </span>
                    ) : null}
                  </div>
                  {a.descriptor ? <div className="st-cap">{a.descriptor}</div> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="st-cap" style={{ marginTop: 8 }}>
              开拍后由 agent 生成角色和场景设定，并锁定给每个镜头使用。
            </div>
          )}
        </div>

        <div className="st-divider" />
        <div>
          <div className="st-label">模型安排 · 自动</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {PLAN_ROWS.map((r) => (
              <ModelPlanRow key={r.kind} providers={providers} {...r} />
            ))}
          </div>
        </div>

        <div style={{ flex: 1 }} />
        {draft ? (
          <>
            <button
              type="button"
              className="st-btn st-btn-agent st-btn-lg"
              style={{ width: '100%' }}
              disabled={starting || saving || !project.brief.trim()}
              title={!project.brief.trim() ? '请先写好影片需求' : undefined}
              onClick={() => void startFilming()}
            >
              <Zap />
              {starting ? '正在开拍…' : '全自动开始'}
            </button>
            <div className="st-cap" style={{ textAlign: 'center' }}>
              开拍后导演 agent 会写分镜并开始生成。超出预算 {formatCredits(project.budgetCredits)}{' '}
              时会自动暂停并问你。
            </div>
          </>
        ) : canApprove ? (
          <>
            <button
              type="button"
              className="st-btn st-btn-agent st-btn-lg"
              style={{ width: '100%' }}
              disabled={approving}
              onClick={() => void approvePlan()}
            >
              <Zap />
              {approving
                ? '确认中…'
                : awaitingReason === 'budget'
                  ? '预算已够，继续生成'
                  : '确认方案，继续生成'}
            </button>
            <div className="st-cap" style={{ textAlign: 'center' }}>
              {awaitingReason === 'budget'
                ? `预估 ${estimate ? formatCredits(estimate) : '—'} 积分，超过了当前预算，调高预算后再继续。`
                : `分镜已写好，预估 ${estimate ? formatCredits(estimate) : '—'} 积分；确认后导演 agent 开始生成镜头。`}
            </div>
          </>
        ) : project.status === 'planning' ||
          project.status === 'running' ||
          project.status === 'composing' ? (
          <div
            className="st-cap"
            style={{ textAlign: 'center' }}
            data-testid="studio-progress-note"
          >
            {project.status === 'planning'
              ? '导演 agent 正在写分镜（通常一分钟内），写好后会显示镜头和预估费用。'
              : estimate
                ? `分镜预估 ${formatCredits(estimate)} 积分，导演 agent 正在生成。`
                : '导演 agent 正在工作。'}
            超出预算 {formatCredits(project.budgetCredits)} 时会自动暂停并问你。
          </div>
        ) : null}
        <div className="st-row" style={{ gap: 8 }}>
          {project.status === 'running' || project.status === 'planning' ? (
            <button
              type="button"
              className="st-btn st-btn-sm"
              style={{ flex: 1 }}
              onClick={() => void transition('pause')}
            >
              <Pause />
              暂停
            </button>
          ) : null}
          {project.status === 'paused' ? (
            <button
              type="button"
              className="st-btn st-btn-sm"
              style={{ flex: 1 }}
              onClick={() => void transition('resume')}
            >
              <Play />
              继续
            </button>
          ) : null}
          {project.status !== 'draft' &&
          project.status !== 'done' &&
          project.status !== 'canceled' &&
          project.status !== 'failed' ? (
            <button
              type="button"
              className="st-btn st-btn-sm"
              style={{ flex: 1 }}
              onClick={() => void transition('cancel')}
            >
              <X />
              取消
            </button>
          ) : null}
          <button
            type="button"
            className="st-btn st-btn-sm st-btn-ghost"
            style={{ flex: 1, color: 'var(--danger)' }}
            onClick={() => void remove()}
          >
            <Trash2 />
            删除项目
          </button>
        </div>
      </aside>
    </div>
  )
}
