import { cva, type VariantProps } from "class-variance-authority";
import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";
import { Spinner } from "./Spinner";

/**
 * 设计系统主按钮。变体语义(Aurora):
 * - primary  : ink 中性主色(浅=近黑/深=近白),app 内主操作/发送/提交
 * - gradient : 极光渐变,仅限营销/落地页 hero CTA —— 不用于 app 内主操作
 * - accent   : 靛紫品牌/交互强调(选中态、需要品牌色的次操作),非 hero CTA
 * - secondary: 描边表面按钮,次级操作
 * - ghost    : 透明,工具栏/低强度操作
 * - subtle   : 浅填充
 * - danger   : 破坏性操作
 * - link     : 文字链接态
 *
 * ── 忙态(loading)为什么下沉进原语 ───────────────────────────────────────
 * 全仓 52 个文件各自在按钮里手写 `<Loader2 className="animate-spin" />` + 自己算
 * `disabled={busy}`,spinner 尺寸(13/14/15/16px)、是否换文案、是否禁用各不相同。
 * `loading` prop 把这套约定收成一处:自动 disabled + aria-busy + 前置 spinner。
 * 两条刻意的设计:
 *  1. **保留原文案**,只在最前面插入 spinner —— 不换成"处理中…",避免按钮宽度整体
 *     重排(手写实现最常见的抖动来源);宽度变化被限制在 spinner 自身盒宽 + gap 内。
 *  2. 视觉用 `opacity-80 + cursor-wait`,刻意区别于 disabled 的 `opacity-50`:
 *     用户要能看出"在做事",而不是"这个按钮不可用"。实现上靠 twMerge「后写优先」
 *     覆盖 base 里的 `disabled:opacity-50`;同时把 `disabled:pointer-events-none`
 *     翻回 auto —— 否则 cursor-wait 在原生 disabled 元素上根本不生效(指针事件被吃掉,
 *     光标由父元素决定)。点击仍被原生 disabled 拦住,不会漏触发。
 *
 * ── 触控靶 ─────────────────────────────────────────────────────────────
 * sm/md 的 32/40px 低于触屏 44px 命中标准,故在 [@media(hover:none)] 下补
 * `min-h-11`(min-height 覆盖 height,桌面端渲染零变化);lg 的 48px 本就达标。
 * 调用方不必再逐处手写这条。
 */
export const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium outline-none transition-[background-color,color,box-shadow,transform,opacity] duration-150 ease-standard focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-fg hover:opacity-90",
        gradient: "bg-grad-cta text-white shadow-soft hover:brightness-110",
        accent: "bg-accent text-accent-fg shadow-soft hover:bg-accent-strong",
        secondary:
          "border border-border bg-surface text-fg hover:border-border-strong hover:bg-hover",
        ghost: "text-fg hover:bg-hover",
        subtle: "bg-hover text-fg hover:bg-active",
        danger: "bg-danger text-white hover:opacity-90",
        link: "text-accent underline-offset-4 hover:underline",
      },
      // 字号走语义档位(text-body=13px / text-title=15px),像素与原 text-[13px]/text-[15px]
      // 完全一致,只是把任意值收进 token;md 保留原厂 text-sm(14px 无对应语义档,改档=全站变字号)。
      size: {
        sm: "h-8 rounded-md px-3 text-body [@media(hover:none)]:min-h-11",
        md: "h-10 rounded-lg px-4 text-sm [@media(hover:none)]:min-h-11",
        lg: "h-12 rounded-xl px-6 text-title",
      },
      // shape 与 size 正交(与 IconButton 同轴):pill 覆盖 size 的圆角。
      shape: {
        default: "",
        pill: "rounded-full",
        square: "aspect-square px-0",
      },
      // 忙态类必须排在 base 之后输出(cva 保证 base → variants 的拼接顺序),
      // 才能靠 twMerge 覆盖 base 的两条 disabled:*。
      loading: {
        true: "cursor-wait disabled:pointer-events-auto disabled:opacity-80",
        false: "",
      },
    },
    defaultVariants: { variant: "secondary", size: "md", shape: "default", loading: false },
  },
);

/** spinner 视觉尺寸随按钮档位走(对齐仓内手写实现常用的 13/14/16px)。 */
const SPINNER_PX = { sm: 13, md: 14, lg: 16 } as const;

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, shape, loading, type = "button", disabled, children, ...props },
    ref,
  ) => {
    const busy = loading === true;
    return (
      <button
        ref={ref}
        type={type}
        // 忙态强制禁用,防重复提交;非忙态完全沿用调用方的 disabled(undefined 时不落属性)。
        disabled={disabled || busy}
        // 只在忙时落 aria-busy —— 默认 false 会给全站按钮凭空加 aria-busy="false"。
        aria-busy={busy || undefined}
        className={cn(buttonVariants({ variant, size, shape, loading: busy }), className)}
        {...props}
      >
        {busy ? <Spinner size={SPINNER_PX[size ?? "md"]} className="shrink-0" /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
