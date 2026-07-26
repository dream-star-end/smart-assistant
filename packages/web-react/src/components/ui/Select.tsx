import { ChevronDown } from "lucide-react";
import { type SelectHTMLAttributes, forwardRef } from "react";
import { cn } from "../../lib/utils";
import { controlHeightClass, controlSurfaceClass } from "./Input";

/**
 * 下拉选择。存在的理由:仓内 16 个文件各写各的裸 `<select>` —— admin 三个 form.tsx
 * 抄 `h-10 pl-3.5 pr-9`、formBits 抄 `h-10 px-3`、PreferencesTab 抄 `py-1.5 text-[13px]`、
 * CronPanel 又抄一套 inputCls,高度、箭头、焦点环、暗色底全不一致。
 *
 * 实现刻意用**原生 `<select>`** 而非 Radix:
 *  - 仓内没有 `@radix-ui/react-select` 依赖,本批不新增依赖;
 *  - 原生控件在 Modal 内没有 portal/焦点纠缠(formBits 的 NativeSelect 注释已踩过),
 *    移动端直接调起系统选择器,触控体验优于自绘浮层,且 jsdom 可测。
 * 外观完全复用 Input 的 `controlSurfaceClass` —— 下拉与输入框严格同构,箭头用
 * `appearance-none` 去掉系统原生的再自绘一个 ChevronDown(pointer-events-none,不夺焦点)。
 * 暗色下选项浮层由 :root/.dark 的 `color-scheme` 驱动跟随系统,无需额外处理。
 *
 * 注意 className 落在**外层定位容器**上(控制宽度/间距,如 `w-auto`),控件本体的附加类
 * 走 `selectClassName` —— 箭头是绝对定位在容器右侧的,宽度必须由容器决定才不会错位。
 */
export interface SelectOption {
  value: string;
  /** 原生 <option> 只能承载纯文本,故不收 ReactNode。 */
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "children"> {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  /** 未选中时的占位项(value=""),渲染为 disabled option:能显示、不能被回选。 */
  placeholder?: string;
  /** 高度档位,与 Input 同轴:sm=h-9 / md=h-10(默认)。 */
  inputSize?: "sm" | "md";
  /** 控件本体的附加类;容器类请用 className。 */
  selectClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      className,
      selectClassName,
      value,
      onValueChange,
      options,
      placeholder,
      inputSize = "md",
      disabled,
      ...props
    },
    ref,
  ) => (
    <span className={cn("relative inline-flex w-full", className)}>
      <select
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(e) => onValueChange(e.target.value)}
        className={cn(
          controlSurfaceClass,
          controlHeightClass[inputSize],
          // pl/pr 分开写(不用 px):右侧要给自绘箭头让位,且避免 padding-inline 与
          // padding-right 在生成 CSS 里靠顺序决胜。peer 供箭头跟随 disabled 变淡。
          "peer cursor-pointer appearance-none pl-3.5 pr-9 disabled:cursor-not-allowed",
          selectClassName,
        )}
        {...props}
      >
        {placeholder === undefined ? null : (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={16}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-faint peer-disabled:opacity-50"
      />
    </span>
  ),
);
Select.displayName = "Select";
