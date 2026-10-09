import { type TextareaHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";
import { controlSurfaceBaseClass } from "./Input";

/**
 * 多行文本框。外观复用 Input 的 `controlSurfaceBaseClass`(边框/底色/字号/焦点环单一权威),
 * 只额外给自己的内边距与行高;高度交给调用方(rows 或 className 的 h-*)。
 * 字号同样锁死 `text-base md:text-sm` —— iOS 聚焦防放大红线,见 Input.tsx 注释。
 *
 * 用不带触控靶的 controlSurfaceBaseClass:单行控件的 `[@media(hover:none)]:min-h-11` 是
 * 媒体查询包着的规则,层叠上排在调用方的 `min-h-[18rem]` 之后 —— 手机上调用方给的最小高度
 * 全部失效,文本框塌成一行(OCV5-362,运营 10-09 19:53 技能工作台截图)。多行框本身远高于 44px。
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(controlSurfaceBaseClass, "resize-none px-3.5 py-2.5 leading-relaxed", className)}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
