import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";
import { StatusDot, useQuiet } from "./Quiet";

/**
 * 状态徽章。tone 直接吃 styles.css 的语义色 token(已按 WCAG AA 重定过值,
 * `bg-<t>-soft text-<t>` 组合在浅/深两个主题下都 ≥4.5:1)。
 *
 * 基类补 `shrink-0 whitespace-nowrap` 的理由:徽章几乎总是放在 flex 行里(列表行右侧、
 * 卡片标题旁),不声明 shrink-0 就会被主体挤压,中文标签被压成两行、英文被截断,
 * 各调用方只好一处处补 shrink-0 —— 这条属于徽章本身的不变量,应该长在原语里。
 */
export const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-hover text-muted",
        accent: "bg-accent-soft text-accent",
        success: "bg-success-soft text-success",
        warning: "bg-warning-soft text-warning",
        danger: "bg-danger-soft text-danger",
        info: "bg-info-soft text-info",
      },
      /** md = 常规;sm 给密集列表(一行里挂 3 个以上徽章时)用。 */
      size: {
        md: "px-2 py-0.5 text-meta",
        sm: "px-1.5 py-0.5 text-caption",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  },
);

export function Badge({
  className,
  tone,
  size,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  const quiet = useQuiet();
  if (quiet) {
    // 安静表面(管理中心):不画彩色药丸。状态色(成功/警告/危险)= 6px 圆点 + 弱化文字;
    // 中性 / 强调 / 信息 = 纯文字(分类标签不是状态,不配圆点)。相邻徽章之间由 CSS 自动插「·」(.oc-qbadge + .oc-qbadge)。
    // 调用方自带的图标在有圆点时隐藏(.oc-qbadge > svg),避免「圆点 + 图标」重复表达。
    const t = tone ?? "neutral";
    const dotted = t === "success" || t === "warning" || t === "danger";
    const { children, ...rest } = props;
    return (
      <span
        data-tone={t}
        className={cn(
          "oc-qbadge inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums text-muted",
          size === "sm" ? "text-caption" : "text-meta",
          dotted && "oc-qbadge-dot",
          className,
          // 调用方给药丸写的底色 / 内距 / 圆角在安静表面一律不要。
          "rounded-none bg-transparent p-0",
        )}
        {...rest}
      >
        {dotted && <StatusDot tone={t} />}
        {children}
      </span>
    );
  }
  return <span className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}
