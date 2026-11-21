import { type ReactNode, type SelectHTMLAttributes, forwardRef } from "react";
import { cn } from "../../../lib/utils";

/** 表单行:标签 + 控件 + 可选说明。告警各建/改通道 Modal 共用。 */
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-body font-medium text-fg">{label}</label>
      {children}
      {hint && <p className="text-caption leading-snug text-faint">{hint}</p>}
    </div>
  );
}

/** 原生 select,套 Input 视觉(在 Modal 内比 DropdownMenu 更稳,无 portal/焦点纠缠)。 */
export const NativeSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "oc-field-control h-10 w-full rounded-lg border border-border px-3 text-base md:text-sm text-fg outline-none disabled:opacity-50",
      className,
    )}
    {...props}
  />
));
NativeSelect.displayName = "NativeSelect";

/** 分步操作指引(建 Telegram/群机器人/智能机器人 通道时的前置说明)。 */
export function StepHint({ steps }: { steps: ReactNode[] }) {
  return (
    <ol className="oc-callout oc-callout-info space-y-1.5 rounded-xl py-3 pl-7 pr-4 text-meta leading-relaxed text-muted">
      {steps.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态步骤文案,顺序稳定
        <li key={i} className="list-decimal">
          {s}
        </li>
      ))}
    </ol>
  );
}
