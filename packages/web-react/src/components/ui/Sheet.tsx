import * as RD from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 侧边抽屉。基于 Radix Dialog,用于移动端导航/侧栏。
 * 替换 App.tsx 中手写的 mobileNavOpen 覆盖层(免费焦点陷阱 + Escape)。
 */
export function Sheet({
  open,
  onOpenChange,
  side = "left",
  srTitle = "侧边面板",
  className,
  overlayClassName,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  srTitle?: string;
  className?: string;
  /** 遮罩附加类。窄屏专属抽屉应传 md:hidden,避免移动→桌面 resize 后遮罩残留挡屏。 */
  overlayClassName?: string;
  children?: ReactNode;
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay
          className={cn(
            "fixed inset-0 z-40 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade",
            overlayClassName,
          )}
        />
        <RD.Content
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 z-50 flex w-[19rem] max-w-[84vw] flex-col bg-sidebar shadow-float outline-none transition-transform",
            side === "left"
              ? "left-0 data-[state=closed]:-translate-x-full data-[state=open]:translate-x-0"
              : "right-0 data-[state=closed]:translate-x-full data-[state=open]:translate-x-0",
            className,
          )}
        >
          <RD.Title className="sr-only">{srTitle}</RD.Title>
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
