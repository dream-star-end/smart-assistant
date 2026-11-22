import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMdViewport } from '../../hooks/useMdViewport'
import { IconButton, Sheet } from '../ui'

/** 任务面板四个配置抽屉的宽度只在这里定义一次(审计 T-25:以前 24rem / 36rem / 92vw / 96vw 各写各的)。 */
export const PANEL_SHEET_WIDTH = {
  wide: 'w-[36rem] max-w-[96vw]',
  narrow: 'w-[26rem] max-w-[92vw]',
} as const

/**
 * 任务面板的配置抽屉外壳:桌面右侧抽屉、移动端贴底抽屉(与单据抽屉 / 新建表单同一范式),
 * 头部常驻标题 + 关闭按钮 —— 移动端贴底抽屉没有 Esc,可点的遮罩只剩顶部 15%,没有关闭按钮
 * 就等于关不掉(审计 T-05 / T-25)。正文区自己滚动,头部不跟着滚走。
 */
export function PanelSheet({
  open,
  onOpenChange,
  title,
  hint,
  testId,
  width = 'wide',
  headerExtra,
  footer,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  hint?: ReactNode
  /** 正文容器的 data-testid;关闭按钮为 `${testId}-close`。 */
  testId: string
  width?: keyof typeof PANEL_SHEET_WIDTH
  /** 头部右侧、关闭按钮左边的附加操作。 */
  headerExtra?: ReactNode
  /** 吸底页脚(保存栏等)。 */
  footer?: ReactNode
  children: ReactNode
}) {
  const desktop = useMdViewport()
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      side={desktop ? 'right' : 'bottom'}
      srTitle={title}
      className={desktop ? PANEL_SHEET_WIDTH[width] : undefined}
    >
      <div className="oc-surface-glass flex shrink-0 items-start justify-between gap-3 border-x-0 border-t-0 border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-title font-semibold tracking-tight text-fg">{title}</h2>
          {hint ? <p className="mt-1 text-caption leading-relaxed text-muted">{hint}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerExtra}
          <IconButton
            type="button"
            size="sm"
            shape="square"
            aria-label="关闭"
            data-testid={`${testId}-close`}
            onClick={() => onOpenChange(false)}
          >
            <X size={16} />
          </IconButton>
        </div>
      </div>
      <div data-testid={testId} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-4 pt-3 pb-5">
        {children}
      </div>
      {footer ? (
        <div className="oc-surface-glass shrink-0 border-x-0 border-b-0 border-t border-border/70 px-4 py-2.5">
          {footer}
        </div>
      ) : null}
    </Sheet>
  )
}
