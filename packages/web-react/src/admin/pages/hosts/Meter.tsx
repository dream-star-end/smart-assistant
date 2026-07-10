import type { ReactNode } from 'react'
import { cn } from '../../../lib/utils'
import type { MeterTone } from './helpers'

// 地基 Progress 原语填充固定为极光渐变，无法按阈值着色 —— 资源水位必须用色区分
// 安全/警告/危险，故本页自带 tone-able Meter（同视觉语言：track bg-hover + 阈值色填充）。
// 见报告「地基缺口」：建议 Progress 增加 tone / fillClassName。
const FILL: Record<MeterTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-faint',
}

/**
 * 阈值着色水位条：label + 右侧数值 + 底部彩条。value/max 归一为百分比（clamp 0–100）。
 * 无数据（value=null）→ 灰条 + 「—」。
 */
export function Meter({
  label,
  value,
  max = 100,
  display,
  tone,
  className,
}: {
  label: ReactNode
  /** 0–max；null = 无数据。 */
  value: number | null | undefined
  max?: number
  /** 右侧展示文本（缺省 `${value}%`）。 */
  display?: ReactNode
  tone: MeterTone
  className?: string
}) {
  const has = value !== null && value !== undefined && Number.isFinite(value)
  const pct = has ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px]">
        <span className="truncate text-faint">{label}</span>
        <span className="shrink-0 font-medium tabular-nums text-fg">
          {has ? (display ?? `${value}%`) : '—'}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
        <div
          className={cn('h-full rounded-full transition-[width] duration-300', FILL[tone])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
