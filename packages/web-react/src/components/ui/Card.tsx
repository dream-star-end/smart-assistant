import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 卡片容器 —— 全仓「圆角 + 描边 + 表面」的唯一权威。
 *
 * 为什么要变体化:改造前 39 个文件手抄 `rounded-xl border border-border bg-surface`,
 * 而 Card 原语只被用了 38 次 —— 手抄面比原语面还大,token 一调就有一半界面跟不上。
 * 手抄的真实原因是原语太"薄"(不给内距、不给下沉底、不给可点态),调用方补一行样式
 * 还不如整段自己写。这里把这三件事收进变体轴,手抄就没有理由了。
 *
 * 默认值刻意 = 改造前 Card 的渲染结果(`rounded-xl border border-border bg-surface shadow-soft`),
 * 存量 38 处调用零改动、零视觉变化。
 */
export const cardVariants = cva(
  // 基类只放"所有 tone 共有"的形状。颜色/描边色/阴影一律下放到 tone —— 这样
  // cardVariants() 即使被单独使用(没过 cn/twMerge),基类与变体之间也不会互相打架。
  "rounded-xl border",
  {
    variants: {
      /** 内距。none = 旧行为(调用方自己写 p-*),保证向后兼容。 */
      padding: { none: "", sm: "p-3", md: "p-4", lg: "p-5" },
      /**
       * default : 常规抬升表面(surface + soft 阴影)
       * sunken  : 卡内嵌套的次级容器,取页面底色形成下沉感,不再叠阴影
       * accent  : 强调 / 选中态,品牌软底 + 品牌描边
       */
      tone: {
        default: "border-border bg-surface shadow-soft",
        sunken: "border-border bg-bg",
        accent: "border-accent/30 bg-accent-soft",
      },
      /**
       * 可点卡片:手型 + hover 抬升 + 焦点环 + 触控靶(≥44px)一次给全,
       * 调用方不必再手工补 `[@media(hover:none)]:min-h-11`。
       * 抬升不必再手工排除触屏:Tailwind v4 的 `hover:` 本身就编译进
       * `@media (hover:hover)`(已核对构建产物),触屏上不会出现"点完粘住不落回"。
       * 注意:role/tabIndex 这类语义本组件不代劳(可能是 <button> 包着,也可能内部还有
       * 链接,自动加 role 反而制造嵌套可交互元素),由调用方按场景给。
       */
      interactive: {
        true: "cursor-pointer outline-none transition-[border-color,box-shadow,transform] duration-150 ease-standard hover:-translate-y-0.5 hover:border-border-strong hover:shadow-float focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg [@media(hover:none)]:min-h-11",
        false: "",
      },
    },
    defaultVariants: { padding: "none", tone: "default", interactive: false },
  },
);

export interface CardProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

export function Card({ className, padding, tone, interactive, ...props }: CardProps) {
  return (
    <div className={cn(cardVariants({ padding, tone, interactive }), className)} {...props} />
  );
}

export interface CardRowProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof cardVariants> {
  /** 左槽:图标 / 头像 / 缩略图。 */
  icon?: ReactNode;
  /** 主名。单行截断 —— 列表行的高度必须可预测。 */
  title?: ReactNode;
  /** 次要说明,最多两行。 */
  description?: ReactNode;
  /** 主体底部的徽章 / 时间戳等。 */
  meta?: ReactNode;
  /** 右槽:操作按钮组。窄屏(<640px)自动落到第二行并右对齐。 */
  actions?: ReactNode;
}

/**
 * 列表行形态的卡片:左图标槽 / 中主体 / 右操作槽。
 * 替代各面板手写的 `flex items-center gap-2.5 rounded-xl border …` + 内部三段结构 ——
 * 手写版本各家的截断策略、窄屏行为都不一致(有的操作区在 375px 下被挤成两个字宽)。
 * 这里统一:主体 min-w-0 可截断、操作区 shrink-0 不被挤压、窄屏整行下沉。
 */
export function CardRow({
  icon,
  title,
  description,
  meta,
  actions,
  children,
  className,
  padding = "sm",
  tone,
  interactive,
  ...props
}: CardRowProps) {
  return (
    <Card
      padding={padding}
      tone={tone}
      interactive={interactive}
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}
      {...props}
    >
      {icon && <span className="flex shrink-0 items-center text-muted">{icon}</span>}
      <div className="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
        {title && <div className="truncate text-section font-medium text-fg">{title}</div>}
        {description && <div className="line-clamp-2 text-meta text-muted">{description}</div>}
        {meta && <div className="flex flex-wrap items-center gap-1.5 pt-0.5">{meta}</div>}
        {children}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-1.5 max-sm:w-full max-sm:justify-end">
          {actions}
        </div>
      )}
    </Card>
  );
}
