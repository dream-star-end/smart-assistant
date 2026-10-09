import type { LucideIcon } from "lucide-react";
import { createContext, type HTMLAttributes, type ReactNode, useContext } from "react";
import { cn } from "../../lib/utils";
import { Select, type SelectOption } from "./Select";

/**
 * 「安静表面」:管理中心(OCV5-344 第 3 轮)的工作面语言 —— 层级靠字号、对齐与留白,
 * 不靠卡片、渐变、彩色药丸与图标方块。规格见仓外 DESIGN-SPEC-ADMIN.md 的摘要:
 * 一个分组 = 一个 10px 圆角容器 + 发丝分隔线;状态 = 6px 圆点 + 文字;强调色只给
 * 选中指示 / 焦点环 / 开关 / 文字链接。
 *
 * 为什么用 context 而不是 CSS 覆盖:Card / Badge / EmptyState / PanelHeader / Tabs
 * 被全站共用,管理中心外的界面必须零变化;context 让原语在**渲染层**选形态,
 * 测试能直接断言,也不会出现「工具类 vs 作用域选择器」的层叠拉锯。
 * 弹窗走 portal 但仍在 React 树内,所以管理中心里打开的工作台 / 确认框同一语言。
 */
const QuietContext = createContext(false);

export function QuietSurface({ children }: { children: ReactNode }) {
  return <QuietContext.Provider value={true}>{children}</QuietContext.Provider>;
}

export function useQuiet() {
  return useContext(QuietContext);
}

export type StatusTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const DOT: Record<StatusTone, string> = {
  neutral: "bg-faint",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
};

/** 6px 状态圆点。纯装饰(aria-hidden),状态词必须以文字出现在旁边。 */
export function StatusDot({ tone = "neutral", className }: { tone?: StatusTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT[tone], className)}
    />
  );
}

/**
 * 分组标题:14/600 + 可选的弱化计数(等宽数字)+ 右侧可选操作。
 * 计数单独成一个 span,不再写进标题字符串的「（6）」全角括号里。
 */
export function GroupHeading({
  title,
  count,
  action,
  className,
  as: Tag = "h4",
}: {
  title: ReactNode;
  count?: number;
  action?: ReactNode;
  className?: string;
  as?: "h3" | "h4";
}) {
  return (
    <div className={cn("flex min-h-8 items-end justify-between gap-3 pb-2", className)}>
      <Tag className="flex items-baseline gap-2 text-[14px] font-semibold leading-5 text-fg">
        {title}
        {count !== undefined && (
          <span className="text-meta font-normal tabular-nums text-faint">{count}</span>
        )}
      </Tag>
      {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  );
}

/**
 * 分组列表容器:一个容器装一组行,行与行之间是发丝线 —— 不是「每条一张卡」。
 * 外形与 Card 默认一致(app 的 rounded-xl + 描边 + soft 阴影,OCV5-362),不再另起 10px 平板。
 * 渲染成 <ul>;行用 ListRow(<li>)。
 */
export function ListGroup({ className, ...props }: HTMLAttributes<HTMLUListElement>) {
  return (
    <ul
      className={cn(
        "oc-list overflow-hidden rounded-xl border border-border bg-surface shadow-soft",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 分组内的一行:12/16 内距,最小 48px(≥44px 触控靶)。行与行的分隔线由 .oc-list 统一画
 * (li + li 上边框),行自身不带边框,所以展开内容可以直接接在行内、共享同一条发丝线。
 */
export function ListRow({ className, ...props }: HTMLAttributes<HTMLLIElement>) {
  return <li className={cn("oc-list-row min-h-12 px-4 py-3", className)} {...props} />;
}

/**
 * 行内的元信息行:弱化色 12px、等宽数字,子项之间自动插「·」分隔(CSS,见 .oc-meta)。
 * 用它代替一排彩色徽章。
 */
export function MetaLine({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "oc-meta flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta tabular-nums text-faint",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 窄屏「上下文行」插槽(OCV5-360 第 4 轮)。管理中心在窄屏把分区的页面标题藏起来
 * (分段控件已经说明你在哪),PanelHeader 的右侧操作改为 portal 进这一行 —— 作用范围在左、
 * 分区操作在右,同一行,不再为一颗按钮单独占一行。值是行内的 DOM 节点;null = 不搬运。
 */
const HeaderSlotContext = createContext<HTMLElement | null>(null);
export const HeaderSlotProvider = HeaderSlotContext.Provider;
export function useHeaderSlot() {
  return useContext(HeaderSlotContext);
}

/**
 * 行内取值选择器:「图标/标签 + 值 ⌄」,无填充框、按内容取宽(field-sizing)、44px 触控高(窄屏)。
 * 与「作用范围」同一语法 —— 管理中心里所有"在当前视图里换一个对象"的选择都长这样。
 * 原生 <select>:移动端直接调起系统选择器;值字号 ≥16px(窄屏)避免 iOS 聚焦放大。
 */
export function InlineSelect({
  id,
  icon: Icon,
  label,
  value,
  onValueChange,
  options,
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  icon?: LucideIcon;
  /** 可见标签(真 <label>)。省略时必须给 aria-label。 */
  label?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  "aria-label"?: string;
}) {
  const selected = options.find((o) => o.value === value)?.label;
  return (
    <span className={cn("oc-inline-select flex min-w-0 items-center gap-1", className)}>
      {Icon && <Icon size={14} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-faint" />}
      {label && id && (
        <label htmlFor={id} className="shrink-0 cursor-pointer text-meta text-faint max-md:text-body max-md:text-muted">
          {label}
        </label>
      )}
      <Select
        id={id}
        aria-label={label ? undefined : ariaLabel}
        title={selected}
        value={value}
        onValueChange={onValueChange}
        options={options}
        inputSize="sm"
        className="w-auto min-w-0 max-w-full"
      />
    </span>
  );
}
