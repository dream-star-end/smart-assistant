// OCV5-593 studio home (d01 / m01): one-line brief on the stage, project cards, templates.

import {
  ArrowUpRight,
  BookOpen,
  Check,
  Clapperboard,
  Coins,
  Gift,
  GraduationCap,
  Hand,
  MessageSquare,
  Mic,
  Music,
  PenLine,
  Ratio,
  ShoppingBag,
  Sparkles,
  Timer,
  WandSparkles,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { kindView } from '../../hooks/useStudioProviders'
import { studioApi, studioErrorText } from '../../lib/studio/api'
import { formatAgo, formatCredits } from '../../lib/studio/format'
import type { StudioRoute } from '../../lib/studio/path'
import {
  ACTIVE_STATUSES,
  type ProvidersView,
  type StudioAspect,
  type StudioProject,
  type StudioStatus,
} from '../../lib/studio/types'
import type { AuthSession } from '../../lib/types'
import { useToast } from '../ui'
import { StateView } from './StateViews'

const ASPECTS: StudioAspect[] = ['16:9', '9:16', '1:1']
const DURATIONS = [15, 30, 60]
const BRIEF_MAX = 4000
const POLL_MS = 5000

const TEMPLATES: Array<{
  name: string
  meta: string
  brief: string
  aspect: StudioAspect
  sec: number
  bg: string
  icon: ReactNode
}> = [
  {
    name: '产品广告',
    meta: '15 秒 · 竖屏 · 旁白 + 节奏配乐',
    brief: '为我的产品拍一条 15 秒竖屏广告：开头 2 秒抓眼球，中间展示卖点，结尾出品牌名和口号。',
    aspect: '9:16',
    sec: 15,
    bg: 'linear-gradient(135deg,#1f1b3a,#5a3fee 60%,#b9a8ff)',
    icon: <ShoppingBag size={20} />,
  },
  {
    name: '知识科普',
    meta: '60 秒 · 横屏 · 讲解旁白',
    brief: '做一条 60 秒的横屏科普短片，旁白讲清楚一个知识点，画面配示意动画和关键词字幕。',
    aspect: '16:9',
    sec: 60,
    bg: 'linear-gradient(135deg,#0d2a2a,#127a6a 55%,#7fe0c4)',
    icon: <GraduationCap size={20} />,
  },
  {
    name: '故事短片',
    meta: '30 秒 · 横屏 · 角色对白',
    brief: '拍一条 30 秒的故事短片：一个角色、一个场景、一次转折，带简短对白，结尾留一点余味。',
    aspect: '16:9',
    sec: 30,
    bg: 'linear-gradient(135deg,#2a1608,#b4581f 55%,#ffcf8a)',
    icon: <BookOpen size={20} />,
  },
  {
    name: '节日祝福',
    meta: '20 秒 · 竖屏 · 温暖配乐',
    brief: '做一条 20 秒竖屏节日祝福视频，温暖的画面和配乐，结尾出现祝福语。',
    aspect: '9:16',
    sec: 20,
    bg: 'linear-gradient(135deg,#2a0c19,#c2335f 55%,#ffb3c7)',
    icon: <Gift size={20} />,
  },
]

type Filter = 'all' | 'active' | 'needs' | 'done'
const FILTERS: Array<[Filter, string]> = [
  ['all', '全部'],
  ['active', '进行中'],
  ['needs', '需要我'],
  ['done', '已完成'],
]

function matches(p: StudioProject, f: Filter): boolean {
  if (f === 'active') return ACTIVE_STATUSES.has(p.status) || p.status === 'paused'
  if (f === 'needs') return p.status === 'awaiting_user'
  if (f === 'done') return p.status === 'done'
  return true
}

function titleFromBrief(brief: string): string {
  const first = brief.trim().split(/[。！？!?\n]/)[0] ?? ''
  return [...first].slice(0, 24).join('') || '未命名影片'
}

const STATUS_CHIP: Record<StudioStatus, { label: string; tone: string; icon?: ReactNode }> = {
  draft: { label: '草稿', tone: '', icon: <PenLine /> },
  planning: { label: '写分镜中', tone: 'st-chip-agent' },
  running: { label: '生成中', tone: 'st-chip-agent' },
  composing: { label: '合成中', tone: 'st-chip-agent' },
  awaiting_user: { label: '需要你', tone: 'st-chip-warn', icon: <Hand /> },
  paused: { label: '已暂停', tone: 'st-chip-warn' },
  done: { label: '已完成', tone: 'st-chip-ok', icon: <Check /> },
  failed: { label: '失败', tone: 'st-chip-bad', icon: <X /> },
  canceled: { label: '已取消', tone: '' },
}

export function StatusChip({ status }: { status: StudioStatus }) {
  const s = STATUS_CHIP[status]
  return (
    <span className={`st-chip st-chip-dark ${s.tone}`}>
      {s.icon ?? <span className="st-dot" />}
      {s.label}
    </span>
  )
}

export function StudioHome(props: {
  auth: AuthSession
  providers: ProvidersView
  navigate: (r: StudioRoute) => void
}) {
  const { auth, navigate } = props
  const toast = useToast()
  const [brief, setBrief] = useState('')
  const [aspect, setAspect] = useState<StudioAspect>('16:9')
  const [sec, setSec] = useState(30)
  const [creating, setCreating] = useState(false)
  const [projects, setProjects] = useState<StudioProject[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(async () => {
    try {
      const page = await studioApi.listProjects(auth)
      setProjects(page.projects)
      setNext(page.next)
      setLoadError(null)
    } catch (err) {
      setLoadError(studioErrorText(err))
    }
  }, [auth])

  useEffect(() => {
    void load()
  }, [load])

  // Poll only while something is in flight, and never in a hidden tab.
  const anyActive = projects?.some((p) => ACTIVE_STATUSES.has(p.status)) ?? false
  useEffect(() => {
    if (!anyActive) return
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [anyActive, load])

  const loadMore = async () => {
    if (!next) return
    try {
      const page = await studioApi.listProjects(auth, next)
      setProjects((cur) => [...(cur ?? []), ...page.projects])
      setNext(page.next)
    } catch (err) {
      toast(studioErrorText(err), 'error')
    }
  }

  const start = async () => {
    const text = brief.trim()
    if (!text || creating) return
    setCreating(true)
    try {
      const project = await studioApi.createProject(auth, {
        title: titleFromBrief(text),
        brief: text,
        aspect,
        targetSec: sec,
      })
      // 全自动开拍 means start: the director begins planning now, not after a second click on the
      // brief page. A start that fails leaves a draft there, with its own 全自动开始 to retry.
      try {
        await studioApi.start(auth, project.id)
      } catch (err) {
        toast(`项目已创建，但没能开拍：${studioErrorText(err)}`, 'error')
      }
      navigate({ kind: 'project', id: project.id, page: 'brief' })
    } catch (err) {
      toast(studioErrorText(err), 'error')
    } finally {
      setCreating(false)
    }
  }

  const shown = useMemo(
    () => (projects ?? []).filter((p) => matches(p, filter)),
    [projects, filter],
  )
  const musicOff = kindView(props.providers, 'music').state !== 'ready'

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <section className="st-stage st-home-hero">
        <div>
          <div className="st-mobile-head st-only-sm">
            <span className="st-brand" aria-hidden="true">
              从
            </span>
            <span style={{ fontWeight: 650, fontSize: 15 }}>媒体工作台</span>
            <span style={{ flex: 1 }} />
            <a
              className="st-iconbtn"
              href="/"
              aria-label="回到对话"
              style={{ color: 'var(--st-stage-muted)' }}
            >
              <MessageSquare size={18} />
            </a>
          </div>
          <div className="st-row st-hide-sm" style={{ color: 'var(--st-agent)', gap: 8 }}>
            <Sparkles size={15} />
            <span style={{ fontSize: 12.5, fontWeight: 650, letterSpacing: '.02em' }}>
              导演 agent · 生图 · 视频 · 配音 · 音乐 · 成片
            </span>
          </div>
          <h1 className="st-display st-home-title">
            一句话，
            <br className="st-only-sm" />
            拍一支片。
          </h1>
          <p className="st-home-lede st-hide-sm">
            说出你想要的画面，agent
            会写分镜、定角色、逐镜头生成、配音配乐，最后剪成成片。只有拿不准的时候才来问你。
          </p>
          <form
            className="st-home-brief"
            onSubmit={(e) => {
              e.preventDefault()
              void start()
            }}
          >
            <label htmlFor="st-brief" className="sr-only">
              影片需求
            </label>
            <textarea
              id="st-brief"
              value={brief}
              maxLength={BRIEF_MAX}
              rows={2}
              placeholder="拍一条 30 秒的冬日红狐短片，纪录片质感，旁白沉稳，结尾出片名"
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void start()
                }
              }}
            />
            <div className="st-row" style={{ marginTop: 14, gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="st-chip st-chip-dark"
                aria-label={`画幅 ${aspect}，点击切换`}
                onClick={() => setAspect(ASPECTS[(ASPECTS.indexOf(aspect) + 1) % ASPECTS.length]!)}
              >
                <Ratio />
                {aspect}
              </button>
              <button
                type="button"
                className="st-chip st-chip-dark"
                aria-label={`时长 ${sec} 秒，点击切换`}
                onClick={() =>
                  setSec(DURATIONS[(DURATIONS.indexOf(sec) + 1) % DURATIONS.length] ?? 30)
                }
              >
                <Timer />
                {sec} 秒
              </button>
              <span className="st-chip st-chip-dark" aria-label="旁白">
                <Mic />
                <span className="st-hide-sm">旁白</span>
              </span>
              <span
                className="st-chip st-chip-dark st-hide-sm"
                title={musicOff ? '音乐生成未配置' : undefined}
              >
                <Music />
                {musicOff ? '配乐（未配置）' : '配乐'}
              </span>
              <div style={{ flex: 1 }} />
              <button
                type="submit"
                className="st-btn st-btn-agent st-btn-lg"
                disabled={!brief.trim() || creating}
              >
                <WandSparkles />
                {creating ? (
                  '正在开拍…'
                ) : (
                  <>
                    <span className="st-hide-sm">全自动开拍</span>
                    <span className="st-only-sm">开拍</span>
                  </>
                )}
              </button>
            </div>
          </form>
          <div
            className="st-row st-cap st-hide-sm"
            style={{ marginTop: 14, color: 'var(--st-stage-faint)', gap: 6 }}
          >
            <Coins size={13} />
            按实际生成扣积分；导演写好分镜后先算出预估，超出预算会暂停问你
          </div>
        </div>
        <div className="st-home-collage" aria-hidden="true">
          <div
            className="st-media st-placeholder"
            style={{ right: 20, top: 6, width: '78%', height: 242, transform: 'rotate(2deg)' }}
          />
          <div
            className="st-media st-placeholder"
            style={{ left: 0, top: 70, width: '55%', height: 169, transform: 'rotate(-4deg)' }}
          />
          <div
            className="st-media st-placeholder shade"
            style={{ right: 70, bottom: 0, width: '66%', height: 202 }}
          >
            <Clapperboard
              size={28}
              style={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                translate: '-50% -50%',
                color: 'var(--st-stage-faint)',
              }}
            />
          </div>
        </div>
      </section>

      <section className="st-home-section">
        <div className="st-row" style={{ marginBottom: 14, gap: 8, flexWrap: 'wrap' }}>
          <h2 className="st-title" style={{ fontSize: 18 }}>
            我的项目
          </h2>
          {projects ? <span className="st-cap">{projects.length}</span> : null}
          <div style={{ flex: 1 }} />
          <fieldset className="st-seg st-home-filter" aria-label="筛选项目">
            {FILTERS.map(([f, label]) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </div>
        {loadError ? (
          <StateView
            kind="error"
            title="项目加载失败"
            body={loadError}
            action={{ label: '重试', onClick: () => void load() }}
          />
        ) : projects === null ? (
          <div className="st-grid">
            {[0, 1, 2, 3].map((i) => (
              <div key={i}>
                <div className="st-stage" style={{ borderRadius: 12, aspectRatio: '16 / 9' }}>
                  <div
                    className="st-sk"
                    style={{ position: 'absolute', inset: 0, borderRadius: 12 }}
                  />
                </div>
                <div className="st-sk" style={{ height: 10, width: '70%', marginTop: 8 }} />
              </div>
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="st-card" style={{ padding: 22, boxShadow: 'none' }}>
            <div className="st-h3" style={{ fontSize: 14 }}>
              {projects.length === 0 ? '还没有项目' : '这个分类下没有项目'}
            </div>
            <div className="st-cap" style={{ marginTop: 4 }}>
              {projects.length === 0 ? '在上面写一句话，或者从下面的模板开始。' : '换个筛选看看。'}
            </div>
          </div>
        ) : (
          <div className="st-grid">
            {shown.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                onOpen={() =>
                  navigate({
                    kind: 'project',
                    id: p.id,
                    page: p.status === 'draft' ? 'brief' : 'board',
                  })
                }
              />
            ))}
          </div>
        )}
        {next ? (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button type="button" className="st-btn st-btn-sm" onClick={() => void loadMore()}>
              加载更多
            </button>
          </div>
        ) : null}

        <div className="st-row" style={{ margin: '24px 0 12px', gap: 8 }}>
          <h2 className="st-h3">从模板开始</h2>
          <span className="st-cap">agent 会按模板的节奏写分镜</span>
        </div>
        <div className="st-grid">
          {TEMPLATES.map((t) => (
            <button
              key={t.name}
              type="button"
              className="st-card hoverable st-row"
              style={{ padding: 12, gap: 12, textAlign: 'left' }}
              onClick={() => {
                setBrief(t.brief)
                setAspect(t.aspect)
                setSec(t.sec)
                document.getElementById('st-brief')?.focus()
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 14,
                  background: t.bg,
                  display: 'grid',
                  placeItems: 'center',
                  color: '#fff',
                  flex: 'none',
                }}
              >
                {t.icon}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 620 }}>{t.name}</span>
                <span className="st-cap">{t.meta}</span>
              </span>
              <ArrowUpRight size={16} style={{ color: 'var(--faint)' }} />
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

function ProjectCard({ project: p, onOpen }: { project: StudioProject; onOpen: () => void }) {
  const active = ACTIVE_STATUSES.has(p.status)
  const pct =
    Number(p.budgetCredits) > 0
      ? Math.min(100, (Number(p.spentCredits) / Number(p.budgetCredits)) * 100)
      : 0
  return (
    <button
      type="button"
      className="st-card hoverable"
      style={{ overflow: 'hidden', padding: 0, textAlign: 'left' }}
      onClick={onOpen}
      data-testid="studio-project-card"
    >
      <div
        className="st-media st-placeholder shade"
        style={{ aspectRatio: '16 / 9', borderRadius: 0 }}
      >
        <div style={{ position: 'absolute', left: 10, top: 10 }}>
          <StatusChip status={p.status} />
        </div>
        <div className="st-pcard-overlay st-only-sm" aria-hidden="true">
          {p.title || '未命名影片'}
        </div>
        {active ? (
          <>
            <div className="st-gen" />
            <div className="st-genbar">
              <i style={{ width: `${Math.max(4, pct)}%` }} />
            </div>
          </>
        ) : null}
      </div>
      <div style={{ padding: '12px 14px 14px' }}>
        <div
          className="st-h3 st-pcard-title"
          style={{
            fontSize: 14,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {p.title || '未命名影片'}
        </div>
        <div className="st-cap st-row" style={{ marginTop: 4, gap: 6 }}>
          <span>
            {p.aspect} · {p.targetSec} 秒 · {formatCredits(p.spentCredits)} 积分
          </span>
          <span style={{ flex: 1 }} />
          <span>{formatAgo(p.updatedAt)}</span>
        </div>
      </div>
    </button>
  )
}
