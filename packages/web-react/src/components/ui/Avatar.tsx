import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 统一头像原语 —— 替换全仓散落的 `size-x rounded-full bg-gradient` 内联写法。
 * 用户 / AI / 智能体头像共用:传 src 显示图片,否则回退到 fallback(首字母)或 children(图标)。
 * tone: brand=极光渐变底白字 / ink=主色底反相字 / neutral=低强度灰底。
 */
export const avatarVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center overflow-hidden font-semibold",
  {
    variants: {
      size: {
        xs: "size-6 text-[11px]",
        sm: "size-7 text-xs",
        md: "size-9 text-sm",
        lg: "size-11 text-[15px]",
      },
      shape: { round: "rounded-full", square: "rounded-lg" },
      tone: {
        brand: "bg-grad-cta text-white",
        ink: "bg-primary text-primary-fg",
        neutral: "bg-hover text-muted",
      },
    },
    defaultVariants: { size: "md", shape: "round", tone: "brand" },
  },
);

export interface AvatarProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof avatarVariants> {
  src?: string;
  alt?: string;
  fallback?: ReactNode;
}

export function Avatar({
  className,
  size,
  shape,
  tone,
  src,
  alt,
  fallback,
  children,
  ...props
}: AvatarProps) {
  return (
    <span className={cn(avatarVariants({ size, shape, tone }), className)} {...props}>
      {src ? (
        <img src={src} alt={alt ?? ""} className="size-full object-cover" />
      ) : (
        (fallback ?? children)
      )}
    </span>
  );
}
