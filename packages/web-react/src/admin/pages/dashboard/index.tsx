import type { ChartConfiguration } from 'chart.js'
import {
  Activity,
  CheckCircle2,
  CreditCard,
  KeyRound,
  RefreshCw,
  Server,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { Button } from '../../../components/ui'
import {
  ChartCard,
  type ChartTheme,
  LevelBadge,
  RangePreset,
  StatCard,
  StatCardRow,
  TimeAgo,
  barConfig,
  donutConfig,
  lineConfig,
  useChart,
} from '../../components'
import { adminGet } from '../../lib/adminApi'
import { useAdminPoll } from '../../lib/useAdminPoll'
import { getAdminPage } from '../../registry'
import { useAdminRoute } from '../../router'
import { dayShort, fmtCompact, fmtInt, fmtPct, fmtYuan, hourShort } from './format'
import { useLoad } from './useLoad'

// ── 后端响应形状（对齐 commercial adminStats.ts；只取消费到的字段） ──────────
type ActivityStats = {
  active_users: number
  returning_users: number
  new_users: number
  paying_users: number
}
type RevenueRow = {
  day: string
  paid_amount_cents: string
  new_subscriptions: number
  orders_paid: number
}
type SignupRow = { day: string; signups: number; verified: number }
type ReqBucket = {
  hour: string
  success: number
  error: number
  total: number
  users: number
  tokens: string
}
type AccountPool = {
  total: number
  active: number
  cooldown: number
  disabled: number
  banned: number
  avg_health: number
  today_requests: number
  today_success_rate: number
}
type HostItem = { uuid: string; name: string; active: number; max: number; status: string }
type HostsUtil = { used: number; capacity: number; per_host: HostItem[] }
type AlertEvent7dRow = { day: string; event_type: string; count: number }
type AlertsSummary = {
  rules: {
    firing: number
    normal: number
    recent_firing: Array<{ rule_id: string; fired_at: string }>
  }
  outbox: { pending: number; failed: number; sent_24h: number; oldest_pending_age_sec: number }
  events_24h_by_severity: { critical: number; warning: number; info: number }
}
type LifetimeStats = {
  total_users: number
  total_paying_users: number
  total_revenue_cents: string
  total_orders_paid: number
  total_requests: string
  total_tokens: string
  first_paid_at: string | null
  days_in_operation: number
}

type DashData = {
  dau: ActivityStats | null
  revenue: RevenueRow[] | null
  signups: SignupRow[] | null
  reqSeries: ReqBucket[] | null
  pool: AccountPool | null
  hosts: HostsUtil | null
  alerts7d: AlertEvent7dRow[] | null
  alertsSummary: AlertsSummary | null
}

const val = <T,>(r: PromiseSettledResult<T>): T | null =>
  r.status === 'fulfilled' ? r.value : null
const rows = <T,>(r: PromiseSettledResult<{ rows: T[] }>): T[] | null =>
  r.status === 'fulfilled' ? (r.value?.rows ?? []) : null

// DAU 窗口用数字代理喂 RangePreset（value → window 串）。
const DAU_OPTS = [
  { label: '24h', value: 1 },
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
]
const REQ_OPTS = [
  { label: '24h', value: 24 },
  { label: '3d', value: 72 },
  { label: '7d', value: 168 },
]
const dauWindowOf = (v: number): '24h' | '7d' | '30d' => (v === 7 ? '7d' : v === 30 ? '30d' : '24h')
const dauWindowLabel = (v: number): string => (v === 7 ? '7 天' : v === 30 ? '30 天' : '24 小时')

export default function DashboardPage() {
  const meta = getAdminPage('dashboard')
  const { navigate } = useAdminRoute()
  const [dauV, setDauV] = useLocalNum('dashDauWindow', 1)
  const [reqV, setReqV] = useLocalNum('dashReqHours', 24)
  const dauWindow = dauWindowOf(dauV)

  // 主聚合（30s 轮询）。每端点独立 settled，单点失败不传染其它卡（对齐 vanilla）。
  const poll = useAdminPoll<DashData>(
    async () => {
      const [dau, rev, sig, req, pool, hosts, a7d, asum] = await Promise.allSettled([
        adminGet<ActivityStats>('/stats/dau', { window: dauWindow }),
        adminGet<{ rows: RevenueRow[] }>('/stats/revenue-by-day', { days: 14 }),
        adminGet<{ rows: SignupRow[] }>('/stats/signups-by-day', { days: 14 }),
        adminGet<{ rows: ReqBucket[] }>('/stats/request-series', { hours: reqV }),
        adminGet<AccountPool>('/stats/account-pool'),
        adminGet<HostsUtil>('/stats/hosts-utilization'),
        adminGet<{ rows: AlertEvent7dRow[] }>('/stats/alert-events-7d'),
        adminGet<AlertsSummary>('/stats/alerts-summary'),
      ])
      return {
        dau: val(dau),
        revenue: rows(rev),
        signups: rows(sig),
        reqSeries: rows(req),
        pool: val(pool),
        hosts: val(hosts),
        alerts7d: rows(a7d),
        alertsSummary: val(asum),
      }
    },
    { intervalMs: 30_000, deps: [dauWindow, reqV] },
  )

  // 运营至今累计（首载 + 手动刷新，不进 30s 轮询）。
  const lifetime = useLoad<LifetimeStats>(() => adminGet<LifetimeStats>('/stats/lifetime'), [])

  const d = poll.data
  const first = poll.loading && !d
  const failed = poll.error && !d

  // ── KPI 派生 ──
  const reqTotal = d?.reqSeries?.reduce((a, r) => a + (Number(r.total) || 0), 0) ?? 0
  const reqSuccess = d?.reqSeries?.reduce((a, r) => a + (Number(r.success) || 0), 0) ?? 0
  const reqErr = reqTotal - reqSuccess
  const errRate = reqTotal > 0 ? reqErr / reqTotal : 0
  const successRate = reqTotal > 0 ? reqSuccess / reqTotal : 1
  const rev7 = d?.revenue?.slice(-7) ?? []
  const cents7 = rev7.reduce((a, r) => a + (Number(r.paid_amount_cents) || 0), 0)
  const orders7 = rev7.reduce((a, r) => a + (Number(r.orders_paid) || 0), 0)
  const poolAvail = d?.pool ? `${d.pool.active} / ${d.pool.total}` : '—'
  const poolTone = d?.pool
    ? d.pool.total === 0
      ? 'neutral'
      : d.pool.active === d.pool.total
        ? 'success'
        : d.pool.cooldown > 0
          ? 'warning'
          : 'danger'
    : 'danger'
  const hostUsed = Number(d?.hosts?.used ?? 0)
  const hostCap = Number(d?.hosts?.capacity ?? 0)
  const hostPct = hostCap > 0 ? hostUsed / hostCap : 0
  const firing = d?.alertsSummary?.rules.firing ?? 0

  const winLabel = `窗口 ${dauWindowLabel(dauV)}`

  return (
    <div className="flex flex-col gap-5">
      <PageHeaderRow
        title={meta.title}
        desc={meta.desc}
        onRefresh={() => {
          poll.refresh()
          lifetime.reload()
        }}
        refreshing={poll.loading}
        dauV={dauV}
        onDau={setDauV}
      />

      {/* 每日经营 KPI（boss 第一屏最上层） */}
      <StatCardRow>
        <StatCard
          label="活跃用户 DAU"
          value={d?.dau ? fmtInt(d.dau.active_users) : '—'}
          hint={d?.dau ? winLabel : failed ? '加载失败' : winLabel}
          tone="accent"
          icon={Users}
          loading={first}
        />
        <StatCard
          label="窗口新注册"
          value={d?.dau ? fmtInt(d.dau.new_users) : '—'}
          hint={`${winLabel} · 首次注册`}
          tone={d?.dau && d.dau.new_users > 0 ? 'success' : 'neutral'}
          icon={UserPlus}
          loading={first}
        />
        <StatCard
          label="付费用户"
          value={d?.dau ? fmtInt(d.dau.paying_users) : '—'}
          hint={`${winLabel} · 有充值`}
          tone={d?.dau && d.dau.paying_users > 0 ? 'success' : 'neutral'}
          icon={CreditCard}
          loading={first}
        />
        <StatCard
          label="7 天营收"
          value={d?.revenue ? fmtYuan(cents7) : '—'}
          hint={d?.revenue ? `${orders7} 笔 · 最近 7 天` : '加载失败'}
          tone={cents7 > 0 ? 'success' : 'neutral'}
          icon={TrendingUp}
          loading={first}
        />
        <StatCard
          label={`请求量 · ${reqV >= 168 ? '7 天' : reqV >= 72 ? '3 天' : '24 小时'}`}
          value={d?.reqSeries ? fmtInt(reqTotal) : '—'}
          hint={d?.reqSeries ? `错误率 ${fmtPct(errRate, 2)}` : '加载失败'}
          tone={
            !d?.reqSeries
              ? 'danger'
              : errRate > 0.05
                ? 'danger'
                : errRate > 0.01
                  ? 'warning'
                  : 'neutral'
          }
          icon={Activity}
          loading={first}
        />
        <StatCard
          label="请求成功率"
          value={d?.reqSeries ? fmtPct(successRate, 2) : '—'}
          hint={d?.reqSeries ? `成功 ${fmtInt(reqSuccess)} / ${fmtInt(reqTotal)}` : '加载失败'}
          tone={
            !d?.reqSeries
              ? 'danger'
              : successRate >= 0.99
                ? 'success'
                : successRate >= 0.95
                  ? 'warning'
                  : 'danger'
          }
          icon={CheckCircle2}
          loading={first}
        />
        <ClickableCard onClick={() => navigate('accounts')} label="查看账号池">
          <StatCard
            label="账号池可用"
            value={poolAvail}
            hint={
              d?.pool
                ? d.pool.cooldown > 0
                  ? `${d.pool.cooldown} 冷却`
                  : d.pool.disabled + d.pool.banned > 0
                    ? `${d.pool.disabled + d.pool.banned} 禁用/封禁`
                    : '全部健康'
                : '加载失败'
            }
            tone={poolTone}
            icon={KeyRound}
            loading={first}
          />
        </ClickableCard>
        <ClickableCard onClick={() => navigate('hosts')} label="查看主机">
          <StatCard
            label="虚机利用率"
            value={d?.hosts ? (hostCap > 0 ? fmtPct(hostPct, 0) : '—') : '—'}
            hint={d?.hosts ? `${hostUsed} / ${hostCap} 容量` : '加载失败'}
            tone={
              !d?.hosts
                ? 'danger'
                : hostPct >= 0.9
                  ? 'danger'
                  : hostPct >= 0.7
                    ? 'warning'
                    : 'neutral'
            }
            icon={Server}
            loading={first}
          />
        </ClickableCard>
      </StatCardRow>

      {/* 运营至今累计 */}
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-muted">运营至今</h2>
        <span className="text-[12px] text-faint">
          {lifetime.data?.first_paid_at
            ? `自 ${lifetime.data.first_paid_at.slice(0, 10)} 首单`
            : lifetime.error
              ? '加载失败'
              : '累计口径'}
        </span>
      </div>
      <StatCardRow className="lg:grid-cols-6">
        <StatCard
          label="累计用户"
          value={lifetime.data ? fmtInt(lifetime.data.total_users) : '—'}
          hint={
            lifetime.data
              ? `付费 ${fmtInt(lifetime.data.total_paying_users)}`
              : lifetime.error
                ? '加载失败'
                : undefined
          }
          loading={lifetime.loading && !lifetime.data}
        />
        <StatCard
          label="累计营收"
          value={lifetime.data ? fmtYuan(lifetime.data.total_revenue_cents) : '—'}
          hint="自首单累计"
          tone={
            lifetime.data && Number(lifetime.data.total_revenue_cents) > 0 ? 'success' : 'neutral'
          }
          loading={lifetime.loading && !lifetime.data}
        />
        <StatCard
          label="累计订单"
          value={lifetime.data ? fmtInt(lifetime.data.total_orders_paid) : '—'}
          hint="已付清"
          loading={lifetime.loading && !lifetime.data}
        />
        <StatCard
          label="累计请求"
          value={lifetime.data ? fmtCompact(lifetime.data.total_requests) : '—'}
          hint="usage_records"
          loading={lifetime.loading && !lifetime.data}
        />
        <StatCard
          label="累计 Token"
          value={lifetime.data ? fmtCompact(lifetime.data.total_tokens) : '—'}
          hint="in+out+cache"
          loading={lifetime.loading && !lifetime.data}
        />
        <StatCard
          label="运营天数"
          value={
            lifetime.data
              ? lifetime.data.days_in_operation > 0
                ? fmtInt(lifetime.data.days_in_operation)
                : '—'
              : '—'
          }
          hint={
            lifetime.data?.first_paid_at
              ? `自 ${lifetime.data.first_paid_at.slice(0, 10)}`
              : '未开单'
          }
          loading={lifetime.loading && !lifetime.data}
        />
      </StatCardRow>

      {/* 趋势图两列 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartPanel
          title="请求趋势"
          hint={`最近 ${reqV >= 168 ? '7 天' : reqV >= 72 ? '3 天' : '24 小时'} · 成功 / 错误 / 独立用户`}
          action={<RangePreset options={REQ_OPTS} value={reqV} onChange={setReqV} />}
          loading={first}
          error={!!failed || (!!d && !d.reqSeries)}
          empty={!!d?.reqSeries && d.reqSeries.length === 0}
          data={d?.reqSeries}
          build={(t) =>
            lineConfig(t, {
              labels: (d?.reqSeries ?? []).map((r) => hourShort(r.hour, reqV > 24)),
              series: [
                {
                  label: '成功',
                  data: (d?.reqSeries ?? []).map((r) => Number(r.success) || 0),
                  colorToken: 'success',
                  fill: true,
                },
                {
                  label: '错误',
                  data: (d?.reqSeries ?? []).map((r) => Number(r.error) || 0),
                  colorToken: 'danger',
                },
                {
                  label: '独立用户',
                  data: (d?.reqSeries ?? []).map((r) => Number(r.users) || 0),
                  colorToken: 'warning',
                },
              ],
            })
          }
        />
        <ChartPanel
          title="每日营收"
          hint={
            d?.revenue
              ? `合计 ${fmtYuan(d.revenue.reduce((a, r) => a + Number(r.paid_amount_cents || 0), 0))} · 最近 14 天`
              : '最近 14 天'
          }
          loading={first}
          error={!!failed || (!!d && !d.revenue)}
          empty={!!d?.revenue && d.revenue.length === 0}
          data={d?.revenue}
          build={(t) =>
            barConfig(t, {
              labels: (d?.revenue ?? []).map((r) => dayShort(r.day)),
              series: [
                {
                  label: '订单金额(元)',
                  data: (d?.revenue ?? []).map((r) => Number(r.paid_amount_cents) / 100),
                },
                {
                  label: '新订阅',
                  data: (d?.revenue ?? []).map((r) => Number(r.new_subscriptions) || 0),
                  colorToken: 'warning',
                },
              ],
            })
          }
        />
        <ChartPanel
          title="每日新注册"
          hint={
            d?.signups
              ? `合计 ${fmtInt(d.signups.reduce((a, r) => a + (Number(r.signups) || 0), 0))} 注册 · 最近 14 天`
              : '最近 14 天'
          }
          loading={first}
          error={!!failed || (!!d && !d.signups)}
          empty={!!d?.signups && d.signups.length === 0}
          data={d?.signups}
          build={(t) =>
            barConfig(t, {
              labels: (d?.signups ?? []).map((r) => dayShort(r.day)),
              series: [
                { label: '新注册', data: (d?.signups ?? []).map((r) => Number(r.signups) || 0) },
                {
                  label: '已验证',
                  data: (d?.signups ?? []).map((r) => Number(r.verified) || 0),
                  colorToken: 'success',
                },
              ],
            })
          }
        />
        <ChartPanel
          title="虚机水位"
          hint="每台主机 已用 / 剩余 容量"
          action={
            <Button variant="link" size="sm" onClick={() => navigate('hosts')}>
              主机管理 →
            </Button>
          }
          loading={first}
          error={!!failed || (!!d && !d.hosts)}
          empty={!!d?.hosts && (d.hosts.per_host?.length ?? 0) === 0}
          data={d?.hosts}
          build={(t) =>
            barConfig(t, {
              stacked: true,
              labels: (d?.hosts?.per_host ?? []).map((h) => (h.name || h.uuid || '').slice(0, 16)),
              series: [
                {
                  label: '已用',
                  data: (d?.hosts?.per_host ?? []).map((h) => Number(h.active) || 0),
                },
                {
                  label: '剩余',
                  data: (d?.hosts?.per_host ?? []).map((h) =>
                    Math.max(0, (Number(h.max) || 0) - (Number(h.active) || 0)),
                  ),
                  colorToken: 'muted',
                },
              ],
            })
          }
        />
      </div>

      {/* 资源 / 告警卡两列 */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartPanel
          title="账号池健康构成"
          hint={
            d?.pool
              ? `均分 ${Math.round(d.pool.avg_health)} · 今日成功率 ${fmtPct(d.pool.today_success_rate, 1)}`
              : '按状态分布'
          }
          action={
            <Button variant="link" size="sm" onClick={() => navigate('accounts')}>
              账号池 →
            </Button>
          }
          height={240}
          loading={first}
          error={!!failed || (!!d && !d.pool)}
          empty={!!d?.pool && d.pool.total === 0}
          data={d?.pool}
          build={(t) =>
            donutConfig(t, {
              labels: ['可用', '冷却', '禁用', '封禁'],
              data: [
                d?.pool?.active ?? 0,
                d?.pool?.cooldown ?? 0,
                d?.pool?.disabled ?? 0,
                d?.pool?.banned ?? 0,
              ],
              colorTokens: ['success', 'warning', 'muted', 'danger'],
            })
          }
        />
        <AlertsCard
          summary={d?.alertsSummary ?? null}
          events7d={d?.alerts7d ?? null}
          loading={first}
          failed={!!failed}
          onOpen={() => navigate('alerts')}
        />
      </div>
    </div>
  )
}

// ── 页头 + DAU 窗口 + 刷新 ────────────────────────────────────────────────
function PageHeaderRow({
  title,
  desc,
  onRefresh,
  refreshing,
  dauV,
  onDau,
}: {
  title: string
  desc: string
  onRefresh: () => void
  refreshing: boolean
  dauV: number
  onDau: (v: number) => void
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-fg">{title}</h1>
        <p className="mt-1 text-[13px] leading-snug text-muted">{desc} · 30s 自动刷新</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-[12px] text-faint">活跃度窗口</span>
        <RangePreset options={DAU_OPTS} value={dauV} onChange={onDau} />
        <Button variant="secondary" size="sm" onClick={onRefresh} className="gap-1.5">
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
          刷新
        </Button>
      </div>
    </div>
  )
}

// ── 可点击 KPI 卡包裹（原生 button，键盘可达） ────────────────────────────
function ClickableCard({
  onClick,
  label,
  children,
}: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="cursor-pointer rounded-xl text-left outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  )
}

// ── 图表面板：统一 loading / error / empty / canvas 分支 ──────────────────
function ChartPanel({
  title,
  hint,
  action,
  height = 260,
  loading,
  error,
  empty,
  data,
  build,
}: {
  title: string
  hint?: string
  action?: ReactNode
  height?: number
  loading?: boolean
  error?: boolean
  empty?: boolean
  data: unknown
  build: (theme: ChartTheme) => ChartConfiguration
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  // canvas 未挂载（loading/error/empty）时 useChart 内部会因 ref 为空 no-op。
  useChart(ref, build, [data, loading, error, empty])
  return (
    <ChartCard title={title} hint={hint} action={action} height={height}>
      {loading ? (
        <div className="flex h-full w-full items-center justify-center">
          <div className="h-full w-full animate-pulse rounded-lg bg-hover" />
        </div>
      ) : error ? (
        <CenterMsg tone="danger">加载失败</CenterMsg>
      ) : empty ? (
        <CenterMsg>暂无数据</CenterMsg>
      ) : (
        <canvas ref={ref} />
      )}
    </ChartCard>
  )
}

function CenterMsg({ children, tone }: { children: ReactNode; tone?: 'danger' }) {
  return (
    <div
      className={`flex h-full w-full items-center justify-center text-[13px] ${
        tone === 'danger' ? 'text-danger' : 'text-faint'
      }`}
    >
      {children}
    </div>
  )
}

// ── 告警摘要卡（整卡可点 → alerts） ──────────────────────────────────────
function AlertsCard({
  summary,
  events7d,
  loading,
  failed,
  onOpen,
}: {
  summary: AlertsSummary | null
  events7d: AlertEvent7dRow[] | null
  loading?: boolean
  failed?: boolean
  onOpen: () => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const sev = summary?.events_24h_by_severity
  const sevTotal = sev ? sev.critical + sev.warning + sev.info : 0
  useChart(
    ref,
    (t) =>
      donutConfig(t, {
        labels: ['严重', '警告', '信息'],
        data: [sev?.critical ?? 0, sev?.warning ?? 0, sev?.info ?? 0],
        colorTokens: ['danger', 'warning', 'info'],
        legend: 'right',
      }),
    [sev?.critical, sev?.warning, sev?.info, loading, failed],
  )
  const events7dTotal = events7d?.reduce((a, r) => a + (Number(r.count) || 0), 0) ?? 0
  const recent = summary?.rules.recent_firing ?? []

  return (
    <button
      type="button"
      aria-label="打开告警中心"
      onClick={onOpen}
      className="flex cursor-pointer flex-col rounded-xl border border-border bg-surface text-left shadow-soft outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3 px-5 py-3.5">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-fg">告警摘要</h3>
          <p className="mt-0.5 text-[11.5px] text-faint">
            触发中规则 / 近 24h 事件级别 / 近 7 日事件
          </p>
        </div>
        <span className="shrink-0 text-[12px] font-medium text-accent">告警中心 →</span>
      </div>

      {loading ? (
        <div className="border-t border-border px-5 py-8">
          <div className="h-24 w-full animate-pulse rounded-lg bg-hover" />
        </div>
      ) : failed || !summary ? (
        <div className="border-t border-border px-5 py-8 text-center text-[13px] text-danger">
          加载失败
        </div>
      ) : (
        <div className="border-t border-border px-5 py-4">
          {/* 概览 3 指标 */}
          <div className="grid grid-cols-3 gap-3">
            <MiniStat
              label="触发中规则"
              value={fmtInt(summary.rules.firing)}
              tone={summary.rules.firing > 0 ? 'danger' : 'success'}
            />
            <MiniStat
              label="近 7 日事件"
              value={fmtInt(events7dTotal)}
              tone={events7dTotal > 0 ? 'warning' : 'neutral'}
            />
            <MiniStat
              label="待发 / 失败"
              value={`${fmtInt(summary.outbox.pending)} / ${fmtInt(summary.outbox.failed)}`}
              tone={
                summary.outbox.failed > 0
                  ? 'danger'
                  : summary.outbox.pending > 0
                    ? 'warning'
                    : 'success'
              }
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* 24h 级别分布 donut */}
            <div>
              <p className="mb-1 text-[11.5px] text-faint">
                近 24h 事件 · 按级别（{fmtInt(sevTotal)} 起）
              </p>
              <div className="relative h-[132px] w-full">
                {sevTotal > 0 ? <canvas ref={ref} /> : <CenterMsg>近 24h 无事件</CenterMsg>}
              </div>
            </div>
            {/* 最近触发规则 */}
            <div>
              <p className="mb-1 text-[11.5px] text-faint">最近触发规则</p>
              {recent.length === 0 ? (
                <p className="py-6 text-center text-[12.5px] text-faint">近期无触发规则</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/60">
                  {recent.map((r) => (
                    <li key={r.rule_id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <LevelBadge level="critical" label="触发" />
                        <code className="truncate text-[12px] text-fg">{r.rule_id}</code>
                      </span>
                      {r.fired_at && (
                        <TimeAgo value={r.fired_at} className="shrink-0 text-[11.5px] text-faint" />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </button>
  )
}

function MiniStat({
  label,
  value,
  tone,
}: { label: string; value: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const toneCls = {
    neutral: 'text-fg',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  }[tone]
  return (
    <div className="rounded-lg bg-hover px-3 py-2">
      <p className="truncate text-[11px] text-faint">{label}</p>
      <p className={`mt-0.5 text-[16px] font-semibold tabular-nums ${toneCls}`}>{value}</p>
    </div>
  )
}

// ── 轻量 localStorage 持久化的数字状态（toggle 记忆，对齐 vanilla sessionStorage 契约） ──
function useLocalNum(key: string, initial: number): [number, (v: number) => void] {
  const storageKey = `oc_admin_${key}`
  const [v, setV] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      const n = raw == null ? Number.NaN : Number(raw)
      return Number.isFinite(n) ? n : initial
    } catch {
      return initial
    }
  })
  const set = (next: number) => {
    setV(next)
    try {
      localStorage.setItem(storageKey, String(next))
    } catch {
      /* 隐私模式 / 配额满：忽略持久化 */
    }
  }
  return [v, set]
}
