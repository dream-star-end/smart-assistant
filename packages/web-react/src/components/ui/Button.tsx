import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * 设计系统主按钮。变体语义(Aurora):
 * - primary  : ink 中性主色(浅=近黑/深=近白),app 内主操作/发送/提交
 * - gradient : 极光渐变,仅限营销/落地页 hero CTA —— 不用于 app 内主操作
 * - accent   : 靛紫品牌/交互强调(选中态、需要品牌色的次操作),非 hero CTA
 * - secondary: 描边表面按钮,次级操作
 * - ghost    : 透明,工具栏/低强度操作
 * - subtle   : 浅填充
 * - danger   : 破坏性操作
 * - link     : 文字链接态
 */
export const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium outline-none transition-[background-color,color,box-shadow,transform,opacity] duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-fg hover:opacity-90",
        gradient: "bg-grad-cta text-white shadow-soft hover:brightness-110",
        accent: "bg-accent text-accent-fg shadow-soft hover:bg-accent-strong",
        secondary:
          "border border-border bg-surface text-fg hover:border-border-strong hover:bg-hover",
        ghost: "text-fg hover:bg-hover",
        subtle: "bg-hover text-fg hover:bg-active",
        danger: "bg-danger text-white hover:opacity-90",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 rounded-md px-3 text-[13px]",
        md: "h-10 rounded-lg px-4 text-sm",
        lg: "h-12 rounded-xl px-6 text-[15px]",
      },
      // shape 与 size 正交(与 IconButton 同轴):pill 覆盖 size 的圆角。
      shape: {
        default: "",
        pill: "rounded-full",
        square: "aspect-square px-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md", shape: "default" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, shape, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, shape }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";
