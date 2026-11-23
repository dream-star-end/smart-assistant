import { Check, Eye, EyeOff, Image as ImageIcon, PenLine, Sparkles, SquarePen, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BlogProse, type BlogImageSource } from '../../../components/tutorials/blog/BlogArticle'
import { blogCategoryLabel } from '../../../components/tutorials/blog/blogLib'
import { Alert, Button, ListSkeleton, Textarea, useToast } from '../../../components/ui'
import { apiErrorMessage } from '../../../lib/api'
import { adminApi } from '../../../lib/api/admin'
import type {
  AdminBlogPost,
  BlogModeration,
  BlogModerationDimension,
  BlogModerationRecord,
  BlogModerationStats,
} from '../../../lib/types'
import { cn } from '../../../lib/utils'
import { PageHeader } from '../../components'
import { adminSession } from '../../auth'
import { getAdminPage } from '../../registry'

type Tab = 'human' | 'approved' | 'rejected' | 'records'

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'human', label: '待人工复核' },
  { value: 'approved', label: '已发布' },
  { value: 'rejected', label: '已驳回' },
  { value: 'records', label: 'AI 审核记录' },
]

const DIMENSIONS: Array<{ key: BlogModerationDimension; label: string }> = [
  { key: 'violation', label: '违规' },
  { key: 'ad', label: '广告' },
  { key: 'leak', label: '泄密' },
  { key: 'low_quality', label: '低质' },
]

const MODE_LABEL: Record<BlogModerationStats['mode'], string> = { on: '开启', shadow: '影子模式（只记录）', off: '关闭' }

const VERDICT_LABEL: Record<BlogModeration['verdict'], string> = {
  pass: '通过',
  reject: '驳回',
  uncertain: '转人工',
  error: '出错转人工',
}

function stamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 「是」的概率 → 颜色:≥0.9 危险、≥0.5 警告、否则成功。 */
function meterColor(yes: number): string {
  if (yes >= 0.9) return 'var(--danger)'
  if (yes >= 0.5) return 'var(--warning)'
  return 'var(--success)'
}

function Verdict({ moderation }: { moderation: BlogModeration }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="oc-icon-badge oc-icon-badge-accent size-6 rounded-md">
          <Sparkles size={12.5} />
        </span>
        <h4 className="m-0 text-caption font-semibold text-faint">AI 判定（置信度）</h4>
      </div>
      <div className="oc-surface-recessed flex flex-col gap-2 rounded-xl p-3">
        {DIMENSIONS.map((dim) => {
          const yes = moderation.categories[dim.key]?.yes
          const pct = yes == null ? null : Math.round(yes * 100)
          const color = yes == null ? 'var(--faint)' : meterColor(yes)
          return (
            <div key={dim.key} className="grid grid-cols-[62px_1fr_42px] items-center gap-2 text-caption">
              <span className="text-fg">{dim.label}</span>
              <span className="blog-meter">
                <i className="oc-progress-fill" style={{ width: `${pct ?? 0}%`, background: color }} />
              </span>
              <span className="text-right font-semibold tabular-nums" style={{ color }}>
                {pct == null ? '—' : `${pct}%`}
              </span>
            </div>
          )
        })}
      </div>
      {moderation.adminNote && (
        <div className="oc-callout oc-callout-warning rounded-xl px-3 py-2.5 text-caption leading-relaxed text-muted">
          {moderation.adminNote}
        </div>
      )}
    </div>
  )
}

function ReviewCard({
  item,
  tab,
  busy,
  onApprove,
  onReject,
  onTakedown,
}: {
  item: AdminBlogPost
  tab: Tab
  busy: boolean
  onApprove: () => void
  onReject: (note: string) => void
  onTakedown: (note: string) => void
}) {
  const [preview, setPreview] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState('')
  const source = useMemo<BlogImageSource>(() => ({ kind: 'private', auth: adminSession }), [])
  const excerpt = item.bodyMarkdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[#>*`_-]/g, '').replace(/\s+/g, ' ').trim()
  const actionLabel = tab === 'approved' ? '下架' : '驳回'
  return (
    <article
      className={cn(
        'oc-surface-card oc-surface-card-hover grid gap-5 rounded-2xl p-5',
        item.moderation && 'lg:grid-cols-[1fr_300px]',
      )}
    >
      <div className="min-w-0">
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
          {item.editId && (
            <span className="blog-chip blog-chip-warn oc-badge-craft" title="已发布帖的修改稿：审核通过后替换线上版本，驳回则线上不变">
              <SquarePen size={12} aria-hidden /> 修改稿 · 线上为旧版
            </span>
          )}
          <span className="blog-chip blog-chip-accent oc-badge-craft">{blogCategoryLabel(item.category)}</span>
          {(item.imageCount ?? 0) > 0 && (
            <span className="blog-chip oc-badge-craft tabular-nums">
              <ImageIcon size={12} aria-hidden /> {item.imageCount} 张图
            </span>
          )}
          <span className="blog-chip oc-badge-craft tabular-nums">
            #{item.id} · {item.authorName} · {stamp(item.createdAt)}
          </span>
          {item.reviewSource && (
            <span className="blog-chip oc-badge-craft">{item.reviewSource === 'ai' ? 'AI 处理' : '人工处理'}</span>
          )}
        </div>
        <h3 className="m-0 mb-2 text-title font-bold tracking-tight text-fg">{item.title}</h3>
        <div className="oc-surface-recessed my-2.5 rounded-xl p-3.5 text-body leading-relaxed text-muted">
          {excerpt.slice(0, 120)}
          {excerpt.length > 120 ? '……' : ''}
          <br />
          <span className="tabular-nums">（正文 {(item.bodyChars ?? [...item.bodyMarkdown].length).toLocaleString('zh-CN')} 字）</span>
        </div>
        {item.reviewNote && tab !== 'human' && (
          <div
            className={cn(
              'oc-callout mb-3 rounded-xl px-3 py-2 text-caption leading-relaxed text-muted',
              tab === 'approved' ? 'oc-callout-info' : 'oc-callout-danger',
            )}
          >
            {tab === 'approved' ? '审核备注' : '驳回理由'}：{item.reviewNote}
          </div>
        )}
        <Button variant="secondary" size="sm" shape="pill" onClick={() => setPreview((v) => !v)}>
          {preview ? <EyeOff size={14} /> : <Eye size={14} />} {preview ? '收起全文' : '预览全文'}
        </Button>
        {preview && (
          <div className="oc-surface-recessed mt-3 max-h-[36rem] overflow-y-auto rounded-xl p-4">
            <BlogProse markdown={item.bodyMarkdown} source={source} />
          </div>
        )}
        {!item.moderation && tab !== 'records' && (
          <Actions
            tab={tab}
            busy={busy}
            actionLabel={actionLabel}
            approveLabel={item.editId ? '通过并替换线上' : '通过发布'}
            noteOpen={noteOpen}
            note={note}
            setNote={setNote}
            setNoteOpen={setNoteOpen}
            onApprove={onApprove}
            onReject={onReject}
            onTakedown={onTakedown}
          />
        )}
      </div>
      {item.moderation && (
        <div className="flex flex-col gap-3 border-border/80 lg:border-l lg:pl-5">
          <Verdict moderation={item.moderation} />
          <Actions
            tab={tab}
            busy={busy}
            actionLabel={actionLabel}
            approveLabel={item.editId ? '通过并替换线上' : '通过发布'}
            noteOpen={noteOpen}
            note={note}
            setNote={setNote}
            setNoteOpen={setNoteOpen}
            onApprove={onApprove}
            onReject={onReject}
            onTakedown={onTakedown}
          />
        </div>
      )}
    </article>
  )
}

function Actions(props: {
  tab: Tab
  busy: boolean
  actionLabel: string
  approveLabel: string
  noteOpen: boolean
  note: string
  setNote: (v: string) => void
  setNoteOpen: (v: boolean) => void
  onApprove: () => void
  onReject: (note: string) => void
  onTakedown: (note: string) => void
}) {
  const { tab, busy, actionLabel, noteOpen, note, setNote, setNoteOpen } = props
  if (tab === 'rejected' || tab === 'records') return null
  return (
    <div className="mt-auto flex flex-col gap-2 pt-1">
      {noteOpen && (
        <Textarea
          rows={3}
          maxLength={2000}
          value={note}
          autoFocus
          aria-label={`${actionLabel}理由`}
          placeholder={tab === 'approved' ? '下架理由（作者会看到）' : '驳回理由（作者会看到，说明怎么改）'}
          onChange={(event) => setNote(event.target.value)}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {tab === 'human' && !noteOpen && (
          <Button variant="accent" size="sm" shape="pill" loading={busy} disabled={busy} onClick={props.onApprove}>
            <Check size={14} /> {props.approveLabel}
          </Button>
        )}
        {noteOpen ? (
          <>
            <Button
              variant="danger"
              size="sm"
              shape="pill"
              loading={busy}
              disabled={busy || !note.trim()}
              onClick={() => (tab === 'approved' ? props.onTakedown(note.trim()) : props.onReject(note.trim()))}
            >
              确认{actionLabel}
            </Button>
            <Button variant="ghost" size="sm" shape="pill" onClick={() => setNoteOpen(false)}>
              取消
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="sm" shape="pill" disabled={busy} onClick={() => setNoteOpen(true)}>
            <X size={14} /> {actionLabel}…
          </Button>
        )}
      </div>
    </div>
  )
}

function RecordRow({ record }: { record: BlogModerationRecord }) {
  return (
    <article className="oc-surface-card oc-surface-card-hover grid gap-5 rounded-2xl p-5 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'blog-chip oc-badge-craft',
              record.verdict === 'pass' ? 'blog-chip-ok' : record.verdict === 'reject' ? 'blog-chip-bad' : 'blog-chip-warn',
            )}
          >
            {VERDICT_LABEL[record.verdict]}
          </span>
          <span className="blog-chip oc-badge-craft">{record.mode === 'shadow' ? '影子模式' : record.applied ? '已生效' : '未生效'}</span>
          {record.revisionId && <span className="blog-chip oc-badge-craft">修改稿</span>}
          <span className="blog-chip oc-badge-craft tabular-nums">
            #{record.publicationId} · {record.authorName} · {stamp(record.createdAt)}
          </span>
        </div>
        <h3 className="m-0 text-section font-semibold tracking-tight text-fg">{record.title}</h3>
        {record.reason && (
          <div className="oc-callout oc-callout-info mt-3 rounded-xl px-3 py-2 text-caption leading-relaxed text-muted">
            给作者的理由：{record.reason}
          </div>
        )}
      </div>
      <div className="border-border/80 lg:border-l lg:pl-5">
        <Verdict moderation={record} />
      </div>
    </article>
  )
}

export default function BlogAdminPage() {
  const meta = getAdminPage('blog')
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('human')
  const [items, setItems] = useState<AdminBlogPost[]>([])
  const [records, setRecords] = useState<BlogModerationRecord[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [stats, setStats] = useState<BlogModerationStats | null>(null)
  const [humanCount, setHumanCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true)
      setError(null)
      try {
        if (tab === 'records') {
          const page = await adminApi.adminBlogModerations(adminSession, cursor)
          setRecords((current) => (cursor ? [...current, ...page.moderations] : page.moderations))
          setNextCursor(page.nextCursor)
        } else {
          const page = await adminApi.adminListBlogPosts(adminSession, {
            status: tab === 'human' ? 'pending' : tab,
            needsHuman: tab === 'human',
            cursor,
          })
          setItems((current) => (cursor ? [...current, ...page.tutorials] : page.tutorials))
          setNextCursor(page.nextCursor)
        }
      } catch (cause) {
        setError(apiErrorMessage(cause, tab === 'records' ? '加载 AI 审核记录失败' : '加载经验分享失败'))
      } finally {
        setLoading(false)
      }
    },
    [tab],
  )

  useEffect(() => {
    setItems([])
    setRecords([])
    void load(null)
  }, [load])

  useEffect(() => {
    // AI 审核(PR-B)之前的后端没有这个接口:拿不到就不显示 AI 状态行。
    adminApi
      .adminBlogModerationStats(adminSession)
      .then(setStats)
      .catch(() => setStats(null))
    adminApi
      .adminListBlogPosts(adminSession, { status: 'pending', needsHuman: true })
      .then((page) => setHumanCount(page.tutorials.length + (page.nextCursor ? 1 : 0)))
      .catch(() => {})
  }, [])

  const act = async (
    item: AdminBlogPost,
    run: () => Promise<unknown>,
    successMsg: string,
    failure: string,
  ) => {
    setBusyId(item.id)
    setError(null)
    try {
      await run()
      setItems((current) => current.filter((entry) => entry.id !== item.id))
      if (tab === 'human') setHumanCount((n) => (n == null ? n : Math.max(0, n - 1)))
      toast(successMsg, 'success')
    } catch (cause) {
      // 作者中途改过（409）或已被处理：先刷新列表（load 会清掉旧错误），再显示原因。
      const message = apiErrorMessage(cause, failure)
      await load(null)
      setError(message)
      toast(message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const desc = stats
    ? `AI 自动审核：${MODE_LABEL[stats.mode]} · 今日自动通过 ${stats.today.autoApproved} / 自动驳回 ${stats.today.autoRejected} / 转人工 ${stats.today.toHuman}`
    : meta.desc

  const visibleTabs = stats ? TABS : TABS.filter((entry) => entry.value !== 'records')
  const empty = tab === 'records' ? records.length === 0 : items.length === 0

  return (
    <div className="flex flex-col gap-5">
      <PageHeader icon={PenLine} title={meta.title} desc={desc} />
      <div
        role="tablist"
        aria-label="经验分享状态"
        className="oc-surface-recessed inline-flex max-w-full items-center gap-1 self-start overflow-x-auto rounded-full p-1"
      >
        {visibleTabs.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={tab === entry.value}
            onClick={() => setTab(entry.value)}
            className={cn(
              'oc-btn-tactile flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-body outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring',
              tab === entry.value
                ? 'oc-segmented-thumb font-semibold text-fg'
                : 'font-medium text-muted hover:text-fg',
            )}
          >
            {entry.label}
            {entry.value === 'human' && humanCount != null && humanCount > 0 && (
              <span className="oc-badge-craft rounded-full bg-warning-soft px-1.5 py-0.5 text-micro font-bold tabular-nums leading-none text-warning">
                {humanCount}
              </span>
            )}
          </button>
        ))}
      </div>
      {error && (
        <Alert
          tone="danger"
          action={
            <Button size="sm" variant="secondary" onClick={() => void load(null)}>
              重试
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {loading && empty ? (
        <div className="oc-surface-card rounded-2xl p-5" data-testid="blog-admin-loading">
          <ListSkeleton rows={3} />
        </div>
      ) : empty ? (
        <div className="oc-surface-card rounded-2xl p-12 text-center">
          <span className="oc-icon-badge oc-icon-badge-success mx-auto size-12 rounded-2xl">
            <Check size={24} />
          </span>
          <p className="mt-3.5 text-sm font-medium text-fg">
            {tab === 'human' ? '没有需要人工复核的投稿' : tab === 'records' ? '还没有 AI 审核记录' : '这里还没有内容'}
          </p>
        </div>
      ) : tab === 'records' ? (
        <div className="grid gap-4">
          {records.map((record) => (
            <RecordRow key={record.id} record={record} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4">
          {items.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              tab={tab}
              busy={busyId === item.id}
              onApprove={() =>
                void act(
                  item,
                  () => adminApi.adminReviewCommunityTutorial(adminSession, item.id, 'approve', undefined, item.reviewToken),
                  item.editId ? '已通过并替换线上版本' : '已通过发布',
                  '通过失败',
                )
              }
              onReject={(note) =>
                void act(
                  item,
                  () => adminApi.adminReviewCommunityTutorial(adminSession, item.id, 'reject', note, item.reviewToken),
                  '已驳回投稿',
                  '驳回失败',
                )
              }
              onTakedown={(note) =>
                void act(
                  item,
                  () => adminApi.adminTakedownCommunityTutorial(adminSession, item.id, note),
                  '已下架文章',
                  '下架失败',
                )
              }
            />
          ))}
        </div>
      )}
      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={loading} onClick={() => void load(nextCursor)}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  )
}
