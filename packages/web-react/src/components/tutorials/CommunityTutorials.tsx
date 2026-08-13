import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Clock3,
  FilePlus2,
  Search,
  Send,
  Users,
  XCircle,
} from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'
import type {
  AuthSession,
  CommunityTutorialCategory,
  CommunityTutorialDetail,
  CommunityTutorialDraft,
  CommunityTutorialMine,
  CommunityTutorialSummary,
} from '../../lib/types'
import { Markdown } from '../Markdown'
import { Alert, Badge, Button, Field, Input, Select, Textarea } from '../ui'

const CATEGORY_OPTIONS = [
  { value: '', label: '全部分类' },
  { value: 'research', label: '科研' },
  { value: 'coding', label: '编码' },
  { value: 'general', label: '通用' },
]

const CATEGORY_LABEL: Record<CommunityTutorialCategory, string> = {
  research: '科研',
  coding: '编码',
  general: '通用',
}

const STATUS_META = {
  pending: { label: '待审核', tone: 'warning' as const, icon: Clock3 },
  approved: { label: '已上线', tone: 'success' as const, icon: CheckCircle2 },
  rejected: { label: '需修改', tone: 'danger' as const, icon: XCircle },
  withdrawn: { label: '已撤回', tone: 'neutral' as const, icon: XCircle },
}

type CommunityView = 'catalog' | 'submit' | 'mine'

export function CommunityTutorials({
  auth,
  onRequireLogin,
}: {
  auth?: AuthSession | null
  onRequireLogin?: () => void
}) {
  const [view, setView] = useState<CommunityView>('catalog')
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
  const [error, setError] = useState<string | null>(null)

  const loadCatalog = useCallback(
    async (cursor: string | null, append = false) => {
      setLoading(true)
      setError(null)
      try {
        const result = await api.listCommunityTutorials({
          cursor,
          query: filters.query,
          category: filters.category || null,
        })
        setItems((current) => (append ? [...current, ...result.tutorials] : result.tutorials))
        setNextCursor(result.nextCursor)
      } catch (cause) {
        setError(apiErrorMessage(cause, '加载社区教程失败'))
      } finally {
        setLoading(false)
      }
    },
    [filters],
  )

  useEffect(() => {
    void loadCatalog(null, false)
  }, [loadCatalog])

  const openDetail = async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      setSelected(await api.getCommunityTutorial(id))
    } catch (cause) {
      setError(apiErrorMessage(cause, '加载教程正文失败'))
    } finally {
      setLoading(false)
    }
  }

  const switchView = (next: CommunityView) => {
    setSelected(null)
    setError(null)
    if (next !== 'catalog' && !auth) {
      onRequireLogin?.()
      return
    }
    setView(next)
  }

  return (
    <section className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-3 pb-12 pt-4 sm:px-7 sm:pt-7">
      <div className="rounded-3xl border border-accent/20 bg-surface p-5 shadow-sm sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-caption font-semibold uppercase tracking-widest text-accent">
              社区共建
            </p>
            <h1 className="mt-2 text-heading font-bold text-fg">
              把你的方法，变成所有人都能复用的教程
            </h1>
            <p className="mt-2 max-w-2xl text-body leading-6 text-muted">
              每位用户都可以投稿。管理员审核通过后，教程会立即进入公开目录。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={view === 'catalog' ? 'accent' : 'secondary'}
              size="sm"
              onClick={() => switchView('catalog')}
            >
              <BookOpen size={14} /> 公开教程
            </Button>
            <Button
              variant={view === 'submit' ? 'accent' : 'secondary'}
              size="sm"
              onClick={() => switchView('submit')}
            >
              <FilePlus2 size={14} /> 发布教程
            </Button>
            <Button
              variant={view === 'mine' ? 'accent' : 'secondary'}
              size="sm"
              onClick={() => switchView('mine')}
            >
              <Users size={14} /> 我的投稿
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}

      {view === 'catalog' && selected ? (
        <CommunityTutorialDetailView item={selected} onBack={() => setSelected(null)} />
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

          {items.length === 0 && !loading ? (
            <div className="mt-5 rounded-2xl border border-dashed border-border p-10 text-center">
              <BookOpen size={28} className="mx-auto text-faint" />
              <p className="mt-3 text-body font-medium text-fg">还没有匹配的社区教程</p>
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
                    <Badge tone="accent">{CATEGORY_LABEL[item.category]}</Badge>
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
        <CommunityTutorialSubmit auth={auth} onSubmitted={() => setView('mine')} />
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
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-meta text-muted hover:text-fg"
      >
        <ArrowLeft size={14} /> 返回社区教程
      </button>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Badge tone="accent">{CATEGORY_LABEL[item.category]}</Badge>
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

  const submit = async (event: FormEvent) => {
    event.preventDefault()
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
        <Field label="标题" hint={`${draft.title.length}/100`} required>
          <Input
            value={draft.title}
            minLength={4}
            maxLength={100}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            placeholder="例如：用公开数据完成一份可复现分析"
          />
        </Field>
        <Field
          label="摘要"
          hint={`${draft.summary.length}/280；说明适合谁、能得到什么结果`}
          required
        >
          <Textarea
            value={draft.summary}
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
          hint={`${draft.bodyMarkdown.length}/50000；建议写清准备、步骤、结果和注意事项`}
          required
        >
          <Textarea
            value={draft.bodyMarkdown}
            minLength={40}
            maxLength={50000}
            rows={16}
            className="font-mono"
            onChange={(event) =>
              setDraft((current) => ({ ...current, bodyMarkdown: event.target.value }))
            }
            placeholder="# 要解决的问题\n\n## 准备\n\n## 操作步骤\n\n## 如何核对结果"
          />
        </Field>
      </div>
      <div className="mt-6 flex justify-end">
        <Button type="submit" variant="primary" loading={submitting}>
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

  const load = useCallback(
    async (cursor: string | null, append = false) => {
      setLoading(true)
      setError(null)
      try {
        const result = await api.listMyCommunityTutorials(auth, cursor)
        setItems((current) => (append ? [...current, ...result.tutorials] : result.tutorials))
        setNextCursor(result.nextCursor)
      } catch (cause) {
        setError(apiErrorMessage(cause, '加载我的投稿失败'))
      } finally {
        setLoading(false)
      }
    },
    [auth],
  )

  useEffect(() => {
    void load(null, false)
  }, [load])

  const withdraw = async (id: string) => {
    setError(null)
    try {
      await api.withdrawCommunityTutorial(auth, id)
      await load(null, false)
    } catch (cause) {
      setError(apiErrorMessage(cause, '撤回失败'))
    }
  }

  return (
    <div className="mx-auto mt-5 w-full max-w-4xl">
      {error && <Alert tone="danger">{error}</Alert>}
      {items.length === 0 && !loading ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center text-body text-faint">
          你还没有投稿。
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
                      <Badge tone="neutral">{CATEGORY_LABEL[item.category]}</Badge>
                    </div>
                    <h2 className="mt-3 text-title font-semibold text-fg">{item.title}</h2>
                    <p className="mt-1 text-body leading-6 text-muted">{item.summary}</p>
                  </div>
                  {item.status === 'pending' && (
                    <Button variant="ghost" size="sm" onClick={() => void withdraw(item.id)}>
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
                  提交于 {new Date(item.createdAt).toLocaleString('zh-CN')}
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
