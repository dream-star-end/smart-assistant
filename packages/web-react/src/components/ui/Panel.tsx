import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'
import { Card } from './Card'
import { useHeaderSlot, useQuiet } from './Quiet'

/**
 * 面板统一头部：标题 + 可选说明 + 可选右侧操作。管理中心/市场各分区共用，
 * 保证分区结构一致。业务文案由调用方传入，本组件只管排版。
 *
 * 2026-07-26 修的是**层级倒挂**：原标题写死 `text-[13px]`，比它内部卡片主名的 14px
 * 还小 —— 分区标题反而比分区里的条目更弱，整块面板读不出主次。现改 text-title(15px)。
 * 左内距 px-5 → px-4 与列表行对齐，消灭"标题比内容右缩 4px"的错位缝。
 * hint 从 text-faint 改 text-muted：它承载"下一步该做什么"的引导，不该拿全站最低对比度。
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
  const quiet = useQuiet()
  const slot = useHeaderSlot()
  if (quiet) {
    // 安静表面(管理中心):壳体提供了上下文行插槽时(OCV5-362 起两个断点都提供),导航已写明
    // 当前分区 —— 与设置中心一样不再放页面大标题,标题 + 说明只留给读屏,右侧操作 portal 进上下文行。
    // 没有插槽(单独渲染的面板)时退回可见的标题行。
    if (slot) {
      return (
        <div data-panel-header="" className="sr-only">
          <h3>{title}</h3>
          {hint && <p>{hint}</p>}
          {action && createPortal(<div className="flex min-w-0 items-center gap-1">{action}</div>, slot)}
        </div>
      )
    }
    return (
      <div data-panel-header="" className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 pb-4 pt-2">
        <div className="min-w-0 flex-1 basis-64">
          <h3 className="text-title font-semibold text-fg">{title}</h3>
          {hint && <p className="mt-0.5 max-w-[60ch] text-caption text-muted">{hint}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
    )
  }
  return (
    // data-panel-header:给外壳按作用域调排版的钩子(管理中心把它当页面标题),本身不带样式。
    <div data-panel-header="" className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <h3 className="text-title font-semibold text-fg">{title}</h3>
        {hint && <p className="mt-0.5 text-caption text-muted">{hint}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/**
 * 分区面板 = Card + PanelHeader + 分隔线 + 统一内距(+ 可选页脚)。
 *
 * 为什么补这个：本文件叫 Panel.tsx 却一直没有 Panel，只有半截的 PanelHeader，
 * admin 侧只能自己拼 `<Card><PanelHeader/><div className="border-t …">` 造出
 * SectionCard —— 同一个东西两套实现，内距还各写各的(px-5 vs px-4)。
 * 这里把那段拼装收成原语，SectionCard 后续可直接并过来。
 * 内距想改(如列表要贴边)传 bodyClassName="p-0" 即可，twMerge 会覆盖默认值。
 */
export function Panel({
  title,
  hint,
  action,
  footer,
  children,
  className,
  bodyClassName,
}: {
  title: string
  hint?: string
  action?: ReactNode
  /** 页脚：分页器 / 批量操作条 / 补充说明。带上分隔线。 */
  footer?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  const quiet = useQuiet()
  if (quiet) {
    return (
      <section className={className}>
        <PanelHeader title={title} hint={hint} action={action} />
        <div className={cn('px-4 pb-4', bodyClassName)}>{children}</div>
        {footer && <div className="border-t border-border px-4 py-3">{footer}</div>}
      </section>
    )
  }
  return (
    <Card className={className}>
      <PanelHeader title={title} hint={hint} action={action} />
      <div className={cn('border-t border-border px-4 py-3.5', bodyClassName)}>{children}</div>
      {footer && <div className="border-t border-border px-4 py-3">{footer}</div>}
    </Card>
  )
}

/**
 * 面板统一空状态：accent 图标芯片 + 标题 + 说明 + 可选行动按钮。
 * 跨管理中心/市场复用，替代各面板手写的纯文本空态。
 * hint 同 PanelHeader 从 text-faint 提到 text-muted —— 空态的说明文字是用户此刻
 * 唯一能读的东西，用全站最低对比度承载它是反的。
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
  const quiet = useQuiet()
  if (quiet) {
    // 安静表面的空态:不放「图标方块 + 一句话」的模板,也不放虚线骨架(第 4 轮:手机上它读起来
    // 像「还在加载」)。左对齐的标题 + 说明 + 行动按钮,与列表行同一条左缘。
    // icon 参数保留(调用方契约不变),此形态下不渲染。
    return (
      <div data-empty-state="" className="px-4 py-2">
        <div className="pt-2 md:pt-4">
          <p className="text-[14px] font-semibold leading-5 text-fg">{title}</p>
          {hint && <p className="mt-1 max-w-[46ch] text-body text-muted">{hint}</p>}
          {action && <div className="mt-4 flex flex-wrap items-center gap-2">{action}</div>}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-2.5 px-5 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
        <Icon size={20} />
      </span>
      <p className="text-section font-medium text-fg">{title}</p>
      {hint && <p className="max-w-[19rem] text-meta text-muted">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
