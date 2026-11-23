/**
 * 对话内多张任务审批卡（present_task_approval）的回合级聚合协调器。
 *
 * 背景（OCV5-869）：
 *  - 单张待审批卡：不入组，保持「点一下实时改单并立即发送消息」的最短路径。
 *  - 同回合 ≥2 张任务审批卡：逐张点击实时调用 /api/board 更新单据（刷新不丢），
 *    但不立即发消息、不把同回合其余审批卡因 chatBusy 锁死；由组底栏统一展示进度、
 *    提供「全部通过 / 全部批准」快捷操作与可选补充说明，最后由用户显式点击
 *    「发送审批结果」合并成一条消息通知助手。
 *  - 全部卡片在打开前已处于非待审批态（历史记录回放）时，底栏自动隐身。
 *
 * 本模块刻意保持轻量，避免拉大 MessageRenderer 所在主 chunk。
 */
import { CheckCheck, ClipboardCheck, Send } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { TicketStatus } from "../../lib/taskboard";
import { Button } from "../ui";
import { useChatInteraction, useToolCardActions } from "./context";
export {
  coalesceTaskApprovalGroups,
  extractTaskApprovalTicketId,
  isTaskApprovalToolMessage,
} from "./taskApprovalCoalesce";

export type TaskApprovalDecisionKind = "approve" | "reject" | "defer";

export interface TaskApprovalDecisionRecord {
  kind: TaskApprovalDecisionKind;
  /** 发给助手的标准单条摘要（与单卡直发口径完全一致）。 */
  summary: string;
}

export interface TaskApprovalGroupEntry {
  key: string;
  order: number;
  ticketId: string;
  identifier: string;
  loading: boolean;
  approvable: boolean;
  ticketStatus?: TicketStatus;
  ticketStatusLabel?: string;
  deciding: boolean;
  decision: TaskApprovalDecisionRecord | null;
  /** 页面打开前就已非待审批态（如刷新前已批过或在任务面板已处理）。 */
  alreadySettledExternally: boolean;
  /** 由对应卡片注册的真实审批触发器（复用 /api/board + 409 重试 + 本地状态同步）。 */
  triggerApprove?: () => Promise<boolean>;
}

export interface TaskApprovalGroupSnapshot {
  entries: TaskApprovalGroupEntry[];
  expectedCount: number;
  totalCount: number;
  /** 本轮用户真实操作过的数量。 */
  decidedCount: number;
  /** 已处理总数（本轮操作 + 外部已生效）。 */
  handledCount: number;
  /** 仍可审批且尚未决定的数量。 */
  approvableCount: number;
  /** 是否存在任意仍在加载中的卡片。 */
  anyLoading: boolean;
  /** 是否存在任意正在提交中的卡片。 */
  anyDeciding: boolean;
  /** 批量「全部通过」进行中。 */
  batchApproving: boolean;
  /** 是否已将聚合结果发送给助手。 */
  sent: boolean;
  /** 当前是否处于多卡聚合模式（未发送且本组 ≥2 张）。 */
  grouped: boolean;
}

export interface TaskApprovalGroupStore {
  syncExpectedTickets: (ticketIds: readonly string[]) => void;
  registerCard: (key: string, ticketId: string) => void;
  detachCard: (key: string) => void;
  updateCard: (
    key: string,
    patch: {
      identifier?: string;
      loading?: boolean;
      approvable?: boolean;
      ticketStatus?: TicketStatus;
      ticketStatusLabel?: string;
      deciding?: boolean;
      alreadySettledExternally?: boolean;
      triggerApprove?: () => Promise<boolean>;
    },
  ) => void;
  recordDecision: (key: string, decision: TaskApprovalDecisionRecord) => void;
  setBatchApproving: (active: boolean) => void;
  markSent: () => void;
  isActiveGrouped: () => boolean;
  getSnapshot: () => TaskApprovalGroupSnapshot;
  subscribe: (cb: () => void) => () => void;
}

function normalizeTicketKey(id: string): string {
  return id.trim().toUpperCase();
}

/** 构造发给助手的聚合审批结果文案（按 identifier 去重，保持展示顺序）。 */
export function formatTaskApprovalSummary(
  entries: readonly TaskApprovalGroupEntry[],
  note?: string,
): string {
  const merged = new Map<string, TaskApprovalGroupEntry>();
  const orderedKeys: string[] = [];
  for (const entry of entries) {
    const norm = normalizeTicketKey(entry.identifier || entry.ticketId);
    const existing = merged.get(norm);
    if (!existing) {
      merged.set(norm, entry);
      orderedKeys.push(norm);
    } else if (!existing.decision && entry.decision) {
      merged.set(norm, entry);
    }
  }
  const unique = orderedKeys.map((k) => merged.get(k)!);
  const lines: string[] = [];
  let handled = 0;
  for (const entry of unique) {
    const ident = entry.identifier || entry.ticketId;
    if (entry.decision) {
      handled += 1;
      lines.push(`- ${entry.decision.summary}`);
    } else if (entry.alreadySettledExternally) {
      handled += 1;
      const statusLabel = entry.ticketStatusLabel || "已处理";
      lines.push(`- ${ident}（已生效：${statusLabel}）`);
    } else {
      lines.push(`- 暂未处理 ${ident}`);
    }
  }
  const header = `已完成任务审批（${handled}/${unique.length}）：`;
  const trimmedNote = note?.trim() ?? "";
  return trimmedNote
    ? `${header}\n${lines.join("\n")}\n补充说明：${trimmedNote}`
    : `${header}\n${lines.join("\n")}`;
}

export function createTaskApprovalGroupStore(initialTicketIds: readonly string[] = []): TaskApprovalGroupStore {
  const entries = new Map<string, TaskApprovalGroupEntry>();
  /** key -> 绑定的初始槽位键（预播种槽位在真实卡片挂载时无缝认领，折叠卸载不丢决策）。 */
  const seedOrder = new Map<string, number>();
  let order = 0;
  let expectedCount = initialTicketIds.length;
  let sent = false;
  let batchApproving = false;

  const seedInitial = (ticketIds: readonly string[]) => {
    expectedCount = Math.max(expectedCount, ticketIds.length);
    for (const raw of ticketIds) {
      const id = raw.trim();
      if (!id) continue;
      const norm = normalizeTicketKey(id);
      if (!seedOrder.has(norm)) {
        seedOrder.set(norm, order++);
      }
    }
  };
  seedInitial(initialTicketIds);

  const buildSnapshot = (): TaskApprovalGroupSnapshot => {
    const list = [...entries.values()].sort((a, b) => a.order - b.order);
    let decidedCount = 0;
    let handledCount = 0;
    let approvableCount = 0;
    let anyLoading = false;
    let anyDeciding = false;
    for (const e of list) {
      if (e.decision) {
        decidedCount += 1;
        handledCount += 1;
      } else if (e.alreadySettledExternally) {
        handledCount += 1;
      }
      if (e.approvable && !e.decision) {
        approvableCount += 1;
      }
      if (e.loading) anyLoading = true;
      if (e.deciding) anyDeciding = true;
    }
    const totalCount = Math.max(expectedCount, list.length);
    const grouped = totalCount >= 2;
    return {
      entries: list,
      expectedCount,
      totalCount,
      decidedCount,
      handledCount,
      approvableCount,
      anyLoading,
      anyDeciding,
      batchApproving,
      sent,
      grouped,
    };
  };

  let snapshot = buildSnapshot();
  const listeners = new Set<() => void>();
  const emit = () => {
    snapshot = buildSnapshot();
    for (const cb of listeners) cb();
  };

  return {
    syncExpectedTickets(ticketIds) {
      const prevExpected = expectedCount;
      seedInitial(ticketIds);
      if (expectedCount !== prevExpected) emit();
    },
    registerCard(key, ticketId) {
      const existing = entries.get(key);
      if (existing) {
        if (existing.ticketId !== ticketId) {
          existing.ticketId = ticketId;
          emit();
        }
        return;
      }
      const norm = normalizeTicketKey(ticketId);
      const assignedOrder = seedOrder.get(norm) ?? order++;
      entries.set(key, {
        key,
        order: assignedOrder,
        ticketId,
        identifier: ticketId,
        loading: true,
        approvable: false,
        deciding: false,
        decision: null,
        alreadySettledExternally: false,
      });
      emit();
    },
    detachCard(key) {
      const existing = entries.get(key);
      if (!existing) return;
      // 保留已产生的 decision 与单据状态（如用户把单卡折叠收起时），只摘除运行态句柄。
      if (existing.decision || existing.alreadySettledExternally) {
        existing.triggerApprove = undefined;
        existing.deciding = false;
        existing.loading = false;
      } else {
        entries.delete(key);
      }
      emit();
    },
    updateCard(key, patch) {
      const existing = entries.get(key);
      if (!existing) return;
      let changed = false;
      if (patch.identifier !== undefined && existing.identifier !== patch.identifier) {
        existing.identifier = patch.identifier;
        changed = true;
      }
      if (patch.loading !== undefined && existing.loading !== patch.loading) {
        existing.loading = patch.loading;
        changed = true;
      }
      if (patch.approvable !== undefined && existing.approvable !== patch.approvable) {
        existing.approvable = patch.approvable;
        changed = true;
      }
      if (patch.ticketStatus !== undefined && existing.ticketStatus !== patch.ticketStatus) {
        existing.ticketStatus = patch.ticketStatus;
        changed = true;
      }
      if (
        patch.ticketStatusLabel !== undefined &&
        existing.ticketStatusLabel !== patch.ticketStatusLabel
      ) {
        existing.ticketStatusLabel = patch.ticketStatusLabel;
        changed = true;
      }
      if (patch.deciding !== undefined && existing.deciding !== patch.deciding) {
        existing.deciding = patch.deciding;
        changed = true;
      }
      if (
        patch.alreadySettledExternally !== undefined &&
        existing.alreadySettledExternally !== patch.alreadySettledExternally
      ) {
        existing.alreadySettledExternally = patch.alreadySettledExternally;
        changed = true;
      }
      if (patch.triggerApprove !== existing.triggerApprove) {
        existing.triggerApprove = patch.triggerApprove;
        changed = true;
      }
      if (changed) emit();
    },
    recordDecision(key, decision) {
      const existing = entries.get(key);
      if (!existing) return;
      existing.decision = decision;
      existing.approvable = false;
      existing.deciding = false;
      emit();
    },
    setBatchApproving(active) {
      if (batchApproving === active) return;
      batchApproving = active;
      emit();
    },
    markSent() {
      if (sent) return;
      sent = true;
      emit();
    },
    isActiveGrouped() {
      return snapshot.grouped && !snapshot.sent;
    },
    getSnapshot: () => snapshot,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

const TaskApprovalGroupContext = createContext<TaskApprovalGroupStore | null>(null);

export function useTaskApprovalGroup(): TaskApprovalGroupStore | null {
  return useContext(TaskApprovalGroupContext);
}

export function useTaskApprovalGroupSnapshot(): TaskApprovalGroupSnapshot | null {
  const store = useContext(TaskApprovalGroupContext);
  const subscribe = useCallback((cb: () => void) => store?.subscribe(cb) ?? (() => {}), [store]);
  const get = useCallback(() => store?.getSnapshot() ?? null, [store]);
  return useSyncExternalStore(subscribe, get, get);
}

export function TaskApprovalGroupProvider({
  children,
  ticketIds = [],
}: {
  children: ReactNode;
  ticketIds?: readonly string[];
}) {
  const storeRef = useRef<TaskApprovalGroupStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createTaskApprovalGroupStore(ticketIds);
  }
  const ticketIdsSig = ticketIds.join("\u0001");
  useEffect(() => {
    storeRef.current?.syncExpectedTickets(ticketIds);
    // ticketIdsSig 稳定反映列表内容，避免每帧无意义同步。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketIdsSig]);

  return (
    <TaskApprovalGroupContext.Provider value={storeRef.current}>
      {children}
    </TaskApprovalGroupContext.Provider>
  );
}

/** 多张任务审批卡底部的统一操作与汇总发送条。 */
export function TaskApprovalGroupFooter() {
  const store = useTaskApprovalGroup();
  const snap = useTaskApprovalGroupSnapshot();
  const { taskApproval } = useToolCardActions();
  const { sendUserText, busy: chatBusy } = useChatInteraction();
  const [noteOpen, setNoteOpen] = useState(false);
  const [groupNote, setGroupNote] = useState("");
  const [batchError, setBatchError] = useState<string | null>(null);

  const approvableEntries = useMemo(() => {
    if (!snap) return [];
    const seen = new Set<string>();
    const out: TaskApprovalGroupEntry[] = [];
    for (const e of snap.entries) {
      if (e.loading || !e.approvable || e.decision || !e.triggerApprove) continue;
      const norm = normalizeTicketKey(e.identifier || e.ticketId);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(e);
    }
    return out;
  }, [snap]);

  const allPendingAreBacklog =
    approvableEntries.length > 0 && approvableEntries.every((e) => e.ticketStatus === "backlog");

  const summaryText = useMemo(() => {
    if (!snap) return "";
    return formatTaskApprovalSummary(snap.entries, groupNote);
  }, [snap, groupNote]);

  const handleApproveAll = useCallback(async () => {
    if (!store || approvableEntries.length === 0 || chatBusy) return;
    setBatchError(null);
    store.setBatchApproving(true);
    let failed = 0;
    try {
      for (const entry of approvableEntries) {
        const trigger = entry.triggerApprove;
        if (!trigger) continue;
        try {
          const ok = await trigger();
          if (!ok) failed += 1;
        } catch {
          failed += 1;
        }
      }
    } finally {
      store.setBatchApproving(false);
    }
    if (failed > 0) {
      setBatchError(`有 ${failed} 项审批未成功，请查看上方对应卡片重试。`);
    }
  }, [store, approvableEntries, chatBusy]);

  const handleSendSummary = useCallback(() => {
    if (!store || !sendUserText || !snap || snap.decidedCount < 1 || snap.batchApproving || chatBusy) return;
    setBatchError(null);
    store.markSent();
    sendUserText(summaryText);
  }, [store, sendUserText, snap, chatBusy, summaryText]);

  if (!store || !snap || !snap.grouped || !taskApproval) return null;

  // 全部卡片加载完成且都是历史已生效状态（0 待批且本页 0 操作）→ 历史记录不渲染多余操作条。
  const hasAnyActionableOrSessionWork =
    snap.anyLoading || snap.approvableCount > 0 || snap.decidedCount > 0 || snap.sent;
  if (!hasAnyActionableOrSessionWork) return null;

  if (snap.sent) {
    const unhandled = Math.max(0, snap.totalCount - snap.handledCount);
    return (
      <p
        data-testid="task-approval-group-sent"
        className="flex items-center gap-1.5 px-1 text-caption text-faint"
      >
        <ClipboardCheck className="size-3.5 text-success" strokeWidth={1.75} />
        {unhandled > 0
          ? `已汇总发送审批结果（另有 ${unhandled} 项标为暂未处理）。`
          : "已汇总发送全部审批结果。"}
      </p>
    );
  }

  const busy = !!chatBusy || snap.batchApproving || snap.anyDeciding;
  const canSend = !!sendUserText && snap.decidedCount >= 1 && !busy;
  const remaining = Math.max(0, snap.totalCount - snap.handledCount);
  const allHandled = remaining === 0 && snap.handledCount > 0 && !snap.anyLoading;

  const hint = chatBusy
    ? "等待当前回合结束后可操作"
    : snap.batchApproving
      ? "正在逐项提交审批…"
      : !sendUserText
        ? "单据已实时生效，请手动回复助手继续"
        : snap.decidedCount === 0
          ? "单张审批实时生效，批完后一起发给助手"
          : allHandled
            ? "全部已处理，可一次性发给助手"
            : `还有 ${remaining} 项未处理，现在也可先发送`;

  const approveAllLabel =
    approvableEntries.length === 1
      ? allPendingAreBacklog
        ? "批准剩余 1 项"
        : "通过剩余 1 项"
      : allPendingAreBacklog
        ? `全部批准（${approvableEntries.length}）`
        : `全部通过（${approvableEntries.length}）`;

  return (
    <div
      data-testid="task-approval-group-footer"
      className="oc-surface-card flex flex-col gap-2.5 rounded-2xl border-accent/35 px-4 py-3 not-prose"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <output aria-live="polite" className="min-w-0 text-meta text-muted">
          已处理{" "}
          <span className="inline-flex items-center rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-caption font-semibold tabular-nums text-accent">
            {snap.handledCount} / {snap.totalCount}
          </span>{" "}
          项
          {hint ? <span className="text-faint"> · {hint}</span> : null}
        </output>

        <div className="flex flex-wrap items-center gap-2">
          {approvableEntries.length >= 1 ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="task-approval-approve-all"
              disabled={busy}
              loading={snap.batchApproving}
              onClick={() => void handleApproveAll()}
            >
              <CheckCheck className="size-3.5" strokeWidth={1.75} />
              {approveAllLabel}
            </Button>
          ) : null}

          {sendUserText ? (
            <>
              <button
                type="button"
                aria-expanded={noteOpen}
                disabled={busy}
                onClick={() => setNoteOpen((v) => !v)}
                className="oc-btn-tactile rounded-md px-2 py-1 text-caption font-medium text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 [@media(hover:none)]:min-h-11"
              >
                {noteOpen ? "收起补充说明" : "补充说明"}
              </button>
              <Button
                type="button"
                variant={allHandled ? "accent" : "primary"}
                size="sm"
                data-testid="task-approval-send-summary"
                disabled={!canSend}
                title={chatBusy ? "等待当前回合结束后可发送" : undefined}
                onClick={handleSendSummary}
              >
                <Send className="size-3.5" strokeWidth={1.75} />
                发送审批结果
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {batchError ? (
        <p className="oc-callout oc-callout-danger rounded-md px-2.5 py-1.5 text-caption text-danger">
          {batchError}
        </p>
      ) : null}

      {noteOpen && sendUserText ? (
        <input
          type="text"
          aria-label="审批补充说明"
          data-testid="task-approval-group-note-input"
          value={groupNote}
          disabled={busy}
          onChange={(e) => setGroupNote(e.target.value)}
          placeholder="选填：输入统一要求或优先级，随审批结果一并发出"
          className="oc-surface-recessed w-full rounded-lg border border-border-control/70 bg-elevated px-3 py-1.5 text-base text-fg outline-none transition-[border-color,box-shadow] focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-meta"
        />
      ) : null}
    </div>
  );
}

/** 供 MessageList 懒加载挂载的多卡审批组完整外壳（Provider + 卡片列表 + 汇总底栏）。 */
export function TaskApprovalGroupShell({
  ticketIds,
  children,
}: {
  ticketIds: readonly string[];
  children: ReactNode;
}) {
  return (
    <TaskApprovalGroupProvider ticketIds={ticketIds}>
      <div className="space-y-3" data-testid="task-approval-group">
        {children}
        <TaskApprovalGroupFooter />
      </div>
    </TaskApprovalGroupProvider>
  );
}
