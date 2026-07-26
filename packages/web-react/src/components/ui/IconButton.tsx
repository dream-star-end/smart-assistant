import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * 仅承载图标的方形/圆形按钮。统一替换全仓散落的
 * `size-9 rounded-full hover:bg-hover` 内联写法。
 * 调用方负责传 aria-label(无文字标签)。
 *
 * 触控靶:四档视觉尺寸(24/28/36/40px)在触屏上全部低于 44px 命中标准,故每档都在
 * `[@media(hover:none)]` 下升到 `size-11`(44px)。这条以前要调用方逐处手写
 * (仓内 33 处 `[@media(hover:none)]:size-11` 补丁),现在下沉进原语 ——
 * 桌面端(hover 可用)渲染零变化,调用方补丁可安全删除(重复写也不会冲突,twMerge 去重)。
 */
export const iconButtonVariants = cva(
  "inline-flex shrink-0 items-center justify-center outline-none transition-[background-color,color,box-shadow,transform] duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.94] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        ghost: "text-muted hover:bg-hover hover:text-fg",
        muted: "text-faint hover:bg-hover hover:text-fg",
        solid: "bg-primary text-primary-fg hover:opacity-90",
        accent: "bg-accent text-accent-fg hover:bg-accent-strong",
        subtle: "bg-hover text-fg hover:bg-active",
        danger: "text-danger hover:bg-danger-soft hover:text-danger",
      },
      size: {
        xs: "size-6 [@media(hover:none)]:size-11",
        sm: "size-7 [@media(hover:none)]:size-11",
        md: "size-9 [@media(hover:none)]:size-11",
        lg: "size-10 [@media(hover:none)]:size-11",
      },
      shape: {
        round: "rounded-full",
        square: "rounded-md",
      },
    },
    defaultVariants: { variant: "ghost", size: "md", shape: "round" },
  },
);

export interface IconButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof iconButtonVariants> {}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, shape, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(iconButtonVariants({ variant, size, shape }), className)}
      {...props}
    />
  ),
);
IconButton.displayName = "IconButton";
