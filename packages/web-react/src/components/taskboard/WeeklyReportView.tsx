import {
  AlertOctagon,
  AlertTriangle,
  ArrowRightLeft,
  CalendarRange,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Coins,
  PlusCircle,
  RefreshCw,
  Timer,
  XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useProjectScope } from '../../hooks/useProjectScope'
import { AuthEpochStaleError } from '../../lib/api'
import { UNBOUND_BOARD_COPY, boardWorkQuery } from '../../lib/projectScope'
import {
  TICKET_STATUS_LABEL,
  type TicketStatus,
  type WeeklyReport,
  formatDurationMs,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import {
  Badge,
  Button,
  Card,
  DescriptionList,
  DescriptionRow,
  EmptyState,
  ListSkeleton,
  StatCard,
  TimeAgo,
} from '../ui'
import { CostCoverageBlock } from './CostCoverageBlock'
import { addDaysYmd, ymdInZone } from './CostStatsView'

function statusLabel(raw: string): string {
  if ((raw as TicketStatus) in TICKET_STATUS_LABEL) {
    return TICKET_STATUS_LABEL[raw as TicketStatus]
  }
  return raw || '空'
}

/**
 * 周报。项目范围只认顶栏那一个 ProjectScopeSelect(审计 T-21);原先的 `projectId` / `projects`
 * prop 从未参与请求或渲染,已删(审计 T-20)。
 */
export function WeeklyReportView({ auth }: { auth: AuthSession }) {
  const { scope } = useProjectScope()
  const workQuery = boardWorkQuery(scope)
  const scopedProjectId = 'projectId' in workQuery ? workQuery.projectId : null
  const [range, setRange] = useState<{ from?: string; to?: string }>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<WeeklyReport | null>(null)

  const load = useCallback(async () => {
    if (!scopedProjectId) {
      setLoading(false)
      setError(null)
      setReport(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const fresh = await taskboardApi.getWeeklyReport(auth, {
        projectId: scopedProjectId,
        from: range.from,
        to: range.to,
      })
      setReport(fresh)
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      setReport(null)
      setError(taskboardErrorMessage(e, '加载周报失败'))
    } finally {
      setLoading(false)
    }
  }, [auth, range.from, range.to, scopedProjectId])

  useEffect(() => {
    void load()
  }, [load])

  const shiftWeek = (delta: number) => {
    const from = report?.period.fromYmd
    const to = report?.period.toYmd
    if (!from || !to) return
    setRange({ from: addDaysYmd(from, delta * 7), to: addDaysYmd(to, delta * 7) })
  }

  // 「下一周」在当前周期已经覆盖到今天时禁用:未来一周没有数据可看(审计 T-21 ②)。
  const today = ymdInZone()
  const nextDisabled = !report || report.period.toYmd >= today

  return (
    <div
      data-testid="weekly-report"
      className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pb-5"
      aria-busy={loading || undefined}
    >
      <div className="flex items-start gap-3">
        <span className="oc-icon-badge oc-icon-badge-accent mt-0.5 size-9 rounded-xl" aria-hidden>
          <CalendarRange size={18} />
        </span>
        <div className="min-w-0">
          <h2 className="text-title font-semibold tracking-tight text-fg">周报</h2>
          <p className="mt-0.5 text-caption leading-relaxed text-muted">
            按周一到周日（上海时间）统计。这里的成本只算任务面板里 agent 执行的用量，不含对话里的模型用量。
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* 上一周 / 区间 / 下一周包成一组,窄屏下不再被换行拆散(审计 T-21 ③)。 */}
        <div className="oc-surface-recessed flex shrink-0 items-center gap-1 rounded-xl p-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="上一周"
            data-testid="weekly-prev"
            disabled={!report}
            onClick={() => shiftWeek(-1)}
          >
            <ChevronLeft size={14} />
            <span className="hidden sm:inline">上一周</span>
          </Button>
          <span
            data-testid="weekly-period"
            className="oc-segmented-thumb rounded-lg px-2.5 py-1 text-body font-medium tabular-nums text-fg"
          >
            {report ? `${report.period.week} · ${report.period.fromYmd} → ${report.period.toYmd}` : '本周'}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="下一周"
            data-testid="weekly-next"
            disabled={nextDisabled}
            title={nextDisabled && report ? '已经是最近一周' : undefined}
            onClick={() => shiftWeek(1)}
          >
            <span className="hidden sm:inline">下一周</span>
            <ChevronRight size={14} />
          </Button>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          loading={loading && !!report}
          disabled={!scopedProjectId}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
          刷新
        </Button>
      </div>
      {!scopedProjectId ? (
        <EmptyState
          icon={CalendarRange}
          title={'blocked' in workQuery ? workQuery.blocked : UNBOUND_BOARD_COPY}
          hint="在顶栏切换到已绑定看板的工作项目后再查看周报。"
        />
      ) : loading && !report ? (
        <ListSkeleton rows={6} variant="card" />
      ) : error ? (
        <EmptyState
          icon={CalendarRange}
          title="周报加载失败"
          hint={error}
          action={
            <Button type="button" variant="secondary" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      ) : !report ? (
        <EmptyState icon={CalendarRange} title="没有周报" hint="换一周或换个项目再试。" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            <StatCard label="新建" value={report.flow.created} icon={PlusCircle} />
            <StatCard label="完成" value={report.flow.completed} tone="success" icon={CheckCircle2} />
            <StatCard label="取消" value={report.flow.canceled} icon={XCircle} />
            <StatCard label="待确认" value={report.flow.waitingHuman} tone="accent" icon={Clock} />
            <StatCard label="受阻" value={report.flow.blockedNow} tone="danger" icon={AlertOctagon} />
          </div>
          <Card padding="md" className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <span className="oc-icon-badge oc-icon-badge-info size-7 rounded-lg" aria-hidden>
                <Coins size={14} />
              </span>
              <h3 className="text-section font-semibold tracking-tight text-fg">成本</h3>
            </div>
            <CostCoverageBlock totals={report.cost} testId="weekly-cost" />
          </Card>
          <Card padding="md" className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
              <span className="oc-icon-badge oc-icon-badge-accent size-7 rounded-lg" aria-hidden>
                <Timer size={14} />
              </span>
              <h3 className="text-section font-semibold tracking-tight text-fg">各阶段耗时</h3>
            </div>
            {report.stages.length === 0 ? (
              <p className="text-caption text-muted">本周还没有记上耗时的执行。</p>
            ) : (
              <DescriptionList divided>
                {report.stages.map((s) => (
                  <DescriptionRow
                    key={s.stageId}
                    label={s.stageName}
                    value={`${formatDurationMs(s.totalDurationMs) ?? '0 秒'} · ${s.runCount} 次`}
                    hint={`成功 ${s.succeeded} / 失败 ${s.failed} / 超时 ${s.timeout}，平均 ${formatDurationMs(s.avgDurationMs) ?? '—'}`}
                  />
                ))}
              </DescriptionList>
            )}
          </Card>
          {report.flow.statusTransitions.length > 0 && (
            <Card padding="md" className="flex flex-col gap-2.5">
              <div className="flex items-center gap-2">
                <span className="oc-icon-badge size-7 rounded-lg" aria-hidden>
                  <ArrowRightLeft size={14} />
                </span>
                <h3 className="text-section font-semibold tracking-tight text-fg">状态流转</h3>
              </div>
              <DescriptionList divided>
                {report.flow.statusTransitions.map((row) => (
                  <DescriptionRow
                    key={`${row.from}->${row.to}`}
                    label={`${statusLabel(row.from)} → ${statusLabel(row.to)}`}
                    value={`${row.count} 次`}
                  />
                ))}
              </DescriptionList>
            </Card>
          )}
          <Card padding="md" className="flex flex-col gap-2.5" data-testid="weekly-blocked">
            <div className="flex items-center gap-2">
              <span className="oc-icon-badge oc-icon-badge-warning size-7 rounded-lg" aria-hidden>
                <AlertOctagon size={14} />
              </span>
              <h3 className="text-section font-semibold tracking-tight text-fg">受阻单</h3>
              {report.blocked.length > 0 && (
                <Badge tone="warning" size="sm" className="ml-auto tabular-nums">
                  {report.blocked.length}
                </Badge>
              )}
            </div>
            {report.blocked.length === 0 ? (
              <p className="text-caption text-muted">当前没有受阻单据。</p>
            ) : (
              <div className="flex flex-col gap-2">
                {report.blocked.map((item) => (
                  <div
                    key={item.identifier}
                    className="oc-callout oc-callout-warning flex flex-col gap-1 rounded-xl px-3.5 py-2.5"
                  >
                    <p className="flex flex-wrap items-center gap-1.5 text-body font-medium text-fg">
                      <span className="inline-flex items-center rounded-md bg-hover px-1.5 py-0.5 font-mono text-caption text-muted tabular-nums">
                        {item.identifier}
                      </span>
                      <span>{item.title}</span>
                    </p>
                    {item.blockedReason && (
                      <p className="text-caption text-muted">{item.blockedReason}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card padding="md" className="flex flex-col gap-2.5" data-testid="weekly-failed-runs">
            <div className="flex items-center gap-2">
              <span className="oc-icon-badge oc-icon-badge-danger size-7 rounded-lg" aria-hidden>
                <AlertTriangle size={14} />
              </span>
              <h3 className="text-section font-semibold tracking-tight text-fg">失败的执行</h3>
              {report.failedRuns.length > 0 && (
                <Badge tone="danger" size="sm" className="ml-auto tabular-nums">
                  {report.failedRuns.length}
                </Badge>
              )}
            </div>
            {report.failedRuns.length === 0 ? (
              <p className="text-caption text-muted">本周没有失败或超时的执行。</p>
            ) : (
              <div className="flex flex-col gap-2">
                {report.failedRuns.map((run) => (
                  <div
                    key={run.runId}
                    className="oc-callout oc-callout-danger flex flex-col gap-1 rounded-xl px-3.5 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-1.5 text-body font-medium text-fg">
                      <span className="inline-flex items-center rounded-md bg-hover px-1.5 py-0.5 font-mono text-caption text-muted tabular-nums">
                        {run.identifier}
                      </span>
                      {run.stageName ? <span className="text-body text-fg">· {run.stageName}</span> : null}
                      <Badge tone="danger" size="sm">
                        {run.status === 'timeout' ? '超时' : run.status === 'failed' ? '失败' : run.status}
                      </Badge>
                      <span className="ml-auto text-caption tabular-nums text-faint">
                        <TimeAgo value={run.createdAt} />
                      </span>
                    </div>
                    {run.error && <p className="text-caption break-words text-danger">{run.error}</p>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
