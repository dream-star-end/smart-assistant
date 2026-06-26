import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/** 加载占位骨架。形状(高/宽/圆角)由调用方用 className 控制。 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("animate-pulse rounded-md bg-hover", className)} aria-hidden="true" {...props} />
  );
}
