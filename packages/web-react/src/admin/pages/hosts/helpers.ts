import type { HostRow, HostStatus } from './types'

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
export type MeterTone = 'success' | 'warning' | 'danger' | 'neutral'

// 资源水位阈值。磁盘 / 内存对齐 alerts_disk_high_warn/critical_pct（默认 85/95），
// 保证「UI 变黄 = 已发/将发告警」语义一致（vanilla 同口径，不用泛化的 80/90）。
export const DISK_WARN_PCT = 85
export const DISK_DANGER_PCT = 95
export const MEM_WARN_PCT = 85
export const MEM_DANGER_PCT = 95
// load1/cpu 比值阈值（vanilla：>=1.5 danger，>=1.0 warning）。
export const LOAD_WARN_RATIO = 1.0
export const LOAD_DANGER_RATIO = 1.5
// metrics 超过 10min 未刷新视为 stale。
export const METRICS_STALE_MS = 10 * 60 * 1000

/** 百分位 → 水位色。 */
export function pctTone(v: number | null | undefined, warn: number, danger: number): MeterTone {
  if (v === null || v === undefined) return 'neutral'
  if (v >= danger) return 'danger'
  if (v >= warn) return 'warning'
  return 'success'
}

/** load1/cpu 比值 → 色 + 展示串。 */
export function loadMeter(h: HostRow): { tone: MeterTone; ratio: number | null; label: string } {
  if (h.load1 === null || h.load1 === undefined) return { tone: 'neutral', ratio: null, label: '—' }
  const cpu = (h.cpu_count ?? 0) || 1
  const ratio = h.load1 / cpu
  const tone: MeterTone =
    ratio >= LOAD_DANGER_RATIO ? 'danger' : ratio >= LOAD_WARN_RATIO ? 'warning' : 'success'
  return { tone, ratio, label: `${h.load1.toFixed(2)} / ${cpu} cpu` }
}

/** metrics 是否过期（null 或 > 10min）。 */
export function metricsStale(h: HostRow): boolean {
  const at = h.metrics_at ? Date.parse(h.metrics_at) : Number.NaN
  return !Number.isFinite(at) || Date.now() - at > METRICS_STALE_MS
}

/** host 状态 → 徽标色。 */
export function hostStatusTone(status: HostStatus): BadgeTone {
  switch (status) {
    case 'ready':
      return 'success'
    case 'bootstrapping':
    case 'draining':
    case 'quarantined':
      return 'warning'
    case 'broken':
    case 'removed':
    case 'revoked':
      return 'danger'
    default:
      return 'neutral'
  }
}

/** 到期/证书天数 chip 派生：null / 已过期 / 剩余天数 + 色。 */
export type DaysChip = { tone: BadgeTone; label: string; title: string } | null

export function daysUntilChip(iso: string | null | undefined, warnDays = 7): DaysChip {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  const title = new Date(iso).toLocaleString('zh-CN')
  if (Number.isNaN(ms)) return { tone: 'neutral', label: iso, title: iso }
  const days = Math.floor(ms / 86_400_000)
  if (days < 0) return { tone: 'danger', label: '已过期', title }
  if (days < warnDays) return { tone: 'warning', label: `${days}d`, title }
  return { tone: 'neutral', label: `${days}d`, title }
}

/** 该 host 可执行的动作（对齐 vanilla 判定）。 */
export function hostActions(h: HostRow): {
  isSelf: boolean
  canDrain: boolean
  canRemove: boolean
  canClearQuarantine: boolean
} {
  const isSelf = h.name === 'self'
  return {
    isSelf,
    canDrain:
      !isSelf && (h.status === 'ready' || h.status === 'quarantined' || h.status === 'broken'),
    canRemove: !isSelf && h.status === 'draining' && (h.active_containers ?? 0) === 0,
    canClearQuarantine: h.status === 'quarantined',
  }
}

/**
 * placement gate 关闭时的诊断/可能原因（本地观测，与后端 predicate 可能秒级偏差）。
 * gate open / 字段缺失时返回空数组（调用方不渲染 chip）。
 */
export function gateClosedReasons(h: HostRow): string[] {
  if (h.placement_gate_open !== false) return []
  const reasons: string[] = []
  if (h.status !== 'ready') reasons.push(`状态 = ${h.status}（非 ready）`)
  if (h.desired_image_id == null) reasons.push('desired_image_id 未初始化（pool 还在 warmup?）')
  else if (h.loaded_image_id == null)
    reasons.push('loaded_image_id 未上报（node-agent selfprobe 没跑过）')
  else if (h.loaded_image_id !== h.desired_image_id) {
    reasons.push(
      `镜像不一致: loaded=${(h.loaded_image_id || '').slice(0, 19)}… ≠ desired=${(h.desired_image_id || '').slice(0, 19)}…`,
    )
  }
  if (h.name !== 'self') {
    const nowMs = Date.now()
    const FRESH_MS = 60 * 1000
    const checkDim = (label: string, ok: boolean | null, atIso: string | null) => {
      if (ok === false) reasons.push(`${label} = false`)
      else if (ok == null) reasons.push(`${label} 未上报`)
      else if (atIso == null) reasons.push(`${label} timestamp 未上报`)
      else {
        const t = new Date(atIso).getTime()
        if (Number.isFinite(t) && nowMs - t > FRESH_MS) {
          reasons.push(`${label} 过期（${Math.round((nowMs - t) / 1000)}s 前）`)
        }
      }
    }
    checkDim('health endpoint', h.last_health_endpoint_ok, h.last_health_poll_at)
    checkDim('uplink', h.last_uplink_ok, h.last_uplink_at)
    checkDim('egress', h.last_egress_probe_ok, h.last_egress_probe_at)
  }
  return reasons
}

// ─── 北京时间 (UTC+8) ↔ datetime-local / ISO 转换（对齐 vanilla） ────────

/** ISO8601(UTC) → datetime-local 控件消费的北京墙钟串 `YYYY-MM-DDTHH:mm`。 */
export function isoToShanghaiInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const sh = new Date(d.getTime() + 8 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${sh.getUTCFullYear()}-${pad(sh.getUTCMonth() + 1)}-${pad(sh.getUTCDate())}T${pad(sh.getUTCHours())}:${pad(sh.getUTCMinutes())}`
}

/** datetime-local(`YYYY-MM-DDTHH:mm`, 北京时区) → ISO8601 with +08:00 offset。空 → null。 */
export function shanghaiInputToIso(val: string | null | undefined): string | null {
  const s = (val ?? '').trim()
  if (!s) return null
  return `${s}:00+08:00`
}

/** distribute-image outcome → 徽标色。 */
export function distributeOutcomeTone(outcome: string): BadgeTone {
  switch (outcome) {
    case 'loaded':
      return 'success'
    case 'already':
      return 'info'
    case 'skipped':
      return 'neutral'
    default:
      return 'danger'
  }
}
