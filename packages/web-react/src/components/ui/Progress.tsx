import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/** 填充色语义。brand = 极光渐变(改造前唯一形态)。 */
export type ProgressTone = "brand" | "neutral" | "success" | "warning" | "danger";

/** 轨道:高度是唯一变化轴,底色/圆角固定。sm 给列表行内的密集用量条。 */
const progressTrackVariants = cva("w-full overflow-hidden rounded-full bg-hover", {
  variants: { size: { sm: "h-1.5", md: "h-2" } },
  defaultVariants: { size: "md" },
});

/**
 * 填充。tone 存在的理由:改造前所有进度条都是同一条极光渐变 —— "积分用到 95%"
 * 和"用到 20%"长得一模一样,配额条完全丧失了预警能力,用户只能自己读数字。
 * 语义色一上,余额告急在余光里就能看见。
 */
const progressFillVariants = cva(
  "h-full rounded-full transition-[width] duration-300 ease-standard",
  {
    variants: {
      tone: {
        brand: "bg-grad-cta",
        neutral: "bg-muted",
        success: "bg-success",
        warning: "bg-warning",
        danger: "bg-danger",
      },
    },
    defaultVariants: { tone: "brand" },
  },
);

export interface ProgressProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof progressTrackVariants>,
    VariantProps<typeof progressFillVariants> {
  value: number;
  /**
   * 按 value 自动升级 tone 的阈值(百分比,含端点):value ≥ danger → danger,
   * ≥ warning → warning,否则用传入的 tone。把"多少算危险"这条业务判断留在调用方
   * (配额 90% 危险,而磁盘 70% 就该报警),把"危险长什么样"留在原语。
   */
  thresholds?: { warning: number; danger: number };
}

/**
 * 进度条。value 0–100(内部 clamp)。配额 / 用量 / 同步进度共用。
 * `...props` 透传到外层 div,调用方可补 aria-label / id 给 progressbar 一个可访问名。
 * 默认 tone="brand" + size="md" 的渲染结果与改造前逐类一致。
 */
export function Progress({ value, tone, size, thresholds, className, ...props }: ProgressProps) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const resolved: ProgressTone = thresholds
    ? pct >= thresholds.danger
      ? "danger"
      : pct >= thresholds.warning
        ? "warning"
        : (tone ?? "brand")
    : (tone ?? "brand");
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      // 阈值命中后的实际语义色对外可见(测试/排障不必去反推类名)。
      data-tone={resolved}
      className={cn(progressTrackVariants({ size }), className)}
      {...props}
    >
      <div className={progressFillVariants({ tone: resolved })} style={{ width: `${pct}%` }} />
    </div>
  );
}
