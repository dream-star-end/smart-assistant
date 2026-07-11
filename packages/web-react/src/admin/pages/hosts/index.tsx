import { Gauge, PackageCheck, Plus, RefreshCw, Server, ServerCog } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Badge, Button, Spinner, Tooltip, useConfirm, useToast } from '../../../components/ui'
import {
  ChartCard,
  PageHeader,
  SectionCard,
  StatCard,
  StatCardRow,
  barConfig,
  useChart,
} from '../../components'
import { adminGet, adminSend, apiErrorMessage } from '../../lib/adminApi'
import { useAdminPoll } from '../../lib/useAdminPoll'
import { getAdminPage } from '../../registry'
import { useAdminRoute } from '../../router'
import { HostCard } from './HostCard'
import {
  AddHostModal,
  BootstrapLogModal,
  DiagnosticModal,
  DistributeImageModal,
  SetExpiresModal,
} from './modals'
import type { BaselineView, HostRow } from './types'

// 虚机池：原版有自动刷新，brief 指定 30s（bootstrap/health 状态自行推进，UI 跟上；
// baseline-version 每次 SSH RPC 每台 host，30s 比 vanilla 的 5s 大幅减轻探测负载）。
const POLL_MS = 30_000

type ModalTarget = { id: string; name: string }

export default function HostsPage() {
  const meta = getAdminPage('hosts')
  const { params, navigate } = useAdminRoute()
  const toast = useToast()
  const [confirm, confirmEl] = useConfirm()

  const focusUuid = params.focus_uuid ?? ''
  const [addOpen, setAddOpen] = useState(false)
  const [distributeOpen, setDistributeOpen] = useState(false)
  const [bootstrapFor, setBootstrapFor] = useState<ModalTarget | null>(null)
  const [diagFor, setDiagFor] = useState<ModalTarget | null>(null)
  const [expiresFor, setExpiresFor] = useState<{
    id: string
    name: string
    current: string | null
  } | null>(null)

  const list = useAdminPoll(() => adminGet<{ hosts: HostRow[] }>('/v3/compute-hosts'), {
    intervalMs: POLL_MS,
  })
  const baseline = useAdminPoll(() => adminGet<BaselineView>('/v3/baseline-version'), {
    intervalMs: POLL_MS,
  })

  const rows = list.data?.hosts ?? []

  const kpis = useMemo(() => {
    let ready = 0
    let gateOpen = 0
    let attention = 0
    let used = 0
    let capacity = 0
    for (const h of rows) {
      if (h.status === 'ready') ready++
      if (h.placement_gate_open === true) gateOpen++
      if (h.status === 'draining' || h.status === 'quarantined' || h.status === 'broken')
        attention++
      used += h.active_containers | 0
      capacity += h.max_containers | 0
    }
    return { ready, gateOpen, attention, used, capacity }
  }, [rows])

  const refreshAll = () => {
    list.refresh()
    baseline.refresh()
  }

  // ── 破坏性动作（drain / remove / clear-quarantine） ──
  const hostAction = async (
    h: HostRow,
    action: 'drain' | 'remove' | 'quarantine-clear',
    opts: { title: string; body: string; danger: boolean; okToast: string },
  ) => {
    const ok = await confirm({
      title: opts.title,
      danger: opts.danger,
      body: <p className="whitespace-pre-line text-[13px] text-muted">{opts.body}</p>,
    })
    if (!ok) return
    try {
      await adminSend('POST', `/v3/compute-hosts/${encodeURIComponent(h.id)}/${action}`, {})
      toast(opts.okToast, 'success')
      refreshAll()
    } catch (e) {
      toast(`失败：${apiErrorMessage(e, '请求失败')}`, 'error')
    }
  }

  const onDrain = (h: HostRow) =>
    hostAction(h, 'drain', {
      title: `排空虚机 ${h.name}`,
      body: `Host: ${h.name}\n影响: 新容器不会再调度到它，已有容器继续运行。`,
      danger: false,
      okToast: `${h.name} 已进入 draining`,
    })
  const onRemove = (h: HostRow) =>
    hostAction(h, 'remove', {
      title: `删除虚机 ${h.name}`,
      body: `Host: ${h.name}\n要求: draining 且 active=0。\n影响: 不可逆，删除后不能再调度到该虚机。`,
      danger: true,
      okToast: `${h.name} 已删除`,
    })
  const onClearQuarantine = (h: HostRow) =>
    hostAction(h, 'quarantine-clear', {
      title: `解除隔离 ${h.name}`,
      body: `Host: ${h.name}\n影响: 之后新容器可能重新调度到它。请确认故障已恢复。`,
      danger: false,
      okToast: `${h.name} 已解除隔离`,
    })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={meta.title}
        desc={meta.desc}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={refreshAll} disabled={list.loading}>
              {list.loading ? <Spinner size={14} /> : <RefreshCw size={14} />}
              刷新
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setDistributeOpen(true)}>
              <ServerCog size={14} />
              分发镜像
            </Button>
            <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
              <Plus size={14} />
              添加虚机
            </Button>
          </>
        }
      />

      {/* KPI */}
      <StatCardRow>
        <StatCard
          label="总虚机"
          icon={Server}
          loading={list.loading}
          value={rows.length.toLocaleString()}
          hint={`${kpis.gateOpen} 可调度（gate open）`}
        />
        <StatCard
          label="就绪"
          icon={PackageCheck}
          tone={rows.length > 0 && kpis.ready === 0 ? 'danger' : 'success'}
          loading={list.loading}
          value={kpis.ready.toLocaleString()}
          hint="status = ready"
        />
        <StatCard
          label="排空 / 隔离 / 故障"
          icon={ServerCog}
          tone={kpis.attention > 0 ? 'warning' : 'success'}
          loading={list.loading}
          value={kpis.attention.toLocaleString()}
          hint="draining · quarantined · broken"
        />
        <StatCard
          label="容量占用"
          icon={Gauge}
          tone={
            kpis.capacity > 0 && kpis.used / kpis.capacity >= 0.9
              ? 'danger'
              : kpis.capacity > 0 && kpis.used / kpis.capacity >= 0.75
                ? 'warning'
                : 'neutral'
          }
          loading={list.loading}
          value={`${kpis.used} / ${kpis.capacity}`}
          hint={
            kpis.capacity > 0 ? `${Math.round((kpis.used / kpis.capacity) * 100)}% 已用` : '无容量'
          }
        />
      </StatCardRow>

      {/* baseline 版本卡 */}
      <BaselineCard baseline={baseline.data} loading={baseline.loading} />

      {/* 利用率堆叠柱 */}
      <UtilizationChart
        rows={rows}
        loading={list.loading}
        used={kpis.used}
        capacity={kpis.capacity}
      />

      {/* host 卡片网格 */}
      {list.error ? (
        <SectionCard title="虚机列表">
          <p className="py-6 text-center text-[13px] text-danger">
            加载失败：{apiErrorMessage(list.error, '加载失败')}
          </p>
        </SectionCard>
      ) : list.loading && rows.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-56 animate-pulse rounded-xl border border-border bg-surface"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <SectionCard title="虚机列表">
          <p className="py-10 text-center text-[13px] text-faint">
            无虚机，点右上「添加虚机」接入。
          </p>
        </SectionCard>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {rows.map((h) => (
            <HostCard
              key={h.id}
              host={h}
              focused={focusUuid !== '' && h.id === focusUuid}
              onOpenContainers={(hostId) => navigate('containers', { host_uuid: hostId })}
              onBootstrapLog={(x) => setBootstrapFor({ id: x.id, name: x.name })}
              onDiagnostic={(x) => setDiagFor({ id: x.id, name: x.name })}
              onDrain={onDrain}
              onRemove={onRemove}
              onClearQuarantine={onClearQuarantine}
              onSetExpires={(x) => setExpiresFor({ id: x.id, name: x.name, current: x.expires_at })}
            />
          ))}
        </div>
      )}

      {/* modals */}
      <AddHostModal
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={(id, name) => {
          setBootstrapFor({ id, name })
          refreshAll()
        }}
      />
      <DistributeImageModal
        open={distributeOpen}
        onOpenChange={setDistributeOpen}
        hosts={rows}
        onDone={refreshAll}
      />
      <BootstrapLogModal
        hostId={bootstrapFor?.id ?? null}
        name={bootstrapFor?.name ?? ''}
        onClose={() => setBootstrapFor(null)}
      />
      <DiagnosticModal
        hostId={diagFor?.id ?? null}
        name={diagFor?.name ?? ''}
        onClose={() => setDiagFor(null)}
      />
      <SetExpiresModal
        target={expiresFor}
        onClose={() => setExpiresFor(null)}
        onSaved={refreshAll}
      />
      {confirmEl}
    </div>
  )
}

/** baseline 版本卡：master 版本 + 每台 remote host 已同步版本 chip（match/mismatch/err）。 */
function BaselineCard({ baseline, loading }: { baseline: BaselineView | null; loading: boolean }) {
  return (
    <SectionCard title="Baseline 版本" hint="master 当前 baseline 与各 host 已同步版本对比">
      {loading && !baseline ? (
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <Spinner size={14} /> 加载中…
        </div>
      ) : !baseline ? (
        <p className="text-[13px] text-faint">—</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
          <span className="text-faint">master</span>
          {baseline.master_version ? (
            <code className="rounded bg-hover px-1.5 py-0.5 font-mono text-[12px] text-fg">
              {baseline.master_version}
            </code>
          ) : (
            <span className="text-danger">
              未初始化{baseline.master_err ? ` · ${baseline.master_err}` : ''}
            </span>
          )}
          <span className="text-border">|</span>
          <span className="text-faint">per-host</span>
          {baseline.per_host.length === 0 ? (
            <span className="text-faint">（暂无远程虚机）</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {baseline.per_host.map((h) => {
                const match =
                  baseline.master_version && h.remote_version === baseline.master_version
                const tone = h.err ? 'danger' : match ? 'success' : 'warning'
                const label = h.err ? `${h.name}: ERR` : `${h.name}: ${h.remote_version || '—'}`
                return (
                  <Tooltip key={h.host_id} content={h.err || h.remote_version || ''}>
                    <span>
                      <Badge tone={tone}>{label}</Badge>
                    </span>
                  </Tooltip>
                )
              })}
            </div>
          )}
        </div>
      )}
    </SectionCard>
  )
}

/** per-host 利用率堆叠柱（已用 / 剩余），与卡片同源 rows。 */
function UtilizationChart({
  rows,
  loading,
  used,
  capacity,
}: {
  rows: HostRow[]
  loading: boolean
  used: number
  capacity: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const data = useMemo(() => {
    const labels: string[] = []
    const usedData: number[] = []
    const freeData: number[] = []
    for (const h of rows) {
      labels.push((h.name || h.id || '').slice(0, 16))
      const active = h.active_containers | 0
      const max = h.max_containers | 0
      usedData.push(active)
      freeData.push(Math.max(0, max - active))
    }
    return { labels, usedData, freeData }
  }, [rows])

  useChart(
    canvasRef,
    (theme) =>
      barConfig(theme, {
        labels: data.labels,
        stacked: true,
        series: [
          { label: '已用', data: data.usedData },
          { label: '剩余', data: data.freeData, colorToken: 'muted' },
        ],
      }),
    [rows],
  )

  return (
    <ChartCard
      title="虚机利用率分布"
      hint={capacity > 0 ? `已用 ${used} / 容量 ${capacity}` : '—'}
      height={260}
    >
      {loading && rows.length === 0 ? (
        <div className="flex h-full items-center justify-center">
          <Spinner size={20} className="text-muted" />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex h-full items-center justify-center text-[13px] text-faint">无虚机</div>
      ) : (
        <canvas ref={canvasRef} />
      )}
    </ChartCard>
  )
}
