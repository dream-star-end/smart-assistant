/**
 * ToolCard —— 工具消息卡（Aurora 全新设计，功能 parity 现网 `_buildToolCard`）。
 *
 * 数据契约（props 约定，与 Core MessageRenderer/toolCardSlot 单一权威对齐）：接收
 * **单个 tool 消息对象** `message`，形态为 {@link ToolLike}
 * （toolName / inputJson / partialJson / inputPreview / _partial / _completed /
 * output / error / bashTail）。`ChatMessage`（role==='tool'）与 agent-group 的
 * `ChildBlock`（kind==='tool_use'）都结构兼容此类型 —— 因此本组件同时服务主流 tool 行
 * 与 agent-group 子块 tool。ToolLike 是 `ChatMessage | ChildBlock` 的结构超集（更宽容），
 * 故 Core 的 `ToolCardProps = { message: ChatMessage | ChildBlock }` 可直接赋值本组件
 * （其 toolCardSlot 的 `as unknown as` cast 落地后可安全删除）。
 * 调用：`<ToolCard message={msg} />` / `<ToolCard message={childBlock} />`。
 *
 * 重要：调用方必须以**稳定 key（消息 id）**挂载本组件，使展开/折叠的 useState 跨流式
 * 重渲存活（运行中默认展开、完成后保留用户选择的语义依赖于此）。
 *
 * 二级分派：按 toolName 走 {@link ToolBody}（builtin / MCP / Codex / generic）。
 * 流式：input 经 normalizeToolForDisplay/resolveToolInput 优先 inputJson、其次容错解析 partialJson —— Edit/Write
 * 的 diff/内容据此边流边渲；_completed 后切完整 inputJson。
 */
import { Check, ChevronRight, PanelRight } from "lucide-react";
import { useCallback, useState } from "react";
import { cn } from "../lib/utils";
import { TokenUsageBadge, type DisplayTokenUsage } from "./chat/tokenUsage";
import { ToolBody } from "./tool/bodies";
import { ToolInspectOpenContext, useArtifactInspect } from "./tool/context";
import {
  type ToolLike,
  normalizeToolForDisplay,
} from "./tool/format";
import { resolveToolMeta, toolSummary } from "./tool/meta";
import { Badge, Spinner } from "./ui";

export type { ToolLike } from "./tool/format";

// 图标底色按工具语义分色(对齐设计稿 .tic.tn-*)。
const TONE_TILE: Record<string, string> = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-hover text-muted",
};

export function ToolCard({
  message,
  tokenUsage,
}: {
  message: ToolLike;
  tokenUsage?: DisplayTokenUsage;
}) {
  const display = normalizeToolForDisplay(message);
  const name = display.name;
  const input = display.input;
  const renderTool = display.tool;
  const meta = resolveToolMeta(name, input);
  const Icon = meta.icon;
  const summary = toolSummary(name, input);

  // 产物详情列(Codex 式第三列):App 提供 open 才渲染入口;点击把本条 tool 消息
  // 引用交给面板全文渲染。回调同时经 ToolInspectOpenContext 下发给体内截断点。
  const inspect = useArtifactInspect();
  const inspectOpen = inspect.open;
  const openInspect = useCallback(() => {
    inspectOpen?.({ kind: "tool", message });
  }, [inspectOpen, message]);
  const canInspect = !!inspectOpen;

  const completed = !!renderTool._completed;
  const outputText = typeof renderTool.output === "string" ? renderTool.output : "";
  // 部分 CLI 会以 exit 0 返回语义失败（Playwright 的 markdown Error、网页反爬阻断）。
  // 这些明确形状应进入用户可见状态，而不是显示绿色完成。
  const reportedError = name === "Bash" && /^#{1,6}\s*Error\b/m.test(outputText);
  const isBlocked = name === "Bash" && /(?:^|\n)oc-web:\s*blocked:/i.test(outputText);
  const hasError = !!renderTool.error || reportedError;
  // 历史 tape 是不可变真记录：turn 已中断时，未完成 tool 代表被取消，而不是仍在运行。
  const isInterruptedHistorical =
    !completed && renderTool._timelineRecord === true && renderTool._dispatchOutcome === "interrupted";
  // 取消(如 Codex item status 'cancelled')是中性终态:≠ 失败(不红)、≠ 运行中(不转圈)。
  const isCancelled = !hasError && (!!renderTool.cancelled || isInterruptedHistorical);
  const isRunning = !completed && !hasError && !isBlocked && !isCancelled;
  // 单次工具异常属于助手内部执行过程：保留真实 error 数据和可展开详情，但前台
  // 不用红色「失败」抢占用户注意力。助手通常会自行换路径继续，表头只中性标记已结束。
  const statusLabel = isRunning
    ? "运行中"
    : hasError
      ? "已结束"
      : isBlocked
        ? "受阻"
        : isCancelled
          ? "已取消"
          : "完成";

  const hasInput = !!input && Object.keys(input).length > 0;
  const hasOutput = !!renderTool.output || !!renderTool.bashTail;
  const hasBody = hasInput || hasOutput || hasError || isBlocked;

  // 运行中（流式）默认展开以便边流边看 diff/输出；历史（挂载即完成）默认折叠。
  // 初值只在挂载求一次，之后用户手动 toggle 为权威（依赖稳定 key 保持实例）。
  // 状态只决定首次挂载；之后用户的展开选择始终为权威，流式状态迁移不强制跳动。
  const isConfirmation = outputText.includes('"confirmation_required"');
  const [open, setOpen] = useState(() => isRunning || isBlocked || isConfirmation);

  return (
    <div
      className={cn(
        // 不带外边距——间距交由容器（MessageList 的 gap / AgentGroupCard 的 space-y）统一控制，
        // 避免 margin 与父级 gap 叠加导致卡片间距过大（boss 反馈"卡片间距好大"的根因之一）。
        "overflow-hidden rounded-md border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.025)] transition-colors",
        isBlocked
          ? "border-warning/35"
          : isRunning
            ? "border-accent/25"
            : "border-border hover:border-border-strong",
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        aria-expanded={hasBody ? open : undefined}
        className={cn(
          "flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          hasBody && "cursor-pointer hover:bg-hover/70 active:bg-active/70",
        )}
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            TONE_TILE[meta.tone ?? "accent"],
          )}
        >
          <Icon size={14} />
        </span>
        <span className="shrink-0 text-[13px] font-semibold text-fg">{meta.label}</span>
        {summary && (
          <span className="min-w-0 truncate font-mono text-xs text-muted" title={summary}>
            {summary}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <TokenUsageBadge usage={tokenUsage} />
          {/* 运行态 spinner 是 aria-hidden，需 sr-only 播报；其余状态均有可见 Badge 文案。 */}
          {isRunning && <span className="sr-only">{statusLabel}</span>}
          {isRunning ? (
            <Spinner size={13} className="text-accent" />
          ) : hasError ? (
            <Badge tone="neutral">已结束</Badge>
          ) : isBlocked ? (
            <Badge tone="warning">受阻</Badge>
          ) : isCancelled ? (
            <Badge tone="neutral">已取消</Badge>
          ) : (
            <Badge tone="success" className="gap-1.5">
              <Check size={11} aria-hidden="true" />
              完成
            </Badge>
          )}
          {canInspect && hasBody && (
            // 表头本身是 <button>(展开/折叠),入口用 role=button 的 span 避免非法嵌套;
            // stopPropagation 使「打开详情」不连带触发折叠切换。
            <span
              role="button"
              tabIndex={0}
              aria-label="在详情面板查看"
              title="在详情面板查看"
              onClick={(e) => {
                e.stopPropagation();
                openInspect();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  openInspect();
                }
              }}
              className="flex size-6 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
            >
              <PanelRight size={14} />
            </span>
          )}
          {hasBody && (
            <ChevronRight
              size={15}
              aria-hidden="true"
              className={cn("text-faint transition-transform", open && "rotate-90")}
            />
          )}
        </span>
      </button>
      {open && hasBody && (
        <div className="border-t border-border/80 bg-bg/35 px-3 py-2 [&>*:first-child]:mt-0">
          <ToolInspectOpenContext.Provider value={canInspect ? openInspect : null}>
            <ToolBody name={name} input={input} tool={renderTool} />
          </ToolInspectOpenContext.Provider>
        </div>
      )}
    </div>
  );
}
