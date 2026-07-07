import { type TextareaHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        // 基准字号 ≥16px(text-base)防 iOS 聚焦整页放大不回弹;md+ 桌面回落 14px(text-sm)。
        "w-full resize-none rounded-lg border border-border bg-surface px-3.5 py-2.5 text-base md:text-sm leading-relaxed text-fg outline-none transition-[border-color,box-shadow] duration-150 ease-standard placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
