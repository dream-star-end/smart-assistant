/**
 * InspectorPanel —— 产物详情列(Codex 桌面版式的第三列)。
 *
 * 点击会话消息流中的产物(工具卡表头入口 / diff·输出截断处「查看全文」)后,
 * 在主消息流右侧弹出本面板,以**全文模式**(ToolBodyFullContext=true,各截断上限放开)
 * 渲染同一条 tool 消息:文件编辑 diff 全文、终端命令与输出全文、读文件/检索结果全文等。
 *
 * 布局接入(App.tsx):
 *   - 桌面(md+):作为根 flex 的第三列 <aside> 内联渲染,与 Sidebar | main 并列;
 *   - 窄屏:不挤三列,复用 Sheet side="right" 抽屉呈现同一 InspectorPanelContent。
 *
 * 数据:target.message 持 ChatSocket 就地 mutate 的消息对象引用,App 随 version 重渲
 * 时面板自然读到最新流式内容(运行中的工具在面板里也会边流边更新)。
 */
import { X } from "lucide-react";
import { useEffect } from "react";
import { ToolBody } from "./tool/bodies";
import { ToolBodyFullContext, type ArtifactInspectTarget } from "./tool/context";
import { normalizeToolForDisplay } from "./tool/format";
import { resolveToolMeta, toolSummary } from "./tool/meta";
import { Badge, Spinner } from "./ui";
import { cn } from "../lib/utils";

const TONE_TILE: Record<string, string> = {
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-hover text-muted",
};

/** 面板内容(头 + 全文体)。桌面 aside 与移动 Sheet 共用。 */
export function InspectorPanelContent({
  target,
  onClose,
}: {
  target: ArtifactInspectTarget;
  onClose: () => void;
}) {
  const display = normalizeToolForDisplay(target.message);
  const meta = resolveToolMeta(display.name, display.input);
  const Icon = meta.icon;
  const summary = toolSummary(display.name, display.input);
  const tool = display.tool;
  const completed = !!tool._completed;
  const hasError = !!tool.error;
  const isRunning = !completed && !hasError && !tool.cancelled;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3 header-safe-t">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            TONE_TILE[meta.tone ?? "accent"],
          )}
        >
          <Icon size={14} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-fg">{meta.label}</span>
            {isRunning ? (
              <Spinner size={13} className="text-accent" />
            ) : hasError ? (
              <Badge tone="neutral">已结束</Badge>
            ) : tool.cancelled ? (
              <Badge tone="neutral">已取消</Badge>
            ) : (
              <Badge tone="success">完成</Badge>
            )}
          </div>
          {summary && (
            <div className="mt-0.5 truncate font-mono text-xs text-muted" title={summary}>
              {summary}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="关闭详情面板"
          onClick={onClose}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 [&>*:first-child]:mt-0">
        <ToolBodyFullContext.Provider value={true}>
          <ToolBody name={display.name} input={display.input} tool={tool} />
        </ToolBodyFullContext.Provider>
      </div>
    </div>
  );
}

/** 桌面第三列:内联 aside(与 Sidebar/main 并列)。Escape 关闭(让位于已消费的弹层)。 */
export function InspectorPanel({
  target,
  onClose,
}: {
  target: ArtifactInspectTarget;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Radix 弹层(Dialog/Sheet/Popover)处理过的 Escape 会 preventDefault,不抢。
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      aria-label="产物详情"
      className="flex min-h-0 w-[clamp(20rem,36vw,34rem)] shrink-0 flex-col border-l border-border"
    >
      <InspectorPanelContent target={target} onClose={onClose} />
    </aside>
  );
}
