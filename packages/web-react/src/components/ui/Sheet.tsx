import * as RD from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * 抽屉方向。left / right = 侧边栏(存量);bottom = 贴底抽屉。
 *
 * bottom 为什么进原语:ContainerWebPreview 的评论面板早就在 styles.css(`.preview-comments-modal`)
 * 里手写了一个贴底抽屉 —— 顶部圆角 + `max-height` + `padding-bottom: env(safe-area-inset-bottom)`
 * + md 起变右侧抽屉。需求是真实存在的,只是没进原语层,于是每个想要贴底面板的界面都得
 * 重抄一遍(还会各自漏掉安全区或滑动手感提示)。
 */
export type SheetSide = "left" | "right" | "bottom";

const sheetVariants = cva(
  "fixed z-50 flex flex-col bg-sidebar shadow-float outline-none transition-transform",
  {
    variants: {
      side: {
        left: "inset-y-0 left-0 w-[19rem] max-w-[84vw] data-[state=closed]:-translate-x-full data-[state=open]:translate-x-0",
        right:
          "inset-y-0 right-0 w-[19rem] max-w-[84vw] data-[state=closed]:translate-x-full data-[state=open]:translate-x-0",
        // 贴底:高度按内容自适应到 85dvh 封顶(dvh 收口移动端动态工具栏);底部补安全区,
        // 否则 Home 指示条会压住最后一行操作。底色取 elevated —— 贴底抽屉是浮在正文之上的
        // 临时面板,不是侧栏那种常驻导航面。
        bottom:
          "inset-x-0 bottom-0 max-h-[85dvh] w-full rounded-t-2xl bg-elevated pb-[env(safe-area-inset-bottom)] data-[state=closed]:translate-y-full data-[state=open]:translate-y-0",
      },
    },
    defaultVariants: { side: "left" },
  },
);

/**
 * 侧边 / 贴底抽屉。基于 Radix Dialog,用于移动端导航、侧栏与贴底面板。
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
  side?: SheetSide;
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
          className={cn(sheetVariants({ side }), className)}
        >
          <RD.Title className="sr-only">{srTitle}</RD.Title>
          {side === "bottom" && (
            // 纯视觉的抓握条(不可拖拽):贴底面板必须有这个"可以往下收"的可供性提示,
            // 否则用户只会去找关闭按钮。aria-hidden —— 它对辅助技术没有信息量。
            <div
              aria-hidden
              className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong"
            />
          )}
          {children}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
