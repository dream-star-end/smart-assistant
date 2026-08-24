import { CalendarRange } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthEpochStaleError } from '../../lib/api'
import {
  type Project,
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
  ProjectScopeSelect,
  StatCard,
  TimeAgo,
} from '../ui'
import { CostCoverageBlock } from './CostCoverageBlock'
import { addDaysYmd } from './CostStatsView'

function statusLabel(raw: string): string {
  if ((raw as TicketStatus) in TICKET_STATUS_LABEL) {
    return TICKET_STATUS_LABEL[raw as TicketStatus]
  }
  return raw || '空'
}

export function WeeklyReportView({
  auth,
  projectId,
  projects,
}: {
  auth: AuthSession
  projectId: string | null
  projects: Project[]
}) {
  const [range, setRange] = useState<{ from?: string; to?: string }>({})
  const [filterProject, setFilterProject] = useState(projectId ?? '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [report, setReport] = useState<WeeklyReport | null>(null)

  useEffect(() => {
    setFilterProject(projectId ?? '')
  }, [projectId])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const fresh = await taskboardApi.getWeeklyReport(auth, {
        projectId: projectId || filterProject || undefined,
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
  }, [auth, filterProject, projectId, range.from, range.to])

  useEffect(() => {
    void load()
  }, [load])

  const shiftWeek = (delta: number) => {
    const from = report?.period.fromYmd
    const to = report?.period.toYmd
    if (!from || !to) return
    setRange({ from: addDaysYmd(from, delta * 7), to: addDaysYmd(to, delta * 7) })
  }

  return (
    <div
      data-testid="weekly-report"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4"
    >
      <div>
        <h2 className="text-title font-semibold text-fg">周报</h2>
        <p className="mt-1 text-caption text-muted">
          周一到周日（上海日历）。此处成本是任务看板统计，不与模型用量 usage_records 加总。
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-label="上一周"
          data-testid="weekly-prev"
          onClick={() => shiftWeek(-1)}
        >
          上一周
        </Button>
        <span data-testid="weekly-period" className="text-body font-medium text-fg">
          {report
            ? `${report.period.week}  ${report.period.fromYmd} → ${report.period.toYmd}`
            : '本周'}
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-label="下一周"
          data-testid="weekly-next"
          onClick={() => shiftWeek(1)}
        >
          下一周
        </Button>
        <ProjectScopeSelect className="w-44" />
        <Button type="button" size="sm" variant="ghost" onClick={() => void load()}>
          刷新
        </Button>
      </div>
      {loading && !report ? (
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
            <h3 className="text-section font-semibold text-fg">失败 run</h3>
            {report.failedRuns.length === 0 ? (
              <p className="text-caption text-muted">本周没有失败或超时的执行。</p>
            ) : (
              report.failedRuns.map((run) => (
                <div key={run.runId} className="rounded-lg bg-hover px-3 py-2">
                  <p className="text-body text-fg">
                    {run.identifier}
                    {run.stageName ? ` · ${run.stageName}` : ''} · {run.status}
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
