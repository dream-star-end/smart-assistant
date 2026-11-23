/**
 * 多张任务审批卡（present_task_approval）的轻量分组与懒加载入口。
 *
 * 刻意只包含极薄的纯归组函数与可重建懒加载外壳（createRetryableLazy），
 * 不静态引入任何图标、按钮或聚合状态机，防止抬升首屏 470 KiB gzip 预算。
 */
import { createElement, Suspense, type ReactNode } from "react";
import type { ChatMessage } from "../../lib/chat/model";
import { createRetryableLazy } from "../ui/retryableLazy";
import { asStr, normalizeToolForDisplay } from "./format";

const TASK_APPROVAL_TOOL_RE = /(?:^|__|:)present_task_approval$/i;

/** 从一条 tool 消息中提取 present_task_approval 的目标单号；非审批卡或出错返回 null。 */
export function extractTaskApprovalTicketId(message: ChatMessage): string | null {
  if (message.role !== "tool" || message.error) return null;
  try {
    const display = normalizeToolForDisplay(message);
    if (!TASK_APPROVAL_TOOL_RE.test(display.name)) return null;
    const ticketId = asStr(display.input?.id) || asStr(display.input?.identifier);
    return ticketId.trim() || null;
  } catch {
    return null;
  }
}

export function isTaskApprovalToolMessage(message: ChatMessage): boolean {
  return extractTaskApprovalTicketId(message) !== null;
}

export type TaskApprovalGroupRenderItem<TSingle> = {
  kind: "approval-group";
  key: string;
  members: ChatMessage[];
  items: TSingle[];
  ticketIds: string[];
};

/**
 * 将同回合内连续出现的 ≥2 张 present_task_approval 单卡归拢为原子渲染组，
 * 既保证底部汇总条紧贴最后一张卡，又防止虚拟滚动把同组卡片拆开挂载/卸载。
 * 单张审批卡原样保留，不引入任何多余 DOM。
 */
export function coalesceTaskApprovalGroups<
  TSingle extends { kind: "single"; m: ChatMessage },
  TItem extends { kind: string },
>(
  items: readonly TItem[],
  keyOf: (item: TSingle) => string,
): Array<TItem | TaskApprovalGroupRenderItem<TSingle>> {
  const out: Array<TItem | TaskApprovalGroupRenderItem<TSingle>> = [];
  let run: TSingle[] = [];
  let runTicketIds: string[] = [];
  let runPageKey = "";

  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= 2) {
      out.push({
        kind: "approval-group",
        key: `approval-group:${keyOf(run[0]!)}`,
        members: run.map((it) => it.m),
        items: run,
        ticketIds: runTicketIds,
      });
    } else {
      out.push(run[0]! as unknown as TItem);
    }
    run = [];
    runTicketIds = [];
    runPageKey = "";
  };

  for (const item of items) {
    if (item.kind === "single") {
      const single = item as unknown as TSingle;
      const ticketId = extractTaskApprovalTicketId(single.m);
      if (ticketId) {
        const pageKey = single.m._historyPageKey ?? single.m._turnTapeProcessPageKey ?? "";
        if (run.length > 0 && pageKey !== runPageKey) {
          flush();
        }
        run.push(single);
        runTicketIds.push(ticketId);
        runPageKey = pageKey;
        continue;
      }
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

const LazyTaskApprovalGroupShell = createRetryableLazy(() =>
  import("./taskApprovalGroup").then((m) => ({ default: m.TaskApprovalGroupShell })),
);

export function preloadTaskApprovalGroup(): Promise<unknown> {
  return LazyTaskApprovalGroupShell.preload();
}

export function TaskApprovalGroupSlot({
  ticketIds,
  children,
}: {
  ticketIds: readonly string[];
  children: ReactNode;
}) {
  return createElement(
    Suspense,
    { fallback: createElement("div", { className: "space-y-3" }, children) },
    createElement(LazyTaskApprovalGroupShell, { ticketIds, children }),
  );
}
