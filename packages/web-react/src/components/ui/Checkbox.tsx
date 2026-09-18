import { Check, Minus } from "lucide-react";
import {
  type InputHTMLAttributes,
  type ReactNode,
  forwardRef,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "../../lib/utils";

/**
 * 复选框原语(market K-27 补:此前全仓只有 `<input type=checkbox className="accent-accent">`,
 * 方块原生外观与 Switch / Chip 的设计语言各自漂移,`ui/` 没有可复用的一套)。
 *
 * 取舍:**保留原生 `<input type="checkbox">`**,只用 `appearance-none` 换视觉 ——
 * 键盘(Space 切换)、表单提交、`<label>` 关联、读屏的 checkbox 角色与 checked / mixed 状态
 * 全部由浏览器给,不引入第二套状态机(仓里也没有 @radix-ui/react-checkbox 依赖)。
 * 勾 / 减号是叠在 input 上方的 `pointer-events-none` 图标,靠 `peer-checked` /
 * `peer-indeterminate` 显隐,所以受控 / 非受控两种用法都对。
 *
 * 不变量:
 *  - **必须有可访问名称**:要么传 `label`(渲染成包住控件的 `<label>`,点文字即切换),
 *    要么自己给 `aria-label` / `aria-labelledby`;两者都没有时读屏只会念"复选框"。
 *  - **触控靶 ≥ 44px**:外层始终是 `<label>`(它才是真正接收点击的元素),触屏下
 *    `min-h-11`;没有文字时再补 `min-w-11` 把 16px 的框居中撑到 44×44。桌面 hover 可用时
 *    渲染零变化,与 Button / Chip / Switch 同一条约定。
 *  - `indeterminate` 走 DOM 属性(它不是 HTML attribute),由内部 effect 同步;读屏读到
 *    "部分选中"(mixed),视觉为减号。
 *  - 字号一律语义档:label = text-body,description = text-caption。
 */
export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  /** 文字标签;渲染为包住控件的 `<label>`,同时成为可访问名称。 */
  label?: ReactNode;
  /** 标签下方的次级说明(text-caption),通过 aria-describedby 关联到控件;不计入可访问名称。 */
  description?: ReactNode;
  /** 部分选中(如"全选"里只勾了一部分);为真时视觉为减号、读屏为 mixed。 */
  indeterminate?: boolean;
  /** 作用在外层 `<label>` 上(布局 / 卡片式外观交给调用方)。 */
  className?: string;
  /** 作用在 16px 的控件盒上(例如 `mt-0.5` 与多行文字的首行对齐)。 */
  controlClassName?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  {
    label,
    description,
    indeterminate = false,
    className,
    controlClassName,
    disabled,
    "aria-describedby": ariaDescribedBy,
    ...props
  },
  forwardedRef,
) {
  const innerRef = useRef<HTMLInputElement | null>(null);
  // 合并外部 ref 与内部 ref:indeterminate 只能通过 DOM 属性设置,所以内部必须拿得到节点。
  const setRef = useCallback(
    (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
  // layout effect:在首帧绘制前就把 DOM 属性写好,减号不会晚一帧才出现。
  useLayoutEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  // useId 产出形如 ":r0:" 的串;去掉冒号后只作 IDREF 关联使用。
  const uid = useId().replace(/:/g, "");
  const descriptionId = description != null ? `checkbox-${uid}-description` : undefined;
  const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;
  const hasText = label != null || description != null;

  return (
    <label
      className={cn(
        "inline-flex items-start gap-2 text-body text-fg [@media(hover:none)]:min-h-11",
        // 无文字时只有一个 16px 的框:触屏下把命中区撑到 44×44 并居中。
        !hasText && "justify-center [@media(hover:none)]:min-w-11",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
        className,
      )}
    >
      <span
        className={cn(
          "relative inline-flex size-4 shrink-0 items-center justify-center",
          controlClassName,
        )}
      >
        <input
          ref={setRef}
          type="checkbox"
          disabled={disabled}
          aria-describedby={describedBy}
          data-ui="checkbox"
          className={cn(
            "peer size-4 shrink-0 cursor-pointer appearance-none rounded-[5px] border border-border-strong bg-surface outline-none transition-colors duration-150 ease-standard",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
            "checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent",
            "disabled:cursor-not-allowed",
          )}
          {...props}
        />
        {/* 勾与减号二选一渲染,避免 checked && indeterminate 时两枚图标叠在一起。 */}
        {indeterminate ? (
          <Minus
            aria-hidden="true"
            strokeWidth={3}
            className="pointer-events-none absolute hidden size-3 text-accent-fg peer-indeterminate:block"
          />
        ) : (
          <Check
            aria-hidden="true"
            strokeWidth={3}
            className="pointer-events-none absolute hidden size-3 text-accent-fg peer-checked:block"
          />
        )}
      </span>
      {hasText && (
        <span className="min-w-0 leading-snug">
          {label != null && <span className="block">{label}</span>}
          {description != null && (
            // aria-hidden:不让说明文字混进由 <label> 内容计算出的可访问名称;
            // 它仍通过 aria-describedby 被引用,读屏在名称之后单独念出(IDREF 引用不受 aria-hidden 影响)。
            <span
              id={descriptionId}
              aria-hidden="true"
              className="mt-0.5 block text-caption text-faint"
            >
              {description}
            </span>
          )}
        </span>
      )}
    </label>
  );
});
