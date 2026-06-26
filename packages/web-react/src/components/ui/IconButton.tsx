import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * 仅承载图标的方形/圆形按钮。统一替换全仓散落的
 * `size-9 rounded-full hover:bg-hover` 内联写法。
 * 调用方负责传 aria-label(无文字标签)。
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
        xs: "size-6",
        sm: "size-7",
        md: "size-9",
        lg: "size-10",
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
