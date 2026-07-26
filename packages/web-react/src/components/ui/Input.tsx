import { cva, type VariantProps } from "class-variance-authority";
import { type InputHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * 输入类控件的**共享外观**(输入框 / 多行文本 / 下拉共用),刻意不含水平内边距 ——
 * 有右侧图标的控件(Select)与纯文本框的左右留白不同,由各控件自己给,避免
 * `px-*` 与 `pr-*` 在生成 CSS 里靠顺序决胜(逻辑属性 padding-inline vs 物理 padding-right)。
 *
 * 单一权威的意义:Input / Textarea / Select 的边框、底色、字号、焦点环、触控靶一处改
 * 全站生效。以前 admin 三个 form.tsx + formBits + PreferencesTab 各抄一份,已经抄出
 * h-10 / py-1.5 两套高度和 border-border / border-border-strong 两套边框。
 *
 * 三处刻意为之:
 * 1. 边框用 `border-border-control` 而非 `border-border` —— 后者是**分隔线**用色,
 *    在 --bg 上只有 1.16:1,当控件边界时输入框在浅色主题几乎看不见(WCAG 非文本
 *    对比要求 ≥3:1)。这是本批唯一的桌面端可见视觉变更,属可访问性修复。
 * 2. 字号锁死 `text-base md:text-sm`,**不接语义档位**:iOS Safari 在输入框字号
 *    <16px 时聚焦会放大整页且不回弹,text-base(16px)是唯一防线;md+ 桌面才回落 14px。
 * 3. 焦点环用 `focus-visible:`(鼠标点击不再画环),但**不加 ring-offset** ——
 *    输入框常置于 bg-surface 卡片内,offset 只能取单一 token(ring-offset-bg),
 *    在卡片上会画出一圈错色边;无 offset 时环紧贴自身边框,两种底色下都正确。
 *    `focus:border-accent` 保持 `focus:`(非环样式,鼠标点击时也应变色)。
 */
export const controlSurfaceClass =
  "w-full rounded-lg border border-border-control bg-surface text-base md:text-sm text-fg outline-none transition-[border-color,box-shadow] duration-150 ease-standard placeholder:text-faint focus:border-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [@media(hover:none)]:min-h-11";

/**
 * 控件高度档位。触控靶由 controlSurfaceClass 的 `[@media(hover:none)]:min-h-11` 统一兜底
 * (min-height 覆盖 height),所以 sm(36px)在触屏上也是 44px,桌面端不变。
 */
export const controlHeightClass = { sm: "h-9", md: "h-10" } as const;

export const inputVariants = cva(cn(controlSurfaceClass, "px-3.5"), {
  variants: { inputSize: controlHeightClass },
  defaultVariants: { inputSize: "md" },
});

export interface InputProps
  extends InputHTMLAttributes<HTMLInputElement>,
    VariantProps<typeof inputVariants> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  // 叫 inputSize 而不是 size:<input size> 是原生属性(可见字符宽度),不能占用。
  ({ className, inputSize, ...props }, ref) => (
    <input ref={ref} className={cn(inputVariants({ inputSize }), className)} {...props} />
  ),
);
Input.displayName = "Input";
