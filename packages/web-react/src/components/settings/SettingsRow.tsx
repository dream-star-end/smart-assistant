import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 设置页行式控件：左标题+说明 / 右操作。不要拿表单 `Field`（上标签下控件）来冒充。
 * `<md` 上下排，避免 390 屏把开关挤没。
 */
export function SettingsRow({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 py-3.5 md:min-h-14 md:flex-row md:items-center md:justify-between md:gap-4",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-section font-medium text-fg">{title}</div>
        {description ? <div className="mt-0.5 text-caption text-faint">{description}</div> : null}
      </div>
      <div className="shrink-0 md:self-center">{action}</div>
    </div>
  );
}
