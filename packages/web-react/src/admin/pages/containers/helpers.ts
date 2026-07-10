import type { StatTone } from '../../components'
import type { ContainerRow, ContainerStats } from './types'

/** 生命周期可选值（对齐 vanilla CONTAINER_STATUSES，供状态下拉）。 */
export const CONTAINER_STATUSES = [
  'provisioning',
  'running',
  'stopped',
  'removed',
  'error',
] as const

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'

/**
 * 容器生命周期 → 语义徽标色。
 * running=success / provisioning=warning / error=danger / stopped·removed=neutral。
 * LevelBadge 只认 active/ok 等词，容器状态词（running/provisioning…）不在其表里，
 * 故本页自带映射，与状态构成 donut 的配色一致。
 */
export function containerStatusTone(status: string | null | undefined): BadgeTone {
  switch ((status ?? '').toLowerCase()) {
    case 'running':
      return 'success'
    case 'provisioning':
      return 'warning'
    case 'error':
      return 'danger'
    default:
      return 'neutral'
  }
}

/** 取容器当前展示的生命周期（lifecycle 优先，回落 status/state）。 */
export function lifecycleOf(c: ContainerRow): string {
  return c.lifecycle || c.status || c.state || '—'
}

/** 镜像全路径 → tag 段（取最后一段 registry/repo:tag → repo:tag），用于版本漂移聚合。 */
export function imageTag(image: string | null | undefined): string {
  const s = (image ?? '').trim()
  if (!s) return '—'
  return s.split('/').pop() || s
}

/** 按 image tag 聚合行数（降序），用于「运行镜像版本分布」卡。 */
export function imageDistribution(rows: ContainerRow[]): { tag: string; count: number }[] {
  const map = new Map<string, number>()
  for (const r of rows) {
    const t = imageTag(r.image)
    map.set(t, (map.get(t) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
}

/** 订阅到期风险 chip（仅 v2 且 active）：过期 danger / 7d 内 warning / 否则无。 */
export type ExpiryChip = { tone: BadgeTone; label: string; title: string }

export function subscriptionExpiryChip(c: ContainerRow): ExpiryChip | null {
  if (c.row_kind !== 'v2' || c.subscription_status !== 'active' || !c.subscription_end_at) {
    return null
  }
  const end = new Date(c.subscription_end_at).getTime()
  if (Number.isNaN(end)) return null
  const days = (end - Date.now()) / 86_400_000
  const title = new Date(c.subscription_end_at).toLocaleString('zh-CN')
  if (days < 0) return { tone: 'danger', label: '订阅已过期', title }
  if (days < 7) return { tone: 'warning', label: `${Math.ceil(days)}d 内到期`, title }
  return null
}

/** KPI 卡色调派生（集中，页面只读结果）。 */
export function kpiTones(s: ContainerStats): {
  running: StatTone
  error: StatTone
  expiring: StatTone
} {
  return {
    running: s.provisioning > 5 ? 'warning' : 'success',
    error: s.error > 0 ? 'danger' : s.with_last_error > 0 ? 'warning' : 'success',
    expiring: s.expiring_7d > 0 ? 'warning' : 'success',
  }
}
