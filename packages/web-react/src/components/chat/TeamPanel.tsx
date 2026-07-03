/**
 * 团队协作面板 —— 蜂群智能团队模式的前端视图。
 *
 * 把"队长在同一轮里并行委派的多个角色"(渲染流里连续的 agent-group 消息)聚成**一个**
 * 清晰友好的团队面板,而不是散落的多张卡:
 *  - 头部一眼看团队规模 + 状态概览(运行中 / 完成 / 失败 计数);活跃时默认展开,全完成默认收起。
 *  - 每个队员一行:名称 + 任务 + 状态(运行中转圈 / 完成✓ / 失败✕ + 耗时),点开看其工作过程 + 结果。
 *  - 复用已有 delegate/agent-group 数据线路 + ChildBlockView,**无需后端改动**;后端真蜂群
 *    (teammate / 邮箱 / coordinator)落地后,本面板可平滑扩展承载更丰富的协作信息。
 *  - 视觉沿用 Aurora 原语(Badge/Spinner/border/surface/grad-cta),与单个 AgentGroupCard 一致。
 *
 * memo:本组件收 {members, sig},reducer 就地 mutate 成员对象(引用不变),故以合并 sig 比较
 * (上层 MessageList 用每个成员的 messageSignature 拼出),sig 变才重渲——同 MessageRenderer 防闪模式。
 */
import { Check, ChevronRight, Users, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { childSignature } from "../../lib/chat/render";
import { cn } from "../../lib/utils";
import { Badge, Spinner } from "../ui";
import { ChildBlockView } from "./AgentGroupCard";

/** 队员显示名:优先委派的 agentId(已是可读标识),空则按序号兜底。 */
function memberName(msg: ChatMessage, idx: number): string {
  const id = msg._delegateAgentId?.trim();
  return id || `角色 ${idx + 1}`;
}

/** 单个队员行:可折叠,运行中默认展开看进度、完成默认收起(显示结果摘要)。 */
function TeamMemberRow({ msg, idx }: { msg: ChatMessage; idx: number }) {
  const running = !msg._completed;
  const isError = !!msg._isError;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? running;
  const children = msg.childBlocks ?? [];
  const name = memberName(msg, idx);
  const goal = msg._delegateGoal || msg.text || "";

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-bg">
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-hover"
      >
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-md",
            running
              ? "bg-accent-soft text-accent"
              : isError
                ? "bg-danger-soft text-danger"
                : "bg-success-soft text-success",
          )}
        >
          {running ? <Spinner size={11} /> : isError ? <X size={11} /> : <Check size={11} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-fg">{name}</span>
          {goal && <span className="block truncate text-[11.5px] text-faint">{goal}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
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
          <ChevronRight size={14} className={cn("text-faint transition-transform", open && "rotate-90")} />
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-border/70 px-3 py-2.5">
          {children.length === 0 && running && (
            <div className="flex items-center gap-2 text-[12px] text-faint">
              <Spinner size={11} /> 启动中…
            </div>
          )}
          {children.map((ch, i) => (
            <ChildBlockView key={`${i}-${ch.blockId ?? ch.kind}`} child={ch} sig={childSignature(ch)} />
          ))}
        </div>
      )}

      {!open && msg._completed && msg._resultPreview && (
        <div className="flex items-start gap-1.5 border-t border-border/70 px-3 py-1.5 text-[12px] text-muted">
          <Check size={12} className="mt-0.5 shrink-0 text-success" />
          <span className="line-clamp-1">{msg._resultPreview}</span>
        </div>
      )}
    </div>
  );
}

export const TeamPanel = memo(
  function TeamPanel({ members }: { members: ChatMessage[]; sig: string }) {
    const total = members.length;
    const running = members.filter((m) => !m._completed).length;
    const failed = members.filter((m) => m._completed && m._isError).length;
    const done = total - running - failed;
    const allDone = running === 0;
    const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);
    // 「曾经活跃过」高水位锁存:面板若在用户眼前从运行跑到完成,保持展开(继续展示各队员结果),
    // 不自动收起——否则会卸载队员行、吞掉用户手动展开的内容。只有「一进来就全完成」的历史
    // 面板才默认收起。用户显式切换(userCollapsed)始终优先。
    // 用 committed effect 锁存(非 render 期写)——保持纯渲染语义,避免 Concurrent 下被丢弃的
    // 渲染把瞬态 active 误锁进来。
    const [everActive, setEverActive] = useState(false);
    useEffect(() => {
      if (running > 0) setEverActive(true);
    }, [running]);
    const collapsed = userCollapsed ?? (allDone && !everActive);

    return (
      <div className="rounded-xl border border-border bg-surface animate-in">
        <button
          type="button"
          onClick={() => setUserCollapsed(!collapsed)}
          className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-hover"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-grad-cta text-white">
            <Users size={13} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
            团队协作 · {total} 个角色
          </span>
          <span className="flex shrink-0 items-center gap-2 text-[11.5px]">
            {running > 0 && (
              <span className="flex items-center gap-1 text-accent">
                <Spinner size={10} /> {running} 运行中
              </span>
            )}
            {done > 0 && <span className="text-success">✓ {done} 完成</span>}
            {failed > 0 && <span className="text-danger">✕ {failed} 失败</span>}
            <ChevronRight size={15} className={cn("text-faint transition-transform", !collapsed && "rotate-90")} />
          </span>
        </button>

        {!collapsed && (
          <div className="space-y-2 border-t border-border px-3 py-2.5">
            {members.map((m, i) => (
              <TeamMemberRow key={m.id} msg={m} idx={i} />
            ))}
          </div>
        )}
      </div>
    );
  },
  (a, b) => a.sig === b.sig,
);
