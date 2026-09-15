import { useCallback, useEffect, useState } from 'react'
import { useProjectScope } from '../../hooks/useProjectScope'
import { apiErrorMessage } from '../../lib/api'
import { formatBytes } from '../../lib/chat/download'
import { isWorkScope } from '../../lib/projectScope'
import { taskboardApi } from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import { Alert, Button, ListSkeleton, PanelHeader } from '../ui'

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
    <div data-testid="agent-project-preview" className="border-t border-border">
      <PanelHeader
        title="智能体会带着这些项目信息开始对话"
        hint="只展示注入了哪些内容和大小，不展示原文。"
      />
      {loading ? (
        <div className="px-4 pb-3">
          <ListSkeleton rows={3} />
        </div>
      ) : err ? (
        <div className="px-4 pb-3">
          <Alert
            tone="danger"
            density="compact"
            action={
              <Button size="sm" variant="secondary" onClick={reload}>
                重试
              </Button>
            }
          >
            {err}
          </Alert>
        </div>
      ) : !enabled ? (
        <p className="px-4 pb-3 text-caption text-muted">该项目关闭了上下文注入。</p>
      ) : slots.length === 0 ? (
        <p className="px-4 pb-3 text-caption text-muted">这个项目还没有会注入的内容。</p>
      ) : (
        <ul className="flex flex-col gap-1 px-4 pb-3 text-caption text-muted">
          {slots.map((s) => (
            <li key={s.name} className="flex flex-wrap items-center gap-x-1.5">
              <span className="text-fg">{slotLabel(s.name)}</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{formatBytes(s.bytes) || '大小未知'}</span>
              {s.redacted ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>已脱敏</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
