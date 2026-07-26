import { createContext, type ReactNode, useContext } from "react";
import { cn } from "../../lib/utils";

/**
 * 键值详情列表(原 admin 的 KeyValue 提升 + 更名)。
 *
 * 存在的理由:用户侧有 47 处手写的 `flex items-center justify-between` 键值行,
 * 每处的间距、字号、label 颜色、长值换行策略都略有出入,叠起来就是"同一个弹窗里
 * 每行都长得不太一样"。这里把一行详情的排版定死:label 左对齐弱化、value 右对齐加重、
 * 长值 break-words 不撑破容器。
 *
 * 语义:包在 <DescriptionList> 里时按 HTML 的 dl/dt/dd 渲染(读屏会成对播报术语与释义);
 * 单独用一行时回落 span —— 游离的 dt/dd 是非法结构,而 admin 存量正是"直接堆 KeyValue"
 * 的用法,不能因为提升就把它变成无效 HTML。
 */

const InsideList = createContext(false);

export function DescriptionList({
  children,
  /** 行间加分隔线(长列表更好扫读)。默认关 = 纯堆叠,与存量一致。 */
  divided = false,
  className,
}: {
  children: ReactNode;
  divided?: boolean;
  className?: string;
}) {
  return (
    <InsideList.Provider value={true}>
      <dl className={cn(divided && "divide-y divide-border", className)}>{children}</dl>
    </InsideList.Provider>
  );
}

export function DescriptionRow({
  label,
  value,
  hint,
  className,
  labelClassName,
  valueClassName,
}: {
  label: ReactNode;
  value: ReactNode;
  /** label 下方的一行补充说明(设置项常用)。 */
  hint?: ReactNode;
  className?: string;
  labelClassName?: string;
  valueClassName?: string;
}) {
  const inList = useContext(InsideList);
  const Term = inList ? "dt" : "span";
  const Desc = inList ? "dd" : "span";
  return (
    <div className={cn("flex items-start justify-between gap-4 py-1.5 text-body", className)}>
      <Term className={cn("shrink-0 text-faint", labelClassName)}>
        {label}
        {hint && <span className="mt-0.5 block text-caption text-faint">{hint}</span>}
      </Term>
      <Desc className={cn("min-w-0 break-words text-right font-medium text-fg", valueClassName)}>
        {value}
      </Desc>
    </div>
  );
}
