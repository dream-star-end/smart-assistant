import { ChevronDown } from "lucide-react";
import { type ReactNode, type SelectHTMLAttributes, forwardRef } from "react";
import { cn } from "../../../lib/utils";

/**
 * 表单字段包裹:标签 + 控件 + 可选说明。account/proxy/group 表单共用排版。
 * (只在本页 accounts 目录内使用;egressProxies/accountGroups 各有同名轻拷贝,
 *  避免跨 page 目录耦合 —— 页面 agent 只拥有自己目录。)
 */
export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: label 经 children 隐式关联表单控件(Input/Select/Textarea)
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-[12.5px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] leading-snug text-faint">{hint}</span>}
    </label>
  );
}

/** 原生 select 套 Input 视觉,与设计系统对齐(无 Select 原语时的表单单选)。 */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "h-10 w-full appearance-none rounded-lg border border-border bg-surface pl-3.5 pr-9 text-base md:text-sm text-fg outline-none transition-[border-color,box-shadow] duration-150 ease-standard focus:border-accent focus:ring-2 focus:ring-ring disabled:opacity-50",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={15}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint"
      />
    </div>
  ),
);
Select.displayName = "Select";
