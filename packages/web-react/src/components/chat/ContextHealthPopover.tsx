import { ArrowUpRight, Minimize2, Plus, Sparkles } from "lucide-react";
import type { SessionContextPressureState } from "../../lib/chat/model";
import { cn } from "../../lib/utils";
import { Badge, Button, Modal, StatusDot } from "../ui";

export type ContextHealthPopoverProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pressure?: SessionContextPressureState | null;
  compacting?: boolean;
  canCompact?: boolean;
  onCompact?: () => void;
  onStartNewSession?: () => void;
  onOpenManageMemory?: () => void;
};

type SegmentDef = {
  key: string;
  label: string;
  group: "resident" | "session";
  bytes: number;
  barClass: string;
  dotClass: string;
};

function buildSegments(pressure: SessionContextPressureState | null | undefined): SegmentDef[] {
  const b = pressure?.breakdown;
  if (!b) return [];
  const raw: SegmentDef[] = [
    { key: "system", label: "助手设定", group: "resident", bytes: b.systemBytes ?? 0, barClass: "bg-accent", dotClass: "bg-accent" },
    { key: "memory", label: "长期记忆", group: "resident", bytes: b.memoryBytes ?? 0, barClass: "bg-info", dotClass: "bg-info" },
    { key: "skills", label: "已启用技能", group: "resident", bytes: b.skillsBytes ?? 0, barClass: "bg-success", dotClass: "bg-success" },
    { key: "project", label: "项目资料", group: "resident", bytes: b.projectBytes ?? 0, barClass: "bg-warning", dotClass: "bg-warning" },
    { key: "history", label: "聊天记录", group: "session", bytes: b.historyBytes ?? 0, barClass: "bg-fg/55", dotClass: "bg-fg/55" },
    { key: "tools", label: "文件与工具结果", group: "session", bytes: b.toolsBytes ?? 0, barClass: "bg-muted/70", dotClass: "bg-muted/70" },
  ];
  return raw.filter((s) => s.bytes > 0);
}

/**
 * 对话内「当前对话空间」弹层（懒加载 chunk，零首屏开销；仅高阶用户主动运行 `/context` 时打开）。
 * 全文通俗人话，不展示底层引擎与字节/Token 工程师术语。
 */
export function ContextHealthPopover({
  open,
  onOpenChange,
  pressure,
  compacting = false,
  canCompact = true,
  onCompact,
  onStartNewSession,
  onOpenManageMemory,
}: ContextHealthPopoverProps) {
  const ratio = typeof pressure?.usedRatio === "number" && Number.isFinite(pressure.usedRatio) ? pressure.usedRatio : null;
  const pct = ratio !== null ? Math.min(100, Math.max(0, Math.round(ratio * 100))) : null;
  const isCritical = ratio !== null && (ratio >= 0.95 || pressure?.level === "critical");
  const isWarning = ratio !== null && !isCritical && ratio >= 0.8;
  const isElevated = ratio !== null && !isCritical && !isWarning && ratio >= 0.65;

  const tone: "danger" | "warning" | "success" = isCritical
    ? "danger"
    : isWarning || isElevated
      ? "warning"
      : "success";
  const statusLabel = isCritical
    ? "对话内容较多，系统即将自动整理"
    : isWarning
      ? "对话内容较长，后台会自动保持顺畅"
      : isElevated
        ? "对话空间良好"
        : pct !== null
          ? "当前对话空间充足"
          : "开始聊天后自动更新";

  const segments = buildSegments(pressure);
  const totalBreakdownBytes = segments.reduce((sum, s) => sum + s.bytes, 0);
  const residentBytes = segments.filter((s) => s.group === "resident").reduce((sum, s) => sum + s.bytes, 0);
  const sessionBytes = segments.filter((s) => s.group === "session").reduce((sum, s) => sum + s.bytes, 0);
  const residentPct = totalBreakdownBytes > 0 ? Math.round((residentBytes / totalBreakdownBytes) * 100) : 0;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      mobile="sheet"
      title={
        <span className="inline-flex items-center gap-2">
          <span className="oc-icon-badge oc-icon-badge-accent size-6 rounded-md" aria-hidden="true">
            <Sparkles size={13} strokeWidth={1.8} />
          </span>
          <span className="text-title font-semibold tracking-tight text-fg">当前对话空间</span>
        </span>
      }
      className="oc-surface-popover bg-surface"
    >
      <div className="space-y-4" data-testid="context-health-popover">
        <div className="oc-callout oc-callout-info rounded-xl px-3.5 py-2.5 text-caption leading-relaxed text-muted">
          系统已开启自动整理，聊久了会自动帮你处理，无需手动操作。
        </div>

        {/* 空间使用概览 */}
        <section className="oc-surface-recessed rounded-xl p-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2 text-body font-medium text-fg">
              <StatusDot tone={tone} />
              <span>{statusLabel}</span>
            </span>
            {pct !== null && (
              <Badge
                tone={isCritical ? "danger" : isWarning ? "warning" : "neutral"}
                size="sm"
                className="oc-badge-craft tabular-nums"
              >
                {pct}%
              </Badge>
            )}
          </div>

          <div
            className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-border/60"
            role="progressbar"
            aria-label="当前对话空间占用比例"
            aria-valuenow={pct ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-300",
                isCritical ? "bg-danger" : isWarning ? "bg-warning" : "bg-accent",
              )}
              style={{ width: `${pct ?? 0}%` }}
            />
          </div>

          <p className="mt-2 text-caption text-muted">
            {pct !== null
              ? `当前对话大约占用了 ${pct}% 的记忆空间，接近上限时系统会自动整理较早记录。`
              : "继续聊天后，这里会自动展示当前对话的空间使用情况。"}
          </p>
        </section>

        {/* 内容分布：纯 CSS 分段堆叠条 */}
        <section className="space-y-2.5" aria-label="对话内容分布">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-meta font-semibold text-fg">内容分布</h4>
            {totalBreakdownBytes > 0 && (
              <span className="text-caption tabular-nums text-faint">
                长期设定与记忆 {residentPct}% · 当前对话 {100 - residentPct}%
              </span>
            )}
          </div>

          {segments.length > 0 && totalBreakdownBytes > 0 ? (
            <>
              <div
                className="flex h-2.5 w-full overflow-hidden rounded-full bg-border/50"
                data-testid="context-breakdown-bar"
              >
                {segments.map((seg) => {
                  const widthPct = Math.max(2, (seg.bytes / totalBreakdownBytes) * 100);
                  return (
                    <span
                      key={seg.key}
                      title={`${seg.label}：约 ${Math.max(1, Math.round((seg.bytes / totalBreakdownBytes) * 100))}%`}
                      className={cn("h-full transition-[width] duration-300 first:rounded-l-full last:rounded-r-full", seg.barClass)}
                      style={{ width: `${widthPct}%` }}
                    />
                  );
                })}
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-caption">
                {segments.map((seg) => {
                  const share = Math.max(1, Math.round((seg.bytes / totalBreakdownBytes) * 100));
                  return (
                    <div
                      key={seg.key}
                      className="oc-surface-card flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
                    >
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-muted">
                        <span className={cn("size-2 shrink-0 rounded-full", seg.dotClass)} aria-hidden="true" />
                        <span className="truncate">{seg.label}</span>
                      </span>
                      <span className="shrink-0 font-medium tabular-nums text-fg">{share}%</span>
                    </div>
                  );
                })}
              </div>
              {residentBytes > sessionBytes && residentBytes > 12 * 1024 && (
                <p className="oc-callout oc-callout-info rounded-xl px-3 py-2 text-caption text-muted">
                  长期记忆与技能占比较高，后台会自动合并相似内容并收纳久未使用的项目，也可在下方随时查看。
                </p>
              )}
            </>
          ) : (
            <p className="oc-surface-recessed rounded-xl px-3 py-2.5 text-caption leading-relaxed text-muted">
              当前对话刚起步，随着聊天深入，系统会自动为你平衡记忆与较早对话记录。
            </p>
          )}
        </section>

        {/* 手动兜底操作区 */}
        <section className="space-y-2 pt-1">
          <div className="flex flex-wrap gap-2">
            {onCompact && (
              <Button
                variant="primary"
                size="sm"
                className="oc-btn-tactile oc-btn-primary-craft flex-1 gap-1.5"
                loading={compacting}
                disabled={!canCompact || compacting}
                onClick={() => {
                  onCompact();
                  onOpenChange(false);
                }}
              >
                <Minimize2 size={14} strokeWidth={1.8} aria-hidden="true" />
                立即整理较早对话
              </Button>
            )}
            {onStartNewSession && (
              <Button
                variant="secondary"
                size="sm"
                className="oc-btn-tactile oc-btn-secondary-craft gap-1.5"
                onClick={() => {
                  onOpenChange(false);
                  onStartNewSession();
                }}
              >
                <Plus size={14} strokeWidth={1.8} aria-hidden="true" />
                开启新会话
              </Button>
            )}
          </div>
          <p className="text-caption text-faint">
            整理只会精简较早对话的摘要，你的完整聊天记录始终保留在上方。
          </p>
        </section>

        {onOpenManageMemory && (
          <div className="border-t border-border/75 pt-3">
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onOpenManageMemory();
              }}
              className="oc-surface-card oc-surface-card-hover oc-btn-tactile group flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-left text-body font-medium text-fg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="inline-flex items-center gap-2">
                <span className="oc-icon-badge oc-icon-badge-accent size-6 rounded-md" aria-hidden="true">
                  <Sparkles size={13} strokeWidth={1.75} />
                </span>
                <span>查看长期记忆与已收纳记录</span>
              </span>
              <ArrowUpRight
                size={14}
                strokeWidth={1.75}
                aria-hidden="true"
                className="shrink-0 text-faint transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-fg"
              />
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ContextHealthPopover;
