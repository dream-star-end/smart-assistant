import { type InputHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        // 基准字号 ≥16px(text-base)防 iOS 聚焦整页放大不回弹;md+ 桌面回落 14px(text-sm)。
        // 受益面=登录/注册第一屏(AuthGate)与全部 settings/manage/org 表单输入。
        "h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-base md:text-sm text-fg outline-none transition-[border-color,box-shadow] duration-150 ease-standard placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
