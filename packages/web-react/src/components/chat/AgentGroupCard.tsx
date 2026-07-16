/**
 * agent-group 卡（子 agent 容器，Aurora 全新设计）。
 *  - 父卡可折叠：运行中默认展开（看实时进度）、完成默认折叠（收成一行摘要）；用户点击
 *    表头后由本地 state 锁定，跨流式重渲不回弹。
 *  - body 递归渲染 childBlocks：text→markdown / thinking→静默块 / tool_use→ToolCardSlot
 *    （子块字段与 tool 消息同形）。reducer 已把子 agent 嵌套 Agent 扁平进同一组（最多两层）。
 *  - 防闪：每个子块按 childSignature memo，完成的子块不随后续子块流式而重建。
 */
import { Check, ChevronRight, Clock, Users, X } from "lucide-react";
import { memo, useState } from "react";
import { type ChatMessage, type ChildBlock, isServerAuthoredRow } from "../../lib/chat/model";
import { agentTerminalStatus, childSignature, reviewVerdictBadge } from "../../lib/chat/render";
import { cn, groupDigits } from "../../lib/utils";
import { Badge, Spinner } from "../ui";
import { Markdown } from "../Markdown";
import { ToolCardSlot } from "./toolCardSlot";

/** 终态图标(与 agentTerminalStatus tone 对齐):完成→Users、失败→X、超时→Clock。 */
export function TerminalIcon({ tone, size }: { tone: "success" | "danger" | "warning"; size: number }) {
  if (tone === "warning") return <Clock size={size} />;
  if (tone === "danger") return <X size={size} />;
  return <Users size={size} />;
}

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

// 不外包 memo:本卡只收 {msg, delegateCost},而 reducer 就地 mutate(msg 引用不变)→ 默认浅比较会永不
// 重渲(_completed/childBlocks 改了画面不更新,曾致委托卡永远"运行中")。重渲已由上层
// MessageRenderer 的 messageSignature memo(sig 变)+ 比较器(delegateCost 变)把关,这层 memo 冗余且有害。
// delegateCost = 该委派本 turn 的成本(债D,来自队长助手行 usage.delegates,按 agentId 匹配);
// 单个委派退化态(未成团)在此显示「· N 积分」。
export function AgentGroupCard({ msg, delegateCost }: { msg: ChatMessage; delegateCost?: string }) {
  // server-authored 骨架行是跨设备终态快照,永远不是"运行中"(无 childBlocks 过程树)。
  const isServerRow = isServerAuthoredRow(msg);
  const running = !msg._completed && !isServerRow;
  const status = agentTerminalStatus(msg);
  // 审查裁决徽记:仅隐藏审查员行返回非 null(PASS/未通过),与执行态徽记并列。
  const verdict = reviewVerdictBadge(msg);
  const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
  const collapsed = userCollapsed ?? (!!msg._completed || isServerRow);
  const children = msg.childBlocks ?? [];
  const terminalNoChildren = !running && children.length === 0;

  return (
    <div className="rounded-lg border border-border bg-surface animate-in">
      <button
        type="button"
        onClick={() => setUserCollapsed(!collapsed)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-hover"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
          {running ? <Spinner size={13} /> : <TerminalIcon tone={status.tone} size={13} />}
        </span>
        <span className="min-w-0 truncate text-[13px] font-medium text-fg">{msg.text || "子任务"}</span>
        <span className="ml-auto flex max-w-[55%] flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {running ? (
            <Badge tone="accent">运行中</Badge>
          ) : (
            <Badge tone={status.tone}>
              {status.label}
              {typeof msg._duration === "number" && msg._duration > 0
                ? ` · ${Math.round(msg._duration / 1000)}s`
                : ""}
            </Badge>
          )}
          {verdict && <Badge tone={verdict.tone}>{verdict.label}</Badge>}
          {delegateCost && (
            <span className="text-[11px] font-medium text-faint">{groupDigits(delegateCost)} 积分</span>
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
          {/* server 骨架行(或任何无 childBlocks 的终态卡)展开态展示结果摘要;server 行附一句
              过程明细降级说明(跨设备只保团队结构+终态,过程树仅在发起设备本地)。 */}
          {terminalNoChildren && (msg._resultPreview || isServerRow) && (
            <div className="space-y-1.5">
              {msg._resultPreview && (
                <div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted">
                  {msg._resultPreview}
                </div>
              )}
              {isServerRow && (
                <div className="text-[11.5px] text-faint">过程明细仅在发起设备可见</div>
              )}
            </div>
          )}
          {children.map((ch, i) => (
            <ChildBlockView key={`${i}-${ch.blockId ?? ch.kind}`} child={ch} sig={childSignature(ch)} />
          ))}
        </div>
      )}

      {/* 折叠态下展示结果摘要（完成后） */}
      {collapsed && !running && msg._resultPreview && (
        <div className="flex items-start gap-1.5 border-t border-border px-3.5 py-2 text-[12.5px] text-muted">
          <Check size={13} className="mt-0.5 shrink-0 text-success" />
          <span className="line-clamp-2">{msg._resultPreview}</span>
        </div>
      )}
    </div>
  );
}
