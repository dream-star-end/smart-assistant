import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

/** 行内提示横幅。语义色 info / success / warning / danger,可选 icon 与 title。 */
export const alertVariants = cva("flex gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed", {
  variants: {
    tone: {
      info: "border-info/30 bg-info-soft",
      success: "border-success/30 bg-success-soft",
      warning: "border-warning/30 bg-warning-soft",
      danger: "border-danger/30 bg-danger-soft",
    },
  },
  defaultVariants: { tone: "info" },
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
}

export function Alert({ className, tone, icon, title, children, ...props }: AlertProps) {
  return (
    <div role="alert" className={cn(alertVariants({ tone }), className)} {...props}>
      {icon && <span className={cn("mt-0.5 shrink-0", iconTone[tone ?? "info"])}>{icon}</span>}
      <div className="min-w-0 flex-1 text-fg">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && "mt-0.5 text-muted")}>{children}</div>}
      </div>
    </div>
  );
}
