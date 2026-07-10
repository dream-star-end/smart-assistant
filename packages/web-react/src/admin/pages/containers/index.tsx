import { Boxes, CircleAlert, PlayCircle, RefreshCw, TimerReset, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Badge, Button, Spinner, Tooltip, useConfirm, useToast } from '../../../components/ui'
import {
  ChartCard,
  type Column,
  CopyChip,
  DataTable,
  FilterBar,
  PageHeader,
  SearchInput,
  SectionCard,
  SelectFilter,
  StatCard,
  StatCardRow,
  TimeAgo,
  barConfig,
  donutConfig,
  useChart,
} from '../../components'
import { ApiError, adminGet, adminSend } from '../../lib/adminApi'
import { useAdminPoll } from '../../lib/useAdminPoll'
import { getAdminPage } from '../../registry'
import { useAdminRoute } from '../../router'
import { ContainerLogsModal } from './ContainerLogsModal'
import {
  CONTAINER_STATUSES,
  containerStatusTone,
  imageDistribution,
  imageTag,
  kpiTones,
  lifecycleOf,
  subscriptionExpiryChip,
} from './helpers'
import type { ContainerAction, ContainerRow, ContainerStats } from './types'

// 容器页无原版自动刷新（brief：仅 dashboard/hosts/accounts/health/pricing 30s）。
// useAdminPoll 无「只加载不轮询」档位（地基缺口，见报告）→ 用超大间隔逼近「首载 + 手动刷新」，
// 仍保留 deps 变化重拉 + 切回可见补拉 + refresh() 手动重拉。
const NO_POLL_MS = 6 * 60 * 60 * 1000

const STATUS_OPTIONS = [
  { label: '全部', value: '' },
  ...CONTAINER_STATUSES.map((s) => ({ label: s, value: s })),
]

const DONUT_STATES: { key: keyof ContainerStats; label: string; token: string }[] = [
  { key: 'running', label: '运行中', token: 'success' },
  { key: 'provisioning', label: 'provisioning', token: 'warning' },
  { key: 'stopped', label: 'stopped', token: 'muted' },
  { key: 'error', label: 'error', token: 'danger' },
]

const ACTION_LABEL: Record<ContainerAction, string> = {
  restart: '重启',
  stop: '停止',
  remove: '删除',
}

export default function ContainersPage() {
  const meta = getAdminPage('containers')
  const { params, navigate } = useAdminRoute()
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()

  // 服务端过滤（URL 为单一权威，可深链 + 跨页跳转携带）：status + host_uuid。
  const statusFilter = params.status ?? ''
  const hostFilter = params.host_uuid ?? ''
  // 客户端文本过滤：从深链 user/user_email 播种，之后本地态（不写回 URL，避免历史堆栈污染）。
  const [userQuery, setUserQuery] = useState(() => params.user ?? params.user_email ?? '')
  const [logsFor, setLogsFor] = useState<{ id: number; label: string } | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const patchRoute = (patch: Record<string, string | undefined>) =>
    navigate('containers', { status: statusFilter, host_uuid: hostFilter, ...patch })

  const stats = useAdminPoll(() => adminGet<ContainerStats>('/agent-containers/stats'), {
    intervalMs: NO_POLL_MS,
  })

  const list = useAdminPoll(
    () =>
      adminGet<{ rows: ContainerRow[] }>('/agent-containers', {
        limit: 500,
        status: statusFilter || undefined,
        host_uuid: hostFilter || undefined,
      }),
    { intervalMs: NO_POLL_MS, deps: [statusFilter, hostFilter] },
  )

  const rows = list.data?.rows ?? []
  const q = userQuery.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      q
        ? rows.filter(
            (c) =>
              (c.user_email || '').toLowerCase().includes(q) || String(c.user_id ?? '').includes(q),
          )
        : rows,
    [rows, q],
  )

  const refreshAll = () => {
    stats.refresh()
    list.refresh()
  }

  const runAction = async (c: ContainerRow, action: ContainerAction) => {
    const label = `#${c.id}${c.user_email ? ` ${c.user_email}` : ''}`
    const ok = await confirm({
      title: `${ACTION_LABEL[action]}容器 #${c.id}`,
      danger: action !== 'restart',
      confirmText: ACTION_LABEL[action],
      body: (
        <div className="space-y-1.5 text-[13px] text-muted">
          <p>
            对象：<span className="font-medium text-fg">{label}</span>
          </p>
          <p>
            {action === 'remove'
              ? '删除会移除容器实例，用户环境将在下次访问时重建；正在运行的任务会中断。'
              : '当前用户正在运行的任务可能中断，环境会在下次访问时恢复或重建。'}
          </p>
        </div>
      ),
    })
    if (!ok) return
    // remove 二次确认（破坏更强）。
    if (action === 'remove') {
      const again = await confirm({
        title: '再次确认删除',
        danger: true,
        confirmText: '确认删除',
        body: (
          <p className="text-[13px] text-muted">
            该操作不可撤销。确认删除容器 <span className="font-medium text-fg">#{c.id}</span>？
          </p>
        ),
      })
      if (!again) return
    }
    setBusyId(c.id)
    try {
      await adminSend('POST', `/agent-containers/${c.id}/${action}`)
      toast(`#${c.id} 已${ACTION_LABEL[action]}`, 'success')
      refreshAll()
    } catch (e) {
      toast(`失败：${e instanceof ApiError ? e.message : String(e)}`, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const columns: Column<ContainerRow>[] = [
    {
      key: 'id',
      title: 'id',
      cellClassName: 'font-mono tabular-nums',
      render: (c) => c.id,
    },
    {
      key: 'row_kind',
      title: '类型',
      render: (c) => (
        <Badge tone={c.row_kind === 'v3' ? 'success' : 'neutral'}>{c.row_kind || '?'}</Badge>
      ),
    },
    {
      key: 'user',
      title: '用户',
      render: (c) => {
        const expiry = subscriptionExpiryChip(c)
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-fg">{c.user_email || `#${c.user_id}`}</span>
              {c.user_email && (
                <span className="shrink-0 font-mono text-[11px] text-faint">#{c.user_id}</span>
              )}
            </div>
            {(c.last_error || expiry) && (
              <div className="mt-1 flex flex-wrap gap-1">
                {c.last_error && (
                  <Tooltip content={c.last_error}>
                    <span>
                      <Badge tone="danger">最近出错</Badge>
                    </span>
                  </Tooltip>
                )}
                {expiry && (
                  <Tooltip content={expiry.title}>
                    <span>
                      <Badge tone={expiry.tone}>{expiry.label}</Badge>
                    </span>
                  </Tooltip>
                )}
              </div>
            )}
          </div>
        )
      },
    },
    {
      key: 'lifecycle',
      title: '生命周期',
      render: (c) => <Badge tone={containerStatusTone(lifecycleOf(c))}>{lifecycleOf(c)}</Badge>,
    },
    {
      key: 'image',
      title: '镜像',
      render: (c) => (
        <Tooltip content={c.image || ''}>
          <span className="font-mono text-[12px] text-muted">{imageTag(c.image)}</span>
        </Tooltip>
      ),
    },
    {
      key: 'docker',
      title: 'docker',
      render: (c) => {
        const ref =
          c.row_kind === 'v2' ? c.docker_name || '—' : (c.docker_id || '').slice(0, 12) || '—'
        return <span className="font-mono text-[12px] text-muted">{ref}</span>
      },
    },
    {
      key: 'host',
      title: '虚机',
      render: (c) =>
        c.host_uuid ? (
          <button
            type="button"
            title={`查看虚机 ${c.host_uuid}`}
            onClick={() => navigate('hosts', { focus_uuid: c.host_uuid ?? '' })}
            className="max-w-[9rem] truncate font-mono text-[12px] text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {c.host_name || c.host_uuid.slice(0, 8)}
          </button>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'last_started_at',
      title: '最近启动',
      render: (c) =>
        c.last_started_at ? (
          <TimeAgo value={c.last_started_at} />
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'last_stopped_at',
      title: '最近停止',
      render: (c) =>
        c.last_stopped_at ? (
          <TimeAgo value={c.last_stopped_at} />
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    {
      key: 'actions',
      title: '操作',
      align: 'right',
      render: (c) => {
        const busy = busyId === c.id
        return (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLogsFor({ id: c.id, label: `#${c.id} ${c.user_email ?? ''}` })}
            >
              日志
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => runAction(c, 'restart')}
            >
              {busy ? <Spinner size={13} /> : '重启'}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => runAction(c, 'stop')}>
              停止
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-danger hover:bg-danger-soft"
              onClick={() => runAction(c, 'remove')}
            >
              删除
            </Button>
          </div>
        )
      },
    },
  ]

  const s = stats.data
  const tones = s ? kpiTones(s) : null

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={meta.desc}
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={refreshAll}
            disabled={list.loading || stats.loading}
          >
            {list.loading || stats.loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
            刷新
          </Button>
        }
      />

      {/* KPI */}
      <StatCardRow>
        <StatCard
          label="总容器"
          icon={Boxes}
          loading={stats.loading}
          value={s ? s.total.toLocaleString() : '—'}
          hint={
            s ? `v2 ${s.v2} · v3 ${s.v3} · 已清理 ${s.gone}` : stats.error ? '加载失败' : undefined
          }
        />
        <StatCard
          label="运行中"
          icon={PlayCircle}
          tone={tones?.running ?? 'neutral'}
          loading={stats.loading}
          value={s ? s.running.toLocaleString() : '—'}
          hint={s ? `provisioning ${s.provisioning} · stopped ${s.stopped}` : undefined}
        />
        <StatCard
          label="错误 / 曾报错"
          icon={CircleAlert}
          tone={tones?.error ?? 'neutral'}
          loading={stats.loading}
          value={s ? `${s.error} / ${s.with_last_error}` : '—'}
          hint="error 态 / 曾有 last_error"
        />
        <StatCard
          label="7d 订阅到期"
          icon={TimerReset}
          tone={tones?.expiring ?? 'neutral'}
          loading={stats.loading}
          value={s ? s.expiring_7d.toLocaleString() : '—'}
          hint={s ? (s.expiring_7d > 0 ? '需关注续订' : '暂无到期风险') : undefined}
        />
      </StatCardRow>

      {/* 状态构成 donut + 镜像版本分布 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <StatusDonut stats={s} loading={stats.loading} />
        <ImageDistCard rows={rows} loading={list.loading} />
      </div>

      {/* 列表 */}
      <SectionCard
        title="Agent 容器"
        hint={
          list.loading
            ? '加载中…'
            : q
              ? `共 ${filtered.length} / ${rows.length} 条（过滤中）`
              : `共 ${rows.length} 条`
        }
        bodyClassName="flex flex-col gap-3"
      >
        <FilterBar>
          <SelectFilter
            label="生命周期"
            value={statusFilter}
            options={STATUS_OPTIONS}
            onChange={(v) => patchRoute({ status: v })}
          />
          <SearchInput
            value={userQuery}
            onChange={setUserQuery}
            placeholder="email / user_id 过滤"
          />
          {hostFilter && (
            <Button variant="ghost" size="sm" onClick={() => patchRoute({ host_uuid: '' })}>
              <X size={14} />
              清除虚机过滤
            </Button>
          )}
        </FilterBar>

        {hostFilter && (
          <div className="flex items-center gap-2 text-[12px] text-faint">
            <span>虚机过滤：</span>
            <CopyChip value={hostFilter} />
          </div>
        )}

        {list.error ? (
          <p className="px-1 py-8 text-center text-[13px] text-danger">
            加载失败：{list.error instanceof ApiError ? list.error.message : String(list.error)}
          </p>
        ) : (
          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(c) => String(c.id)}
            loading={list.loading}
            emptyTitle="无匹配容器"
            emptyHint={q || statusFilter || hostFilter ? '调整或清除过滤条件后重试' : undefined}
          />
        )}
      </SectionCard>

      <ContainerLogsModal
        id={logsFor?.id ?? null}
        label={logsFor?.label ?? ''}
        onClose={() => setLogsFor(null)}
      />
      {confirmEl}
    </div>
  )
}

/** 容器状态构成 donut（running/provisioning/stopped/error，仅 >0）。 */
function StatusDonut({ stats, loading }: { stats: ContainerStats | null; loading: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const present = stats
    ? DONUT_STATES.map((d) => ({ ...d, value: Number(stats[d.key]) || 0 })).filter(
        (d) => d.value > 0,
      )
    : []
  useChart(
    canvasRef,
    (theme) =>
      donutConfig(theme, {
        labels: present.map((d) => d.label),
        data: present.map((d) => d.value),
        colorTokens: present.map((d) => d.token),
      }),
    [stats],
  )
  return (
    <ChartCard title="容器状态构成" hint="running / provisioning / stopped / error" height={240}>
      {loading ? (
        <div className="flex h-full items-center justify-center">
          <Spinner size={20} className="text-muted" />
        </div>
      ) : present.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[13px] text-faint">无容器</div>
      ) : (
        <canvas ref={canvasRef} />
      )}
    </ChartCard>
  )
}

/** 运行镜像版本分布（按当前已加载行聚合 image tag，漂移一眼可见）。 */
function ImageDistCard({ rows, loading }: { rows: ContainerRow[]; loading: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dist = useMemo(() => imageDistribution(rows).slice(0, 8), [rows])
  useChart(
    canvasRef,
    (theme) =>
      barConfig(theme, {
        labels: dist.map((d) => d.tag),
        series: [{ label: '容器数', data: dist.map((d) => d.count) }],
        horizontal: true,
      }),
    [rows],
  )
  return (
    <ChartCard
      title="运行镜像版本分布"
      hint={dist.length > 1 ? `${dist.length} 个镜像 tag（存在漂移）` : '当前加载的容器'}
      height={240}
    >
      {loading ? (
        <div className="flex h-full items-center justify-center">
          <Spinner size={20} className="text-muted" />
        </div>
      ) : dist.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[13px] text-faint">无数据</div>
      ) : (
        <canvas ref={canvasRef} />
      )}
    </ChartCard>
  )
}
