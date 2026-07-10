import { Download, RefreshCw } from 'lucide-react'
import { useRef, useState } from 'react'
import { Badge, Button, useToast } from '../../../components/ui'
import {
  ChartCard,
  type Column,
  DataTable,
  FilterBar,
  PageHeader,
  Pagination,
  RangePreset,
  SearchInput,
  SelectFilter,
  StatCard,
  StatCardRow,
  TimeAgo,
  barConfig,
  useChart,
} from '../../components'
import { ApiError, adminGet, adminText } from '../../lib/adminApi'
import { getAdminPage } from '../../registry'
import { useAdminRoute } from '../../router'
import { AdjustCreditsModal } from './AdjustCreditsModal'
import { UserDetailSheet } from './UserDetailSheet'
import { fmtInt, fmtPct, fmtYuan } from './format'
import type { FunnelStats, ListUsersResult, UserRow, UsersStats } from './types'
import { useLoad } from './useLoad'

const PAGE_SIZE = 50

const STATUS_OPTS = [
  { label: '全部状态', value: '' },
  { label: 'active', value: 'active' },
  { label: 'banned', value: 'banned' },
  { label: 'deleting', value: 'deleting' },
  { label: 'deleted', value: 'deleted' },
]
const REG_OPTS = [
  { label: '全部时间', value: '' },
  { label: '今天', value: 'today' },
  { label: '昨天', value: 'yesterday' },
  { label: '7 天内', value: '7d' },
  { label: '30 天内', value: '30d' },
]
const FUNNEL_OPTS = [
  { label: '全部漏斗', value: '' },
  { label: '未验证邮箱', value: 'unverified' },
  { label: '未充值', value: 'no_topup' },
  { label: '未请求', value: 'no_request' },
  { label: '注册满 24h 沉默', value: 'silent_24h' },
]
const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  active: 'success',
  banned: 'danger',
  deleting: 'warning',
  deleted: 'neutral',
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e)
}

/** 最近活跃时间的健康 tone：>7 天 danger，>1 天 warning，否则 success。 */
function activeTone(iso: string | null): 'danger' | 'warning' | 'success' | 'faint' {
  if (!iso) return 'faint'
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff > 86400 * 7) return 'danger'
  if (diff > 86400) return 'warning'
  return 'success'
}

// ToastProvider / TooltipProvider 由 admin/main.tsx 在根挂载（全局单例），页面直接消费。
export default function UsersPage() {
  const meta = getAdminPage('users')
  const { navigate } = useAdminRoute()
  const toast = useToast()

  // 过滤 / 分页
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [registeredWithin, setRegisteredWithin] = useState('')
  const [funnelState, setFunnelState] = useState('')
  const [offset, setOffset] = useState(0)
  const [funnelDays, setFunnelDays] = useState(7)

  // 详情 / 调账
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adjust, setAdjust] = useState<{ id: string; email: string } | null>(null)
  const [detailReload, setDetailReload] = useState(0)
  const [exporting, setExporting] = useState(false)

  // 改过滤 → 回到第一页。
  const resetTo = (fn: () => void) => {
    fn()
    setOffset(0)
  }

  // KPI（首载 + 手动刷新）
  const stats = useLoad<UsersStats>(() => adminGet<UsersStats>('/users/stats'), [])
  // 漏斗（随 7/30 切换重拉）
  const funnel = useLoad<FunnelStats>(
    () => adminGet<FunnelStats>('/stats/funnel', { days: funnelDays }),
    [funnelDays],
  )
  // 用户列表（过滤 / 翻页变化重拉；offset/limit 分页）
  const list = useLoad<ListUsersResult>(
    () =>
      adminGet<ListUsersResult>('/users', {
        with_stats: 1,
        limit: PAGE_SIZE,
        offset,
        q,
        status,
        registered_within: registeredWithin,
        funnel_state: funnelState,
      }),
    [q, status, registeredWithin, funnelState, offset],
  )
  // 注：users 为非轮询 tab（首载 + 手动刷新，对齐旧 vanilla），故不用 useAdminPoll。

  const rows = list.data?.rows ?? []
  const totalLoaded = rows.length

  const refreshAll = () => {
    stats.reload()
    funnel.reload()
    list.reload()
  }

  const exportCsv = async () => {
    setExporting(true)
    try {
      const csv = await adminText('/users.csv', {
        q,
        status,
        registered_within: registeredWithin,
        funnel_state: funnelState,
      })
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `users-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast('已导出用户 CSV', 'success')
    } catch (e) {
      toast(`导出失败：${errMsg(e)}`, 'error')
    } finally {
      setExporting(false)
    }
  }

  const columns: Column<UserRow>[] = [
    {
      key: 'id',
      title: 'ID',
      width: 72,
      cellClassName: 'font-mono text-faint',
      render: (u) => u.id,
    },
    {
      key: 'email',
      title: '邮箱',
      render: (u) => (
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{u.email}</span>
          {u.email_verified ? (
            <Badge tone="success">✓</Badge>
          ) : (
            <Badge tone="warning">未验证</Badge>
          )}
          {u.containers_active > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                navigate('containers', { user_email: u.email })
              }}
              className="shrink-0 rounded-md bg-hover px-1.5 py-0.5 text-[11px] text-muted outline-none transition-colors hover:bg-active hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
              title="查看该用户的活跃容器"
            >
              {u.containers_active} 容器
            </button>
          )}
        </div>
      ),
    },
    {
      key: 'display_name',
      title: '显示名',
      render: (u) => u.display_name || <span className="text-faint">—</span>,
    },
    {
      key: 'role',
      title: '角色',
      render: (u) => <Badge tone={u.role === 'admin' ? 'warning' : 'neutral'}>{u.role}</Badge>,
    },
    {
      key: 'status',
      title: '状态',
      render: (u) => <Badge tone={STATUS_TONE[u.status] ?? 'neutral'}>{u.status}</Badge>,
    },
    {
      key: 'credits',
      title: '余额',
      align: 'right',
      cellClassName: 'tabular-nums',
      render: (u) => fmtYuan(u.credits),
    },
    {
      key: 'total_topup_cents',
      title: '累计充值',
      align: 'right',
      cellClassName: 'tabular-nums',
      render: (u) => fmtYuan(u.total_topup_cents),
    },
    {
      key: 'today_requests',
      title: '今日请求',
      align: 'right',
      cellClassName: 'tabular-nums',
      render: (u) => {
        if (u.today_requests <= 0) return <span className="text-faint">—</span>
        const rate = u.today_errors / u.today_requests
        const tone = rate > 0.1 ? 'danger' : rate > 0.02 ? 'warning' : 'success'
        return (
          <span className="inline-flex items-center gap-1.5">
            {fmtInt(u.today_requests)}
            <Badge tone={tone}>{fmtPct(rate, 1)}</Badge>
          </span>
        )
      },
    },
    {
      key: 'last_active_at',
      title: '最近活跃',
      render: (u) => {
        if (!u.last_active_at) return <span className="text-faint">从未</span>
        const tone = activeTone(u.last_active_at)
        const cls =
          tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-success'
        return <TimeAgo value={u.last_active_at} className={cls} />
      },
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      render: (u) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            setAdjust({ id: u.id, email: u.email })
          }}
        >
          ± 余额
        </Button>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={meta.desc}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={exportCsv}
              disabled={exporting}
              className="gap-1.5"
            >
              <Download size={14} className={exporting ? 'animate-pulse' : undefined} />
              导出 CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={refreshAll} className="gap-1.5">
              <RefreshCw size={14} className={list.loading ? 'animate-spin' : undefined} />
              刷新
            </Button>
          </>
        }
      />

      {/* KPI */}
      <StatCardRow>
        <StatCard
          label="总用户数"
          value={stats.data ? fmtInt(stats.data.total_users) : '—'}
          hint={
            stats.data
              ? `active ${stats.data.active_users} · banned ${stats.data.banned_users} · 已删 ${stats.data.deleted_users}`
              : stats.error
                ? '加载失败'
                : undefined
          }
          tone={stats.data && stats.data.banned_users > 0 ? 'warning' : 'success'}
          loading={stats.loading && !stats.data}
        />
        <StatCard
          label="7 天新注册"
          value={stats.data ? fmtInt(stats.data.new_7d) : '—'}
          hint="7d 累计"
          tone={stats.data && stats.data.new_7d > 0 ? 'success' : 'neutral'}
          loading={stats.loading && !stats.data}
        />
        <StatCard
          label="7 天活跃"
          value={stats.data ? fmtInt(stats.data.active_7d) : '—'}
          hint="有 usage_records 的独立用户"
          loading={stats.loading && !stats.data}
        />
        <StatCard
          label="7 天付费用户"
          value={stats.data ? fmtInt(stats.data.paying_7d) : '—'}
          hint={stats.data ? `平均余额 ${fmtYuan(stats.data.avg_credits_cents)}` : undefined}
          tone={stats.data && stats.data.paying_7d > 0 ? 'success' : 'neutral'}
          loading={stats.loading && !stats.data}
        />
      </StatCardRow>

      {/* 新用户漏斗 */}
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-muted">
          新用户漏斗 <span className="text-faint">· 最近 {funnelDays} 天</span>
        </h2>
        <RangePreset value={funnelDays} onChange={setFunnelDays} />
      </div>
      <StatCardRow className="lg:grid-cols-6">
        <FunnelKpi
          label="cohort 总数"
          value={funnel.data?.cohort_total}
          loading={funnel.loading && !funnel.data}
          tone="accent"
          days={funnelDays}
        />
        <FunnelKpi
          label="已验证邮箱"
          value={funnel.data?.verified}
          of={funnel.data?.cohort_total}
          loading={funnel.loading && !funnel.data}
        />
        <FunnelKpi
          label="首次充值"
          value={funnel.data?.first_topup}
          of={funnel.data?.cohort_total}
          loading={funnel.loading && !funnel.data}
          tone="success"
        />
        <FunnelKpi
          label="首次请求"
          value={funnel.data?.first_request}
          of={funnel.data?.cohort_total}
          loading={funnel.loading && !funnel.data}
        />
        <RetentionKpi
          label="D1 留存"
          retained={funnel.data?.d1_retained}
          eligible={funnel.data?.eligible_for_d1}
          loading={funnel.loading && !funnel.data}
        />
        <RetentionKpi
          label="D7 留存"
          retained={funnel.data?.d7_retained}
          eligible={funnel.data?.eligible_for_d7}
          loading={funnel.loading && !funnel.data}
        />
      </StatCardRow>

      <FunnelChart
        data={funnel.data}
        days={funnelDays}
        loading={funnel.loading && !funnel.data}
        error={!!funnel.error}
      />

      {/* 过滤 + 表格 */}
      <FilterBar>
        <SearchInput
          value={q}
          onChange={(v) => resetTo(() => setQ(v))}
          placeholder="搜索 邮箱 / ID / 显示名"
        />
        <SelectFilter
          label="状态"
          value={status}
          options={STATUS_OPTS}
          onChange={(v) => resetTo(() => setStatus(v))}
        />
        <SelectFilter
          label="注册"
          value={registeredWithin}
          options={REG_OPTS}
          onChange={(v) => resetTo(() => setRegisteredWithin(v))}
        />
        <SelectFilter
          label="漏斗"
          value={funnelState}
          options={FUNNEL_OPTS}
          onChange={(v) => resetTo(() => setFunnelState(v))}
        />
        <span className="ml-auto text-[12px] text-faint tabular-nums">
          {list.data ? `本页 ${totalLoaded}${list.data.next_cursor ? '+' : ''} 人` : ''}
        </span>
      </FilterBar>

      {list.error && !list.data ? (
        <div className="rounded-xl border border-danger/40 bg-danger-soft px-4 py-8 text-center text-[13px] text-danger">
          加载失败：{errMsg(list.error)}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(u) => u.id}
            loading={list.loading && !list.data}
            onRowClick={(u) => setSelectedId(u.id)}
            emptyTitle="无用户"
            emptyHint="没有符合当前筛选条件的用户"
          />
          <Pagination offset={offset} limit={PAGE_SIZE} count={totalLoaded} onChange={setOffset} />
        </div>
      )}

      <UserDetailSheet
        userId={selectedId}
        reloadKey={detailReload}
        onClose={() => setSelectedId(null)}
        onChanged={() => list.reload()}
        onAdjust={(id, email) => setAdjust({ id, email })}
        onNavigate={(tab, params) => navigate(tab, params)}
      />
      <AdjustCreditsModal
        userId={adjust?.id ?? null}
        userEmail={adjust?.email}
        onClose={() => setAdjust(null)}
        onDone={() => {
          list.reload()
          setDetailReload((n) => n + 1)
        }}
      />
    </div>
  )
}

// ── 漏斗 KPI（绝对值 + 占 cohort 比例） ──────────────────────────────────
function FunnelKpi({
  label,
  value,
  of,
  loading,
  tone,
  days,
}: {
  label: string
  value?: number
  of?: number
  loading?: boolean
  tone?: 'accent' | 'success'
  days?: number
}) {
  const v = value ?? 0
  const hint =
    days != null
      ? v > 0
        ? `最近 ${days} 天注册`
        : `最近 ${days} 天无新注册`
      : of && of > 0
        ? `占 cohort ${fmtPct(v / of, 1)}`
        : '—'
  return (
    <StatCard
      label={label}
      value={value == null ? '—' : fmtInt(value)}
      hint={hint}
      tone={v > 0 ? (tone ?? 'neutral') : 'neutral'}
      loading={loading}
    />
  )
}

// ── 留存 KPI（retained / eligible 比率） ─────────────────────────────────
function RetentionKpi({
  label,
  retained,
  eligible,
  loading,
}: {
  label: string
  retained?: number
  eligible?: number
  loading?: boolean
}) {
  const el = eligible ?? 0
  const rt = retained ?? 0
  const ratio = el > 0 ? rt / el : 0
  return (
    <StatCard
      label={label}
      value={eligible == null ? '—' : el > 0 ? fmtPct(ratio, 1) : '窗口未到'}
      hint={el > 0 ? `${rt} / ${el} 合格 cohort` : '窗口未到'}
      tone={el > 0 && ratio < 0.2 ? 'warning' : 'neutral'}
      loading={loading}
    />
  )
}

// ── 转化漏斗 bar ─────────────────────────────────────────────────────────
function FunnelChart({
  data,
  days,
  loading,
  error,
}: {
  data: FunnelStats | null
  days: number
  loading?: boolean
  error?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useChart(
    ref,
    (t) =>
      barConfig(t, {
        labels: ['cohort 总数', '已验证', '首次充值', '首次请求'],
        series: [
          {
            label: `最近 ${days} 天`,
            data: [
              data?.cohort_total ?? 0,
              data?.verified ?? 0,
              data?.first_topup ?? 0,
              data?.first_request ?? 0,
            ],
          },
        ],
      }),
    [data?.cohort_total, data?.verified, data?.first_topup, data?.first_request, loading, error],
  )
  return (
    <ChartCard title="转化漏斗" hint={`最近 ${days} 天 · cohort → 验证 → 充值 → 请求`} height={220}>
      {loading ? (
        <div className="h-full w-full animate-pulse rounded-lg bg-hover" />
      ) : error ? (
        <div className="flex h-full w-full items-center justify-center text-[13px] text-danger">
          加载失败
        </div>
      ) : (
        <canvas ref={ref} />
      )}
    </ChartCard>
  )
}
