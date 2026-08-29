import { Check, Clock3, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Markdown } from '../../../components/Markdown'
import { Alert, Badge, Button, Textarea } from '../../../components/ui'
import { api, apiErrorMessage } from '../../../lib/api'
import type { CommunityTutorialPending } from '../../../lib/types'
import { PageHeader } from '../../components'
import { adminSession } from '../../auth'
import { getAdminPage } from '../../registry'

const CATEGORY_LABEL = { research: '科研', coding: '编码', general: '通用' } as const

export default function TutorialReviewPage() {
  const meta = getAdminPage('tutorials')
  const [items, setItems] = useState<CommunityTutorialPending[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (cursor: string | null, append: boolean) => {
    setLoading(true)
    setError(null)
    try {
      const page = await api.adminPendingCommunityTutorials(adminSession, cursor)
      setItems((current) => (append ? [...current, ...page.tutorials] : page.tutorials))
      setNextCursor(page.nextCursor)
    } catch (cause) {
      setError(apiErrorMessage(cause, '加载教程审核队列失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(null, false)
  }, [load])

  const review = async (item: CommunityTutorialPending, decision: 'approve' | 'reject') => {
    const note = notes[item.id]?.trim() ?? ''
    if (decision === 'reject' && !note) {
      setError('拒绝教程时必须填写审核意见')
      return
    }
    setBusyId(item.id)
    setError(null)
    try {
      await api.adminReviewCommunityTutorial(adminSession, item.id, decision, note || undefined)
      setItems((current) => current.filter((entry) => entry.id !== item.id))
      setNotes((current) => {
        const next = { ...current }
        delete next[item.id]
        return next
      })
    } catch (cause) {
      setError(apiErrorMessage(cause, '审核失败'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={meta.title} desc={meta.desc} />
      {error && <Alert tone="danger">{error}</Alert>}
      {items.length === 0 && !loading ? (
        <div className="rounded-2xl border border-dashed border-border bg-surface p-12 text-center">
          <Check size={30} className="mx-auto text-success" />
          <p className="mt-3 text-sm font-medium text-fg">教程审核队列已清空</p>
          <p className="mt-1 text-meta text-faint">新的用户投稿会自动出现在这里。</p>
        </div>
      ) : (
        <div className="grid gap-5">
          {items.map((item) => (
            <article
              key={item.id}
              className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
            >
              <div className="border-b border-border p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warning">
                    <Clock3 size={12} /> 待审核
                  </Badge>
                  <Badge tone="neutral">{CATEGORY_LABEL[item.category]}</Badge>
                  <span className="text-caption text-faint">作者：{item.authorName}</span>
                  <span className="text-caption text-faint">
                    {new Date(item.createdAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <h2 className="mt-3 text-title font-semibold text-fg">{item.title}</h2>
                <p className="mt-2 text-body leading-6 text-muted">{item.summary}</p>
              </div>
              <div className="max-h-[32rem] overflow-y-auto p-5">
                <Markdown readOnly blockImages>
                  {item.bodyMarkdown}
                </Markdown>
              </div>
              <div className="border-t border-border bg-sidebar p-5">
                <label
                  className="text-meta font-medium text-muted"
                  htmlFor={`tutorial-note-${item.id}`}
                >
                  审核意见
                </label>
                <Textarea
                  id={`tutorial-note-${item.id}`}
                  rows={3}
                  maxLength={2000}
                  value={notes[item.id] ?? ''}
                  onChange={(event) =>
                    setNotes((current) => ({ ...current, [item.id]: event.target.value }))
                  }
                  placeholder="批准时可选；拒绝时必填，说明需要修改的内容"
                  className="mt-2"
                />
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    variant="danger"
                    loading={busyId === item.id}
                    disabled={busyId !== null || !notes[item.id]?.trim()}
                    onClick={() => void review(item, 'reject')}
                  >
                    <X size={14} /> 拒绝
                  </Button>
                  <Button
                    variant="primary"
                    loading={busyId === item.id}
                    disabled={busyId !== null}
                    onClick={() => void review(item, 'approve')}
                  >
                    <Check size={14} /> 审核通过并上线
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={loading} onClick={() => void load(nextCursor, true)}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  )
}
