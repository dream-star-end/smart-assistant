/**
 * agent-group 卡（子 agent 容器，Aurora 全新设计）。
 *  - 父卡可折叠：运行中默认展开（看实时进度）、完成默认折叠（收成一行摘要）；用户点击
 *    表头后由本地 state 锁定，跨流式重渲不回弹。
 *  - body 递归渲染 childBlocks：text→markdown / thinking→静默块 / tool_use→ToolCardSlot
 *    （子块字段与 tool 消息同形）。reducer 已把子 agent 嵌套 Agent 扁平进同一组（最多两层）。
 *  - 防闪：每个子块按 childSignature memo，完成的子块不随后续子块流式而重建。
 */
import type { TurnTokenUsageSnapshot } from "@openclaude/protocol/frames";
import { Check, ChevronRight, Clock, Users, X } from "lucide-react";
import { memo, useState } from "react";
import { type ChatMessage, type ChildBlock, isServerAuthoredRow } from "../../lib/chat/model";
import { agentTerminalStatus, childSignature, reviewVerdictBadge } from "../../lib/chat/render";
import { cn, groupDigits } from "../../lib/utils";
import { Badge, Spinner } from "../ui";
import { Markdown } from "../Markdown";
import { ToolCardSlot } from "./toolCardSlot";
import { delegateTokenUsage, TokenUsageBadge } from "./tokenUsage";

/** 终态图标(与 agentTerminalStatus tone 对齐):完成→Users、失败→X、超时→Clock。 */
export function TerminalIcon({ tone, size }: { tone: "success" | "danger" | "warning"; size: number }) {
  if (tone === "warning") return <Clock size={size} />;
  if (tone === "danger") return <X size={size} />;
  return <Users size={size} />;
}

const RAW_CHILD_STEP = 64 * 1024;

export function ProgressivePlainText({ text, className }: { text: string; className?: string }) {
  const [visibleChars, setVisibleChars] = useState(RAW_CHILD_STEP);
  return (
    <div className={className}>
      <div className="whitespace-pre-wrap break-words">{text.slice(0, visibleChars)}</div>
      {visibleChars < text.length && (
        <button
          type="button"
          onClick={() => setVisibleChars((value) => value + RAW_CHILD_STEP)}
          className="mt-2 rounded-full bg-hover px-2.5 py-1 text-[11px] text-muted hover:text-fg"
        >
          继续显示完整结果
        </button>
      )}
    </div>
  );
}

function ProgressiveChildRaw({ text }: { text: string }) {
  const [visibleChars, setVisibleChars] = useState(RAW_CHILD_STEP);
  return (
    <>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-code px-3 py-2 font-mono text-xs leading-relaxed text-fg">
        {text.slice(0, visibleChars)}
      </pre>
      {visibleChars < text.length && (
        <button
          type="button"
          onClick={() => setVisibleChars((value) => value + RAW_CHILD_STEP)}
          className="mx-auto mt-2 block rounded-full bg-hover px-3 py-1 text-xs text-muted hover:text-fg"
        >
          继续显示原始事件（还有 {(text.length - visibleChars).toLocaleString()} 个字符）
        </button>
      )}
    </>
  );
}

/** Records that are not a tool-use shell remain first-class process rows.
 * They are never dropped or summarized; large string fields mount in chunks. */
function RawChildEventView({ child }: { child: ChildBlock }) {
  const [open, setOpen] = useState(false);
  const source = child as ChildBlock & Record<string, unknown>;
  const bulkFields = ["output", "preview", "tail", "error", "text", "explanation", "objective"];
  const bulk: Array<{ name: string; text: string }> = [];
  const metadata: Record<string, unknown> = { ...source };
  for (const name of bulkFields) {
    const value = source[name];
    if (typeof value !== "string") continue;
    bulk.push({ name, text: value });
    delete metadata[name];
  }
  const serialized = JSON.stringify(metadata, null, 2) ?? "{}";
  const label = child.kind === "tool_result"
    ? `${child.toolName || "工具"} · 原始结果`
    : child.kind === "tool_output_tail"
      ? "终端输出快照"
      : child.kind === "plan"
        ? "子智能体计划事件"
        : child.kind === "goal"
          ? "子智能体目标事件"
          : child.kind === "error"
            ? "子智能体错误事件"
            : child.kind === "final"
              ? "子智能体终态事件"
              : `原始事件 · ${child.kind}`;
  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-bg">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted hover:bg-hover"
      >
        <ChevronRight size={13} className={cn("shrink-0 transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {child.isError && <Badge tone="danger">失败</Badge>}
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/70 px-3 py-2.5">
          {serialized !== "{}" && <ProgressiveChildRaw text={serialized} />}
          {bulk.map((field) => (
            <section key={field.name}>
              <div className="mb-1 text-[11px] font-medium text-faint">{field.name}</div>
              <ProgressiveChildRaw text={field.text} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export const ChildBlockView = memo(
  function ChildBlockView({
    child,
    tokenUsage,
  }: {
    child: ChildBlock;
    sig: string;
    tokenUsage?: TurnTokenUsageSnapshot;
  }) {
    const [visibleChars, setVisibleChars] = useState(64 * 1024);
    if (child.kind === "text") {
      if (!child.text) return null;
      const hasMore = visibleChars < child.text.length;
      return (
        <div>
          <Markdown signMedia>{child.text.slice(0, visibleChars)}</Markdown>
          {hasMore && (
            <button
              type="button"
              onClick={() => setVisibleChars((value) => value + 64 * 1024)}
              className="mt-1 rounded-full bg-hover px-2.5 py-1 text-[11px] text-muted hover:text-fg"
            >
              继续显示正文
            </button>
          )}
        </div>
      );
    }
    if (child.kind === "thinking") {
      if (!child.text) return null;
      return (
        <div className="whitespace-pre-wrap break-words rounded-md bg-surface/60 px-3 py-2 text-[12.5px] leading-relaxed text-muted">
          {child.text.slice(0, visibleChars)}
          {visibleChars < child.text.length && (
            <button
              type="button"
              onClick={() => setVisibleChars((value) => value + 64 * 1024)}
              className="mt-2 block rounded-full bg-hover px-2.5 py-1 text-[11px] text-muted hover:text-fg"
            >
              继续显示思考内容
            </button>
          )}
        </div>
      );
    }
    if (child.kind === "tool_use") {
      const nested = /^Agent$/i.test(child.toolName || "");
      return (
        <div className={cn(nested && "border-l-2 border-accent/30 pl-2")}>
          <ToolCardSlot message={child} tokenUsage={tokenUsage} />
        </div>
      );
    }
    // Hydrated immutable transcripts intentionally retain result/tail/plan/
    // goal/error/final event boundaries. Render every one rather than relying
    // on the live reducer's combined tool card representation.
    return <RawChildEventView child={child} />;
  },
  (a, b) => a.sig === b.sig && a.tokenUsage?.totalTokens === b.tokenUsage?.totalTokens,
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
  const [visibleChildren, setVisibleChildren] = useState(100);
  const collapsed = userCollapsed ?? (!!msg._completed || isServerRow);
  const children = msg.childBlocks ?? [];
  const tokenUsage = delegateTokenUsage(msg);
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
          <TokenUsageBadge usage={tokenUsage} label="子 Agent 合计" />
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
          {/* 任何无 childBlocks 的终态卡展开态展示真实结果摘要。 */}
          {terminalNoChildren && (msg._resultPreview || isServerRow) && (
            <div className="space-y-1.5">
              {msg._resultPreview && (
                <ProgressivePlainText
                  text={msg._resultPreview}
                  className="text-[12.5px] leading-relaxed text-muted"
                />
              )}
            </div>
          )}
          {children.slice(0, visibleChildren).map((ch, i) => (
            <ChildBlockView
              key={`${i}-${ch.blockId ?? ch.kind}`}
              child={ch}
              sig={childSignature(ch)}
              tokenUsage={tokenUsage}
            />
          ))}
          {visibleChildren < children.length && (
            <button
              type="button"
              onClick={() => setVisibleChildren((value) => value + 100)}
              className="mx-auto block rounded-full bg-hover px-3 py-1 text-xs text-muted hover:text-fg"
            >
              继续加载过程（还有 {children.length - visibleChildren} 条）
            </button>
          )}
        </div>
      )}

      {/* 折叠态下展示结果摘要（完成后） */}
      {collapsed && !running && msg._resultPreview && (
        <div className="flex items-start gap-1.5 border-t border-border px-3.5 py-2 text-[12.5px] text-muted">
          <Check size={13} className="mt-0.5 shrink-0 text-success" />
          <span className="line-clamp-2">
            {msg._resultPreview.slice(0, 500)}{msg._resultPreview.length > 500 ? "…" : ""}
          </span>
        </div>
      )}
    </div>
  );
}
