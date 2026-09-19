import * as RD from "@radix-ui/react-dropdown-menu";
import { ChevronRight } from "lucide-react";
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from "react";
import { cn } from "../../lib/utils";

export const DropdownMenu = RD.Root;
export const DropdownMenuTrigger = RD.Trigger;
export const DropdownMenuGroup = RD.Group;

export const DropdownMenuContent = forwardRef<
  ComponentRef<typeof RD.Content>,
  ComponentPropsWithoutRef<typeof RD.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <RD.Portal>
    <RD.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[11rem] overflow-hidden rounded-lg border border-border bg-elevated p-1 text-fg shadow-pop",
        "data-[state=open]:animate-fade",
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
      "flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover [@media(hover:none)]:min-h-11",
      destructive && "text-danger data-[highlighted]:bg-danger-soft",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = "DropdownMenuItem";

export function DropdownMenuLabel({ className, ...props }: ComponentPropsWithoutRef<typeof RD.Label>) {
  return <RD.Label className={cn("px-2.5 py-1.5 text-xs font-medium text-faint", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentPropsWithoutRef<typeof RD.Separator>) {
  return <RD.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
}

export const DropdownMenuSub = RD.Sub;

export const DropdownMenuSubTrigger = forwardRef<
  ComponentRef<typeof RD.SubTrigger>,
  ComponentPropsWithoutRef<typeof RD.SubTrigger>
>(({ className, children, ...props }, ref) => (
  <RD.SubTrigger
    ref={ref}
    className={cn(
      "flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover data-[state=open]:bg-hover [@media(hover:none)]:min-h-11",
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
>(({ className, sideOffset = 4, ...props }, ref) => (
  <RD.SubContent
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "z-50 min-w-[11rem] overflow-hidden rounded-lg border border-border bg-elevated p-1 text-fg shadow-pop",
      "data-[state=open]:animate-fade",
      className,
    )}
    {...props}
  />
));
DropdownMenuSubContent.displayName = "DropdownMenuSubContent";
