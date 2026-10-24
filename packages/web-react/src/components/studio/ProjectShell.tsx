// OCV5-593 project frame: breadcrumb, step tabs (需求 / 设定 / 镜头 / 配音 / 音乐 / 成片), credit pill.

import { ChevronRight, Clapperboard, Coins } from 'lucide-react'

import { useStudioProject } from '../../hooks/useStudioProject'
import { budgetPercent, formatCredits } from '../../lib/studio/format'
import type { StudioPage, StudioRoute } from '../../lib/studio/path'
import type { ProvidersView } from '../../lib/studio/types'
import type { AuthSession } from '../../lib/types'
import { StateView } from './StateViews'
import { BoardPage } from './pages/Board'
import { BriefPage } from './pages/Brief'
import { ImageStudioPage } from './pages/ImageStudio'
import { ReviewPage } from './pages/Review'

const STEPS: Array<[StudioPage, string]> = [
  ['brief', '需求'],
  ['image', '设定'],
  ['board', '镜头'],
  ['voice', '配音'],
  ['music', '音乐'],
  ['final', '成片'],
]

const PAGE_NAMES: Record<StudioPage, string> = {
  brief: '方案',
  image: '设定',
  board: '镜头',
  review: '审阅',
  voice: '配音',
  music: '音乐',
  final: '成片',
}

export function ProjectShell(props: {
  auth: AuthSession
  projectId: string
  page: StudioPage
  shot?: string
  providers: ProvidersView
  navigate: (r: StudioRoute, replace?: boolean) => void
}) {
  const { auth, projectId, page, navigate } = props
  const { state, reload, applyProject } = useStudioProject(auth, projectId)

  if (state.state === 'loading') return <StateView kind="loading" />
  if (state.state === 'missing') {
    return (
      <StateView
        kind="closed"
        title="项目不存在或已删除"
        action={{ label: '回到工作台', onClick: () => navigate({ kind: 'home' }, true) }}
      />
    )
  }
  if (state.state === 'error') {
    return (
      <StateView
        kind="error"
        title="项目加载失败"
        body="网络异常，请稍后再试"
        action={{ label: '重试', onClick: () => void reload() }}
      />
    )
  }
  const { project } = state.view
  const pct = budgetPercent(project.spentCredits, project.reservedCredits, project.budgetCredits)
  const go = (p: StudioPage) => navigate({ kind: 'project', id: projectId, page: p })

  return (
    <>
      <header className="st-topbar">
        <div className="st-crumb">
          <a
            href="/studio"
            className="st-row"
            style={{ gap: 6 }}
            onClick={(e) => {
              e.preventDefault()
              navigate({ kind: 'home' })
            }}
          >
            <Clapperboard size={16} />
            <span className="st-hide-sm">媒体工作台</span>
          </a>
          <ChevronRight size={14} className="st-hide-sm" />
          <b title={project.title}>{project.title || '未命名影片'}</b>
          <span className="st-hide-sm">{PAGE_NAMES[page]}</span>
        </div>
        <div style={{ flex: 1 }} />
        <nav className="st-steps" aria-label="制作步骤">
          {STEPS.map(([p, label], i) => (
            <a
              key={p}
              href={`/studio/p/${projectId}${p === 'board' ? '' : `/${p}`}`}
              aria-current={page === p || (page === 'review' && p === 'board') ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault()
                go(p)
              }}
            >
              <i className="n">{i + 1}</i>
              {label}
            </a>
          ))}
        </nav>
        <div
          className={`st-credit${pct >= 85 ? ' warn' : ''}`}
          title={`已花费 ${formatCredits(project.spentCredits)} · 预留 ${formatCredits(project.reservedCredits)} · 预算 ${formatCredits(project.budgetCredits)}`}
        >
          <Coins size={14} />
          <span className="tnum">{formatCredits(project.spentCredits)}</span>
          <span className="bar st-hide-sm">
            <i style={{ width: `${pct}%` }} />
          </span>
          <span className="st-cap tnum st-hide-sm">/ {formatCredits(project.budgetCredits)}</span>
        </div>
      </header>
      <nav className="st-steps-mobile" aria-label="制作步骤">
        {STEPS.map(([p, label]) => (
          <button key={p} type="button" aria-pressed={page === p} onClick={() => go(p)}>
            {label}
          </button>
        ))}
      </nav>
      {page === 'brief' ? (
        <BriefPage
          auth={auth}
          view={state.view}
          providers={props.providers}
          onProject={applyProject}
          onReload={reload}
          onDeleted={() => navigate({ kind: 'home' }, true)}
        />
      ) : page === 'board' ? (
        <BoardPage
          auth={auth}
          view={state.view}
          providers={props.providers}
          onOpenShot={(shot) => navigate({ kind: 'project', id: projectId, page: 'review', shot })}
          onOpenBrief={() => go('brief')}
        />
      ) : page === 'image' ? (
        <ImageStudioPage
          auth={auth}
          view={state.view}
          providers={props.providers}
          onReload={reload}
        />
      ) : page === 'review' ? (
        <ReviewPage auth={auth} view={state.view} shotId={props.shot} onBack={() => go('board')} />
      ) : (
        <StateView
          kind="soon"
          title={`${PAGE_NAMES[page]}页即将开放`}
          body="导演 agent 开拍后，这里会显示镜头、版本和批注。现在可以先在「需求」里调整方案和预算。"
          action={{ label: '去需求页', onClick: () => go('brief') }}
        />
      )}
    </>
  )
}
