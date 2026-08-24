import { Coins } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AuthEpochStaleError } from '../../lib/api'
import {
  COST_GROUP_BY,
  COST_GROUP_BY_LABEL,
  type CostGroupBy,
  type CostStatsResult,
  type Project,
  formatCostMoneyLine,
  formatCount,
  formatTokenUsage,
  taskboardApi,
  taskboardErrorMessage,
} from '../../lib/taskboard'
import type { AuthSession } from '../../lib/types'
import { Button, Card, EmptyState, Field, Input, ListSkeleton, ProjectScopeSelect, Select, StatCard } from '../ui'
import { CostCoverageBlock } from './CostCoverageBlock'

const TZ = 'Asia/Shanghai'

export function ymdInZone(at = new Date(), timeZone = TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

export function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const utc = Date.UTC(y, m - 1, d) + delta * 86_400_000
  const dt = new Date(utc)
  const yy = dt.getUTCFullYear()
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(dt.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

export function CostStatsView({
  auth,
  projectId,
  projects,
}: {
  auth: AuthSession
  projectId: string | null
  projects: Project[]
}) {
  const today = ymdInZone()
  const [from, setFrom] = useState(() => addDaysYmd(today, -6))
  const [to, setTo] = useState(today)
  const [groupBy, setGroupBy] = useState<CostGroupBy>('day')
  const [filterProject, setFilterProject] = useState(projectId ?? '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<CostStatsResult | null>(null)

  useEffect(() => {
    setFilterProject(projectId ?? '')
  }, [projectId])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const fresh = await taskboardApi.getCostStats(auth, {
        from,
        to,
        groupBy,
        projectId: projectId || filterProject || undefined,
        timeZone: TZ,
      })
      setStats(fresh)
    } catch (e) {
      if (e instanceof AuthEpochStaleError) return
      setStats(null)
      setError(taskboardErrorMessage(e, '加载成本统计失败'))
    } finally {
      setLoading(false)
    }
  }, [auth, filterProject, from, groupBy, projectId, to])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div
      data-testid="cost-stats"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4"
    >
      <div>
        <h2 className="text-title font-semibold text-fg">成本统计</h2>
        <p className="mt-1 text-caption text-muted">
          任务看板 tb_project 自身统计，不含模型用量 usage_records。先看 token。美元只计有单价的执行；Cursor / Grok 等路由常把成本记成 0，不能当成没花钱。
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="从" className="w-auto">
          <Input
            aria-label="成本起始日"
            type="date"
            inputSize="sm"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="到" className="w-auto">
          <Input
            aria-label="成本结束日"
            type="date"
            inputSize="sm"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <Field label="分组" className="min-w-[8rem]">
          <Select
            aria-label="成本分组"
            inputSize="sm"
            value={groupBy}
            onValueChange={(v) => setGroupBy(v as CostGroupBy)}
            options={COST_GROUP_BY.map((k) => ({ value: k, label: COST_GROUP_BY_LABEL[k] }))}
          />
        </Field>
        <Field label="项目" className="min-w-[10rem]">
          <ProjectScopeSelect className="w-full" />
        </Field>
        <Button type="button" size="sm" variant="secondary" onClick={() => void load()}>
          刷新
        </Button>
      </div>
      {loading && !stats ? (
        <ListSkeleton rows={5} variant="card" />
      ) : error ? (
        <EmptyState
          icon={Coins}
          title="成本统计加载失败"
          hint={error}
          action={
            <Button type="button" variant="secondary" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      ) : !stats ? (
        <EmptyState icon={Coins} title="没有成本数据" hint="换个日期范围或项目再试。" />
      ) : (
        <>
          <Card padding="md" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-section font-semibold text-fg">合计</h3>
              <span className="text-caption text-faint">
                {stats.from} → {stats.to} · {stats.totals.runCount} 次执行
              </span>
            </div>
            <CostCoverageBlock totals={stats.totals} />
          </Card>
          {stats.buckets.length === 0 ? (
            <EmptyState
              icon={Coins}
              title="这一组没有明细"
              hint="合计已显示在上方。换分组或放宽筛选可以看到分桶。"
            />
          ) : (
            <div className="flex flex-col gap-2">
              {stats.buckets.map((bucket) => (
                <Card
                  key={bucket.key}
                  padding="sm"
                  className="flex flex-col gap-1"
                  data-testid="cost-bucket"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="min-w-0 truncate text-body font-medium text-fg">
                      {bucket.label}
                    </h4>
                    <span className="shrink-0 text-caption text-faint">{bucket.runCount} 次</span>
                  </div>
                  <p className="text-meta tabular-nums text-fg">
                    {formatTokenUsage(bucket.tokensIn, bucket.tokensOut)}
                  </p>
                  <p
                    className={`text-caption ${
                      bucket.coverage === 'partial' || bucket.coverage === 'unpriced_only'
                        ? 'text-warning'
                        : 'text-muted'
                    }`}
                  >
                    {formatCostMoneyLine(bucket) ?? '无金额'}
                    {bucket.coverage === 'partial'
                      ? ''
                      : bucket.unpriced.runCount > 0
                        ? ` · ${formatCount(bucket.unpriced.runCount)} 次缺单价`
                        : ''}
                  </p>
                </Card>
              ))}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <StatCard
              label="有单价"
              value={formatCount(stats.totals.priced.runCount)}
              hint={formatTokenUsage(stats.totals.priced.tokensIn, stats.totals.priced.tokensOut)}
            />
            <StatCard
              label="无单价"
              value={formatCount(stats.totals.unpriced.runCount)}
              hint={formatTokenUsage(
                stats.totals.unpriced.tokensIn,
                stats.totals.unpriced.tokensOut,
              )}
              tone={stats.totals.unpriced.runCount > 0 ? 'warning' : 'neutral'}
            />
          </div>
        </>
      )}
    </div>
  )
}
