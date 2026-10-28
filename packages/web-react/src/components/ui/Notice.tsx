import { ChevronRight } from "lucide-react";
import { type HTMLAttributes, type ReactNode, useId, useState } from "react";
import { NOTICE_TONES, type NoticeTone, type SemanticTone } from "../../lib/ui/statusTone";
import { cn } from "../../lib/utils";
import { Button } from "./Button";

/**
 * 时间线内提示(UI-SPEC §4.2)。提示类的东西只有三种容器:页面级横幅(Alert + bannerStack,
 * 跨回合的连接 / 后台运行 / 版本 / 成本)、时间线内提示(本组件)、瞬时 Toast。
 * 错误卡(内容由 FE-errors 给)、已停止、自动恢复停止、模型切换灰条、接近上限提示都用它,
 * 不再各写一种画法(§1.1 C5 数过,至少 8 种)。
 *
 * 结构固定:语气图标 + 一句标题(可带「×N」)+ 可选正文 + 最多两个动作 + 可折叠的「技术详情」。
 * 命令、错误码、追踪号这类技术信息只放 details,展开后才出现,也只有那里用等宽字体。
 */
export type NoticeAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
};

export type NoticeProps = Omit<HTMLAttributes<HTMLDivElement>, "title" | "children"> & {
  tone?: NoticeTone;
  /** 一句人话。 */
  title: ReactNode;
  /** 可选正文,弱化色。 */
  children?: ReactNode;
  /** 最多两个动作:第一个是主动作(描边按钮),第二个是次动作(透明按钮)。 */
  actions?: readonly [NoticeAction] | readonly [NoticeAction, NoticeAction];
  /** 技术详情,默认收起。 */
  details?: ReactNode;
  detailsLabel?: string;
  /** 同样的提示连续出现的次数(见 collapseRepeats);>1 时标题后显示「×N」。 */
  count?: number;
};

const GLYPH_TEXT: Record<SemanticTone, string> = {
  running: "text-status-running",
  attention: "text-status-attention",
  done: "text-status-done",
  failed: "text-status-failed",
  idle: "text-status-idle",
};

const GLYPH_DOT: Record<SemanticTone, string> = {
  running: "bg-status-running",
  attention: "bg-status-attention",
  done: "bg-status-done",
  failed: "bg-status-failed",
  idle: "bg-status-idle",
};

export function Notice({
  tone = "info",
  title,
  children,
  actions,
  details,
  detailsLabel = "技术详情",
  count,
  className,
  ...rest
}: NoticeProps) {
  const spec = NOTICE_TONES[tone];
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const Icon = spec.icon;
  const hasFooter = Boolean(actions?.length) || details != null;
  return (
    <div
      data-notice-tone={tone}
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-border bg-surface px-3.5 py-3 text-body",
        className,
      )}
      {...rest}
    >
      {/* 图标框与标题首行等高(13px × 1.55 ≈ 20px),多行标题时图标仍对齐第一行。 */}
      <span aria-hidden="true" className="flex h-5 w-3.5 shrink-0 items-center justify-center">
        {Icon ? (
          <Icon
            size={14}
            strokeWidth={1.75}
            fill={spec.filled ? "currentColor" : "none"}
            className={GLYPH_TEXT[spec.tone]}
          />
        ) : (
          <span
            className={cn(
              "size-[7px] rounded-full",
              GLYPH_DOT[spec.tone],
              spec.breathe && "oc-status-breathe",
            )}
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className="min-w-0 font-medium text-fg">{title}</div>
          {count != null && count > 1 && (
            <span className="shrink-0 text-meta tabular-nums text-faint">×{count}</span>
          )}
        </div>
        {children != null && <div className="mt-0.5 text-muted">{children}</div>}
        {hasFooter && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {actions?.map((a, i) => (
              <Button
                key={a.label}
                size="sm"
                variant={i === 0 ? "secondary" : "ghost"}
                disabled={a.disabled}
                loading={a.loading}
                onClick={a.onClick}
              >
                {a.label}
              </Button>
            ))}
            {details != null && (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={detailsId}
                onClick={() => setOpen((v) => !v)}
                className="inline-flex items-center gap-0.5 rounded-sm px-1 text-meta text-faint outline-none transition-colors hover:text-muted focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11"
              >
                {detailsLabel}
                <ChevronRight
                  aria-hidden="true"
                  size={12}
                  className={cn("transition-transform", open && "rotate-90")}
                />
              </button>
            )}
          </div>
        )}
        {details != null && (
          <div
            id={detailsId}
            hidden={!open}
            className="mt-2 max-h-48 select-text overflow-auto whitespace-pre-wrap break-all rounded-sm bg-hover px-2.5 py-2 font-mono text-meta text-muted"
          >
            {details}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 连续相同的提示合并成一条「×N」(§1.1 C5:同样的粉卡叠 3 张)。只合并相邻且 key 相同的,
 * 中间隔了别的东西就各自保留,时间顺序不变;保留最后一条(内容最新)。
 */
export function collapseRepeats<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): Array<{ item: T; count: number }> {
  const out: Array<{ item: T; count: number; key: string }> = [];
  for (const item of items) {
    const key = keyOf(item);
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.item = item;
      last.count += 1;
    } else {
      out.push({ item, count: 1, key });
    }
  }
  return out.map(({ item, count }) => ({ item, count }));
}
