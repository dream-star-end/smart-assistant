import { CalendarRange, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
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
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4"
      aria-busy={loading || undefined}
    >
      <div>
        <h2 className="text-title font-semibold text-fg">周报</h2>
        <p className="mt-1 text-caption text-muted">
          按周一到周日（上海时间）统计。这里的成本只算任务面板里 agent 执行的用量，不含对话里的模型用量。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* 上一周 / 区间 / 下一周包成一组,窄屏下不再被换行拆散(审计 T-21 ③)。 */}
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border bg-surface p-0.5">
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
          <span data-testid="weekly-period" className="px-1 text-body font-medium tabular-nums text-fg">
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
          variant="ghost"
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
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <StatCard label="新建" value={report.flow.created} />
            <StatCard label="完成" value={report.flow.completed} tone="success" />
            <StatCard label="取消" value={report.flow.canceled} />
            <StatCard label="待确认" value={report.flow.waitingHuman} tone="accent" />
            <StatCard label="受阻" value={report.flow.blockedNow} tone="danger" />
          </div>
          <Card padding="md" className="flex flex-col gap-2">
            <h3 className="text-section font-semibold text-fg">成本</h3>
            <CostCoverageBlock totals={report.cost} testId="weekly-cost" />
          </Card>
          <Card padding="md" className="flex flex-col gap-2">
            <h3 className="text-section font-semibold text-fg">各阶段耗时</h3>
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
            <Card padding="md" className="flex flex-col gap-2">
              <h3 className="text-section font-semibold text-fg">状态流转</h3>
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
          <Card padding="md" className="flex flex-col gap-2" data-testid="weekly-blocked">
            <h3 className="text-section font-semibold text-fg">受阻单</h3>
            {report.blocked.length === 0 ? (
              <p className="text-caption text-muted">当前没有受阻单据。</p>
            ) : (
              report.blocked.map((item) => (
                <div key={item.identifier} className="rounded-lg bg-hover px-3 py-2">
                  <p className="text-body text-fg">
                    {item.identifier} {item.title}
                  </p>
                  {item.blockedReason && (
                    <p className="text-caption text-muted">{item.blockedReason}</p>
                  )}
                </div>
              ))
            )}
          </Card>
          <Card padding="md" className="flex flex-col gap-2" data-testid="weekly-failed-runs">
            <h3 className="text-section font-semibold text-fg">失败的执行</h3>
            {report.failedRuns.length === 0 ? (
              <p className="text-caption text-muted">本周没有失败或超时的执行。</p>
            ) : (
              report.failedRuns.map((run) => (
                <div key={run.runId} className="rounded-lg bg-hover px-3 py-2">
                  <p className="text-body text-fg">
                    {run.identifier}
                    {run.stageName ? ` · ${run.stageName}` : ''} ·{' '}
                    {run.status === 'timeout' ? '超时' : run.status === 'failed' ? '失败' : run.status}
                  </p>
                  {run.error && <p className="text-caption text-danger">{run.error}</p>}
                  <p className="text-caption text-faint">
                    <TimeAgo value={run.createdAt} />
                  </p>
                </div>
              ))
            )}
          </Card>
        </>
      )}
    </div>
  )
}
