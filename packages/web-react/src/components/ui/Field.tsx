import {
  Fragment,
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
  useId,
} from "react";
import { cn } from "../../lib/utils";

/**
 * 表单字段包装:标签 + 控件 + 说明 + 错误。
 *
 * 存在的理由:仓内 40 处手写 `<label>` 各调各的字号(11.5 / 12 / 12.5 / 13px 四档在
 * AuthGate、formBits、CronPanel、MembersTab 之间随机摇摆),说明文字有的 text-faint
 * 有的 text-muted;更要命的是**几乎没有一处接 aria-describedby / aria-invalid** ——
 * 错误提示对读屏用户等于不存在。这里把排版档位(label=text-meta / hint=text-caption /
 * error=text-caption)和无障碍连线一次性收口。
 *
 * 无障碍连线怎么做的:
 *  - 用 useId 生成 hint/error 的稳定 id,自动拼进控件的 `aria-describedby`
 *    (与控件自带的 describedby 合并,不覆盖);
 *  - 有 error 时自动给控件加 `aria-invalid`,有 required 时加 `aria-required`
 *    (控件已显式声明的一律不动 —— 调用方永远有最终解释权);
 *  - htmlFor 不传时自动生成控件 id 并注入唯一子元素,label 指向它。
 * 只有 children 是**单个 React 元素**时才能注入;传多个元素/裸文本时请显式给
 * htmlFor,并自行接 aria-describedby(此时本组件只负责排版)。
 */
export interface FieldProps {
  label: ReactNode;
  /** 辅助说明,常驻显示(有 error 时也保留 —— 格式要求往往正是纠错所需)。 */
  hint?: ReactNode;
  /** 错误文案;非空即触发控件 aria-invalid。 */
  error?: ReactNode;
  /** 仅渲染必填星号 + 给控件补 aria-required,不做校验。 */
  required?: boolean;
  /** 控件已有稳定 id 时传入;不传则本组件生成并注入唯一子元素。 */
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  className,
  children,
}: FieldProps) {
  const uid = useId();
  const hintId = hint ? `${uid}-hint` : undefined;
  const errorId = error ? `${uid}-error` : undefined;
  // 只引用真正渲染出来的节点 —— 悬空的 aria-describedby 在读屏上是静默失败。
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  // Fragment 排除在外:cloneElement 往 Fragment 上塞 id/aria-* 会被 React 判成非法 prop 并告警。
  const child =
    isValidElement(children) && children.type !== Fragment
      ? (children as ReactElement<Record<string, unknown>>)
      : null;
  const childProps: Record<string, unknown> = child ? { ...child.props } : {};
  const childId = typeof childProps.id === "string" ? childProps.id : undefined;
  const controlId = htmlFor ?? childId ?? `${uid}-control`;

  const control =
    child === null
      ? children
      : cloneElement(child, {
          // 只在控件自己没有 id 时补;绝不覆盖调用方显式给的 id(可能被别处
          // getElementById / aria-labelledby 引用)。htmlFor 与子元素 id 若同时给出,
          // 两者必须一致 —— 不一致时以子元素为准,label 指向落空会被 a11y 审计抓到,
          // 好过静默改掉一个外部依赖的 id。
          id: childId ?? controlId,
          "aria-describedby":
            [childProps["aria-describedby"], describedBy].filter(Boolean).join(" ") || undefined,
          "aria-invalid": childProps["aria-invalid"] ?? (error ? true : undefined),
          "aria-required": childProps["aria-required"] ?? (required ? true : undefined),
        });

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={controlId} className="text-meta font-medium text-muted">
        {label}
        {required ? (
          // 星号只是视觉标记,语义由控件的 aria-required 承载,故对读屏隐藏。
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
        ) : null}
      </label>
      {control}
      {hint ? (
        <p id={hintId} className="text-caption text-faint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
