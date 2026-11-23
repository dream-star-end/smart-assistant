import * as RD from "@radix-ui/react-dropdown-menu";
import { ChevronRight } from "lucide-react";
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from "react";
import { cn } from "../../lib/utils";

export const DropdownMenu = RD.Root;
export const DropdownMenuTrigger = RD.Trigger;
export const DropdownMenuGroup = RD.Group;

const DEFAULT_DROPDOWN_MAX_H =
  "max-h-[min(80dvh,var(--radix-dropdown-menu-content-available-height))]";
const hasUnprefixedMaxH = (className?: string) =>
  typeof className === "string" && /(?:^|\s)max-h-/.test(className);

export const DropdownMenuContent = forwardRef<
  ComponentRef<typeof RD.Content>,
  ComponentPropsWithoutRef<typeof RD.Content>
>(({ className, sideOffset = 6, collisionPadding = 8, ...props }, ref) => (
  <RD.Portal>
    <RD.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        // 矮视口（如手机横屏）下按 min(80dvh, Radix 可用高) 封顶并开启纵向滚动（OCV5-778 / OCV5-820）；
        // oc-dropdown-max-h 提供老 WebView 的 80vh 回退，调用方传自定义 max-h-* 时自动让位不冲突。
        !hasUnprefixedMaxH(className) && "oc-dropdown-max-h",
        "oc-surface-popover z-[var(--z-popover-portal)] min-w-[11.5rem] overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl p-1.5 text-fg outline-none",
        DEFAULT_DROPDOWN_MAX_H,
        "origin-[var(--radix-popper-transform-origin)] data-[state=open]:animate-pop data-[state=closed]:oc-pop-out",
        className,
      )}
      {...props}
    />
  </RD.Portal>
));
DropdownMenuContent.displayName = "DropdownMenuContent";

export const DropdownMenuItem = forwardRef<
  ComponentRef<typeof RD.Item>,
  ComponentPropsWithoutRef<typeof RD.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <RD.Item
    ref={ref}
    className={cn(
      // 触屏命中高 44px(a11y 走查 shell#9:菜单项 py-2 只有 36px);桌面端(hover 可用)零变化,与 IconButton / Chip 同一约定。
      "flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-body font-medium outline-none transition-[background-color,color] duration-150 ease-standard data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover [@media(hover:none)]:min-h-11 [&_svg]:shrink-0 [&_svg]:opacity-75 data-[highlighted]:[&_svg]:opacity-100",
      destructive && "text-danger data-[highlighted]:bg-danger-soft",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export function DropdownMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof RD.Label>) {
  return (
    <RD.Label
      className={cn("px-2.5 py-1.5 text-caption font-semibold uppercase tracking-wider text-faint", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentPropsWithoutRef<typeof RD.Separator>) {
  return <RD.Separator className={cn("-mx-0.5 my-1.5 h-px bg-border/80", className)} {...props} />;
}

export const DropdownMenuSub = RD.Sub;

export const DropdownMenuSubTrigger = forwardRef<
  ComponentRef<typeof RD.SubTrigger>,
  ComponentPropsWithoutRef<typeof RD.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <RD.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-body font-medium outline-none transition-[background-color,color] duration-150 ease-standard data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover data-[state=open]:bg-hover [@media(hover:none)]:min-h-11 [&_svg]:shrink-0 [&_svg]:opacity-75 data-[highlighted]:[&_svg]:opacity-100",
      className,
    )}
    {...props}
  >
    {children}
    <ChevronRight size={14} className="ml-auto shrink-0 text-faint" />
  </RD.SubTrigger>
));
DropdownMenuSubTrigger.displayName = "DropdownMenuSubTrigger";

export const DropdownMenuSubContent = forwardRef<
  ComponentRef<typeof RD.SubContent>,
  ComponentPropsWithoutRef<typeof RD.SubContent>
>(({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <RD.SubContent
    ref={ref}
    sideOffset={sideOffset}
    collisionPadding={collisionPadding}
    className={cn(
      !hasUnprefixedMaxH(className) && "oc-dropdown-max-h",
      "oc-surface-popover z-[var(--z-popover-portal)] min-w-[11.5rem] overflow-y-auto overflow-x-hidden overscroll-contain rounded-xl p-1.5 text-fg outline-none",
      DEFAULT_DROPDOWN_MAX_H,
      "origin-[var(--radix-popper-transform-origin)] data-[state=open]:animate-pop data-[state=closed]:oc-pop-out",
      className,
    )}
    {...props}
  />
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";
