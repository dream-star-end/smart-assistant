import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * 面板统一头部：标题 + 可选说明 + 可选右侧操作。管理中心/市场各分区共用，
 * 保证分区结构一致。业务文案由调用方传入，本组件只管排版。
 */
export function PanelHeader({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 py-3.5">
      <div className="min-w-0">
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        {hint && <p className="mt-0.5 text-[11.5px] leading-snug text-faint">{hint}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/**
 * 面板统一空状态：accent 图标芯片 + 标题 + 说明 + 可选行动按钮。
 * 跨管理中心/市场复用，替代各面板手写的纯文本空态。
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-5 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <Icon size={20} />
      </span>
      <p className="text-[13px] font-medium text-fg">{title}</p>
      {hint && <p className="max-w-[19rem] text-[12px] leading-relaxed text-faint">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
