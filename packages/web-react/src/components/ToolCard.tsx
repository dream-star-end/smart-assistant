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
 * 状态：四态 + 受阻 + 取消全部来自 {@link resolveToolStatus}（与详情面板同一权威，T-05）。
 */
import { Check, ChevronRight, PanelRight } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { TokenUsageBadge, type DisplayTokenUsage } from "./chat/tokenUsage";
import { ToolBody } from "./tool/bodies";
import {
  ToolHeaderLabelContext,
  ToolInspectOpenContext,
  useArtifactInspect,
  useArtifactInspectActive,
} from "./tool/context";
import {
  type ToolLike,
  normalizeToolForDisplay,
} from "./tool/format";
import { resolveToolMeta, toolSummary } from "./tool/meta";
import { resolveToolStatus } from "./tool/status";
import { toneTileClass } from "./tool/tone";
import { Badge, IconButton, Spinner } from "./ui";

export type { ToolLike } from "./tool/format";

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
  // 表头各段的 id:按钮可及名走 aria-labelledby 拼「标签 + 摘要 + 错误首行 + 状态」(T-22),
  // 不再用 aria-label 把按钮内的可见文本全部覆盖掉。
  const uid = useId();
  const labelId = `${uid}-label`;
  const summaryId = `${uid}-summary`;
  const errorId = `${uid}-error`;
  const statusId = `${uid}-status`;

  // 产物详情列(Codex 式第三列):App 提供 open 才渲染入口;点击把本条 tool 消息
  // 引用交给面板全文渲染。回调同时经 ToolInspectOpenContext 下发给体内截断点。
  const inspect = useArtifactInspect();
  const inspectOpen = inspect.open;
  const openInspect = useCallback(() => {
    inspectOpen?.({ kind: "tool", message });
  }, [inspectOpen, message]);
  const canInspect = !!inspectOpen;
  // 面板正在看的就是本条 → 选中态描边(T-18),多卡同列时知道面板对应哪一条。
  const activeMessage = useArtifactInspectActive();
  const isActive = canInspect && activeMessage !== null && activeMessage === message;

  const status = resolveToolStatus(display);
  const { hasError, isBlocked, isRunning, isCancelled, errorFirstLine } = status;

  const hasInput = !!input && Object.keys(input).length > 0;
  const hasOutput = !!renderTool.output || !!renderTool.bashTail;
  const hasBody = hasInput || hasOutput || hasError || isBlocked;

  // 运行中（流式）默认展开以便边流边看 diff/输出；历史（挂载即完成）默认折叠。
  // 未成功的卡也默认展开:错误详情是用户此刻最需要的信息,不该多一次点击。
  // 初值只在挂载求一次，之后用户手动 toggle 为权威（依赖稳定 key 保持实例）。
  const [open, setOpen] = useState(
    () => isRunning || isBlocked || status.isConfirmation || hasError,
  );
  const userToggled = useRef(false);
  // 挂载时还是「完成/折叠」、随后归并成 error:true 的历史消息,同样按 F1 展开(T-07);
  // 用户已手动折叠过则尊重用户,不再跳动。
  useEffect(() => {
    if (hasError && !userToggled.current) setOpen(true);
  }, [hasError]);

  // 无 body 的卡表头不渲染成 button(L5):没有可展开的内容,不该有可点语义。
  const HeaderTag = hasBody ? ("button" as const) : ("div" as const);
  const labelledBy = [labelId, summary ? summaryId : "", errorFirstLine ? errorId : "", statusId]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={cn(
        // 不带外边距——间距交由容器（MessageList 的 gap / AgentGroupCard 的 space-y）统一控制，
        // 避免 margin 与父级 gap 叠加导致卡片间距过大（boss 反馈"卡片间距好大"的根因之一）。
        "overflow-hidden rounded-md border bg-surface shadow-[0_1px_2px_rgba(0,0,0,0.025)] transition-colors",
        hasError
          ? "border-danger/25"
          : isBlocked
            ? "border-warning/35"
            : isRunning
              ? "border-accent/25"
              : "border-border hover:border-border-strong",
        isActive && "ring-1 ring-accent/40",
      )}
    >
      <div className="flex items-stretch">
      <HeaderTag
        {...(hasBody
          ? {
              type: "button" as const,
              onClick: () => {
                userToggled.current = true;
                setOpen((o) => !o);
              },
              "aria-expanded": open,
              "aria-labelledby": labelledBy,
            }
          : {})}
        className={cn(
          "flex min-h-11 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          hasBody && "cursor-pointer hover:bg-hover/70 active:bg-active/70",
        )}
      >
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            toneTileClass(meta.tone),
          )}
        >
          <Icon size={14} />
        </span>
        {/* 窄屏(L7):标题限宽、摘要优先截断,右侧徽章区 shrink-0 保持完整可见。 */}
        <span id={labelId} className="min-w-0 max-w-[45%] shrink-0 truncate text-body font-semibold text-fg">
          {meta.label}
        </span>
        {summary && (
          <span
            id={summaryId}
            // 有错误首行时,窄屏把整行让给错误(T-11):摘要藏起来,错误首行单独占表头下一行。
            className={cn(
              "min-w-0 truncate font-mono text-xs text-muted",
              errorFirstLine && "hidden sm:inline",
            )}
            title={summary}
          >
            {summary}
          </span>
        )}
        {errorFirstLine && (
          <span
            id={errorId}
            className="hidden min-w-0 truncate text-xs text-danger sm:inline"
            title={errorFirstLine}
          >
            {errorFirstLine}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <TokenUsageBadge usage={tokenUsage} />
          {/* 状态区 aria-live:运行中→完成/未成功的迁移会被读屏播报(T-22)。
              运行态 spinner 是 aria-hidden，需 sr-only 播报；其余状态均有可见 Badge 文案。 */}
          <span id={statusId} aria-live="polite" className="flex items-center">
            {isRunning && <span className="sr-only">{status.label}</span>}
            {isRunning ? (
              <Spinner size={13} className="text-accent" />
            ) : hasError ? (
              <Badge tone="danger">{status.label}</Badge>
            ) : isBlocked ? (
              <Badge tone="warning">{status.label}</Badge>
            ) : isCancelled ? (
              <Badge tone="neutral">{status.label}</Badge>
            ) : (
              <Badge tone="success" className="gap-1.5">
                <Check size={11} aria-hidden="true" />
                {status.label}
              </Badge>
            )}
          </span>
          {hasBody && (
            <ChevronRight
              size={15}
              aria-hidden="true"
              className={cn("text-faint transition-transform", open && "rotate-90")}
            />
          )}
        </span>
      </HeaderTag>
      {canInspect && hasBody && (
        <div className="flex shrink-0 items-center pr-2">
          <IconButton
            size="sm"
            shape="square"
            aria-label="在详情面板查看"
            aria-pressed={isActive || undefined}
            title="在详情面板查看"
            onClick={(e) => {
              e.stopPropagation();
              openInspect();
            }}
          >
            <PanelRight size={14} />
          </IconButton>
        </div>
      )}
      </div>
      {/* 窄屏专用:错误首行独立成行(桌面在表头同行,见上;此处 aria-hidden 防读屏重复)。 */}
      {errorFirstLine && (
        <div
          aria-hidden="true"
          className="truncate px-3 pb-1.5 text-xs text-danger sm:hidden"
          title={errorFirstLine}
        >
          {errorFirstLine}
        </div>
      )}
      {open && hasBody && (
        <div className="border-t border-border/80 bg-bg/35 px-3 py-2 [&>*:first-child]:mt-0">
          <ToolInspectOpenContext.Provider value={canInspect ? openInspect : null}>
            <ToolHeaderLabelContext.Provider value={meta.label}>
              <ToolBody name={name} input={input} tool={renderTool} />
            </ToolHeaderLabelContext.Provider>
          </ToolInspectOpenContext.Provider>
        </div>
      )}
    </div>
  );
}
