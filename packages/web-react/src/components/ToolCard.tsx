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
import { Check, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { ToolBody } from "./tool/bodies";
import { normalizeToolForDisplay, type ToolLike } from "./tool/format";
import { resolveToolMeta, toolSummary } from "./tool/meta";
import { Badge, Spinner } from "./ui";

export type { ToolLike } from "./tool/format";

// 图标底色按工具语义分色(对齐设计稿 .tic.tn-*);error 单独走红。
const TONE_TILE: Record<string, string> = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-hover text-muted",
};

const RAW_TEXT_STEP = 128 * 1024;

function rawText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

function hasExactRecord(message: ToolLike): boolean {
  return !!message && typeof message === "object";
}

function ProgressiveRawText({ label, text }: { label: string; text: string }) {
  const [visibleChars, setVisibleChars] = useState(RAW_TEXT_STEP);
  const visible = Math.min(visibleChars, text.length);

  return (
    <section>
      <div className="mb-1 text-[11px] font-medium text-faint">{label}</div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-xs leading-relaxed text-fg">
        {text.slice(0, visible)}
      </pre>
      {visible < text.length && (
        <button
          type="button"
          onClick={() => setVisibleChars((value) => value + RAW_TEXT_STEP)}
          className="mx-auto mt-2 block rounded-full bg-hover px-3 py-1 text-xs text-muted hover:text-fg"
        >
          继续显示原始内容（还有 {(text.length - visible).toLocaleString()} 个字符）
        </button>
      )}
    </section>
  );
}

/**
 * 结构化工具卡只负责易读展示；这里始终保留 tape 中的原始输入/输出作为权威记录。
 * 长内容按固定步长逐段挂载，但没有总量上限，也不会用摘要替换原文。
 */
function ExactToolRecord({ message }: { message: ToolLike }) {
  return (
    <div className="mt-3 border-t border-border pt-3">
      <ProgressiveRawText label="原始完整记录" text={rawText(message)} />
    </div>
  );
}

/** Reusable for specialized cards that intentionally omit the generic tool shell. */
export function ExactToolRecordDisclosure({ message }: { message: ToolLike }) {
  const [showExact, setShowExact] = useState(false);
  if (!hasExactRecord(message)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setShowExact((value) => !value)}
        aria-expanded={showExact}
        className="mt-3 flex items-center gap-1.5 text-xs text-muted hover:text-fg"
      >
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={cn("transition-transform", showExact && "rotate-90")}
        />
        {showExact ? "收起原始完整记录" : "查看原始完整记录"}
      </button>
      {showExact && <ExactToolRecord message={message} />}
    </>
  );
}

export function ToolCard({ message }: { message: ToolLike }) {
  const display = normalizeToolForDisplay(message);
  const name = display.name;
  const input = display.input;
  const renderTool = display.tool;
  const meta = resolveToolMeta(name, input);
  const Icon = meta.icon;
  const summary = toolSummary(name, input);

  const completed = !!renderTool._completed;
  const isError = !!renderTool.error;
  // 取消(如 Codex item status 'cancelled')是中性终态:≠ 失败(不红)、≠ 运行中(不转圈)。
  const isCancelled = !isError && !!renderTool.cancelled;
  const isRunning = !completed && !isError && !isCancelled;
  const statusLabel = isRunning ? "运行中" : isError ? "失败" : isCancelled ? "已取消" : "完成";

  const hasInput = !!input && Object.keys(input).length > 0;
  const hasOutput = !!renderTool.output || !!renderTool.bashTail;
  const hasExact = hasExactRecord(message);
  const hasBody = hasInput || hasOutput || isError || hasExact;

  // 运行中（流式）默认展开以便边流边看 diff/输出；历史（挂载即完成）默认折叠。
  // 初值只在挂载求一次，之后用户手动 toggle 为权威（依赖稳定 key 保持实例）。
  const [open, setOpen] = useState(() => isRunning);

  return (
    <div
      className={cn(
        // 不带外边距——间距交由容器（MessageList 的 gap / AgentGroupCard 的 space-y）统一控制，
        // 避免 margin 与父级 gap 叠加导致卡片间距过大（boss 反馈"卡片间距好大"的根因之一）。
        "overflow-hidden rounded-lg border bg-surface",
        isRunning ? "border-accent-soft" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((o) => !o)}
        aria-expanded={hasBody ? open : undefined}
        className={cn(
          "flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left",
          hasBody && "cursor-pointer hover:bg-hover",
        )}
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md",
            isError ? "bg-danger-soft text-danger" : TONE_TILE[meta.tone ?? "accent"],
          )}
        >
          <Icon size={13} />
        </span>
        <span className="shrink-0 text-[13px] font-medium text-fg">{meta.label}</span>
        {summary && (
          <span className="min-w-0 truncate font-mono text-xs text-muted" title={summary}>
            {summary}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {/* running/done 的 spinner/✓ 是 aria-hidden，需 sr-only 播报状态；error/cancelled 的 Badge 自带可见文案，无需重复。 */}
          {!isError && !isCancelled && <span className="sr-only">{statusLabel}</span>}
          {isRunning ? (
            <Spinner size={13} className="text-accent" />
          ) : isError ? (
            <Badge tone="danger">失败</Badge>
          ) : isCancelled ? (
            <Badge tone="neutral">已取消</Badge>
          ) : (
            <Check size={14} className="text-success" aria-hidden="true" />
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
        <div className="border-t border-border px-3.5 py-2.5 [&>*:first-child]:mt-0">
          <ToolBody name={name} input={input} tool={renderTool} />
          {hasExact && <ExactToolRecordDisclosure message={message} />}
        </div>
      )}
    </div>
  );
}
