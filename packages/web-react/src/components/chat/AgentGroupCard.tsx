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
import { memo, useId, useState } from "react";
import { type ChatMessage, type ChildBlock, isServerAuthoredRow } from "../../lib/chat/model";
import { agentTerminalStatus, reviewVerdictBadge } from "../../lib/chat/render";
import { cn, groupDigits } from "../../lib/utils";
import { Badge, Spinner } from "../ui";
import { Markdown } from "../Markdown";
import { ToolCardSlot } from "./toolCardSlot";
import { DelegateProcessList } from "./delegateProcessList";
import { delegateTokenUsage, TokenUsageBadge } from "./tokenUsage";
import { agentDisplayName } from "./agentNames";

/** 终态图标(与 agentTerminalStatus tone 对齐):完成→Users、失败→X、超时→Clock。 */
export function TerminalIcon({ tone, size }: { tone: "success" | "danger" | "warning" | "neutral"; size: number }) {
  if (tone === "warning") return <Clock size={size} />;
  if (tone === "danger" || tone === "neutral") return <X size={size} />;
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
          className="mt-2 rounded-full bg-hover px-2.5 py-1 text-caption text-muted hover:text-fg"
        >
          继续显示完整结果
        </button>
      )}
    </div>
  );
}

function ChildPlanView({ steps }: { steps: unknown }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const valid = steps.filter(
    (s): s is { status?: string; step?: string } => Boolean(s) && typeof s === "object",
  );
  if (valid.length === 0) return null;
  return (
    <ul className="oc-surface-recessed space-y-1 rounded-lg border border-border/60 px-3 py-2 text-meta text-muted">
      {valid.map((s, idx) => (
        <li key={`${idx}-${s.step ?? ""}`} className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 text-caption text-faint">
            {s.status === "completed" ? "✓" : s.status === "in_progress" ? "●" : "○"}
          </span>
          <span className="min-w-0 break-words">{s.step ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

export const ChildBlockView = memo(
  function ChildBlockView({
    child,
  }: {
    child: ChildBlock;
    sig: string;
    /** 子卡不再展示父组用量；保留参数以免旧调用方类型立刻裂开。 */
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
              className="mt-1 rounded-full bg-hover px-2.5 py-1 text-caption text-muted hover:text-fg"
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
        <div className="oc-surface-recessed whitespace-pre-wrap break-words rounded-lg border border-border/60 px-3 py-2 text-meta leading-relaxed text-muted">
          {child.text.slice(0, visibleChars)}
          {visibleChars < child.text.length && (
            <button
              type="button"
              onClick={() => setVisibleChars((value) => value + 64 * 1024)}
              className="oc-btn-tactile mt-2 block rounded-full bg-hover px-2.5 py-1 text-caption text-muted hover:text-fg"
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
          <ToolCardSlot message={child} />
        </div>
      );
    }
    if (child.kind === "tool_result") {
      return (
        <ToolCardSlot
          message={{
            ...child,
            kind: "tool_use",
            toolName: child.toolName || "工具",
            _completed: true,
            error: child.isError,
            output: child.output ?? child.preview,
          }}
        />
      );
    }
    if (child.kind === "plan") {
      return <ChildPlanView steps={child.steps} />;
    }
    if (child.kind === "error") {
      const msgText = (child.text || child.preview || "").trim();
      if (!msgText) return null;
      return (
        <div className="oc-callout oc-callout-danger rounded-lg px-3 py-2 text-meta text-danger">
          {msgText}
        </div>
      );
    }
    if (child.kind === "goal") {
      const goalText = (child.text || child.explanation || "").trim();
      if (!goalText) return null;
      return <div className="text-meta text-muted">{goalText}</div>;
    }
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
  const children = Array.isArray(msg.childBlocks) ? msg.childBlocks : [];
  const tokenUsage = delegateTokenUsage(msg);
  const terminalNoChildren = !running && children.length === 0;
  const bodyId = useId();

  return (
    <div className="oc-surface-card overflow-hidden rounded-xl animate-in">
      {/* 折叠开关暴露展开态(aria-expanded/aria-controls,与 DelegateProgressCard 一致)。 */}
      <button
        type="button"
        onClick={() => setUserCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        aria-controls={collapsed ? undefined : bodyId}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-hover/70 [@media(hover:none)]:min-h-11"
      >
        <span className="oc-icon-badge oc-icon-badge-accent flex size-6 shrink-0 items-center justify-center rounded-sm">
          {running ? <Spinner size={13} /> : <TerminalIcon tone={status.tone} size={13} />}
        </span>
        {/* 团队模式:谁接了这件事先写出来(体验官 P3「看不出委派」)。 */}
        {msg._delegateAgentId ? (
          <span data-testid="agent-group-assignee" className="shrink-0 text-body text-muted">{`委派给 ${agentDisplayName(msg._delegateAgentId)}`}</span>
        ) : null}
        <span className="min-w-0 truncate text-body font-semibold text-fg">{msg.text || "子任务"}</span>
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
            <span className="font-mono text-caption font-medium tabular-nums text-faint">{groupDigits(delegateCost)} 积分</span>
          )}
          <ChevronRight
            size={15}
            strokeWidth={1.75}
            className={cn("text-faint transition-transform duration-200 ease-[var(--ease-spring)]", !collapsed && "rotate-90")}
          />
        </span>
      </button>

      {!collapsed && (
        <div id={bodyId} className="border-t border-border/70">
          {children.length === 0 && running && (
            <div className="flex items-center gap-2 px-3.5 py-2.5 text-meta text-faint">
              <Spinner size={12} /> 子智能体启动中…
            </div>
          )}
          {/* 任何无 childBlocks 的终态卡展开态展示真实结果摘要。 */}
          {terminalNoChildren && (typeof msg._resultPreview === "string" || isServerRow) && (
            <div className="space-y-1.5 px-3.5 py-2.5">
              {typeof msg._resultPreview === "string" && msg._resultPreview && (
                <ProgressivePlainText
                  text={msg._resultPreview}
                  className="text-meta leading-relaxed text-muted"
                />
              )}
            </div>
          )}
          {children.length > 0 && <DelegateProcessList childBlocks={children} />}
        </div>
      )}

      {/* 折叠态下展示结果摘要(完成后)。图标跟终态 tone 走:成功 ✓ / 失败 ✕ / 超时 ⏱,
          不再对着「失败 · 61s」徽记画一个绿勾。 */}
      {collapsed && !running && typeof msg._resultPreview === "string" && msg._resultPreview && (
        <div className="flex items-start gap-1.5 border-t border-border/70 bg-bg/35 px-3.5 py-2 text-meta text-muted">
          <span
            className={cn(
              "mt-0.5 shrink-0",
              status.tone === "danger" ? "text-danger" : status.tone === "warning" ? "text-warning" : status.tone === "neutral" ? "text-muted" : "text-success",
            )}
            data-testid="agent-summary-icon"
            data-tone={status.tone}
          >
            {status.tone === "success" ? <Check size={13} strokeWidth={2} /> : <TerminalIcon tone={status.tone} size={13} />}
          </span>
          <span className="line-clamp-2">
            {msg._resultPreview.slice(0, 500)}{msg._resultPreview.length > 500 ? "…" : ""}
          </span>
        </div>
      )}
    </div>
  );
}
