import {
  ArrowLeft,
  BookOpen,
  Camera,
  CheckCircle2,
  Clock3,
  FilePlus2,
  Search,
  Send,
  Sparkles,
  Users,
  XCircle,
} from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import type { ChatMessage } from '../../lib/chat/model'
import { api, apiErrorMessage } from '../../lib/api'
import {
  canWithdrawCommunityTutorial,
  communityCategoryLabel,
  communityTutorialDraftIssue,
  snapshotPublishGate,
  snapshotPublishGateMessage,
  tutorialKindOf,
  withdrawConsequence,
} from '../../lib/tutorialStudio'
import type {
  AuthSession,
  CommunityTutorialCategory,
  CommunityTutorialDetail,
  CommunityTutorialDraft,
  CommunityTutorialMine,
  CommunityTutorialStatus,
  CommunityTutorialSummary,
  TutorialLeakReport,
} from '../../lib/types'
import { Markdown } from '../Markdown'
import { Alert, Badge, Button, Field, Input, ListSkeleton, Select, Textarea, useConfirm, useToast } from '../ui'
import { PublishFromSessionDialog } from './PublishFromSessionDialog'
import { SnapshotTutorialDetail } from './SnapshotTutorialDetail'

const CATEGORY_OPTIONS = [
  { value: '', label: '全部分类' },
  { value: 'research', label: '科研' },
  { value: 'coding', label: '编码' },
  { value: 'general', label: '通用' },
]

/** 「提交于」只到分钟：精确到秒对用户没有含义（审计 TU-26）。 */
function formatSubmittedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

const STATUS_META: Record<
  CommunityTutorialStatus,
  { label: string; tone: 'warning' | 'success' | 'danger' | 'neutral'; icon: typeof Clock3 }
> = {
  draft: { label: '草稿', tone: 'neutral', icon: Clock3 },
  pending: { label: '待审核', tone: 'warning', icon: Clock3 },
  approved: { label: '已上线', tone: 'success', icon: CheckCircle2 },
  rejected: { label: '需修改', tone: 'danger', icon: XCircle },
  withdrawn: { label: '已撤回', tone: 'neutral', icon: XCircle },
  takedown: { label: '已下架', tone: 'danger', icon: XCircle },
}

type CommunityView = 'catalog' | 'submit' | 'mine'

export function CommunityTutorials({
  auth,
  onRequireLogin,
  activeSessionId = null,
  sessionMessages = [],
  sending = false,
  sessionTitle = '',
  sessionProjectId = null,
  initialDetailId = null,
  onDetailIdChange,
}: {
  auth?: AuthSession | null
  onRequireLogin?: () => void
  activeSessionId?: string | null
  sessionMessages?: ChatMessage[]
  sending?: boolean
  sessionTitle?: string
  sessionProjectId?: string | null
  initialDetailId?: string | null
  onDetailIdChange?: (id: string | null) => void
}) {
  const [view, setView] = useState<CommunityView>('catalog')
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [gateNotice, setGateNotice] = useState<string | null>(null)
  const [leakReport, setLeakReport] = useState<TutorialLeakReport | null>(null)
  const snapshotGate = snapshotPublishGate({
    authed: !!auth,
    sending,
    messageCount: sessionMessages.length,
  })
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CommunityTutorialCategory | ''>('')
  const [filters, setFilters] = useState<{
    query: string
    category: CommunityTutorialCategory | ''
  }>({ query: '', category: '' })
  const [items, setItems] = useState<CommunityTutorialSummary[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<CommunityTutorialDetail | null>(null)
  const [loading, setLoading] = useState(false)
  // 目录读失败与正文读失败分开（审计 TU-07）：此前共用一个 error，详情失败会压在目录上，
  // 目录失败又与「还没有匹配的教程」空态同屏。
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const toast = useToast()

  const loadCatalog = useCallback(
    async (cursor: string | null, append = false) => {
      setLoading(true)
      setCatalogError(null)
      try {
        const result = await api.listCommunityTutorials({
          cursor,
          query: filters.query,
          category: filters.category || null,
        })
        setItems((current) => (append ? [...current, ...result.tutorials] : result.tutorials))
        setNextCursor(result.nextCursor)
      } catch (cause) {
        setCatalogError(apiErrorMessage(cause, '加载教程工作室目录失败'))
      } finally {
        setLoading(false)
        setLoadedOnce(true)
      }
    },
    [filters],
  )

  useEffect(() => {
    void loadCatalog(null, false)
  }, [loadCatalog])

  const openDetail = async (id: string, syncRoute = true) => {
    setView('catalog')
    setLoading(true)
    setDetailError(null)
    try {
      setSelected(await api.getCommunityTutorial(id))
      if (syncRoute) onDetailIdChange?.(id)
    } catch (cause) {
      setDetailError(apiErrorMessage(cause, '加载教程正文失败'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!initialDetailId) return
    void openDetail(initialDetailId, false)
    // 深链 id 变化时打开对应详情；openDetail 读最新 onDetailIdChange。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDetailId])

  const closeDetail = () => {
    setSelected(null)
    onDetailIdChange?.(null)
  }

  const switchView = (next: CommunityView) => {
    setSelected(null)
    onDetailIdChange?.(null)
    setDetailError(null)
    setGateNotice(null)
    if (next !== 'catalog' && !auth) {
      onRequireLogin?.()
      return
    }
    setView(next)
  }

  const openSnapshot = () => {
    setSelected(null)
    onDetailIdChange?.(null)
    setDetailError(null)
    if (!auth) {
      onRequireLogin?.()
      return
    }
    if (!snapshotGate.ok) {
      setGateNotice(snapshotPublishGateMessage(snapshotGate.reason))
      return
    }
    setGateNotice(null)
    setSnapshotOpen(true)
  }

  // 子视图 / 详情里 hero 收成一行工具栏（审计 TU-25）：两行说明只在目录首屏有意义，
  // 在表单、我的发布和正文上方各顶 120–350px 只是把内容往下推。
  const compactHero = view !== 'catalog' || selected !== null

  return (
    <section className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-3 pb-12 pt-4 sm:px-7 sm:pt-7">
      <div className={compactHero ? 'rounded-2xl border border-border bg-surface px-4 py-3 shadow-sm' : 'rounded-3xl border border-accent/20 bg-surface p-5 shadow-sm sm:p-7'}>
        <div className={compactHero ? 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between' : 'flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between'}>
          <div>
            <p className="text-caption font-semibold uppercase tracking-widest text-accent">
              教程工作室
            </p>
            <h1 className={compactHero ? 'sr-only' : 'mt-2 text-heading font-bold text-fg'}>
              探索教程，或把一次真实会话变成可复用方法
            </h1>
            {!compactHero && (
              <p className="mt-2 max-w-2xl text-body leading-6 text-muted">
                可以手写 Markdown，也可以从当前已结束的会话生成交互快照。审核通过后进入公开目录。
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={view === 'catalog' ? 'accent' : 'secondary'}
              size="sm"
              onClick={() => switchView('catalog')}
            >
              <BookOpen size={14} /> 探索教程
            </Button>
            <Button
              variant={snapshotOpen ? 'accent' : 'secondary'}
              size="sm"
              aria-disabled={!!auth && !snapshotGate.ok}
              title={
                auth && !snapshotGate.ok ? snapshotPublishGateMessage(snapshotGate.reason) : undefined
              }
              onClick={openSnapshot}
            >
              <Camera size={14} /> 从当前会话生成
            </Button>
            <Button
              variant={view === 'submit' ? 'accent' : 'secondary'}
              size="sm"
              onClick={() => switchView('submit')}
            >
              <FilePlus2 size={14} /> 手写教程
            </Button>
            <Button
              variant={view === 'mine' ? 'accent' : 'secondary'}
              size="sm"
              onClick={() => switchView('mine')}
            >
              <Users size={14} /> 我的发布
            </Button>
          </div>
        </div>
      </div>

      {detailError && (
        <Alert tone="danger" className="mt-4">
          {detailError}
        </Alert>
      )}
      {gateNotice && (
        <Alert tone="warning" className="mt-4">
          {gateNotice}
        </Alert>
      )}
      {leakReport && (
        <Alert tone="info" className="mt-4" title="隐私扫描已完成">
          {leakReport.leaks && leakReport.leaks.length > 0
            ? `扫描命中：${leakReport.leaks.map((item) => item.rule).join('、')}`
            : leakReport.strippedRoles && leakReport.strippedRoles.length > 0
              ? `已剥离内部角色：${leakReport.strippedRoles.join('、')}`
              : '提交成功，可在「我的发布」查看审核状态。'}
        </Alert>
      )}
      {auth && activeSessionId && (
        <PublishFromSessionDialog
          open={snapshotOpen}
          onOpenChange={setSnapshotOpen}
          auth={auth}
          sessionId={activeSessionId}
          sessionTitle={sessionTitle}
          projectId={sessionProjectId}
          messages={sessionMessages}
          onSubmitted={(report) => {
            setLeakReport(report ?? null)
            toast('快照已提交审核，可在「我的发布」查看进度', 'success')
            setView('mine')
          }}
        />
      )}

      {view === 'catalog' && selected ? (
        tutorialKindOf(selected) === 'snapshot' ? (
          <SnapshotTutorialDetail item={selected} onBack={closeDetail} />
        ) : (
          <CommunityTutorialDetailView item={selected} onBack={closeDetail} />
        )
      ) : view === 'catalog' ? (
        <div className="mt-5">
          <form
            className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-3 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault()
              const nextFilters = { query: query.trim(), category }
              if (
                nextFilters.query === filters.query &&
                nextFilters.category === filters.category
              ) {
                void loadCatalog(null, false)
              } else {
                setFilters(nextFilters)
              }
            }}
          >
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border-control bg-bg px-3 focus-within:ring-2 focus-within:ring-ring">
              <Search size={15} className="shrink-0 text-faint" />
              <span className="sr-only">搜索社区教程</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索标题或摘要"
                className="h-10 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-faint md:text-sm"
              />
            </label>
            <Select
              aria-label="教程分类"
              className="sm:w-40"
              value={category}
              onValueChange={(value) => setCategory(value as CommunityTutorialCategory | '')}
              options={CATEGORY_OPTIONS}
            />
            <Button type="submit" variant="primary" loading={loading}>
              筛选
            </Button>
          </form>

          {catalogError ? (
            // 读失败时不渲染空态（否则像"目录是空的"），并给出可点的重试出口（审计 TU-07）。
            <Alert tone="danger" className="mt-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{catalogError}</span>
                <Button variant="secondary" size="sm" loading={loading} onClick={() => void loadCatalog(null, false)}>
                  重试
                </Button>
              </div>
            </Alert>
          ) : loading && items.length === 0 ? (
            <ListSkeleton variant="card" rows={4} className="mt-5" />
          ) : items.length === 0 && loadedOnce ? (
            <div className="mt-5 rounded-2xl border border-dashed border-border p-10 text-center">
              <BookOpen size={28} className="mx-auto text-faint" />
              <p className="mt-3 text-body font-medium text-fg">还没有匹配的教程</p>
              <p className="mt-1 text-meta text-faint">你可以成为第一个分享这类经验的人。</p>
            </div>
          ) : (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => void openDetail(item.id)}
                  className="group rounded-2xl border border-border bg-surface p-5 text-left shadow-sm outline-none transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="accent">{communityCategoryLabel(item.category)}</Badge>
                      {tutorialKindOf(item) === 'snapshot' && (
                        <Badge tone="neutral">
                          <Sparkles size={11} /> 会话快照
                        </Badge>
                      )}
                    </div>
                    <span className="text-caption text-faint">
                      {new Date(item.publishedAt).toLocaleDateString('zh-CN')}
                    </span>
                  </div>
                  <h2 className="mt-3 text-title font-semibold leading-6 text-fg group-hover:text-accent">
                    {item.title}
                  </h2>
                  <p className="mt-2 line-clamp-3 text-body leading-6 text-muted">{item.summary}</p>
                  <p className="mt-4 text-caption text-faint">作者：{item.authorName}</p>
                </button>
              ))}
            </div>
          )}
          {nextCursor && (
            <div className="mt-5 flex justify-center">
              <Button
                variant="secondary"
                loading={loading}
                onClick={() => void loadCatalog(nextCursor, true)}
              >
                加载更多
              </Button>
            </div>
          )}
        </div>
      ) : view === 'submit' && auth ? (
        <CommunityTutorialSubmit
          auth={auth}
          onSubmitted={() => {
            toast('教程已提交审核，通过后会进入公开目录', 'success')
            setView('mine')
          }}
        />
      ) : view === 'mine' && auth ? (
        <MyCommunityTutorials auth={auth} />
      ) : null}
    </section>
  )
}

function CommunityTutorialDetailView({
  item,
  onBack,
}: {
  item: CommunityTutorialDetail
  onBack: () => void
}) {
  return (
    <article className="mx-auto mt-5 w-full max-w-4xl rounded-3xl border border-border bg-surface p-5 shadow-sm sm:p-8">
      {/* 返回走 Button 原语，触屏自动 44px（审计 TU-11）。 */}
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 text-muted hover:text-fg">
        <ArrowLeft size={14} /> 返回探索教程
      </Button>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Badge tone="accent">{communityCategoryLabel(item.category)}</Badge>
        <span className="text-caption text-faint">
          {item.authorName} · {new Date(item.publishedAt).toLocaleDateString('zh-CN')}
        </span>
      </div>
      <h1 className="mt-3 text-heading font-bold leading-tight text-fg">{item.title}</h1>
      <p className="mt-3 text-body leading-6 text-muted">{item.summary}</p>
      <div className="mt-7 border-t border-border pt-7">
        <Markdown readOnly blockImages>
          {item.bodyMarkdown}
        </Markdown>
      </div>
    </article>
  )
}

function CommunityTutorialSubmit({
  auth,
  onSubmitted,
}: { auth: AuthSession; onSubmitted: () => void }) {
  const [draft, setDraft] = useState<CommunityTutorialDraft>({
    title: '',
    summary: '',
    category: 'general',
    bodyMarkdown: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 提交门槛前置（审计 TU-05）：此前只有必填星号，空标题 / 空正文能直接提交，等服务端拒绝才看到一条泛化错误。
  const issue = communityTutorialDraftIssue(draft)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (issue) {
      setError(issue)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await api.submitCommunityTutorial(auth, draft)
      onSubmitted()
    } catch (cause) {
      setError(apiErrorMessage(cause, '投稿失败，请稍后重试'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => void submit(event)}
      className="mx-auto mt-5 w-full max-w-3xl rounded-3xl border border-border bg-surface p-5 shadow-sm sm:p-7"
    >
      <h2 className="text-section font-semibold text-fg">发布一份新教程</h2>
      <p className="mt-1 text-meta text-muted">
        提交后进入管理员审核；审核前不会公开，正文支持 Markdown。
      </p>
      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}
      <div className="mt-5 grid gap-5">
        <Field label="标题" hint={`${draft.title.length}/100；至少 4 个字`} required>
          <Input
            value={draft.title}
            required
            minLength={4}
            maxLength={100}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="例如：用公开数据完成一份可复现分析"
          />
        </Field>
        <Field
          label="摘要"
          hint={`${draft.summary.length}/280；至少 10 个字，说明适合谁、能得到什么结果`}
          required
        >
          <Textarea
            value={draft.summary}
            required
            minLength={10}
            maxLength={280}
            rows={3}
            onChange={(event) =>
              setDraft((current) => ({ ...current, summary: event.target.value }))
            }
          />
        </Field>
        <Field label="分类" required>
          <Select
            value={draft.category}
            onValueChange={(value) =>
              setDraft((current) => ({ ...current, category: value as CommunityTutorialCategory }))
            }
            options={CATEGORY_OPTIONS.slice(1)}
          />
        </Field>
        <Field
          label="教程正文"
          hint={`${draft.bodyMarkdown.length}/50000；至少 40 个字，建议写清准备、步骤、结果和注意事项`}
          required
        >
          <Textarea
            value={draft.bodyMarkdown}
            required
            minLength={40}
            maxLength={50000}
            rows={16}
            className="font-mono"
            onChange={(event) =>
              setDraft((current) => ({ ...current, bodyMarkdown: event.target.value }))
            }
            // JS 字符串才有真正的换行；写在 JSX 属性字符串里 `\n` 会原样显示（审计 TU-06）。
            placeholder={'# 要解决的问题\n\n## 准备\n\n## 操作步骤\n\n## 如何核对结果'}
          />
        </Field>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
        {issue && (
          <p role="status" className="text-caption text-muted">
            {issue}
          </p>
        )}
        <Button type="submit" variant="primary" loading={submitting} disabled={!!issue}>
          <Send size={15} /> 提交审核
        </Button>
      </div>
    </form>
  )
}

function MyCommunityTutorials({ auth }: { auth: AuthSession }) {
  const [items, setItems] = useState<CommunityTutorialMine[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)
  const [confirm, confirmElement] = useConfirm()
  const toast = useToast()

  const load = useCallback(
    async (cursor: string | null, append = false) => {
      setLoading(true)
      setError(null)
      try {
        const result = await api.listMyCommunityTutorials(auth, cursor)
        setItems((current) => (append ? [...current, ...result.tutorials] : result.tutorials))
        setNextCursor(result.nextCursor)
      } catch (cause) {
        setError(apiErrorMessage(cause, '加载我的发布失败'))
      } finally {
        setLoading(false)
      }
    },
    [auth],
  )

  useEffect(() => {
    void load(null, false)
  }, [load])

  // 撤回是不可逆的危险操作：先确认、再发请求、按钮进忙态（审计 TU-08）。
  const withdraw = async (item: CommunityTutorialMine) => {
    const ok = await confirm({
      title: '撤回这份教程？',
      body: <p className="text-body text-muted">{withdrawConsequence(item.status)}</p>,
      confirmText: '撤回',
      danger: true,
    })
    if (ok !== true) return
    setError(null)
    setWithdrawingId(item.id)
    try {
      await api.withdrawCommunityTutorial(auth, item.id)
      toast('已撤回', 'success')
      await load(null, false)
    } catch (cause) {
      setError(apiErrorMessage(cause, '撤回失败'))
    } finally {
      setWithdrawingId(null)
    }
  }

  return (
    <div className="mx-auto mt-5 w-full max-w-4xl">
      {confirmElement}
      {error && <Alert tone="danger">{error}</Alert>}
      {loading && items.length === 0 ? (
        <ListSkeleton rows={3} />
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center text-body text-faint">
          你还没有发布。
        </div>
      ) : (
        <div className="grid gap-4">
          {items.map((item) => {
            const meta = STATUS_META[item.status]
            const Icon = meta.icon
            return (
              <article
                key={item.id}
                className="rounded-2xl border border-border bg-surface p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={meta.tone}>
                        <Icon size={12} /> {meta.label}
                      </Badge>
                      <Badge tone="neutral">{communityCategoryLabel(item.category)}</Badge>
                      {tutorialKindOf(item) === 'snapshot' && (
                        <Badge tone="accent">
                          <Sparkles size={11} /> 会话快照
                        </Badge>
                      )}
                    </div>
                    <h2 className="mt-3 text-title font-semibold text-fg">{item.title}</h2>
                    <p className="mt-1 text-body leading-6 text-muted">{item.summary}</p>
                  </div>
                  {canWithdrawCommunityTutorial(item.status) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={withdrawingId === item.id}
                      disabled={withdrawingId !== null}
                      onClick={() => void withdraw(item)}
                    >
                      撤回
                    </Button>
                  )}
                </div>
                {item.reviewNote && (
                  <Alert
                    tone={item.status === 'rejected' ? 'warning' : 'info'}
                    className="mt-4"
                    title="审核意见"
                  >
                    {item.reviewNote}
                  </Alert>
                )}
                <p className="mt-4 text-caption text-faint">
                  提交于 {formatSubmittedAt(item.createdAt)}
                </p>
              </article>
            )
          })}
        </div>
      )}
      {nextCursor && (
        <div className="mt-5 flex justify-center">
          <Button variant="secondary" loading={loading} onClick={() => void load(nextCursor, true)}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  )
}
