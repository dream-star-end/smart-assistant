import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "./IconButton";

/**
 * 居中模态。基于 Radix Dialog,免费获得焦点陷阱/Escape/aria-modal。
 * 无可见标题时传 srTitle 提供无障碍名(Radix 要求每个 Dialog 有 Title)。
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  srTitle = "对话框",
  children,
  footer,
  className,
  bodyClassName,
  hideClose,
  onEscapeKeyDown,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  srTitle?: string;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** 内容区附加类；大尺寸对话查看器可用来接管 padding/滚动容器。 */
  bodyClassName?: string;
  hideClose?: boolean;
  /** Optional layered-Escape handler. Omit to keep Radix's default close behavior. */
  onEscapeKeyDown?: RD.DialogContentProps["onEscapeKeyDown"];
}) {
  // Description 仅在 title 存在时渲染;否则显式断开 Radix 默认 aria-describedby,避免悬空引用。
  const hasDescription = Boolean(title && description);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <RD.Content
          {...(hasDescription ? {} : { "aria-describedby": undefined })}
          onEscapeKeyDown={onEscapeKeyDown}
          // max-h 用 dvh 收口移动端浏览器动态工具栏(地址栏展开时 88vh 会溢出可视视口)。
          // 桌面 dvh≡vh 故零回退;调用方仍可用自己的 max-h 覆盖(单类,tailwind-merge 后者覆盖)。
          // 注:此处**不**并列 max-h-[88vh] 双回退——className 走 cn(tailwind-merge),同属性
          // 会被折叠为最后一个,vh 回退会被剥掉(SettingsCenter 等能双类共存是因其 class 是纯
          // 字符串、不过 cn)。dvh 在目标浏览器(iOS15.4+/Chromium108+,含现役鸿蒙/Quark 内核)
          // 已普遍支持;更老 WebView 的 vh 回退 + safe-area 契约仍由 .oc-center-dialog(全尺寸 center)承担。
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[88dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-elevated shadow-float outline-none data-[state=open]:animate-in",
            className,
          )}
        >
          {title ? (
            <div className="flex items-start justify-between gap-4 px-5 pt-5">
              <div className="min-w-0">
                <RD.Title className="text-base font-semibold text-fg">{title}</RD.Title>
                {description && (
                  <RD.Description className="mt-1 text-sm text-muted">{description}</RD.Description>
                )}
              </div>
              {!hideClose && (
                <RD.Close asChild>
                  <IconButton aria-label="关闭" size="sm">
                    <X size={16} />
                  </IconButton>
                </RD.Close>
              )}
            </div>
          ) : (
            <RD.Title className="sr-only">{srTitle}</RD.Title>
          )}
          <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", bodyClassName)}>
            {children}
          </div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-border px-5 py-4">{footer}</div>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
