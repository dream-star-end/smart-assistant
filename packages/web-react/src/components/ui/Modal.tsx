import * as RD from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "./IconButton";

/** 桌面宽度档。默认 md = 改造前的 max-w-lg。 */
export type ModalSize = "sm" | "md" | "lg" | "xl";
/** 窄屏(<768px)形态。默认 center = 改造前行为。 */
export type ModalMobileLayout = "center" | "fullscreen" | "sheet";

/**
 * 弹层外形的唯一权威。
 *
 * ── 为什么要变体化 ─────────────────────────────────────────────────────
 * ManageCenter / MarketplaceCenter / SettingsCenter / OrgCenter 四个中心壳各自手抄
 * ~250 字符的 Radix 类名,宽度(2xl/2xl/2xl/3xl)、高度(44rem / 46rem / max-h / 46rem)、
 * 底色(bg-surface vs Modal 的 bg-elevated)全是"各写各的",token 一调就有一半界面跟不上。
 * size / fixedHeight / toolbar 三个轴就是把那四段手写收敛进原语所需的全部能力。
 *
 * ── `oc-center-dialog` ────────────────────────────────────────────────
 * styles.css 的 visualViewport / safe-area 定位契约(iOS 键盘弹起时靠 App 实测的
 * --oc-visual-* 变量把弹层顶回可视视口)。四个中心壳都挂了,**唯独 Modal 漏了** ——
 * 同一个 app 里两类弹层在 iOS 键盘下行为不一致。这里补上,且只在 mobile="center"
 * (真正的"居中弹层"形态)时挂:该类是无媒体查询、未进 @layer 的普通 CSS 规则,
 * 会盖掉任何 Tailwind 的 top / max-height 工具类,所以 fullscreen / sheet 形态**不能**挂它,
 * 否则自身定位会被它反向覆盖。
 * ⚠️ 迁移注意:挂上后 `.oc-center-dialog` 的 max-height 会盖掉调用方 className 里的
 * max-h-*(工具类打不过未分层的普通规则)。需要整屏 / 贴底形态的调用方请走 mobile 轴,
 * 不要再用 className 手工顶位置。
 *
 * ── 断点书写纪律 ──────────────────────────────────────────────────────
 * fullscreen / sheet 一律「基础段写窄屏形态 + md: 写桌面回落」,同一属性在两段用**同族**
 * 工具类(top-0 ↔ md:top-1/2、rounded-t-2xl ↔ md:rounded-t-xl …)。Tailwind v4 把带断点
 * 变体的规则整体排在全部无变体规则之后(已核对 dist 产物),同族对写即可确定性覆盖,
 * 不依赖不同工具类在基础段内的相对顺序。
 */
export const modalContentVariants = cva(
  "fixed z-50 flex flex-col overflow-hidden bg-elevated shadow-float outline-none data-[state=open]:animate-in",
  {
    // 轴顺序即类名输出顺序:size / fixedHeight 先出、mobile 后出 —— fullscreen / sheet
    // 才能用 max-w-none / h-auto 通过 twMerge 折掉前两轴的桌面值,再由 compoundVariants
    // 在末尾补回 md: 断点值。
    variants: {
      size: { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-3xl" },
      /**
       * 固定高度:多分区弹层切 tab 时高度不再跳动(四个中心壳都靠它)。
       * 具体像素调用方仍可用 className 的 h-* 覆盖(twMerge 后写优先)。
       */
      fixedHeight: { true: "h-[min(85dvh,44rem)]", false: "" },
      mobile: {
        // max-h 用 dvh 收口移动端动态工具栏(地址栏展开时 88vh 会溢出可视视口);桌面 dvh≡vh
        // 故零回退。此处**不**并列 max-h-[88vh] 双回退 —— className 走 cn(tailwind-merge),
        // 同属性会被折叠为最后一个,vh 回退反而被剥掉;更老 WebView 的 vh 回退与 safe-area
        // 契约由 .oc-center-dialog 承担。
        center:
          "oc-center-dialog left-1/2 top-1/2 max-h-[88dvh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border",
        fullscreen:
          "bottom-0 left-0 right-0 top-0 h-auto max-h-none w-full max-w-none translate-x-0 translate-y-0 rounded-none border-0 border-border md:bottom-auto md:left-1/2 md:right-auto md:top-1/2 md:max-h-[88dvh] md:w-[calc(100vw-2rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border",
        /**
         * 定位完全交给调用方:本轴一个类都不输出(连 oc-center-dialog 也不挂)。
         *
         * 给的是 ContainerWebPreview 这类「所有断点都铺满、且要用 visualViewport 变量
         * 精确控位」的场景 —— 它既不能用 center(会被未分层的 .oc-center-dialog 顶掉
         * top/max-height),也不能用 fullscreen(那条带 md: 桌面回落,会在桌面把弹层
         * 拉回居中,而全屏预览在桌面同样要铺满)。
         * 2026-07-26 实测:Modal 补挂 oc-center-dialog 后,browser-tests T16/T17 立刻转红
         * (jsdom 的 2119 个用例全绿 —— CSS 层叠 jsdom 根本不算,交互面必须真浏览器验)。
         */
        none: "",
        // 贴底抽屉:窄屏从底部升起(顶部圆角 + 安全区内边距),md 起回到居中弹层。
        sheet:
          "bottom-0 left-0 right-0 top-auto h-auto max-h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl border border-b-0 border-border pb-[env(safe-area-inset-bottom)] md:bottom-auto md:left-1/2 md:right-auto md:top-1/2 md:max-h-[88dvh] md:w-[calc(100vw-2rem)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-b-xl md:rounded-t-xl md:border-b md:pb-0",
      },
    },
    // 非 center 形态的桌面宽 / 高必须写成断点值,否则会被基础段的 max-w-none / h-auto 折掉。
    // 类名必须字面量书写 —— Tailwind 扫不到运行时拼接出来的 `"md:" + size`。
    compoundVariants: [
      { mobile: "fullscreen", size: "sm", class: "md:max-w-md" },
      { mobile: "fullscreen", size: "md", class: "md:max-w-lg" },
      { mobile: "fullscreen", size: "lg", class: "md:max-w-2xl" },
      { mobile: "fullscreen", size: "xl", class: "md:max-w-3xl" },
      { mobile: "sheet", size: "sm", class: "md:max-w-md" },
      { mobile: "sheet", size: "md", class: "md:max-w-lg" },
      { mobile: "sheet", size: "lg", class: "md:max-w-2xl" },
      { mobile: "sheet", size: "xl", class: "md:max-w-3xl" },
      { mobile: "fullscreen", fixedHeight: true, class: "md:h-[min(85dvh,44rem)]" },
      { mobile: "sheet", fixedHeight: true, class: "md:h-[min(85dvh,44rem)]" },
    ],
    defaultVariants: { size: "md", fixedHeight: false, mobile: "center" },
  },
);

export interface ModalProps extends VariantProps<typeof modalContentVariants> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  srTitle?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** 标题下方、正文上方的常驻插槽(通常是 Tabs)。自带分隔线,不随正文滚动。 */
  toolbar?: ReactNode;
  className?: string;
  /** 内容区附加类;大尺寸对话查看器可用来接管 padding/滚动容器。 */
  bodyClassName?: string;
  hideClose?: boolean;
  /** Optional layered-Escape handler. Omit to keep Radix's default close behavior. */
  onEscapeKeyDown?: RD.DialogContentProps["onEscapeKeyDown"];
  /** Let immersive dialogs place initial focus on their primary interaction surface. */
  onOpenAutoFocus?: RD.DialogContentProps["onOpenAutoFocus"];
  /** Controlled dialogs opened by an external action can explicitly restore that action's focus. */
  onCloseAutoFocus?: RD.DialogContentProps["onCloseAutoFocus"];
}

/**
 * 居中模态。基于 Radix Dialog,免费获得焦点陷阱 / Escape / aria-modal。
 * 无可见标题时传 srTitle 提供无障碍名(Radix 要求每个 Dialog 有 Title)。
 * 新增的 size / fixedHeight / toolbar / mobile 四个轴,默认值都等于改造前行为。
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  srTitle = "对话框",
  children,
  footer,
  toolbar,
  size,
  fixedHeight,
  mobile,
  className,
  bodyClassName,
  hideClose,
  onEscapeKeyDown,
  onOpenAutoFocus,
  onCloseAutoFocus,
}: ModalProps) {
  // Description 仅在 title 存在时渲染;否则显式断开 Radix 默认 aria-describedby,避免悬空引用。
  const hasDescription = Boolean(title && description);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm data-[state=open]:animate-fade" />
        <RD.Content
          {...(hasDescription ? {} : { "aria-describedby": undefined })}
          onEscapeKeyDown={onEscapeKeyDown}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(modalContentVariants({ size, fixedHeight, mobile }), className)}
        >
          {title ? (
            <div
              className={cn(
                "flex items-start justify-between gap-4 px-5 pt-5",
                // 有 toolbar 时标题区自己承担下间距,否则标题会贴到分隔线上。
                toolbar && "pb-4",
              )}
            >
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
          {toolbar && (
            // px-4 而非 px-5:Tabs 药丸自带 p-1,4+4=20px 后首个 tab 的文字正好与正文左缘对齐。
            <div className={cn("shrink-0 border-b border-border px-4 pb-3", !title && "pt-4")}>
              {toolbar}
            </div>
          )}
          <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", bodyClassName)}>
            {children}
          </div>
          {footer && (
            // 窄屏按钮组竖排:col-reverse 让"主操作"(DOM 里写在最后)留在最上,且各自铺满整行 ——
            // 375px 屏上并排两个中文按钮会被压到两三个字宽。
            <div className="flex justify-end gap-2 border-t border-border px-5 py-4 max-sm:flex-col-reverse max-sm:[&>*]:w-full">
              {footer}
            </div>
          )}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
