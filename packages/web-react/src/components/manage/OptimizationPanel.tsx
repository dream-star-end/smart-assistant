import {
  AlertTriangle,
  Check,
  ChevronRight,
  Loader2,
  MoonStar,
  Play,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'
import type {
  AuthSession,
  AutoDreamOptimizerProposal,
  AutoDreamOptimizerState,
} from '../../lib/types'
import { relativeTime } from '../../lib/utils'
import { Alert, Badge, Button, Modal, PanelHeader } from '../ui'

const CATEGORY_LABELS: Record<string, string> = {
  memory: '记忆',
  profile: '用户画像',
  skill: '技能',
  rule: '规则',
  agent: 'Agent',
  setting: '功能设置',
  schedule: '定时任务',
  plugin: '插件',
}

export function OptimizationPanel({
  auth,
  agentId,
  agents,
}: {
  auth: AuthSession
  agentId: string
  agents: { id: string; name: string }[]
}) {
  const [selectedAgent, setSelectedAgent] = useState(agentId)
  const effectiveAgent = agents.some((agent) => agent.id === selectedAgent)
    ? selectedAgent
    : agentId
  const [state, setState] = useState<AutoDreamOptimizerState | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AutoDreamOptimizerProposal | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setState(await api.getAutoDreamOptimizer(auth, effectiveAgent))
    } catch (err) {
      setError(apiErrorMessage(err, '无法加载优化报告'))
    } finally {
      setLoading(false)
    }
  }, [auth, effectiveAgent])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (state?.status !== 'running') return
    const timer = window.setInterval(() => {
      void api
        .getAutoDreamOptimizer(auth, effectiveAgent)
        .then(setState)
        .catch((err) => setError(apiErrorMessage(err, '无法刷新审计进度')))
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [auth, effectiveAgent, state?.status])

  const pending = useMemo(
    () =>
      state?.proposals.filter(
        (proposal) => proposal.state === 'pending' || proposal.state === 'conflict',
      ) ?? [],
    [state],
  )
  const history = useMemo(
    () =>
      state?.proposals.filter(
        (proposal) => proposal.state !== 'pending' && proposal.state !== 'conflict',
      ) ?? [],
    [state],
  )

  async function runNow() {
    setRunning(true)
    setError(null)
    try {
      const next = await api.runAutoDreamOptimizer(auth, effectiveAgent)
      setState(next)
    } catch (err) {
      setError(apiErrorMessage(err, '启动全面审计失败'))
    } finally {
      setRunning(false)
    }
  }

  async function cancelRun() {
    setCancelling(true)
    setError(null)
    try {
      setState(await api.cancelAutoDreamOptimizer(auth, effectiveAgent))
    } catch (err) {
      setError(apiErrorMessage(err, '停止全面审计失败'))
    } finally {
      setCancelling(false)
    }
  }

  async function mutate(proposal: AutoDreamOptimizerProposal, action: 'apply' | 'dismiss') {
    setMutating(true)
    setError(null)
    try {
      const next = await api.mutateAutoDreamProposal(auth, effectiveAgent, proposal.id, action)
      setState(next)
      setSelected(null)
    } catch (err) {
      setError(apiErrorMessage(err, action === 'apply' ? '应用建议失败' : '忽略建议失败'))
    } finally {
      setMutating(false)
    }
  }

  return (
    <div className="flex flex-col">
      <PanelHeader
        title="全面优化"
        hint="GPT‑5.6 Terra 结合平台能力与技能，审计会话、操作和日志；所有用户内容修改都先征求确认。"
        action={
          agents.length > 1 ? (
            <select
              aria-label="选择智能体"
              value={effectiveAgent}
              onChange={(event) => setSelectedAgent(event.target.value)}
              className="rounded-lg border border-border bg-surface px-2 py-1 text-[12px] text-fg outline-none focus:border-accent"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />

      <div className="space-y-4 px-5 py-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="rounded-2xl border border-accent/20 bg-gradient-to-br from-accent-soft via-surface to-surface p-4">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white">
              <MoonStar size={19} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[14px] font-semibold text-fg">Auto‑Dream 全面审计</h3>
                <Badge
                  tone={
                    state?.status === 'failed'
                      ? 'danger'
                      : state?.status === 'running'
                        ? 'warning'
                        : 'accent'
                  }
                >
                  {state?.status === 'running'
                    ? state.cancelRequestedAt
                      ? '正在停止'
                      : '审计中'
                    : state?.status === 'failed'
                      ? '上次失败'
                      : state?.status === 'cancelled'
                        ? '已停止'
                        : '每周'}
                </Badge>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted">
                覆盖记忆、设置、技能、规则、Agent、插件与定时任务。平台层问题会以匿名、去内容的结构化发现自动汇总到管理员后台。
              </p>
              {state?.lastSuccessAt && (
                <p className="mt-2 text-[11.5px] text-faint">
                  上次完成于 {relativeTime(state.lastSuccessAt)} · {state.sessionsReviewed} 个会话 ·{' '}
                  {state.pagesReviewed} 个审计分片
                </p>
              )}
            </div>
            {state?.status === 'running' ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={cancelling || !!state.cancelRequestedAt}
                onClick={() => void cancelRun()}
              >
                {cancelling || state.cancelRequestedAt ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <X size={14} />
                )}
                {state.cancelRequestedAt ? '正在停止' : '停止审计'}
              </Button>
            ) : (
              <Button size="sm" variant="primary" disabled={running} onClick={() => void runNow()}>
                {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                立即审计
              </Button>
            )}
          </div>
          {state?.summary && (
            <p className="mt-3 rounded-xl border border-border/70 bg-surface/75 px-3 py-2.5 text-[12.5px] leading-relaxed text-fg">
              {state.summary}
            </p>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-faint">
            <Loader2 size={16} className="animate-spin" /> 加载优化建议…
          </div>
        ) : pending.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-9 text-center">
            <Sparkles size={22} className="mx-auto text-accent" />
            <p className="mt-2 text-[13px] font-medium text-fg">暂无待确认建议</p>
            <p className="mt-1 text-[12px] text-faint">
              完成新会话后会每周自动审计，也可以立即运行。
            </p>
          </div>
        ) : (
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-fg">待你确认</h3>
              <span className="text-[11.5px] text-faint">{pending.length} 项</span>
            </div>
            <div className="space-y-2">
              {pending.map((proposal) => (
                <button
                  key={proposal.id}
                  type="button"
                  onClick={() => setSelected(proposal)}
                  className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3 text-left outline-none transition-colors hover:border-accent/50 hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                    {proposal.state === 'conflict' ? (
                      <AlertTriangle size={15} />
                    ) : (
                      <Sparkles size={15} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-fg">
                        {proposal.title}
                      </span>
                      <Badge tone="neutral">
                        {CATEGORY_LABELS[proposal.category] ?? proposal.category}
                      </Badge>
                    </span>
                    <span className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-muted">
                      {proposal.reason}
                    </span>
                  </span>
                  <ChevronRight size={15} className="shrink-0 text-faint" />
                </button>
              ))}
            </div>
          </section>
        )}

        {history.length > 0 && (
          <details>
            <summary className="cursor-pointer text-[12px] font-medium text-muted">
              查看已处理建议（{history.length}）
            </summary>
            <div className="mt-2 space-y-1.5">
              {history.map((proposal) => (
                <div
                  key={proposal.id}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[12px]"
                >
                  {proposal.state === 'applied' ? (
                    <Check size={13} className="text-success" />
                  ) : (
                    <X size={13} className="text-faint" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-fg">{proposal.title}</span>
                  <span className="text-faint">
                    {proposal.state === 'applied' ? '已应用' : '已忽略'}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {selected && (
        <ProposalDiffModal
          proposal={selected}
          busy={mutating}
          onClose={() => !mutating && setSelected(null)}
          onApply={() => void mutate(selected, 'apply')}
          onDismiss={() => void mutate(selected, 'dismiss')}
        />
      )}
    </div>
  )
}

function ProposalDiffModal({
  proposal,
  busy,
  onClose,
  onApply,
  onDismiss,
}: {
  proposal: AutoDreamOptimizerProposal
  busy: boolean
  onClose: () => void
  onApply: () => void
  onDismiss: () => void
}) {
  const guided = proposal.action === 'plugin.install' || proposal.action === 'manual.review'
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={proposal.title}
      description={`${CATEGORY_LABELS[proposal.category] ?? proposal.category} · ${proposal.targetId}`}
      className="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onDismiss}>
            忽略
          </Button>
          {!guided && (
            <Button variant="primary" disabled={busy} onClick={onApply}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              <Check size={14} /> 确认并应用
            </Button>
          )}
        </>
      }
    >
      <p className="mb-4 text-[13px] leading-relaxed text-muted">{proposal.reason}</p>
      {proposal.error && (
        <Alert tone="warning" className="mb-3">
          {proposal.error}
        </Alert>
      )}
      {guided ? (
        <Alert tone="info">
          这项建议需要进入对应功能完成，Auto‑Dream 不会代替你自动安装或执行。
        </Alert>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <DiffPane title="调整前" content={proposal.before || '（无）'} tone="before" />
          <DiffPane title="调整后" content={proposal.after || '（删除）'} tone="after" />
        </div>
      )}
    </Modal>
  )
}

function DiffPane({
  title,
  content,
  tone,
}: {
  title: string
  content: string
  tone: 'before' | 'after'
}) {
  return (
    <div
      className={`min-w-0 overflow-hidden rounded-xl border ${tone === 'after' ? 'border-success/25' : 'border-danger/20'}`}
    >
      <div
        className={`border-b px-3 py-2 text-[11.5px] font-semibold ${tone === 'after' ? 'border-success/20 bg-success-soft text-success' : 'border-danger/15 bg-danger-soft text-danger'}`}
      >
        {title}
      </div>
      <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-words bg-surface p-3 font-mono text-[11.5px] leading-relaxed text-fg">
        {content}
      </pre>
    </div>
  )
}
