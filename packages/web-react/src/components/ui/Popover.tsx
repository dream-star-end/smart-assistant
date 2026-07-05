import * as RP from "@radix-ui/react-popover";
import { type ComponentPropsWithoutRef, type ComponentRef, forwardRef } from "react";
import { cn } from "../../lib/utils";

/**
 * 轻量 Popover 原语(radix)。与 DropdownMenuContent 同一套 surface token
 * (border-border/bg-elevated/shadow-pop),用于「点开看一段说明 + 一个操作」
 * 这类非菜单、非 modal 的浮层(如顶栏团队模式 chip 的说明气泡)。
 */
export const Popover = RP.Root;
export const PopoverTrigger = RP.Trigger;

export const PopoverContent = forwardRef<
  ComponentRef<typeof RP.Content>,
  ComponentPropsWithoutRef<typeof RP.Content>
>(({ className, align = "start", sideOffset = 6, ...props }, ref) => (
  <RP.Portal>
    <RP.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-lg border border-border bg-elevated p-3 text-fg shadow-pop",
        "data-[state=open]:animate-fade",
        className,
      )}
      {...props}
    />
  </RP.Portal>
));
PopoverContent.displayName = "PopoverContent";
