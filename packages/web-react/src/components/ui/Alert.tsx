import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "./IconButton";

/**
 * 行内提示横幅。语义色 info / success / warning / danger,可选 icon 与 title。
 *
 * ── density 为什么进原语 ───────────────────────────────────────────────
 * 全仓 44 处调用方在 className 里把 Alert 的字号往小掰(`text-[12.5px]`/`text-xs` …),
 * 原因是 `px-4 py-3 text-sm` 这一档对表单内、卡片内的行内提示明显偏大。字号档位是
 * 设计系统的事,不该由 44 个调用点各掰各的 —— 这里把它收成一个 density 轴。
 * comfortable = 改造前那一档,一字不改。
 *
 * ⚠️ 内距/字号必须放在 variants 而不是 base:`alertVariants({tone:'success'})` 有调用方
 * **直接当类名字符串用**(不过 cn/tailwind-merge),base 与 variant 里出现同属性会两条都留下,
 * 谁后写谁生效全靠运气。同属性只允许出现在一个轴上。
 */
export const alertVariants = cva("flex gap-3 rounded-lg border leading-relaxed", {
  variants: {
    tone: {
      info: "border-info/30 bg-info-soft",
      success: "border-success/30 bg-success-soft",
      warning: "border-warning/30 bg-warning-soft",
      danger: "border-danger/30 bg-danger-soft",
    },
    /** comfortable = 改造前默认(独立成块的页面级提示);compact = 表单/卡片内的行内提示。 */
    density: {
      comfortable: "px-4 py-3 text-sm",
      compact: "px-3 py-2 text-body",
    },
  },
  defaultVariants: { tone: "info", density: "comfortable" },
});

const iconTone: Record<string, string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export interface AlertProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof alertVariants> {
  icon?: ReactNode;
  title?: ReactNode;
  /**
   * 右侧动作槽(通常是「重试」按钮)。窄屏自动换到第二行并右对齐。
   * 存在的理由:全仓 55 处 danger Alert 里只有 4 处给了重试出口,而那 4 处还各自手抄了
   * 同一段 flex 样板 —— "报错必须给出口"是原语该保证的事,不是调用方的自觉。
   */
  action?: ReactNode;
  /** 传了就在右上角出现关闭按钮。不传则不渲染(可关闭与否由调用方决定,原语不臆断)。 */
  onDismiss?: () => void;
  /** 请求 ID:等宽 + select-all,用户报障时一点即可整段复制,省掉"能否给下截图"的来回。 */
  requestId?: string;
}

export function Alert({
  className,
  tone,
  density,
  icon,
  title,
  action,
  onDismiss,
  requestId,
  children,
  ...props
}: AlertProps) {
  const hasTrailing = Boolean(action || onDismiss);
  return (
    <div
      role="alert"
      className={cn(
        alertVariants({ tone, density }),
        // 仅在有尾槽时才开启换行:无尾槽的存量调用渲染结果保持一字不差。
        hasTrailing && "flex-wrap items-start",
        className,
      )}
      {...props}
    >
      {icon && <span className={cn("mt-0.5 shrink-0", iconTone[tone ?? "info"])}>{icon}</span>}
      <div className={cn("min-w-0 flex-1 text-fg", hasTrailing && "basis-48")}>
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && "mt-0.5 text-muted")}>{children}</div>}
        {requestId && (
          <div className="mt-1.5 flex flex-wrap items-baseline gap-1 text-micro text-faint">
            <span>请求 ID</span>
            <span className="select-all break-all font-mono">{requestId}</span>
          </div>
        )}
      </div>
      {hasTrailing && (
        <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end">
          {action}
          {onDismiss && (
            <IconButton aria-label="关闭提示" size="sm" variant="muted" onClick={onDismiss}>
              <X size={14} />
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}
