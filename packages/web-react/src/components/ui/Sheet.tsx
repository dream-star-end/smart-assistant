import * as RD from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "./IconButton";

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
        // overflow-y-auto:内容超过 85dvh 时原语自己兜底可滚(shell 审计 S-17)—— 调用方若
        // 自带 `min-h-0 flex-1 overflow-y-auto` 的滚动容器,外层不会溢出,不会叠出双滚动条。
        bottom:
          "inset-x-0 bottom-0 max-h-[85dvh] w-full overflow-y-auto overscroll-contain rounded-t-2xl bg-elevated pb-[env(safe-area-inset-bottom)] data-[state=closed]:translate-y-full data-[state=open]:translate-y-0",
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
  closeButton = false,
  closeLabel = "关闭",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: SheetSide;
  srTitle?: string;
  className?: string;
  /** 遮罩附加类。窄屏专属抽屉应传 md:hidden,避免移动→桌面 resize 后遮罩残留挡屏。 */
  overlayClassName?: string;
  /**
   * 右上角显式关闭钮(media 审计 M-04 / X-M3)。窄屏下 84vw 宽的抽屉只剩 ~6vw 遮罩可点、
   * 贴底抽屉更是只有 Esc 与遮罩两条退路 —— 内容自己不带关闭控件的抽屉应开启它,
   * 别再各自手写(MediaTaskCenter 之前就是这么补的)。关闭钮走 Radix Close,与遮罩 / Esc 同一条
   * onOpenChange(false) 路径;可访问名由 closeLabel 给,默认「关闭」。
   */
  closeButton?: boolean;
  closeLabel?: string;
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
          {closeButton && (
            // 绝对定位在面板右上:Content 是 fixed 容器,不占内容流;贴底抽屉的抓握条居中,与它不打架。
            <RD.Close asChild>
              <IconButton
                aria-label={closeLabel}
                title={closeLabel}
                className="absolute right-2 top-2 z-10"
              >
                <X size={18} />
              </IconButton>
            </RD.Close>
          )}
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
