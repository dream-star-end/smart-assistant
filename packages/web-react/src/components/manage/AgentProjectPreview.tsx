import { Eye, Layers } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useProjectScope } from '../../hooks/useProjectScope'
import { apiErrorMessage } from '../../lib/api'
import { formatBytes } from '../../lib/chat/download'
import { isWorkScope } from '../../lib/projectScope'
import { taskboardApi } from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import { Alert, Badge, Button, ListSkeleton } from '../ui'

/**
 * 注入槽的用户可读名。后端槽名是实现词（instructions / memories / skills），
 * 这块面板是用户理解「智能体到底看到了我项目的什么」的唯一窗口，不能念代码。未知槽名原样。
 */
const SLOT_LABELS: Record<string, string> = {
  instructions: '项目说明',
  memories: '项目记忆',
  skills: '项目技能',
  assets: '项目资产',
}

export function slotLabel(name: string): string {
  return SLOT_LABELS[name] ?? name
}

/**
 * 工作项目作用域下「智能体会带着哪些项目信息开始对话」的只读预览。
 *
 * 读失败与空态互斥（M-03）：改造前失败只闪一条 toast，随后列表落成「暂无注入槽」——
 * toast 消失后用户看到的是一个自信的"空"。现在失败渲染带重试的 Alert，不渲染空态。
 * 文案不再暴露 API 路径 / 字节数 / 槽名等开发者词汇（M-07）。
 */
export function AgentProjectPreview({ auth, agentId }: { auth: AuthSession; agentId: string }) {
  const { scope } = useProjectScope()
  const workId = scope.workProject?.id
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    void reloadKey
    if (!workId) {
      setPreview(null)
      setErr(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setErr(null)
    void taskboardApi
      .previewProjectContext(auth, workId, { agentId })
      .then((res) => {
        if (!cancelled) setPreview(res)
      })
      .catch((e) => {
        if (!cancelled) setErr(apiErrorMessage(e, '读取项目上下文失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [auth, workId, agentId, reloadKey])

  if (!isWorkScope(scope) || !workId) return null

  const slots = Array.isArray(preview?.slots)
    ? (preview?.slots as Array<{ name: string; bytes: number; redacted?: boolean }>)
    : []
  const enabled = preview?.enabled !== false

  return (
    <div data-testid="agent-project-preview" className="border-t border-border/80">
      {/* 小节标题,不是页面标题:PanelHeader 在手机管理中心里只留给读屏,这里必须一直可见。 */}
      <div className="flex items-start gap-2.5 px-4 pb-3 pt-5">
        <span className="oc-icon-badge oc-icon-badge-accent mt-0.5 size-7 shrink-0 rounded-lg" aria-hidden="true">
          <Eye size={14} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-section font-semibold leading-5 tracking-tight text-fg">
            智能体会带着这些项目信息开始对话
          </h4>
          <p className="mt-0.5 text-meta text-muted">只展示注入了哪些内容和大小，不展示原文。</p>
        </div>
      </div>
      {loading ? (
        <div className="px-4 pb-4">
          <ListSkeleton rows={3} />
        </div>
      ) : err ? (
        <div className="px-4 pb-4">
          <Alert
            tone="danger"
            density="compact"
            className="oc-callout oc-callout-danger rounded-xl"
            action={
              <Button
                size="sm"
                variant="secondary"
                className="oc-btn-tactile oc-btn-secondary-craft"
                onClick={reload}
              >
                重试
              </Button>
            }
          >
            {err}
          </Alert>
        </div>
      ) : !enabled ? (
        <div className="px-4 pb-4">
          <p className="oc-surface-recessed rounded-xl px-3.5 py-2.5 text-caption text-muted">
            该项目关闭了上下文注入。
          </p>
        </div>
      ) : slots.length === 0 ? (
        <div className="px-4 pb-4">
          <p className="oc-surface-recessed rounded-xl px-3.5 py-2.5 text-caption text-muted">
            这个项目还没有会注入的内容。
          </p>
        </div>
      ) : (
        <div className="px-4 pb-4">
          <ul className="oc-list oc-surface-card overflow-hidden rounded-xl bg-surface">
            {slots.map((s) => (
              <li
                key={s.name}
                className="oc-list-row flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-caption text-muted"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="oc-icon-badge size-6 shrink-0 rounded-md" aria-hidden="true">
                    <Layers size={12} strokeWidth={1.75} />
                  </span>
                  <span className="truncate text-body font-medium text-fg">{slotLabel(s.name)}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {s.redacted ? (
                    <Badge tone="info" size="sm" className="oc-badge-craft">
                      已脱敏
                    </Badge>
                  ) : null}
                  <span className="oc-surface-recessed rounded-md px-2 py-0.5 text-caption font-medium tabular-nums text-muted">
                    {formatBytes(s.bytes) || '大小未知'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
