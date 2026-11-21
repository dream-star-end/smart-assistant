import { ArrowUpRight, Gauge, Minimize2, Plus, Sparkles } from "lucide-react";
import type { SessionContextPressureState } from "../../lib/chat/model";
import { formatBytes } from "../../lib/chat/download";
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

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(tokens);
}

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
    { key: "system", label: "系统与人格", group: "resident", bytes: b.systemBytes ?? 0, barClass: "bg-accent", dotClass: "bg-accent" },
    { key: "memory", label: "核心记忆", group: "resident", bytes: b.memoryBytes ?? 0, barClass: "bg-info", dotClass: "bg-info" },
    { key: "skills", label: "技能清单", group: "resident", bytes: b.skillsBytes ?? 0, barClass: "bg-success", dotClass: "bg-success" },
    { key: "project", label: "项目上下文", group: "resident", bytes: b.projectBytes ?? 0, barClass: "bg-warning", dotClass: "bg-warning" },
    { key: "history", label: "对话历史", group: "session", bytes: b.historyBytes ?? 0, barClass: "bg-fg/55", dotClass: "bg-fg/55" },
    { key: "tools", label: "工具与附件", group: "session", bytes: b.toolsBytes ?? 0, barClass: "bg-muted/70", dotClass: "bg-muted/70" },
  ];
  return raw.filter((s) => s.bytes > 0);
}

/**
 * 对话内「上下文健康与瘦身」弹层（懒加载 chunk，零首屏开销）。
 * 桌面居中轻量卡片、手机端自动切换贴底 Sheet；纯 CSS 分段堆叠条展示常驻底噪 vs 当前会话。
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
    ? "上下文已接近上限"
    : isWarning
      ? "上下文偏高，建议瘦身"
      : isElevated
        ? "上下文使用中偏高"
        : pct !== null
          ? "上下文健康"
          : "等待实时水位样本";

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
          <span
            className={cn(
              "oc-icon-badge size-6 rounded-md",
              isCritical ? "oc-icon-badge-danger" : isWarning ? "oc-icon-badge-warning" : "oc-icon-badge-accent",
            )}
            aria-hidden="true"
          >
            <Gauge size={13} strokeWidth={1.8} />
          </span>
          <span className="text-title font-semibold tracking-tight text-fg">会话上下文健康</span>
        </span>
      }
      className="oc-surface-popover bg-surface"
    >
      <div className="space-y-4" data-testid="context-health-popover">
        {/* 水位总览 */}
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
            aria-label="当前上下文窗口占用率"
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

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-caption tabular-nums text-muted">
            {pressure?.usedTokens !== undefined && pressure?.windowTokens ? (
              <span>
                已用 {formatCompactTokens(pressure.usedTokens)} / {formatCompactTokens(pressure.windowTokens)} tokens
              </span>
            ) : pressure?.usedTokens !== undefined ? (
              <span>当前窗口约 {formatCompactTokens(pressure.usedTokens)} tokens</span>
            ) : (
              <span>发出消息或到达阈值后自动更新实时窗口水位</span>
            )}
            {pressure?.engine && <span className="text-faint">{pressure.engine}</span>}
          </div>
        </section>

        {/* 成分拆解：纯 CSS 分段堆叠条（常驻底噪 vs 当前会话） */}
        <section className="space-y-2.5" aria-label="上下文成分拆解">
          <div className="flex items-baseline justify-between gap-2">
            <h4 className="text-meta font-semibold text-fg">成分拆解</h4>
            {totalBreakdownBytes > 0 && (
              <span className="text-caption tabular-nums text-faint">
                常驻底噪 {residentPct}% · 本会话 {100 - residentPct}%
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
                      title={`${seg.label}：${formatBytes(seg.bytes)}`}
                      className={cn("h-full transition-[width] duration-300 first:rounded-l-full last:rounded-r-full", seg.barClass)}
                      style={{ width: `${widthPct}%` }}
                    />
                  );
                })}
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-caption">
                {segments.map((seg) => (
                  <div
                    key={seg.key}
                    className="oc-surface-card flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
                  >
                    <span className="inline-flex min-w-0 items-center gap-1.5 text-muted">
                      <span className={cn("size-2 shrink-0 rounded-full", seg.dotClass)} aria-hidden="true" />
                      <span className="truncate">{seg.label}</span>
                    </span>
                    <span className="shrink-0 font-medium tabular-nums text-fg">{formatBytes(seg.bytes)}</span>
                  </div>
                ))}
              </div>
              {residentBytes > sessionBytes && residentBytes > 12 * 1024 && (
                <p className="oc-callout oc-callout-warning rounded-xl px-3 py-2 text-caption text-warning">
                  常驻底噪（{formatBytes(residentBytes)}）占比较高，建议前往管理中心归档过期记忆或低频技能。
                </p>
              )}
            </>
          ) : (
            <p className="oc-surface-recessed rounded-xl px-3 py-2.5 text-caption leading-relaxed text-muted">
              当前引擎暂未回报细分字节占比，你仍可一键压缩本会话，或前往管理中心检查长期记忆与技能底噪。
            </p>
          )}
        </section>

        {/* 操作区 */}
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
                一键压缩当前会话
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
            压缩仅精简发送给模型的上下文摘要，你的完整对话记录仍会保留在时间线中。
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
                <span>治理长期记忆与技能</span>
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
