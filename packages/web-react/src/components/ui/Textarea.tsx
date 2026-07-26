import { type TextareaHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";
import { controlSurfaceClass } from "./Input";

/**
 * 多行文本框。外观复用 Input 的 `controlSurfaceClass`(边框/底色/字号/焦点环单一权威),
 * 只额外给自己的内边距与行高;高度交给调用方(rows 或 className 的 h-*)。
 * 字号同样锁死 `text-base md:text-sm` —— iOS 聚焦防放大红线,见 Input.tsx 注释。
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(controlSurfaceClass, "resize-none px-3.5 py-2.5 leading-relaxed", className)}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
