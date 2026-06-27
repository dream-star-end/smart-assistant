/**
 * agent-group 卡（子 agent 容器，Aurora 全新设计）。
 *  - 父卡可折叠：运行中默认展开（看实时进度）、完成默认折叠（收成一行摘要）；用户点击
 *    表头后由本地 state 锁定，跨流式重渲不回弹。
 *  - body 递归渲染 childBlocks：text→markdown / thinking→静默块 / tool_use→ToolCardSlot
 *    （子块字段与 tool 消息同形）。reducer 已把子 agent 嵌套 Agent 扁平进同一组（最多两层）。
 *  - 防闪：每个子块按 childSignature memo，完成的子块不随后续子块流式而重建。
 */
import { Check, ChevronRight, Users, X } from "lucide-react";
import { memo, useState } from "react";
import type { ChatMessage, ChildBlock } from "../../lib/chat/model";
import { childSignature } from "../../lib/chat/render";
import { cn } from "../../lib/utils";
import { Badge, Spinner } from "../ui";
import { Markdown } from "../Markdown";
import { ToolCardSlot } from "./toolCardSlot";

export const ChildBlockView = memo(
  function ChildBlockView({ child }: { child: ChildBlock; sig: string }) {
    if (child.kind === "text") {
      if (!child.text) return null;
      return <Markdown signMedia>{child.text}</Markdown>;
    }
    if (child.kind === "thinking") {
      if (!child.text) return null;
      return (
        <div className="whitespace-pre-wrap break-words rounded-md bg-surface/60 px-3 py-2 text-[12.5px] leading-relaxed text-muted">
          {child.text}
        </div>
      );
    }
    if (child.kind === "tool_use") {
      const nested = /^Agent$/i.test(child.toolName || "");
      return (
        <div className={cn(nested && "border-l-2 border-accent/30 pl-2")}>
          <ToolCardSlot message={child} />
        </div>
      );
    }
    // tool_result / tool_output_tail 已被 reducer 并进 tool_use；不独立渲染。
    return null;
  },
  (a, b) => a.sig === b.sig,
);

// 不外包 memo:本卡只收 {msg},而 reducer 就地 mutate(msg 引用不变)→ 默认浅比较会永不
// 重渲(_completed/childBlocks 改了画面不更新,曾致委托卡永远"运行中")。重渲已由上层
// MessageRenderer 的 messageSignature memo 把关(sig 变才渲染本卡),这层 memo 冗余且有害。
export function AgentGroupCard({ msg }: { msg: ChatMessage }) {
  const running = !msg._completed;
  const isError = !!msg._isError;
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const collapsed = userCollapsed ?? !!msg._completed;
  const children = msg.childBlocks ?? [];

  return (
    <div className="rounded-lg border border-border bg-surface animate-in">
      <button
        type="button"
        onClick={() => setUserCollapsed(!collapsed)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-hover"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          {running ? <Spinner size={13} /> : isError ? <X size={13} /> : <Users size={13} />}
        </span>
        <span className="min-w-0 truncate text-[13px] font-medium text-fg">{msg.text || "子任务"}</span>
        <span className="ml-auto flex items-center gap-2">
          {running ? (
            <Badge tone="accent">运行中</Badge>
          ) : (
            <Badge tone={isError ? "danger" : "success"}>
              {isError ? "失败" : "完成"}
              {typeof msg._duration === "number" && msg._duration > 0
                ? ` · ${Math.round(msg._duration / 1000)}s`
                : ""}
            </Badge>
          )}
          <ChevronRight
            size={15}
            className={cn("text-faint transition-transform", !collapsed && "rotate-90")}
          />
        </span>
      </button>

      {!collapsed && (
        <div className="space-y-2 border-t border-border px-3.5 py-2.5">
          {children.length === 0 && running && (
            <div className="flex items-center gap-2 text-[12.5px] text-faint">
              <Spinner size={12} /> 子智能体启动中…
            </div>
          )}
          {children.map((ch, i) => (
            <ChildBlockView key={`${i}-${ch.blockId ?? ch.kind}`} child={ch} sig={childSignature(ch)} />
          ))}
        </div>
      )}

      {/* 折叠态下展示结果摘要（完成后） */}
      {collapsed && msg._completed && msg._resultPreview && (
        <div className="flex items-start gap-1.5 border-t border-border px-3.5 py-2 text-[12.5px] text-muted">
          <Check size={13} className="mt-0.5 shrink-0 text-success" />
          <span className="line-clamp-2">{msg._resultPreview}</span>
        </div>
      )}
    </div>
  );
}
