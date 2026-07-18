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
import { AlertTriangle, Check, ChevronRight, FileText } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import type { ChatMessage } from "../lib/chat/model";
import { formatTapeBytes, isRecordTruncated } from "../lib/chat/render";
import type { TapeRecordsResult } from "./chat/cards";
import { ToolBody } from "./tool/bodies";
import { normalizeToolForDisplay, type ToolLike } from "./tool/format";
import { resolveToolMeta, toolSummary } from "./tool/meta";
import { Badge, Spinner } from "./ui";

export type { ToolLike } from "./tool/format";

/**
 * §9 截断工具输出卡尾部(RFC §9.1)。逐记录超 64KB 的工具输出被截断(带 `_fullBytes`),此处显示
 * "输出已截断（共 N MB），查看完整" —— 点击经同一 tape 记录端点拉取更完整版本,内联抽屉呈现。
 * server 端点亦 chat-safe 有界(单记录解析上限),故"完整"= 端点允许的更完整版本,非 exact 原始 payload。
 */
/** 前端"查看完整"拼接上限:超出只展示前 4MB(避免超大记录拉爆内存/DOM)。 */
const VIEW_FULL_MAX_BYTES = 4 * 1024 * 1024;

function TruncatedRecordFooter({
  message,
  onFetch,
  onFetchRecordChunk,
}: {
  message: ChatMessage;
  onFetch?: (tapeId: string, cursor: number | null) => Promise<TapeRecordsResult>;
  onFetchRecordChunk?: (
    tapeId: string,
    recordOrdinal: number,
    offset: number,
  ) => Promise<{ chunk: string; nextOffset: number | null; totalBytes: number } | null>;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [full, setFull] = useState<string | null>(null);
  const [overflow, setOverflow] = useState(false);
  // M6②(R3):分块拉取中途拿不到块(限频/瞬态错)→ 已拉到的是**半截**,标 incomplete 并显式提示,
  // 绝不把半截当完整。
  const [incomplete, setIncomplete] = useState(false);
  const fullBytes = message._fullBytes;
  const tapeId = message._turnTapeId;
  const recordId = message.id;
  // M-§9-1:截断行携 `_recordOrdinal`(server 附)→ 走按记录分块拉取真通路(不整卷)。
  const recordOrdinal = (message as { _recordOrdinal?: number })._recordOrdinal;
  const canChunk =
    !!onFetchRecordChunk && typeof tapeId === "string" && tapeId.length > 0 && typeof recordOrdinal === "number";
  const canView = canChunk || (!!onFetch && typeof tapeId === "string" && tapeId.length > 0);

  const viewFull = async () => {
    if (!tapeId || loading) return;
    setLoading(true);
    setError(false);
    setOverflow(false);
    setIncomplete(false);
    try {
      // 优先:M-§9-1 按记录分块拉取拼接(真"完整";上限 4MB UTF-8 字节,超出提示"内容过大")。
      if (canChunk && onFetchRecordChunk && typeof recordOrdinal === "number") {
        const enc = new TextEncoder();
        const parts: string[] = [];
        let bytes = 0;
        let offset = 0;
        for (let i = 0; i < 64; i++) {
          const res = await onFetchRecordChunk(tapeId, recordOrdinal, offset);
          if (!res) {
            // M6②(R3):中途拿不到块(限频/瞬态错)。已拉到内容为空 → 纯失败;非空 → 半截,标
            // incomplete(显式"内容加载不完整,请稍后重试"),**绝不把半截冒充完整**。
            if (parts.length === 0) setError(true);
            else setIncomplete(true);
            break;
          }
          // M6③(R3):4MB 上限按 **UTF-8 字节**(TextEncoder)非 JS 字符数。加本块会越限 → 停在整块
          // 边界(server 单块已按 utf8 安全切,故不切裂多字节字符),标 overflow 只展示已拉部分。
          const chunkBytes = enc.encode(res.chunk).length;
          if (bytes + chunkBytes > VIEW_FULL_MAX_BYTES) {
            setOverflow(true);
            break;
          }
          parts.push(res.chunk);
          bytes += chunkBytes;
          if (typeof res.nextOffset !== "number") break;
          offset = res.nextOffset;
        }
        if (parts.length > 0) setFull(parts.join(""));
        return;
      }
      // 兜底:老分页扫描(端点仅回截断预览)——跨页找该记录(≤12 页)。
      if (!onFetch) { setError(true); return; }
      let cursor: number | null = null;
      for (let page = 0; page < 12; page++) {
        const res: TapeRecordsResult = await onFetch(tapeId, cursor);
        if (!res) {
          setError(true);
          break;
        }
        const hit = res.records.find((r) => r?.id === recordId);
        if (hit) {
          const text =
            typeof hit.output === "string" && hit.output.length > 0
              ? hit.output
              : typeof hit.text === "string"
                ? hit.text
                : "";
          setFull(text);
          break;
        }
        if (typeof res.nextCursor !== "number") {
          setError(true); // 扫完全部页仍未命中
          break;
        }
        cursor = res.nextCursor;
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const sizeLabel = formatTapeBytes(fullBytes);
  return (
    <div className="mt-2 border-t border-dashed border-border pt-2 text-xs text-muted">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle size={13} className="shrink-0 text-warning" />
        <span>输出已截断{sizeLabel ? `（共 ${sizeLabel}）` : ""}</span>
        {full === null && canView && (
          <button
            type="button"
            onClick={() => void viewFull()}
            disabled={loading}
            aria-busy={loading}
            className="inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-muted hover:text-fg disabled:opacity-60 [@media(hover:none)]:min-h-9 [@media(hover:none)]:py-2"
          >
            {loading ? <Spinner size={12} /> : <FileText size={12} />} 查看完整
          </button>
        )}
      </div>
      {error && <div className="mt-1 text-[11px] text-danger">未能加载完整内容，请重试。</div>}
      {incomplete && (
        <div className="mt-1 text-[11px] text-warning">内容加载不完整，请稍后重试。</div>
      )}
      {overflow && (
        <div className="mt-1 text-[11px] text-warning">内容过大，已展示前 4MB。</div>
      )}
      {full !== null && (
        <pre className="mt-1.5 max-h-96 max-w-full overflow-auto whitespace-pre-wrap rounded-md bg-code px-2.5 py-2 text-[11px] text-fg/90 [overflow-wrap:anywhere]">
          {full}
        </pre>
      )}
    </div>
  );
}

// 图标底色按工具语义分色(对齐设计稿 .tic.tn-*);error 单独走红。
const TONE_TILE: Record<string, string> = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-hover text-muted",
};

export function ToolCard({
  message,
  onFetchTapeRecords,
  onFetchTapeRecordChunk,
}: {
  message: ToolLike;
  onFetchTapeRecords?: (tapeId: string, cursor: number | null) => Promise<TapeRecordsResult>;
  onFetchTapeRecordChunk?: (
    tapeId: string,
    recordOrdinal: number,
    offset: number,
  ) => Promise<{ chunk: string; nextOffset: number | null; totalBytes: number } | null>;
}) {
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

  // §9 逐记录截断(仅主流 tool 行携带 `_fullBytes`;agent-group 子块无此字段 → false)。
  const showTruncated = isRecordTruncated(message as ChatMessage);
  const hasInput = !!input && Object.keys(input).length > 0;
  const hasOutput = !!renderTool.output || !!renderTool.bashTail;
  const hasBody = hasInput || hasOutput || isError || showTruncated;

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
          {showTruncated && (
            <TruncatedRecordFooter
              message={message as ChatMessage}
              onFetch={onFetchTapeRecords}
              onFetchRecordChunk={onFetchTapeRecordChunk}
            />
          )}
        </div>
      )}
    </div>
  );
}
