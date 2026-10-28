import type { HTMLAttributes } from "react";
import { STATUS, type SemanticTone, type StatusKind } from "../../lib/ui/statusTone";
import { cn } from "../../lib/utils";

/**
 * 全站唯一的状态标记(UI-SPEC §4.2)。原先有两份:侧栏的 SessionStatusDot(写死紫 / 红 / 琥珀 / 蓝)
 * 和安静表面的 Quiet.StatusDot(6px 色板点)。两者现在都是本组件的薄封装。
 *
 * - 文案、色调、图标查 lib/ui/statusTone 的状态表;颜色只写 `--status-*` 别名。
 * - variant="dot":只有一个点。悬停(title)和读屏(role=img + aria-label)给出文案 ——
 *   「所有点都要有悬停或长按说明」;旁边已有同义文字时传 decorative,点只做装饰。
 * - variant="pill":点或图标 + 文字。不带底色和描边(颜色只留给状态本身)。
 */
const BG: Record<SemanticTone, string> = {
  running: "bg-status-running",
  attention: "bg-status-attention",
  done: "bg-status-done",
  failed: "bg-status-failed",
  idle: "bg-status-idle",
};

const BORDER: Record<SemanticTone, string> = {
  running: "border-status-running",
  attention: "border-status-attention",
  done: "border-status-done",
  failed: "border-status-failed",
  idle: "border-status-idle",
};

const TEXT: Record<SemanticTone, string> = {
  running: "text-status-running",
  attention: "text-status-attention",
  done: "text-status-done",
  failed: "text-status-failed",
  idle: "text-status-idle",
};

/** 失败 / 需要处理的点带同色柔光晕(只在 md,也就是侧栏行首这种需要一眼扫到的位置)。 */
const HALO: Partial<Record<SemanticTone, string>> = {
  failed: "ring-[3px] ring-status-failed/20",
  attention: "ring-[3px] ring-status-attention/20",
};

type StatusSource =
  | { status: StatusKind; tone?: undefined }
  /** 状态表里没有对应状态、只需要一个色调时(插件「已授权」这类),直接给色调和文案。 */
  | { tone: SemanticTone; status?: undefined };

export type StatusPillProps = StatusSource &
  Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
    /** 覆盖状态表的默认文案(「正在写 Q4 汇报.pptx」「没完成：…」见 statusTone 的 *Label)。 */
    label?: string;
    variant?: "dot" | "pill";
    /** sm = 6px 点 / 12px 图标(行内文字旁);md = 7px 点 / 14px 图标(侧栏行首)。 */
    size?: "sm" | "md";
    /**
     * 点的形状。ring = 细线旋转环(侧栏「运行中」沿用的语汇;减少动态效果时静止为缺口环,
     * 形状仍能和实心点区分)。
     */
    mark?: "dot" | "ring";
    /** 旁边已有同义文字:点只做装饰(aria-hidden),不挂 title / aria-label。 */
    decorative?: boolean;
  };

export function StatusPill({
  status,
  tone: toneProp,
  label,
  variant = "dot",
  size = "sm",
  mark = "dot",
  decorative = false,
  className,
  ...rest
}: StatusPillProps) {
  const spec = status ? STATUS[status] : undefined;
  const tone = spec?.tone ?? toneProp ?? "idle";
  const text = label ?? spec?.label;
  const dot =
    mark === "ring"
      ? cn("size-2.5 rounded-full border-[1.5px] border-r-transparent oc-session-running", BORDER[tone])
      : cn(
          "rounded-full",
          size === "md" ? "size-[7px]" : "size-1.5",
          BG[tone],
          size === "md" && HALO[tone],
          spec?.breathe && "oc-status-breathe",
        );

  if (variant === "dot") {
    return (
      <span
        role={decorative ? undefined : "img"}
        aria-hidden={decorative ? true : undefined}
        aria-label={decorative ? undefined : text}
        title={decorative ? undefined : text}
        data-status={status}
        data-tone={tone}
        className={cn("inline-block shrink-0", dot, className)}
        {...rest}
      />
    );
  }

  const Icon = spec?.icon;
  return (
    <span
      data-status={status}
      data-tone={tone}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-muted",
        size === "md" ? "text-body" : "text-meta",
        className,
      )}
      {...rest}
    >
      {Icon ? (
        <Icon
          aria-hidden="true"
          size={size === "md" ? 14 : 12}
          strokeWidth={1.75}
          fill={spec?.filled ? "currentColor" : "none"}
          className={cn("shrink-0", TEXT[spec?.iconTone ?? tone])}
        />
      ) : (
        <span aria-hidden="true" className={cn("inline-block shrink-0", dot)} />
      )}
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}
