import { AlertTriangle, Check, ChevronRight, MoonStar, Play, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, apiErrorMessage } from '../../lib/api'
import type {
  AuthSession,
  AutoDreamOptimizerProposal,
  AutoDreamOptimizerState,
} from '../../lib/types'
import { cn } from '../../lib/utils'
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ListSkeleton,
  Modal,
  Progress,
  Select,
  Skeleton,
  TimeAgo,
  cardVariants,
  useToast,
} from '../ui'

/**
 * Auto‑Dream 全面优化面板：扫描历史会话 → 产出跨域改进提案 → 用户逐条采纳/拒绝。
 *
 * ── 为什么这里没有 PanelHeader ───────────────────────────────────────────
 * 改造前从上到下有四层几乎同义的标题：Dialog「管理中心」→ Tab「全面优化」→
 * PanelHeader「全面优化」→ 卡片「Auto‑Dream 全面审计」，合计吃掉近 290px，
 * 375×667 手机上留给待确认列表的只剩三行。Tab 已经命名了本分区，PanelHeader 是
 * 逐字重复，故删除；下面这张 hero 卡就是本面板的头部 —— 标题同样是 text-title(15px)、
 * 同样位于面板首位，与其余分区的 PanelHeader 处在同一层级，只是多带状态与主操作。
 * 说明文案也合并成一句（改造前 PanelHeader hint 与卡片正文讲的是同一件事，且 hint
 * 里裸露了内部模型名）。
 *
 * ── 错误必须报在发起它的容器里 ─────────────────────────────────────────
 * 改造前所有失败都走同一个 `error` 并渲染在面板正文顶部：应用建议失败时红条被自己的
 * Modal 遮罩盖住，用户只看到"点了没反应"然后重复提交。现在按发起点分成三路：
 *  - loadError   整表读取失败 → 顶部/空态位（唯一保留在顶层的错误）
 *  - actionError 立即审计 / 停止审计失败 → hero 卡内，紧贴按钮
 *  - modalError  应用 / 忽略失败 → 弹窗内，带重试
 * 轮询失败单独计数：<3 次只在进度行降级提示，≥3 次才升级；任一次成功立即清零
 * （改造前一次网络抖动会让红条永久挂着，与正常前进的进度条自相矛盾）。
 */

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

/**
 * 引导类建议（plugin.install / manual.review）的去处。Auto‑Dream 不代替用户安装或执行，
 * 但也不能只说"请去对应功能完成"就把人扔在原地 —— 至少要指名道姓地告诉他去哪。
 * （真正的跳转按钮需要外壳把 onOpenMarketplace / onTabChange 传下来，属另一批的改动。）
 */
const CATEGORY_DESTINATION: Record<string, string> = {
  memory: '管理中心 →「记忆」',
  profile: '管理中心 →「记忆」的用户画像',
  skill: '管理中心 →「技能」',
  rule: '管理中心 →「记忆」',
  agent: '市场 →「智能体」',
  setting: '设置中心 →「偏好」',
  schedule: '管理中心 →「定时任务」',
  plugin: '市场 →「插件」',
}

/**
 * 审计中断原因 → 用户语。后端 error 是给排障看的英文/错误码串，直接摊给付费用户
 * 既读不懂也无从判断"再点一次有没有意义"。未命中一律回落到通用引导，不裸露原始串。
 */
const AUDIT_ERROR_HINTS: { match: RegExp; text: string }[] = [
  {
    match: /timeout|timed?.?out|deadline|etimedout/i,
    text: '模型响应超时了，重新发起一次通常就能跑完。',
  },
  {
    match: /insufficient|balance|credit|quota|payment|402/i,
    text: '积分不足，充值后可以重新发起。',
  },
  { match: /rate.?limit|too.?many|429/i, text: '触发了模型限流，过几分钟再试。' },
  {
    match: /no.?(sessions?|evidence|data)|empty/i,
    text: '这段时间还没有足够的会话可供审计，多聊几次再来。',
  },
  {
    match: /unavailable|upstream|bad.?gateway|50[023]/i,
    text: '审计服务当时不可用，稍后重试即可。',
  },
  { match: /cancel|abort/i, text: '上一次运行被中断了。' },
]

function friendlyAuditError(raw?: string): string {
  if (!raw?.trim()) return '原因未知，重新发起一次通常就能跑完。'
  return (
    AUDIT_ERROR_HINTS.find((h) => h.match.test(raw))?.text ??
    '重新发起一次通常就能跑完；仍然失败可以把这条反馈给我们。'
  )
}

/** Toast 里回显建议标题：过长会把提示条撑成一整屏。 */
function clip(text: string, max = 18): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

type AutoDreamOptimizerProgress = {
  stage: 'loading' | 'mapping' | 'reducing' | 'synthesizing' | 'finalizing'
  sessionsTotal: number
  evidencePagesTotal: number
  evidencePagesReviewed: number
  mapBatchesTotal: number
  mapBatchesCompleted: number
  reducePagesTotal: number
  reducePagesCompleted: number
  synthesisPagesCompleted: number
}

type AutoDreamOptimizerLiveState = AutoDreamOptimizerState & {
  progress?: AutoDreamOptimizerProgress
}

/**
 * 五个阶段在整条进度上的权重区间。改造前进度条只画 evidencePagesReviewed/Total：
 * 一进入 reducing 阶段证据页就已经读完，条子顶在 100% 却还要跑三个阶段 —— 用户读到的
 * 是"卡在满格"。这里把五个阶段铺满 0–100，mapping（模型批次，最耗时）占最大一段，
 * 保证进度单调前进且始终有"还剩多少"的意义。
 */
const STAGE_STEPS = [
  { key: 'loading', label: '整理证据', from: 0, to: 8 },
  { key: 'mapping', label: '分析证据', from: 8, to: 70 },
  { key: 'reducing', label: '跨页归并', from: 70, to: 85 },
  { key: 'synthesizing', label: '生成建议', from: 85, to: 95 },
  { key: 'finalizing', label: '核对设置', from: 95, to: 100 },
] as const

const clamp01 = (done: number, total: number) =>
  total > 0 ? Math.min(1, Math.max(0, done / total)) : 0

export function OptimizationPanel({
  auth,
  agentId,
  agents,
}: {
  auth: AuthSession
  agentId: string
  agents: { id: string; name: string }[]
}) {
  const toast = useToast()
  const [selectedAgent, setSelectedAgent] = useState(agentId)
  const effectiveAgent = agents.some((agent) => agent.id === selectedAgent)
    ? selectedAgent
    : agentId
  const [state, setState] = useState<AutoDreamOptimizerLiveState | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  /** 哪个动作正在提交（apply/dismiss），用于让对应按钮单独进忙态。 */
  const [busyAction, setBusyAction] = useState<'apply' | 'dismiss' | null>(null)
  /** 整表读取失败：唯一允许渲染在面板顶层的错误。 */
  const [loadError, setLoadError] = useState<string | null>(null)
  /** 立即审计 / 停止审计失败：渲染在 hero 卡内（发起它的容器）。 */
  const [actionError, setActionError] = useState<{
    message: string
    retry: 'run' | 'cancel'
  } | null>(null)
  /** 应用 / 忽略失败：渲染在弹窗内（发起它的容器）。 */
  const [modalError, setModalError] = useState<string | null>(null)
  const [failedAction, setFailedAction] = useState<'apply' | 'dismiss' | null>(null)
  /** 轮询连续失败次数：<3 只在进度行降级提示，≥3 才升级为顶部 Alert。 */
  const [pollFailures, setPollFailures] = useState(0)
  const [selected, setSelected] = useState<AutoDreamOptimizerProposal | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setState(await api.getAutoDreamOptimizer(auth, effectiveAgent))
      setPollFailures(0)
    } catch (err) {
      setLoadError(apiErrorMessage(err, '无法加载优化报告'))
    } finally {
      setLoading(false)
    }
  }, [auth, effectiveAgent])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    // 换 agent / 审计结束时把上一轮的轮询失败计数清干净，否则红条会跨轮次残留。
    setPollFailures(0)
    if (state?.status !== 'running') return
    const timer = window.setInterval(() => {
      void api
        .getAutoDreamOptimizer(auth, effectiveAgent)
        .then((next) => {
          setState(next)
          // 成功即清零：改造前只 setState 不清错，一次抖动的红条会挂到用户下次手动操作。
          setPollFailures(0)
        })
        .catch(() => setPollFailures((n) => n + 1))
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

  const isRunning = state?.status === 'running'
  const stopping = isRunning && !!state?.cancelRequestedAt

  async function runNow() {
    setRunning(true)
    setActionError(null)
    try {
      setState(await api.runAutoDreamOptimizer(auth, effectiveAgent))
      setPollFailures(0)
    } catch (err) {
      setActionError({ message: apiErrorMessage(err, '启动全面审计失败'), retry: 'run' })
    } finally {
      setRunning(false)
    }
  }

  async function cancelRun() {
    setCancelling(true)
    setActionError(null)
    try {
      setState(await api.cancelAutoDreamOptimizer(auth, effectiveAgent))
      setPollFailures(0)
    } catch (err) {
      setActionError({ message: apiErrorMessage(err, '停止全面审计失败'), retry: 'cancel' })
    } finally {
      setCancelling(false)
    }
  }

  async function mutate(proposal: AutoDreamOptimizerProposal, action: 'apply' | 'dismiss') {
    setBusyAction(action)
    setModalError(null)
    setFailedAction(null)
    try {
      const next = await api.mutateAutoDreamProposal(auth, effectiveAgent, proposal.id, action)
      setState(next)
      setSelected(null)
      // 成功后弹窗关闭、条目从列表消失 —— 用户离开了发起动作的上下文，反馈只能走 toast。
      toast(
        action === 'apply'
          ? `已应用「${clip(proposal.title)}」`
          : `已忽略「${clip(proposal.title)}」`,
        'success',
      )
    } catch (err) {
      setModalError(apiErrorMessage(err, action === 'apply' ? '应用建议失败' : '忽略建议失败'))
      setFailedAction(action)
    } finally {
      setBusyAction(null)
    }
  }

  const closeModal = () => {
    if (busyAction) return
    setSelected(null)
    setModalError(null)
    setFailedAction(null)
  }

  return (
    <div className="flex min-h-full flex-col gap-3 px-4 py-4">
      <Card
        tone="accent"
        padding="md"
        className="rounded-2xl border-accent/20 bg-gradient-to-br from-accent-soft via-surface to-surface"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white">
            <MoonStar size={19} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-title font-semibold text-fg">Auto‑Dream 全面审计</h3>
              <StatusBadge state={state} />
              {/* 窄屏放不下时整组换行(而不是 shrink-0 撑出横向滚动);切换器再压一档宽度。 */}
              <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
                {agents.length > 1 && (
                  <Select
                    aria-label="选择智能体"
                    className="w-auto max-w-32 sm:max-w-40"
                    inputSize="sm"
                    value={effectiveAgent}
                    onValueChange={setSelectedAgent}
                    options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
                  />
                )}
                {isRunning ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={cancelling || stopping}
                    onClick={() => void cancelRun()}
                  >
                    {!(cancelling || stopping) && <X size={14} />}
                    {stopping ? '正在停止' : '停止审计'}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="primary"
                    loading={running}
                    onClick={() => void runNow()}
                  >
                    {!running && <Play size={14} />}
                    立即审计
                  </Button>
                )}
              </div>
            </div>
            <p className="mt-1.5 text-meta leading-relaxed text-muted">
              每周自动审计你的记忆、设置、技能、规则、智能体、插件与定时任务，任何改动都会先问过你；平台层问题只以匿名、去内容的统计汇总给管理员。
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-caption text-faint">
              <span>每周自动</span>
              {state?.lastSuccessAt && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1">
                    上次完成于 <TimeAgo value={state.lastSuccessAt} />
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{state.sessionsReviewed} 个会话</span>
                  <span aria-hidden="true">·</span>
                  <span>{state.pagesReviewed} 个审计分片</span>
                </>
              )}
            </p>
            {isRunning && state?.progress && (
              <AuditProgress
                progress={state.progress}
                stopping={!!state.cancelRequestedAt}
                refreshHiccup={pollFailures > 0 && pollFailures < 3}
              />
            )}
          </div>
        </div>

        {state?.summary && (
          <Card tone="sunken" padding="sm" className="mt-3">
            <p className="text-body leading-relaxed text-fg">{state.summary}</p>
          </Card>
        )}

        {state?.status === 'failed' && (
          <Alert
            tone="warning"
            density="compact"
            className="mt-3"
            action={
              <Button size="sm" variant="secondary" loading={running} onClick={() => void runNow()}>
                重新审计
              </Button>
            }
          >
            上次审计中断：{friendlyAuditError(state.error)}
          </Alert>
        )}

        {state?.status === 'cancelled' && (
          <Alert tone="info" density="compact" className="mt-3">
            已按你的要求停止，已完成的进度会保留到下次审计。
          </Alert>
        )}

        {/* 立即审计 / 停止审计的失败贴在按钮所在的容器里，不再飞到面板顶部。 */}
        {actionError && (
          <Alert
            tone="danger"
            density="compact"
            className="mt-3"
            onDismiss={() => setActionError(null)}
            action={
              <Button
                size="sm"
                variant="secondary"
                loading={actionError.retry === 'run' ? running : cancelling}
                onClick={() => void (actionError.retry === 'run' ? runNow() : cancelRun())}
              >
                重试
              </Button>
            }
          >
            {actionError.message}
          </Alert>
        )}
      </Card>

      {/* 轮询连续失败 ≥3 次才升级为面板级提示；danger 留给真正需要用户动作的失败。 */}
      {isRunning && pollFailures >= 3 && (
        <Alert
          tone="warning"
          density="compact"
          action={
            <Button size="sm" variant="secondary" loading={loading} onClick={() => void load()}>
              刷新
            </Button>
          }
        >
          进度已连续 {pollFailures} 次刷新失败，审计仍在后台继续，可手动刷新查看最新状态。
        </Alert>
      )}

      {/* 已有数据时的整表刷新失败：保留数据 + 顶部可重试提示（不与空态并存）。 */}
      {state && loadError && (
        <Alert
          tone="danger"
          density="compact"
          onDismiss={() => setLoadError(null)}
          action={
            <Button size="sm" variant="secondary" loading={loading} onClick={() => void load()}>
              重试
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}

      {loading && !state ? (
        <ListSkeleton rows={3} />
      ) : loadError && !state ? (
        // 错误态与空态互斥：改造前两者会同时出现（红条 + ✨「暂无待确认建议」），
        // 后者更像权威结论，用户会以为系统真的没建议给他。
        <div className="my-auto">
          <EmptyState
            icon={AlertTriangle}
            title="暂时读不到优化报告"
            hint={loadError}
            action={
              <Button variant="secondary" loading={loading} onClick={() => void load()}>
                重试
              </Button>
            }
          />
        </div>
      ) : pending.length === 0 ? (
        <div className="my-auto">
          {isRunning ? (
            <EmptyState
              icon={Sparkles}
              title="正在审计，建议稍后出现"
              hint="审计完成后，需要你确认的改动会逐条列在这里，应用前都会给你看 Diff。"
              action={
                <Button
                  variant="secondary"
                  loading={cancelling || stopping}
                  onClick={() => void cancelRun()}
                >
                  停止审计
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Sparkles}
              title="暂无待确认建议"
              hint="完成新会话后每周会自动审计，也可以现在就运行一次。"
              action={
                <Button variant="primary" loading={running} onClick={() => void runNow()}>
                  {!running && <Play size={14} />}
                  立即审计
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <section>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="text-section font-semibold text-fg">待你确认</h4>
            <span className="text-caption tabular-nums text-faint">{pending.length} 项</span>
          </div>
          <div className="flex flex-col gap-2">
            {pending.map((proposal) => (
              <button
                key={proposal.id}
                type="button"
                onClick={() => setSelected(proposal)}
                className={cn(
                  cardVariants({ padding: 'sm', interactive: true }),
                  'flex w-full items-center gap-3 text-left hover:border-accent/50',
                )}
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
                    <span className="truncate text-section font-medium text-fg">
                      {proposal.title}
                    </span>
                    <Badge tone={proposal.state === 'conflict' ? 'warning' : 'neutral'} size="sm">
                      {proposal.state === 'conflict'
                        ? '有冲突'
                        : (CATEGORY_LABELS[proposal.category] ?? proposal.category)}
                    </Badge>
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-caption leading-relaxed text-muted">
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
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg py-2 text-meta font-medium text-muted outline-none transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={14}
              aria-hidden="true"
              className="shrink-0 transition-transform group-open:rotate-90"
            />
            查看已处理建议（{history.length}）
          </summary>
          <div className="mt-2 flex flex-col gap-1.5">
            {history.map((proposal) => (
              <button
                key={proposal.id}
                type="button"
                onClick={() => setSelected(proposal)}
                className={cn(
                  cardVariants({ padding: 'sm', interactive: true }),
                  'flex w-full items-center gap-2 text-left',
                )}
              >
                {proposal.state === 'applied' ? (
                  <Check size={14} className="shrink-0 text-success" />
                ) : (
                  <X size={14} className="shrink-0 text-faint" />
                )}
                <span className="min-w-0 flex-1 truncate text-body text-fg">{proposal.title}</span>
                <span className="shrink-0 text-caption text-faint">
                  {proposal.state === 'applied' ? '已应用' : '已忽略'}
                </span>
                <TimeAgo
                  value={proposal.appliedAt ?? proposal.createdAt}
                  className="shrink-0 text-caption text-faint"
                />
              </button>
            ))}
          </div>
        </details>
      )}

      {selected && (
        <ProposalDiffModal
          proposal={selected}
          busyAction={busyAction}
          error={modalError}
          onRetry={failedAction ? () => void mutate(selected, failedAction) : undefined}
          onClose={closeModal}
          onApply={() => void mutate(selected, 'apply')}
          onDismiss={() => void mutate(selected, 'dismiss')}
        />
      )}
    </div>
  )
}

/**
 * 状态徽章只表状态。改造前它同时承载状态与频率（非运行中一律显示「每周」），
 * 于是"上次跑成功了"根本看不出来；state 还没到时也会先渲染出「每周」再跳变成「审计中」。
 * 频率已并入 hero 的 meta 行，未加载时给骨架而不是一个会自我推翻的结论。
 */
function StatusBadge({ state }: { state: AutoDreamOptimizerLiveState | null }) {
  if (!state) return <Skeleton className="h-5 w-14 rounded-full" />
  switch (state.status) {
    case 'running':
      return <Badge tone="warning">{state.cancelRequestedAt ? '正在停止' : '审计中'}</Badge>
    case 'failed':
      return <Badge tone="danger">上次失败</Badge>
    case 'cancelled':
      return <Badge tone="neutral">已停止</Badge>
    case 'success':
      return <Badge tone="success">已完成</Badge>
    default:
      return <Badge tone="neutral">尚未运行</Badge>
  }
}

function AuditProgress({
  progress,
  stopping,
  refreshHiccup,
}: {
  progress: AutoDreamOptimizerProgress
  stopping: boolean
  /** 轮询短暂失败（<3 次）：就地降级提示，不升级成红条。 */
  refreshHiccup: boolean
}) {
  const detail = {
    loading: '正在整理会话、操作、日志和平台能力',
    mapping: `正在分析证据 ${progress.evidencePagesReviewed}/${progress.evidencePagesTotal}（模型批次 ${progress.mapBatchesCompleted}/${progress.mapBatchesTotal}）`,
    reducing: `正在跨页归并 ${progress.reducePagesCompleted}/${progress.reducePagesTotal}`,
    synthesizing: `正在生成完整建议（已综合 ${progress.synthesisPagesCompleted} 页）`,
    finalizing: '正在核对当前设置并生成确认项',
  }[progress.stage]

  const index = Math.max(
    0,
    STAGE_STEPS.findIndex((s) => s.key === progress.stage),
  )
  const step = STAGE_STEPS[index]
  const fraction =
    progress.stage === 'mapping'
      ? progress.evidencePagesTotal > 0
        ? clamp01(progress.evidencePagesReviewed, progress.evidencePagesTotal)
        : clamp01(progress.mapBatchesCompleted, progress.mapBatchesTotal)
      : progress.stage === 'reducing'
        ? clamp01(progress.reducePagesCompleted, progress.reducePagesTotal)
        : 0
  const percent = Math.round(step.from + (step.to - step.from) * fraction)
  const stageText = `第 ${index + 1}/${STAGE_STEPS.length} 步 · ${step.label}`

  return (
    <div className="mt-3" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-caption text-muted">
        <span className="min-w-0">{stopping ? '正在等待当前批次安全结束' : detail}</span>
        {progress.sessionsTotal > 0 && (
          <span className="shrink-0 tabular-nums">{progress.sessionsTotal} 个会话</span>
        )}
      </div>
      <Progress
        className="mt-1.5"
        size="sm"
        value={percent}
        aria-label="全面审计进度"
        // 读屏播报具体在做什么，而不是一个孤立的百分数。
        aria-valuetext={`${stageText} · ${stopping ? '正在等待当前批次安全结束' : detail}`}
      />
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-caption">
        <span className="text-faint">{stageText}</span>
        {refreshHiccup && <span className="text-warning">进度刷新中断，正在重试</span>}
      </div>
    </div>
  )
}

function ProposalDiffModal({
  proposal,
  busyAction,
  error,
  onRetry,
  onClose,
  onApply,
  onDismiss,
}: {
  proposal: AutoDreamOptimizerProposal
  busyAction: 'apply' | 'dismiss' | null
  error: string | null
  onRetry?: () => void
  onClose: () => void
  onApply: () => void
  onDismiss: () => void
}) {
  const busy = busyAction !== null
  const guided = proposal.action === 'plugin.install' || proposal.action === 'manual.review'
  // 已处理的建议以只读态复用同一个弹层（历史行点开就是"当时改了什么"）。
  const readOnly = proposal.state !== 'pending' && proposal.state !== 'conflict'
  const destination = CATEGORY_DESTINATION[proposal.category]

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={proposal.title}
      description={`${CATEGORY_LABELS[proposal.category] ?? proposal.category} · ${proposal.targetId}`}
      size="lg"
      // 子模态起步与父壳同宽，桌面端再放大；改造前 max-w-4xl 比父壳 max-w-2xl 还宽，
      // 弹出时会"胀出"底层弹窗边界，层级关系看着是反的。
      className="md:max-w-4xl"
      // 忙态下关闭键仍可点却被 onOpenChange 拦掉 —— 又一处"点了没反应"。
      hideClose={busy}
      footer={
        readOnly ? (
          <Button variant="secondary" onClick={onClose}>
            关闭
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={busy}
              loading={busyAction === 'dismiss'}
              onClick={onDismiss}
            >
              忽略
            </Button>
            {guided ? (
              <Button variant="primary" disabled={busy} onClick={onClose}>
                知道了
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={busy}
                loading={busyAction === 'apply'}
                onClick={onApply}
              >
                {busyAction !== 'apply' && <Check size={14} />}
                确认并应用
              </Button>
            )}
          </>
        )
      }
    >
      {/* 失败必须报在发起它的容器里：弹窗内报错 + 就地重试，而不是红条藏在遮罩底下。 */}
      {error && (
        <Alert
          tone="danger"
          density="compact"
          className="mb-3"
          action={
            onRetry && (
              <Button size="sm" variant="secondary" loading={busy} onClick={onRetry}>
                重试
              </Button>
            )
          }
        >
          {error}
        </Alert>
      )}
      <p className="mb-4 text-body leading-relaxed text-muted">{proposal.reason}</p>
      {proposal.error && (
        <Alert tone="warning" density="compact" className="mb-3">
          {proposal.error}
        </Alert>
      )}
      {guided ? (
        <Alert tone="info" density="compact">
          这项建议需要你自己去完成，Auto‑Dream 不会代替你安装或执行。
          {destination ? `请前往 ${destination} 处理，处理完这条建议可以直接忽略。` : ''}
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
    <Card
      padding="none"
      className={cn(
        'min-w-0 overflow-hidden shadow-none',
        tone === 'after' ? 'border-success/25' : 'border-danger/20',
      )}
    >
      <div
        className={cn(
          'border-b px-3 py-2 text-caption font-semibold',
          tone === 'after'
            ? 'border-success/20 bg-success-soft text-success'
            : 'border-danger/15 bg-danger-soft text-danger',
        )}
      >
        {title}
      </div>
      {/* 窄屏两个 pane 会堆成上下两屏：各自压到 28vh，用户不必滚一屏才够到 footer。 */}
      <pre className="max-h-[28vh] overflow-auto whitespace-pre-wrap break-words bg-surface p-3 font-mono text-caption leading-relaxed text-fg md:max-h-[45vh]">
        {content}
      </pre>
    </Card>
  )
}
