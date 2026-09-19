/**
 * 工具卡**卡内**文字型操作的统一原语(tools 审计 T-08)。
 *
 * 「展开全部 / 继续显示 / 收起 / 查看结果 / 查看更多 / 还有 N 个字段 / 查看完整内容」这类
 * 卡内链接式按钮此前散落在 8 个文件里各写各的 className,触控高度只有 16–24px(表头与
 * IconButton 早已在 hover:none 下升到 44px)。这里收成一处:
 *   - 桌面渲染零变化(仍是行内文字链接);
 *   - `[@media(hover:none)]:min-h-11`:触屏下命中面积 ≥44px(与 Button / IconButton / Chip 同标准);
 *   - 默认 `e.stopPropagation()`:卡内按钮不冒泡到 ToolCard 表头造成误折叠。
 *
 * `<details><summary>` 不能换成 button(原生折叠语义要保留),用 {@link INLINE_SUMMARY_CLS}
 * 给 summary 同一档触控高度。
 */
import { type ButtonHTMLAttributes, type MouseEvent, forwardRef } from 'react'
import { cn } from '../../lib/utils'

/** 行内文字操作的基类(text-xs 档,展开/收起/查看更多)。 */
export const INLINE_ACTION_CLS =
  'inline-flex items-center gap-1 rounded text-xs text-accent outline-none transition-colors hover:underline focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11'

/** `<summary>` 用:保留 list-item 显示(浏览器原生三角标记),触屏下用上下内边距把命中区撑到 44px。 */
export const INLINE_SUMMARY_CLS =
  'cursor-pointer rounded text-caption text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:py-3.5'

export interface InlineActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 整行可点的块级形态(diff 底部「展开全部」行):左对齐、占满宽度、hover 底色。 */
  block?: boolean
}

export const InlineAction = forwardRef<HTMLButtonElement, InlineActionProps>(function InlineAction(
  { className, block = false, onClick, type = 'button', ...props },
  ref,
) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    onClick?.(e)
  }
  return (
    <button
      ref={ref}
      type={type}
      onClick={handleClick}
      className={cn(
        INLINE_ACTION_CLS,
        block &&
          'flex w-full rounded-none px-3 py-1 text-left hover:bg-hover/60 focus-visible:ring-inset',
        className,
      )}
      {...props}
    />
  )
})
