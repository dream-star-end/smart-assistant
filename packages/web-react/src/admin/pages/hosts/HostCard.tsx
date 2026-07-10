import { useEffect, useRef } from 'react'
import { Badge, Button, Card, Tooltip } from '../../../components/ui'
import { cn } from '../../../lib/utils'
import { TimeAgo } from '../../components'
import { Meter } from './Meter'
import {
  DISK_DANGER_PCT,
  DISK_WARN_PCT,
  MEM_DANGER_PCT,
  MEM_WARN_PCT,
  daysUntilChip,
  gateClosedReasons,
  hostActions,
  hostStatusTone,
  loadMeter,
  metricsStale,
  pctTone,
} from './helpers'
import type { HostRow } from './types'

type HostCardProps = {
  host: HostRow
  focused: boolean
  onOpenContainers: (hostId: string) => void
  onBootstrapLog: (h: HostRow) => void
  onDiagnostic: (h: HostRow) => void
  onDrain: (h: HostRow) => void
  onRemove: (h: HostRow) => void
  onClearQuarantine: (h: HostRow) => void
  onSetExpires: (h: HostRow) => void
}

export function HostCard({
  host: h,
  focused,
  onOpenContainers,
  onBootstrapLog,
  onDiagnostic,
  onDrain,
  onRemove,
  onClearQuarantine,
  onSetExpires,
}: HostCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  // 深链跳转时高亮 + 滚动到视图。
  useEffect(() => {
    if (focused && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [focused])

  const { isSelf, canDrain, canRemove, canClearQuarantine } = hostActions(h)
  const load = loadMeter(h)
  const stale = metricsStale(h)
  const gateReasons = gateClosedReasons(h)
  const cert = daysUntilChip(h.cert_not_after)
  const vps = daysUntilChip(h.expires_at)
  const okN = h.consecutive_health_ok | 0
  const failN = h.consecutive_health_fail | 0

  return (
    <div ref={ref}>
      <Card
        className={cn(
          'flex flex-col gap-3.5 p-4 transition-shadow',
          focused && 'ring-2 ring-accent',
        )}
      >
        {/* 头部 */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-semibold text-fg">{h.name}</span>
              {isSelf && <span className="shrink-0 text-[11px] text-faint">(master)</span>}
            </div>
            <p className="mt-0.5 truncate font-mono text-[11.5px] text-faint">
              {h.host}:{h.ssh_port}
              {h.agent_port && h.agent_port !== 9443 ? ` · agent ${h.agent_port}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
            <Badge tone={hostStatusTone(h.status)}>{h.status}</Badge>
            {h.placement_gate_open === true && (
              <Tooltip content="placement gate 通过 — 调度会考虑这台 host">
                <span>
                  <Badge tone="success">gate open</Badge>
                </span>
              </Tooltip>
            )}
            {h.placement_gate_open === false && (
              <Tooltip
                content={
                  gateReasons.length > 0
                    ? `诊断/可能原因（以后端为准）：\n- ${gateReasons.join('\n- ')}`
                    : 'placement gate 关闭，但无法定位具体维度'
                }
              >
                <span>
                  <Badge tone="warning">gate closed</Badge>
                </span>
              </Tooltip>
            )}
          </div>
        </div>

        {/* 资源水位 */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <Meter
            label="磁盘"
            value={h.disk_pct}
            tone={pctTone(h.disk_pct, DISK_WARN_PCT, DISK_DANGER_PCT)}
          />
          <Meter
            label="内存"
            value={h.mem_pct}
            tone={pctTone(h.mem_pct, MEM_WARN_PCT, MEM_DANGER_PCT)}
          />
          <Meter
            label="负载"
            value={h.load1}
            max={((h.cpu_count ?? 0) || 1) * 2}
            display={h.load1 !== null ? `L${h.load1.toFixed(2)}` : undefined}
            tone={load.tone}
          />
        </div>

        {/* slots + 5min 请求 + stale */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <button
            type="button"
            title="查看该 host 上的容器"
            onClick={() => onOpenContainers(h.id)}
            className="text-[12.5px] tabular-nums text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            slots {h.active_containers | 0} / {h.max_containers | 0}
          </button>
          <span
            className="text-[12px] text-faint tabular-nums"
            title="过去 5 分钟 /v1/messages 请求数"
          >
            {h.req_5m | 0} req/5m
          </span>
          <span className="text-[12px] text-faint tabular-nums" title={load.label}>
            {(h.cpu_count ?? 0) || '—'} cpu
          </span>
          {stale && (
            <span className="text-[11px] text-warning" title="metrics 超过 10 分钟未刷新">
              metrics stale
            </span>
          )}
        </div>

        {/* 到期 / 健康 / bootstrap chips */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-[12px]">
          <div className="flex items-center gap-1.5">
            <span className="text-faint">cert</span>
            {cert ? (
              <Tooltip content={cert.title}>
                <span>
                  <Badge tone={cert.tone}>{cert.label}</Badge>
                </span>
              </Tooltip>
            ) : (
              <span className="text-faint">—</span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-faint">VPS</span>
            <button type="button" onClick={() => onSetExpires(h)} title="点击设置/编辑 VPS 到期">
              {vps ? (
                <Badge tone={vps.tone}>{vps.label}</Badge>
              ) : (
                <Badge tone="neutral">设置</Badge>
              )}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-faint">健康</span>
            {h.last_health_ok === true ? (
              <Tooltip
                content={h.last_health_at ? new Date(h.last_health_at).toLocaleString('zh-CN') : ''}
              >
                <span>
                  <Badge tone="success">OK</Badge>
                </span>
              </Tooltip>
            ) : h.last_health_ok === false ? (
              <Tooltip content={h.last_health_err || ''}>
                <span>
                  <Badge tone="danger">FAIL</Badge>
                </span>
              </Tooltip>
            ) : (
              <span className="text-faint">—</span>
            )}
            {(okN > 0 || failN > 0) && (
              <span
                className="text-[11px] text-faint tabular-nums"
                title="连续 OK / 连续 FAIL（各 3 次切换状态）"
              >
                {okN}/{failN}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-faint">bootstrap</span>
            {h.last_bootstrap_err ? (
              <Tooltip content={h.last_bootstrap_err}>
                <span>
                  <Badge tone="danger">ERR</Badge>
                </span>
              </Tooltip>
            ) : h.last_bootstrap_at ? (
              <Badge tone="success">OK</Badge>
            ) : (
              <span className="text-faint">—</span>
            )}
          </div>
          {h.last_health_at && (
            <span className="text-faint">
              最近健康 <TimeAgo value={h.last_health_at} />
            </span>
          )}
        </div>

        {/* 动作 */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
          <Button variant="ghost" size="sm" onClick={() => onBootstrapLog(h)}>
            日志
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDiagnostic(h)}>
            诊断
          </Button>
          {canClearQuarantine && (
            <Button variant="ghost" size="sm" onClick={() => onClearQuarantine(h)}>
              解除隔离
            </Button>
          )}
          {canDrain && (
            <Button variant="ghost" size="sm" onClick={() => onDrain(h)}>
              排空
            </Button>
          )}
          {canRemove && (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger hover:bg-danger-soft"
              onClick={() => onRemove(h)}
            >
              删除
            </Button>
          )}
        </div>
      </Card>
    </div>
  )
}
