import { Check, Eye, EyeOff, Image as ImageIcon, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BlogProse, type BlogImageSource } from '../../../components/tutorials/blog/BlogArticle'
import { blogCategoryLabel } from '../../../components/tutorials/blog/blogLib'
import { Alert, Button, Textarea } from '../../../components/ui'
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
      <h4 className="m-0 text-[12.5px] font-semibold text-faint">AI 判定（置信度）</h4>
      {DIMENSIONS.map((dim) => {
        const yes = moderation.categories[dim.key]?.yes
        const pct = yes == null ? null : Math.round(yes * 100)
        const color = yes == null ? 'var(--faint)' : meterColor(yes)
        return (
          <div key={dim.key} className="grid grid-cols-[62px_1fr_42px] items-center gap-2 text-[12.5px]">
            <span className="text-fg">{dim.label}</span>
            <span className="blog-meter">
              <i style={{ width: `${pct ?? 0}%`, background: color }} />
            </span>
            <span className="text-right font-semibold" style={{ color }}>
              {pct == null ? '—' : `${pct}%`}
            </span>
          </div>
        )
      })}
      {moderation.adminNote && (
        <div className="rounded-[10px] bg-warning-soft p-2.5 text-[12.5px] leading-[1.6] text-muted">
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
        'grid gap-5 rounded-[20px] border border-border bg-surface p-[18px]',
        item.moderation && 'lg:grid-cols-[1fr_300px]',
      )}
    >
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="blog-chip blog-chip-accent">{blogCategoryLabel(item.category)}</span>
          {(item.imageCount ?? 0) > 0 && (
            <span className="blog-chip">
              <ImageIcon size={12} aria-hidden /> {item.imageCount} 张图
            </span>
          )}
          <span className="blog-chip">
            #{item.id} · {item.authorName} · {stamp(item.createdAt)}
          </span>
          {item.reviewSource && (
            <span className="blog-chip">{item.reviewSource === 'ai' ? 'AI 处理' : '人工处理'}</span>
          )}
        </div>
        <h3 className="m-0 mb-1.5 text-[16px] font-bold text-fg">{item.title}</h3>
        <div className="my-2.5 rounded-xl border border-border bg-bg p-3 text-[13px] leading-[1.65] text-muted">
          {excerpt.slice(0, 120)}
          {excerpt.length > 120 ? '……' : ''}
          <br />（正文 {(item.bodyChars ?? [...item.bodyMarkdown].length).toLocaleString('zh-CN')} 字）
        </div>
        {item.reviewNote && tab !== 'human' && (
          <p className="mb-2 text-[12.5px] text-muted">
            {tab === 'approved' ? '审核备注' : '驳回理由'}：{item.reviewNote}
          </p>
        )}
        <Button variant="secondary" size="sm" shape="pill" onClick={() => setPreview((v) => !v)}>
          {preview ? <EyeOff size={14} /> : <Eye size={14} />} {preview ? '收起全文' : '预览全文'}
        </Button>
        {preview && (
          <div className="mt-3 max-h-[36rem] overflow-y-auto rounded-xl border border-border p-4">
            <BlogProse markdown={item.bodyMarkdown} source={source} />
          </div>
        )}
        {!item.moderation && tab !== 'records' && (
          <Actions
            tab={tab}
            busy={busy}
            actionLabel={actionLabel}
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
        <div className="flex flex-col gap-2.5 border-border lg:border-l lg:pl-5">
          <Verdict moderation={item.moderation} />
          <Actions
            tab={tab}
            busy={busy}
            actionLabel={actionLabel}
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
            <Check size={14} /> 通过发布
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
    <article className="grid gap-4 rounded-[20px] border border-border bg-surface p-[18px] lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              'blog-chip',
              record.verdict === 'pass' ? 'blog-chip-ok' : record.verdict === 'reject' ? 'blog-chip-bad' : 'blog-chip-warn',
            )}
          >
            {VERDICT_LABEL[record.verdict]}
          </span>
          <span className="blog-chip">{record.mode === 'shadow' ? '影子模式' : record.applied ? '已生效' : '未生效'}</span>
          <span className="blog-chip">
            #{record.publicationId} · {record.authorName} · {stamp(record.createdAt)}
          </span>
        </div>
        <h3 className="m-0 text-[15px] font-semibold text-fg">{record.title}</h3>
        {record.reason && <p className="mt-2 text-[12.5px] text-muted">给作者的理由：{record.reason}</p>}
      </div>
      <Verdict moderation={record} />
    </article>
  )
}

export default function BlogAdminPage() {
  const meta = getAdminPage('blog')
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

  const act = async (item: AdminBlogPost, run: () => Promise<unknown>, failure: string) => {
    setBusyId(item.id)
    setError(null)
    try {
      await run()
      setItems((current) => current.filter((entry) => entry.id !== item.id))
      if (tab === 'human') setHumanCount((n) => (n == null ? n : Math.max(0, n - 1)))
    } catch (cause) {
      setError(apiErrorMessage(cause, failure))
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
    <div className="flex flex-col gap-4">
      <PageHeader title={meta.title} desc={desc} />
      <div role="tablist" aria-label="经验分享状态" className="flex gap-1 overflow-x-auto border-b border-border">
        {visibleTabs.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={tab === entry.value}
            onClick={() => setTab(entry.value)}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-[13.5px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === entry.value ? 'border-accent font-semibold text-fg' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {entry.label}
            {entry.value === 'human' && humanCount != null && humanCount > 0 && (
              <span className="rounded-full bg-warning-soft px-1.5 text-[11px] font-bold text-warning">{humanCount}</span>
            )}
          </button>
        ))}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {empty && !loading ? (
        <div className="rounded-2xl border border-dashed border-border bg-surface p-12 text-center">
          <Check size={30} className="mx-auto text-success" />
          <p className="mt-3 text-sm font-medium text-fg">
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
                void act(item, () => adminApi.adminReviewCommunityTutorial(adminSession, item.id, 'approve'), '通过失败')
              }
              onReject={(note) =>
                void act(item, () => adminApi.adminReviewCommunityTutorial(adminSession, item.id, 'reject', note), '驳回失败')
              }
              onTakedown={(note) =>
                void act(item, () => adminApi.adminTakedownCommunityTutorial(adminSession, item.id, note), '下架失败')
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
